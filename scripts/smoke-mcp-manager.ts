/** Read-only live probe of Claude's MCP inventory through Sertum's normalized host API. */
import assert from 'node:assert/strict';
import { ClaudeChatHost } from '../src/main/adapters/claude-chat';

const cwd = process.argv[2] || process.cwd();
const host = new ClaudeChatHost();
const id = 'smoke-mcp-manager';
const pid = host.spawn(id, {
  command: 'claude',
  args: [
    '--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--include-partial-messages', '--verbose',
  ],
  cwd,
  env: { ...process.env } as Record<string, string>,
});
assert(pid, 'Claude did not start');

try {
  const result = await host.listMcpServers(id);
  assert(result.ok, result.ok ? '' : result.reason);
  for (const server of result.servers) {
    assert(server.name);
    assert(!('config' in server), 'raw MCP configuration must not cross the host boundary');
    assert(!server.endpoint || /^https?:\/\/[^/?#]+$/i.test(server.endpoint));
  }
  console.log(JSON.stringify(result, null, 2));
  console.log(`PASS: normalized ${result.servers.length} live Claude MCP server(s) without exposing process configuration.`);
} finally {
  host.disposeAll();
}
