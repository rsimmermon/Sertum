import type { ResumableSession, SessionStatus } from '../../shared/types';
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
  /** Unix seconds, as `thread/list` reports it -- not epoch ms. */
  updatedAt?: number;
  /** Set for an AgentControl sub-agent thread, never a user session. */
  parentThreadId?: string | null;
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

/**
 * A `thread/list` row as a past session the resume dialog can show and act
 * on -- the same class of source as everywhere else Codex's own record is
 * read, never a live pid. Sub-agent and title-generation threads are
 * filtered out exactly like `isUserThread` already excludes them elsewhere.
 */
export function resumableThread(thread: CodexThread): ResumableSession | null {
  if (!isUserThread(thread) || thread.parentThreadId || !thread.cwd) return null;
  return {
    agent: 'codex',
    externalId: thread.id,
    cwd: thread.cwd,
    preview: threadSummary(thread),
    updatedAt: typeof thread.updatedAt === 'number' ? thread.updatedAt * 1000 : null,
    name: typeof thread.name === 'string' && thread.name.trim() ? thread.name.trim() : null,
  };
}
