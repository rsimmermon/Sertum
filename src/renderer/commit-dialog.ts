import type { DiffCommitResult, DiffInventory } from '../shared/types';
import { openPullRequestDialog } from './pull-request-dialog';

const api = window.sertum;

/**
 * Commit sheet — wireframe C15 (frame HxSVe), reached from C11's Commit &
 * push button.
 *
 * The sheet asks Git for nothing it can infer: the file count and stat come
 * from the inventory C11 already read, and the push destination is the one
 * `readDiff` resolved, so the checkbox names where the push will actually
 * land instead of promising `origin` and finding out afterwards.
 *
 * Resolves true when a commit was written, so C11 can re-read its inventory.
 */
export function openCommitDialog(inv: DiffInventory): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    const dlg = document.createElement('div');
    dlg.className = 'dialog commit-dialog';
    overlay.append(dlg);

    let committed = false;
    const finish = (): void => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(committed);
    };

    const title = document.createElement('h3');
    title.textContent = 'Commit & push';
    const sub = document.createElement('p');
    sub.className = 'dialog-sub';
    sub.textContent = `${count(inv.files.length, 'file')} on ${inv.branch ?? 'detached HEAD'} · +${inv.additions} −${inv.deletions}`;

    // --- message ------------------------------------------------------------
    // Deliberately not prefilled. Sertum has no account of what the change is
    // for that it did not read off a terminal, and a summary invented here
    // would be committed under the user's name.
    const label = document.createElement('label');
    label.className = 'field-label';
    label.textContent = 'MESSAGE';
    const message = document.createElement('textarea');
    message.className = 'field';
    message.rows = 5;
    message.placeholder = 'Summary line\n\nOptional body explaining why.';
    message.spellcheck = true;

    // --- push ---------------------------------------------------------------
    const pushRow = document.createElement('label');
    pushRow.className = 'check commit-check';
    const pushBox = document.createElement('input');
    pushBox.type = 'checkbox';
    const pushCopy = document.createElement('span');
    if (inv.pushTarget) {
      pushCopy.textContent = `Push to ${inv.pushTarget}`;
    } else {
      pushCopy.textContent = 'Push after committing';
      pushBox.disabled = true;
      pushRow.title = inv.pushReason ?? 'There is nowhere to push.';
      pushRow.classList.add('is-declined');
    }
    pushRow.append(pushBox, pushCopy);

    // C15 note 131: this chains into C16 once the push has landed. It follows
    // the push rather than standing alone, because a pull request needs the
    // branch on the remote first.
    const prRow = document.createElement('label');
    prRow.className = 'check commit-check';
    const prBox = document.createElement('input');
    prBox.type = 'checkbox';
    const prCopy = document.createElement('span');
    prCopy.textContent = 'Open a pull request after pushing';
    prRow.append(prBox, prCopy);

    const status = document.createElement('div');
    status.className = 'commit-status';
    status.hidden = true;

    const cancel = button('Cancel', 'ghost', finish);
    const submit = button('Commit & push', 'primary', () => void run());
    submit.disabled = true;

    const syncSubmit = (): void => {
      const pushing = pushBox.checked && !pushBox.disabled;
      submit.textContent = pushing ? 'Commit & push' : 'Commit';
      submit.disabled = message.value.trim().length === 0;
      // Without a push there is nothing for GitHub to open a request against.
      prBox.disabled = !pushing;
      if (!pushing) prBox.checked = false;
      prRow.classList.toggle('is-declined', !pushing);
      prRow.title = pushing ? '' : 'A pull request needs the branch pushed first.';
    };
    message.oninput = syncSubmit;
    pushBox.onchange = syncSubmit;

    async function run(): Promise<void> {
      submit.disabled = true;
      cancel.disabled = true;
      show('Committing…', null);
      let result: DiffCommitResult;
      try {
        result = await api.commitDiff({
          root: inv.root,
          message: message.value,
          paths: inv.files.map((file) => file.path),
          push: pushBox.checked && !pushBox.disabled,
        });
      } catch {
        result = { ok: false, reason: 'The commit could not be run.' };
      }

      if (!result.ok) {
        cancel.disabled = false;
        syncSubmit();
        show(result.reason ?? 'The commit failed.', 'error');
        return;
      }

      // The commit landing and the push landing are separate facts, and a
      // push that failed must not read as work lost.
      committed = true;
      if (result.push && !result.push.ok) {
        cancel.disabled = false;
        cancel.textContent = 'Close';
        show(
          `Committed ${result.commit ?? ''}. Not pushed — ${result.push.reason ?? 'the push failed.'}`.trim(),
          'warn',
        );
        return;
      }

      const chain = prBox.checked && !prBox.disabled;
      finish();
      if (chain) await openPullRequestDialog(inv.root);
    }

    function show(text: string, tone: 'error' | 'warn' | null): void {
      status.hidden = false;
      status.textContent = text;
      status.classList.toggle('is-error', tone === 'error');
      status.classList.toggle('is-warn', tone === 'warn');
    }

    function onKey(event: KeyboardEvent): void {
      if (
        event.key === 'Enter' &&
        (event.ctrlKey || event.metaKey) &&
        !submit.disabled
      ) {
        event.preventDefault();
        submit.click();
      }
    }

    const footer = document.createElement('div');
    footer.className = 'dialog-footer';
    footer.append(cancel, submit);
    dlg.append(title, sub, label, message, pushRow, prRow, status, footer);

    // Neither a backdrop click nor Escape is an answer: every route out of a
    // modal goes through one of its own buttons. See "Modals answer, they do
    // not vanish" in AGENTS.md.
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    message.focus();
    syncSubmit();
  });
}

function button(
  text: string,
  kind: string,
  action: () => void,
): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `btn ${kind}`;
  element.textContent = text;
  element.onclick = action;
  return element;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
