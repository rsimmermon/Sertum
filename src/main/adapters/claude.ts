import type { SessionStatus } from '../../shared/types';

/** Hook events we subscribe to. Ordered roughly by turn lifecycle. */
const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'PermissionRequest',
  'PreCompact',
  'PostCompact',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const;

/**
 * Settings blob passed to `claude --settings`. Registers one hook per
 * lifecycle event, all POSTing to this session's own endpoint.
 *
 * These are `command` hooks running curl, not the `http` hook type this
 * endpoint was originally built for. As of Claude Code 2.1.247 an `http` hook
 * is accepted in settings and then never fires; a `command` hook registered on
 * the very same event does. Verified by putting both on one SessionStart and
 * watching only the command arrive -- which is why plane 2 looked wired up
 * (the settings were accepted, the endpoint was live) while no status ever
 * moved.
 *
 * curl preserves the cross-platform property the http type was chosen for: it
 * ships with macOS, with mainstream Linux, and with Windows 10 and later. The
 * arguments are deliberately free of quotes and spaces-in-values so the single
 * string is valid under both sh and cmd.exe. Claude hands the event payload to
 * the command on stdin, which `--data-binary @-` forwards verbatim.
 *
 * **Two deadlines, because only one event is ever held.** Every hook but
 * `PreToolUse` is answered the moment it arrives, so it keeps a two-second
 * ceiling: a Sertum that has stopped answering must never stall a turn.
 * `PreToolUse` is the one call Sertum deliberately holds open while B5's
 * approval bar waits for a person, so its deadline has to outlast that hold.
 * One shared `-m 2` did not, and it failed in the worst way available -- the
 * bar appeared, curl gave up two seconds later, Claude printed
 * `PreToolUse:Bash hook error -- Failed with non-blocking status code` and
 * asked in its own TUI, and every button on the bar answered a socket that had
 * already gone. `--connect-timeout` keeps the fast failure where it belongs:
 * an endpoint that is gone refuses the connection at once, so only a live one
 * that is genuinely holding a call gets the long deadline.
 */
export function buildClaudeSettings(
  hookUrl: string,
  approvalHoldMs: number,
): string {
  const curl = (maxSeconds: number): string =>
    `curl -s --connect-timeout 2 -m ${maxSeconds} --noproxy 127.0.0.1 -X POST ` +
    `-H Content-Type:application/json --data-binary @- ${hookUrl}`;
  const held = Math.max(2, Math.ceil(approvalHoldMs / 1000) + 5);
  const hooks = Object.fromEntries(
    HOOK_EVENTS.map((event) => [
      event,
      [
        {
          hooks: [
            {
              type: 'command',
              command: curl(event === 'PreToolUse' ? held : 2),
            },
          ],
        },
      ],
    ]),
  );
  return JSON.stringify({ hooks });
}

export interface StatusUpdate {
  status?: SessionStatus;
  activity?: string;
}

/**
 * Maps one hook event onto the app's status vocabulary.
 *
 * Returning `{}` means "this event carries no status change" — it is not a
 * failure. Only events that genuinely tell us something move the dot.
 */
export function mapClaudeHook(
  event: string,
  payload: Record<string, unknown>,
): StatusUpdate {
  const tool = str(payload.tool_name);

  switch (event) {
    case 'SessionStart':
      return { status: 'idle', activity: 'ready' };

    case 'UserPromptSubmit':
      return { status: 'working', activity: 'thinking' };

    case 'PreToolUse':
      return { status: 'working', activity: tool ? `${tool}…` : 'running a tool' };

    case 'PostToolUse':
      return { status: 'working', activity: tool ?? 'thinking' };

    case 'PostToolUseFailure':
      // A failed tool call is not a failed turn; the agent usually recovers.
      return { status: 'working', activity: tool ? `${tool} failed` : 'tool failed' };

    case 'PermissionRequest':
      return { status: 'needs-input', activity: tool ? `approve ${tool}?` : 'approval needed' };

    case 'Notification':
      return mapNotification(payload);

    // Compaction is the event the context indicator exists to warn about, so
    // when it actually happens we say so outright.
    case 'PreCompact':
      return { status: 'working', activity: 'compacting context…' };

    case 'PostCompact':
      return { status: 'working', activity: 'context compacted' };

    case 'Stop':
      return { status: 'idle', activity: 'turn finished' };

    case 'StopFailure':
      return { status: 'attention', activity: errorText(payload) ?? 'turn failed' };

    case 'SessionEnd':
      return { status: 'idle', activity: 'session ended' };

    default:
      return {};
  }
}

/**
 * `Notification` is the event that actually earns this architecture: it fires
 * when Claude wants input or a permission decision, so "needs you" is exact
 * rather than inferred from output going quiet.
 *
 * It carries two unlike things under one name, and only one of them is a
 * question:
 *
 *   - **A permission or approval request.** The agent is blocked and cannot
 *     proceed until you answer. This is what amber is for.
 *   - **The idle nudge.** Claude Code fires this after roughly a minute of no
 *     typing at an empty prompt. Nothing is blocked -- it is the state a
 *     finished turn already left the session in, restated.
 *
 * Treating the nudge as "needs you" turned every session anyone walked away
 * from amber a minute after `Stop` had correctly set it idle, which is the
 * crying-wolf failure the two planes exist to prevent. It costs more now that
 * a needs-input transition can also raise a system notification.
 */
function mapNotification(payload: Record<string, unknown>): StatusUpdate {
  const kind = (
    str(payload.matcher) ??
    str(payload.reason) ??
    str(payload.notification_type) ??
    ''
  ).toLowerCase();
  const message = str(payload.message);
  const text = (message ?? '').toLowerCase();

  if (kind.includes('permission') || /permission|approve|approval/.test(text)) {
    return { status: 'needs-input', activity: message ?? 'approval needed' };
  }

  // Deliberately no status at all rather than `idle`: the nudge says nothing
  // about whether the agent is blocked, so it must not clear a genuine
  // needs-input that arrived before it either.
  if (
    kind.includes('idle') ||
    kind.includes('prompt') ||
    text.includes('waiting for your input')
  ) {
    return {};
  }

  // Unknown notification kinds still mean Claude spoke up unprompted.
  if (message) return { status: 'needs-input', activity: message };
  return {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function errorText(payload: Record<string, unknown>): string | undefined {
  const err = payload.error;
  if (typeof err === 'string') return err.slice(0, 120);
  if (err && typeof err === 'object') {
    const m = (err as Record<string, unknown>).message;
    if (typeof m === 'string') return m.slice(0, 120);
  }
  return str(payload.last_assistant_message)?.slice(0, 120);
}
