/**
 * Verifies `ClaudeChatHost.interrupt` end to end against a real `claude`
 * process: sent mid-generation, it must land quickly, end the turn as an
 * interruption rather than a failure, and leave the process usable for a
 * following turn.
 */
import { ClaudeChatHost } from '../src/main/adapters/claude-chat';

const cwd = process.argv[2];

const host = new ClaudeChatHost();
const id = 'smoke-session';
const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;
let sawDelta = false;
let interruptSentAt = 0;

host.on('init', (e) => console.log(at(), 'init', e.sessionId, e.model));
host.on('update', (e) => console.log(at(), 'update', e.status ?? '-', e.activity ?? '-'));
host.on('exit', (e) => { console.log(at(), 'exit', e.exitCode); process.exit(0); });

const pid = host.spawn(id, {
  command: 'claude',
  args: [
    '--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--include-partial-messages', '--verbose',
  ],
  cwd,
  env: { ...process.env } as Record<string, string>,
});
console.log(at(), 'pid', pid, 'has() before send ->', host.has(id));

setTimeout(() => {
  host.send(id, 'Write a very long, at least 3000 word, essay about the history of the postal system. Do not use any tools. Just respond with the essay text.');
}, 1000);

// Poll status via repeated no-op update listener already logs; watch for the
// first 'responding' update as the moment generation is under way, then fire
// the interrupt and time the round trip.
let interrupted = false;
let followUpSent = false;
host.on('update', (e) => {
  if (!sawDelta && e.activity === 'responding') {
    sawDelta = true;
    interruptSentAt = Date.now();
    console.log(at(), 'interrupting…');
    void host.interrupt(id).then((accepted) => {
      console.log(at(), `interrupt() resolved -> ${accepted} (${Date.now() - interruptSentAt}ms)`);
      // The process should still be alive and usable for a follow-up turn.
      setTimeout(() => {
        followUpSent = true;
        console.log(at(), 'sending follow-up turn, has() ->', host.has(id));
        host.send(id, 'What is 2+2? One word answer.');
      }, 500);
    });
    return;
  }
  if (followUpSent && e.status === 'idle') {
    interrupted = true;
    console.log(at(), 'PASS: interrupt landed and the session answered a following turn');
    host.disposeAll();
    process.exit(0);
  }
});

setTimeout(() => {
  console.log(at(), interrupted ? 'exiting' : 'TIMEOUT: did not observe interrupt + follow-up turn');
  host.disposeAll();
  process.exit(interrupted ? 0 : 1);
}, 30000);
