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
) => {
  args?: string[];
  env?: Record<string, string>;
  /** True when this spawn wires the session up to a status adapter. */
  adapterBound?: boolean;
};

interface Session {
  snapshot: SessionSnapshot;
  /** Set once the process has written anything: proof it really started. */
  sawOutput?: boolean;
  /** Absent for monitored sessions: they run in someone else's terminal. */
  proc?: IPty;
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
      origin: 'owned',
      externalId: null,
      status: 'working',
      pid: proc.pid,
      startedAt: Date.now(),
      exitCode: null,
      activity: 'starting…',
      lastEventAt: null,
      adapterBound: extra.adapterBound ?? false,
      model: null,
      effort: null,
      contextTokens: null,
      contextLimit: null,
      transcriptPath: null,
    };

    proc.onData((data) => {
      this.emit('data', { id, data });
      this.markStarted(id);
    });
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
   * Applies model / effort / context figures read from a transcript. Emits
   * only on a real change, so a poll does not churn the UI.
   */
  applyMeta(
    id: string,
    meta: {
      model?: string | null;
      effort?: string | null;
      contextTokens?: number | null;
      contextLimit?: number | null;
      transcriptPath?: string | null;
      /** The agent-side id this pane is bound to (a Codex thread, say). */
      externalId?: string | null;
    },
  ): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const snap = session.snapshot;
    let changed = false;
    for (const key of [
      'model',
      'effort',
      'contextTokens',
      'contextLimit',
      'transcriptPath',
      'externalId',
    ] as const) {
      const next = meta[key];
      if (next !== undefined && next !== null && next !== snap[key]) {
        (snap[key] as unknown) = next;
        changed = true;
      }
    }
    if (changed) this.emit('session-updated', { ...snap });
  }

  /**
   * First output proves the process is alive and past its own startup.
   *
   * This is a plane 1 fact -- bytes arrived -- not an inference about what the
   * agent is doing. For a session with no adapter it is all we will ever know,
   * so we settle it at idle rather than leaving a permanent "starting…".
   */
  private markStarted(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.sawOutput) return;
    session.sawOutput = true;

    if (session.snapshot.adapterBound) {
      // The adapter owns status from here; just clear the placeholder.
      if (session.snapshot.activity === 'starting…') {
        session.snapshot.activity = null;
        this.emit('session-updated', { ...session.snapshot });
      }
      return;
    }

    session.snapshot.status = 'idle';
    session.snapshot.activity = null;
    this.emit('session-updated', { ...session.snapshot });
  }

  /**
   * Registers a session running in another terminal. There is no PTY to own:
   * the OS gives its master fd to whoever spawned it, so this is a live status
   * row rather than a terminal.
   */
  registerMonitored(input: {
    label: string;
    agent: SessionSpec['agent'];
    cwd: string;
    externalId: string;
    pid: number | null;
    status: SessionStatus;
  }): SessionSnapshot {
    const existing = [...this.sessions.values()].find(
      (s) => s.snapshot.externalId === input.externalId,
    );
    if (existing) return { ...existing.snapshot };

    const snapshot: SessionSnapshot = {
      id: randomUUID(),
      origin: 'monitored',
      externalId: input.externalId,
      label: input.label,
      agent: input.agent,
      cwd: input.cwd,
      command: '',
      args: [],
      status: input.status,
      pid: input.pid,
      startedAt: Date.now(),
      exitCode: null,
      activity: 'running in another terminal',
      lastEventAt: Date.now(),
      adapterBound: false,
      model: null,
      effort: null,
      contextTokens: null,
      contextLimit: null,
      transcriptPath: null,
    };
    this.sessions.set(snapshot.id, { snapshot });
    this.emit('session-updated', { ...snapshot });
    return { ...snapshot };
  }

  /** Refreshes monitored rows from a discovery sweep. */
  syncMonitored(
    seen: Array<{ externalId: string; status: SessionStatus }>,
  ): void {
    const byId = new Map(seen.map((s) => [s.externalId, s]));
    for (const session of this.sessions.values()) {
      const snap = session.snapshot;
      if (snap.origin !== 'monitored' || !snap.externalId) continue;
      const hit = byId.get(snap.externalId);
      if (!hit) {
        if (snap.status !== 'done') {
          snap.status = 'done';
          snap.activity = 'no longer running';
          this.emit('session-updated', { ...snap });
        }
        continue;
      }
      if (hit.status !== snap.status) {
        snap.status = hit.status;
        snap.activity =
          hit.status === 'working' ? 'working' : 'idle in another terminal';
        snap.lastEventAt = Date.now();
        this.emit('session-updated', { ...snap });
      }
    }
  }

  /** Pids of sessions we spawned, so discovery can exclude them. */
  ownedPids(): Set<number> {
    const pids = new Set<number>();
    for (const s of this.sessions.values()) {
      if (s.snapshot.origin === 'owned' && s.snapshot.pid !== null) {
        pids.add(s.snapshot.pid);
      }
    }
    return pids;
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
    if (session.snapshot.origin === 'owned' && session.snapshot.pid === null) {
      return null;
    }
    if (!update.status && !update.activity) return null;

    if (update.status) session.snapshot.status = update.status;
    if (update.activity) session.snapshot.activity = update.activity;
    session.snapshot.lastEventAt = Date.now();
    const next = { ...session.snapshot };
    this.emit('session-updated', next);
    return next;
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.proc?.write(data);
  }

  resize(id: string, { cols, rows }: PtySize): void {
    const session = this.sessions.get(id);
    if (!session?.proc || session.snapshot.pid === null) return;
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
    if (!session?.proc) return;
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
