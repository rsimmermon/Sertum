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
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const;

/**
 * Settings blob passed to `claude --settings`. Registers one HTTP hook per
 * lifecycle event, all pointing at this session's own endpoint.
 */
export function buildClaudeSettings(hookUrl: string): string {
  const hooks = Object.fromEntries(
    HOOK_EVENTS.map((event) => [
      event,
      [{ hooks: [{ type: 'http', url: hookUrl }] }],
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
 */
function mapNotification(payload: Record<string, unknown>): StatusUpdate {
  const kind = (
    str(payload.matcher) ??
    str(payload.reason) ??
    str(payload.notification_type) ??
    ''
  ).toLowerCase();
  const message = str(payload.message);

  if (kind.includes('permission')) {
    return { status: 'needs-input', activity: message ?? 'approval needed' };
  }
  if (kind.includes('idle') || kind.includes('prompt')) {
    return { status: 'needs-input', activity: message ?? 'waiting for you' };
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
