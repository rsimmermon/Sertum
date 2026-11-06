// The upload spool, and the bounds on reading an image a message names.
//
//   npx esbuild scripts/test-daemon-files.ts --bundle --platform=node \
//     --format=esm --outfile=<tmp>/files.mjs && node <tmp>/files.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ABANDONED_MS,
  MAX_ACTIVE_UPLOADS,
  MAX_CHUNK_BYTES,
  MAX_UPLOAD_BYTES,
  RETAIN_MS,
  safeUploadName,
  UploadSpool,
} from '../src/daemon/upload-spool';
import { readLocalImage } from '../src/main/local-image';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sertum-files-'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');
let serial = 0;
const fresh = (now?: () => number) => {
  const root = path.join(base, `spool${++serial}`);
  return { root, spool: new UploadSpool(root, now) };
};
const b64 = (b: Buffer) => b.toString('base64');

const checks: Array<[string, () => Promise<void>]> = [
  ['chunks in order become an attachment, with its kind read from the bytes', async () => {
    const { root, spool } = fresh();
    const { uploadId } = await spool.begin({ name: 'shot.png', size: PNG.length });
    const middle = Math.floor(PNG.length / 2);
    assert.deepEqual(await spool.chunk({ uploadId, offset: 0, data: b64(PNG.subarray(0, middle)) }), { received: middle });
    await spool.chunk({ uploadId, offset: middle, data: b64(PNG.subarray(middle)) });
    const attachment = await spool.finish({ uploadId });
    assert.equal(attachment.kind, 'image');
    assert.equal(attachment.name, 'shot.png');
    assert.equal(attachment.size, PNG.length);
    assert(attachment.path.startsWith(root));
    assert(fs.readFileSync(attachment.path).equals(PNG));
  }],
  ['a hostile name cannot leave its folder', async () => {
    const { root, spool } = fresh();
    for (const name of ['..\\..\\evil.png', '../../evil.png', 'C:\\Windows\\evil.png', '/etc/evil.png']) {
      const { uploadId } = await spool.begin({ name, size: 1 });
      await spool.chunk({ uploadId, offset: 0, data: b64(Buffer.from('x')) });
      const attachment = await spool.finish({ uploadId });
      assert.equal(path.dirname(path.dirname(attachment.path)), path.resolve(root), name);
      assert.equal(attachment.name, 'evil.png', name);
    }
    assert(!fs.existsSync(path.join(base, 'evil.png')));
  }],
  ['names are made creatable', async () => {
    assert.equal(safeUploadName('con.txt'), '_con.txt');
    assert.equal(safeUploadName('NUL'), '_NUL');
    assert.equal(safeUploadName('a:b*c?.txt'), 'a_b_c_.txt');
    assert.equal(safeUploadName('trailing. . '), 'trailing');
    assert.equal(safeUploadName('.bashrc'), 'bashrc');
    assert.equal(safeUploadName('...'), 'upload');
    assert.equal(safeUploadName(''), 'upload');
    assert.equal(safeUploadName('new\nline.txt'), 'new_line.txt');
    const long = safeUploadName(`${'x'.repeat(500)}.png`);
    assert(long.length <= 116 && long.endsWith('.png'));
  }],
  ['a gap or a repeat is refused, and the upload survives it', async () => {
    const { spool } = fresh();
    const { uploadId } = await spool.begin({ name: 'a.bin', size: 4 });
    await assert.rejects(spool.chunk({ uploadId, offset: 2, data: b64(Buffer.from('ab')) }), /Expected a chunk at 0/);
    await spool.chunk({ uploadId, offset: 0, data: b64(Buffer.from('ab')) });
    await assert.rejects(spool.chunk({ uploadId, offset: 0, data: b64(Buffer.from('ab')) }), /Expected a chunk at 2/);
    await spool.chunk({ uploadId, offset: 2, data: b64(Buffer.from('cd')) });
    assert.equal(fs.readFileSync((await spool.finish({ uploadId })).path, 'latin1'), 'abcd');
  }],
  ['the declared size is enforced both ways', async () => {
    const { root, spool } = fresh();
    await assert.rejects(spool.begin({ name: 'a', size: 0 }), /needs a size/);
    await assert.rejects(spool.begin({ name: 'a', size: -1 }), /needs a size/);
    await assert.rejects(spool.begin({ name: 'a', size: 1.5 }), /needs a size/);
    await assert.rejects(spool.begin({ name: 'a', size: MAX_UPLOAD_BYTES + 1 }), /too large/);
    const short = await spool.begin({ name: 'a', size: 4 });
    await spool.chunk({ uploadId: short.uploadId, offset: 0, data: b64(Buffer.from('ab')) });
    await assert.rejects(spool.finish(short), /Received 2 of 4/);
    const over = await spool.begin({ name: 'b', size: 1 });
    await assert.rejects(spool.chunk({ uploadId: over.uploadId, offset: 0, data: b64(Buffer.from('ab')) }), /More bytes/);
    assert(!fs.existsSync(path.join(root, over.uploadId)), 'an overrun is discarded');
    await assert.rejects(spool.chunk({ uploadId: over.uploadId, offset: 0, data: b64(Buffer.from('a')) }), /not in progress/);
    await spool.abort(short);
  }],
  ['an oversized or malformed chunk is refused', async () => {
    const { spool } = fresh();
    const { uploadId } = await spool.begin({ name: 'a', size: MAX_CHUNK_BYTES + 3 });
    await assert.rejects(spool.chunk({ uploadId, offset: 0, data: b64(Buffer.alloc(MAX_CHUNK_BYTES + 3)) }), /too large/);
    await assert.rejects(spool.chunk({ uploadId, offset: 0, data: 'not base64!' }), /base64/);
    await assert.rejects(spool.chunk({ uploadId, offset: 0, data: '' }), /base64/);
    await spool.abort({ uploadId });
  }],
  ['the number of uploads in progress is bounded', async () => {
    const { spool } = fresh();
    for (let i = 0; i < MAX_ACTIVE_UPLOADS; i += 1) await spool.begin({ name: `${i}`, size: 1 });
    await assert.rejects(spool.begin({ name: 'more', size: 1 }), /Too many/);
    await spool.dispose();
    await spool.begin({ name: 'after', size: 1 });
    await spool.dispose();
  }],
  ['abort removes the partial file', async () => {
    const { root, spool } = fresh();
    const { uploadId } = await spool.begin({ name: 'a', size: 4 });
    await spool.chunk({ uploadId, offset: 0, data: b64(Buffer.from('ab')) });
    assert.equal(await spool.abort({ uploadId }), true);
    assert(!fs.existsSync(path.join(root, uploadId)));
    assert.equal(await spool.abort({ uploadId }), false);
  }],
  ['an abandoned upload is dropped, and a live one is not', async () => {
    let clock = 1_000_000;
    const { root, spool } = fresh(() => clock);
    const dead = await spool.begin({ name: 'dead', size: 4 });
    clock += ABANDONED_MS - 1000;
    const live = await spool.begin({ name: 'live', size: 4 });
    clock += 2000;
    await spool.sweep();
    assert(!fs.existsSync(path.join(root, dead.uploadId)));
    assert(fs.existsSync(path.join(root, live.uploadId)));
    await spool.dispose();
  }],
  ['a finished file stays for its retention, then goes', async () => {
    let clock = Date.now();
    const { spool } = fresh(() => clock);
    const { uploadId } = await spool.begin({ name: 'a', size: 1 });
    await spool.chunk({ uploadId, offset: 0, data: b64(Buffer.from('a')) });
    const attachment = await spool.finish({ uploadId });
    clock += RETAIN_MS - 60_000;
    await spool.sweep();
    assert(fs.existsSync(attachment.path), 'still there for a later turn');
    clock += 120_000;
    await spool.sweep();
    assert(!fs.existsSync(attachment.path));
  }],
  ['a local image inside the folder is read, by its bytes', async () => {
    const dir = path.join(base, 'img1');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'real.png'), PNG);
    fs.writeFileSync(path.join(dir, 'fake.png'), 'not an image');
    assert((await readLocalImage(dir, 'real.png'))?.startsWith('data:image/png;base64,'));
    assert.equal(await readLocalImage(dir, 'fake.png'), null);
    assert.equal(await readLocalImage(dir, 'missing.png'), null);
  }],
  ['an image outside the folder is not', async () => {
    const dir = path.join(base, 'img2');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(base, 'outside.png'), PNG);
    assert.equal(await readLocalImage(dir, '../outside.png'), null);
    assert.equal(await readLocalImage(dir, path.join(base, 'outside.png')), null);
    assert.equal(await readLocalImage(dir, 'https://example.com/a.png'), null);
  }],
  ['a link inside the folder cannot reach out of it', async () => {
    const dir = path.join(base, 'img3');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(base, 'secret.png'), PNG);
    const outside = path.join(base, 'linkdir');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'inner.png'), PNG);
    let made = 0;
    try {
      fs.symlinkSync(path.join(base, 'secret.png'), path.join(dir, 'link.png'));
      made += 1;
      assert.equal(await readLocalImage(dir, 'link.png'), null, 'file link');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
    // A directory junction needs no privilege on Windows, so this always runs.
    fs.symlinkSync(outside, path.join(dir, 'junction'), 'junction');
    made += 1;
    assert.equal(await readLocalImage(dir, 'junction/inner.png'), null, 'junction');
    assert(made >= 1);
  }],
];

let failed = 0;
for (const [name, check] of checks) {
  try {
    await check();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${String(error)}`);
  }
}
fs.rmSync(base, { recursive: true, force: true });
console.log(`${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
