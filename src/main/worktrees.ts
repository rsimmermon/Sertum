import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorktreeInfo, WorktreeInventory } from '../shared/types';

const run = promisify(execFile);

/**
 * Inventory of the git worktrees belonging to one repository — wireframe C9.
 *
 * Nothing here is agent-specific: a worktree is git's, not an agent's, so the
 * same inventory serves a Claude session, a Codex session and a shell. What
 * differs per agent is only ever what to do with a session *attached* to a
 * worktree, which lives behind AgentAdapter.
 *
 * The costly parts -- on-disk size and merged-ness -- are gathered per
 * worktree and in parallel, because a repository with several checkouts of a
 * large tree would otherwise make opening the manager feel broken.
 */
export async function readWorktrees(
  cwd: string,
  sessionCwds: ReadonlyMap<string, string>,
): Promise<WorktreeInventory | null> {
  const root = await mainRepoRoot(cwd);
  if (!root) return null;

  const entries = await listWorktrees(root);
  if (entries.length === 0) return null;

  const base = await defaultBranch(root);
  const worktrees = await Promise.all(
    entries.map((e) => describe(e, root, base, sessionCwds)),
  );

  return {
    repo: path.basename(root),
    root,
    worktrees,
    includeFile: includeFileFor(root),
  };
}

/** Removes a worktree, and its branch when that branch is now unreachable. */
export async function removeWorktree(
  root: string,
  worktreePath: string,
  force: boolean,
): Promise<{ ok: boolean; reason?: string }> {
  // Never let a caller remove the checkout the repository itself lives in.
  const main = await mainRepoRoot(root);
  if (main && path.resolve(worktreePath) === path.resolve(main)) {
    return { ok: false, reason: 'That is the main checkout, not a worktree.' };
  }
  try {
    const args = ['-C', root, 'worktree', 'remove'];
    if (force) args.push('--force');
    args.push(worktreePath);
    await run('git', args, { timeout: 30_000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: gitMessage(err) };
  }
}

// ------------------------------------------------------------------ details

interface RawWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

async function listWorktrees(root: string): Promise<RawWorktree[]> {
  let stdout: string;
  try {
    ({ stdout } = await run('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
      timeout: 10_000,
      maxBuffer: 4_000_000,
    }));
  } catch {
    return [];
  }

  const out: RawWorktree[] = [];
  let current: RawWorktree | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) out.push(current);
      current = {
        path: line.slice('worktree '.length).trim(),
        head: null,
        branch: null,
        detached: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('HEAD ')) current.head = line.slice(5).trim();
    else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line === 'detached') current.detached = true;
    else if (line.startsWith('locked')) current.locked = true;
    else if (line.startsWith('prunable')) current.prunable = true;
  }
  if (current) out.push(current);
  return out;
}

async function describe(
  raw: RawWorktree,
  root: string,
  base: string | null,
  sessionCwds: ReadonlyMap<string, string>,
): Promise<WorktreeInfo> {
  const [dirty, merged, sizeBytes] = await Promise.all([
    dirtyCounts(raw.path),
    raw.branch && base ? isMerged(root, raw.branch, base) : Promise.resolve(false),
    directorySize(raw.path),
  ]);

  const resolved = path.resolve(raw.path);
  let sessionId: string | null = null;
  for (const [id, cwd] of sessionCwds) {
    if (path.resolve(cwd) === resolved) {
      sessionId = id;
      break;
    }
  }

  return {
    path: raw.path,
    name: path.basename(raw.path),
    branch: raw.branch,
    detached: raw.detached,
    locked: raw.locked,
    isMain: path.resolve(root) === resolved,
    modified: dirty.modified,
    untracked: dirty.untracked,
    merged,
    sizeBytes,
    sessionId,
  };
}

async function dirtyCounts(
  worktreePath: string,
): Promise<{ modified: number; untracked: number }> {
  try {
    const { stdout } = await run(
      'git',
      ['-C', worktreePath, 'status', '--porcelain'],
      { timeout: 15_000, maxBuffer: 8_000_000 },
    );
    let modified = 0;
    let untracked = 0;
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      if (line.startsWith('??')) untracked += 1;
      else modified += 1;
    }
    return { modified, untracked };
  } catch {
    return { modified: 0, untracked: 0 };
  }
}

/**
 * Whether a branch is already contained in the default branch, which is what
 * makes a worktree safe to reclaim. Uses merge-base rather than
 * `branch --merged` so a squash-merged branch is still judged by its commits.
 */
async function isMerged(
  root: string,
  branch: string,
  base: string,
): Promise<boolean> {
  if (branch === base) return false;
  try {
    await run('git', ['-C', root, 'merge-base', '--is-ancestor', branch, base], {
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function defaultBranch(root: string): Promise<string | null> {
  // The remote's HEAD is the honest answer; fall back to whichever of the
  // conventional names exists, so a repo with no remote still reports one.
  try {
    const { stdout } = await run(
      'git',
      ['-C', root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { timeout: 8_000 },
    );
    const name = stdout.trim().replace(/^origin\//, '');
    if (name) return name;
  } catch {
    // No origin/HEAD; fall through.
  }
  for (const candidate of ['main', 'master', 'trunk']) {
    try {
      await run('git', ['-C', root, 'rev-parse', '--verify', candidate], {
        timeout: 8_000,
      });
      return candidate;
    } catch {
      // Try the next.
    }
  }
  return null;
}

/**
 * Size of a worktree on disk, in bytes.
 *
 * `du` is used rather than a manual walk because a checkout with node_modules
 * in it holds hundreds of thousands of files, and the number only has to be
 * good enough to answer "what is this costing me".
 */
async function directorySize(dir: string): Promise<number | null> {
  if (process.platform === 'win32') return null;
  try {
    const { stdout } = await run('du', ['-sk', dir], { timeout: 30_000 });
    const kb = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

/** The main checkout, which owns the shared object store. */
async function mainRepoRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await run(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { timeout: 8_000 },
    );
    const commonDir = stdout.trim();
    if (!commonDir) return null;
    // .git/ lives inside the main checkout; a bare repo has no checkout.
    return path.basename(commonDir) === '.git'
      ? path.dirname(commonDir)
      : commonDir;
  } catch {
    return null;
  }
}

/**
 * The `.worktreeinclude` file C9 reports on: the list of untracked files a new
 * worktree needs copied in, since git brings across only tracked ones.
 */
function includeFileFor(root: string): { path: string; entries: string[] } | null {
  const file = path.join(root, '.worktreeinclude');
  try {
    const entries = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    return { path: file, entries };
  } catch {
    return null;
  }
}

function gitMessage(err: unknown): string {
  const stderr = (err as { stderr?: string }).stderr;
  const first = (stderr ?? (err as Error).message ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return first ?? 'git refused the operation.';
}
