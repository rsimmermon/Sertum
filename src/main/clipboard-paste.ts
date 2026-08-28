import { app, clipboard } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClipboardPaste } from '../shared/types';

/**
 * Reading the system clipboard on behalf of a terminal paste.
 *
 * A PTY is a byte stream, so an image has nowhere to go in it. What every
 * agent does understand is a path, so a bitmap on the clipboard is spilled to
 * a file first and the paste becomes that path. An image file copied in
 * Explorer or Finder is already on disk and is used where it lies.
 */

const SPILL_DIR = 'sertum-pastes';

/** Spilled images older than this are swept on the next paste. */
const KEEP_MS = 24 * 60 * 60 * 1000;

const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/tiff': '.tif',
};

const IMAGE_EXTENSIONS = new Set(Object.values(EXTENSIONS).concat('.jpeg'));

/**
 * The formats a copied *file* hides behind. `getType` rejects on a format the
 * item doesn't carry, which is the check.
 *
 * `text/uri-list` is what Explorer offers on Windows (verified: copying a file
 * there yields exactly this and a `file:///C:/...` URL). The macOS format is a
 * fallback for the same job and has not been exercised here.
 */
const FILE_FORMATS = [
  'text/uri-list',
  'electron application/osclipboard;format="public.file-url"',
];

export async function readClipboardPaste(): Promise<ClipboardPaste> {
  let items: Electron.ClipboardItem[] = [];
  try {
    items = await clipboard.read();
  } catch {
    return { kind: 'empty' };
  }

  // A bitmap wins over text: an image copied from a browser puts both on the
  // clipboard, and the image is the part worth having.
  const bitmap = await readBitmap(items);
  if (bitmap) return { kind: 'image', path: bitmap };

  const file = await readImageFilePath(items);
  if (file) return { kind: 'image', path: file };

  const text = await clipboard.readText().catch(() => '');
  return text ? { kind: 'text', text } : { kind: 'empty' };
}

/** Spills the first image on the clipboard to disk, returning its path. */
async function readBitmap(
  items: Electron.ClipboardItem[],
): Promise<string | null> {
  for (const item of items) {
    const mime = item.types.find((type) => type.startsWith('image/'));
    if (!mime) continue;
    try {
      const blob = (await item.getType(mime)) as Blob;
      const bytes = Buffer.from(await blob.arrayBuffer());
      if (bytes.length) return spill(bytes, EXTENSIONS[mime] ?? '.png');
    } catch {
      // Another format may still work.
    }
  }
  return null;
}

/** Writes bytes into the temp dir, returning the path, or null if that failed. */
function spill(bytes: Buffer, extension: string): string | null {
  try {
    const dir = path.join(app.getPath('temp'), SPILL_DIR);
    fs.mkdirSync(dir, { recursive: true });
    sweep(dir);
    const target = path.join(dir, `paste-${Date.now()}${extension}`);
    fs.writeFileSync(target, bytes);
    return target;
  } catch {
    return null;
  }
}

/**
 * Deletes spilled images the agent has long since read.
 *
 * Nothing tracks whether a path was actually used -- an agent may read it
 * seconds later or never -- so age is the only safe signal, and a day is far
 * longer than any live turn.
 */
function sweep(dir: string): void {
  const cutoff = Date.now() - KEEP_MS;
  for (const name of fs.readdirSync(dir)) {
    const entry = path.join(dir, name);
    try {
      if (fs.statSync(entry).mtimeMs < cutoff) fs.unlinkSync(entry);
    } catch {
      // Another window may have swept it already.
    }
  }
}

/** The path of an image file copied in the OS file manager, if that is what this is. */
async function readImageFilePath(
  items: Electron.ClipboardItem[],
): Promise<string | null> {
  for (const item of items) {
    for (const format of FILE_FORMATS) {
      const candidate = await readFilePath(item, format);
      if (!candidate) continue;
      if (!IMAGE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) continue;
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // A path to nothing is not a paste.
      }
    }
  }
  return null;
}

async function readFilePath(
  item: Electron.ClipboardItem,
  format: string,
): Promise<string | null> {
  try {
    const blob = (await item.getType(format)) as Blob;
    const line = (await blob.text()).split(/\r?\n/)[0]?.trim();
    if (!line) return null;
    return line.startsWith('file:') ? fileURLToPath(line) : line;
  } catch {
    return null;
  }
}
