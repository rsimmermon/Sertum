import type { ApprovalScope, PendingApproval } from '../shared/types';
import { openTextPrompt } from './text-prompt-dialog';

const api = window.sertum;

/**
 * Approval bar — wireframe B5 (frame HgiJ5).
 *
 * A tool call is waiting and the agent's turn is genuinely held open behind
 * this bar, which shapes every decision here:
 *
 *   - It appears above the terminal rather than as a modal overlay. You need
 *     to read the output that led to the request while deciding, and a dialog
 *     covering it would make the answer worse.
 *   - It is never dismissed by clicking away. Every route off the bar answers
 *     the call, because anything else leaves a turn hanging on a decision
 *     nobody made.
 *   - It removes itself when the hook server says the call is gone, which is
 *     what a timeout or a dead session looks like from here.
 *
 * The four choices differ only in how far the answer reaches: this call, this
 * session, or a stored rule.
 */
export class ApprovalBar {
  readonly element: HTMLElement;
  private pending: PendingApproval | null = null;

  constructor(private readonly onResolved: () => void) {
    this.element = document.createElement('div');
    this.element.className = 'approval-bar';
    this.element.hidden = true;
  }

  /** The session this bar is currently asking about, if any. */
  get sessionId(): string | null {
    return this.pending?.sessionId ?? null;
  }

  show(request: PendingApproval): void {
    this.pending = request;
    this.element.hidden = false;
    this.element.replaceChildren(
      icon(),
      body(request),
      actions([
        button('Allow once', 'primary', () => void this.answer('allow', 'once')),
        button('Allow this session', '', () => void this.answer('allow', 'session')),
        button('Always allow', '', () => void this.answer('allow', 'always')),
        button('Deny', 'danger', () => void this.deny()),
      ]),
    );
  }

  /**
   * Takes the bar down without answering. Only correct when the call is
   * already gone -- the hook server says so, or the session ended.
   */
  dismiss(id?: string): void {
    if (id && this.pending?.id !== id) return;
    this.pending = null;
    this.element.hidden = true;
    this.element.replaceChildren();
  }

  private async deny(): Promise<void> {
    const request = this.pending;
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
    if (this.pending?.id !== request.id) return;
    await this.answer('deny', 'once', reason ?? undefined);
  }

  private async answer(
    decision: 'allow' | 'deny',
    scope: ApprovalScope,
    reason?: string,
  ): Promise<void> {
    const request = this.pending;
    if (!request) return;
    this.dismiss();
    await api.answerApproval(
      {
        id: request.id,
        sessionId: request.sessionId,
        tool: request.tool,
        subject: request.subject,
      },
      { decision, scope, reason },
    );
    this.onResolved();
  }
}

function icon(): HTMLElement {
  const el = document.createElement('span');
  el.className = 'approval-icon';
  el.textContent = '⚠';
  return el;
}

function body(request: PendingApproval): HTMLElement {
  const col = document.createElement('div');
  col.className = 'approval-body';
  const title = document.createElement('div');
  title.className = 'approval-title';
  title.textContent = `${request.tool} needs permission`;
  const subject = document.createElement('div');
  subject.className = 'approval-subject';
  subject.textContent = request.subject;
  subject.title = request.subject;
  col.append(title, subject);
  return col;
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
