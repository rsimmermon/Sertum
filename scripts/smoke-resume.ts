/**
 * Live end-to-end probe for `session-resume`: create a stream session, teach
 * it a secret, end it, then resume it purely from `session/resumable` +
 * `session/resume` and confirm the secret survives -- for both Claude and
 * Codex. Run with Electron's ELECTRON_RUN_AS_NODE=1 for node-pty's ABI.
 * Set SMOKE_SKIP_CODEX=1 to run the Claude leg alone.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFabric } from '../src/daemon/fabric';
import type { ConversationSnapshot, ResumableSession, SessionSnapshot } from '../src/shared/types';

async function waitIdle(
  fabric: ReturnType<typeof createFabric>,
  id: string,
  current: Map<string, SessionSnapshot>,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // chat/send's own promise resolves as soon as turn/start's request round
  // trip completes; the status transition to 'working' is a separate,
  // asynchronous notification that can land a beat later (verified up to
  // ~90ms for Codex, which has no optimistic status on send the way Claude
  // does). Checking status *before* ever giving that notification a chance
  // to arrive can see a turn that just started as already 'idle' and return
  // instantly -- which is exactly what let a real in-flight second turn get
  // reported as already finished. Always wait at least one interval before
  // trusting an idle read.
  do {
    await new Promise((r) => setTimeout(r, 150));
    assert(Date.now() < deadline, `session ${id} never went idle (status: ${current.get(id)?.status})`);
  } while (current.get(id)?.status !== 'idle');
}

function lastAssistantText(c: ConversationSnapshot): string {
  const msg = [...c.items].reverse().find((i) => i.kind === 'message' && i.role === 'assistant');
  return msg && msg.kind === 'message' ? msg.text : '';
}

async function probeAgent(
  fabric: ReturnType<typeof createFabric>,
  current: Map<string, SessionSnapshot>,
  agent: 'claude' | 'codex',
  root: string,
): Promise<void> {
  console.log(`--- ${agent} ---`);
  const secret = `PINEAPPLE-${agent.toUpperCase()}-4471`;

  const session = (await fabric.handle('session/create', {
    agent,
    transport: 'stream',
    cwd: root,
    label: `resume probe (${agent})`,
  })) as SessionSnapshot;
  assert.equal(session.transport, 'stream');
  console.log(`created ${agent} session ${session.id}, externalId=${session.externalId}`);

  assert(
    await fabric.handle('chat/send', {
      id: session.id,
      text: `Remember the codeword ${secret}. Reply with just OK.`,
    }),
  );
  await waitIdle(fabric, session.id, current);
  const reportedPath = current.get(session.id)?.transcriptPath;
  console.log('turn 1 complete; snapshot transcriptPath =', reportedPath);

  // Claude's own transcript write lags the turn's `result` event by roughly
  // a second; wait for it so the session is genuinely resumable by the time
  // it is looked up below, rather than racing that write.
  if (agent === 'claude' && reportedPath) {
    for (let i = 0; i < 10 && !fs.existsSync(reportedPath); i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    assert(fs.existsSync(reportedPath), 'transcript file never appeared');
  }

  const externalId = session.externalId;
  assert(externalId, 'session must report an externalId to be resumable');

  // End the process entirely -- resuming must work with nothing left in memory.
  await fabric.handle('session/kill', session.id);
  const killDeadline = Date.now() + 15_000;
  while (current.get(session.id)?.exitCode === null && Date.now() < killDeadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.notEqual(current.get(session.id)?.exitCode, null, 'original process never reported exiting');

  let resumable: ResumableSession[] = [];
  let found: ResumableSession | undefined;
  for (let i = 0; i < 10 && !found; i++) {
    resumable = (await fabric.handle('session/resumable', { agent, cwd: root })) as ResumableSession[];
    found = resumable.find((r) => r.externalId === externalId);
    if (!found) await new Promise((r) => setTimeout(r, 1000));
  }
  assert(found, `resumed session ${externalId} not found in session/resumable: ${JSON.stringify(resumable.map((r) => r.externalId))}`);
  console.log('found in resumable list:', JSON.stringify(found));

  const resumed = (await fabric.handle('session/resume', {
    r: found,
    label: `resumed (${agent})`,
  })) as SessionSnapshot;
  assert.equal(resumed.externalId, externalId, 'resume must reuse the exact same agent-side id');
  console.log(`resumed as new Sertum session ${resumed.id}, transcriptPath=${resumed.transcriptPath}`);

  assert(
    await fabric.handle('chat/send', {
      id: resumed.id,
      text: 'What codeword did I ask you to remember? Reply with just the codeword.',
    }),
  );
  await waitIdle(fabric, resumed.id, current);
  console.log('turn 2 complete; snapshot transcriptPath =', current.get(resumed.id)?.transcriptPath);

  let reply = '';
  let lastConversation: ConversationSnapshot | undefined;
  for (let i = 0; i < 20; i++) {
    lastConversation = (await fabric.handle('conversation/read', resumed.id)) as ConversationSnapshot;
    reply = lastAssistantText(lastConversation);
    if (reply) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('conversation path/reason/items:', lastConversation?.path, lastConversation?.reason, lastConversation?.items.length);
  console.log('assistant reply after resume:', JSON.stringify(reply));
  assert(reply.includes(secret), `resumed session did not recall the codeword; got: ${reply}`);

  await fabric.handle('session/kill', resumed.id);
  console.log(`PASS: ${agent} resume round-trip retained context across a killed process.`);
}

async function main() {
  const root = path.resolve('.temp/resume-probe');
  fs.mkdirSync(root, { recursive: true });
  const fabric = createFabric({ userDataDir: root });
  const current = new Map<string, SessionSnapshot>();
  fabric.onEvent((name, value) => {
    if (name === 'session:updated') {
      const s = value as SessionSnapshot;
      current.set(s.id, s);
    }
  });
  try {
    await fabric.start();
    await probeAgent(fabric, current, 'claude', root);
    if (process.env.SMOKE_SKIP_CODEX !== '1') {
      await probeAgent(fabric, current, 'codex', root);
    }
    console.log('ALL PASS');
  } finally {
    await fabric.shutdown();
  }
}
main().catch((e) => {
  console.error('FAILED:', e);
  process.exitCode = 1;
});
