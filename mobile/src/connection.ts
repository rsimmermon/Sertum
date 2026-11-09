import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { GATEWAY_API_VERSION, signedText, type PairingOffer } from './pairing';

interface PinnedSocket {
  connect(options: { url: string; pinSha256: string }): Promise<{ connection: number }>;
  send(options: { connection: number; text: string }): Promise<{ queued: boolean }>;
  close(options: { connection?: number }): Promise<void>;
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

/** What the phone remembers about one PC. None of it is a secret: the key is in the Keystore. */
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
  | { kind: 'unreachable'; found: string | null; tried: string[]; detail: string | null; retryAt: number | null }
  | { kind: 'refused'; reason: string; message: string };

const REQUEST_TIMEOUT_MS = 60_000;
const ATTEMPT_TIMEOUT_MS = 12_000;
/**
 * After a failed attempt, the next tries come this far apart, the last repeating.
 * A PC that is switched off should not be hunted for every few seconds, so the
 * gap grows to minutes, and nothing is tried at all while the app is in the
 * background. Coming back to the app, Try again, or using one of the PC's
 * sessions each try at once.
 */
const RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 300_000];
/** How long a request waits on a reconnect before saying the PC is out of reach. */
const RECONNECT_WAIT_MS = 15_000;
const SERVICE_TYPE = '_sertum._tcp.';

type SocketEvent = { kind: 'message'; text: string } | { kind: 'gone'; detail: string };

/**
 * Shared by every connection. The plugin holds one socket per PC and names the
 * socket on each event, so each event goes to the connection that opened it.
 */
const routes = new Map<number, (event: SocketEvent) => void>();
/** PC id to the address mDNS last saw it at. */
const discovered = new Map<string, string>();
let listening: Promise<unknown> | null = null;
let browsers = 0;

function listen(): Promise<unknown> {
  // A reloaded page leaves the last page's sockets open in the plugin, which only
  // this page uses, so anything still open belongs to no one and is closed first.
  listening ??= socket.close({}).catch(() => undefined).then(() => Promise.all([
    socket.addListener('message', (e) => routes.get(e.connection)?.({ kind: 'message', text: e.text })),
    socket.addListener('closed', (e) => routes.get(e.connection)?.({ kind: 'gone', detail: `closed ${e.code}` })),
    socket.addListener('failure', (e) => routes.get(e.connection)?.({ kind: 'gone', detail: e.message })),
    nsd.addListener('found', (e) => {
      if (e.id && e.host) discovered.set(e.id, e.host);
    }),
  ]));
  return listening;
}

/** Discovery runs while any connection is looking for its PC, and stops when none is. */
async function startDiscovery(): Promise<void> {
  await listen();
  browsers += 1;
  if (browsers > 1) return;
  // Without discovery the addresses already known are still tried.
  await nsd.start({ type: SERVICE_TYPE }).catch(() => undefined);
}

function stopDiscovery(): void {
  browsers = Math.max(0, browsers - 1);
  if (browsers === 0) void nsd.stop().catch(() => undefined);
}

class Refusal extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
  }
}

interface Attempt {
  connection: number;
  onFrame(frame: Record<string, unknown>): void;
  onGone(detail: string): void;
}

/**
 * One socket to one PC, kept alive for as long as the app wants it. A phone paired
 * with several PCs holds one of these for each, side by side (see `Fleet`).
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
  private failures = 0;
  private foreground = true;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private browsing = false;
  private readonly liveWaiters = new Set<(failure: string | null) => void>();

  constructor(
    private readonly onState: (state: ConnectionState) => void,
    private readonly onEvent: (name: string, payload: unknown) => void,
    private readonly onReady: () => void,
    private readonly onPcChanged: (pc: PairedPc) => void,
  ) {}

  /**
   * Closes one socket this connection opened: by default the one in use. Several
   * PCs' sockets are open at once, so closing never means "the" socket.
   */
  private closeAttempt(connection = this.attempt?.connection): void {
    if (connection === undefined) return;
    routes.delete(connection);
    void socket.close({ connection });
    if (this.attempt?.connection === connection) this.attempt = null;
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
    // Someone wants this PC now, so the wait for the next scheduled try is cut short.
    if (this.retry) this.retryNow();
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
    await startDiscovery();
  }

  private stopBrowsing(): void {
    if (!this.browsing) return;
    this.browsing = false;
    stopDiscovery();
  }

  /**
   * Opens a socket to one address and takes it as far as the challenge. A socket
   * that opens after its attempt was given up on is closed, never adopted.
   */
  private open(host: string, port: number, pin: string, cycle: number, greet: (nonce: string) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let mine: number | undefined;
      const finish = (act: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        act();
      };
      const timer = setTimeout(() => finish(() => {
        this.closeAttempt(mine);
        reject(new Error('timed out'));
      }), ATTEMPT_TIMEOUT_MS);
      const url = `wss://${host.includes(':') ? `[${host}]` : host}:${port}`;
      void listen().then(() => socket.connect({ url, pinSha256: pin })).then(({ connection }) => {
        mine = connection;
        if (settled || cycle !== this.cycle) {
          void socket.close({ connection });
          finish(() => reject(new Error('cancelled')));
          return;
        }
        this.closeAttempt();
        routes.set(connection, (event) => {
          const { attempt } = this;
          if (attempt?.connection !== connection) return;
          if (event.kind === 'gone') {
            routes.delete(connection);
            attempt.onGone(event.detail);
            return;
          }
          let frame: Record<string, unknown>;
          try {
            frame = JSON.parse(event.text) as Record<string, unknown>;
          } catch {
            return;
          }
          attempt.onFrame(frame);
        });
        this.attempt = {
          connection,
          onGone: (detail) => finish(() => reject(new Error(detail))),
          onFrame: (frame) => {
            if (frame.t === 'challenge') {
              if (frame.api !== GATEWAY_API_VERSION) {
                finish(() => reject(new Refusal('api', 'This PC and this app speak different versions. Update whichever is older.')));
                return;
              }
              void greet(String(frame.nonce)).then((reply) => {
                void socket.send({ connection, text: JSON.stringify(reply) });
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
    this.failures = 0;
    pc.lastGoodHost = host;
    this.onPcChanged(pc);
    this.set({ kind: 'connected', host });
    this.stopBrowsing();
    this.onReady();
  }

  private hosts(pc: PairedPc): string[] {
    const found = discovered.get(pc.id);
    return [...new Set([pc.manualHost, pc.lastGoodHost, found, ...pc.hosts].filter((h): h is string => Boolean(h)))];
  }

  /** Pairs using a code from the PC, trying each address it named and any found. */
  async pair(offer: PairingOffer, manualHost: string | null): Promise<PairedPc> {
    this.stop();
    const cycle = ++this.cycle;
    await this.browse();
    const key = await device.deviceKey();
    const tried: string[] = [];
    this.set({ kind: 'connecting' });
    let detail: string | null = null;
    // Discovery gets a moment, since a QR code's addresses can already be stale.
    for (let pass = 0; pass < 2; pass += 1) {
      const hosts = [...new Set([manualHost, discovered.get(offer.id), ...offer.hosts].filter((h): h is string => Boolean(h)))];
      for (const host of hosts) {
        if (tried.includes(host)) continue;
        tried.push(host);
        try {
          const ready = await this.open(host, offer.port, offer.pin, cycle, async (nonce) => ({
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
            this.stopBrowsing();
            throw err;
          }
          if (cycle !== this.cycle) throw err;
          detail = err instanceof Error ? err.message : String(err);
        }
      }
      if (pass === 0) await new Promise((r) => setTimeout(r, 2500));
    }
    const found = discovered.get(offer.id) ?? null;
    this.set({ kind: 'unreachable', found, tried, detail, retryAt: null });
    this.stopBrowsing();
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
    this.closeAttempt();
    this.stopBrowsing();
    this.failAll('Disconnected.');
    this.set({ kind: 'idle' });
  }

  /** The app came back to the foreground, or someone pressed Try again. */
  retryNow(): void {
    if (!this.wanted || this.live || this.state.kind === 'refused') return;
    // An attempt already under way is not restarted.
    if (this.state.kind === 'connecting') return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.failures = 0;
    void this.connect();
  }

  /**
   * In the background, a PC out of reach is left alone until the app is back.
   * A socket already open stays open.
   */
  setForeground(foreground: boolean): void {
    this.foreground = foreground;
    if (foreground) {
      this.retryNow();
      return;
    }
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (this.state.kind === 'unreachable') this.set({ ...this.state, retryAt: null });
  }

  private async connect(): Promise<void> {
    const { pc } = this;
    if (!pc || !this.wanted) return;
    const cycle = ++this.cycle;
    await this.browse();
    if (cycle !== this.cycle) return;
    this.set({ kind: 'connecting' });
    const tried: string[] = [];
    let detail: string | null = null;
    for (const pass of [0, 1]) {
      for (const host of this.hosts(pc)) {
        if (tried.includes(host)) continue;
        tried.push(host);
        if (cycle !== this.cycle) return;
        try {
          await this.open(host, pc.port, pc.pin, cycle, async (nonce) => ({
            t: 'auth',
            api: GATEWAY_API_VERSION,
            deviceId: pc.deviceId,
            signature: (await device.sign({ text: signedText('auth', nonce, pc.pin) })).signature,
          }));
          if (cycle !== this.cycle) {
            this.closeAttempt();
            return;
          }
          this.settleOpen(host, pc);
          return;
        } catch (err) {
          if (cycle !== this.cycle) return;
          if (err instanceof Refusal) {
            this.set({ kind: 'refused', reason: err.reason, message: err.message });
            this.stopBrowsing();
            return;
          }
          detail = err instanceof Error ? err.message : String(err);
        }
      }
      if (pass === 0) await new Promise((r) => setTimeout(r, 1500));
    }
    if (cycle !== this.cycle) return;
    const delay = RETRY_DELAYS_MS[Math.min(this.failures, RETRY_DELAYS_MS.length - 1)];
    this.failures += 1;
    const retryAt = this.foreground ? Date.now() + delay : null;
    if (retryAt !== null) {
      this.retry = setTimeout(() => {
        this.retry = null;
        void this.connect();
      }, delay);
    }
    this.set({ kind: 'unreachable', found: discovered.get(pc.id) ?? null, tried, detail, retryAt });
  }

  private dropped(): void {
    this.live = false;
    this.closeAttempt();
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
      const connection = this.attempt?.connection;
      const sent = connection === undefined
        ? Promise.resolve({ queued: false })
        : socket.send({ connection, text: JSON.stringify({ t: 'req', id, method, params }) });
      void sent.then(({ queued }) => {
        if (queued) return;
        this.waiting.delete(id);
        clearTimeout(timer);
        reject(new Error('The connection to the PC was lost.'));
      });
    });
  }
}
