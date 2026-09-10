import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionProcessInfo } from '../shared/types';

const run = promisify(execFile);

/**
 * Read-only process inspection for the session Info surface.
 *
 * This is deliberately diagnostic data, not an agent-status source. The
 * truth plane still comes from adapter events; a child process can be idle,
 * blocked, or unrelated to the current turn.
 */
export async function inspectProcessTree(
  rootPid: number | null,
): Promise<SessionProcessInfo[]> {
  if (rootPid === null) return [];
  const rows = process.platform === 'win32'
    ? await windowsProcesses()
    : await posixProcesses();
  if (!rows.length) return [];

  const byParent = new Map<number, SessionProcessInfo[]>();
  for (const row of rows) {
    if (row.parentPid === null) continue;
    const siblings = byParent.get(row.parentPid) ?? [];
    siblings.push(row);
    byParent.set(row.parentPid, siblings);
  }

  const found: SessionProcessInfo[] = [];
  const queue = [rootPid];
  const seen = new Set<number>();
  while (queue.length && found.length < 200) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = rows.find((candidate) => candidate.pid === pid);
    if (row) found.push(row);
    for (const child of byParent.get(pid) ?? []) queue.push(child.pid);
  }
  return found;
}

async function posixProcesses(): Promise<SessionProcessInfo[]> {
  try {
    const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,args='], {
      timeout: 5000,
      maxBuffer: 8_000_000,
    });
    return stdout.split(/\r?\n/).flatMap((line): SessionProcessInfo[] => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (!match) return [];
      return [{
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        command: trimCommand(match[3]),
      }];
    });
  } catch {
    return [];
  }
}

async function windowsProcesses(): Promise<SessionProcessInfo[]> {
  try {
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
      ],
      { timeout: 8000, maxBuffer: 8_000_000 },
    );
    const parsed: unknown = JSON.parse(stdout || '[]');
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((value): SessionProcessInfo[] => {
      if (!value || typeof value !== 'object') return [];
      const row = value as Record<string, unknown>;
      const pid = Number(row.ProcessId);
      if (!Number.isInteger(pid) || pid <= 0) return [];
      const parent = Number(row.ParentProcessId);
      return [{
        pid,
        parentPid: Number.isInteger(parent) && parent > 0 ? parent : null,
        command: trimCommand(typeof row.CommandLine === 'string' ? row.CommandLine : `pid ${pid}`),
      }];
    });
  } catch {
    return [];
  }
}

function trimCommand(command: string): string {
  const normalized = command.replace(/\s+/g, ' ').trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}…` : normalized;
}
