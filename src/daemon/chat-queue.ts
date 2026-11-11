import type {
  ChatAttachment,
  ChatSubmitResult,
  QueuedChatMessage,
  SessionSnapshot,
} from '../shared/types';

/**
 * How long a delivered message may wait to be seen starting a turn before the
 * next one goes anyway.
 *
 * A stream host reports `working` on the write itself, but a PTY-backed agent
 * says nothing until its own hook or log catches up, and until then the session
 * still reads as free. This only matters if the report never comes, so it is
 * long enough not to race one that is merely slow.
 */
export const TURN_START_GRACE_MS = 5000;

/**
 * A refusal can be momentary. Codex announces `thread/status/changed` before
 * `turn/completed`, so for a moment a session reads idle while its host still
 * refuses. These retries cover about 15 seconds and then stop, since a failed
 * Codex send reports an error each time and each one can raise a notification.
 */
export const RETRY_BASE_MS = 500;
export const MAX_ATTEMPTS = 5;

export interface ChatQueueHost {
  session(id: string): SessionSnapshot | undefined;
  /** Puts one message in. Resolves null on success, otherwise why it did not go. */
  deliver(session: SessionSnapshot, text: string, attachments: ChatAttachment[]): Promise<string | null>;
  /**
   * Puts one message into the turn already running, the way the agent's own
   * composer does when typed into mid-turn. False when this session cannot, or
   * the turn ended first; the message is then queued for the next boundary.
   */
  steer(session: SessionSnapshot, text: string, attachments: ChatAttachment[]): Promise<boolean>;
  /** What every client should now show for this session's queue. */
  publish(id: string, queue: QueuedChatMessage[], stalled: string | null): void;
  /** Told once per message that went in, whichever client wrote it. */
  delivered(id: string, message: QueuedChatMessage, stillQueued: number): void;
}

interface SessionQueue {
  entries: QueuedChatMessage[];
  /** A delivery is in flight; nothing else may start. */
  delivering: boolean;
  /** Delivered, and no report yet of that turn starting. */
  awaitingTurn: boolean;
  /** Why the head of the queue did not go, once it has failed more than once. */
  stalled: string | null;
  /** Failed attempts at the head of the queue since it last had a clean start. */
  failures: number;
  retry: ReturnType<typeof setTimeout> | null;
  wasActive: boolean;
  grace: ReturnType<typeof setTimeout> | null;
}

/**
 * Messages a session cannot take yet, held where every client can see them.
 *
 * This lives in the daemon because a queue in a window dies with that window and
 * cannot be seen from a phone. A message sent mid-turn is first offered to the
 * running turn (`steer`); only one that cannot join it waits here. One message
 * goes in per turn boundary, since delivering starts a turn. Receivable comes from the truth plane, `turnActive`,
 * never from output going quiet.
 */
export class ChatQueue {
  private readonly queues = new Map<string, SessionQueue>();
  private nextId = 0;

  constructor(
    private readonly host: ChatQueueHost,
    private readonly graceMs = TURN_START_GRACE_MS,
    private readonly retryBaseMs = RETRY_BASE_MS,
  ) {}

  private queueFor(id: string): SessionQueue {
    let queue = this.queues.get(id);
    if (!queue) {
      queue = {
        entries: [],
        delivering: false,
        awaitingTurn: false,
        stalled: null,
        failures: 0,
        retry: null,
        wasActive: false,
        grace: null,
      };
      this.queues.set(id, queue);
    }
    return queue;
  }

  /**
   * Send now if the session can take it, otherwise hold it. A message nothing
   * was ahead of that fails is refused, so the writer keeps their draft; once
   * something is queued it stays queued and says why it is stuck.
   */
  async submit(
    id: string,
    text: string,
    attachments: ChatAttachment[],
  ): Promise<ChatSubmitResult> {
    const session = this.host.session(id);
    if (!session) return { outcome: 'refused', reason: 'The session no longer exists.' };
    if (session.origin === 'monitored') {
      return { outcome: 'refused', reason: 'This session’s input lives in its own terminal.' };
    }
    if (session.exitCode !== null) return { outcome: 'refused', reason: 'The session has exited.' };
    if (!text.trim() && !attachments.length) {
      return { outcome: 'refused', reason: 'There is nothing to send.' };
    }

    const queue = this.queueFor(id);
    const message: QueuedChatMessage = { id: ++this.nextId, text, attachments };
    // Mid-turn, a message joins the running turn where the agent can take it
    // there. Never past anything already queued, which would reorder them.
    if (session.turnActive && !this.blocked(queue) && !queue.entries.length) {
      if (await this.steerOne(id, queue, session, message)) return { outcome: 'sent' };
    }
    if (this.blocked(queue) || this.host.session(id)?.turnActive || queue.entries.length) {
      queue.entries.push(message);
      this.startOver(queue);
      this.publish(id, queue);
      void this.pump(id);
      return { outcome: 'queued', position: queue.entries.length };
    }
    const failed = await this.deliverOne(id, queue, session, message);
    return failed ? { outcome: 'refused', reason: failed } : { outcome: 'sent' };
  }

  /**
   * `delivering` is held for the call so a second submit, or the pump, cannot
   * slip a message in ahead of this one.
   */
  private async steerOne(
    id: string,
    queue: SessionQueue,
    session: SessionSnapshot,
    message: QueuedChatMessage,
  ): Promise<boolean> {
    queue.delivering = true;
    let taken = false;
    try {
      taken = await this.host.steer(session, message.text, message.attachments);
    } catch {
      taken = false;
    }
    queue.delivering = false;
    if (taken) this.host.delivered(id, message, queue.entries.length);
    return taken;
  }

  /** False when it is already going in, or gone. */
  remove(id: string, messageId: number): boolean {
    const queue = this.queues.get(id);
    if (!queue) return false;
    const at = queue.entries.findIndex((entry) => entry.id === messageId);
    if (at < 0 || (at === 0 && queue.delivering)) return false;
    queue.entries.splice(at, 1);
    if (at === 0) this.startOver(queue);
    this.publish(id, queue);
    void this.pump(id);
    return true;
  }

  /** Every snapshot passes through here; this is how a turn's end is heard. */
  sessionChanged(session: SessionSnapshot): void {
    const queue = this.queues.get(session.id);
    if (!queue) return;
    const active = session.turnActive;
    if (active) this.turnStarted(queue);
    // A failing send can itself report working and then an error, which is not
    // a turn ending. Counting it would retry a dead session forever.
    if (queue.wasActive && !active && !queue.delivering && queue.failures) {
      this.startOver(queue);
      this.publish(session.id, queue);
    }
    queue.wasActive = active;
    if (session.exitCode !== null) {
      this.clearGrace(queue);
      this.clearRetry(queue);
      queue.awaitingTurn = false;
      return;
    }
    void this.pump(session.id);
  }

  /** The session is gone from the registry, so its queue goes with it. */
  forget(id: string): void {
    const queue = this.queues.get(id);
    if (queue) {
      this.clearGrace(queue);
      this.clearRetry(queue);
    }
    this.queues.delete(id);
  }

  private startOver(queue: SessionQueue): void {
    queue.failures = 0;
    queue.stalled = null;
    this.clearRetry(queue);
  }

  private clearRetry(queue: SessionQueue): void {
    if (queue.retry !== null) clearTimeout(queue.retry);
    queue.retry = null;
  }

  private blocked(queue: SessionQueue): boolean {
    return queue.delivering || queue.awaitingTurn;
  }

  private turnStarted(queue: SessionQueue): void {
    queue.awaitingTurn = false;
    this.clearGrace(queue);
  }

  private clearGrace(queue: SessionQueue): void {
    if (queue.grace !== null) clearTimeout(queue.grace);
    queue.grace = null;
  }

  private async pump(id: string): Promise<void> {
    const queue = this.queues.get(id);
    const session = this.host.session(id);
    const next = queue?.entries[0];
    if (!queue || !session || !next || this.blocked(queue)) return;
    if (queue.retry !== null || queue.failures >= MAX_ATTEMPTS) return;
    if (session.turnActive || session.exitCode !== null || session.origin === 'monitored') return;
    const failed = await this.deliverOne(id, queue, session, next);
    if (this.queues.get(id) !== queue) return;
    if (!failed) {
      if (queue.failures) {
        this.startOver(queue);
        this.publish(id, queue);
      }
      return;
    }
    queue.failures += 1;
    // One refusal is usually the moment described above, and not worth a word.
    if (queue.failures > 1) {
      queue.stalled = failed;
      this.publish(id, queue);
    }
    if (queue.failures < MAX_ATTEMPTS) {
      queue.retry = setTimeout(() => {
        queue.retry = null;
        void this.pump(id);
      }, this.retryBaseMs * 2 ** (queue.failures - 1));
    }
  }

  /**
   * `awaitingTurn` is set before the write because a stream host reports its
   * turn during the write, which is what clears it again.
   */
  private async deliverOne(
    id: string,
    queue: SessionQueue,
    session: SessionSnapshot,
    message: QueuedChatMessage,
  ): Promise<string | null> {
    queue.delivering = true;
    queue.awaitingTurn = true;
    let failed: string | null;
    try {
      failed = await this.host.deliver(session, message.text, message.attachments);
    } catch (error) {
      failed = String(error);
    }
    queue.delivering = false;
    if (failed) {
      queue.awaitingTurn = false;
      return failed;
    }

    const at = queue.entries.findIndex((entry) => entry.id === message.id);
    if (at >= 0) {
      queue.entries.splice(at, 1);
      this.publish(id, queue);
    }
    this.host.delivered(id, message, queue.entries.length);
    if (queue.awaitingTurn) {
      queue.grace = setTimeout(() => {
        queue.grace = null;
        queue.awaitingTurn = false;
        void this.pump(id);
      }, this.graceMs);
    }
    return null;
  }

  private publish(id: string, queue: SessionQueue): void {
    this.host.publish(id, queue.entries.map((entry) => ({ ...entry })), queue.stalled);
  }
}
