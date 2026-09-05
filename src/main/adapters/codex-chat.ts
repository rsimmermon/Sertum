import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ApprovalAnswer, PendingApproval, PermissionMode, PermissionModeResult } from '../../shared/types';
import { CodexAppServer, type CodexNotification, type CodexServerRequest } from './codex-app-server';
import { mapCodexStatus, type CodexThreadStatus } from './codex';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => v && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : {};
const string = (v: unknown): string => typeof v === 'string' ? v : '';

interface Hosted {
  id: string;
  threadId: string;
  turnId: string | null;
  busy: boolean;
  closing: boolean;
  reconfiguring?: boolean;
  items: Map<string, ObjectValue>;
}
interface Held {
  session: Hosted;
  wire: CodexServerRequest;
  request: PendingApproval;
  decisions: unknown[];
}

/** Owns app-server threads, never terminal pixels. All wire shapes stay here. */
export class CodexChatHost extends EventEmitter {
  private sessions = new Map<string, Hosted>();
  private threads = new Map<string, Hosted>();
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

  async start(id: string, cwd: string): Promise<{ threadId: string; model: string; path: string; mode: PermissionMode | null }> {
    if (!this.server.connected) throw new Error('Codex app server is unavailable.');
    const result = object(await this.server.request('thread/start', {
      cwd, approvalPolicy: 'untrusted', sandbox: 'workspace-write',
      approvalsReviewer: 'user',
    }));
    const thread = object(result.thread);
    const threadId = string(thread.id);
    if (!threadId || !this.server.connected) throw new Error('Codex did not return a live thread.');
    const session: Hosted = { id, threadId, turnId: null, busy: false, closing: false, items: new Map() };
    this.sessions.set(id, session);
    this.threads.set(threadId, session);
    return { threadId, model: string(result.model), path: string(thread.path), mode: policyMode(result.approvalPolicy) };
  }

  async send(id: string, text: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s || s.closing || s.busy || !text.trim()) return false;
    s.busy = true;
    try {
      await this.server.request('turn/start', { threadId: s.threadId, input: [{ type: 'text', text }] });
      return this.sessions.get(id) === s;
    } catch (error) {
      if (this.sessions.get(id) === s) {
        s.busy = false;
        this.emit('update', { id, status: 'attention', activity: String(error) });
      }
      return false;
    }
  }

  async setPermissionMode(id: string, mode: PermissionMode): Promise<PermissionModeResult> {
    const s = this.sessions.get(id);
    if (!s || s.closing) return { ok: false, reason: 'That session is gone.' };
    const policy = modePolicy(mode);
    if (!policy) return { ok: false, reason: 'Codex does not support that permission policy.' };
    if (s.busy) return { ok: false, reason: 'Finish or stop the current turn before changing its policy.' };
    s.busy = true;
    s.reconfiguring = true;
    try {
      // resume on an already loaded thread ignores configuration overrides.
      // Unload the idle thread first, then read back its effective policy.
      await this.server.request('thread/unsubscribe', { threadId: s.threadId });
      const result = object(await this.server.request('thread/resume', {
        threadId: s.threadId, approvalPolicy: policy,
      }));
      const actual = policyMode(result.approvalPolicy);
      if (this.sessions.get(id) !== s || !actual) return { ok: false, reason: 'Codex did not report the updated policy.' };
      return { ok: true, mode: actual };
    } catch (error) {
      this.finish(s, -1);
      return { ok: false, reason: String(error) };
    } finally { s.busy = false; s.reconfiguring = false; }
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
    const s = this.threads.get(string(params.threadId));
    if (!s) return;
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
    } else if (method === 'thread/status/changed') {
      this.emit('update', { id: s.id, ...mapCodexStatus(params.status as CodexThreadStatus) });
    }
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

function policyMode(policy: unknown): PermissionMode | null {
  return policy === 'untrusted' ? 'codex-untrusted' : policy === 'on-request' ? 'codex-on-request' : policy === 'never' ? 'codex-never' : null;
}
function modePolicy(mode: PermissionMode): string | null {
  return mode === 'codex-untrusted' ? 'untrusted' : mode === 'codex-on-request' ? 'on-request' : mode === 'codex-never' ? 'never' : null;
}
