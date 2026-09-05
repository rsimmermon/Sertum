import { sessionCapability } from '../shared/session-capabilities';
import type {
  AgentCapabilities,
  AgentKind,
  PermissionMode,
  SessionSnapshot,
} from '../shared/types';
import { openSessionMenu, SEPARATOR, type MenuEntry } from './session-menu';

/**
 * How the agent decides permissions, and the one popup that changes it.
 *
 * The mode is the setting that decides how much of the session you are asked
 * about, so it belongs beside the composer rather than several menus away —
 * Claude Code puts it beside its own prompt for the same reason. Every
 * surface that offers the choice reads this catalogue, so none of them has to
 * be found and edited separately when the list changes.
 *
 * Ordered by how much they ask of you, loosest last but one: the row you land
 * on while scanning should not be the one that stops asking.
 */
export interface PermissionModeOption {
  mode: PermissionMode;
  label: string;
  /** What choosing it means, in one line. */
  note: string;
  /**
   * Why it cannot be chosen, when it cannot. `bypassPermissions` is the only
   * one: Claude Code refuses it unless the process was launched with
   * `--dangerously-skip-permissions`, and Sertum does not launch one that
   * way. It is listed rather than hidden so the reason is where the question
   * gets asked, which is the same answer a declined capability gives.
   */
  unavailable?: string;
}

export const PERMISSION_MODES: PermissionModeOption[] = [
  { mode: 'codex-untrusted', label: 'Ask for untrusted commands', note: 'Codex asks before commands outside its trusted set. Workspace sandbox stays enabled.' },
  { mode: 'codex-on-request', label: 'Ask on request', note: 'Codex asks when it needs to leave the workspace sandbox.' },
  { mode: 'codex-never', label: 'Never ask', note: 'Keep the workspace sandbox and refuse requests that require approval.' },
  {
    mode: 'plan',
    label: 'Plan',
    note: 'Explore and design only. Nothing is written until you approve a plan.',
  },
  {
    mode: 'default',
    label: 'Manual',
    note: 'Ask before anything that needs permission.',
  },
  {
    mode: 'auto',
    label: 'Auto',
    note: 'A model classifier approves routine calls and asks about the rest.',
  },
  {
    mode: 'acceptEdits',
    label: 'Accept edits',
    note: 'Edits inside the working folder go through without asking.',
  },
  {
    mode: 'dontAsk',
    label: 'Don’t ask',
    note: 'Never prompt. Anything not already allowed is refused instead.',
  },
  {
    mode: 'bypassPermissions',
    label: 'Bypass permissions',
    note: 'No permission checks at all.',
    unavailable:
      'Only on a session started with --dangerously-skip-permissions, which Sertum does not do.',
  },
];

const BY_MODE = new Map(PERMISSION_MODES.map((o) => [o.mode, o]));

/**
 * What to call the mode on a button.
 *
 * Null is "the agent has not said", which is deliberately not rendered as
 * `default`: guessing would put a word on screen the agent never used.
 */
export function permissionModeLabel(mode: PermissionMode | null): string {
  if (!mode) return 'Mode';
  return BY_MODE.get(mode)?.label ?? mode;
}

/**
 * Whether this session can be told at all, and why not when it cannot.
 *
 * Two separate answers, and both matter: the agent may have no such setting,
 * or it may have one that only its structured transport can carry. A terminal
 * session says where the mode *is* set rather than pretending it has none.
 */
export function permissionModeAvailability(
  s: SessionSnapshot,
  capabilities: Record<AgentKind, AgentCapabilities> | null,
): { ok: true } | { ok: false; reason: string } {
  return sessionCapability(s, capabilities?.[s.agent], 'permission-mode');
}

/**
 * The picker. A transient popup rather than a modal: it has one decision to
 * record and no field to lose, so clicking away is the gesture that fits.
 */
export function openPermissionModePicker(
  x: number,
  y: number,
  s: SessionSnapshot,
  capabilities: Record<AgentKind, AgentCapabilities> | null,
  pick: (mode: PermissionMode) => void,
): void {
  const available = permissionModeAvailability(s, capabilities);
  const declared = capabilities?.[s.agent]['permission-mode'];
  const modes = declared?.ok ? declared.modes : [];
  const entries: MenuEntry[] = PERMISSION_MODES.filter(opt => modes?.includes(opt.mode)).map((opt) => {
    const blocked = opt.unavailable ?? (available.ok ? null : available.reason);
    return {
      label: opt.label,
      note: blocked ?? opt.note,
      checked: s.permissionMode === opt.mode,
      onSelect: blocked ? undefined : () => pick(opt.mode),
    };
  });
  if (!s.permissionMode) {
    // Saying nothing would read as Manual, which is a claim about the agent
    // that has not been made. The session's own `defaultMode` setting is
    // usually what is in force, and it arrives with the first turn.
    entries.push(SEPARATOR, {
      label: 'Current mode not reported yet',
      note: 'The agent names it when the session’s first turn starts.',
    });
  }
  openSessionMenu(x, y, `Permission mode — ${s.label}`, entries);
}
