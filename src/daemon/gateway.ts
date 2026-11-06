import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { Socket } from 'node:net';
import { Bonjour, type Service } from 'bonjour-service';
import selfsigned from 'selfsigned';
import { WebSocket, WebSocketServer } from 'ws';
import type { GatewayDevice, GatewayPairing, GatewayStatus } from '../shared/types';
import {
  GATEWAY_EVENTS,
  admit,
  afterAnswer,
  isLocalPeer,
  newDeviceFiles,
  outgoing,
  outgoingEvent,
  type DeviceFiles,
} from './gateway-policy';

/**
 * Sertum's one door onto the network, for phones it has paired with.
 *
 * Off until it is turned on. TLS 1.3 with a key this daemon made for itself,
 * which a phone learns from the pairing QR code rather than from any authority,
 * so the address never has to be trusted. A phone proves itself by signing a
 * fresh nonce with a key that cannot leave it, which also means this file holds
 * nothing a thief could log in with.
 *
 * Its API is versioned apart from DAEMON_PROTOCOL, because a phone updates on
 * its own schedule and the desktop's protocol moves whenever the two desktop
 * halves do.
 */
export const GATEWAY_API = 1;
export const DEFAULT_GATEWAY_PORT = 47615;
export const MDNS_TYPE = 'sertum';

/** About the longest it takes to find a phone, unlock it and point the camera. */
export const PAIRING_MS = 5 * 60_000;
const AUTH_TIMEOUT_MS = 10_000;
const MAX_UNAUTHENTICATED = 32;
const MAX_UNAUTHENTICATED_FRAME = 8 * 1024;
/** An upload chunk is 2MB decoded, so its frame is about 2.7MB. */
const MAX_FRAME = 4 * 1024 * 1024;
/** A phone this far behind has gone. It catches up by version when it returns. */
const MAX_BUFFERED = 32 * 1024 * 1024;
const HEARTBEAT_MS = 20_000;

export interface GatewayOptions {
  dir: string;
  version: string;
  dispatch(method: string, params: unknown): unknown;
  /** Status changed: a phone paired, connected or left. */
  onChanged(): void;
  /** Off in tests, which have no use for multicast. */
  advertise?: boolean;
  port?: number;
  now?: () => number;
}

interface Stored {
  enabled: boolean;
  port: number;
  id: string;
  devices: StoredDevice[];
}
interface StoredDevice {
  id: string;
  name: string;
  /** SPKI DER, base64. */
  publicKey: string;
  pairedAt: number;
  lastSeenAt: number | null;
}
interface Connection {
  socket: WebSocket;
  address: string;
  nonce: string;
  device: StoredDevice | null;
  files: DeviceFiles;
  alive: boolean;
  authTimer: NodeJS.Timeout | null;
}

/** What a phone signs. It names the key it saw, so a signature cannot be relayed. */
export function signedText(purpose: 'auth' | 'pair', nonce: string, pin: string): string {
  return `sertum-gateway-${GATEWAY_API}|${purpose}|${nonce}|${pin}`;
}

export function pinOf(certificatePem: string): string {
  const spki = new X509Certificate(certificatePem).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('base64');
}

function isP256Key(publicKey: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  } catch {
    return false;
  }
}

function signatureHolds(publicKey: string, text: string, signature: unknown): boolean {
  if (typeof signature !== 'string') return false;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return verify('sha256', Buffer.from(text), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

function digest(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}

function writePrivate(file: string, text: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function localAddresses(): string[] {
  const found: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.') && isLocalPeer(entry.address)) {
        found.push(entry.address);
      }
    }
  }
  return found;
}

export class Gateway {
  private readonly stateFile: string;
  private readonly keyFile: string;
  private readonly certFile: string;
  private readonly now: () => number;
  private stored: Stored;
  private server: https.Server | null = null;
  private wss: WebSocketServer | null = null;
  private bonjour: Bonjour | null = null;
  private service: Service | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly connections = new Set<Connection>();
  private pairing: { code: Buffer; expiresAt: number } | null = null;
  private pin = '';
  private listenError: string | null = null;
  private starting: Promise<void> | null = null;

  constructor(private readonly options: GatewayOptions) {
    this.stateFile = path.join(options.dir, 'gateway.json');
    this.keyFile = path.join(options.dir, 'gateway-key.pem');
    this.certFile = path.join(options.dir, 'gateway-cert.pem');
    this.now = options.now ?? Date.now;
    this.stored = this.load();
  }

  private load(): Stored {
    const fresh: Stored = {
      enabled: false,
      port: this.options.port ?? DEFAULT_GATEWAY_PORT,
      id: randomUUID(),
      devices: [],
    };
    try {
      const read = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<Stored>;
      return {
        enabled: read.enabled === true,
        port: this.options.port ?? (Number.isInteger(read.port) ? read.port as number : fresh.port),
        id: typeof read.id === 'string' ? read.id : fresh.id,
        devices: Array.isArray(read.devices) ? read.devices.filter((d) => isP256Key(d.publicKey)) : [],
      };
    } catch {
      return fresh;
    }
  }

  private save(): void {
    fs.mkdirSync(this.options.dir, { recursive: true });
    writePrivate(this.stateFile, JSON.stringify(this.stored, null, 2));
  }

  /** The daemon's key, made once. Replacing it would unpair every phone. */
  private async identity(): Promise<{ key: string; cert: string }> {
    try {
      return {
        key: fs.readFileSync(this.keyFile, 'utf8'),
        cert: fs.readFileSync(this.certFile, 'utf8'),
      };
    } catch {
      // First use. A half-written pair cannot be used either, so it is replaced.
    }
    fs.mkdirSync(this.options.dir, { recursive: true });
    const made = await selfsigned.generate(
      [{ name: 'commonName', value: 'sertumd' }],
      { keyType: 'ec', curve: 'P-256', algorithm: 'sha256', notAfterDate: new Date(Date.now() + 20 * 365 * 86_400_000) },
    );
    writePrivate(this.keyFile, made.private);
    writePrivate(this.certFile, made.cert);
    return { key: made.private, cert: made.cert };
  }

  /** Starts listening if it was left on. Called when the daemon comes up. */
  async start(): Promise<void> {
    if (this.stored.enabled) await this.listen();
  }

  private listen(): Promise<void> {
    this.starting ??= this.bind().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async bind(): Promise<void> {
    if (this.server) return;
    this.listenError = null;
    const { key, cert } = await this.identity();
    this.pin = pinOf(cert);
    const server = https.createServer({ key, cert, minVersion: 'TLSv1.3' });
    // Before TLS, so an address that cannot be local costs one socket and no work.
    server.on('connection', (socket: Socket) => {
      if (!isLocalPeer(socket.remoteAddress)) socket.destroy();
    });
    server.on('request', (_request, response) => {
      response.writeHead(426, { Connection: 'close' });
      response.end();
    });
    const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME, perMessageDeflate: false });
    wss.on('connection', (socket, request) => this.accept(socket, request.socket.remoteAddress ?? ''));
    // ws re-raises the server's errors as its own, and an unheard one would take
    // the daemon and every session down over a port that happened to be busy.
    wss.on('error', () => undefined);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.stored.port, '::', () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      this.listenError = code === 'EADDRINUSE'
        ? `Port ${this.stored.port} is already in use on this PC.`
        : `Could not listen on port ${this.stored.port}: ${(err as Error).message}`;
      console.error(`[gateway] ${this.listenError}`);
      wss.close();
      return;
    }
    // A running server can still fail; say so rather than going quiet.
    server.on('error', (err) => console.error('[gateway] server error:', err.message));
    this.server = server;
    this.wss = wss;
    this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);
    this.stored.port = (server.address() as { port: number }).port;
    if (this.options.advertise !== false) this.publish();
    console.log(`[gateway] listening on port ${this.stored.port}`);
  }

  /** Discovery only says where to try. The phone's pin decides who it found. */
  private publish(): void {
    try {
      this.bonjour = new Bonjour();
      this.service = this.bonjour.publish({
        // A DNS label holds 63 bytes. The id keeps two PCs named alike apart.
        name: `${os.hostname().slice(0, 40)} ${this.stored.id.slice(0, 8)}`,
        type: MDNS_TYPE,
        port: this.stored.port,
        txt: { id: this.stored.id, api: String(GATEWAY_API) },
      });
      this.service.on('error', (err: unknown) => console.error('[gateway] mdns error:', String(err)));
    } catch (err) {
      console.error('[gateway] mdns failed; a phone can still use the address:', String(err));
    }
  }

  private accept(socket: WebSocket, address: string): void {
    const waiting = [...this.connections].filter((c) => !c.device).length;
    if (waiting >= MAX_UNAUTHENTICATED) {
      socket.close(1013, 'busy');
      return;
    }
    const connection: Connection = {
      socket,
      address,
      nonce: randomBytes(32).toString('base64'),
      device: null,
      files: newDeviceFiles(),
      alive: true,
      authTimer: null,
    };
    connection.authTimer = setTimeout(() => {
      if (!connection.device) socket.close(4408, 'no credentials');
    }, AUTH_TIMEOUT_MS);
    this.connections.add(connection);
    socket.on('pong', () => { connection.alive = true; });
    socket.on('error', (err) => console.error(`[gateway] socket ${address}:`, err.message));
    socket.on('close', () => {
      if (connection.authTimer) clearTimeout(connection.authTimer);
      this.connections.delete(connection);
      if (connection.device) this.options.onChanged();
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'text only');
        return;
      }
      const size = Array.isArray(data) ? data.reduce((sum, part) => sum + part.length, 0)
        : (data as Buffer | ArrayBuffer).byteLength;
      if (!connection.device && size > MAX_UNAUTHENTICATED_FRAME) {
        socket.close(1009, 'too large');
        return;
      }
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        socket.close(1007, 'not JSON');
        return;
      }
      if (connection.device) void this.request(connection, frame);
      else this.credentials(connection, frame);
    });
    this.send(connection, {
      t: 'challenge',
      api: GATEWAY_API,
      nonce: connection.nonce,
      server: { id: this.stored.id, name: os.hostname() },
    });
  }

  private send(connection: Connection, frame: unknown): void {
    const { socket } = connection;
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED) {
      socket.close(1013, 'fell behind');
      return;
    }
    socket.send(JSON.stringify(frame));
  }

  private refuse(connection: Connection, reason: 'api' | 'unknown' | 'signature' | 'code' | 'request', message: string): void {
    console.log(`[gateway] refused ${connection.address}: ${reason}`);
    this.send(connection, { t: 'refused', reason, message });
    connection.socket.close(4401, reason);
  }

  private credentials(connection: Connection, frame: Record<string, unknown>): void {
    if (frame.api !== GATEWAY_API) {
      this.refuse(connection, 'api', `This PC speaks gateway API ${GATEWAY_API}. Update the app.`);
    } else if (frame.t === 'auth') {
      this.authenticate(connection, frame);
    } else if (frame.t === 'pair') {
      this.pair(connection, frame);
    } else {
      this.refuse(connection, 'request', 'Sign in first.');
    }
  }

  private authenticate(connection: Connection, frame: Record<string, unknown>): void {
    const device = this.stored.devices.find((d) => d.id === frame.deviceId);
    if (!device) {
      // The same answer for a revoked phone and one never seen.
      this.refuse(connection, 'unknown', 'This PC does not know this phone. Pair it again.');
      return;
    }
    if (!signatureHolds(device.publicKey, signedText('auth', connection.nonce, this.pin), frame.signature)) {
      this.refuse(connection, 'signature', 'This phone could not prove who it is. Pair it again.');
      return;
    }
    this.welcome(connection, device);
  }

  private pair(connection: Connection, frame: Record<string, unknown>): void {
    const { code, publicKey, signature } = frame;
    const pairing = this.pairing;
    const offered = pairing !== null && pairing.expiresAt > this.now() && typeof code === 'string' &&
      timingSafeEqual(digest(code), pairing.code);
    if (!offered) {
      // A wrong guess leaves the code standing. Burning it would let anything on
      // the network cancel a pairing, and 128 random bits have no need to.
      this.refuse(connection, 'code', 'That pairing code is wrong or has expired. Show a new one on the PC.');
      return;
    }
    if (typeof publicKey !== 'string' || !isP256Key(publicKey) ||
      !signatureHolds(publicKey, signedText('pair', connection.nonce, this.pin), signature)) {
      this.refuse(connection, 'signature', 'This phone could not prove it holds its key.');
      return;
    }
    this.pairing = null;
    const device: StoredDevice = {
      id: randomUUID(),
      name: typeof frame.name === 'string' && frame.name.trim() ? frame.name.trim().slice(0, 80) : 'Phone',
      publicKey,
      pairedAt: this.now(),
      lastSeenAt: null,
    };
    this.stored.devices.push(device);
    this.save();
    console.log(`[gateway] paired ${device.id} from ${connection.address}`);
    this.welcome(connection, device);
  }

  private welcome(connection: Connection, device: StoredDevice): void {
    if (connection.authTimer) clearTimeout(connection.authTimer);
    connection.authTimer = null;
    connection.device = device;
    device.lastSeenAt = this.now();
    this.save();
    this.send(connection, { t: 'ready', api: GATEWAY_API, deviceId: device.id, version: this.options.version });
    this.options.onChanged();
  }

  private async request(connection: Connection, frame: Record<string, unknown>): Promise<void> {
    const { id, method, params } = frame;
    if (frame.t !== 'req' || typeof id !== 'number' || typeof method !== 'string') return;
    try {
      const admitted = admit(method, params, connection.files);
      const result = await this.options.dispatch(method, admitted);
      afterAnswer(method, admitted, result, connection.files);
      this.send(connection, { t: 'res', id, ok: true, result: outgoing(method, result) ?? null });
    } catch (err) {
      this.send(connection, { t: 'res', id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Every daemon event comes through here, and most stop here. */
  event(name: string, payload: unknown): void {
    if (!GATEWAY_EVENTS.has(name)) return;
    let frame: unknown = null;
    for (const connection of this.connections) {
      if (!connection.device) continue;
      frame ??= { t: 'event', name, payload: outgoingEvent(name, payload) };
      this.send(connection, frame);
    }
  }

  private beat(): void {
    for (const connection of this.connections) {
      if (!connection.alive) {
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
  }

  async setEnabled(enabled: boolean): Promise<GatewayStatus> {
    this.stored.enabled = enabled;
    this.save();
    if (enabled) await this.listen();
    else await this.stop();
    this.options.onChanged();
    return this.status();
  }

  beginPairing(): GatewayPairing {
    if (!this.server) throw new Error('Turn on phone access first.');
    const code = randomBytes(16).toString('base64url');
    const expiresAt = this.now() + PAIRING_MS;
    this.pairing = { code: digest(code), expiresAt };
    const hosts = localAddresses();
    const payload = Buffer.from(JSON.stringify({
      v: GATEWAY_API,
      id: this.stored.id,
      name: os.hostname(),
      pin: this.pin,
      port: this.stored.port,
      hosts,
      code,
    })).toString('base64url');
    return { payload: `sertum-pair:${payload}`, expiresAt, hosts, port: this.stored.port };
  }

  cancelPairing(): void {
    this.pairing = null;
  }

  /** A revoked phone is cut off now, not at its next connection. */
  revoke(id: string): GatewayStatus {
    this.stored.devices = this.stored.devices.filter((device) => device.id !== id);
    this.save();
    for (const connection of this.connections) {
      if (connection.device?.id === id) {
        this.send(connection, { t: 'refused', reason: 'unknown', message: 'This phone was removed on the PC.' });
        // Nothing more is served in the moments before the close completes.
        connection.device = null;
        connection.socket.close(4401, 'revoked');
      }
    }
    this.options.onChanged();
    return this.status();
  }

  status(): GatewayStatus {
    const connected = new Set([...this.connections].map((c) => c.device?.id));
    const devices: GatewayDevice[] = this.stored.devices.map((device) => ({
      id: device.id,
      name: device.name,
      pairedAt: device.pairedAt,
      lastSeenAt: device.lastSeenAt,
      connected: connected.has(device.id),
    }));
    return {
      enabled: this.stored.enabled,
      listening: this.server !== null,
      port: this.stored.port,
      addresses: localAddresses(),
      error: this.listenError,
      devices,
    };
  }

  /** Stops listening and drops every phone. What was paired stays paired. */
  async stop(): Promise<void> {
    this.pairing = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const connection of this.connections) connection.socket.terminate();
    const { server, wss, bonjour } = this;
    this.server = null;
    this.wss = null;
    this.bonjour = null;
    this.service = null;
    wss?.close();
    await new Promise<void>((resolve) => {
      if (!bonjour) return resolve();
      bonjour.unpublishAll(() => {
        bonjour.destroy();
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}
