/**
 * Wireframe C7. A yes/no gate for actions that cannot be undone.
 *
 * The destructive choice is never the default: focus lands on Cancel and Esc
 * dismisses, so a stray Return or a second click on a button that has just
 * moved cannot destroy anything.
 */
export interface ConfirmOptions {
  title: string;
  body: string;
  /** Label for the destructive action. */
  confirmLabel: string;
  /** Extra line shown in a warning tone, for consequences worth spelling out. */
  warning?: string;
  /** Keep the destructive button disabled until this exact value is typed. */
  typeToConfirm?: string;
}

export function openConfirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = el('div', 'overlay');
    const dlg = el('div', 'dialog confirm-dialog');
    overlay.append(dlg);

    dlg.append(text('h3', opts.title, ''));
    dlg.append(text('p', opts.body, 'dialog-sub'));
    if (opts.warning) dlg.append(text('p', opts.warning, 'confirm-warning'));

    let typed: HTMLInputElement | null = null;
    if (opts.typeToConfirm) {
      const field = el('label', 'confirm-type');
      field.append(
        text('span', `TYPE ${opts.typeToConfirm} TO CONFIRM`, 'field-label'),
      );
      typed = document.createElement('input');
      typed.className = 'field';
      typed.autocomplete = 'off';
      typed.spellcheck = false;
      field.append(typed);
      dlg.append(field);
    }

    const actions = el('div', 'dialog-actions');
    const cancel = button('Cancel', 'btn ghost', () => close(false));
    const confirm = button(opts.confirmLabel, 'btn danger', () => close(true));
    if (typed && opts.typeToConfirm) {
      confirm.disabled = true;
      typed.oninput = () => {
        confirm.disabled = typed?.value !== opts.typeToConfirm;
      };
    }
    actions.append(el('div', 'grow'), cancel, confirm);
    dlg.append(actions);

    function close(result: boolean) {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
    };
    document.addEventListener('keydown', onKey);
    overlay.onclick = (e) => {
      if (e.target === overlay) close(false);
    };

    document.body.append(overlay);
    cancel.focus();
  });
}

function el(tag: string, cls: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

function text(tag: string, content: string, cls: string): HTMLElement {
  const node = el(tag, cls);
  node.textContent = content;
  return node;
}

function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.onclick = onClick;
  return b;
}
