// Building outgoing mail: Markdown in, a multipart message with HTML and plain text out.
// Runs where mail is sent (the sync process) and in tests.
import { marked } from 'marked';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { Address, OutgoingMessage } from './types';

const fmt = (a: Address) => (a.name ? { name: a.name, address: a.address } : a.address);

/** Markdown to HTML for the HTML part. Raw HTML in the Markdown is escaped, not passed through. */
export function markdownToHtml(markdown: string): string {
  const escapeHtml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const body = marked.parse(markdown, { async: false, gfm: true, breaks: true, renderer: Object.assign(new marked.Renderer(), {
    html: ({ text }: { text: string }) => escapeHtml(text),
  }) });
  return `<!doctype html><html><body style="font-family: -apple-system, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5;">${body}</body></html>`;
}

export interface BuiltMessage {
  raw: Uint8Array;
  envelope: { from: string; to: Array<string> };
}

/** The full message, ready for SMTP and for appending to Sent. */
export async function buildMime(m: OutgoingMessage, messageId: string, date = new Date()): Promise<BuiltMessage> {
  const composer = new MailComposer({
    from: fmt(m.from),
    to: m.to.map(fmt),
    cc: m.cc.map(fmt),
    bcc: m.bcc.map(fmt),
    subject: m.subject,
    text: m.body,
    html: markdownToHtml(m.body),
    messageId,
    date,
    ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}),
    ...(m.references?.length ? { references: m.references } : {}),
    attachments: (m.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.content) })),
    headers: { 'X-Mailer': 'Normie' },
  });
  // MailComposer keeps Bcc in the envelope and out of the headers.
  const node = composer.compile();
  const raw = await node.build();
  const env = node.getEnvelope();
  return { raw: new Uint8Array(raw), envelope: { from: env.from || m.from.address, to: env.to } };
}
