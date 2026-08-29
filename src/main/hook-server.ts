import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';

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

        const reply = this.controlReply(sessionId, event);
        if (reply) {
          // A command hook's stdout is its structured reply. curl writes this
          // body to stdout, so no shell or PTY interpretation is involved.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(reply));
        } else {
          // Always answer 2xx: a hook error can block the agent's turn. An
          // empty 204 keeps curl's stdout empty when there is no control word.
          res.writeHead(204).end();
        }
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
  }

  private controlReply(
    sessionId: string,
    event: string,
  ): Record<string, unknown> | null {
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
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
    this.pendingInterrupts.clear();
    this.pendingSteers.clear();
    this.toolGates.clear();
  }
}
