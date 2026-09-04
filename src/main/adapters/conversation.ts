import fs from 'node:fs';
import type {
  AgentKind,
  ChatItem,
  ConversationSnapshot,
} from '../../shared/types';
import { classifyMessages } from './markdown-format';

/**
 * Reads a session's transcript as a conversation.
 *
 * This widens plane 2 from status to content without adding a channel: the
 * transcript is the agent's own account of what was said, on disk regardless
 * of who owns the process, which is what lets the chat view work for adopted
 * sessions the headless route never will. Nothing here reads terminal pixels,
 * and nothing here writes — input stays with the PTY.
 *
 * Record shapes are verified against real files on disk (Claude Code 2.1.252,
 * codex-cli 0.151.0, Grok CLI on Windows 11), not assumed from documentation:
 *
 *   Claude  `{ type: 'user'|'assistant', message: { role, content } }` with
 *           content blocks `text` / `thinking` / `tool_use` / `tool_result`,
 *           `isMeta` marking injected records and `isSidechain` subagents.
 *   Codex   `{ type: 'response_item', payload }` with payload types
 *           `message` (roles user/assistant/developer), `function_call`,
 *           `custom_tool_call`, their `*_output` twins paired by `call_id`,
 *           and `reasoning` carrying a summary.
 *   Grok    the role is the record's own `type`; assistant records carry
 *           `tool_calls`, results arrive as `tool_result` records paired by
 *           `tool_call_id`, and `synthetic_reason` marks injected context.
 */

/**
 * Read complete transcripts until they become genuinely exceptional. Image
 * tools embed multi-megabyte data URLs in one JSONL record, so a small byte
 * tail can never promise even one complete turn.
 */
const TRANSCRIPT_CAP = 32 * 1024 * 1024;

/** Prose is capped high — losing the end of an answer defeats the view. */
const TEXT_CAP = 24_000;

/** Tool payloads are capped low: they are context, not the conversation. */
const TOOL_CAP = 2_000;

/** Ceiling on rendered items, so a chatty turn cannot swamp the renderer. */
const ITEM_CAP = 400;

const conversationCache = new Map<
  string,
  { size: number; mtime: number; snapshot: ConversationSnapshot }
>();

export function noConversation(reason: string): ConversationSnapshot {
  return { items: [], path: null, updatedAt: null, truncated: false, reason };
}

export function readConversation(
  agent: AgentKind,
  file: string,
): ConversationSnapshot {
  // Claude names its transcript in the first hook payload before the file
  // exists, so "not there yet" is the young session's normal state, not an
  // error.
  if (!fs.existsSync(file)) {
    return noConversation(
      'No transcript yet — the conversation appears once the agent records its first turn.',
    );
  }
  const cacheKey = `${agent}\0${file}`;
  try {
    const stat = fs.statSync(file);
    const cached = conversationCache.get(cacheKey);
    if (cached?.size === stat.size && cached.mtime === stat.mtimeMs) {
      return cached.snapshot;
    }
  } catch {
    return noConversation('The transcript could not be read.');
  }
  const tail = readTail(file);
  if (!tail) {
    return noConversation('The transcript could not be read.');
  }

  let items: ChatItem[];
  switch (agent) {
    case 'codex':
      items = parseCodex(tail.records);
      break;
    case 'grok':
      items = parseGrok(tail.records);
      break;
    default:
      items = parseClaude(tail.records);
  }

  classifyMessages(items);

  const truncated = tail.truncated || items.length > ITEM_CAP;
  if (items.length > ITEM_CAP) items = items.slice(items.length - ITEM_CAP);

  const snapshot: ConversationSnapshot = {
    items,
    path: file,
    updatedAt: tail.mtime,
    truncated,
    reason: items.length
      ? null
      : 'Nothing conversational in the transcript yet.',
  };
  try {
    conversationCache.set(cacheKey, {
      size: fs.statSync(file).size,
      mtime: tail.mtime,
      snapshot,
    });
  } catch {
    // It changed or vanished after the read; the next poll will retry.
  }
  return snapshot;
}

// ------------------------------------------------------------------ Claude

/**
 * Machine content Claude wraps in tags on user records: shell echoes, slash
 * command envelopes, system reminders. Matched by opener rather than by a
 * blanket "starts with <", so a user who pastes XML still shows up.
 */
const CLAUDE_MACHINE_TEXT =
  /^\s*<(local-command|command-|bash-|system-reminder|task-notification|user-memory)/;

function parseClaude(records: Array<Record<string, unknown>>): ChatItem[] {
  const items: ChatItem[] = [];
  const toolsById = new Map<string, ChatItem & { kind: 'tool' }>();

  for (const rec of records) {
    if (rec.type !== 'user' && rec.type !== 'assistant') continue;
    // Injected context and subagent traffic are not the conversation.
    if (rec.isMeta === true || rec.isSidechain === true) continue;
    const msg = rec.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    const role = msg.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const at = parseTime(rec.timestamp);

    const content = msg.content;
    if (typeof content === 'string') {
      pushMessage(items, role, content, at, CLAUDE_MACHINE_TEXT);
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue;
      const block = raw as Record<string, unknown>;
      switch (block.type) {
        case 'text':
          if (typeof block.text === 'string') {
            pushMessage(items, role, block.text, at, CLAUDE_MACHINE_TEXT);
          }
          break;
        case 'thinking':
          if (typeof block.thinking === 'string' && block.thinking.trim()) {
            items.push({ kind: 'thinking', text: cap(block.thinking, TEXT_CAP), at });
          }
          break;
        case 'tool_use': {
          const tool: ChatItem & { kind: 'tool' } = {
            kind: 'tool',
            name: typeof block.name === 'string' ? block.name : 'tool',
            detail: claudeToolDetail(block.input),
            output: null,
            at,
          };
          if (typeof block.id === 'string') toolsById.set(block.id, tool);
          items.push(tool);
          break;
        }
        case 'tool_result': {
          // Paired by the call's own id. A result whose call scrolled out of
          // the tail window has nowhere honest to land, so it is dropped.
          const id = block.tool_use_id;
          const tool = typeof id === 'string' ? toolsById.get(id) : undefined;
          if (tool) {
            tool.output = cap(joinBlockText(block.content), TOOL_CAP);
            pushImages(items, block.content, tool.name, at);
          }
          break;
        }
      }
    }
  }
  return items;
}

/**
 * The one field of a tool's input a person would read: the command for Bash,
 * the path for an edit. Falls back to the whole input as JSON, capped.
 */
function claudeToolDetail(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']) {
    if (typeof o[key] === 'string' && o[key]) return cap(o[key] as string, TOOL_CAP);
  }
  try {
    const json = JSON.stringify(input);
    return json === '{}' ? null : cap(json, TOOL_CAP);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- Codex

/** Codex wraps every injection it makes in a named tag on a user record. */
const CODEX_MACHINE_TEXT =
  /^\s*<(environment_context|user_instructions|skills_instructions|turn_aborted|permissions|collaboration_mode|AGENTS)/;

function parseCodex(records: Array<Record<string, unknown>>): ChatItem[] {
  const items: ChatItem[] = [];
  const toolsByCall = new Map<string, ChatItem & { kind: 'tool' }>();

  for (const rec of records) {
    if (rec.type !== 'response_item') continue;
    const p = rec.payload as Record<string, unknown> | undefined;
    if (!p) continue;
    const at = parseTime(rec.timestamp);

    switch (p.type) {
      case 'message': {
        const role = p.role;
        // `developer` records are injected instructions, not conversation.
        if (role !== 'user' && role !== 'assistant') break;
        pushMessage(items, role, joinBlockText(p.content), at, CODEX_MACHINE_TEXT);
        break;
      }
      case 'function_call':
      case 'custom_tool_call': {
        const detail = p.type === 'function_call' ? p.arguments : p.input;
        const tool: ChatItem & { kind: 'tool' } = {
          kind: 'tool',
          name: typeof p.name === 'string' ? p.name : 'tool',
          detail: typeof detail === 'string' && detail ? cap(detail, TOOL_CAP) : null,
          output: null,
          at,
        };
        if (typeof p.call_id === 'string') toolsByCall.set(p.call_id, tool);
        items.push(tool);
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const id = p.call_id;
        const tool = typeof id === 'string' ? toolsByCall.get(id) : undefined;
        if (tool) {
          tool.output = cap(joinBlockText(p.output), TOOL_CAP);
          pushImages(items, p.output, tool.name, at);
        }
        break;
      }
      case 'reasoning': {
        const text = joinSummaryText(p.summary);
        if (text) items.push({ kind: 'thinking', text: cap(text, TEXT_CAP), at });
        break;
      }
    }
  }
  return items;
}

// -------------------------------------------------------------------- Grok

function parseGrok(records: Array<Record<string, unknown>>): ChatItem[] {
  const items: ChatItem[] = [];
  const toolsByCall = new Map<string, ChatItem & { kind: 'tool' }>();

  for (const rec of records) {
    // Grok stamps the context it injects; the environment preamble is the
    // one unmarked injection, identified by the tag it opens with.
    if (typeof rec.synthetic_reason === 'string' && rec.synthetic_reason) {
      continue;
    }
    // No timestamps anywhere in Grok's chat history: `at` stays null.
    switch (rec.type) {
      case 'user': {
        const text = joinBlockText(rec.content).trim();
        if (!text || text.startsWith('<user_info>')) break;
        items.push({
          kind: 'message',
          role: 'user',
          text: cap(unwrapUserQuery(text), TEXT_CAP),
          at: null,
          format: 'text',
        });
        break;
      }
      case 'assistant': {
        const text = joinBlockText(rec.content).trim();
        if (text) {
          items.push({
            kind: 'message',
            role: 'assistant',
            text: cap(text, TEXT_CAP),
            at: null,
            format: 'text',
          });
        }
        if (Array.isArray(rec.tool_calls)) {
          for (const raw of rec.tool_calls) {
            if (!raw || typeof raw !== 'object') continue;
            const call = raw as Record<string, unknown>;
            const tool: ChatItem & { kind: 'tool' } = {
              kind: 'tool',
              name: typeof call.name === 'string' ? call.name : 'tool',
              detail:
                typeof call.arguments === 'string' && call.arguments
                  ? cap(call.arguments, TOOL_CAP)
                  : null,
              output: null,
              at: null,
            };
            if (typeof call.id === 'string') toolsByCall.set(call.id, tool);
            items.push(tool);
          }
        }
        break;
      }
      case 'tool_result': {
        const id = rec.tool_call_id;
        const tool = typeof id === 'string' ? toolsByCall.get(id) : undefined;
        if (tool) {
          tool.output = cap(joinBlockText(rec.content), TOOL_CAP);
          pushImages(items, rec.content, tool.name, null);
        }
        break;
      }
      case 'reasoning': {
        const text = joinSummaryText(rec.summary);
        if (text) items.push({ kind: 'thinking', text: cap(text, TEXT_CAP), at: null });
        break;
      }
    }
  }
  return items;
}

/** Grok wraps what the user typed; the tags are ours to strip, not to show. */
function unwrapUserQuery(text: string): string {
  const open = '<user_query>';
  const close = '</user_query>';
  if (!text.startsWith(open)) return text;
  const end = text.lastIndexOf(close);
  const inner = end === -1 ? text.slice(open.length) : text.slice(open.length, end);
  return inner.trim();
}

// ----------------------------------------------------------------- helpers

function pushMessage(
  items: ChatItem[],
  role: 'user' | 'assistant',
  text: string,
  at: number | null,
  machine: RegExp,
): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  if (role === 'user' && machine.test(trimmed)) return;
  // `format` is the parsers' placeholder: telling markdown from prose needs
  // the request a message answers, which only exists once the whole list is
  // built. `classifyMessages` fills it in there.
  items.push({ kind: 'message', role, text: cap(trimmed, TEXT_CAP), at, format: 'text' });
}

/** Text out of a content field that is a string or a list of text blocks. */
function joinBlockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (!c || typeof c !== 'object') return '';
      const o = c as Record<string, unknown>;
      return typeof o.text === 'string' ? o.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Codex and Grok reasoning summaries: a list of blocks carrying `text`. */
function joinSummaryText(summary: unknown): string {
  return joinBlockText(summary).trim();
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function cap(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Only structured image fields become previews; prose is never treated as a URL. */
function pushImages(
  items: ChatItem[],
  value: unknown,
  toolName: string,
  at: number | null,
): void {
  for (const src of imageDataUrls(value)) {
    items.push({ kind: 'image', src, alt: `${toolName} output`, at });
  }
}

function imageDataUrls(value: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const object = node as Record<string, unknown>;
    const url = object.image_url;
    if (
      typeof url === 'string' &&
      /^data:image\/(png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(url)
    ) {
      found.push(url);
    }
    for (const child of Object.values(object)) visit(child);
  };
  visit(value);
  return [...new Set(found)];
}

function readTail(
  file: string,
): { records: Array<Record<string, unknown>>; mtime: number; truncated: boolean } | null {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - TRANSCRIPT_CAP);
    const fd = fs.openSync(file, 'r');
    let text: string;
    try {
      const len = stat.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const lines = text.split('\n');
    // A read that started mid-file almost certainly opens mid-record.
    if (start > 0) lines.shift();
    const records: Array<Record<string, unknown>> = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        records.push(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        // One unparseable record must not abandon the file.
      }
    }
    return { records, mtime: stat.mtimeMs, truncated: start > 0 };
  } catch {
    return null;
  }
}
