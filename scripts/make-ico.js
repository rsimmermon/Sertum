#!/usr/bin/env node
/**
 * Packs assets/icon.png into a Windows assets/icon.ico.
 *
 * Uses the PNG-payload ICO variant (Vista+), so each entry is just the resized
 * PNG bytes — no BMP/mask encoding needed. Resizing is done with sips, so this
 * is macOS-only; the committed assets/icon.ico is what Windows builds consume.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'assets', 'icon.png');
const dest = path.join(root, 'assets', 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

if (process.platform !== 'darwin') {
  console.error('[make-ico] needs sips (macOS); leaving assets/icon.ico as-is');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sertum-ico-'));
const images = SIZES.map((px) => {
  const out = path.join(tmp, `${px}.png`);
  execFileSync('sips', ['-z', String(px), String(px), src, '--out', out], { stdio: 'ignore' });
  return { px, data: fs.readFileSync(out) };
});

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);              // reserved
header.writeUInt16LE(1, 2);              // 1 = icon
header.writeUInt16LE(images.length, 4);

let offset = 6 + images.length * 16;
const entries = [];
for (const { px, data } of images) {
  const e = Buffer.alloc(16);
  e.writeUInt8(px >= 256 ? 0 : px, 0);   // 0 encodes 256
  e.writeUInt8(px >= 256 ? 0 : px, 1);
  e.writeUInt8(0, 2);                    // palette count
  e.writeUInt8(0, 3);                    // reserved
  e.writeUInt16LE(1, 4);                 // colour planes
  e.writeUInt16LE(32, 6);                // bits per pixel
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  offset += data.length;
}

fs.writeFileSync(dest, Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`[make-ico] wrote assets/icon.ico (${images.length} sizes, ${fs.statSync(dest).size} bytes)`);
