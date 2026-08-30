import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SETTINGS,
  PANE_COUNT,
  SCROLLBACK_CHOICES,
  type AccentColour,
  type PaneLayout,
  type PaneSplits,
  type Settings,
  type TerminalCursorStyle,
  type TerminalRenderer,
  type ThemePreference,
  type WorktreeBase,
} from '../shared/types';

/**
 * Display preferences, stored as JSON in userData.
 *
 * Deliberately tolerant: settings only affect how things look, so a missing,
 * unreadable or partly-garbage file falls back to defaults rather than
 * stopping the app. Unknown keys are dropped and known keys are range-checked,
 * so a hand-edited file cannot produce an unusable window.
 */
let cached: Settings | null = null;

function file(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

const FONT_MIN = 8;
const FONT_MAX = 32;

function clampFont(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(value)));
}

/**
 * Gutter fractions are clamped well away from the edges: a pane dragged to
 * nothing would leave a terminal too small to read, which the layout refuses
 * to do (design G7).
 */
const SPLIT_MIN = 0.15;
const SPLIT_MAX = 0.85;

function clampSplit(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value));
}

function sanitizeSplits(
  raw: Partial<PaneSplits> | undefined,
  base: PaneSplits,
): PaneSplits {
  return {
    columns: clampSplit(raw?.columns, base.columns),
    rows: clampSplit(raw?.rows, base.rows),
    gridCol: clampSplit(raw?.gridCol, base.gridCol),
    gridRow: clampSplit(raw?.gridRow, base.gridRow),
  };
}

function sanitize(raw: Partial<Settings>, base: Settings): Settings {
  const placement = raw.tabPlacement;
  const layout = raw.paneLayout as PaneLayout | undefined;
  return {
    tabPlacement:
      placement === 'side' || placement === 'top' || placement === 'both'
        ? placement
        : base.tabPlacement,
    paneLayout:
      layout !== undefined && layout in PANE_COUNT ? layout : base.paneLayout,
    paneSplits: sanitizeSplits(raw.paneSplits, base.paneSplits),
    terminalFontSize: clampFont(raw.terminalFontSize, base.terminalFontSize),
    tabFontSize: clampFont(raw.tabFontSize, base.tabFontSize),
    listFontSize: clampFont(raw.listFontSize, base.listFontSize),
    uiFontSize: clampFont(raw.uiFontSize, base.uiFontSize),
    // Wide enough to read a label, narrow enough to leave the terminal usable.
    sidebarWidth:
      typeof raw.sidebarWidth === 'number' && Number.isFinite(raw.sidebarWidth)
        ? Math.min(560, Math.max(180, Math.round(raw.sidebarWidth)))
        : base.sidebarWidth,
    showChips:
      typeof raw.showChips === 'boolean' ? raw.showChips : base.showChips,
    agentBinaryPaths: {
      claude: sanitizeBinaryPath(raw.agentBinaryPaths?.claude, base.agentBinaryPaths.claude),
      codex: sanitizeBinaryPath(raw.agentBinaryPaths?.codex, base.agentBinaryPaths.codex),
      grok: sanitizeBinaryPath(raw.agentBinaryPaths?.grok, base.agentBinaryPaths.grok),
    },
    terminalFontFamily:
      typeof raw.terminalFontFamily === 'string'
        ? raw.terminalFontFamily.trim().slice(0, 200)
        : base.terminalFontFamily,
    terminalLineHeight:
      typeof raw.terminalLineHeight === 'number' &&
      Number.isFinite(raw.terminalLineHeight)
        ? Math.min(2, Math.max(1, raw.terminalLineHeight))
        : base.terminalLineHeight,
    terminalCursorStyle: oneOf<TerminalCursorStyle>(
      raw.terminalCursorStyle,
      ['block', 'block-blink', 'bar', 'bar-blink', 'underline', 'underline-blink'],
      base.terminalCursorStyle,
    ),
    // Only the offered sizes are accepted: an arbitrary hand-edited number is
    // exactly the setting that quietly costs hundreds of megabytes.
    terminalScrollback: SCROLLBACK_CHOICES.includes(
      raw.terminalScrollback as number,
    )
      ? (raw.terminalScrollback as number)
      : base.terminalScrollback,
    terminalCopyOnSelect:
      typeof raw.terminalCopyOnSelect === 'boolean'
        ? raw.terminalCopyOnSelect
        : base.terminalCopyOnSelect,
    terminalRenderer: oneOf<TerminalRenderer>(
      raw.terminalRenderer,
      ['webgl', 'canvas'],
      base.terminalRenderer,
    ),
    worktreeBase: oneOf<WorktreeBase>(
      raw.worktreeBase,
      ['fresh', 'head'],
      base.worktreeBase,
    ),
    worktreeBootstrap:
      typeof raw.worktreeBootstrap === 'string'
        ? raw.worktreeBootstrap.trim().slice(0, 500)
        : base.worktreeBootstrap,
    approvalsInApp: bool(raw.approvalsInApp, base.approvalsInApp),
    notifyNeedsInput: bool(raw.notifyNeedsInput, base.notifyNeedsInput),
    notifyFailed: bool(raw.notifyFailed, base.notifyFailed),
    notifyFinished: bool(raw.notifyFinished, base.notifyFinished),
    // Only the thresholds E5 offers; 0 is "never".
    notifyLongTurnMinutes: [0, 5, 10, 30].includes(
      raw.notifyLongTurnMinutes as number,
    )
      ? (raw.notifyLongTurnMinutes as number)
      : base.notifyLongTurnMinutes,
    notifyOnlyWhenUnfocused: bool(
      raw.notifyOnlyWhenUnfocused,
      base.notifyOnlyWhenUnfocused,
    ),
    notifySound: bool(raw.notifySound, base.notifySound),
    notifyBadge: bool(raw.notifyBadge, base.notifyBadge),
    notifySnoozeMinutes: [5, 10, 30, 60].includes(
      raw.notifySnoozeMinutes as number,
    )
      ? (raw.notifySnoozeMinutes as number)
      : base.notifySnoozeMinutes,
    theme: oneOf<ThemePreference>(
      raw.theme,
      ['system', 'light', 'dark'],
      base.theme,
    ),
    accent: oneOf<AccentColour>(
      raw.accent,
      ['blue', 'violet', 'green', 'amber'],
      base.accent,
    ),
    compactRows:
      typeof raw.compactRows === 'boolean' ? raw.compactRows : base.compactRows,
  };
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function sanitizeBinaryPath(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

export function getSettings(): Settings {
  if (cached) return cached;
  let parsed: Partial<Settings> = {};
  try {
    parsed = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<Settings>;
  } catch {
    // First run, or a file we cannot use. Defaults are always valid.
  }
  cached = sanitize(parsed, DEFAULT_SETTINGS);
  return cached;
}

export function setSettings(patch: Partial<Settings>): Settings {
  cached = sanitize({ ...getSettings(), ...patch }, DEFAULT_SETTINGS);
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(cached, null, 2));
  } catch (err) {
    // A failed write costs the user their preference next launch, which is not
    // worth interrupting them over — but it should not be silent either.
    console.error('[sertum] could not save settings:', err);
  }
  return cached;
}
