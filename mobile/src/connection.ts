import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { GATEWAY_API_VERSION, signedText, type PairingOffer } from './pairing';

interface PinnedSocket {
  connect(options: { url: string; pinSha256: string }): Promise<{ connection: number }>;
  send(options: { text: string }): Promise<{ queued: boolean }>;
  close(): Promise<void>;
  addListener(event: 'open', fn: (e: { connection: number; tls: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'message', fn: (e: { connection: number; text: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'closed', fn: (e: { connection: number; code: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'failure', fn: (e: { connection: number; message: string }) => void): Promise<PluginListenerHandle>;
}
interface NsdBrowser {
  start(options: { type: string }): Promise<void>;
  stop(): Promise<void>;
  addListener(event: 'found', fn: (e: { name: string; host: string | null; port: number; id: string | null }) => void): Promise<PluginListenerHandle>;
}
export interface PhoneDevice {
  deviceKey(): Promise<{ publicKey: string; name: string }>;
  sign(options: { text: string }): Promise<{ signature: string }>;
  scanQr(): Promise<{ text?: string; cancelled?: boolean }>;
  readClipboard(): Promise<{ text: string }>;
}
const socket = registerPlugin<PinnedSocket>('PinnedSocket');
const nsd = registerPlugin<NsdBrowser>('NsdBrowser');
export const device = registerPlugin<PhoneDevice>('PhoneDevice');

/** What the phone remembers about its PC. None of it is a secret: the key is in the Keystore. */
export interface PairedPc {
  id: string;
  name: string;
  pin: string;
  port: number;
  hosts: string[];
  deviceId: string;
  /** Typed by hand, for a VPN or a network mDNS cannot cross. Tried first. */
  manualHost: string | null;
  lastGoodHost: string | null;
}

/**
 * Finding a PC and reaching it are reported apart, because a firewall lets the
 * first through and not the second, and the two call for different fixes.
 */
export type ConnectionState =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'connected'; host: string }
  | { kind: 'unreachable'; found: string | null; tried: string[]; detail: string | null }
  | { kind: 'refused'; reason: string; message: string };

const REQUEST_TIMEOUT_MS = 60_000;
const ATTEMPT_TIMEOUT_MS = 12_000;
const MAX_BACKOFF_MS = 15_000;
/** How long a request waits on a reconnect before saying the PC is out of reach. */
const RECONNECT_WAIT_MS = 15_000;
const SERVICE_TYPE = '_sertum._tcp.';

class Refusal extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
  }
}

interface Attempt {
  connection: number;
  onFrame(frame: Record<string, unknown>): void;
  onGone(detail: string): void;
  pin: string;
}

/**
 * One socket to one PC, kept alive for as long as the app wants it.
 *
 * Everything a dropped socket loses is answered by asking again: the session list
 * is reread and a pane catches up from the version it holds. So a reconnect has no
 * replay to manage, and a request in flight when it drops just fails.
 */
export class Connection {
  state: ConnectionState = { kind: 'idle' };
  private pc: PairedPc | null = null;
  private attempt: Attempt | null = null;
  private live = false;
  private wanted = false;
  private cycle = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private backoff = 1000;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly found = new Map<string, string>();
  private browsing = false;
  private readonly liveWaiters = new Set<(failure: string | null) => void>();
  private readonly installed: Promise<unknown>;

  constructor(
    private readonly onState: (state: ConnectionState) => void,
    private readonly onEvent: (name: string, payload: unknown) => void,
    private readonly onReady: () => void,
    private readonly onPcChanged: (pc: PairedPc) => void,
  ) {
    this.installed = Promise.all([
      socket.addListener('message', (e) => {
        if (e.connection !== this.attempt?.connection) return;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(e.text) as Record<string, unknown>;
        } catch {
          return;
        }
        this.attempt.onFrame(frame);
      }),
      socket.addListener('closed', (e) => this.gone(e.connection, `closed ${e.code}`)),
      socket.addListener('failure', (e) => this.gone(e.connection, e.message)),
      nsd.addListener('found', (e) => {
        if (e.id && e.host) this.found.set(e.id, e.host);
      }),
    ]);
  }

  private gone(connection: number, detail: string): void {
    if (connection === this.attempt?.connection) this.attempt.onGone(detail);
  }

  private set(state: ConnectionState): void {
    this.state = state;
    if (state.kind === 'connected') this.settleWaiters(null);
    else if (state.kind === 'refused' || state.kind === 'idle') this.settleWaiters('Not connected to the PC.');
    this.onState(state);
  }

  private settleWaiters(failure: string | null): void {
    for (const waiter of [...this.liveWaiters]) waiter(failure);
  }

  /**
   * Returning from the file picker, or from the phone sleeping, the socket is often
   * still coming back. A file chosen in that second has to wait for it, not fail.
   */
  private whenLive(): Promise<void> {
    if (this.live) return Promise.resolve();
    if (!this.wanted || this.state.kind === 'refused') return Promise.reject(new Error('Not connected to the PC.'));
    return new Promise((resolve, reject) => {
      const waiter = (failure: string | null): void => {
        clearTimeout(timer);
        this.liveWaiters.delete(waiter);
        if (failure) reject(new Error(failure));
        else resolve();
      };
      const timer = setTimeout(() => waiter('Not connected to the PC.'), RECONNECT_WAIT_MS);
      this.liveWaiters.add(waiter);
    });
  }

  private async browse(): Promise<void> {
    if (this.browsing) return;
    this.browsing = true;
    try {
      await nsd.start({ type: SERVICE_TYPE });
    } catch {
      this.browsing = false;
    }
  }

  private async stopBrowsing(): Promise<void> {
    if (!this.browsing) return;
    this.browsing = false;
    await nsd.stop().catch(() => undefined);
  }

  /** Opens a socket to one address and takes it as far as the challenge. */
  private open(host: string, port: number, pin: string, greet: (nonce: string) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (act: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        act();
      };
      const timer = setTimeout(() => finish(() => {
        void socket.close();
        this.attempt = null;
        reject(new Error('timed out'));
      }), ATTEMPT_TIMEOUT_MS);
      const url = `wss://${host.includes(':') ? `[${host}]` : host}:${port}`;
      void socket.connect({ url, pinSha256: pin }).then(({ connection }) => {
        this.attempt = {
          connection,
          pin,
          onGone: (detail) => finish(() => reject(new Error(detail))),
          onFrame: (frame) => {
            if (frame.t === 'challenge') {
              if (frame.api !== GATEWAY_API_VERSION) {
                finish(() => reject(new Refusal('api', 'This PC and this app speak different versions. Update whichever is older.')));
                return;
              }
              void greet(String(frame.nonce)).then((reply) => {
                void socket.send({ text: JSON.stringify(reply) });
              }).catch((err: unknown) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))));
            } else if (frame.t === 'ready') {
              finish(() => resolve(frame));
            } else if (frame.t === 'refused') {
              finish(() => reject(new Refusal(String(frame.reason), String(frame.message))));
            }
          },
        };
      }).catch((err: unknown) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))));
    });
  }

  private settleOpen(host: string, pc: PairedPc): void {
    const { attempt } = this;
    if (!attempt) return;
    attempt.onFrame = (frame) => this.frame(frame);
    attempt.onGone = () => this.dropped();
    this.live = true;
    this.backoff = 1000;
    pc.lastGoodHost = host;
    this.onPcChanged(pc);
    this.set({ kind: 'connected', host });
    void this.stopBrowsing();
    this.onReady();
  }

  private hosts(pc: PairedPc): string[] {
    const found = this.found.get(pc.id);
    return [...new Set([pc.manualHost, pc.lastGoodHost, found, ...pc.hosts].filter((h): h is string => Boolean(h)))];
  }

  /** Pairs using a code from the PC, trying each address it named and any found. */
  async pair(offer: PairingOffer, manualHost: string | null): Promise<PairedPc> {
    this.stop();
    await this.installed;
    await this.browse();
    const key = await device.deviceKey();
    const tried: string[] = [];
    const cycle = ++this.cycle;
    this.set({ kind: 'connecting' });
    let detail: string | null = null;
    // Discovery gets a moment, since a QR code's addresses can already be stale.
    for (let pass = 0; pass < 2; pass += 1) {
      const hosts = [...new Set([manualHost, this.found.get(offer.id), ...offer.hosts].filter((h): h is string => Boolean(h)))];
      for (const host of hosts) {
        if (tried.includes(host)) continue;
        tried.push(host);
        try {
          const ready = await this.open(host, offer.port, offer.pin, async (nonce) => ({
            t: 'pair',
            api: GATEWAY_API_VERSION,
            code: offer.code,
            name: key.name,
            publicKey: key.publicKey,
            signature: (await device.sign({ text: signedText('pair', nonce, offer.pin) })).signature,
          }));
          if (cycle !== this.cycle) throw new Error('cancelled');
          const pc: PairedPc = {
            id: offer.id, name: offer.name, pin: offer.pin, port: offer.port, hosts: offer.hosts,
            deviceId: String(ready.deviceId), manualHost, lastGoodHost: host,
          };
          this.pc = pc;
          this.wanted = true;
          this.settleOpen(host, pc);
          return pc;
        } catch (err) {
          if (err instanceof Refusal) {
            this.set({ kind: 'refused', reason: err.reason, message: err.message });
            await this.stopBrowsing();
            throw err;
          }
          detail = err instanceof Error ? err.message : String(err);
        }
      }
      if (pass === 0) await new Promise((r) => setTimeout(r, 2500));
    }
    const found = this.found.get(offer.id) ?? null;
    this.set({ kind: 'unreachable', found, tried, detail });
    await this.stopBrowsing();
    throw new Error('unreachable');
  }

  /** Keeps a socket open to this PC until `stop`. */
  start(pc: PairedPc): void {
    this.stop();
    this.pc = pc;
    this.wanted = true;
    void this.connect();
  }

  stop(): void {
    this.wanted = false;
    this.cycle += 1;
    this.live = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.attempt = null;
    void socket.close();
    void this.stopBrowsing();
    this.failAll('Disconnected.');
    this.set({ kind: 'idle' });
  }

  /** The app came back to the foreground, or someone pressed Try again. */
  retryNow(): void {
    if (!this.wanted || this.live || this.state.kind === 'refused') return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.backoff = 1000;
    void this.connect();
  }

  private async connect(): Promise<void> {
    const { pc } = this;
    if (!pc || !this.wanted) return;
    const cycle = ++this.cycle;
    await this.installed;
    await this.browse();
    this.set({ kind: 'connecting' });
    const tried: string[] = [];
    let detail: string | null = null;
    for (const pass of [0, 1]) {
      for (const host of this.hosts(pc)) {
        if (tried.includes(host)) continue;
        tried.push(host);
        if (cycle !== this.cycle) return;
        try {
          await this.open(host, pc.port, pc.pin, async (nonce) => ({
            t: 'auth',
            api: GATEWAY_API_VERSION,
            deviceId: pc.deviceId,
            signature: (await device.sign({ text: signedText('auth', nonce, pc.pin) })).signature,
          }));
          if (cycle !== this.cycle) {
            void socket.close();
            return;
          }
          this.settleOpen(host, pc);
          return;
        } catch (err) {
          if (cycle !== this.cycle) return;
          if (err instanceof Refusal) {
            this.set({ kind: 'refused', reason: err.reason, message: err.message });
            void this.stopBrowsing();
            return;
          }
          detail = err instanceof Error ? err.message : String(err);
        }
      }
      if (pass === 0) await new Promise((r) => setTimeout(r, 1500));
    }
    if (cycle !== this.cycle) return;
    this.set({ kind: 'unreachable', found: this.found.get(pc.id) ?? null, tried, detail });
    this.retry = setTimeout(() => void this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  private dropped(): void {
    this.live = false;
    this.attempt = null;
    this.failAll('The connection to the PC was lost.');
    if (!this.wanted || this.state.kind === 'refused') return;
    void this.connect();
  }

  private failAll(message: string): void {
    for (const [id, pending] of this.waiting) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      this.waiting.delete(id);
    }
  }

  private frame(frame: Record<string, unknown>): void {
    if (frame.t === 'res') {
      const pending = this.waiting.get(frame.id as number);
      if (!pending) return;
      this.waiting.delete(frame.id as number);
      clearTimeout(pending.timer);
      if (frame.ok) pending.resolve(frame.result);
      else pending.reject(new Error(String(frame.error)));
    } else if (frame.t === 'event') {
      this.onEvent(String(frame.name), frame.payload);
    } else if (frame.t === 'refused') {
      // Removed on the PC while connected: no point in coming back.
      this.set({ kind: 'refused', reason: String(frame.reason), message: String(frame.message) });
    }
  }

  async call<T>(method: string, params?: unknown): Promise<T> {
    await this.whenLive();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error('The PC did not answer in time.'));
      }, REQUEST_TIMEOUT_MS);
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      void socket.send({ text: JSON.stringify({ t: 'req', id, method, params }) }).then(({ queued }) => {
        if (queued) return;
        this.waiting.delete(id);
        clearTimeout(timer);
        reject(new Error('The connection to the PC was lost.'));
      });
    });
  }
}
