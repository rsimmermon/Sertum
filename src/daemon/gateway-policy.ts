import fs from 'node:fs';
import path from 'node:path';
import type { ChatAttachment, SessionSnapshot } from '../shared/types';

/**
 * What a paired phone may ask of the daemon.
 *
 * The pipe is trusted because the OS scopes it to this user. The network is not,
 * so nothing reaches the fabric from here unless it is named below, and a method
 * added to the fabric later is refused until someone decides otherwise. Terminal
 * bytes, settings, stored rules, discovery and repairs stay on the PC.
 */
export const GATEWAY_METHODS: ReadonlySet<string> = new Set([
  'session/list',
  'session/create',
  'session/kill',
  'session/remove',
  'session/interrupt-turn',
  'session/permission-mode',
  'session/models',
  'session/model',
  'session/efforts',
  'session/effort',
  'agent/capabilities',
  'conversation/read',
  'conversation/page',
  'conversation/item',
  'image/read-local',
  'chat/submit',
  'chat/queue-remove',
  'upload/begin',
  'upload/chunk',
  'upload/finish',
  'upload/abort',
  'approval/pending',
  'approval/answer',
]);

/** `pty:data` above all stays out: it is pixels, and there is a lot of it. */
export const GATEWAY_EVENTS: ReadonlySet<string> = new Set([
  'session:updated',
  'session:removed',
  'chat:delivered',
  'conversation:changed',
  'approval:needed',
  'approval:gone',
]);

/** The agents a phone can start. A shell is a terminal, which a phone cannot use. */
const STARTABLE_AGENTS: ReadonlySet<string> = new Set(['claude', 'codex', 'grok']);
const MAX_LABEL = 120;
/** Enough for any message the composer takes, with room for its attachments. */
export const MAX_SUBMITTED_ATTACHMENTS = 32;

/** What the gateway remembers about one phone's files, for as long as it runs. */
export interface DeviceFiles {
  uploads: Set<string>;
  attachable: Set<string>;
}

export function newDeviceFiles(): DeviceFiles {
  return { uploads: new Set(), attachable: new Set() };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('That request is not shaped correctly.');
  }
  return value as Record<string, unknown>;
}

/**
 * `session/create` from a phone names an agent and a folder and nothing else.
 *
 * The fabric's spec can also name the executable and its arguments, which from
 * here would be running anything at all without asking an agent to. They are
 * rebuilt rather than filtered, so a field added to the spec later stays out.
 */
function startSpec(params: unknown): { agent: string; cwd: string; label?: string } {
  const p = asRecord(params);
  if (typeof p.agent !== 'string' || !STARTABLE_AGENTS.has(p.agent)) {
    throw new Error('A session started from a phone has to be Claude, Codex or Grok.');
  }
  if (typeof p.cwd !== 'string' || !path.isAbsolute(p.cwd)) {
    throw new Error('A session needs a full folder path.');
  }
  let isFolder = false;
  try {
    isFolder = fs.statSync(p.cwd).isDirectory();
  } catch {
    // Reported below in the same words.
  }
  if (!isFolder) throw new Error('That folder does not exist on this PC.');
  const spec: { agent: string; cwd: string; label?: string } = { agent: p.agent, cwd: p.cwd };
  if (typeof p.label === 'string' && p.label.trim()) spec.label = p.label.trim().slice(0, MAX_LABEL);
  return spec;
}

/** A phone can attach what it uploaded, never a path it merely knows of. */
function submission(params: unknown, files: DeviceFiles): unknown {
  const p = asRecord(params);
  if (p.attachments === undefined) return p;
  if (!Array.isArray(p.attachments) || p.attachments.length > MAX_SUBMITTED_ATTACHMENTS) {
    throw new Error('Those attachments are not shaped correctly.');
  }
  for (const attachment of p.attachments as ChatAttachment[]) {
    if (typeof attachment?.path !== 'string' || !files.attachable.has(attachment.path)) {
      throw new Error('A file has to be uploaded from this phone before it can be attached.');
    }
  }
  return p;
}

function ownUpload(params: unknown, files: DeviceFiles): unknown {
  const p = asRecord(params);
  if (typeof p.uploadId !== 'string' || !files.uploads.has(p.uploadId)) {
    throw new Error('That upload is not in progress.');
  }
  return p;
}

/**
 * The params to hand the fabric, or a refusal. Throwing is the only way past
 * this that does not reach the fabric.
 */
export function admit(method: string, params: unknown, files: DeviceFiles): unknown {
  if (!GATEWAY_METHODS.has(method)) throw new Error(`A phone cannot use ${method}.`);
  switch (method) {
    case 'session/create':
      return startSpec(params);
    case 'chat/submit':
      return submission(params, files);
    case 'upload/chunk':
    case 'upload/finish':
    case 'upload/abort':
      return ownUpload(params, files);
    default:
      return params;
  }
}

/** Notes what an answered request means for the phone's own files. */
export function afterAnswer(method: string, params: unknown, result: unknown, files: DeviceFiles): void {
  if (method === 'upload/begin') {
    files.uploads.add((result as { uploadId: string }).uploadId);
  } else if (method === 'upload/finish') {
    files.uploads.delete((params as { uploadId: string }).uploadId);
    files.attachable.add((result as ChatAttachment).path);
  } else if (method === 'upload/abort') {
    files.uploads.delete((params as { uploadId: string }).uploadId);
  }
}

/**
 * A snapshot with its process line removed. A phone never uses it, a Claude
 * session's carries the whole hooks blob on every update, and it is nobody's
 * business on the network.
 */
export function phoneSnapshot(session: SessionSnapshot): SessionSnapshot {
  return { ...session, command: '', args: [] };
}

/** Applied to everything on its way out, so no path to a phone can miss it. */
export function outgoing(method: string, result: unknown): unknown {
  if (method === 'session/list') return (result as SessionSnapshot[]).map(phoneSnapshot);
  if (method === 'session/create') return phoneSnapshot(result as SessionSnapshot);
  return result;
}

export function outgoingEvent(name: string, payload: unknown): unknown {
  return name === 'session:updated' ? phoneSnapshot(payload as SessionSnapshot) : payload;
}

/**
 * Whether a connection comes from somewhere a local network or a private VPN
 * could be. Everything past this still has to pass pairing, so this only keeps
 * the listener off the internet if a router forwards the port by mistake.
 */
export function isLocalPeer(address: string | undefined): boolean {
  if (!address) return false;
  const plain = address.toLowerCase().replace(/^::ffff:/, '').split('%')[0] ?? '';
  if (plain === '::1') return true;
  if (plain.includes(':')) return /^(fe[89ab]|f[cd])/.test(plain);
  const parts = plain.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  return a === 127 || a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    // Carrier-grade NAT space, which is where Tailscale puts its addresses.
    (a === 100 && b >= 64 && b <= 127);
}
