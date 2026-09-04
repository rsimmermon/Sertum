import type { ChatItem, MessageFormat } from '../../shared/types';

/**
 * Telling markdown from prose, and telling a rendered answer from one where
 * the markup itself is what was asked for.
 *
 * Stage 1 rendered every message as plain text on the principle that
 * inventing formatting the agent did not send is the same class of mistake as
 * inventing a commit message. That principle stands; what was wrong was the
 * conclusion. Agents emit `##`, `-` and fenced blocks *deliberately* — that
 * markup is theirs, not ours — so showing it as literal characters is the
 * same misrepresentation pointed the other way. Rendering it is reading what
 * the agent wrote; the mistake would be adding structure to text that has
 * none.
 *
 * Two honest signals decide it, and both are read from the transcript — the
 * agent's own words and the user's — never from terminal pixels:
 *
 *  - **The message's syntax**, which says whether rendering would change
 *    anything at all. No constructs means no decision to make.
 *  - **The request the turn is answering**, which says whether the markup is
 *    the subject rather than the presentation. "Give me the markdown for a
 *    table" wants characters; "summarise this" wants a summary.
 *
 * Neither signal is load-bearing, and that is deliberate: a guess about
 * intent will sometimes be wrong, so every classified message carries a
 * toggle in the chat view. The classifier picks the opening position, not the
 * final answer.
 */

/**
 * Block constructs whose rendering differs from the characters as written.
 * `\r?` guards the line ends because JavaScript's multiline `$` does not
 * treat a carriage return as one, and transcripts do carry CRLF.
 */
const BLOCK_SYNTAX: RegExp[] = [
  /^ {0,3}(?:```|~~~)/m, // a fenced code block
  /^ {0,3}#{1,6}[ \t]+\S/m, // an ATX heading
  /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+\S/m, // a list item
  /^ {0,3}>[ \t]*\S/m, // a block quote
  /^ {0,3}(?:\*[ \t]*){3,}\r?$/m, // a thematic break
  /^ {0,3}(?:-[ \t]*){3,}\r?$/m,
  /^ {0,3}(?:_[ \t]*){3,}\r?$/m,
  /^ {0,3}\|.*\|[ \t]*\r?\n {0,3}\|?[ \t]*:?-{2,}/m, // a table's delimiter row
  /^ {0,3}\[\^[^\]\s]+\]:/m, // a footnote definition
];

/**
 * Inline constructs. Each requires a non-space next to its delimiters, and
 * the underscore forms additionally require a non-word character outside
 * them, so `snake_case_names` and arithmetic like `a * b * c` are prose.
 */
const INLINE_SYNTAX: RegExp[] = [
  /`[^`\n]+`/, // a code span
  /\*\*\S(?:[^\n]*\S)?\*\*/, // strong
  /(?<![A-Za-z0-9_])__\S(?:[^\n]*\S)?__(?![A-Za-z0-9_])/,
  /(?<![*\w])\*\S(?:[^*\n]*\S)?\*(?![*\w])/, // emphasis
  /(?<![A-Za-z0-9_])_\S(?:[^_\n]*\S)?_(?![A-Za-z0-9_])/,
  /~~\S(?:[^\n]*\S)?~~/, // strikethrough
  /!?\[[^\]\n]*\]\([^()\s]+(?:[ \t]+"[^"\n]*")?\)/, // a link or image
];

/** Whether rendering this text would show anything the characters do not. */
export function hasMarkdown(text: string): boolean {
  return (
    BLOCK_SYNTAX.some((rule) => rule.test(text)) ||
    INLINE_SYNTAX.some((rule) => rule.test(text))
  );
}

/**
 * Markdown named as the artifact being produced, or the source asked for in
 * so many words. Deliberately narrow: "in markdown", "using markdown" and
 * "with markdown formatting" name a house style rather than a deliverable,
 * and none of these match them.
 */
const SOURCE_REQUEST: RegExp[] = [
  /\braw\s+(?:markdown|md)\b/i,
  /\b(?:markdown|md)\s+(?:source|syntax|code|snippet|block|text)\b/i,
  /\bmarkdown\s+(?:for|of|behind)\b/i,
  /\b(?:the|this|that|your|its)\s+markdown\b/i,
  /\bmarkdown\s+(?:file|document|table|list|link|heading|image|cheat\s?sheet)\b/i,
  /\bshow\s+(?:me\s+)?(?:the\s+)?raw\b/i,
  /\bas\s+(?:plain|raw)\s+text\b/i,
  /\bverbatim\b/i,
  /\bescape[sd]?\s+the\s+markdown\b/i,
  /\b(?:un|non-?)\s*rendered\b/i,
  /\b(?:do(?:es)?\s*n(?:o|')?t|never)\s+render\b/i,
  /\bwithout\s+rendering\b/i,
];

/**
 * A request to see it rendered settles the question by itself, so it is asked
 * first — otherwise "render the markdown" would be read as a request for the
 * source by the phrase it contains. The negated forms are excluded here and
 * matched by `SOURCE_REQUEST` above, so the two lists agree rather than
 * competing for precedence.
 */
const RENDER_VERB = /\brender(?:ed|s|ing)?\b/i;
const NEGATED_RENDER =
  /\b(?:do(?:es)?\s*n(?:o|')?t|never|without|un|non-?)[\s-]*render(?:ed|s|ing)?\b/i;

/** Whether the turn asked for the markup itself rather than what it produces. */
export function wantsMarkdownSource(request: string): boolean {
  if (!request) return false;
  if (RENDER_VERB.test(request) && !NEGATED_RENDER.test(request)) return false;
  return SOURCE_REQUEST.some((rule) => rule.test(request));
}

export function classifyMessage(text: string, request: string): MessageFormat {
  if (!hasMarkdown(text)) return 'text';
  return wantsMarkdownSource(request) ? 'markdown-source' : 'markdown';
}

/**
 * Stamp every assistant message with how it should be shown, reading each
 * against the request it answers.
 *
 * Runs once per transcript change, inside the snapshot the conversation cache
 * keys on size and mtime, so the 1s poll costs nothing.
 *
 * A user's own message is never classified. They typed those characters into
 * the composer, and handing them back reformatted hides what was actually
 * sent — the one place where showing the text as written is unarguable.
 */
export function classifyMessages(items: ChatItem[]): void {
  let request = '';
  for (const item of items) {
    if (item.kind !== 'message') continue;
    if (item.role === 'user') {
      request = item.text;
      continue;
    }
    item.format = classifyMessage(item.text, request);
  }
}
