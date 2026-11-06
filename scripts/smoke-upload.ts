/**
 * A file from another device reaching a real agent: chunks through the spool, an
 * attachment back, and a real Claude turn that has to say what is in the image.
 * Also the guard on reading a message's image, through the real method.
 *
 *   npx esbuild scripts/smoke-upload.ts --bundle --platform=node --format=cjs \
 *     --external:node-pty --outfile=.temp/smoke-upload.cjs
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron .temp/smoke-upload.cjs
 */
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { createFabric } from '../src/daemon/fabric';
import type { ChatAttachment, ChatSubmitResult, SessionSnapshot } from '../src/shared/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A solid red PNG, big enough to be unmistakable and to need several chunks. */
function redPng(size: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const byte of b) c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(8 + typed.length + 4);
    out.writeUInt32BE(data.length, 0);
    typed.copy(out, 4);
    out.writeUInt32BE(crc(typed), 4 + typed.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3)]);
  for (let x = 0; x < size; x += 1) row[1 + x * 3] = 255;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => row)), { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  const root = path.resolve('.temp/upload-probe');
  const other = path.resolve('.temp/upload-probe-other');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  const png = redPng(600);
  fs.writeFileSync(path.join(root, 'inside.png'), png);
  fs.writeFileSync(path.join(other, 'elsewhere.png'), png);

  const fabric = createFabric({ userDataDir: root });
  const current = new Map<string, SessionSnapshot>();
  fabric.onEvent((name, value) => {
    if (name === 'session:updated') current.set((value as SessionSnapshot).id, value as SessionSnapshot);
  });
  try {
    await fabric.start();
    const session = await fabric.handle('session/create', {
      agent: 'claude', transport: 'stream', cwd: root, label: 'upload probe',
    }) as SessionSnapshot;

    const read = (cwd: string, src: string) => fabric.handle('image/read-local', { cwd, src }) as Promise<string | null>;
    assert((await read(root, 'inside.png'))?.startsWith('data:image/png;base64,'), 'a session folder reads');
    assert.equal(await read(other, 'elsewhere.png'), null, 'a folder no session has is refused');
    assert.equal(await read(root, '../upload-probe-other/elsewhere.png'), null, 'escaping is refused');
    console.log('PASS image reads are bound to a real session folder');

    const { uploadId } = await fabric.handle('upload/begin', { name: '..\\phone photo.png', size: png.length }) as { uploadId: string };
    const CHUNK = 512 * 1024;
    let chunks = 0;
    for (let offset = 0; offset < png.length; offset += CHUNK) {
      await fabric.handle('upload/chunk', {
        uploadId, offset, data: png.subarray(offset, offset + CHUNK).toString('base64'),
      });
      chunks += 1;
    }
    const attachment = await fabric.handle('upload/finish', { uploadId }) as ChatAttachment;
    assert.equal(attachment.kind, 'image');
    assert.equal(attachment.name, 'phone photo.png');
    assert(attachment.path.startsWith(path.join(root, 'uploads')));
    assert(fs.readFileSync(attachment.path).equals(png));
    console.log(`PASS ${png.length} bytes in ${chunks} chunks became an attachment`);

    const result = await fabric.handle('chat/submit', {
      id: session.id,
      text: 'What single colour fills this image? Reply with only that colour word.',
      attachments: [attachment],
    }) as ChatSubmitResult;
    assert.equal(result.outcome, 'sent');
    await sleep(500);
    const deadline = Date.now() + 90_000;
    let answer = '';
    while (Date.now() < deadline) {
      const s = current.get(session.id);
      if (s && !s.turnActive && s.transcriptPath) {
        const conversation = await fabric.handle('conversation/read', { id: session.id }) as { items?: Array<{ kind: string; role?: string; text?: string }> };
        answer = conversation.items?.findLast((i) => i.kind === 'message' && i.role === 'assistant')?.text ?? '';
        if (answer) break;
      }
      await sleep(500);
    }
    console.log(`  agent answered: ${JSON.stringify(answer)}`);
    assert(/red/i.test(answer), 'the agent really saw the uploaded image');
    console.log('PASS a real agent saw the uploaded image');
    await fabric.handle('session/kill', session.id);
    console.log('ALL PASS');
  } catch (error) {
    // Here rather than on main(): the exit below would otherwise swallow it.
    console.error('FAILED:', error);
    process.exitCode = 1;
  } finally {
    await fabric.shutdown();
    await sleep(500);
    process.exit(process.exitCode ?? 0);
  }
}
void main();
