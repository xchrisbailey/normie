// An in-memory MailProvider that plays a scripted mailbox. Used by core tests,
// the performance fixture and `npm run start:fake`.
import type { ServerQuery } from './search-query';
import { expected } from './errors';
import { ServerRejectedError } from './types';
import type {
  Address,
  Caps,
  ChangeSet,
  ChangesOptions,
  FlagChange,
  Mailbox,
  MailEvent,
  MailProvider,
  MailTransport,
  MessageEdit,
  RawMessage,
  RemoteHeader,
  SyncState,
} from './types';

export interface FakeMessageInput {
  subject: string;
  from?: Address;
  to?: Array<Address>;
  date?: number;
  flags?: Array<string>;
  labels?: Array<string>;
  threadId?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: Array<string>;
  text?: string;
  /** The whole raw message (headers and MIME body), instead of a plain-text one built from `text`. */
  raw?: string;
  /** Sent to a list (List-Unsubscribe), as a newsletter is. */
  list?: boolean;
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

const copyHeader = (h: RemoteHeader): RemoteHeader => ({ ...h, flags: [...h.flags], labels: [...h.labels] });

const applyEdit = (xs: Array<string>, add?: Array<string>, remove?: Array<string>) => {
  const set = new Set(xs);
  remove?.forEach((x) => set.delete(x));
  add?.forEach((x) => set.add(x));
  return [...set];
};

const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());
const addr = (a?: Address) => (a ? `${a.name ?? ''} ${a.address}` : '');

export class FakeProvider implements MailProvider {
  readonly caps: Caps;
  private boxes = new Map<string, FakeBox>();
  private watchers = new Set<(e: MailEvent | 'drop') => void>();
  connected = false;
  /** Set to make the next calls fail, to simulate network trouble. */
  failNext = 0;
  calls: Array<string> = [];
  /** Set to make the server refuse the next edits (the connection stays up). */
  rejectEdits = 0;
  /** Messages appended (such as sent copies), in order. */
  appends: Array<{ mailbox: string; raw: string; flags: Array<string> }> = [];
  /** Every edit the core sent, in order. */
  edits: Array<{ mailbox: string; uids: Array<number>; edit: MessageEdit }> = [];

  constructor(opts: { caps?: Partial<Caps>; mailboxes?: Array<Mailbox> } = {}) {
    this.caps = { ...GMAIL_CAPS, ...opts.caps };
    const boxes =
      opts.mailboxes ??
      (this.caps.labels
        ? [
            { path: 'INBOX', role: 'inbox' },
            { path: '[Gmail]/All Mail', role: 'all' },
            { path: '[Gmail]/Sent Mail', role: 'sent' },
            { path: '[Gmail]/Drafts', role: 'drafts' },
          ]
        : [
            { path: 'INBOX', role: 'inbox' },
            { path: 'Sent Messages', role: 'sent' },
            { path: 'Drafts', role: 'drafts' },
            { path: 'Archive', role: 'archive' },
            { path: 'Deleted Messages', role: 'trash' },
          ]);
    for (const m of boxes) {
      this.addMailbox(m);
    }
  }

  /** The mailbox new messages go to: All Mail with Labels, Inbox without. */
  get primaryPath() {
    const want = this.caps.labels ? 'all' : 'inbox';
    return expected(
      [...this.boxes.values()].find((b) => b.mailbox.role === want),
      'a mailbox for new messages',
    ).mailbox.path;
  }

  addMailbox(m: Mailbox) {
    this.boxes.set(m.path, { mailbox: m, uidValidity: '1', uidNext: 1, modseq: 1n, messages: new Map(), vanished: new Map() });
  }

  private box(path: string) {
    const b = this.boxes.get(path);
    if (!b) {
      throw new Error(`no such mailbox ${path}`);
    }
    return b;
  }

  private check(call: string) {
    this.calls.push(call);
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error(`fake network failure in ${call}`);
    }
  }

  private emit(e: MailEvent | 'drop', labels?: Array<string>) {
    for (const w of this.watchers) {
      w(e);
    }
    // Like Gmail: a change to a message carrying the Inbox label is also an event on INBOX.
    if (e !== 'drop' && this.caps.labels && labels?.includes(String.raw`\Inbox`)) {
      const inbox = [...this.boxes.values()].find((b) => b.mailbox.role === 'inbox')?.mailbox.path;
      if (inbox && inbox !== e.mailbox) {
        for (const w of this.watchers) {
          w({ ...e, mailbox: inbox });
        }
      }
    }
  }

  // --- Scripting

  /** Like Gmail: a reply joins the Thread of the message it answers. */
  private threadOfMessage(messageId?: string): string | undefined {
    if (!messageId) {
      return undefined;
    }
    for (const b of this.boxes.values()) {
      for (const m of b.messages.values()) {
        if (m.header.messageId === messageId) {
          return m.header.threadId;
        }
      }
    }
    return undefined;
  }

  /** Deliver a message. Returns its UID. */
  deliver(input: FakeMessageInput, path = this.primaryPath): number {
    const b = this.box(path);
    const uid = b.uidNext++;
    b.modseq++;
    const messageId = input.messageId ?? (input.raw && /^Message-ID: (.*)$/im.exec(input.raw)?.[1]?.trim()) ?? `<fake-${path}-${uid}@normie.test>`;
    const stored: Stored = {
      modseq: b.modseq,
      text: input.text ?? `Body of ${input.subject}`,
      header: {
        uid,
        remoteId: this.caps.labels ? `gm-${uid}` : `${path}:${uid}`,
        threadId: this.caps.serverThreads
          ? (input.threadId ?? this.threadOfMessage(input.inReplyTo ?? (input.raw && /^In-Reply-To: (.*)$/im.exec(input.raw)?.[1]?.trim())) ?? `t-${uid}`)
          : undefined,
        messageId,
        inReplyTo: input.inReplyTo,
        references: input.references,
        subject: input.subject,
        from: input.from ?? { name: 'Sender', address: 'sender@example.com' },
        to: input.to ?? [{ address: 'me@example.com' }],
        date: input.date ?? Date.now(),
        flags: input.flags ?? [],
        labels: input.labels ?? (this.caps.labels ? [String.raw`\Inbox`] : [path]),
        isList: input.list ?? (input.raw ? /^(list-unsubscribe|list-id):/im.test(input.raw.split(/\r?\n\r?\n/)[0] ?? '') : false),
      },
    };
    if (input.raw) {
      stored.raw = input.raw;
    }
    b.messages.set(uid, stored);
    this.emit({ type: 'exists', mailbox: path }, stored.header.labels);
    return uid;
  }

  /** Change flags (and Labels) as another device would. */
  setFlags(uid: number, change: { flags?: Array<string>; labels?: Array<string> }, path = this.primaryPath) {
    const b = this.box(path);
    const m = b.messages.get(uid);
    if (!m) {
      throw new Error(`no uid ${uid}`);
    }
    b.modseq++;
    m.modseq = b.modseq;
    if (change.flags) {
      m.header.flags = change.flags;
    }
    if (change.labels) {
      m.header.labels = change.labels;
    }
    this.emit({ type: 'flags', mailbox: path, uid, flags: m.header.flags }, m.header.labels);
  }

  /** Delete a message as another device would. */
  expunge(uid: number, path = this.primaryPath) {
    const b = this.box(path);
    const m = b.messages.get(uid);
    if (!m || !b.messages.delete(uid)) {
      return;
    }
    b.modseq++;
    b.vanished.set(uid, b.modseq);
    this.emit({ type: 'expunge', mailbox: path, uid }, m.header.labels);
  }

  /** Simulate a network drop: open IDLE connections fail, and the next `failCalls` calls fail too. */
  drop(failCalls = 1) {
    this.connected = false;
    this.failNext = failCalls;
    for (const w of this.watchers) {
      w('drop');
    }
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
    const state: SyncState = { uidValidity: b.uidValidity, uidNext: b.uidNext };
    if (this.caps.condstore) {
      state.highestModseq = String(b.modseq);
    }
    return state;
  }

  async changes(path: string, since: SyncState | null, opts: ChangesOptions): Promise<ChangeSet> {
    this.check('changes');
    const b = this.box(path);
    const state = this.stateOf(b);
    const inWindow = (m: Stored) => m.header.date >= opts.windowStart;
    if (!since || since.uidValidity !== b.uidValidity) {
      const headers = [...b.messages.values()].flatMap((m) => (inWindow(m) ? [copyHeader(m.header)] : []));
      return { state, reset: true, headers, flagChanges: [], vanished: [] };
    }
    const headers = [...b.messages.values()].flatMap((m) => (m.header.uid >= since.uidNext && inWindow(m) ? [copyHeader(m.header)] : []));
    let flagChanges: Array<FlagChange>;
    let vanished: Array<number> = [];
    if (this.caps.condstore && since.highestModseq) {
      const base = BigInt(since.highestModseq);
      flagChanges = [...b.messages.values()].flatMap((m) => {
        if (m.header.uid >= since.uidNext || m.modseq <= base) {
          return [];
        }
        const change: FlagChange = { uid: m.header.uid, flags: [...m.header.flags] };
        if (this.caps.labels) {
          change.labels = [...m.header.labels];
        }
        return [change];
      });
      if (this.caps.qresync) {
        vanished = [...b.vanished].flatMap(([uid, s]) => (s > base ? [uid] : []));
      }
    } else {
      // No CONDSTORE: report the flags of every known message in the window.
      flagChanges = [...b.messages.values()].flatMap((m) =>
        m.header.uid < since.uidNext && inWindow(m) ? [{ uid: m.header.uid, flags: [...m.header.flags] }] : [],
      );
    }
    return { state, reset: false, headers, flagChanges, vanished };
  }

  async uids(path: string, opts: ChangesOptions) {
    this.check('uids');
    return [...this.box(path).messages.values()].flatMap((m) => (m.header.date >= opts.windowStart ? [m.header.uid] : []));
  }

  async uidsBefore(path: string, before: number) {
    this.check('uidsBefore');
    return [...this.box(path).messages.values()].flatMap((m) => (m.header.date < before ? [m.header.uid] : []));
  }

  async headers(path: string, uids: Array<number>): Promise<Array<RemoteHeader>> {
    this.check('headers');
    const b = this.box(path);
    return uids.flatMap((uid) => {
      const m = b.messages.get(uid);
      return m ? [{ ...m.header, flags: [...m.header.flags], labels: [...m.header.labels] }] : [];
    });
  }

  async fetchBodies(path: string, uids: Array<number>): Promise<Array<RawMessage>> {
    this.check('fetchBodies');
    const b = this.box(path);
    return uids.flatMap((uid) => {
      const m = b.messages.get(uid);
      if (!m) {
        return [];
      }
      const raw = m.raw ?? `Subject: ${m.header.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${m.text}`;
      return [{ uid, raw: new TextEncoder().encode(raw) }];
    });
  }

  async edit(path: string, uids: Array<number>, edit: MessageEdit) {
    this.check('edit');
    if (!this.connected) {
      throw new Error('fake: not connected');
    }
    if (this.rejectEdits > 0) {
      this.rejectEdits--;
      throw new ServerRejectedError('fake: server refused the edit');
    }
    const b = this.box(path);
    this.edits.push({ mailbox: path, uids: [...uids], edit });
    for (const uid of uids) {
      const m = b.messages.get(uid);
      if (!m) {
        continue;
      }
      const before = m.header.labels;
      const change: Parameters<FakeProvider['setFlags']>[1] = { flags: applyEdit(m.header.flags, edit.addFlags, edit.removeFlags) };
      if (this.caps.labels) {
        change.labels = applyEdit(m.header.labels, edit.addLabels, edit.removeLabels);
      }
      this.setFlags(uid, change, path);
      // Removing the Inbox label is also an event on INBOX, as on Gmail.
      if (before.includes(String.raw`\Inbox`) && !m.header.labels.includes(String.raw`\Inbox`)) {
        this.emit({ type: 'flags', mailbox: path, uid, flags: m.header.flags }, before);
      }
    }
  }

  async append(path: string, raw: Uint8Array, flags: Array<string>) {
    this.check('append');
    if (!this.connected) {
      throw new Error('fake: not connected');
    }
    const text = new TextDecoder().decode(raw);
    this.appends.push({ mailbox: path, raw: text, flags });
    const subject = /^Subject: (.*)$/m.exec(text)?.[1]?.trim() ?? '';
    const messageId = /^Message-ID: (.*)$/im.exec(text)?.[1]?.trim();
    const input: FakeMessageInput = {
      subject,
      flags,
      raw: text,
      labels: this.caps.labels ? [flags.includes(String.raw`\Draft`) ? String.raw`\Draft` : String.raw`\Sent`] : [path],
    };
    if (messageId) {
      input.messageId = messageId;
    }
    const uid = this.deliver(input, path);
    return { uid };
  }

  /** Searches as a server would: every term in the field it names (or anywhere), case-insensitive. */
  async search(path: string, query: ServerQuery) {
    this.check('search');
    const b = this.box(path);
    return [...b.messages.values()].flatMap((m) => {
      const matches = query.terms.every((t) => {
        const h = m.header;
        if (t.field === 'from') {
          return has(addr(h.from), t.text);
        }
        if (t.field === 'to') {
          return has(h.to.map(addr).join(' '), t.text);
        }
        if (t.field === 'subject') {
          return has(h.subject, t.text);
        }
        return has(`${h.subject} ${addr(h.from)} ${h.to.map(addr).join(' ')} ${m.text}`, t.text);
      });
      return matches ? [m.header.uid] : [];
    });
  }

  /** Moves the core made, in order, and how (MOVE, or copy + delete + expunge without it). */
  moves: Array<{ from: string; to: string; uids: Array<number>; method: 'move' | 'copy+delete' }> = [];

  async move(path: string, uids: Array<number>, destination: string) {
    this.check('move');
    if (!this.connected) {
      throw new Error('fake: not connected');
    }
    const from = this.box(path);
    this.box(destination);
    this.moves.push({ from: path, to: destination, uids: [...uids], method: this.caps.move ? 'move' : 'copy+delete' });
    const out: Array<number> = [];
    for (const uid of uids) {
      const m = from.messages.get(uid);
      if (!m) {
        out.push(0);
        continue;
      }
      const h = m.header;
      const input: FakeMessageInput = {
        subject: h.subject,
        to: h.to,
        date: h.date,
        flags: h.flags,
        text: m.text,
        labels: this.caps.labels ? h.labels : [destination],
      };
      if (h.from) {
        input.from = h.from;
      }
      if (h.messageId) {
        input.messageId = h.messageId;
      }
      if (h.inReplyTo) {
        input.inReplyTo = h.inReplyTo;
      }
      if (h.references) {
        input.references = h.references;
      }
      if (h.threadId) {
        input.threadId = h.threadId;
      }
      if (m.raw) {
        input.raw = m.raw;
      }
      out.push(this.deliver(input, destination));
      this.expunge(uid, path);
    }
    return { uids: out };
  }

  async createMailbox(path: string) {
    this.check('createMailbox');
    if (this.boxes.has(path)) {
      return;
    }
    // Like iCloud, a new folder named Archive or Trash is found by its name.
    const role = /^archive$/i.test(path) ? 'archive' : /^(trash|deleted messages)$/i.test(path) ? 'trash' : undefined;
    this.addMailbox(role ? { path, role } : { path });
  }

  /** Messages deleted for good by the core, in order. */
  removed: Array<{ mailbox: string; uids: Array<number> }> = [];

  async remove(path: string, uids: Array<number>) {
    this.check('remove');
    if (!this.connected) {
      throw new Error('fake: not connected');
    }
    this.removed.push({ mailbox: path, uids: [...uids] });
    for (const uid of uids) {
      this.expunge(uid, path);
    }
  }

  /** What's in a mailbox now, for tests. */
  contents(path: string): Array<{ uid: number; subject: string; flags: Array<string> }> {
    return [...this.box(path).messages.values()].map((m) => ({ uid: m.header.uid, subject: m.header.subject, flags: m.header.flags }));
  }

  async *watch(path: string, signal: AbortSignal): AsyncIterable<MailEvent> {
    this.check('watch');
    const queue: Array<MailEvent> = [];
    let dropped = false;
    let wake: (() => void) | undefined;
    const fn = (e: MailEvent | 'drop') => {
      if (e === 'drop') {
        dropped = true;
      } else if (e.mailbox === path) {
        queue.push(e);
      } else {
        return;
      }
      wake?.();
    };
    this.watchers.add(fn);
    const onAbort = () => wake?.();
    signal.addEventListener('abort', onAbort);
    try {
      while (!signal.aborted) {
        if (!queue.length && !dropped) {
          await new Promise<void>((r) => {
            wake = r;
          });
        }
        wake = undefined;
        if (dropped) {
          throw new Error('fake connection dropped');
        }
        let next = queue.shift();
        while (next) {
          yield next;
          next = queue.shift();
        }
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
  if (p.caps.labels) {
    for (const path of ['Receipts', 'Travel', 'Work/Projects']) {
      p.addMailbox({ path });
    }
  }
  const topics = [
    'Quarterly budget',
    'Flight to Lisbon',
    'Release notes',
    'Lunch on Friday',
    'Invoice #4821',
    'Design review',
    'Hotel booking',
    'CI is red again',
  ];
  for (let i = 0; i < count; i++) {
    const name = people[i % people.length] ?? '';
    const subject = `${topics[Math.floor(i / 3) % topics.length] ?? ''}${i >= 3 * topics.length ? ` (${Math.floor(i / 3)})` : ''}`;
    p.deliver({
      subject,
      from: { name, address: `${(name.split(' ')[0] ?? '').toLowerCase()}@example.com` },
      // Messages 20 minutes apart, three to a Thread, so thousands of them fit inside the 90-day window.
      date: now - i * 1_200_000,
      threadId: `t-${Math.floor(i / 3)}`,
      flags: i % 3 === 0 ? [] : [String.raw`\Seen`],
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
    subject: 'The Normie Weekly',
    from: { name: 'Normie Weekly', address: 'weekly@example.com' },
    date: now + 1000,
    threadId: 't-weekly',
    raw: [
      'Subject: The Normie Weekly',
      'From: Normie Weekly <weekly@example.com>',
      'List-Unsubscribe: <https://example.com/unsubscribe>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="m"',
      '',
      '--m',
      'Content-Type: multipart/alternative; boundary="b"',
      '',
      '--b',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Hello from Normie. This is an HTML newsletter.',
      '',
      '--b',
      'Content-Type: text/html; charset=utf-8',
      '',
      html,
      '',
      '--b--',
      '',
      '--m',
      'Content-Type: text/plain; name="agenda.txt"',
      'Content-Disposition: attachment; filename="agenda.txt"',
      '',
      'Monday: ship it.',
      '',
      '--m--',
      '',
    ].join('\r\n'),
  });
}

/** An SMTP stand-in: records what was sent, and fails or refuses on cue. */
export class FakeTransport implements MailTransport {
  sent: Array<{ raw: string; envelope: { from: string; to: Array<string> } }> = [];
  /** The next sends fail as a dropped connection would. */
  failNext = 0;
  /** The next sends are refused by the server. */
  rejectNext = 0;

  async send(raw: Uint8Array, envelope: { from: string; to: Array<string> }) {
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
