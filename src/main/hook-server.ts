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
   * Asks the permission rules about one tool call. Injected rather than
   * imported so the hook server keeps knowing only about hook shapes, and so
   * a session's cwd is resolved by whoever owns sessions.
   */
  evaluatePermission?: (
    sessionId: string,
    payload: Record<string, unknown>,
  ) =>
    | { decision: 'allow' | 'deny'; reason: string }
    | { decision: 'ask'; subject: string }
    | null;

  /**
   * Announces a tool call waiting on B5's approval bar. Absent means in-app
   * approval is off and an unruled call goes straight to the agent's prompt.
   */
  onApprovalNeeded?: (request: PendingApproval) => void;

  /** Tells the UI to take a bar down that no longer has a turn behind it. */
  onApprovalGone?: (id: string) => void;

  /** Calls held open waiting for a person, keyed by request id. */
  private pendingApprovals = new Map<
    string,
    { sessionId: string; settle: (answer: ApprovalAnswer | null) => void }
  >();

  /**
   * How long a turn may sit blocked on Sertum's UI.
   *
   * Holding the hook response is what makes B5 possible, and it is also the
   * one thing here that can stall an agent. On expiry the call is released
   * with no decision, so Claude falls back to asking in its own TUI: a person
   * who walked away costs a delay, never a wedged session.
   */
  approvalTimeoutMs = 120_000;

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

        void this.controlReply(sessionId, event, payload).then(
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

  /** Forget control words for a session that no longer exists. */
  clearControl(sessionId: string): void {
    this.pendingInterrupts.delete(sessionId);
    this.pendingSteers.delete(sessionId);
    this.toolGates.delete(sessionId);
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
      if (entry.sessionId === sessionId) entry.settle(null);
    }
  }

  private awaitApproval(
    sessionId: string,
    payload: Record<string, unknown>,
    subject: string,
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
      this.pendingApprovals.set(id, { sessionId, settle });
      this.onApprovalNeeded?.({
        id,
        sessionId,
        tool: String(payload.tool_name ?? 'a tool'),
        subject,
      });
    });
  }

  private async controlReply(
    sessionId: string,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    if (this.pendingInterrupts.delete(sessionId)) {
      return {
        continue: false,
        stopReason: 'Turn interrupted from Sertum.',
      };
    }

    if (event === 'PreToolUse' && this.toolGates.has(sessionId)) {
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
    // instrument and must win. `ask` returns nothing at all, so Claude runs
    // its own permission flow exactly as it would without Sertum -- an
    // unmatched call is not an approval.
    if (event === 'PreToolUse') {
      const decision = this.evaluatePermission?.(sessionId, payload);
      if (decision && decision.decision !== 'ask') {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision.decision,
            permissionDecisionReason: decision.reason,
          },
        };
      }

      // Nothing decided it, so ask a person -- wireframe B5. The turn is held
      // here, which is precisely why `awaitApproval` always settles.
      if (this.onApprovalNeeded) {
        const answer = await this.awaitApproval(
          sessionId,
          payload,
          decision?.decision === 'ask'
            ? decision.subject
            : String(payload.tool_name ?? ''),
        );
        if (answer) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: answer.decision,
              permissionDecisionReason:
                answer.reason ??
                (answer.decision === 'deny'
                  ? 'Denied in Sertum.'
                  : 'Approved in Sertum.'),
            },
          };
        }
        // Released with no decision: fall through so Claude asks in its TUI.
      }
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
  }
}
