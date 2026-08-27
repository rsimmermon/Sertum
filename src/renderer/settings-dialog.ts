import { DEFAULT_SETTINGS, type Settings, type TabPlacement } from '../shared/types';

/**
 * Wireframe E1. Display preferences only.
 *
 * Every control applies live as it changes rather than on a Save button: type
 * size is something you judge by looking at it, and a dialog that hides the
 * result behind a commit step makes you guess. Cancel restores the settings
 * captured on open, so live preview stays safe to explore.
 */
export function openSettingsDialog(
  current: Settings,
  onPreview: (s: Settings) => void,
): Promise<Settings | null> {
  return new Promise((resolve) => {
    const opened: Settings = { ...current };
    let working: Settings = { ...current };

    const overlay = el('div', 'overlay');
    const dlg = el('div', 'dialog settings-dialog');
    overlay.append(dlg);

    const title = el('h3', '');
    title.textContent = 'Settings';
    const sub = el('p', 'dialog-sub');
    sub.textContent = 'Changes preview as you make them.';
    dlg.append(title, sub);

    const apply = (patch: Partial<Settings>) => {
      working = { ...working, ...patch };
      onPreview(working);
    };

    // ---------------------------------------------------------- layout
    dlg.append(sectionHead('Layout'));

    const placements: Array<{ id: TabPlacement; label: string; hint: string }> = [
      { id: 'side', label: 'Side', hint: 'Session list only' },
      { id: 'top', label: 'Top', hint: 'Horizontal tab strip only' },
      { id: 'both', label: 'Both', hint: 'Strip and list together' },
    ];
    const placementRow = el('div', 'seg');
    const placementButtons = new Map<TabPlacement, HTMLButtonElement>();
    for (const p of placements) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn' + (working.tabPlacement === p.id ? ' on' : '');
      b.textContent = p.label;
      b.title = p.hint;
      b.onclick = () => {
        for (const [id, btn] of placementButtons) {
          btn.classList.toggle('on', id === p.id);
        }
        apply({ tabPlacement: p.id });
      };
      placementButtons.set(p.id, b);
      placementRow.append(b);
    }
    dlg.append(field('Tabs', placementRow, 'Where session tabs appear.'));

    const chips = document.createElement('input');
    chips.type = 'checkbox';
    chips.checked = working.showChips;
    chips.onchange = () => apply({ showChips: chips.checked });
    const chipsWrap = el('label', 'check');
    chipsWrap.append(chips, document.createTextNode(' Show model and effort badges'));
    dlg.append(field('Badges', chipsWrap, 'Colour-coded model and thinking-effort marks.'));

    // ------------------------------------------------------------ type
    dlg.append(sectionHead('Type size'));

    const sizes: Array<{ key: keyof Settings; label: string; hint: string }> = [
      { key: 'terminalFontSize', label: 'Terminal', hint: 'Agent output and input' },
      { key: 'tabFontSize', label: 'Tab labels', hint: 'Top strip, when shown' },
      { key: 'listFontSize', label: 'Session list', hint: 'Sidebar rows' },
      { key: 'uiFontSize', label: 'Interface', hint: 'Menus, dialogs, status bar' },
    ];
    for (const s of sizes) {
      dlg.append(
        field(
          s.label,
          stepper(working[s.key] as number, (v) => apply({ [s.key]: v } as Partial<Settings>)),
          s.hint,
        ),
      );
    }

    // ---------------------------------------------------------- actions
    const actions = el('div', 'dialog-actions');
    const reset = button('Reset to defaults', 'btn ghost', () => {
      working = { ...DEFAULT_SETTINGS, sidebarWidth: working.sidebarWidth };
      onPreview(working);
      close(null, true);
    });
    const cancel = button('Cancel', 'btn ghost', () => close(null));
    const done = button('Done', 'btn primary', () => close(working));
    actions.append(reset, spacer(), cancel, done);
    dlg.append(actions);

    function close(result: Settings | null, keepPreview = false) {
      // Cancel puts back exactly what was showing when the dialog opened.
      if (!result && !keepPreview) onPreview(opened);
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result ?? (keepPreview ? working : null));
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(null);
    };
    document.addEventListener('keydown', onKey);
    overlay.onclick = (e) => {
      if (e.target === overlay) close(null);
    };

    document.body.append(overlay);
    (dlg.querySelector('button') as HTMLButtonElement | null)?.focus();
  });
}

/** −/+ around a number, so a size can be nudged without selecting text. */
function stepper(value: number, onChange: (v: number) => void): HTMLElement {
  let current = value;
  const wrap = el('div', 'stepper');
  const out = el('span', 'stepper-value');
  out.textContent = `${current} pt`;

  const step = (delta: number) => {
    const next = Math.min(32, Math.max(8, current + delta));
    if (next === current) return;
    current = next;
    out.textContent = `${current} pt`;
    onChange(current);
  };

  wrap.append(
    button('−', 'stepper-btn', () => step(-1)),
    out,
    button('+', 'stepper-btn', () => step(1)),
  );
  return wrap;
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const row = el('div', 'setting-row');
  const left = el('div', 'setting-label');
  left.append(text('span', label, 'setting-name'));
  if (hint) left.append(text('span', hint, 'setting-hint'));
  row.append(left, control);
  return row;
}

function sectionHead(label: string): HTMLElement {
  return text('div', label, 'setting-section');
}

function spacer(): HTMLElement {
  return el('div', 'grow');
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
