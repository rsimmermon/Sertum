import assert from 'node:assert/strict';
import path from 'node:path';
import { describeChatAttachment, readChatImage, validateChatAttachments } from '../src/main/chat-attachments';
import { promptWithAttachments } from '../src/shared/chat-attachments';

const image = describeChatAttachment(path.resolve('assets/icon.png'));
const file = describeChatAttachment(path.resolve('package.json'));
assert(image && image.kind === 'image');
assert(file && file.kind === 'file');
assert.equal(readChatImage(image)?.mime, 'image/png');
assert.deepEqual(validateChatAttachments([image, image]), [image]);
assert.equal(
  promptWithAttachments('', [image], new Set([image.path])),
  `Please review the attached image.\n\nAttachments:\n- ${image.name} (image)`,
);
assert.match(promptWithAttachments('Compare these.', [image, file]), /package\.json: /);
assert.throws(
  () => validateChatAttachments([{ ...file, path: path.resolve('missing-file') }]),
  /no longer readable/,
);
console.log('PASS: attachment classification, image encoding, validation, de-duplication and prompt labels.');
