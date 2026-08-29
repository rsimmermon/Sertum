import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  DiffDiscardResult,
  DiffFileInfo,
  DiffFilePatch,
  DiffInventory,
} from '../shared/types';

const run = promisify(execFile);
const MAX_PATCH_BYTES = 512 * 1024;

/**
 * Reads C11 from Git's index and worktree, never from an agent or its pixels.
 * The inventory stays small; a patch is fetched only after its row is chosen.
 */
export async function readDiff(cwd: string): Promise<DiffInventory | null> {
  const root = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) return null;
  const branch = await git(root, ['branch', '--show-current']);
  const raw = await git(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  if (raw === null) return null;

  const statuses = parseStatus(raw);
  const files = await Promise.all(
    statuses.map(async ({ path: file, status }) => {
      if (status === 'untracked') return untrackedInfo(root, file);
      const stat = await git(root, ['diff', '--numstat', 'HEAD', '--', file]);
      return trackedInfo(file, status, stat ?? '');
    }),
  );
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    root,
    branch: branch || null,
    files,
    additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
    deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
  };
}

export async function readDiffFile(
  root: string,
  relative: string,
): Promise<DiffFilePatch> {
  const file = safePath(root, relative);
  if (!file) return unavailable(relative, 'That path is outside the worktree.');
  const status = (await readDiff(root))?.files.find((f) => f.path === relative);
  if (!status) return unavailable(relative, 'That file is no longer changed.');
  if (status.reason) return unavailable(relative, status.reason);

  if (status.status === 'untracked') {
    let body: Buffer;
    try {
      const stat = fs.lstatSync(file);
      body = stat.isSymbolicLink()
        ? Buffer.from(fs.readlinkSync(file), 'utf8')
        : fs.readFileSync(file);
    } catch {
      return unavailable(relative, 'The file could not be read.');
    }
    if (body.length > MAX_PATCH_BYTES) {
      return unavailable(relative, 'File is too large to show safely.');
    }
    const text = body.toString('utf8');
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    const patch = [
      `diff --git a/${relative} b/${relative}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${relative}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
    ].join('\n');
    return { path: relative, patch, reason: null };
  }

  const patch = await git(root, [
    'diff',
    '--no-ext-diff',
    '--unified=3',
    'HEAD',
    '--',
    relative,
  ], MAX_PATCH_BYTES);
  if (patch === null) return unavailable(relative, 'Git could not read this diff.');
  return { path: relative, patch, reason: patch ? null : 'No textual diff.' };
}

/**
 * Discards exactly the paths Git reports at execution time.
 *
 * The renderer's earlier inventory is display only: this function resolves
 * the repository again and re-reads its changes before touching anything.
 * Untracked entries come from `--untracked-files=all`, so each target is an
 * individual file or symlink and never a recursively deleted directory.
 */
export async function discardDiff(root: string): Promise<DiffDiscardResult> {
  const inventory = await readDiff(root);
  if (!inventory || !samePath(inventory.root, root)) {
    return { ok: false, reason: 'The worktree could not be verified.' };
  }
  if (!inventory.files.length) return { ok: true };

  const tracked = inventory.files
    .filter((file) => file.status !== 'untracked')
    .map((file) => file.path);
  if (tracked.length) {
    const restored = await gitOk(inventory.root, [
      'restore',
      '--source=HEAD',
      '--staged',
      '--worktree',
      '--',
      ...tracked,
    ]);
    if (!restored) {
      return { ok: false, reason: 'Git refused to restore the tracked files.' };
    }
  }

  for (const entry of inventory.files.filter((file) => file.status === 'untracked')) {
    const target = safePath(inventory.root, entry.path);
    if (!target) return { ok: false, reason: `Refused unsafe path: ${entry.path}` };
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        return { ok: false, reason: `Refused non-file path: ${entry.path}` };
      }
      fs.rmSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return { ok: false, reason: `Could not remove ${entry.path}.` };
    }
  }
  return { ok: true };
}

function parseStatus(raw: string): Array<{ path: string; status: DiffFileInfo['status'] }> {
  const fields = raw.split('\0');
  const out: Array<{ path: string; status: DiffFileInfo['status'] }> = [];
  for (let i = 0; i < fields.length; i += 1) {
    const row = fields[i];
    if (!row || row.length < 4) continue;
    const code = row.slice(0, 2);
    const file = row.slice(3);
    if (code.includes('R')) i += 1; // porcelain -z follows the new path with the old one
    out.push({ path: file, status: mapStatus(code) });
  }
  return out;
}

function mapStatus(code: string): DiffFileInfo['status'] {
  if (code === '??') return 'untracked';
  if (code.includes('R')) return 'renamed';
  if (code.includes('A')) return 'added';
  if (code.includes('D')) return 'deleted';
  return 'modified';
}

function trackedInfo(
  file: string,
  status: DiffFileInfo['status'],
  stat: string,
): DiffFileInfo {
  const [added, deleted] = stat.trim().split(/\s+/);
  const binary = added === '-' || deleted === '-';
  return {
    path: file,
    status,
    additions: binary ? null : Number(added || 0),
    deletions: binary ? null : Number(deleted || 0),
    binary,
    reason: binary ? 'Binary file, not shown.' : null,
  };
}

function untrackedInfo(root: string, file: string): DiffFileInfo {
  const target = safePath(root, file);
  if (!target) return unavailableInfo(file, 'That path is outside the worktree.');
  try {
    const stat = fs.lstatSync(target);
    if (stat.size > MAX_PATCH_BYTES) {
      return unavailableInfo(file, 'File is too large to show safely.');
    }
    if (stat.isSymbolicLink()) {
      return {
        path: file,
        status: 'untracked',
        additions: 1,
        deletions: 0,
        binary: false,
        reason: null,
      };
    }
    const body = fs.readFileSync(target);
    const binary = body.subarray(0, 8192).includes(0);
    return {
      path: file,
      status: 'untracked',
      additions: binary
        ? null
        : body.length === 0
          ? 0
          : body.toString('utf8').split(/\r?\n/).length,
      deletions: binary ? null : 0,
      binary,
      reason: binary ? 'Binary file, not shown.' : null,
    };
  } catch {
    return unavailableInfo(file, 'The file could not be read.');
  }
}

function unavailableInfo(file: string, reason: string): DiffFileInfo {
  return {
    path: file,
    status: 'untracked',
    additions: null,
    deletions: null,
    binary: false,
    reason,
  };
}

function safePath(root: string, relative: string): string | null {
  if (!relative || path.isAbsolute(relative)) return null;
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  return target === base || target.startsWith(`${base}${path.sep}`) ? target : null;
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function unavailable(file: string, reason: string): DiffFilePatch {
  return { path: file, patch: null, reason };
}

async function git(cwd: string, args: string[], maxBuffer = 4_000_000): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], {
      timeout: 12_000,
      maxBuffer,
      encoding: 'utf8',
    });
    return stdout.trimEnd();
  } catch {
    return null;
  }
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await run('git', ['-C', cwd, ...args], {
      timeout: 12_000,
      maxBuffer: 4_000_000,
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
}
