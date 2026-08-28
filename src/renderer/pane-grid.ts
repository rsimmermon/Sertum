import { PANE_COUNT, type PaneLayout, type PaneSplits } from '../shared/types';

/**
 * The pane area — design section 07, screens G1 to G3.
 *
 * Geometry only. This module knows how many panes a layout has, where the
 * gutters sit and when a pane has become too small to be a terminal; it knows
 * nothing about sessions. Everything session-shaped arrives as a prebuilt
 * `header`/`body` pair, which keeps the grid free to be rebuilt on any render
 * while the xterm instances inside it are merely re-parented.
 */

/** Which gutter a drag is moving. `col` splits left/right, `row` top/bottom. */
export type SplitAxis = 'col' | 'row';

export interface SlotView {
  /** Chrome above the terminal, or null in a layout that shows none. */
  header: HTMLElement | null;
  body: HTMLElement;
  focused: boolean;
  /**
   * Border tint for an unfocused pane, so an errored session reads from across
   * the room (design G3). Focused panes always take the accent.
   */
  tone?: 'run' | 'warn' | 'err' | null;
}

export interface PaneGridOptions {
  layout: PaneLayout;
  slots: SlotView[];
  splits: PaneSplits;
  /** Terminal point size, which sets how small a pane may usefully get. */
  fontSize: number;
  onFocus(slot: number): void;
  /** Live during a drag, and again on release; also fires on double-click. */
  onSplit(axis: SplitAxis, fraction: number): void;
  /** A session dropped onto a pane, by id. */
  onDrop(slot: number, sessionId: string): void;
}

/** The drag payload used between tabs, sidebar rows and panes. */
export const SESSION_DND_TYPE = 'application/x-sertum-session';

/**
 * A terminal stops being useful before it reaches zero.
 *
 * Below 40 columns agent TUIs wrap into noise, and below 12 rows there is not
 * enough of a transcript to follow, so the layout treats these as the floor:
 * drags clamp to them and a window too small to honour them says so rather
 * than clipping output. Both scale with the terminal's own point size, which
 * is why the font size is an input (design G7, note 297).
 */
const MIN_COLS = 40;
const MIN_ROWS = 12;
/** Character cell as a fraction of point size, for the monospace stack. */
const CELL_W = 0.6;
const CELL_H = 1.25;
/** Terminal host padding plus the pane's own border and header. */
const CHROME_W = 24;
const CHROME_H = 40;

export function minPaneWidth(fontSize: number): number {
  return Math.round(MIN_COLS * fontSize * CELL_W) + CHROME_W;
}

export function minPaneHeight(fontSize: number): number {
  return Math.round(MIN_ROWS * fontSize * CELL_H) + CHROME_H;
}

const GUTTER = 6;

/**
 * Builds the grid. The returned element is ready to replace the pane host's
 * children; `refresh()` re-runs the too-small check, and reads layout to do
 * it, so calling it right after inserting the grid is enough.
 */
export function buildPaneGrid(o: PaneGridOptions): {
  element: HTMLElement;
  refresh(): void;
  /** Moves a gutter without rebuilding: a drag runs this per pointer move. */
  resize(axis: SplitAxis, fraction: number): void;
} {
  const grid = document.createElement('div');
  grid.className = `pane-grid layout-${o.layout}`;

  const cells: HTMLElement[] = [];
  const count = PANE_COUNT[o.layout];
  const slot = (index: number): HTMLElement => {
    const cell = buildSlot(o, index);
    cells.push(cell);
    return cell;
  };

  // Which element takes which share of which axis, so a drag can restate the
  // flex weights in place instead of rebuilding the grid sixty times a second.
  const shares: Array<{ el: HTMLElement; axis: SplitAxis; first: boolean }> = [];
  const sized = (
    el: HTMLElement,
    axis: SplitAxis,
    first: boolean,
    fraction: number,
  ): HTMLElement => {
    shares.push({ el, axis, first });
    el.style.flex = `${first ? fraction : 1 - fraction} 1 0`;
    return el;
  };

  if (o.layout === 'single') {
    grid.append(slot(0));
  } else if (o.layout === 'columns') {
    grid.classList.add('axis-col');
    grid.append(
      sized(slot(0), 'col', true, o.splits.columns),
      gutter(o, 'col', grid),
      sized(slot(1), 'col', false, o.splits.columns),
    );
  } else if (o.layout === 'rows') {
    grid.classList.add('axis-row');
    grid.append(
      sized(slot(0), 'row', true, o.splits.rows),
      gutter(o, 'row', grid),
      sized(slot(1), 'row', false, o.splits.rows),
    );
  } else {
    grid.classList.add('axis-row');
    // One column fraction shared by both rows keeps the grid rectangular, so
    // the four panes always read as a grid rather than two unrelated splits.
    const row = (a: number, b: number): HTMLElement => {
      const wrap = document.createElement('div');
      wrap.className = 'pane-row axis-col';
      wrap.append(
        sized(slot(a), 'col', true, o.splits.gridCol),
        gutter(o, 'col', wrap),
        sized(slot(b), 'col', false, o.splits.gridCol),
      );
      return wrap;
    };
    grid.append(
      sized(row(0, 1), 'row', true, o.splits.gridRow),
      gutter(o, 'row', grid),
      sized(row(2, 3), 'row', false, o.splits.gridRow),
    );
  }

  const check = () => {
    const minW = minPaneWidth(o.fontSize);
    const minH = minPaneHeight(o.fontSize);
    for (const cell of cells.slice(0, count)) {
      const narrow = cell.clientWidth > 0 && cell.clientWidth < minW;
      const short = cell.clientHeight > 0 && cell.clientHeight < minH;
      cell.classList.toggle('too-small', narrow || short);
      const notice = cell.querySelector<HTMLElement>('.pane-cramped-detail');
      if (notice) {
        notice.textContent = narrow
          ? `${MIN_COLS} cols min at ${o.fontSize}pt`
          : `${MIN_ROWS} rows min at ${o.fontSize}pt`;
      }
    }
  };

  const resize = (axis: SplitAxis, fraction: number) => {
    for (const share of shares) {
      if (share.axis !== axis) continue;
      share.el.style.flex = `${share.first ? fraction : 1 - fraction} 1 0`;
    }
  };

  return { element: grid, refresh: check, resize };
}

function buildSlot(o: PaneGridOptions, index: number): HTMLElement {
  const view = o.slots[index];
  const cell = document.createElement('div');
  cell.className = 'pane-cell';
  cell.dataset.slot = String(index);
  if (!view) return cell;

  cell.classList.toggle('focused', view.focused);
  if (!view.focused && view.tone) cell.classList.add(`tone-${view.tone}`);
  if (view.header) cell.append(view.header);
  cell.append(view.body);

  // Design G7: the pane stays mounted underneath, so the notice is an overlay
  // rather than a swap -- scrollback and the PTY are untouched by a resize.
  const cramped = document.createElement('div');
  cramped.className = 'pane-cramped';
  const label = document.createElement('div');
  label.className = 'pane-cramped-label';
  label.textContent = 'Too small to read';
  const detail = document.createElement('div');
  detail.className = 'pane-cramped-detail';
  cramped.append(label, detail);
  cell.append(cramped);

  // Focus follows the pointer down rather than click, so a drag that starts in
  // an unfocused pane is already acting on the pane the user reached for.
  cell.addEventListener('pointerdown', () => o.onFocus(index));

  cell.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes(SESSION_DND_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    cell.classList.add('drop-target');
  });
  cell.addEventListener('dragleave', () => cell.classList.remove('drop-target'));
  cell.addEventListener('drop', (e) => {
    cell.classList.remove('drop-target');
    const id = e.dataTransfer?.getData(SESSION_DND_TYPE);
    if (!id) return;
    e.preventDefault();
    o.onDrop(index, id);
  });

  return cell;
}

/**
 * A draggable gutter.
 *
 * The fraction is computed against `container` rather than accumulated from
 * pointer deltas, so a drag that outruns the pointer or is clamped at a
 * minimum cannot drift out of step with where the gutter actually is.
 */
function gutter(
  o: PaneGridOptions,
  axis: SplitAxis,
  container: HTMLElement,
): HTMLElement {
  const el = document.createElement('div');
  el.className = `pane-gutter axis-${axis}`;
  el.setAttribute('role', 'separator');
  el.setAttribute(
    'aria-orientation',
    axis === 'col' ? 'vertical' : 'horizontal',
  );
  el.setAttribute('aria-label', 'Resize panes');
  el.title = 'Drag to resize · double-click to equalise';

  el.onpointerdown = (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    const move = (ev: PointerEvent) => {
      const box = container.getBoundingClientRect();
      const span = axis === 'col' ? box.width : box.height;
      const at = axis === 'col' ? ev.clientX - box.left : ev.clientY - box.top;
      const min =
        axis === 'col' ? minPaneWidth(o.fontSize) : minPaneHeight(o.fontSize);
      const usable = span - GUTTER;
      if (usable <= 0) return;
      // Both neighbours have to clear the minimum. When the container cannot
      // fit two of them, the gutter simply holds still.
      const lo = min / usable;
      const hi = 1 - min / usable;
      if (lo > hi) return;
      o.onSplit(axis, Math.min(hi, Math.max(lo, at / usable)));
    };
    const up = () => {
      el.classList.remove('dragging');
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  el.ondblclick = () => o.onSplit(axis, 0.5);
  return el;
}
