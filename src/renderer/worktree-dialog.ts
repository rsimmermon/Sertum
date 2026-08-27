import { openConfirmDialog } from './confirm-dialog';
import type { WorktreeInfo, WorktreeInventory } from '../shared/types';

const api = window.sertum;

export interface WorktreeDialogOptions {
  /** Any path inside the repository whose worktrees should be listed. */
  cwd: string;
  /** Label for the session occupying a worktree, when one does. */
  sessionLabel: (id: string) => string | undefined;
  /** Focus the session working in a worktree. */
  onOpenSession: (id: string) => void;
}

/**
 * The worktree manager — wireframe C9.
 *
 * An inventory rather than a workshop: what exists on disk, what it costs, and
 * what is safe to reclaim. Creating worktrees belongs to C1's isolation
 * preset, so the New worktree button waits for that rather than growing a
 * second, divergent way to make one.
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

  dlg.textContent = 'Reading worktrees…';
  let inventory: WorktreeInventory | null = null;
  try {
    inventory = await api.listWorktrees(opts.cwd);
  } catch {
    inventory = null;
  }

  if (!inventory) {
    dlg.replaceChildren(
      heading('Worktree manager', 'This folder is not inside a git repository.'),
      footer([button('Close', 'ghost', close)]),
    );
    return;
  }

  const inv = inventory;

  const render = (): void => {
    const total = inv.worktrees.reduce((n, w) => n + (w.sizeBytes ?? 0), 0);
    const reclaimable = inv.worktrees.filter(isReclaimable);
    const reclaimBytes = reclaimable.reduce((n, w) => n + (w.sizeBytes ?? 0), 0);

    const head = document.createElement('div');
    head.className = 'wt-head';
    head.append(
      heading(
        'Worktree manager',
        `${inv.repo} · ${count(inv.worktrees.length, 'worktree')} · ${size(total)} on disk`,
      ),
    );
    const headActions = document.createElement('div');
    headActions.className = 'wt-head-actions';
    // Both route to screens that have not landed: E4 for the include-file
    // editor, C1's isolation preset for creation.
    headActions.append(
      disabledButton('Bootstrap settings', 'Settings → Worktrees (E4) is not built yet'),
      disabledButton('New worktree', 'Create from New Session (C1) once isolation lands'),
    );
    head.append(headActions);

    const table = document.createElement('div');
    table.className = 'wt-table';
    table.append(row(['WORKTREE', 'BRANCH', 'STATUS', 'SESSION', 'SIZE', ''], 'wt-thead'));

    for (const w of inv.worktrees) {
      const sessionName = w.sessionId ? opts.sessionLabel(w.sessionId) : undefined;
      const cells = document.createElement('div');
      cells.className = 'wt-row';

      cells.append(
        cell(w.name, 'wt-name', w.path),
        cell(w.branch ?? 'detached', 'wt-branch'),
        cell(statusText(w), 'wt-status'),
      );

      const sessionCell = document.createElement('span');
      sessionCell.className = 'wt-cell wt-session';
      const chip = document.createElement('span');
      chip.className = 'wt-chip' + (sessionName ? ' on' : '');
      chip.textContent = sessionName ?? '—';
      sessionCell.append(chip);
      cells.append(sessionCell);

      cells.append(cell(w.sizeBytes === null ? '—' : size(w.sizeBytes), 'wt-size'));

      const action = document.createElement('span');
      action.className = 'wt-cell wt-action';
      if (isReclaimable(w)) {
        action.append(
          button('Remove', 'danger small', () => void remove(w, false)),
        );
      } else if (w.sessionId) {
        action.append(
          button('Open', 'ghost small', () => {
            close();
            opts.onOpenSession(w.sessionId as string);
          }),
        );
      } else {
        action.append(
          button('Reveal', 'ghost small', () => void api.revealPath(w.path)),
        );
      }
      cells.append(action);
      table.append(cells);
    }

    // The include-file strip: green when configured, amber when not, because
    // git carries only tracked files into a new worktree and the untracked
    // ones are exactly what makes a checkout usable.
    const strip = document.createElement('div');
    strip.className = 'wt-strip ' + (inv.includeFile ? 'ok' : 'warn');
    const dot = document.createElement('span');
    dot.className = 'wt-strip-dot';
    const stripText = document.createElement('span');
    stripText.textContent = inv.includeFile
      ? `.worktreeinclude found — ${inv.includeFile.entries.join(', ')} ${
          inv.includeFile.entries.length === 1 ? 'is' : 'are'
        } copied into every new worktree.`
      : 'No .worktreeinclude — a new worktree starts without .env files, ' +
        'installed dependencies or build caches.';
    strip.append(dot, stripText);

    const actions: HTMLElement[] = [];
    if (reclaimable.length) {
      actions.push(
        button(
          `Reclaim ${size(reclaimBytes)} from ${count(reclaimable.length, 'merged worktree')}`,
          'ghost',
          () => void reclaim(reclaimable),
        ),
      );
    }
    actions.push(button('Close', 'primary', close));

    dlg.replaceChildren(head, table, strip, footer(actions));
  };

  const refresh = async (): Promise<void> => {
    const next = await api.listWorktrees(opts.cwd).catch(() => null);
    if (next) inv.worktrees = next.worktrees;
    render();
  };

  const remove = async (w: WorktreeInfo, batch: boolean): Promise<void> => {
    if (!batch) {
      const ok = await openConfirmDialog({
        title: `Remove ${w.name}?`,
        body:
          `Deletes ${w.path} from disk. Its branch ${w.branch ?? ''} is already ` +
          'contained in the default branch, so no commits are lost.',
        warning:
          'Anything untracked in that folder — .env files, installed ' +
          'dependencies, build output — goes with it.',
        confirmLabel: 'Remove worktree',
      });
      if (!ok) return;
    }
    const res = await api.removeWorktree(inv.root, w.path, false);
    if (!res.ok) {
      const strip = dlg.querySelector('.wt-strip');
      if (strip) {
        strip.className = 'wt-strip warn';
        strip.textContent = res.reason ?? 'git refused to remove that worktree.';
      }
      return;
    }
    await refresh();
  };

  const reclaim = async (list: WorktreeInfo[]): Promise<void> => {
    const bytes = list.reduce((n, w) => n + (w.sizeBytes ?? 0), 0);
    const ok = await openConfirmDialog({
      title: `Reclaim ${size(bytes)}?`,
      body:
        `Removes ${count(list.length, 'worktree')} whose branches are already ` +
        `contained in the default branch: ${list.map((w) => w.name).join(', ')}.`,
      warning:
        'Untracked files in those folders are deleted too. Worktrees with ' +
        'uncommitted changes, or with a session attached, are never included.',
      confirmLabel: 'Reclaim',
    });
    if (!ok) return;
    for (const w of list) await remove(w, true);
    await refresh();
  };

  render();
}

/**
 * A worktree is only offered for removal when nothing can be lost by it: its
 * commits are already in the default branch, it has no uncommitted work, no
 * session is using it, and it is not the repository's own checkout.
 */
function isReclaimable(w: WorktreeInfo): boolean {
  return (
    w.merged &&
    !w.isMain &&
    !w.locked &&
    w.sessionId === null &&
    w.modified === 0 &&
    w.untracked === 0
  );
}

function statusText(w: WorktreeInfo): string {
  const parts: string[] = [];
  if (w.modified) parts.push(`${w.modified} mod`);
  if (w.untracked) parts.push(`${w.untracked} new`);
  const base = parts.length ? parts.join(', ') : 'clean';
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

function button(label: string, cls: string, onClick: () => void): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn ${cls}`.trim();
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

function disabledButton(label: string, why: string): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn ghost';
  b.textContent = label;
  b.disabled = true;
  b.title = why;
  return b;
}

function footer(children: HTMLElement[]): HTMLElement {
  const f = document.createElement('div');
  f.className = 'dialog-footer';
  f.append(...children);
  return f;
}
