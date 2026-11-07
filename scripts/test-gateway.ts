/**
 * The gateway over a real TLS socket, with the fabric replaced by a recorder so
 * that "never reached the fabric" is something a check can see.
 *
 *   npx esbuild scripts/test-gateway.ts --bundle --platform=node --format=esm \
 *     --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);" \
 *     --outfile=.temp/test-gateway.mjs
 *   node .temp/test-gateway.mjs
 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, X509Certificate, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { WebSocket } from 'ws';
import { Gateway, GATEWAY_API, PAIRING_MS, signedText } from '../src/daemon/gateway';
import { GATEWAY_EVENTS, GATEWAY_METHODS, isLocalPeer } from '../src/daemon/gateway-policy';
import type { SessionSnapshot } from '../src/shared/types';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sertum-gateway-'));
const calls: Array<{ method: string; params: unknown }> = [];
let changes = 0;
let clock = Date.now();
const results: Record<string, unknown> = {
  'upload/begin': { uploadId: 'up-1' },
  'upload/finish': { path: 'C:\\spool\\up-1\\a.png', name: 'a.png', size: 1, kind: 'image' },
  'session/list': [{ id: 's', command: 'claude', args: ['--settings', 'secret-hooks'], label: 'x' }],
  'session/create': { id: 'new', command: 'claude', args: ['--settings', 'secret-hooks'] },
};
function dispatch(method: string, params: unknown): unknown {
  calls.push({ method, params });
  if (method === 'session/kill') throw new Error('boom from fabric');
  return results[method] ?? null;
}
const options = {
  dir, version: 'test', dispatch, onChanged: () => { changes += 1; }, advertise: false, port: 0,
  now: () => clock,
};
let gateway = new Gateway(options);

interface Client {
  socket: WebSocket;
  frames: Array<Record<string, unknown>>;
  next(match?: (f: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  closed: Promise<number>;
  pin: string;
  request(method: string, params?: unknown): Promise<Record<string, unknown>>;
}

function connect(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const frames: Array<Record<string, unknown>> = [];
    const waiters: Array<() => void> = [];
    socket.on('message', (data) => {
      frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
      for (const wake of waiters.splice(0)) wake();
    });
    const closed = new Promise<number>((done) => socket.on('close', (code) => done(code)));
    const next: Client['next'] = async (match = () => true) => {
      const deadline = Date.now() + 5000;
      for (;;) {
        const at = frames.findIndex(match);
        if (at >= 0) return frames.splice(at, 1)[0] as Record<string, unknown>;
        if (Date.now() > deadline) throw new Error('no frame arrived');
        await new Promise<void>((wake) => {
          waiters.push(wake);
          setTimeout(wake, 200);
        });
      }
    };
    let nextId = 1;
    const client: Client = {
      socket, frames, next, closed, pin: '',
      request: (method, params) => {
        const id = nextId++;
        socket.send(JSON.stringify({ t: 'req', id, method, params }));
        return next((f) => f.t === 'res' && f.id === id);
      },
    };
    socket.on('upgrade', (response) => {
      const peer = (response.socket as tls.TLSSocket).getPeerCertificate();
      const spki = new X509Certificate(peer.raw).publicKey.export({ type: 'spki', format: 'der' });
      client.pin = createHash('sha256').update(spki).digest('base64');
    });
    socket.on('open', () => resolve(client));
    socket.on('error', reject);
  });
}

interface Phone { publicKey: string; privateKey: KeyObject; deviceId?: string }
function newPhone(): Phone {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey };
}
const signature = (phone: Phone, purpose: 'auth' | 'pair', nonce: unknown, pin: string) =>
  sign('sha256', Buffer.from(signedText(purpose, String(nonce), pin)), phone.privateKey).toString('base64');
const codeIn = (payload: string) =>
  JSON.parse(Buffer.from(payload.replace('sertum-pair:', ''), 'base64url').toString()) as Record<string, unknown>;

async function pair(port: number, phone: Phone, code: unknown): Promise<{ client: Client; answer: Record<string, unknown> }> {
  const client = await connect(port);
  const challenge = await client.next();
  client.socket.send(JSON.stringify({
    t: 'pair', api: GATEWAY_API, code, name: 'Test phone', publicKey: phone.publicKey,
    signature: signature(phone, 'pair', challenge.nonce, client.pin),
  }));
  const answer = await client.next();
  if (answer.t === 'ready') phone.deviceId = answer.deviceId as string;
  return { client, answer };
}

async function auth(port: number, phone: Phone): Promise<{ client: Client; answer: Record<string, unknown> }> {
  const client = await connect(port);
  const challenge = await client.next();
  client.socket.send(JSON.stringify({
    t: 'auth', api: GATEWAY_API, deviceId: phone.deviceId,
    signature: signature(phone, 'auth', challenge.nonce, client.pin),
  }));
  return { client, answer: await client.next() };
}

const checks: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, check: () => Promise<void> | void) => checks.push([name, check]);

let port = 0;
const phone = newPhone();
let live: Client;

test('it is off until turned on, and pairing says so', async () => {
  assert.equal(gateway.status().enabled, false);
  assert.equal(gateway.status().listening, false);
  assert.throws(() => gateway.beginPairing(), /Turn on/);
  const status = await gateway.setEnabled(true);
  assert.equal(status.listening, true);
  port = status.port;
  assert.ok(port > 0);
});

test('TLS below 1.3 is refused', async () => {
  const failed = await new Promise<boolean>((resolve) => {
    const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, maxVersion: 'TLSv1.2' });
    socket.once('secureConnect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(true));
  });
  assert.equal(failed, true);
});

test('nothing but a socket gets an answer over plain HTTPS', async () => {
  const code = await new Promise<number>((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      socket.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    });
    socket.once('data', (data) => { socket.destroy(); resolve(Number(data.toString().split(' ')[1])); });
    socket.once('error', reject);
  });
  assert.equal(code, 426);
});

test('a request before signing in closes the socket and reaches nothing', async () => {
  const before = calls.length;
  const client = await connect(port);
  await client.next();
  client.socket.send(JSON.stringify({ t: 'req', id: 1, method: 'session/list', api: GATEWAY_API }));
  assert.equal((await client.next()).t, 'refused');
  assert.equal(await client.closed, 4401);
  assert.equal(calls.length, before);
});

test('an oversized frame before signing in closes the socket', async () => {
  const client = await connect(port);
  await client.next();
  client.socket.send(JSON.stringify({ t: 'pair', api: GATEWAY_API, code: 'x'.repeat(9000) }));
  assert.equal(await client.closed, 1009);
});

test('another API version is refused with a reason', async () => {
  const client = await connect(port);
  await client.next();
  client.socket.send(JSON.stringify({ t: 'auth', api: GATEWAY_API + 1, deviceId: 'x' }));
  const answer = await client.next();
  assert.equal(answer.reason, 'api');
});

test('a wrong pairing code is refused and leaves the right one standing', async () => {
  const { payload } = gateway.beginPairing();
  const wrong = await pair(port, newPhone(), 'not-the-code');
  assert.equal(wrong.answer.reason, 'code');
  assert.equal(gateway.status().devices.length, 0);
  const stranger = await pair(port, newPhone(), { an: 'object' });
  assert.equal(stranger.answer.reason, 'code');
  const held = codeIn(payload);
  assert.equal(held.v, GATEWAY_API);
  assert.equal(held.port, port);
  const right = await pair(port, phone, held.code);
  assert.equal(right.answer.t, 'ready');
  assert.equal(gateway.status().devices.length, 1);
  live = right.client;
});

test('the QR code names the key the socket really presents', async () => {
  const { payload } = gateway.beginPairing();
  gateway.cancelPairing();
  const client = await connect(port);
  await client.next();
  assert.equal(codeIn(payload).pin, client.pin);
  client.socket.close();
});

test('a code works once', async () => {
  const code = codeIn(gateway.beginPairing().payload).code;
  const first = newPhone();
  assert.equal((await pair(port, first, code)).answer.t, 'ready');
  assert.equal((await pair(port, newPhone(), code)).answer.reason, 'code');
  gateway.revoke(first.deviceId as string);
});

test('a code expires, and can be cancelled', async () => {
  const stale = codeIn(gateway.beginPairing().payload).code;
  clock += PAIRING_MS + 1;
  assert.equal((await pair(port, newPhone(), stale)).answer.reason, 'code');
  const cancelled = codeIn(gateway.beginPairing().payload).code;
  gateway.cancelPairing();
  assert.equal((await pair(port, newPhone(), cancelled)).answer.reason, 'code');
});

test('pairing needs proof of holding the key offered', async () => {
  const code = codeIn(gateway.beginPairing().payload).code;
  const claimed = newPhone();
  const actual = newPhone();
  const client = await connect(port);
  const challenge = await client.next();
  client.socket.send(JSON.stringify({
    t: 'pair', api: GATEWAY_API, code, publicKey: claimed.publicKey,
    signature: signature(actual, 'pair', challenge.nonce, client.pin),
  }));
  assert.equal((await client.next()).reason, 'signature');
  gateway.cancelPairing();
});

test('a phone returns by signature, and nothing else will do', async () => {
  const back = await auth(port, phone);
  assert.equal(back.answer.t, 'ready');
  back.client.socket.close();

  const impostor: Phone = { ...newPhone(), deviceId: phone.deviceId };
  assert.equal((await auth(port, impostor)).answer.reason, 'signature');
  assert.equal((await auth(port, { ...newPhone(), deviceId: 'nobody' })).answer.reason, 'unknown');
});

test('a signature cannot be replayed on a new connection or sent for another key', async () => {
  const first = await connect(port);
  const old = await first.next();
  const replay = signature(phone, 'auth', old.nonce, first.pin);
  first.socket.close();
  const second = await connect(port);
  await second.next();
  second.socket.send(JSON.stringify({ t: 'auth', api: GATEWAY_API, deviceId: phone.deviceId, signature: replay }));
  assert.equal((await second.next()).reason, 'signature');

  const third = await connect(port);
  const fresh = await third.next();
  third.socket.send(JSON.stringify({
    t: 'auth', api: GATEWAY_API, deviceId: phone.deviceId,
    signature: signature(phone, 'auth', fresh.nonce, 'a-different-servers-key'),
  }));
  assert.equal((await third.next()).reason, 'signature');
});

test('every method not on the list is refused before the fabric', async () => {
  // Every fabric method a phone was decided against, plus the desktop's own.
  const refused = [
    'settings/apply', 'session/diagnostics', 'session/rename', 'session/steer', 'session/tool-gate',
    'pty/input', 'pty/resize', 'pty/replay', 'discovery/list', 'discovery/attach', 'discovery/monitor',
    'session/resumable', 'session/resume', 'agent/detect', 'adapters/status', 'codex/restart', 'codex/repair',
    'rules/get', 'rules/add', 'rules/remove', 'daemon/stop', 'daemon/ping', 'gateway/status',
    'gateway/set-enabled', 'gateway/pair-begin', 'gateway/revoke', '__proto__', 'constructor',
  ];
  const before = calls.length;
  for (const method of refused) {
    const answer = await live.request(method, {});
    assert.equal(answer.ok, false, method);
    assert.match(String(answer.error), /cannot use/, method);
    assert.equal(GATEWAY_METHODS.has(method), false, method);
  }
  assert.equal(calls.length, before);
});

test('an allowed method reaches the fabric, and its error comes back', async () => {
  const answer = await live.request('approval/pending');
  assert.equal(answer.ok, true);
  assert.equal(calls.at(-1)?.method, 'approval/pending');
  const failed = await live.request('session/kill', 's');
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'boom from fabric');
});

test('starting a session can name an agent, a folder and a label, and nothing else', async () => {
  const answer = await live.request('session/create', {
    agent: 'claude', cwd: dir, label: '  mine  ', command: 'calc.exe', args: ['/evil'], transport: 'pty',
    background: true, remoteControl: true, env: { A: 'b' },
  });
  assert.equal(answer.ok, true);
  assert.deepEqual(calls.at(-1), { method: 'session/create', params: { agent: 'claude', cwd: dir, label: 'mine' } });
  const made = answer.result as SessionSnapshot;
  assert.equal(made.command, '');
  assert.deepEqual(made.args, []);

  const before = calls.length;
  for (const spec of [
    { agent: 'shell', cwd: dir },
    { cwd: dir },
    { agent: 'claude' },
    { agent: 'claude', cwd: 'relative/path' },
    { agent: 'claude', cwd: path.join(dir, 'missing') },
    { agent: 'claude', cwd: path.join(dir, 'gateway.json') },
    'claude',
    null,
  ]) {
    assert.equal((await live.request('session/create', spec)).ok, false, JSON.stringify(spec));
  }
  assert.equal(calls.length, before);
});

test('a phone attaches only what it uploaded itself', async () => {
  const before = calls.length;
  const stolen = { id: 's', text: 'x', attachments: [{ path: 'C:\\Users\\Admin\\.ssh\\id_rsa', name: 'id_rsa', size: 1, kind: 'file' }] };
  assert.equal((await live.request('chat/submit', stolen)).ok, false);
  assert.equal(calls.length, before);

  assert.equal((await live.request('upload/begin', { name: 'a.png', size: 1 })).ok, true);
  const finished = await live.request('upload/finish', { uploadId: 'up-1' });
  assert.equal(finished.ok, true);
  const sent = await live.request('chat/submit', { id: 's', text: 'x', attachments: [finished.result] });
  assert.equal(sent.ok, true);
  assert.equal((await live.request('chat/submit', { id: 's', text: 'plain' })).ok, true);
});

test('a phone cannot touch an upload that is not its own', async () => {
  const other = newPhone();
  const code = codeIn(gateway.beginPairing().payload).code;
  const { client } = await pair(port, other, code);
  await live.request('upload/begin', { name: 'a.png', size: 1 });
  const before = calls.length;
  for (const method of ['upload/chunk', 'upload/finish', 'upload/abort']) {
    assert.equal((await client.request(method, { uploadId: 'up-1', offset: 0, data: 'AA==' })).ok, false, method);
  }
  assert.equal(calls.length, before);
  gateway.revoke(other.deviceId as string);
});

test('a session on its way out has its process line taken off', async () => {
  const listed = await live.request('session/list');
  assert.deepEqual(listed.result, [{ id: 's', command: '', args: [], label: 'x' }]);
  gateway.event('session:updated', { id: 's', command: 'claude', args: ['secret-hooks'] });
  const event = await live.next((f) => f.name === 'session:updated');
  assert.deepEqual(event.payload, { id: 's', command: '', args: [] });
});

test('only listed events go out', async () => {
  assert.equal(GATEWAY_EVENTS.has('pty:data'), false);
  gateway.event('pty:data', { id: 's', data: 'terminal bytes' });
  gateway.event('pty:replay', { id: 's', data: 'terminal bytes' });
  gateway.event('gateway:changed', {});
  gateway.event('conversation:changed', { id: 's' });
  await live.next((f) => f.name === 'conversation:changed');
  assert.equal(live.frames.some((f) => f.name === 'pty:data' || f.name === 'pty:replay' || f.name === 'gateway:changed'), false);
});

test('an event never reaches a socket that has not signed in', async () => {
  const client = await connect(port);
  await client.next();
  gateway.event('conversation:changed', { id: 'secret' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(client.frames.length, 0);
  client.socket.close();
  await live.next((f) => f.name === 'conversation:changed');
});

test('nothing secret is stored, and a restart keeps the pairing and the key', async () => {
  const { pin } = codeIn(gateway.beginPairing().payload);
  const { code } = codeIn(gateway.beginPairing().payload);
  const stored = fs.readFileSync(path.join(dir, 'gateway.json'), 'utf8');
  assert.equal(stored.includes(String(code)), false);
  gateway.cancelPairing();
  await gateway.stop();
  assert.equal(gateway.status().listening, false);
  assert.equal(await live.closed, 1006);

  gateway = new Gateway(options);
  assert.equal(gateway.status().enabled, true);
  assert.equal(gateway.status().devices.length, 1);
  await gateway.start();
  port = gateway.status().port;
  assert.equal(codeIn(gateway.beginPairing().payload).pin, pin);
  gateway.cancelPairing();
  const back = await auth(port, phone);
  assert.equal(back.answer.t, 'ready');
  live = back.client;
});

test('a code does not survive a restart', async () => {
  const { code } = codeIn(gateway.beginPairing().payload);
  await gateway.stop();
  await live.closed;
  gateway = new Gateway(options);
  await gateway.start();
  port = gateway.status().port;
  assert.equal((await pair(port, newPhone(), code)).answer.reason, 'code');
  live = (await auth(port, phone)).client;
});

test('revoking cuts a connected phone off at once and for good', async () => {
  const seen = changes;
  const before = calls.length;
  const status = gateway.revoke(phone.deviceId as string);
  assert.equal(status.devices.length, 0);
  assert.equal(await live.closed, 4401);
  assert.ok(changes > seen);
  assert.equal((await auth(port, phone)).answer.reason, 'unknown');
  assert.equal(calls.length, before);
});

test('turning it off closes the port, and pairings outlive that', async () => {
  const again = newPhone();
  const code = codeIn(gateway.beginPairing().payload).code;
  const { client } = await pair(port, again, code);
  const status = await gateway.setEnabled(false);
  assert.equal(status.listening, false);
  assert.equal(status.devices.length, 1);
  await client.closed;
  await assert.rejects(connect(port));

  gateway = new Gateway(options);
  await gateway.start();
  assert.equal(gateway.status().listening, false, 'stays off across a restart');
});

test('a port already taken is reported rather than swallowed', async () => {
  const first = new Gateway({ ...options, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sertum-gateway-')) });
  const taken = (await first.setEnabled(true)).port;
  const second = new Gateway({ ...options, port: taken, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sertum-gateway-')) });
  const status = await second.setEnabled(true);
  assert.equal(status.listening, false);
  assert.match(String(status.error), /already in use/);
  await first.stop();
  await second.stop();
});

test('only addresses a local network or VPN could use get through', () => {
  for (const near of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.5', '169.254.1.1',
    '100.64.0.1', '100.127.0.1', '::1', '::ffff:192.168.1.5', 'fe80::1%en0', 'fd12:3456::1', 'fc00::1']) {
    assert.equal(isLocalPeer(near), true, near);
  }
  for (const far of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.167.1.1', '100.63.0.1', '100.128.0.1',
    '2001:4860:4860::8888', '::ffff:8.8.8.8', '', undefined, 'not-an-address', '1.2.3', '999.1.1.1']) {
    assert.equal(isLocalPeer(far), false, String(far));
  }
});

let failed = 0;
for (const [name, check] of checks) {
  try {
    await check();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${err instanceof Error ? err.message : String(err)}`);
    break;
  }
}
await gateway.stop();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? 'FAILED' : `${checks.length}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
