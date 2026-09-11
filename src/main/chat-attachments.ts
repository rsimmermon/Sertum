import fs from 'node:fs';
import path from 'node:path';
import type { ChatAttachment } from '../shared/types';
import { MAX_CHAT_ATTACHMENTS } from '../shared/chat-attachments';

/**
 * Claude's documented limit applies to the base64 form. Seven raw MiB stays
 * below ten encoded MiB and leaves room for the rest of the JSON message.
 */
export const MAX_CHAT_IMAGE_BYTES = 7 * 1024 * 1024;

const IMAGE_SIGNATURES: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  {
    mime: 'image/png',
    test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: (b) => b.subarray(0, 6).toString('latin1').startsWith('GIF8') },
  {
    mime: 'image/webp',
    test: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

function imageMime(file: string): string | null {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const bytes = Buffer.alloc(16);
      const read = fs.readSync(fd, bytes, 0, bytes.length, 0);
      return IMAGE_SIGNATURES.find((signature) => signature.test(bytes.subarray(0, read)))?.mime ?? null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Read display metadata from a path selected by the reader. */
export function describeChatAttachment(file: string): ChatAttachment | null {
  if (!path.isAbsolute(file)) return null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    return {
      path: path.resolve(file),
      name: path.basename(file),
      size: stat.size,
      kind: imageMime(file) ? 'image' : 'file',
    };
  } catch {
    return null;
  }
}

/**
 * Re-read every descriptor at the daemon boundary.
 *
 * The renderer owns draft UI, not filesystem truth. Missing files, changed
 * kinds, over-large native images and attempts to exceed the bounded draft
 * are refused before either agent sees a partial turn.
 */
export function validateChatAttachments(
  attachments: readonly ChatAttachment[],
): ChatAttachment[] {
  if (attachments.length > MAX_CHAT_ATTACHMENTS) {
    throw new Error(`A message can contain at most ${MAX_CHAT_ATTACHMENTS} attachments.`);
  }
  const resolved: ChatAttachment[] = [];
  const seen = new Set<string>();
  for (const attachment of attachments) {
    const actual = describeChatAttachment(attachment.path);
    if (!actual) throw new Error(`Attachment is no longer readable: ${attachment.name || attachment.path}`);
    const key = process.platform === 'win32' ? actual.path.toLowerCase() : actual.path;
    if (seen.has(key)) continue;
    seen.add(key);
    if (actual.kind === 'image' && actual.size > MAX_CHAT_IMAGE_BYTES) {
      throw new Error(`${actual.name} is too large to attach as an image (7 MB maximum).`);
    }
    resolved.push(actual);
  }
  return resolved;
}

/** A native Claude image block, with the type decided from its bytes. */
export function readChatImage(
  attachment: ChatAttachment,
): { mime: string; data: string } | null {
  if (attachment.kind !== 'image' || attachment.size > MAX_CHAT_IMAGE_BYTES) return null;
  try {
    const stat = fs.statSync(attachment.path);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_CHAT_IMAGE_BYTES) return null;
    const mime = imageMime(attachment.path);
    if (!mime) return null;
    return { mime, data: fs.readFileSync(attachment.path).toString('base64') };
  } catch {
    return null;
  }
}
