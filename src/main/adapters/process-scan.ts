import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentKind } from '../../shared/types';

const run = promisify(execFile);

export interface ScannedProcess {
  pid: number;
  agent: AgentKind;
  cwd: string | null;
  tty: string | null;
  startedAt: number | null;
}

/** Command names that identify an agent CLI, in `ps comm=` form. */
const AGENT_COMMANDS: Array<{ agent: AgentKind; match: RegExp }> = [
  { agent: 'claude', match: /(^|\/)claude$/ },
  { agent: 'codex', match: /(^|\/)codex$/ },
];

/**
 * Finds running agent processes by walking the process table.
 *
 * This is the agent-agnostic floor of discovery: it needs no vendor API, so it
 * works for Codex today and for any future CLI by adding one row above. Richer
 * per-agent sources layer on top when available.
 */
export async function scanAgentProcesses(): Promise<ScannedProcess[]> {
  if (process.platform === 'win32') return scanWindows();

  let stdout: string;
  try {
    ({ stdout } = await run('ps', ['-axo', 'pid=,ppid=,tty=,comm='], {
      timeout: 5000,
      maxBuffer: 8_000_000,
    }));
  } catch {
    return [];
  }

  const found: ScannedProcess[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const [, pidStr, , ttyRaw, comm] = m;

    const hit = AGENT_COMMANDS.find((a) => a.match.test(comm));
    if (!hit) continue;

    const pid = Number(pidStr);
    found.push({
      pid,
      agent: hit.agent,
      cwd: null, // resolved lazily; lsof is slow and not always needed
      tty: ttyRaw && ttyRaw !== '??' ? `/dev/${ttyRaw}` : null,
      startedAt: null,
    });
  }
  return found;
}

/**
 * Working directory of a running process. Separated from the scan because
 * `lsof` costs ~50ms per process and is only needed for rows we keep.
 */
export async function cwdForPid(pid: number): Promise<string | null> {
  if (process.platform === 'win32') return null;
  try {
    const { stdout } = await run(
      'lsof',
      ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      { timeout: 4000 },
    );
    for (const line of stdout.split('\n')) {
      if (line.startsWith('n')) return line.slice(1).trim();
    }
  } catch {
    // lsof missing or permission denied: the row still works without a cwd.
  }
  return null;
}

/** Windows has no `ps`; enumerate through PowerShell instead. */
async function scanWindows(): Promise<ScannedProcess[]> {
  try {
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(claude|codex)(\\.exe)?$' } | Select-Object ProcessId,Name | ConvertTo-Json -Compress",
      ],
      { timeout: 8000 },
    );
    const parsed: unknown = JSON.parse(stdout || '[]');
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((r) => {
      const o = r as Record<string, unknown>;
      const pid = Number(o.ProcessId);
      const name = String(o.Name ?? '').toLowerCase();
      if (!pid) return [];
      const agent: AgentKind = name.startsWith('codex') ? 'codex' : 'claude';
      return [{ pid, agent, cwd: null, tty: null, startedAt: null }];
    });
  } catch {
    return [];
  }
}
