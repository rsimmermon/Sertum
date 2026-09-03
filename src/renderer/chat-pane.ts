import type {
  CapabilityAnswer,
  ChatItem,
  ConversationSnapshot,
  SessionSnapshot,
} from '../shared/types';
import { render as renderMath } from 'katex';
import 'katex/dist/katex.min.css';

const api = window.sertum;

/**
 * A session rendered as a conversation instead of a terminal — stage 1 of the
 * chat direction in BROKER-HANDOFF.md.
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
  private send: HTMLButtonElement;
  private stop: HTMLButtonElement;
  private composerNote: HTMLDivElement;
  private timer: ReturnType<typeof setInterval> | null = null;
  private renderedKey = '';
  private session: SessionSnapshot;
  private attached = false;

  constructor(
    session: SessionSnapshot,
    private interruptCapability: CapabilityAnswer,
  ) {
    this.session = session;
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

    this.send = document.createElement('button');
    this.send.className = 'btn primary chat-send';
    this.send.type = 'button';
    this.send.textContent = 'Send';
    this.send.onclick = () => this.submit();

    this.stop = document.createElement('button');
    this.stop.className = 'btn danger chat-stop';
    this.stop.type = 'button';
    this.stop.textContent = 'Stop';
    this.stop.onclick = () => void this.interrupt();

    this.composerNote = document.createElement('div');
    this.composerNote.className = 'chat-sent';
    this.composerNote.hidden = true;

    const row = document.createElement('div');
    row.className = 'chat-composer-row';
    row.append(this.input, this.send, this.stop);
    composer.append(row, this.composerNote);

    this.element.append(this.note, this.scroll, composer);
    this.applySession(session);
  }

  /** The freshest snapshot, so the composer tracks the process's life. */
  update(session: SessionSnapshot): void {
    this.session = session;
    this.applySession(session);
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
    this.send.disabled = !writable;
    const turnActive = s.status === 'working' || s.status === 'needs-input';
    this.stop.disabled =
      !writable || !turnActive || !this.interruptCapability.ok;
    this.stop.title = !this.interruptCapability.ok
      ? this.interruptCapability.reason
      : turnActive
        ? `Interrupt ${s.agent}’s current turn`
        : 'There is no active turn to stop.';
    if (writable) {
      this.input.placeholder = `Message ${s.agent} — Enter sends, Shift+Enter for a new line`;
      this.input.title = '';
    } else if (s.origin === 'monitored') {
      this.input.placeholder =
        'This session’s input lives in its own terminal — jump to it to reply.';
    } else {
      this.input.placeholder = 'The session has exited.';
    }
  }

  /** Stop through plane 2; never synthesize Ctrl+C or Escape terminal bytes. */
  private async interrupt(): Promise<void> {
    if (this.stop.disabled) return;
    this.stop.disabled = true;
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
  private submit(): void {
    const text = this.input.value.replace(/\s+$/, '');
    if (!text || this.input.disabled) return;
    const id = this.session.id;
    if (this.session.transport === 'stream') {
      // A stream session takes the message whole, structured, no PTY bytes.
      void api.sendChatMessage(id, text);
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
    this.input.value = '';
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
    this.renderedKey = key;
    this.composerNote.hidden = true;
    this.render(snapshot);
  }

  private render(snapshot: ConversationSnapshot): void {
    // Keep the reading position unless the user was already at the tail.
    const nearBottom =
      this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 48;

    if (snapshot.items.length === 0) {
      this.note.hidden = true;
      this.scroll.replaceChildren(renderWelcome(this.session));
      return;
    }
    this.note.textContent = snapshot.truncated
      ? 'Older messages are not shown — the full history is in the transcript on disk.'
      : '';
    this.note.hidden = !snapshot.truncated;

    const nodes = snapshot.items.map((item) => renderItem(item));
    this.scroll.replaceChildren(...nodes);
    if (nearBottom) this.scroll.scrollTop = this.scroll.scrollHeight;
  }
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
      return `m:${item.role}:${item.text.length}`;
    case 'thinking':
      return `t:${item.text.length}`;
    case 'image':
      return `i:${item.src.length}:${item.alt}`;
    case 'tool':
      return `x:${item.name}:${item.detail?.length ?? 0}:${item.output?.length ?? 0}`;
  }
}

function renderItem(item: ChatItem): HTMLElement {
  switch (item.kind) {
    case 'message':
      return renderMessage(item);
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

/** Render the agent's text faithfully, typesetting only explicit TeX spans. */
function renderMessage(item: ChatItem & { kind: 'message' }): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `chat-item chat-${item.role}`;
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  appendMessageText(bubble, item.text);
  if (item.at !== null) bubble.title = timeLabel(item.at);
  wrap.append(bubble);
  return wrap;
}

/**
 * KaTeX receives only text inside the agent's explicit `\[...\]` or
 * `\(...\)` delimiters. Everything else remains a text node, so transcript
 * content cannot inject HTML and ordinary prose is never reformatted by us.
 */
function appendMessageText(target: HTMLElement, text: string): void {
  const math = /\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)/g;
  let from = 0;
  for (const match of text.matchAll(math)) {
    const at = match.index;
    if (at > from) target.append(document.createTextNode(text.slice(from, at)));
    const displayMode = match[1] !== undefined;
    const source = (match[1] ?? match[2] ?? '').trim();
    const span = document.createElement(displayMode ? 'div' : 'span');
    span.className = displayMode ? 'chat-math-display' : 'chat-math-inline';
    try {
      renderMath(source, span, {
        displayMode,
        throwOnError: false,
        trust: false,
        strict: 'ignore',
      });
    } catch {
      span.textContent = match[0];
    }
    target.append(span);
    from = at + match[0].length;
  }
  if (from < text.length) target.append(document.createTextNode(text.slice(from)));
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
