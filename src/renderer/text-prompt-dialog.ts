/** A small multiline prompt used by structured session actions. */
export function openTextPrompt(options: {
  title: string;
  description: string;
  placeholder?: string;
  submitLabel: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    const dialog = document.createElement('div');
    dialog.className = 'dialog text-prompt-dialog';

    const title = document.createElement('h3');
    title.textContent = options.title;
    const description = document.createElement('p');
    description.className = 'dialog-sub';
    description.textContent = options.description;
    const input = document.createElement('textarea');
    input.className = 'field';
    input.rows = 5;
    input.placeholder = options.placeholder ?? '';
    input.spellcheck = true;

    const cancel = button('Cancel', 'ghost', () => finish(null));
    const submit = button(options.submitLabel, 'primary', () => {
      const value = input.value.trim();
      if (value) finish(value);
    });
    submit.disabled = true;
    input.oninput = () => {
      submit.disabled = input.value.trim().length === 0;
    };

    const footer = document.createElement('div');
    footer.className = 'dialog-footer';
    footer.append(cancel, submit);
    dialog.append(title, description, input, footer);
    overlay.append(dialog);

    function finish(value: string | null): void {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
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

    // Neither a backdrop click nor Escape is an answer: every route out of a
    // modal goes through one of its own buttons. See "Modals answer, they do
    // not vanish" in AGENTS.md.
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    input.focus();
  });
}

function button(
  label: string,
  kind: string,
  action: () => void,
): HTMLButtonElement {
  const element = document.createElement('button');
  element.className = `btn ${kind}`;
  element.textContent = label;
  element.onclick = action;
  return element;
}
