// Reading stored messages: the HTML part (with inline cid: images made self-contained) and the attachments.
// Runs in the data process, on demand, from the raw message already on disk.
import { simpleParser, type AddressObject, type Attachment } from 'mailparser';
import type { Original } from './reply';
import type { Address } from './types';

/** Inline images are embedded as data: URLs up to this total, so the reader never fetches them. */
const INLINE_LIMIT = 8 * 1024 * 1024;

import type { AttachmentInfo } from './types';

const isInline = (a: Attachment) => a.related || (a.contentDisposition === 'inline' && !!a.contentId && a.contentType.startsWith('image/'));

export interface ReadMessage {
  /** The HTML part, or null when there is none. */
  html: string | null;
  attachments: AttachmentInfo[];
}

/** What the reader needs from a stored message, in one parse: its HTML and its attachments. */
export async function readMessage(raw: Uint8Array): Promise<ReadMessage> {
  if (!raw.length) return { html: null, attachments: [] };
  const parsed = await simpleParser(Buffer.from(raw), { skipTextToHtml: true, skipImageLinks: true });
  const attachments = parsed.attachments.flatMap((a, index) =>
    isInline(a) ? [] : [{ index, filename: a.filename || `attachment-${index + 1}`, contentType: a.contentType, size: a.size }]);
  if (!parsed.html) return { html: null, attachments };
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
  return { html, attachments };
}

/** The message's HTML, or null when it has none. */
export async function extractHtml(raw: Uint8Array): Promise<string | null> {
  return (await readMessage(raw)).html;
}

/** One attachment's bytes, by its index in the message. */
export async function attachmentContent(raw: Uint8Array, index: number): Promise<{ filename: string; contentType: string; content: Uint8Array } | null> {
  if (!raw.length) return null;
  const parsed = await simpleParser(Buffer.from(raw), { skipTextToHtml: true, skipImageLinks: true });
  const a = parsed.attachments[index];
  return a ? { filename: a.filename || `attachment-${index + 1}`, contentType: a.contentType, content: new Uint8Array(a.content) } : null;
}

const addressesOf = (a?: AddressObject | AddressObject[]): Address[] =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((o) => o.value).flatMap((v) => (v.address ? [v.name ? { name: v.name, address: v.address } : { address: v.address }] : []));

/** What a reply or forward needs from a stored message. Attachments only when asked (for a forward). */
export async function readOriginal(raw: Uint8Array, withAttachments: boolean): Promise<Original> {
  const parsed = await simpleParser(Buffer.from(raw), { skipTextToHtml: true, skipImageLinks: true });
  const refs = parsed.references ? (Array.isArray(parsed.references) ? parsed.references : parsed.references.split(/\s+/)) : [];
  const from = addressesOf(parsed.from)[0];
  return {
    ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
    references: refs.filter(Boolean),
    ...(from ? { from } : {}),
    replyTo: addressesOf(parsed.replyTo),
    to: addressesOf(parsed.to),
    cc: addressesOf(parsed.cc),
    subject: parsed.subject ?? '',
    date: parsed.date?.getTime() ?? 0,
    text: (parsed.text ?? '').replace(/\r\n/g, '\n').trim(),
    attachments: withAttachments
      ? parsed.attachments.filter((a) => !isInline(a)).map((a) => ({ filename: a.filename || 'attachment', contentType: a.contentType, content: new Uint8Array(a.content) }))
      : [],
  };
}
