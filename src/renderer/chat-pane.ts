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

export class ChatPane {
  readonly element: HTMLDivElement;
  private scroll: HTMLDivElement;
  private note: HTMLDivElement;
  private input: HTMLTextAreaElement;
  private action: HTMLButtonElement;
  /** Which of the two things the one composer button currently does. */
  private mode: 'send' | 'stop' = 'send';
  private composerNote: HTMLDivElement;
  /**
   * The permission-mode button, beside the box you type into.
   *
   * This is the setting that decides how much of the session you are asked
   * about, so it sits where the asking happens rather than several menus
   * away -- which is also where Claude Code itself keeps it. It shows the
   * mode the agent reported, never a guess.
   */
  private modeButton: HTMLButtonElement;
  private waiting: HTMLDivElement;
  private waitingLabel: HTMLSpanElement;
  private timer: ReturnType<typeof setInterval> | null = null;
  private renderedKey = '';
  private session: SessionSnapshot;
  private attached = false;
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
        (mode) => void this.setMode(mode),
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
    meta.append(this.modeButton, this.composerNote);
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
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
  }

  /** Leave the DOM and stop polling; the conversation is on disk, not here. */
  unmount(): void {
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

  /** Ask the agent to change mode, and say plainly when it will not. */
  private async setMode(mode: PermissionMode): Promise<void> {
    const result = await api.setPermissionMode(this.session.id, mode);
    if (result.ok) {
      // The snapshot arrives on its own through `session:updated`; nothing is
      // painted from the request, only from what the agent said.
      this.composerNote.hidden = true;
      return;
    }
    this.reportModeRefusal(result.reason);
  }

  /** A refused mode change, said under the composer where the button is. */
  reportModeRefusal(reason: string): void {
    this.composerNote.textContent = `Could not change the permission mode — ${reason}`;
    this.composerNote.hidden = false;
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

  /** Stop through plane 2; never synthesize Ctrl+C or Escape terminal bytes. */
  private async interrupt(): Promise<void> {
    if (this.action.disabled || this.mode !== 'stop') return;
    this.action.disabled = true;
    const accepted = await api.interruptTurn(this.session.id);
    this.composerNote.textContent = accepted
      ? 'Stop requested through the agent’s control channel.'
      : 'The agent no longer has an active turn to stop.';
    this.composerNote.hidden = false;
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
          this.composerNote.textContent = 'Message was not sent. Finish or stop the current turn, then try again.';
          this.composerNote.hidden = false;
          return;
        }
      } catch (error) {
        this.composerNote.textContent = `Message was not sent: ${String(error)}`;
        this.composerNote.hidden = false;
        return;
      } finally { this.submitting = false; }
      this.composerNote.textContent =
        'Sent — it appears here once the agent records it.';
    } else {
      api.write(
        id,
        text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text,
      );
      setTimeout(() => api.write(id, '\r'), 150);
      this.composerNote.textContent =
        'Sent to the terminal — it appears here once the agent records it.';
    }
    if (this.input.value.replace(/\s+$/, '') === text) this.input.value = '';
    this.paintAction();
    this.composerNote.hidden = false;
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
    this.composerNote.hidden = true;
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
    const nearBottom =
      this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 48;
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
