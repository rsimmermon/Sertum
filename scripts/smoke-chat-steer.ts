/**
 * A message typed mid-turn joins the running turn instead of queueing, against
 * real Claude and Codex structured hosts. Whether the agent folds it into that
 * turn or answers it right after is the agent's call; either way it must not be
 * queued, must reach the transcript, and must be acted on.
 *
 *   npx esbuild scripts/smoke-chat-steer.ts --bundle --platform=node --format=cjs \
 *     --external:node-pty --outfile=.temp/smoke-steer.cjs
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron .temp/smoke-steer.cjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFabric } from '../src/daemon/fabric';
import type {
  ChatSubmitResult,
  ConversationSnapshot,
  SessionSnapshot,
} from '../src/shared/types';

type Fabric = ReturnType<typeof createFabric>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const current = new Map<string, SessionSnapshot>();
const turnStarts = new Map<string, number>();

async function until(what: string, test: () => boolean, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

async function leg(fabric: Fabric, agent: 'claude' | 'codex', root: string, marker: string) {
  console.log(`--- ${agent} ---`);
  const session = await fabric.handle('session/create', {
    agent, transport: 'stream', cwd: root, label: 'steer probe',
  }) as SessionSnapshot;
  const { id } = session;
  await until('ready', () => !(current.get(id) ?? session).turnActive);
  const submit = (text: string) =>
    fabric.handle('chat/submit', { id, text }) as Promise<ChatSubmitResult>;

  const first = 'Write the numbers from 1 to 150 in words, one per line, then stop.';
  assert.equal((await submit(first)).outcome, 'sent');
  await until('the turn to start', () => current.get(id)?.turnActive === true);
  await sleep(2500);
  assert.equal(current.get(id)?.turnActive, true, 'the first turn is still running');
  const steer = `New instruction: end your reply with the single word ${marker}.`;
  const result = await submit(steer);
  console.log(`  mid-turn submit: ${JSON.stringify(result)}`);
  assert.deepEqual(result, { outcome: 'sent' }, 'a running turn takes the message');
  assert.equal(current.get(id)?.messageQueue.length ?? 0, 0, 'nothing was queued');

  // A message that missed every boundary of the running turn runs right after
  // it, so idle has to hold for a while before it counts.
  let idleSince = 0;
  await until('every turn to finish', () => {
    if (current.get(id)?.turnActive !== false) idleSince = 0;
    else idleSince ||= Date.now();
    return idleSince > 0 && Date.now() - idleSince > 4000;
  }, 180_000);

  let texts: Array<{ role: string; text: string }> = [];
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const read = await fabric.handle('conversation/read', { id }) as ConversationSnapshot;
    texts = (read.items ?? []).flatMap((item) =>
      item.kind === 'message' ? [{ role: item.role, text: item.text }] : []);
    if (texts.some((t) => t.role === 'assistant' && t.text.includes(marker))) break;
    await sleep(500);
  }
  const users = texts.filter((t) => t.role === 'user').map((t) => t.text);
  assert(users.some((t) => t.includes(marker)), `the steer reached the transcript: ${JSON.stringify(users)}`);
  assert(texts.some((t) => t.role === 'assistant' && t.text.includes(marker)),
    `the agent acted on it: ${JSON.stringify(texts.map((t) => [t.role, t.text.slice(-80)]))}`);
  const turns = turnStarts.get(id) ?? 0;
  // Idle-to-active flips, which over-count turns: a status can dip between them.
  console.log(`  times the session went active: ${turns}`);
  await fabric.handle('session/kill', id);
  console.log(`PASS: ${agent}`);
}

async function main() {
  const root = path.resolve('.temp/steer-probe');
  fs.mkdirSync(root, { recursive: true });
  const fabric = createFabric({ userDataDir: root });
  const wasActive = new Map<string, boolean>();
  fabric.onEvent((name, value) => {
    if (name !== 'session:updated') return;
    const s = value as SessionSnapshot;
    current.set(s.id, s);
    if (s.turnActive && !wasActive.get(s.id)) turnStarts.set(s.id, (turnStarts.get(s.id) ?? 0) + 1);
    wasActive.set(s.id, s.turnActive);
  });
  const only = process.env.SMOKE_ONLY;
  try {
    await fabric.start();
    if (!only || only === 'claude') await leg(fabric, 'claude', root, 'CLAUDESTEER');
    if (!only || only === 'codex') await leg(fabric, 'codex', root, 'CODEXSTEER');
    console.log('ALL PASS');
  } finally {
    await fabric.shutdown();
  }
}
main().catch((e) => {
  console.error('FAILED:', e);
  process.exitCode = 1;
});
