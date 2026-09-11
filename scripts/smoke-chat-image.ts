/** Verify Claude's structured host accepts a real native image turn. */
import path from 'node:path';
import { ClaudeChatHost } from '../src/main/adapters/claude-chat';
import { describeChatAttachment } from '../src/main/chat-attachments';

const cwd = path.resolve(process.argv[2] || '.');
const image = describeChatAttachment(path.resolve('assets/icon.png'));
if (!image || image.kind !== 'image') throw new Error('assets/icon.png was not recognised as an image');

const host = new ClaudeChatHost();
const id = 'smoke-image';
let sent = false;
host.on('update', (event) => {
  console.log(event.status ?? '-', event.activity ?? '-');
  if (sent && event.status === 'idle') {
    console.log('PASS: Claude accepted and completed a structured image turn.');
    host.disposeAll();
    process.exit(0);
  }
  if (event.status === 'attention') {
    host.disposeAll();
    process.exit(1);
  }
});
host.on('exit', (event) => {
  console.log('exit', event.exitCode);
  if (sent) process.exitCode = 1;
});

const pid = host.spawn(id, {
  command: 'claude',
  args: [
    '--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--include-partial-messages', '--verbose',
  ],
  cwd,
  env: { ...process.env } as Record<string, string>,
});
if (!pid) throw new Error('Could not start Claude');
sent = host.send(id, 'Briefly describe this image.', [image]);
if (!sent) throw new Error('Could not send the image turn');

setTimeout(() => {
  console.error('TIMEOUT: Claude did not finish the image turn');
  host.disposeAll();
  process.exit(1);
}, 60_000);
