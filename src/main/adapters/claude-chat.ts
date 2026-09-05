import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type {
  PermissionMode,
  PermissionModeResult,
  SessionStatus,
} from '../../shared/types';

/**
 * Hosts headless Claude chat processes over its structured stream transport.
 *
 * One process per `stream` session, spawned as
 * `claude --print --input-format stream-json --output-format stream-json`,
 * which is a persistent bidirectional chat protocol: verified against Claude
 * Code 2.1.252, one process answered three consecutive turns on one session
 * id. Input is one JSON user message per line on stdin; output is an NDJSON
 * event stream — `system/init`, `stream_event` partials, `assistant`,
 * `result` — which is plane 2 speaking in its richest form. Nothing here is
 * a PTY and nothing here parses pixels.
 *
 * Content deliberately does not flow through this class into the UI. A
 * headless session writes the same transcript an interactive one does (also
 * verified), so the conversation view keeps reading the transcript for every
 * session alike; the stream drives status and identity, which are the parts
 * the transcript cannot carry live.
 *
 * **Permission asks ride the same wire, and without them a stream session
 * cannot ask at all.** Headless Claude has no dialog to display, so a call
 * that would prompt is auto-denied with `no approval surface in this
 * session; permission request denied automatically` unless the host declares
 * one. `--permission-prompt-tool stdio` is that declaration: from then on the
 * CLI sends a `control_request`/`can_use_tool` down stdout and *holds the
 * turn* until a `control_response` comes back on stdin. Verified against
 * Claude Code 2.1.260 — a Write outside the working directory was denied
 * outright without the flag, and with it arrived as a control request
 * carrying the path, the reason (`Path is outside allowed working
 * directories`) and the CLI's own suggestions; a reply held for 25 seconds
 * was still accepted, and a `deny` reached the model as the tool result.
 */

/**
 * A `can_use_tool` control request, as the CLI sends it.
 *
 * Field names are the wire's, not ours, so the mapping to Sertum's own
 * vocabulary happens in one place at the boundary rather than being guessed
 * at twice.
 */
export interface ChatPermissionAsk {
  /** Sertum's session id. */
  id: string;
  /** The control request this answers; the CLI matches replies on it. */
  requestId: string;
  toolName: string;
  displayName: string;
  input: Record<string, unknown>;
  /** The CLI's own one-line summary of the call, when it wrote one. */
  description?: string;
  /** Why the ask escalated. May carry ANSI escapes -- treat as untrusted. */
  reason?: string;
  /** `workingDir`, `safetyCheck`, `rule`, … -- policy without parsing prose. */
  reasonType?: string;
  /**
   * True when one-tap approve/deny must not be offered because the tool's own
   * card is the consent surface. Sertum cannot draw that card, so this is
   * answered rather than shown.
   */
  requiresUserInteraction: boolean;
  /**
   * True when accepting a persistent rule would be broader than the ask
   * itself, so "always allow" must not be offered for this call.
   */
  suppressAlwaysAllow: boolean;
}

/** The host's answer to one ask. `deny` carries the message the model reads. */
export type ChatPermissionAnswer =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export interface ChatStreamEvents {
  /** A status or activity change, mapped from the stream. */
  update: { id: string; status?: SessionStatus; activity?: string };
  /**
   * The session announced itself: its own id, the model, and the permission
   * mode actually in effect -- which is the user's own `defaultMode` unless
   * something set it, and is read rather than assumed.
   */
  init: {
    id: string;
    sessionId: string;
    model: string | null;
    permissionMode: PermissionMode | null;
  };
  /** The process ended. */
  exit: { id: string; exitCode: number };
  /** A tool call is held open waiting for an answer. */
  permission: ChatPermissionAsk;
  /**
   * The CLI withdrew an ask -- the turn was interrupted, or another client
   * answered it. Nothing is owed in reply; the bar showing it comes down.
   */
  'permission-cancelled': { id: string; requestId: string };
}

interface Hosted {
  child: ChildProcess;
  buf: string;
  /** Rejected writes after exit answer false instead of throwing. */
  alive: boolean;
  /** Asks this process is still holding a turn open for. */
  pendingAsks: Set<string>;
  /** Requests *we* sent, waiting on the CLI's answer. */
  replies: Map<string, (r: ControlReply) => void>;
  nextRequest: number;
}

/** The CLI's answer to one request of ours. */
type ControlReply =
  | { ok: true; response: Record<string, unknown> }
  | { ok: false; reason: string };

export class ClaudeChatHost extends EventEmitter {
  private hosted = new Map<string, Hosted>();

  has(id: string): boolean {
    return this.hosted.get(id)?.alive === true;
  }

  /**
   * Spawns the headless process. Returns its pid, or null when the spawn
   * failed synchronously — the caller decides what a failed session becomes.
   */
  spawn(
    id: string,
    opts: {
      command: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
    },
  ): number | null {
    let child: ChildProcess;
    try {
      child = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Never a shell: the command is a resolved executable path and the
        // args carry a JSON settings blob no shell quoting should touch.
        shell: false,
        windowsHide: true,
      });
    } catch {
      return null;
    }
    if (child.pid === undefined) return null;

    const entry: Hosted = {
      child,
      buf: '',
      alive: true,
      pendingAsks: new Set(),
      replies: new Map(),
      nextRequest: 1,
    };
    this.hosted.set(id, entry);

    child.stdout?.on('data', (chunk: Buffer) => {
      entry.buf += chunk.toString('utf8');
      let at: number;
      while ((at = entry.buf.indexOf('\n')) >= 0) {
        const line = entry.buf.slice(0, at).trim();
        entry.buf = entry.buf.slice(at + 1);
        if (line) this.handleLine(id, line);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) console.warn(`[claude-chat ${id.slice(0, 8)}]`, text.slice(0, 300));
    });
    child.on('error', (err) => {
      console.warn(`[claude-chat ${id.slice(0, 8)}] spawn error:`, err.message);
      entry.alive = false;
      this.emit('exit', { id, exitCode: -1 } satisfies ChatStreamEvents['exit']);
      this.hosted.delete(id);
    });
    child.on('exit', (code) => {
      entry.alive = false;
      // Anything still waiting on this process will never be answered, so it
      // is told rather than left to its deadline.
      for (const settle of [...entry.replies.values()]) {
        settle({ ok: false, reason: 'The session ended.' });
      }
      entry.replies.clear();
      this.emit('exit', {
        id,
        exitCode: code ?? -1,
      } satisfies ChatStreamEvents['exit']);
      this.hosted.delete(id);
    });

    return child.pid;
  }

  /** One user message down the wire. The turn begins when Claude reads it. */
  send(id: string, text: string): boolean {
    const entry = this.hosted.get(id);
    if (!entry?.alive || !entry.child.stdin?.writable) return false;
    const message = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
    try {
      entry.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      return false;
    }
    // The stream stays silent until the model starts answering, so the send
    // itself is the moment the session stops being idle.
    this.update(id, { status: 'working', activity: 'thinking' });
    return true;
  }

  /**
   * Answers one held `can_use_tool` request.
   *
   * Returns false when the ask is no longer live -- the process ended, or the
   * CLI withdrew it -- so the caller can tell "answered" from "too late"
   * rather than assuming the turn resumed.
   */
  answerPermission(
    id: string,
    requestId: string,
    answer: ChatPermissionAnswer,
  ): boolean {
    const entry = this.hosted.get(id);
    if (!entry?.pendingAsks.delete(requestId)) return false;
    return this.writeLine(entry, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        // `decisionClassification` is telemetry the CLI would otherwise infer
        // conservatively. Sertum knows what actually happened -- a person
        // pressed a button -- so it says so rather than leaving it to a guess.
        response:
          answer.behavior === 'allow'
            ? {
                behavior: 'allow',
                ...(answer.updatedInput ? { updatedInput: answer.updatedInput } : {}),
                decisionClassification: 'user_temporary',
              }
            : {
                behavior: 'deny',
                message: answer.message,
                decisionClassification: 'user_reject',
              },
      },
    });
  }

  /**
   * Changes how the agent decides permissions for the rest of the session.
   *
   * `set_permission_mode` is a stable control request the *host* sends, and
   * the CLI answers with the mode now in effect -- so what comes back is what
   * happened, not what was asked for. Verified against Claude Code 2.1.260:
   * `plan`, `acceptEdits`, `dontAsk`, `auto` and `default` all take, `manual`
   * is accepted and normalises to `default`, an unknown mode is refused by
   * name, and `bypassPermissions` is refused unless the process was launched
   * with `--dangerously-skip-permissions`. Every refusal arrives as an error
   * subtype carrying a sentence worth showing.
   */
  async setPermissionMode(
    id: string,
    mode: PermissionMode,
  ): Promise<PermissionModeResult> {
    const reply = await this.request(id, { subtype: 'set_permission_mode', mode });
    if (!reply.ok) return reply;
    // The echoed mode wins: `manual` comes back as `default`, and a CLI that
    // silently substituted something else must not be reported as agreeing.
    const echoed = reply.response.mode;
    return {
      ok: true,
      mode: typeof echoed === 'string' ? (echoed as PermissionMode) : mode,
    };
  }

  /**
   * Stops the current turn immediately over the control channel, rather
   * than waiting for a hook boundary that pure text generation may never
   * reach before the turn ends on its own.
   *
   * Verified against Claude Code 2.1.261: `interrupt` is a control request
   * like `set_permission_mode`, not something the model reads. Sent while a
   * `content_block_delta` was streaming, the `control_response` landed in
   * single-digit milliseconds and the turn's `result` record followed within
   * the same tick, carrying `terminal_reason: 'aborted_streaming'` — the
   * signal `handleLine` below reports as an interruption rather than a
   * failure. The process stayed live and answered a following turn normally.
   */
  async interrupt(id: string): Promise<boolean> {
    const reply = await this.request(id, { subtype: 'interrupt' });
    return reply.ok;
  }

  /**
   * One request of ours, matched to its answer by id.
   *
   * The deadline exists because this is the one direction with nothing else
   * to notice a stall: a control request the CLI never answers would leave a
   * menu item spinning for the life of the session.
   */
  private request(
    id: string,
    request: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<ControlReply> {
    const entry = this.hosted.get(id);
    if (!entry?.alive) {
      return Promise.resolve({ ok: false, reason: 'The session is not running.' });
    }
    const requestId = `sertum-${entry.nextRequest++}`;
    return new Promise<ControlReply>((resolve) => {
      let done = false;
      const settle = (r: ControlReply): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        entry.replies.delete(requestId);
        resolve(r);
      };
      const timer = setTimeout(
        () => settle({ ok: false, reason: 'The agent did not answer in time.' }),
        timeoutMs,
      );
      timer.unref?.();
      entry.replies.set(requestId, settle);
      if (!this.writeLine(entry, { type: 'control_request', request_id: requestId, request })) {
        settle({ ok: false, reason: 'The session’s input stream is closed.' });
      }
    });
  }

  kill(id: string): void {
    const entry = this.hosted.get(id);
    if (!entry) return;
    try {
      entry.child.kill();
    } catch {
      // Already gone.
    }
  }

  /**
   * Ends a session's process, escalating exactly as the PTY path does: the
   * polite signal first, SIGKILL if it is ignored. Resolves true once the
   * process is confirmed gone.
   */
  async terminate(id: string, graceMs = 3000): Promise<boolean> {
    const entry = this.hosted.get(id);
    if (!entry?.alive) return true;

    const exited = (ms: number) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          entry.child.off('exit', onExit);
          resolve(false);
        }, ms);
        const onExit = () => {
          clearTimeout(timer);
          resolve(true);
        };
        entry.child.once('exit', onExit);
      });

    const grace = exited(graceMs);
    try {
      entry.child.kill();
    } catch {
      return true;
    }
    if (await grace) return true;

    const forced = exited(2000);
    try {
      entry.child.kill('SIGKILL');
    } catch {
      return true;
    }
    return forced;
  }

  disposeAll(): void {
    for (const id of [...this.hosted.keys()]) this.kill(id);
  }

  // -------------------------------------------------------------- the stream

  private handleLine(id: string, line: string): void {
    if (!line.startsWith('{')) return;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    // The control channel shares the stream with conversation records and is
    // answered here rather than falling through to the status mapping below.
    if (
      rec.type === 'control_request' ||
      rec.type === 'control_cancel_request' ||
      rec.type === 'keep_alive' ||
      rec.type === 'control_response'
    ) {
      this.handleControl(id, rec);
      return;
    }

    switch (rec.type) {
      case 'system': {
        if (rec.subtype !== 'init') return;
        const sessionId = typeof rec.session_id === 'string' ? rec.session_id : null;
        const model = typeof rec.model === 'string' ? rec.model : null;
        if (sessionId) {
          this.emit('init', {
            id,
            sessionId,
            model,
            // The mode actually in effect, which is the user's own
            // `defaultMode` setting unless something has changed it.
            permissionMode:
              typeof rec.permissionMode === 'string'
                ? (rec.permissionMode as PermissionMode)
                : null,
          } satisfies ChatStreamEvents['init']);
        }
        // Init opens every turn, so it only means "ready" before the first.
        this.update(id, { activity: 'ready' });
        return;
      }
      case 'stream_event': {
        const event = rec.event as Record<string, unknown> | undefined;
        if (!event) return;
        if (event.type === 'content_block_start') {
          const block = event.content_block as Record<string, unknown> | undefined;
          if (block?.type === 'tool_use' && typeof block.name === 'string') {
            this.update(id, { status: 'working', activity: `${block.name}…` });
          } else if (block?.type === 'thinking') {
            this.update(id, { status: 'working', activity: 'thinking' });
          } else if (block?.type === 'text') {
            this.update(id, { status: 'working', activity: 'responding' });
          }
        }
        return;
      }
      case 'result': {
        // An interrupted turn also carries `is_error: true` -- Claude has no
        // other record of how the turn ended -- so `terminal_reason` is
        // checked first to tell a user's own Stop apart from a real failure.
        const interrupted = rec.terminal_reason === 'aborted_streaming';
        const failed = !interrupted && rec.is_error === true;
        this.update(id, {
          status: failed ? 'attention' : 'idle',
          activity: interrupted
            ? 'turn interrupted'
            : failed
              ? 'turn failed'
              : 'turn finished',
        });
        return;
      }
      default:
        // `assistant` and `user` records carry content the transcript already
        // holds; the conversation view reads it there.
        return;
    }
  }

  /**
   * The control channel, which is a request/response protocol in both
   * directions over the same NDJSON stream.
   *
   * Only `can_use_tool` is expected: the other CLI-to-host subtypes
   * (`hook_callback`, `mcp_message`, `elicitation`, `request_user_dialog`)
   * are only sent to a host that opted into them during `initialize`, and
   * Sertum sends no `initialize` at all. An unexpected one is still answered
   * -- with an error, which the protocol has a shape for -- because silence
   * from this side is a turn that never resumes.
   */
  private handleControl(id: string, rec: Record<string, unknown>): void {
    const entry = this.hosted.get(id);
    if (!entry) return;

    // "Either side may send it at any time; receivers must ignore it."
    if (rec.type === 'keep_alive') return;

    // The answer to a request of ours. The id lives one level down here, and
    // an error subtype carries a sentence the caller shows rather than a code.
    if (rec.type === 'control_response') {
      const res =
        rec.response && typeof rec.response === 'object'
          ? (rec.response as Record<string, unknown>)
          : {};
      const settle = entry.replies.get(String(res.request_id ?? ''));
      if (!settle) return;
      if (res.subtype === 'success') {
        settle({
          ok: true,
          response:
            res.response && typeof res.response === 'object'
              ? (res.response as Record<string, unknown>)
              : {},
        });
      } else {
        settle({
          ok: false,
          reason: wireText(res.error) ?? 'The agent refused the request.',
        });
      }
      return;
    }

    const requestId = typeof rec.request_id === 'string' ? rec.request_id : null;
    if (!requestId) return;

    if (rec.type === 'control_cancel_request') {
      // The ask is withdrawn: an interrupted turn, or another client got
      // there first. Nothing is owed in reply, but the bar has to come down
      // or it would ask about a turn that has gone.
      if (entry.pendingAsks.delete(requestId)) {
        this.emit('permission-cancelled', {
          id,
          requestId,
        } satisfies ChatStreamEvents['permission-cancelled']);
      }
      return;
    }

    const request =
      rec.request && typeof rec.request === 'object'
        ? (rec.request as Record<string, unknown>)
        : {};
    if (request.subtype !== 'can_use_tool') {
      this.writeLine(entry, {
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error: `Sertum does not handle control requests of subtype ${String(
            request.subtype ?? 'unknown',
          )}.`,
        },
      });
      return;
    }

    const toolName = String(request.tool_name ?? '');
    entry.pendingAsks.add(requestId);
    this.emit('permission', {
      id,
      requestId,
      toolName,
      displayName: String(request.display_name ?? toolName),
      input:
        request.input && typeof request.input === 'object'
          ? (request.input as Record<string, unknown>)
          : {},
      description: wireText(request.description),
      reason: wireText(request.decision_reason),
      reasonType: wireText(request.decision_reason_type),
      requiresUserInteraction: request.requires_user_interaction === true,
      suppressAlwaysAllow: request.suppress_always_allow_rule === true,
    } satisfies ChatStreamEvents['permission']);
  }

  private writeLine(entry: Hosted, frame: Record<string, unknown>): boolean {
    if (!entry.alive || !entry.child.stdin?.writable) return false;
    try {
      entry.child.stdin.write(`${JSON.stringify(frame)}\n`);
    } catch {
      return false;
    }
    return true;
  }

  private update(
    id: string,
    update: { status?: SessionStatus; activity?: string },
  ): void {
    this.emit('update', { id, ...update } satisfies ChatStreamEvents['update']);
  }
}

/**
 * A wire string, or undefined when it is absent or blank. These fields are
 * producer-authored and may carry ANSI escapes, so they are display-sanitised
 * where they are rendered rather than trusted here.
 */
function wireText(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
