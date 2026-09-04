import os from 'node:os';
import path from 'node:path';

/**
 * The wire contract between the Sertum GUI and its independent session broker.
 *
 * The daemon owns the session fabric; the GUI is a disposable client. The
 * transport is a named pipe on Windows and a unix socket elsewhere, carrying
 * newline-delimited JSON frames. Both are filesystem-scoped to the user, so
 * the OS answers "who may connect" and no token scheme is invented here.
 *
 * The version handshake exists from day one because version skew is not a
 * corner case in this design: a GUI update will routinely find a daemon
 * still running the previous build. The first frame each side sends is
 * `hello`; a protocol mismatch is answered with an error and a closed
 * socket, never with a best-effort conversation.
 */

/** Bumped on any incompatible change to methods, params or events. */
export const DAEMON_PROTOCOL = 1;

export type DaemonFrame =
  | { t: 'hello'; protocol: number; version: string }
  | { t: 'req'; id: number; method: string; params?: unknown }
  | { t: 'res'; id: number; ok: true; result: unknown }
  | { t: 'res'; id: number; ok: false; error: string }
  | { t: 'event'; name: string; payload: unknown };

/** Where the daemon records how to reach it, and its own identity. */
export interface DaemonState {
  protocol: number;
  version: string;
  pid: number;
  /** Pipe name on win32, socket path elsewhere. */
  endpoint: string;
  startedAt: number;
}

export function sertumHome(): string {
  return path.join(os.homedir(), '.sertum');
}

export function daemonStateFile(): string {
  return path.join(sertumHome(), 'daemon.json');
}

export function daemonLogFile(): string {
  return path.join(sertumHome(), 'sertumd.log');
}

/**
 * The endpoint is derived, not stored config: one daemon per user per
 * machine. The username lands in the pipe name because the Windows pipe
 * namespace is machine-wide.
 */
export function daemonEndpoint(): string {
  if (process.platform === 'win32') {
    const user = (os.userInfo().username || 'user').replace(/[^\w-]/g, '_');
    return `\\\\.\\pipe\\sertumd-${user}`;
  }
  return path.join(sertumHome(), 'sertumd.sock');
}
