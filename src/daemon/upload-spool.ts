import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describeChatAttachment } from '../main/chat-attachments';
import type { ChatAttachment } from '../shared/types';

/** Larger than any image an agent takes natively; a generous bound for files. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Decoded. Fits one frame without one upload holding up the socket for long. */
export const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
export const MAX_ACTIVE_UPLOADS = 10;
/** An upload nothing has written to for this long was abandoned. */
export const ABANDONED_MS = 60 * 60_000;
/**
 * A finished file stays this long, because the transcript names its path and an
 * agent may read it again on a later turn.
 */
export const RETAIN_MS = 7 * 24 * 60 * 60_000;

const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * A file name from another device, made safe to create here. It decides nothing
 * but what the agent sees, since each upload gets a random folder of its own.
 */
export function safeUploadName(name: string): string {
  const base = String(name).split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/[. ]+$/, '')
    .replace(/^\.+/, '');
  const ext = path.extname(cleaned).slice(0, 16);
  const stem = cleaned.slice(0, cleaned.length - path.extname(cleaned).length).slice(0, 100);
  const joined = `${stem}${ext}`;
  if (!stem) return 'upload';
  return RESERVED_WINDOWS_NAME.test(joined) ? `_${joined}` : joined;
}

interface ActiveUpload {
  handle: fs.promises.FileHandle;
  folder: string;
  file: string;
  size: number;
  received: number;
  writing: boolean;
  touchedAt: number;
}

/**
 * Where a file from another device waits to become an attachment.
 *
 * A phone has no path the agent can read, so its bytes land here first and what
 * comes back is an ordinary `ChatAttachment` for `chat/submit`. Chunks arrive in
 * order and each states its offset, so a repeat or a gap is an error rather than
 * a corrupt file. Bytes are written to a random folder under the daemon's own
 * directory, and nothing a client sends names a location.
 */
export class UploadSpool {
  private readonly active = new Map<string, ActiveUpload>();

  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  async begin(request: { name: string; size: number }): Promise<{ uploadId: string }> {
    const { size } = request;
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('An upload needs a size.');
    if (size > MAX_UPLOAD_BYTES) throw new Error('That file is too large to send.');
    await this.sweep();
    if (this.active.size >= MAX_ACTIVE_UPLOADS) throw new Error('Too many uploads are in progress.');
    const uploadId = randomUUID();
    const folder = path.join(this.root, uploadId);
    await fs.promises.mkdir(folder, { recursive: true });
    const file = path.join(folder, safeUploadName(request.name));
    const handle = await fs.promises.open(file, 'wx');
    this.active.set(uploadId, {
      handle, folder, file, size, received: 0, writing: false, touchedAt: this.now(),
    });
    return { uploadId };
  }

  /** Answers how many bytes are held, so a client knows where it stands. */
  async chunk(request: { uploadId: string; offset: number; data: string }): Promise<{ received: number }> {
    const upload = this.active.get(request.uploadId);
    if (!upload) throw new Error('That upload is not in progress.');
    if (upload.writing) throw new Error('Send one chunk at a time.');
    if (request.offset !== upload.received) {
      throw new Error(`Expected a chunk at ${upload.received}, not ${request.offset}.`);
    }
    if (typeof request.data !== 'string' || !request.data || request.data.length % 4 !== 0 ||
      !BASE64.test(request.data)) {
      throw new Error('A chunk has to be base64.');
    }
    const bytes = Buffer.from(request.data, 'base64');
    if (bytes.length > MAX_CHUNK_BYTES) throw new Error('That chunk is too large.');
    if (upload.received + bytes.length > upload.size) {
      await this.abort(request);
      throw new Error('More bytes arrived than the upload declared.');
    }
    upload.writing = true;
    try {
      await upload.handle.write(bytes, 0, bytes.length);
    } finally {
      upload.writing = false;
    }
    upload.received += bytes.length;
    upload.touchedAt = this.now();
    return { received: upload.received };
  }

  async finish(request: { uploadId: string }): Promise<ChatAttachment> {
    const upload = this.active.get(request.uploadId);
    if (!upload) throw new Error('That upload is not in progress.');
    if (upload.writing) throw new Error('A chunk is still being written.');
    if (upload.received !== upload.size) {
      throw new Error(`Received ${upload.received} of ${upload.size} bytes.`);
    }
    this.active.delete(request.uploadId);
    await upload.handle.close();
    const attachment = describeChatAttachment(upload.file);
    if (!attachment) throw new Error('The uploaded file could not be read back.');
    return attachment;
  }

  async abort(request: { uploadId: string }): Promise<boolean> {
    const upload = this.active.get(request.uploadId);
    if (!upload) return false;
    this.active.delete(request.uploadId);
    await upload.handle.close().catch(() => undefined);
    await fs.promises.rm(upload.folder, { recursive: true, force: true }).catch(() => undefined);
    return true;
  }

  /** Drops abandoned uploads and finished files past their retention. */
  async sweep(): Promise<void> {
    const now = this.now();
    for (const [uploadId, upload] of this.active) {
      if (!upload.writing && now - upload.touchedAt > ABANDONED_MS) await this.abort({ uploadId });
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || this.active.has(entry.name)) continue;
      const folder = path.join(this.root, entry.name);
      try {
        const { mtimeMs } = await fs.promises.stat(folder);
        if (now - mtimeMs > RETAIN_MS) await fs.promises.rm(folder, { recursive: true, force: true });
      } catch {
        // Gone already, or in use. The next sweep looks again.
      }
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.active.keys()].map((uploadId) => this.abort({ uploadId })));
  }
}
