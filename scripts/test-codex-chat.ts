import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexChatHost } from '../src/main/adapters/codex-chat';
import type { ClaudeChatHost } from '../src/main/adapters/claude-chat';
import { CodexAppServer, type CodexServerRequest } from '../src/main/adapters/codex-app-server';
import { sessionCapability } from '../src/shared/session-capabilities';
import { createAgentAdapters } from '../src/main/adapters/agent-adapter';
import type { SessionSnapshot } from '../src/shared/types';

async function main() {
  class Server extends EventEmitter {
    connected = true;
    next = 0;
    deniedProfiles = new Set<string>();
    calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    async request(method: string, params: Record<string, unknown> = {}) {
      this.calls.push({ method, params });
      if (method === 'thread/start') return {
        thread: { id: `thread-${++this.next}` },
        approvalPolicy: 'on-request', approvalsReviewer: 'user',
        sandbox: { type: 'workspaceWrite' },
      };
      if (method === 'permissionProfile/list') return {
        data: [':read-only', ':workspace', ':danger-full-access'].map(id => ({
          id, allowed: !this.deniedProfiles.has(id),
        })),
      };
      if (method === 'thread/settings/update') {
        const profile = String(params.permissions);
        const sandboxPolicy = {
          type: profile === ':read-only' ? 'readOnly'
            : profile === ':danger-full-access' ? 'dangerFullAccess' : 'workspaceWrite',
        };
        queueMicrotask(() => this.emit('notification', {
          method: 'thread/settings/updated',
          params: {
            threadId: params.threadId,
            threadSettings: {
              approvalPolicy: params.approvalPolicy,
              approvalsReviewer: params.approvalsReviewer,
              sandboxPolicy,
              activePermissionProfile: { id: profile },
            },
          },
        }));
      }
      return {};
    }
  }
  const server = new Server();
  const host = new CodexChatHost(server as unknown as CodexAppServer);
  const a = await host.start('a', 'C:/a');
  const b = await host.start('b', 'C:/b');
  assert.equal(a.mode, 'codex-ask');
  server.emit('notification', {
    method: 'thread/started',
    params: {
      thread: {
        id: 'child-a', parentThreadId: a.threadId, name: 'researcher',
        status: { type: 'active' },
      },
    },
  });
  assert.equal(host.subSessions('a').length, 1, 'Codex child threads should be inspectable');
  server.emit('notification', {
    method: 'thread/status/changed',
    params: { threadId: 'child-a', status: { type: 'idle' } },
  });
  assert.equal(host.subSessions('a')[0]?.status, 'idle');
  const firstMode = await host.setPermissionMode('a', 'codex-read-only');
  assert.deepEqual(firstMode, { ok: true, mode: 'codex-read-only' });
  assert(host.has('a'), 'Changing a fresh thread policy must not end the session');
  const settings = server.calls.findLast(c => c.method === 'thread/settings/update');
  assert.deepEqual(settings?.params, {
    threadId: a.threadId,
    permissions: ':read-only',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
  });
  assert(await host.send('a', 'first turn', [
    { path: 'C:/shots/example.png', name: 'example.png', size: 42, kind: 'image' },
    { path: 'C:/notes/design brief.txt', name: 'design brief.txt', size: 99, kind: 'file' },
  ]));
  const firstTurn = server.calls.findLast(c => c.method === 'turn/start');
  assert(!('approvalPolicy' in (firstTurn?.params ?? {})));
  assert.deepEqual(firstTurn?.params.input, [
    {
      type: 'text',
      text: 'first turn\n\nAttachments:\n- example.png (image)\n- design brief.txt: "C:/notes/design brief.txt"',
    },
    { type: 'localImage', path: 'C:/shots/example.png' },
  ]);
  const activeMode = await host.setPermissionMode('a', 'codex-auto-review');
  assert.deepEqual(activeMode, { ok: true, mode: 'codex-auto-review', appliesToNextTurn: true });
  server.deniedProfiles.add(':danger-full-access');
  const blocked = await host.setPermissionMode('b', 'codex-full-access');
  assert.deepEqual(blocked, {
    ok: false,
    reason: 'Codex’s effective requirements do not allow :danger-full-access.',
  });
  let reply: unknown;
  const ask = (method: string, params: Record<string, unknown>) => {
    reply = undefined;
    server.emit('request', { id: 'wire-1', method, params,
      reply: result => { reply = result; return true; },
    } satisfies CodexServerRequest);
  };
  ask('item/tool/requestUserInput', { threadId: a.threadId, itemId: 'q', questions: [
    { id: 'one', header: 'same', question: 'First?', options: [{ label: 'A' }] },
    { id: 'two', header: 'same', question: 'Second?', isSecret: true },
  ] });
  const question = host.pending()[0];
  assert.equal(question.card?.kind, 'questions');
  assert(!host.answer(question.id, 'b', { decision: 'answer', scope: 'once' }));
  assert(host.answer(question.id, 'a', { decision: 'answer', scope: 'once', answers: { one: ['A'], two: ['secret'] } }));
  assert.deepEqual(reply, { answers: { one: { answers: ['A'] }, two: { answers: ['secret'] } } });
  ask('item/commandExecution/requestApproval', { threadId: a.threadId, command: 'echo hello', availableDecisions: ['accept', 'decline'] });
  const command = host.pending()[0];
  assert.deepEqual(command.allowedScopes, ['once']);
  assert(!host.answer(command.id, 'a', { decision: 'allow', scope: 'always' }));
  assert.equal(reply, undefined);
  server.emit('notification', { method: 'serverRequest/resolved', params: { threadId: a.threadId, requestId: 'wire-1' } });
  assert.equal(host.pending().length, 0);
  ask('item/permissions/requestApproval', { threadId: b.threadId, permissions: { network: { enabled: true } } });
  const grant = host.pending()[0];
  assert(host.answer(grant.id, 'b', { decision: 'deny', scope: 'once' }));
  assert.deepEqual(reply, { permissions: {}, scope: 'turn' });
  assert(await host.terminate('a'));
  assert(host.has('b'), 'Closing one thread must not close another');
  let updates = 0;
  host.on('update', () => updates++);
  server.emit('notification', { method: 'thread/status/changed', params: { threadId: a.threadId, status: { type: 'active' } } });
  ask('item/commandExecution/requestApproval', { threadId: a.threadId });
  assert.equal(updates, 0);
  assert.equal(reply, undefined);
  server.emit('disconnected');
  assert(!host.has('b'));
  assert(!await host.send('b', 'late'));

  const adapters = createAgentAdapters({ codex: server as unknown as CodexAppServer,
    claudeControl: { queueSteer() {}, queueInterrupt() {}, setToolGate() {} },
    claudeChat: { has: () => false, interrupt: async () => false } as unknown as ClaudeChatHost,
  });
  const caps = adapters.get('codex')!.capabilities;
  const session = { agent: 'codex', origin: 'owned', transport: 'stream', exitCode: null } as SessionSnapshot;
  assert(sessionCapability(session, caps, 'permission-mode').ok);
  assert(!sessionCapability({ ...session, transport: 'pty' }, caps, 'permission-mode').ok);
  assert(!sessionCapability({ ...session, exitCode: 0 }, caps, 'permission-mode').ok);
  assert(!sessionCapability({ ...session, origin: 'monitored' }, caps, 'permission-mode').ok);
  console.log('PASS: permission presets/readback/policy limits, question IDs, approval scopes, cancellation, isolation, stale events, session capabilities.');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
