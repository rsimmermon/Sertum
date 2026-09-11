import { nativeImage } from 'electron';
import type { ChatAttachment } from '../shared/types';
import {
  describeChatAttachment,
  MAX_CHAT_IMAGE_BYTES,
} from './chat-attachments';

/** The largest bitmap the composer needs to draw for an attachment card. */
const PREVIEW_WIDTH = 320;
const PREVIEW_HEIGHT = 200;

/**
 * Build a bounded display thumbnail for a file the reader attached.
 *
 * The renderer keeps only the path descriptor in its draft. It asks for this
 * disposable PNG separately, and the trusted side re-stats the path and
 * checks its magic bytes again before reading it. Returning a thumbnail rather
 * than the source image prevents a row of previews from hauling several full
 * multi-megabyte images into Chromium.
 */
export function readChatAttachmentPreview(
  attachment: ChatAttachment,
): string | null {
  if (!attachment || typeof attachment.path !== 'string') return null;
  const actual = describeChatAttachment(attachment.path);
  if (!actual || actual.kind !== 'image' || actual.size > MAX_CHAT_IMAGE_BYTES) {
    return null;
  }

  try {
    const source = nativeImage.createFromPath(actual.path);
    if (source.isEmpty()) return null;
    const size = source.getSize();
    if (size.width <= 0 || size.height <= 0) return null;
    const scale = Math.min(
      1,
      PREVIEW_WIDTH / size.width,
      PREVIEW_HEIGHT / size.height,
    );
    const preview = scale < 1
      ? source.resize({
          width: Math.max(1, Math.round(size.width * scale)),
          height: Math.max(1, Math.round(size.height * scale)),
          quality: 'best',
        })
      : source;
    return preview.toDataURL();
  } catch {
    return null;
  }
}
