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
/**
 * Where keyboard focus was when the menu took it, so it can be handed back.
 *
 * A menu focuses its first item, which is what makes the arrow keys work --
 * and, until this existed, what made the caret vanish. Removing the element
 * dropped focus to `<body>`, and nothing put it back: `focusActivePane` in
 * `app.ts` refocuses only when the pane it should be in has *changed*, which
 * setting a chip on the session you are already looking at never does. So
 * picking a model left the composer unfocused and the next keystroke went
 * nowhere.
 */
let focusReturn: HTMLElement | null = null;
/** Takes the open menu's document-level dismiss handlers off again. */
let releaseListeners: (() => void) | null = null;

/** Closes whatever menu is open. Safe to call when none is. */
export function closeSessionMenu(): void {
  closeMenu(true);
}

/**
 * `restore` is false only when a menu is being replaced by its own second
 * render -- bouncing focus through the composer and back would be visible,
 * and the replacement decides for itself whether to take it.
 */
function closeMenu(restore: boolean): void {
  const menu = openMenu;
  if (!menu) return;
  const back = focusReturn;
  // Only give focus back if the menu still had it. A click that landed
  // somewhere else has already said where focus belongs.
  const held = menu.contains(document.activeElement);
  openMenu = null;
  const release = releaseListeners;
  releaseListeners = null;
  release?.();
  menu.remove();
  if (!restore) return;
  focusReturn = null;
  if (held && back?.isConnected) back.focus();
}

/**
 * Whether a menu this caller opened is still the one on screen.
 *
 * A menu whose contents have to be fetched opens once saying so and again
 * with the answer, and between the two the reader may have clicked away or
 * opened something else. Re-rendering then would put back a menu they
 * dismissed, so the second render asks this first.
 */
export function isSessionMenuOpen(menu: HTMLElement | null): boolean {
  return menu !== null && openMenu === menu;
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
): HTMLElement {
  // A menu whose contents had to be fetched renders twice, and the reader may
  // well have gone back to typing while it was being read. The second render
  // takes focus only if nothing has moved on -- the menu it replaces still
  // holds it, or focus is still on whatever opened the menu -- so the caret
  // is never pulled out of the composer a second or two after a click.
  const replacing = openMenu !== null;
  const keepFocus =
    !replacing ||
    openMenu!.contains(document.activeElement) ||
    document.activeElement === focusReturn;
  if (!replacing) {
    const active = document.activeElement;
    focusReturn = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  closeMenu(false);

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
  if (keepFocus) menu.querySelector<HTMLButtonElement>('.ctx-item:not(:disabled)')?.focus();
  const opened = menu;

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
    closeSessionMenu();
  };
  const onBlur = () => closeSessionMenu();
  document.addEventListener('mousedown', dismiss, true);
  window.addEventListener('blur', onBlur);
  // Every way the menu can close runs through `closeMenu`, so that is where
  // these come off -- they used to be removed only by the dismissing click
  // itself, which meant choosing an item left a document-wide capturing
  // mousedown handler behind. The next click anywhere in the app then hit a
  // detached menu, was swallowed by the `preventDefault` above, and only the
  // click after it reached the composer at all.
  releaseListeners = () => {
    document.removeEventListener('mousedown', dismiss, true);
    window.removeEventListener('blur', onBlur);
  };

  return opened;
}
