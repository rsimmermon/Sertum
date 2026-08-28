import { type PaneLayout } from '../shared/types';

/**
 * The layout picker — design section 07, screen G4.
 *
 * Reached three ways, all of which land here: the layout button in the pane
 * header, View → Pane Layout, and ⌘⌥L. Single is always listed first because
 * it is where every window starts and what closing the last split returns to.
 *
 * Actions whose feature has not landed are listed without a handler and render
 * disabled, the same convention the application menu and the row menu use --
 * the shape of the feature stays legible rather than appearing later.
 */

export interface LayoutOption {
  layout: PaneLayout;
  label: string;
  detail: string;
  accel: string;
}

export const LAYOUT_OPTIONS: LayoutOption[] = [
  {
    layout: 'single',
    label: 'Single',
    detail: 'One pane, full viewport — the default',
    accel: '⌘⌥1',
  },
  {
    layout: 'columns',
    label: 'Columns',
    detail: 'Side by side, split vertically',
    accel: '⌘⌥2',
  },
  {
    layout: 'rows',
    label: 'Rows',
    detail: 'Stacked, split horizontally',
    accel: '⌘⌥3',
  },
  {
    layout: 'grid',
    label: 'Grid',
    detail: 'Two by two, up to four sessions',
    accel: '⌘⌥4',
  },
];

/**
 * The picker's own name for a layout.
 *
 * Shared with the status bar and the pane header so the four names are written
 * once: a layout called Columns in one place and Vertical in another is the
 * kind of drift that makes a shortcut list untrustworthy.
 */
export function layoutLabel(layout: PaneLayout): string {
  return LAYOUT_OPTIONS.find((o) => o.layout === layout)?.label ?? layout;
}

export interface LayoutAction {
  label: string;
  accel: string;
  /** Omitted when the action cannot apply right now; renders disabled. */
  run?: () => void;
  /** Shown under the list when the action was offered but is unavailable. */
  unavailable?: string;
}

export interface LayoutPickerOptions {
  /** The button the popover hangs from. */
  anchor: HTMLElement;
  current: PaneLayout;
  onPick(layout: PaneLayout): void;
  actions: LayoutAction[];
}

let openPop: HTMLElement | null = null;

export function closeLayoutPicker(): void {
  openPop?.remove();
  openPop = null;
}

export function openLayoutPicker(o: LayoutPickerOptions): void {
  closeLayoutPicker();

  const pop = document.createElement('div');
  pop.className = 'layout-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Pane layout');

  const title = document.createElement('div');
  title.className = 'layout-pop-title';
  title.textContent = 'Pane layout';
  pop.append(title);

  const list = document.createElement('div');
  list.className = 'layout-opts';
  for (const opt of LAYOUT_OPTIONS) {
    const selected = opt.layout === o.current;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'layout-opt' + (selected ? ' selected' : '');
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(selected));
    item.append(glyph(opt.layout));

    const col = document.createElement('span');
    col.className = 'layout-opt-text';
    const name = document.createElement('span');
    name.className = 'layout-opt-name';
    name.textContent = opt.label;
    const detail = document.createElement('span');
    detail.className = 'layout-opt-detail';
    detail.textContent = opt.detail;
    col.append(name, detail);

    const accel = document.createElement('span');
    accel.className = 'layout-accel';
    accel.textContent = opt.accel;

    item.append(col, accel);
    item.onclick = () => {
      closeLayoutPicker();
      o.onPick(opt.layout);
    };
    list.append(item);
  }
  pop.append(list);

  const rule = document.createElement('div');
  rule.className = 'layout-sep';
  pop.append(rule);

  const notices: string[] = [];
  for (const action of o.actions) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'layout-action';
    item.setAttribute('role', 'menuitem');
    item.disabled = !action.run;
    const label = document.createElement('span');
    label.textContent = action.label;
    const accel = document.createElement('span');
    accel.className = 'layout-accel';
    accel.textContent = action.accel;
    item.append(label, accel);
    item.onclick = () => {
      closeLayoutPicker();
      action.run?.();
    };
    pop.append(item);
    if (!action.run && action.unavailable) notices.push(action.unavailable);
  }

  // Design note 276: the ceiling is stated where the user hit it, with the way
  // forward, rather than as a beep.
  for (const message of notices) {
    const warn = document.createElement('div');
    warn.className = 'layout-warn';
    warn.textContent = message;
    pop.append(warn);
  }

  const foot = document.createElement('div');
  foot.className = 'layout-foot';
  const bullet = document.createElement('span');
  bullet.className = 'layout-foot-dot';
  const text = document.createElement('span');
  text.textContent =
    'Layout is remembered until you change it. Splits never stop a session — a hidden one stays in the list.';
  foot.append(bullet, text);
  pop.append(foot);

  // Measured hidden, then placed: a picker opened near an edge has to flip
  // rather than run off-window.
  pop.style.visibility = 'hidden';
  document.body.append(pop);
  const box = pop.getBoundingClientRect();
  const from = o.anchor.getBoundingClientRect();
  const left = Math.max(
    4,
    Math.min(from.left, window.innerWidth - box.width - 4),
  );
  const below = from.bottom + 6;
  const top =
    below + box.height + 4 > window.innerHeight
      ? Math.max(4, from.top - box.height - 6)
      : below;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.style.visibility = '';

  openPop = pop;
  pop.querySelector<HTMLButtonElement>('.layout-opt.selected')?.focus();

  pop.onkeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      teardown();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [
      ...pop.querySelectorAll<HTMLButtonElement>(
        '.layout-opt, .layout-action:not(:disabled)',
      ),
    ];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    items[(at + step + items.length) % items.length].focus();
  };

  const dismiss = (e: MouseEvent) => {
    if (pop.contains(e.target as Node)) return;
    e.preventDefault();
    e.stopPropagation();
    teardown();
  };
  const onBlur = () => teardown();
  function teardown(): void {
    document.removeEventListener('mousedown', dismiss, true);
    window.removeEventListener('blur', onBlur);
    closeLayoutPicker();
  }
  document.addEventListener('mousedown', dismiss, true);
  window.addEventListener('blur', onBlur);
}

/**
 * The little diagram beside each option.
 *
 * Cheap to build and worth it: the names alone do not say which axis splits,
 * and "Columns, split vertically" is exactly the phrase people read twice.
 */
function glyph(layout: PaneLayout): HTMLElement {
  const box = document.createElement('span');
  box.className = `layout-glyph glyph-${layout}`;
  box.setAttribute('aria-hidden', 'true');
  const cells = layout === 'single' ? 1 : layout === 'grid' ? 4 : 2;
  for (let i = 0; i < cells; i += 1) {
    box.append(document.createElement('span'));
  }
  return box;
}
