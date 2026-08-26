import http from 'node:http';
import { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';

/** A hook payload, keyed to the AgentStation session that produced it. */
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
 * processes cannot guess a session's endpoint.
 */
export class HookServer extends EventEmitter {
  private server: http.Server | null = null;
  private boundPort = 0;
  private received = 0;

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
        // Always answer 200: a hook that errors can block the agent's turn.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');

        let payload: Record<string, unknown> = {};
        try {
          payload = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        } catch {
          return;
        }
        this.received += 1;
        const event = String(payload.hook_event_name ?? 'Unknown');
        this.emit('hook', { sessionId, event, payload } satisfies HookEvent);
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

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }
}
