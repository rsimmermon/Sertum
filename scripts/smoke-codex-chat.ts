/** Real app-server ownership/approval/lifecycle probe, isolated from user sessions.
 * Bundle with esbuild (platform=node), then run with a disposable cwd argument.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CodexAppServer } from '../src/main/adapters/codex-app-server';
import { CodexChatHost } from '../src/main/adapters/codex-chat';
import type { PendingApproval } from '../src/shared/types';

async function main() {
  const cwd = process.argv[2];
  assert(cwd, 'Provide a disposable working folder');
  fs.mkdirSync(cwd, { recursive: true });
  const server = new CodexAppServer();
  const host = new CodexChatHost(server);
  let completed = 0;
  let approvals = 0;
  let questions = 0;
  let exited = false;
  let modeApplied: { id: string; mode: string } | null = null;
  const waitFor = async (test: () => boolean, ms = 100_000) => {
    const deadline = Date.now() + ms;
    while (!test()) {
      assert(Date.now() < deadline, 'Timed out waiting for structured event');
      await new Promise(r => setTimeout(r, 100));
    }
  };
  server.on('log', (line: string) => console.log('server', line.slice(0, 180)));
  server.on('notification', ({ method, params }) => {
    if (method === 'turn/completed') { completed++; console.log('completed', JSON.stringify(params.turn)); }
  });
  host.on('update', e => console.log('update', e));
  host.on('exit', () => { exited = true; });
  host.on('mode-applied', (e: { id: string; mode: string }) => { modeApplied = e; console.log('mode-applied', e); });
  host.on('approval', (request: PendingApproval) => {
    if (request.card?.kind === 'questions') {
      questions++;
      assert(host.answer(request.id, request.sessionId, {
        decision: 'answer', scope: 'once', answers: Object.fromEntries(request.card.questions.map(q => [q.id!, [q.options[0]?.label ?? 'Blue']])),
      }));
      return;
    }
    approvals++;
    console.log('approval', request.tool, request.subject, request.allowedScopes);
    const before = completed;
    setTimeout(() => {
      assert.equal(completed, before, 'Turn must stay held until answered');
      assert(host.pending().some(p => p.id === request.id));
      assert(host.answer(request.id, request.sessionId, { decision: 'deny', scope: 'once' }));
      assert(!host.answer(request.id, request.sessionId, { decision: 'allow', scope: 'once' }));
    }, 1500);
  });
  try {
    assert(await server.start());
    const started = await host.start('probe', cwd);
    console.log('started', started);
    assert.equal(started.mode, 'codex-untrusted');
    assert(await host.send('probe', 'Use your apply_patch tool to create probe.txt containing hello. Do not use a shell command. If denied, stop and report that.'));
    await waitFor(() => completed >= 1);
    assert(approvals > 0, 'Expected a real approval request');
    assert(!fs.existsSync(`${cwd}/probe.txt`), 'Denied change must not be written');
    const mode = await host.setPermissionMode('probe', 'codex-on-request');
    console.log('mode', mode);
    assert.deepEqual(mode, { ok: true, mode: 'codex-on-request' });
    assert(await host.send('probe', 'Reply with exactly second-turn-ok. Do not call tools.'));
    await waitFor(() => completed >= 2);
    // Queued permission-mode change: asked mid-turn, it must not be refused,
    // a second ask before the first lands must overwrite it rather than
    // queueing both, and it takes the instant this turn ends.
    assert(await host.send('probe', 'Count slowly from one to five, one number per line, then stop. Do not call tools.'));
    const queuedFirst = await host.setPermissionMode('probe', 'codex-never');
    assert.deepEqual(queuedFirst, { ok: true, mode: 'codex-never', queued: true });
    const queuedSecond = await host.setPermissionMode('probe', 'codex-untrusted');
    assert.deepEqual(queuedSecond, { ok: true, mode: 'codex-untrusted', queued: true },
      'A second ask while one is queued must overwrite it, not queue both');
    await waitFor(() => completed >= 3);
    await waitFor(() => modeApplied !== null);
    assert.deepEqual(modeApplied, { id: 'probe', mode: 'codex-untrusted' },
      'The mode actually applied must be the last one asked for, not the first');
    // Exercise the native question wire directly; the product does not yet
    // expose collaboration-mode selection as a permission policy.
    await server.request('turn/start', {
      threadId: started.threadId,
      collaborationMode: { mode: 'plan', settings: { model: started.model, reasoning_effort: null, developer_instructions: null } },
      input: [{ type: 'text', text: 'Use request_user_input to ask me to choose Blue or Green for a hypothetical button. This is a protocol test: call the tool, then repeat my chosen answer and stop. Do not edit files.' }],
    });
    await waitFor(() => completed >= 4);
    assert(questions > 0, 'Expected a live structured question');
    await host.start('keeper', cwd);
    assert(await host.send('probe', 'Think carefully about the distribution of prime numbers, then give a short explanation. Do not use tools.'));
    assert(await host.terminate('probe'));
    assert(exited);
    assert(host.has('keeper') && server.connected, 'Ending an active thread must preserve the other session and server');
    assert(await host.terminate('keeper'));
    assert(!await host.send('probe', 'Must not run'));
    console.log('PASS: approval held/denied, duplicate rejected, multiple turns, policy echoed, queued policy change overwritten and applied on idle, native question answered, isolated thread closed.');
  } finally { server.stop(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
