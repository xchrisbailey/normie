// Replies and forwards: who they go to, their subject, threading headers and the quoted text. Pure.
import type { Address, OutgoingMessage } from './types';

/** The message being replied to or forwarded, as read from the store. */
export interface Original {
  messageId?: string;
  references: Array<string>;
  from?: Address;
  replyTo: Array<Address>;
  to: Array<Address>;
  cc: Array<Address>;
  subject: string;
  date: number;
  text: string;
  attachments: Array<{ filename: string; contentType: string; content: Uint8Array }>;
}

export type ReplyKind = 'reply' | 'replyAll' | 'forward';

const same = (a: Address, b: Address) => a.address.toLowerCase() === b.address.toLowerCase();
const dedupe = (list: Array<Address>) => list.filter((a, i) => list.findIndex((b) => same(a, b)) === i);
const without = (list: Array<Address>, drop: Array<Address>) => list.filter((a) => !drop.some((d) => same(a, d)));
const label = (a?: Address) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : 'someone');

export function prefixed(subject: string, kind: ReplyKind): string {
  const s = subject.trim();
  if (kind === 'forward') {return /^(fwd?|fw):/i.test(s) ? s : `Fwd: ${s}`;}
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

const quote = (text: string) => text.replaceAll('\r\n', '\n').trimEnd().split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');

/**
 * Plan a reply or forward. `mine` are my Identities' addresses, for leaving myself out and for picking the From:
 * a reply goes out from the Identity the original was sent to.
 */
export function planReply(kind: ReplyKind, o: Original, mine: Array<Address>, when = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })) {
  const fromMe = !!o.from && mine.some((m) => same(m, o.from!));
  const identity = mine.find((m) => [...o.to, ...o.cc].some((a) => same(a, m))) ?? (fromMe ? o.from : undefined);
  const date = when.format(o.date);
  const threading = o.messageId
    ? { inReplyTo: o.messageId, references: [...o.references.filter((r) => r !== o.messageId), o.messageId].slice(-20) }
    : { references: o.references.slice(-20) };

  if (kind === 'forward') {
    const header = [
      '---------- Forwarded message ---------',
      `From: ${label(o.from)}`,
      `Date: ${date}`,
      `Subject: ${o.subject}`,
      `To: ${o.to.map(label).join(', ')}`,
      ...(o.cc.length ? [`Cc: ${o.cc.map(label).join(', ')}`] : []),
    ].join('\n');
    return {
      ...(identity ? { from: identity } : {}),
      to: [], cc: [], bcc: [],
      subject: prefixed(o.subject, 'forward'),
      body: `\n\n${header}\n\n${o.text.trimEnd()}`,
      attachments: o.attachments,
    } satisfies Partial<OutgoingMessage>;
  }

  // Replying to my own message goes to the people I wrote to.
  const primary = fromMe ? o.to : o.replyTo.length ? o.replyTo : o.from ? [o.from] : [];
  let to = dedupe(primary);
  let cc: Array<Address> = [];
  if (kind === 'replyAll') {
    to = dedupe([...to, ...(fromMe ? [] : without(o.to, mine))]);
    cc = without(dedupe(o.cc), [...mine, ...to]);
  }
  if (!fromMe) {to = without(to, mine);}
  return {
    ...(identity ? { from: identity } : {}),
    to, cc, bcc: [],
    subject: prefixed(o.subject, 'reply'),
    body: `\n\nOn ${date}, ${label(o.from)} wrote:\n${quote(o.text)}`,
    ...threading,
  } satisfies Partial<OutgoingMessage>;
}
