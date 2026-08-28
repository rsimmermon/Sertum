import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  WorktreeInfo,
  WorktreeInventory,
  WorktreeProvisionResult,
  WorktreeRemoveResult,
} from '../shared/types';

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

/**
 * Deletes a worktree's folder and its entry in the repository.
 *
 * The branch is left alone: `git worktree remove` unregisters a checkout, so
 * the commits on that branch stay in the repository whether or not they have
 * been merged. What is actually destroyed is the folder -- which means the
 * untracked files in it, since those exist nowhere else.
 *
 * Two refusals are absolute and `force` overrides neither. The main checkout
 * is where the repository itself lives. And a folder a session is working in
 * is a live process's cwd: deleting it strands the agent mid-turn on files
 * that vanished underneath it. Everything `force` does override -- modified
 * and untracked files -- is the user's own to weigh, and the caller confirms
 * it before asking.
 *
 * The occupancy test lives here rather than in the dialog because it is the
 * safety rule, not a piece of presentation: the renderer's inventory can be
 * seconds stale, and a session started while the manager was open must still
 * be honoured.
 */
export async function removeWorktree(
  root: string,
  worktreePath: string,
  force: boolean,
  sessionCwds: ReadonlyMap<string, string>,
): Promise<WorktreeRemoveResult> {
  const main = await mainRepoRoot(root);
  if (main && samePath(worktreePath, main)) {
    return { ok: false, reason: 'That is the main checkout, not a worktree.' };
  }

  const busy = occupants(worktreePath, sessionCwds);
  if (busy.length > 0) {
    return {
      ok: false,
      reason:
        busy.length === 1
          ? 'A session is working in that folder. Close it first.'
          : `${busy.length} sessions are working in that folder. Close them first.`,
      busySessionIds: busy,
    };
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

/**
 * Sessions whose working folder lies inside a worktree.
 *
 * Containment, not equality: a session started in a subfolder of a checkout
 * is still working in that checkout, and equality alone would call the folder
 * free and delete it out from under exactly that session.
 */
function occupants(
  worktreePath: string,
  sessionCwds: ReadonlyMap<string, string>,
): string[] {
  const ids: string[] = [];
  for (const [id, cwd] of sessionCwds) {
    if (contains(worktreePath, cwd)) ids.push(id);
  }
  return ids;
}

/**
 * Path comparison for the safety tests above.
 *
 * Case-folded on macOS and Windows, whose filesystems are case-insensitive by
 * default: a session recorded as /users/me/repo and a worktree listed as
 * /Users/me/repo are the same folder, and a case-sensitive compare would call
 * the busy one free.
 */
const CASE_BLIND = process.platform === 'darwin' || process.platform === 'win32';

function normal(p: string): string {
  const abs = path.resolve(p);
  return CASE_BLIND ? abs.toLowerCase() : abs;
}

function samePath(a: string, b: string): boolean {
  return normal(a) === normal(b);
}

function contains(dir: string, target: string): boolean {
  const from = normal(dir);
  const to = normal(target);
  if (from === to) return true;
  const rel = path.relative(from, to);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Where managed worktrees live.
 *
 * Kept outside the repository on purpose. A worktree created inside the repo
 * shows up as untracked clutter in the checkout it came from, and one created
 * beside it litters whatever folder the user keeps projects in. A single
 * managed root also makes "is this ours?" a prefix test rather than a guess,
 * which is what lets the pool reclaim safely.
 */
export function managedRoot(): string {
  return path.join(os.homedir(), '.sertum', 'worktrees');
}

export function isManagedWorktree(target: string): boolean {
  const rel = path.relative(managedRoot(), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Filesystem-safe form of a branch name, which may contain slashes. */
function slug(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'work';
}

/**
 * Provides a worktree for a branch, reusing one when we already have it.
 *
 * This is the pool: a managed worktree is kept when its session ends rather
 * than deleted, so coming back to the same branch skips the expensive part.
 * What makes a fresh worktree costly is not git -- it is everything git does
 * not carry across, since only tracked files come with a checkout. Reuse is by
 * branch identity rather than by swapping branches inside a spare directory,
 * which would invalidate exactly the installed dependencies and build caches
 * the pool exists to preserve.
 */
export async function provisionWorktree(
  cwd: string,
  branch: string,
  copyIncludes: boolean,
): Promise<WorktreeProvisionResult> {
  const root = await mainRepoRoot(cwd);
  if (!root) return { ok: false, reason: 'Not inside a git repository.' };

  const target = path.join(managedRoot(), path.basename(root), slug(branch));

  const existing = await listWorktrees(root);
  const hit = existing.find(
    (w) => path.resolve(w.path) === path.resolve(target),
  );
  if (hit) {
    // Already ours and on the right branch: hand it straight back.
    if (hit.branch === branch) return { ok: true, path: target, reused: true };
    return {
      ok: false,
      reason: `${target} already exists on branch ${hit.branch ?? 'a detached HEAD'}.`,
    };
  }

  const inUse = existing.find((w) => w.branch === branch);
  if (inUse) {
    // Git enforces one branch per worktree; say so before it does, because
    // its own message points at a path the user has no context for.
    return {
      ok: false,
      reason: `Branch ${branch} is already checked out at ${inUse.path}.`,
    };
  }

  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const known = await branchExists(root, branch);
    const args = known
      ? ['-C', root, 'worktree', 'add', target, branch]
      : ['-C', root, 'worktree', 'add', '-b', branch, target];
    await run('git', args, { timeout: 60_000 });
  } catch (err) {
    return { ok: false, reason: gitMessage(err) };
  }

  const copied = copyIncludes ? await copyIncludes_(root, target) : [];
  return { ok: true, path: target, reused: false, copied };
}

async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await run('git', ['-C', root, 'rev-parse', '--verify', `refs/heads/${branch}`], {
      timeout: 8_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies the untracked files a checkout needs to be usable. Failures are
 * reported by omission rather than aborting: a missing .env is worth knowing
 * about, but it is not a reason to throw away a worktree that was created.
 */
async function copyIncludes_(root: string, target: string): Promise<string[]> {
  const include = includeFileFor(root);
  if (!include) return [];
  const done: string[] = [];
  for (const entry of include.entries) {
    const from = path.join(root, entry);
    const to = path.join(target, entry);
    try {
      await fs.promises.mkdir(path.dirname(to), { recursive: true });
      await fs.promises.cp(from, to, { recursive: true, errorOnExist: false });
      done.push(entry);
    } catch {
      // Not present in the source checkout, or unreadable.
    }
  }
  return done;
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

  return {
    path: raw.path,
    name: path.basename(raw.path),
    branch: raw.branch,
    detached: raw.detached,
    locked: raw.locked,
    isMain: samePath(root, raw.path),
    managed: isManagedWorktree(raw.path),
    modified: dirty.modified,
    untracked: dirty.untracked,
    merged,
    sizeBytes,
    sessionIds: occupants(raw.path, sessionCwds),
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
