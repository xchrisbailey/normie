// An in-memory MailProvider that plays a scripted mailbox. Used by core tests,
// the performance fixture and `npm run start:fake`.
import { ServerRejectedError } from './types';
import type {
  Address, Caps, ChangeSet, ChangesOptions, FlagChange, Mailbox, MailEvent, MailProvider, MailTransport, MessageEdit, RawMessage, RemoteHeader, SyncState,
} from './types';

export interface FakeMessageInput {
  subject: string;
  from?: Address;
  to?: Address[];
  date?: number;
  flags?: string[];
  labels?: string[];
  threadId?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  text?: string;
  /** The whole raw message (headers and MIME body), instead of a plain-text one built from `text`. */
  raw?: string;
}

interface Stored {
  header: RemoteHeader;
  modseq: bigint;
  text: string;
  raw?: string;
}

interface FakeBox {
  mailbox: Mailbox;
  uidValidity: string;
  uidNext: number;
  modseq: bigint;
  messages: Map<number, Stored>;
  /** uid -> modseq at which it vanished, for QRESYNC. */
  vanished: Map<number, bigint>;
}

/** Gmail-like defaults: Labels, server threads, CONDSTORE without QRESYNC. */
export const GMAIL_CAPS: Caps = { condstore: true, qresync: false, move: true, labels: true, serverThreads: true, savesSent: true };
/** iCloud-like: folders, CONDSTORE and QRESYNC, no MOVE. */
export const ICLOUD_CAPS: Caps = { condstore: true, qresync: true, move: false, labels: false, serverThreads: false, savesSent: false };

export class FakeProvider implements MailProvider {
  readonly caps: Caps;
  private boxes = new Map<string, FakeBox>();
  private watchers = new Set<(e: MailEvent | 'drop') => void>();
  connected = false;
  /** Set to make the next calls fail, to simulate network trouble. */
  failNext = 0;
  calls: string[] = [];
  /** Set to make the server refuse the next edits (the connection stays up). */
  rejectEdits = 0;
  /** Messages appended (such as sent copies), in order. */
  appends: { mailbox: string; raw: string; flags: string[] }[] = [];
  /** Every edit the core sent, in order. */
  edits: { mailbox: string; uids: number[]; edit: MessageEdit }[] = [];

  constructor(opts: { caps?: Partial<Caps>; mailboxes?: Mailbox[] } = {}) {
    this.caps = { ...GMAIL_CAPS, ...opts.caps };
    const boxes = opts.mailboxes ?? (this.caps.labels
      ? [{ path: 'INBOX', role: 'inbox' }, { path: '[Gmail]/All Mail', role: 'all' }, { path: '[Gmail]/Sent Mail', role: 'sent' }, { path: '[Gmail]/Drafts', role: 'drafts' }]
      : [{ path: 'INBOX', role: 'inbox' }, { path: 'Sent Messages', role: 'sent' }, { path: 'Drafts', role: 'drafts' }]) as Mailbox[];
    for (const m of boxes) this.addMailbox(m);
  }

  /** The mailbox new messages go to: All Mail with Labels, Inbox without. */
  get primaryPath() {
    const want = this.caps.labels ? 'all' : 'inbox';
    return [...this.boxes.values()].find((b) => b.mailbox.role === want)!.mailbox.path;
  }

  addMailbox(m: Mailbox) {
    this.boxes.set(m.path, { mailbox: m, uidValidity: '1', uidNext: 1, modseq: 1n, messages: new Map(), vanished: new Map() });
  }

  private box(path: string) {
    const b = this.boxes.get(path);
    if (!b) throw new Error(`no such mailbox ${path}`);
    return b;
  }

  private check(call: string) {
    this.calls.push(call);
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error(`fake network failure in ${call}`);
    }
  }

  private emit(e: MailEvent | 'drop', labels?: string[]) {
    for (const w of this.watchers) w(e);
    // Like Gmail: a change to a message carrying the Inbox label is also an event on INBOX.
    if (e !== 'drop' && this.caps.labels && labels?.includes('\\Inbox')) {
      const inbox = [...this.boxes.values()].find((b) => b.mailbox.role === 'inbox')?.mailbox.path;
      if (inbox && inbox !== e.mailbox) for (const w of this.watchers) w({ ...e, mailbox: inbox });
    }
  }

  // --- Scripting

  /** Like Gmail: a reply joins the Thread of the message it answers. */
  private threadOfMessage(messageId?: string): string | undefined {
    if (!messageId) return undefined;
    for (const b of this.boxes.values()) for (const m of b.messages.values()) if (m.header.messageId === messageId) return m.header.threadId;
    return undefined;
  }

  /** Deliver a message. Returns its UID. */
  deliver(input: FakeMessageInput, path = this.primaryPath): number {
    const b = this.box(path);
    const uid = b.uidNext++;
    b.modseq++;
    const messageId = input.messageId ?? (input.raw && /^Message-ID: (.*)$/im.exec(input.raw)?.[1]?.trim()) ?? `<fake-${path}-${uid}@normie.test>`;
    b.messages.set(uid, {
      modseq: b.modseq,
      text: input.text ?? `Body of ${input.subject}`,
      ...(input.raw ? { raw: input.raw } : {}),
      header: {
        uid, remoteId: this.caps.labels ? `gm-${uid}` : `${path}:${uid}`,
        threadId: this.caps.serverThreads ? (input.threadId ?? this.threadOfMessage(input.inReplyTo ?? (input.raw && /^In-Reply-To: (.*)$/im.exec(input.raw)?.[1]?.trim())) ?? `t-${uid}`) : undefined,
        messageId, inReplyTo: input.inReplyTo, references: input.references,
        subject: input.subject, from: input.from ?? { name: 'Sender', address: 'sender@example.com' }, to: input.to ?? [{ address: 'me@example.com' }],
        date: input.date ?? Date.now(), flags: input.flags ?? [], labels: input.labels ?? (this.caps.labels ? ['\\Inbox'] : [path]),
      },
    });
    this.emit({ type: 'exists', mailbox: path }, b.messages.get(uid)!.header.labels);
    return uid;
  }

  /** Change flags (and Labels) as another device would. */
  setFlags(uid: number, change: { flags?: string[]; labels?: string[] }, path = this.primaryPath) {
    const b = this.box(path);
    const m = b.messages.get(uid);
    if (!m) throw new Error(`no uid ${uid}`);
    b.modseq++;
    m.modseq = b.modseq;
    if (change.flags) m.header.flags = change.flags;
    if (change.labels) m.header.labels = change.labels;
    this.emit({ type: 'flags', mailbox: path, uid, flags: m.header.flags }, m.header.labels);
  }

  /** Delete a message as another device would. */
  expunge(uid: number, path = this.primaryPath) {
    const b = this.box(path);
    const m = b.messages.get(uid);
    if (!m || !b.messages.delete(uid)) return;
    b.modseq++;
    b.vanished.set(uid, b.modseq);
    this.emit({ type: 'expunge', mailbox: path, uid }, m.header.labels);
  }

  /** Simulate a network drop: open IDLE connections fail, and the next `failCalls` calls fail too. */
  drop(failCalls = 1) {
    this.connected = false;
    this.failNext = failCalls;
    for (const w of this.watchers) w('drop');
  }

  /** Simulate the server resetting UIDVALIDITY. */
  resetUidValidity(path = this.primaryPath) {
    const b = this.box(path);
    b.uidValidity = String(Number(b.uidValidity) + 1);
    b.vanished.clear();
  }

  // --- MailProvider

  async connect() {
    this.check('connect');
    this.connected = true;
  }

  async close() {
    this.connected = false;
  }

  async listMailboxes() {
    this.check('listMailboxes');
    return [...this.boxes.values()].map((b) => b.mailbox);
  }

  private stateOf(b: FakeBox): SyncState {
    return { uidValidity: b.uidValidity, uidNext: b.uidNext, ...(this.caps.condstore ? { highestModseq: String(b.modseq) } : {}) };
  }

  async changes(path: string, since: SyncState | null, opts: ChangesOptions): Promise<ChangeSet> {
    this.check('changes');
    const b = this.box(path);
    const state = this.stateOf(b);
    const inWindow = (m: Stored) => m.header.date >= opts.windowStart;
    const copy = (h: RemoteHeader): RemoteHeader => ({ ...h, flags: [...h.flags], labels: [...h.labels] });
    if (!since || since.uidValidity !== b.uidValidity) {
      const headers = [...b.messages.values()].filter(inWindow).map((m) => copy(m.header));
      return { state, reset: true, headers, flagChanges: [], vanished: [] };
    }
    const headers = [...b.messages.values()].filter((m) => m.header.uid >= since.uidNext && inWindow(m)).map((m) => copy(m.header));
    let flagChanges: FlagChange[] = [];
    let vanished: number[] = [];
    if (this.caps.condstore && since.highestModseq) {
      const base = BigInt(since.highestModseq);
      flagChanges = [...b.messages.values()]
        .filter((m) => m.header.uid < since.uidNext && m.modseq > base)
        .map((m) => ({ uid: m.header.uid, flags: [...m.header.flags], ...(this.caps.labels ? { labels: [...m.header.labels] } : {}) }));
      if (this.caps.qresync) vanished = [...b.vanished].filter(([, s]) => s > base).map(([uid]) => uid);
    } else {
      // No CONDSTORE: report the flags of every known message in the window.
      flagChanges = [...b.messages.values()]
        .filter((m) => m.header.uid < since.uidNext && inWindow(m))
        .map((m) => ({ uid: m.header.uid, flags: [...m.header.flags] }));
    }
    return { state, reset: false, headers, flagChanges, vanished };
  }

  async uids(path: string, opts: ChangesOptions) {
    this.check('uids');
    return [...this.box(path).messages.values()].filter((m) => m.header.date >= opts.windowStart).map((m) => m.header.uid);
  }

  async uidsBefore(path: string, before: number) {
    this.check('uidsBefore');
    return [...this.box(path).messages.values()].filter((m) => m.header.date < before).map((m) => m.header.uid);
  }

  async headers(path: string, uids: number[]): Promise<RemoteHeader[]> {
    this.check('headers');
    const b = this.box(path);
    return uids.flatMap((uid) => {
      const m = b.messages.get(uid);
      return m ? [{ ...m.header, flags: [...m.header.flags], labels: [...m.header.labels] }] : [];
    });
  }

  async fetchBodies(path: string, uids: number[]): Promise<RawMessage[]> {
    this.check('fetchBodies');
    const b = this.box(path);
    return uids.flatMap((uid) => {
      const m = b.messages.get(uid);
      if (!m) return [];
      const raw = m.raw ?? `Subject: ${m.header.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${m.text}`;
      return [{ uid, raw: new TextEncoder().encode(raw) }];
    });
  }

  async edit(path: string, uids: number[], edit: MessageEdit) {
    this.check('edit');
    if (!this.connected) throw new Error('fake: not connected');
    if (this.rejectEdits > 0) {
      this.rejectEdits--;
      throw new ServerRejectedError('fake: server refused the edit');
    }
    const b = this.box(path);
    this.edits.push({ mailbox: path, uids: [...uids], edit });
    const apply = (xs: string[], add?: string[], remove?: string[]) => {
      const set = new Set(xs);
      remove?.forEach((x) => set.delete(x));
      add?.forEach((x) => set.add(x));
      return [...set];
    };
    for (const uid of uids) {
      const m = b.messages.get(uid);
      if (!m) continue;
      const before = m.header.labels;
      this.setFlags(uid, {
        flags: apply(m.header.flags, edit.addFlags, edit.removeFlags),
        ...(this.caps.labels ? { labels: apply(m.header.labels, edit.addLabels, edit.removeLabels) } : {}),
      }, path);
      // Removing the Inbox label is also an event on INBOX, as on Gmail.
      if (before.includes('\\Inbox') && !m.header.labels.includes('\\Inbox')) this.emit({ type: 'flags', mailbox: path, uid, flags: m.header.flags }, before);
    }
  }

  async append(path: string, raw: Uint8Array, flags: string[]) {
    this.check('append');
    if (!this.connected) throw new Error('fake: not connected');
    const text = new TextDecoder().decode(raw);
    this.appends.push({ mailbox: path, raw: text, flags });
    const subject = /^Subject: (.*)$/m.exec(text)?.[1]?.trim() ?? '';
    const messageId = /^Message-ID: (.*)$/im.exec(text)?.[1]?.trim();
    const uid = this.deliver({ subject, flags, ...(messageId ? { messageId } : {}), raw: text, labels: this.caps.labels ? [flags.includes('\\Draft') ? '\\Draft' : '\\Sent'] : [path] }, path);
    return { uid };
  }

  /** Messages deleted for good by the core, in order. */
  removed: { mailbox: string; uids: number[] }[] = [];

  async remove(path: string, uids: number[]) {
    this.check('remove');
    if (!this.connected) throw new Error('fake: not connected');
    this.removed.push({ mailbox: path, uids: [...uids] });
    for (const uid of uids) this.expunge(uid, path);
  }

  /** What's in a mailbox now, for tests. */
  contents(path: string): { uid: number; subject: string; flags: string[] }[] {
    return [...this.box(path).messages.values()].map((m) => ({ uid: m.header.uid, subject: m.header.subject, flags: m.header.flags }));
  }

  async *watch(path: string, signal: AbortSignal): AsyncIterable<MailEvent> {
    this.check('watch');
    const queue: MailEvent[] = [];
    let dropped = false;
    let wake: (() => void) | undefined;
    const fn = (e: MailEvent | 'drop') => {
      if (e === 'drop') dropped = true;
      else if (e.mailbox === path) queue.push(e);
      else return;
      wake?.();
    };
    this.watchers.add(fn);
    const onAbort = () => wake?.();
    signal.addEventListener('abort', onAbort);
    try {
      while (!signal.aborted) {
        if (!queue.length && !dropped) await new Promise<void>((r) => (wake = r));
        wake = undefined;
        if (dropped) throw new Error('fake connection dropped');
        while (queue.length) yield queue.shift()!;
      }
    } finally {
      this.watchers.delete(fn);
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/** Extracts the text of a fake message (everything after the header block). */
export async function fakeExtractText(raw: Uint8Array): Promise<string> {
  const s = new TextDecoder().decode(raw);
  const i = s.indexOf('\r\n\r\n');
  return i < 0 ? '' : s.slice(i + 4);
}

/** A small demo mailbox for `npm run start:fake`. */
export function seedDemo(p: FakeProvider, count = 40, now = Date.now()) {
  const people = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Katherine Johnson', 'Linus Torvalds', 'Margaret Hamilton'];
  // A few Labels to file into (Gmail-like mailboxes only).
  if (p.caps.labels) for (const path of ['Receipts', 'Travel', 'Work/Projects']) p.addMailbox({ path });
  const topics = ['Quarterly budget', 'Flight to Lisbon', 'Release notes', 'Lunch on Friday', 'Invoice #4821', 'Design review', 'Hotel booking', 'CI is red again'];
  for (let i = 0; i < count; i++) {
    const name = people[i % people.length]!;
    const subject = `${topics[Math.floor(i / 3) % topics.length]!}${i >= 3 * topics.length ? ` (${Math.floor(i / 3)})` : ''}`;
    p.deliver({
      subject,
      from: { name, address: `${name.split(' ')[0]!.toLowerCase()}@example.com` },
      // Messages 20 minutes apart, three to a Thread, so thousands of them fit inside the 90-day window.
      date: now - i * 1_200_000,
      threadId: `t-${Math.floor(i / 3)}`,
      flags: i % 3 === 0 ? [] : ['\\Seen'],
      text: `Hi,\n\nA note about ${subject.toLowerCase()}.\n\n${name}`,
    });
  }
}

/** An HTML newsletter with the usual hazards (a script, a tracking pixel, a javascript: link), for the fake mailbox. */
export function seedNewsletter(p: FakeProvider, now = Date.now()) {
  const html = [
    '<style>h1 { color: #d20f39 }</style>',
    '<h1>Hello from Normie</h1>',
    '<p>This is an <b>HTML</b> newsletter. <a href="https://example.com/read">Read more</a> or <a href="javascript:alert(1)">do not click</a>.</p>',
    '<img src="https://tracker.example/open.gif" width="1" height="1">',
    '<script>document.title = "pwned"</script>',
  ].join('\n');
  p.deliver({
    subject: 'The Normie Weekly', from: { name: 'Normie Weekly', address: 'weekly@example.com' }, date: now + 1000, threadId: 't-weekly',
    raw: [
      'Subject: The Normie Weekly', 'From: Normie Weekly <weekly@example.com>', 'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="m"', '',
      '--m', 'Content-Type: multipart/alternative; boundary="b"', '',
      '--b', 'Content-Type: text/plain; charset=utf-8', '', 'Hello from Normie. This is an HTML newsletter.', '',
      '--b', 'Content-Type: text/html; charset=utf-8', '', html, '', '--b--', '',
      '--m', 'Content-Type: text/plain; name="agenda.txt"', 'Content-Disposition: attachment; filename="agenda.txt"', '', 'Monday: ship it.', '',
      '--m--', '',
    ].join('\r\n'),
  });
}

/** An SMTP stand-in: records what was sent, and fails or refuses on cue. */
export class FakeTransport implements MailTransport {
  sent: { raw: string; envelope: { from: string; to: string[] } }[] = [];
  /** The next sends fail as a dropped connection would. */
  failNext = 0;
  /** The next sends are refused by the server. */
  rejectNext = 0;

  async send(raw: Uint8Array, envelope: { from: string; to: string[] }) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('fake SMTP: connection lost');
    }
    if (this.rejectNext > 0) {
      this.rejectNext--;
      throw new ServerRejectedError('fake SMTP: 550 rejected');
    }
    this.sent.push({ raw: new TextDecoder().decode(raw), envelope });
  }
}
