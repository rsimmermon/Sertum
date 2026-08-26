import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DirectoryInfo } from '../shared/types';

const run = promisify(execFile);

/**
 * Answers what we can about a candidate working folder before an agent is
 * spawned in it. Git state matters because a worktree and a main checkout
 * behave differently, and the user should see which one they picked.
 */
export async function inspectDirectory(dir: string): Promise<DirectoryInfo> {
  const resolved = path.resolve(expandHome(dir));
  const info: DirectoryInfo = {
    path: resolved,
    exists: false,
    isDirectory: false,
    isGitRepo: false,
    branch: null,
    isWorktree: false,
  };

  try {
    const stat = await fs.promises.stat(resolved);
    info.exists = true;
    info.isDirectory = stat.isDirectory();
  } catch {
    return info;
  }
  if (!info.isDirectory) return info;

  try {
    const { stdout } = await run(
      'git',
      ['rev-parse', '--is-inside-work-tree', '--abbrev-ref', 'HEAD'],
      { cwd: resolved, timeout: 3000 },
    );
    const [inside, branch] = stdout.trim().split('\n');
    info.isGitRepo = inside === 'true';
    info.branch = branch?.trim() || null;
  } catch {
    return info;
  }

  // A linked worktree has a .git *file* pointing at the parent's gitdir.
  try {
    const gitPath = path.join(resolved, '.git');
    const stat = await fs.promises.stat(gitPath);
    info.isWorktree = stat.isFile();
  } catch {
    // Nested subdirectory of a repo: not the worktree root, leave false.
  }

  return info;
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Sensible default working folder: where the app was launched from, unless
 * that is `/` (the Finder/dock case), in which case fall back to home.
 */
export function defaultCwd(): string {
  const cwd = process.cwd();
  if (!cwd || cwd === '/' || cwd === path.parse(cwd).root) return os.homedir();
  return cwd;
}
