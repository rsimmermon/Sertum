// Spike harness, driven over CDP by spikes/drive.mjs. Throwaway by design.
//
// Rendering runs the desktop ChatPane unmodified. The only thing replaced is
// window.sertum, which is the seam the phone app is betting on.
import { registerPlugin } from '@capacitor/core';
import '@desktop/index.css';
import type { ChatItem, ConversationRead, SessionSnapshot } from '@desktop/shared/types';

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
let served: { items: ChatItem[]; version: string } = { items: [], version: 'none' };
let readAt = 0;
function readConversation(_id: string, known?: string | null): Promise<ConversationRead> {
  if (known === served.version) return Promise.resolve({ unchanged: true } as ConversationRead);
  readAt = performance.now();
  return Promise.resolve({
    items: served.items,
    path: 'fixture',
    updatedAt: Number(served.version.slice(1)) || 1,
    truncated: false,
    reason: null,
    version: served.version,
  } as ConversationRead);
}
const stub = new Proxy({} as Record<string, unknown>, {
  get(_t, prop: string) {
    if (prop === 'platform') return 'linux';
    if (prop === 'readConversation') return readConversation;
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
  origin: 'owned', externalId: null, status: 'idle', turnActive: false, subagents: [], pid: 1,
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

async function scrollProbe(el: HTMLElement, pxPerSecond: number, seconds: number) {
  el.scrollTop = 0;
  await wait(300);
  const deltas: number[] = [];
  let last = await frame();
  const end = last + seconds * 1000;
  while (last < end) {
    const now = await frame();
    deltas.push(now - last);
    el.scrollTop += (pxPerSecond * (now - last)) / 1000;
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

interface RunOptions { items: number; contentVisibility?: boolean; scrollSeconds?: number }

/** Build the conversation at this size, scroll it, then deliver one new item. */
async function run(options: RunOptions) {
  const { items, contentVisibility = false, scrollSeconds = 5 } = options;
  document.getElementById('spike-cv')?.remove();
  if (contentVisibility) {
    const style = document.createElement('style');
    style.id = 'spike-cv';
    style.textContent = '.chat-scroll > * { content-visibility: auto; contain-intrinsic-size: auto 140px; }';
    document.head.append(style);
  }
  served = { items: fixture(items), version: 'v1' };
  const pane = new ChatPane(session, { ok: true }, () => undefined, null);
  host.replaceChildren(pane.element);
  const scroll = pane.element.querySelector('.chat-scroll') as HTMLElement;

  const first = nextRepaint(scroll);
  const started = performance.now();
  pane.attach();
  await first;
  const openMs = Math.round(performance.now() - started);
  await wait(500);

  const scrolling = await scrollProbe(scroll, 3000, scrollSeconds);

  // Today's path: one new item repaints the whole conversation, and that is
  // the stall a person typing in the composer would feel.
  served = {
    items: [...served.items, { kind: 'message', role: 'assistant', text: 'A new message.', at: Date.now(), format: 'markdown' } as ChatItem],
    version: 'v2',
  };
  const repaint = nextRepaint(scroll);
  await repaint;
  const newItemMs = Math.round(performance.now() - readAt);

  const nodes = pane.element.querySelectorAll('*').length;
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  const heapMB = memory ? Math.round(memory.usedJSHeapSize / 1048576) : null;
  pane.dispose();
  host.replaceChildren();
  await wait(300);
  return { items, contentVisibility, openMs, newItemMs, nodes, heapMB, scroll: scrolling };
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
  served = { items: fixture(items), version: 'v1' };
  const pane = new ChatPane(session, { ok: true }, () => undefined, null);
  host.replaceChildren(pane.element);
  const landed = nextRepaint(pane.element.querySelector('.chat-scroll') as HTMLElement);
  pane.attach();
  await landed;
  return 'shown';
}

globals.spike = {
  run,
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
