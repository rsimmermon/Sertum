import { sessionCapability } from '../shared/session-capabilities';
import type {
  AgentCapabilities,
  AgentKind,
  AgentModel,
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
 * Which model a session runs, and the one popup that changes it.
 *
 * The shape is `permission-mode.ts`'s, deliberately: the same kind of setting,
 * reached from the same two places, so the two chips beside the composer read
 * as a pair rather than as two features that grew separately. The one real
 * difference is where the list comes from -- a permission mode is a fixed
 * vocabulary Sertum can spell out, while a model catalogue belongs to the
 * account and changes without Sertum being rebuilt, so it is fetched from the
 * session's own agent every time this opens.
 *
 * That fetch is why this is async where the mode picker is not. Claude answers
 * in milliseconds on the session's own stream; Codex's `model/list` goes to
 * its app server and was measured at ~1.9s cold. Opening a menu that says it
 * is reading, then replacing it with the answer, beats a chip that appears to
 * do nothing for two seconds.
 */

/**
 * What to call the model on the chip.
 *
 * The agent's own words for it when a catalogue row has supplied them, the
 * slug when only the agent has spoken, and "Model" when it has not said
 * anything at all. A slug is not a name: `claude-opus-5[1m]` is what a turn
 * reports, never what the picker offered, so a reader who just clicked
 * "Opus 5" has nothing to recognise until the label arrives. The slug stays
 * in the tooltip either way, which is the convention every other badge here
 * follows.
 */
export function modelLabel(s: SessionSnapshot): string {
  return s.modelLabel ?? s.model ?? 'Model';
}

/**
 * Whether this session can be told at all, and why not when it cannot.
 *
 * Two answers again, and both matter: the agent may have no way to switch, or
 * it may have one that only its structured transport carries. A PTY-backed
 * Claude or Codex session says where the model *is* set rather than
 * pretending it cannot be.
 */
export function modelAvailability(
  s: SessionSnapshot,
  capabilities: Record<AgentKind, AgentCapabilities> | null,
): { ok: true } | { ok: false; reason: string } {
  return sessionCapability(s, capabilities?.[s.agent], 'model-select');
}

/**
 * True when this catalogue row is the one the session is on.
 *
 * A row is matched on the id *or* on what it resolves to, because those are
 * two different names for one model and either may be what the session
 * reported. Claude's `default` resolves to `claude-opus-5[1m]` and a turn
 * reports `claude-opus-5`, so an exact-string test would leave the picker
 * with nothing ticked while showing the right model on the chip.
 */
function isCurrent(model: AgentModel, current: string | null): boolean {
  if (!current) return false;
  return [model.id, model.resolved].some(
    (name) => name !== null && (name === current || name.startsWith(`${current}[`) || current.startsWith(`${name}[`)),
  );
}

/**
 * The picker. A transient popup rather than a modal, like the mode picker:
 * one decision to record, no field to lose, so clicking away is the gesture
 * that fits.
 */
export async function openModelPicker(
  x: number,
  y: number,
  s: SessionSnapshot,
  capabilities: Record<AgentKind, AgentCapabilities> | null,
  pick: (model: string) => void,
): Promise<void> {
  const title = `Model — ${s.label}`;
  const available = modelAvailability(s, capabilities);
  if (!available.ok) {
    openSessionMenu(x, y, title, [
      { label: 'Switch model', note: available.reason },
    ]);
    return;
  }

  const waiting = openSessionMenu(x, y, title, [
    {
      label: 'Reading the model list…',
      note: `${agentName(s.agent)} answers this per session, so it is asked each time.`,
    },
  ]);

  const listed = await api.sessionModels(s.id);
  // Clicked away, or opened something else, while that was in flight. Putting
  // the menu back now would reopen one they had already dismissed.
  if (!isSessionMenuOpen(waiting)) return;

  if (!listed.ok) {
    openSessionMenu(x, y, title, [{ label: 'Switch model', note: listed.reason }]);
    return;
  }

  // What the agent just said it is on, which on a session with no turns
  // behind it is newer than the snapshot this picker was opened from.
  const current = listed.current ?? s.model;
  const entries: MenuEntry[] = listed.models.map((model) => ({
    label: model.label,
    note: model.note ?? model.id,
    checked: isCurrent(model, current),
    onSelect: () => pick(model.id),
  }));
  if (!current) {
    // Saying nothing would leave every row unticked with no explanation. The
    // model arrives with the session's first turn, exactly as the mode does.
    entries.push(SEPARATOR, {
      label: 'Current model not reported yet',
      note: 'The agent names it when the session’s first turn starts.',
    });
  }
  openSessionMenu(x, y, title, entries);
}
