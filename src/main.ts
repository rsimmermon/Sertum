import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  shell,
} from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { PtyManager } from './main/pty-manager';
import { defaultCwd, inspectDirectory } from './main/workspace';
import { HookServer } from './main/hook-server';
import {
  buildClaudeSettings,
  mapClaudeHook,
  type StatusUpdate,
} from './main/adapters/claude';
import {
  CodexAppServer,
  reapStrayAppServers,
  recordAppServer,
  resolveCodexBinary,
} from './main/adapters/codex-app-server';
import { createAgentAdapters } from './main/adapters/agent-adapter';
import { hydrateLoginEnv } from './main/login-env';
import {
  provisionWorktree,
  readWorktrees,
  removeWorktree,
} from './main/worktrees';
import { getSettings, setSettings } from './main/settings';
import { readClipboardPaste } from './main/clipboard-paste';
import {
  isUserThread,
  mapCodexStatus,
  threadSummary,
  type CodexThread,
  type CodexThreadStatus,
} from './main/adapters/codex';
import { discoverSessions } from './main/adapters/discovery';
import { mapGrokEvent } from './main/adapters/grok';
import {
  GrokEventLog,
  type GrokEventArrival,
} from './main/adapters/grok-event-log';
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
  BinaryDetection,
  ManagedAgent,
  MenuState,
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
const codex = new CodexAppServer(
  () => getSettings().agentBinaryPaths.codex || resolveCodexBinary(),
);

/**
 * Plane 2 wiring for Grok: it pushes nothing, but it writes a structured
 * event log per session and lets us name the session before it starts, so
 * following that log is attributable to exactly one pane.
 */
const grokEvents = new GrokEventLog();

/**
 * The Grok session id minted for a spawn that has not happened yet.
 *
 * The id has to be chosen while the argument list is being built, which is
 * before node-pty is asked for a process -- so binding the log there would
 * leave a watcher polling for a session that never started every time a spawn
 * fails. One slot rather than a map: `create` is synchronous, so at most one
 * spawn is ever mid-flight, and the id check on collection means a spawn that
 * threw can never have its leftover claimed by the next session.
 */
let mintedGrokSession: { sessionId: string; grokSessionId: string } | null = null;

/**
 * One implementation per agent of everything the UI can ask of a session.
 * Callers below look an agent up here rather than switching on its kind.
 */
const agentAdapters = createAgentAdapters({ codex, claudeControl: hooks });

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
  const adapter = agentAdapters.get(spec.agent);
  const remoteArgs =
    spec.remoteControl && adapter?.capabilities['remote-control'].ok
      ? adapter.remoteControlArgs(spec.label)
      : [];
  const args = [...spec.args, ...remoteArgs];

  if (spec.agent === 'claude' && hooks.port) {
    return {
      args: [...args, '--settings', buildClaudeSettings(hooks.urlFor(id))],
      adapterBound: true,
    };
  }

  // `-C` rather than the PTY's cwd: with `--remote` the thread's working
  // directory comes from the app server's process, not the terminal's, so
  // without this every session would silently run in Sertum's folder.
  if (spec.agent === 'codex' && codex.connected) {
    awaitingThread.push({ id, cwd: spec.cwd });
    return {
      args: [...args, '--remote', codex.remoteUrl, '-C', spec.cwd],
      adapterBound: true,
    };
  }

  // Grok has no way to be told where to report, but `--session-id` lets us
  // name the session up front -- which is the same property the per-session
  // hook URL buys for Claude, arrived at from the other direction.
  if (spec.agent === 'grok') {
    const grokSessionId = randomUUID();
    mintedGrokSession = { sessionId: id, grokSessionId };
    return {
      args: [...args, '--session-id', grokSessionId],
      adapterBound: true,
    };
  }

  return remoteArgs.length ? { args } : {};
});

grokEvents.on('events', (arrival: GrokEventArrival) => {
  const { sessionId, grokSessionId, events } = arrival;

  // One update per batch. Grok emits hundreds of records a turn and most
  // carry no news; more to the point, an auto-approved tool asks and is
  // granted within the same millisecond, so applying each in turn would flash
  // "approval needed" for a permission nobody was ever asked about. The last
  // word in a batch is the one still true. See GrokEventArrival.
  const folded: StatusUpdate = {};
  let model: string | undefined;
  for (const event of events) {
    const update = mapGrokEvent(event);
    if (update.status) folded.status = update.status;
    if (update.activity) folded.activity = update.activity;
    // turn_started opens every turn and names the model, so a Grok pane
    // learns what it is running from the agent itself rather than from a
    // config file that may not describe this session.
    if (typeof event.model_id === 'string') model = event.model_id;
  }

  if (folded.status || folded.activity) ptys.applyUpdate(sessionId, folded);
  ptys.applyMeta(sessionId, { externalId: grokSessionId, model });
});

/** Thread id -> session id, for routing later status changes. */
const threadToSession = new Map<string, string>();
/** Sertum session id -> active Codex turn id. */
const activeCodexTurns = new Map<string, string>();

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

  if (method === 'turn/started') {
    const turn = (params.turn ?? {}) as { id?: unknown };
    if (typeof turn.id === 'string') activeCodexTurns.set(sessionId, turn.id);
    return;
  }

  if (method === 'turn/completed') {
    activeCodexTurns.delete(sessionId);
    return;
  }

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

ipcMain.on('menu:state', (_e, state: MenuState) => applyMenuState(state));

ptys.on('data', (e) => broadcast('pty:data', e));
ptys.on('exit', (e) => {
  grokEvents.unbind(e.id);
  hooks.clearControl(e.id);
  activeCodexTurns.delete(e.id);
  for (const [threadId, sessionId] of threadToSession) {
    if (sessionId === e.id) threadToSession.delete(threadId);
  }
  broadcast('pty:exit', e);
});
ptys.on('session-updated', (s) => broadcast('session:updated', s));

ipcMain.handle('session:create', (_e, spec: Partial<SessionSpec>) => {
  // Resolve the agent's binary here rather than trusting PATH: a packaged app
  // launched from Finder has only the bare launchd PATH, and a bare `claude`
  // would exit immediately.
  const snapshot = ptys.create({
    ...spec,
    command: resolvedCommand(spec.agent, spec.command),
  });
  // The spawn succeeded, so there is now a process whose log is worth
  // following. See mintedGrokSession.
  if (mintedGrokSession?.sessionId === snapshot.id) {
    grokEvents.bind(snapshot.id, mintedGrokSession.grokSessionId);
    mintedGrokSession = null;
  }

  // Claude never reports its model on a live session, so record what its
  // configuration says it will use.
  const model = readConfiguredModel(snapshot.agent);
  if (model) ptys.applyMeta(snapshot.id, { model });
  return { ...snapshot, model: model ?? snapshot.model };
});
ipcMain.handle('session:list', () => ptys.list());
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
  new Map(ptys.list().map((s) => [s.id, s.cwd]));

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
ipcMain.handle('shell:reveal', (_e, target: string) => {
  shell.showItemInFolder(target);
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
ipcMain.handle('session:kill', (_e, id: string) => ptys.kill(id));
ipcMain.handle(
  'session:steer',
  async (_e, { id, text }: { id: string; text: string }) => {
    const session = ptys.get(id);
    const adapter = session && agentAdapters.get(session.agent);
    const guidance = text.trim();
    if (!session || !adapter?.capabilities['turn-steer'].ok || !guidance) {
      return false;
    }
    const accepted = await adapter.steerTurn(
      {
        id,
        externalId: session.externalId,
        activeTurnId: activeCodexTurns.get(id) ?? null,
        cwd: session.cwd,
      },
      guidance,
    );
    if (accepted) {
      ptys.applyUpdate(id, { activity: 'guidance accepted' });
    } else {
      ptys.applyUpdate(id, { activity: 'could not steer — no active turn' });
    }
    return accepted;
  },
);
ipcMain.handle('session:interrupt-turn', async (_e, id: string) => {
  const session = ptys.get(id);
  const adapter = session && agentAdapters.get(session.agent);
  if (!session || !adapter?.capabilities['turn-interrupt'].ok) return false;
  const accepted = await adapter.interruptTurn({
    id,
    externalId: session.externalId,
    activeTurnId: activeCodexTurns.get(id) ?? null,
    cwd: session.cwd,
  });
  if (accepted) ptys.applyUpdate(id, { activity: 'interrupting…' });
  else ptys.applyUpdate(id, { activity: 'could not interrupt — no active turn' });
  return accepted;
});
ipcMain.handle(
  'session:tool-gate',
  async (_e, { id, paused }: { id: string; paused: boolean }) => {
    const session = ptys.get(id);
    const adapter = session && agentAdapters.get(session.agent);
    if (!session || !adapter?.capabilities['tool-gate'].ok) return false;
    const accepted = await adapter.setToolGate(
      {
        id,
        externalId: session.externalId,
        activeTurnId: activeCodexTurns.get(id) ?? null,
        cwd: session.cwd,
      },
      paused,
    );
    return accepted && ptys.setToolsPaused(id, paused);
  },
);
ipcMain.handle(
  'session:rename',
  (_e, { id, label }: { id: string; label: string }) => {
    const stored = ptys.rename(id, label);
    if (stored === null) return null;
    const session = ptys.get(id);
    const adapter = session && agentAdapters.get(session.agent);
    // Only an agent that declared the capability is asked. A declining one
    // has already said why, and the sidebar showed it before the edit began.
    if (session && adapter?.capabilities['rename-remote'].ok) {
      // Not awaited: the local name is authoritative and already applied, so
      // the rename must not wait on an agent that may be slow or gone.
      void adapter.renameRemote(
        {
          id,
          externalId: session.externalId,
          activeTurnId: activeCodexTurns.get(id) ?? null,
          cwd: session.cwd,
        },
        stored,
      );
    }
    return stored;
  },
);
ipcMain.handle('session:remove', (_e, id: string) => ptys.remove(id));
ipcMain.handle('workspace:default-cwd', () => defaultCwd());
ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
  const before = getSettings().paneLayout;
  const stored = setSettings(patch);
  // The View menu carries the layout radio set, so it has to be rebuilt when
  // the layout is changed from anywhere else -- the picker, a shortcut, or a
  // pane close collapsing back to Single.
  if (stored.paneLayout !== before) buildMenu();
  return stored;
});
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

// Declared once per adapter and fixed for the app's life; the renderer reads
// them at startup so the UI can say what an agent cannot do before trying.
ipcMain.handle('agent:capabilities', () =>
  Object.fromEntries(
    [...agentAdapters].map(([agent, adapter]) => [agent, adapter.capabilities]),
  ),
);
ipcMain.handle('adapters:status', () => ({
  claude: {
    connected: hooks.port > 0,
    port: hooks.port,
    events: hooks.eventCount,
    binaryFound: binaryFound('claude'),
  },
  codex: {
    connected: codex.connected,
    url: codex.connected ? codex.remoteUrl : '',
    events: codex.eventCount,
    binaryFound: binaryFound('codex'),
  },
  grok: {
    watching: grokEvents.watching,
    events: grokEvents.eventCount,
    binaryFound: binaryFound('grok'),
  },
}));
ipcMain.handle(
  'agent:detect',
  (_e, agent: ManagedAgent): BinaryDetection => {
    // Auto-detection only -- a saved override is deliberately not consulted
    // here, so this always answers "what would Sertum find on its own?",
    // which is what both the Settings "Detect" button and validating a
    // freshly-typed path need.
    const candidate = agentAdapters.get(agent)?.resolveBinary();
    if (!candidate) return { path: null };
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return { path: candidate };
    } catch {
      // A bare command name (the last-resort fallback every adapter returns)
      // is not a path fs can confirm -- nothing was actually found.
      return { path: null };
    }
  },
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
    if (up && codex.serverPid !== null) {
      recordAppServer(appServerRecordFile(), {
        ownerPid: process.pid,
        serverPid: codex.serverPid,
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
  // A saved override always wins over auto-detection: it exists precisely for
  // the case where detection guessed wrong, so it must not be second-guessed.
  if (agent !== 'shell') {
    const override = getSettings().agentBinaryPaths[agent];
    if (override) return override;
  }
  return agentAdapters.get(agent)?.resolveBinary();
}

/**
 * Whether `resolvedCommand(agent)` currently points at a real, executable
 * file -- override or auto-detected, doesn't matter which. Shared by the
 * status bar (`adapters:status`) and the Settings "Detect" affordance
 * (`agent:detect`), so both report exactly the same fact.
 */
function binaryFound(agent: ManagedAgent): boolean {
  const cmd = resolvedCommand(agent);
  if (!cmd) return false;
  try {
    fs.accessSync(cmd, fs.constants.X_OK);
    return true;
  } catch {
    // Either nothing was found (the adapter fell back to a bare command name,
    // which is not a path fs can check) or an override points at nothing.
    return false;
  }
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
  grokEvents.stopAll();
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
        accelerator: 'CmdOrCtrl+,',
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
          accelerator: 'CmdOrCtrl+N',
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
          accelerator: 'CmdOrCtrl+Shift+W',
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
                accelerator: 'CmdOrCtrl+,',
                click: send('menu:settings'),
              },
            ] as Electron.MenuItemConstructorOptions[])),
        { type: 'separator' },
        {
          id: 'file-close-tab',
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
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
          accelerator: 'CmdOrCtrl+.',
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
          accelerator: 'CmdOrCtrl+Shift+]',
          click: send('menu:next-session'),
          enabled: false,
        },
        {
          id: 'session-prev',
          label: 'Previous Session',
          accelerator: 'CmdOrCtrl+Shift+[',
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
          accelerator: 'CmdOrCtrl+K',
          click: send('menu:palette'),
        },
        { type: 'separator' },
        // Design section 07. The radio set mirrors the layout picker, and the
        // accelerators live here rather than in the renderer so they keep
        // working while focus is inside a terminal -- a keystroke the renderer
        // would have to intercept is a keystroke the agent's TUI never sees.
        {
          label: 'Pane Layout…',
          accelerator: 'CmdOrCtrl+Alt+L',
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
              accelerator: 'CmdOrCtrl+Alt+D',
              click: send('menu:split-right'),
            },
            {
              label: 'Split Focused Pane Down',
              accelerator: 'CmdOrCtrl+Alt+Shift+D',
              click: send('menu:split-down'),
            },
            { type: 'separator' },
            {
              label: 'Maximise Focused Pane',
              accelerator: 'CmdOrCtrl+Alt+Return',
              click: send('menu:maximise-pane'),
            },
            {
              label: 'Close Focused Pane',
              accelerator: 'CmdOrCtrl+Alt+W',
              click: send('menu:close-pane'),
            },
            {
              label: 'Reset Pane Sizes',
              accelerator: 'CmdOrCtrl+Alt+0',
              click: send('menu:reset-panes'),
            },
            { type: 'separator' },
            // Design notes 249, 257 and 263: one binding per direction, which
            // a two-pane layout answers on its own axis only.
            {
              label: 'Focus Pane Left',
              accelerator: 'CmdOrCtrl+Alt+Left',
              click: send('menu:focus-pane-left'),
            },
            {
              label: 'Focus Pane Right',
              accelerator: 'CmdOrCtrl+Alt+Right',
              click: send('menu:focus-pane-right'),
            },
            {
              label: 'Focus Pane Up',
              accelerator: 'CmdOrCtrl+Alt+Up',
              click: send('menu:focus-pane-up'),
            },
            {
              label: 'Focus Pane Down',
              accelerator: 'CmdOrCtrl+Alt+Down',
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
