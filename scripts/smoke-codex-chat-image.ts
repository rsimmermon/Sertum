/** Verify Codex's owned app-server thread accepts a real localImage turn. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { CodexAppServer } from '../src/main/adapters/codex-app-server';
import { CodexChatHost } from '../src/main/adapters/codex-chat';
import { describeChatAttachment } from '../src/main/chat-attachments';

async function main() {
  const cwd = path.resolve(process.argv[2] || '.');
  const image = describeChatAttachment(path.resolve('assets/icon.png'));
  assert(image && image.kind === 'image', 'assets/icon.png must be an image');
  const server = new CodexAppServer();
  const host = new CodexChatHost(server);
  let completed: Record<string, unknown> | null = null;
  server.on('notification', ({ method, params }) => {
    if (method === 'turn/completed') completed = params.turn as Record<string, unknown>;
  });
  try {
    assert(await server.start(), 'Could not start Codex app server');
    await host.start('probe', cwd);
    assert(await host.send('probe', 'Briefly describe this image. Do not use tools.', [image]));
    const deadline = Date.now() + 60_000;
    while (!completed) {
      assert(Date.now() < deadline, 'Timed out waiting for Codex image turn');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.notEqual(completed.status, 'failed');
    console.log('PASS: Codex accepted and completed a localImage turn.');
  } finally {
    await host.terminate('probe').catch(() => {});
    server.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
