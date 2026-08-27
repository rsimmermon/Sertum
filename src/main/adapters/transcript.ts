import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind } from '../../shared/types';

/** Only the tail is read: transcripts reach megabytes. */
const TAIL_BYTES = 96 * 1024;

export interface TranscriptSummary {
  lastAssistant: string | null;
  lastUser: string | null;
  updatedAt: number | null;
  path: string | null;
}

const EMPTY: TranscriptSummary = {
  lastAssistant: null,
  lastUser: null,
  updatedAt: null,
  path: null,
};

/**
 * Describes what a session is doing by reading its own transcript.
 *
 * This is what lets a session we did not spawn still be summarised: the
 * transcript is on disk regardless of which terminal owns the process. Both
 * agents write JSONL, so only the record shape and file location differ.
 */
export function summarizeSession(
  agent: AgentKind,
  opts: { sessionId?: string | null; cwd?: string | null },
): TranscriptSummary {
  const file =
    agent === 'codex'
      ? findCodexTranscript(opts.sessionId ?? null, opts.cwd ?? null)
      : findClaudeTranscript(opts.sessionId ?? null, opts.cwd ?? null);
  if (!file) return EMPTY;

  const tail = readTail(file);
  if (!tail) return EMPTY;

  const extract = agent === 'codex' ? extractCodex : extractClaude;
  let lastAssistant: string | null = null;
  let lastUser: string | null = null;

  for (let i = tail.lines.length - 1; i >= 0; i--) {
    const line = tail.lines[i].trim();
    if (!line || !line.startsWith('{')) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const got = extract(rec);
    if (!got?.text) continue;
    if (got.role === 'assistant' && !lastAssistant) {
      lastAssistant = oneLine(got.text);
    }
    if (got.role === 'user' && !lastUser) lastUser = oneLine(got.text);
    if (lastAssistant && lastUser) break;
  }

  return { lastAssistant, lastUser, updatedAt: tail.mtime, path: file };
}

// ----------------------------------------------------------- record shapes

type Extracted = { role: 'user' | 'assistant'; text: string } | null;

/** Claude writes `{ message: { role, content } }` per line. */
function extractClaude(rec: Record<string, unknown>): Extracted {
  const msg = rec.message as Record<string, unknown> | undefined;
  if (!msg) return null;
  const role = msg.role;
  if (role !== 'user' && role !== 'assistant') return null;
  const text = joinText(msg.content);
  // Shell echoes are wrapped in bash-* tags and are not user intent.
  if (role === 'user' && /^<bash-/.test(text)) return null;
  return { role, text };
}

/** Codex writes `{ type: 'response_item', payload: { role, content } }`. */
function extractCodex(rec: Record<string, unknown>): Extracted {
  if (rec.type !== 'response_item') return null;
  const payload = rec.payload as Record<string, unknown> | undefined;
  if (!payload || payload.type !== 'message') return null;
  const role = payload.role;
  // `developer` records are injected instructions, not conversation.
  if (role !== 'user' && role !== 'assistant') return null;
  return { role, text: joinText(payload.content) };
}

function joinText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (!c || typeof c !== 'object') return '';
      const o = c as Record<string, unknown>;
      return typeof o.text === 'string' ? o.text : '';
    })
    .filter(Boolean)
    .join(' ');
}

// -------------------------------------------------------------- locating

function findClaudeTranscript(
  sessionId: string | null,
  cwd: string | null,
): string | null {
  // No session id: fall back to the newest transcript recorded for this cwd.
  if (!sessionId) {
    if (!cwd) return null;
    const dir = path.join(
      os.homedir(),
      '.claude',
      'projects',
      cwd.replace(/[/\\:]/g, '-'),
    );
    const newest = safeReaddir(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(dir, f))
      .map((f) => {
        try {
          return { f, m: fs.statSync(f).mtimeMs };
        } catch {
          return { f, m: 0 };
        }
      })
      .sort((a, b) => b.m - a.m)[0];
    return newest?.f ?? null;
  }
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (cwd) {
    const guess = path.join(root, cwd.replace(/[/\\:]/g, '-'), `${sessionId}.jsonl`);
    if (isFile(guess)) return guess;
  }
  for (const dir of safeReaddir(root)) {
    const candidate = path.join(root, dir, `${sessionId}.jsonl`);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Codex files are `sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. When the
 * session id is unknown -- process-scan discovery cannot know it -- the newest
 * rollout whose recorded cwd matches is the best available answer.
 */
function findCodexTranscript(
  sessionId: string | null,
  cwd: string | null,
): string | null {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const files = walkJsonl(root, 400);
  if (files.length === 0) return null;

  if (sessionId) {
    const exact = files.find((f) => f.includes(sessionId));
    if (exact) return exact;
  }
  if (!cwd) return files[0] ?? null;

  for (const file of files) {
    if (recordedCwd(file) === cwd) return file;
  }
  return null;
}

/** Reads the leading `session_meta` / `turn_context` to learn a rollout's cwd. */
function recordedCwd(file: string): string | null {
  for (const line of headLines(file)) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // One unparseable record must not abandon the file: the cwd may well be
      // on the next line.
      continue;
    }
    const payload = rec.payload as Record<string, unknown> | undefined;
    const c = payload?.cwd;
    if (typeof c === 'string') return c;
  }
  return null;
}

/**
 * Complete JSONL records from the head of a file.
 *
 * The window is generous because Codex embeds its full base instructions in
 * the opening `session_meta` record, which routinely runs past 20KB. Reading
 * a smaller head yields exactly one truncated line and nothing parseable --
 * which silently broke matching a Codex rollout to its folder, and with it
 * every model, effort and context readout for Codex sessions.
 *
 * Only the head is read, never the whole file: transcripts reach megabytes.
 */
function headLines(file: string, maxBytes = 256 * 1024): string[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buf, 0, maxBytes, 0);
    const lines = buf.toString('utf8', 0, read).split('\n');
    // A slice that filled the buffer almost certainly ends mid-record.
    if (read === maxBytes) lines.pop();
    return lines.filter((line) => line.startsWith('{'));
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  }
}

/** Newest-first, bounded so a large history cannot stall discovery. */
function walkJsonl(root: string, limit: number): string[] {
  const out: Array<{ file: string; mtime: number }> = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop()!;
    for (const entry of safeReaddirEnt(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith('.jsonl')) {
        try {
          out.push({ file: full, mtime: fs.statSync(full).mtimeMs });
        } catch {
          // Vanished between listing and stat.
        }
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).map((o) => o.file);
}

// ---------------------------------------------------------------- helpers

function readTail(file: string): { lines: string[]; mtime: number } | null {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    try {
      const len = stat.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return { lines: buf.toString('utf8').split('\n'), mtime: stat.mtimeMs };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}
function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
function safeReaddir(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}
function safeReaddirEnt(p: string): fs.Dirent[] {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Locates a transcript when the agent never told us where it is.
 *
 * Codex spawns no hooks, so the only link back to its rollout file is the
 * working directory it recorded. Claude sessions normally arrive with an
 * explicit path and skip this.
 */
/**
 * The transcript for a session this app did not start.
 *
 * Deliberately carries no freshness guard, unlike findTranscriptForCwd. A
 * monitored session began before we ever saw it, and its `startedAt` records
 * the moment we adopted it -- so the guard that stops an owned session from
 * inheriting a previous run's transcript would reject every monitored one,
 * including the transcript that genuinely belongs to it.
 *
 * When discovery supplies a real agent session id the match is exact; the cwd
 * is only a fallback for the discoverers that cannot.
 */
export function findTranscriptForSession(
  agent: AgentKind,
  sessionId: string | null,
  cwd: string | null,
): string | null {
  return agent === 'codex'
    ? findCodexTranscript(sessionId, cwd)
    : findClaudeTranscript(sessionId, cwd);
}

export function findTranscriptForCwd(
  agent: AgentKind,
  cwd: string,
  startedAt?: number,
): string | null {
  if (!cwd) return null;
  const file =
    agent === 'codex'
      ? findCodexTranscript(null, cwd)
      : findClaudeTranscript(null, cwd);
  if (!file) return null;

  // A transcript last written before this session began belongs to a previous
  // run in the same folder, not to us.
  if (startedAt) {
    try {
      if (fs.statSync(file).mtimeMs < startedAt) return null;
    } catch {
      return null;
    }
  }
  return file;
}
