import { hasStructuredTransport } from '../shared/session-capabilities';
import type {
  AgentCapabilities,
  AgentKind,
  CapabilityAnswer,
  ChatAttachment,
  ChatDeliveredEvent,
  ChatItem,
  ChatSubmitResult,
  ClipboardPaste,
  ConversationDelta,
  ConversationRead,
  ConversationSnapshot,
  PendingApproval,
  PermissionMode,
  QueuedChatMessage,
  SessionSnapshot,
  ConversationItemRead,
} from '../shared/types';
import {
  MAX_CHAT_ATTACHMENTS,
  promptWithAttachments,
} from '../shared/chat-attachments';
import { ApprovalBar } from './approval-bar';
import {
  effortAvailability,
  effortLabel,
  openEffortPicker,
} from './effort-picker';
import {
  modelAvailability,
  modelLabel,
  openModelPicker,
} from './model-picker';
import {
  openPermissionModePicker,
  permissionModeAvailability,
  permissionModeLabel,
} from './permission-mode';
import { appendMessageText } from './message-text';

const api = window.sertum;

/**
 * The most items a pane keeps in the DOM. Measured on a Galaxy Z Fold6 at 4x
 * throttle, a window this size opens in about 640ms and still scrolls at the
 * display's full rate, where 20,000 items scrolled at 117ms a frame. Everything
 * beyond it stays in the daemon and is paged back in as the reader nears an edge.
 */
const WINDOW_ITEMS = 1000;

/** How far past that size the window goes before it is trimmed back. */
const TRIM_BATCH = 50;

/** How near an edge of the window, in pixels, the next page is fetched. */
const PAGE_AHEAD_PX = 1500;

/**
 * A session rendered as a conversation instead of a terminal.
 *
 * Everything shown here is read from the agent's own transcript through
 * `conversation:read`; nothing is inferred from terminal output. Input goes to
 * the daemon, which sends it by the session's transport or queues it. For a
 * PTY-backed agent the terminal keeps running underneath as an implementation
 * detail; only Shell exposes a terminal as its product UI.
 *
 * The daemon says when the transcript moves, and the pane then asks what did.
 * The transcript lags the pixels by design — it is written when the agent
 * records a message, not as characters stream — so a sent message is
 * acknowledged under the composer until it shows up for real.
 */
const POLL_MS = 1000;

/** How long a pane goes on the daemon's word alone before asking anyway. */
const BACKSTOP_READ_MS = 5000;

/**
 * How long a note that reports something *done* stays under the composer.
 *
 * Long enough to be read after a click that was looking somewhere else, short
 * enough that it does not become part of the furniture. A note about
 * something that did *not* happen has no timer at all -- see `say`.
 */
const NOTE_FADE_MS = 6000;

interface SentAttachmentMessage extends QueuedChatMessage {
  /** Last visible user record at send time; the new record must follow it. */
  afterUserKey: string | null;
  /** Identity remembered once the transcript has acknowledged this send. */
  transcriptKey?: string;
}

export class ChatPane {
  readonly element: HTMLDivElement;
  private scroll: HTMLDivElement;
  private input: HTMLTextAreaElement;
  private action: HTMLButtonElement;
  private attachButton: HTMLButtonElement;
  private attachmentList: HTMLDivElement;
  private attachments: ChatAttachment[] = [];
  /** Which of the two things the one composer button currently does. */
  private mode: 'send' | 'stop' = 'send';
  private composerNote: HTMLDivElement;
  /** Pending clear for a note that says something already happened. */
  private noteTimer: number | null = null;
  /**
   * The permission-mode button, beside the box you type into.
   *
   * This is the setting that decides how much of the session you are asked
   * about, so it sits where the asking happens rather than several menus
   * away -- which is also where Claude Code itself keeps it. It shows the
   * mode the agent reported, never a guess.
   */
  private modeButton: HTMLButtonElement;
  /**
   * Which model this session runs, beside the mode button.
   *
   * The two settings that decide how a turn goes -- what it runs on and how
   * much it asks -- sit together at the point the turn is composed, which is
   * also where both agents keep their own equivalents.
   */
  private modelButton: HTMLButtonElement;
  /**
   * How hard this session thinks, beside the model it thinks with.
   *
   * The third chip of the row rather than a fourth thing somewhere else: the
   * settings that shape a turn belong together at the point the turn is
   * composed, and this one is read off the same catalogue the model came
   * from.
   */
  private effortButton: HTMLButtonElement;
  private waiting: HTMLDivElement;
  private waitingLabel: HTMLSpanElement;
  /**
   * Subagents still working, kept apart from the waiting bubble: that one
   * says the conversation is mid-turn and cannot take a message, and a
   * background agent running after the turn ended says neither.
   */
  private subagentLine: HTMLDivElement;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly stopChangeEvents: () => void;
  /** A change arrived that could not be read or drawn at the time. */
  private readAgain = false;
  private lastRead = 0;
  /** The transcript version this pane has drawn; handed to every poll. */
  private version: string | null = null;
  /** Rendered nodes, parallel to `snapshot.items`, which is the window held. */
  private nodes: HTMLElement[] = [];
  /** Which node a sent attachment's preview was added to. */
  private readonly decorated = new WeakMap<SentAttachmentMessage, HTMLElement>();
  /** One conversation request at a time, so a reply always fits the window. */
  private fetching = false;
  /** The ids drawn in `queuedMessages`, to tell when the daemon's queue moved. */
  private paintedQueue = '';
  /** The visible, removable queued-message group in the conversation. */
  private queuedMessages: HTMLDivElement;
  private readonly stopDeliveryEvents: () => void;
  /** Attachment messages sent by this pane, retained for transcript previews. */
  private sentAttachmentMessages: SentAttachmentMessage[] = [];
  /** Sent messages not recorded by the transcript yet. */
  private pendingSentMessages: HTMLDivElement;
  /** The last snapshot drawn, used to reconcile a just-sent attachment. */
  private snapshot: ConversationSnapshot | null = null;
  private session: SessionSnapshot;
  private attached = false;
  /**
   * Where the reader was, tracked continuously rather than read off the DOM
   * at the moment it matters -- because the moment it matters is exactly
   * when the DOM cannot be trusted. Switching tabs detaches this pane's
   * element (`pane-grid.ts` moves `body` between cells by removing and
   * reinserting it), and a scroller with no box reports `scrollTop` as zero
   * as long as it is out of the document, per the CSSOM View spec. Reading
   * "where is the scrollbar" right after reattaching therefore always
   * answers "at the top", regardless of where it actually was -- which is
   * this bug. These two fields are this pane's own memory of that fact,
   * updated on every scroll and restored the instant `attach()` puts the
   * element back, before the poll's first render can even land.
   */
  private pinnedToBottom = true;
  private savedScrollTop = 0;
  /**
   * What the reader is looking at, since a pixel offset stops meaning anything
   * once text rewraps: unfolding a phone took a view of messages 1884-1895 to
   * 1911-1914. It has to be noted before a resize, because by the time the
   * observer hears of one the old geometry is gone.
   */
  private readingPlace: { node: HTMLElement; through: number; gap: number } | null = null;
  /** The width `readingPlace` was measured at. Zero until first laid out. */
  private readingWidth = 0;
  private readonly resizes: ResizeObserver;
  /**
   * Messages the reader has switched between rendered and source, by a key
   * that survives the window moving past the message and back. Classification picks the opening position; this is
   * what stops that guess from being the last word.
   */
  private readonly chosenRaw = new Map<string, boolean>();
  private readonly controls: ItemControls = {
    expand: (item) => this.expandItem(item),
    raw: (item) => this.chosenRaw.get(formatKey(item)) ?? item.format === 'markdown-source',
    toggle: (item) => {
      const key = formatKey(item);
      const now = this.chosenRaw.get(key) ?? item.format === 'markdown-source';
      this.chosenRaw.set(key, !now);
    },
  };

  /**
   * B5, mounted between the transcript and the composer.
   *
   * A held tool call is part of the turn being read, and the answer to it
   * belongs where every other reply to this agent is typed. The app owns the
   * queue and hands down the calls for this session; the bar only draws and
   * answers them.
   */
  private readonly approvals: ApprovalBar;

  constructor(
    session: SessionSnapshot,
    private interruptCapability: CapabilityAnswer,
    onApprovalAnswered: (id: string) => void,
    private capabilities: Record<AgentKind, AgentCapabilities> | null = null,
  ) {
    this.session = session;
    this.approvals = new ApprovalBar(onApprovalAnswered, () => this.session.cwd);
    this.element = document.createElement('div');
    this.element.className = 'chat-pane';

    this.scroll = document.createElement('div');
    this.scroll.className = 'chat-scroll';
    // Live tracking, not a snapshot taken when the tab switches away -- by
    // then the element may already be mid-detach and its own scrollTop
    // unreliable. This fires for both the reader's own scrolling and this
    // pane's programmatic scrollToTail()/restore, which is fine: either way
    // it is where the scrollbar now sits.
    this.scroll.addEventListener('scroll', () => {
      // A scroll landing between a width change and its observer would record
      // the new geometry as the place to restore. The observer handles it.
      if (this.scroll.clientWidth !== this.readingWidth) return;
      this.savedScrollTop = this.scroll.scrollTop;
      this.pinnedToBottom = this.isNearBottom();
      this.noteReadingPlace();
      void this.loadMoreIfNeeded();
    });
    this.resizes = new ResizeObserver(() => this.onResized());
    this.resizes.observe(this.scroll);

    const composer = document.createElement('div');
    composer.className = 'chat-composer';

    this.input = document.createElement('textarea');
    this.input.className = 'chat-input';
    this.input.rows = 2;
    this.input.spellcheck = false;
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        this.submit();
      }
    });
    // The browser cannot turn clipboard bitmap bytes into a durable agent
    // input. Main spills them to disk, then this draft treats that path like
    // one chosen through the attachment button. Plain text is inserted back
    // at the selection so the platform paste keeps ordinary textarea rules.
    this.input.addEventListener('paste', (event) => {
      event.preventDefault();
      void this.pasteClipboard();
    });

    // One button at the right edge of the box you type into, carrying
    // whichever of the two things you can currently do. Typing is the signal:
    // text in the composer means you are about to send, an empty composer
    // during a turn means the only thing left to do is stop it. They cannot
    // both apply, so two buttons would always leave one of them dead.
    this.action = document.createElement('button');
    this.action.className = 'chat-action';
    this.action.type = 'button';
    const sign = document.createElement('span');
    sign.className = 'chat-stop-sign';
    this.action.append(sign, sendArrow());
    this.action.onclick = () => {
      if (this.mode === 'stop') void this.stop();
      else this.submit();
    };

    this.attachButton = document.createElement('button');
    this.attachButton.type = 'button';
    this.attachButton.className = 'chat-attach';
    this.attachButton.append(attachmentIcon());
    this.attachButton.title = 'Add attachments';
    this.attachButton.setAttribute('aria-label', 'Add attachments');
    this.attachButton.onclick = () => void this.pickAttachments();
    // The mode follows the composer, so it flips on the first keystroke and
    // back on the last backspace.
    this.input.addEventListener('input', () => {
      this.paintAction();
    });

    this.composerNote = document.createElement('div');
    this.composerNote.className = 'chat-sent';
    this.composerNote.hidden = true;

    this.modeButton = document.createElement('button');
    this.modeButton.type = 'button';
    this.modeButton.className = 'chat-mode';
    this.modeButton.onclick = (e) => {
      const box = this.modeButton.getBoundingClientRect();
      openPermissionModePicker(
        box.left,
        box.bottom + 4,
        this.session,
        this.capabilities,
        (mode) => {
          // Setting a chip is not leaving the composer. The menu hands focus
          // back to the button that opened it, which is right for a menu and
          // wrong here: what someone does after choosing how a turn runs is
          // type the turn.
          this.focus();
          void this.setMode(mode);
        },
      );
      e.stopPropagation();
    };

    this.modelButton = document.createElement('button');
    this.modelButton.type = 'button';
    this.modelButton.className = 'chat-mode chat-model';
    this.modelButton.onclick = (e) => {
      const rect = this.modelButton.getBoundingClientRect();
      void openModelPicker(
        rect.left,
        rect.bottom + 4,
        this.session,
        this.capabilities,
        (model) => {
          this.focus();
          void this.setModel(model);
        },
      );
      e.stopPropagation();
    };

    this.effortButton = document.createElement('button');
    this.effortButton.type = 'button';
    this.effortButton.className = 'chat-mode chat-effort';
    this.effortButton.onclick = (e) => {
      const rect = this.effortButton.getBoundingClientRect();
      void openEffortPicker(
        rect.left,
        rect.bottom + 4,
        this.session,
        this.capabilities,
        (effort) => {
          this.focus();
          void this.setEffort(effort);
        },
      );
      e.stopPropagation();
    };

    const box = document.createElement('div');
    box.className = 'chat-input-box';
    box.append(this.input, this.action);

    const row = document.createElement('div');
    row.className = 'chat-composer-row';
    row.append(this.attachButton, box);

    this.attachmentList = document.createElement('div');
    this.attachmentList.className = 'chat-attachments';
    this.attachmentList.hidden = true;

    const meta = document.createElement('div');
    meta.className = 'chat-composer-meta';
    meta.append(this.modeButton, this.modelButton, this.effortButton, this.composerNote);
    // B3 composer: attachments stay visibly part of the unsent turn, above
    // the same input box and one send/stop control the frame already owns.
    composer.append(this.attachmentList, row, meta);

    this.waiting = document.createElement('div');
    this.waiting.className = 'chat-item chat-assistant chat-waiting';
    this.waiting.hidden = true;
    const dots = document.createElement('span');
    dots.className = 'chat-dots';
    dots.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 3; i += 1) dots.append(document.createElement('i'));
    this.waitingLabel = document.createElement('span');
    this.waitingLabel.className = 'chat-waiting-label';
    this.waiting.append(dots, this.waitingLabel);

    this.subagentLine = document.createElement('div');
    this.subagentLine.className = 'chat-subagents';
    this.subagentLine.hidden = true;
    this.subagentLine.setAttribute('role', 'status');

    this.queuedMessages = document.createElement('div');
    this.queuedMessages.className = 'chat-queued-messages';

    this.pendingSentMessages = document.createElement('div');
    this.pendingSentMessages.className = 'chat-sent-attachment-messages';

    this.element.append(this.scroll, this.approvals.element, composer);
    this.stopDeliveryEvents = api.onChatDelivered((event) => this.onDelivered(event));
    this.stopChangeEvents = api.onConversationChanged((event) => {
      if (event.id === this.session.id) this.onConversationChanged();
    });
    this.applySession(session);
  }

  /** The freshest snapshot, so the composer tracks the process's life. */
  update(session: SessionSnapshot): void {
    this.session = session;
    this.applySession(session);
  }

  /**
   * Re-reads the adapter answers this pane draws its controls from.
   *
   * They were a constructor argument alone, on the reasoning that capabilities
   * are fixed for the app's life -- true of the answers, not of whether this
   * window has them yet. A stream session's pane is built from its snapshot
   * without consulting them, so it can exist first, and a pane keeping the
   * copy it was born with would draw every chip disabled reading "Agent
   * capabilities are still loading" for as long as the window lived. The app
   * restates them on every render instead, so the pane converges on the real
   * answers whenever they arrive.
   */
  setCapabilities(
    capabilities: Record<AgentKind, AgentCapabilities> | null,
    interruptCapability: CapabilityAnswer,
  ): void {
    if (this.capabilities === capabilities) return;
    this.capabilities = capabilities;
    this.interruptCapability = interruptCapability;
    this.applySession(this.session);
  }

  /** The calls this session is holding open, oldest first. */
  setApprovals(requests: PendingApproval[]): void {
    this.approvals.setRequests(requests);
  }

  /** Start polling. Safe to call repeatedly, like TerminalPane.attach. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    // The pane grid already reattached `element` to the document by now --
    // see the class comment on `pinnedToBottom` -- which handed it a fresh
    // scroll box sitting at zero. Restore the reader's actual position
    // before the poll gets a chance to run, so coming back to a tab never
    // shows a flash of the top of the transcript. The content itself is
    // untouched by unmount(), so the old scrollHeight this restores against
    // is exactly the one the position was recorded from.
    if (this.pinnedToBottom) this.scrollToTail();
    else this.scroll.scrollTop = this.savedScrollTop;
    void this.refresh();
    this.timer = setInterval(() => this.onTick(), POLL_MS);
  }

  /**
   * The daemon says when a transcript moves, so a pane does not have to ask. It
   * still asks when it has nothing yet, when a change could not be drawn at the
   * time, and now and then regardless, which covers a session whose transcript the
   * daemon has not found yet, a final record written as it exited, and a reconnect.
   */
  private onTick(): void {
    if (!this.version || this.readAgain || Date.now() - this.lastRead >= BACKSTOP_READ_MS) {
      void this.refresh();
    }
  }

  private onConversationChanged(): void {
    if (!this.attached) return;
    if (this.fetching) this.readAgain = true;
    else void this.refresh();
  }

  /** Leave the DOM and stop polling; the conversation is on disk, not here. */
  unmount(): void {
    // Capture once more right before detaching, on top of the live scroll
    // listener, since this is the last moment the values are certainly
    // fresh.
    this.savedScrollTop = this.scroll.scrollTop;
    this.pinnedToBottom = this.isNearBottom();
    this.element.remove();
    this.attached = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  focus(): void {
    if (!this.input.disabled) this.input.focus();
  }

  dispose(): void {
    this.hushNote();
    this.resizes.disconnect();
    this.stopDeliveryEvents();
    this.stopChangeEvents();
    this.unmount();
  }

  /**
   * Whether this pane can put input into the session at all: it must be an
   * owned live transport, structured or PTY-backed.
   */
  private canWrite(s: SessionSnapshot): boolean {
    return s.origin !== 'monitored' && s.exitCode === null;
  }

  /**
   * Whether a message put in now would be taken.
   *
   * Read from the truth plane, never from whether the composer feels idle: a
   * turn in progress is what refuses a message, and `working`/`needs-input`
   * is the adapter's own word for that. A session waiting on an approval is
   * as unable to take a prompt as one mid-answer, so both queue.
   *
   * It is the *main thread's* turn that refuses, which is `turnActive`
   * rather than `status`: a subagent still running, or asking, after the
   * turn ended leaves the conversation free to take the next prompt.
   */
  private receivable(): boolean {
    const s = this.session;
    return this.canWrite(s) && !s.turnActive;
  }

  /** What the daemon is holding for this session. Its copy is the only one. */
  private get queue(): QueuedChatMessage[] {
    return this.session.messageQueue;
  }

  private applySession(s: SessionSnapshot): void {
    const writable = this.canWrite(s);
    this.input.disabled = !writable;
    this.attachButton.disabled = !writable;
    this.attachButton.title = writable
      ? 'Add attachments'
      : 'This session cannot take attachments here.';
    this.attachButton.setAttribute('aria-label', this.attachButton.title);
    this.paintAction();
    const queueKey = s.messageQueue.map((entry) => entry.id).join();
    if (queueKey !== this.paintedQueue) this.paintQueuedMessages();
    this.paintMode(s);
    this.paintModel(s);
    this.paintEffort(s);
    this.paintWaiting(s);
  }

  /**
   * What the empty composer says, which is where a waiting queue lives.
   *
   * The note under the composer cannot hold it: `refresh` hushes the note
   * whenever the transcript moves, and a working agent moves it constantly,
   * so a "queued" line put there would be gone within the second. The
   * placeholder is a compact status summary, while the queued messages
   * themselves stay visible in the conversation. Queueing clears what you
   * typed so the composer is ready for another message.
   */
  private paintPlaceholder(): void {
    const s = this.session;
    const waiting = this.queue.length;
    const plural = waiting === 1 ? '' : 's';
    if (this.canWrite(s)) {
      this.input.placeholder = s.queueStalled
        ? `Queued message${plural} not sent: ${s.queueStalled}`
        : waiting
          ? `${waiting} message${plural} queued — click × on a message to remove it.`
          : `Message ${s.agent} — Enter sends, Shift+Enter for a new line`;
      this.input.title = '';
    } else if (s.origin === 'monitored') {
      this.input.placeholder =
        'This session’s input lives in its own terminal — jump to it to reply.';
    } else {
      // A queue that can no longer be delivered is said out loud rather than
      // dropped quietly: the messages are unreachable once the composer is
      // disabled, so the count is the last honest thing this pane can offer.
      this.input.placeholder = waiting
        ? `The session has exited — ${waiting} queued message${plural} never went in.`
        : 'The session has exited.';
    }
  }

  /**
   * The waiting bubble, shown only while plane 2 says the agent is working.
   *
   * This is the truth plane's payoff at conversation scale: the dots appear
   * because the agent reported a turn in progress, never because output went
   * quiet. Its caption is the same `activity` string the sidebar reads, so a
   * pane cannot disagree with the dot beside it.
   *
   * A `needs-input` session is deliberately not shown as waiting — it is not
   * working, it is waiting on the reader, which the status dot and the
   * approval bar already say.
   */
  /**
   * Decide what the one composer button is, and say so.
   *
   * Text in the composer always means Send — it is the thing you just did.
   * With the composer empty during a turn, stopping is the only thing left,
   * so the button becomes the stop sign. It stays a *stop* sign even when
   * the agent declines `turn-interrupt`, disabled and carrying the reason:
   * that reason is user-facing copy the adapter wrote, and hiding the button
   * would hide it. Being a sign rather than a word, the reason has to reach a
   * screen reader as well as a tooltip.
   *
   * Queued messages have their own dismiss controls in the conversation, so
   * the stop sign has one job: stop the active turn. A queue does not make the
   * sign appear on an idle session, and stopping a turn does not rewrite or
   * recall text the reader has already sent.
   */
  private paintAction(): void {
    const s = this.session;
    const writable = this.canWrite(s);
    const hasDraft = this.input.value.trim().length > 0 || this.attachments.length > 0;
    this.mode = writable && !hasDraft && s.turnActive ? 'stop' : 'send';
    const canStop = writable && s.turnActive && this.interruptCapability.ok;

    let reason: string;
    if (this.mode === 'stop') {
      this.action.disabled = !canStop;
      reason = this.interruptCapability.ok
        ? `Stop ${s.agent}’s current turn`
        : this.interruptCapability.reason;
    } else {
      this.action.disabled = !writable || !hasDraft;
      reason = !writable
        ? 'This session cannot take input here.'
        : hasDraft
          ? `Send to ${s.agent}`
          : 'Type a message or add an attachment to send.';
    }
    this.action.classList.toggle('is-stop', this.mode === 'stop');
    this.action.classList.toggle('is-send', this.mode === 'send');
    this.action.title = reason;
    this.action.setAttribute('aria-label', reason);
    this.paintPlaceholder();
  }

  /**
   * The mode button says what the agent reported, and the button is present
   * even where it cannot act -- disabled, carrying the reason, exactly as a
   * declined capability does everywhere else. Hiding it would hide the
   * reason, and "where is the mode set for this session" is precisely the
   * question a terminal-backed Claude session raises.
   */
  private paintMode(s: SessionSnapshot): void {
    const available = permissionModeAvailability(s, this.capabilities);
    const label = permissionModeLabel(s.permissionMode);
    this.modeButton.textContent = label;
    this.modeButton.disabled = !available.ok;
    const title = !available.ok
      ? available.reason
      : s.permissionMode
        ? `Permission mode: ${label} — click to change`
        : 'The agent has not named its permission mode yet — click to set one';
    this.modeButton.title = title;
    this.modeButton.setAttribute('aria-label', title);
    this.modeButton.classList.toggle('is-unset', !s.permissionMode);
  }

  /**
   * The model button says what the session reports it runs, and is present
   * even where it cannot act -- disabled, carrying the reason -- for the same
   * reason the mode button is: hiding it would hide the reason.
   */
  private paintModel(s: SessionSnapshot): void {
    const available = modelAvailability(s, this.capabilities);
    const label = modelLabel(s);
    this.modelButton.textContent = label;
    this.modelButton.disabled = !available.ok;
    // Both names when they differ: the chip is capped and elides, so the
    // tooltip is where the slug a turn will report stays legible in full.
    const named = s.modelLabel && s.model ? `${s.modelLabel} (${s.model})` : label;
    const title = !available.ok
      ? available.reason
      : s.model
        ? `Model: ${named} — click to change`
        : 'The agent has not named its model yet — click to set one';
    this.modelButton.title = title;
    this.modelButton.setAttribute('aria-label', title);
    this.modelButton.classList.toggle('is-unset', !s.model);
  }

  /**
   * The thinking chip, painted by the same rules as the model beside it:
   * present even where it cannot act, disabled and carrying the reason.
   */
  private paintEffort(s: SessionSnapshot): void {
    const available = effortAvailability(s, this.capabilities);
    const label = effortLabel(s);
    this.effortButton.textContent = label;
    this.effortButton.disabled = !available.ok;
    const title = !available.ok
      ? available.reason
      : s.effort
        ? `Thinking level: ${label} — click to change`
        : 'The agent has not named its thinking level yet — click to set one';
    this.effortButton.title = title;
    this.effortButton.setAttribute('aria-label', title);
    this.effortButton.classList.toggle('is-unset', !s.effort);
  }

  /**
   * Ask the session to change how hard it thinks, and say what it landed on.
   *
   * `setModel`'s twin, with one thing to be careful about: what comes back is
   * the level the session is actually on, which is not always the one that
   * was asked for -- an agent may downgrade a level its model cannot run. So
   * the confirmation names what the adapter read back rather than what was
   * requested, and a level that was quietly not taken at all comes back as a
   * refusal rather than as a success nobody could see through.
   */
  private async setEffort(effort: string): Promise<void> {
    const result = await api.setSessionEffort(this.session.id, effort);
    if (!result.ok) {
      this.reportEffortRefusal(result.reason);
      return;
    }
    const named = result.label ?? result.effort;
    if (result.appliesToNextTurn) {
      this.say(
        `Thinking at ${named} from the next turn. The turn already running finishes at the previous level.`,
      );
      return;
    }
    this.say(`Now thinking at ${named}.`, NOTE_FADE_MS);
  }

  /** A refused level change, said under the composer where the button is. */
  reportEffortRefusal(reason: string): void {
    this.say(`Could not change the thinking level — ${reason}`);
  }

  /**
   * Ask the session to switch models, and say plainly when it will not.
   *
   * A turn already running keeps the model it started with on every agent
   * here, so that is said rather than left to be noticed a reply later. The
   * chip itself repaints from the snapshot the daemon pushes back, never from
   * this request.
   */
  private async setModel(model: string): Promise<void> {
    const result = await api.setSessionModel(this.session.id, model);
    if (!result.ok) {
      this.reportModelRefusal(result.reason);
      return;
    }
    const named = result.label ?? result.model;
    if (result.appliesToNextTurn) {
      this.reportModelQueued(named);
      return;
    }
    this.reportModelSwitched(named);
  }

  /**
   * Put one line under the composer, and optionally take it away again.
   *
   * A refusal, or anything else the reader may need to find a second time,
   * has no timer: it is the answer to something that did not happen, and it
   * stays until the next thing replaces it. A confirmation is the opposite --
   * it has done its job the moment it is read -- so it is given `fadeAfterMs`
   * and clears itself, but only if it is still the line on screen. Anything
   * written since is newer and has not had its own time.
   */
  private say(text: string, fadeAfterMs: number | null = null): void {
    this.hushNote();
    this.composerNote.textContent = text;
    this.composerNote.hidden = false;
    if (fadeAfterMs === null) return;
    this.noteTimer = window.setTimeout(() => {
      this.noteTimer = null;
      if (this.composerNote.textContent === text) this.composerNote.hidden = true;
    }, fadeAfterMs);
  }

  /** Clear the note, and cancel any fade still owed to an earlier one. */
  private hushNote(): void {
    if (this.noteTimer !== null) {
      clearTimeout(this.noteTimer);
      this.noteTimer = null;
    }
    this.composerNote.hidden = true;
  }

  /** A refused model change, said under the composer where the button is. */
  reportModelRefusal(reason: string): void {
    this.say(`Could not change the model — ${reason}`);
  }

  /** Switched mid-turn: accepted, but the turn in flight keeps its model. */
  reportModelQueued(model: string): void {
    this.say(`Switched to ${model}. The turn already running finishes on the previous model.`);
  }

  /**
   * Switched on an idle session, which is the ordinary case and used to be
   * the silent one.
   *
   * `appliesToNextTurn` is false here, so the note above never fired, and the
   * only remaining evidence was the chip -- which shows a slug the reader
   * never saw, truncates, and on a brand-new session may not have moved at
   * all. Doing something and saying nothing reads as doing nothing.
   */
  reportModelSwitched(model: string): void {
    this.say(`Now running ${model}.`, NOTE_FADE_MS);
  }

  /** Ask the agent to change mode, and say plainly when it will not. */
  private async setMode(mode: PermissionMode): Promise<void> {
    const result = await api.setPermissionMode(this.session.id, mode);
    if (!result.ok) {
      this.reportModeRefusal(result.reason);
      return;
    }
    if (result.appliesToNextTurn) {
      this.reportModeDeferred(result.mode);
      return;
    }
    // The snapshot arrives on its own through `session:updated`; nothing is
    // painted from the request, only from what the agent said -- and the mode
    // chip says it in the same words the picker did, so there is nothing here
    // a confirmation could add.
    this.hushNote();
  }

  /** A refused mode change, said under the composer where the button is. */
  reportModeRefusal(reason: string): void {
    this.say(`Could not change the permission mode — ${reason}`);
  }

  /** A running turn keeps the permission tuple it started with. */
  reportModeDeferred(mode: PermissionMode): void {
    this.say(`Switched to ${permissionModeLabel(mode)}. The turn already running keeps its previous permissions.`);
  }

  private paintWaiting(s: SessionSnapshot): void {
    const working = s.status === 'working' && s.exitCode === null;
    const wasHidden = this.waiting.hidden;
    this.waiting.hidden = !working;
    this.waitingLabel.textContent = working ? (s.activity ?? 'working') : '';
    if (working && wasHidden) this.scrollToTail();
    this.paintSubagents(s);
  }

  /** One line per subagent, said in its own words and apart from the turn. */
  private paintSubagents(s: SessionSnapshot): void {
    const agents = s.exitCode === null ? s.subagents : [];
    const wasHidden = this.subagentLine.hidden;
    this.subagentLine.hidden = agents.length === 0;
    const head = document.createElement('div');
    head.className = 'chat-subagents-head';
    head.textContent = `${agents.length} subagent${agents.length === 1 ? '' : 's'} working`;
    this.subagentLine.replaceChildren(
      head,
      ...agents.map((agent) => {
        const row = document.createElement('div');
        row.className = 'chat-subagent' + (agent.asking ? ' is-asking' : '');
        const type = document.createElement('span');
        type.className = 'chat-subagent-type';
        type.textContent = agent.type ?? 'subagent';
        const what = document.createElement('span');
        what.className = 'chat-subagent-activity';
        what.textContent = agent.activity ?? 'working';
        row.append(type, what);
        return row;
      }),
    );
    if (agents.length && wasHidden && this.isNearBottom()) this.scrollToTail();
  }

  private scrollToTail(): void {
    // A window scrolled back through history does not contain the end, so
    // getting there means asking for it. Forgetting the version does: the next
    // poll answers with the newest page, which is drawn at the tail.
    if (!this.follows()) {
      this.version = null;
      this.pinnedToBottom = true;
      void this.refresh();
      return;
    }
    this.scroll.scrollTop = this.scroll.scrollHeight;
  }

  /** Whether the window held reaches the newest item. */
  private follows(): boolean {
    const held = this.snapshot;
    return !held || held.start + held.items.length >= held.total;
  }

  /** Close enough to the end that new content should keep pulling it down. */
  private isNearBottom(): boolean {
    return this.follows() &&
      this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 48;
  }

  /** Stop through plane 2; never synthesize Ctrl+C or Escape terminal bytes. */
  private async interrupt(): Promise<boolean> {
    this.action.disabled = true;
    return api.interruptTurn(this.session.id);
  }

  /** Stop the active turn through the declared capability. */
  private async stop(): Promise<void> {
    if (this.action.disabled || this.mode !== 'stop') return;
    try {
      this.say(
        await this.interrupt()
          ? 'Stopped.'
          : 'The agent no longer had an active turn to stop.',
      );
    } finally {
      this.paintAction();
    }
  }

  /** Remove one message. The daemon's next snapshot takes it off screen. */
  private async removeQueued(messageId: number): Promise<void> {
    try {
      this.say(await api.removeQueuedMessage(this.session.id, messageId)
        ? 'Removed queued message.'
        : 'That message has already gone in.');
    } catch (error) {
      this.say(`Could not remove the message: ${String(error)}`);
    }
  }

  /** Ask the platform for files; only the native picker can mint this draft. */
  private async pickAttachments(): Promise<void> {
    if (this.attachButton.disabled) return;
    try {
      const picked = await api.pickChatAttachments(this.session.cwd);
      this.addAttachments(picked);
    } catch (error) {
      this.say(`Attachments were not added: ${String(error)}`);
    }
    this.focus();
  }

  /** Image-aware paste for the chat composer, with ordinary text preserved. */
  private async pasteClipboard(): Promise<void> {
    let paste: ClipboardPaste;
    try {
      paste = await api.readClipboard();
    } catch (error) {
      this.say(`Could not paste: ${String(error)}`);
      return;
    }
    if (paste.kind === 'text') {
      const start = this.input.selectionStart;
      const end = this.input.selectionEnd;
      this.input.setRangeText(paste.text, start, end, 'end');
      this.input.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    if (paste.kind === 'attachments') this.addAttachments(paste.attachments);
  }

  /** Merge files into the draft by path, keeping the ten-item bound visible. */
  private addAttachments(incoming: ChatAttachment[]): void {
    const key = (attachment: ChatAttachment) =>
      api.platform === 'win32' ? attachment.path.toLowerCase() : attachment.path;
    const seen = new Set(this.attachments.map(key));
    let omitted = 0;
    for (const attachment of incoming) {
      const pathKey = key(attachment);
      if (seen.has(pathKey)) continue;
      if (this.attachments.length >= MAX_CHAT_ATTACHMENTS) {
        omitted += 1;
        continue;
      }
      seen.add(pathKey);
      this.attachments.push(attachment);
    }
    this.paintAttachments();
    this.paintAction();
    if (omitted) this.say(`A message can contain at most ${MAX_CHAT_ATTACHMENTS} attachments.`);
  }

  /** Draw removable attachment chips without ever interpreting their names. */
  private paintAttachments(): void {
    this.attachmentList.replaceChildren(
      ...this.attachments.map((attachment, index) =>
        renderAttachment(attachment, () => {
          this.attachments.splice(index, 1);
          this.paintAttachments();
          this.paintAction();
          this.focus();
        }),
      ),
    );
    this.attachmentList.hidden = this.attachments.length === 0;
  }

  /** Guards a second press while the daemon is answering the first. */
  private submitting = false;

  /**
   * Hand the draft to the daemon, which sends it or holds it. Refused is the
   * only answer that leaves the draft here, since nothing else has it.
   */
  private async submit(): Promise<void> {
    const text = this.input.value.replace(/\s+$/, '');
    const attachments = [...this.attachments];
    if ((!text && !attachments.length) || this.input.disabled || this.submitting) return;
    this.submitting = true;
    let result: ChatSubmitResult;
    try {
      result = await api.submitChatMessage(this.session.id, text, attachments);
    } catch (error) {
      this.say(`Message was not sent: ${String(error)}`);
      return;
    } finally {
      this.submitting = false;
    }
    if (result.outcome === 'refused') {
      this.say(`Message was not sent: ${result.reason}`);
      return;
    }
    // Only the text that was actually sent is cleared: anything typed while
    // the send was in flight is newer and is not this message.
    if (this.input.value.replace(/\s+$/, '') === text) this.input.value = '';
    this.attachments = this.attachments.filter(
      (attachment) => !attachments.includes(attachment),
    );
    this.paintAttachments();
    if (result.outcome === 'queued') {
      this.paintQueuedMessages(true);
      this.say(result.position === 1
        ? `Queued — it goes in when ${this.session.agent} is ready.`
        : `Queued — ${result.position} waiting, they go in as ${this.session.agent} is ready.`);
    }
    this.paintAction();
  }

  /** A message went in, typed here or on another client. */
  private onDelivered(event: ChatDeliveredEvent): void {
    if (event.id !== this.session.id) return;
    const { message, stillQueued } = event;
    if (stillQueued) {
      this.say(`Sent — ${stillQueued} still queued.`, NOTE_FADE_MS);
    } else {
      this.say(hasStructuredTransport(this.session) ? 'Sent.' : 'Sent to the terminal.');
    }
    if (message.attachments.length) {
      this.sentAttachmentMessages.push({
        ...message,
        afterUserKey: lastUserMessageKey(this.snapshot),
      });
      this.paintPendingSentMessages();
    }
  }

  /** Keep queued messages visible even when no transcript update occurs. */
  private paintQueuedMessages(scrollToTail = false): void {
    const nearBottom = this.isNearBottom();
    this.paintedQueue = this.queue.map((entry) => entry.id).join();
    this.queuedMessages.replaceChildren(
      ...this.queue.map((entry, index) =>
        renderQueuedMessage(entry.text, entry.attachments, index, () => void this.removeQueued(entry.id)),
      ),
    );
    if (scrollToTail || nearBottom) this.scrollToTail();
  }

  /** Keep a sent attachment visible while its transcript record catches up. */
  private paintPendingSentMessages(): void {
    const nearBottom = this.isNearBottom();
    const { unmatched } = matchSentAttachmentMessages(
      this.snapshot,
      this.sentAttachmentMessages,
    );
    this.pendingSentMessages.replaceChildren(
      ...unmatched.map((entry) => renderSentAttachmentMessage(entry.text, entry.attachments)),
    );
    if (nearBottom) this.scrollToTail();
  }

  private async refresh(): Promise<void> {
    if (this.fetching) return;
    this.fetching = true;
    this.readAgain = false;
    this.lastRead = Date.now();
    const asked = this.version;
    let read: ConversationRead;
    try {
      const held = this.snapshot;
      read = await api.readConversation(this.session.id, asked && held
        ? {
            known: asked,
            start: held.start,
            end: held.start + held.items.length,
            follow: this.follows(),
          }
        : {});
    } catch {
      return;
    } finally {
      this.fetching = false;
    }
    // Asked for the tail while this was in flight, so it answers the wrong
    // question. The poll that follows asks the right one.
    if (this.version !== asked) return;
    // The ordinary answer: the agent has not written since the last poll, so
    // there is nothing to carry across the pipe and nothing to repaint.
    if ('unchanged' in read) {
      void this.loadMoreIfNeeded();
      return;
    }
    // Keep the DOM holding the reader's selection intact while new transcript
    // records arrive. The version is not advanced, so the next poll after the
    // selection clears is told the same changes again.
    if (this.selectionInConversation()) {
      this.readAgain = true;
      return;
    }
    // Out of the document, a scroller has no geometry to compensate against.
    // The version stays put and the first poll after `attach` catches up.
    if (!this.element.isConnected) return;
    if ('delta' in read) this.applyDelta(read);
    else this.showNewest(read);
    void this.loadMoreIfNeeded();
  }

  private selectionInConversation(): boolean {
    const selection = window.getSelection();
    return Boolean(selection && !selection.isCollapsed &&
      ((selection.anchorNode && this.scroll.contains(selection.anchorNode)) ||
       (selection.focusNode && this.scroll.contains(selection.focusNode))));
  }

  /**
   * Draw a bounded run of the conversation in place of whatever was held.
   *
   * Only the first read and a transcript replaced under the pane land here, and
   * either way the old position means nothing, so the reader goes to the end.
   */
  private showNewest(snapshot: ConversationSnapshot): void {
    const welcomed = this.snapshot !== null && !this.snapshot.items.length;
    this.version = snapshot.version;
    this.snapshot = snapshot;
    // An absent transcript answers this on every poll, with a null version.
    if (welcomed && !snapshot.items.length) return;
    this.hushNote();

    this.nodes = snapshot.items.map((item) =>
      renderItem(item, this.controls, this.session.cwd),
    );
    // The bubble is one long-lived element rather than one per repaint, so
    // its animation does not restart every time the transcript poll lands.
    // The welcome card is centred by `margin: auto`, so the waiting bubble
    // rides along beneath it rather than being dropped for a first turn.
    this.scroll.replaceChildren(
      ...(snapshot.items.length ? this.nodes : [renderWelcome(this.session)]),
      this.pendingSentMessages,
      this.queuedMessages,
      this.waiting,
      this.subagentLine,
    );
    this.decorateSentAttachments();
    if (snapshot.items.length) {
      this.scroll.scrollTop = this.scroll.scrollHeight;
      this.pinnedToBottom = true;
    }
  }

  /**
   * Replace the items that changed and add the ones that arrived, touching
   * nothing else. This is the difference between a new message costing its own
   * nodes and costing the whole conversation, which measured 94ms at 400 items
   * and 3.1s at 20,000 on a Galaxy Z Fold6, with the composer blocked throughout.
   */
  private applyDelta(delta: ConversationDelta): void {
    const held = this.snapshot;
    if (!held) return;
    held.total = delta.total;
    held.updatedAt = delta.updatedAt;
    held.reason = null;
    this.version = delta.version;
    if (!delta.changed.length) return;
    this.hushNote();

    const nearBottom = this.isNearBottomOfWindow();
    if (!this.nodes.length) {
      // What was on screen was the welcome card, which is not an item.
      this.scroll.replaceChildren(
        this.pendingSentMessages,
        this.queuedMessages,
        this.waiting,
        this.subagentLine,
      );
    }
    const arrived = document.createDocumentFragment();
    for (const { index, item } of delta.changed) {
      const at = index - held.start;
      const node = renderItem(item, this.controls, this.session.cwd);
      const existing = this.nodes[at];
      if (existing) {
        // A tool call gaining its result, which the reader may have open.
        if (existing instanceof HTMLDetailsElement && node instanceof HTMLDetailsElement) {
          node.open = existing.open;
        }
        existing.replaceWith(node);
        if (this.readingPlace?.node === existing) this.readingPlace.node = node;
        this.nodes[at] = node;
        held.items[at] = item;
      } else if (at === this.nodes.length) {
        arrived.append(node);
        this.nodes.push(node);
        held.items.push(item);
      } else {
        // A gap cannot be drawn honestly. Start again from the end.
        this.version = null;
        return;
      }
    }
    this.scroll.insertBefore(arrived, this.pendingSentMessages);
    this.decorateSentAttachments();
    this.trimWindow(nearBottom);
    if (nearBottom && this.follows()) this.scroll.scrollTop = this.scroll.scrollHeight;
  }

  /**
   * Swap a shortened item for all of it. The text grows downward from where the
   * reader is, so nothing above moves. The window may have moved while this was
   * asked, in which case the item has gone and there is nothing to draw.
   */
  private async expandItem(item: ChatItem): Promise<boolean> {
    const held = this.snapshot;
    const asked = held?.items.indexOf(item) ?? -1;
    if (!held || asked < 0 || !this.version) return false;
    let read: ConversationItemRead;
    try {
      read = await api.readConversationItem(this.session.id, {
        index: held.start + asked,
        known: this.version,
      });
    } catch {
      return false;
    }
    if (!('item' in read)) return false;
    const current = this.snapshot;
    const at = current?.items.indexOf(item) ?? -1;
    const existing = this.nodes[at];
    if (!current || at < 0 || !existing) return true;
    const node = renderItem(read.item, this.controls, this.session.cwd);
    if (existing instanceof HTMLDetailsElement && node instanceof HTMLDetailsElement) {
      node.open = existing.open;
    }
    existing.replaceWith(node);
    if (this.readingPlace?.node === existing) this.readingPlace.node = node;
    this.nodes[at] = node;
    current.items[at] = read.item;
    return true;
  }

  /** Record the item at the top of the view, and how far through it the view is. */
  private noteReadingPlace(): void {
    const top = this.scroll.getBoundingClientRect().top;
    let low = 0;
    let high = this.nodes.length - 1;
    let found: HTMLElement | null = null;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const node = this.nodes[middle] as HTMLElement;
      if (node.getBoundingClientRect().bottom > top) {
        found = node;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }
    if (!found) {
      this.readingPlace = null;
      return;
    }
    const box = found.getBoundingClientRect();
    this.readingPlace = {
      node: found,
      through: box.height ? Math.max(0, top - box.top) / box.height : 0,
      gap: Math.max(0, box.top - top),
    };
  }

  /**
   * Keep the reader's place when the pane changes size: a phone unfolding, a
   * split being dragged, the keyboard opening. Someone at the end stays at the
   * end, and a height change alone leaves the top line where it was.
   */
  private onResized(): void {
    const width = this.scroll.clientWidth;
    // Out of the document. The place is kept for when it comes back.
    if (!width) return;
    const changed = width !== this.readingWidth;
    this.readingWidth = width;
    const place = this.readingPlace;
    if (this.pinnedToBottom && this.follows()) {
      this.scroll.scrollTop = this.scroll.scrollHeight;
    } else if (changed && place?.node.isConnected) {
      const box = place.node.getBoundingClientRect();
      this.scroll.scrollTop += box.top + place.through * box.height - place.gap -
        this.scroll.getBoundingClientRect().top;
    }
    this.savedScrollTop = this.scroll.scrollTop;
    this.noteReadingPlace();
    void this.loadMoreIfNeeded();
  }

  /** Near the end of what is held, whether or not that is the conversation's. */
  private isNearBottomOfWindow(): boolean {
    return this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 48;
  }

  /**
   * Fetch the next page when the reader nears an edge of the window.
   *
   * Called from scrolling and after every answer, so a page that did not fill
   * the distance is followed by another without the reader moving.
   */
  private async loadMoreIfNeeded(): Promise<void> {
    const held = this.snapshot;
    if (this.fetching || !this.attached || !held || !this.version ||
      !this.element.isConnected || this.selectionInConversation()) return;
    const end = held.start + held.items.length;
    const fromTop = this.scroll.scrollTop;
    const fromBottom = this.scroll.scrollHeight - fromTop - this.scroll.clientHeight;
    const older = held.start > 0 && fromTop < PAGE_AHEAD_PX;
    const newer = !older && end < held.total && fromBottom < PAGE_AHEAD_PX;
    if (!older && !newer) return;

    this.fetching = true;
    const asked = this.version;
    let page: ConversationSnapshot;
    try {
      page = await api.readConversationPage(
        this.session.id,
        older ? { before: held.start } : { from: end },
      );
    } catch {
      return;
    } finally {
      this.fetching = false;
    }
    if (this.version !== asked || !this.element.isConnected) return;
    // Different content under the same session: the indexes held mean nothing.
    if (!sameContent(page.version, asked)) {
      this.version = null;
      return;
    }
    if (!page.items.length) return;
    held.total = page.total;
    const nodes = page.items.map((item) =>
      renderItem(item, this.controls, this.session.cwd),
    );
    if (older) {
      const before = this.scroll.scrollHeight;
      this.scroll.prepend(...nodes);
      this.scroll.scrollTop += this.scroll.scrollHeight - before;
      held.items.unshift(...page.items);
      this.nodes.unshift(...nodes);
      held.start = page.start;
    } else {
      this.pendingSentMessages.before(...nodes);
      held.items.push(...page.items);
      this.nodes.push(...nodes);
    }
    this.decorateSentAttachments();
    this.trimWindow(false);
    void this.loadMoreIfNeeded();
  }

  /**
   * Hold the window at its size by dropping whichever end is further from the
   * reader. With a thousand items held, the far half is well off screen.
   */
  private trimWindow(pinned: boolean): void {
    const held = this.snapshot;
    const excess = this.nodes.length - WINDOW_ITEMS;
    // Measuring forces a layout, so this waits for a batch rather than running
    // on every message once the window is full.
    if (!held || excess < TRIM_BATCH) return;
    const middle = (this.scroll.scrollHeight - this.scroll.clientHeight) / 2;
    if (pinned || this.scroll.scrollTop > middle) {
      const keep = this.nodes[excess];
      const first = this.nodes[0];
      const height = keep && first
        ? keep.getBoundingClientRect().top - first.getBoundingClientRect().top
        : 0;
      for (const node of this.nodes.splice(0, excess)) node.remove();
      held.items.splice(0, excess);
      held.start += excess;
      this.scroll.scrollTop -= height;
    } else {
      for (const node of this.nodes.splice(-excess)) node.remove();
      held.items.splice(-excess);
    }
  }

  /** Show what was sent, as a bubble until recorded and on its record after. */
  private decorateSentAttachments(): void {
    if (!this.sentAttachmentMessages.length) return;
    const matched = matchSentAttachmentMessages(this.snapshot, this.sentAttachmentMessages);
    this.pendingSentMessages.replaceChildren(
      ...matched.unmatched.map((entry) =>
        renderSentAttachmentMessage(entry.text, entry.attachments),
      ),
    );
    for (const [itemIndex, entries] of matched.byItem) {
      const node = this.nodes[itemIndex];
      const bubble = node?.querySelector<HTMLElement>('.chat-bubble');
      if (!node || !bubble) continue;
      for (const entry of entries) {
        if (this.decorated.get(entry) === node) continue;
        this.decorated.set(entry, node);
        bubble.append(renderAttachmentGroup(entry.attachments));
      }
    }
  }
}

/** Whether two versions read the same content, which `identity:offset` names. */
function sameContent(a: string | null, b: string | null): boolean {
  return a !== null && b !== null &&
    a.slice(0, a.lastIndexOf(':')) === b.slice(0, b.lastIndexOf(':'));
}

/**
 * The send mark: a paper plane, built as SVG nodes rather than markup — the
 * same rule the message renderer keeps, and the reason there is no
 * `innerHTML` anywhere in this view.
 *
 * Two strokes rather than one filled silhouette: the body, and the fold that
 * reads as the near wing. Without the fold a small plane collapses into an
 * anonymous triangle.
 */
function sendArrow(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'chat-send-arrow');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M21.5 2.5 2.8 9.3l7.6 3.4 3.4 7.6z', 'M21.5 2.5 10.4 12.7']) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2.1');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
  }
  return svg;
}

/** Paperclip mark for B3's add-attachment control, built as safe SVG nodes. */
function attachmentIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'chat-attach-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M8.5 12.5 15 6a3.5 3.5 0 0 1 5 5l-8.5 8.5a6 6 0 0 1-8.5-8.5l8-8a2.5 2.5 0 0 1 3.5 3.5L7 14a1 1 0 0 0 1.5 1.5l7-7');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

/**
 * The startup protocol provides identity/model/readiness, not a conversational
 * welcome message. Render that truth as Sertum chrome instead of pretending
 * the agent authored prose or parsing the banner drawn in its terminal.
 */
function renderWelcome(session: SessionSnapshot): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'chat-welcome';

  const title = document.createElement('div');
  title.className = 'chat-welcome-title';
  title.textContent = `Welcome to ${agentLabel(session.agent)}`;

  const body = document.createElement('div');
  body.className = 'chat-welcome-body';
  body.textContent = session.origin === 'monitored'
    ? `This session is connected in ${session.cwd}. Its input remains in the terminal where it started.`
    : `Connected in ${session.cwd}. Send a message to begin.`;

  const meta = document.createElement('div');
  meta.className = 'chat-welcome-meta';
  meta.textContent = session.model ?? '';
  meta.hidden = !meta.textContent;

  wrap.append(title, body, meta);
  return wrap;
}

function agentLabel(agent: SessionSnapshot['agent']): string {
  switch (agent) {
    case 'claude': return 'Claude';
    case 'codex': return 'Codex';
    case 'grok': return 'Grok';
    case 'shell': return 'Shell';
  }
}

function renderItem(item: ChatItem, controls: ItemControls, cwd: string): HTMLElement {
  switch (item.kind) {
    case 'message':
      return renderMessage(item, controls, cwd);
    case 'thinking':
      return renderThinking(item, controls);
    case 'image':
      return renderImage(item);
    case 'tool':
      return renderTool(item, controls);
  }
}

function renderImage(item: ChatItem & { kind: 'image' }): HTMLElement {
  const figure = document.createElement('figure');
  figure.className = 'chat-item chat-image';
  const image = document.createElement('img');
  image.src = item.src;
  image.alt = item.alt;
  image.loading = 'lazy';
  if (item.at !== null) image.title = timeLabel(item.at);
  figure.append(image);
  return figure;
}

/**
 * Which of a message's two readings is on screen, how to swap them, and how to
 * bring back the rest of an item that was shortened.
 *
 * A reader's choice is held by the pane rather than by the node, because a
 * node leaves the DOM whenever the window moves past it.
 */
interface ItemControls {
  raw(item: ChatItem & { kind: 'message' }): boolean;
  toggle(item: ChatItem & { kind: 'message' }): void;
  /** Fetch the rest of a shortened item and redraw it. False if that failed. */
  expand(item: ChatItem): Promise<boolean>;
}

/**
 * Identity that survives what changes about a message while it is on screen:
 * its text grows as the agent streams, and the window moves past it. The
 * timestamp plus an opening slice of the text is stable through both.
 */
function formatKey(item: ChatItem & { kind: 'message' }): string {
  return `${item.at ?? 'na'}|${item.text.slice(0, 80)}`;
}

/**
 * The agent's message, shown the way `MessageFormat` says — with the reader
 * given the other reading whenever there is one.
 */
function renderMessage(
  item: ChatItem & { kind: 'message' },
  controls: ItemControls,
  cwd: string,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `chat-item chat-${item.role}`;

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  if (item.at !== null) bubble.title = timeLabel(item.at);

  if (item.format === 'text') {
    appendMessageText(bubble, item.text, false, cwd);
    wrap.append(bubble, ...renderMore(item, controls));
    return wrap;
  }

  // A source-requested message explains itself, because being shown the
  // characters when the app could have rendered them looks like a failure
  // until you know it was a reading of the request.
  const bar = document.createElement('div');
  bar.className = 'chat-format';
  const note = document.createElement('span');
  note.className = 'chat-format-note';
  const button = document.createElement('button');
  button.className = 'chat-format-toggle';
  button.type = 'button';
  bar.append(note, button);

  const paint = (): void => {
    const raw = controls.raw(item);
    bubble.classList.toggle('is-markdown', !raw);
    bubble.classList.toggle('is-source', raw);
    bubble.replaceChildren();
    appendMessageText(bubble, item.text, !raw, cwd);
    button.textContent = raw ? 'Show rendered' : 'Show source';
    button.title = raw
      ? 'Render this message as markdown'
      : 'Show the characters the agent wrote';
    const explain = raw && item.format === 'markdown-source';
    note.textContent = explain ? 'Markdown source — the request asked for the markup' : '';
    bar.classList.toggle('is-explained', explain);
  };
  button.onclick = () => {
    controls.toggle(item);
    paint();
  };
  paint();

  wrap.append(bar, bubble, ...renderMore(item, controls));
  return wrap;
}

/** A queued user message, kept separate from the transcript until delivery. */
function renderQueuedMessage(
  text: string,
  attachments: ChatAttachment[],
  index: number,
  remove: () => void,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'chat-item chat-user chat-queued-message';

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  const copy = document.createElement('div');
  copy.textContent = text || 'Attachments';
  bubble.append(copy);
  if (attachments.length) bubble.append(renderAttachmentGroup(attachments));

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-queued-remove';
  button.textContent = '×';
  button.title = 'Remove queued message';
  button.setAttribute('aria-label', `Remove queued message ${index + 1}`);
  button.onclick = (event) => {
    event.stopPropagation();
    remove();
  };

  bubble.append(button);
  wrap.append(bubble);
  return wrap;
}

/** A successfully delivered attachment waiting for the transcript to land. */
function renderSentAttachmentMessage(
  text: string,
  attachments: ChatAttachment[],
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'chat-item chat-user chat-sent-attachment-message';
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  const copy = document.createElement('div');
  copy.textContent = text || 'Attachments';
  bubble.append(copy, renderAttachmentGroup(attachments));
  wrap.append(bubble);
  return wrap;
}

/** One file in the unsent draft (wireframe B3). */
function renderAttachment(
  attachment: ChatAttachment,
  remove: () => void,
): HTMLElement {
  const card = renderAttachmentPreview(attachment);
  card.classList.add('is-removable');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-attachment-remove';
  button.textContent = '×';
  button.title = `Remove ${attachment.name}`;
  button.setAttribute('aria-label', `Remove attachment ${attachment.name}`);
  button.onclick = remove;
  card.append(button);
  return card;
}

/** The same preview treatment in queued and sent user bubbles. */
function renderAttachmentGroup(attachments: readonly ChatAttachment[]): HTMLElement {
  const group = document.createElement('div');
  group.className = 'chat-attachment-previews';
  group.append(...attachments.map((attachment) => renderAttachmentPreview(attachment)));
  return group;
}

/** A bounded image thumbnail or a file placeholder, with inert text leaves. */
function renderAttachmentPreview(attachment: ChatAttachment): HTMLElement {
  const card = document.createElement('div');
  card.className = `chat-attachment is-${attachment.kind}`;
  card.title = `${attachment.path} · ${fileSize(attachment.size)}`;

  const visual = document.createElement('div');
  visual.className = 'chat-attachment-visual';
  const icon = attachmentPreviewIcon(attachment.kind);
  visual.append(icon);
  if (attachment.kind === 'image') {
    const image = document.createElement('img');
    image.alt = `${attachment.name} preview`;
    image.hidden = true;
    visual.append(image);
    void attachmentPreview(attachment).then((src) => {
      if (!src) return;
      image.src = src;
      image.hidden = false;
      icon.style.display = 'none';
    });
  }

  const copy = document.createElement('div');
  copy.className = 'chat-attachment-copy';
  const name = document.createElement('span');
  name.className = 'chat-attachment-name';
  name.textContent = attachment.name;
  const meta = document.createElement('span');
  meta.className = 'chat-attachment-meta';
  meta.textContent = `${attachment.kind === 'image' ? 'Image' : 'File'} · ${fileSize(attachment.size)}`;
  copy.append(name, meta);
  card.append(visual, copy);
  return card;
}

const attachmentPreviewCache = new Map<string, Promise<string | null>>();
const ATTACHMENT_PREVIEW_CACHE_MAX = 100;

function attachmentPreview(attachment: ChatAttachment): Promise<string | null> {
  const key = `${attachment.path}\u0000${attachment.size}`;
  let preview = attachmentPreviewCache.get(key);
  if (!preview) {
    preview = api.readChatAttachmentPreview(attachment).catch(() => null);
    if (attachmentPreviewCache.size >= ATTACHMENT_PREVIEW_CACHE_MAX) {
      attachmentPreviewCache.delete(
        attachmentPreviewCache.keys().next().value as string,
      );
    }
    attachmentPreviewCache.set(key, preview);
  }
  return preview;
}

function attachmentPreviewIcon(kind: ChatAttachment['kind']): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'chat-attachment-placeholder');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-hidden', 'true');
  const outline = document.createElementNS(ns, 'path');
  outline.setAttribute('d', 'M8 3.5h10l6 6V28.5H8z M18 3.5v6h6');
  svg.append(outline);
  if (kind === 'image') {
    const picture = document.createElementNS(ns, 'path');
    picture.setAttribute('d', 'm11 23 4.2-5 3 3 2-2.3 2.8 3.5 M13 13.5h.01');
    svg.append(picture);
  } else {
    for (const d of ['M11.5 15.5h9', 'M11.5 19.5h9', 'M11.5 23.5h6']) {
      const line = document.createElementNS(ns, 'path');
      line.setAttribute('d', d);
      svg.append(line);
    }
  }
  return svg;
}

function lastUserMessageKey(snapshot: ConversationSnapshot | null): string | null {
  if (!snapshot) return null;
  for (let index = snapshot.items.length - 1; index >= 0; index -= 1) {
    const item = snapshot.items[index];
    if (item?.kind === 'message' && item.role === 'user') return formatKey(item);
  }
  return null;
}

/** Pair locally sent descriptors with the user record the transcript wrote. */
function matchSentAttachmentMessages(
  snapshot: ConversationSnapshot | null,
  sent: readonly SentAttachmentMessage[],
): {
  byItem: Map<number, SentAttachmentMessage[]>;
  unmatched: SentAttachmentMessage[];
} {
  const byItem = new Map<number, SentAttachmentMessage[]>();
  const unmatched: SentAttachmentMessage[] = [];
  if (!snapshot) return { byItem, unmatched: [...sent] };

  const userItems = snapshot.items
    .map((item, itemIndex) => ({ item, itemIndex }))
    .filter((entry): entry is {
      item: ChatItem & { kind: 'message'; role: 'user' };
      itemIndex: number;
    } => entry.item.kind === 'message' && entry.item.role === 'user');
  let beforeOrdinal = userItems.length;
  for (let sentIndex = sent.length - 1; sentIndex >= 0; sentIndex -= 1) {
    const entry = sent[sentIndex];
    if (!entry) continue;
    const body = entry.text.trim() || promptWithAttachments('', entry.attachments).split('\n')[0] || '';
    const boundary = entry.afterUserKey
      ? userItems.findLastIndex(({ item }) => formatKey(item) === entry.afterUserKey) + 1
      : 0;
    let found = -1;
    for (
      let ordinal = beforeOrdinal - 1;
      ordinal >= boundary;
      ordinal -= 1
    ) {
      const candidate = userItems[ordinal];
      if (!candidate) continue;
      const candidateKey = formatKey(candidate.item);
      if (entry.transcriptKey
        ? candidateKey === entry.transcriptKey
        : candidate.item.text === body || candidate.item.text.startsWith(`${body}\n`)) {
        found = ordinal;
        break;
      }
    }
    if (found === -1) {
      // Once acknowledged, a record that is no longer in the bounded
      // transcript window belongs off-screen rather than resurfacing at the
      // tail as a fresh optimistic message.
      if (!entry.transcriptKey) unmatched.unshift(entry);
      continue;
    }
    beforeOrdinal = found;
    entry.transcriptKey ??= formatKey(userItems[found]!.item);
    const itemIndex = userItems[found]?.itemIndex;
    if (itemIndex === undefined) continue;
    const messages = byItem.get(itemIndex) ?? [];
    messages.unshift(entry);
    byItem.set(itemIndex, messages);
  }
  return { byItem, unmatched };
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The way to the rest of a shortened item, or word that this is all there will be. */
function renderMore(item: ChatItem, controls: ItemControls): HTMLElement[] {
  if (item.kind === 'image' || !item.more) return [];
  if (item.more === 'too-long') {
    const note = document.createElement('div');
    note.className = 'chat-more-note';
    note.textContent = 'Showing the first 4 MB. The rest is in the transcript file.';
    return [note];
  }
  const button = document.createElement('button');
  button.className = 'chat-format-toggle chat-more';
  button.type = 'button';
  button.textContent = 'Show all';
  button.onclick = () => {
    button.disabled = true;
    button.textContent = 'Loading…';
    void controls.expand(item).then((done) => {
      if (done) return;
      button.disabled = false;
      button.textContent = 'Could not load it. Try again';
    });
  };
  return [button];
}

function renderThinking(item: ChatItem & { kind: 'thinking' }, controls: ItemControls): HTMLElement {
  const details = document.createElement('details');
  details.className = 'chat-item chat-thinking';
  const summary = document.createElement('summary');
  summary.textContent = 'Thinking';
  const body = document.createElement('div');
  body.className = 'chat-thinking-body';
  body.textContent = item.text;
  details.append(summary, body, ...renderMore(item, controls));
  return details;
}

function renderTool(item: ChatItem & { kind: 'tool' }, controls: ItemControls): HTMLElement {
  const details = document.createElement('details');
  details.className = 'chat-item chat-tool';

  const summary = document.createElement('summary');
  const name = document.createElement('span');
  name.className = 'chat-tool-name';
  name.textContent = item.name;
  summary.append(name);
  if (item.detail) {
    const detail = document.createElement('span');
    detail.className = 'chat-tool-detail';
    detail.textContent = firstLine(item.detail);
    summary.append(detail);
  }
  if (item.output === null) {
    const running = document.createElement('span');
    running.className = 'chat-tool-running';
    running.textContent = 'no result yet';
    summary.append(running);
  }
  details.append(summary);

  if (item.detail && item.detail !== firstLine(item.detail)) {
    details.append(pre(item.detail, 'chat-tool-input'));
  }
  if (item.output !== null) {
    details.append(pre(item.output, 'chat-tool-output'));
  }
  details.append(...renderMore(item, controls));
  return details;
}

function pre(text: string, cls: string): HTMLPreElement {
  const el = document.createElement('pre');
  el.className = cls;
  el.textContent = text;
  return el;
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0];
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

function timeLabel(at: number): string {
  try {
    return new Date(at).toLocaleTimeString();
  } catch {
    return '';
  }
}
