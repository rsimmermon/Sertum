import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { SessionStatus } from '../../shared/types';

/**
 * Hosts headless Claude chat processes — stage 2 of BROKER-HANDOFF.md.
 *
 * One process per `stream` session, spawned as
 * `claude --print --input-format stream-json --output-format stream-json`,
 * which is a persistent bidirectional chat protocol: verified against Claude
 * Code 2.1.252, one process answered three consecutive turns on one session
 * id. Input is one JSON user message per line on stdin; output is an NDJSON
 * event stream — `system/init`, `stream_event` partials, `assistant`,
 * `result` — which is plane 2 speaking in its richest form. Nothing here is
 * a PTY and nothing here parses pixels.
 *
 * Content deliberately does not flow through this class into the UI. A
 * headless session writes the same transcript an interactive one does (also
 * verified), so the conversation view keeps reading the transcript for every
 * session alike; the stream drives status and identity, which are the parts
 * the transcript cannot carry live.
 */

export interface ChatStreamEvents {
  /** A status or activity change, mapped from the stream. */
  update: { id: string; status?: SessionStatus; activity?: string };
  /** The session announced itself: its own id and the model in use. */
  init: { id: string; sessionId: string; model: string | null };
  /** The process ended. */
  exit: { id: string; exitCode: number };
}

interface Hosted {
  child: ChildProcess;
  buf: string;
  /** Rejected writes after exit answer false instead of throwing. */
  alive: boolean;
}

export class ClaudeChatHost extends EventEmitter {
  private hosted = new Map<string, Hosted>();

  /**
   * Spawns the headless process. Returns its pid, or null when the spawn
   * failed synchronously — the caller decides what a failed session becomes.
   */
  spawn(
    id: string,
    opts: {
      command: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
    },
  ): number | null {
    let child: ChildProcess;
    try {
      child = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Never a shell: the command is a resolved executable path and the
        // args carry a JSON settings blob no shell quoting should touch.
        shell: false,
        windowsHide: true,
      });
    } catch {
      return null;
    }
    if (child.pid === undefined) return null;

    const entry: Hosted = { child, buf: '', alive: true };
    this.hosted.set(id, entry);

    child.stdout?.on('data', (chunk: Buffer) => {
      entry.buf += chunk.toString('utf8');
      let at: number;
      while ((at = entry.buf.indexOf('\n')) >= 0) {
        const line = entry.buf.slice(0, at).trim();
        entry.buf = entry.buf.slice(at + 1);
        if (line) this.handleLine(id, line);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) console.warn(`[claude-chat ${id.slice(0, 8)}]`, text.slice(0, 300));
    });
    child.on('error', (err) => {
      console.warn(`[claude-chat ${id.slice(0, 8)}] spawn error:`, err.message);
      entry.alive = false;
      this.emit('exit', { id, exitCode: -1 } satisfies ChatStreamEvents['exit']);
      this.hosted.delete(id);
    });
    child.on('exit', (code) => {
      entry.alive = false;
      this.emit('exit', {
        id,
        exitCode: code ?? -1,
      } satisfies ChatStreamEvents['exit']);
      this.hosted.delete(id);
    });

    return child.pid;
  }

  /** One user message down the wire. The turn begins when Claude reads it. */
  send(id: string, text: string): boolean {
    const entry = this.hosted.get(id);
    if (!entry?.alive || !entry.child.stdin?.writable) return false;
    const message = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
    try {
      entry.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      return false;
    }
    // The stream stays silent until the model starts answering, so the send
    // itself is the moment the session stops being idle.
    this.update(id, { status: 'working', activity: 'thinking' });
    return true;
  }

  kill(id: string): void {
    const entry = this.hosted.get(id);
    if (!entry) return;
    try {
      entry.child.kill();
    } catch {
      // Already gone.
    }
  }

  /**
   * Ends a session's process, escalating exactly as the PTY path does: the
   * polite signal first, SIGKILL if it is ignored. Resolves true once the
   * process is confirmed gone.
   */
  async terminate(id: string, graceMs = 3000): Promise<boolean> {
    const entry = this.hosted.get(id);
    if (!entry?.alive) return true;

    const exited = (ms: number) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          entry.child.off('exit', onExit);
          resolve(false);
        }, ms);
        const onExit = () => {
          clearTimeout(timer);
          resolve(true);
        };
        entry.child.once('exit', onExit);
      });

    const grace = exited(graceMs);
    try {
      entry.child.kill();
    } catch {
      return true;
    }
    if (await grace) return true;

    const forced = exited(2000);
    try {
      entry.child.kill('SIGKILL');
    } catch {
      return true;
    }
    return forced;
  }

  disposeAll(): void {
    for (const id of [...this.hosted.keys()]) this.kill(id);
  }

  // -------------------------------------------------------------- the stream

  private handleLine(id: string, line: string): void {
    if (!line.startsWith('{')) return;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (rec.type) {
      case 'system': {
        if (rec.subtype !== 'init') return;
        const sessionId = typeof rec.session_id === 'string' ? rec.session_id : null;
        const model = typeof rec.model === 'string' ? rec.model : null;
        if (sessionId) {
          this.emit('init', { id, sessionId, model } satisfies ChatStreamEvents['init']);
        }
        // Init opens every turn, so it only means "ready" before the first.
        this.update(id, { activity: 'ready' });
        return;
      }
      case 'stream_event': {
        const event = rec.event as Record<string, unknown> | undefined;
        if (!event) return;
        if (event.type === 'content_block_start') {
          const block = event.content_block as Record<string, unknown> | undefined;
          if (block?.type === 'tool_use' && typeof block.name === 'string') {
            this.update(id, { status: 'working', activity: `${block.name}…` });
          } else if (block?.type === 'thinking') {
            this.update(id, { status: 'working', activity: 'thinking' });
          } else if (block?.type === 'text') {
            this.update(id, { status: 'working', activity: 'responding' });
          }
        }
        return;
      }
      case 'result': {
        const failed = rec.is_error === true;
        this.update(id, {
          status: failed ? 'attention' : 'idle',
          activity: failed ? 'turn failed' : 'turn finished',
        });
        return;
      }
      default:
        // `assistant` and `user` records carry content the transcript already
        // holds; the conversation view reads it there.
        return;
    }
  }

  private update(
    id: string,
    update: { status?: SessionStatus; activity?: string },
  ): void {
    this.emit('update', { id, ...update } satisfies ChatStreamEvents['update']);
  }
}
