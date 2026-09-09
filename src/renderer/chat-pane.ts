import { hasStructuredTransport } from '../shared/session-capabilities';
import type {
  AgentCapabilities,
  AgentKind,
  CapabilityAnswer,
  ChatItem,
  ConversationSnapshot,
  PendingApproval,
  PermissionMode,
  SessionSnapshot,
} from '../shared/types';
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
 * A session rendered as a conversation instead of a terminal.
 *
 * Everything shown here is read from the agent's own transcript through
 * `conversation:read`; nothing is inferred from terminal output. Input still
 * goes to the PTY — see `submit` for the exact byte sequence and why. The
 * For a PTY-backed agent the terminal keeps running underneath as an
 * implementation detail; only Shell exposes a terminal as its product UI.
 *
 * The transcript is followed on a poll, like Grok's event log and for the
 * same reasons: the file may not exist yet, watch semantics differ by
 * platform, and one update per batch is the point. The transcript lags the
 * pixels by design — it is written when the agent records a message, not as
 * characters stream — so a sent message is acknowledged under the composer
 * until it shows up for real.
 */
const POLL_MS = 1000;

/**
 * How long a note that reports something *done* stays under the composer.
 *
 * Long enough to be read after a click that was looking somewhere else, short
 * enough that it does not become part of the furniture. A note about
 * something that did *not* happen has no timer at all -- see `say`.
 */
const NOTE_FADE_MS = 6000;

export class ChatPane {
  readonly element: HTMLDivElement;
  private scroll: HTMLDivElement;
  private note: HTMLDivElement;
  private input: HTMLTextAreaElement;
  private action: HTMLButtonElement;
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
  private timer: ReturnType<typeof setInterval> | null = null;
  private renderedKey = '';
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
   * Messages the reader has switched between rendered and source, by a key
   * that survives the message growing as it streams and the read window
   * dropping older items. Classification picks the opening position; this is
   * what stops that guess from being the last word.
   */
  private readonly chosenRaw = new Map<string, boolean>();
  private readonly formatChoice: FormatChoice = {
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

    this.note = document.createElement('div');
    this.note.className = 'chat-note';
    this.note.hidden = true;

    this.scroll = document.createElement('div');
    this.scroll.className = 'chat-scroll';
    // Live tracking, not a snapshot taken when the tab switches away -- by
    // then the element may already be mid-detach and its own scrollTop
    // unreliable. This fires for both the reader's own scrolling and this
    // pane's programmatic scrollToTail()/restore, which is fine: either way
    // it is where the scrollbar now sits.
    this.scroll.addEventListener('scroll', () => {
      this.savedScrollTop = this.scroll.scrollTop;
      this.pinnedToBottom = this.isNearBottom();
    });

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
      if (this.mode === 'stop') void this.interrupt();
      else this.submit();
    };
    // The mode follows the composer, so it flips on the first keystroke and
    // back on the last backspace.
    this.input.addEventListener('input', () => this.paintAction());

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
    row.append(box);

    const meta = document.createElement('div');
    meta.className = 'chat-composer-meta';
    meta.append(this.modeButton, this.modelButton, this.effortButton, this.composerNote);
    composer.append(row, meta);

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

    this.element.append(this.note, this.scroll, this.approvals.element, composer);
    this.applySession(session);
  }

  /** The freshest snapshot, so the composer tracks the process's life. */
  update(session: SessionSnapshot): void {
    this.session = session;
    this.applySession(session);
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
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
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
    this.unmount();
  }

  /**
   * Whether this pane can put input into the session at all: only a PTY we
   * own carries keystrokes, and only while its process is alive.
   */
  private canWrite(s: SessionSnapshot): boolean {
    return s.origin !== 'monitored' && s.exitCode === null;
  }

  private applySession(s: SessionSnapshot): void {
    const writable = this.canWrite(s);
    this.input.disabled = !writable;
    this.paintAction();
    this.paintMode(s);
    this.paintModel(s);
    this.paintEffort(s);
    if (writable) {
      this.input.placeholder = `Message ${s.agent} — Enter sends, Shift+Enter for a new line`;
      this.input.title = '';
    } else if (s.origin === 'monitored') {
      this.input.placeholder =
        'This session’s input lives in its own terminal — jump to it to reply.';
    } else {
      this.input.placeholder = 'The session has exited.';
    }
    this.paintWaiting(s);
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
   */
  private paintAction(): void {
    const s = this.session;
    const writable = this.canWrite(s);
    const hasText = this.input.value.trim().length > 0;
    const turnActive = s.status === 'working' || s.status === 'needs-input';

    this.mode = !hasText && writable && turnActive ? 'stop' : 'send';
    const canStop = writable && turnActive && this.interruptCapability.ok;

    let reason: string;
    if (this.mode === 'stop') {
      this.action.disabled = !canStop;
      reason = this.interruptCapability.ok
        ? `Stop ${s.agent}’s current turn`
        : this.interruptCapability.reason;
    } else {
      this.action.disabled = !writable || !hasText;
      reason = !writable
        ? 'This session cannot take input here.'
        : hasText
          ? `Send to ${s.agent}`
          : 'Type a message to send.';
    }
    this.action.classList.toggle('is-stop', this.mode === 'stop');
    this.action.classList.toggle('is-send', this.mode === 'send');
    this.action.title = reason;
    this.action.setAttribute('aria-label', reason);
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
    if (result.queued) {
      this.reportModeQueued(result.mode);
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

  /**
   * A mode asked for mid-turn, held rather than refused. It takes the moment
   * the turn ends -- the mode chip keeps reading the current mode until then,
   * since that is still what is actually in effect, so this note is the only
   * place the pending change is visible in the meantime.
   */
  reportModeQueued(mode: PermissionMode): void {
    this.say(`Will switch to ${permissionModeLabel(mode)} once the current turn finishes.`);
  }

  private paintWaiting(s: SessionSnapshot): void {
    const working = s.status === 'working' && s.exitCode === null;
    const wasHidden = this.waiting.hidden;
    this.waiting.hidden = !working;
    this.waitingLabel.textContent = working ? (s.activity ?? 'working') : '';
    if (working && wasHidden) this.scrollToTail();
  }

  private scrollToTail(): void {
    this.scroll.scrollTop = this.scroll.scrollHeight;
  }

  /** Close enough to the end that new content should keep pulling it down. */
  private isNearBottom(): boolean {
    return this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 48;
  }

  /** Stop through plane 2; never synthesize Ctrl+C or Escape terminal bytes. */
  private async interrupt(): Promise<void> {
    if (this.action.disabled || this.mode !== 'stop') return;
    this.action.disabled = true;
    const accepted = await api.interruptTurn(this.session.id);
    this.say(accepted
      ? 'Stop requested through the agent’s control channel.'
      : 'The agent no longer has an active turn to stop.');
  }

  /**
   * Send the composer's text into the PTY the way a person would: the body
   * as a paste, then Enter as its own keystroke.
   *
   * Multi-line text travels as a bracketed paste, because that is what the
   * agent's composer is built to receive whole. Encoding the newlines as ESC
   * CR (the Shift+Enter chord) was tried first and failed in a way worth
   * recording: written in one burst with a trailing CR, Claude's TUI read
   * the whole thing as a paste, swallowed the CR into it, and left the
   * message sitting in its composer unsent. The final CR is therefore
   * delayed a beat so it arrives as a real Enter press — verified against a
   * live Claude session, spaces and newlines intact. Codex requires the same
   * write boundary even for a single line: sending `text + CR` in one PTY
   * write leaves the text visibly sitting in its composer without submitting
   * it. Single lines therefore avoid paste markers but still receive Enter
   * in a second write.
   */
  private submitting = false;

  private async submit(): Promise<void> {
    const text = this.input.value.replace(/\s+$/, '');
    if (!text || this.input.disabled || this.submitting) return;
    const id = this.session.id;
    if (hasStructuredTransport(this.session)) {
      // A stream session takes the message whole, structured, no PTY bytes.
      this.submitting = true;
      try {
        if (!await api.sendChatMessage(id, text)) {
          this.say('Message was not sent. Finish or stop the current turn, then try again.');
          return;
        }
      } catch (error) {
        this.say(`Message was not sent: ${String(error)}`);
        return;
      } finally { this.submitting = false; }
      this.say('Sent — it appears here once the agent records it.');
    } else {
      api.write(
        id,
        text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text,
      );
      setTimeout(() => api.write(id, '\r'), 150);
      this.say('Sent to the terminal — it appears here once the agent records it.');
    }
    if (this.input.value.replace(/\s+$/, '') === text) this.input.value = '';
    this.paintAction();
  }

  private async refresh(): Promise<void> {
    let snapshot: ConversationSnapshot;
    try {
      snapshot = await api.readConversation(this.session.id);
    } catch {
      return;
    }
    const last = snapshot.items[snapshot.items.length - 1];
    const key = [
      snapshot.updatedAt ?? 0,
      snapshot.items.length,
      last ? itemSignature(last) : '',
      snapshot.reason ?? '',
    ].join(':');
    if (key === this.renderedKey) return;
    // Keep the DOM holding the reader's selection intact while new transcript
    // records arrive. The next poll catches up after the selection is cleared.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed &&
      ((selection.anchorNode && this.scroll.contains(selection.anchorNode)) ||
       (selection.focusNode && this.scroll.contains(selection.focusNode)))) return;
    this.renderedKey = key;
    this.hushNote();
    this.render(snapshot);
  }

  /**
   * Repaint the conversation, keeping the reader where they were.
   *
   * `replaceChildren` is atomic, so the scroller never lays out empty and
   * Chromium keeps `scrollTop` across it -- verified by removing the restore
   * below and watching the position survive anyway. The restore stays because
   * that is a property of one method rather than of this code: clearing and
   * appending in two steps would reset the position, and nothing here says
   * not to write it that way later.
   */
  private render(snapshot: ConversationSnapshot): void {
    const nearBottom = this.isNearBottom();
    const wasAt = this.scroll.scrollTop;

    if (snapshot.items.length === 0) {
      this.note.hidden = true;
      // The welcome card is centred by `margin: auto`, so the waiting bubble
      // rides along beneath it rather than being dropped for a first turn.
      this.scroll.replaceChildren(renderWelcome(this.session), this.waiting);
      return;
    }
    this.note.textContent = snapshot.truncated
      ? 'Older messages are not shown — the full history is in the transcript on disk.'
      : '';
    this.note.hidden = !snapshot.truncated;

    const nodes = snapshot.items.map((item) =>
      renderItem(item, this.formatChoice, this.session.cwd),
    );
    // The bubble is one long-lived element rather than one per repaint, so
    // its animation does not restart every time the transcript poll lands.
    this.scroll.replaceChildren(...nodes, this.waiting);
    if (nearBottom) this.scrollToTail();
    else this.scroll.scrollTop = wasAt;
  }
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

/** Enough of an item to notice streaming growth without hashing the list. */
function itemSignature(item: ChatItem): string {
  switch (item.kind) {
    case 'message':
      return `m:${item.role}:${item.format}:${item.text.length}`;
    case 'thinking':
      return `t:${item.text.length}`;
    case 'image':
      return `i:${item.src.length}:${item.alt}`;
    case 'tool':
      return `x:${item.name}:${item.detail?.length ?? 0}:${item.output?.length ?? 0}`;
  }
}

function renderItem(item: ChatItem, choice: FormatChoice, cwd: string): HTMLElement {
  switch (item.kind) {
    case 'message':
      return renderMessage(item, choice, cwd);
    case 'thinking':
      return renderThinking(item);
    case 'image':
      return renderImage(item);
    case 'tool':
      return renderTool(item);
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
 * Which of a message's two readings is on screen, and how to swap them.
 *
 * A reader's choice is held by the pane rather than by the node, because the
 * transcript poll rebuilds these nodes about once a second.
 */
interface FormatChoice {
  raw(item: ChatItem & { kind: 'message' }): boolean;
  toggle(item: ChatItem & { kind: 'message' }): void;
}

/**
 * Identity that survives what changes about a message while it is on screen:
 * its text grows as the agent streams, and the read window drops older items
 * off the front. The timestamp plus an opening slice of the text is stable
 * through both.
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
  choice: FormatChoice,
  cwd: string,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `chat-item chat-${item.role}`;

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  if (item.at !== null) bubble.title = timeLabel(item.at);

  if (item.format === 'text') {
    appendMessageText(bubble, item.text, false, cwd);
    wrap.append(bubble);
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
    const raw = choice.raw(item);
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
    choice.toggle(item);
    paint();
  };
  paint();

  wrap.append(bar, bubble);
  return wrap;
}

function renderThinking(item: ChatItem & { kind: 'thinking' }): HTMLElement {
  const details = document.createElement('details');
  details.className = 'chat-item chat-thinking';
  const summary = document.createElement('summary');
  summary.textContent = 'Thinking';
  const body = document.createElement('div');
  body.className = 'chat-thinking-body';
  body.textContent = item.text;
  details.append(summary, body);
  return details;
}

function renderTool(item: ChatItem & { kind: 'tool' }): HTMLElement {
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
