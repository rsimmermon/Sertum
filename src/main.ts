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
import { DaemonClient, daemonScriptPath } from './main/daemon-client';
import { defaultCwd, inspectDirectory } from './main/workspace';
import {
  provisionWorktree,
  readWorktrees,
  removeWorktree,
} from './main/worktrees';
import {
  commitDiff,
  discardDiff,
  readDiff,
  readDiffFile,
} from './main/diff-review';
import {
  createPullRequest,
  readPullRequestContext,
} from './main/pull-request';
import { Notifier } from './main/notifications';
import {
  accel,
  listKeybindings,
  resetKeybindings,
  setKeybinding,
} from './main/keybindings';
import { getSettings, setSettings } from './main/settings';
import { readClipboardPaste } from './main/clipboard-paste';
import { focusExternalSession } from './main/adapters/window-focus';
import type {
  DiffCommitRequest,
  PermissionRule,
  ManagedAgent,
  MenuState,
  DiscoveredSession,
  SessionSnapshot,
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

/**
 * The session fabric lives in sertumd — stage 3 of BROKER-HANDOFF.md. This
 * process owns windows, menus, dialogs and notifications; every session,
 * adapter and hook endpoint belongs to the daemon, reached over its socket.
 * Closing this app therefore closes nothing an agent needs, for every agent
 * alike. The IPC channel names the renderer speaks are unchanged: each
 * handler below that used to *be* the fabric now forwards to it.
 */
const daemon = new DaemonClient(
  daemonScriptPath(),
  app.getVersion(),
  app.getPath('userData'),
);

/**
 * The GUI's mirror of the daemon's sessions, fed by `session:updated`
 * events and primed from `session/list`. UI-side consumers — worktree
 * gating, the badge count, the mute re-broadcast — read this instead of
 * making a round trip per lookup.
 */
const sessionCache = new Map<string, SessionSnapshot>();

/** What the fabric needs from settings, pushed on connect and on change. */
function pushFabricSettings(): void {
  const s = getSettings();
  void daemon
    .request('settings/apply', {
      approvalsInApp: s.approvalsInApp,
      agentBinaryPaths: s.agentBinaryPaths,
    })
    .catch(() => {
      // Disconnected; the reconnect path pushes again.
    });
}

// B5's bar lives in the renderer; the held call lives in the daemon's hook
// server. The answer carries everything the fabric needs to write rules,
// remember session allows, and release the turn.
ipcMain.handle('approval:answer', (_e, payload: unknown) =>
  daemon.request('approval/answer', payload),
);

ipcMain.handle('keys:get', () => listKeybindings());
ipcMain.handle(
  'keys:set',
  (_e, { id, accelerator }: { id: string; accelerator: string }) => {
    const result = setKeybinding(id, accelerator);
    // The menu carries the accelerators, so a new binding only takes effect
    // once it is rebuilt.
    if (result.ok) buildMenu();
    return result;
  },
);
ipcMain.handle('keys:reset', () => {
  const bindings = resetKeybindings();
  buildMenu();
  return bindings;
});
// Rules are evaluated at the daemon's hook boundary, so the daemon owns the
// store; E2 edits it through these proxies.
ipcMain.handle('rules:get', () => daemon.request('rules/get'));
ipcMain.handle('rules:add', (_e, rule: Omit<PermissionRule, 'id'>) =>
  daemon.request('rules/add', rule),
);
ipcMain.handle('rules:remove', (_e, id: string) =>
  daemon.request('rules/remove', id),
);


let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0d1113',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Only needed in dev: `npm start` runs the bare electron.exe/Electron.app
    // binary, which carries Electron's own generic icon, so without this the
    // title bar and taskbar show that instead of Sertum's. A packaged build
    // is its own icon-bearing executable (packagerConfig.icon, applied by
    // resedit at package time) and needs no override -- Windows and macOS
    // both read a running window's icon from its host executable by default.
    icon: MAIN_WINDOW_VITE_DEV_SERVER_URL
      ? path.join(
          app.getAppPath(),
          'assets',
          process.platform === 'win32' ? 'icon.ico' : 'icon.png',
        )
      : undefined,
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

  watchForProcessDeath(mainWindow);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

/** How soon a second renderer death means reloading is not the answer. */
const RELOAD_GRACE_MS = 30_000;

/**
 * Answers a helper process dying under the window, and says so in the log.
 *
 * These are the deaths that present as "the app froze", because none of them
 * announces itself. A renderer that goes leaves the window an empty rectangle
 * -- Electron does not bring it back, so every tab, pane and control is gone
 * for good while the main process sits there healthy, still owning every PTY.
 * A GPU process that goes takes every terminal's WebGL context with it, which
 * `TerminalPane` recovers from, but only if someone can tell afterwards that
 * it happened.
 *
 * Reloading is safe because sessions live here rather than in the renderer:
 * it re-lists them on start, so what a reload actually costs is pane
 * scrollback. Once, though -- if the replacement dies too then reloading is
 * not the answer, and a window left alone beats one that spends the session
 * flickering through fresh renderers.
 */
function watchForProcessDeath(win: BrowserWindow): void {
  let reloadedAt = 0;

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(
      `[sertum] renderer gone: ${details.reason} (exit ${details.exitCode})`,
    );
    // A clean exit is the renderer going away because we are, and quitting
    // must not be answered by building a new window to quit again.
    if (shuttingDown || details.reason === 'clean-exit') return;
    if (win.isDestroyed()) return;

    const now = Date.now();
    if (now - reloadedAt < RELOAD_GRACE_MS) {
      console.error('[sertum] renderer died again after a reload; leaving it');
      return;
    }
    reloadedAt = now;
    console.error('[sertum] reloading the window; sessions are unaffected');
    win.webContents.reload();
  });

  // Not recoverable from here -- the point is that it stops being invisible.
  win.webContents.on('unresponsive', () =>
    console.error('[sertum] renderer is not answering'),
  );
  win.webContents.on('responsive', () =>
    console.warn('[sertum] renderer is answering again'),
  );
}

app.on('child-process-gone', (_e, details) => {
  console.error(
    `[sertum] ${details.type}${details.serviceName ? ` (${details.serviceName})` : ''} gone: ${details.reason}`,
  );
});

/** Forward PTY traffic to whichever window is alive. */
const broadcast = (channel: string, payload: unknown) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
};

ipcMain.on('menu:state', (_e, state: MenuState) => applyMenuState(state));

/**
 * C20 rides on the same event the renderer does, so a notification can never
 * disagree with the dot beside it.
 */
const notifier = new Notifier(
  () => mainWindow,
  () => getSettings(),
);

/**
 * Everything the daemon says fans out to the renderer on the channel names
 * it has always listened on. Mute is stamped here because it is ours, not
 * the fabric's: notifications are a GUI concern, so the daemon never learns
 * who is muted.
 */
daemon.on('daemon-event', (name: string, payload: unknown) => {
  switch (name) {
    case 'pty:data':
      broadcast('pty:data', payload);
      break;
    case 'pty:replay':
      broadcast('pty:replay', payload);
      break;
    case 'pty:exit': {
      const e = payload as { id: string; exitCode: number };
      // A mute lasted "until it finishes", and it just did.
      notifier.forget(e.id);
      broadcast('pty:exit', e);
      break;
    }
    case 'session:updated': {
      const s = payload as SessionSnapshot;
      s.muted = notifier.isMuted(s.id);
      sessionCache.set(s.id, s);
      notifier.update(s);
      notifier.updateBadge(
        [...sessionCache.values()].filter((row) => row.status === 'needs-input')
          .length,
      );
      broadcast('session:updated', s);
      break;
    }
    case 'approval:needed':
      broadcast('approval:needed', payload);
      break;
    case 'approval:gone':
      broadcast('approval:gone', payload);
      break;
  }
});

/**
 * A lost daemon looks like every button breaking at once, so it is said out
 * loud; a regained one re-primes the mirror and repaints the renderer.
 */
daemon.on('state', ({ connected }: { connected: boolean }) => {
  if (!connected) {
    console.error('[sertum] lost sertumd; reconnecting');
    return;
  }
  console.log('[sertum] connected to sertumd');
  pushFabricSettings();
  void daemon
    .request<SessionSnapshot[]>('session/list')
    .then((sessions) => {
      sessionCache.clear();
      for (const s of sessions) {
        sessionCache.set(s.id, s);
        broadcast('session:updated', { ...s, muted: notifier.isMuted(s.id) });
      }
    })
    .catch(() => {});
});

ipcMain.handle(
  'session:mute',
  (_e, { id, muted }: { id: string; muted: boolean }) => {
    notifier.setMuted(id, muted);
    const session = sessionCache.get(id);
    if (session) broadcast('session:updated', { ...session, muted });
    return muted;  },
);
ipcMain.handle('session:snooze', (_e, id: string) => {
  notifier.snooze(id, getSettings().notifySnoozeMinutes);
});

ipcMain.handle('session:create', async (_e, spec: Partial<SessionSpec>) => {
  const snapshot = await daemon.request<SessionSnapshot>(
    'session/create',
    spec,
  );
  sessionCache.set(snapshot.id, snapshot);
  return snapshot;
});
ipcMain.handle('session:list', async () => {
  const sessions = await daemon.request<SessionSnapshot[]>('session/list');
  sessionCache.clear();
  for (const s of sessions) {
    s.muted = notifier.isMuted(s.id);
    sessionCache.set(s.id, s);
  }
  return sessions;
});
ipcMain.handle('clipboard:write', async (_e, text: string) => {
  await clipboard.writeText(text);
});
ipcMain.handle('clipboard:read', () => readClipboardPaste());
/**
 * Every session's working folder, keyed by id.
 *
 * Passed into the worktree layer rather than reached for from inside it, so
 * that layer keeps knowing nothing about sessions: it is handed a set of
 * occupied folders and answers in those terms. Read fresh on each call --
 * this is what makes "is anything using it?" true at the moment of removal
 * rather than at the moment the manager was opened.
 */
const sessionCwds = (): Map<string, string> =>
  new Map([...sessionCache.values()].map((s) => [s.id, s.cwd]));
ipcMain.handle('worktree:list', (_e, cwd: string) =>
  readWorktrees(cwd, sessionCwds()),
);
ipcMain.handle(
  'worktree:remove',
  (_e, { root, path: target, force }: { root: string; path: string; force: boolean }) =>
    removeWorktree(root, target, force, sessionCwds()),
);
ipcMain.handle(
  'worktree:provision',
  (
    _e,
    { cwd, branch, copyIncludes }: { cwd: string; branch: string; copyIncludes: boolean },
  ) => provisionWorktree(cwd, branch, copyIncludes),
);
ipcMain.handle('diff:read', (_e, cwd: string) => readDiff(cwd));
ipcMain.handle(
  'diff:file',
  (_e, { root, path: file }: { root: string; path: string }) =>
    readDiffFile(root, file),
);
ipcMain.handle('diff:discard', (_e, root: string) => discardDiff(root));
ipcMain.handle('diff:commit', (_e, request: DiffCommitRequest) =>
  commitDiff(request),
);
ipcMain.handle('pr:read', (_e, root: string) => readPullRequestContext(root));
ipcMain.handle(
  'pr:create',
  (
    _e,
    request: { root: string; title: string; body: string; draft: boolean },
  ) => createPullRequest(request),
);
ipcMain.handle('shell:reveal', (_e, target: string) => {
  shell.showItemInFolder(target);
});
/**
 * Opens a web URL in the user's browser.
 *
 * Deliberately restricted to http(s). `shell.openExternal` hands any other
 * scheme to whatever the OS registered for it, which is how a renderer bug or
 * a hostile string turns into launching a local program -- and the URLs that
 * reach here come from `gh`'s output, not from us.
 */
ipcMain.handle('shell:open-external', (_e, url: string) => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  void shell.openExternal(parsed.toString());
  return true;
});
/**
 * Deep link to the pane holding our Apple events grant.
 *
 * Sertum only shows up there once it has actually asked to control something,
 * which needs NSAppleEventsUsageDescription in the bundle -- see the key set
 * in forge.config.ts and scripts/dev-app-name.js.
 */
ipcMain.handle('shell:automation-settings', () =>
  shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  ),
);
ipcMain.handle('session:kill', (_e, id: string) =>
  daemon.request('session/kill', id),
);
ipcMain.handle('session:steer', (_e, p: { id: string; text: string }) =>
  daemon.request('session/steer', p),
);
ipcMain.handle('session:interrupt-turn', (_e, id: string) =>
  daemon.request('session/interrupt-turn', id),
);
ipcMain.handle('session:tool-gate', (_e, p: { id: string; paused: boolean }) =>
  daemon.request('session/tool-gate', p),
);
ipcMain.handle('session:rename', (_e, p: { id: string; label: string }) =>
  daemon.request('session/rename', p),
);
ipcMain.handle('session:remove', async (_e, id: string) => {
  const gone = await daemon.request<boolean>('session/remove', id);
  if (gone) sessionCache.delete(id);
  return gone;
});
ipcMain.handle('workspace:default-cwd', () => defaultCwd());
ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
  const before = getSettings().paneLayout;
  const stored = setSettings(patch);
  pushFabricSettings();  // The View menu carries the layout radio set, so it has to be rebuilt when
  // the layout is changed from anywhere else -- the picker, a shortcut, or a
  // pane close collapsing back to Single.
  if (stored.paneLayout !== before) buildMenu();
  return stored;
});
/**
 * The chat view's one data source: the session's transcript, parsed into
 * conversation items. Resolution reuses `transcriptFor`, so the same rules
 * apply as for model and context readouts — a Claude session is only matched
 * exactly, never guessed by cwd.
 */
/**
 * Input for a stream session: one structured message, no PTY bytes anywhere.
 * The status flip to working happens in the host, on the write itself.
 */
ipcMain.handle('chat:send', (_e, p: { id: string; text: string }) =>
  daemon.request('chat/send', p),
);
ipcMain.handle('conversation:read', (_e, id: string) =>
  daemon.request('conversation/read', id),
);

ipcMain.handle('discovery:list', () => daemon.request('discovery/list'));ipcMain.handle('discovery:focus', (_e, pid: number) =>
  focusExternalSession(pid),
);

/**
 * Daemon-hosted sessions can have a real terminal opened onto them, because
 * the supervisor -- not another terminal emulator -- owns the PTY.
 */
ipcMain.handle('discovery:attach', (_e, d: DiscoveredSession) =>
  daemon.request('discovery/attach', d),
);

ipcMain.handle('discovery:monitor', (_e, d: DiscoveredSession) =>
  daemon.request('discovery/monitor', d),
);

// Declared once per adapter and fixed for the app's life; the renderer reads
// them at startup so the UI can say what an agent cannot do before trying.
ipcMain.handle('agent:capabilities', () =>
  daemon.request('agent/capabilities'),
);
ipcMain.handle('adapters:status', () => daemon.request('adapters/status'));
ipcMain.handle('agent:detect', (_e, agent: ManagedAgent) =>
  daemon.request('agent/detect', agent),
);
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
ipcMain.handle('dialog:pick-file', async (_e, startIn?: string) => {
  const result = await dialog.showOpenDialog({
    title: 'Choose an executable',
    defaultPath: startIn || undefined,
    properties: ['openFile'],
    buttonLabel: 'Use this file',
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});
// Keystrokes are the hot path: fire-and-forget, no response round trip.
ipcMain.on('pty:input', (_e, p: { id: string; data: string }) =>
  daemon.send('pty/input', p),
);
ipcMain.on('pty:resize', (_e, p: { id: string } & PtySize) =>
  daemon.send('pty/resize', p),
);
// The renderer asks for a repaint of a session that predates it — a GUI
// reopened onto a daemon that kept the session alive. The daemon answers on
// the event stream so the replay is ordered against live output.
ipcMain.handle('pty:replay', (_e, id: string) =>
  daemon.request('pty/replay', id),
);
// The deliberate way to end everything: kills every session, then the
// daemon itself. Without this there would be orphaned agents with no UI
// left to reclaim them.
ipcMain.handle('daemon:stop', () => daemon.request('daemon/stop'));
app.on('ready', async () => {
  app.setAboutPanelOptions({
    applicationName: 'Sertum',
    applicationVersion: app.getVersion(),
    credits: 'One window for every coding agent you have running.',
  });

  // Join the daemon, or start one. The window opens either way: a fabric
  // that failed to come up presents as an empty session list plus a console
  // trail, not as an app that never appears.
  try {
    await daemon.ensure();
  } catch (err) {
    console.error('[sertum] could not reach sertumd:', err);
  }

  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});


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
  // Disconnect, nothing more. Sessions belong to the daemon now, so the
  // quit-drain dance this function used to perform — and the node-pty
  // teardown crash it existed to dodge — left this process with the PTYs.
  daemon.dispose();
}

app.on('before-quit', () => shutdown());

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
  // The radio ticks have to start where the stored layout is, or the menu
  // disagrees with the window until the user opens the picker.
  const layout = getSettings().paneLayout;

  const appMenu: Electron.MenuItemConstructorOptions = {
    label: 'Sertum',
    submenu: [
      { role: 'about', label: 'About Sertum' },
      { type: 'separator' },
      {
        label: 'Settings…',
        accelerator: accel('settings'),
        click: send('menu:settings'),
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
          accelerator: accel('new-session'),
          click: send('menu:new-session'),
        },
        { type: 'separator' },
        { label: 'Add Repository…', enabled: false },
        {
          label: 'Import Running Sessions…',
          click: send('menu:import-sessions'),
        },
        // Worktrees outlive the sessions that used them, so the manager has
        // to be reachable with nothing open -- the row menu alone would hide
        // it behind the very session you just closed.
        {
          label: 'Worktree Manager…',
          accelerator: accel('worktrees'),
          click: send('menu:worktrees'),
        },
        // macOS keeps Settings in the app menu; every other platform has no
        // app menu, so File is where it belongs and where Ctrl+, is bound.
        ...(isMac
          ? []
          : ([
              { type: 'separator' },
              {
                label: 'Settings…',
                accelerator: accel('settings'),
                click: send('menu:settings'),
              },
            ] as Electron.MenuItemConstructorOptions[])),
        { type: 'separator' },
        {
          id: 'file-close-tab',
          label: 'Close Tab',
          accelerator: accel('close-tab'),
          click: send('menu:close-tab'),
          enabled: false,
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
        {
          id: 'session-rename',
          label: 'Rename…',
          click: send('menu:rename'),
          enabled: false,
        },
        { type: 'separator' },
        {
          id: 'session-interrupt',
          label: 'Interrupt Turn',
          accelerator: accel('interrupt'),
          click: send('menu:interrupt'),
          enabled: false,
        },
        {
          id: 'session-stop',
          label: 'Stop Session',
          click: send('menu:stop'),
          enabled: false,
        },
        { type: 'separator' },
        // Moving between sessions is a property of the list, not of any
        // agent, so these behave identically for Claude, Codex and a shell.
        {
          id: 'session-next',
          label: 'Next Session',
          accelerator: accel('next-session'),
          click: send('menu:next-session'),
          enabled: false,
        },
        {
          id: 'session-prev',
          label: 'Previous Session',
          accelerator: accel('prev-session'),
          click: send('menu:prev-session'),
          enabled: false,
        },
        {
          id: 'session-goto',
          label: 'Go to Session',
          enabled: false,
          submenu: Array.from({ length: 9 }, (_, i) => ({
            id: `session-goto-${i + 1}`,
            label: `Session ${i + 1}`,
            accelerator: `CmdOrCtrl+${i + 1}`,
            click: send(`menu:goto-session-${i + 1}`),
            enabled: false,
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
          accelerator: accel('palette'),
          click: send('menu:palette'),
        },
        { type: 'separator' },
        // Design section 07. The radio set mirrors the layout picker, and the
        // accelerators live here rather than in the renderer so they keep
        // working while focus is inside a terminal -- a keystroke the renderer
        // would have to intercept is a keystroke the agent's TUI never sees.
        {
          label: 'Pane Layout…',
          accelerator: accel('layout-picker'),
          click: send('menu:layout-picker'),
        },
        {
          label: 'Layout',
          submenu: [
            {
              label: 'Single',
              type: 'radio',
              checked: layout === 'single',
              accelerator: 'CmdOrCtrl+Alt+1',
              click: send('menu:layout-single'),
            },
            {
              label: 'Columns',
              type: 'radio',
              checked: layout === 'columns',
              accelerator: 'CmdOrCtrl+Alt+2',
              click: send('menu:layout-columns'),
            },
            {
              label: 'Rows',
              type: 'radio',
              checked: layout === 'rows',
              accelerator: 'CmdOrCtrl+Alt+3',
              click: send('menu:layout-rows'),
            },
            {
              label: 'Grid',
              type: 'radio',
              checked: layout === 'grid',
              accelerator: 'CmdOrCtrl+Alt+4',
              click: send('menu:layout-grid'),
            },
          ],
        },
        {
          label: 'Panes',
          submenu: [
            {
              label: 'Split Focused Pane Right',
              accelerator: accel('split-right'),
              click: send('menu:split-right'),
            },
            {
              label: 'Split Focused Pane Down',
              accelerator: accel('split-down'),
              click: send('menu:split-down'),
            },
            { type: 'separator' },
            {
              label: 'Maximise Focused Pane',
              accelerator: accel('maximise-pane'),
              click: send('menu:maximise-pane'),
            },
            {
              label: 'Close Focused Pane',
              accelerator: accel('close-pane'),
              click: send('menu:close-pane'),
            },
            {
              label: 'Reset Pane Sizes',
              accelerator: accel('reset-panes'),
              click: send('menu:reset-panes'),
            },
            { type: 'separator' },
            // Design notes 249, 257 and 263: one binding per direction, which
            // a two-pane layout answers on its own axis only.
            {
              label: 'Focus Pane Left',
              accelerator: accel('focus-pane-left'),
              click: send('menu:focus-pane-left'),
            },
            {
              label: 'Focus Pane Right',
              accelerator: accel('focus-pane-right'),
              click: send('menu:focus-pane-right'),
            },
            {
              label: 'Focus Pane Up',
              accelerator: accel('focus-pane-up'),
              click: send('menu:focus-pane-up'),
            },
            {
              label: 'Focus Pane Down',
              accelerator: accel('focus-pane-down'),
              click: send('menu:focus-pane-down'),
            },
          ],
        },
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

/**
 * Greys out the commands that have nothing to act on.
 *
 * Every session command is a no-op without a session, and the renderer's
 * handlers already guard on that -- so before this the whole Session menu
 * looked live with nothing open and silently did nothing when clicked, which
 * is the one thing a menu must never do. Items are built disabled and enabled
 * from here, so there is no flash of a live-looking menu at startup either.
 *
 * Toggling the built items rather than rebuilding the menu: a rebuild on every
 * session event would run hundreds of times during a single turn, and the
 * renderer only sends this when the answer actually changes.
 */
function applyMenuState(state: MenuState): void {
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  const set = (id: string, enabled: boolean) => {
    const item = menu.getMenuItemById(id);
    if (item) item.enabled = enabled;
  };

  set('file-close-tab', state.hasActive);
  set('session-rename', state.hasActive);
  // Interrupting or stopping needs a live process, not merely a selected row.
  set('session-interrupt', state.activeRunning);
  set('session-stop', state.activeRunning);
  // With one session, next and previous both land back on it.
  set('session-next', state.count > 1);
  set('session-prev', state.count > 1);
  set('session-goto', state.gotoLimit > 0);
  for (let n = 1; n <= 9; n += 1) set(`session-goto-${n}`, n <= state.gotoLimit);
}
