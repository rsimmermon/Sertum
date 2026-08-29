import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { findGrokSessionDir, grokSessionsRoot, type GrokEvent } from './grok';

/**
 * Plane 2 ingress for Grok: tails each bound session's own events.jsonl.
 *
 * The counterpart to HookServer for Claude and CodexAppServer for Codex. Grok
 * pushes nothing, so this pulls -- but from the agent's structured event log,
 * never from the terminal. Sertum names the session with `--session-id` before
 * spawning it, so every event read here belongs to exactly one pane.
 *
 * Polling rather than fs.watch, for three reasons: the file may not exist for
 * a beat after spawn (so a watch would have to be retried anyway), watch
 * semantics differ across platforms in ways that are tedious to get right, and
 * a turn emits hundreds of `phase_changed` records -- a poll coalesces those
 * into one status update per tick, which is exactly what the UI wants.
 */

/** Fast enough to feel live, slow enough to coalesce a chatty turn. */
const POLL_MS = 300;

interface Binding {
  grokSessionId: string;
  /** Resolved on the first tick that finds it; null until Grok creates it. */
  file: string | null;
  offset: number;
  /** Holds a trailing partial line between reads. */
  carry: string;
  decoder: StringDecoder;
}

/**
 * Everything one poll found, delivered together.
 *
 * A batch rather than an event apiece because most of what Grok writes is not
 * a distinct thing to show. A single auto-approved tool call emits
 * `permission_prompt`, `permission_requested` and `permission_resolved` inside
 * the same millisecond; replayed one at a time that turns the tab amber for
 * "approval needed" and back again, for a permission the user was never asked
 * for. Folding a batch keeps the last word, which is the one still true --
 * and a prompt that really is waiting has no resolution to follow it, so it
 * survives the fold.
 */
export interface GrokEventArrival {
  /** Sertum's session id -- the pane this belongs to. */
  sessionId: string;
  /** Grok's own session id, which we chose at spawn. */
  grokSessionId: string;
  events: GrokEvent[];
}

export class GrokEventLog extends EventEmitter {
  private bindings = new Map<string, Binding>();
  private timer: NodeJS.Timeout | null = null;
  private events = 0;

  /** Start following the log for a session spawned with `--session-id`. */
  bind(sessionId: string, grokSessionId: string): void {
    this.bindings.set(sessionId, {
      grokSessionId,
      file: null,
      offset: 0,
      carry: '',
      decoder: new StringDecoder('utf8'),
    });
    this.start();
  }

  unbind(sessionId: string): void {
    this.bindings.delete(sessionId);
    if (this.bindings.size === 0) this.stop();
  }

  /** Sessions currently being followed. */
  get watching(): number {
    return this.bindings.size;
  }

  get eventCount(): number {
    return this.events;
  }

  /**
   * Whether Grok's session store exists at all. False means no Grok session
   * has ever run on this machine, so nothing could be followed -- reported
   * rather than hidden, so the status bar can say why.
   */
  get available(): boolean {
    try {
      return fs.statSync(grokSessionsRoot()).isDirectory();
    } catch {
      return false;
    }
  }

  stopAll(): void {
    this.bindings.clear();
    this.stop();
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), POLL_MS);
    // Following a log must never be the reason the app stays alive.
    this.timer.unref?.();
  }

  private stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    for (const [sessionId, binding] of this.bindings) {
      try {
        this.drain(sessionId, binding);
      } catch {
        // A read that loses a race with Grok's own writer is retried on the
        // next tick; one bad tick must not stop the other sessions.
      }
    }
  }

  private drain(sessionId: string, binding: Binding): void {
    if (!binding.file) {
      const dir = findGrokSessionDir(binding.grokSessionId);
      if (!dir) return;
      binding.file = path.join(dir, 'events.jsonl');
    }

    let size: number;
    try {
      size = fs.statSync(binding.file).size;
    } catch {
      // Not written yet, or removed under us.
      return;
    }
    if (size === binding.offset) return;
    // Truncated or replaced: start again rather than read from a stale offset.
    if (size < binding.offset) {
      binding.offset = 0;
      binding.carry = '';
      binding.decoder = new StringDecoder('utf8');
    }

    const buf = Buffer.alloc(size - binding.offset);
    const fd = fs.openSync(binding.file, 'r');
    let read: number;
    try {
      read = fs.readSync(fd, buf, 0, buf.length, binding.offset);
    } finally {
      fs.closeSync(fd);
    }
    binding.offset += read;

    // Decoded through a StringDecoder because a read can land mid-character:
    // the tail of a multi-byte sequence is held until its remaining bytes
    // arrive, which a plain toString would replace with U+FFFD.
    const chunk = binding.decoder.write(buf.subarray(0, read));
    const lines = (binding.carry + chunk).split('\n');
    // The final element is either empty or a record still being written.
    binding.carry = lines.pop() ?? '';

    const batch: GrokEvent[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        batch.push(JSON.parse(trimmed) as GrokEvent);
      } catch {
        continue;
      }
    }
    if (batch.length === 0) return;

    this.events += batch.length;
    this.emit('events', {
      sessionId,
      grokSessionId: binding.grokSessionId,
      events: batch,
    } satisfies GrokEventArrival);
  }
}
