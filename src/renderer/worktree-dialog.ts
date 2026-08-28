import { openConfirmDialog } from './confirm-dialog';
import type { WorktreeInfo, WorktreeInventory } from '../shared/types';

const api = window.sertum;

export interface WorktreeDialogOptions {
  /** Any path inside the repository whose worktrees should be listed. */
  cwd: string;
  /** Label for a session occupying a worktree, when one does. */
  sessionLabel: (id: string) => string | undefined;
  /** Focus a session working in a worktree. */
  onOpenSession: (id: string) => void;
  /** Reports the repository actually being managed, once resolved. */
  onRootChanged: (root: string) => void;
  /**
   * Hand off creation to C1 with the isolation preset. C9 deliberately does
   * not create worktrees itself -- two ways to make one would diverge.
   */
  onNewWorktree: (root: string) => void;
}

/**
 * The worktree manager — wireframe C9.
 *
 * An inventory rather than a workshop: what exists on disk, what it costs, and
 * what is safe to reclaim. Creating belongs to C1's isolation preset, so New
 * worktree hands off there rather than growing a second, divergent way to make
 * one.
 *
 * It manages a *repository*, not a session's folder. A worktree outlives the
 * session that used it -- that is the whole point of the pool -- so the folder
 * is picked here rather than inherited from whatever happens to be open, and
 * the manager works just as well with no sessions at all.
 *
 * Removal is gated on one thing: whether a session is working in the folder.
 * Uncommitted files are a cost the user is shown and can choose to pay, but a
 * session's cwd is not theirs to delete out from under. The main process
 * enforces that same rule again at the moment of removal, because this list is
 * a snapshot and a session can start while the dialog is open.
 *
 * Deliberately agent-neutral. A worktree belongs to git, so the same view
 * serves every agent; the only agent-shaped question -- what to do with a
 * session attached to one -- is handed back to the caller.
 */
export async function openWorktreeDialog(
  opts: WorktreeDialogOptions,
): Promise<void> {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const dlg = document.createElement('div');
  dlg.className = 'dialog wt-dialog';
  overlay.append(dlg);
  document.body.append(overlay);

  const close = (): void => overlay.remove();
  overlay.onmousedown = (e) => {
    if (e.target === overlay) close();
  };
  overlay.onkeydown = (e) => {
    if (e.key === 'Escape') close();
  };

  /** Folder the inventory was last read from; the repo root once resolved. */
  let target = opts.cwd;
  let inv: WorktreeInventory | null = null;
  /** Transient line under the table: why something was refused, mostly. */
  let note: { tone: 'ok' | 'warn'; text: string } | null = null;
  /** True while a removal is in flight, so a second click cannot land. */
  let working = false;

  /**
   * Reads the inventory for a folder.
   *
   * A folder that is not a repository leaves the previous inventory on screen
   * and says so, rather than blanking the dialog: mis-picking a folder should
   * cost one more click, not the list you were working through.
   */
  const load = async (dir: string, clearNote = true): Promise<void> => {
    const next = await api.listWorktrees(dir).catch(() => null);
    if (!next) {
      note = { tone: 'warn', text: `${dir} is not inside a git repository.` };
      render();
      return;
    }
    inv = next;
    target = next.root;
    if (clearNote) note = null;
    opts.onRootChanged(next.root);
    render();
  };

  /**
   * Re-reads the current repository, keeping whatever the last action had to
   * say. A removal reports its outcome by setting the note and then reloading,
   * so a reload that cleared it would swallow every refusal.
   */
  const refresh = (): Promise<void> => load(inv?.root ?? target, false);

  const choose = async (): Promise<void> => {
    const picked = await api.pickDirectory(inv?.root ?? target);
    if (picked) await load(picked);
  };

  /**
   * Removes one worktree, confirming first unless a batch already did.
   *
   * `force` is derived rather than offered: git refuses to delete a checkout
   * holding modified or untracked files, and the confirmation the user just
   * read is exactly the question --force is asking. Sessions are never part of
   * that bargain; the main process refuses those outright.
   */
  const remove = async (w: WorktreeInfo, confirm: boolean): Promise<boolean> => {
    if (confirm) {
      const ok = await openConfirmDialog({
        title: `Remove ${w.name}?`,
        body: consequence(w),
        warning: loss(w),
        confirmLabel: dirt(w) ? 'Delete uncommitted work' : 'Remove worktree',
      });
      if (!ok) return false;
    }
    const res = await api.removeWorktree(
      inv?.root ?? target,
      w.path,
      dirt(w) > 0,
    );
    if (!res.ok) {
      const busy = (res.busySessionIds ?? [])
        .map((id) => opts.sessionLabel(id))
        .filter((n): n is string => Boolean(n));
      note = {
        tone: 'warn',
        text: busy.length
          ? `${w.name} is in use by ${and(busy)}. Close ${
              busy.length === 1 ? 'that session' : 'those sessions'
            } and try again.`
          : `${w.name}: ${res.reason ?? 'git refused to remove that worktree.'}`,
      };
      return false;
    }
    return true;
  };

  const removeOne = async (w: WorktreeInfo): Promise<void> => {
    if (working) return;
    working = true;
    render();
    await remove(w, true);
    working = false;
    await refresh();
  };

  /**
   * The bulk action, over worktrees that can lose nothing: merged, clean and
   * unoccupied. Deliberately narrower than what Remove allows per row -- one
   * click should never destroy work the user was not shown item by item.
   */
  const reclaim = async (list: WorktreeInfo[]): Promise<void> => {
    if (working) return;
    const bytes = list.reduce((n, w) => n + (w.sizeBytes ?? 0), 0);
    const ok = await openConfirmDialog({
      title: `Reclaim ${size(bytes)}?`,
      body:
        `Removes ${count(list.length, 'worktree')} whose branches are already ` +
        `contained in the default branch: ${list.map((w) => w.name).join(', ')}.`,
      warning:
        'Gitignored files in those folders — .env files, installed ' +
        'dependencies, build caches — are deleted too. Worktrees with ' +
        'uncommitted changes, or with a session in them, are never included.',
      confirmLabel: 'Reclaim',
    });
    if (!ok) return;
    working = true;
    render();
    let done = 0;
    for (const w of list) if (await remove(w, false)) done += 1;
    working = false;
    if (done > 0 && !note) {
      note = { tone: 'ok', text: `Removed ${count(done, 'worktree')}.` };
    }
    await refresh();
  };

  const render = (): void => {
    const children: HTMLElement[] = [head(), repoRow()];

    if (inv) {
      children.push(table(inv), includeStrip(inv));
    } else {
      children.push(
        empty(
          'Point the manager at a git repository to see its worktrees. Any ' +
            'folder inside one will do.',
        ),
      );
    }
    if (note) children.push(strip(note.tone, note.text));
    children.push(footer(actions()));
    dlg.replaceChildren(...children);
  };

  const head = (): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'wt-head';
    const total = (inv?.worktrees ?? []).reduce(
      (n, w) => n + (w.sizeBytes ?? 0),
      0,
    );
    el.append(
      heading(
        'Worktree manager',
        inv
          ? `${inv.repo} · ${count(inv.worktrees.length, 'worktree')} · ${size(
              total,
            )} on disk`
          : 'No repository chosen.',
      ),
    );
    const headActions = document.createElement('div');
    headActions.className = 'wt-head-actions';
    // The include-file editor belongs to E4, which has not landed.
    headActions.append(
      disabledButton('Bootstrap settings', 'Settings → Worktrees (E4) is not built yet'),
      button('New worktree', 'primary small', () => {
        if (!inv) return;
        close();
        opts.onNewWorktree(inv.root);
      }, !inv),
    );
    el.append(headActions);
    return el;
  };

  /** The repository being managed, and the way to point at another one. */
  const repoRow = (): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'wt-repo';
    const p = document.createElement('span');
    p.className = 'wt-repo-path';
    p.textContent = inv?.root ?? target;
    p.title = inv?.root ?? target;
    el.append(p, button('Choose folder…', 'ghost small', () => void choose()));
    return el;
  };

  const table = (i: WorktreeInventory): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'wt-table';
    el.append(
      row(['WORKTREE', 'BRANCH', 'STATUS', 'SESSION', 'SIZE', ''], 'wt-thead'),
    );
    for (const w of i.worktrees) el.append(worktreeRow(w));
    return el;
  };

  const worktreeRow = (w: WorktreeInfo): HTMLElement => {
    const cells = document.createElement('div');
    cells.className = 'wt-row';

    // Every cell that can be clipped carries its full value as a tooltip, so
    // a narrow window costs a hover rather than the ability to tell two
    // worktrees apart -- which is exactly what a shared prefix does to them.
    const nameCell = cell(w.name, 'wt-name', `${w.name} — ${w.path}`);
    if (w.managed) {
      const tag = document.createElement('span');
      tag.className = 'wt-tag';
      tag.textContent = 'pooled';
      tag.title = 'Created and kept by Sertum, and reused for this branch';
      nameCell.append(' ', tag);
    }
    const branch = w.branch ?? 'detached';
    cells.append(
      nameCell,
      cell(branch, 'wt-branch', branch),
      cell(statusText(w), 'wt-status', statusDetail(w)),
    );

    const names = w.sessionIds
      .map((id) => opts.sessionLabel(id))
      .filter((n): n is string => Boolean(n));
    const sessionCell = document.createElement('span');
    sessionCell.className = 'wt-cell wt-session';
    const chip = document.createElement('span');
    chip.className = 'wt-chip' + (w.sessionIds.length ? ' on' : '');
    chip.textContent = names.length
      ? names.length > 1
        ? `${names[0]} +${names.length - 1}`
        : names[0]
      : w.sessionIds.length
        ? count(w.sessionIds.length, 'session')
        : '—';
    if (names.length) chip.title = names.join(', ');
    sessionCell.append(chip);
    cells.append(sessionCell);

    cells.append(cell(w.sizeBytes === null ? '—' : size(w.sizeBytes), 'wt-size'));

    const action = document.createElement('span');
    action.className = 'wt-cell wt-action';
    const blocked = blockedReason(w, names);
    if (w.sessionIds.length) {
      action.append(
        button('Open', 'ghost small', () => {
          close();
          opts.onOpenSession(w.sessionIds[0]);
        }),
      );
    } else {
      action.append(button('Reveal', 'ghost small', () => void api.revealPath(w.path)));
    }
    // Disabled rather than absent: the reason a worktree cannot go is worth
    // reading, and a row with nothing in this column looks like a bug.
    const del = button('Remove', 'danger small', () => void removeOne(w), Boolean(blocked) || working);
    if (blocked) del.title = blocked;
    action.append(del);
    cells.append(action);
    return cells;
  };

  /**
   * The include-file strip: green when configured, amber when not, because
   * git carries only tracked files into a new worktree and the untracked
   * ones are exactly what makes a checkout usable.
   */
  const includeStrip = (i: WorktreeInventory): HTMLElement =>
    strip(
      i.includeFile ? 'ok' : 'warn',
      i.includeFile
        ? `.worktreeinclude found — ${i.includeFile.entries.join(', ')} ${
            i.includeFile.entries.length === 1 ? 'is' : 'are'
          } copied into every new worktree.`
        : 'No .worktreeinclude — a new worktree starts without .env files, ' +
          'installed dependencies or build caches.',
    );

  const actions = (): HTMLElement[] => {
    const out: HTMLElement[] = [];
    const list = (inv?.worktrees ?? []).filter(isReclaimable);
    if (list.length) {
      const bytes = list.reduce((n, w) => n + (w.sizeBytes ?? 0), 0);
      out.push(
        button(
          `Reclaim ${size(bytes)} from ${count(list.length, 'merged worktree')}`,
          'ghost',
          () => void reclaim(list),
          working,
        ),
      );
    }
    out.push(button('Close', 'primary', close));
    return out;
  };

  dlg.textContent = 'Reading worktrees…';
  await load(target);
}

/**
 * Why a worktree cannot be removed, or null when it can be.
 *
 * A session in the folder is the only reason that is about use rather than
 * identity, and it is the one the user asked for: everything else here is
 * something git itself would refuse.
 */
function blockedReason(w: WorktreeInfo, names: string[]): string | null {
  if (w.isMain) return 'The repository’s own checkout is never removable.';
  if (w.locked) return 'Locked in git. Run `git worktree unlock` first.';
  if (w.sessionIds.length) {
    const who = names.length ? and(names) : count(w.sessionIds.length, 'session');
    return `In use by ${who}. Close ${
      w.sessionIds.length === 1 ? 'it' : 'them'
    } first.`;
  }
  return null;
}

/**
 * A worktree is offered for one-click bulk reclaim only when nothing at all
 * can be lost: its commits are already in the default branch, it has no
 * uncommitted work, no session is in it, and it is not the repository's own
 * checkout. Removing a worktree that fails this test is still allowed — it
 * just has to be asked for by name, with the cost spelled out.
 */
function isReclaimable(w: WorktreeInfo): boolean {
  return (
    w.merged &&
    !w.isMain &&
    !w.locked &&
    w.sessionIds.length === 0 &&
    w.modified === 0 &&
    w.untracked === 0
  );
}

/** Uncommitted files that would go with the folder. */
function dirt(w: WorktreeInfo): number {
  return w.modified + w.untracked;
}

/** What removing this worktree does to the repository, in plain terms. */
function consequence(w: WorktreeInfo): string {
  const head = `Deletes ${w.path} from disk and unregisters it from the repository.`;
  if (w.detached || !w.branch) {
    return `${head} This checkout is on a detached HEAD, so any commit made here that no branch points at becomes unreachable.`;
  }
  return w.merged
    ? `${head} Branch ${w.branch} stays in the repository and is already contained in the default branch, so no commits are lost.`
    : `${head} Branch ${w.branch} stays in the repository, so its commits survive — only this checkout of them goes.`;
}

/** What is actually destroyed, which is never the commits. */
function loss(w: WorktreeInfo): string {
  const gitignored =
    'Gitignored files there — .env files, installed dependencies, build ' +
    'caches — go too, and git has no copy of them.';
  if (!dirt(w)) return gitignored;
  const parts: string[] = [];
  if (w.modified) parts.push(count(w.modified, 'modified file'));
  if (w.untracked) parts.push(count(w.untracked, 'untracked file'));
  return `${and(parts)} in that folder will be deleted, and uncommitted work cannot be recovered. ${gitignored}`;
}

/** The status column spelled out, for the tooltip. */
function statusDetail(w: WorktreeInfo): string {
  const parts: string[] = [];
  if (w.modified) parts.push(count(w.modified, 'modified file'));
  if (w.untracked) parts.push(count(w.untracked, 'untracked file'));
  if (!parts.length) parts.push('No uncommitted changes');
  if (w.locked) parts.push('locked in git');
  if (w.merged && !w.isMain) parts.push('already contained in the default branch');
  return `${and(parts)}.`;
}

function statusText(w: WorktreeInfo): string {
  const parts: string[] = [];
  if (w.modified) parts.push(`${w.modified} mod`);
  if (w.untracked) parts.push(`${w.untracked} new`);
  const base = parts.length ? parts.join(', ') : 'clean';
  if (w.locked) return `${base} · locked`;
  return w.merged && !w.isMain ? `${base} · merged` : base;
}

function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes > 0) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return '0 KB';
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Joins names the way a sentence would. */
function and(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function heading(title: string, sub: string): HTMLElement {
  const col = document.createElement('div');
  col.className = 'wt-title';
  const h = document.createElement('h2');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = sub;
  col.append(h, p);
  return col;
}

function row(cells: string[], cls: string): HTMLElement {
  const el = document.createElement('div');
  el.className = cls;
  for (const c of cells) {
    const s = document.createElement('span');
    s.className = 'wt-cell';
    s.textContent = c;
    el.append(s);
  }
  return el;
}

function cell(text: string, cls: string, title?: string): HTMLElement {
  const s = document.createElement('span');
  s.className = `wt-cell ${cls}`;
  s.textContent = text;
  if (title) s.title = title;
  return s;
}

function strip(tone: 'ok' | 'warn', text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = `wt-strip ${tone}`;
  const dot = document.createElement('span');
  dot.className = 'wt-strip-dot';
  const body = document.createElement('span');
  body.textContent = text;
  el.append(dot, body);
  return el;
}

function empty(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'wt-empty';
  el.textContent = text;
  return el;
}

function button(
  label: string,
  cls: string,
  onClick: () => void,
  disabled = false,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn ${cls}`.trim();
  b.textContent = label;
  b.disabled = disabled;
  b.onclick = onClick;
  return b;
}

function disabledButton(label: string, why: string): HTMLElement {
  const b = button(label, 'ghost', () => {}, true);
  b.title = why;
  return b;
}

function footer(children: HTMLElement[]): HTMLElement {
  const f = document.createElement('div');
  f.className = 'dialog-footer';
  f.append(...children);
  return f;
}
