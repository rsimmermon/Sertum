import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** A JSON-RPC notification from the app server, already parsed. */
export interface CodexNotification {
  method: string;
  params: Record<string, unknown>;
}

/**
 * Plane 2 ingress for Codex.
 *
 * Codex has no HTTP hook type, so the Claude approach does not port. What it
 * has instead is better: an app server speaking JSON-RPC, which reports thread
 * and turn lifecycle as structured events. AgentStation runs its own instance
 * and spawns every Codex TUI with `--remote` pointing at it, so the terminal
 * still renders the real TUI (plane 1) while status arrives out-of-band.
 *
 * The transport is a WebSocket on loopback rather than the unix socket the
 * daemon defaults to: it behaves identically on Windows, and the server
 * exposes /readyz so startup is observable instead of timed.
 *
 * Deliberately a private instance, not the shared `codex app-server daemon`:
 * AgentStation owns its lifetime, and a crash here cannot disturb whatever the
 * user is running in their own terminals.
 */
export class CodexAppServer extends EventEmitter {
  private child: ChildProcess | null = null;
  private socket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, (result: unknown, error?: unknown) => void>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private boundPort = 0;

  constructor(private binary = resolveCodexBinary()) {
    super();
  }

  get port(): number {
    return this.boundPort;
  }

  /** The value to pass to a session's `--remote` flag. */
  get remoteUrl(): string {
    return `ws://127.0.0.1:${this.boundPort}`;
  }

  get connected(): boolean {
    return this.socket?.readyState === 1;
  }

  async start(): Promise<boolean> {
    if (this.child) return this.connected;
    this.stopping = false;

    this.boundPort = await freePort();
    this.child = spawn(this.binary, ['app-server', '--listen', this.remoteUrl], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.child.stderr?.on('data', (d: Buffer) => {
      const text = d.toString();
      // Startup banner is not worth surfacing; anything else may explain a drop.
      if (!/listening on|readyz|healthz|note:|WebSockets/.test(text)) {
        this.emit('log', text.trim());
      }
    });
    this.child.on('exit', (code) => {
      this.child = null;
      this.emit('log', `app server exited (${code})`);
      if (!this.stopping) this.scheduleReconnect();
    });

    // The binary may be missing entirely; treat that as "Codex unavailable"
    // rather than a crash, so the app still runs with Claude only.
    const failed = await new Promise<boolean>((resolve) => {
      this.child?.once('error', () => resolve(true));
      setTimeout(() => resolve(false), 300);
    });
    if (failed) {
      this.child = null;
      return false;
    }

    if (!(await this.waitForReady())) {
      this.stop();
      return false;
    }
    return this.connect();
  }

  /** Polls /readyz so we connect when the server is up, not after a fixed wait. */
  private async waitForReady(timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.boundPort}/readyz`);
        if (res.ok) return true;
      } catch { /* not listening yet */ }
      await delay(200);
    }
    return false;
  }

  private async connect(): Promise<boolean> {
    const ws = new WebSocket(this.remoteUrl);
    this.socket = ws;

    ws.onmessage = (event) => this.receive(String(event.data));
    ws.onclose = () => {
      this.socket = null;
      this.emit('disconnected');
      if (!this.stopping) this.scheduleReconnect();
    };
    ws.onerror = () => { /* surfaced by onclose */ };

    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      setTimeout(() => resolve(ws.readyState === 1), 5_000);
    });
    if (!opened) return false;

    await this.request('initialize', {
      clientInfo: { name: 'AgentStation', version: '1.0.0' },
    });
    this.notify('initialized', {});
    this.emit('connected');
    return true;
  }

  /**
   * Reconnects after the server drops — most often when the machine sleeps and
   * the socket dies without either side noticing.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopping) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopping) return;
      if (!this.child) await this.start();
      else await this.connect();
    }, 2_000);
  }

  private receive(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const id = message.id;
    const method = message.method;

    // A response to something we asked.
    if (typeof id === 'number' && method === undefined) {
      const settle = this.pending.get(id);
      this.pending.delete(id);
      settle?.(message.result, message.error);
      return;
    }

    if (typeof method !== 'string') return;
    const params = (message.params ?? {}) as Record<string, unknown>;

    // Server *requests* carry an id and expect a reply. The TUI owns the thread
    // and answers them; AgentStation only listens, so replying here would race
    // it. They are still worth surfacing — an approval prompt is exactly the
    // "needs you" signal the sidebar exists to show.
    this.emit('notification', { method, params } satisfies CodexNotification);
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('codex app server not connected'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, (result, error) => {
        if (error) reject(new Error(JSON.stringify(error)));
        else resolve(result);
      });
      this.socket?.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 10_000);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (!this.connected) return;
    this.socket?.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  stop(): void {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try { this.socket?.close(); } catch { /* already gone */ }
    this.socket = null;
    this.child?.kill();
    this.child = null;
  }
}

/**
 * Finds the codex binary without relying on PATH.
 *
 * A GUI app launched from Finder or the Dock inherits a bare login PATH, not
 * the one from the user's shell profile, so a plain `codex` would resolve in
 * `npm start` and then fail in the packaged build. The standalone install is
 * checked first because it is the one that shadows the others on PATH.
 */
export function resolveCodexBinary(): string {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.codex', 'packages', 'standalone', 'current', 'codex'),
    path.join(home, '.local', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    path.join(home, '.volta', 'bin', 'codex'),
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* try the next one */ }
  }
  // Last resort: let PATH decide, which is correct when launched from a shell.
  return 'codex';
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Binds port 0 to let the OS pick, then releases it for the server to claim. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}
