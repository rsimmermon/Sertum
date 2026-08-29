import fs from 'node:fs';
import type { AgentKind } from '../../shared/types';

/** Only the tail matters: the newest records carry the current state. */
const TAIL_BYTES = 128 * 1024;

export interface SessionMeta {
  model: string | null;
  effort: string | null;
  /** Tokens occupying the context window on the most recent request. */
  contextTokens: number | null;
  contextLimit: number | null;
}

const EMPTY: SessionMeta = {
  model: null,
  effort: null,
  contextTokens: null,
  contextLimit: null,
};

/**
 * Reads model, effort and context pressure out of a session's transcript.
 *
 * Hooks report effort but not the model or token counts, and the Codex TUI
 * reports nothing to us at all -- but both agents write everything we need to
 * their own transcript, so that is the one source that works for both.
 */
export function readSessionMeta(
  agent: AgentKind,
  transcriptPath: string | null,
): SessionMeta {
  if (!transcriptPath) return EMPTY;
  const lines = readTail(transcriptPath);
  if (!lines) return EMPTY;

  const meta: SessionMeta = { ...EMPTY };
  for (let i = lines.length - 1; i >= 0 && !isComplete(meta); i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (agent === 'codex') applyCodex(rec, meta);
    else if (agent === 'grok') applyGrok(rec, meta);
    else applyClaude(rec, meta);
  }

  if (meta.model && meta.contextLimit === null) {
    meta.contextLimit = contextLimitFor(meta.model);
  }
  return meta;
}

function isComplete(m: SessionMeta): boolean {
  return m.model !== null && m.effort !== null && m.contextTokens !== null;
}

/**
 * Grok stamps the model and effort on every assistant turn.
 *
 * It records no token accounting anywhere -- not in the transcript, not in the
 * event log -- so context pressure stays null and its chip simply does not
 * appear, which is the honest reading of "we do not know" rather than an
 * estimate dressed up as a measurement.
 */
function applyGrok(rec: Record<string, unknown>, meta: SessionMeta): void {
  if (rec.type !== 'assistant') return;
  if (meta.model === null && typeof rec.model_id === 'string') {
    meta.model = rec.model_id;
  }
  if (meta.effort === null && typeof rec.reasoning_effort === 'string') {
    meta.effort = rec.reasoning_effort;
  }
}

function applyClaude(rec: Record<string, unknown>, meta: SessionMeta): void {
  if (meta.effort === null) {
    const effort = rec.effort as Record<string, unknown> | undefined;
    const level = effort?.level;
    if (typeof level === 'string') meta.effort = level;
  }

  const msg = rec.message as Record<string, unknown> | undefined;
  if (!msg || msg.role !== 'assistant') return;

  if (meta.model === null && typeof msg.model === 'string') {
    meta.model = msg.model;
  }

  if (meta.contextTokens === null) {
    const u = msg.usage as Record<string, unknown> | undefined;
    if (u) {
      // The window holds the whole prompt: fresh input plus everything
      // served from or written to cache.
      const total =
        num(u.input_tokens) +
        num(u.cache_read_input_tokens) +
        num(u.cache_creation_input_tokens);
      if (total > 0) meta.contextTokens = total;
    }
  }
}

function applyCodex(rec: Record<string, unknown>, meta: SessionMeta): void {
  const payload = rec.payload as Record<string, unknown> | undefined;
  if (!payload) return;

  if (rec.type === 'turn_context' || rec.type === 'session_meta') {
    if (meta.model === null && typeof payload.model === 'string') {
      meta.model = payload.model;
    }
    const effort = payload.effort ?? payload.reasoning_effort;
    if (meta.effort === null && typeof effort === 'string') meta.effort = effort;
  }

  if (rec.type === 'event_msg' && meta.contextTokens === null) {
    const window = payload.model_context_window;
    if (typeof window === 'number' && meta.contextLimit === null) {
      meta.contextLimit = window;
    }
    const usage = payload.token_usage ?? payload.usage;
    if (usage && typeof usage === 'object') {
      const u = usage as Record<string, unknown>;
      const total = num(u.total_tokens) || num(u.input_tokens);
      if (total > 0) meta.contextTokens = total;
    }
  }
}

/**
 * Context windows by model family. Wrong-but-close is worse than absent here,
 * so an unrecognised model reports no limit rather than a guessed one.
 */
function contextLimitFor(model: string): number | null {
  const m = model.toLowerCase();
  if (/haiku/.test(m)) return 200_000;
  if (/opus-5|opus-4|sonnet-5|sonnet-4-6|fable|mythos/.test(m)) return 1_000_000;
  if (/gpt-5|o[34]/.test(m)) return 400_000;
  if (/sonnet|opus/.test(m)) return 200_000;
  return null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function readTail(file: string): string[] | null {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    try {
      const len = stat.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString('utf8').split('\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * The model an agent will actually use, read from its own configuration.
 *
 * Claude exposes no model field on a live session -- not in `agents --json`,
 * not in hook payloads -- and its transcript is not flushed while the session
 * runs. The configured default is therefore the only truthful source until we
 * pass `--model` ourselves.
 */
export function readConfiguredModel(agent: AgentKind): string | null {
  try {
    if (agent === 'claude') {
      const p = `${process.env.HOME}/.claude/settings.json`;
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
      return typeof raw.model === 'string' ? raw.model : null;
    }
    if (agent === 'codex') {
      const p = `${process.env.HOME}/.codex/config.toml`;
      const raw = fs.readFileSync(p, 'utf8');
      const m = /^\s*model\s*=\s*"([^"]+)"/m.exec(raw);
      return m?.[1] ?? null;
    }
  } catch {
    // No config, or unreadable: reporting nothing beats reporting a guess.
  }
  return null;
}
