import { CodexChatHost } from '../main/adapters/codex-chat';
import { hasStructuredTransport, sessionCapability } from '../shared/session-capabilities';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { agentSafeEnv, PtyManager } from '../main/pty-manager';
import {
  ClaudeChatHost,
  type ChatPermissionAsk,
} from '../main/adapters/claude-chat';
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
import { approvalCardFor } from '../main/adapters/interactive-tools';
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
  type PendingApproval,
  type PermissionMode,
  type PermissionModeResult,
  type PermissionRule,
  type PtySize,
  type SessionSnapshot,
  type SessionSpec,
  type SessionStatus,
} from '../shared/types';

/** What the session's activity line reads once a held call is answered. */
const ANSWERED_ACTIVITY: Record<
  ApprovalAnswer['decision'],
  (tool: string) => string
> = {
  allow: (tool) => `${tool}…`,
  deny: (tool) => `${tool} denied`,
  answer: (tool) => `${tool} answered`,
};

/**
 * The session fabric — everything Sertum knows about running agents, moved
 * out of the Electron main process so sessions are not children of a window.
 * This is the fabric owned by the independent broker process: the code here is the
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
  shutdown(): Promise<void>;
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

  /**
   * The stored answer for one tool call, or null when nothing has an opinion.
   *
   * Shared by both places a permission question can arrive: Claude's
   * `PermissionRequest` hook for a PTY-backed session, and a conversation
   * session's own `can_use_tool` control request. One function, so a rule
   * cannot mean two different things depending on which transport asked.
   */
  const decidePermission: NonNullable<HookServer['evaluatePermission']> = (
    sessionId,
    payload,
  ) => {
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

  hooks.evaluatePermission = decidePermission;
  hooks.onApprovalGone = (id) => emit('approval:gone', id);

  /**
   * Puts one call on B5's bar, whichever channel it arrived on.
   *
   * The status move is plane 2 speaking rather than a guess about pixels:
   * Claude said a decision is wanted, either by firing `PermissionRequest`
   * or by holding a `can_use_tool` control request open.
   */
  function raiseApproval(request: PendingApproval): void {
    if (request.blocksTurn !== false) {
      ptys.applyUpdate(request.sessionId, {
        status: 'needs-input',
        activity: activityFor(request),
      });
    }
    emit('approval:needed', request);
  }

  /** What the sidebar says while this call waits. A card is not an approval. */
  function activityFor(request: PendingApproval): string {
    switch (request.card?.kind) {
      case 'questions':
        return 'waiting on your answer';
      case 'plan':
        return 'review the plan';
      default:
        return `approve ${request.tool}?`;
    }
  }

  /**
   * B5 is opt-outable, and the switch is the presence of the handler: with
   * no handler the hook server never holds a call at all.
   */
  function syncApprovalHandler(): void {
    hooks.onApprovalNeeded = settings.approvalsInApp ? raiseApproval : undefined;
  }

  const codex = new CodexAppServer(
    () => settings.agentBinaryPaths.codex || resolveCodexBinary(),
  );
  const grokEvents = new GrokEventLog();

  /** See the note on the original in main.ts history: one spawn in flight. */
  let mintedGrokSession: { sessionId: string; grokSessionId: string } | null =
    null;

  // Constructed here, ahead of `ptys` and its listeners below, so
  // `ClaudeAdapter` can be given the same instance rather than a second one —
  // its interrupt needs to ask this host whether a session has a live
  // control channel before falling back to the hook queue.
  const claudeChat = new ClaudeChatHost();
  const agentAdapters = createAgentAdapters({ codex, claudeControl: hooks, claudeChat });

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

  const codexChat = new CodexChatHost(codex);
  const structuredHostFor = (id: string) => codexChat.has(id) ? codexChat : claudeChat;
  codexChat.on('update', ({ id, status, activity }) => ptys.applyUpdate(id, { status, activity }));
  codexChat.on('exit', ({ id, exitCode }) => ptys.markExited(id, exitCode));
  codexChat.on('approval-gone', (id: string) => emit('approval:gone', id));
  codexChat.on('approval', (request: PendingApproval) => {
    if (!settings.approvalsInApp) {
      codexChat.answer(request.id, request.sessionId, { decision: 'deny', scope: 'once' });
      return;
    }
    raiseApproval(request);
  });
  claudeChat.on('update', ({ id, status, activity }) =>
    ptys.applyUpdate(id, { status, activity }),
  );
  claudeChat.on('init', ({ id, sessionId, model, permissionMode }) =>
    ptys.applyMeta(id, { externalId: sessionId, model, permissionMode }),
  );
  claudeChat.on('exit', ({ id, exitCode }) => ptys.markExited(id, exitCode));

  /**
   * Calls a conversation session is holding open, keyed by the approval id
   * the UI answers with. The turn behind each one is genuinely stopped, so
   * this map is what turns a button press back into a resumed turn.
   */
  const controlAsks = new Map<
    string,
    { requestId: string; request: PendingApproval }
  >();

  /**
   * Answers one held control ask and forgets it.
   *
   * Returns whether the id belonged to this channel at all -- not whether the
   * write landed. A process that died while the bar was up owns the id and
   * cannot be written to, and handing that id on to the hook server, which
   * has never heard of it, would only look like a second attempt.
   */
  function settleControlAsk(
    id: string,
    answer: { behavior: 'allow' } | { behavior: 'deny'; message: string },
  ): boolean {
    const ask = controlAsks.get(id);
    if (!ask) return false;
    controlAsks.delete(id);
    claudeChat.answerPermission(ask.request.sessionId, ask.requestId, answer);
    return true;
  }

  /**
   * A conversation session is asking. This is the same question B5 already
   * answers for a PTY-backed session, arriving on the transport that session
   * actually has -- so it goes through the same rules, the same
   * session-scoped allows and the same bar rather than a parallel path.
   *
   * Unlike the hook, nothing here expires. A held hook has curl's deadline
   * behind it and must be released before it; a control request has only the
   * turn, and an interactive Claude leaves its own dialog up indefinitely
   * too. Answering late is correct; timing out would resume a turn with a
   * decision nobody made.
   */
  claudeChat.on('permission', (ask: ChatPermissionAsk) => {
    const reply = (
      answer: { behavior: 'allow' } | { behavior: 'deny'; message: string },
    ) => claudeChat.answerPermission(ask.id, ask.requestId, answer);

    // A tool whose card *is* the interaction surface. The two Sertum knows
    // how to draw come through with their card; anything else has a shape
    // Sertum would be guessing at, so it is refused with a reason rather than
    // shown as an approve/deny it never asked for.
    const card = approvalCardFor(ask.toolName, ask.input);
    if (ask.requiresUserInteraction && !card) {
      reply({
        behavior: 'deny',
        message: `${ask.displayName} asks for a decision on its own card, which Sertum's conversation view cannot show. Run this session's agent in a terminal to answer it.`,
      });
      return;
    }

    // A card deliberately skips the rules and the session-scoped allows. A
    // rule is a policy about whether a call is safe to run; it has no opinion
    // on which option a person would pick or whether a plan is right, and a
    // stale `allow` silently approving every plan is exactly the kind of
    // answer-nobody-gave this whole surface exists to prevent.
    const decision = card
      ? null
      : decidePermission(ask.id, {
          tool_name: ask.toolName,
          tool_input: ask.input,
        });
    if (decision && decision.decision !== 'ask') {
      if (decision.decision === 'allow') {
        reply({ behavior: 'allow' });
        ptys.applyUpdate(ask.id, {
          status: 'working',
          activity: `${ask.toolName}…`,
        });
      } else {
        reply({ behavior: 'deny', message: decision.reason });
        ptys.applyUpdate(ask.id, {
          status: 'working',
          activity: `${ask.toolName} denied`,
        });
      }
      return;
    }

    // With in-app approval switched off there is nowhere else for a
    // conversation session to ask -- it has no terminal and no dialog of its
    // own -- so it is refused with a reason rather than left holding.
    if (!settings.approvalsInApp) {
      reply({
        behavior: 'deny',
        message:
          'Approvals in Sertum are switched off, and a conversation session has no other place to ask. Turn them on in Settings › Agents & permissions.',
      });
      return;
    }

    const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const request: PendingApproval = {
      id,
      sessionId: ask.id,
      tool: ask.toolName,
      subject: decision?.subject ?? subjectOf(ask.toolName, ask.input),
      description: ask.description,
      reason: ask.reason,
      // A rule written from this bar would reach wider than the call it was
      // written about, so the button that writes one is not offered -- and a
      // card has nothing a rule could usefully say in the first place.
      alwaysAllowable: !ask.suppressAlwaysAllow && !card,
      ...(card ? { card } : {}),
    };
    controlAsks.set(id, { requestId: ask.requestId, request });
    raiseApproval(request);
  });

  /**
   * The CLI withdrew an ask: the turn was interrupted, or something else
   * answered it. Nothing is owed in reply -- only the bar has to come down,
   * or it would be asking about a turn that has gone.
   */
  claudeChat.on('permission-cancelled', ({ id, requestId }) => {
    for (const [askId, ask] of controlAsks) {
      if (ask.request.sessionId !== id || ask.requestId !== requestId) continue;
      controlAsks.delete(askId);
      emit('approval:gone', askId);
    }
  });

  async function createCodexConversationSession(spec: Partial<SessionSpec>): Promise<SessionSnapshot> {
    const id = randomUUID();
    const cwd = spec.cwd ?? process.cwd();
    const started = await codexChat.start(id, cwd);
    threadToSession.set(started.threadId, id);
    ptys.registerStream({
      id, label: spec.label ?? 'Codex', agent: 'codex', cwd,
      command: resolvedCommand('codex') ?? 'codex', args: [],
      pid: codex.serverPid!, externalId: started.threadId,
      controls: {
        kill: () => { void codexChat.terminate(id); },
        terminate: () => codexChat.terminate(id),
      },
    });
    ptys.applyMeta(id, { model: started.model || undefined, transcriptPath: started.path || undefined, permissionMode: started.mode });
    ptys.applyUpdate(id, { status: 'idle', activity: 'ready' });
    return ptys.get(id)!;
  }

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
      // Declares an approval surface. Without it a headless session cannot
      // ask at all: anything that would prompt is refused with "no approval
      // surface in this session; permission request denied automatically",
      // which reaches the reader only as the agent explaining afterwards
      // that it lacked permission. With it, the CLI holds the turn and sends
      // a `can_use_tool` control request down its own stream. `stdio` names
      // that channel rather than a real MCP tool.
      '--permission-prompt-tool',
      'stdio',
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
    // Its own control channel answers permission questions, so the
    // `PermissionRequest` hook must not raise a second bar for the same call.
    hooks.setHostAnsweredPermissions(id, true);
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
      // Structured hosts bind the thread/start response by id. Only CLI
      // threads can satisfy the legacy TUI queue, even in the same folder.
      if (thread.source !== undefined && thread.source !== 'cli') return;
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
      if (codexChat.has(sessionId)) return;
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
    // A dead process is holding nothing, so every bar asking about it comes
    // down rather than waiting for an answer that can no longer land.
    for (const [askId, ask] of controlAsks) {
      if (ask.request.sessionId !== e.id) continue;
      controlAsks.delete(askId);
      emit('approval:gone', askId);
    }
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
      (hasStructuredTransport(s) || s.origin === 'attached') &&
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
      return agent === 'codex' ? createCodexConversationSession(spec) : createConversationSession(spec);
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
      // Set before asking, not after: a structured Claude session's own
      // control channel can answer and end the turn within the same tick as
      // this await resolves, and its `result` update is the authoritative
      // one. Setting the optimistic label first means that real event -- if
      // it lands during the await -- naturally supersedes it instead of
      // being clobbered by it.
      ptys.applyUpdate(id, { activity: 'interrupting…' });
      const accepted = await adapter.interruptTurn(sessionRef(id, session));
      if (!accepted) {
        ptys.applyUpdate(id, { activity: 'could not interrupt — no active turn' });
      }
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
      if (!session || session.exitCode !== null || session.origin !== 'owned' || !hasStructuredTransport(session) || !message) return false;
      return structuredHostFor(p.id).send(p.id, message);
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

    /**
     * Every call still holding a turn open.
     *
     * A window that reloads, or is closed to the tray and reopened, has no
     * copy of what is waiting -- and a conversation session's ask has no
     * timeout behind it, so a bar lost with the window would strand the turn
     * for good. The daemon is the one that knows, so it is asked on connect.
     * A session is only ever on one of the two channels, so each session's
     * own calls keep the order they arrived in.
     */
    'approval/pending': () => [
      ...codexChat.pending(),
      ...hooks.pending(),
      ...[...controlAsks.values()].map((a) => a.request),
    ],

    /**
     * Change how the agent decides permissions for the rest of the session.
     *
     * Only a conversation session has a channel to say it on; a PTY-backed
     * one carries whatever mode it was started with, and is told so rather
     * than left to wonder why nothing happened. The mode recorded is the one
     * the agent echoed back, never the one that was asked for.
     */
    'session/permission-mode': async (p: {
      id: string;
      mode: PermissionMode;
    }): Promise<PermissionModeResult> => {
      const session = ptys.get(p.id);
      if (!session) return { ok: false, reason: 'That session is gone.' };
      const answer = sessionCapability(session, agentAdapters.get(session.agent)?.capabilities, 'permission-mode');
      if (!answer.ok) return answer;
      if (!answer.modes?.includes(p.mode)) return { ok: false, reason: 'This agent does not support that mode.' };
      const result = await structuredHostFor(p.id).setPermissionMode(p.id, p.mode);
      if (result.ok) ptys.applyMeta(p.id, { permissionMode: result.mode });
      return result;
    },

    'approval/answer': (p: {
      id: string;
      sessionId: string;
      tool: string;
      subject: string;
      answer: ApprovalAnswer;
    }) => {
      // Resolve identity from daemon-owned state, never from renderer-supplied tool/path.
      const codexAsk = codexChat.pending().find(a => a.id === p.id);
      if (codexAsk) {
        if (!codexChat.answer(p.id, p.sessionId, p.answer)) throw new Error('That Codex request cannot be answered anymore.');
        return null;
      }
      const pending = controlAsks.get(p.id)?.request ?? hooks.pending().find(a => a.id === p.id);
      if (!pending || pending.sessionId !== p.sessionId) return null;
      p = { ...p, tool: pending.tool, subject: pending.subject };
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
      // The same button answers either channel. A conversation session's
      // call is held on its own control stream; a PTY-backed session's is
      // held as an open hook response, and the id says which.
      //
      // `answer` rides the deny channel because that is the only one that
      // carries a message, but it is a card's outcome rather than a refusal:
      // the words are the user's answer, and the activity line says so.
      const settled =
        p.answer.decision === 'allow'
          ? settleControlAsk(p.id, { behavior: 'allow' })
          : settleControlAsk(p.id, {
              behavior: 'deny',
              message:
                p.answer.reason?.trim() ||
                (p.answer.decision === 'answer'
                  ? 'The user dismissed the question without answering.'
                  : 'Denied in Sertum.'),
            });
      if (!settled) hooks.resolveApproval(p.id, p.answer);
      ptys.applyUpdate(p.sessionId, {
        status: 'working',
        activity: ANSWERED_ACTIVITY[p.answer.decision](p.tool),
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

    async shutdown() {
      // Background sessions Sertum created live under Claude's own daemon,
      // so killing their attach PTYs is only a detach. A complete Sertum
      // shutdown explicitly stops those owned background agents as well.
      const backgroundStops = ptys.list()
        .filter((session) => session.background && session.agent === 'claude')
        .map(async (session) => {
          const backgroundId = session.args[1] ?? session.externalId;
          if (!backgroundId) return;
          try {
            await runClaude(
              session.command,
              ['stop', backgroundId],
              session.cwd,
            );
          } catch (err) {
            console.error(
              `[sertumd] could not stop background session ${backgroundId}:`,
              err,
            );
          }
        });
      await Promise.all(backgroundStops);
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
