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
    async request(method: string) {
      if (method === 'thread/start') return { thread: { id: `thread-${++this.next}` }, approvalPolicy: 'untrusted' };
      return {};
    }
  }
  const server = new Server();
  const host = new CodexChatHost(server as unknown as CodexAppServer);
  const a = await host.start('a', 'C:/a');
  const b = await host.start('b', 'C:/b');
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
  console.log('PASS: question IDs, restricted approval scopes, cancellation, grant denial, isolation, stale events, session capabilities.');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
