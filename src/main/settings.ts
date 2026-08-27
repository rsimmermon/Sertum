import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, type Settings } from '../shared/types';

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

function sanitize(raw: Partial<Settings>, base: Settings): Settings {
  const placement = raw.tabPlacement;
  return {
    tabPlacement:
      placement === 'side' || placement === 'top' || placement === 'both'
        ? placement
        : base.tabPlacement,
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
  };
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
