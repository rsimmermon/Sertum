import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { agentSafeEnv, PtyManager } from '../main/pty-manager';
import { ClaudeChatHost } from '../main/adapters/claude-chat';
import { HookServer } from '../main/hook-server';
import { hydrateLoginEnv } from '../main/login-env';
import {
  buildClaudeSettings,
  mapClaudeHook,
  type StatusUpdate,
} from '../main/adapters/claude';
import {
  isUserThread,
  mapCodexStatus,
  threadSummary,
  type CodexThread,
  type CodexThreadStatus,
} from '../main/adapters/codex';
import {
  CodexAppServer,
  reapStrayAppServers,
  recordAppServer,
  resolveCodexBinary,
} from '../main/adapters/codex-app-server';
import { discoverSessions } from '../main/adapters/discovery';
import { mapGrokEvent } from '../main/adapters/grok';
import {
  GrokEventLog,
  type GrokEventArrival,
} from '../main/adapters/grok-event-log';
import {
  readConfiguredModel,
  readSessionMeta,
} from '../main/adapters/session-meta';
import {
  noConversation,
  readConversation,
} from '../main/adapters/conversation';
import {
  findTranscriptForCwd,
  findTranscriptForSession,
} from '../main/adapters/transcript';
import { createAgentAdapters } from '../main/adapters/agent-adapter';
import {
  addRule,
  evaluate,
  getRules,
  removeRule,
  setRulesDir,
  subjectOf,
} from '../main/permission-rules';
import {
  DEFAULT_SETTINGS,
  type AgentKind,
  type ApprovalAnswer,
  type BinaryDetection,
  type DiscoveredSession,
  type ManagedAgent,
  type PermissionRule,
  type PtySize,
  type SessionSnapshot,
  type SessionSpec,
  type SessionStatus,
} from '../shared/types';

/**
 * The session fabric — everything Sertum knows about running agents, moved
 * out of the Electron main process so sessions are not children of a window.
 * This is stage 3 of BROKER-HANDOFF.md made literal: the code here is the
 * fabric main.ts used to host, re-homed rather than redesigned, and the GUI
 * reaches it over the socket protocol instead of module scope.
 *
 * The fabric knows nothing about Electron, windows or notifications. Its
 * outputs are events (`session:updated`, `pty:data`, `approval:needed`, …)
 * and its inputs are requests dispatched by name — the same shapes the
 * renderer always consumed, which is what let the GUI become a proxy without
 * the renderer changing.
 */

/** The slice of Settings the fabric acts on, pushed by the GUI as it changes. */
export interface FabricSettings {
  approvalsInApp: boolean;
  agentBinaryPaths: Record<ManagedAgent, string>;
}

export interface Fabric {
  start(): Promise<void>;
  /** Kill every session and stop every adapter. The daemon's own quit. */
  shutdown(): void;
  handle(method: string, params: unknown): unknown;
  onEvent(cb: (name: string, payload: unknown) => void): void;
}

export function createFabric(opts: { userDataDir: string }): Fabric {
  const { userDataDir } = opts;
  setRulesDir(userDataDir);

  let settings: FabricSettings = {
    approvalsInApp: DEFAULT_SETTINGS.approvalsInApp,
    agentBinaryPaths: { ...DEFAULT_SETTINGS.agentBinaryPaths },
  };

  const listeners: Array<(name: string, payload: unknown) => void> = [];
  const emit = (name: string, payload: unknown) => {
    for (const cb of listeners) cb(name, payload);
  };

  const hooks = new HookServer();

  /**
   * "Allow this session" from B5. Deliberately not a rule: it is remembered
   * only while the daemon lives, and is dropped with the session, so an
   * approval given to one run cannot silently govern the next.
   */
  const sessionAllows = new Map<string, Set<string>>();

  hooks.evaluatePermission = (sessionId, payload) => {
    const session = ptys.get(sessionId);
    if (!session) return null;
    const input =
      payload.tool_input && typeof payload.tool_input === 'object'
        ? (payload.tool_input as Record<string, unknown>)
        : {};
    const tool = String(payload.tool_name ?? '');
    const subject = subjectOf(tool, input);

    if (sessionAllows.get(sessionId)?.has(`${tool}\u0000${subject}`)) {
      return { decision: 'allow', reason: 'Allowed for this session in Sertum.' };
    }

    const result = evaluate(tool, input, session.cwd);
    if (result.decision === 'ask') {
      return { decision: 'ask', subject, ruled: result.rule !== null };
    }
    return {
      decision: result.decision,
      reason: `${result.decision === 'deny' ? 'Denied' : 'Allowed'} by a Sertum permission rule: ${result.rule?.pattern ?? '*'}`,
    };
  };

  hooks.onApprovalGone = (id) => emit('approval:gone', id);

  /**
   * B5 is opt-outable, and the switch is the presence of the handler: with
   * no handler the hook server never holds a call at all.
   */
  function syncApprovalHandler(): void {
    hooks.onApprovalNeeded = settings.approvalsInApp
      ? (request) => {
          // Claude said it needs a decision by firing PermissionRequest, so
          // this is plane 2 speaking, not a guess about pixels.
          ptys.applyUpdate(request.sessionId, {
            status: 'needs-input',
            activity: `approve ${request.tool}?`,
          });
          emit('approval:needed', request);
        }
      : undefined;
  }

  const codex = new CodexAppServer(
    () => settings.agentBinaryPaths.codex || resolveCodexBinary(),
  );
  const grokEvents = new GrokEventLog();

  /** See the note on the original in main.ts history: one spawn in flight. */
  let mintedGrokSession: { sessionId: string; grokSessionId: string } | null =
    null;

  const agentAdapters = createAgentAdapters({ codex, claudeControl: hooks });

  /** Codex sessions awaiting their thread, oldest first. */
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
        args: [
          ...args,
          '--settings',
          buildClaudeSettings(hooks.urlFor(id), hooks.approvalTimeoutMs),
        ],
        adapterBound: true,
      };
    }

    if (spec.agent === 'codex' && codex.connected) {
      awaitingThread.push({ id, cwd: spec.cwd });
      return {
        args: [...args, '--remote', codex.remoteUrl, '-C', spec.cwd],
        adapterBound: true,
      };
    }

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

  syncApprovalHandler();

  // ------------------------------------------------------- stream sessions

  const claudeChat = new ClaudeChatHost();
  claudeChat.on('update', ({ id, status, activity }) =>
    ptys.applyUpdate(id, { status, activity }),
  );
  claudeChat.on('init', ({ id, sessionId, model }) =>
    ptys.applyMeta(id, { externalId: sessionId, model }),
  );
  claudeChat.on('exit', ({ id, exitCode }) => ptys.markExited(id, exitCode));

  function createConversationSession(
    spec: Partial<SessionSpec>,
  ): SessionSnapshot {
    const id = randomUUID();
    const externalId = randomUUID();
    const cwd = spec.cwd ?? process.cwd();
    const command = resolvedCommand('claude', spec.command);
    if (!command) throw new Error('Claude Code binary not found');
    const args = [
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--session-id',
      externalId,
      ...(hooks.port
        ? [
            '--settings',
            buildClaudeSettings(hooks.urlFor(id), hooks.approvalTimeoutMs),
          ]
        : []),
    ];

    const pid = claudeChat.spawn(id, {
      command,
      args,
      cwd,
      env: { ...agentSafeEnv(), SERTUM_SESSION_ID: id },
    });
    if (pid === null) {
      throw new Error(`Could not start ${command} for a conversation session`);
    }

    const snapshot = ptys.registerStream({
      id,
      label: spec.label ?? 'conversation',
      agent: 'claude',
      cwd,
      command,
      args,
      pid,
      externalId,
      controls: {
        kill: () => claudeChat.kill(id),
        terminate: (graceMs) => claudeChat.terminate(id, graceMs),
      },
    });
    const model = readConfiguredModel('claude');
    if (model) ptys.applyMeta(id, { model });
    return snapshot;
  }

  // --------------------------------------------------- background sessions

  async function createBackgroundSession(
    spec: Partial<SessionSpec>,
  ): Promise<SessionSnapshot> {
    const command = resolvedCommand('claude', spec.command);
    if (!command) throw new Error('Claude Code binary not found');
    const cwd = spec.cwd ?? process.cwd();
    const label = spec.label?.trim() || 'background session';

    const announced = await runClaude(command, ['--bg', '-n', label], cwd);
    const short = /backgrounded · ([0-9a-f]{4,})/.exec(announced)?.[1];
    if (!short) {
      throw new Error(
        `claude --bg did not announce a session id: ${announced.slice(0, 200)}`,
      );
    }

    let externalId: string | null = null;
    for (let attempt = 0; attempt < 5 && !externalId; attempt += 1) {
      try {
        const roster = JSON.parse(
          await runClaude(command, ['agents', '--json'], cwd),
        ) as Array<{ id?: string; sessionId?: string }>;
        externalId = roster.find((row) => row.id === short)?.sessionId ?? null;
      } catch {
        // Retry below.
      }
      if (!externalId) await new Promise((r) => setTimeout(r, 700));
    }

    return ptys.create(
      {
        label,
        agent: 'claude',
        cwd,
        command,
        args: ['attach', short],
        background: true,
      },
      { origin: 'attached', externalId: externalId ?? short },
    );
  }

  function runClaude(
    command: string,
    args: string[],
    cwd: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        { cwd, env: agentSafeEnv(), timeout: 30_000, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) reject(new Error(stderr.trim() || err.message));
          else resolve(stdout);
        },
      );
    });
  }

  // ------------------------------------------------------- adapter wiring

  grokEvents.on('events', (arrival: GrokEventArrival) => {
    const { sessionId, grokSessionId, events } = arrival;
    const folded: StatusUpdate = {};
    let model: string | undefined;
    for (const event of events) {
      const update = mapGrokEvent(event);
      if (update.status) folded.status = update.status;
      if (update.activity) folded.activity = update.activity;
      if (typeof event.model_id === 'string') model = event.model_id;
    }
    if (folded.status || folded.activity) ptys.applyUpdate(sessionId, folded);
    ptys.applyMeta(sessionId, { externalId: grokSessionId, model });
  });

  const threadToSession = new Map<string, string>();
  const activeCodexTurns = new Map<string, string>();

  codex.on('notification', ({ method, params }) => {
    if (method === 'thread/started') {
      const thread = (params.thread ?? {}) as CodexThread;
      if (!thread.id || !isUserThread(thread)) return;
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
    if (method === 'thread/name/updated') {
      const name = threadSummary({ id: threadId!, name: params.threadName as string });
      if (name) ptys.applyUpdate(sessionId, { activity: name });
    }
  });

  codex.on('log', (line: string) => console.warn('[codex]', line));

  hooks.on('hook', ({ sessionId, event, payload }) => {
    const update = mapClaudeHook(event, payload);
    if (update.status || update.activity) ptys.applyUpdate(sessionId, update);

    const transcript = payload.transcript_path;
    const effort = (payload.effort as { level?: string } | undefined)?.level;
    if (typeof transcript === 'string' || effort) {
      ptys.applyMeta(sessionId, {
        transcriptPath: typeof transcript === 'string' ? transcript : undefined,
        effort: effort ?? undefined,
      });
    }
  });

  ptys.on('data', (e) => emit('pty:data', e));
  ptys.on('exit', (e: { id: string; exitCode: number }) => {
    grokEvents.unbind(e.id);
    hooks.clearControl(e.id);
    activeCodexTurns.delete(e.id);
    for (const [threadId, sessionId] of threadToSession) {
      if (sessionId === e.id) threadToSession.delete(threadId);
    }
    sessionAllows.delete(e.id);
    emit('pty:exit', e);
  });
  ptys.on('session-updated', (s) => emit('session:updated', s));

  // ------------------------------------------------------------- polling

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

  let monitorTimer: NodeJS.Timeout | null = null;
  function startMonitorPolling() {
    if (monitorTimer) return;
    monitorTimer = setInterval(async () => {
      const watched = ptys
        .list()
        .filter(
          (s) =>
            (s.origin === 'monitored' || s.origin === 'attached') &&
            s.externalId,
        );
      if (watched.length === 0) return;
      const found = await discoverSessions(new Set(), resolvedCommand);
      ptys.syncMonitored(
        found.map((f: { sessionId: string; status: SessionStatus }) => ({
          externalId: f.sessionId,
          status: f.status,
        })),
      );
    }, 3000);
  }

  function transcriptFor(s: SessionSnapshot): string | null {
    if (s.transcriptPath) return s.transcriptPath;

    if (s.origin === 'monitored') {
      const sessionId = discoveredSessionId(s.externalId);
      if (s.agent === 'claude' && !sessionId) return null;
      return findTranscriptForSession(s.agent, sessionId, s.cwd);
    }

    if (s.agent === 'shell') return null;

    if (
      (s.transport === 'stream' || s.origin === 'attached') &&
      discoveredSessionId(s.externalId)
    ) {
      return findTranscriptForSession(
        s.agent,
        discoveredSessionId(s.externalId),
        s.cwd,
      );
    }

    if (s.agent === 'claude') return null;
    return findTranscriptForCwd(s.agent, s.cwd, s.startedAt);
  }

  function discoveredSessionId(externalId: string | null): string | null {
    if (!externalId || externalId.startsWith('pid:')) return null;
    return externalId;
  }

  function resolvedCommand(
    agent: AgentKind | undefined,
    explicit?: string,
  ): string | undefined {
    if (explicit) return explicit;
    if (!agent) return undefined;
    if (agent !== 'shell') {
      const override = settings.agentBinaryPaths[agent];
      if (override) return override;
    }
    return agentAdapters.get(agent)?.resolveBinary();
  }

  function binaryFound(agent: ManagedAgent): boolean {
    const cmd = resolvedCommand(agent);
    if (!cmd) return false;
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  const appServerRecordFile = () =>
    path.join(userDataDir, 'codex-app-server.json');

  // ------------------------------------------------------------ requests

  function createSession(spec: Partial<SessionSpec>) {
    if (spec.transport === 'stream') {
      const agent = spec.agent ?? 'claude';
      const answer =
        agentAdapters.get(agent)?.capabilities['structured-conversation'];
      if (!answer?.ok) {
        throw new Error(
          answer && !answer.ok
            ? answer.reason
            : `${agent} has no structured conversation protocol`,
        );
      }
      return createConversationSession(spec);
    }
    if (spec.background) {
      const agent = spec.agent ?? 'claude';
      const answer = agentAdapters.get(agent)?.capabilities['background-host'];
      if (!answer?.ok) {
        throw new Error(
          answer && !answer.ok
            ? answer.reason
            : `${agent} cannot host a session in the background`,
        );
      }
      return createBackgroundSession(spec);
    }
    const snapshot = ptys.create({
      ...spec,
      command: resolvedCommand(spec.agent, spec.command),
    });
    if (mintedGrokSession?.sessionId === snapshot.id) {
      grokEvents.bind(snapshot.id, mintedGrokSession.grokSessionId);
      mintedGrokSession = null;
    }
    const model = readConfiguredModel(snapshot.agent);
    if (model) ptys.applyMeta(snapshot.id, { model });
    return { ...snapshot, model: model ?? snapshot.model };
  }

  function sessionRef(id: string, s: SessionSnapshot) {
    return {
      id,
      externalId: s.externalId,
      activeTurnId: activeCodexTurns.get(id) ?? null,
      cwd: s.cwd,
    };
  }

  const methods: Record<string, (params: never) => unknown> = {
    'settings/apply': (p: Partial<FabricSettings>) => {
      settings = {
        approvalsInApp: p.approvalsInApp ?? settings.approvalsInApp,
        agentBinaryPaths: p.agentBinaryPaths ?? settings.agentBinaryPaths,
      };
      syncApprovalHandler();
      return null;
    },

    'session/create': (spec: Partial<SessionSpec>) => createSession(spec),
    'session/list': () => ptys.list(),
    'session/kill': (id: string) => ptys.kill(id),
    'session/remove': (id: string) => ptys.remove(id),
    'session/rename': (p: { id: string; label: string }) => {
      const stored = ptys.rename(p.id, p.label);
      if (stored === null) return null;
      const session = ptys.get(p.id);
      const adapter = session && agentAdapters.get(session.agent);
      if (session && adapter?.capabilities['rename-remote'].ok) {
        void adapter.renameRemote(sessionRef(p.id, session), stored);
      }
      return stored;
    },
    'session/steer': async (p: { id: string; text: string }) => {
      const session = ptys.get(p.id);
      const adapter = session && agentAdapters.get(session.agent);
      const guidance = p.text.trim();
      if (!session || !adapter?.capabilities['turn-steer'].ok || !guidance) {
        return false;
      }
      const accepted = await adapter.steerTurn(
        sessionRef(p.id, session),
        guidance,
      );
      ptys.applyUpdate(p.id, {
        activity: accepted
          ? 'guidance accepted'
          : 'could not steer — no active turn',
      });
      return accepted;
    },
    'session/interrupt-turn': async (id: string) => {
      const session = ptys.get(id);
      const adapter = session && agentAdapters.get(session.agent);
      if (!session || !adapter?.capabilities['turn-interrupt'].ok) return false;
      const accepted = await adapter.interruptTurn(sessionRef(id, session));
      ptys.applyUpdate(id, {
        activity: accepted
          ? 'interrupting…'
          : 'could not interrupt — no active turn',
      });
      return accepted;
    },
    'session/tool-gate': async (p: { id: string; paused: boolean }) => {
      const session = ptys.get(p.id);
      const adapter = session && agentAdapters.get(session.agent);
      if (!session || !adapter?.capabilities['tool-gate'].ok) return false;
      const accepted = await adapter.setToolGate(
        sessionRef(p.id, session),
        p.paused,
      );
      return accepted && ptys.setToolsPaused(p.id, p.paused);
    },

    'pty/input': (p: { id: string; data: string }) => ptys.write(p.id, p.data),
    'pty/resize': (p: { id: string } & PtySize) =>
      ptys.resize(p.id, { cols: p.cols, rows: p.rows }),
    'pty/replay': (id: string) => {
      // Emitted as an event rather than returned, so it is ordered against
      // the live pty:data stream on the same socket: everything before this
      // frame is inside it, everything after follows it.
      emit('pty:replay', { id, data: ptys.replay(id) });
      return null;
    },

    'chat/send': (p: { id: string; text: string }) => {
      const session = ptys.get(p.id);
      const message = p.text.trim();
      if (!session || session.transport !== 'stream' || !message) return false;
      return claudeChat.send(p.id, message);
    },
    'conversation/read': (id: string) => {
      const session = ptys.get(id);
      if (!session) return noConversation('Session not found.');
      const answer =
        agentAdapters.get(session.agent)?.capabilities['conversation-view'];
      if (answer && !answer.ok) return noConversation(answer.reason);
      const transcript = transcriptFor(session);
      if (!transcript) {
        return noConversation(
          'No transcript yet — the conversation appears once the agent records its first turn.',
        );
      }
      return readConversation(session.agent, transcript);
    },

    'discovery/list': () => discoverSessions(ptys.ownedPids(), resolvedCommand),
    'discovery/attach': (d: DiscoveredSession) =>
      ptys.create(
        {
          label: d.name,
          agent: d.agent,
          cwd: d.cwd || process.cwd(),
          command: resolvedCommand('claude'),
          args: ['attach', d.sessionId],
          background: true,
        },
        { origin: 'attached', externalId: d.sessionId },
      ),
    'discovery/monitor': (d: DiscoveredSession) =>
      ptys.registerMonitored({
        label: d.name,
        agent: d.agent,
        cwd: d.cwd,
        externalId: d.sessionId,
        pid: d.pid,
        status: d.status,
      }),

    'agent/capabilities': () =>
      Object.fromEntries(
        [...agentAdapters].map(([agent, adapter]) => [
          agent,
          adapter.capabilities,
        ]),
      ),
    'agent/detect': (agent: ManagedAgent): BinaryDetection => {
      const candidate = agentAdapters.get(agent)?.resolveBinary();
      if (!candidate) return { path: null };
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return { path: candidate };
      } catch {
        return { path: null };
      }
    },
    'adapters/status': () => ({
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
    }),

    'rules/get': () => getRules(),
    'rules/add': (rule: Omit<PermissionRule, 'id'>) => addRule(rule),
    'rules/remove': (id: string) => removeRule(id),

    'approval/answer': (p: {
      id: string;
      sessionId: string;
      tool: string;
      subject: string;
      answer: ApprovalAnswer;
    }) => {
      if (p.answer.decision === 'allow' && p.answer.scope === 'session') {
        const set = sessionAllows.get(p.sessionId) ?? new Set<string>();
        set.add(`${p.tool}0000${p.subject}`);
        sessionAllows.set(p.sessionId, set);
      }
      if (p.answer.decision === 'allow' && p.answer.scope === 'always') {
        const session = ptys.get(p.sessionId);
        addRule({
          tool: p.tool || '*',
          pattern: p.subject,
          scope: session?.cwd ?? '*',
          decision: 'allow',
        });
      }
      hooks.resolveApproval(p.id, p.answer);
      ptys.applyUpdate(p.sessionId, {
        status: 'working',
        activity:
          p.answer.decision === 'deny' ? `${p.tool} denied` : `${p.tool}…`,
      });
      return null;
    },
  };

  return {
    async start() {
      try {
        const port = await hooks.start();
        console.log(`[sertumd] hook endpoint on 127.0.0.1:${port}`);
      } catch (err) {
        console.error('[sertumd] hook server failed to start:', err);
      }

      const hydrated = await hydrateLoginEnv();
      console.log(
        hydrated
          ? '[sertumd] environment taken from your login shell'
          : '[sertumd] using the inherited environment; login shell did not answer',
      );

      try {
        const reaped = await reapStrayAppServers(appServerRecordFile());
        if (reaped) {
          console.log(`[sertumd] reaped ${reaped} orphaned codex app server(s)`);
        }
        const up = await codex.start();
        console.log(
          up
            ? `[sertumd] codex app server on ${codex.remoteUrl}`
            : '[sertumd] codex not available; codex sessions run unmonitored',
        );
        if (up && codex.serverPid !== null) {
          recordAppServer(appServerRecordFile(), {
            ownerPid: process.pid,
            serverPid: codex.serverPid,
            port: codex.port,
          });
        }
      } catch (err) {
        console.error('[sertumd] codex app server failed to start:', err);
      }

      startMonitorPolling();
      startMetaPolling();
    },

    shutdown() {
      if (metaTimer) clearInterval(metaTimer);
      if (monitorTimer) clearInterval(monitorTimer);
      ptys.disposeAll();
      claudeChat.disposeAll();
      void hooks.stop();
      codex.stop();
      grokEvents.stopAll();
    },

    handle(method, params) {
      const fn = methods[method];
      if (!fn) throw new Error(`unknown method: ${method}`);
      return fn(params as never);
    },

    onEvent(cb) {
      listeners.push(cb);
    },
  };
}
