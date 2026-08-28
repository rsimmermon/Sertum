import { PANE_COUNT, type PaneLayout, type PaneSplits } from '../shared/types';

/**
 * The pane area — design section 07, screens G1 to G3.
 *
 * Geometry only. This module knows how many panes a layout has, where the
 * gutters sit and when a pane has become too small to be a terminal; it knows
 * nothing about sessions. Everything session-shaped arrives as a prebuilt
 * `header`/`body` pair, so a repaint is a swap of those two rather than a new
 * grid: see `update`, and the comment on it for why that matters to whoever is
 * typing at the time.
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

export interface PaneGrid {
  element: HTMLElement;
  /** Re-runs the too-small check, reading the grid's current geometry. */
  refresh(): void;
  /** Moves a gutter without rebuilding: a drag runs this per pointer move. */
  resize(axis: SplitAxis, fraction: number): void;
  /**
   * Restates the slots in place, for a grid whose shape has not changed.
   *
   * Whether it has is the caller's to know -- the layout and the slot count
   * are fixed when the grid is built -- and this is what that buys: a terminal
   * already in the right cell is left exactly where it is. Moving a node out
   * of the document blurs whatever inside it holds keyboard focus, and putting
   * it back does not return it, so a grid rebuilt on every repaint takes the
   * caret away from whoever is typing each time an unrelated session ticks.
   */
  update(slots: SlotView[], splits: PaneSplits, fontSize: number): void;
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
export function buildPaneGrid(o: PaneGridOptions): PaneGrid {
  const grid = document.createElement('div');
  grid.className = `pane-grid layout-${o.layout}`;

  const cells: HTMLElement[] = [];
  const applies: Array<(view: SlotView | undefined) => void> = [];
  const count = PANE_COUNT[o.layout];
  const slot = (index: number): HTMLElement => {
    const built = buildSlot(o, index);
    cells.push(built.cell);
    applies.push(built.apply);
    return built.cell;
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
    const share = fractionOf(o.layout, 'col', o.splits);
    grid.append(
      sized(slot(0), 'col', true, share),
      gutter(o, 'col', grid),
      sized(slot(1), 'col', false, share),
    );
  } else if (o.layout === 'rows') {
    grid.classList.add('axis-row');
    const share = fractionOf(o.layout, 'row', o.splits);
    grid.append(
      sized(slot(0), 'row', true, share),
      gutter(o, 'row', grid),
      sized(slot(1), 'row', false, share),
    );
  } else {
    grid.classList.add('axis-row');
    // One column fraction shared by both rows keeps the grid rectangular, so
    // the four panes always read as a grid rather than two unrelated splits.
    const row = (a: number, b: number): HTMLElement => {
      const wrap = document.createElement('div');
      wrap.className = 'pane-row axis-col';
      wrap.append(
        sized(slot(a), 'col', true, fractionOf(o.layout, 'col', o.splits)),
        gutter(o, 'col', wrap),
        sized(slot(b), 'col', false, fractionOf(o.layout, 'col', o.splits)),
      );
      return wrap;
    };
    grid.append(
      sized(row(0, 1), 'row', true, fractionOf(o.layout, 'row', o.splits)),
      gutter(o, 'row', grid),
      sized(row(2, 3), 'row', false, fractionOf(o.layout, 'row', o.splits)),
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

  const update = (
    slots: SlotView[],
    splits: PaneSplits,
    fontSize: number,
  ): void => {
    // The gutter's clamp and the too-small check read these when they run
    // rather than when the grid was built, so a type-size change is not a
    // reason to rebuild either.
    o.slots = slots;
    o.fontSize = fontSize;
    applies.forEach((apply, index) => apply(slots[index]));
    // Restating both axes covers a split the user reset from the menu, and
    // costs nothing on the layouts that have only one gutter or none.
    resize('col', fractionOf(o.layout, 'col', splits));
    resize('row', fractionOf(o.layout, 'row', splits));
  };

  return { element: grid, refresh: check, resize, update };
}

/** Which recorded fraction an axis reads, given the layout drawing it. */
function fractionOf(
  layout: PaneLayout,
  axis: SplitAxis,
  splits: PaneSplits,
): number {
  if (layout === 'grid') return axis === 'col' ? splits.gridCol : splits.gridRow;
  return layout === 'columns' ? splits.columns : splits.rows;
}

/** The tints a pane can carry, so a repaint can clear the one it had. */
const TONES = ['run', 'warn', 'err'] as const;

function buildSlot(
  o: PaneGridOptions,
  index: number,
): { cell: HTMLElement; apply(view: SlotView | undefined): void } {
  const cell = document.createElement('div');
  cell.className = 'pane-cell';
  cell.dataset.slot = String(index);

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

  // Everything above is the cell itself and outlives any one render. What
  // follows is the part a repaint restates, and it is deliberately a swap of
  // whole nodes: the header is rebuilt each time because its status text
  // changes, the body is not, because it is usually a live terminal.
  let header: HTMLElement | null = null;
  let body: HTMLElement | null = null;

  const apply = (view: SlotView | undefined): void => {
    const nextHeader = view?.header ?? null;
    if (nextHeader !== header) {
      if (header?.parentElement === cell) header.remove();
      if (nextHeader) cell.prepend(nextHeader);
      header = nextHeader;
    }

    const nextBody = view?.body ?? null;
    if (nextBody !== body) {
      // Another cell may have claimed this body earlier in the same pass --
      // that is what dragging a session between panes looks like -- so it is
      // detached only while it is still ours, or the pane it just moved to
      // would lose it.
      if (body?.parentElement === cell) body.remove();
      if (nextBody) cell.insertBefore(nextBody, cramped);
      body = nextBody;
    }

    cell.classList.toggle('focused', Boolean(view?.focused));
    for (const tone of TONES) {
      cell.classList.toggle(
        `tone-${tone}`,
        Boolean(view && !view.focused && view.tone === tone),
      );
    }
  };

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

  apply(o.slots[index]);
  return { cell, apply };
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
