import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  DAEMON_PROTOCOL,
  daemonEndpoint,
  daemonStateFile,
  sertumHome,
  type DaemonFrame,
} from '../shared/daemon-protocol';

/**
 * The GUI's connection to sertumd — the client half of stage 3.
 *
 * Connect-or-spawn: an existing daemon is joined, none is started. The spawn
 * runs the app's own executable as Node (ELECTRON_RUN_AS_NODE), detached, so
 * the daemon is not a child that dies with this process — that being the
 * point. Requests carry ids and time out rather than hang; events fan out to
 * subscribers; a dropped socket is retried in the background and announced
 * through `onState`, because a GUI that silently lost its fabric would look
 * exactly like an app where every button broke at once.
 */

const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_MS = 1500;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class DaemonClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buf = '';
  private greeted = false;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    /** Absolute path to the built sertumd.js this build ships. */
    private daemonScript: string,
    private appVersion: string,
    private userDataDir: string,
  ) {
    super();
  }

  get connected(): boolean {
    return this.greeted;
  }

  /** Joins the running daemon, or starts one and joins it. */
  async ensure(): Promise<void> {
    if (this.greeted) return;
    try {
      await this.connect();
      return;
    } catch {
      // No daemon (or a corpse's endpoint). Start one.
    }
    this.spawnDaemon();
    // The daemon writes its state file only once it is listening.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        await this.connect();
        return;
      } catch {
        // Still coming up.
      }
    }
    throw new Error('sertumd did not come up; see ~/.sertum/sertumd.log');
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.socket || !this.greeted) {
      return Promise.reject(new Error('not connected to sertumd'));
    }
    const id = this.nextId++;
    const frame: DaemonFrame = { t: 'req', id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`sertumd request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.socket!.write(`${JSON.stringify(frame)}\n`);
    });
  }

  /** Fire-and-forget, for the hot paths (keystrokes, resizes). */
  send(method: string, params?: unknown): void {
    if (!this.socket || !this.greeted) return;
    const frame: DaemonFrame = { t: 'req', id: this.nextId++, method, params };
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  /** Disconnect and stop reconnecting. The daemon keeps running. */
  dispose(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.destroy();
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(daemonEndpoint());
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(err);
      };
      socket.setNoDelay(true);
      socket.once('error', fail);
      const guard = setTimeout(() => fail(new Error('connect timeout')), 3000);

      socket.once('connect', () => {
        socket.write(
          `${JSON.stringify({ t: 'hello', protocol: DAEMON_PROTOCOL, version: this.appVersion } satisfies DaemonFrame)}\n`,
        );
      });

      socket.on('data', (chunk) => {
        this.buf += chunk.toString('utf8');
        let at: number;
        while ((at = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, at).trim();
          this.buf = this.buf.slice(at + 1);
          if (!line) continue;
          let frame: DaemonFrame;
          try {
            frame = JSON.parse(line) as DaemonFrame;
          } catch {
            continue;
          }
          if (!settled) {
            if (frame.t === 'hello') {
              settled = true;
              clearTimeout(guard);
              this.adopt(socket, frame.version);
              resolve();
            } else if (frame.t === 'res' && !frame.ok) {
              // The daemon refused the handshake — version skew, worth
              // surfacing verbatim rather than as a generic failure.
              fail(new Error(frame.error));
            }
            continue;
          }
          this.dispatch(frame);
        }
      });
    });
  }

  private adopt(socket: net.Socket, daemonVersion: string): void {
    this.socket = socket;
    this.greeted = true;
    this.emit('state', { connected: true, daemonVersion });
    socket.on('close', () => {
      const wasUp = this.greeted;
      this.greeted = false;
      this.socket = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('sertumd connection lost'));
      }
      this.pending.clear();
      if (wasUp) this.emit('state', { connected: false });
      if (!this.closed) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensure().catch(() => this.scheduleReconnect());
    }, RECONNECT_MS);
  }

  private dispatch(frame: DaemonFrame): void {
    if (frame.t === 'res') {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.ok) p.resolve(frame.result);
      else p.reject(new Error(frame.error));
      return;
    }
    if (frame.t === 'event') this.emit('daemon-event', frame.name, frame.payload);
  }

  private spawnDaemon(): void {
    fs.mkdirSync(sertumHome(), { recursive: true });
    // Spawn errors land in the retry loop above; the daemon's own console
    // goes to ~/.sertum/sertumd.log, written by the daemon itself.
    const child = spawn(process.execPath, [this.daemonScript], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        SERTUM_VERSION: this.appVersion,
        SERTUM_USER_DATA: this.userDataDir,
      },
    });
    child.unref();
  }
}

/**
 * Where this build's sertumd.js lives: next to the built main.js. In a
 * packaged app that directory sits inside app.asar, which a Node process
 * cannot read — the packaged path swaps in the unpacked copy that
 * forge.config.ts's asar.unpack carries. Packaged operation is untested so
 * far; dev is verified.
 */
export function daemonScriptPath(): string {
  return path
    .join(__dirname, 'sertumd.js')
    .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

export { daemonStateFile };
