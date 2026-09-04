import { render as renderMath } from 'katex';
import 'katex/dist/katex.min.css';

/**
 * Turning an agent's message text into DOM.
 *
 * Two modes, chosen per message by `main/adapters/markdown-format.ts`: the
 * characters as written, or the markdown they spell. Both paths run through
 * here so the rule they share cannot drift apart — **nothing is ever
 * assembled as an HTML string.** Every node is created and every leaf gets
 * its content through `textContent` or a text node, so a transcript can no
 * more inject markup than it could before this file existed. Raw HTML inside
 * a message is therefore shown as the characters the agent wrote, which is
 * both the safe answer and the honest one.
 *
 * What is deliberately not rendered: bare URLs do not become links, and a
 * remote image is not fetched. Both would have the renderer act on an address
 * out of a transcript — the first inventing an affordance the agent did not
 * write, the second making a network request from message text. A markdown
 * image keeps its label and its address instead; only the `data:` images
 * already trusted from structured tool results become pictures.
 */

const api = window.sertum;

/**
 * Render `text` into `target`.
 *
 * With `markdown` false this is the original stage-1 behaviour: text nodes
 * throughout, with only explicit TeX spans typeset.
 */
export function appendMessageText(
  target: HTMLElement,
  text: string,
  markdown: boolean,
  cwd = '',
): void {
  if (!markdown) {
    appendPlain(target, text);
    return;
  }
  // One render's shared state, module-level because footnotes and images need
  // it at the leaves and threading a context through every block and inline
  // function would be plumbing rather than design. Rendering is synchronous
  // and single-threaded, so there is only ever one render in flight; the
  // `finally` is what keeps that true when a leaf throws.
  render = { cwd, notes: new Map(), order: [], refs: new Map(), links: new Map() };
  try {
    const lines = extractNotes(text.replace(/\r\n?/g, '\n').split('\n'));
    appendBlocks(target, lines);
    appendNotes(target);
  } finally {
    render = null;
  }
}

interface RenderState {
  /** The session's own folder, the only place a local image is read from. */
  cwd: string;
  /** Footnote definitions found in this message, by label. */
  notes: Map<string, string[]>;
  /** Labels in order of first reference — which is also their numbering. */
  order: string[];
  /** Every reference element per label, so the definition can point back. */
  refs: Map<string, HTMLElement[]>;
  /** Link definitions, by lower-cased label — `[text][ref]` resolves here. */
  links: Map<string, { href: string; title?: string }>;
}

let render: RenderState | null = null;

// ------------------------------------------------------------------- math

/**
 * KaTeX receives only what is inside the agent's explicit delimiters, with
 * trust disabled. Everything around it stays a text node.
 */
function mathNode(source: string, displayMode: boolean, literal: string): HTMLElement {
  const span = document.createElement(displayMode ? 'div' : 'span');
  span.className = displayMode ? 'chat-math-display' : 'chat-math-inline';
  try {
    renderMath(source.trim(), span, {
      displayMode,
      throwOnError: false,
      trust: false,
      strict: 'ignore',
    });
  } catch {
    span.textContent = literal;
  }
  return span;
}

/**
 * `\[` opens display math in TeX and escapes a bracket in markdown, and both
 * are things an agent writes. Nothing in the delimiters says which, so the
 * content decides: real math carries operators, digits or a backslash macro,
 * and a single token with no spaces is a variable. Prose — `\[not a link\]`
 * — has none of that and is left to the escape rule, which is the important
 * direction: turning a sentence into a typeset equation is a far worse
 * failure than showing one that was meant as math.
 */
function looksLikeMath(source: string): boolean {
  const inner = source.trim();
  if (!inner) return false;
  return /[\\^_{}=+<>|$]/.test(inner) || /\d/.test(inner) || !/\s/.test(inner);
}

/** The plain path: text nodes, plus TeX where the agent asked for it. */
function appendPlain(target: HTMLElement, text: string): void {
  const math = /\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)/g;
  let from = 0;
  for (const match of text.matchAll(math)) {
    const at = match.index;
    if (at > from) target.append(document.createTextNode(text.slice(from, at)));
    const displayMode = match[1] !== undefined;
    const source = match[1] ?? match[2] ?? '';
    target.append(
      looksLikeMath(source)
        ? mathNode(source, displayMode, match[0])
        : document.createTextNode(match[0]),
    );
    from = at + match[0].length;
  }
  if (from < text.length) target.append(document.createTextNode(text.slice(from)));
}

// ----------------------------------------------------------------- blocks

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`\n]*?)[ \t]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TASK = /^\[([ xX])\][ \t]+(.*)$/;
const TABLE_DELIM =
  /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
/** A setext underline: `===` makes the paragraph above it an h1, `---` an h2. */
const SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/;
/** A `$$` alone on a line, opening or closing a display-math block. */
const MATH_FENCE = /^ {0,3}\$\$[ \t]*$/;

function appendBlocks(target: Node, lines: string[]): void {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      i = appendFence(target, lines, i, fence);
      continue;
    }

    // A `$$` on its own line opens display math that runs to the next one.
    // The inline rule cannot see it, because a paragraph reaches the inline
    // pass one line at a time.
    if (MATH_FENCE.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !MATH_FENCE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      const source = body.join('\n');
      target.appendChild(mathNode(source, true, '$$' + source + '$$'));
      if (i < lines.length) i += 1;
      continue;
    }

    // After the fence check, so an indented fence still opens a fence, and
    // before every prose reading.
    if (leadingSpaces(line) >= 4 && !LIST_ITEM.test(line)) {
      i = appendIndentedCode(target, lines, i);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      // The agent's own outline level is kept, so the structure it wrote is
      // the structure a screen reader hears; CSS decides how loud it looks.
      const level = heading[1].length;
      const el = document.createElement(`h${level}`);
      el.className = `chat-md-h chat-md-h${level}`;
      appendInline(el, heading[2]);
      target.appendChild(el);
      i += 1;
      continue;
    }

    // Ahead of the list rule: `- - -` is a break, not a bullet holding "- -".
    if (RULE.test(line)) {
      const hr = document.createElement('hr');
      hr.className = 'chat-md-rule';
      target.appendChild(hr);
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      i = appendQuote(target, lines, i);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      i = appendList(target, lines, i);
      continue;
    }
    if (isTable(lines, i)) {
      i = appendTable(target, lines, i);
      continue;
    }

    const para: string[] = [lines[i].trim()];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !opensBlock(lines, i) &&
      !SETEXT.test(lines[i])
    ) {
      para.push(lines[i].trim());
      i += 1;
    }

    // A setext underline turns the paragraph above it into a heading, and it
    // outranks the thematic-break reading of `---` precisely here, where a
    // paragraph precedes it. Getting this wrong is not a missing feature but
    // a wrong one: the heading became body text *and* a rule appeared that
    // the agent never wrote.
    if (i < lines.length && SETEXT.test(lines[i])) {
      const level = lines[i].trim().startsWith('=') ? 1 : 2;
      const el = document.createElement(`h${level}`);
      el.className = `chat-md-h chat-md-h${level}`;
      appendInline(el, para.join(' '));
      target.appendChild(el);
      i += 1;
      continue;
    }

    const p = document.createElement('p');
    p.className = 'chat-md-p';
    appendSoftLines(p, para);
    target.appendChild(p);
  }
}

/**
 * An indented code block. Four spaces at the top of a block is code, and
 * reading it as a paragraph is not merely plainer — the inline pass then runs
 * over it, so `*ptr` becomes emphasis and the code is altered on screen.
 *
 * A line that is also a list item is left alone: an agent indenting a whole
 * list is far commoner in these transcripts than one relying on indented
 * code at four spaces, and misreading a list as code is the worse trade.
 */
function appendIndentedCode(target: Node, lines: string[], start: number): number {
  const body: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      let peek = i;
      while (peek < lines.length && !lines[peek].trim()) peek += 1;
      if (peek >= lines.length || leadingSpaces(lines[peek]) < 4) break;
      body.push('');
      i += 1;
      continue;
    }
    if (leadingSpaces(line) < 4) break;
    body.push(line.replace(/^(?: {4}|\t)/, ''));
    i += 1;
  }
  const wrap = document.createElement('div');
  wrap.className = 'chat-md-code';
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = body.join('\n');
  pre.appendChild(code);
  wrap.appendChild(pre);
  target.appendChild(wrap);
  return i;
}

function opensBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  return (
    FENCE_OPEN.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    isTable(lines, i)
  );
}

/**
 * A newline the agent wrote inside a paragraph stays a line break. Markdown
 * would reflow it into the surrounding sentence, and reflowing an agent's
 * deliberate line breaks is the kind of invented formatting this view exists
 * to avoid.
 */
function appendSoftLines(el: HTMLElement, lines: string[]): void {
  lines.forEach((line, n) => {
    if (n > 0) el.appendChild(document.createElement('br'));
    // A trailing backslash is markdown's other hard break. The break is
    // already there, so only the backslash itself has to go — it was showing
    // up as a stray character at the end of the line.
    appendInline(el, line.replace(/\\$/, ''));
  });
}

/**
 * A fenced block is shown as code whatever its language — a markdown-tagged
 * fence included, which is the agent declaring that these characters are the
 * subject rather than the presentation. That declaration is the agent's own,
 * so it needs no heuristic behind it.
 */
function appendFence(
  target: Node,
  lines: string[],
  start: number,
  open: RegExpExecArray,
): number {
  const indent = open[1].length;
  const marker = open[2];
  const info = open[3].trim();
  const closer = marker[0] === '~' ? '~' : '`';
  const close = new RegExp(`^ {0,3}${closer}{${marker.length},}[ \\t]*$`);

  const body: string[] = [];
  let i = start + 1;
  while (i < lines.length && !close.test(lines[i])) {
    body.push(lines[i].slice(Math.min(indent, leadingSpaces(lines[i]))));
    i += 1;
  }

  const wrap = document.createElement('div');
  wrap.className = 'chat-md-code';
  if (info) {
    const tag = document.createElement('div');
    tag.className = 'chat-md-code-lang';
    tag.textContent = info;
    wrap.appendChild(tag);
  }
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = body.join('\n');
  pre.appendChild(code);
  wrap.appendChild(pre);
  target.appendChild(wrap);

  // An unclosed fence is the normal state of a block still being written.
  return i < lines.length ? i + 1 : i;
}

function appendQuote(target: Node, lines: string[], start: number): number {
  const body: string[] = [];
  let i = start;
  while (i < lines.length) {
    const marked = QUOTE.exec(lines[i]);
    if (marked) {
      body.push(marked[1]);
      i += 1;
      continue;
    }
    // A lazy continuation line belongs to the quote's last paragraph.
    if (lines[i].trim() && !opensBlock(lines, i)) {
      body.push(lines[i].trim());
      i += 1;
      continue;
    }
    break;
  }
  const el = document.createElement('blockquote');
  el.className = 'chat-md-quote';
  appendBlocks(el, body);
  target.appendChild(el);
  return i;
}

/**
 * A list and everything nested under it. Each item swallows the lines
 * indented beneath it and is parsed as blocks in its own right, so a nested
 * list, a fenced block or a second paragraph inside an item all work by
 * recursion rather than by special cases.
 *
 * The outer loop only ever advances: it skips blank lines looking for the
 * next sibling and stops unless it finds one, and consuming an item always
 * moves past at least that item's own first line.
 */
function appendList(target: Node, lines: string[], start: number): number {
  const first = LIST_ITEM.exec(lines[start]);
  if (!first) return start + 1;
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);

  const list = document.createElement(ordered ? 'ol' : 'ul');
  list.className = 'chat-md-list';
  if (ordered) {
    const from = Number.parseInt(first[2], 10);
    if (Number.isFinite(from) && from !== 1) (list as HTMLOListElement).start = from;
  }

  let i = start;
  while (i < lines.length) {
    let at = i;
    while (at < lines.length && !lines[at].trim()) at += 1;
    if (at >= lines.length) break;
    if (RULE.test(lines[at])) break;
    const marker = LIST_ITEM.exec(lines[at]);
    if (!marker || marker[1].length !== base || ordered !== /\d/.test(marker[2])) break;

    const own: string[] = [marker[3]];
    const inner = base + marker[2].length + 1;
    i = at + 1;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        let peek = i;
        while (peek < lines.length && !lines[peek].trim()) peek += 1;
        if (peek >= lines.length || leadingSpaces(lines[peek]) < inner) break;
        own.push('');
        i += 1;
        continue;
      }
      const nested = LIST_ITEM.exec(line);
      if (nested && nested[1].length <= base) break;
      if (!nested && leadingSpaces(line) < inner && opensBlock(lines, i)) break;
      own.push(line.slice(Math.min(leadingSpaces(line), inner)));
      i += 1;
    }
    list.appendChild(listItem(own));
  }
  target.appendChild(list);
  return i;
}

function listItem(lines: string[]): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'chat-md-item';

  let body = lines;
  const task = TASK.exec(body[0] ?? '');
  if (task) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'chat-md-task';
    box.checked = task[1] !== ' ';
    box.disabled = true;
    li.appendChild(box);
    li.classList.add('is-task');
    body = [task[2], ...body.slice(1)];
  }

  const holder = document.createElement('div');
  appendBlocks(holder, body);
  // A tight item is a single paragraph; unwrapping it keeps items on one line
  // instead of each gaining a paragraph's block spacing.
  const only = holder.childNodes.length === 1 ? holder.firstElementChild : null;
  const source = only?.tagName === 'P' ? only : holder;
  li.append(...Array.from(source.childNodes));
  return li;
}

function isTable(lines: string[], i: number): boolean {
  const head = lines[i];
  const delim = lines[i + 1];
  if (!head || !delim || !head.includes('|')) return false;
  if (!TABLE_DELIM.test(delim) || !delim.includes('-')) return false;
  return splitRow(head).length === splitRow(delim).length;
}

function appendTable(target: Node, lines: string[], start: number): number {
  const head = splitRow(lines[start]);
  const align = splitRow(lines[start + 1]).map(columnAlign);

  const table = document.createElement('table');
  table.className = 'chat-md-table';

  const headRow = document.createElement('tr');
  head.forEach((cell, n) => {
    const th = document.createElement('th');
    const side = align[n];
    if (side) th.style.textAlign = side;
    appendInline(th, cell);
    headRow.appendChild(th);
  });
  const thead = document.createElement('thead');
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  let i = start + 2;
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    const cells = splitRow(lines[i]);
    const tr = document.createElement('tr');
    for (let n = 0; n < head.length; n += 1) {
      const td = document.createElement('td');
      const side = align[n];
      if (side) td.style.textAlign = side;
      appendInline(td, cells[n] ?? '');
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
    i += 1;
  }
  table.appendChild(tbody);

  // Its own scroller: a wide table must not make the whole pane scroll.
  const wrap = document.createElement('div');
  wrap.className = 'chat-md-table-wrap';
  wrap.appendChild(table);
  target.appendChild(wrap);
  return i;
}

function columnAlign(cell: string): string | null {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\' && text[i + 1] === '|') {
      cell += '|';
      i += 1;
      continue;
    }
    if (text[i] === '|') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += text[i];
  }
  cells.push(cell.trim());
  return cells;
}

// -------------------------------------------------------------- footnotes

/*
 * GFM footnotes. A definition is lifted out of the block flow before parsing
 * — it is not a paragraph wherever the agent happened to write it — and the
 * references decide both the numbering and the order, because that is the
 * order a reader meets them in.
 *
 * A reference whose definition is missing stays literal text. Inventing a
 * marker for a note that does not exist would be the same mistake as
 * inventing formatting: better to show exactly what the agent wrote.
 */
const NOTE_DEF = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/;

/**
 * A link definition, the other thing that opens with a bracket and a colon.
 * The label's first character may not be `^`, which is what keeps this from
 * competing with a footnote definition for the same line.
 */
const LINK_DEF =
  /^ {0,3}\[([^\]^][^\]]*|[^\]^])\]:[ \t]*(\S+)(?:[ \t]+"([^"\n]*)")?[ \t]*$/;

/**
 * Pull both kinds of definition out, returning the lines that remain to be
 * parsed. Neither is a paragraph wherever the agent happened to write it.
 */
function extractNotes(lines: string[]): string[] {
  const notes = render?.notes;
  if (!notes) return lines;
  const rest: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const link = LINK_DEF.exec(lines[i]);
    if (link) {
      render?.links.set(link[1].trim().toLowerCase(), {
        href: link[2],
        title: link[3],
      });
      i += 1;
      continue;
    }
    const def = NOTE_DEF.exec(lines[i]);
    if (!def) {
      rest.push(lines[i]);
      i += 1;
      continue;
    }
    const body = [def[2]];
    i += 1;
    // Continuation lines are the ones indented under the definition.
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        let peek = i;
        while (peek < lines.length && !lines[peek].trim()) peek += 1;
        if (peek >= lines.length || leadingSpaces(lines[peek]) < 2) break;
        body.push('');
        i += 1;
        continue;
      }
      if (leadingSpaces(line) < 2 || NOTE_DEF.test(line)) break;
      body.push(line.replace(/^[ \t]{1,4}/, ''));
      i += 1;
    }
    notes.set(def[1], body);
  }
  return rest;
}

/** The number a label carries, assigned on first reference. */
function noteNumber(label: string): number {
  const state = render;
  if (!state) return 0;
  let at = state.order.indexOf(label);
  if (at === -1) {
    at = state.order.length;
    state.order.push(label);
  }
  return at + 1;
}

function noteRefNode(label: string): HTMLElement {
  const sup = document.createElement('sup');
  sup.className = 'chat-md-fnref';
  const mark = document.createElement('button');
  mark.type = 'button';
  mark.className = 'chat-md-fnref-mark';
  mark.textContent = String(noteNumber(label));
  mark.title = 'Jump to the note';
  sup.append(mark);
  const refs = render?.refs;
  if (refs) refs.set(label, [...(refs.get(label) ?? []), sup]);
  return sup;
}

/**
 * The notes themselves, after the message they belong to. Referenced labels
 * come first, in reference order, so the list numbering and the marks agree;
 * a definition nothing referenced is still listed rather than dropped,
 * because it is something the agent wrote.
 */
function appendNotes(target: Node): void {
  const state = render;
  if (!state || state.notes.size === 0) return;

  const labels = [
    ...state.order.filter((l) => state.notes.has(l)),
    ...[...state.notes.keys()].filter((l) => !state.order.includes(l)),
  ];
  if (labels.length === 0) return;

  const list = document.createElement('ol');
  list.className = 'chat-md-notes-list';

  for (const label of labels) {
    const item = document.createElement('li');
    item.className = 'chat-md-note';
    const body = document.createElement('div');
    body.className = 'chat-md-note-body';
    appendBlocks(body, state.notes.get(label) ?? []);
    item.append(body);

    const refs = state.refs.get(label) ?? [];
    for (const ref of refs) {
      const mark = ref.querySelector('button');
      if (mark) mark.onclick = () => reveal(item);
    }
    if (refs.length > 0) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'chat-md-note-back';
      back.textContent = '↩';
      back.title = 'Back to the reference';
      back.onclick = () => reveal(refs[0]);
      item.append(back);
    }
    list.append(item);
  }

  const wrap = document.createElement('div');
  wrap.className = 'chat-md-notes';
  wrap.append(list);
  target.appendChild(wrap);
}

/**
 * Scrolling within the pane rather than navigating: an `href="#id"` would
 * need ids unique across every message on screen and would move the
 * renderer's own URL, and the flash is what says "here" when the target was
 * already in view and nothing scrolled.
 */
function reveal(el: HTMLElement): void {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('is-found');
  // Reading offsetWidth restarts the animation rather than merging with it.
  void el.offsetWidth;
  el.classList.add('is-found');
  setTimeout(() => el.classList.remove('is-found'), 1400);
}

function leadingSpaces(line: string): number {
  const match = /^[ \t]*/.exec(line);
  if (!match) return 0;
  let width = 0;
  for (const ch of match[0]) width += ch === '\t' ? 4 : 1;
  return width;
}

// ----------------------------------------------------------------- inline

/*
 * Sticky patterns, tried in this order at each position. They are sticky
 * rather than sliced-and-anchored because a message runs to 24,000
 * characters and re-slicing the tail once per character is quadratic.
 *
 * Math comes first so a display-math opener is read as the agent's, rather
 * than as a markdown escape of `[`. The escape rule follows, so an escaped
 * asterisk cannot open emphasis. Code spans precede everything that could
 * otherwise be found inside one.
 */
const MATH_DISPLAY = /\\\[([\s\S]*?)\\\]/y;
const MATH_INLINE = /\\\(([\s\S]*?)\\\)/y;
const ESCAPE = /\\([\\`*_{}[\]()#+\-.!|~>])/y;
const CODE_SPAN = /(`+)([\s\S]+?)\1(?!`)/y;
const NOTE_REF = /\[\^([^\]\s]+)\]/y;
const AUTOLINK = /<((?:https?|mailto):[^>\s]+)>/y;
const EMAIL = /<([^\s@<>]+@[^\s@<>.]+\.[^\s@<>]+)>/y;
/*
 * Dollar-delimited TeX, which is what agents actually emit far more often
 * than `\[...\]`. `$$` is unambiguous. A single `$` is not — money looks the
 * same — so it must hug its content, must not be followed by a digit, and
 * must contain a character that belongs to TeX rather than to a price. That
 * last test is deliberately stricter than `looksLikeMath`: a bare digit is
 * enough to call `\(2\)` math, but "$5 and $10" would pass on a digit alone.
 */
const MATH_DOLLARS = /\$\$([\s\S]+?)\$\$/y;
const MATH_DOLLAR = /\$(?!\s)((?:[^$\n\\]|\\.)+?)(?<!\s)\$(?!\d)/y;
const TEX_CHARS = /[\\^_{}=]/;
const STRONG_STAR = /\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/y;
const STRONG_UNDER = /__(?=\S)([\s\S]+?)(?<=\S)__(?![A-Za-z0-9_])/y;
const STRIKE = /~~(?=\S)([\s\S]+?)(?<=\S)~~/y;
const EM_STAR = /\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)/y;
const EM_UNDER = /_(?=\S)([^_\n]+?)(?<=\S)_(?![A-Za-z0-9_])/y;

/** A `data:` image is the one address already trusted from tool results. */
const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

interface Token {
  node: Node;
  length: number;
}

/*
 * Named and numeric character references, decoded by table rather than by
 * letting the platform parse HTML. The result is a text node either way, so
 * this is about keeping the promise at the top of this file literally true:
 * no string in here is ever handed to an HTML parser. A reference that is
 * not in the table stays exactly as the agent wrote it.
 */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', times: '×', divide: '÷',
  deg: '°', plusmn: '±', laquo: '«', raquo: '»',
  bull: '•', middot: '·', dagger: '†', euro: '€',
  pound: '£', yen: '¥', sect: '§', para: '¶',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓',
  harr: '↔', ne: '≠', le: '≤', ge: '≥', infin: '∞',
};

function decodeEntities(text: string): string {
  if (text.indexOf('&') === -1) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function appendInline(target: HTMLElement, text: string): void {
  let plain = '';
  let i = 0;
  const flush = (): void => {
    if (plain) {
      // Only prose is decoded; a code span keeps every character it was
      // given, which is why this is here and not in the leaf node helper.
      target.append(document.createTextNode(decodeEntities(plain)));
      plain = '';
    }
  };
  while (i < text.length) {
    const token = matchInline(text, i);
    if (!token) {
      plain += text[i];
      i += 1;
      continue;
    }
    flush();
    target.append(token.node);
    i += token.length;
  }
  flush();
}

function matchInline(text: string, at: number): Token | null {
  const before = at > 0 ? text[at - 1] : '';

  const display = take(MATH_DISPLAY, text, at);
  if (display && looksLikeMath(display[1])) {
    return { node: mathNode(display[1], true, display[0]), length: display[0].length };
  }
  const inline = take(MATH_INLINE, text, at);
  if (inline && looksLikeMath(inline[1])) {
    return { node: mathNode(inline[1], false, inline[0]), length: inline[0].length };
  }
  const dollars = take(MATH_DOLLARS, text, at);
  if (dollars) {
    return { node: mathNode(dollars[1], true, dollars[0]), length: dollars[0].length };
  }
  const dollar = take(MATH_DOLLAR, text, at);
  if (dollar && TEX_CHARS.test(dollar[1])) {
    return { node: mathNode(dollar[1], false, dollar[0]), length: dollar[0].length };
  }

  const escaped = take(ESCAPE, text, at);
  if (escaped) {
    return { node: document.createTextNode(escaped[1]), length: escaped[0].length };
  }

  const code = take(CODE_SPAN, text, at);
  if (code) {
    const el = document.createElement('code');
    el.className = 'chat-md-code-span';
    el.textContent = trimCodeSpan(code[2]);
    return { node: el, length: code[0].length };
  }

  // Ahead of links, since both open with `[`. A reference with no definition
  // is not a footnote at all and falls through to literal text.
  const note = take(NOTE_REF, text, at);
  if (note && render?.notes.has(note[1])) {
    return { node: noteRefNode(note[1]), length: note[0].length };
  }

  const bracketed = matchLinkOrImage(text, at);
  if (bracketed) return bracketed;

  const auto = take(AUTOLINK, text, at);
  if (auto) {
    return { node: linkNode(auto[1], auto[1], undefined), length: auto[0].length };
  }
  // `<someone@example.com>` is an address, not a tag. It becomes a labelled
  // span rather than an anchor because `shell:open-external` takes http(s)
  // only — but showing the angle brackets was plainly wrong.
  const mail = take(EMAIL, text, at);
  if (mail) {
    return { node: linkNode(mail[1], 'mailto:' + mail[1], undefined), length: mail[0].length };
  }

  const strong =
    take(STRONG_STAR, text, at) ??
    (isWordChar(before) ? null : take(STRONG_UNDER, text, at));
  if (strong) return { node: wrapped('strong', strong[1]), length: strong[0].length };

  const strike = take(STRIKE, text, at);
  if (strike) return { node: wrapped('del', strike[1]), length: strike[0].length };

  // Emphasis must not open mid-word: `2*3*4` is arithmetic and
  // `snake_case_names` are identifiers, in the transcripts this view reads
  // more often than they are anything else.
  if (!isWordChar(before) && before !== '*') {
    const em = take(EM_STAR, text, at);
    if (em) return { node: wrapped('em', em[1]), length: em[0].length };
  }
  if (!isWordChar(before)) {
    const em = take(EM_UNDER, text, at);
    if (em) return { node: wrapped('em', em[1]), length: em[0].length };
  }
  return null;
}

function take(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

/*
 * Links and images are scanned with balanced brackets rather than matched
 * with a regex, because the label of a link can itself contain brackets —
 * and the commonest case of that, an image wrapped in a link
 * (`[![alt](src)](href)`), is exactly what a badge is. A `[^\]]*` label stops
 * at the image's own `]`, which produced a link captioned `![alt` pointing at
 * the image, with the real address left sitting in the text as characters.
 */

/** Index just past the bracket matching the one at `at`, or -1. */
function scanBalanced(text: string, at: number, open: string, close: string): number {
  if (text[at] !== open) return -1;
  let depth = 0;
  for (let i = at; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** A link or an image, inline (`](url)`) or by reference (`][label]`). */
function matchLinkOrImage(text: string, at: number): Token | null {
  const isImage = text[at] === '!';
  const open = isImage ? at + 1 : at;
  if (text[open] !== '[') return null;

  const labelEnd = scanBalanced(text, open, '[', ']');
  if (labelEnd < 0) return null;
  const label = text.slice(open + 1, labelEnd - 1);

  // Inline: the destination follows in parentheses.
  if (text[labelEnd] === '(') {
    const destEnd = scanBalanced(text, labelEnd, '(', ')');
    if (destEnd < 0) return null;
    const inner = text.slice(labelEnd + 1, destEnd - 1).trim();
    const parts = /^(\S*)(?:\s+"([^"]*)")?$/.exec(inner);
    if (!parts) return null;
    const node = isImage
      ? imageNode(label, parts[1], parts[2])
      : linkNode(label, parts[1], parts[2]);
    return { node, length: destEnd - at };
  }

  // By reference: resolved against the definitions lifted out before parsing.
  // One with no definition is not a link at all and stays literal text.
  if (text[labelEnd] === '[') {
    const refEnd = scanBalanced(text, labelEnd, '[', ']');
    if (refEnd < 0) return null;
    const ref = text.slice(labelEnd + 1, refEnd - 1);
    const target = render?.links.get((ref || label).trim().toLowerCase());
    if (!target) return null;
    const node = isImage
      ? imageNode(label, target.href, target.title)
      : linkNode(label, target.href, target.title);
    return { node, length: refEnd - at };
  }
  return null;
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

/** CommonMark strips one space from each end of a padded code span. */
function trimCodeSpan(text: string): string {
  if (text.length > 2 && text.startsWith(' ') && text.endsWith(' ') && text.trim()) {
    return text.slice(1, -1);
  }
  return text;
}

function wrapped(tag: 'strong' | 'em' | 'del', inner: string): HTMLElement {
  const el = document.createElement(tag);
  appendInline(el, inner);
  return el;
}

/**
 * Only http(s) becomes a real link, matching what `shell:open-external`
 * accepts — so the app never draws an affordance that would silently fail.
 * Every other address keeps its label and carries the address in its tooltip,
 * which is where a relative path or a `file:` URL stays readable.
 */
function linkNode(label: string, href: string, title?: string): HTMLElement {
  const external = /^https?:\/\//i.test(href);
  const el = document.createElement(external ? 'a' : 'span');
  el.className = external ? 'chat-md-link' : 'chat-md-link-plain';
  el.title = title || href;
  if (external) {
    (el as HTMLAnchorElement).href = href;
    el.addEventListener('click', (event) => {
      event.preventDefault();
      void api.openExternal(href);
    });
  }
  appendInline(el, label || href);
  return el;
}

function imageNode(alt: string, src: string, title?: string): HTMLElement {
  if (DATA_IMAGE.test(src)) return pictureNode(src, alt, title);

  // A path already resolved becomes a picture *synchronously*, and this is
  // load-bearing rather than an optimisation. The transcript repaints about
  // once a second while a turn runs; rendering a 20px link and then swapping
  // a 400px image into it each time reflowed the whole conversation on every
  // repaint, which a reader part-way up sees as the view lurching backwards
  // again and again. Resolved once, the layout is then stable across
  // repaints.
  const cwd = render?.cwd;
  const known = cwd ? localImages.get(`${cwd}\u0000${src}`) : undefined;
  if (known) return pictureNode(known, alt, title);

  // Otherwise the link is rendered now and upgraded only if the address turns
  // out to name a readable local image. Rendering stays synchronous, and
  // every way the read can fail leaves the link that was already there.
  const el = linkNode(alt || src, src, title);
  el.classList.add('chat-md-image-ref');
  if (known === undefined) upgradeLocalImage(el, alt, src, title);
  return el;
}

function pictureNode(source: string, alt: string, title?: string): HTMLImageElement {
  const img = document.createElement('img');
  img.className = 'chat-md-image';
  img.src = source;
  img.alt = alt;
  img.loading = 'lazy';
  if (title) img.title = title;
  return img;
}

/**
 * Resolved reads, so the once-a-second repaint does not re-read a file per
 * image. A file that changes on disk keeps the bytes the message was first
 * shown with, which is the right answer for a transcript: it records what the
 * agent produced, not what that path holds now.
 */
const localImages = new Map<string, string | null>();
const LOCAL_IMAGE_CACHE_MAX = 64;

function upgradeLocalImage(
  placeholder: HTMLElement,
  alt: string,
  src: string,
  title?: string,
): void {
  const cwd = render?.cwd;
  // A remote address is never read from disk, and without a session folder
  // there is nothing to resolve against.
  if (!cwd || /^https?:\/\//i.test(src)) return;

  const key = `${cwd}\u0000${src}`;
  /*
   * Put the picture in, and pay back the height it took.
   *
   * The first resolve is the one that cannot be synchronous, so it is the one
   * that moves the page. An image growing *above* the reader pushes what they
   * are looking at downwards, which reads as the view jumping back towards
   * the top. Adding the same delta to `scrollTop` leaves their place exactly
   * where it was; an image below them changes nothing they can see, so it is
   * left alone. The adjustment waits for `load`, because the height only
   * changes once the bytes are decoded.
   */
  const swap = (data: string | null): void => {
    if (!data || !placeholder.parentNode) return;
    const found = placeholder.closest('.chat-scroll');
    const host = found instanceof HTMLElement ? found : null;
    const above =
      host !== null &&
      placeholder.getBoundingClientRect().top < host.getBoundingClientRect().top;
    const heightBefore = host ? host.scrollHeight : 0;
    const picture = pictureNode(data, alt, title);
    if (host && above) {
      picture.addEventListener(
        'load',
        () => {
          host.scrollTop += host.scrollHeight - heightBefore;
        },
        { once: true },
      );
    }
    placeholder.replaceWith(picture);
  };
  if (localImages.has(key)) {
    // Still asynchronous, because the placeholder is not in the DOM yet.
    queueMicrotask(() => swap(localImages.get(key) ?? null));
    return;
  }
  void api
    .readLocalImage(cwd, src)
    .then((data) => {
      if (localImages.size >= LOCAL_IMAGE_CACHE_MAX) {
        localImages.delete(localImages.keys().next().value as string);
      }
      localImages.set(key, data);
      swap(data);
    })
    .catch(() => {
      // The link stays exactly as it is.
    });
}
