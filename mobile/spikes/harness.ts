// Spike harness, driven over CDP by spikes/drive.mjs. Throwaway by design.
//
// Rendering runs the desktop ChatPane unmodified. The only thing replaced is
// window.sertum, which is the seam the phone app is betting on.
import { registerPlugin } from '@capacitor/core';
import type {
  ChatItem,
  ConversationPageRequest,
  ConversationRead,
  ConversationReadRequest,
  ConversationSnapshot,
  SessionSnapshot,
} from '@desktop/shared/types';

// --- Fixture: a seeded mix shaped like a working session, not private data.
function fixture(count: number): ChatItem[] {
  let seed = 42;
  const rand = (n: number) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % n;
  };
  const words = 'the daemon reads each transcript and the pane draws what the agent said while a tool call waits on its result so the status moves only when an adapter reports it'.split(' ');
  const sentence = (n: number) => Array.from({ length: n }, () => words[rand(words.length)]).join(' ');
  const code = () => Array.from({ length: 6 + rand(20) }, (_, i) => `const line${i} = read('${words[rand(words.length)]}', ${rand(999)});`).join('\n');
  const items: ChatItem[] = [];
  for (let i = 0; i < count; i++) {
    const at = 1_700_000_000_000 + i * 5000;
    const roll = rand(100);
    if (roll < 12) {
      items.push({ kind: 'message', role: 'user', text: `Message ${i}: ${sentence(8 + rand(30))}`, at, format: 'text' });
    } else if (roll < 42) {
      items.push({
        kind: 'message',
        role: 'assistant',
        at,
        format: 'markdown',
        text: `## Step ${i}\n\n${sentence(30 + rand(60))} **${sentence(3)}** and \`${words[rand(words.length)]}\`.\n\n- ${sentence(9)}\n- ${sentence(11)}\n- ${sentence(7)}\n\n\`\`\`ts\n${code()}\n\`\`\`\n\n${sentence(25)}`,
      });
    } else if (roll < 50) {
      items.push({ kind: 'thinking', text: sentence(60 + rand(100)), at });
    } else {
      items.push({
        kind: 'tool',
        name: ['Bash', 'Read', 'Edit', 'Grep'][rand(4)],
        detail: `src/renderer/${words[rand(words.length)]}.ts`,
        output: code().slice(0, 1900),
        at,
      });
    }
  }
  return items;
}

// --- The seam. Anything the pane asks for beyond the transcript resolves empty.
// The stub keeps the daemon's contract: bounded pages, and deltas by revision.
const PAGE = 200;
let served: ChatItem[] = [];
let rev = 1;
let revs: number[] = [];
let readAt = 0;
function serve(items: ChatItem[]) {
  served = items;
  rev += 1;
  revs = items.map(() => rev);
}
function page(start: number, end: number): ConversationSnapshot {
  return {
    items: served.slice(start, end), start, total: served.length, path: 'fixture',
    updatedAt: rev, reason: null, version: `fixture:${rev}`,
  };
}
function readConversation(_id: string, request: ConversationReadRequest = {}): Promise<ConversationRead> {
  const known = request.known ? Number(request.known.split(':')[1]) : null;
  if (known === null) return Promise.resolve(page(Math.max(0, served.length - PAGE), served.length));
  if (known === rev) return Promise.resolve({ unchanged: true } as ConversationRead);
  readAt = performance.now();
  const from = request.start ?? 0;
  const to = request.follow ? served.length : Math.min(served.length, request.end ?? served.length);
  const changed = [];
  for (let index = from; index < to; index += 1) {
    if ((revs[index] ?? 0) > known) changed.push({ index, item: served[index] as ChatItem });
  }
  return Promise.resolve({ delta: true, changed, total: served.length, updatedAt: rev, version: `fixture:${rev}` } as ConversationRead);
}
function readConversationPage(_id: string, request: ConversationPageRequest): Promise<ConversationSnapshot> {
  const size = request.limit ?? PAGE;
  if (request.before !== undefined) return Promise.resolve(page(Math.max(0, request.before - size), request.before));
  const from = request.from ?? 0;
  return Promise.resolve(page(from, Math.min(served.length, from + size)));
}
const stub = new Proxy({} as Record<string, unknown>, {
  get(_t, prop: string) {
    if (prop === 'platform') return 'linux';
    if (prop === 'readConversation') return readConversation;
    if (prop === 'readConversationPage') return readConversationPage;
    if (prop === 'readConversationItem') {
      return (_id: string, request: { index: number }) => Promise.resolve({ item: served[request.index] });
    }
    if (prop.startsWith('on')) return () => () => undefined;
    return async () => null;
  },
});
const globals = window as unknown as Record<string, unknown>;
globals.sertum = stub;
globals.sertumMenu = { on: () => () => undefined, setState: () => undefined };

// Dynamic so `const api = window.sertum` in the desktop modules sees the stub.
const { ChatPane } = await import('@desktop/renderer/chat-pane');

const session = {
  id: 'spike', label: 'Spike', agent: 'claude', cwd: '/spike', command: 'claude', args: [],
  transport: 'stream', background: false, remoteControl: false, toolsPaused: false, muted: false,
  origin: 'owned', externalId: null, status: 'idle', turnActive: false, messageQueue: [],
  queueStalled: null, subagents: [], pid: 1,
  startedAt: 0, exitCode: null, activity: null, lastEventAt: null, adapterBound: true, model: null,
  modelLabel: null, effort: null, contextTokens: null, contextLimit: null, transcriptPath: null,
  permissionMode: null,
} as unknown as SessionSnapshot;

const host = document.getElementById('host') as HTMLElement;
const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const percentile = (sorted: number[], p: number) =>
  sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 10) / 10 : 0;

/** Resolves once the next replaceChildren has landed and been painted. */
function nextRepaint(el: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const observer = new MutationObserver(async () => {
      observer.disconnect();
      await frame();
      await frame();
      resolve();
    });
    observer.observe(el, { childList: true });
  });
}

/** Scroll up from the end, as a reader does, paging in history on the way. */
async function scrollProbe(el: HTMLElement, pxPerSecond: number, seconds: number) {
  el.scrollTop = el.scrollHeight;
  await wait(300);
  const deltas: number[] = [];
  let last = await frame();
  const end = last + seconds * 1000;
  while (last < end) {
    const now = await frame();
    deltas.push(now - last);
    el.scrollTop -= (pxPerSecond * (now - last)) / 1000;
    last = now;
  }
  const sorted = [...deltas].sort((a, b) => a - b);
  return {
    frames: deltas.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    worst: percentile(sorted, 1),
    over50ms: deltas.filter((d) => d > 50).length,
  };
}

interface RunOptions { items: number; scrollSeconds?: number; pxPerSecond?: number }

/** Open the conversation, deliver new items, then scroll back through history. */
async function run(options: RunOptions) {
  const { items, scrollSeconds = 5, pxPerSecond = 3000 } = options;
  serve(fixture(items));
  const pane = new ChatPane(session, { ok: true }, () => undefined, null);
  host.replaceChildren(pane.element);
  const scroll = pane.element.querySelector('.chat-scroll') as HTMLElement;

  const first = nextRepaint(scroll);
  const started = performance.now();
  pane.attach();
  await first;
  const openMs = Math.round(performance.now() - started);
  await wait(300);

  // A new item costs its own nodes now, and this is what a person typing in
  // the composer would feel.
  const newItems: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const arrived = { kind: 'message', role: 'assistant', text: `## New ${i}\n\nA **new** message.`, at: Date.now(), format: 'markdown' } as ChatItem;
    rev += 1;
    served.push(arrived);
    revs.push(rev);
    const repaint = nextRepaint(scroll);
    await repaint;
    newItems.push(Math.round(performance.now() - readAt));
  }
  const nodesAtTail = pane.element.querySelectorAll('*').length;

  const scrolling = await scrollProbe(scroll, pxPerSecond, scrollSeconds);
  await wait(300);
  const itemsHeld = scroll.querySelectorAll(':scope > .chat-item:not([hidden])').length;
  const nodes = pane.element.querySelectorAll('*').length;
  pane.dispose();
  host.replaceChildren();
  await wait(300);
  return { items, openMs, newItemMs: newItems, nodesAtTail, nodes, itemsHeld, scroll: scrolling };
}

/**
 * Walk to the start of the conversation and back to the end through the real
 * pane, checking at every page that the line being read did not move, the window
 * stayed bounded, and each end of the history was actually reached.
 */
async function pagingCheck(items: number) {
  serve(fixture(items));
  const pane = new ChatPane(session, { ok: true }, () => undefined, null);
  host.replaceChildren(pane.element);
  const scroll = pane.element.querySelector('.chat-scroll') as HTMLElement;
  const landed = nextRepaint(scroll);
  pane.attach();
  await landed;
  await wait(100);

  const held = () => [...scroll.querySelectorAll<HTMLElement>(':scope > .chat-item:not([hidden])')];
  const textAt = (node: Element | undefined) => node?.textContent?.slice(0, 60) ?? '';
  const expected = (index: number) => {
    const probe = document.createElement('div');
    const item = served[index] as ChatItem;
    probe.textContent = item.kind === 'tool' ? item.name : item.kind === 'image' ? item.alt : item.text;
    return probe.textContent.slice(0, 12);
  };
  const center = () => {
    const box = scroll.getBoundingClientRect();
    return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      ?.closest('.chat-item') as HTMLElement | null;
  };
  const jumps: number[] = [];
  let maxHeld = 0;
  let steps = 0;

  /** Move one screen past the threshold, then see whether the reader was moved. */
  async function step(top: number) {
    scroll.scrollTop = top;
    await frame();
    const node = center();
    const y = node?.getBoundingClientRect().top ?? 0;
    await wait(60);
    await frame();
    await frame();
    if (node?.isConnected) jumps.push(Math.abs(node.getBoundingClientRect().top - y));
    maxHeld = Math.max(maxHeld, held().length);
    steps += 1;
  }

  let quiet = 0;
  while (quiet < 5 && steps < 2000) {
    const before = textAt(held()[0]);
    await step(Math.max(0, scroll.scrollTop - 4000));
    quiet = scroll.scrollTop === 0 && textAt(held()[0]) === before ? quiet + 1 : 0;
  }
  const firstHeld = textAt(held()[0]);
  const reachedStart = firstHeld.includes(expected(0));
  const stepsUp = steps;

  quiet = 0;
  while (quiet < 5 && steps < 4000) {
    const before = textAt(held().at(-1));
    await step(scroll.scrollTop + 4000);
    const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 2;
    quiet = atBottom && textAt(held().at(-1)) === before ? quiet + 1 : 0;
  }
  const reachedEnd = textAt(held().at(-1)).includes(expected(items - 1));

  // Back at the end, an arrival must be drawn and followed.
  const arrived = { kind: 'message', role: 'assistant', text: 'Arrived after the walk.', at: Date.now(), format: 'text' } as ChatItem;
  rev += 1;
  served.push(arrived);
  revs.push(rev);
  await wait(1300);
  const followed = held().at(-1)?.textContent?.includes('Arrived after the walk.') === true &&
    scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;

  jumps.sort((a, b) => a - b);
  const internals = pane as unknown as {
    snapshot: { start: number; total: number; items: unknown[] } | null;
    version: string | null;
  };
  const result = {
    items, stepsUp, stepsDown: steps - stepsUp, reachedStart, reachedEnd, followed, maxHeld,
    window: internals.snapshot && {
      start: internals.snapshot.start,
      held: internals.snapshot.items.length,
      total: internals.snapshot.total,
    },
    version: internals.version,
    served: served.length,
    lastHeld: textAt(held().at(-1)),
    expectedLast: expected(items - 1),
    fromBottom: Math.round(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight),
    jumpsOver1px: jumps.filter((j) => j > 1).length,
    worstJumpPx: Math.round((jumps.at(-1) ?? 0) * 10) / 10,
  };
  pane.dispose();
  host.replaceChildren();
  return result;
}

/**
 * Change the pane's width at several reading positions, and check that the item
 * at the top of the view stays there and that a reader at the end stays at the end.
 */
async function widthCheck(items: number) {
  serve(fixture(items));
  const pane = new ChatPane(session, { ok: true }, () => undefined, null);
  host.replaceChildren(pane.element);
  const scroll = pane.element.querySelector('.chat-scroll') as HTMLElement;
  const landed = nextRepaint(scroll);
  pane.attach();
  await landed;
  await wait(200);

  const held = () => [...scroll.querySelectorAll<HTMLElement>(':scope > .chat-item:not([hidden])')];
  const atTop = () => {
    const top = scroll.getBoundingClientRect().top;
    const node = held().find((n) => n.getBoundingClientRect().bottom > top) as HTMLElement;
    const box = node.getBoundingClientRect();
    return { node, through: Math.max(0, top - box.top) / (box.height || 1) };
  };
  const settle = async () => {
    await frame();
    await frame();
    await wait(120);
  };
  const widths = ['55%', '100%', '75%', '100%'];
  const cases: Array<{ start: number; sameItem: boolean; worstThrough: number; heights: number[] }> = [];
  for (const fraction of [0.1, 0.35, 0.5, 0.65, 0.85]) {
    scroll.scrollTop = Math.round((scroll.scrollHeight - scroll.clientHeight) * fraction);
    await settle();
    const before = atTop();
    let sameItem = true;
    let worstThrough = 0;
    const heights: number[] = [];
    for (const width of widths) {
      host.style.width = width;
      await settle();
      const after = atTop();
      sameItem &&= after.node === before.node;
      worstThrough = Math.max(worstThrough, Math.abs(after.through - before.through));
      heights.push(scroll.scrollHeight);
    }
    cases.push({
      start: fraction,
      sameItem,
      worstThrough: Math.round(worstThrough * 1000) / 1000,
      heights,
    });
  }

  scroll.scrollTop = scroll.scrollHeight;
  await settle();
  const tail: boolean[] = [];
  for (const width of widths) {
    host.style.width = width;
    await settle();
    tail.push(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 2);
  }
  host.style.width = '';
  pane.dispose();
  host.replaceChildren();
  return { items, cases, stayedAtEnd: tail };
}

// --- Spike 2: native pinned socket, and what the WebView refuses on its own.
interface Listener { remove(): Promise<void> }
interface PinnedSocket {
  connect(o: { url: string; pinSha256: string }): Promise<void>;
  send(o: { text: string }): Promise<{ queued: boolean }>;
  close(): Promise<void>;
  addListener(event: string, cb: (data: Record<string, unknown>) => void): Promise<Listener>;
}
const pinned = registerPlugin<PinnedSocket>('PinnedSocket');

async function pinnedOpen(url: string, pinSha256: string) {
  const inbox: Array<(data: Record<string, unknown>) => void> = [];
  const handles = await Promise.all([
    pinned.addListener('message', (d) => inbox.shift()?.(d)),
  ]);
  const opened = new Promise<{ ok: boolean; detail: string }>((resolve) => {
    void pinned.addListener('open', (d) => resolve({ ok: true, detail: String(d.tls ?? '') }));
    void pinned.addListener('failure', (d) => resolve({ ok: false, detail: String(d.message) }));
    setTimeout(() => resolve({ ok: false, detail: 'timed out' }), 10000);
  });
  await pinned.connect({ url, pinSha256 });
  const result = await opened;
  const next = () => new Promise<Record<string, unknown>>((r) => inbox.push(r));
  return { result, next, handles };
}

async function pinTest(url: string, goodPin: string, badPin: string) {
  const bad = await pinnedOpen(url, badPin);
  await pinned.close().catch(() => undefined);
  await (pinned as unknown as { removeAllListeners(): Promise<void> }).removeAllListeners();
  const good = await pinnedOpen(url, goodPin);
  const out: Record<string, unknown> = { wrongPin: bad.result, rightPin: good.result };
  if (good.result.ok) {
    const trips: number[] = [];
    for (let i = 0; i < 200; i++) {
      const reply = good.next();
      const t = performance.now();
      await pinned.send({ text: `ping-${i}` });
      await reply;
      trips.push(performance.now() - t);
    }
    trips.sort((a, b) => a - b);
    out.echoMs = { p50: percentile(trips, 0.5), p95: percentile(trips, 0.95), worst: percentile(trips, 1) };
    for (const size of [1048576, 5242880]) {
      const reply = good.next();
      const t = performance.now();
      await pinned.send({ text: JSON.stringify({ blob: size }) });
      const message = await reply;
      out[`blob${size / 1048576}MB`] = { ms: Math.round(performance.now() - t), received: String(message.text).length };
    }
  }
  await pinned.close().catch(() => undefined);
  await (pinned as unknown as { removeAllListeners(): Promise<void> }).removeAllListeners();
  return out;
}

function webviewSocket(url: string) {
  return new Promise<string>((resolve) => {
    try {
      const ws = new WebSocket(url);
      ws.onopen = () => { ws.close(); resolve('opened'); };
      ws.onerror = () => resolve('refused');
      setTimeout(() => resolve('timed out'), 8000);
    } catch (err) {
      resolve(`threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

// --- Spike 3: discovery through Android's own NsdManager.
interface NsdBrowser {
  start(o: { type: string }): Promise<void>;
  stop(): Promise<void>;
  addListener(event: string, cb: (data: Record<string, unknown>) => void): Promise<Listener>;
}
const nsd = registerPlugin<NsdBrowser>('NsdBrowser');
async function browse(type: string, ms: number) {
  const found: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  await nsd.addListener('found', (d) => found.push(d));
  await nsd.addListener('error', (d) => errors.push(d));
  await nsd.start({ type });
  await wait(ms);
  await nsd.stop();
  await (nsd as unknown as { removeAllListeners(): Promise<void> }).removeAllListeners();
  return { found, errors };
}

/** Leaves a conversation on screen, for a screenshot at phone width. */
async function show(items: number) {
  serve(fixture(items));
  const pane = new ChatPane(session, { ok: true }, () => undefined, null);
  host.replaceChildren(pane.element);
  const landed = nextRepaint(pane.element.querySelector('.chat-scroll') as HTMLElement);
  pane.attach();
  await landed;
  return 'shown';
}

globals.spike = {
  run,
  pagingCheck,
  widthCheck,
  show,
  pinTest,
  webviewSocket,
  browse,
  environment: () => ({
    origin: location.origin,
    secureContext: isSecureContext,
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    viewport: [innerWidth, innerHeight, devicePixelRatio],
  }),
};
document.title = 'spike-ready';
