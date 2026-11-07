/**
 * The daemon's message queue against real agents: Claude and Codex over their
 * structured hosts, and Claude over a PTY with a multi-line message. In each, one
 * message goes straight in, the next waits for that turn, and one is removed.
 *
 *   npx esbuild scripts/smoke-chat-queue.ts --bundle --platform=node --format=cjs \
 *     --external:node-pty --outfile=.temp/smoke-queue.cjs
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron .temp/smoke-queue.cjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFabric } from '../src/daemon/fabric';
import type {
  ChatDeliveredEvent,
  ChatSubmitResult,
  ConversationSnapshot,
  SessionSnapshot,
} from '../src/shared/types';

type Fabric = ReturnType<typeof createFabric>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const current = new Map<string, SessionSnapshot>();
const log: Array<{ at: number; id: string; what: string }> = [];
const started = Date.now();
function note(id: string, what: string): void {
  log.push({ at: Date.now() - started, id, what });
  console.log(`  ${String(Date.now() - started).padStart(6)}ms ${what}`);
}

async function until(what: string, test: () => boolean, ms = 90_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

async function userAndAssistantTexts(fabric: Fabric, id: string, expectUsers: number) {
  let texts: Array<{ role: string; text: string }> = [];
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const read = await fabric.handle('conversation/read', { id }) as ConversationSnapshot;
    texts = (read.items ?? []).flatMap((item) => item.kind === 'message' ? [{ role: item.role, text: item.text }] : []);
    const users = texts.filter((t) => t.role === 'user').length;
    if (users >= expectUsers && texts.at(-1)?.role === 'assistant') break;
    await sleep(500);
  }
  return texts;
}

async function leg(
  fabric: Fabric,
  name: string,
  spec: Record<string, unknown>,
  first: string,
  marker: string,
  ready: (s: SessionSnapshot) => boolean,
) {
  console.log(`--- ${name} ---`);
  const session = await fabric.handle('session/create', spec) as SessionSnapshot;
  const { id } = session;
  await until('the session to be ready', () => {
    const s = current.get(id) ?? session;
    return ready(s) && !s.turnActive;
  });

  const submit = (text: string) =>
    fabric.handle('chat/submit', { id, text }) as Promise<ChatSubmitResult>;
  const answers = await Promise.all([
    submit(first),
    submit(`Reply with only the word ${marker}TWO.`),
    submit(`Reply with only the word ${marker}THREE.`),
  ]);
  note(id, `submitted three: ${answers.map((a) => a.outcome).join(', ')}`);
  assert.deepEqual(answers.map((a) => a.outcome), ['sent', 'queued', 'queued']);

  const held = current.get(id)?.messageQueue ?? [];
  assert.deepEqual(held.map((m) => m.text), [
    `Reply with only the word ${marker}TWO.`,
    `Reply with only the word ${marker}THREE.`,
  ], 'every client sees the queue, in order, on the snapshot');
  const third = held[1];
  assert(third);
  assert.equal(await fabric.handle('chat/queue-remove', { id, messageId: third.id }), true);
  assert.equal(current.get(id)?.messageQueue.length, 1, 'removal reaches the snapshot');
  note(id, 'removed the third');

  await until('the queue to drain', () => current.get(id)?.messageQueue.length === 0, 120_000);
  await until('the last turn to finish', () => current.get(id)?.turnActive === false, 120_000);

  const mine = log.filter((entry) => entry.id === id).map((entry) => entry.what);
  const firstTurnEnded = mine.indexOf('turn ended');
  const secondSent = mine.findIndex((what) => what.startsWith('delivered') && what.includes('TWO'));
  assert(firstTurnEnded >= 0 && secondSent > firstTurnEnded, `the second waited for the first turn: ${mine.join(' | ')}`);
  assert(mine.indexOf('turn started') < firstTurnEnded, 'a real turn ran first');

  const texts = await userAndAssistantTexts(fabric, id, 2);
  const users = texts.filter((t) => t.role === 'user').map((t) => t.text);
  assert.equal(users.length, 2, `transcript users: ${JSON.stringify(users)}`);
  assert.equal(users[0], first, 'the first message arrived whole');
  assert(users[1]?.includes(`${marker}TWO`));
  assert(!texts.some((t) => t.text.includes(`${marker}THREE`)), 'the removed message never went in');
  const answersSeen = texts.filter((t) => t.role === 'assistant').map((t) => t.text);
  assert(answersSeen.some((t) => t.includes(`${marker}ONE`)), `answers: ${JSON.stringify(answersSeen)}`);
  assert(answersSeen.some((t) => t.includes(`${marker}TWO`)), `answers: ${JSON.stringify(answersSeen)}`);
  console.log(`  transcript: ${JSON.stringify(texts)}`);
  await fabric.handle('session/kill', id);
  console.log(`PASS: ${name}`);
}

async function main() {
  const root = path.resolve('.temp/queue-probe');
  fs.mkdirSync(root, { recursive: true });
  const fabric = createFabric({ userDataDir: root });
  const wasActive = new Map<string, boolean>();
  let answerTrust = true;
  fabric.onEvent((name, value) => {
    if (name === 'session:updated') {
      const s = value as SessionSnapshot;
      current.set(s.id, s);
      if (wasActive.get(s.id) !== s.turnActive) {
        if (s.turnActive) note(s.id, 'turn started');
        else if (wasActive.get(s.id)) note(s.id, 'turn ended');
        wasActive.set(s.id, s.turnActive);
      }
    } else if (name === 'chat:delivered') {
      const e = value as ChatDeliveredEvent;
      note(e.id, `delivered ${JSON.stringify(e.message.text)} (${e.stillQueued} still queued)`);
    } else if (name === 'pty:data' && answerTrust) {
      // This test's own way past a first-run prompt in its scratch folder. Reading
      // a terminal is what the product must never do; a test may.
      const e = value as { id: string; data: string };
      if (/trust/i.test(e.data)) {
        answerTrust = false;
        setTimeout(() => void fabric.handle('pty/input', { id: e.id, data: '\r' }), 500);
      }
    }
  });
  const only = process.env.SMOKE_ONLY;
  const wanted = (leg: string) => !only || only === leg;
  try {
    await fabric.start();
    if (wanted('claude')) {
      await leg(fabric, 'Claude over its structured host', {
        agent: 'claude', transport: 'stream', cwd: root, label: 'queue probe',
      }, 'Reply with only the word CLAUDEONE.', 'CLAUDE', () => true);
    }
    if (wanted('codex')) {
      await leg(fabric, 'Codex over its structured host', {
        agent: 'codex', transport: 'stream', cwd: root, label: 'queue probe',
      }, 'Reply with only the word CODEXONE.', 'CODEX', () => true);
    }
    if (wanted('pty')) {
      await leg(fabric, 'Claude over a PTY, with a multi-line first message', {
        agent: 'claude', transport: 'pty', cwd: root, label: 'queue probe',
      }, 'This message has two lines.\nReply with only the word PTYONE.', 'PTY',
      (s) => s.lastEventAt !== null);
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
