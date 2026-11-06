/**
 * A phone's whole path against real agents: pair over the TLS socket, start a
 * session, send a file, approve a real tool call, follow the turn on events, end
 * it. Everything goes through the socket, as a phone's would.
 *
 *   npx esbuild scripts/smoke-gateway.ts --bundle --platform=node --format=cjs \
 *     --external:node-pty --outfile=.temp/smoke-gateway.cjs
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron .temp/smoke-gateway.cjs [claude|codex]
 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type tls from 'node:tls';
import { WebSocket } from 'ws';
import { createFabric } from '../src/daemon/fabric';
import { Gateway, GATEWAY_API, signedText } from '../src/daemon/gateway';
import type {
  ChatAttachment,
  ChatItem,
  ConversationRead,
  PendingApproval,
  SessionSnapshot,
} from '../src/shared/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MARK = 'GATEWAYMARK';
// A one pixel PNG, so a real agent receives a real image.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

class Phone {
  private socket!: WebSocket;
  private id = 1;
  private readonly waiting = new Map<number, (frame: Record<string, unknown>) => void>();
  private first: ((frame: Record<string, unknown>) => void) | null = null;
  pin = '';
  closed = false;
  readonly events: Array<{ name: string; payload: unknown }> = [];
  readonly publicKey: string;
  private readonly privateKey;

  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.publicKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    this.privateKey = privateKey;
  }

  private next(): Promise<Record<string, unknown>> {
    return new Promise((resolve) => { this.first = resolve; });
  }

  async open(port: number): Promise<Record<string, unknown>> {
    this.socket = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const challenge = this.next();
    this.socket.on('upgrade', (response) => {
      const peer = (response.socket as tls.TLSSocket).getPeerCertificate();
      const spki = new X509Certificate(peer.raw).publicKey.export({ type: 'spki', format: 'der' });
      this.pin = createHash('sha256').update(spki).digest('base64');
      assert.equal((response.socket as tls.TLSSocket).getProtocol(), 'TLSv1.3');
    });
    this.socket.on('close', () => { this.closed = true; });
    this.socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame.t === 'res') {
        this.waiting.get(frame.id as number)?.(frame);
        this.waiting.delete(frame.id as number);
      } else if (frame.t === 'event') {
        this.events.push({ name: frame.name as string, payload: frame.payload });
      } else {
        this.first?.(frame);
      }
    });
    return challenge;
  }

  signature(purpose: 'auth' | 'pair', nonce: unknown): string {
    return sign('sha256', Buffer.from(signedText(purpose, String(nonce), this.pin)), this.privateKey).toString('base64');
  }

  credentials(frame: unknown): Promise<Record<string, unknown>> {
    const answer = this.next();
    this.socket.send(JSON.stringify(frame));
    return answer;
  }

  async call<T>(method: string, params?: unknown): Promise<T> {
    const id = this.id++;
    const answer = new Promise<Record<string, unknown>>((resolve) => this.waiting.set(id, resolve));
    this.socket.send(JSON.stringify({ t: 'req', id, method, params }));
    const frame = await answer;
    if (!frame.ok) throw new Error(`${method}: ${String(frame.error)}`);
    return frame.result as T;
  }

  close(): void {
    this.socket.close();
  }
}

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 180_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function run(agent: 'claude' | 'codex', phone: Phone, cwd: string): Promise<void> {
  const started = Date.now();
  phone.events.length = 0;
  // Asked for more than a phone may have: it should still come back an agent session.
  const session = await phone.call<SessionSnapshot>('session/create', {
    agent, cwd, label: `gateway ${agent}`, command: 'calc.exe', args: ['/evil'],
  });
  const { id } = session;
  assert.equal(session.command, '');
  assert.equal(session.transport, 'stream');
  console.log(`[${agent}] started ${id} as ${session.agent} over ${session.transport}`);

  const list = await phone.call<SessionSnapshot[]>('session/list');
  assert.ok(list.some((s) => s.id === id));
  assert.ok(list.every((s) => s.command === '' && s.args.length === 0));

  // Ask for approval on every tool, so a real call has to be answered from here.
  const askMode = agent === 'claude' ? 'default' : 'codex-ask';
  const mode = await phone.call<{ ok: boolean; reason?: string }>('session/permission-mode', { id, mode: askMode });
  console.log(`[${agent}] permission mode:`, JSON.stringify(mode));

  const { uploadId } = await phone.call<{ uploadId: string }>('upload/begin', { name: 'pixel.png', size: Buffer.from(PNG, 'base64').length });
  await phone.call('upload/chunk', { uploadId, offset: 0, data: PNG });
  const attachment = await phone.call<ChatAttachment>('upload/finish', { uploadId });
  assert.equal(attachment.kind, 'image');
  await assert.rejects(
    phone.call('chat/submit', { id, text: 'x', attachments: [{ ...attachment, path: path.join(cwd, 'notes.txt') }] }),
    /uploaded from this phone/,
  );

  const submitted = await phone.call<{ outcome: string }>('chat/submit', {
    id,
    text: `Use your shell tool to run exactly this and nothing else: node -e "console.log('${MARK}')" Then, in one short reply, say the output and what colour family the attached image is, and end with the word DONE.`,
    attachments: [attachment],
  });
  assert.notEqual(submitted.outcome, 'refused');

  // Follow on events alone, as the pane does.
  let version: string | null = null;
  let held: ChatItem[] = [];
  let start = 0;
  let handled = 0;
  let reads = 0;
  const changes = () => phone.events.filter((e) => e.name === 'conversation:changed' && (e.payload as { id: string }).id === id).length;
  const follow = async () => {
    reads += 1;
    const read = await phone.call<ConversationRead>('conversation/read', {
      id, ...(version ? { known: version, start, end: start + held.length, follow: true } : {}),
    });
    if ('unchanged' in read) return;
    if ('delta' in read) {
      for (const { index, item } of read.changed) held[index - start] = item;
      version = read.version;
    } else if ('items' in read) {
      held = read.items;
      start = read.start;
      version = read.version;
    }
  };

  let approved = 0;
  let current: SessionSnapshot = session;
  await until(`${agent}'s turn to finish`, async () => {
    for (const event of phone.events) {
      if (event.name === 'session:updated' && (event.payload as SessionSnapshot).id === id) {
        current = event.payload as SessionSnapshot;
      }
    }
    assert.ok(phone.events.every((e) => e.name !== 'pty:data'));
    const pending = await phone.call<PendingApproval[]>('approval/pending');
    for (const ask of pending.filter((a) => a.sessionId === id)) {
      console.log(`[${agent}] answering ${ask.tool} ${ask.subject.slice(0, 70)}`);
      await phone.call('approval/answer', {
        id: ask.id, sessionId: id, tool: ask.tool, subject: ask.subject, answer: { decision: 'allow', scope: 'once' },
      });
      approved += 1;
      // A second client's bar comes down because of this event, not its own click.
      await until('approval:gone', () => phone.events.some((e) => e.name === 'approval:gone' && e.payload === ask.id), 5000);
    }
    if (changes() > handled) {
      handled = changes();
      await follow();
    }
    const last = held.at(-1);
    return !current.turnActive && last?.kind === 'message' && last.role === 'assistant' && /DONE/.test(last.text);
  });

  // The same thing a fresh read holds, and the tool really ran.
  await follow();
  const fresh = await phone.call<ConversationRead>('conversation/read', { id });
  assert.ok('items' in fresh);
  assert.deepEqual(held.slice(-5), fresh.items.slice(-5));
  const ran = held.some((item) => item.kind === 'tool' && (item.output ?? '').includes(MARK));
  const said = held.at(-1);
  assert.ok(ran, 'the approved tool ran and its output came back');
  console.log(`[${agent}] approvals ${approved}, change events ${changes()}, reads ${reads}, items ${held.length}`);
  console.log(`[${agent}] reply: ${said && 'text' in said ? said.text.slice(0, 160).replace(/\n/g, ' ') : ''}`);

  // Ending: a removed row has to reach every client.
  assert.equal(await phone.call('session/remove', id), true);
  await until('session:removed', () => phone.events.some((e) => e.name === 'session:removed' && (e.payload as { id: string }).id === id), 10_000);
  const after = await phone.call<SessionSnapshot[]>('session/list');
  assert.ok(!after.some((s) => s.id === id));
  console.log(`[${agent}] passed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

async function main(): Promise<void> {
  const which = process.argv[2];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sertum-smoke-gateway-'));
  const cwd = path.join(home, 'work');
  fs.mkdirSync(cwd);
  const fabric = createFabric({ userDataDir: home });
  await fabric.start();
  const gateway = new Gateway({
    dir: home, version: 'smoke', advertise: false, port: 0,
    dispatch: (method, params) => fabric.handle(method, params),
    onChanged: () => undefined,
  });
  fabric.onEvent((name, payload) => gateway.event(name, payload));
  const { port } = await gateway.setEnabled(true);

  const phone = new Phone();
  try {
    const challenge = await phone.open(port);
    const { payload } = gateway.beginPairing();
    const offer = JSON.parse(Buffer.from(payload.replace('sertum-pair:', ''), 'base64url').toString()) as Record<string, unknown>;
    assert.equal(offer.pin, phone.pin);
    const ready = await phone.credentials({
      t: 'pair', api: GATEWAY_API, code: offer.code, name: 'smoke', publicKey: phone.publicKey,
      signature: phone.signature('pair', challenge.nonce),
    });
    assert.equal(ready.t, 'ready');
    console.log(`paired over ${process.versions.electron ? `Electron ${process.versions.electron}` : `Node ${process.version}`}, ${process.versions.openssl ?? 'no openssl'}`);

    await assert.rejects(phone.call('pty/input', { id: 'x', data: 'calc\r' }), /cannot use/);
    await assert.rejects(phone.call('daemon/stop'), /cannot use/);

    if (!which || which === 'claude') await run('claude', phone, cwd);
    if (!which || which === 'codex') await run('codex', phone, cwd);

    gateway.revoke(ready.deviceId as string);
    await until('the socket to close', () => phone.closed, 5000);
    console.log('PASS');
    await gateway.stop();
    await fabric.shutdown();
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(0);
  } catch (err) {
    console.error('FAIL', err);
    await gateway.stop();
    await fabric.shutdown();
    process.exit(1);
  }
}

void main();
