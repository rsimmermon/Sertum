import { TerminalPane } from './terminal-pane';
import { openNewSessionDialog } from './new-session-dialog';
import { openAdoptDialog } from './adopt-dialog';
import { openSettingsDialog } from './settings-dialog';
import { openConfirmDialog } from './confirm-dialog';
import { effortChip, modelChip } from './chips';
import { openSessionMenu, SEPARATOR } from './session-menu';
import {
  DEFAULT_SETTINGS,
  type AgentKind,
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

const AGENTS: Record<AgentKind, { command: string; args: string[] }> = {
  claude: { command: 'claude', args: [] },
  codex: { command: 'codex', args: [] },
  shell: { command: '', args: [] },
};

/** CSS custom properties the settings dialog drives. */
const FONT_VARS: Array<[keyof Settings, string]> = [
  ['tabFontSize', '--size-tab'],
  ['listFontSize', '--size-list'],
  ['uiFontSize', '--size-ui'],
];

export class App {
  private sessions = new Map<string, SessionSnapshot>();
  private panes = new Map<string, TerminalPane>();
  private activeId: string | null = null;
  private lastCwd: string | null = null;
  private notice: string | null = null;
  private adapters: import('../shared/types').AdapterStatus | null = null;
  private settings: Settings = { ...DEFAULT_SETTINGS };

  private el = {
    root: qs('#root'),
    tabstrip: qs('.tabstrip'),
    sidebar: qs('.sidebar'),
    titlebarText: qs('#titlebar-text'),
    splitter: qs('#splitter'),
    sidebarNew: qs('#sidebar-new'),
    openSettings: qs('#open-settings'),
    sidebarList: qs('#sidebar-list'),
    sidebarCount: qs('#sidebar-count'),
    sidebarHead: qs('#sidebar-head'),
    sidebarFind: qs('#sidebar-find'),
    sidebarSearch: qs('#sidebar-search'),
    sidebarFilter: qs('#sidebar-filter') as HTMLInputElement,
    sidebarClear: qs('#sidebar-clear'),
    paneHost: qs('#pane-host'),
    paneHead: qs('#pane-head'),
    paneTitle: qs('#pane-title'),
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
    this.installSplitter();

    // Row ages are derived from startedAt, so a sidebar that nothing else is
    // updating still has to be repainted for them to stay true.
    setInterval(() => this.renderSidebar(), 30_000);

    this.el.sidebarNew.onclick = () => void this.promptNewSession();
    this.installFilter();
    this.el.openSettings.onclick = () => void this.promptSettings();

    api.onData(({ id, data }) => this.panes.get(id)?.write(data));

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

    menu.on('new-session', () => void this.promptNewSession());
    menu.on('settings', () => void this.promptSettings());
    menu.on('import-sessions', () => void this.promptAdopt());
    menu.on('close-tab', () => {
      if (this.activeId) void this.closeTab(this.activeId);
    });
    menu.on('interrupt', () => this.activeId && api.write(this.activeId, '\x1b'));
    menu.on('stop', () => this.activeId && void api.killSession(this.activeId));
    menu.on('rename', () => this.activeId && this.beginRename(this.activeId));
    menu.on('next-session', () => this.stepSession(1));
    menu.on('prev-session', () => this.stepSession(-1));
    for (let n = 1; n <= 9; n += 1) {
      menu.on(`goto-session-${n}`, () => this.gotoSession(n));
    }

    window.addEventListener('resize', () =>
      this.activeId ? this.panes.get(this.activeId)?.refit() : undefined,
    );

    // Only macOS hides its own title bar, so only macOS gets ours.
    this.el.root.classList.toggle('mac', api.platform === 'darwin');

    // Adapter health is polled: it is a property of the app, not of a turn,
    // so it does not belong on the event stream.
    const pollAdapters = async () => {
      try {
        this.adapters = await api.adapterStatus();
        this.renderStatus();
      } catch {
        this.adapters = null;
      }
    };
    void pollAdapters();
    setInterval(() => void pollAdapters(), 4000);

    for (const s of await api.listSessions()) this.sessions.set(s.id, s);
    // Sessions outlive the renderer (reload, devtools). Re-select one, or the
    // empty state renders on top of tabs that already exist.
    if (!this.activeId) this.activeId = [...this.sessions.keys()][0] ?? null;
    this.render();
  }

  /**
   * Opens wireframe C1 so the working folder is always an explicit choice,
   * then starts the session the user described.
   */
  async promptNewSession(): Promise<void> {
    const startCwd =
      this.lastCwd ??
      (this.activeId ? this.sessions.get(this.activeId)?.cwd : undefined) ??
      (await api.defaultCwd());
    const choice = await openNewSessionDialog(startCwd);
    if (!choice) return;
    await this.newSession(choice.agent, choice.cwd, choice.label);
  }

  /** Spawns a real agent CLI in a PTY and opens it as a tab. */
  async newSession(
    agent: AgentKind,
    cwd?: string,
    label?: string,
  ): Promise<void> {
    const preset = AGENTS[agent];
    const resolvedCwd = cwd ?? (await api.defaultCwd());
    this.lastCwd = resolvedCwd;
    const snapshot = await api.createSession({
      agent,
      label: label ?? `${agent}`,
      cwd: resolvedCwd,
      command: preset.command || undefined,
      args: preset.args,
    });
    this.sessions.set(snapshot.id, snapshot);
    this.panes.set(
      snapshot.id,
      new TerminalPane(snapshot, this.settings.terminalFontSize),
    );
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

  /** Raises the OS window owning a session we cannot render. */
  private async revealExternal(s: SessionSnapshot): Promise<void> {
    if (s.pid === null) return;
    const result = await api.focusExternal(s.pid);
    if (!result.ok && result.reason) {
      this.notice = result.reason;
      this.render();
    }
  }

  private select(id: string): void {
    const session = this.sessions.get(id);
    // A monitored session has no terminal here, so selecting it means going
    // to where it actually lives.
    if (session?.origin === 'monitored') void this.revealExternal(session);
    if (this.activeId === id) return;
    this.notice = null;
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
      this.notice = `${session.label} will not exit — its process is still running.`;
      this.renderStatus();
      return;
    }

    this.panes.get(id)?.dispose();
    this.panes.delete(id);
    this.sessions.delete(id);
    if (this.activeId === id) {
      this.activeId = [...this.sessions.keys()][0] ?? null;
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

    for (const pane of this.panes.values()) pane.setFontSize(next.terminalFontSize);
    this.render();
  }

  private async promptSettings(): Promise<void> {
    const before = this.settings;
    const chosen = await openSettingsDialog(before, (preview) =>
      this.applySettings(preview),
    );
    if (!chosen) return;
    try {
      this.applySettings(await api.setSettings(chosen));
    } catch {
      this.notice = 'Could not save settings.';
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
  }

  private renderTabs(): void {
    const strip = this.el.tabstrip;
    strip.replaceChildren();
    // The sidebar is the primary list; the strip only exists when asked for.
    if (this.settings.tabPlacement === 'side') return;
    for (const s of this.sessions.values()) {
      const selected = s.id === this.activeId;
      const tab = div('tab' + (selected ? ' active' : ''));
      tab.setAttribute('aria-selected', String(selected));
      const stack = div('tab-stack');
      const head = div('tab-head');
      head.append(text('span', s.label, 'tab-label'));
      const badges = this.chipsFor(s);
      if (badges) head.append(badges);
      stack.append(head);
      const meta = metaLine(s);
      if (meta) stack.append(meta);
      tab.append(dot(s.status), stack);
      const close = iconButton('×', `Close ${s.label}`, (e) => {
        e.stopPropagation();
        void this.closeTab(s.id);
      });
      close.classList.add('close');
      tab.append(close);
      tab.tabIndex = 0;
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

    for (const group of GROUP_ORDER) {
      const rows = visible.filter((s) => s.status === group.key);
      // A group with nothing in it collapses out rather than showing an
      // empty heading, which is what B10 asks for while filtering.
      if (rows.length === 0) continue;
      const groupHead = div('sb-group');
      groupHead.append(
        text('span', group.label, 'sb-group-label'),
        text('span', String(rows.length), `sb-count ${group.key}`),
      );
      list.append(groupHead);
      for (const s of rows) {
        const selected = s.id === this.activeId;
        const row = div('sb-row' + (selected ? ' active' : ''));

        const top = div('sb-top');
        top.append(dot(s.status));
        if (this.renaming === s.id) {
          top.append(this.renameField(s));
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

        const bottom = div('sb-bottom');
        bottom.append(text('span', s.activity ?? shortCwd(s.cwd), 'activity'));
        const ctx = contextInfo(s);
        if (ctx) {
          const badge = text('span', `ctx ${ctx.label}`, `tm-ctx ${ctx.band}`);
          badge.title = ctx.detail;
          bottom.append(badge);
        }

        row.append(top, bottom);
        row.title = `${s.cwd}\n${s.activity ?? ''}`.trim();
        row.tabIndex = 0;
        // Announced as a selectable option so the highlight is not the only
        // signal of which session is showing.
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(selected));
        row.dataset.session = s.id;
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
    openSessionMenu(x, y, s.label, [
      { label: 'Focus tab', accel: '⏎', onSelect: () => this.select(s.id) },
      { label: 'Rename…', onSelect: () => this.beginRename(s.id) },
      { label: 'Open in focused pane' },
      { label: 'Open in new pane' },
      { label: 'Mirror in new pane', accel: '⌘⌥M' },
      { label: 'Open in new window' },
      SEPARATOR,
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
      { label: 'Review changes…', accel: '⌘⇧D' },
      { label: 'Commit & push…' },
      { label: 'Open pull request…' },
      { label: 'Worktree manager…' },
      { label: 'Remove worktree…', destructive: true },
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

  private gotoSession(position: number): void {
    const target = this.orderedSessions()[position - 1];
    if (target) this.focusSession(target.id);
  }

  private focusSession(id: string): void {
    this.select(id);
    this.panes.get(id)?.focus();
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

  private renderPane(): void {
    const host = this.el.paneHost;
    const active = this.activeId ? this.sessions.get(this.activeId) : undefined;

    for (const [id, pane] of this.panes) if (id !== this.activeId) pane.unmount();

    if (!active) {
      this.el.paneHead.style.display = 'none';
      host.replaceChildren(this.emptyState());
      return;
    }

    this.el.paneHead.style.display = '';
    this.el.paneTitle.replaceChildren(
      text('span', basename(active.cwd) || active.cwd, 'repo'),
      text('span', '·'),
      text('span', active.cwd, 'branch'),
    );

    if (active.origin === 'monitored') {
      host.replaceChildren(this.externalPane(active));
      return;
    }

    let pane = this.panes.get(active.id);
    if (!pane) {
      pane = new TerminalPane(active, this.settings.terminalFontSize);
      this.panes.set(active.id, pane);
    }
    host.replaceChildren();
    pane.mount(host);
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
      wrap.append(text('div', this.notice, 'external-notice'));
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
function button(label: string, cls: string, onClick: () => void): HTMLElement {
  const b = document.createElement('button');
  b.className = `btn ${cls}`.trim();
  b.textContent = label;
  b.onclick = onClick;
  return b;
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
