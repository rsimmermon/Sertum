import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import type { PendingApproval, ApprovalAnswer } from '../shared/types';

/** A hook payload, keyed to the Sertum session that produced it. */
export interface HookEvent {
  sessionId: string;
  event: string;
  payload: Record<string, unknown>;
}

/**
 * How long a turn may sit blocked on Sertum's UI.
 *
 * Exported because the hook command has to know it. curl's own deadline must
 * outlast the hold, or the decision can never reach the agent waiting for it.
 */
export const APPROVAL_HOLD_MS = 120_000;

/**
 * Permission modes in which a bar must never appear.
 *
 * `permission_mode` rides on every hook payload and reports `bypassPermissions`,
 * `dontAsk`, `acceptEdits` and `plan` faithfully -- but collapses both `auto`
 * and `manual` to `default`, so it can never be the thing that decides whether
 * a person is needed. It is only used to refuse, never to ask.
 */
const NEVER_ASK_MODES = new Set(['bypassPermissions', 'dontAsk']);

/**
 * A `PermissionRequest` reply. The decision nests under `decision` and names
 * itself `behavior`, unlike `PreToolUse`'s flat `permissionDecision`; a reply
 * in the wrong shape is rejected and the dialog stays up.
 */
function permissionRequestDecision(
  behavior: 'allow' | 'deny',
  message?: string,
): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: behavior === 'allow' ? { behavior } : { behavior, message },
    },
  };
}

/**
 * Plane 2 ingress for Claude Code.
 *
 * Each session is spawned with a settings blob whose hook URLs carry that
 * session's own id, so an arriving event is attributable to exactly one pane
 * with no correlation guesswork. `http` hooks are used rather than `command`
 * hooks deliberately: a shell-command hook would be a per-OS script to
 * maintain, while an HTTP POST is identical on macOS, Linux and Windows.
 *
 * Bound to loopback only. The path segment is a UUID, so other local
 * processes cannot guess a session's endpoint. Claude Code currently reaches
 * it through command hooks whose curl stdout carries the structured response;
 * the server remains HTTP even though the hook declaration is not.
 */
export class HookServer extends EventEmitter {
  private server: http.Server | null = null;
  private boundPort = 0;
  private received = 0;
  /** Control replies waiting for the next attributable hook boundary. */
  private pendingInterrupts = new Set<string>();
  private pendingSteers = new Map<string, string>();
  /** Sessions whose PreToolUse requests are denied until explicitly resumed. */
  private toolGates = new Set<string>();
  /**
   * Sessions that answer permission questions on their own channel.
   *
   * A conversation session declares an approval surface with
   * `--permission-prompt-tool stdio`, and the CLI then does *both* things for
   * one call: it holds a `can_use_tool` control request open on the session's
   * own stream, and it fires `PermissionRequest` here, because a dialog was
   * raised. Answering both would ask the reader twice for one call and let
   * the two answers disagree -- a rule denying here while the control channel
   * had already allowed. The control request is the one with the turn behind
   * it, so this hook becomes a no-op for those sessions.
   */
  private hostAnswered = new Set<string>();

  /**
   * Asks the permission rules about one tool call. Injected rather than
   * imported so the hook server keeps knowing only about hook shapes, and so
   * a session's cwd is resolved by whoever owns sessions.
   *
   * `ruled` distinguishes the two things that arrive as `ask`: a rule the
   * user deliberately set to ask, which should raise a question the agent
   * would not have raised, and no matching rule at all, which is silence.
   */
  evaluatePermission?: (
    sessionId: string,
    payload: Record<string, unknown>,
  ) =>
    | { decision: 'allow' | 'deny'; reason: string }
    | { decision: 'ask'; subject: string; ruled: boolean }
    | null;

  /**
   * Announces a permission dialog waiting on B5's approval bar. Absent means
   * in-app approval is off, and the question stays where Claude put it.
   */
  onApprovalNeeded?: (request: PendingApproval) => void;

  /** Tells the UI to take a bar down that no longer has a turn behind it. */
  onApprovalGone?: (id: string) => void;

  /**
   * Calls held open waiting for a person, keyed by request id.
   *
   * The request itself is kept, not just how to settle it, because a window
   * that reloads or is closed to the tray loses its copy and has to be able
   * to ask what is still waiting -- see `pending`.
   */
  private pendingApprovals = new Map<
    string,
    {
      request: PendingApproval;
      settle: (answer: ApprovalAnswer | null) => void;
    }
  >();

  /** Every call still waiting for a person, oldest first. */
  pending(): PendingApproval[] {
    return [...this.pendingApprovals.values()].map((e) => e.request);
  }

  /**
   * How long a turn may sit blocked on Sertum's UI.
   *
   * Holding the hook response is what makes B5 possible, and it is also the
   * one thing here that can stall an agent. On expiry the call is released
   * with no decision, and Claude's own dialog is still on screen to answer: a
   * person who walked away costs a delay, never a wedged session.
   */
  approvalTimeoutMs = APPROVAL_HOLD_MS;

  async start(): Promise<number> {
    if (this.server) return this.boundPort;

    this.server = http.createServer((req, res) => {
      const match = /^\/hook\/([A-Za-z0-9-]+)\/?$/.exec(req.url ?? '');
      if (req.method !== 'POST' || !match) {
        res.writeHead(404).end();
        return;
      }
      const sessionId = match[1];

      let body = '';
      let tooLarge = false;
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) {
          tooLarge = true;
          req.destroy();
        }
      });
      req.on('end', () => {
        if (tooLarge) return;
        let payload: Record<string, unknown> = {};
        try {
          payload = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        } catch {
          res.writeHead(204).end();
          return;
        }
        this.received += 1;
        const event = String(payload.hook_event_name ?? 'Unknown');
        this.emit('hook', { sessionId, event, payload } satisfies HookEvent);

        // A held call has a turn behind it only for as long as its connection
        // lives. curl giving up, or the user interrupting Claude, closes the
        // socket with no answer -- and a bar still asking about a turn that
        // has gone is exactly the false claim the two planes exist to prevent.
        let abandon: (() => void) | null = null;
        res.on('close', () => {
          if (!res.writableEnded) abandon?.();
        });

        void this.controlReply(sessionId, event, payload, (cancel) => {
          abandon = cancel;
        }).then(
          (reply) => {
            if (res.writableEnded) return;
            if (reply) {
              // A command hook's stdout is its structured reply. curl writes
              // this body to stdout, so no shell or PTY interpretation is
              // involved.
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(reply));
            } else {
              // Always answer 2xx: a hook error can block the agent's turn. An
              // empty 204 keeps curl's stdout empty when there is no control
              // word.
              res.writeHead(204).end();
            }
          },
          () => {
            // A thrown reply must still answer, or the turn never resumes.
            if (!res.writableEnded) res.writeHead(204).end();
          },
        );
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });

    this.boundPort = (this.server!.address() as AddressInfo).port;
    return this.boundPort;
  }

  get port(): number {
    return this.boundPort;
  }

  get eventCount(): number {
    return this.received;
  }

  urlFor(sessionId: string): string {
    return `http://127.0.0.1:${this.boundPort}/hook/${sessionId}`;
  }

  /** Stop the session's current turn at its next structured hook boundary. */
  queueInterrupt(sessionId: string): void {
    this.pendingInterrupts.add(sessionId);
  }

  /** Add application context when this session next submits a user prompt. */
  queueSteer(sessionId: string, text: string): void {
    this.pendingSteers.set(sessionId, text);
  }

  setToolGate(sessionId: string, paused: boolean): void {
    if (paused) this.toolGates.add(sessionId);
    else this.toolGates.delete(sessionId);
  }

  /** Declares that this session's permissions are answered elsewhere. */
  setHostAnsweredPermissions(sessionId: string, on: boolean): void {
    if (on) this.hostAnswered.add(sessionId);
    else this.hostAnswered.delete(sessionId);
  }

  /** Forget control words for a session that no longer exists. */
  clearControl(sessionId: string): void {
    this.pendingInterrupts.delete(sessionId);
    this.pendingSteers.delete(sessionId);
    this.toolGates.delete(sessionId);
    this.hostAnswered.delete(sessionId);
    this.cancelApprovals(sessionId);
  }

  /**
   * Answers a call that B5 is showing. `null` releases it with no decision,
   * which is what a timeout and a dead session both do.
   */
  resolveApproval(id: string, answer: ApprovalAnswer | null): void {
    this.pendingApprovals.get(id)?.settle(answer);
  }

  /** Releases every call a session is holding, so a dead PTY leaves none. */
  cancelApprovals(sessionId: string): void {
    for (const entry of [...this.pendingApprovals.values()]) {
      if (entry.request.sessionId === sessionId) entry.settle(null);
    }
  }

  private awaitApproval(
    sessionId: string,
    payload: Record<string, unknown>,
    subject: string,
    onHold?: (cancel: () => void) => void,
  ): Promise<ApprovalAnswer | null> {
    const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      let done = false;
      const settle = (answer: ApprovalAnswer | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pendingApprovals.delete(id);
        this.onApprovalGone?.(id);
        resolve(answer);
      };
      const timer = setTimeout(() => settle(null), this.approvalTimeoutMs);
      timer.unref?.();
      const request: PendingApproval = {
        id,
        sessionId,
        tool: String(payload.tool_name ?? 'a tool'),
        subject,
      };
      this.pendingApprovals.set(id, { request, settle });
      // Registered before the bar is announced, so a connection that dies in
      // the same tick still has something to release.
      onHold?.(() => settle(null));
      this.onApprovalNeeded?.(request);
    });
  }

  private async controlReply(
    sessionId: string,
    event: string,
    payload: Record<string, unknown>,
    onHold?: (cancel: () => void) => void,
  ): Promise<Record<string, unknown> | null> {
    if (this.pendingInterrupts.delete(sessionId)) {
      return {
        continue: false,
        stopReason: 'Turn interrupted from Sertum.',
      };
    }

    if (event === 'PreToolUse') return this.preToolUseReply(sessionId, payload);
    if (event === 'PermissionRequest') {
      return this.permissionRequestReply(sessionId, payload, onHold);
    }

    if (event !== 'UserPromptSubmit') return null;
    const steer = this.pendingSteers.get(sessionId);
    if (!steer) return null;
    this.pendingSteers.delete(sessionId);
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: steer,
      },
    };
  }

  /**
   * Answers the boundary that fires before *every* tool call.
   *
   * Nothing here ever holds. `PreToolUse` is Claude Code's "before tool
   * execution" event, not a permission event: it fires for a Read the agent
   * would have run silently exactly as it fires for a Bash command a person
   * needs to see. Verified against Claude Code 2.1.251 -- it arrives under
   * `bypassPermissions`, `dontAsk`, `acceptEdits` and `auto` alike, for calls
   * that raise no dialog at all.
   *
   * So the answers given here are the ones Sertum can make *without* being
   * asked: the wholesale gate, and rules the user wrote down. Waiting for a
   * person belongs to `PermissionRequest`, which fires only when Claude
   * actually needs a decision.
   */
  private preToolUseReply(
    sessionId: string,
    payload: Record<string, unknown>,
  ): Record<string, unknown> | null {
    if (this.toolGates.has(sessionId)) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            'Tool use is paused in Sertum. Resume it from the session menu.',
        },
      };
    }

    // Rules are consulted only after the wholesale gate, which is the blunter
    // instrument and must win.
    const decision = this.evaluatePermission?.(sessionId, payload);
    if (!decision) return null;
    if (decision.decision !== 'ask') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision.decision,
          permissionDecisionReason: decision.reason,
        },
      };
    }

    // A rule the user set to `ask` is a request to be asked about calls the
    // agent would otherwise run unprompted, so it answers `ask` here -- which
    // makes Claude raise its dialog, which fires `PermissionRequest`, which is
    // where the bar picks it up. A call *no* rule matched returns nothing at
    // all, so Claude runs its own permission flow exactly as it would without
    // Sertum: an unmatched call is not an approval, and it is not a question
    // either.
    if (!decision.ruled) return null;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'A Sertum permission rule asks about this.',
      },
    };
  }

  /**
   * Holds the one boundary that means a person is genuinely needed -- B5.
   *
   * Claude Code describes `PermissionRequest` as firing "when a permission
   * dialog is displayed", so an arriving event is a question the agent is
   * already blocked on. That is what makes holding it honest: the turn was
   * stopped before Sertum touched it, and answering here is strictly faster
   * than switching to the terminal.
   *
   * The reply shape is *not* `PreToolUse`'s. The decision nests under
   * `decision`, and allow/deny is spelled `behavior`; a flat `behavior` is
   * rejected and the dialog simply stays up. Verified end to end against
   * Claude Code 2.1.251, which acknowledges it in the transcript with
   * "Allowed by PermissionRequest hook".
   */
  private async permissionRequestReply(
    sessionId: string,
    payload: Record<string, unknown>,
    onHold?: (cancel: () => void) => void,
  ): Promise<Record<string, unknown> | null> {
    // With no handler, in-app approval is off: never hold, so turning it off
    // cannot leave a turn waiting on a bar that will not appear.
    if (!this.onApprovalNeeded) return null;

    // The same call is already held open on this session's own control
    // channel, where it is being answered once.
    if (this.hostAnswered.has(sessionId)) return null;

    // A backstop, not the mechanism. A mode that means "do not ask" should
    // not produce a Sertum bar even if a dialog somehow reaches us, because a
    // bar is a question and the user has already answered it for the session.
    // Note this cannot recognise the mode in the screenshot everyone hits:
    // `auto` and `manual` both arrive as `default`. That is fine -- the event
    // itself already carries the fact that a dialog was displayed.
    if (NEVER_ASK_MODES.has(String(payload.permission_mode ?? ''))) return null;

    // Rules are re-consulted here rather than trusted from `PreToolUse`,
    // because Claude issues tool calls in parallel: several can pass that
    // boundary before "Always allow" writes a rule, and their dialogs arrive
    // after it. Re-asking lets the new rule answer them instead of stacking
    // more bars for a call the user has already decided.
    const decision = this.evaluatePermission?.(sessionId, payload);
    if (decision && decision.decision !== 'ask') {
      return permissionRequestDecision(decision.decision, decision.reason);
    }
    // Injected and answered `null` means whoever owns sessions has never heard
    // of this one, so there is no pane to raise a bar in -- and a bar nothing
    // can release would sit there until the timeout.
    if (this.evaluatePermission && !decision) return null;

    const answer = await this.awaitApproval(
      sessionId,
      payload,
      decision?.subject ?? String(payload.tool_name ?? ''),
      onHold,
    );
    // Released with no decision -- expired, or the session went away. Answer
    // nothing, and Claude's own dialog is still on screen to answer.
    if (!answer) return null;
    // `answer` cannot arrive here: a card only ever comes from a conversation
    // session's control channel, and those sessions never reach this hook at
    // all. It is still mapped rather than left to fall through, because the
    // one thing this function must never do is return a shape Claude rejects
    // -- that failure is silent and the dialog just stays up.
    const behavior = answer.decision === 'allow' ? 'allow' : 'deny';
    return permissionRequestDecision(
      behavior,
      answer.reason ??
        (behavior === 'deny' ? 'Denied in Sertum.' : 'Approved in Sertum.'),
    );
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    // Release held calls *before* closing. `server.close()` waits for
    // in-flight requests to finish, and a B5 approval is deliberately an
    // in-flight request with no response yet -- settling afterwards is a
    // deadlock that hangs the quit forever.
    for (const entry of [...this.pendingApprovals.values()]) entry.settle(null);

    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
      // A keep-alive socket can outlive its request, so close() alone is not
      // enough to guarantee the callback runs.
      this.server!.closeAllConnections?.();
    });
    this.server = null;
    this.pendingInterrupts.clear();
    this.pendingSteers.clear();
    this.toolGates.clear();
    this.hostAnswered.clear();
  }
}
