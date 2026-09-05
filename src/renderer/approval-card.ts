import type { ApprovalCard, ApprovalQuestion } from '../shared/types';
import { appendMessageText } from './message-text';

/**
 * The two calls whose card *is* the question — wireframe B5, widened.
 *
 * `AskUserQuestion` and `ExitPlanMode` do not ask whether they may run. One
 * asks which option; the other asks whether a plan is right. An approve/deny
 * bar cannot express either, so those calls used to be refused outright with
 * a note saying Sertum could not draw the card. It can: `can_use_tool`
 * carries the whole thing — the questions with their options and
 * descriptions, or the plan as its own markdown — so the card is drawn from
 * the agent's own words. See `main/adapters/interactive-tools.ts` for how
 * each answer gets back.
 *
 * These sit where the bar sits, between the transcript and the composer,
 * because a question you are being asked belongs next to where you answer
 * everything else. They are taller than the bar and scroll internally rather
 * than pushing the conversation off screen: a plan can be long, and a
 * question can have six options with a sentence each.
 *
 * Nothing here is assembled as an HTML string. The plan goes through
 * `appendMessageText`, the same renderer the transcript uses and under the
 * same promise; every other leaf is set with `textContent`.
 */

/** What the user did with a card, in the vocabulary `ApprovalAnswer` uses. */
export interface CardAnswer {
  decision: 'allow' | 'deny' | 'answer';
  /** The words that go back to the agent. */
  reason?: string;
  answers?: Record<string, string[]>;
}

export interface CardView {
  element: HTMLElement;
  /** The buttons this card owns, for the bar's action row. */
  actions: HTMLButtonElement[];
}

export function buildApprovalCard(
  card: ApprovalCard,
  cwd: string,
  answer: (a: CardAnswer) => void,
): CardView {
  return card.kind === 'questions'
    ? questionsCard(card.questions, answer)
    : planCard(card.plan, card.planFilePath, cwd, answer);
}

// --------------------------------------------------------------- questions

/**
 * The agent's questions, each with its options.
 *
 * `multiSelect` decides the control, and it is the agent's own field rather
 * than a guess: a single-select question uses radios so picking a second
 * option replaces the first, and a multi-select uses checkboxes. Every
 * question also takes free text, because a set of options the user disagrees
 * with should not be a dead end — the tool's own card offers the same way
 * out, and its result format carries free text alongside the choices.
 */
function questionsCard(
  questions: ApprovalQuestion[],
  answer: (a: CardAnswer) => void,
): CardView {
  const body = document.createElement('div');
  body.className = 'approval-card';

  // Unique per card instance, so two cards on screen cannot capture each
  // other's radio groups.
  const group = `q-${Math.random().toString(36).slice(2, 8)}`;
  const chosen: string[][] = questions.map(() => []);
  const notes: string[] = questions.map(() => '');

  const send = button('Send answer', 'primary', () =>
    answer({ decision: 'answer', reason: compose(questions, chosen, notes), answers: Object.fromEntries(questions.filter(q => q.id).map(q => { const i = questions.indexOf(q); return [q.id!, [...chosen[i], ...(notes[i].trim() ? [notes[i].trim()] : [])]]; })) }),
  );
  const paint = (): void => {
    // Something has to have been said, or there is nothing to send back.
    send.disabled = !chosen.some((c) => c.length) && !notes.some((n) => n.trim());
  };

  questions.forEach((q, qi) => {
    const block = document.createElement('div');
    block.className = 'approval-question';

    if (q.header) {
      const header = document.createElement('div');
      header.className = 'approval-q-header';
      header.textContent = q.header;
      block.append(header);
    }

    const text = document.createElement('div');
    text.className = 'approval-q-text';
    text.textContent = q.question;
    block.append(text);

    if (q.multiSelect) {
      const hint = document.createElement('div');
      hint.className = 'approval-q-hint';
      hint.textContent = 'Pick as many as apply.';
      block.append(hint);
    }

    for (const opt of q.options) {
      const row = document.createElement('label');
      row.className = 'approval-option';

      const box = document.createElement('input');
      box.type = q.multiSelect ? 'checkbox' : 'radio';
      box.name = `${group}-${qi}`;
      box.className = 'approval-option-input';
      box.addEventListener('change', () => {
        if (q.multiSelect) {
          chosen[qi] = box.checked
            ? [...chosen[qi], opt.label]
            : chosen[qi].filter((l) => l !== opt.label);
        } else {
          chosen[qi] = box.checked ? [opt.label] : [];
        }
        paint();
      });

      const label = document.createElement('div');
      label.className = 'approval-option-body';
      const name = document.createElement('div');
      name.className = 'approval-option-label';
      name.textContent = opt.label;
      label.append(name);
      if (opt.description) {
        const desc = document.createElement('div');
        desc.className = 'approval-option-desc';
        desc.textContent = opt.description;
        label.append(desc);
      }

      row.append(box, label);
      block.append(row);
    }

    const other = document.createElement('input');
    other.type = q.isSecret ? 'password' : 'text';
    other.className = 'field approval-q-other';
    other.placeholder = q.options.length
      ? 'Something else, or a note on your choice…'
      : 'Your answer…';
    other.addEventListener('input', () => {
      notes[qi] = other.value;
      paint();
    });
    block.append(other);

    body.append(block);
  });

  paint();
  return {
    element: body,
    actions: [
      send,
      button('Skip', '', () =>
        answer({
          decision: 'answer',
          reason: 'The user dismissed the question without answering.',
        }),
      ),
    ],
  };
}

/** One answer per question, keyed by the agent's own short header. */
function compose(
  questions: ApprovalQuestion[],
  chosen: string[][],
  notes: string[],
): string {
  const lines: string[] = [];
  questions.forEach((q, i) => {
    const picks = chosen[i] ?? [];
    const note = (notes[i] ?? '').trim();
    if (!picks.length && !note) return;
    const key = q.header || q.question;
    const said = picks.length ? picks.join(', ') : '';
    if (said && note) lines.push(`${key}: ${said} — they added: "${note}"`);
    else if (said) lines.push(`${key}: ${said}`);
    else lines.push(`${key}: they wrote "${note}"`);
  });
  if (!lines.length) return 'The user dismissed the question without answering.';
  return [
    'Answered in Sertum.',
    '',
    ...lines,
    '',
    'These are the user’s answers to your questions. Continue with them in mind, and do not ask these again.',
  ].join('\n');
}

// -------------------------------------------------------------------- plan

/**
 * A plan to approve.
 *
 * This one maps onto the wire natively: allowing the call *is* approval —
 * the tool result reads "User has approved your plan" and the session leaves
 * plan mode — and denying it with a message keeps the session planning and
 * hands the agent the feedback. So the buttons say what the answer means
 * rather than what the wire does.
 */
function planCard(
  plan: string,
  planFilePath: string | undefined,
  cwd: string,
  answer: (a: CardAnswer) => void,
): CardView {
  const body = document.createElement('div');
  body.className = 'approval-card';

  const text = document.createElement('div');
  // The transcript's own markdown classes, so a plan reads exactly like the
  // message it would otherwise have been.
  text.className = 'approval-plan chat-bubble is-markdown';
  // The agent wrote markdown deliberately, so it is rendered as markdown —
  // the same call, the same renderer and the same no-HTML-strings promise the
  // transcript above it is drawn under.
  appendMessageText(text, plan, true, cwd);
  body.append(text);

  if (planFilePath) {
    const where = document.createElement('div');
    where.className = 'approval-plan-path';
    where.textContent = `Saved to ${planFilePath}`;
    where.title = planFilePath;
    body.append(where);
  }

  const feedback = document.createElement('input');
  feedback.type = 'text';
  feedback.className = 'field approval-plan-feedback';
  feedback.placeholder = 'What should change? (sent when you keep planning)';
  body.append(feedback);

  return {
    element: body,
    actions: [
      button('Approve plan', 'primary', () => answer({ decision: 'allow' })),
      button('Keep planning', '', () => {
        const said = feedback.value.trim();
        answer({
          decision: 'deny',
          reason: said
            ? `The user did not approve the plan. They said: "${said}" Stay in plan mode and revise it.`
            : 'The user did not approve the plan. Stay in plan mode and revise it.',
        });
      }),
    ],
  };
}

function button(
  label: string,
  tone: string,
  action: () => void,
): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `btn ${tone} small`.trim();
  el.textContent = label;
  el.onclick = action;
  return el;
}
