/**
 * The command palette — wireframe C13.
 *
 * ⌘K is meant to be the keyboard route to everything, so no feature is
 * menu-only. The palette itself knows nothing about agents: it is handed a
 * list of sessions and a list of actions and renders them the same way, so a
 * Claude session, a Codex session and a shell all appear and behave
 * identically here. Anything that genuinely differs per agent is resolved
 * behind AgentAdapter long before it reaches this file.
 */

export interface PaletteSession {
  id: string;
  /** Shown as the row title. */
  label: string;
  /** Rendered under the title as "repo · status". */
  detail: string;
  /** A single glyph standing in for the session's status. */
  glyph: string;
  /** Free text the query also matches against, such as the folder path. */
  haystack: string;
}

export interface PaletteAction {
  glyph: string;
  label: string;
  accel?: string;
  /** Omitted for actions whose feature has not landed; renders disabled. */
  run?: () => void;
}

export interface PaletteOptions {
  sessions: PaletteSession[];
  actions: PaletteAction[];
  /** Focus an existing session. */
  onPickSession: (id: string) => void;
  /**
   * Chosen when nothing matches: C13 offers to start a session named after
   * whatever was typed, so a dead end still moves you forward.
   */
  onCreateNamed: (label: string) => void;
  /** Called after the palette closes, to put focus back in the terminal. */
  onClose: () => void;
}

interface Row {
  el: HTMLElement;
  activate: () => void;
}

let open: HTMLElement | null = null;

export function closeCommandPalette(): void {
  open?.remove();
  open = null;
}

export function openCommandPalette(opts: PaletteOptions): void {
  closeCommandPalette();

  const overlay = document.createElement('div');
  overlay.className = 'overlay palette-overlay';

  const panel = document.createElement('div');
  panel.className = 'palette';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Command palette');
  overlay.append(panel);

  const search = document.createElement('div');
  search.className = 'palette-search';
  const hint = document.createElement('span');
  hint.className = 'palette-hint';
  hint.textContent = '⌘K';
  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Search sessions and actions');
  input.placeholder = 'Search sessions and actions';
  search.append(hint, input);

  const results = document.createElement('div');
  results.className = 'palette-results';
  panel.append(search, results);

  let rows: Row[] = [];
  let cursor = 0;

  const render = (): void => {
    const query = input.value.trim();
    const needle = query.toLowerCase();
    results.replaceChildren();
    rows = [];

    const sessions = opts.sessions.filter((s) =>
      `${s.label} ${s.haystack}`.toLowerCase().includes(needle),
    );
    const actions = opts.actions.filter((a) =>
      a.label.toLowerCase().includes(needle),
    );

    if (sessions.length === 0 && actions.length === 0) {
      const none = document.createElement('div');
      none.className = 'palette-empty';
      none.textContent = query
        ? `No matches. Press ⏎ to start a session named “${query}”.`
        : 'No sessions or actions.';
      results.append(none);
      // Enter still has somewhere to go, which is the point of the message.
      if (query) {
        rows.push({
          el: none,
          activate: () => {
            closeCommandPalette();
            opts.onCreateNamed(query);
          },
        });
      }
      cursor = 0;
      return;
    }

    if (sessions.length) {
      results.append(groupLabel('SESSIONS'));
      for (const s of sessions) {
        rows.push(
          addRow(results, s.glyph, s.label, s.detail, undefined, true, () => {
            closeCommandPalette();
            opts.onPickSession(s.id);
          }),
        );
      }
    }

    if (actions.length) {
      results.append(groupLabel('ACTIONS'));
      for (const a of actions) {
        const run = a.run;
        rows.push(
          addRow(results, a.glyph, a.label, null, a.accel, Boolean(run), () => {
            closeCommandPalette();
            run?.();
          }),
        );
      }
    }

    cursor = rows.findIndex((r) => !r.el.classList.contains('disabled'));
    if (cursor < 0) cursor = 0;
    paint();
  };

  const paint = (): void => {
    rows.forEach((r, i) => r.el.classList.toggle('on', i === cursor));
    rows[cursor]?.el.scrollIntoView({ block: 'nearest' });
  };

  const move = (delta: number): void => {
    if (rows.length === 0) return;
    let next = cursor;
    // Skip past the actions a later phase will bring rather than letting the
    // cursor rest somewhere Enter would do nothing.
    for (let i = 0; i < rows.length; i += 1) {
      next = (next + delta + rows.length) % rows.length;
      if (!rows[next].el.classList.contains('disabled')) break;
    }
    cursor = next;
    paint();
  };

  input.oninput = render;
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[cursor];
      if (row && !row.el.classList.contains('disabled')) row.activate();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      dismiss();
    }
  };

  // A click outside is the other way out, and must not reach the terminal.
  overlay.onmousedown = (e) => {
    if (e.target === overlay) {
      e.preventDefault();
      dismiss();
    }
  };

  function dismiss(): void {
    closeCommandPalette();
    opts.onClose();
  }

  document.body.append(overlay);
  open = overlay;
  render();
  input.focus();
}

function groupLabel(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'palette-group';
  el.textContent = text;
  return el;
}

function addRow(
  parent: HTMLElement,
  glyph: string,
  title: string,
  detail: string | null,
  accel: string | undefined,
  enabled: boolean,
  activate: () => void,
): Row {
  const row = document.createElement('div');
  row.className = 'palette-row' + (enabled ? '' : ' disabled');
  row.setAttribute('role', 'option');

  const mark = document.createElement('span');
  mark.className = 'palette-glyph';
  mark.textContent = glyph;

  const col = document.createElement('span');
  col.className = 'palette-col';
  const name = document.createElement('span');
  name.className = 'palette-title';
  name.textContent = title;
  col.append(name);
  if (detail) {
    const sub = document.createElement('span');
    sub.className = 'palette-detail';
    sub.textContent = detail;
    col.append(sub);
  }

  row.append(mark, col);
  if (accel) {
    const key = document.createElement('span');
    key.className = 'palette-accel';
    key.textContent = accel;
    row.append(key);
  }

  if (enabled) row.onclick = activate;
  parent.append(row);
  return { el: row, activate };
}
