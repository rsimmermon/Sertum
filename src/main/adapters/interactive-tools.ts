import type { ApprovalCard, ApprovalQuestion } from '../../shared/types';

/**
 * The tools whose approval card *is* their interaction surface.
 *
 * `can_use_tool` marks these `requires_user_interaction: true` and means it
 * literally: there is no one-tap approve/deny, because the answer the tool
 * wants is not "may this run" but "which option" or "is this plan right".
 * Claude Code renders those cards itself in the TUI, and the protocol has a
 * channel for handing them to a host -- `request_user_dialog`, with kinds
 * `permission_ask_user_question` and `permission_exit_plan_mode_v2`. That
 * channel is **not** wired to a `--print --input-format stream-json` host in
 * Claude Code 2.1.260: the dialog transport is constructed only for the REPL
 * bridge (a session published to claude.ai), verified by declaring every
 * relevant kind in an `initialize` control request and watching `can_use_tool`
 * arrive instead, every time.
 *
 * What that leaves is better than it sounds, because **`can_use_tool` already
 * carries the whole card**. The questions arrive with their options and
 * descriptions; the plan arrives as its own markdown. So the card is drawn
 * from the tool input, and the answer goes back on the only wire there is:
 *
 * - **A plan is a native fit.** `allow` is approval -- the tool result reads
 *   "User has approved your plan. You can now start coding" and the session
 *   leaves plan mode -- and `deny` with a message keeps it planning and hands
 *   the agent the feedback. Both verified end to end.
 * - **A question is answered on the deny channel**, because that is the only
 *   one that carries a message back. The tool call genuinely does not run, so
 *   this is not a lie about what happened; the message states the answer and
 *   the agent reads it as one. Verified: given "Answered in Sertum --
 *   Indentation: Spaces", the reply was "You picked spaces for indentation."
 *   The alternative is strictly worse -- allowing the call runs a tool with
 *   no answer channel, which returns "The user did not answer the questions"
 *   and throws the user's choice away.
 *
 * Anything else marked `requires_user_interaction` has a card Sertum does not
 * know the shape of, so it is refused with a reason rather than guessed at.
 */
export function approvalCardFor(
  toolName: string,
  input: Record<string, unknown>,
): ApprovalCard | null {
  if (toolName === 'AskUserQuestion') {
    const questions = readQuestions(input.questions);
    return questions.length ? { kind: 'questions', questions } : null;
  }
  if (toolName === 'ExitPlanMode') {
    const plan = str(input.plan);
    return plan ? { kind: 'plan', plan, planFilePath: str(input.planFilePath) } : null;
  }
  return null;
}

function readQuestions(value: unknown): ApprovalQuestion[] {
  if (!Array.isArray(value)) return [];
  const out: ApprovalQuestion[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const q = raw as Record<string, unknown>;
    const question = str(q.question);
    if (!question) continue;
    const options: ApprovalQuestion['options'] = [];
    if (Array.isArray(q.options)) {
      for (const o of q.options) {
        if (!o || typeof o !== 'object') continue;
        const label = str((o as Record<string, unknown>).label);
        if (!label) continue;
        options.push({
          label,
          description: str((o as Record<string, unknown>).description),
        });
      }
    }
    out.push({
      question,
      header: str(q.header) ?? '',
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
