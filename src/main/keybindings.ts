import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Keybinding, KeybindingSection } from '../shared/types';

/**
 * Remappable shortcuts — wireframe E6.
 *
 * Accelerators lived as literals inside `buildMenu`, which made them
 * unremappable by construction: there was nowhere to put an override and
 * nothing to detect a collision against. This is that missing registry, and
 * it stays deliberately small — a table of commands, a map of overrides, and
 * one rule about conflicts.
 *
 * **A stored accelerator is validated before it is ever handed to Electron.**
 * `Menu.buildFromTemplate` throws on a malformed accelerator, and the menu is
 * built during startup, so one bad string in a hand-edited file would leave
 * the app with no menu at all. Anything that does not parse is dropped on
 * load and the command keeps its default.
 */
export interface CommandDef {
  id: string;
  label: string;
  section: KeybindingSection;
  accelerator: string;
}

/**
 * Every command whose accelerator is a fixed string. The numbered ones
 * (`⌘1`…`⌘4` for sessions and panes) are generated per index and mean
 * "the nth thing" rather than naming one command, so they are not listed.
 */
export const COMMANDS: readonly CommandDef[] = [
  { id: 'new-session', label: 'New session', section: 'Application', accelerator: 'CmdOrCtrl+N' },
  { id: 'settings', label: 'Settings', section: 'Application', accelerator: 'CmdOrCtrl+,' },
  { id: 'palette', label: 'Command palette', section: 'Application', accelerator: 'CmdOrCtrl+K' },
  { id: 'worktrees', label: 'Worktree manager', section: 'Application', accelerator: 'CmdOrCtrl+Shift+W' },

  { id: 'close-tab', label: 'Close tab', section: 'Sessions', accelerator: 'CmdOrCtrl+W' },
  { id: 'interrupt', label: 'Interrupt turn', section: 'Sessions', accelerator: 'CmdOrCtrl+.' },
  { id: 'next-session', label: 'Next session', section: 'Sessions', accelerator: 'CmdOrCtrl+Shift+]' },
  { id: 'prev-session', label: 'Previous session', section: 'Sessions', accelerator: 'CmdOrCtrl+Shift+[' },

  { id: 'layout-picker', label: 'Pane layout picker', section: 'Panes', accelerator: 'CmdOrCtrl+Alt+L' },
  { id: 'split-right', label: 'Split focused pane right', section: 'Panes', accelerator: 'CmdOrCtrl+Alt+D' },
  { id: 'split-down', label: 'Split focused pane down', section: 'Panes', accelerator: 'CmdOrCtrl+Alt+Shift+D' },
  { id: 'maximise-pane', label: 'Maximise focused pane', section: 'Panes', accelerator: 'CmdOrCtrl+Alt+Return' },
  { id: 'close-pane', label: 'Close focused pane', section: 'Panes', accelerator: 'CmdOrCtrl+Alt+W' },
  { id: 'reset-panes', label: 'Reset pane sizes', section: 'Panes', accelerator: 'CmdOrCtrl+Alt+0' },
  { id: 'focus-pane-left', label: 'Focus pane left', section: 'Panes', accelerator: 'CmdOrCtrl+Alt+Left' },
  { id: 'focus-pane-right', label: 'Focus pane right', section: 'Panes', accelerator: 'CmdOrCtrl+Alt+Right' },
  { id: 'focus-pane-up', label: 'Focus pane up', section: 'Panes', accelerator: 'CmdOrCtrl+Alt+Up' },
  { id: 'focus-pane-down', label: 'Focus pane down', section: 'Panes', accelerator: 'CmdOrCtrl+Alt+Down' },
];

const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

let overrides: Record<string, string> | null = null;

function file(): string {
  return path.join(app.getPath('userData'), 'keybindings.json');
}

function load(): Record<string, string> {
  if (overrides) return overrides;
  let raw: unknown = {};
  try {
    raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    // First run, or a file we cannot use. Defaults are always valid.
  }
  const next: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      // Unknown command, or an accelerator Electron would reject: keep the
      // default rather than risk a menu that cannot be built.
      if (!BY_ID.has(id) || typeof value !== 'string') continue;
      if (!isValidAccelerator(value)) continue;
      next[id] = value;
    }
  }
  overrides = next;
  return overrides;
}

function save(): void {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(overrides ?? {}, null, 2));
  } catch (err) {
    console.error('[sertum] could not save keybindings:', err);
  }
}

/** The accelerator a command should be built with right now. */
export function accel(id: string): string {
  const command = BY_ID.get(id);
  if (!command) throw new Error(`unknown command: ${id}`);
  return load()[id] ?? command.accelerator;
}

/** Every command with its current binding, for E6 to list. */
export function listKeybindings(): Keybinding[] {
  const current = load();
  return COMMANDS.map((c) => ({
    id: c.id,
    label: c.label,
    section: c.section,
    accelerator: current[c.id] ?? c.accelerator,
    isDefault: !(c.id in current),
    defaultAccelerator: c.accelerator,
  }));
}

/** Commands already using this accelerator, excluding one. */
export function conflictsFor(accelerator: string, exceptId: string): string[] {
  return listKeybindings()
    .filter((k) => k.id !== exceptId && sameAccelerator(k.accelerator, accelerator))
    .map((k) => k.id);
}

/**
 * Records a binding, refusing one that collides.
 *
 * E6 note 236: nothing is saved until the conflict is resolved. Storing a
 * duplicate would mean two menu items claiming one chord, where which of them
 * fires is Electron's business and not something the user chose.
 */
export function setKeybinding(
  id: string,
  accelerator: string,
): { ok: true; bindings: Keybinding[] } | { ok: false; reason: string } {
  const command = BY_ID.get(id);
  if (!command) return { ok: false, reason: 'Unknown command.' };
  if (!isValidAccelerator(accelerator)) {
    return { ok: false, reason: 'That is not a shortcut this platform can register.' };
  }

  const clash = conflictsFor(accelerator, id);
  if (clash.length) {
    const names = clash.map((c) => BY_ID.get(c)?.label ?? c).join(', ');
    return { ok: false, reason: `Already used by ${names}.` };
  }

  const current = load();
  if (accelerator === command.accelerator) delete current[id];
  else current[id] = accelerator;
  save();
  return { ok: true, bindings: listKeybindings() };
}

/** Back to the shipped chords, all of them. */
export function resetKeybindings(): Keybinding[] {
  overrides = {};
  save();
  return listKeybindings();
}

/**
 * Whether Electron will accept this accelerator.
 *
 * Checked by shape rather than by trying it, because the only way to ask
 * Electron directly is to build a menu and catch the throw -- which would
 * mean replacing the live application menu to validate a keystroke.
 */
export function isValidAccelerator(value: string): boolean {
  if (!value || value.length > 64) return false;
  const parts = value.split('+');
  const key = parts.pop();
  if (!key) return false;

  const MODIFIERS = new Set([
    'Command', 'Cmd', 'Control', 'Ctrl', 'CommandOrControl', 'CmdOrCtrl',
    'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta',
  ]);
  if (parts.some((p) => !MODIFIERS.has(p))) return false;
  // A bare letter is a menu item that fires on every press of that letter.
  if (!parts.length) return false;

  const KEYS = new Set([
    'Plus', 'Space', 'Tab', 'Capslock', 'Numlock', 'Scrolllock', 'Backspace',
    'Delete', 'Insert', 'Return', 'Enter', 'Up', 'Down', 'Left', 'Right',
    'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Esc', 'PrintScreen',
  ]);
  if (KEYS.has(key)) return true;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return true;
  if (/^num[0-9]$/.test(key) || key === 'numdec' || key === 'numadd' || key === 'numsub') return true;
  // Single printable character: letters, digits and the punctuation Electron
  // documents as usable on its own.
  return /^[0-9A-Za-z~!@#$%^&*()_=[\]{};:'",.<>/?\\|`+-]$/.test(key);
}

/** Two accelerators are the same chord even if written differently. */
function sameAccelerator(a: string, b: string): boolean {
  return normalise(a) === normalise(b);
}

function normalise(value: string): string {
  const parts = value.split('+');
  const key = parts.pop() ?? '';
  const mods = parts
    .map((m) =>
      m === 'Cmd' || m === 'Command' || m === 'Control' || m === 'Ctrl' || m === 'CommandOrControl'
        ? 'CmdOrCtrl'
        : m === 'Option'
          ? 'Alt'
          : m === 'Meta' || m === 'Super'
            ? 'Super'
            : m,
    )
    .sort();
  return [...mods, key.toLowerCase()].join('+');
}
