import type { PullRequestContext, PullRequestResult } from '../shared/types';

const api = window.sertum;

/**
 * Open pull request — wireframe C16 (frame Zxhhh).
 *
 * Everything the branch can and cannot do is resolved before the sheet is
 * drawn, so the controls state the answer instead of failing when pressed: a
 * missing `gh`, a branch that is really the default branch, or a pull request
 * this branch already has are all shown as reasons rather than as errors
 * after the fact.
 */
export function openPullRequestDialog(root: string): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    const dlg = document.createElement('div');
    dlg.className = 'dialog pr-dialog';
    overlay.append(dlg);

    const finish = (): void => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve();
    };

    let submit: HTMLButtonElement | null = null;
    function onKey(event: KeyboardEvent): void {
      if (
        event.key === 'Enter' &&
        (event.ctrlKey || event.metaKey) &&
        submit &&
        !submit.disabled
      ) {
        event.preventDefault();
        submit.click();
      }
    }

    // Neither a backdrop click nor Escape is an answer: every route out of a
    // modal goes through one of its own buttons. See "Modals answer, they do
    // not vanish" in AGENTS.md.
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);

    dlg.replaceChildren(
      title('Open pull request'),
      waiting('Reading the branch…'),
      closeFooter(finish),
    );
    void api
      .readPullRequest(root)
      .catch((): PullRequestContext | null => null)
      .then((context) => {
        if (!context) {
          dlg.replaceChildren(
            title('Open pull request'),
            note('The branch could not be read.', 'error'),
            closeFooter(finish),
          );
          return;
        }
        submit = render(context, root, dlg, finish);
      });
  });
}

function render(
  context: PullRequestContext,
  root: string,
  dlg: HTMLElement,
  finish: () => void,
): HTMLButtonElement | null {
  const head = title('Open pull request');

  if (!context.ok) {
    dlg.replaceChildren(head, note(context.reason ?? 'Unavailable.', 'error'), closeFooter(finish));
    return null;
  }

  // The branch line reads exactly as C16 draws it: head → base, with how far
  // ahead the branch is.
  const branch = document.createElement('div');
  branch.className = 'pr-branch';
  branch.append(
    span(context.head ?? '', 'pr-head'),
    span('→', 'pr-arrow'),
    span(context.base ?? '', 'pr-base'),
    span(`${context.commits.length} AHEAD`, 'minichip'),
  );

  if (context.existing) {
    const existing = context.existing;
    dlg.replaceChildren(
      head,
      branch,
      note(
        `${context.head} already has pull request #${existing.number}: ${existing.title}`,
        'warn',
      ),
      footer([
        button('Close', 'ghost', finish),
        button('Open on GitHub', 'primary', () => {
          void api.openExternal(existing.url);
          finish();
        }),
      ]),
    );
    return null;
  }

  const titleLabel = document.createElement('label');
  titleLabel.className = 'field-label';
  titleLabel.textContent = 'TITLE';
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'field';
  titleInput.value = context.title;
  titleInput.spellcheck = true;

  const bodyLabel = document.createElement('label');
  bodyLabel.className = 'field-label';
  bodyLabel.textContent = 'DESCRIPTION';
  const bodyInput = document.createElement('textarea');
  bodyInput.className = 'field';
  bodyInput.rows = 6;
  bodyInput.value = context.body;
  bodyInput.spellcheck = true;

  const draftRow = document.createElement('label');
  draftRow.className = 'check commit-check';
  const draftBox = document.createElement('input');
  draftBox.type = 'checkbox';
  const draftCopy = document.createElement('span');
  draftCopy.textContent = 'Create as draft';
  draftRow.append(draftBox, draftCopy);

  const status = document.createElement('div');
  status.className = 'commit-status';
  status.hidden = true;

  const cancel = button('Cancel', 'ghost', finish);
  // C16 note 136: an unpushed branch is pushed for you, and the button says so
  // rather than the sheet refusing.
  const label = context.needsPush
    ? 'Push and create pull request'
    : 'Create pull request';
  const submit = button(label, 'primary', () => void run());

  const sync = (): void => {
    submit.disabled = titleInput.value.trim().length === 0;
  };
  titleInput.oninput = sync;

  async function run(): Promise<void> {
    submit.disabled = true;
    cancel.disabled = true;
    show(context.needsPush ? 'Pushing, then opening…' : 'Opening pull request…', null);
    let result: PullRequestResult;
    try {
      result = await api.createPullRequest({
        root,
        title: titleInput.value,
        body: bodyInput.value,
        draft: draftBox.checked,
      });
    } catch {
      result = { ok: false, reason: 'The pull request could not be opened.' };
    }

    if (!result.ok) {
      cancel.disabled = false;
      sync();
      show(result.reason ?? 'The pull request could not be opened.', 'error');
      // A pull request that already exists is still somewhere to go.
      if (result.url) {
        const url = result.url;
        status.append(
          document.createTextNode(' '),
          link('Open on GitHub', () => void api.openExternal(url)),
        );
      }
      return;
    }

    if (result.url) void api.openExternal(result.url);
    finish();
  }

  function show(text: string, tone: 'error' | 'warn' | null): void {
    status.hidden = false;
    status.textContent = text;
    status.classList.toggle('is-error', tone === 'error');
    status.classList.toggle('is-warn', tone === 'warn');
  }

  dlg.replaceChildren(
    head,
    branch,
    titleLabel,
    titleInput,
    bodyLabel,
    bodyInput,
    draftRow,
    status,
    footer([cancel, submit]),
  );
  titleInput.focus();
  sync();
  return submit;
}

function title(text: string): HTMLElement {
  const h = document.createElement('h3');
  h.textContent = text;
  return h;
}

/**
 * The waiting state, which carries its own way out.
 *
 * A modal closes only through one of its own buttons, so the seconds spent
 * reading `gh` cannot be a stretch with no button on screen: a call that hangs
 * would leave a dialog nothing could dismiss.
 */
function waiting(text: string): HTMLElement {
  const el = document.createElement('p');
  el.className = 'dialog-sub';
  el.textContent = text;
  return el;
}

function span(text: string, className: string): HTMLElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

function note(text: string, tone: 'error' | 'warn'): HTMLElement {
  const el = document.createElement('div');
  el.className = `commit-status is-${tone}`;
  el.textContent = text;
  return el;
}

function link(text: string, action: () => void): HTMLElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'linkish';
  el.textContent = text;
  el.onclick = action;
  return el;
}

function footer(children: HTMLElement[]): HTMLElement {
  const el = document.createElement('div');
  el.className = 'dialog-footer';
  el.append(...children);
  return el;
}

function closeFooter(finish: () => void): HTMLElement {
  return footer([button('Close', 'primary', finish)]);
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
