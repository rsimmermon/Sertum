import type { SessionStatus } from '../../shared/types';
import type { StatusUpdate } from './claude';

/** The `status` object carried by thread/started and thread/status/changed. */
export interface CodexThreadStatus {
  type: 'idle' | 'active' | 'systemError' | 'notLoaded';
  activeFlags?: string[];
}

export interface CodexThread {
  id: string;
  cwd?: string;
  ephemeral?: boolean;
  threadSource?: string;
  source?: unknown;
  name?: string | null;
  preview?: string;
  status?: CodexThreadStatus;
  updatedAt?: number;
}

/**
 * Whether a started thread is a real user session worth binding to a pane.
 *
 * Codex opens a second, throwaway thread alongside each session to generate
 * the conversation title, and it reports the same cwd as the real one. Binding
 * by cwd alone would attach the pane to whichever arrived first — the same
 * class of bug as showing another session's context. These two fields separate
 * them exactly, so no guessing is needed.
 */
export function isUserThread(thread: CodexThread): boolean {
  return thread.ephemeral !== true && thread.threadSource !== 'system';
}

/**
 * Maps a Codex thread status onto the app's status vocabulary.
 *
 * Codex is more forthcoming than Claude here: "waiting on you" is a first-class
 * flag on the status itself rather than something inferred from a notification
 * matcher, so needs-input is reported rather than deduced.
 */
export function mapCodexStatus(status: CodexThreadStatus | undefined): StatusUpdate {
  if (!status) return {};

  switch (status.type) {
    case 'active': {
      const flags = status.activeFlags ?? [];
      if (flags.includes('waitingOnApproval')) {
        return { status: 'needs-input', activity: 'approval needed' };
      }
      if (flags.includes('waitingOnUserInput')) {
        return { status: 'needs-input', activity: 'waiting for you' };
      }
      return { status: 'working', activity: 'working' };
    }

    case 'idle':
      return { status: 'idle', activity: 'turn finished' };

    case 'systemError':
      return { status: 'attention', activity: 'session error' };

    // notLoaded is a resting state for threads on disk, not a live session.
    default:
      return {};
  }
}

/** Status for a thread listed by thread/list, used by the adopt dialog. */
export function discoveredStatus(thread: CodexThread): SessionStatus {
  return mapCodexStatus(thread.status).status ?? 'idle';
}

/**
 * A one-line summary for the session list. Codex names threads itself a beat
 * after the first turn, which is a better label than the raw prompt, so prefer
 * it and fall back to the preview until it arrives.
 */
export function threadSummary(thread: CodexThread): string | null {
  const name = typeof thread.name === 'string' ? thread.name.trim() : '';
  if (name) return name.slice(0, 120);
  const preview = (thread.preview ?? '').trim().replace(/\s+/g, ' ');
  return preview ? preview.slice(0, 120) : null;
}
