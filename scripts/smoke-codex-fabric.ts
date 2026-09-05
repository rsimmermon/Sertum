/** Run the bundled script with Electron's ELECTRON_RUN_AS_NODE=1 for node-pty ABI. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFabric } from '../src/daemon/fabric';
import type { PendingApproval, SessionSnapshot, ConversationSnapshot } from '../src/shared/types';

async function main() {
  const root = path.resolve('.temp/codex-fabric-probe');
  fs.mkdirSync(root, { recursive: true });
  const fabric = createFabric({ userDataDir: root });
  let current: SessionSnapshot | undefined;
  let asks = 0;
  fabric.onEvent((name, value) => {
    if (name === 'session:updated') current = value as SessionSnapshot;
    if (name === 'approval:needed') {
      const ask = value as PendingApproval;
      asks++;
      const pending = fabric.handle('approval/pending', null) as PendingApproval[];
      assert(pending.some(p => p.id === ask.id));
      fabric.handle('approval/answer', { ...ask, answer: { decision: 'deny', scope: 'once' } });
    }
  });
  try {
    await fabric.start();
    const session = await fabric.handle('session/create', { agent: 'codex', transport: 'stream', cwd: root, label: 'fabric probe' }) as SessionSnapshot;
    assert.equal(session.agent, 'codex');
    assert.equal(session.transport, 'stream');
    assert.equal(session.status, 'idle');
    assert(session.transcriptPath);
    assert(await fabric.handle('chat/send', { id: session.id, text: 'Use apply_patch to create fabric-probe.txt with hello. If denied, stop.' }));
    const deadline = Date.now() + 100_000;
    while (!asks || current?.status !== 'idle') {
      assert(Date.now() < deadline, 'Turn did not finish');
      await new Promise(r => setTimeout(r, 100));
    }
    const conversation = await fabric.handle('conversation/read', session.id) as ConversationSnapshot;
    assert(conversation.items.length > 1, 'The public reader must return the owned transcript');
    assert.equal(conversation.path, session.transcriptPath);
    assert(!fs.existsSync(path.join(root, 'fabric-probe.txt')));
    console.log('PASS: fabric session creation, metadata, chat send, pending approvals, denial, status, exact transcript.');
  } finally { await fabric.shutdown(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
