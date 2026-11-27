// Reading stored messages: the HTML part (with inline cid: images made self-contained) and the attachments.
// Runs in the data process, on demand, from the raw message already on disk.
import { simpleParser, type Attachment } from 'mailparser';

/** Inline images are embedded as data: URLs up to this total, so the reader never fetches them. */
const INLINE_LIMIT = 8 * 1024 * 1024;

export interface AttachmentInfo {
  index: number;
  filename: string;
  contentType: string;
  size: number;
}

const isInline = (a: Attachment) => a.related || (a.contentDisposition === 'inline' && !!a.contentId && a.contentType.startsWith('image/'));

/** The message's HTML, or null when it has none. */
export async function extractHtml(raw: Uint8Array): Promise<string | null> {
  if (!raw.length) return null;
  const parsed = await simpleParser(Buffer.from(raw), { skipTextToHtml: true, skipImageLinks: true });
  if (!parsed.html) return null;
  let html = parsed.html;
  let budget = INLINE_LIMIT;
  for (const a of parsed.attachments) {
    if (!a.contentId || !a.contentType.startsWith('image/') || a.size > budget) continue;
    const cid = a.contentId.replace(/^<|>$/g, '');
    const url = `data:${a.contentType};base64,${a.content.toString('base64')}`;
    const before = html;
    html = html.split(`cid:${cid}`).join(url);
    if (html !== before) budget -= a.size;
  }
  return html;
}

/** Attachments a person would want to open or save: inline images shown in the body are left out. */
export async function listAttachments(raw: Uint8Array): Promise<AttachmentInfo[]> {
  if (!raw.length) return [];
  const parsed = await simpleParser(Buffer.from(raw), { skipTextToHtml: true, skipImageLinks: true });
  return parsed.attachments.flatMap((a, index) =>
    isInline(a) ? [] : [{ index, filename: a.filename || `attachment-${index + 1}`, contentType: a.contentType, size: a.size }]);
}

/** One attachment's bytes, by its index in the message. */
export async function attachmentContent(raw: Uint8Array, index: number): Promise<{ filename: string; contentType: string; content: Uint8Array } | null> {
  if (!raw.length) return null;
  const parsed = await simpleParser(Buffer.from(raw), { skipTextToHtml: true, skipImageLinks: true });
  const a = parsed.attachments[index];
  return a ? { filename: a.filename || `attachment-${index + 1}`, contentType: a.contentType, content: new Uint8Array(a.content) } : null;
}
