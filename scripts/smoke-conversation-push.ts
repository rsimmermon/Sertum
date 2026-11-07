/**
 * The conversation told to clients rather than asked for, against real agents: a
 * turn raises `conversation:changed`, quiet raises nothing, and following only
 * those events reaches the same answer the file holds. Then a real tool result
 * past the display cap comes back whole.
 *
 *   npx esbuild scripts/smoke-conversation-push.ts --bundle --platform=node --format=cjs \
 *     --external:node-pty --outfile=.temp/smoke-push.cjs
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron .temp/smoke-push.cjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFabric } from '../src/daemon/fabric';
import type {
  ChatItem,
  ConversationItemRead,
  ConversationRead,
  ConversationSnapshot,
  PendingApproval,
  SessionSnapshot,
} from '../src/shared/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LINES = 400;
const MARK = 'PUSHMARK';
const PROMPT = `Use your shell tool to run exactly this and nothing else: node -e "for(let i=0;i<${LINES};i++)console.log('${MARK} line '+i+' padding padding padding padding')" Then reply with only the word DONE.`;

async function run(agent: 'claude' | 'codex', fabric: ReturnType<typeof createFabric>, cwd: string, current: Map<string, SessionSnapshot>, changes: Map<string, number[]>) {
  const session = await fabric.handle('session/create', {
    agent, transport: 'stream', cwd, label: `push ${agent}`,
  }) as SessionSnapshot;
  const { id } = session;
  const started = Date.now();

  // A client that reads only when told, as a phone will.
  let version: string | null = null;
  let held: ChatItem[] = [];
  let start = 0;
  let reads = 0;
  const follow = async () => {
    reads += 1;
    const read = await fabric.handle('conversation/read', {
      id, ...(version ? { known: version, start, end: start + held.length, follow: true } : {}),
    }) as ConversationRead;
    if ('unchanged' in read) return;
    if ('delta' in read) {
      for (const { index, item } of read.changed) held[index - start] = item;
      version = read.version;
    } else {
      held = read.items;
      start = read.start;
      version = read.version;
    }
  };
  let handled = 0;
  const pump = setInterval(() => {
    const seen = changes.get(id)?.length ?? 0;
    if (seen > handled) {
      handled = seen;
      void follow();
    }
  }, 20);

  await fabric.handle('chat/submit', { id, text: PROMPT });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const s = current.get(id);
    const last = held.at(-1);
    if (s && !s.turnActive && last?.kind === 'message' && last.role === 'assistant' && /DONE/.test(last.text)) break;
    await sleep(200);
  }
  clearInterval(pump);
  const times = changes.get(id) ?? [];
  assert(times.length > 0, 'a real turn raised events');
  const lastIsDone = held.at(-1);
  assert(lastIsDone?.kind === 'message' && /DONE/.test(lastIsDone.text), `reached the answer on events alone (${held.length} items, ${times.length} events)`);
  console.log(`PASS ${agent}: followed a whole turn on ${times.length} events and ${reads} reads in ${Math.round((Date.now() - started) / 1000)}s`);

  const whole = await fabric.handle('conversation/page', { id, from: 0 }) as ConversationSnapshot;
  assert.deepEqual(held, whole.items.slice(start), 'what events built matches a fresh read');
  console.log(`PASS ${agent}: what the events built equals a fresh read of ${whole.items.length} items`);

  // Quiet: no turn, so nothing should be sent at all.
  await sleep(1500);
  const before = times.length;
  await sleep(3000);
  assert.equal(times.length, before, 'no events while nothing is written');
  console.log(`PASS ${agent}: 3s of quiet raised no events`);

  const index = whole.items.findIndex((item) => item.kind === 'tool' && item.more === 'available');
  assert(index >= 0, 'the tool output really was shortened');
  const shortened = whole.items[index] as ChatItem & { kind: 'tool' };
  assert.equal(shortened.output?.length, 2_000);
  const read = await fabric.handle('conversation/item', {
    id, index, known: whole.version,
  }) as ConversationItemRead;
  assert('item' in read && read.item.kind === 'tool', JSON.stringify(read).slice(0, 200));
  const lines = (read.item.output ?? '').split('\n').filter((l) => l.includes(`${MARK} line`));
  assert.equal(lines.length, LINES, `every line back: ${lines.length}`);
  assert.equal(read.item.more, undefined);
  console.log(`PASS ${agent}: tool output of ${read.item.output?.length} chars back whole from a ${shortened.output?.length}-char item`);
  await fabric.handle('session/kill', id);
}

async function main() {
  const root = path.resolve('.temp/push-probe');
  fs.mkdirSync(root, { recursive: true });
  const fabric = createFabric({ userDataDir: root });
  const current = new Map<string, SessionSnapshot>();
  const changes = new Map<string, number[]>();
  fabric.onEvent((name, value) => {
    if (name === 'session:updated') current.set((value as SessionSnapshot).id, value as SessionSnapshot);
    if (name === 'approval:needed') {
      const ask = value as PendingApproval;
      void fabric.handle('approval/answer', {
        id: ask.id, sessionId: ask.sessionId, tool: ask.tool, subject: ask.subject,
        answer: { decision: 'allow', scope: 'once' },
      });
    }
    if (name === 'conversation:changed') {
      const { id } = value as { id: string };
      changes.set(id, [...(changes.get(id) ?? []), Date.now()]);
    }
  });
  try {
    await fabric.start();
    for (const agent of (process.argv[2] ?? 'claude,codex').split(',')) {
      await run(agent as 'claude' | 'codex', fabric, root, current, changes);
    }
    console.log('ALL PASS');
  } catch (error) {
    // Here rather than on main(): the exit below would otherwise swallow it.
    console.error('FAILED:', error);
    process.exitCode = 1;
  } finally {
    await fabric.shutdown();
    await sleep(500);
    process.exit(process.exitCode ?? 0);
  }
}
void main();
