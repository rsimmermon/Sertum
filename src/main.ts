import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { PtyManager } from './main/pty-manager';
import { defaultCwd, inspectDirectory } from './main/workspace';
import { HookServer } from './main/hook-server';
import { buildClaudeSettings, mapClaudeHook } from './main/adapters/claude';
import type { PtySize, SessionSpec } from './shared/types';

if (started) app.quit();

// Opt-in remote debugging, so the app can be driven and verified headlessly
// (CI, cross-platform smoke checks) without shipping a debug build.
if (process.env.AGENTSTATION_DEBUG_PORT) {
  app.commandLine.appendSwitch(
    'remote-debugging-port',
    process.env.AGENTSTATION_DEBUG_PORT,
  );
}

const hooks = new HookServer();

/**
 * Plane 2 wiring for Claude Code: every session is spawned pointing its hooks
 * at its own endpoint, so status comes from the agent telling us rather than
 * from watching its output.
 */
const ptys = new PtyManager((id, spec) => {
  if (spec.agent !== 'claude' || !hooks.port) return {};
  return {
    args: [...spec.args, '--settings', buildClaudeSettings(hooks.urlFor(id))],
  };
});

hooks.on('hook', ({ sessionId, event, payload }) => {
  const update = mapClaudeHook(event, payload);
  if (update.status || update.activity) ptys.applyUpdate(sessionId, update);
});
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

ipcMain.handle('session:create', (_e, spec: Partial<SessionSpec>) =>
  ptys.create(spec),
);
ipcMain.handle('session:list', () => ptys.list());
ipcMain.handle('session:kill', (_e, id: string) => ptys.kill(id));
ipcMain.handle('session:remove', (_e, id: string) => ptys.remove(id));
ipcMain.handle('workspace:default-cwd', () => defaultCwd());
ipcMain.handle('adapters:status', () => ({
  claude: { connected: hooks.port > 0, port: hooks.port, events: hooks.eventCount },
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
  try {
    const port = await hooks.start();
    console.log(`[agentstation] hook endpoint on 127.0.0.1:${port}`);
  } catch (err) {
    // Without hooks the app still runs; status falls back to process
    // lifecycle only, which is worth saying out loud rather than hiding.
    console.error('[agentstation] hook server failed to start:', err);
  }
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  ptys.disposeAll();
  void hooks.stop();
});

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

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([{ role: 'appMenu' }] as Electron.MenuItemConstructorOptions[])
      : []),
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
        { label: 'Import Running Sessions…', enabled: false },
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
        { label: 'Rename…', enabled: false },
        { type: 'separator' },
        {
          label: 'Interrupt Turn',
          accelerator: 'CmdOrCtrl+.',
          click: send('menu:interrupt'),
        },
        { label: 'Stop Session', click: send('menu:stop') },
        { type: 'separator' },
        { label: 'Session Info', accelerator: 'CmdOrCtrl+I', enabled: false },
      ],
    },
    {
      label: 'View',
      submenu: [
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
