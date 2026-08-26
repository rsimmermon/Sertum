import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import type { IPty } from 'node-pty';
import * as pty from 'node-pty';
import type {
  PtySize,
  SessionSnapshot,
  SessionSpec,
  SessionStatus,
} from '../shared/types';

/**
 * Lets the caller add spawn arguments that depend on the session id -- used to
 * point each agent's hooks at its own endpoint.
 */
export type SpawnDecorator = (
  id: string,
  spec: SessionSpec,
) => { args?: string[]; env?: Record<string, string> };

interface Session {
  snapshot: SessionSnapshot;
  proc: IPty;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

/**
 * Owns every PTY process. This is plane 1 of the architecture: bytes in,
 * bytes out. It deliberately does not parse output to infer agent state --
 * that job belongs to the adapters that will feed plane 2.
 */
export class PtyManager extends EventEmitter {
  private sessions = new Map<string, Session>();

  constructor(private decorate: SpawnDecorator = () => ({})) {
    super();
  }

  create(spec: Partial<SessionSpec>): SessionSnapshot {
    const resolved: SessionSpec = {
      label: spec.label ?? 'session',
      agent: spec.agent ?? 'shell',
      cwd: spec.cwd ?? os.homedir(),
      command: spec.command ?? defaultShell(),
      args: spec.args ?? [],
    };

    const id = randomUUID();
    const extra = this.decorate(id, resolved);
    const args = extra.args ?? resolved.args;
    const proc = pty.spawn(resolved.command, args, {
      name: 'xterm-256color',
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: resolved.cwd,
      env: {
        ...(process.env as Record<string, string>),
        TERM: 'xterm-256color',
        // Lets a session (and its hooks) know which pane it belongs to.
        AGENTSTATION_SESSION_ID: id,
        ...(extra.env ?? {}),
      },
    });

    const snapshot: SessionSnapshot = {
      ...resolved,
      id,
      status: 'working',
      pid: proc.pid,
      startedAt: Date.now(),
      exitCode: null,
      activity: 'starting…',
      lastEventAt: null,
    };

    proc.onData((data) => this.emit('data', { id, data }));
    proc.onExit(({ exitCode, signal }) => {
      const session = this.sessions.get(id);
      if (session) {
        session.snapshot.status = exitCode === 0 ? 'done' : 'attention';
        session.snapshot.exitCode = exitCode;
        session.snapshot.pid = null;
        session.snapshot.activity =
          exitCode === 0 ? 'exited cleanly' : `exited with code ${exitCode}`;
        this.emit('session-updated', { ...session.snapshot });
      }
      this.emit('exit', { id, exitCode, signal });
    });

    this.sessions.set(id, { snapshot, proc });
    return { ...snapshot };
  }

  /**
   * Applies a plane 2 status update. Ignored once the process has exited --
   * a late hook must not resurrect a dead session's dot.
   */
  applyUpdate(
    id: string,
    update: { status?: SessionStatus; activity?: string },
  ): SessionSnapshot | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.snapshot.pid === null) return null;
    if (!update.status && !update.activity) return null;

    if (update.status) session.snapshot.status = update.status;
    if (update.activity) session.snapshot.activity = update.activity;
    session.snapshot.lastEventAt = Date.now();
    const next = { ...session.snapshot };
    this.emit('session-updated', next);
    return next;
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.proc.write(data);
  }

  resize(id: string, { cols, rows }: PtySize): void {
    const session = this.sessions.get(id);
    if (!session || session.snapshot.pid === null) return;
    // xterm can report 0 mid-layout; a 0-column PTY throws on some platforms.
    if (cols < 1 || rows < 1) return;
    try {
      session.proc.resize(cols, rows);
    } catch {
      // The process can exit between the guard and the call.
    }
  }

  kill(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    try {
      session.proc.kill();
    } catch {
      // Already gone.
    }
  }

  /** Kill the process and forget the session entirely. */
  remove(id: string): void {
    this.kill(id);
    this.sessions.delete(id);
  }

  list(): SessionSnapshot[] {
    return [...this.sessions.values()].map((s) => ({ ...s.snapshot }));
  }

  get(id: string): SessionSnapshot | undefined {
    const s = this.sessions.get(id);
    return s ? { ...s.snapshot } : undefined;
  }

  disposeAll(): void {
    for (const id of this.sessions.keys()) this.kill(id);
    this.sessions.clear();
  }
}

function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL ?? '/bin/bash';
}
