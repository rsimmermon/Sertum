import { app, BrowserWindow, Notification } from 'electron';
import type { SessionSnapshot, SessionStatus, Settings } from '../shared/types';

/**
 * System notifications — wireframe C20 (frame gRhjg), configured by E5
 * (frame ZMHK6).
 *
 * This is the payoff of the truth plane rather than a new source of it. A
 * notification fires because an adapter said the agent is waiting, never
 * because output went quiet, so it can be exact enough to interrupt someone
 * — which is the only thing that makes narrow defaults defensible.
 *
 * Three rules keep it from crying wolf:
 *
 *   - **Only transitions.** A session already sitting in `needs-input` that
 *     updates for any other reason does not notify again.
 *   - **Only when you are not looking.** With the window focused, the sidebar
 *     dot has already told you.
 *   - **Only states that are actually blocked on you**, unless E5 is told
 *     otherwise. `working` never notifies.
 */
export class Notifier {
  private readonly lastStatus = new Map<string, SessionStatus>();
  private readonly snoozedUntil = new Map<string, number>();
  private readonly muted = new Set<string>();
  private readonly turnTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly window: () => BrowserWindow | null,
    private readonly settings: () => Settings,
  ) {}

  /**
   * Called for every session update. Decides whether this one crossed into a
   * state worth interrupting for.
   */
  update(snapshot: SessionSnapshot): void {
    const previous = this.lastStatus.get(snapshot.id);
    this.lastStatus.set(snapshot.id, snapshot.status);
    if (previous === snapshot.status) return;

    this.trackLongTurn(snapshot, previous);

    const settings = this.settings();
    const wanted =
      (snapshot.status === 'needs-input' && settings.notifyNeedsInput) ||
      (snapshot.status === 'attention' && settings.notifyFailed) ||
      (snapshot.status === 'done' && settings.notifyFinished);
    if (!wanted) return;

    this.fire(snapshot, headline(snapshot));
  }

  /** True when this session is muted, for the snapshot the renderer reads. */
  isMuted(id: string): boolean {
    return this.muted.has(id);
  }

  setMuted(id: string, muted: boolean): void {
    if (muted) this.muted.add(id);
    else this.muted.delete(id);
  }

  /** C20 note 152: quiet for a while, without changing the session's status. */
  snooze(id: string, minutes: number): void {
    this.snoozedUntil.set(id, Date.now() + minutes * 60_000);
  }

  /**
   * A session's process ended. Its mute was "until it finishes" (E5), and a
   * pending long-turn timer must not outlive the turn it was measuring.
   */
  forget(id: string): void {
    this.muted.delete(id);
    this.snoozedUntil.delete(id);
    this.lastStatus.delete(id);
    const timer = this.turnTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.turnTimers.delete(id);
    }
  }

  /**
   * Unread count on the app icon.
   *
   * `setBadgeCount` is macOS and Linux only; on Windows it returns false and
   * changes nothing, which is why E5 says so rather than offering a switch
   * that appears to work.
   */
  updateBadge(needsInput: number): void {
    if (!this.settings().notifyBadge) {
      app.setBadgeCount(0);
      return;
    }
    app.setBadgeCount(needsInput);
  }

  /**
   * A turn that has run long enough to be worth mentioning (E5). The timer is
   * started when the session enters `working` and cleared when it leaves, so
   * it fires at most once per turn by construction rather than by bookkeeping.
   */
  private trackLongTurn(
    snapshot: SessionSnapshot,
    previous: SessionStatus | undefined,
  ): void {
    const existing = this.turnTimers.get(snapshot.id);
    if (existing) {
      clearTimeout(existing);
      this.turnTimers.delete(snapshot.id);
    }
    if (snapshot.status !== 'working' || previous === 'working') return;

    const minutes = this.settings().notifyLongTurnMinutes;
    if (minutes <= 0) return;

    const timer = setTimeout(() => {
      this.turnTimers.delete(snapshot.id);
      this.fire(snapshot, `${snapshot.label} has been working for ${minutes} minutes`);
    }, minutes * 60_000);
    // A pending notification is not a reason to hold the app open at quit.
    timer.unref?.();
    this.turnTimers.set(snapshot.id, timer);
  }

  private fire(snapshot: SessionSnapshot, title: string): void {
    if (!Notification.isSupported()) return;
    if (this.muted.has(snapshot.id)) return;

    const until = this.snoozedUntil.get(snapshot.id);
    if (until !== undefined) {
      if (until > Date.now()) return;
      this.snoozedUntil.delete(snapshot.id);
    }

    const window = this.window();
    if (this.settings().notifyOnlyWhenUnfocused && window?.isFocused()) return;

    const notification = new Notification({
      title,
      body: snapshot.activity ?? '',
      silent: !this.settings().notifySound,
    });

    // C20 note 150: the body takes you to the session it is about.
    notification.on('click', () => {
      const target = this.window();
      if (!target || target.isDestroyed()) return;
      if (target.isMinimized()) target.restore();
      target.show();
      target.focus();
      target.webContents.send('session:reveal', snapshot.id);
    });
    notification.show();
  }
}

function headline(snapshot: SessionSnapshot): string {
  switch (snapshot.status) {
    case 'needs-input':
      return `${snapshot.label} needs input`;
    case 'attention':
      return `${snapshot.label} failed`;
    default:
      return `${snapshot.label} finished`;
  }
}
