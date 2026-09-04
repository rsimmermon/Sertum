import { TerminalPane } from './terminal-pane';
import { ChatPane } from './chat-pane';
import { ApprovalBar } from './approval-bar';
import { openNewSessionDialog } from './new-session-dialog';
import { openAdoptDialog } from './adopt-dialog';
import { openSettingsDialog } from './settings-dialog';
import { openConfirmDialog } from './confirm-dialog';
import { agentName, effortChip, modelChip } from './chips';
import { openSessionMenu, SEPARATOR } from './session-menu';
import {
  openCommandPalette,
  type PaletteAction,
} from './command-palette';
import { openWorktreeDialog } from './worktree-dialog';
import { openDiffReviewDialog } from './diff-review-dialog';
import { openTextPrompt } from './text-prompt-dialog';
import {
  buildPaneGrid,
  SESSION_DND_TYPE,
  type PaneGrid,
  type SlotView,
  type SplitAxis,
} from './pane-grid';
import {
  closeLayoutPicker,
  LAYOUT_OPTIONS,
  layoutLabel,
  openLayoutPicker,
} from './layout-picker';
import { agentIcon } from './agent-icon';
import { noteAgentAvailability, openAgentPicker } from './agent-picker';
import {
  DEFAULT_SETTINGS,
  PANE_COUNT,
  type AgentCapabilities,
  type AgentKind,
  type MenuState,
  type PaneLayout,
  type SessionSnapshot,
  type SessionStatus,
  type Settings,
} from '../shared/types';

const api = window.sertum;
const menu = window.sertumMenu;

/** Order the sidebar by what needs you most, exactly as in wireframe B3. */
const GROUP_ORDER: Array<{ key: SessionStatus; label: string }> = [
  { key: 'needs-input', label: 'NEEDS INPUT' },
  { key: 'working', label: 'WORKING' },
  { key: 'attention', label: 'ATTENTION' },
  { key: 'done', label: 'DONE' },
  { key: 'idle', label: 'IDLE' },
];

/** One glyph per status, standing in for the sidebar's coloured dot (C13). */
const STATUS_GLYPH: Record<SessionStatus, string> = {
  'needs-input': '◑',
  working: '◐',
  attention: '◭',
  done: '●',
  idle: '○',
};

/**
 * Border tint an unfocused pane carries (design note 265).
 *
 * Only the states worth noticing across the room get one: an idle pane stays
 * neutral so the ones that need you stand out rather than everything glowing.
 */
const STATUS_TONE: Record<SessionStatus, 'run' | 'warn' | 'err' | null> = {
  'needs-input': 'warn',
  working: 'run',
  attention: 'err',
  // Design note 265 tints an unfocused pane only when it is not green: a
  // finished session is not asking for anything, so it stays neutral and the
  // panes that do need you are the ones that stand out.
  done: null,
  idle: null,
};

/** A one-glyph diagram of each layout, for the pane header's button. */
const LAYOUT_GLYPH: Record<PaneLayout, string> = {
  single: '▢',
  columns: '▥',
  rows: '▤',
  grid: '▦',
};

/** CSS custom properties the settings dialog drives. */
const FONT_VARS: Array<[keyof Settings, string]> = [
  ['tabFontSize', '--size-tab'],
  ['listFontSize', '--size-list'],
  ['uiFontSize', '--size-ui'],
];

export class App {
  private sessions = new Map<string, SessionSnapshot>();
  private approvals = new ApprovalBar(() => this.render());
  private panes = new Map<string, TerminalPane>();
  /**
   * Chat views, keyed by session like the terminals above. Both live at once:
   * the terminal keeps its PTY and scrollback while the chat view is up, so
   * toggling costs nothing and input always has somewhere to go.
   */
  private chatPanes = new Map<string, ChatPane>();
  /**
   * Sessions that predate this window — the daemon kept them alive across a
   * GUI restart. Their terminals are repainted from the daemon's replay
   * buffer, and live bytes are held back until the replay lands so nothing
   * is drawn twice or out of order.
   */
  private needsReplay = new Set<string>();
  /**
   * Which session each pane holds, in reading order; null is an empty pane.
   *
   * Design section 07. With more than one terminal on screen, "the active
   * session" is exactly "whatever is in the focused pane", so `activeId` is
   * derived from this rather than stored alongside it -- one source of truth,
   * which is what stops the two from drifting when a pane is closed or a
   * session is dropped into a different one.
   */
  private slots: Array<string | null> = [null];
  private focusedSlot = 0;
  private layout: PaneLayout = 'single';
  /** Last menu state sent, so an unchanged answer is not resent. */
  private lastMenuState = '';
  /**
   * A pane promoted to the full viewport. The layout is kept, not discarded,
   * so a second press restores it (design G6, note 287).
   */
  private maximised: number | null = null;
  /** Which pane last took keyboard focus, so a render does not steal it. */
  private focusKey = '';
  /** The grid on screen, or null while the window is showing its empty state. */
  private grid: PaneGrid | null = null;
  /** The shape that grid was built for; anything else needs a new one. */
  private gridKey = '';
  private lastCwd: string | null = null;
  /**
   * Repository the worktree manager was last pointed at.
   *
   * Kept because worktrees outlive sessions: after closing the session that
   * used one, nothing else in the app still remembers which repository you
   * were managing, and falling back to the launch folder would send you
   * somewhere you never asked for.
   */
  private lastWorktreeRoot: string | null = null;
  private notice: string | null = null;
  /** A one-click way out of whatever `notice` is complaining about. */
  private noticeFix: { label: string; run: () => void } | null = null;
  private adapters: import('../shared/types').AdapterStatus | null = null;
  /**
   * Every agent's answer to every capability, read once at startup. The UI
   * consults these before offering an action, so a declined capability is
   * shown as declined -- with the adapter's own reason -- rather than found
   * out by calling something that does nothing.
   */
  private capabilities: Record<AgentKind, AgentCapabilities> | null = null;
  private settings: Settings = { ...DEFAULT_SETTINGS };

  private el = {
    root: qs('#root'),
    tabstrip: qs('.tabstrip'),
    sidebar: qs('.sidebar'),
    titlebarText: qs('#titlebar-text'),
    splitter: qs('#splitter'),
    sidebarNew: qs('#sidebar-new'),
    sidebarNewAgent: qs('#sidebar-new-agent') as HTMLButtonElement,
    openSettings: qs('#open-settings'),
    paneStop: qs('#pane-stop') as HTMLButtonElement,
    sidebarList: qs('#sidebar-list'),
    sidebarCount: qs('#sidebar-count'),
    sidebarHead: qs('#sidebar-head'),
    sidebarFind: qs('#sidebar-find'),
    sidebarSearch: qs('#sidebar-search'),
    sidebarFilter: qs('#sidebar-filter') as HTMLInputElement,
    sidebarClear: qs('#sidebar-clear'),
    paneHost: qs('#pane-host'),
    approvalHost: qs('#approval-host'),
    paneHead: qs('#pane-head'),
    paneTitle: qs('#pane-title'),
    layoutButton: qs('#pane-layout') as HTMLButtonElement,
    statusLeft: qs('#status-left'),
    statusRight: qs('#status-right'),
  };

  async start(): Promise<void> {
    // Settings first: they decide the shell's shape, and applying them after
    // the first render would show the default layout then visibly reflow.
    try {
      this.settings = await api.getSettings();
    } catch {
      this.settings = { ...DEFAULT_SETTINGS };
    }
    this.applySettings(this.settings);
    // The layout is a preference, so it is restored with the others -- but the
    // panes start empty, because nothing this window was showing survived the
    // last quit (design G4: layout is remembered, sessions are not).
    this.layout = this.settings.paneLayout;
    this.slots = Array.from({ length: PANE_COUNT[this.layout] }, () => null);
    this.installSplitter();

    // DOM dialogs are modal to the renderer already; keep Electron's native
    // menu in the same state. Watching the common overlay class covers every
    // dialog and restores commands as soon as its own close path removes it.
    new MutationObserver(() => this.syncMenuState()).observe(document.body, {
      childList: true,
    });

    // Row ages are derived from startedAt, so a sidebar that nothing else is
    // updating still has to be repainted for them to stay true.
    setInterval(() => this.renderSidebar(), 30_000);

    this.el.sidebarNew.onclick = () => void this.promptNewSession();
    // The caret names the agent up front; the button itself repeats the last
    // one, which is the common case and stays a single click.
    this.el.sidebarNewAgent.onclick = () => {
      // No `current`: this list starts a session rather than editing a
      // value, so nothing in it is already chosen. The face of the split
      // button is where "the one you used last" lives.
      void openAgentPicker(this.el.sidebarNewAgent, {
        onManage: () => void this.promptSettings(),
      }).then((agent) => {
        if (agent) void this.promptNewSession(undefined, { agent });
      });
    };
    this.installFilter();
    this.el.openSettings.onclick = () => void this.promptSettings();
    this.el.paneStop.onclick = () => {
      if (this.activeId) void api.killSession(this.activeId);
    };
    this.el.layoutButton.onclick = () => this.openLayoutMenu(this.el.layoutButton);

    api.onData(({ id, data }) => {
      // Held back for a session awaiting its replay: these bytes are inside
      // the buffer the replay will deliver, so writing them now would show
      // them twice.
      if (this.needsReplay.has(id)) return;
      this.panes.get(id)?.write(data);
    });
    api.onPtyReplay(({ id, data }) => {
      this.needsReplay.delete(id);
      this.panes.get(id)?.replay(data);
    });

    api.onExit(({ id, exitCode }) => {
      this.panes
        .get(id)
        ?.writeNotice(
          `── session exited (code ${exitCode}). Worktree and transcript are untouched. ──`,
        );
    });

    api.onSessionUpdated((s) => {
      this.sessions.set(s.id, s);
      this.render();
    });

    // C20 note 150: clicking a notification lands on the session it was about.
    api.onSessionReveal((id) => {
      if (this.sessions.has(id)) this.focusSession(id);
    });

    // B5: a tool call is holding a turn open until someone answers.
    this.el.approvalHost.append(this.approvals.element);
    api.onApprovalNeeded((request) => {
      this.approvals.show(request);
      // Answering means seeing what led to the request, so the session comes
      // forward with the bar -- whichever call the bar ended up showing, which
      // is not this one when an older call is still queued ahead of it.
      const showing = this.approvals.sessionId;
      if (showing && this.sessions.has(showing)) this.focusSession(showing);
    });
    api.onApprovalGone((id) => this.approvals.dismiss(id));

    menu.on('new-session', () => void this.promptNewSession());
    menu.on('settings', () => void this.promptSettings());
    menu.on('import-sessions', () => void this.promptAdopt());
    menu.on('close-tab', () => {
      if (this.activeId) void this.closeTab(this.activeId);
    });
    menu.on('interrupt', () => this.activeId && api.write(this.activeId, '\x1b'));
    menu.on('stop', () => this.activeId && void api.killSession(this.activeId));
    menu.on('copy', () => this.copyFromFocus());
    menu.on('paste', () => this.pasteToFocus());
    menu.on('palette', () => this.openPalette());
    menu.on('worktrees', () => void this.promptWorktrees());
    menu.on('rename', () => this.activeId && this.beginRename(this.activeId));
    menu.on('next-session', () => this.stepSession(1));
    menu.on('prev-session', () => this.stepSession(-1));
    for (let n = 1; n <= 9; n += 1) {
      menu.on(`goto-session-${n}`, () => this.gotoSession(n));
    }

    for (const opt of LAYOUT_OPTIONS) {
      menu.on(`layout-${opt.layout}`, () => this.setLayout(opt.layout));
    }
    menu.on('layout-picker', () => this.openLayoutMenu(this.el.layoutButton));
    menu.on('split-right', () => this.splitFocused('right'));
    menu.on('split-down', () => this.splitFocused('down'));
    menu.on('close-pane', () => this.closePane(this.focusedSlot));
    menu.on('reset-panes', () => this.resetPaneSizes());
    menu.on('maximise-pane', () => this.toggleMaximise(this.focusedSlot));
    for (const dir of ['left', 'right', 'up', 'down'] as const) {
      menu.on(`focus-pane-${dir}`, () => this.moveFocus(dir));
    }

    // Every pane on screen has to re-fit, not just the focused one, or the
    // unfocused PTYs keep drawing against the geometry they had before. The
    // grid itself is left alone: rebuilding it per resize frame would re-parent
    // every terminal for no gain.
    window.addEventListener('resize', () => this.refitPanes());

    // Only macOS hides its own title bar, so only macOS gets ours.
    this.el.root.classList.toggle('mac', api.platform === 'darwin');

    // Adapter health is polled: it is a property of the app, not of a turn,
    // so it does not belong on the event stream.
    const pollAdapters = async () => {
      try {
        this.adapters = await api.adapterStatus();
        // The picker lists what this machine can run, and has to be right on
        // its first paint -- so it reads this poll's answer rather than
        // starting its own round trip when it opens.
        noteAgentAvailability(this.adapters);
        this.renderStatus();
      } catch {
        this.adapters = null;
      }
    };
    void pollAdapters();
    setInterval(() => void pollAdapters(), 4000);

    // Capabilities are declared by the adapters and fixed for the app's life,
    // unlike adapter health above, so one read is enough.
    try {
      this.capabilities = await api.agentCapabilities();
    } catch {
      this.capabilities = null;
    }

    for (const s of await api.listSessions()) {
      this.sessions.set(s.id, s);
      // Anything alive in this first listing ran before this window did, so
      // its terminal has history only the daemon's buffer holds.
      if (s.origin !== 'monitored' && s.transport !== 'stream') {
        this.needsReplay.add(s.id);
      }
    }
    // Sessions outlive the renderer (reload, devtools). Re-select one, or the
    // empty state renders on top of tabs that already exist.
    if (!this.activeId) this.activeId = [...this.sessions.keys()][0] ?? null;
    this.render();
  }

  /**
   * Opens wireframe C1 so the working folder is always an explicit choice,
   * then starts the session the user described.
   *
   * The dialog itself performs the spawn (see `new-session-dialog.ts`'s
   * `done()`) and reports a failure inline, so by the time this resolves the
   * session is real: this only has to wire the snapshot into a pane.
   */
  async promptNewSession(
    presetLabel?: string,
    preset?: {
      cwd?: string;
      isolation?: 'main' | 'new' | 'existing';
      /** Chosen from the split button, so the dialog does not ask again. */
      agent?: AgentKind;
    },
  ): Promise<void> {
    const startCwd =
      preset?.cwd ??
      this.lastCwd ??
      (this.activeId ? this.sessions.get(this.activeId)?.cwd : undefined) ??
      (await api.defaultCwd());
    const snapshot = await openNewSessionDialog({
      startCwd,
      capabilities: this.capabilities,
      agentBackground: this.settings.agentBackground,
      presetLabel,
      presetIsolation: preset?.isolation,
      presetAgent: preset?.agent,
    });
    if (!snapshot) return;
    this.lastCwd = snapshot.cwd;
    this.sessions.set(snapshot.id, snapshot);
    if (snapshot.transport === 'pty') {
      this.panes.set(
        snapshot.id,
        new TerminalPane(snapshot, this.settings),
      );
    }
    this.activeId = snapshot.id;
    this.render();
  }

  /**
   * Wireframe C18. Adopts sessions running elsewhere: daemon-hosted ones get
   * a real terminal, the rest become live status rows.
   */
  async promptAdopt(): Promise<void> {
    const picked = await openAdoptDialog();
    if (!picked?.length) return;
    for (const d of picked) {
      const snapshot =
        d.adoptMode === 'attach'
          ? await api.attachSession(d)
          : await api.monitorSession(d);
      this.sessions.set(snapshot.id, snapshot);
      this.activeId = snapshot.id;
    }
    this.render();
  }

  // ------------------------------------------------------------ pane layout

  /** The session in the focused pane, which is what "active" now means. */
  private get activeId(): string | null {
    return this.slots[this.focusedSlot] ?? null;
  }

  private set activeId(id: string | null) {
    this.assignSlot(this.focusedSlot, id);
  }

  /**
   * Puts a session in a pane.
   *
   * A session occupies at most one pane, so moving it into this one vacates
   * wherever it was rather than showing the same PTY twice -- two views onto
   * one terminal is a separate feature (design G8) with its own sizing rules.
   */
  private assignSlot(slot: number, id: string | null): void {
    if (id !== null) {
      const at = this.slots.indexOf(id);
      if (at >= 0 && at !== slot) this.slots[at] = null;
    }
    this.slots[slot] = id;
  }

  /**
   * Panes actually drawn, which is one while a pane is maximised.
   *
   * Distinct from `isSplit`, and the distinction matters: maximising is a
   * temporary zoom, not a layout change, so the tabs, the sidebar and the
   * status bar keep describing the split that is still there while the grid
   * draws only the promoted pane.
   */
  private paneCount(): number {
    return this.maximised === null ? PANE_COUNT[this.layout] : 1;
  }

  private isSplit(): boolean {
    return PANE_COUNT[this.layout] > 1;
  }

  /** Slots the layout has, maximised or not. */
  private layoutSlots(): Array<string | null> {
    return this.slots.slice(0, PANE_COUNT[this.layout]);
  }

  /** Slot contents as drawn: the whole layout, or just the maximised pane. */
  private visiblePaneSlots(): Array<string | null> {
    if (this.maximised !== null) return [this.slots[this.maximised] ?? null];
    return this.layoutSlots();
  }

  /** Sessions the layout holds — what the sidebar calls IN VIEW. */
  private inView(): string[] {
    return this.layoutSlots().filter((id): id is string => id !== null);
  }

  /** Sessions with a terminal on screen right now, so refits reach them. */
  private onScreen(): string[] {
    return this.visiblePaneSlots().filter((id): id is string => id !== null);
  }

  /**
   * Switches layout, keeping what is already on screen.
   *
   * `fill` is the difference between the two ways a pane appears. Choosing a
   * layout from the picker backfills new panes from sessions that were only
   * tabs until now -- the common case is one session you are steering and one
   * you are watching, and making you drag it there would be busywork. A split
   * of the focused pane deliberately does not: it opens empty and names its
   * three ways in, because there it is genuinely unclear which session was
   * meant (design G4 note 272 against G5).
   */
  private applyLayout(next: PaneLayout, fill: boolean): void {
    // A shortcut or a menu item can change the layout while the picker is
    // still open, which would leave it showing the wrong selection.
    closeLayoutPicker();
    const count = PANE_COUNT[next];
    // The focused session leads, so it is the one that keeps the viewport when
    // panes go away (design note 268).
    const ordered = [
      this.slots[this.focusedSlot],
      ...this.visiblePaneSlots(),
    ].filter(
      (id): id is string => typeof id === 'string' && this.sessions.has(id),
    );
    const slots: Array<string | null> = [...new Set(ordered)].slice(0, count);

    if (fill) {
      for (const s of this.orderedSessions()) {
        if (slots.length >= count) break;
        if (!slots.includes(s.id)) slots.push(s.id);
      }
    }
    while (slots.length < count) slots.push(null);

    this.layout = next;
    this.slots = slots;
    this.focusedSlot = 0;
    this.maximised = null;
    this.persistLayout();
    this.render();
  }

  /** Called by the picker, the View menu and ⌘⌥1…4. */
  setLayout(next: PaneLayout): void {
    if (next === this.layout && this.maximised === null) return;
    this.applyLayout(next, true);
  }

  /**
   * Adds a pane beside the focused one and promotes the layout to suit.
   *
   * With four named layouts rather than a free-form tree, "one more pane" has
   * exactly one honest destination each time, and past four there is none --
   * a fifth pane would be too small to read, so the answer is another window
   * (design note 276).
   */
  private splitFocused(axis: 'right' | 'down'): void {
    const next = this.splitTarget(axis);
    if (!next) {
      this.setNotice(
        'Grid already shows the four panes that stay readable. Open another window for a fifth session.',
      );
      this.render();
      return;
    }
    this.applyLayout(next, false);
    // applyLayout compacts what was on screen to the front, so the pane this
    // split just added is the first empty one.
    const empty = this.slots.indexOf(null);
    if (empty >= 0) this.focusedSlot = empty;
    this.render();
  }

  private splitTarget(axis: 'right' | 'down'): PaneLayout | null {
    if (this.layout === 'single') return axis === 'right' ? 'columns' : 'rows';
    if (this.layout === 'grid') return null;
    return 'grid';
  }

  /**
   * Closing a pane is a layout action, never a session action (design G6).
   *
   * The session keeps running and stays in the list; only this view of it goes
   * away. Once one pane is left there is no split to preserve, so the window
   * drops back to Single rather than sitting on a layout full of holes.
   */
  private closePane(slot: number): void {
    closeLayoutPicker();
    if (this.maximised !== null) this.maximised = null;
    this.slots[slot] = null;
    const filled = this.inView();
    if (filled.length <= 1) {
      this.layout = 'single';
      this.slots = [filled[0] ?? null];
      this.focusedSlot = 0;
      this.persistLayout();
      this.render();
      return;
    }
    this.focusedSlot = this.nearestFilled(slot);
    this.render();
  }

  /** The closest pane holding something, so focus never lands on a hole. */
  private nearestFilled(from: number): number {
    const count = PANE_COUNT[this.layout];
    for (let step = 1; step < count; step += 1) {
      for (const at of [from - step, from + step]) {
        if (at >= 0 && at < count && this.slots[at]) return at;
      }
    }
    return Math.min(from, count - 1);
  }

  /** ⤢ — full viewport for one pane, with the layout remembered. */
  private toggleMaximise(slot: number): void {
    this.maximised = this.maximised === null ? slot : null;
    if (this.maximised !== null) this.focusedSlot = slot;
    this.render();
  }

  private focusSlot(slot: number): void {
    if (slot === this.focusedSlot) return;
    this.focusedSlot = slot;
    // The render moves keyboard focus into the newly focused pane; see
    // focusActivePane, which is what keeps that from happening on every paint.
    this.render();
  }

  /**
   * ⌘⌥ arrows. Grid moves spatially in all four directions; a two-pane layout
   * only answers the axis it actually splits (design notes 249, 257, 263).
   */
  private moveFocus(dir: 'left' | 'right' | 'up' | 'down'): void {
    if (!this.isSplit()) return;
    const horizontal = dir === 'left' || dir === 'right';
    if (this.layout === 'grid') {
      const col = this.focusedSlot % 2;
      const row = Math.floor(this.focusedSlot / 2);
      const next = horizontal
        ? row * 2 + (col === 0 ? 1 : 0)
        : (row === 0 ? 1 : 0) * 2 + col;
      this.focusSlot(next);
      return;
    }
    const along = this.layout === 'columns' ? horizontal : !horizontal;
    if (!along) return;
    this.focusSlot(this.focusedSlot === 0 ? 1 : 0);
  }

  private resetPaneSizes(): void {
    this.settings = {
      ...this.settings,
      paneSplits: { columns: 0.5, rows: 0.5, gridCol: 0.5, gridRow: 0.5 },
    };
    this.persistLayout();
    this.render();
  }

  private setSplit(axis: SplitAxis, fraction: number): void {
    const key =
      this.layout === 'grid'
        ? axis === 'col'
          ? 'gridCol'
          : 'gridRow'
        : this.layout === 'columns'
          ? 'columns'
          : 'rows';
    if (this.settings.paneSplits[key] === fraction) return;
    this.settings = {
      ...this.settings,
      paneSplits: { ...this.settings.paneSplits, [key]: fraction },
    };
    // Restate the flex weights in place. A drag fires this per pointer move,
    // and rebuilding the grid at that rate would re-parent every terminal
    // sixty times a second for a change two numbers describe.
    this.grid?.resize(axis, fraction);
    this.refitPanes();
    this.persistLayout();
  }

  /**
   * Persists layout and gutter positions.
   *
   * Not awaited and deliberately quiet: the layout on screen is already
   * authoritative, and a failed write costs a preference next launch rather
   * than anything the user is doing now. Dragging a gutter fires this on every
   * frame, so the write is coalesced.
   */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  private persistLayout(): void {
    // Keep the cached settings in step with the window, not just the file.
    // The settings dialog is seeded from this object and writes the whole of
    // it back, so leaving it stale here means saving an unrelated preference
    // would quietly revert the layout on the next launch.
    this.settings = { ...this.settings, paneLayout: this.layout };
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void api
        .setSettings({
          paneLayout: this.layout,
          paneSplits: this.settings.paneSplits,
        })
        .catch(() => undefined);
    }, 200);
  }

  private openLayoutMenu(anchor: HTMLElement): void {
    const split = this.isSplit();
    const canSplit = this.splitTarget('right') !== null;
    const tooMany = !canSplit
      ? 'Four panes is the ceiling — past that a terminal is too small to read. File → New Window takes a fifth session.'
      : undefined;
    openLayoutPicker({
      anchor,
      current: this.layout,
      onPick: (next) => this.setLayout(next),
      actions: [
        {
          label: 'Split focused pane right',
          accel: '⌘⌥D',
          run: canSplit ? () => this.splitFocused('right') : undefined,
          unavailable: tooMany,
        },
        {
          label: 'Split focused pane down',
          accel: '⌘⌥⇧D',
          run: canSplit ? () => this.splitFocused('down') : undefined,
        },
        {
          label: 'Close focused pane',
          accel: '⌘⌥W',
          run: split ? () => this.closePane(this.focusedSlot) : undefined,
        },
        {
          label: 'Reset pane sizes',
          accel: '⌘⌥0',
          run: split ? () => this.resetPaneSizes() : undefined,
        },
        // Two views onto one PTY is design G8, which is not built: listed
        // without a handler so the feature's shape stays legible.
        ...(split
          ? [{ label: 'Mirror focused pane', accel: '⌘⌥M' }]
          : []),
      ],
    });
  }

  /** Raises the OS window owning a session we cannot render. */
  private async revealExternal(s: SessionSnapshot): Promise<void> {
    if (s.pid === null) return;
    const result = await api.focusExternal(s.pid);
    // A reason can arrive on success too -- the window was raised but the
    // exact tab was not selected -- and that is worth saying.
    if (!result.reason) {
      this.setNotice(null);
      this.render();
      return;
    }
    this.setNotice(
      result.reason,
      result.needsPermission
        ? {
            label: 'Open Automation settings',
            run: () => void api.openAutomationSettings(),
          }
        : null,
    );
    this.render();
  }

  private setNotice(
    message: string | null,
    fix: { label: string; run: () => void } | null = null,
  ): void {
    this.notice = message;
    this.noticeFix = fix;
  }

  /**
   * Picks a session, from a tab, a sidebar row or the palette.
   *
   * With a split active this is where "which pane?" gets answered: a session
   * already on screen means focus its pane, and one that is not gets loaded
   * into the focused pane (design notes 246 and 278). Nothing here duplicates
   * a session into two panes.
   */
  private select(id: string): void {
    const session = this.sessions.get(id);
    // A monitored session has no terminal here, so selecting it means going
    // to where it actually lives — unless its conversation view is up, which
    // is exactly the part of it that can live here.
    if (session?.origin === 'monitored' && !this.showsChat(id)) {
      void this.revealExternal(session);
    }

    const at = this.slots.indexOf(id);
    if (at >= 0) {
      // Focusing a pane hidden behind a maximised one has to un-maximise, or
      // the click would appear to do nothing.
      if (this.maximised !== null && this.maximised !== at) this.maximised = null;
      this.focusSlot(at);
      return;
    }
    this.setNotice(null);
    this.activeId = id;
    this.render();
  }

  /** Closing a tab detaches the view; it never destroys work. */
  /**
   * Ends a session and removes its row.
   *
   * Confirms first only when there is something to lose: a session still
   * running is killed outright with no undo, while one that has already exited
   * closes immediately. A monitored session is another terminal's process, so
   * closing it only stops watching and never prompts.
   */
  private async closeTab(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;

    const stillRunning = session.origin === 'owned' && session.exitCode === null;
    if (stillRunning) {
      const ok = await openConfirmDialog({
        title: `Close ${session.label}?`,
        body:
          `The ${session.agent} process is still running in ${shortCwd(session.cwd)}. ` +
          'Closing ends it now; anything mid-turn is lost.',
        warning:
          'The worktree and transcript are untouched, but background processes ' +
          'the agent detached from its terminal keep running.',
        confirmLabel: 'Close session',
      });
      if (!ok) return;
    }

    const gone = await api.removeSession(id);
    if (!gone) {
      // The process outlived SIGKILL. Keep the row: dropping it would leave a
      // live process with nothing in the UI to reclaim it.
      this.setNotice(
        `${session.label} will not exit — its process is still running.`,
      );
      this.renderStatus();
      return;
    }

    this.panes.get(id)?.dispose();
    this.panes.delete(id);
    this.chatPanes.get(id)?.dispose();
    this.chatPanes.delete(id);
    this.sessions.delete(id);
    // Ending a session vacates whatever pane held it. Backfilling only makes
    // sense in a single-pane window: with a split, an empty pane is a drop
    // target and choosing a replacement for the user would be a guess.
    const at = this.slots.indexOf(id);
    if (at >= 0) {
      this.slots[at] = this.isSplit()
        ? null
        : ([...this.sessions.keys()][0] ?? null);
      if (this.maximised === at) this.maximised = null;
      if (this.isSplit() && !this.slots[this.focusedSlot]) {
        this.focusedSlot = this.nearestFilled(this.focusedSlot);
      }
      // Ending the last session on screen leaves a split with nothing to
      // split, so the window drops back to Single and shows the empty state
      // rather than a grid of holes (design note 283).
      if (this.isSplit() && this.inView().length === 0) {
        this.layout = 'single';
        this.slots = [null];
        this.focusedSlot = 0;
        this.persistLayout();
      }
    }
    this.render();
  }

  /**
   * Scrollback of the active pane. The WebGL renderer draws to canvas, so this
   * is the only way to read terminal contents programmatically -- used by
   * scripts/drive.js for headless verification.
   */
  debugActiveSnapshot(): string {
    if (!this.activeId) return '';
    return this.panes.get(this.activeId)?.snapshot() ?? '';
  }

  // ---------------------------------------------------------------- render

  /**
   * Pushes settings into the DOM. Type sizes travel as CSS custom properties
   * so a change is one style recalculation rather than a re-render, and the
   * terminals are told separately because xterm measures its own cell grid.
   */
  private applySettings(next: Settings): void {
    this.settings = next;
    const root = this.el.root;

    for (const [key, cssVar] of FONT_VARS) {
      root.style.setProperty(cssVar, `${next[key] as number}px`);
    }
    root.style.setProperty('--sidebar-w', `${next.sidebarWidth}px`);

    root.classList.toggle('tabs-top', next.tabPlacement !== 'side');
    root.classList.toggle('tabs-side', next.tabPlacement !== 'top');
    root.classList.toggle('no-chips', !next.showChips);
    root.classList.toggle('compact-rows', next.compactRows);
    // `system` leaves the attribute off so the media query decides (E6).
    if (next.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', next.theme);
    root.setAttribute('data-accent', next.accent);

    for (const pane of this.panes.values()) pane.applySettings(next);
    this.render();
  }

  /**
   * Silences one session's notifications until its process ends (E5). The
   * status dot is deliberately untouched: muting is about being interrupted,
   * not about pretending the agent is not waiting.
   */
  private async setMuted(s: SessionSnapshot, muted: boolean): Promise<void> {
    await api.muteSession(s.id, muted);
  }

  private async promptSettings(): Promise<void> {
    const before = this.settings;
    const chosen = await openSettingsDialog(
      before,
      (preview) => this.applySettings(preview),
      this.capabilities,
      {
        list: () =>
          [...this.sessions.values()]
            .filter((row) => row.muted)
            .map((row) => ({ id: row.id, label: row.label })),
        unmute: (id) => {
          const session = this.sessions.get(id);
          if (session) void this.setMuted(session, false);
        },
      },
    );
    if (!chosen) return;
    try {
      this.applySettings(await api.setSettings(chosen));
    } catch {
      this.setNotice('Could not save settings.');
      this.renderStatus();
    }
  }

  /**
   * Drag-to-resize for the session list.
   *
   * Pointer capture keeps the drag alive when the cursor crosses the terminal,
   * which would otherwise swallow the events. The width is committed once on
   * release rather than on every move, so a drag is one settings write.
   */
  private installSplitter(): void {
    const bar = this.el.splitter;
    const MIN = 180;
    const MAX = 560;

    const widthFrom = (clientX: number) =>
      Math.min(MAX, Math.max(MIN, Math.round(clientX - this.el.sidebar.getBoundingClientRect().left)));

    bar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('dragging');

      const move = (ev: PointerEvent) => {
        this.el.root.style.setProperty('--sidebar-w', `${widthFrom(ev.clientX)}px`);
        if (this.activeId) this.panes.get(this.activeId)?.refit();
      };
      const up = (ev: PointerEvent) => {
        bar.releasePointerCapture(ev.pointerId);
        bar.classList.remove('dragging');
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        const width = widthFrom(ev.clientX);
        this.settings = { ...this.settings, sidebarWidth: width };
        void api.setSettings({ sidebarWidth: width }).catch(() => undefined);
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
    });

    // Keyboard resizing, so the splitter is not mouse-only.
    bar.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
      if (!step) return;
      e.preventDefault();
      const width = Math.min(MAX, Math.max(MIN, this.settings.sidebarWidth + step));
      this.el.root.style.setProperty('--sidebar-w', `${width}px`);
      this.settings = { ...this.settings, sidebarWidth: width };
      if (this.activeId) this.panes.get(this.activeId)?.refit();
      void api.setSettings({ sidebarWidth: width }).catch(() => undefined);
    });
  }

  private render(): void {
    this.renderTitlebar();
    this.renderTabs();
    this.renderSidebar();
    this.renderPane();
    this.renderStatus();
    this.syncMenuState();
  }

  /**
   * Tells the menu what it can currently do.
   *
   * Sent from here because the answer is the renderer's to give: it owns the
   * focused session, the list order, and whether a split is up -- and while
   * one is, the low digits address panes rather than sessions, so the reach of
   * ⌘N is not simply the session count. Only a change is sent; render()
   * runs on every status event and the menu must not be touched that often.
   */
  private syncMenuState(): void {
    const active = this.activeId ? this.sessions.get(this.activeId) : undefined;
    const panes = this.isSplit() ? PANE_COUNT[this.layout] : 0;
    const state: MenuState = {
      modalOpen: Boolean(document.querySelector('.overlay:not(.palette-overlay)')),
      count: this.sessions.size,
      hasActive: Boolean(active),
      activeRunning: Boolean(active && active.pid !== null),
      gotoLimit: Math.max(this.sessions.size, panes),
    };
    const key = `${state.modalOpen}|${state.count}|${state.hasActive}|${state.activeRunning}|${state.gotoLimit}`;
    if (key === this.lastMenuState) return;
    this.lastMenuState = key;
    menu.setState(state);
  }

  private renderTabs(): void {
    const strip = this.el.tabstrip;
    strip.replaceChildren();
    // The sidebar is the primary list; the strip only exists when asked for.
    if (this.settings.tabPlacement === 'side') return;
    for (const s of this.sessions.values()) {
      const selected = s.id === this.activeId;
      const tab = div('tab' + (selected ? ' active' : ''));
      tab.classList.add(`agent-${s.agent}`);
      tab.title = `${s.label} — ${agentName(s.agent)}`;
      tab.setAttribute('aria-selected', String(selected));
      const stack = div('tab-stack');
      const head = div('tab-head');
      // Which pane this session occupies, and its ⌘-digit (design note 245).
      const pane = this.slots.indexOf(s.id);
      if (pane >= 0 && this.isSplit()) {
        head.append(text('span', String(pane + 1), 'tab-pane'));
      }
      head.append(text('span', s.label, 'tab-label'));
      const badges = this.chipsFor(s);
      if (badges) head.append(badges);
      stack.append(head);
      const meta = metaLine(s);
      if (meta) stack.append(meta);
      // One badge, both facts -- the mark says which agent, the tint says what
      // it needs. The separate status dot beside it was saying half of that
      // twice.
      tab.append(agentBadge(s.agent, s.status), stack);
      const close = iconButton('×', `Close ${s.label}`, (e) => {
        e.stopPropagation();
        void this.closeTab(s.id);
      });
      close.classList.add('close');
      tab.append(close);
      tab.tabIndex = 0;
      makeSessionDraggable(tab, s);
      tab.onclick = () => this.select(s.id);
      tab.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.select(s.id);
        }
      };
      strip.append(tab);
    }
    const add = iconButton('＋', 'New session', () => void this.promptNewSession());
    add.classList.add('tab-new');
    add.title = 'New session…  (⌘N)';
    strip.append(add);
  }

  /**
   * Turns the sidebar header into a filter — wireframe B10.
   *
   * Matching runs over the session name and its folder path. The wireframe
   * also names the branch, which no snapshot carries yet; for a worktree the
   * path holds the branch-derived folder name, so that case is covered in
   * practice while a plain checkout is not.
   */
  private installFilter(): void {
    this.el.sidebarFind.onclick = () => this.setFiltering(true);
    this.el.sidebarClear.onclick = () => this.setFiltering(false);
    this.el.sidebarFilter.oninput = () => {
      this.filter = this.el.sidebarFilter.value.trim();
      this.renderSidebar();
    };
    this.el.sidebarFilter.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.setFiltering(false);
        return;
      }
      if (e.key !== 'Enter') return;
      // Enter on a result focuses that tab, so the filter is a way to reach a
      // session rather than only a way to look at one.
      e.preventDefault();
      const first = this.visibleSessions()[0];
      if (first) {
        this.select(first.id);
        this.panes.get(first.id)?.focus();
      }
    };
  }

  private setFiltering(on: boolean): void {
    this.filter = '';
    this.el.sidebarFilter.value = '';
    this.el.sidebarHead.classList.toggle('searching', on);
    this.el.sidebarSearch.hidden = !on;
    if (on) this.el.sidebarFilter.focus();
    this.renderSidebar();
  }

  /** Sessions passing the current filter, in the order they were created. */
  private visibleSessions(): SessionSnapshot[] {
    const all = [...this.sessions.values()];
    const needle = this.filter.toLowerCase();
    if (!needle) return all;
    return all.filter((s) =>
      `${s.label} ${s.cwd}`.toLowerCase().includes(needle),
    );
  }

  /**
   * How the sidebar groups its rows.
   *
   * Normally by what needs you most (wireframe B3). While a split is up that
   * question is answered on screen, and the useful one becomes what is *not*
   * on screen -- so the list regroups into IN VIEW and OTHER SESSIONS, and
   * drops the grouping again as soon as one pane is left (design notes 252 and
   * 290).
   */
  private sidebarGroups(
    visible: SessionSnapshot[],
  ): Array<{ label: string; tint: string; rows: SessionSnapshot[] }> {
    if (this.isSplit()) {
      const order = this.layoutSlots();
      const inView = visible
        .filter((s) => order.includes(s.id))
        .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      return [
        { label: 'IN VIEW', tint: 'in-view', rows: inView },
        {
          label: 'OTHER SESSIONS',
          tint: 'idle',
          rows: visible.filter((s) => !order.includes(s.id)),
        },
      ];
    }
    return GROUP_ORDER.map((g) => ({
      label: g.label,
      tint: g.key,
      rows: visible.filter((s) => s.status === g.key),
    }));
  }

  private renderSidebar(): void {
    const list = this.el.sidebarList;
    list.replaceChildren();
    const visible = this.visibleSessions();
    this.el.sidebarCount.textContent = String(this.sessions.size);

    if (this.sessions.size === 0) {
      const empty = div('sb-empty');
      empty.textContent =
        'Sessions you start appear here, grouped by what they need from you.';
      list.append(empty);
      return;
    }

    if (visible.length === 0) {
      const none = div('sb-empty');
      none.append(
        text('span', `No sessions match “${this.filter}”. `),
        (() => {
          const clear = text('button', 'Clear filter', 'linkish');
          (clear as HTMLButtonElement).type = 'button';
          clear.onclick = () => this.setFiltering(false);
          return clear;
        })(),
      );
      list.append(none);
      return;
    }

    for (const group of this.sidebarGroups(visible)) {
      const rows = group.rows;
      // A group with nothing in it collapses out rather than showing an
      // empty heading, which is what B10 asks for while filtering.
      if (rows.length === 0) continue;
      const groupHead = div('sb-group');
      groupHead.append(
        text('span', group.label, 'sb-group-label'),
        text('span', String(rows.length), `sb-count ${group.tint}`),
      );
      list.append(groupHead);
      for (const s of rows) {
        const selected = s.id === this.activeId;
        const row = div('sb-row' + (selected ? ' active' : ''));
        row.classList.add(`agent-${s.agent}`);

        const top = div('sb-top');
        top.append(agentBadge(s.agent, s.status));
        // While the name is being edited, the activity line below says how
        // far the new name will reach -- the one moment that answer matters.
        const scope = this.renaming === s.id ? this.renameScope(s) : null;
        if (this.renaming === s.id) {
          const field = this.renameField(s);
          if (scope) field.setAttribute('aria-describedby', `rename-scope-${s.id}`);
          top.append(field);
        } else {
          top.append(text('span', s.label, 'name'));
        }
        const badges = this.chipsFor(s);
        if (badges) top.append(badges);
        top.append(
          text('span', repoMark(s.cwd), 'sb-mark'),
          text('span', sessionAge(s.startedAt), 'sb-age'),
        );
        if (s.origin === 'monitored') {
          top.append(text('span', '↗', 'external-mark'));
          row.classList.add('is-external');
        }
        const pane = this.slots.indexOf(s.id);
        if (pane >= 0 && this.isSplit()) {
          row.classList.add('in-view');
          top.append(text('span', String(pane + 1), 'sb-pane'));
        }

        // The only close affordance used to live on the top tab strip, which
        // is now hidden by default. A finished session needs it most, so it
        // stays visible there rather than waiting for a hover.
        const verb = s.origin === 'monitored' ? 'Stop watching' : 'Close';
        const close = iconButton('×', `${verb} ${s.label}`, (e) => {
          e.stopPropagation();
          void this.closeTab(s.id);
        });
        close.classList.add('sb-close');
        close.title = `${verb} ${s.label}`;
        if (s.status === 'done' || s.exitCode !== null) {
          close.classList.add('always');
        }
        top.append(close);

        // One line, as the wireframe draws it: dot, name, chips, repo, age.
        // Activity is in the row's tooltip and in the pane header, and the
        // context figure is in the status bar, so neither is lost -- what a
        // second line cost was half the fleet fitting on screen.
        row.append(top);

        // The exception, and only while it is true: renaming is the one
        // moment the scope of the new name has to be visible before you
        // commit to it.
        if (scope) {
          const bottom = div('sb-bottom');
          const hint = text('span', scope, 'activity rename-scope');
          hint.id = `rename-scope-${s.id}`;
          bottom.append(hint);
          row.append(bottom);
        }
        row.title =
          `${agentName(s.agent)}\n${s.cwd}\n${s.activity ?? ''}`.trim();
        row.tabIndex = 0;
        // Announced as a selectable option so the highlight is not the only
        // signal of which session is showing.
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(selected));
        row.dataset.session = s.id;
        makeSessionDraggable(row, s);
        row.onclick = () => this.select(s.id);
        row.ondblclick = () => this.beginRename(s.id);
        row.onkeydown = (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            this.select(s.id);
          }
        };
        row.oncontextmenu = (e) => {
          e.preventDefault();
          this.openRowMenu(s, e.clientX, e.clientY);
        };
        list.append(row);
      }
    }
  }

  /** Model and effort badges, or null when there is nothing to show. */
  /**
   * The context menu for one sidebar row — wireframe C5.
   *
   * Items belonging to phases that have not landed are listed without a
   * handler, which renders them disabled. That is the same choice the
   * application menu makes: the shape of the app is legible from the first
   * run rather than the menu quietly growing over several releases.
   */
  private openRowMenu(s: SessionSnapshot, x: number, y: number): void {
    const running = s.origin === 'owned' && s.exitCode === null;
    const steer = this.capabilities?.[s.agent]['turn-steer'];
    const interrupt = this.capabilities?.[s.agent]['turn-interrupt'];
    const toolGate = this.capabilities?.[s.agent]['tool-gate'];
    openSessionMenu(x, y, s.label, [
      { label: 'Focus tab', accel: '⏎', onSelect: () => this.select(s.id) },
      { label: 'Rename…', onSelect: () => this.beginRename(s.id) },
      {
        label: 'Open in focused pane',
        onSelect: () => this.dropIntoPane(this.focusedSlot, s.id),
      },
      {
        label: 'Open in new pane',
        // Only offered while there is room for one; past four panes a terminal
        // stops being readable (design note 276).
        onSelect:
          this.splitTarget('right') !== null
            ? () => this.openInNewPane(s.id)
            : undefined,
      },
      // Two views onto one PTY is design G8, which is not built.
      { label: 'Mirror in new pane', accel: '⌘⌥M' },
      { label: 'Open in new window' },
      SEPARATOR,
      {
        label: s.toolsPaused ? 'Resume tool use' : 'Pause tool use',
        accel: toolGate && !toolGate.ok ? toolGate.reason : undefined,
        onSelect:
          running && toolGate?.ok
            ? () => void this.setToolGate(s, !s.toolsPaused)
            : undefined,
      },
      {
        // Muting is ours, not the agent's, so every session offers it.
        label: s.muted ? 'Unmute notifications' : 'Mute until it finishes',
        onSelect: () => void this.setMuted(s, !s.muted),
      },
      {
        // Electron only renders notification action buttons on macOS, so
        // snooze lives here where every platform can reach it.
        label: `Snooze notifications ${this.settings.notifySnoozeMinutes}m`,
        onSelect: s.muted ? undefined : () => void api.snoozeSession(s.id),
      },
      {
        // The agent's own id when we know it, ours otherwise -- either way
        // this identifies the session, whatever is running in it.
        label: 'Copy session id',
        onSelect: () => void api.copyText(s.externalId ?? s.id),
      },
      {
        label: 'Copy working directory',
        onSelect: () => void api.copyText(s.cwd),
      },
      SEPARATOR,
      {
        label: 'Review changes…',
        accel: '⌘⇧D',
        onSelect: () => void openDiffReviewDialog(s.cwd),
      },
      { label: 'Commit & push…' },
      { label: 'Open pull request…' },
      { label: 'Worktree manager…', onSelect: () => void this.promptWorktrees(s.cwd) },
      { label: 'Remove worktree…', destructive: true },
      SEPARATOR,
      {
        label: 'Steer turn…',
        accel: steer && !steer.ok ? steer.reason : undefined,
        onSelect:
          running && steer?.ok ? () => void this.promptSteer(s) : undefined,
      },
      {
        label: 'Interrupt turn',
        accel: interrupt && !interrupt.ok ? interrupt.reason : undefined,
        onSelect:
          running && s.status === 'working' && interrupt?.ok
            ? () => void this.interruptTurn(s)
            : undefined,
      },
      SEPARATOR,
      {
        // Ends the process but keeps the row, which is wireframe C7.
        label: 'Stop session',
        onSelect: running ? () => void api.killSession(s.id) : undefined,
      },
      {
        label: 'Delete session',
        destructive: true,
        onSelect: () => void this.closeTab(s.id),
      },
    ]);
  }

  private async promptSteer(s: SessionSnapshot): Promise<void> {
    const guidance = await openTextPrompt({
      title: `Steer ${s.label}`,
      description:
        'Send guidance through the agent’s structured control channel. No terminal input is generated.',
      placeholder: 'What should the agent account for next?',
      submitLabel: 'Send guidance',
    });
    if (!guidance) return;
    await api.steerSession(s.id, guidance);
  }

  private async interruptTurn(s: SessionSnapshot): Promise<void> {
    await api.interruptTurn(s.id);
  }

  private async setToolGate(
    s: SessionSnapshot,
    paused: boolean,
  ): Promise<void> {
    await api.setToolGate(s.id, paused);
  }

  private filter = '';
  private renaming: string | null = null;

  /**
   * Sessions in the order the sidebar draws them, which is what ⌘1–9 counts.
   *
   * Counting the visible order rather than creation order means the number
   * you press matches the row you can see. The trade is that the mapping
   * moves when a session changes group, which is the same bargain any
   * status-grouped list makes.
   */
  private orderedSessions(): SessionSnapshot[] {
    const visible = this.visibleSessions();
    const grouped = GROUP_ORDER.flatMap((g) =>
      visible.filter((s) => s.status === g.key),
    );
    // Anything with a status the sidebar does not group still has to be
    // reachable, or a keyboard user could not get to it at all.
    const rest = visible.filter((s) => !grouped.includes(s));
    return [...grouped, ...rest];
  }

  /** Moves the selection by one, wrapping. Nothing here is agent-specific. */
  private stepSession(delta: number): void {
    const list = this.orderedSessions();
    if (list.length === 0) return;
    const at = list.findIndex((s) => s.id === this.activeId);
    const next = at === -1 ? 0 : (at + delta + list.length) % list.length;
    this.focusSession(list[next].id);
  }

  /**
   * ⌘1…9.
   *
   * While a split is up the low digits address panes instead of sessions, as
   * design note 264 asks -- the pane number is printed on both the pane and
   * its tab, so it is the more direct reading of ⌘2 when two terminals are
   * side by side. Digits past the pane count still reach sessions.
   */
  private gotoSession(position: number): void {
    if (this.isSplit() && position <= PANE_COUNT[this.layout]) {
      if (this.maximised !== null) this.maximised = null;
      this.focusSlot(position - 1);
      return;
    }
    const target = this.orderedSessions()[position - 1];
    if (target) this.focusSession(target.id);
  }

  private focusSession(id: string): void {
    this.select(id);
    this.panes.get(id)?.focus();
  }

  /**
   * Opens the command palette — wireframe C13.
   *
   * Sessions and actions are flattened to plain rows before they get here, so
   * the palette needs no knowledge of which agent a session runs. Actions
   * whose feature has not landed are listed without a handler and render
   * disabled, matching the application menu and the C5 row menu.
   */
  /**
   * Copy what is selected wherever the focus is (macOS Edit menu).
   *
   * A terminal is asked first, because xterm keeps its selection in its own
   * model where the platform's copy cannot see it. Everything else -- the
   * transcript, the composer, a dialog field -- goes to the platform, which
   * already knows how a textarea and a DOM range each behave.
   */
  private copyFromFocus(): void {
    const pane = this.focusedTerminal();
    if (pane?.copySelection()) return;
    void api.copySelection();
  }

  /** Paste into whatever has focus, image-aware inside a terminal. */
  private pasteToFocus(): void {
    const pane = this.focusedTerminal();
    if (pane) {
      pane.paste();
      return;
    }
    void api.pasteSelection();
  }

  /** The terminal the caret is actually in, or null for every other surface. */
  private focusedTerminal(): TerminalPane | null {
    const host = document.activeElement?.closest('.term-host');
    if (!host) return null;
    for (const pane of this.panes.values()) {
      if (pane.element === host) return pane;
    }
    return null;
  }

  private openPalette(): void {
    const active = this.activeId ? this.sessions.get(this.activeId) : undefined;
    const activeSteer = active
      ? this.capabilities?.[active.agent]['turn-steer']
      : undefined;
    const activeInterrupt = active
      ? this.capabilities?.[active.agent]['turn-interrupt']
      : undefined;
    const activeToolGate = active
      ? this.capabilities?.[active.agent]['tool-gate']
      : undefined;
    const actions: PaletteAction[] = [
      {
        glyph: '＋',
        label: 'New session…',
        accel: '⌘N',
        run: () => void this.promptNewSession(),
      },
      {
        glyph: '⇱',
        label: 'Import running sessions…',
        run: () => void this.promptAdopt(),
      },
      { glyph: '⑂', label: 'New session from PR #…' },
      {
        glyph: '⌥',
        label: 'Worktree manager…',
        run: () => void this.promptWorktrees(),
      },
      {
        glyph: '±',
        label: 'Review changes in focused session…',
        accel: '⌘⇧D',
        run: active ? () => void openDiffReviewDialog(active.cwd) : undefined,
      },
      {
        glyph: '↪',
        label: 'Steer focused turn…',
        run:
          active && active.origin === 'owned' && active.exitCode === null && activeSteer?.ok
            ? () => void this.promptSteer(active)
            : undefined,
      },
      {
        glyph: active?.toolsPaused ? '▶' : '‖',
        label: active?.toolsPaused
          ? 'Resume tool use in focused session'
          : 'Pause tool use in focused session',
        run:
          active &&
          active.origin === 'owned' &&
          active.exitCode === null &&
          activeToolGate?.ok
            ? () => void this.setToolGate(active, !active.toolsPaused)
            : undefined,
      },
      {
        glyph: '■',
        label: 'Interrupt focused turn',
        run:
          active &&
          active.origin === 'owned' &&
          active.exitCode === null &&
          active.status === 'working' &&
          activeInterrupt?.ok
            ? () => void this.interruptTurn(active)
            : undefined,
      },
      {
        glyph: '⚙',
        label: 'Settings…',
        accel: '⌘,',
        run: () => void this.promptSettings(),
      },
      {
        glyph: '⏻',
        label: 'Shut down agent daemon…',
        run: () => void this.confirmStopDaemon(),
      },
    ];

    openCommandPalette({
      sessions: this.orderedSessions().map((s) => ({
        id: s.id,
        label: s.label,
        detail: `${basename(s.cwd) || s.cwd} · ${s.activity ?? s.status}`,
        glyph: STATUS_GLYPH[s.status] ?? '◌',
        haystack: s.cwd,
      })),
      actions,
      onPickSession: (id) => this.focusSession(id),
      onCreateNamed: (label) => void this.promptNewSession(label),
      onClose: () => this.activeId && this.panes.get(this.activeId)?.focus(),
    });
  }

  /**
   * The deliberate end of everything. Closing the window ends nothing —
   * sessions live in the daemon — so this is the one gesture that does, and
   * it says exactly what it will take down before doing it.
   */
  private async confirmStopDaemon(): Promise<void> {
    const running = [...this.sessions.values()].filter(
      (s) => s.origin === 'owned' && s.exitCode === null,
    ).length;
    const ok = await openConfirmDialog({
      title: 'Shut down the agent daemon?',
      body:
        running > 0
          ? `Every session ends with it — ${running} still running. Claude sessions started with --bg keep running under Claude's own daemon.`
          : 'Every session it holds ends with it.',
      warning:
        'Closing the window never does this; only this action does. While Sertum stays open, a fresh empty daemon starts in its place.',
      confirmLabel: 'Shut down daemon',
    });
    if (!ok) return;
    await api.stopDaemon();
  }

  /**
   * Opens the worktree inventory — wireframe C9.
   *
   * Which repository it shows follows the session you asked from, falling
   * back to the active one, so the manager is always about the code in front
   * of you rather than some remembered default. With nothing open there is no
   * session to follow, so it resumes wherever it was last pointed and the
   * dialog's own folder picker takes it anywhere else -- the manager is about
   * a repository, and a repository outlasts every session in it.
   */
  private async promptWorktrees(cwd?: string): Promise<void> {
    const from =
      cwd ??
      (this.activeId ? this.sessions.get(this.activeId)?.cwd : undefined) ??
      this.lastWorktreeRoot ??
      this.lastCwd ??
      (await api.defaultCwd());
    await openWorktreeDialog({
      cwd: from,
      sessionLabel: (id) => this.sessions.get(id)?.label,
      onOpenSession: (id) => this.focusSession(id),
      onRootChanged: (root) => {
        this.lastWorktreeRoot = root;
      },
      // C9 does not grow its own creation path: it hands off to C1 with the
      // isolation already chosen, so there is one way to make a worktree.
      onNewWorktree: (root) =>
        void this.promptNewSession(undefined, { cwd: root, isolation: 'new' }),
    });
  }

  /**
   * How far a rename reaches, for the hint shown while editing -- or null
   * when the agent mirrors the name too and there is nothing to warn about.
   * The reason is the adapter's own; nothing here knows which agents decline.
   */
  private renameScope(s: SessionSnapshot): string | null {
    const answer = this.capabilities?.[s.agent]['rename-remote'];
    if (!answer || answer.ok) return null;
    return `Renames here only — ${answer.reason}`;
  }

  /** Starts the inline rename from wireframe C3. */
  private beginRename(id: string): void {
    if (!this.sessions.has(id)) return;
    this.renaming = id;
    this.renderSidebar();
  }

  private async commitRename(id: string, value: string): Promise<void> {
    this.renaming = null;
    const session = this.sessions.get(id);
    // An unchanged name needs no round trip; the re-render restores the row.
    if (!session || value === session.label) {
      this.renderSidebar();
      return;
    }
    const stored = await api.renameSession(id, value);
    if (stored) session.label = stored;
    this.renderSidebar();
    this.renderTabs();
    this.renderStatus();
  }

  private cancelRename(): void {
    this.renaming = null;
    this.renderSidebar();
  }


  /**
   * The inline name field — wireframe C3.
   *
   * Rendered as part of the row rather than layered over it, so a session
   * update repainting the sidebar mid-edit cannot destroy what is being
   * typed.
   */
  private renameField(s: SessionSnapshot): HTMLInputElement {
    const input = document.createElement('input');
    input.className = 'sb-rename';
    input.value = s.label;
    input.spellcheck = false;
    input.setAttribute('aria-label', `Rename ${s.label}`);
    // The row itself selects on click; editing must not re-trigger that.
    input.onclick = (e) => e.stopPropagation();
    input.ondblclick = (e) => e.stopPropagation();
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.commitRename(s.id, input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelRename();
      }
    };
    // Clicking away commits, which is what a field embedded in a list should
    // do -- losing the edit would be the surprising outcome.
    input.onblur = () => {
      if (this.renaming === s.id) void this.commitRename(s.id, input.value);
    };
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    return input;
  }

  private chipsFor(s: SessionSnapshot): HTMLElement | null {
    if (!this.settings.showChips) return null;
    if (!s.model && !s.effort) return null;
    const wrap = div('chips');
    if (s.model) wrap.append(modelChip(s.model));
    if (s.effort) wrap.append(effortChip(s.effort));
    return wrap;
  }

  /**
   * Draws the pane area — design section 07.
   *
   * xterm instances live in `panes`, keyed by session and never rebuilt here,
   * so moving one between panes -- or between layouts -- costs a DOM move and
   * a refit, never its scrollback or its PTY.
   *
   * That move is not free, though, and this is what decides how often it
   * happens. A render is triggered by any session update, including the meta
   * poll ticking another agent's context every few seconds, and re-parenting a
   * terminal blurs whatever inside it holds keyboard focus. So the grid is
   * rebuilt only when its shape changes; the ordinary repaint hands the same
   * cells a new header and leaves every terminal exactly where it is.
   */
  private renderPane(): void {
    const host = this.el.paneHost;
    const drawn = this.visiblePaneSlots();
    const onScreen = new Set(drawn.filter((id): id is string => id !== null));

    // A pane not on screen keeps its buffer but must leave the DOM, or its
    // ResizeObserver keeps firing against a zero-sized element.
    for (const [id, pane] of this.panes) {
      if (!onScreen.has(id) || this.showsChat(id)) pane.unmount();
    }
    // Chat views also stop polling when they leave the screen.
    for (const [id, pane] of this.chatPanes) {
      if (!onScreen.has(id) || !this.showsChat(id)) pane.unmount();
    }

    if (onScreen.size === 0 && !this.isSplit()) {
      this.el.paneHead.style.display = 'none';
      host.replaceChildren(this.emptyState());
      // The grid is out of the document, so the next render has to build one
      // rather than update the one it used to hold.
      this.grid = null;
      this.gridKey = '';
      return;
    }

    this.el.paneHead.style.display = '';
    this.renderPaneHead();

    const layout = this.maximised === null ? this.layout : 'single';
    const slots: SlotView[] = drawn.map((id, index) =>
      this.slotView(id, index, drawn.length),
    );
    // Everything the grid fixes at build time. The splits and the type size
    // are not in here: `update` restates both, so neither is worth a rebuild.
    const key = `${layout}:${drawn.length}`;

    this.withFocusKept(() => {
      if (this.grid && key === this.gridKey) {
        this.grid.update(
          slots,
          this.settings.paneSplits,
          this.settings.terminalFontSize,
        );
      } else {
        this.grid = buildPaneGrid({
          layout,
          slots,
          splits: this.settings.paneSplits,
          fontSize: this.settings.terminalFontSize,
          onFocus: (slot) => this.focusSlot(this.slotIndex(slot)),
          onSplit: (axis, fraction) => this.setSplit(axis, fraction),
          onDrop: (slot, id) => this.dropIntoPane(this.slotIndex(slot), id),
        });
        this.gridKey = key;
        host.replaceChildren(this.grid.element);
      }

      // xterm measures its host to work out a cell, so it can only be opened
      // once the grid is in the document. A session showing its chat view
      // must not open xterm against a detached host; its chat pane starts
      // polling instead.
      for (const id of onScreen) {
        if (this.showsChat(id)) this.chatPanes.get(id)?.attach();
        else this.panes.get(id)?.attach();
      }

      // Re-fit now, synchronously. A terminal that just changed size has to
      // tell its PTY or the agent's TUI draws against stale geometry (design
      // note 294), and deferring that to an animation frame would make it
      // conditional on the window being visible -- rAF does not run while a
      // window is occluded, which left panes wrong until something else
      // resized them. Measuring here forces the pending layout, which is all
      // the frame bought.
      this.refitPanes();
    });

    this.focusActivePane();
  }

  /**
   * Runs `work` without letting it take the caret away.
   *
   * Whenever a node leaves the document the browser blurs whatever inside it
   * had keyboard focus, and putting the node back does not hand the focus
   * back. A pane that is re-parented -- by a layout change, or by a session
   * being dragged into a different pane -- therefore leaves the person who was
   * typing in it typing into nothing, with no event to say so.
   *
   * Only a focus that `work` itself destroyed is restored, and only to an
   * element still in the document: when the pane is genuinely gone, deciding
   * where the caret belongs is `focusActivePane`'s job, and it runs after this.
   */
  private withFocusKept(work: () => void): void {
    const held = document.activeElement;
    work();
    if (
      held instanceof HTMLElement &&
      held !== document.body &&
      held !== document.activeElement &&
      held.isConnected
    ) {
      held.focus();
    }
  }

  /** Re-measures the panes on screen without touching the grid's DOM. */
  private refitPanes(): void {
    this.grid?.refresh();
    for (const id of this.onScreen()) this.panes.get(id)?.refit();
  }

  /**
   * Maps a drawn pane back to the slot it stands for.
   *
   * While a pane is maximised the grid draws a single pane at index 0, but the
   * session in it still belongs to whichever slot was promoted.
   */
  private slotIndex(drawnIndex: number): number {
    return this.maximised === null ? drawnIndex : this.maximised;
  }

  /**
   * Moves keyboard focus into the focused pane, but only when the pane it
   * should be in has actually changed.
   *
   * Focusing on every render would pull the caret out of the sidebar filter
   * and out of any open dialog, since both leave the pane grid mounted.
   */
  private focusActivePane(): void {
    const key = `${this.layout}:${this.maximised}:${this.focusedSlot}:${this.activeId}`;
    if (key === this.focusKey) return;
    this.focusKey = key;
    if (!this.activeId) return;
    if (this.showsChat(this.activeId)) {
      this.chatPanes.get(this.activeId)?.focus();
    } else {
      this.panes.get(this.activeId)?.focus();
    }
  }

  /** One pane: its chrome, and a terminal, a status row or an invitation. */
  private slotView(
    id: string | null,
    drawnIndex: number,
    drawnCount: number,
  ): SlotView {
    const slot = this.slotIndex(drawnIndex);
    const focused = slot === this.focusedSlot;
    const session = id ? this.sessions.get(id) : undefined;
    // Single-pane windows already name the session in the pane header above,
    // so per-pane chrome only earns its 28px once there is more than one.
    const chrome = drawnCount > 1;

    if (!session) {
      return {
        header: chrome ? this.paneChrome(null, slot, focused) : null,
        body: this.emptyPane(slot),
        focused,
        tone: null,
      };
    }

    // The conversation view replaces whatever the session would otherwise
    // show — a terminal, or a monitored session's status card. It is read
    // from the transcript on disk, which is why a monitored session can have
    // one when it cannot have a terminal.
    if (this.showsChat(session.id)) {
      // The terminal keeps collecting the PTY's bytes while the chat view is
      // up (xterm buffers writes before open), so switching back shows the
      // scrollback the pixels produced in the meantime. A stream session has
      // no bytes to collect and never gets one.
      if (
        session.origin !== 'monitored' &&
        session.transport !== 'stream' &&
        !this.panes.has(session.id)
      ) {
        this.panes.set(session.id, new TerminalPane(session, this.settings));
        if (this.needsReplay.has(session.id)) void api.replayPty(session.id);
      }
      let chat = this.chatPanes.get(session.id);
      if (!chat) {
        chat = new ChatPane(
          session,
          this.capabilities?.[session.agent]['turn-interrupt'] ?? {
            ok: false,
            reason: 'Agent capabilities are still loading.',
          },
        );
        this.chatPanes.set(session.id, chat);
      }
      chat.update(session);
      return {
        header: chrome ? this.paneChrome(session, slot, focused) : null,
        body: chat.element,
        focused,
        tone: STATUS_TONE[session.status],
      };
    }

    if (session.origin === 'monitored') {
      return {
        header: chrome ? this.paneChrome(session, slot, focused) : null,
        body: this.externalPane(session),
        focused,
        tone: STATUS_TONE[session.status],
      };
    }

    let pane = this.panes.get(session.id);
    if (!pane) {
      pane = new TerminalPane(session, this.settings);
      this.panes.set(session.id, pane);
      // A session the daemon kept alive gets its history back the moment a
      // terminal exists to draw it into.
      if (this.needsReplay.has(session.id)) void api.replayPty(session.id);
    }
    return {
      header: chrome ? this.paneChrome(session, slot, focused) : null,
      body: pane.element,
      focused,
      tone: STATUS_TONE[session.status],
    };
  }

  /** Agents are always chat; a shell is always its terminal. */
  private showsChat(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.agent === 'shell') return false;
    return Boolean(this.capabilities?.[session.agent]['conversation-view'].ok);
  }

  /**
   * The 28px bar on top of a pane (design G1).
   *
   * Focus has to be unambiguous when several terminals are on screen, because
   * keystrokes only ever reach one of them: hence the accent border, the FOCUS
   * chip and the pane number, which is also its ⌘-digit.
   */
  private paneChrome(
    s: SessionSnapshot | null,
    slot: number,
    focused: boolean,
  ): HTMLElement {
    const head = div('pane-chrome' + (focused ? ' focused' : ''));

    const left = div('pane-chrome-left');
    left.append(text('span', String(slot + 1), 'pane-num'));
    if (s) {
      left.append(dot(s.status), text('span', s.label, 'pane-chrome-label'));
      if (s.remoteControl) {
        left.append(text('span', 'REMOTE', 'pane-remote-chip'));
      }
      if (s.toolsPaused) {
        left.append(text('span', 'TOOLS PAUSED', 'pane-tool-chip'));
      }
    } else {
      left.append(text('span', 'Empty pane', 'pane-chrome-label empty'));
    }
    if (focused) left.append(text('span', 'FOCUS', 'pane-focus-chip'));
    head.append(left);

    const right = div('pane-chrome-actions');
    const maxed = this.maximised !== null;
    right.append(
      iconButton(
        '⤢',
        maxed ? 'Restore layout' : 'Maximise this pane',
        (e) => {
          e.stopPropagation();
          this.toggleMaximise(slot);
        },
      ),
    );
    if (s) {
      right.append(
        iconButton('⋯', `Actions for ${s.label}`, (e) => {
          e.stopPropagation();
          this.focusSlot(slot);
          this.openRowMenu(s, e.clientX, e.clientY);
        }),
      );
    }
    right.append(
      iconButton('×', 'Close this pane — the session keeps running', (e) => {
        e.stopPropagation();
        this.closePane(slot);
      }),
    );
    head.append(right);
    return head;
  }

  /**
   * An empty pane — design G5.
   *
   * Splitting never guesses which session you meant, so the pane says what it
   * is and names every way to fill it rather than looking like a failure.
   */
  private emptyPane(slot: number): HTMLElement {
    const wrap = div('pane-empty');
    wrap.append(text('div', 'Empty pane', 'pane-empty-title'));
    wrap.append(
      text(
        'div',
        'Drop a session here, click a tab or a sidebar row, or start a new one.',
        'pane-empty-body',
      ),
    );
    const row = div('row');
    row.append(
      button('New session…', 'primary', () => {
        this.focusedSlot = slot;
        void this.promptNewSession();
      }),
      button('Choose session…', '', (e) => {
        this.focusedSlot = slot;
        this.openSessionChooser(slot, e);
      }),
    );
    wrap.append(row);
    return wrap;
  }

  /**
   * A compact list of the sessions not currently on screen (design note 280).
   *
   * The row menu's popover is the right shape for this and already handles
   * placement and dismissal, so it is reused rather than reinvented.
   */
  private openSessionChooser(slot: number, e: MouseEvent): void {
    const shown = new Set(this.inView());
    const candidates = this.orderedSessions().filter((s) => !shown.has(s.id));
    openSessionMenu(
      e.clientX,
      e.clientY,
      candidates.length ? 'Load into this pane' : 'No other sessions',
      candidates.length
        ? candidates.map((s) => ({
            label: s.label,
            accel: shortCwd(s.cwd),
            onSelect: () => this.dropIntoPane(slot, s.id),
          }))
        : [{ label: 'Every session is already in view' }],
    );
  }

  /**
   * Splits, then loads the session into the pane that appeared.
   *
   * The split itself deliberately opens empty (design G5); this is the case
   * where the user already said which session they meant, so leaving them to
   * drag it into the hole they just asked for would be theatre.
   */
  private openInNewPane(id: string): void {
    this.splitFocused('right');
    const empty = this.slots.indexOf(null);
    if (empty >= 0) this.dropIntoPane(empty, id);
  }

  /** A session assigned to a pane, however it got there. */
  private dropIntoPane(slot: number, id: string): void {
    if (!this.sessions.has(id)) return;
    this.assignSlot(slot, id);
    this.focusedSlot = slot;
    this.setNotice(null);
    this.render();
  }

  /** The bar above the grid: which session is focused, and the layout. */
  private renderPaneHead(): void {
    const active = this.activeId ? this.sessions.get(this.activeId) : undefined;
    this.el.paneTitle.replaceChildren();
    if (active) {
      this.el.paneTitle.append(
        text('span', basename(active.cwd) || active.cwd, 'repo'),
        text('span', '·'),
        text('span', active.cwd, 'branch'),
      );
      if (active.remoteControl) {
        this.el.paneTitle.append(text('span', 'REMOTE', 'pane-remote-chip'));
      }
      if (active.toolsPaused) {
        this.el.paneTitle.append(
          text('span', 'TOOLS PAUSED', 'pane-tool-chip'),
        );
      }
    } else {
      this.el.paneTitle.append(text('span', 'Empty pane', 'repo'));
    }
    this.el.layoutButton.textContent = `${LAYOUT_GLYPH[this.layout]} ${layoutLabel(this.layout)}`;
    this.el.layoutButton.title = `Pane layout: ${layoutLabel(this.layout)}  (⌘⌥L)`;

    // Ends the process and keeps the row, exactly as Session > Stop Session
    // and the row menu do. Enabled only while there is a process to end, so
    // the button reports whether it can act rather than failing silently.
    const running = Boolean(active && active.pid !== null);
    this.el.paneStop.disabled = !running;
    this.el.paneStop.title = running
      ? `Stop ${active?.label ?? 'session'} — ends the process, keeps the tab`
      : 'Nothing running in this pane';
  }

  /**
   * Shown in place of a terminal for a monitored session. States plainly why
   * there is no terminal rather than looking broken.
   */
  private externalPane(s: SessionSnapshot): HTMLElement {
    const wrap = div('external');
    const h = document.createElement('h2');
    h.textContent = s.label;
    wrap.append(h);

    wrap.append(text('div', s.cwd, 'external-cwd'));
    if (s.activity) wrap.append(text('div', s.activity, 'external-summary'));

    const why = document.createElement('p');
    why.textContent =
      'This session runs in another terminal. Its pseudo-terminal belongs to that app, so it cannot be drawn here — but its status stays live, and you can jump to it.';
    wrap.append(why);

    const row = div('row');
    row.append(
      button('Reveal its window', 'primary', () => void this.revealExternal(s)),
      button('Stop tracking', 'ghost', () => void this.closeTab(s.id)),
    );
    wrap.append(row);

    if (this.notice) {
      const notice = div('external-notice');
      notice.append(text('div', this.notice));
      if (this.noticeFix) {
        notice.append(
          button(this.noticeFix.label, 'ghost small', this.noticeFix.run),
        );
      }
      wrap.append(notice);
    }
    return wrap;
  }

  private emptyState(): HTMLElement {
    const wrap = div('empty');
    const h = document.createElement('h2');
    h.textContent = 'No sessions yet';
    const p = document.createElement('p');
    p.textContent =
      'Start an agent in a real PTY. You choose the working folder, so the project\u2019s own CLAUDE.md, settings and MCP config resolve normally.';
    const row = div('row');
    row.append(
      button('New session…', 'primary', () => void this.promptNewSession()),
      button('Import running sessions…', '', () => void this.promptAdopt()),
    );
    wrap.append(h, p, row);
    return wrap;
  }

  private renderTitlebar(): void {
    const active = this.activeId ? this.sessions.get(this.activeId) : undefined;
    this.el.titlebarText.textContent = active
      ? `${active.label} — ${shortCwd(active.cwd)}`
      : 'Sertum';
  }

  renderStatus(): void {
    const active = this.activeId ? this.sessions.get(this.activeId) : undefined;
    this.el.statusLeft.replaceChildren();
    this.el.statusRight.replaceChildren();

    // Which layout, and which of its panes has the keyboard -- the two things
    // that stop being obvious the moment more than one terminal is on screen.
    if (this.isSplit()) {
      const panes = PANE_COUNT[this.layout];
      const empty = panes - this.inView().length;
      this.el.statusLeft.append(
        text(
          'span',
          `${panes} panes · ${layoutLabel(this.layout)}` +
            (this.maximised !== null ? ' · maximised' : '') +
            (empty > 0 ? ` · ${empty} empty` : ''),
          'chip layout-chip',
        ),
        text(
          'span',
          active ? `focus: ${active.label}` : 'focus: empty pane',
          'status-focus',
        ),
      );
    }

    if (active) {
      this.el.statusLeft.append(
        text('span', active.agent, 'chip'),
        text('span', active.cwd, 'mono'),
      );
      if (active.activity) {
        this.el.statusLeft.append(text('span', active.activity));
      }

      const ctx = contextInfo(active);
      if (ctx) {
        const used = active.contextTokens ?? 0;
        const limit = active.contextLimit;
        const left = limit ? Math.max(0, limit - used) : null;
        this.el.statusLeft.append(
          text(
            'span',
            left !== null
              ? `context ${compactTokens(used)} used · ${compactTokens(left)} left · ${ctx.label}`
              : `context ${compactTokens(used)} used`,
            `mono ctx-readout ${ctx.band}`,
          ),
        );
      }
      this.el.statusRight.append(
        text(
          'span',
          active.pid ? `pid ${active.pid}` : `exit ${active.exitCode}`,
          'mono',
        ),
      );
    } else {
      this.el.statusLeft.append(text('span', 'no session'));
    }

    this.el.statusRight.append(text('span', `${this.sessions.size} session(s)`));

    // Be explicit about where the dot's information comes from. A session
    // with no adapter shows process lifecycle only, and saying so beats
    // letting the user wonder why its status never changes.
    if (active && active.origin === 'owned' && !active.adapterBound) {
      this.el.statusRight.append(
        dot('idle'),
        text('span', `no status adapter for ${active.agent}`, 'mono'),
      );
      return;
    }
    if (active && active.origin === 'monitored') {
      this.el.statusRight.append(
        dot('idle'),
        text('span', 'status polled · runs elsewhere', 'mono'),
      );
      return;
    }

    // App-level plumbing health, not a session's. It is shown with nothing
    // open precisely because that is when you cannot tell from a session
    // whether the adapters came up. Named by what is listening rather than by
    // an event count, which reads as a failure when it is simply idle.
    const a = this.adapters;
    if (!a) return;

    // Only things that are genuinely broken. A CLI that is not installed used
    // to be announced here, which made a normal machine -- one that simply
    // does not have all three agents -- look permanently faulty. It is not a
    // fault, and the agent list already says so by not offering it; the
    // tooltip below still names it for anyone who goes looking.
    const down = [
      a.claude.connected ? null : 'Claude hooks',
      a.codex.connected ? null : 'Codex app server',
    ].filter(Boolean) as string[];

    // "adapters" is the vocabulary the designs use throughout (E2, C14), so
    // the status bar matches rather than inventing a second word for it.
    const label = down.length === 0 ? 'adapters ok' : `${down.join(' + ')} offline`;
    const readout = text('span', label, 'mono');
    const events = (n: number) => `${n} event${n === 1 ? '' : 's'}`;
    readout.title =
      `Claude hooks: ${a.claude.connected ? `listening on 127.0.0.1:${a.claude.port}` : 'offline'}` +
      ` · ${events(a.claude.events)}\n` +
      `Codex app server: ${a.codex.connected ? a.codex.url : 'offline'}` +
      ` · ${events(a.codex.events)}\n` +
      `Claude Code CLI: ${a.claude.binaryFound ? 'found' : 'not found — set it in Settings → Agents'}\n` +
      `Codex CLI: ${a.codex.binaryFound ? 'found' : 'not found — set it in Settings → Agents'}\n` +
      `Grok event log: following ${a.grok.watching} session${a.grok.watching === 1 ? '' : 's'}` +
      ` · ${events(a.grok.events)}\n` +
      `Grok CLI: ${a.grok.binaryFound ? 'found' : 'not found — set it in Settings → Agents'}\n` +
      'These are the channels agents report status through. Counts are zero ' +
      'until a session does something.';

    this.el.statusRight.append(dot(down.length === 0 ? 'done' : 'attention'), readout);
  }
}

// ------------------------------------------------------------------ helpers

function qs<T extends HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
}
function div(cls: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}
function text(tag: string, content: string, cls = ''): HTMLElement {
  const e = document.createElement(tag);
  e.textContent = content;
  if (cls) e.className = cls;
  return e;
}
/**
 * The line under a tab label: which model, at what thinking level, and how
 * full the context window is. Context is the one that changes behaviour --
 * it turns amber then red as a compact approaches.
 */
function metaLine(s: SessionSnapshot): HTMLElement | null {
  const parts: HTMLElement[] = [];

  if (s.model) parts.push(text('span', shortModel(s.model), 'tm-model'));
  if (s.effort) parts.push(text('span', s.effort, 'tm-effort'));

  const ctxInfo = contextInfo(s);
  if (!ctxInfo && s.agent === 'claude' && s.origin === 'owned') {
    const unknown = text('span', 'ctx —', 'tm-ctx unknown');
    unknown.title =
      'Claude Code does not report context usage while a session is live. ' +
      'It appears once the transcript is written.';
    parts.push(unknown);
  }
  if (ctxInfo) {
    // Labelled "ctx" and expressed as *used*, so there is no ambiguity about
    // whether the number counts up toward a compact or down away from one.
    const ctx = text('span', `ctx ${ctxInfo.label}`, `tm-ctx ${ctxInfo.band}`);
    ctx.title = ctxInfo.detail;
    parts.push(ctx);
  }

  if (parts.length === 0) return null;

  const line = div('tab-meta');
  parts.forEach((p, i) => {
    if (i > 0) line.append(text('span', '·', 'tm-sep'));
    line.append(p);
  });
  return line;
}

/**
 * Context pressure, always expressed as consumption rather than headroom.
 * `used` counts up toward a compact; `left` is what remains.
 */
export function contextInfo(s: SessionSnapshot): {
  label: string;
  detail: string;
  band: string;
  usedPct: number | null;
} | null {
  if (s.contextTokens === null) return null;
  const used = s.contextTokens;
  const limit = s.contextLimit ?? null;

  if (!limit || limit <= 0) {
    return {
      label: compactTokens(used),
      detail: `${used.toLocaleString()} context tokens used (window size unknown)`,
      band: '',
      usedPct: null,
    };
  }

  const usedPct = Math.min(100, Math.round((used / limit) * 100));
  const left = Math.max(0, limit - used);
  return {
    label: `${usedPct}%`,
    detail:
      `${used.toLocaleString()} used · ${left.toLocaleString()} left ` +
      `· ${usedPct}% of ${compactTokens(limit)}`,
    band: pressure(usedPct),
    usedPct,
  };
}

/** 970490 -> "970k", 1000000 -> "1M". */
function compactTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m % 1 === 0 ? m : m.toFixed(1)}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Compact enough for a tab: drop the vendor prefix and date suffix. */
function shortModel(model: string): string {
  return model
    .replace(/^(claude|anthropic|openai)[-/]/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-latest$/, '');
}

/** Context pressure bands: the point at which you should think about /compact. */
function pressure(pct: number | null): string {
  if (pct === null) return '';
  if (pct >= 85) return 'crit';
  if (pct >= 65) return 'warn';
  return 'ok';
}

function dot(status: SessionStatus): HTMLElement {
  return div(`dot ${status}`);
}
/**
 * Makes a tab or a sidebar row draggable onto a pane (design note 277).
 *
 * The payload is the session id under a private MIME type, so a pane can tell
 * one of our drags from a file drop or a text selection and only lights up for
 * the former.
 */
function makeSessionDraggable(el: HTMLElement, s: SessionSnapshot): void {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer?.setData(SESSION_DND_TYPE, s.id);
    // Plain text as well, so dragging out of the app somewhere useful is not
    // silently empty.
    e.dataTransfer?.setData('text/plain', s.label);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
}

/** A compact icon control that is a real button, not a styled div. */
function iconButton(
  glyph: string,
  label: string,
  onClick: (e: MouseEvent) => void,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = glyph;
  b.setAttribute('aria-label', label);
  b.onclick = onClick;
  return b;
}
function button(
  label: string,
  cls: string,
  onClick: (e: MouseEvent) => void,
): HTMLElement {
  const b = document.createElement('button');
  b.className = `btn ${cls}`.trim();
  b.textContent = label;
  b.onclick = onClick;
  return b;
}
/**
  * The agent's mark in a small square.
  *
  * With a status it does two jobs at once: the glyph says which agent, the
  * tint says what that session needs. That is what lets it stand in for the
  * status dot in the sidebar without losing the property the whole app is
  * built on -- a row going amber because the agent said it needs you.
  */
function agentBadge(agent: AgentKind, status?: SessionStatus): HTMLElement {
  const box = div('agent-badge' + (status ? ' st-' + status : ''));
  box.append(agentIcon(agent));
  return box;
}

function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] ?? '';
}
/**
 * Two-letter mark for the repository a session lives in, as B3 shows it.
 *
 * Splitting on separators and camelCase humps is what makes "CodeBuilder"
 * read CB and "WISEintelligence" read WI, rather than the first two letters
 * of each.
 */
function repoMark(cwd: string): string {
  const name = basename(cwd);
  if (!name) return '';
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/** How long a session has been alive, in the wireframe's compact form. */
function sessionAge(startedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function shortCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1].slice(0, 14) : cwd;
}
