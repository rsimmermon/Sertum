// The daemon's message queue, against a host whose turns are driven by hand.
//
//   npx esbuild scripts/test-chat-queue.ts --bundle --platform=node \
//     --format=esm --outfile=<tmp>/queue.mjs && node <tmp>/queue.mjs
import assert from 'node:assert/strict';
import { ChatQueue, MAX_ATTEMPTS } from '../src/daemon/chat-queue';
import type { QueuedChatMessage, SessionSnapshot } from '../src/shared/types';

const GRACE_MS = 40;
const RETRY_MS = 5;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function rig(options: {
  reportsOnWrite?: boolean;
  transportFails?: () => string | null;
  retryMs?: number;
} = {}) {
  const session = {
    id: 's',
    origin: 'owned',
    exitCode: null,
    turnActive: false,
    messageQueue: [],
    queueStalled: null,
  } as unknown as SessionSnapshot;
  const sent: string[] = [];
  const delivered: Array<{ text: string; stillQueued: number }> = [];
  let held: QueuedChatMessage[] = [];
  let stalled: string | null = null;
  const queue = new ChatQueue({
    session: () => session,
    deliver: async (_s, text) => {
      const failure = options.transportFails?.() ?? null;
      if (failure) return failure;
      sent.push(text);
      if (options.reportsOnWrite) setTurn(true);
      return null;
    },
    publish: (_id, entries, why) => {
      held = entries;
      stalled = why;
    },
    delivered: (_id, message, stillQueued) => delivered.push({ text: message.text, stillQueued }),
  }, GRACE_MS, options.retryMs ?? RETRY_MS);
  function setTurn(active: boolean) {
    session.turnActive = active;
    queue.sessionChanged(session);
  }
  return {
    session, sent, delivered, queue, setTurn,
    held: () => held.map((entry) => entry.text),
    stalled: () => stalled,
    idOf: (text: string) => held.find((entry) => entry.text === text)?.id ?? -1,
  };
}

const checks: Array<[string, () => Promise<void>]> = [
  ['an idle session takes a message at once, and nothing is queued', async () => {
    const r = rig({ reportsOnWrite: true });
    assert.deepEqual(await r.queue.submit('s', 'one', []), { outcome: 'sent' });
    assert.deepEqual(r.sent, ['one']);
    assert.deepEqual(r.held(), []);
    assert.deepEqual(r.delivered, [{ text: 'one', stillQueued: 0 }]);
  }],
  ['a turn in progress holds messages, in order', async () => {
    const r = rig({ reportsOnWrite: true });
    r.setTurn(true);
    assert.deepEqual(await r.queue.submit('s', 'one', []), { outcome: 'queued', position: 1 });
    assert.deepEqual(await r.queue.submit('s', 'two', []), { outcome: 'queued', position: 2 });
    assert.deepEqual(r.sent, []);
    assert.deepEqual(r.held(), ['one', 'two']);
  }],
  ['one message goes in per turn boundary', async () => {
    const r = rig({ reportsOnWrite: true });
    r.setTurn(true);
    await r.queue.submit('s', 'one', []);
    await r.queue.submit('s', 'two', []);
    r.setTurn(false);
    await wait(0);
    assert.deepEqual(r.sent, ['one']);
    assert.deepEqual(r.held(), ['two']);
    assert.deepEqual(r.delivered, [{ text: 'one', stillQueued: 1 }]);
    assert.equal(r.session.turnActive, true, 'delivering started the next turn');
    r.queue.sessionChanged(r.session);
    await wait(0);
    assert.deepEqual(r.sent, ['one'], 'the running turn must not take the next');
    r.setTurn(false);
    await wait(0);
    assert.deepEqual(r.sent, ['one', 'two']);
  }],
  ['a PTY agent that has not reported its turn yet is not sent a second message', async () => {
    const r = rig();
    assert.deepEqual(await r.queue.submit('s', 'one', []), { outcome: 'sent' });
    assert.deepEqual(await r.queue.submit('s', 'two', []), { outcome: 'queued', position: 1 });
    r.queue.sessionChanged(r.session); // An unrelated update, still reading idle.
    await wait(0);
    assert.deepEqual(r.sent, ['one']);
    r.setTurn(true);
    r.setTurn(false);
    await wait(0);
    assert.deepEqual(r.sent, ['one', 'two']);
  }],
  ['a report that never comes does not strand the queue', async () => {
    const r = rig();
    await r.queue.submit('s', 'one', []);
    await r.queue.submit('s', 'two', []);
    assert.deepEqual(r.sent, ['one']);
    await wait(GRACE_MS * 2);
    assert.deepEqual(r.sent, ['one', 'two']);
  }],
  ['a message arriving behind a queue cannot overtake it', async () => {
    const r = rig();
    r.setTurn(true);
    await r.queue.submit('s', 'one', []);
    r.session.turnActive = false; // Free, but the queue has not been told yet.
    assert.deepEqual(await r.queue.submit('s', 'two', []), { outcome: 'queued', position: 2 });
    await wait(0);
    assert.deepEqual(r.sent, ['one']);
    await wait(GRACE_MS * 2);
    assert.deepEqual(r.sent, ['one', 'two']);
  }],
  ['removal takes only the message named', async () => {
    const r = rig();
    r.setTurn(true);
    await r.queue.submit('s', 'one', []);
    await r.queue.submit('s', 'two', []);
    await r.queue.submit('s', 'three', []);
    assert.equal(r.queue.remove('s', r.idOf('two')), true);
    assert.deepEqual(r.held(), ['one', 'three']);
    assert.equal(r.queue.remove('s', 9999), false);
  }],
  ['an immediate failure is refused, so the writer keeps the draft', async () => {
    const r = rig({ transportFails: () => 'busy' });
    assert.deepEqual(await r.queue.submit('s', 'one', []), { outcome: 'refused', reason: 'busy' });
    assert.deepEqual(r.held(), []);
    assert.deepEqual(r.delivered, []);
  }],
  ['a momentary refusal goes in by itself, without a word to anyone', async () => {
    let attempts = 0;
    const r = rig({
      reportsOnWrite: true,
      retryMs: 100, // Well past Windows' timer resolution, so "not yet" holds.
      transportFails: () => (++attempts === 1 ? 'busy' : null),
    });
    r.setTurn(true);
    await r.queue.submit('s', 'one', []);
    r.setTurn(false);
    await wait(0);
    assert.deepEqual(r.sent, []);
    assert.equal(r.stalled(), null);
    r.queue.sessionChanged(r.session);
    await wait(0);
    assert.equal(attempts, 1, 'an unrelated update must not retry early');
    await wait(300);
    assert.deepEqual(r.sent, ['one']);
    assert.equal(r.stalled(), null);
  }],
  ['a lasting failure stops, stays queued, says why, and a turn boundary revives it', async () => {
    let failure: string | null = 'busy';
    let attempts = 0;
    const r = rig({
      reportsOnWrite: true,
      transportFails: () => {
        attempts += 1;
        return failure;
      },
    });
    r.setTurn(true);
    await r.queue.submit('s', 'one', []);
    r.setTurn(false);
    await wait(RETRY_MS * 2 ** MAX_ATTEMPTS * 2);
    assert.equal(attempts, MAX_ATTEMPTS);
    assert.deepEqual(r.held(), ['one']);
    assert.equal(r.stalled(), 'busy');
    r.queue.sessionChanged(r.session);
    await wait(RETRY_MS * 4);
    assert.equal(attempts, MAX_ATTEMPTS, 'it has stopped until something changes');
    failure = null;
    r.setTurn(true);
    r.setTurn(false);
    await wait(0);
    assert.deepEqual(r.sent, ['one']);
    assert.equal(r.stalled(), null);
  }],
  ['a failing send that reports working then an error cannot retry forever', async () => {
    let attempts = 0;
    let setTurn: (active: boolean) => void = () => undefined;
    const r = rig({
      transportFails: () => {
        attempts += 1;
        setTurn(true);
        setTurn(false);
        return 'turn/start failed';
      },
    });
    setTurn = r.setTurn;
    r.setTurn(true);
    await r.queue.submit('s', 'one', []);
    setTurn = () => undefined;
    r.session.turnActive = false;
    setTurn = r.setTurn;
    r.queue.sessionChanged(r.session);
    await wait(RETRY_MS * 2 ** MAX_ATTEMPTS * 3);
    assert.equal(attempts, MAX_ATTEMPTS);
    assert.equal(r.stalled(), 'turn/start failed');
  }],
  ['removing a stuck message lets the next one try', async () => {
    let attempts = 0;
    const r = rig({
      reportsOnWrite: true,
      transportFails: () => (++attempts <= MAX_ATTEMPTS ? 'busy' : null),
    });
    r.setTurn(true);
    await r.queue.submit('s', 'stuck', []);
    await r.queue.submit('s', 'next', []);
    r.setTurn(false);
    await wait(RETRY_MS * 2 ** MAX_ATTEMPTS * 2);
    assert.equal(r.stalled(), 'busy');
    assert.equal(r.queue.remove('s', r.idOf('stuck')), true);
    await wait(0);
    assert.deepEqual(r.sent, ['next']);
    assert.equal(r.stalled(), null);
  }],
  ['an exited session refuses, and what it held stays visible', async () => {
    const r = rig();
    r.setTurn(true);
    await r.queue.submit('s', 'one', []);
    (r.session as { exitCode: number | null }).exitCode = 1;
    r.setTurn(false);
    await wait(0);
    assert.deepEqual(r.sent, []);
    assert.deepEqual(r.held(), ['one']);
    assert.equal((await r.queue.submit('s', 'two', [])).outcome, 'refused');
  }],
  ['a monitored session refuses', async () => {
    const r = rig();
    (r.session as { origin: string }).origin = 'monitored';
    assert.equal((await r.queue.submit('s', 'one', [])).outcome, 'refused');
    assert.deepEqual(r.sent, []);
  }],
];

let failed = 0;
for (const [name, check] of checks) {
  try {
    await check();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${String(error)}`);
  }
}
console.log(`${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
