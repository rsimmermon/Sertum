import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type {
  AgentEffortList,
  AgentModel,
  AgentModelList,
  EffortChangeResult,
  ModelChangeResult,
  PermissionMode,
  PermissionModeResult,
  SessionStatus,
  ChatAttachment,
} from '../../shared/types';
import { promptWithAttachments } from '../../shared/chat-attachments';
import { readChatImage } from '../chat-attachments';

/** See `Hosted.awaitingResumeSettle`. */
const RESUME_SETTLE_MS = 2000;

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
  /**
   * A `--resume`d process still settling in, so the first turn sent to it
   * queues here instead of writing immediately. Cleared by a timer, not an
   * event: there is no stream record for "history finished loading" to wait
   * on, and `system/init` is not it -- verified by the deadlock that
   * resulted from gating on `init` instead, where a resumed process given no
   * input first stayed completely silent for 60+ seconds, proving `init`
   * itself needs a turn to open ("Init opens every turn," see below) rather
   * than announcing readiness on its own. Undefined (not merely false) for
   * an ordinary fresh spawn, which must never queue at all -- the same
   * chicken-and-egg deadlock applies to it even harder, since it has no
   * history to fall back on either.
   *
   * `RESUME_SETTLE_MS` of real wall-clock time is what was actually verified
   * against Claude Code 2.1.263 to work: a message written immediately after
   * `--resume` spawn came back "No response requested." instead of an
   * answer, while the identical message held for this long answered
   * correctly and recalled the earlier turn.
   */
  awaitingResumeSettle?: {
    queued: Array<{ text: string; attachments: ChatAttachment[] }>;
    timer: NodeJS.Timeout;
  };
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
      /** True when `args` carries `--resume`. See `Hosted.awaitingResumeSettle`. */
      resuming?: boolean;
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
    } catch (error) {
      // The caller only learns that the session could not start, and the
      // reason is exactly what is needed to tell a missing binary from a
      // refused one -- so it goes to the daemon's log rather than nowhere.
      console.error(`[claude-chat] spawn of ${opts.command} failed:`, error);
      return null;
    }
    if (child.pid === undefined) {
      // A spawn that fails asynchronously -- the usual Windows shape, since
      // `CreateProcess` errors arrive as an `error` event rather than as a
      // throw -- leaves a ChildProcess with no pid that is *still going to
      // emit* `error`. Returning here without listening for it made that an
      // unhandled `error` event, which takes the whole daemon down: one
      // unstartable session ended every other session on the machine. So the
      // listener goes on before the early return, and its only job is to say
      // why in the log the caller cannot reach.
      child.once('error', (err) => {
        console.error(`[claude-chat] spawn of ${opts.command} failed:`, err.message);
      });
      return null;
    }

    const entry: Hosted = {
      child,
      buf: '',
      alive: true,
      pendingAsks: new Set(),
      replies: new Map(),
      nextRequest: 1,
    };
    if (opts.resuming) {
      entry.awaitingResumeSettle = {
        queued: [],
        timer: setTimeout(() => this.releaseResumeSettle(id), RESUME_SETTLE_MS),
      };
    }
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
      if (entry.awaitingResumeSettle) clearTimeout(entry.awaitingResumeSettle.timer);
      this.emit('exit', { id, exitCode: -1 } satisfies ChatStreamEvents['exit']);
      this.hosted.delete(id);
    });
    child.on('exit', (code) => {
      entry.alive = false;
      if (entry.awaitingResumeSettle) clearTimeout(entry.awaitingResumeSettle.timer);
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

  /**
   * One user message down the wire. The turn begins when Claude reads it --
   * except for a `--resume`d process still settling in, which queues the
   * text instead. See `Hosted.awaitingResumeSettle`.
   */
  send(id: string, text: string, attachments: ChatAttachment[] = []): boolean {
    const entry = this.hosted.get(id);
    if (!entry?.alive || !entry.child.stdin?.writable) return false;
    if (entry.awaitingResumeSettle) {
      entry.awaitingResumeSettle.queued.push({ text, attachments });
    } else if (!this.writeUserMessage(entry, text, attachments)) {
      return false;
    }
    // The stream stays silent until the model starts answering (or until the
    // settle timer releases a queued turn), so the send itself is the moment
    // the session stops being idle.
    this.update(id, { status: 'working', activity: 'thinking' });
    return true;
  }

  private writeUserMessage(
    entry: Hosted,
    text: string,
    attachments: ChatAttachment[],
  ): boolean {
    const images = attachments
      .map((attachment) => ({ attachment, image: readChatImage(attachment) }))
      .filter((candidate): candidate is {
        attachment: ChatAttachment;
        image: { mime: string; data: string };
      } => candidate.image !== null);
    const nativeImages = new Set(images.map(({ attachment }) => attachment.path));
    const prompt = promptWithAttachments(text, attachments, nativeImages);
    const message = {
      type: 'user',
      message: {
        role: 'user',
        // Images precede the prompt, matching Claude's preferred multimodal
        // ordering. Files without a native block remain explicit paths in it.
        content: [
          ...images.map(({ image }) => ({
            type: 'image',
            source: { type: 'base64', media_type: image.mime, data: image.data },
          })),
          { type: 'text', text: prompt },
        ],
      },
    };
    try {
      entry.child.stdin!.write(`${JSON.stringify(message)}\n`);
    } catch {
      return false;
    }
    return true;
  }

  /** Flushes whatever queued while a resumed process was settling in. */
  private releaseResumeSettle(id: string): void {
    const entry = this.hosted.get(id);
    if (!entry?.awaitingResumeSettle) return;
    const { queued } = entry.awaitingResumeSettle;
    entry.awaitingResumeSettle = undefined;
    for (const message of queued) {
      this.writeUserMessage(entry, message.text, message.attachments);
    }
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
   * The models this session could run, asked of the session itself.
   *
   * `list_models` is a control request like `set_permission_mode`, and its
   * answer is the account's own catalogue rather than anything Sertum keeps
   * -- verified against Claude Code 2.1.266, which answered before any turn
   * had opened, listing `default`, `opus[1m]`, `claude-fable-5-1[1m]`,
   * `sonnet` and `haiku` with the id to send in `value` and the model each
   * one actually resolves to in `resolvedModel`.
   */
  async listModels(id: string): Promise<AgentModelList> {
    const reply = await this.request(id, { subtype: 'list_models' });
    if (!reply.ok) return reply;
    const rows = Array.isArray(reply.response.models) ? reply.response.models : [];
    const models = rows.map(claudeModel).filter((m): m is AgentModel => m !== null);
    if (!models.length) {
      return { ok: false, reason: 'Claude Code listed no models for this session.' };
    }
    // The catalogue does not mark its own current row, so the session is
    // asked separately. Worth the extra control request: before the first
    // turn nothing else knows, and the answer is what puts a tick in the
    // picker and a name on the chip instead of "Model".
    return { ok: true, models, current: (await this.appliedSettings(id))?.model ?? null };
  }

  /**
   * Switches the model for the rest of the session.
   *
   * `set_model` takes the catalogue's `value` and answers success with no
   * payload at all -- unlike `set_permission_mode`, there is nothing echoed
   * to read the result off -- so the resolved name is looked up in the same
   * catalogue the picker was built from rather than guessed. A model the CLI
   * does not recognise is refused by name, and that sentence is worth
   * showing: verified against Claude Code 2.1.266, `not-a-model` came back
   * as `Model "not-a-model" is not a recognized model id. Run /model to see
   * available models.`
   *
   * Sent mid-turn it is still accepted immediately -- also verified, 20ms
   * into a turn that then ran for another 55 seconds -- and the running turn
   * keeps the model it started with, while the next turn's `system/init`
   * reports the new one. That is what `appliesToNextTurn` is telling the
   * reader about; nothing here waits for the turn to end.
   */
  async setModel(id: string, model: string): Promise<ModelChangeResult> {
    const reply = await this.request(id, { subtype: 'set_model', model });
    if (!reply.ok) return reply;
    const listed = await this.listModels(id);
    const resolved = listed.ok
      ? listed.models.find((m) => m.id === model)?.resolved
      : null;
    return { ok: true, model: resolved || model, appliesToNextTurn: false };
  }

  /**
   * The thinking levels this session could run, off the catalogue's own rows.
   *
   * `list_models` rows carry `supportedEffortLevels` -- verified against
   * Claude Code 2.1.266, which listed `low,medium,high,xhigh,max` on each of
   * `default`, `opus[1m]`, `claude-fable-5-1[1m]` and `sonnet`, and nothing
   * at all on `haiku`. The ladder therefore belongs to a model rather than to
   * the account, and the row read is the one for the model this session is
   * actually on: `applied.model` from `get_settings`, which is the session's
   * own answer, with the caller's snapshot as the fallback while the session
   * has not been asked yet.
   *
   * `supportsAdaptiveThinking` is deliberately not offered. It is real, and
   * there is no verified way to *select* it over this channel --
   * `apply_flag_settings` takes a level string -- so offering it would be a
   * row that does nothing.
   */
  async listEfforts(id: string, model: string | null): Promise<AgentEffortList> {
    const reply = await this.request(id, { subtype: 'list_models' });
    if (!reply.ok) return reply;
    const rows = Array.isArray(reply.response.models) ? reply.response.models : [];
    const applied = await this.appliedSettings(id);
    const current = applied?.model ?? model;
    const levels = claudeEffortLevels(rows, current);
    if (levels.length === 0) {
      return {
        ok: false,
        reason: current
          ? `Claude Code lists no thinking levels for ${current}.`
          : 'Claude Code listed no thinking levels for this session.',
      };
    }
    return {
      ok: true,
      // The level is its own name here: Claude publishes the word it also
      // reports back, and there is no description on the row to carry.
      efforts: levels.map((level) => ({ id: level, label: level, note: null })),
      current: applied?.effort ?? null,
    };
  }

  /**
   * Switches the thinking level for the rest of the session, then reads back
   * what the session actually ended up on.
   *
   * The channel is `apply_flag_settings { effortLevel }` -- the session-scoped
   * flag layer -- because there is no `set_effort` control request: the only
   * other mid-session thinking knob is `set_max_thinking_tokens`, which takes
   * a numeric budget and, per Claude's own description, means *no* effort
   * parameter is sent at all. Verified against Claude Code 2.1.266: the key
   * is `effortLevel` and not `effort`, and `get_settings().applied.effort`
   * moved to `low` and then `high` as asked.
   *
   * The read-back is not a nicety. That same probe sent `effortLevel:
   * "bogus"` and got `{"subtype":"success"}` back with the level unchanged --
   * accepted and ignored, exactly the silent-no-op failure the `http` hook
   * type taught this project to check for. So the answer is what the session
   * reports afterwards: unchanged means refused and is reported as such, and
   * a level the model quietly downgrades is reported as the level it landed
   * on rather than the one that was asked for.
   */
  async setEffort(id: string, effort: string): Promise<EffortChangeResult> {
    const before = (await this.appliedSettings(id))?.effort ?? null;
    const applied = await this.request(id, {
      subtype: 'apply_flag_settings',
      settings: { effortLevel: effort },
    });
    if (!applied.ok) return applied;
    const now = (await this.appliedSettings(id))?.effort ?? null;
    if (now === null) {
      return {
        ok: false,
        reason: 'Claude Code did not report a thinking level after the change.',
      };
    }
    if (now === before && now !== effort) {
      return {
        ok: false,
        reason: `Claude Code kept ${now} — it did not accept ${effort} for this session’s model.`,
      };
    }
    return { ok: true, effort: now, appliesToNextTurn: false };
  }

  /**
   * What this session will actually send on its next request.
   *
   * `get_settings` answers with the merged settings, the raw per-source
   * settings, and `applied` -- the resolved pair the session will use, "after
   * env overrides, session state, org caps and model-support downgrades" in
   * Claude's own words. That last part is why `applied` is read rather than
   * `effective`: the two disagree whenever a level is downgraded, and the one
   * worth showing is the one that will be sent.
   */
  private async appliedSettings(
    id: string,
  ): Promise<{ model: string | null; effort: string | null } | null> {
    const reply = await this.request(id, { subtype: 'get_settings' });
    if (!reply.ok) return null;
    const applied = reply.response.applied;
    if (!applied || typeof applied !== 'object') return null;
    const row = applied as Record<string, unknown>;
    return {
      model: typeof row.model === 'string' ? row.model : null,
      effort: typeof row.effort === 'string' ? row.effort : null,
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
 * One catalogue row, in the wire's own field names.
 *
 * `value` is what `set_model` takes and `resolvedModel` is what a turn will
 * report, so both are kept: the first is what we send, the second is what we
 * will be told back.
 */
function claudeModel(row: unknown): AgentModel | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const id = wireText(r.value);
  if (!id) return null;
  return {
    id,
    label: wireText(r.displayName) ?? id,
    note: wireText(r.description) ?? null,
    resolved: wireText(r.resolvedModel) ?? null,
  };
}

/**
 * The effort ladder for one model, out of the `list_models` rows.
 *
 * The row for `current` when one matches -- on either the id sent or the
 * model it resolves to, the same two names `isCurrent` matches on in the
 * picker -- and otherwise the first row that publishes a ladder at all, so a
 * session whose model has not been named yet still gets the levels it will
 * almost certainly have rather than an empty menu.
 */
function claudeEffortLevels(rows: unknown[], current: string | null): string[] {
  const ladders = rows.map((row) => {
    const r = (row ?? {}) as Record<string, unknown>;
    const levels = Array.isArray(r.supportedEffortLevels)
      ? r.supportedEffortLevels.filter((v): v is string => typeof v === 'string')
      : [];
    const names = [wireText(r.value), wireText(r.resolvedModel)].filter(
      (v): v is string => v !== undefined,
    );
    return { levels, names };
  });
  const match = current
    ? ladders.find((row) =>
        row.names.some(
          (name) =>
            name === current ||
            name.startsWith(`${current}[`) ||
            current.startsWith(`${name}[`),
        ),
      )
    : undefined;
  // A matched row is the answer even when its ladder is empty: haiku
  // publishes no `supportedEffortLevels` at all, and falling through to
  // another model's rungs would offer levels this session cannot run. The
  // fallback is only for not knowing which model is answering yet.
  if (match) return match.levels;
  return ladders.find((row) => row.levels.length > 0)?.levels ?? [];
}

/**
 * A wire string, or undefined when it is absent or blank. These fields are
 * producer-authored and may carry ANSI escapes, so they are display-sanitised
 * where they are rendered rather than trusted here.
 */
function wireText(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
