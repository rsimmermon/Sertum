import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AgentEffort, AgentEffortList, AgentModel, AgentModelList, ApprovalAnswer, EffortChangeResult, ModelChangeResult, PendingApproval, PermissionMode, PermissionModeResult, ResumableSession, SessionSubsessionInfo, SessionStatus } from '../../shared/types';
import { CodexAppServer, type CodexNotification, type CodexServerRequest } from './codex-app-server';
import { mapCodexStatus, resumableThread, type CodexThread, type CodexThreadStatus } from './codex';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => v && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : {};
const string = (v: unknown): string => typeof v === 'string' ? v : '';

interface Hosted {
  id: string;
  threadId: string;
  /** `thread/start` has no persisted rollout until its first turn. */
  hasRollout: boolean;
  turnId: string | null;
  busy: boolean;
  closing: boolean;
  reconfiguring?: boolean;
  items: Map<string, ObjectValue>;
  /**
   * A mode asked for while a turn was in flight, applied the instant it
   * completes. Only the latest ask survives -- a second request overwrites
   * the first exactly as retyping over an unsent draft would, since only the
   * mode you actually land on when the turn ends is meaningful.
   */
  pendingMode?: PermissionMode | null;
  /** A first-turn policy override waiting for Codex's settings notification. */
  modeInFlight?: PermissionMode | null;
  /**
   * The model this session has been switched to, passed on every
   * `turn/start` from then on.
   *
   * `turn/start` documents its `model` field as overriding "for this turn and
   * subsequent turns", so sending it once would be enough -- it is sent every
   * turn anyway because that costs nothing and cannot be undone by anything
   * that later reloads the thread's own configuration. Null means the thread
   * runs whatever it was started with.
   */
  model?: string | null;
  /**
   * The thinking level this session has been switched to, passed on every
   * `turn/start` from then on.
   *
   * `turn/start`'s `effort` field is `model`'s twin -- "Override the
   * reasoning effort for this turn and subsequent turns" in the generated
   * schema of Codex CLI 0.153.4 -- so it is carried the same way, for the
   * same reason. Null means the thread reasons at whatever its model's
   * `defaultReasoningEffort` is.
   */
  effort?: string | null;
}
interface Held {
  session: Hosted;
  wire: CodexServerRequest;
  request: PendingApproval;
  decisions: unknown[];
}

interface ChildThread extends SessionSubsessionInfo {
  parentThreadId: string;
}

/** Owns app-server threads, never terminal pixels. All wire shapes stay here. */
export class CodexChatHost extends EventEmitter {
  private sessions = new Map<string, Hosted>();
  private threads = new Map<string, Hosted>();
  private childThreads = new Map<string, ChildThread>();
  private asks = new Map<string, Held>();

  constructor(private server: CodexAppServer) {
    super();
    server.on('notification', (event: CodexNotification) => this.notification(event));
    server.on('request', (request: CodexServerRequest) => this.request(request));
    // Ownership cannot be reconstructed from a replacement socket's pixels or
    // guessed from cwd. End these handles; transcripts remain readable.
    server.on('disconnected', () => {
      for (const session of [...this.sessions.values()]) this.finish(session, -1);
    });
  }

  has(id: string): boolean { return this.sessions.has(id); }

  /** Agent-owned sub-sessions reported by Codex's thread lifecycle. */
  subSessions(id: string): SessionSubsessionInfo[] {
    const root = this.sessions.get(id);
    if (!root) return [];
    return [...this.childThreads.values()]
      .filter((child) => child.parentThreadId === root.threadId)
      .map(({ parentThreadId: _parent, ...child }) => ({ ...child }));
  }

  async start(id: string, cwd: string): Promise<{ threadId: string; model: string; path: string; cwd: string; mode: PermissionMode | null }> {
    if (!this.server.connected) throw new Error('Codex app server is unavailable.');
    const result = object(await this.server.request('thread/start', {
      cwd, approvalPolicy: 'untrusted', sandbox: 'workspace-write',
      approvalsReviewer: 'user',
    }));
    const thread = object(result.thread);
    const threadId = string(thread.id);
    if (!threadId || !this.server.connected) throw new Error('Codex did not return a live thread.');
    const session: Hosted = {
      id, threadId, hasRollout: false, turnId: null, busy: false, closing: false,
      items: new Map(),
    };
    this.sessions.set(id, session);
    this.threads.set(threadId, session);
    return { threadId, model: string(result.model), path: string(thread.path), cwd, mode: policyMode(result.approvalPolicy) };
  }

  /**
   * Loads a past thread from disk into this app server and binds it to a new
   * Sertum session, exactly as `start` binds a brand-new one.
   *
   * Verified against Codex CLI 0.153.4 by killing the app server that created
   * a thread -- the whole process tree, not just the client connection -- and
   * resuming it from a brand-new one that never saw it: the resumed thread
   * answered a follow-up turn with full context from before that process
   * existed. `thread/resume` needs nothing but the id; the cwd it reports back
   * is the thread's own, never overridden here.
   */
  async resume(id: string, threadId: string): Promise<{ threadId: string; model: string; path: string; cwd: string; mode: PermissionMode | null }> {
    if (!this.server.connected) throw new Error('Codex app server is unavailable.');
    const result = object(await this.server.request('thread/resume', { threadId }));
    const thread = object(result.thread);
    const resumedId = string(thread.id) || threadId;
    if (!resumedId || !this.server.connected) throw new Error('Codex did not return a live thread.');
    const session: Hosted = {
      id, threadId: resumedId, hasRollout: true, turnId: null, busy: false,
      closing: false, items: new Map(),
    };
    this.sessions.set(id, session);
    this.threads.set(resumedId, session);
    return {
      threadId: resumedId,
      model: string(result.model),
      path: string(thread.path),
      cwd: string(result.cwd),
      mode: policyMode(result.approvalPolicy),
    };
  }

  /**
   * Past threads for this folder, read from the app server's own roster
   * rather than a live process -- `thread/list` answers from disk, so a
   * thread whose process exited long ago still appears. See `resume` above
   * for how that was verified.
   */
  async listResumable(cwd: string): Promise<ResumableSession[]> {
    if (!this.server.connected) return [];
    let result: ObjectValue;
    try {
      result = object(await this.server.request('thread/list', { cwd }));
    } catch {
      return [];
    }
    const rows = Array.isArray(result.data) ? (result.data as CodexThread[]) : [];
    return rows
      .map(resumableThread)
      .filter((r): r is ResumableSession => r !== null)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  async send(id: string, text: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s || s.closing || s.busy || !text.trim()) return false;
    s.busy = true;
    const firstTurnMode = !s.hasRollout && s.pendingMode ? s.pendingMode : null;
    const firstTurnPolicy = firstTurnMode ? modePolicy(firstTurnMode) : null;
    if (firstTurnMode) {
      s.pendingMode = null;
      s.modeInFlight = firstTurnMode;
    }
    // Optimistic, like Claude's own send() -- `turn/started` and
    // `thread/status/changed` are separate async notifications that can
    // land a beat after this request's own response, verified up to ~90ms
    // apart. Reporting 'working' only once they arrive left a real window
    // where a turn had genuinely begun but the session still read 'idle',
    // which a synchronous status check right after send (as a resume/turn
    // round trip test does) could observe and mistake for the turn already
    // being finished. The real notification supersedes this the moment it
    // lands, same as the interrupt path's optimistic label.
    this.emit('update', { id, status: 'working', activity: 'working' });
    try {
      await this.server.request('turn/start', {
        threadId: s.threadId,
        input: [{ type: 'text', text }],
        ...(firstTurnPolicy ? { approvalPolicy: firstTurnPolicy } : {}),
        ...(s.model ? { model: s.model } : {}),
        ...(s.effort ? { effort: s.effort } : {}),
      });
      s.hasRollout = true;
      return this.sessions.get(id) === s;
    } catch (error) {
      if (this.sessions.get(id) === s) {
        if (firstTurnMode) {
          s.pendingMode = firstTurnMode;
          s.modeInFlight = null;
        }
        s.busy = false;
        this.emit('update', { id, status: 'attention', activity: String(error) });
      }
      return false;
    }
  }

  /**
   * `thread/resume` on an already-loaded thread ignores configuration
   * overrides, so a policy change only ever takes on an idle thread. A busy
   * one queues the request instead of refusing it outright: `pendingMode` is
   * applied the moment `turn/completed` lands, and a later call here simply
   * overwrites it, so only the last mode asked for while busy ever matters.
   * A brand-new thread has no rollout for `thread/resume` to load, so its
   * first change is held for `turn/start`'s `approvalPolicy` override.
   */
  async setPermissionMode(id: string, mode: PermissionMode): Promise<PermissionModeResult> {
    const s = this.sessions.get(id);
    if (!s || s.closing) return { ok: false, reason: 'That session is gone.' };
    if (!modePolicy(mode)) return { ok: false, reason: 'Codex does not support that permission policy.' };
    if (s.busy) {
      s.pendingMode = mode;
      return { ok: true, mode, queued: true };
    }
    if (!s.hasRollout) {
      s.pendingMode = mode;
      return { ok: true, mode, queued: true, beforeFirstTurn: true };
    }
    return this.applyPermissionMode(s, mode);
  }

  private async applyPermissionMode(s: Hosted, mode: PermissionMode): Promise<PermissionModeResult> {
    const policy = modePolicy(mode);
    if (!policy) return { ok: false, reason: 'Codex does not support that permission policy.' };
    s.busy = true;
    s.reconfiguring = true;
    try {
      // Unload the idle thread first, then read back its effective policy.
      await this.server.request('thread/unsubscribe', { threadId: s.threadId });
      const result = object(await this.server.request('thread/resume', {
        threadId: s.threadId, approvalPolicy: policy,
      }));
      const actual = policyMode(result.approvalPolicy);
      if (this.sessions.get(s.id) !== s || !actual) return { ok: false, reason: 'Codex did not report the updated policy.' };
      return { ok: true, mode: actual };
    } catch (error) {
      // The thread was unsubscribed before this rebind. If resume fails, the
      // host no longer owns a live thread, so report that lifecycle change;
      // an empty thread never reaches this path because it uses turn/start.
      this.finish(s, -1);
      return { ok: false, reason: String(error) };
    } finally { s.busy = false; s.reconfiguring = false; }
  }

  /**
   * The models this account can run, from the app server's own roster.
   *
   * `model/list` is a plain request needing no thread, and it pages, so the
   * cursor is followed rather than assumed to be absent -- with a bound,
   * because a catalogue that never stops paging must not hang the picker.
   * Hidden rows are exactly the ones Codex keeps out of its own picker, so
   * they stay out of ours.
   */
  async listModels(): Promise<AgentModelList> {
    if (!this.server.connected) return { ok: false, reason: 'Codex app server is unavailable.' };
    const models: AgentModel[] = [];
    let cursor: string | undefined;
    try {
      for (let page = 0; page < 10; page += 1) {
        const result = object(await this.server.request('model/list', cursor ? { cursor } : {}));
        for (const row of Array.isArray(result.data) ? result.data : []) {
          const model = codexModel(row);
          if (model) models.push(model);
        }
        cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
        if (!cursor) break;
      }
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
    return models.length
      ? { ok: true, models }
      : { ok: false, reason: 'Codex listed no models for this account.' };
  }

  /**
   * Switches the model this session's turns run on.
   *
   * Deliberately not the `thread/unsubscribe` + `thread/resume` dance
   * `setPermissionMode` has to perform: `turn/start` carries a `model`
   * override of its own, so the change needs no idle thread, no reload, and
   * has no window in which the thread is unowned. It also works on a thread
   * that has never taken a turn, which resume does not -- `thread/resume` on
   * a brand-new thread answers `no rollout found for thread id`, since
   * nothing has been written to disk for it to load yet.
   *
   * The cost is that it lands when the next turn starts rather than the
   * instant it is asked, which is what `appliesToNextTurn` says out loud
   * while a turn is running. On an idle session the next turn is the next
   * thing that happens, so there is nothing to say.
   */
  async setModel(id: string, model: string): Promise<ModelChangeResult> {
    const s = this.sessions.get(id);
    if (!s || s.closing) return { ok: false, reason: 'That session is gone.' };
    s.model = model;
    return { ok: true, model, appliesToNextTurn: s.busy };
  }

  /**
   * The thinking levels this session's model publishes.
   *
   * Codex hangs the ladder off the model rather than the account: every
   * `model/list` row carries `supportedReasoningEfforts` (each a
   * `{reasoningEffort, description}` pair) alongside a `defaultReasoningEffort`.
   * So the row read is the one for the model this session runs -- what it was
   * switched to, else what plane 2 reported, else the row Codex marks
   * `isDefault`, which is what a thread with no override actually starts on.
   */
  async listEfforts(id: string, model: string | null): Promise<AgentEffortList> {
    if (!this.server.connected) return { ok: false, reason: 'Codex app server is unavailable.' };
    const wanted = this.sessions.get(id)?.model ?? model;
    let fallback: { efforts: AgentEffort[]; current: string | null } | null = null;
    let cursor: string | undefined;
    try {
      for (let page = 0; page < 10; page += 1) {
        const result = object(await this.server.request('model/list', cursor ? { cursor } : {}));
        for (const row of Array.isArray(result.data) ? result.data : []) {
          const r = object(row);
          const id_ = string(r.model) || string(r.id);
          const efforts = codexEfforts(r);
          if (!efforts.length) continue;
          // What this thread will actually reason at: the override it was
          // given, else the row's own default. Codex reports no effort until
          // a turn has written one to the rollout, so without this the chip
          // reads blank on a thread that has a perfectly good answer.
          const current = this.sessions.get(id)?.effort ?? (string(r.defaultReasoningEffort) || null);
          if (wanted && id_ === wanted) return { ok: true, efforts, current };
          if (!fallback && (r.isDefault === true || !wanted)) {
            fallback = { efforts, current };
          }
        }
        cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
        if (!cursor) break;
      }
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
    return fallback
      ? { ok: true, ...fallback }
      : {
          ok: false,
          reason: wanted
            ? `Codex lists no thinking levels for ${wanted}.`
            : 'Codex listed no thinking levels for this account.',
        };
  }

  /**
   * Switches the thinking level this session's turns reason at.
   *
   * `setModel`'s twin down to the shape of the answer, because the mechanism
   * is the same one: the override rides the next `turn/start` rather than
   * being pushed at the server now, so it needs no idle thread and no reload,
   * and it works on a thread that has never taken a turn. The cost is the
   * same too -- it lands when the next turn starts, which is what
   * `appliesToNextTurn` says out loud while one is already running.
   */
  async setEffort(id: string, effort: string): Promise<EffortChangeResult> {
    const s = this.sessions.get(id);
    if (!s || s.closing) return { ok: false, reason: 'That session is gone.' };
    s.effort = effort;
    return { ok: true, effort, appliesToNextTurn: s.busy };
  }

  pending(): PendingApproval[] { return [...this.asks.values()].map(a => a.request); }

  answer(id: string, sessionId: string, answer: ApprovalAnswer): boolean {
    const held = this.asks.get(id);
    if (!held || held.session.id !== sessionId || held.session.closing) return false;
    const { wire, request, decisions } = held;
    if (!request.card && answer.decision === 'allow' && !request.allowedScopes?.includes(answer.scope)) return false;
    let result: ObjectValue;
    if (request.card?.kind === 'questions') {
      const answers: Record<string, { answers: string[] }> = {};
      for (const q of request.card.questions) {
        if (!q.id) continue;
        const supplied = answer.answers?.[q.id];
        answers[q.id] = { answers: Array.isArray(supplied) ? supplied.filter(v => typeof v === 'string') : [] };
      }
      result = { answers };
    } else if (wire.method === 'item/permissions/requestApproval') {
      result = {
        permissions: answer.decision === 'allow' ? object(wire.params.permissions) : {},
        scope: answer.scope === 'session' ? 'session' : 'turn',
      };
    } else {
      let decision: unknown = decisions.includes('decline') ? 'decline' : 'cancel';
      if (answer.decision === 'allow') {
        if (!request.allowedScopes?.includes(answer.scope)) return false;
        decision = answer.scope === 'once' ? 'accept' : answer.scope === 'session' ? 'acceptForSession'
          : decisions.find(d => object(d).acceptWithExecpolicyAmendment);
        if (decision === undefined) return false;
      }
      result = { decision };
    }
    if (!wire.reply(result)) return false;
    this.asks.delete(id);
    this.emit('approval-gone', id);
    // Further structured events, not the button click, determine live status.
    return true;
  }

  async terminate(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return true;
    // Do not race an unload/resume and leave its replacement thread unowned.
    if (s.reconfiguring) return false;
    s.closing = true;
    try {
      if (s.turnId) await this.server.request('turn/interrupt', { threadId: s.threadId, turnId: s.turnId });
      await this.server.request('thread/unsubscribe', { threadId: s.threadId });
      this.finish(s, 0);
      return true;
    } catch {
      if (!this.sessions.has(id)) return true;
      s.closing = false;
      return false;
    }
  }

  private finish(s: Hosted, exitCode: number): void {
    if (this.sessions.get(s.id) !== s) return;
    this.sessions.delete(s.id);
    this.threads.delete(s.threadId);
    for (const [threadId, child] of this.childThreads) {
      if (child.parentThreadId === s.threadId) this.childThreads.delete(threadId);
    }
    this.clearAsks(s);
    this.emit('exit', { id: s.id, exitCode });
  }

  private clearAsks(s: Hosted, itemId?: string): void {
    for (const [id, ask] of this.asks) {
      if (ask.session !== s || (itemId && ask.wire.params.itemId !== itemId)) continue;
      this.asks.delete(id);
      this.emit('approval-gone', id);
    }
  }

  private notification({ method, params }: CodexNotification): void {
    const thread = object(params.thread);
    const threadId = string(params.threadId) || string(thread.id);
    const s = this.threads.get(threadId);
    if (!s) {
      this.childNotification(method, params, threadId, thread);
      return;
    }
    if (method === 'thread/closed') {
      if (!s.reconfiguring) this.finish(s, 0);
      return;
    }
    if (method === 'turn/started') {
      s.turnId = string(object(params.turn).id) || null;
      s.busy = true;
    } else if (method === 'turn/completed') {
      if (s.turnId && string(object(params.turn).id) !== s.turnId) return;
      s.turnId = null;
      s.busy = false;
      s.items.clear();
      this.clearAsks(s);
      const turn = object(params.turn);
      this.emit('update', { id: s.id, status: turn.status === 'failed' ? 'attention' : 'idle',
        activity: string(object(turn.error).message) || (turn.status === 'interrupted' ? 'turn interrupted' : 'turn finished') });
      // The thread just went idle -- exactly the moment a mode queued while
      // it was busy becomes applicable. Runs after the idle/attention update
      // above, so a failure here overwrites "turn finished" with why the
      // mode did not take, rather than the other way around.
      if (s.modeInFlight) {
        const mode = s.modeInFlight;
        s.modeInFlight = null;
        void this.applyPermissionMode(s, mode).then((result) => {
          if (result.ok) this.emit('mode-applied', { id: s.id, mode: result.mode });
          else this.emit('update', { id: s.id, activity: `Could not switch permission mode — ${result.reason}` });
        });
      } else if (s.pendingMode) {
        const mode = s.pendingMode;
        s.pendingMode = null;
        void this.applyPermissionMode(s, mode).then((result) => {
          if (result.ok) this.emit('mode-applied', { id: s.id, mode: result.mode });
          else this.emit('update', { id: s.id, activity: `Could not switch permission mode — ${result.reason}` });
        });
      }
    } else if (method === 'thread/settings/updated') {
      const settings = object(params.threadSettings);
      const actual = policyMode(settings.approvalPolicy);
      if (actual && s.modeInFlight) {
        s.modeInFlight = null;
        this.emit('mode-applied', { id: s.id, mode: actual });
      }
    } else if (method === 'item/started') {
      const item = object(params.item);
      s.items.set(string(item.id), item);
    } else if (method === 'item/completed') {
      const itemId = string(object(params.item).id);
      this.clearAsks(s, itemId);
      s.items.delete(itemId);
    } else if (method === 'serverRequest/resolved') {
      for (const [id, ask] of this.asks) {
        if (ask.session === s && ask.wire.id === params.requestId) {
          this.asks.delete(id); this.emit('approval-gone', id);
        }
      }
    } else if (method === 'model/rerouted') {
      // The server moved the turn to a different model of its own accord.
      // That is its own account of what is running, the same class of source
      // as any other notification here, so it supersedes what we asked for.
      const to = string(params.toModel);
      if (to) {
        s.model = to;
        this.emit('model-applied', { id: s.id, model: to });
      }
    } else if (method === 'thread/status/changed') {
      this.emit('update', { id: s.id, ...mapCodexStatus(params.status as CodexThreadStatus) });
    }
  }

  private childNotification(
    method: string,
    params: Record<string, unknown>,
    threadId: string,
    thread: ObjectValue,
  ): void {
    if (method === 'thread/started') {
      const parentThreadId = string(thread.parentThreadId);
      if (!threadId || !parentThreadId || !this.threads.has(parentThreadId)) return;
      const initial = mapCodexStatus(thread.status as CodexThreadStatus | undefined);
      this.childThreads.set(threadId, {
        id: threadId,
        parentThreadId,
        label: string(thread.name) || string(thread.preview) || 'sub-session',
        status: initial.status ?? 'working',
        activity: initial.activity ?? 'started',
        startedAt: typeof thread.createdAt === 'number' ? thread.createdAt * 1000 : Date.now(),
        lastEventAt: Date.now(),
      });
      return;
    }

    const child = this.childThreads.get(threadId);
    if (!child) return;
    if (method === 'thread/closed') {
      this.childThreads.delete(threadId);
      return;
    }
    if (method !== 'thread/status/changed') return;
    const update = mapCodexStatus(params.status as CodexThreadStatus | undefined);
    if (update.status) child.status = update.status as SessionStatus;
    if (update.activity) child.activity = update.activity;
    child.lastEventAt = Date.now();
  }

  private request(wire: CodexServerRequest): void {
    const p = wire.params;
    const s = this.threads.get(string(p.threadId));
    if (!s) return; // TUI or another owner: never answer it.
    if (s.closing) { wire.reply({}, 'Session is closing.'); return; }
    const item = s.items.get(string(p.itemId)) ?? {};
    const isCommand = wire.method === 'item/commandExecution/requestApproval';
    const isFile = wire.method === 'item/fileChange/requestApproval';
    const isPermissions = wire.method === 'item/permissions/requestApproval';
    const isQuestion = wire.method === 'item/tool/requestUserInput';
    if (!isCommand && !isFile && !isPermissions && !isQuestion) {
      wire.reply({}, `Sertum cannot answer ${wire.method}.`);
      return;
    }
    const decisions: unknown[] = Array.isArray(p.availableDecisions) ? p.availableDecisions
      : ['accept', 'acceptForSession', 'decline', 'cancel'];
    const changes = Array.isArray(item.changes) ? item.changes.map(object) : [];
    const request: PendingApproval = {
      id: `codex-${randomUUID()}`, sessionId: s.id, agentLabel: 'Codex',
      blocksTurn: !isQuestion || p.isBlocking !== false,
      tool: isCommand ? 'Command' : isFile ? 'File changes' : isQuestion ? 'Question' : 'Permissions',
      subject: isCommand ? string(p.command) || string(item.command)
        : isFile ? changes.map(c => string(c.path)).join(', ') : '',
      reason: string(p.reason) || undefined,
      detail: isFile ? changes.map(c => `${string(c.path)}\n${string(c.diff)}`).join('\n\n')
        : isPermissions ? JSON.stringify(p.permissions, null, 2) : undefined,
      alwaysAllowable: false,
      allowedScopes: [],
    };
    if (isQuestion) {
      const questions = Array.isArray(p.questions) ? p.questions.map(object) : [];
      request.card = { kind: 'questions', questions: questions.map(q => ({
        id: string(q.id), header: string(q.header), question: string(q.question),
        isSecret: q.isSecret === true, multiSelect: false,
        options: Array.isArray(q.options) ? q.options.map(object).map(o => ({ label: string(o.label), description: string(o.description) })) : [],
      })) };
    } else if (isPermissions) {
      request.allowedScopes = ['once', 'session'];
      request.onceLabel = 'Allow this turn';
    } else {
      if (decisions.includes('accept')) request.allowedScopes!.push('once');
      if (decisions.includes('acceptForSession')) request.allowedScopes!.push('session');
      if (decisions.some(d => object(d).acceptWithExecpolicyAmendment)) {
        request.allowedScopes!.push('always');
        request.alwaysAllowable = true;
        request.detail = [request.detail, 'Persistent command rule:\n' + JSON.stringify(decisions.find(d => object(d).acceptWithExecpolicyAmendment), null, 2)].filter(Boolean).join('\n');
      }
    }
    this.asks.set(request.id, { session: s, wire, request, decisions });
    this.emit('approval', request);
  }
}

/** One `model/list` row, in the wire's own field names. */
function codexModel(row: unknown): AgentModel | null {
  const r = object(row);
  const id = string(r.model) || string(r.id);
  if (!id || r.hidden === true) return null;
  return {
    id,
    label: string(r.displayName) || id,
    note: string(r.description) || null,
    // Codex names one model per row; there are no aliases to resolve.
    resolved: null,
  };
}

/** The `supportedReasoningEfforts` rows of one `model/list` entry. */
function codexEfforts(row: Record<string, unknown>): AgentEffort[] {
  const rows = Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts : [];
  const efforts: AgentEffort[] = [];
  for (const entry of rows) {
    const r = object(entry);
    const id = string(r.reasoningEffort);
    if (!id) continue;
    // Codex names a level with the level itself and describes it separately;
    // there is no display name on the row to prefer over the word.
    efforts.push({ id, label: id, note: string(r.description) || null });
  }
  return efforts;
}

function policyMode(policy: unknown): PermissionMode | null {
  return policy === 'untrusted' ? 'codex-untrusted' : policy === 'on-request' ? 'codex-on-request' : policy === 'never' ? 'codex-never' : null;
}
function modePolicy(mode: PermissionMode): string | null {
  return mode === 'codex-untrusted' ? 'untrusted' : mode === 'codex-on-request' ? 'on-request' : mode === 'codex-never' ? 'never' : null;
}
