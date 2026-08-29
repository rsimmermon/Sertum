import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StatusUpdate } from './claude';

/**
 * Plane 2 for Grok, and a third answer to the same question.
 *
 * Claude Code is told where to report (`--settings` hooks pointing at a
 * per-session URL) and Codex reports over its app server; Grok does neither,
 * but it writes a structured event log per session and lets us name the
 * session up front. `grok --session-id <uuid>` therefore buys the same
 * property the hook URL buys for Claude: an arriving event is attributable to
 * exactly one pane with no correlation guesswork.
 *
 * Reading that log is not the thing this architecture forbids. The forbidden
 * move is inferring state from the pixels a TUI draws; `events.jsonl` is the
 * agent's own structured account of what it is doing, the same class of source
 * as a hook payload or a JSON-RPC notification.
 *
 * Sessions live at:
 *
 *   ~/.grok/sessions/<uri-encoded cwd>/<session-id>/events.jsonl
 *
 * The directory name is the working directory percent-encoded, but nothing
 * here relies on reproducing that: the id is what we know, so the session is
 * found by looking for it, which survives any change to how Grok names the
 * folder above it.
 */

/** One record from a session's events.jsonl. */
export interface GrokEvent {
  type?: string;
  ts?: string;
  /** phase_changed: the turn's current stage. */
  phase?: string;
  tool_name?: string;
  /** tool_completed / turn_ended: how it finished. */
  outcome?: string;
  /** permission_resolved: what the user chose. */
  decision?: string;
  /** turn_started carries both, which is how a Grok pane learns its model. */
  model_id?: string;
  session_id?: string;
}

/**
 * Maps one Grok event onto the app's status vocabulary.
 *
 * `{}` means "carries no status change" rather than "failed", exactly as in
 * the Claude and Codex mappings.
 *
 * Two deliberate silences. `phase_changed: tool_execution` returns a status
 * with no activity so the tool name `tool_started` just set survives -- the
 * phase is the coarser statement of the same fact, and overwriting `Bash…`
 * with "running a tool" would lose information. `first_token` and the mcp_*
 * records other than the last say nothing about what the agent is doing for
 * the user.
 */
export function mapGrokEvent(event: GrokEvent): StatusUpdate {
  const tool = str(event.tool_name);

  switch (event.type) {
    // Grok has no SessionStart of its own, and this is the closest honest
    // stand-in: it is the last record written before the prompt appears, so
    // an adapter-bound pane can settle at "ready" instead of sitting on the
    // "working" the PTY layer starts every session at. Observed to fire with
    // MCP servers configured; a setup with none would leave the pane on that
    // default until its first turn ends, which is a duller reading rather
    // than a wrong one.
    case 'mcp_init_completed':
      return { status: 'idle', activity: 'ready' };

    case 'turn_started':
      return { status: 'working', activity: 'thinking' };

    case 'phase_changed':
      return mapPhase(event.phase);

    case 'tool_started':
      return { status: 'working', activity: tool ? `${tool}…` : 'running a tool' };

    case 'tool_completed':
      // A failed tool call is not a failed turn; the agent usually recovers.
      return {
        status: 'working',
        activity:
          event.outcome && event.outcome !== 'success'
            ? `${tool ?? 'tool'} ${event.outcome}`
            : (tool ?? 'thinking'),
      };

    // The event this design earns its keep on: Grok says outright that it is
    // blocked on a decision, so needs-input is reported rather than inferred
    // from output going quiet.
    case 'permission_requested':
      return {
        status: 'needs-input',
        activity: tool ? `approve ${tool}?` : 'approval needed',
      };

    case 'permission_resolved':
      return event.decision === 'allow'
        ? { status: 'working', activity: tool ? `${tool}…` : 'working' }
        : { status: 'working', activity: tool ? `${tool} denied` : 'denied' };

    case 'turn_ended':
      return mapTurnEnd(event.outcome);

    default:
      return {};
  }
}

function mapPhase(phase: string | undefined): StatusUpdate {
  switch (phase) {
    case 'waiting_for_model':
      return { status: 'working', activity: 'thinking' };
    case 'streaming_reasoning':
      return { status: 'working', activity: 'reasoning' };
    case 'streaming_text':
      return { status: 'working', activity: 'responding' };
    // Deliberately activity-free: see the note on mapGrokEvent.
    case 'tool_execution':
      return { status: 'working' };
    case 'permission_prompt':
      return { status: 'needs-input', activity: 'approval needed' };
    default:
      return {};
  }
}

function mapTurnEnd(outcome: string | undefined): StatusUpdate {
  switch (outcome) {
    case 'completed':
    case undefined:
      return { status: 'idle', activity: 'turn finished' };
    case 'cancelled':
    case 'interrupted':
      return { status: 'idle', activity: `turn ${outcome}` };
    default:
      return { status: 'attention', activity: `turn ${outcome}` };
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

// ------------------------------------------------------------- locating

export function grokSessionsRoot(): string {
  return path.join(os.homedir(), '.grok', 'sessions');
}

/**
 * The directory Grok keeps a session in, found by its id.
 *
 * Scans the per-cwd folders rather than rebuilding the encoded name, so this
 * keeps working whatever Grok decides to call that folder. There is one entry
 * per working directory a session has ever run in, so the walk is small.
 */
export function findGrokSessionDir(sessionId: string): string | null {
  const root = grokSessionsRoot();
  for (const entry of safeReaddir(root)) {
    const candidate = path.join(root, entry, sessionId);
    if (isDirectory(candidate)) return candidate;
  }
  return null;
}

/**
 * The newest session directory recorded for a working folder.
 *
 * The fallback for a session we did not start, so its id is unknown -- the
 * folder name decodes back to the cwd, and Windows paths are compared
 * case-insensitively because its filesystem is.
 */
export function findGrokSessionDirForCwd(cwd: string): string | null {
  const root = grokSessionsRoot();
  const want = normalizePath(cwd);
  if (!want) return null;

  for (const entry of safeReaddir(root)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(entry);
    } catch {
      // A folder name that is not valid percent-encoding is not one of ours.
      continue;
    }
    if (normalizePath(decoded) !== want) continue;
    return newestChild(path.join(root, entry));
  }
  return null;
}

function newestChild(dir: string): string | null {
  let best: { p: string; m: number } | null = null;
  for (const entry of safeReaddir(dir)) {
    const full = path.join(dir, entry);
    try {
      const stat = fs.statSync(full);
      if (!stat.isDirectory()) continue;
      if (!best || stat.mtimeMs > best.m) best = { p: full, m: stat.mtimeMs };
    } catch {
      // Vanished between listing and stat.
    }
  }
  return best?.p ?? null;
}

function normalizePath(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '');
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
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
