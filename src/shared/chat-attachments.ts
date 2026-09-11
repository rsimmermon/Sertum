import type { ChatAttachment } from './types';

/** A bounded draft keeps native image requests and the composer usable. */
export const MAX_CHAT_ATTACHMENTS = 10;

/**
 * Add the part of an attachment an agent needs to the user's text.
 *
 * Images delivered through a native multimodal block need only a label here;
 * everything else needs its absolute path because coding agents read ordinary
 * attachments with their file tools. JSON quoting keeps spaces, slashes and
 * punctuation unambiguous without inventing shell syntax.
 */
export function promptWithAttachments(
  text: string,
  attachments: readonly ChatAttachment[],
  nativeImages: ReadonlySet<string> = new Set(),
): string {
  const supplied = text.replace(/\s+$/, '');
  const body = supplied.trim() ? supplied : (attachments.length === 1
    ? `Please review the attached ${attachments[0]?.kind === 'image' ? 'image' : 'file'}.`
    : 'Please review the attached files.');
  if (!attachments.length) return body;
  const lines = attachments.map((attachment) => {
    const name = attachment.name.replace(/\s+/g, ' ').trim() || 'attachment';
    return nativeImages.has(attachment.path)
      ? `- ${name} (image)`
      : `- ${name}: ${JSON.stringify(attachment.path)}`;
  });
  return `${body}\n\nAttachments:\n${lines.join('\n')}`;
}
