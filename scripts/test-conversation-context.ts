import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConversation } from '../src/main/adapters/conversation';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sertum-context-'));
const file = path.join(dir, 'conversation.jsonl');
try {
  const messages = [
    ['user', '<recommended_plugins>\n- Airtable\n</recommended_plugins>'],
    ['user', '<example>Keep my pasted XML</example>'],
    ['assistant', '## Answer\n\n- One\n- Two'],
  ];
  fs.writeFileSync(file, messages.map(([role, text]) => JSON.stringify({
    type: 'response_item', payload: {
      type: 'message', role, content: [{ type: 'input_text', text }],
    },
  })).join('\n'));
  const result = readConversation('codex', file);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].kind, 'message');
  assert.equal(result.items[1].kind, 'message');
  if (result.items[0].kind === 'message' && result.items[1].kind === 'message') {
    assert.equal(result.items[0].text, messages[1][1]);
    assert.equal(result.items[1].format, 'markdown');
  }
  console.log('Codex injected context, pasted XML, and markdown classification passed.');
} finally {
  fs.unlinkSync(file);
  fs.rmdirSync(dir);
}
