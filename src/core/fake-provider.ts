// An in-memory MailProvider that plays a scripted mailbox. Used by core tests,
// the performance fixture and `npm run start:fake`.
import type {
  Address, Caps, ChangeSet, ChangesOptions, FlagChange, Mailbox, MailEvent, MailProvider, RawMessage, RemoteHeader, SyncState,
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
}

interface Stored {
  header: RemoteHeader;
  modseq: bigint;
  text: string;
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
  private watchers = new Set<(e: MailEvent) => void>();
  connected = false;
  /** Set to make the next calls fail, to simulate network trouble. */
  failNext = 0;
  calls: string[] = [];

  constructor(opts: { caps?: Partial<Caps>; mailboxes?: Mailbox[] } = {}) {
    this.caps = { ...GMAIL_CAPS, ...opts.caps };
    const boxes = opts.mailboxes ?? (this.caps.labels
      ? [{ path: 'INBOX', role: 'inbox' }, { path: '[Gmail]/All Mail', role: 'all' }, { path: '[Gmail]/Sent Mail', role: 'sent' }]
      : [{ path: 'INBOX', role: 'inbox' }, { path: 'Sent Messages', role: 'sent' }]) as Mailbox[];
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

  private emit(e: MailEvent) {
    for (const w of this.watchers) w(e);
  }

  // --- Scripting

  /** Deliver a message. Returns its UID. */
  deliver(input: FakeMessageInput, path = this.primaryPath): number {
    const b = this.box(path);
    const uid = b.uidNext++;
    b.modseq++;
    const messageId = input.messageId ?? `<fake-${path}-${uid}@normie.test>`;
    b.messages.set(uid, {
      modseq: b.modseq,
      text: input.text ?? `Body of ${input.subject}`,
      header: {
        uid, remoteId: this.caps.labels ? `gm-${uid}` : `${path}:${uid}`,
        threadId: this.caps.serverThreads ? (input.threadId ?? `t-${uid}`) : undefined,
        messageId, inReplyTo: input.inReplyTo, references: input.references,
        subject: input.subject, from: input.from ?? { name: 'Sender', address: 'sender@example.com' }, to: input.to ?? [{ address: 'me@example.com' }],
        date: input.date ?? Date.now(), flags: input.flags ?? [], labels: input.labels ?? (this.caps.labels ? ['\\Inbox'] : [path]),
      },
    });
    this.emit({ type: 'exists', mailbox: path });
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
    this.emit({ type: 'flags', mailbox: path, uid, flags: m.header.flags });
  }

  /** Delete a message as another device would. */
  expunge(uid: number, path = this.primaryPath) {
    const b = this.box(path);
    if (!b.messages.delete(uid)) return;
    b.modseq++;
    b.vanished.set(uid, b.modseq);
    this.emit({ type: 'expunge', mailbox: path, uid });
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
      const raw = `Subject: ${m.header.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${m.text}`;
      return [{ uid, raw: new TextEncoder().encode(raw) }];
    });
  }

  async *watch(path: string, signal: AbortSignal): AsyncIterable<MailEvent> {
    const queue: MailEvent[] = [];
    let wake: (() => void) | undefined;
    const fn = (e: MailEvent) => {
      if (e.mailbox !== path) return;
      queue.push(e);
      wake?.();
    };
    this.watchers.add(fn);
    const onAbort = () => wake?.();
    signal.addEventListener('abort', onAbort);
    try {
      while (!signal.aborted) {
        if (!queue.length) await new Promise<void>((r) => (wake = r));
        wake = undefined;
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
