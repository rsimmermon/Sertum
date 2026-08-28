import { execFile, spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { firstExecutable, resolveOnWindowsPath } from './binary-resolve';

const run = promisify(execFile);

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
 * and turn lifecycle as structured events. Sertum runs its own instance
 * and spawns every Codex TUI with `--remote` pointing at it, so the terminal
 * still renders the real TUI (plane 1) while status arrives out-of-band.
 *
 * The transport is a WebSocket on loopback rather than the unix socket the
 * daemon defaults to: it behaves identically on Windows, and the server
 * exposes /readyz so startup is observable instead of timed.
 *
 * Deliberately a private instance, not the shared `codex app-server daemon`:
 * Sertum owns its lifetime, and a crash here cannot disturb whatever the
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
  private events = 0;
  private binary = '';

  /**
   * Resolved lazily, in `start()`, rather than baked in as a constructor
   * default: a caller may want to consult a user override that lives in
   * settings, which are not guaranteed loaded at the moment this object is
   * constructed (module load time) but are well before `start()` runs (inside
   * `app.on('ready')`).
   */
  constructor(private resolveBinary: () => string = resolveCodexBinary) {
    super();
  }

  get port(): number {
    return this.boundPort;
  }

  /** Pid of the spawned server, so its owner can record it for cleanup. */
  get childPid(): number | null {
    return this.child?.pid ?? null;
  }

  /** The value to pass to a session's `--remote` flag. */
  get remoteUrl(): string {
    return `ws://127.0.0.1:${this.boundPort}`;
  }

  get connected(): boolean {
    return this.socket?.readyState === 1;
  }

  /** Notifications received since launch, for the health readout. */
  get eventCount(): number {
    return this.events;
  }

  async start(): Promise<boolean> {
    if (this.child) return this.connected;
    this.stopping = false;

    this.binary = this.resolveBinary();
    this.boundPort = await freePort();
    this.child = spawn(this.binary, ['app-server', '--listen', this.remoteUrl], {
      stdio: ['ignore', 'ignore', 'pipe'],
      // npm on Windows installs `codex` as a `codex.cmd` shim, and Node has
      // refused to spawn .cmd/.bat directly since the CVE-2024-27980 fix --
      // it throws EINVAL synchronously instead of failing async via the
      // 'error' handler below, which would otherwise take the app down.
      // `shell: true` is what makes that spawn legal again; the args stay
      // safe to array-quote because none of them come from user input.
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.binary),
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
      clientInfo: { name: 'Sertum', version: '1.0.0' },
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
    // and answers them; Sertum only listens, so replying here would race
    // it. They are still worth surfacing — an approval prompt is exactly the
    // "needs you" signal the sidebar exists to show.
    this.events++;
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

  /**
   * Ends the spawned server, best effort.
   *
   * Deliberately does not try to confirm the death. This runs while the
   * process is tearing down, and the server is our own direct child: once it
   * exits it stays a zombie until Node reaps it, which cannot happen if we
   * block the event loop waiting. `kill(pid, 0)` cannot tell a zombie from a
   * live process, so any synchronous confirmation here would be a guess.
   *
   * The record written at startup is what makes this safe: whatever survives
   * is identified and killed by reapStrayAppServers on the next launch, which
   * runs with a working event loop and against a process that is no longer
   * our child.
   */
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
 * A codex app server this app spawned, remembered across runs.
 *
 * `ownerPid` is the Sertum process that owns it. A record whose owner is still
 * alive belongs to a second instance running right now and must be left alone;
 * only records whose owner has gone describe a stray.
 */
export interface AppServerRecord {
  ownerPid: number;
  serverPid: number;
  port: number;
}

function readRecords(file: string): AppServerRecord[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is AppServerRecord =>
        !!r &&
        typeof r === 'object' &&
        typeof (r as AppServerRecord).ownerPid === 'number' &&
        typeof (r as AppServerRecord).serverPid === 'number' &&
        typeof (r as AppServerRecord).port === 'number',
    );
  } catch {
    // Missing or corrupt: nothing is known to reap, which is the safe answer.
    return [];
  }
}

function writeRecords(file: string, records: AppServerRecord[]): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(records));
  } catch {
    // Losing the record costs one stray, which the process scan already
    // declines to list. Not worth failing startup over.
  }
}

/** Whether a pid exists. EPERM means it does, but belongs to someone else. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function recordAppServer(file: string, record: AppServerRecord): void {
  const others = readRecords(file).filter(
    (r) => r.ownerPid !== record.ownerPid,
  );
  writeRecords(file, [...others, record]);
}

/**
 * Kills app servers left behind by runs that never got to clean up.
 *
 * The quit path and the signal handlers cover every exit the process can
 * observe, but SIGKILL and a hard crash cannot be trapped -- so the survivor
 * is collected on the next launch instead. Without this, one server is
 * orphaned to init per abnormal exit and they accumulate silently, each
 * holding its port for the life of the machine.
 *
 * The recorded pid is verified against the live command line before anything
 * is signalled: pids are recycled, and a stale record must never be able to
 * kill an unrelated process.
 */
export async function reapStrayAppServers(file: string): Promise<number> {
  const records = readRecords(file);
  if (records.length === 0) return 0;

  const kept: AppServerRecord[] = [];
  let reaped = 0;

  for (const record of records) {
    if (pidAlive(record.ownerPid)) {
      // Another instance is running and this is its server, not a stray.
      kept.push(record);
      continue;
    }
    if (!(await isOurAppServer(record.serverPid, record.port))) continue;
    if (await killAndConfirm(record.serverPid)) reaped += 1;
  }

  writeRecords(file, kept);
  return reaped;
}

/**
 * Ends a stray, escalating if it ignores the request.
 *
 * Unlike the shutdown path this can wait properly: the stray belongs to init,
 * not to us, so there is no zombie to confuse `kill(pid, 0)` and the event
 * loop is running normally.
 */
async function killAndConfirm(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false; // Already gone; nothing was reaped.
  }
  for (let waited = 0; waited < 2000; waited += 100) {
    await new Promise((r) => setTimeout(r, 100));
    if (!pidAlive(pid)) return true;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return true;
  }
  return true;
}

/** Confirms a pid is still the server we recorded, not a recycled one. */
async function isOurAppServer(pid: number, port: number): Promise<boolean> {
  let cmd: string;
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { timeout: 8000 },
      );
      cmd = stdout.trim();
    } else {
      const { stdout } = await run('ps', ['-p', String(pid), '-o', 'args='], {
        timeout: 4000,
      });
      cmd = stdout.trim();
    }
  } catch {
    // No such process, or ps/powershell unavailable: decline to kill.
    return false;
  }
  // The ephemeral port makes this signature specific to the exact server we
  // spawned, not merely to some codex app server.
  return (
    /codex/.test(cmd) &&
    /\bapp-server\b/.test(cmd) &&
    cmd.includes(`ws://127.0.0.1:${port}`)
  );
}

/**
 * Finds the codex binary without relying on PATH.
 *
 * A GUI app launched from Finder or the Dock inherits a bare login PATH, not
 * the one from the user's shell profile, so a plain `codex` would resolve in
 * `npm start` and then fail in the packaged build. The standalone install is
 * checked first because it is the one that shadows the others on PATH.
 *
 * Windows doesn't have this problem -- Explorer-launched processes inherit
 * the full user/system PATH already -- but it has a different one: Windows
 * has no single well-known install directory the way Homebrew or the
 * standalone installer's `current` symlink do on macOS/Linux, so the answer
 * there is to search PATH x PATHEXT ourselves (`resolveOnWindowsPath`, in
 * `./binary-resolve`) rather than guess a location.
 */
export function resolveCodexBinary(): string {
  if (process.platform === 'win32') {
    return resolveOnWindowsPath('codex') ?? 'codex';
  }

  const home = os.homedir();
  return (
    firstExecutable([
      path.join(home, '.codex', 'packages', 'standalone', 'current', 'codex'),
      path.join(home, '.local', 'bin', 'codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      path.join(home, '.volta', 'bin', 'codex'),
    ]) ??
    // Last resort: let PATH decide, which is correct when launched from a shell.
    'codex'
  );
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
