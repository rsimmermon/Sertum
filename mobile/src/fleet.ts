import type { AgentCapabilities, AgentKind, SessionSnapshot, SessionSpec } from '@desktop/shared/types';
import { Connection, type ConnectionState, type PairedPc } from './connection';
import type { PairingOffer } from './pairing';

const PCS_KEY = 'sertum.pcs';
/** Where a phone paired with one PC, before it could pair with several, kept it. */
const LEGACY_PC_KEY = 'sertum.pc';
const LEGACY_FOLDERS_KEY = 'sertum.folders';

export function foldersKey(pcId: string): string {
  return `sertum.folders.${pcId}`;
}

/** The PC's sessions as last seen, so a PC that is off still shows them after a restart. */
export function sessionsKey(pcId: string): string {
  return `sertum.sessions.${pcId}`;
}

export interface Member {
  pc: PairedPc;
  connection: Connection;
  /** Being paired right now: shown nowhere until it succeeds. */
  pairing: boolean;
  capabilities: Record<AgentKind, AgentCapabilities> | null;
}

export interface FleetHooks {
  /** A PC's connection state changed. */
  state(pcId: string): void;
  /** A PC's socket opened, so everything held for it may be stale. */
  ready(pcId: string): void;
  /** An event from one PC. Session ids are unique across PCs, so these merge. */
  event(pcId: string, name: string, payload: unknown): void;
}

export type PairOutcome = { ok: true; pc: PairedPc } | { ok: false; state: ConnectionState };

function read<T>(key: string): T | null {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) as T : null;
  } catch {
    return null;
  }
}

/**
 * Every PC this phone is paired with, each on its own socket, presented as one
 * place. Which PC owns a session is learned from that PC's own list and events,
 * and every call about a session goes to that PC alone.
 */
export class Fleet {
  readonly hooks: FleetHooks = { state: () => undefined, ready: () => undefined, event: () => undefined };
  private readonly members = new Map<string, Member>();
  private readonly owners = new Map<string, { pcId: string; cwd: string }>();
  /** The session on screen, which says where a picked file or a pasted path belongs. */
  focus: string | null = null;

  /** Reads the paired PCs and starts connecting to each. */
  load(): void {
    let pcs = read<PairedPc[]>(PCS_KEY);
    if (!pcs) {
      const legacy = read<PairedPc>(LEGACY_PC_KEY);
      pcs = legacy ? [legacy] : [];
      const folders = read<string[]>(LEGACY_FOLDERS_KEY);
      try {
        if (legacy && folders) localStorage.setItem(foldersKey(legacy.id), JSON.stringify(folders));
        localStorage.setItem(PCS_KEY, JSON.stringify(pcs));
        localStorage.removeItem(LEGACY_PC_KEY);
        localStorage.removeItem(LEGACY_FOLDERS_KEY);
      } catch {
        // Read from the old place again next time.
      }
    }
    for (const pc of pcs) this.add(pc, false).connection.start(pc);
  }

  private save(): void {
    try {
      localStorage.setItem(PCS_KEY, JSON.stringify(this.list().map((m) => m.pc)));
    } catch {
      // Not a secret, and nothing to do: the phone keeps what it has in memory.
    }
  }

  private add(pc: PairedPc, pairing: boolean): Member {
    const pcId = pc.id;
    const member: Member = {
      pc,
      pairing,
      capabilities: null,
      connection: new Connection(
        () => this.hooks.state(pcId),
        (name, payload) => this.event(pcId, name, payload),
        () => this.hooks.ready(pcId),
        (next) => {
          member.pc = next;
          if (!member.pairing) this.save();
        },
      ),
    };
    this.members.set(pcId, member);
    return member;
  }

  private event(pcId: string, name: string, payload: unknown): void {
    if (name === 'session:updated') {
      const session = payload as SessionSnapshot;
      this.owners.set(session.id, { pcId, cwd: session.cwd });
    } else if (name === 'session:removed') {
      this.owners.delete((payload as { id: string }).id);
    }
    this.hooks.event(pcId, name, payload);
  }

  /** Paired PCs, in the order they were paired. */
  list(): Member[] {
    return [...this.members.values()].filter((m) => !m.pairing);
  }

  get(pcId: string): Member | null {
    const member = this.members.get(pcId);
    return member && !member.pairing ? member : null;
  }

  ownerOf(sessionId: string): Member | null {
    const owner = this.owners.get(sessionId);
    return owner ? this.get(owner.pcId) : null;
  }

  /** The PC of the session on screen, or the only PC there is. */
  focusedPc(): Member | null {
    const owned = this.focus ? this.ownerOf(this.focus) : null;
    if (owned) return owned;
    const all = this.list();
    return all.length === 1 ? all[0] : null;
  }

  /** A folder named by a message belongs to the PC whose session has that folder. */
  pcForCwd(cwd: string): Member | null {
    const focused = this.focusedPc();
    if (focused && this.focus && this.owners.get(this.focus)?.cwd === cwd) return focused;
    for (const owner of this.owners.values()) {
      if (owner.cwd === cwd) return this.get(owner.pcId);
    }
    return focused;
  }

  callOn<T>(pcId: string, method: string, params?: unknown): Promise<T> {
    const member = this.get(pcId);
    if (!member) return Promise.reject(new Error('That PC is no longer paired with this phone.'));
    return member.connection.call<T>(method, params);
  }

  callFor<T>(sessionId: string, method: string, params?: unknown): Promise<T> {
    const owner = this.owners.get(sessionId);
    if (!owner) return Promise.reject(new Error('This phone does not know which PC that session is on.'));
    return this.callOn<T>(owner.pcId, method, params);
  }

  /** One PC's sessions, which also replaces what is known about which it owns. */
  async listSessions(pcId: string): Promise<SessionSnapshot[]> {
    const listed = await this.callOn<SessionSnapshot[]>(pcId, 'session/list');
    for (const [id, owner] of this.owners) {
      if (owner.pcId === pcId) this.owners.delete(id);
    }
    for (const session of listed) this.owners.set(session.id, { pcId, cwd: session.cwd });
    return listed;
  }

  /**
   * Sessions remembered from the last time this PC answered. They are shown as
   * offline until the PC is reached, when its own list replaces them.
   */
  remember(pcId: string, sessions: SessionSnapshot[]): void {
    for (const session of sessions) this.owners.set(session.id, { pcId, cwd: session.cwd });
  }

  async createSession(pcId: string, spec: Partial<SessionSpec>): Promise<SessionSnapshot> {
    const made = await this.callOn<SessionSnapshot>(pcId, 'session/create', spec);
    this.owners.set(made.id, { pcId, cwd: made.cwd });
    return made;
  }

  /**
   * Pairs with a PC from its code. Pairing again with one already paired
   * replaces its record, and a failure puts the old one back.
   */
  async pair(offer: PairingOffer, manualHost: string | null): Promise<PairOutcome> {
    const previous = this.members.get(offer.id);
    previous?.connection.stop();
    const member = this.add({
      id: offer.id, name: offer.name, pin: offer.pin, port: offer.port, hosts: offer.hosts,
      deviceId: '', manualHost, lastGoodHost: null,
    }, true);
    try {
      const pc = await member.connection.pair(offer, manualHost);
      member.pc = pc;
      member.pairing = false;
      this.save();
      this.hooks.state(pc.id);
      // The socket opened while it was still pairing, when the shell could not see
      // it yet, so its sessions are read now.
      this.hooks.ready(pc.id);
      return { ok: true, pc };
    } catch {
      const state = member.connection.state;
      member.connection.stop();
      this.members.delete(offer.id);
      if (previous) {
        this.members.set(offer.id, previous);
        previous.connection.start(previous.pc);
      }
      return { ok: false, state };
    }
  }

  /** Saves a changed address and reconnects with it. */
  update(pc: PairedPc): void {
    const member = this.get(pc.id);
    if (!member) return;
    member.pc = pc;
    this.save();
    member.connection.start(pc);
  }

  /** Session ids this PC owns, before it is forgotten. */
  sessionsOf(pcId: string): string[] {
    return [...this.owners].filter(([, owner]) => owner.pcId === pcId).map(([id]) => id);
  }

  forget(pcId: string): void {
    const member = this.members.get(pcId);
    if (!member) return;
    member.connection.stop();
    this.members.delete(pcId);
    for (const id of this.sessionsOf(pcId)) this.owners.delete(id);
    try {
      localStorage.removeItem(foldersKey(pcId));
      localStorage.removeItem(sessionsKey(pcId));
    } catch {
      // Harmless if it stays.
    }
    this.save();
  }

  retry(pcId: string): void {
    this.get(pcId)?.connection.retryNow();
  }

  /** In the background, PCs out of reach are left alone. */
  setForeground(foreground: boolean): void {
    for (const member of this.list()) member.connection.setForeground(foreground);
  }
}
