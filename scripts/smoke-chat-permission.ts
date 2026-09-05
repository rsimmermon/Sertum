/**
 * Verifies the conversation session's permission channel end to end against a
 * real `claude` process: the ask arrives, the turn stays held while nobody
 * answers, and the answer resumes it.
 */
import { ClaudeChatHost, type ChatPermissionAsk } from '../src/main/adapters/claude-chat';

const cwd = process.argv[2];
const decision = (process.argv[3] ?? 'deny') as 'allow' | 'deny';
const holdMs = Number(process.argv[4] ?? 8000);

const host = new ClaudeChatHost();
const id = 'smoke-session';
const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

host.on('init', (e) => console.log(at(), 'init', e.sessionId, e.model));
host.on('update', (e) => console.log(at(), 'update', e.status ?? '-', e.activity ?? '-'));
host.on('exit', (e) => { console.log(at(), 'exit', e.exitCode); process.exit(0); });
host.on('permission-cancelled', (e) => console.log(at(), 'cancelled', e.requestId));

host.on('permission', (ask: ChatPermissionAsk) => {
  console.log(at(), 'ASK', JSON.stringify({
    tool: ask.toolName, display: ask.displayName, description: ask.description,
    reason: ask.reason, reasonType: ask.reasonType,
    requiresUserInteraction: ask.requiresUserInteraction,
    suppressAlwaysAllow: ask.suppressAlwaysAllow,
    input: ask.input,
  }));
  console.log(at(), `holding ${holdMs}ms, then ${decision}`);
  setTimeout(() => {
    const sent = host.answerPermission(id, ask.requestId,
      decision === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: 'Denied in Sertum: write inside the working directory instead.' });
    console.log(at(), 'answered ->', sent);
    // A second answer must be refused: the ask is no longer held.
    console.log(at(), 'second answer ->', host.answerPermission(id, ask.requestId, { behavior: 'allow' }));
  }, holdMs);
});

const pid = host.spawn(id, {
  command: 'claude',
  args: [
    '--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--include-partial-messages', '--verbose',
    '--permission-prompt-tool', 'stdio',
    '--permission-mode', 'manual',
  ],
  cwd,
  env: { ...process.env } as Record<string, string>,
});
console.log(at(), 'pid', pid);
setTimeout(() => {
  host.send(id, 'Use the Write tool to create the file C:\Users\Admin\sertum-probe-outside.txt containing the word probe. Do it now.');
}, 1500);
setTimeout(() => { console.log('TIMEOUT'); host.disposeAll(); process.exit(1); }, 120000);
