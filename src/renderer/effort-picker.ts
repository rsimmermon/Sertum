import { sessionCapability } from '../shared/session-capabilities';
import type {
  AgentCapabilities,
  AgentKind,
  SessionSnapshot,
} from '../shared/types';
import { agentName } from './chips';
import {
  isSessionMenuOpen,
  openSessionMenu,
  SEPARATOR,
  type MenuEntry,
} from './session-menu';

const api = window.sertum;

/**
 * How hard a session thinks, and the one popup that changes it.
 *
 * `model-picker.ts`'s twin, deliberately and almost line for line: the two
 * settings decide how a turn goes, both are asked about where the turn is
 * composed, and both are reached from the sidebar row menu as well, so
 * building the second any other way would make one feature read as two.
 *
 * The one difference worth knowing is what the catalogue belongs to. A model
 * catalogue belongs to the account; a thinking ladder belongs to a *model* --
 * Claude publishes `supportedEffortLevels` per row, Codex publishes
 * `supportedReasoningEfforts` per row, and Grok's cache publishes
 * `reasoning_efforts` per model. So this is asked per session and re-asked
 * after a model switch, and a level is never one Sertum named.
 */

/** What to call the level on the chip. Null is "the agent has not said". */
export function effortLabel(s: SessionSnapshot): string {
  return s.effort ?? 'Thinking';
}

/**
 * Whether this session can be told at all, and why not when it cannot.
 *
 * The same two answers `modelAvailability` gives, for the same two reasons:
 * an agent may have no way to set a level, or one that only its structured
 * transport carries.
 */
export function effortAvailability(
  s: SessionSnapshot,
  capabilities: Record<AgentKind, AgentCapabilities> | null,
): { ok: true } | { ok: false; reason: string } {
  return sessionCapability(s, capabilities?.[s.agent], 'thinking-level');
}

/**
 * The picker. A transient popup rather than a modal, like the two chips
 * beside it: one decision to record, no field to lose.
 */
export async function openEffortPicker(
  x: number,
  y: number,
  s: SessionSnapshot,
  capabilities: Record<AgentKind, AgentCapabilities> | null,
  pick: (effort: string) => void,
): Promise<void> {
  const title = `Thinking — ${s.label}`;
  const available = effortAvailability(s, capabilities);
  if (!available.ok) {
    openSessionMenu(x, y, title, [
      { label: 'Thinking level', note: available.reason },
    ]);
    return;
  }

  const waiting = openSessionMenu(x, y, title, [
    {
      label: 'Reading the thinking levels…',
      note: `${agentName(s.agent)} publishes these per model, so they are asked for the one this session runs.`,
    },
  ]);

  const listed = await api.sessionEfforts(s.id);
  // Clicked away, or opened something else, while that was in flight.
  if (!isSessionMenuOpen(waiting)) return;

  if (!listed.ok) {
    openSessionMenu(x, y, title, [{ label: 'Thinking level', note: listed.reason }]);
    return;
  }

  // What the agent just said it is on, which on a session with no turns
  // behind it is newer than the snapshot this picker was opened from.
  const current = listed.current ?? s.effort;
  const entries: MenuEntry[] = listed.efforts.map((effort) => ({
    label: effort.label,
    // The level as the agent spells it, when the label is a friendlier
    // rendering of it -- Grok's "High Effort" is the row for `high`, and a
    // rule or a transcript reads in the second spelling, not the first.
    note: effort.note ?? (effort.label === effort.id ? null : effort.id) ?? undefined,
    checked: current === effort.id,
    onSelect: () => pick(effort.id),
  }));
  if (!current) {
    // Every row unticked with no explanation reads as a broken menu rather
    // than as an unanswered question.
    entries.push(SEPARATOR, {
      label: 'Current level not reported yet',
      note: 'The agent names it once a turn has run.',
    });
  }
  openSessionMenu(x, y, title, entries);
}
