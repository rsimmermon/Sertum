import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type {
  AgentKind,
  ChatItem,
  ConversationItemRead,
  ConversationItemRequest,
  ConversationPageRequest,
  ConversationRead,
  ConversationReadRequest,
  ConversationSnapshot,
  ItemMore,
} from '../../shared/types';
import { classifyMessage } from './markdown-format';

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

/** Prose is capped high — losing the end of an answer defeats the view. */
const TEXT_CAP = 24_000;

/** Tool payloads are capped low: they are context, not the conversation. */
const TOOL_CAP = 2_000;

/** The most items one answer carries, however small they are. */
const PAGE_ITEMS = 200;

/**
 * The most one answer carries in characters. Image items hold their data URL,
 * so a count alone cannot bound a page: 60 items measured 9.32MB on a Codex
 * session with pasted screenshots. One item always goes, whatever its size.
 */
const PAGE_CHARS = 4 * 1024 * 1024;

/**
 * The most of one field that expanding an item sends. Well past anything a person
 * reads in a pane, and it keeps a runaway tool result from becoming one frame.
 */
const FULL_CHARS = 4 * 1024 * 1024;

/** Transcripts are read in slices so a large one never holds the event loop. */
const READ_CHUNK = 1024 * 1024;

/** How much of what was already read must still match before reading on. */
const TAIL_CHECK = 256;

/**
 * A transcript nobody has asked about for this long is dropped and parsed again
 * when next asked. Panes poll only while on screen, and an image-heavy session
 * costs roughly its file size to hold. Versions survive this; see `versionOf`.
 */
const IDLE_MS = 10 * 60_000;

type ToolItem = ChatItem & { kind: 'tool' };

/** Where the whole of a shortened item can be read back from. */
interface ItemSource {
  /** The record that made the item, and which of its new items this one was. */
  body?: { start: number; end: number; ordinal: number };
  /** The record holding a tool's result, and the call it pairs with. */
  output?: { start: number; end: number; callId: string };
}

interface ParseContext {
  items: ChatItem[];
  tools: Map<string, { tool: ToolItem; index: number }>;
  /** Indexes of existing items the current record changed. */
  touched: number[];
  /** Only shortened items have an entry, so this stays small. */
  sources: Map<number, ItemSource>;
  /** The byte range of the record being fed. */
  record: { start: number; end: number };
}

/** One transcript's parsed items, extended as the file grows. */
interface TranscriptStore extends ParseContext {
  agent: AgentKind;
  file: string;
  /** Names this file's content; a client holding another identity starts over. */
  identity: string | null;
  /** Bytes consumed, always at a record boundary. */
  offset: number;
  /** For each item, the end offset of the record that last changed it. */
  revs: number[];
  /** The bytes just before `offset`, to notice a file rewritten in place. */
  tail: Buffer;
  size: number;
  mtime: number;
  /** The last user message, which the next assistant message answers. */
  request: string;
  lastAsked: number;
  syncing: Promise<boolean> | null;
}

const stores = new Map<string, TranscriptStore>();

function freshStore(agent: AgentKind, file: string): TranscriptStore {
  return {
    agent,
    file,
    items: [],
    tools: new Map(),
    touched: [],
    sources: new Map(),
    record: { start: 0, end: 0 },
    identity: null,
    offset: 0,
    revs: [],
    tail: Buffer.alloc(0),
    size: -1,
    mtime: -1,
    request: '',
    lastAsked: Date.now(),
    syncing: null,
  };
}

export function noConversation(reason: string): ConversationSnapshot {
  return {
    items: [],
    start: 0,
    total: 0,
    path: null,
    updatedAt: null,
    reason,
    version: null,
  };
}

/**
 * Where a client has read up to: this content, up to this byte.
 *
 * Both halves are derived from the file rather than from this process, and an
 * item's revision is the offset of the record that last changed it. So parsing
 * the same bytes again, after an idle eviction or a daemon restart, reproduces
 * the same answers, and a reader scrolled back through history keeps their
 * place instead of being sent back to the end.
 */
function versionOf(store: TranscriptStore): string {
  return `${store.identity ?? 'empty'}:${store.offset}`;
}

function parseVersion(version: string): { identity: string; offset: number } | null {
  const cut = version.lastIndexOf(':');
  const offset = Number(version.slice(cut + 1));
  if (cut < 1 || !Number.isSafeInteger(offset)) return null;
  return { identity: version.slice(0, cut), offset };
}

function charsOf(item: ChatItem): number {
  switch (item.kind) {
    case 'message':
    case 'thinking':
      return item.text.length;
    case 'image':
      return item.src.length;
    case 'tool':
      return (item.detail?.length ?? 0) + (item.output?.length ?? 0);
  }
}

function feedAgent(agent: AgentKind, context: ParseContext, rec: Record<string, unknown>): void {
  switch (agent) {
    case 'codex':
      feedCodex(context, rec);
      break;
    case 'grok':
      feedGrok(context, rec);
      break;
    default:
      feedClaude(context, rec);
  }
}

function feedRecord(
  store: TranscriptStore,
  rec: Record<string, unknown>,
  start: number,
  end: number,
): void {
  store.record = { start, end };
  const firstNew = store.revs.length;
  feedAgent(store.agent, store, rec);
  for (let index = firstNew; index < store.items.length; index += 1) {
    const item = store.items[index];
    if (item && item.kind !== 'image' && bodyWasCut(item)) {
      sourceOf(store, index).body = { start, end, ordinal: index - firstNew };
      item.more = 'available';
    }
    // Items are classified as they arrive, each against the request before
    // it, and that request can never change, so neither can a format.
    if (item?.kind === 'message') {
      if (item.role === 'user') store.request = item.text;
      else item.format = classifyMessage(item.text, store.request);
    }
    store.revs.push(end);
  }
  for (const index of store.touched) store.revs[index] = end;
  store.touched.length = 0;
}

/** Parse one line; a line that is not a record is skipped, never fatal. */
function feedLine(store: TranscriptStore, line: Buffer, start: number, end: number): boolean {
  store.identity ??= createHash('sha1')
    .update(store.file)
    .update(line)
    .digest('hex')
    .slice(0, 16);
  const text = line.toString('utf8').trim();
  store.offset = end;
  if (!text.startsWith('{')) return false;
  try {
    feedRecord(store, JSON.parse(text) as Record<string, unknown>, start, end);
    return true;
  } catch {
    return false;
  }
}

/** Read whatever the file has gained. False when it could not be read. */
async function readNewRecords(store: TranscriptStore): Promise<boolean> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(store.file, 'r');
  } catch {
    return false;
  }
  try {
    const stat = await handle.stat();
    if (stat.size === store.size && stat.mtimeMs === store.mtime) return true;

    let intact = stat.size >= store.offset;
    if (intact && store.tail.length) {
      const check = Buffer.alloc(store.tail.length);
      await handle.read(check, 0, check.length, store.offset - check.length);
      intact = check.equals(store.tail);
    }
    if (!intact) {
      // Rewritten in place, so nothing already read can be trusted to line up.
      // The nonce makes this identity differ from the old one even when the
      // first record is the same, which sends every client back to the tail.
      const fresh = freshStore(store.agent, store.file);
      fresh.lastAsked = store.lastAsked;
      const { syncing } = store;
      Object.assign(store, fresh, { syncing });
      store.identity = null;
      rewriteNonces.set(store.file, randomBytes(4).toString('hex'));
    }

    let position = store.offset;
    let lineStart = position;
    let carry: Buffer[] = [];
    const chunk = Buffer.allocUnsafe(READ_CHUNK);
    while (position < stat.size) {
      const want = Math.min(READ_CHUNK, stat.size - position);
      const { bytesRead } = await handle.read(chunk, 0, want, position);
      if (bytesRead === 0) break;
      const view = chunk.subarray(0, bytesRead);
      let from = 0;
      for (;;) {
        const newline = view.indexOf(0x0a, from);
        if (newline === -1) break;
        const end = position + newline + 1;
        const piece = view.subarray(from, newline);
        const line = carry.length ? Buffer.concat([...carry, piece]) : piece;
        carry = [];
        feedLine(store, line, lineStart, end);
        lineStart = end;
        from = newline + 1;
      }
      if (from < bytesRead) carry.push(Buffer.from(view.subarray(from)));
      position += bytesRead;
    }
    // A final line with no newline is either a record still being written or a
    // complete one from a writer that does not end its file with a newline.
    // Only the second parses, so nothing half-written is ever taken as a record.
    if (carry.length) {
      const line = Buffer.concat(carry);
      if (isCompleteRecord(line)) feedLine(store, line, lineStart, lineStart + line.length);
    }
    const nonce = rewriteNonces.get(store.file);
    if (nonce && store.identity && !store.identity.endsWith(nonce)) {
      store.identity = `${store.identity}${nonce}`;
    }

    const tailLength = Math.min(TAIL_CHECK, store.offset);
    store.tail = Buffer.alloc(tailLength);
    await handle.read(store.tail, 0, tailLength, store.offset - tailLength);
    store.size = stat.size;
    store.mtime = stat.mtimeMs;
    return true;
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Files seen rewritten in place; lost on restart, when no client remains either. */
const rewriteNonces = new Map<string, string>();

function isCompleteRecord(line: Buffer): boolean {
  const text = line.toString('utf8').trim();
  if (!text.startsWith('{')) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** The store for this transcript, caught up with the file, or why it is not. */
async function currentStore(
  agent: AgentKind,
  file: string,
): Promise<TranscriptStore | ConversationSnapshot> {
  // Claude names its transcript in the first hook payload before the file
  // exists, so "not there yet" is the young session's normal state, not an
  // error.
  if (!fs.existsSync(file)) {
    return noConversation(
      'No transcript yet — the conversation appears once the agent records its first turn.',
    );
  }
  const now = Date.now();
  for (const [key, held] of stores) {
    if (!held.syncing && now - held.lastAsked > IDLE_MS) stores.delete(key);
  }
  const key = `${agent}\0${file}`;
  let store = stores.get(key);
  if (!store) {
    store = freshStore(agent, file);
    stores.set(key, store);
  }
  store.lastAsked = now;
  // Two panes on one transcript, or a poll overtaking a slow read, share a read
  // rather than racing to feed the same bytes in twice.
  store.syncing ??= readNewRecords(store).finally(() => {
    (store as TranscriptStore).syncing = null;
  });
  const ok = await store.syncing;
  return ok ? store : noConversation('The transcript could not be read.');
}

/** Items `[start, end)`, as one bounded answer. */
function snapshotOf(store: TranscriptStore, start: number, end: number): ConversationSnapshot {
  const total = store.items.length;
  return {
    items: store.items.slice(start, end),
    start,
    total,
    path: store.file,
    updatedAt: store.mtime,
    reason: total ? null : 'Nothing conversational in the transcript yet.',
    version: versionOf(store),
  };
}

/** Walk back from `end` until the page is full. */
function pageEndingAt(store: TranscriptStore, end: number, limit: number): ConversationSnapshot {
  let start = end;
  let chars = 0;
  while (start > 0 && end - start < limit) {
    const item = store.items[start - 1];
    chars += item ? charsOf(item) : 0;
    if (chars > PAGE_CHARS && start < end) break;
    start -= 1;
  }
  return snapshotOf(store, start, end);
}

/** Walk forward from `start` until the page is full. */
function pageStartingAt(store: TranscriptStore, start: number, limit: number): ConversationSnapshot {
  const total = store.items.length;
  let end = Math.min(start, total);
  let chars = 0;
  while (end < total && end - start < limit) {
    const item = store.items[end];
    chars += item ? charsOf(item) : 0;
    if (chars > PAGE_CHARS && end > start) break;
    end += 1;
  }
  return snapshotOf(store, Math.min(start, total), end);
}

/**
 * What a client needs to catch up.
 *
 * With nothing known, or a version from different content, the answer is the
 * newest page. Otherwise it is only what changed: items in the window the client
 * holds whose record moved past its version, and, when it is following the end,
 * whatever arrived. Too much to send at once falls back to the newest page.
 */
export async function readConversation(
  agent: AgentKind,
  file: string,
  request: ConversationReadRequest = {},
): Promise<ConversationRead> {
  const current = await currentStore(agent, file);
  if (!('revs' in current)) return current;
  const store = current;
  const total = store.items.length;
  const newest = (): ConversationSnapshot => pageEndingAt(store, total, PAGE_ITEMS);

  const known = request.known ? parseVersion(request.known) : null;
  if (!known || known.identity !== (store.identity ?? 'empty') || known.offset > store.offset) {
    return newest();
  }
  if (known.offset === store.offset) return { unchanged: true };

  const start = Math.max(0, request.start ?? 0);
  const end = request.follow ? total : Math.min(total, request.end ?? total);
  const changed: Array<{ index: number; item: ChatItem }> = [];
  let chars = 0;
  for (let index = start; index < end; index += 1) {
    if ((store.revs[index] ?? 0) <= known.offset) continue;
    const item = store.items[index];
    if (!item) continue;
    chars += charsOf(item);
    changed.push({ index, item });
    if (changed.length > PAGE_ITEMS || chars > PAGE_CHARS) return newest();
  }
  return {
    delta: true,
    changed,
    total,
    updatedAt: store.mtime,
    version: versionOf(store),
  };
}

/** One bounded page of history, from either direction. */
export async function readConversationPage(
  agent: AgentKind,
  file: string,
  request: ConversationPageRequest,
): Promise<ConversationSnapshot> {
  const current = await currentStore(agent, file);
  if (!('revs' in current)) return current;
  const limit = Math.min(PAGE_ITEMS, Math.max(1, request.limit ?? PAGE_ITEMS));
  return request.before !== undefined
    ? pageEndingAt(current, Math.min(Math.max(0, request.before), current.items.length), limit)
    : pageStartingAt(current, Math.max(0, request.from ?? 0), limit);
}

/**
 * One item with its text whole, for a reader who asked for the rest of it.
 *
 * Only the shortened text is held, because the full text of every tool result in
 * a long conversation is what the window exists to avoid holding. The store keeps
 * which bytes each shortened item came from, and those records go back through
 * the same parsers with the caps off, so what comes back is what the item would
 * have said. It must still begin with what the reader has, or the file has moved
 * under the store and the answer is `stale`.
 */
export async function readConversationItem(
  agent: AgentKind,
  file: string,
  request: ConversationItemRequest,
): Promise<ConversationItemRead> {
  const current = await currentStore(agent, file);
  if (!('revs' in current)) {
    return { reason: current.reason ?? 'The transcript could not be read.' };
  }
  const known = parseVersion(request.known);
  const item = current.items[request.index];
  if (!item || known?.identity !== (current.identity ?? 'empty')) return { stale: true };
  const source = current.sources.get(request.index);
  if (!source) return { item };
  try {
    const whole = await wholeItem(current, item, source);
    return whole ? { item: whole } : { stale: true };
  } catch {
    return { stale: true };
  }
}

async function wholeItem(
  store: TranscriptStore,
  item: ChatItem,
  source: ItemSource,
): Promise<ChatItem | null> {
  let cut = false;
  /** The whole text, if it still starts with what is held; bounded for the wire. */
  const fit = (full: string | null | undefined, held: string): string | null => {
    if (typeof full !== 'string' || !full.startsWith(held.slice(0, -1))) return null;
    if (full.length <= FULL_CHARS) return full;
    cut = true;
    return `${full.slice(0, FULL_CHARS - 1)}…`;
  };
  const made = source.body
    ? (await reparse(store, source.body)).items[source.body.ordinal]
    : undefined;

  if (item.kind === 'message' || item.kind === 'thinking') {
    const text = fit(made?.kind === item.kind ? made.text : null, item.text);
    if (text === null) return null;
    return settled({ ...item, text }, cut);
  }
  if (item.kind !== 'tool') return null;

  let { detail, output } = item;
  if (source.body && detail !== null) {
    detail = fit(made?.kind === 'tool' ? made.detail : null, detail);
    if (detail === null) return null;
  }
  if (source.output && output !== null) {
    const held: ToolItem = { kind: 'tool', name: item.name, detail: null, output: null, at: null };
    await reparse(store, source.output, [source.output.callId, held]);
    output = fit(held.output, output);
    if (output === null) return null;
  }
  return settled({ ...item, detail, output }, cut);
}

/** An item that has been expanded: whole, or as whole as it will get. */
function settled<T extends { more?: ItemMore }>(item: T, cut: boolean): T {
  delete item.more;
  if (cut) item.more = 'too-long';
  return item;
}

/** Run one record back through its parser with the caps off. */
async function reparse(
  store: TranscriptStore,
  range: { start: number; end: number },
  call?: [string, ToolItem],
): Promise<ParseContext> {
  const handle = await fs.promises.open(store.file, 'r');
  const bytes = Buffer.alloc(range.end - range.start);
  try {
    await handle.read(bytes, 0, bytes.length, range.start);
  } finally {
    await handle.close().catch(() => undefined);
  }
  const context: ParseContext = {
    items: [],
    tools: new Map(call ? [[call[0], { tool: call[1], index: 0 }]] : []),
    touched: [],
    sources: new Map(),
    record: range,
  };
  // Synchronous, so no other parse can run while the caps are off.
  capping = false;
  try {
    feedAgent(store.agent, context, JSON.parse(bytes.toString('utf8').trim()) as Record<string, unknown>);
  } finally {
    capping = true;
  }
  return context;
}

// ------------------------------------------------------------------ Claude

/**
 * Machine content Claude wraps in tags on user records: shell echoes, slash
 * command envelopes, system reminders. Matched by opener rather than by a
 * blanket "starts with <", so a user who pastes XML still shows up.
 */
const CLAUDE_MACHINE_TEXT =
  /^\s*<(local-command|command-|bash-|system-reminder|task-notification|user-memory)/;

function feedClaude(context: ParseContext, rec: Record<string, unknown>): void {
  const { items } = context;
  if (rec.type === 'attachment') {
    feedClaudeMidTurnMessage(items, rec);
    return;
  }
  if (rec.type !== 'user' && rec.type !== 'assistant') return;
  // Injected context and subagent traffic are not the conversation.
  if (rec.isMeta === true || rec.isSidechain === true) return;
  const msg = rec.message as Record<string, unknown> | undefined;
  if (!msg) return;
  const role = msg.role;
  if (role !== 'user' && role !== 'assistant') return;
  const at = parseTime(rec.timestamp);

  const content = msg.content;
  if (typeof content === 'string') {
    pushMessage(items, role, content, at, CLAUDE_MACHINE_TEXT);
    return;
  }
  if (!Array.isArray(content)) return;

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
        pushTool(
          context,
          typeof block.id === 'string' ? block.id : null,
          typeof block.name === 'string' ? block.name : 'tool',
          claudeToolDetail(block.input),
          at,
        );
        break;
      }
      case 'tool_result': {
        // Paired by the call's own id. A result with no call on record has
        // nowhere honest to land, so it is dropped.
        const tool = setToolOutput(context, block.tool_use_id, block.content);
        if (tool) pushImages(items, block.content, tool.name, at);
        break;
      }
    }
  }
}

/**
 * A message the user sent while a turn was running. Claude folds it into that
 * turn rather than starting another, and records it as a `queued_command`
 * attachment with no `user` record of its own -- verified against Claude Code
 * 2.1.322 -- so without this it would vanish from the conversation.
 */
function feedClaudeMidTurnMessage(items: ChatItem[], rec: Record<string, unknown>): void {
  if (rec.isSidechain === true) return;
  const attachment = rec.attachment as Record<string, unknown> | undefined;
  if (attachment?.type !== 'queued_command') return;
  if (attachment.commandMode !== undefined && attachment.commandMode !== 'prompt') return;
  const at = parseTime(attachment.timestamp ?? rec.timestamp);
  const prompt = attachment.prompt;
  if (typeof prompt === 'string') {
    pushMessage(items, 'user', prompt, at, CLAUDE_MACHINE_TEXT);
    return;
  }
  if (!Array.isArray(prompt)) return;
  for (const raw of prompt) {
    const block = raw as Record<string, unknown> | null;
    if (block?.type === 'text' && typeof block.text === 'string') {
      pushMessage(items, 'user', block.text, at, CLAUDE_MACHINE_TEXT);
    }
  }
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
  // A question's input has none of those keys, so it used to fall through to
  // the JSON dump below -- which is what an unanswerable question looked like
  // on screen: a wall of `{"questions":[{"question":...` where the reader
  // expected to be asked something. The card above the composer is still
  // where it is *answered*; this line is the transcript's record of it, and it
  // reads as the question either way.
  const asked = questionText(o.questions);
  if (asked) return cap(asked, TOOL_CAP);
  try {
    const json = JSON.stringify(input);
    return json === '{}' ? null : cap(json, TOOL_CAP);
  } catch {
    return null;
  }
}

/**
 * `AskUserQuestion`'s input, read as the questions it asks.
 *
 * Shape-checked rather than trusted: a transcript is data, and a record whose
 * `questions` is not the expected array falls back to the JSON dump rather
 * than to a wrong summary.
 */
function questionText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const asked = value
    .map((q) =>
      q && typeof q === 'object' && typeof (q as Record<string, unknown>).question === 'string'
        ? ((q as Record<string, unknown>).question as string).trim()
        : '',
    )
    .filter(Boolean);
  return asked.length ? asked.join(' · ') : null;
}

// ------------------------------------------------------------------- Codex

/**
 * Codex wraps most injections in a named tag on a user record. A project's
 * AGENTS.md instead arrives under a markdown heading with the path after it.
 */
const CODEX_MACHINE_TEXT =
  /^\s*(?:<(environment_context|user_instructions|skills_instructions|recommended_plugins|turn_aborted|permissions|collaboration_mode|AGENTS)|# AGENTS\.md instructions for )/;

function feedCodex(context: ParseContext, rec: Record<string, unknown>): void {
  const { items } = context;
  if (rec.type !== 'response_item') return;
  const p = rec.payload as Record<string, unknown> | undefined;
  if (!p) return;
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
      pushTool(
        context,
        typeof p.call_id === 'string' ? p.call_id : null,
        typeof p.name === 'string' ? p.name : 'tool',
        typeof detail === 'string' && detail ? cap(detail, TOOL_CAP) : null,
        at,
      );
      break;
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const tool = setToolOutput(context, p.call_id, p.output);
      if (tool) pushImages(items, p.output, tool.name, at);
      break;
    }
    case 'reasoning': {
      const text = joinSummaryText(p.summary);
      if (text) items.push({ kind: 'thinking', text: cap(text, TEXT_CAP), at });
      break;
    }
  }
}

// -------------------------------------------------------------------- Grok

function feedGrok(context: ParseContext, rec: Record<string, unknown>): void {
  const { items } = context;
  // Grok stamps the context it injects; the environment preamble is the
  // one unmarked injection, identified by the tag it opens with.
  if (typeof rec.synthetic_reason === 'string' && rec.synthetic_reason) return;
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
          pushTool(
            context,
            typeof call.id === 'string' ? call.id : null,
            typeof call.name === 'string' ? call.name : 'tool',
            typeof call.arguments === 'string' && call.arguments
              ? cap(call.arguments, TOOL_CAP)
              : null,
            null,
          );
        }
      }
      break;
    }
    case 'tool_result': {
      const tool = setToolOutput(context, rec.tool_call_id, rec.content);
      if (tool) pushImages(items, rec.content, tool.name, null);
      break;
    }
    case 'reasoning': {
      const text = joinSummaryText(rec.summary);
      if (text) items.push({ kind: 'thinking', text: cap(text, TEXT_CAP), at: null });
      break;
    }
  }
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

function pushTool(
  context: ParseContext,
  id: string | null,
  name: string,
  detail: string | null,
  at: number | null,
): void {
  const tool: ToolItem = { kind: 'tool', name, detail, output: null, at };
  if (id) context.tools.set(id, { tool, index: context.items.length });
  context.items.push(tool);
}

/** Pair a result with its call by the agent's own id, recording what moved. */
function setToolOutput(
  context: ParseContext,
  id: unknown,
  content: unknown,
): ToolItem | undefined {
  const entry = typeof id === 'string' ? context.tools.get(id) : undefined;
  if (!entry) return undefined;
  entry.tool.output = cap(joinBlockText(content), TOOL_CAP);
  context.touched.push(entry.index);
  if (wasCut(entry.tool.output, TOOL_CAP)) {
    const { start, end } = context.record;
    sourceOf(context, entry.index).output = { start, end, callId: id as string };
    entry.tool.more = 'available';
  } else {
    // A call answered twice: the later result is the one on screen.
    const source = context.sources.get(entry.index);
    if (source) delete source.output;
    if (!source?.body) delete entry.tool.more;
  }
  return entry.tool;
}

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
  // the request a message answers. `feedRecord` fills it in as items arrive.
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

/** Off only while `reparse` runs a record back through a parser. */
let capping = true;

function cap(text: string, limit: number): string {
  return capping && text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * A text exactly at its limit and ending in the mark. One that merely happens to
 * be costs a button that brings back what is already there.
 */
function wasCut(text: string | null, limit: number): boolean {
  return text !== null && text.length === limit && text.endsWith('…');
}

function bodyWasCut(item: ChatItem & { kind: 'message' | 'thinking' | 'tool' }): boolean {
  return item.kind === 'tool' ? wasCut(item.detail, TOOL_CAP) : wasCut(item.text, TEXT_CAP);
}

function sourceOf(context: ParseContext, index: number): ItemSource {
  let source = context.sources.get(index);
  if (!source) {
    source = {};
    context.sources.set(index, source);
  }
  return source;
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
