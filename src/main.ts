import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  shell,
} from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { PtyManager } from './main/pty-manager';
import { defaultCwd, inspectDirectory } from './main/workspace';
import { HookServer } from './main/hook-server';
import { buildClaudeSettings, mapClaudeHook } from './main/adapters/claude';
import {
  CodexAppServer,
  reapStrayAppServers,
  recordAppServer,
} from './main/adapters/codex-app-server';
import { createAgentAdapters } from './main/adapters/agent-adapter';
import { hydrateLoginEnv } from './main/login-env';
import {
  provisionWorktree,
  readWorktrees,
  removeWorktree,
} from './main/worktrees';
import { getSettings, setSettings } from './main/settings';
import {
  isUserThread,
  mapCodexStatus,
  threadSummary,
  type CodexThread,
  type CodexThreadStatus,
} from './main/adapters/codex';
import { discoverSessions } from './main/adapters/discovery';
import {
  readConfiguredModel,
  readSessionMeta,
} from './main/adapters/session-meta';
import {
  findTranscriptForCwd,
  findTranscriptForSession,
} from './main/adapters/transcript';
import { focusExternalSession } from './main/adapters/window-focus';
import type {
  AgentKind,
  DiscoveredSession,
  SessionSnapshot,
  SessionStatus,
  Settings,
} from './shared/types';
import type { PtySize, SessionSpec } from './shared/types';

// Sets the userData dir and the name Electron reports to the app itself.
// On macOS this does NOT drive the menu-bar/Dock title: those come from the
// running bundle's Info.plist, which scripts/dev-app-name.js patches for dev
// and Forge writes correctly for packaged builds.
app.setName('Sertum');

if (started) app.quit();

// Opt-in remote debugging, so the app can be driven and verified headlessly
// (CI, cross-platform smoke checks) without shipping a debug build.
if (process.env.SERTUM_DEBUG_PORT) {
  app.commandLine.appendSwitch(
    'remote-debugging-port',
    process.env.SERTUM_DEBUG_PORT,
  );
}

const hooks = new HookServer();

/**
 * Plane 2 wiring for Claude Code: every session is spawned pointing its hooks
 * at its own endpoint, so status comes from the agent telling us rather than
 * from watching its output.
 */
const codex = new CodexAppServer();

/**
 * One implementation per agent of everything the UI can ask of a session.
 * Callers below look an agent up here rather than switching on its kind.
 */
const agentAdapters = createAgentAdapters({ codex });

/**
 * Codex sessions awaiting their thread, oldest first.
 *
 * A spawned TUI does not know its thread id, and the thread announces itself
 * moments later over the app server. One spawn produces exactly one user
 * thread (the throwaway title thread is filtered out), so consuming this queue
 * in order binds correctly without matching on cwd, which several sessions can
 * share.
 */
const awaitingThread: Array<{ id: string; cwd: string }> = [];

const ptys = new PtyManager((id, spec) => {
  if (spec.agent === 'claude' && hooks.port) {
    return {
      args: [...spec.args, '--settings', buildClaudeSettings(hooks.urlFor(id))],
      adapterBound: true,
    };
  }

  // `-C` rather than the PTY's cwd: with `--remote` the thread's working
  // directory comes from the app server's process, not the terminal's, so
  // without this every session would silently run in Sertum's folder.
  if (spec.agent === 'codex' && codex.connected) {
    awaitingThread.push({ id, cwd: spec.cwd });
    return {
      args: [...spec.args, '--remote', codex.remoteUrl, '-C', spec.cwd],
      adapterBound: true,
    };
  }

  return {};
});

/** Thread id -> session id, for routing later status changes. */
const threadToSession = new Map<string, string>();

codex.on('notification', ({ method, params }) => {
  if (method === 'thread/started') {
    const thread = (params.thread ?? {}) as CodexThread;
    if (!thread.id || !isUserThread(thread)) return;

    // Prefer a pending session in the same folder; fall back to the oldest,
    // which covers a thread whose cwd was rewritten (a `/cd`, say).
    const match = awaitingThread.findIndex((w) => w.cwd === thread.cwd);
    const waiting =
      match >= 0 ? awaitingThread.splice(match, 1)[0] : awaitingThread.shift();
    if (!waiting) return;

    threadToSession.set(thread.id, waiting.id);
    ptys.applyMeta(waiting.id, { externalId: thread.id });
    ptys.applyUpdate(waiting.id, mapCodexStatus(thread.status));
    return;
  }

  const threadId = typeof params.threadId === 'string' ? params.threadId : null;
  const sessionId = threadId ? threadToSession.get(threadId) : undefined;
  if (!sessionId) return;

  if (method === 'thread/status/changed') {
    const update = mapCodexStatus(params.status as CodexThreadStatus | undefined);
    if (update.status || update.activity) ptys.applyUpdate(sessionId, update);
    return;
  }

  // Codex titles a thread itself once the first turn lands; it reads better in
  // the session list than the raw prompt does.
  if (method === 'thread/name/updated') {
    const name = threadSummary({ id: threadId!, name: params.threadName as string });
    if (name) ptys.applyUpdate(sessionId, { activity: name });
  }
});

codex.on('log', (line: string) => console.warn('[codex]', line));

hooks.on('hook', ({ sessionId, event, payload }) => {
  const update = mapClaudeHook(event, payload);
  if (update.status || update.activity) ptys.applyUpdate(sessionId, update);

  // Hooks report effort but not the model or token counts. Remember where the
  // transcript lives; the poller below reads the rest, because the transcript
  // is not always flushed by the time the hook fires.
  const transcript = payload.transcript_path;
  const effort = (payload.effort as { level?: string } | undefined)?.level;
  if (typeof transcript === 'string' || effort) {
    ptys.applyMeta(sessionId, {
      transcriptPath: typeof transcript === 'string' ? transcript : undefined,
      effort: effort ?? undefined,
    });
  }
});

/**
 * Model, effort and context pressure are read from each session's transcript
 * on a slow poll rather than on hook arrival: the transcript lags the hook,
 * and context usage keeps climbing between events anyway.
 */
let metaTimer: NodeJS.Timeout | null = null;
function startMetaPolling() {
  if (metaTimer) return;
  metaTimer = setInterval(() => {
    for (const s of ptys.list()) {
      if (s.pid === null) continue;

      const transcript = transcriptFor(s);
      if (!transcript) continue;

      const meta = readSessionMeta(s.agent, transcript);
      ptys.applyMeta(s.id, { ...meta, transcriptPath: transcript });
    }
  }, 4000);
}
/**
 * Which transcript belongs to a session, or null when nothing can be matched
 * without guessing.
 *
 * Monitored sessions are included: the transcript is on disk whoever owns the
 * process, which is the same property that lets discovery summarise them, so
 * there is no reason an adopted row should go without a model or a context
 * readout. They resolve by their discovered session id rather than by cwd.
 */
function transcriptFor(s: SessionSnapshot): string | null {
  if (s.transcriptPath) return s.transcriptPath;

  if (s.origin === 'monitored') {
    const sessionId = discoveredSessionId(s.externalId);
    // Falling back to cwd is fine for Codex but not for Claude, per the note
    // below -- a Claude row we cannot identify exactly gets nothing.
    if (s.agent === 'claude' && !sessionId) return null;
    return findTranscriptForSession(s.agent, sessionId, s.cwd);
  }

  // Claude tells us its exact transcript through the hook payload. Never
  // guess one by cwd: several sessions share a folder, and showing another
  // session's context is worse than showing none.
  if (s.agent === 'claude') return null;
  return findTranscriptForCwd(s.agent, s.cwd, s.startedAt);
}

/**
 * A discovered id is either the agent's own session id or a `pid:N` stand-in
 * from the process scan, which identifies nothing on disk.
 */
function discoveredSessionId(externalId: string | null): string | null {
  if (!externalId || externalId.startsWith('pid:')) return null;
  return externalId;
}

let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0d1113',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

/** Forward PTY traffic to whichever window is alive. */
const broadcast = (channel: string, payload: unknown) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
};

ptys.on('data', (e) => broadcast('pty:data', e));
ptys.on('exit', (e) => broadcast('pty:exit', e));
ptys.on('session-updated', (s) => broadcast('session:updated', s));

ipcMain.handle('session:create', (_e, spec: Partial<SessionSpec>) => {
  // Resolve the agent's binary here rather than trusting PATH: a packaged app
  // launched from Finder has only the bare launchd PATH, and a bare `claude`
  // would exit immediately.
  const snapshot = ptys.create({
    ...spec,
    command: resolvedCommand(spec.agent, spec.command),
  });
  // Claude never reports its model on a live session, so record what its
  // configuration says it will use.
  const model = readConfiguredModel(snapshot.agent);
  if (model) ptys.applyMeta(snapshot.id, { model });
  return { ...snapshot, model: model ?? snapshot.model };
});
ipcMain.handle('session:list', () => ptys.list());
ipcMain.handle('clipboard:write', (_e, text: string) => {
  clipboard.writeText(text);
});
ipcMain.handle('worktree:list', (_e, cwd: string) => {
  // Sessions are passed as a map so the inventory can say which worktree is
  // occupied without the worktree layer knowing anything about sessions.
  const byId = new Map(ptys.list().map((s) => [s.id, s.cwd]));
  return readWorktrees(cwd, byId);
});
ipcMain.handle(
  'worktree:remove',
  (_e, { root, path: target, force }: { root: string; path: string; force: boolean }) =>
    removeWorktree(root, target, force),
);
ipcMain.handle(
  'worktree:provision',
  (
    _e,
    { cwd, branch, copyIncludes }: { cwd: string; branch: string; copyIncludes: boolean },
  ) => provisionWorktree(cwd, branch, copyIncludes),
);
ipcMain.handle('shell:reveal', (_e, target: string) => {
  shell.showItemInFolder(target);
});
ipcMain.handle('session:kill', (_e, id: string) => ptys.kill(id));
ipcMain.handle(
  'session:rename',
  (_e, { id, label }: { id: string; label: string }) => {
    const stored = ptys.rename(id, label);
    if (stored === null) return null;
    const session = ptys.get(id);
    if (session) {
      // Not awaited: the local name is authoritative and already applied, so
      // the rename must not wait on an agent that may be slow or gone.
      void agentAdapters
        .get(session.agent)
        ?.renameRemote(
          { externalId: session.externalId, cwd: session.cwd },
          stored,
        );
    }
    return stored;
  },
);
ipcMain.handle('session:remove', (_e, id: string) => ptys.remove(id));
ipcMain.handle('workspace:default-cwd', () => defaultCwd());
ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) =>
  setSettings(patch),
);
ipcMain.handle('discovery:list', () =>
  discoverSessions(ptys.ownedPids(), resolvedCommand),
);
ipcMain.handle('discovery:focus', (_e, pid: number) =>
  focusExternalSession(pid),
);

/**
 * Daemon-hosted sessions can have a real terminal opened onto them, because
 * the supervisor -- not another terminal emulator -- owns the PTY.
 */
ipcMain.handle('discovery:attach', (_e, d: DiscoveredSession) =>
  ptys.create({
    label: d.name,
    agent: d.agent,
    cwd: d.cwd || defaultCwd(),
    command: resolvedCommand('claude'),
    args: ['attach', d.sessionId],
  }),
);

ipcMain.handle('discovery:monitor', (_e, d: DiscoveredSession) =>
  ptys.registerMonitored({
    label: d.name,
    agent: d.agent,
    cwd: d.cwd,
    externalId: d.sessionId,
    pid: d.pid,
    status: d.status,
  }),
);

ipcMain.handle('adapters:status', () => ({
  claude: { connected: hooks.port > 0, port: hooks.port, events: hooks.eventCount },
  codex: {
    connected: codex.connected,
    url: codex.connected ? codex.remoteUrl : '',
    events: codex.eventCount,
  },
}));
ipcMain.handle('workspace:inspect', (_e, dir: string) => inspectDirectory(dir));
ipcMain.handle('dialog:pick-directory', async (_e, startIn?: string) => {
  const result = await dialog.showOpenDialog({
    title: 'Choose a working folder',
    defaultPath: startIn || defaultCwd(),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Use this folder',
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});
ipcMain.on('pty:input', (_e, { id, data }: { id: string; data: string }) =>
  ptys.write(id, data),
);
ipcMain.on('pty:resize', (_e, { id, ...size }: { id: string } & PtySize) =>
  ptys.resize(id, size),
);

app.on('ready', async () => {
  app.setAboutPanelOptions({
    applicationName: 'Sertum',
    applicationVersion: app.getVersion(),
    credits: 'One window for every coding agent you have running.',
  });
  try {
    const port = await hooks.start();
    console.log(`[sertum] hook endpoint on 127.0.0.1:${port}`);
  } catch (err) {
    // Without hooks the app still runs; status falls back to process
    // lifecycle only, which is worth saying out loud rather than hiding.
    console.error('[sertum] hook server failed to start:', err);
  }

  // Codex is optional: a machine with only Claude installed should still get a
  // working app, so a failure here degrades that agent rather than the window.
  // Before anything is spawned: a GUI app inherits the launchd environment,
  // not the user's, and every session and agent would otherwise run without
  // the PATH their machine is actually set up with.
  const hydrated = await hydrateLoginEnv();
  console.log(
    hydrated
      ? '[sertum] environment taken from your login shell'
      : '[sertum] using the inherited environment; login shell did not answer',
  );

  try {
    const reaped = await reapStrayAppServers(appServerRecordFile());
    if (reaped) {
      console.log(`[sertum] reaped ${reaped} orphaned codex app server(s)`);
    }
    const up = await codex.start();
    console.log(
      up
        ? `[sertum] codex app server on ${codex.remoteUrl}`
        : '[sertum] codex not available; codex sessions run unmonitored',
    );
    if (up && codex.childPid !== null) {
      recordAppServer(appServerRecordFile(), {
        ownerPid: process.pid,
        serverPid: codex.childPid,
        port: codex.port,
      });
    }
  } catch (err) {
    console.error('[sertum] codex app server failed to start:', err);
  }

  buildMenu();
  startMonitorPolling();
  startMetaPolling();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * Monitored sessions emit no hooks to us -- they were not spawned with our
 * settings -- so their status is polled from the agent's own roster.
 */
let monitorTimer: NodeJS.Timeout | null = null;
function startMonitorPolling() {
  if (monitorTimer) return;
  monitorTimer = setInterval(async () => {
    const monitored = ptys
      .list()
      .filter((s) => s.origin === 'monitored' && s.externalId);
    if (monitored.length === 0) return;
    const found = await discoverSessions(new Set(), resolvedCommand);
    ptys.syncMonitored(
      found.map((f: { sessionId: string; status: SessionStatus }) => ({
        externalId: f.sessionId,
        status: f.status,
      })),
    );
  }, 3000);
}

/**
 * The executable to spawn for an agent, asking that agent's adapter.
 *
 * An explicit command from the caller always wins -- someone naming a binary
 * means it -- and a shell with no command falls through to the adapter too, so
 * every session resolves the same way.
 */
function resolvedCommand(
  agent: AgentKind | undefined,
  explicit?: string,
): string | undefined {
  if (explicit) return explicit;
  if (!agent) return undefined;
  return agentAdapters.get(agent)?.resolveBinary();
}

/** Where the spawned codex app server is remembered between runs. */
function appServerRecordFile(): string {
  return path.join(app.getPath('userData'), 'codex-app-server.json');
}

/**
 * Everything that must happen before the process goes away, exactly once.
 *
 * `before-quit` covers the exits Electron knows about, but it does not fire
 * when the process is signalled -- which in development is the common case,
 * since Ctrl-C on `npm start` reaches Electron as SIGINT. Without a handler
 * the default disposition kills us outright and the codex app server we
 * spawned is reparented to init, one stray per abnormal exit.
 *
 * SIGKILL and a hard crash still cannot be trapped. Those are what the
 * startup reap covers.
 */
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (monitorTimer) clearInterval(monitorTimer);
  if (metaTimer) clearInterval(metaTimer);
  ptys.disposeAll();
  void hooks.stop();
  // The record is deliberately left in place. Confirming the kill is not
  // possible from inside a dying process, so the next launch verifies and
  // reaps whatever actually survived -- and drops the record when nothing did.
  codex.stop();
}

app.on('before-quit', shutdown);

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    shutdown();
    process.exit(0);
  });
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

/**
 * Menu scaffold. Items map to the wireframes in section 04; only the ones
 * phase 01 can honour are enabled, the rest stay visible but disabled so the
 * shape of the app is legible from the first run.
 */
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (channel: string) => () => broadcast(channel, null);

  const appMenu: Electron.MenuItemConstructorOptions = {
    label: 'Sertum',
    submenu: [
      { role: 'about', label: 'About Sertum' },
      { type: 'separator' },
      {
        label: 'Settings…',
        accelerator: 'CmdOrCtrl+,',
        click: send('settings'),
      },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide', label: 'Hide Sertum' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit', label: 'Quit Sertum' },
    ],
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [appMenu] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Session…',
          accelerator: 'CmdOrCtrl+N',
          click: send('menu:new-session'),
        },
        { type: 'separator' },
        { label: 'Add Repository…', enabled: false },
        {
          label: 'Import Running Sessions…',
          click: send('menu:import-sessions'),
        },
        { type: 'separator' },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: send('menu:close-tab'),
        },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Session',
      submenu: [
        // No accelerator: D2 draws this as Enter, but that is Enter on a
        // focused sidebar row, and a menu accelerator would swallow every
        // Enter in the app -- including keystrokes meant for the terminal.
        { label: 'Rename…', click: send('menu:rename') },
        { type: 'separator' },
        {
          label: 'Interrupt Turn',
          accelerator: 'CmdOrCtrl+.',
          click: send('menu:interrupt'),
        },
        { label: 'Stop Session', click: send('menu:stop') },
        { type: 'separator' },
        // Moving between sessions is a property of the list, not of any
        // agent, so these behave identically for Claude, Codex and a shell.
        {
          label: 'Next Session',
          accelerator: 'CmdOrCtrl+Shift+]',
          click: send('menu:next-session'),
        },
        {
          label: 'Previous Session',
          accelerator: 'CmdOrCtrl+Shift+[',
          click: send('menu:prev-session'),
        },
        {
          label: 'Go to Session',
          submenu: Array.from({ length: 9 }, (_, i) => ({
            label: `Session ${i + 1}`,
            accelerator: `CmdOrCtrl+${i + 1}`,
            click: send(`menu:goto-session-${i + 1}`),
          })),
        },
        { type: 'separator' },
        { label: 'Session Info', accelerator: 'CmdOrCtrl+I', enabled: false },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Command Palette…',
          accelerator: 'CmdOrCtrl+K',
          click: send('menu:palette'),
        },
        { type: 'separator' },
        { label: 'Layout: Single', type: 'radio', checked: true },
        { label: 'Layout: Columns', type: 'radio', enabled: false },
        { label: 'Layout: Rows', type: 'radio', enabled: false },
        { label: 'Layout: Grid', type: 'radio', enabled: false },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
