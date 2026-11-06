// The transcript store against files written the way agents write them.
//
//   npx esbuild scripts/test-conversation-paging.ts --bundle --platform=node \
//     --format=esm --outfile=<tmp>/paging.mjs && node <tmp>/paging.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readConversation,
  readConversationItem,
  readConversationPage,
} from '../src/main/adapters/conversation';
import type {
  ChatItem,
  ConversationDelta,
  ConversationSnapshot,
} from '../src/shared/types';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sertum-paging-'));
let serial = 0;
const newFile = () => path.join(dir, `t${++serial}.jsonl`);

const user = (text: string) => JSON.stringify({
  type: 'user', message: { role: 'user', content: text }, timestamp: '2026-11-05T00:00:00Z',
});
const assistant = (text: string) => JSON.stringify({
  type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const toolUse = (id: string, command: string) => JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
});
const toolResult = (id: string, content: string) => JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
});
const textOf = (item: ChatItem | undefined) =>
  item?.kind === 'message' ? item.text : item?.kind === 'tool' ? item.output : null;

/** Files can land within one mtime tick, and the store rightly looks at both. */
async function append(file: string, ...lines: string[]) {
  await new Promise((resolve) => setTimeout(resolve, 15));
  fs.appendFileSync(file, lines.map((line) => `${line}\n`).join(''));
}

const checks: Array<[string, () => Promise<void>]> = [
  ['the newest page is bounded, and every item is reachable by paging', async () => {
    const file = newFile();
    const count = 1250;
    fs.writeFileSync(file, Array.from({ length: count }, (_, i) => `${user(`m${i}`)}\n`).join(''));
    const first = await readConversation('claude', file) as ConversationSnapshot;
    assert.equal(first.total, count);
    assert.equal(first.items.length, 200);
    assert.equal(first.start, count - 200);
    assert.equal(textOf(first.items[199]), `m${count - 1}`);

    const seen = first.items.map(textOf);
    let start = first.start;
    while (start > 0) {
      const page = await readConversationPage('claude', file, { before: start });
      assert.equal(page.start + page.items.length, start, 'pages must abut');
      seen.unshift(...page.items.map(textOf));
      start = page.start;
    }
    assert.deepEqual(seen, Array.from({ length: count }, (_, i) => `m${i}`));

    const forward = await readConversationPage('claude', file, { from: 10, limit: 5 });
    assert.equal(forward.start, 10);
    assert.deepEqual(forward.items.map(textOf), ['m10', 'm11', 'm12', 'm13', 'm14']);
  }],

  ['a poll with nothing new is one word', async () => {
    const file = newFile();
    fs.writeFileSync(file, `${user('hello')}\n`);
    const first = await readConversation('claude', file) as ConversationSnapshot;
    const again = await readConversation('claude', file, { known: first.version, start: 0, end: 1, follow: true });
    assert.deepEqual(again, { unchanged: true });
  }],

  ['a poll following the end is told only what arrived', async () => {
    const file = newFile();
    fs.writeFileSync(file, Array.from({ length: 500 }, (_, i) => `${user(`m${i}`)}\n`).join(''));
    const first = await readConversation('claude', file) as ConversationSnapshot;
    await append(file, assistant('new one'));
    const delta = await readConversation('claude', file, {
      known: first.version, start: first.start, end: first.total, follow: true,
    }) as ConversationDelta;
    assert.equal(delta.delta, true);
    assert.equal(delta.total, 501);
    assert.deepEqual(delta.changed.map((c) => c.index), [500]);
    assert.equal(textOf(delta.changed[0]?.item), 'new one');
  }],

  ['a tool result changes the tool item it pairs with, by index', async () => {
    const file = newFile();
    fs.writeFileSync(file, `${user('run it')}\n${toolUse('t1', 'ls')}\n${assistant('waiting')}\n`);
    const first = await readConversation('claude', file) as ConversationSnapshot;
    assert.equal((first.items[1] as ChatItem & { kind: 'tool' }).output, null);
    await append(file, toolResult('t1', 'a.txt'));
    const delta = await readConversation('claude', file, {
      known: first.version, start: 0, end: 3, follow: true,
    }) as ConversationDelta;
    assert.deepEqual(delta.changed.map((c) => c.index), [1]);
    assert.equal(textOf(delta.changed[0]?.item), 'a.txt');
  }],

  ['a change outside the window held is not sent, and arrivals wait for a follower', async () => {
    const file = newFile();
    fs.writeFileSync(file, `${toolUse('t1', 'ls')}\n${user('a')}\n${user('b')}\n${user('c')}\n`);
    const first = await readConversation('claude', file) as ConversationSnapshot;
    await append(file, toolResult('t1', 'out'), user('d'));
    const reader = await readConversation('claude', file, {
      known: first.version, start: 1, end: 3, follow: false,
    }) as ConversationDelta;
    assert.deepEqual(reader.changed, []);
    assert.equal(reader.total, 5);
  }],

  ['a half-written last line waits for the rest of itself', async () => {
    const file = newFile();
    const whole = user('complete');
    fs.writeFileSync(file, `${user('first')}\n${whole.slice(0, 20)}`);
    const first = await readConversation('claude', file) as ConversationSnapshot;
    assert.equal(first.total, 1);
    await append(file);
    fs.appendFileSync(file, `${whole.slice(20)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const delta = await readConversation('claude', file, {
      known: first.version, start: 0, end: 1, follow: true,
    }) as ConversationDelta;
    assert.equal(delta.total, 2);
    assert.equal(textOf(delta.changed[0]?.item), 'complete');
  }],

  ['a last record with no newline is read, and not read twice', async () => {
    const file = newFile();
    fs.writeFileSync(file, `${user('first')}\n${user('no newline')}`);
    const first = await readConversation('claude', file) as ConversationSnapshot;
    assert.equal(first.total, 2);
    await append(file);
    fs.appendFileSync(file, `\n${user('third')}\n`);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const delta = await readConversation('claude', file, {
      known: first.version, start: 0, end: 2, follow: true,
    }) as ConversationDelta;
    assert.equal(delta.total, 3);
    assert.deepEqual(delta.changed.map((c) => c.index), [2]);
  }],

  ['a file rewritten in place sends the client back to the newest page', async () => {
    const file = newFile();
    fs.writeFileSync(file, `${user('one')}\n${user('two')}\n${user('three')}\n`);
    const first = await readConversation('claude', file) as ConversationSnapshot;
    await new Promise((resolve) => setTimeout(resolve, 15));
    fs.writeFileSync(file, `${user('one')}\n${user('TWO, edited')}\n${user('three, also longer')}\n${user('four')}\n`);
    const after = await readConversation('claude', file, {
      known: first.version, start: 0, end: 3, follow: true,
    }) as ConversationSnapshot;
    assert.equal('delta' in after, false);
    assert.equal(after.start, 0);
    assert.deepEqual(after.items.map(textOf), ['one', 'TWO, edited', 'three, also longer', 'four']);
    assert.notEqual(after.version, first.version);
  }],

  ['a shrunken file does the same', async () => {
    const file = newFile();
    fs.writeFileSync(file, `${user('one')}\n${user('two')}\n`);
    const first = await readConversation('claude', file) as ConversationSnapshot;
    await new Promise((resolve) => setTimeout(resolve, 15));
    fs.writeFileSync(file, `${user('only')}\n`);
    const after = await readConversation('claude', file, {
      known: first.version, start: 0, end: 2, follow: true,
    }) as ConversationSnapshot;
    assert.deepEqual(after.items.map(textOf), ['only']);
  }],

  ['a page is bounded by size as well as count, and always moves', async () => {
    const file = newFile();
    const big = 'x'.repeat(23_000);
    const image = (n: number) => JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call_output', call_id: 'c', output: [{
          image_url: `data:image/png;base64,${String(n).padEnd(3_000_000, 'A')}`,
        }],
      },
    });
    const call = JSON.stringify({
      type: 'response_item', payload: { type: 'function_call', call_id: 'c', name: 'shot', arguments: '{}' },
    });
    fs.writeFileSync(file, [call, image(1), image(2), image(3), big && JSON.stringify({
      type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'end' }] },
    })].map((line) => `${line}\n`).join(''));
    const newest = await readConversation('codex', file) as ConversationSnapshot;
    const chars = newest.items.reduce((sum, item) => sum + (item.kind === 'image' ? item.src.length : 0), 0);
    assert.ok(chars <= 4 * 1024 * 1024, `carried ${chars} characters of images`);
    assert.ok(newest.items.length >= 1);
    let start = newest.start;
    let guard = 0;
    while (start > 0) {
      const page = await readConversationPage('codex', file, { before: start });
      assert.ok(page.items.length >= 1, 'a page must always make progress');
      start = page.start;
      assert.ok(++guard < 20);
    }
  }],

  ['formats do not move as the conversation grows, and parsing in pieces matches parsing whole', async () => {
    const lines = [
      user('give me the raw markdown for a table'),
      assistant('| a |\n|---|\n| 1 |'),
      user('now summarise'),
      assistant('## Summary\n\n- done'),
      toolUse('t9', 'pwd'),
      toolResult('t9', '/here'),
    ];
    const whole = newFile();
    fs.writeFileSync(whole, lines.map((line) => `${line}\n`).join(''));
    const pieces = newFile();
    fs.writeFileSync(pieces, '');
    for (const line of lines) {
      await append(pieces, line);
      await readConversation('claude', pieces);
    }
    const a = await readConversationPage('claude', whole, { from: 0 });
    const b = await readConversationPage('claude', pieces, { from: 0 });
    assert.deepEqual(a.items, b.items);
    const formats = a.items.flatMap((item) => (item.kind === 'message' && item.role === 'assistant' ? [item.format] : []));
    assert.deepEqual(formats, ['markdown-source', 'markdown']);
  }],

  ['a shortened message says so, and comes back whole, keeping its place among its record\'s items', async () => {
    const file = newFile();
    const long = `${'é🙂'.repeat(15_000)}THE END`;
    fs.writeFileSync(file, `${user('hi')}\n${JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'text', text: 'short first' },
        { type: 'text', text: long },
        { type: 'thinking', thinking: long },
      ] },
    })}\n${assistant('after')}\n`);
    const page = await readConversation('claude', file) as ConversationSnapshot;
    assert.equal(page.items[0]?.kind === 'message' && page.items[0].more, undefined);
    assert.equal(page.items[1]?.kind === 'message' && page.items[1].more, undefined);
    const held = page.items[2];
    assert.ok(held?.kind === 'message' && held.more === 'available' && held.text.length === 24_000);
    const read = await readConversationItem('claude', file, { index: 2, known: page.version as string });
    assert.ok('item' in read && read.item.kind === 'message');
    assert.equal(read.item.text, long);
    assert.equal(read.item.more, undefined);
    assert.equal(read.item.format, held.format);
    const thought = await readConversationItem('claude', file, { index: 3, known: page.version as string });
    assert.ok('item' in thought && thought.item.kind === 'thinking');
    assert.equal(thought.item.text, long);
  }],

  ['a tool\'s input and its result come back whole, from the two records that hold them', async () => {
    const file = newFile();
    const command = `echo ${'c'.repeat(5_000)}`;
    const output = `${'o'.repeat(9_000)}END`;
    fs.writeFileSync(file, `${toolUse('a', command)}\n${user('between')}\n${toolUse('b', 'ls')}\n${toolResult('b', output)}\n${toolResult('a', output)}\n`);
    const page = await readConversation('claude', file) as ConversationSnapshot;
    const known = page.version as string;
    const first = page.items[0] as ChatItem & { kind: 'tool' };
    assert.equal(first.more, 'available');
    assert.equal(first.detail?.length, 2_000);
    const whole = await readConversationItem('claude', file, { index: 0, known });
    assert.ok('item' in whole && whole.item.kind === 'tool');
    assert.equal(whole.item.detail, command);
    assert.equal(whole.item.output, output);
    const second = await readConversationItem('claude', file, { index: 2, known });
    assert.ok('item' in second && second.item.kind === 'tool');
    assert.equal(second.item.detail, 'ls');
    assert.equal(second.item.output, output);
    assert.equal(second.item.more, undefined);
  }],

  ['a whole item is what it was, and a later answer to a call replaces a shortened one', async () => {
    const file = newFile();
    fs.writeFileSync(file, `${toolUse('a', 'ls')}\n${toolResult('a', 'x'.repeat(3_000))}\n${toolResult('a', 'short')}\n`);
    const page = await readConversation('claude', file) as ConversationSnapshot;
    const tool = page.items[0] as ChatItem & { kind: 'tool' };
    assert.equal(tool.output, 'short');
    assert.equal(tool.more, undefined);
    const read = await readConversationItem('claude', file, { index: 0, known: page.version as string });
    assert.ok('item' in read);
    assert.deepEqual(read.item, tool);
  }],

  ['a shortened item still reads after the file grows, and a rewrite makes the old index stale', async () => {
    const file = newFile();
    const long = 'L'.repeat(30_000);
    fs.writeFileSync(file, `${user('hi')}\n${assistant(long)}\n`);
    const page = await readConversation('claude', file) as ConversationSnapshot;
    const known = page.version as string;
    await append(file, assistant('more'));
    const grown = await readConversationItem('claude', file, { index: 1, known });
    assert.ok('item' in grown && grown.item.kind === 'message' && grown.item.text === long);

    await new Promise((resolve) => setTimeout(resolve, 15));
    fs.writeFileSync(file, `${user('entirely')}\n${assistant('different')}\n`);
    assert.deepEqual(await readConversationItem('claude', file, { index: 1, known }), { stale: true });
    assert.deepEqual(await readConversationItem('claude', file, { index: 99, known: 'x:0' }), { stale: true });
  }],

  ['a huge field is bounded, and says so', async () => {
    const file = newFile();
    fs.writeFileSync(file, `${assistant('H'.repeat(5 * 1024 * 1024))}\n`);
    const page = await readConversation('claude', file) as ConversationSnapshot;
    const read = await readConversationItem('claude', file, { index: 0, known: page.version as string });
    assert.ok('item' in read && read.item.kind === 'message');
    assert.equal(read.item.text.length, 4 * 1024 * 1024);
    assert.equal(read.item.more, 'too-long');
  }],

  ['Codex and Grok items come back whole too', async () => {
    const long = 'Z'.repeat(30_000);
    const codex = newFile();
    fs.writeFileSync(codex, [
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: long }] } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c', name: 'shell', arguments: '{}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output: long } },
    ].map((r) => `${JSON.stringify(r)}\n`).join(''));
    const c = await readConversation('codex', codex) as ConversationSnapshot;
    const cm = await readConversationItem('codex', codex, { index: 0, known: c.version as string });
    assert.ok('item' in cm && cm.item.kind === 'message' && cm.item.text === long);
    const ct = await readConversationItem('codex', codex, { index: 1, known: c.version as string });
    assert.ok('item' in ct && ct.item.kind === 'tool' && ct.item.output === long);

    const grok = newFile();
    fs.writeFileSync(grok, [
      { type: 'assistant', content: long, tool_calls: [{ id: 'g', name: 'list_dir', arguments: '{}' }] },
      { type: 'tool_result', tool_call_id: 'g', content: long },
    ].map((r) => `${JSON.stringify(r)}\n`).join(''));
    const g = await readConversation('grok', grok) as ConversationSnapshot;
    const gm = await readConversationItem('grok', grok, { index: 0, known: g.version as string });
    assert.ok('item' in gm && gm.item.kind === 'message' && gm.item.text === long);
    const gt = await readConversationItem('grok', grok, { index: 1, known: g.version as string });
    assert.ok('item' in gt && gt.item.kind === 'tool' && gt.item.output === long);
  }],

  ['an absent file is the young session\'s normal state', async () => {
    const missing = await readConversation('claude', path.join(dir, 'nope.jsonl')) as ConversationSnapshot;
    assert.equal(missing.version, null);
    assert.equal(missing.total, 0);
    assert.match(missing.reason ?? '', /No transcript yet/);
  }],
];

let failed = 0;
for (const [name, check] of checks) {
  try {
    await check();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`);
  }
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `${failed} of ${checks.length} failed` : `all ${checks.length} passed`);
process.exitCode = failed ? 1 : 0;
