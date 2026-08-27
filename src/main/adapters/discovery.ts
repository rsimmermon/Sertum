import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import type {
  AgentKind,
  DiscoveredSession,
  SessionStatus,
} from '../../shared/types';
import { cwdForPid, scanAgentProcesses } from './process-scan';
import { summarizeSession } from './transcript';

const run = promisify(execFile);

/**
 * A source of sessions for one agent. Adding an agent means adding one of
 * these; nothing downstream changes.
 */
export interface AgentDiscoverer {
  agent: AgentKind;
  /**
   * `resolveBinary` answers where an agent's CLI lives, since PATH cannot be
   * relied on in a packaged app. Discoverers that shell out must use it.
   */
  discover(
    resolveBinary: (agent: AgentKind) => string | undefined,
  ): Promise<DiscoveredSession[]>;
}

/**
 * Finds agent sessions running outside Sertum.
 *
 * Two adoption modes, and the difference is an OS constraint rather than a
 * policy choice. A PTY's master fd belongs to whoever spawned it, so a session
 * started in another terminal can never have its terminal rendered here.
 *
 *   attach  - daemon-hosted, so a real terminal can be opened onto it
 *   monitor - lives in another terminal; status and summary only, but the
 *             owning OS window can be raised
 */
export async function discoverSessions(
  ownedPids: ReadonlySet<number>,
  resolveBinary: (agent: AgentKind) => string | undefined = () => undefined,
): Promise<DiscoveredSession[]> {
  const results = await Promise.all(
    DISCOVERERS.map((d) =>
      d.discover(resolveBinary).catch(() => [] as DiscoveredSession[]),
    ),
  );

  // Richer sources come first, so a pid already described in detail is not
  // overwritten by the bare process-scan row for the same process.
  const byPid = new Map<number, DiscoveredSession>();
  const noPid: DiscoveredSession[] = [];
  for (const session of results.flat()) {
    if (session.pid === null) {
      noPid.push(session);
      continue;
    }
    if (ownedPids.has(session.pid)) continue;
    if (!byPid.has(session.pid)) byPid.set(session.pid, session);
  }

  return [...byPid.values(), ...noPid].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

// ------------------------------------------------------------------ Claude

/**
 * Claude publishes its own roster, which carries the session id, name and a
 * live status -- everything the process table cannot tell us.
 */
const claudeDiscoverer: AgentDiscoverer = {
  agent: 'claude',
  async discover(resolveBinary) {
    let raw: string;
    try {
      ({ stdout: raw } = await run(resolveBinary('claude') ?? 'claude', ['agents', '--json'], {
        timeout: 6000,
        maxBuffer: 4_000_000,
      }));
    } catch {
      return [];
    }

    let rows: unknown;
    try {
      rows = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(rows)) return [];

    return rows.flatMap((row): DiscoveredSession[] => {
      if (!row || typeof row !== 'object') return [];
      const r = row as Record<string, unknown>;
      const sessionId = typeof r.sessionId === 'string' ? r.sessionId : null;
      if (!sessionId) return [];

      const pid = typeof r.pid === 'number' ? r.pid : null;
      const cwd = typeof r.cwd === 'string' ? r.cwd : '';
      const kind = typeof r.kind === 'string' ? r.kind : 'interactive';
      const summary = summarizeSession('claude', { sessionId, cwd });

      return [
        {
          agent: 'claude',
          sessionId,
          pid,
          kind,
          name: typeof r.name === 'string' ? r.name : sessionId.slice(0, 8),
          cwd,
          status: mapClaudeStatus(r.status),
          // Only a daemon-hosted session can have a terminal opened onto it.
          adoptMode: kind === 'background' ? 'attach' : 'monitor',
          messagingSocket: pid === null ? null : socketFor(pid),
          summary: summary.lastAssistant ?? summary.lastUser,
          lastActivityAt: summary.updatedAt,
        },
      ];
    });
  },
};

function mapClaudeStatus(value: unknown): SessionStatus {
  switch (value) {
    case 'busy':
      return 'working';
    case 'failed':
      return 'attention';
    case 'completed':
      return 'done';
    default:
      return 'idle';
  }
}

/** Claude publishes one Unix socket per session, named by pid. */
function socketFor(pid: number): string | null {
  if (process.platform === 'win32') return `\\\\.\\pipe\\cc-${pid}`;
  const p = `/tmp/cc-socks/${pid}.sock`;
  try {
    return fs.statSync(p).isSocket() ? p : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------- process-table pass

/**
 * Covers every agent that has no roster API of its own -- Codex today. Yields
 * less detail than a vendor source, but enough to list a session, summarise it
 * from its transcript, and raise the window that owns it.
 *
 * When the Codex app-server adapter lands it becomes a richer discoverer
 * registered ahead of this one, and this stays as the fallback.
 */
const processDiscoverer: AgentDiscoverer = {
  agent: 'codex',
  async discover() {
    const procs = await scanAgentProcesses();
    const out: DiscoveredSession[] = [];

    for (const p of procs) {
      const cwd = (await cwdForPid(p.pid)) ?? '';
      const summary = summarizeSession(p.agent, { sessionId: null, cwd });
      out.push({
        agent: p.agent,
        // No vendor id available; the pid identifies the row.
        sessionId: `pid:${p.pid}`,
        pid: p.pid,
        kind: 'interactive',
        name: cwd ? `${basename(cwd)} · ${p.agent}` : `${p.agent} ${p.pid}`,
        cwd,
        status: 'idle',
        adoptMode: 'monitor',
        messagingSocket: null,
        summary: summary.lastAssistant ?? summary.lastUser,
        lastActivityAt: summary.updatedAt,
      });
    }
    return out;
  },
};

function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] ?? p;
}

/** Ordered richest-first; the merge above keeps the first hit per pid. */
const DISCOVERERS: AgentDiscoverer[] = [claudeDiscoverer, processDiscoverer];
