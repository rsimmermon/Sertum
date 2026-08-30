import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  PullRequestContext,
  PullRequestResult,
} from '../shared/types';
import { firstExecutable, resolveOnWindowsPath } from './adapters/binary-resolve';
import { pushBranch } from './diff-review';

const run = promisify(execFile);

/**
 * C16 goes through the GitHub CLI rather than the REST API, for one reason:
 * `gh` already owns the credential. Reimplementing auth here would mean
 * discovering, storing or prompting for a token that the user has already
 * given to a tool built to hold it.
 *
 * Every precondition is answered before the sheet offers anything, in the
 * same spirit as an agent capability: a reason the user can act on beats a
 * button that fails when pressed.
 */
export async function readPullRequestContext(
  root: string,
): Promise<PullRequestContext> {
  const empty = {
    repo: null,
    base: null,
    head: null,
    existing: null,
    commits: [],
    title: '',
    body: '',
    needsPush: false,
  };

  const gh = resolveGhBinary();
  if (!gh) {
    return {
      ...empty,
      ok: false,
      reason: 'The GitHub CLI (gh) was not found. Install it to open pull requests from here.',
    };
  }
  if (!(await ok(gh, ['auth', 'status'], root))) {
    return {
      ...empty,
      ok: false,
      reason: 'The GitHub CLI is not signed in. Run `gh auth login` and try again.',
    };
  }

  const head = await git(root, ['branch', '--show-current']);
  if (!head) {
    return {
      ...empty,
      ok: false,
      reason: 'Detached HEAD has no branch to open a pull request from.',
    };
  }

  const view = await json<{
    defaultBranchRef?: { name?: string };
    nameWithOwner?: string;
  }>(gh, ['repo', 'view', '--json', 'defaultBranchRef,nameWithOwner'], root);
  if (!view?.nameWithOwner) {
    return {
      ...empty,
      ok: false,
      reason: 'This repository has no GitHub remote that the CLI can see.',
    };
  }
  const repo = view.nameWithOwner;
  const base = view.defaultBranchRef?.name ?? null;
  if (!base) {
    return { ...empty, repo, ok: false, reason: `${repo} has no default branch.` };
  }
  if (head === base) {
    return {
      ...empty,
      repo,
      base,
      head,
      ok: false,
      reason: `You are on ${base}. A pull request needs a branch of its own.`,
    };
  }

  // gh cannot open a pull request for commits GitHub has never seen, and this
  // runs non-interactively, so its own offer to push would simply fail. Rather
  // than refuse, the sheet says so on its button and pushes first -- the same
  // push C15 performs, to the same resolved target.
  const upstream = await git(root, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ]);
  const unpushed = upstream
    ? Number((await git(root, ['rev-list', '--count', `${upstream}..HEAD`])) ?? '0')
    : 0;
  const needsPush = !upstream || unpushed > 0;
  if (needsPush && !(await git(root, ['remote']))) {
    return {
      ...empty,
      repo,
      base,
      head,
      ok: false,
      reason: `${head} has not been pushed and this repository has no remote to push to.`,
    };
  }

  const existing =
    (
      await json<
        Array<{ url: string; number: number; state: string; title: string }>
      >(
        gh,
        ['pr', 'list', '--head', head, '--json', 'url,number,state,title', '--limit', '1'],
        root,
      )
    )?.[0] ?? null;

  const commits =
    (await git(root, ['log', '--format=%s', `${base}..HEAD`]))
      ?.split('\n')
      .filter(Boolean) ?? [];

  // A single commit's own subject and body are the user's words, not a
  // summary invented here, so they seed the sheet. Several commits have no
  // such answer and the fields stay empty rather than being guessed at.
  const single = commits.length === 1;
  return {
    ok: true,
    reason: null,
    repo,
    base,
    head,
    existing,
    commits,
    needsPush,
    title: single ? commits[0] : '',
    body: single ? ((await git(root, ['log', '-1', '--format=%b'])) ?? '').trim() : '',
  };
}

/**
 * Opens the pull request. The context is re-read first, so a branch that
 * stopped qualifying between opening the sheet and pressing the button is
 * refused with the current reason rather than the one shown earlier.
 */
export async function createPullRequest(request: {
  root: string;
  title: string;
  body: string;
  draft: boolean;
}): Promise<PullRequestResult> {
  const title = request.title.trim();
  if (!title) return { ok: false, reason: 'A pull request title is required.' };

  const context = await readPullRequestContext(request.root);
  if (!context.ok || !context.base || !context.head) {
    return { ok: false, reason: context.reason ?? 'The branch cannot be opened as a pull request.' };
  }
  if (context.existing) {
    return {
      ok: false,
      url: context.existing.url,
      reason: `${context.head} already has pull request #${context.existing.number}.`,
    };
  }

  const gh = resolveGhBinary();
  if (!gh) return { ok: false, reason: 'The GitHub CLI (gh) was not found.' };

  // The button said "Push and create pull request", so this is the consented
  // half of that. A failed push stops here rather than handing gh a branch
  // GitHub cannot see.
  if (context.needsPush) {
    const pushed = await pushBranch(request.root, context.head);
    if (!pushed.ok) {
      return { ok: false, reason: pushed.reason ?? `${context.head} could not be pushed.` };
    }
  }

  const args = [
    'pr',
    'create',
    '--base',
    context.base,
    '--head',
    context.head,
    '--title',
    title,
    '--body',
    request.body,
  ];
  if (request.draft) args.push('--draft');

  let stdout: string;
  try {
    ({ stdout } = await run(gh, args, {
      cwd: request.root,
      timeout: 30_000,
      maxBuffer: 2_000_000,
      encoding: 'utf8',
    }));
  } catch (error) {
    return { ok: false, reason: ghMessage(error) };
  }

  // gh prints the new pull request's URL on success.
  const url = stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('http'));
  return { ok: true, url };
}

/**
 * The CLI's error text is the useful part -- "GraphQL: ... permission",
 * "pull request already exists" -- so it is surfaced rather than replaced
 * with a generic failure.
 */
function ghMessage(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr ?? '';
  const first = stderr
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('X '));
  return first || 'The GitHub CLI could not open the pull request.';
}

/** Same shape as the agent resolvers: real paths first, then PATH. */
function resolveGhBinary(): string | null {
  if (process.platform === 'win32') {
    return (
      firstExecutable([
        `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\GitHub CLI\\gh.exe`,
        `${process.env.LOCALAPPDATA ?? ''}\\Programs\\GitHub CLI\\gh.exe`,
      ]) ?? resolveOnWindowsPath('gh')
    );
  }
  return firstExecutable([
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
    '/usr/bin/gh',
  ]);
}

async function ok(binary: string, args: string[], cwd: string): Promise<boolean> {
  try {
    await run(binary, args, { cwd, timeout: 15_000, encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

async function json<T>(
  binary: string,
  args: string[],
  cwd: string,
): Promise<T | null> {
  try {
    const { stdout } = await run(binary, args, {
      cwd,
      timeout: 20_000,
      maxBuffer: 4_000_000,
      encoding: 'utf8',
    });
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], {
      timeout: 12_000,
      maxBuffer: 4_000_000,
      encoding: 'utf8',
    });
    return stdout.trimEnd();
  } catch {
    return null;
  }
}
