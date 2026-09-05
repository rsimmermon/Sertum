/**
 * Context menu for a sidebar session row — wireframe C5.
 *
 * The wireframe is a superset of the tab menu: it adds the worktree and review
 * actions that make sense away from the terminal. Most of those belong to
 * phases that are not built yet, so they appear disabled rather than missing,
 * which is the same convention the application menu uses — the shape of the
 * app stays legible from the first run instead of growing items later.
 */

export interface MenuItem {
  label: string;
  /** Shown right-aligned and muted, exactly as in the wireframe. */
  accel?: string;
  /**
   * A second line under the label: what the item does, or why it cannot.
   * A sentence read badly squeezed into the right-aligned accel slot, which
   * is sized for a chord.
   */
  note?: string;
  /** Marks the item as the one currently in effect. */
  checked?: boolean;
  /** Red, for the items the wireframe marks destructive. */
  destructive?: boolean;
  /** Omitted for the actions a later phase will bring. */
  onSelect?: () => void;
}

/** A rule between groups of items. */
export const SEPARATOR = 'separator' as const;

export type MenuEntry = MenuItem | typeof SEPARATOR;

let openMenu: HTMLElement | null = null;

/** Closes whatever menu is open. Safe to call when none is. */
export function closeSessionMenu(): void {
  openMenu?.remove();
  openMenu = null;
}

/**
 * Opens the menu at the pointer, keeping it inside the window.
 *
 * `title` is the highlighted header the wireframe puts at the top, which names
 * the row you right-clicked so a menu opened over a dense list is never
 * ambiguous about what it will act on.
 */
export function openSessionMenu(
  x: number,
  y: number,
  title: string,
  entries: MenuEntry[],
): void {
  closeSessionMenu();

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', title);

  const head = document.createElement('div');
  head.className = 'ctx-title';
  head.textContent = title;
  menu.append(head);

  for (const entry of entries) {
    if (entry === SEPARATOR) {
      const rule = document.createElement('div');
      rule.className = 'ctx-sep';
      menu.append(rule);
      continue;
    }

    const item = document.createElement('button');
    item.type = 'button';
    item.className =
      'ctx-item' +
      (entry.destructive ? ' destructive' : '') +
      (entry.note ? ' has-note' : '') +
      (entry.checked ? ' checked' : '');
    item.setAttribute('role', entry.checked === undefined ? 'menuitem' : 'menuitemradio');
    if (entry.checked !== undefined) {
      item.setAttribute('aria-checked', String(entry.checked));
    }
    item.disabled = !entry.onSelect;

    const main = document.createElement('span');
    main.className = 'ctx-main';

    const label = document.createElement('span');
    label.className = 'ctx-label';
    label.textContent = entry.label;
    main.append(label);

    if (entry.accel) {
      const accel = document.createElement('span');
      accel.className = 'ctx-accel';
      accel.textContent = entry.accel;
      main.append(accel);
    }
    item.append(main);

    if (entry.note) {
      const note = document.createElement('span');
      note.className = 'ctx-note';
      note.textContent = entry.note;
      item.append(note);
    }

    item.onclick = () => {
      closeSessionMenu();
      entry.onSelect?.();
    };
    menu.append(item);
  }

  // Mounted hidden so it can be measured before being placed: a menu opened
  // near the bottom or right edge has to flip rather than run off-window.
  menu.style.visibility = 'hidden';
  document.body.append(menu);
  const { width, height } = menu.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, window.innerWidth - width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - height - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = '';

  openMenu = menu;
  menu.querySelector<HTMLButtonElement>('.ctx-item:not(:disabled)')?.focus();

  menu.onkeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSessionMenu();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [
      ...menu.querySelectorAll<HTMLButtonElement>('.ctx-item:not(:disabled)'),
    ];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    items[(at + step + items.length) % items.length].focus();
  };

  // Capture so the dismissing click cannot also land on whatever is beneath.
  const dismiss = (e: MouseEvent) => {
    if (menu.contains(e.target as Node)) return;
    e.preventDefault();
    e.stopPropagation();
    teardown();
  };
  const onBlur = () => teardown();
  function teardown(): void {
    document.removeEventListener('mousedown', dismiss, true);
    window.removeEventListener('blur', onBlur);
    closeSessionMenu();
  }
  document.addEventListener('mousedown', dismiss, true);
  window.addEventListener('blur', onBlur);
}
