/**
 * Verifies interrupting an *owned* Codex chat thread through the real path
 * fabric.ts uses -- `AgentAdapter.interruptTurn`, not `CodexChatHost`
 * directly -- against a real app server. This matters because owned threads
 * never populate fabric's `activeCodexTurns` map (that map is fed only by
 * `thread/started` for CLI-owned threads matched to a waiting TUI spawn), so
 * `CodexAdapter.interruptTurn` always takes its `readActiveTurn` fallback
 * for a session like this one: `session.activeTurnId` is passed as `null`,
 * exactly as `sessionRef` in fabric.ts builds it for an owned thread.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CodexAppServer } from '../src/main/adapters/codex-app-server';
import { CodexChatHost } from '../src/main/adapters/codex-chat';
import { createAgentAdapters } from '../src/main/adapters/agent-adapter';
import type { ClaudeChatHost } from '../src/main/adapters/claude-chat';

async function main() {
  const cwd = process.argv[2];
  assert(cwd, 'Provide a disposable working folder');
  fs.mkdirSync(cwd, { recursive: true });

  const server = new CodexAppServer();
  const host = new CodexChatHost(server);
  const adapters = createAgentAdapters({
    codex: server,
    claudeControl: { queueSteer() {}, queueInterrupt() {}, setToolGate() {} },
    claudeChat: { has: () => false, interrupt: async () => false } as unknown as ClaudeChatHost,
  });
  const adapter = adapters.get('codex')!;

  const turnStatus = (t: Record<string, unknown> | null): unknown => (t ? t.status : undefined);

  let completed = 0;
  let lastTurn: Record<string, unknown> | null = null;
  server.on('notification', ({ method, params }) => {
    if (method === 'turn/completed') { completed++; lastTurn = params.turn as Record<string, unknown>; }
  });
  host.on('update', (e) => console.log('update', e));

  const waitFor = async (test: () => boolean, ms = 60_000) => {
    const deadline = Date.now() + ms;
    while (!test()) {
      assert(Date.now() < deadline, 'Timed out waiting for structured event');
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  try {
    assert(await server.start());
    const started = await host.start('probe', cwd);
    console.log('started', started);

    assert(await host.send(
      'probe',
      'Think step by step, out loud, about the history of the Roman aqueduct system for several paragraphs. Do not use any tools. Just keep writing.',
    ));
    // Give the turn a moment to actually be running before interrupting --
    // mirrors a person clicking Stop shortly after a turn starts.
    await new Promise((r) => setTimeout(r, 2000));

    const t0 = Date.now();
    // This is exactly what fabric.ts's sessionRef() builds for an owned
    // thread: no activeTurnId, forcing the readActiveTurn(thread/read)
    // fallback inside CodexAdapter.interruptTurn.
    const accepted = await adapter.interruptTurn({
      id: 'probe',
      externalId: started.threadId,
      activeTurnId: null,
      cwd,
    });
    console.log(`interruptTurn() -> ${accepted} (${Date.now() - t0}ms)`);
    assert(accepted, 'interruptTurn must find the in-progress turn via thread/read and interrupt it');

    await waitFor(() => completed >= 1);
    console.log('turn/completed ->', JSON.stringify(lastTurn));
    assert.equal(turnStatus(lastTurn), 'interrupted', 'The turn must end as interrupted, not merely finished');

    // The thread must still be usable afterward.
    assert(await host.send('probe', 'Reply with exactly second-turn-ok. Do not call tools.'));
    await waitFor(() => completed >= 2);
    console.log('second turn ->', JSON.stringify(lastTurn));
    assert.notEqual(turnStatus(lastTurn), 'failed', 'The thread must still accept and complete a turn after being interrupted');
    console.log('PASS: owned Codex thread interrupted through AgentAdapter, thread stayed usable.');
  } finally {
    await host.terminate('probe').catch(() => {});
    server.stop();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
