import { TerminalPane } from './terminal-pane';
import { openNewSessionDialog } from './new-session-dialog';
import { openAdoptDialog } from './adopt-dialog';
import type {
  AgentKind,
  SessionSnapshot,
  SessionStatus,
} from '../shared/types';

const api = window.agentStation;
const menu = window.agentStationMenu;

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

export class App {
  private sessions = new Map<string, SessionSnapshot>();
  private panes = new Map<string, TerminalPane>();
  private activeId: string | null = null;
  private lastCwd: string | null = null;
  private notice: string | null = null;
  private adapters: import('../shared/types').AdapterStatus | null = null;

  private el = {
    tabstrip: qs('.tabstrip'),
    sidebarList: qs('#sidebar-list'),
    sidebarCount: qs('#sidebar-count'),
    paneHost: qs('#pane-host'),
    paneHead: qs('#pane-head'),
    paneTitle: qs('#pane-title'),
    statusLeft: qs('#status-left'),
    statusRight: qs('#status-right'),
  };

  async start(): Promise<void> {
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
    menu.on('import-sessions', () => void this.promptAdopt());
    menu.on('close-tab', () => this.activeId && this.closeTab(this.activeId));
    menu.on('interrupt', () => this.activeId && api.write(this.activeId, '\x1b'));
    menu.on('stop', () => this.activeId && void api.killSession(this.activeId));

    window.addEventListener('resize', () =>
      this.activeId ? this.panes.get(this.activeId)?.refit() : undefined,
    );

    if (api.platform !== 'darwin') this.el.tabstrip.classList.add('win');

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
    this.panes.set(snapshot.id, new TerminalPane(snapshot));
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
  private closeTab(id: string): void {
    const session = this.sessions.get(id);
    const pane = this.panes.get(id);
    pane?.dispose();
    this.panes.delete(id);
    // A monitored session is someone else's process: forget it, never kill it.
    void api.removeSession(id);
    if (session?.origin === 'monitored') this.notice = null;
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

  private render(): void {
    this.renderTabs();
    this.renderSidebar();
    this.renderPane();
    this.renderStatus();
  }

  private renderTabs(): void {
    const strip = this.el.tabstrip;
    strip.replaceChildren();
    for (const s of this.sessions.values()) {
      const tab = div('tab' + (s.id === this.activeId ? ' active' : ''));
      tab.append(dot(s.status), text('span', s.label));
      const close = text('span', '×', 'close');
      close.onclick = (e) => {
        e.stopPropagation();
        this.closeTab(s.id);
      };
      tab.append(close);
      tab.onclick = () => this.select(s.id);
      strip.append(tab);
    }
    const add = text('div', '＋', 'tab-new');
    add.title = 'New session…  (⌘N)';
    add.onclick = () => void this.promptNewSession();
    strip.append(add);
  }

  private renderSidebar(): void {
    const list = this.el.sidebarList;
    list.replaceChildren();
    this.el.sidebarCount.textContent = String(this.sessions.size);

    if (this.sessions.size === 0) {
      const empty = div('sb-empty');
      empty.textContent =
        'Sessions you start appear here, grouped by what they need from you.';
      list.append(empty);
      return;
    }

    for (const group of GROUP_ORDER) {
      const rows = [...this.sessions.values()].filter(
        (s) => s.status === group.key,
      );
      if (rows.length === 0) continue;
      list.append(text('div', `${group.label}  ${rows.length}`, 'sb-group'));
      for (const s of rows) {
        const row = div('sb-row' + (s.id === this.activeId ? ' active' : ''));
        const stack = div('sb-stack');
        stack.append(text('span', s.label, 'name'));
        stack.append(
          text('span', s.activity ?? shortCwd(s.cwd), 'activity'),
        );
        row.append(dot(s.status), stack);
        if (s.origin === 'monitored') {
          row.append(text('span', '↗', 'external-mark'));
          row.classList.add('is-external');
        }
        row.title = `${s.cwd}\n${s.activity ?? ''}`.trim();
        row.onclick = () => this.select(s.id);
        list.append(row);
      }
    }
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
      pane = new TerminalPane(active);
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
      button('Stop tracking', 'ghost', () => this.closeTab(s.id)),
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

    const a = this.adapters;
    const healthy = a?.claude.connected ?? false;
    this.el.statusRight.append(
      text('span', `${this.sessions.size} session(s)`),
      dot(healthy ? 'done' : 'attention'),
      text(
        'span',
        healthy
          ? `claude hooks · ${a?.claude.events ?? 0} events`
          : 'hooks offline',
        'mono',
      ),
    );
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
function dot(status: SessionStatus): HTMLElement {
  return div(`dot ${status}`);
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
function shortCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1].slice(0, 14) : cwd;
}
