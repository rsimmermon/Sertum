/**
 * Model and effort badges.
 *
 * These are meant to be read by shape and colour first. A model's family sets
 * the colour, so a glance across the sidebar tells you which agent is which
 * without reading anything; the two-character mark only disambiguates tier and
 * version once you do look. Effort is a four-bar meter rather than a word,
 * because "medium" and "minimal" are indistinguishable at a glance while two
 * filled bars and one are not.
 *
 * Full values stay available in the title attribute — the badge is a summary,
 * never the only place the information exists.
 */

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

/** "claude-opus-5" -> "O5", "gpt-5.6-sol" -> "G5". Two chars, always. */
export function modelMark(model: string): string {
  const family = modelFamily(model);
  const initial: Record<ModelFamily, string> = {
    opus: 'O',
    sonnet: 'S',
    haiku: 'H',
    gpt: 'G',
    gemini: 'M',
    other: '·',
  };
  // First standalone number in the name is the generation.
  const version = /(?:^|[^a-z0-9])(\d+)(?:\.\d+)?/i.exec(model)?.[1] ?? '';
  return (initial[family] + version).slice(0, 3);
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
