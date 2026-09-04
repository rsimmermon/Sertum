import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reading an image a message points at, so the chat view can show it.
 *
 * A markdown image carries an address written by the agent, and the renderer
 * is a web page: it cannot open a `file://` path, and letting it fetch an
 * arbitrary address out of a transcript is the thing the conversation view
 * deliberately does not do. So the read happens here, where every other
 * filesystem read in this app happens, and the renderer only ever receives a
 * `data:` URL — the one image source it already trusts from tool results.
 *
 * Three things bound it, and each failure is the same failure: the answer is
 * `null` and the message keeps the link it already had.
 *
 * - **Scope is the session's own folder.** The path is resolved against the
 *   cwd the user pointed the agent at and must still be inside it. That cwd
 *   comes from `SessionSnapshot`, never from the message, so a transcript
 *   cannot widen its own reach — and without the check, message text would
 *   be able to make the app read any file on disk and hand it to the
 *   renderer. Worktrees beneath a repository are covered by the same prefix
 *   test the permission rules use.
 * - **It must actually be an image**, decided by the bytes rather than the
 *   extension: a `.png` that is really something else is not sent.
 * - **It must be small enough to inline.** A data URL is base64 in the
 *   renderer's memory, so a large file is left as a link rather than turned
 *   into a multi-megabyte string on every repaint.
 */

/** Beyond this, a link beats inlining base64 into the renderer. */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Magic bytes, so the type comes from the file rather than its name. WEBP is
 * a RIFF container, so it is matched on both halves of its header.
 */
const SIGNATURES: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
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
  {
    mime: 'image/svg+xml',
    test: () => false, // never inlined: SVG carries script, and this is a page
  },
];

/** Whether `target` is `root` or sits beneath it, as a path rather than text. */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Turn a message's image address into a local file path, or null when it does
 * not name one. A remote URL is not this function's business.
 */
function toLocalPath(cwd: string, src: string): string | null {
  if (/^data:/i.test(src)) return null;
  if (/^https?:\/\//i.test(src)) return null;
  let candidate = src;
  if (/^file:\/\//i.test(src)) {
    try {
      candidate = fileURLToPath(src);
    } catch {
      return null;
    }
  } else {
    // A bare `?query#hash` is URL grammar, not part of a filename.
    candidate = candidate.replace(/[?#].*$/, '');
    try {
      candidate = decodeURI(candidate);
    } catch {
      // Not percent-encoded; use it as written.
    }
  }
  if (!candidate) return null;
  const resolved = path.resolve(cwd, candidate);
  return isInside(path.resolve(cwd), resolved) ? resolved : null;
}

/**
 * The image at `src` as a data URL, or null when it is not a readable local
 * image inside `cwd`. Null is the ordinary answer, not an error: the caller
 * keeps the link it already rendered.
 */
export function readLocalImage(cwd: string, src: string): string | null {
  if (!cwd || !src) return null;
  const file = toLocalPath(cwd, src);
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BYTES) return null;
    const bytes = fs.readFileSync(file);
    const match = SIGNATURES.find((s) => s.test(bytes));
    if (!match) return null;
    return `data:${match.mime};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}
