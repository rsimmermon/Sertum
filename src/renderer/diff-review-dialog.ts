import type { DiffFileInfo, DiffInventory } from '../shared/types';
import { openCommitDialog } from './commit-dialog';
import { openConfirmDialog } from './confirm-dialog';

const api = window.sertum;

/**
 * Git-backed changes review — wireframe C11 (frame eeoMn).
 *
 * Discard and commit both re-read Git before acting, so what this dialog
 * shows is never what authorises a write -- the inventory on screen is
 * display only.
 */
export async function openDiffReviewDialog(cwd: string): Promise<void> {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const dlg = document.createElement('div');
  dlg.className = 'dialog diff-dialog';
  overlay.append(dlg);
  document.body.append(overlay);

  const close = (): void => overlay.remove();
  // Neither a backdrop click nor Escape is an answer: every route out of a
  // modal goes through one of its own buttons. See "Modals answer, they do
  // not vanish" in AGENTS.md.

  loading(dlg, close);
  const inventory = await api.readDiff(cwd).catch(() => null);
  if (!inventory) {
    dlg.replaceChildren(
      heading('Changes', 'This folder is not inside a Git repository.'),
      footer(close),
    );
    return;
  }
  render(inventory, dlg, close);
}

function render(inv: DiffInventory, dlg: HTMLElement, close: () => void): void {
  const head = document.createElement('div');
  head.className = 'diff-head';
  head.append(
    heading(
      'Changes',
      `${inv.branch ?? 'detached HEAD'} · ${count(inv.files.length, 'file')} · +${inv.additions} −${inv.deletions}`,
    ),
  );
  const actions = document.createElement('div');
  actions.className = 'diff-actions';
  const discard = actionButton('Discard all', 'danger');
  discard.onclick = async () => {
    const confirmation = inv.branch ?? 'DISCARD';
    const shown = inv.files.slice(0, 8).map((file) => file.path);
    const remainder = inv.files.length - shown.length;
    const ok = await openConfirmDialog({
      title: `Discard changes in ${inv.branch ?? 'this worktree'}?`,
      body: `Permanently restores or removes ${count(inv.files.length, 'changed file')}: ${shown.join(', ')}${remainder ? `, and ${remainder} more` : ''}.`,
      warning: 'Uncommitted changes and untracked files cannot be recovered from Git.',
      confirmLabel: 'Discard all',
      typeToConfirm: confirmation,
    });
    if (!ok) return;
    discard.disabled = true;
    const result = await api.discardDiff(inv.root);
    if (!result.ok) {
      discard.disabled = false;
      const error = message(result.reason ?? 'The changes could not be discarded.');
      error.classList.add('diff-error');
      dlg.insertBefore(error, dlg.lastElementChild);
      return;
    }
    loading(dlg, close);
    const refreshed = await api.readDiff(inv.root);
    if (refreshed) render(refreshed, dlg, close);
  };
  const commit = actionButton('Commit & push', 'primary');
  commit.disabled = !inv.files.length;
  if (!inv.files.length) commit.title = 'There is nothing to commit.';
  commit.onclick = async () => {
    // C15 commits the inventory this dialog is showing, so a commit sends us
    // back to Git for a fresh one rather than trusting what is on screen.
    if (!(await openCommitDialog(inv))) return;
    loading(dlg, close);
    const refreshed = await api.readDiff(inv.root);
    if (refreshed) render(refreshed, dlg, close);
  };
  actions.append(discard, commit);
  head.append(actions);

  if (!inv.files.length) {
    const empty = document.createElement('div');
    empty.className = 'diff-empty';
    empty.textContent = 'This worktree has no uncommitted changes.';
    dlg.replaceChildren(head, empty, footer(close));
    return;
  }

  const body = document.createElement('div');
  body.className = 'diff-body';
  const list = document.createElement('div');
  list.className = 'diff-files';
  const view = document.createElement('div');
  view.className = 'diff-view';
  body.append(list, view);

  let selected: HTMLButtonElement | null = null;
  let request = 0;
  const choose = async (file: DiffFileInfo, row: HTMLButtonElement): Promise<void> => {
    selected?.classList.remove('active');
    selected = row;
    row.classList.add('active');
    const ticket = ++request;
    view.replaceChildren(diffTitle(file), message('Reading diff…'));
    const result = await api.readDiffFile(inv.root, file.path);
    if (ticket !== request) return;
    const content = result.patch ? patch(result.patch) : message(result.reason ?? 'No diff to show.');
    view.replaceChildren(diffTitle(file), content);
  };

  for (const file of inv.files) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'diff-file';
    const path = document.createElement('span');
    path.className = 'diff-file-path';
    path.textContent = file.path;
    path.title = file.path;
    const stat = document.createElement('span');
    stat.className = 'diff-file-stat';
    stat.textContent = file.reason
      ? file.binary
        ? 'binary'
        : 'not shown'
      : `+${file.additions ?? 0} −${file.deletions ?? 0}`;
    row.append(path, stat);
    row.onclick = () => void choose(file, row);
    list.append(row);
  }

  dlg.replaceChildren(head, body, footer(close));
  (list.firstElementChild as HTMLButtonElement | null)?.click();
}

function diffTitle(file: DiffFileInfo): HTMLElement {
  const title = document.createElement('div');
  title.className = 'diff-view-title';
  const path = document.createElement('span');
  path.textContent = file.path;
  const status = document.createElement('span');
  status.className = 'diff-status';
  status.textContent = file.status.toUpperCase();
  title.append(path, status);
  return title;
}

function patch(value: string): HTMLElement {
  const pre = document.createElement('pre');
  pre.className = 'diff-patch';
  for (const valueLine of value.split('\n')) {
    const line = document.createElement('span');
    line.className =
      valueLine.startsWith('+') && !valueLine.startsWith('+++')
        ? 'add'
        : valueLine.startsWith('-') && !valueLine.startsWith('---')
          ? 'del'
          : valueLine.startsWith('@@')
            ? 'hunk'
            : '';
    line.textContent = valueLine || ' ';
    pre.append(line);
  }
  return pre;
}

function heading(title: string, sub: string): HTMLElement {
  const col = document.createElement('div');
  col.className = 'diff-heading';
  const h = document.createElement('h2');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = sub;
  col.append(h, p);
  return col;
}

function message(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'diff-message';
  el.textContent = text;
  return el;
}

/**
 * The waiting state, which carries its own way out.
 *
 * A modal closes only through one of its own buttons, so the seconds spent
 * reading Git cannot be a stretch with no button on screen: a call that hangs
 * would leave a dialog nothing could dismiss.
 */
function loading(dlg: HTMLElement, close: () => void): void {
  dlg.replaceChildren(message('Reading changes…'), footer(close));
}

function actionButton(label: string, tone: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn ${tone} small`;
  button.textContent = label;
  return button;
}

function footer(close: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'dialog-footer';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn primary';
  button.textContent = 'Close';
  button.onclick = close;
  el.append(button);
  return el;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
