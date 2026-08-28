/**
 * Model, effort, and agent-kind badges.
 *
 * These are meant to be read by shape and colour first. A model's family sets
 * the colour, so a glance across the sidebar tells you which agent is which
 * without reading anything; the short mark only disambiguates tier and version
 * once you do look. Effort is a four-bar meter rather than a word,
 * because "medium" and "minimal" are indistinguishable at a glance while two
 * filled bars and one are not.
 *
 * Full values stay available in the title attribute — the badge is a summary,
 * never the only place the information exists.
 */

import type { AgentKind } from '../shared/types';

const AGENT_NAMES: Record<AgentKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  shell: 'Shell',
};

/** Human label for an agent kind, matching what New Session and Settings call it. */
export function agentName(agent: AgentKind): string {
  return AGENT_NAMES[agent];
}

export type ModelFamily =
  | 'opus'
  | 'sonnet'
  | 'haiku'
  | 'gpt'
  | 'gemini'
  | 'other';

/** Effort levels, ordered. Index doubles as the meter fill count. */
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'max'] as const;
export type EffortLevel = (typeof EFFORT_ORDER)[number];

export function modelFamily(model: string): ModelFamily {
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('gemini')) return 'gemini';
  if (m.includes('gpt') || m.includes('codex') || m.startsWith('o')) return 'gpt';
  return 'other';
}

/**
 * "claude-opus-5" -> "Op5", "gpt-5.6-sol" -> "Gp5".
 *
 * Two letters rather than one, and mixed case rather than upper: a lone
 * capital O next to a digit reads as a zero in a monospace face, so "O5" was
 * being seen as "05". "Op5" cannot be mistaken for a number.
 */
export function modelMark(model: string): string {
  const family = modelFamily(model);
  const initial: Record<ModelFamily, string> = {
    opus: 'Op',
    sonnet: 'So',
    haiku: 'Ha',
    gpt: 'Gp',
    gemini: 'Gm',
    other: '··',
  };
  // Bracketed annotations carry context-window sizes, not versions: without
  // dropping them "opus[1m]" reads its 1 as a generation and renders "Op1".
  const cleaned = model.replace(/\[[^\]]*\]/g, '');
  const version = /(?:^|[^a-z0-9])(\d+)(?:\.\d+)?/i.exec(cleaned)?.[1] ?? '';
  return (initial[family] + version).slice(0, 4);
}

export function effortLevel(effort: string): EffortLevel | null {
  const e = effort.toLowerCase().trim();
  if (!e) return null;
  if (e.startsWith('min') || e === 'none') return 'minimal';
  if (e.startsWith('low')) return 'low';
  if (e.startsWith('med') || e === 'default' || e === 'standard') return 'medium';
  if (e.startsWith('high')) return 'high';
  if (e.startsWith('max') || e.startsWith('ultra') || e === 'xhigh') return 'max';
  return null;
}

export function modelChip(model: string): HTMLElement {
  const chip = document.createElement('span');
  chip.className = `chip model ${modelFamily(model)}`;
  chip.textContent = modelMark(model);
  chip.title = `Model: ${model}`;
  return chip;
}

/**
 * A five-bar meter, one bar per level. Unknown effort strings still render, labelled but empty,
 * rather than vanishing — a missing badge would read as "no effort setting"
 * when it actually means "we could not interpret what the agent reported".
 */
export function effortChip(effort: string): HTMLElement {
  const level = effortLevel(effort);
  // One bar per level, so the lowest setting still shows a filled bar and an
  // empty meter means only "not understood".
  const filled = level ? EFFORT_ORDER.indexOf(level) + 1 : 0;

  const chip = document.createElement('span');
  chip.className = `chip effort${level ? ` lv-${level}` : ' unknown'}`;
  chip.title = `Thinking effort: ${effort}`;

  const meter = document.createElement('span');
  meter.className = 'meter';
  for (let i = 0; i < EFFORT_ORDER.length; i++) {
    const bar = document.createElement('span');
    bar.className = 'bar' + (i < filled ? ' on' : '');
    meter.append(bar);
  }
  chip.append(meter);
  return chip;
}
