import type { ApprovalScope, PendingApproval } from '../shared/types';
import { buildApprovalCard, type CardAnswer } from './approval-card';
import { openTextPrompt } from './text-prompt-dialog';

const api = window.sertum;

/**
 * Approval bar — wireframe B5 (frame HgiJ5).
 *
 * A tool call is waiting and the agent's turn is genuinely held open behind
 * this bar, which shapes every decision here:
 *
 *   - It sits **directly above the composer**, inside the conversation it is
 *     about. The question is part of the turn you are reading, and the reply
 *     to it belongs where every other reply to that agent is typed; a bar at
 *     the top of the window was a decision to make about a conversation you
 *     then had to look somewhere else to read. A pane that is not a
 *     conversation keeps the bar above it, for the same reason it was there
 *     originally: you have to see the output that led to the request.
 *   - It is never dismissed by clicking away. Every route off the bar answers
 *     the call, because anything else leaves a turn hanging on a decision
 *     nobody made.
 *   - It removes itself when the daemon says the call is gone, which is what
 *     a timeout, a withdrawn request or a dead session look like from here.
 *
 * The four choices differ only in how far the answer reaches: this call, this
 * session, or a stored rule.
 *
 * The queue is owned by the app rather than by the bar, because the same call
 * can be waiting while its session is moved between panes, and because a
 * session's questions have to survive its pane being rebuilt. Each bar is
 * handed the calls for one session and draws the head of that list.
 */
export class ApprovalBar {
  readonly element: HTMLElement;

  /**
   * Calls waiting for this bar, oldest first; the head is the one on screen.
   * Claude issues tool calls in parallel, so more than one turn can be held
   * at a time, and a later request must not replace an earlier one that is
   * still holding its own turn open -- that would leave a call nobody can
   * answer until it times out.
   */
  private queue: PendingApproval[] = [];

  /**
   * @param onAnswered Told which call was answered, so the app can drop it
   *   from the queue it owns before the answer round-trips.
   * @param cwd The session's own folder, needed only so a plan card's
   *   markdown resolves a local image the same way the transcript does.
   */
  constructor(
    private readonly onAnswered: (id: string) => void,
    private readonly cwd: () => string = () => '',
  ) {
    this.element = document.createElement('div');
    this.element.className = 'approval-bar';
    this.element.hidden = true;
  }

  /** The session this bar is currently asking about, if any. */
  get sessionId(): string | null {
    return this.queue[0]?.sessionId ?? null;
  }

  /**
   * Replaces what this bar is showing. Redrawing is skipped when the head and
   * the depth are both unchanged, so the app's repaint does not rebuild the
   * buttons under a cursor that is on its way to one.
   */
  setRequests(requests: PendingApproval[]): void {
    const before = `${this.queue[0]?.id ?? ''}/${this.queue.length}`;
    this.queue = requests;
    if (`${this.queue[0]?.id ?? ''}/${this.queue.length}` === before) return;
    this.draw();
  }

  private draw(): void {
    const request = this.queue[0];
    this.element.classList.toggle('is-card', Boolean(request?.card));
    if (!request) {
      this.element.hidden = true;
      this.element.replaceChildren();
      return;
    }
    this.element.hidden = false;
    if (request.card) {
      this.drawCard(request);
      return;
    }
    const scopes = request.allowedScopes ?? ['once', 'session', 'always'];
    const choices: HTMLButtonElement[] = [];
    if (scopes.includes('once')) choices.push(button(request.onceLabel ?? 'Allow once', 'primary', () => void this.answer('allow', 'once')));
    if (scopes.includes('session')) choices.push(button('Allow this session', '', () => void this.answer('allow', 'session')));
    // A rule written from this button would cover more than the call on
    // screen, so the agent asked for it not to be offered.
    if (request.alwaysAllowable !== false && scopes.includes('always')) {
      choices.push(button('Always allow', '', () => void this.answer('allow', 'always')));
    }
    choices.push(button('Deny', 'danger', () => void this.deny()));
    this.element.replaceChildren(icon(), body(request, this.queue.length), actions(choices));
  }

  /**
   * A call whose card is the question. It gets a column rather than a row --
   * a plan is long and a question has options with a sentence each -- and the
   * card supplies its own buttons, because what they mean is particular to
   * the card and not to permission.
   */
  private drawCard(request: PendingApproval): void {
    const card = buildApprovalCard(request.card!, this.cwd(), (a) =>
      void this.answerCard(request.id, a),
    );
    const head = document.createElement('div');
    head.className = 'approval-card-head';
    const title = document.createElement('div');
    title.className = 'approval-title';
    const waiting =
      this.queue.length > 1 ? ` · ${this.queue.length - 1} more waiting` : '';
    title.textContent =
      (request.card!.kind === 'questions'
        ? `${request.agentLabel ?? 'Claude'} has a question`
        : `${request.agentLabel ?? 'Claude'} has a plan for you to review`) + waiting;
    head.append(icon(), title);
    this.element.replaceChildren(head, card.element, actions(card.actions));
  }

  private async answerCard(id: string, a: CardAnswer): Promise<void> {
    const request = this.queue[0];
    if (request?.id !== id) return;
    this.onAnswered(id);
    await api.answerApproval(
      {
        id: request.id,
        sessionId: request.sessionId,
        tool: request.tool,
        subject: request.subject,
      },
      { decision: a.decision, scope: 'once', reason: a.reason, answers: a.answers },
    );
  }

  private async deny(): Promise<void> {
    const request = this.queue[0];
    if (!request) return;
    // B5 note 31: the reason is optional and goes back to the agent, so it can
    // try something else instead of guessing why it was stopped.
    const reason = await openTextPrompt({
      title: `Deny ${request.tool}?`,
      description:
        'Optionally tell the agent why. Cancel denies without a reason.',
      placeholder: 'Use the staging database instead.',
      submitLabel: 'Deny',
    });
    // The prompt may have outlived the request it was about.
    if (this.queue[0]?.id !== request.id) return;
    await this.answer('deny', 'once', reason ?? undefined);
  }

  private async answer(
    decision: 'allow' | 'deny',
    scope: ApprovalScope,
    reason?: string,
  ): Promise<void> {
    const request = this.queue[0];
    if (!request) return;
    this.onAnswered(request.id);
    await api.answerApproval(
      {
        id: request.id,
        sessionId: request.sessionId,
        tool: request.tool,
        subject: request.subject,
      },
      { decision, scope, reason },
    );
  }
}

function icon(): HTMLElement {
  const el = document.createElement('span');
  el.className = 'approval-icon';
  el.textContent = '⚠';
  return el;
}

function body(request: PendingApproval, waiting: number): HTMLElement {
  const col = document.createElement('div');
  col.className = 'approval-body';
  const title = document.createElement('div');
  title.className = 'approval-title';
  // Saying how many are queued matters: each one is a turn held open, so
  // answering this bar is not necessarily the end of it.
  title.textContent =
    waiting > 1
      ? `${request.tool} needs permission · ${waiting - 1} more waiting`
      : `${request.tool} needs permission`;
  col.append(title);

  // The command or path itself, never the agent's summary of it. This is the
  // string the decision is actually about and the one "Always allow" would
  // write into a rule, so a gloss standing in its place -- "Echo the probe
  // marker string" where `echo …` belonged -- would be asking someone to
  // approve something they were not shown.
  if (request.subject) {
    const el = document.createElement('div');
    el.className = 'approval-subject';
    el.textContent = request.subject;
    el.title = request.subject;
    col.append(el);
  }

  // Why the agent had to ask. This is the sentence that used to reach the
  // reader only as the agent explaining, a turn later, that it had lacked
  // permission -- so it is worth a line of its own. The agent's own summary
  // of the call stands in when nothing said why. Both are producer-authored
  // and may carry ANSI escapes, so they are stripped and set as text.
  const note = request.reason ?? request.description;
  if (note) {
    const el = document.createElement('div');
    el.className = 'approval-reason';
    const clean = plain(note);
    el.textContent = clean;
    el.title = clean;
    col.append(el);
  }
  if (request.detail) {
    const detail = document.createElement('pre');
    detail.className = 'approval-detail';
    detail.textContent = request.detail;
    col.append(detail);
  }
  return col;
}

/** A CSI escape sequence, as a decision reason is allowed to carry them. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[\x20-\x2f]*[@-~]/g;

/** Strips escape sequences and collapses newlines; the bar is one line tall. */
function plain(text: string): string {
  return text.replace(ANSI, '').replace(/\s+/g, ' ').trim();
}

function actions(children: HTMLElement[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'approval-actions';
  row.append(...children);
  return row;
}

function button(label: string, tone: string, action: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `btn ${tone} small`.trim();
  el.textContent = label;
  el.onclick = action;
  return el;
}
