// The local store: one SQLite file in WAL mode, owned by the data process.
import Database from 'better-sqlite3';
import type {
  AccountId, Address, FlagChange, MailboxRole, RemoteHeader, SplitId, SyncState, ThreadMessage, ThreadRow,
} from './types';

const INBOX_LABEL = '\\Inbox';

const MIGRATIONS: string[] = [
  `
  create table accounts (
    id text primary key,
    kind text not null,
    email text not null
  );
  create table mailboxes (
    account_id text not null,
    path text not null,
    role text,
    uid_validity text,
    uid_next integer,
    highest_modseq text,
    primary key (account_id, path)
  );
  create table messages (
    id integer primary key,
    account_id text not null,
    mailbox text not null,
    uid integer not null,
    remote_id text not null,
    thread_key text not null,
    message_id text,
    subject text not null,
    from_json text,
    to_json text not null,
    date integer not null,
    flags_json text not null,
    labels_json text not null,
    in_inbox integer not null,
    unread integer not null,
    snippet text not null default '',
    has_body integer not null default 0,
    unique (account_id, mailbox, uid)
  );
  create index messages_thread on messages (account_id, thread_key);
  create index messages_remote on messages (account_id, remote_id);
  create table bodies (
    message_id integer primary key references messages(id) on delete cascade,
    raw blob not null,
    text text not null
  );
  create table threads (
    account_id text not null,
    thread_key text not null,
    subject text not null,
    from_label text not null,
    last_date integer not null,
    snippet text not null,
    unread integer not null,
    count integer not null,
    in_inbox integer not null,
    primary key (account_id, thread_key)
  );
  create index threads_inbox on threads (in_inbox, last_date desc);
  `,
];

export interface MailboxStateRow {
  path: string;
  role?: MailboxRole;
  state: SyncState | null;
}

export interface BodyInput {
  uid: number;
  raw: Uint8Array;
  text: string;
}

const addressLabel = (a?: Address) => (a ? a.name || a.address : '');

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
  }

  private migrate() {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  close() {
    this.db.close();
  }

  // --- Accounts and mailboxes

  upsertAccount(id: AccountId, kind: string, email: string) {
    this.db
      .prepare('insert into accounts(id, kind, email) values (?, ?, ?) on conflict(id) do update set kind = excluded.kind, email = excluded.email')
      .run(id, kind, email);
  }

  removeAccount(id: AccountId) {
    this.db.transaction(() => {
      this.db.prepare('delete from bodies where message_id in (select id from messages where account_id = ?)').run(id);
      for (const t of ['threads', 'messages', 'mailboxes']) this.db.prepare(`delete from ${t} where account_id = ?`).run(id);
      this.db.prepare('delete from accounts where id = ?').run(id);
    })();
  }

  setMailboxes(accountId: AccountId, boxes: { path: string; role?: MailboxRole }[]) {
    const up = this.db.prepare(
      'insert into mailboxes(account_id, path, role) values (?, ?, ?) on conflict(account_id, path) do update set role = excluded.role',
    );
    this.db.transaction(() => boxes.forEach((b) => up.run(accountId, b.path, b.role ?? null)))();
  }

  mailboxState(accountId: AccountId, path: string): SyncState | null {
    const r = this.db
      .prepare('select uid_validity, uid_next, highest_modseq from mailboxes where account_id = ? and path = ?')
      .get(accountId, path) as { uid_validity: string | null; uid_next: number | null; highest_modseq: string | null } | undefined;
    if (!r || r.uid_validity === null) return null;
    return { uidValidity: r.uid_validity, uidNext: r.uid_next ?? 0, ...(r.highest_modseq ? { highestModseq: r.highest_modseq } : {}) };
  }

  /** UIDs already stored, optionally only those dated on or after `since`. */
  knownUids(accountId: AccountId, mailbox: string, since = 0): number[] {
    return this.db
      .prepare('select uid from messages where account_id = ? and mailbox = ? and date >= ? order by uid')
      .pluck()
      .all(accountId, mailbox, since) as number[];
  }

  /** UIDs of messages in the window that still need their body, newest first. */
  uidsNeedingBodies(accountId: AccountId, mailbox: string, windowStart: number, limit: number): number[] {
    return this.db
      .prepare('select uid from messages where account_id = ? and mailbox = ? and has_body = 0 and date >= ? order by date desc limit ?')
      .pluck()
      .all(accountId, mailbox, windowStart, limit) as number[];
  }

  // --- Writes from sync

  /** Apply one batch of changes from a provider in a single transaction. Returns whether the Inbox Split changed. */
  applyChanges(
    accountId: AccountId,
    mailbox: string,
    batch: { state?: SyncState; reset?: boolean; headers?: RemoteHeader[]; flagChanges?: FlagChange[]; vanished?: number[] },
  ): boolean {
    const touched = new Set<string>();
    let inboxChanged = false;
    // On folder servers, being in the Inbox mailbox is what puts a message in the Inbox; on Gmail it's the \Inbox label.
    const isInboxMailbox = this.db.prepare('select role from mailboxes where account_id = ? and path = ?').pluck().get(accountId, mailbox) === 'inbox';
    const inInbox = (labels: string[]) => (isInboxMailbox || labels.includes(INBOX_LABEL) ? 1 : 0);
    const threadOf = this.db.prepare('select thread_key from messages where account_id = ? and mailbox = ? and uid = ?').pluck();
    const insert = this.db.prepare(`
      insert into messages(account_id, mailbox, uid, remote_id, thread_key, message_id, subject, from_json, to_json, date,
                           flags_json, labels_json, in_inbox, unread)
      values (@accountId, @mailbox, @uid, @remoteId, @threadKey, @messageId, @subject, @fromJson, @toJson, @date,
              @flagsJson, @labelsJson, @inInbox, @unread)
      on conflict(account_id, mailbox, uid) do update set
        remote_id = excluded.remote_id, thread_key = excluded.thread_key, message_id = excluded.message_id,
        subject = excluded.subject, from_json = excluded.from_json, to_json = excluded.to_json, date = excluded.date,
        flags_json = excluded.flags_json, labels_json = excluded.labels_json, in_inbox = excluded.in_inbox, unread = excluded.unread`);
    const updateFlags = this.db.prepare(
      'update messages set flags_json = ?, unread = ?, labels_json = coalesce(?, labels_json), in_inbox = coalesce(?, in_inbox) where account_id = ? and mailbox = ? and uid = ?',
    );
    const del = this.db.prepare('delete from messages where account_id = ? and mailbox = ? and uid = ?');

    this.db.transaction(() => {
      if (batch.reset) {
        const keys = this.db.prepare('select distinct thread_key from messages where account_id = ? and mailbox = ?').pluck().all(accountId, mailbox) as string[];
        keys.forEach((k) => touched.add(k));
        this.db.prepare('delete from messages where account_id = ? and mailbox = ?').run(accountId, mailbox);
      }
      for (const h of batch.headers ?? []) {
        const old = threadOf.get(accountId, mailbox, h.uid) as string | undefined;
        if (old) touched.add(old);
        const threadKey = h.threadId ?? h.messageId ?? h.remoteId;
        touched.add(threadKey);
        insert.run({
          accountId, mailbox, uid: h.uid, remoteId: h.remoteId, threadKey, messageId: h.messageId ?? null,
          subject: h.subject, fromJson: h.from ? JSON.stringify(h.from) : null, toJson: JSON.stringify(h.to), date: h.date,
          flagsJson: JSON.stringify(h.flags), labelsJson: JSON.stringify(h.labels),
          inInbox: inInbox(h.labels), unread: h.flags.includes('\\Seen') ? 0 : 1,
        });
      }
      for (const f of batch.flagChanges ?? []) {
        const key = threadOf.get(accountId, mailbox, f.uid) as string | undefined;
        if (!key) continue;
        touched.add(key);
        updateFlags.run(
          JSON.stringify(f.flags), f.flags.includes('\\Seen') ? 0 : 1,
          f.labels ? JSON.stringify(f.labels) : null, f.labels ? inInbox(f.labels) : null,
          accountId, mailbox, f.uid,
        );
      }
      for (const uid of batch.vanished ?? []) {
        const key = threadOf.get(accountId, mailbox, uid) as string | undefined;
        if (!key) continue;
        touched.add(key);
        del.run(accountId, mailbox, uid);
      }
      if (batch.state) {
        this.db
          .prepare('update mailboxes set uid_validity = ?, uid_next = ?, highest_modseq = ? where account_id = ? and path = ?')
          .run(batch.state.uidValidity, batch.state.uidNext, batch.state.highestModseq ?? null, accountId, mailbox);
      }
      for (const key of touched) if (this.refreshThread(accountId, key)) inboxChanged = true;
    })();
    return inboxChanged;
  }

  /** Store bodies. Returns the keys of the Threads touched and whether the Inbox Split was affected. */
  putBodies(accountId: AccountId, mailbox: string, bodies: BodyInput[]): { keys: string[]; inboxChanged: boolean } {
    const idOf = this.db.prepare('select id, thread_key from messages where account_id = ? and mailbox = ? and uid = ?');
    const put = this.db.prepare('insert into bodies(message_id, raw, text) values (?, ?, ?) on conflict(message_id) do update set raw = excluded.raw, text = excluded.text');
    const mark = this.db.prepare('update messages set has_body = 1, snippet = ? where id = ?');
    const touched = new Set<string>();
    let inboxChanged = false;
    this.db.transaction(() => {
      for (const b of bodies) {
        const m = idOf.get(accountId, mailbox, b.uid) as { id: number; thread_key: string } | undefined;
        if (!m) continue;
        put.run(m.id, Buffer.from(b.raw), b.text);
        mark.run(snippetOf(b.text), m.id);
        touched.add(m.thread_key);
      }
      for (const key of touched) if (this.refreshThread(accountId, key)) inboxChanged = true;
    })();
    return { keys: [...touched].map((k) => `${accountId}:${k}`), inboxChanged };
  }

  /** Recompute one Thread's row from its messages. Returns whether the Inbox Split was affected. */
  private refreshThread(accountId: AccountId, threadKey: string): boolean {
    const wasInInbox = this.db.prepare('select in_inbox from threads where account_id = ? and thread_key = ?').pluck().get(accountId, threadKey) === 1;
    const agg = this.db
      .prepare(`select count(*) n, max(date) last_date, max(unread) unread, max(in_inbox) in_inbox from messages where account_id = ? and thread_key = ?`)
      .get(accountId, threadKey) as { n: number; last_date: number; unread: number; in_inbox: number };
    if (!agg.n) {
      this.db.prepare('delete from threads where account_id = ? and thread_key = ?').run(accountId, threadKey);
      return wasInInbox;
    }
    const latest = this.db
      .prepare('select subject, from_json, snippet from messages where account_id = ? and thread_key = ? order by date desc limit 1')
      .get(accountId, threadKey) as { subject: string; from_json: string | null; snippet: string };
    const first = this.db
      .prepare('select subject from messages where account_id = ? and thread_key = ? order by date asc limit 1')
      .pluck()
      .get(accountId, threadKey) as string;
    this.db
      .prepare(`insert into threads(account_id, thread_key, subject, from_label, last_date, snippet, unread, count, in_inbox)
                values (?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(account_id, thread_key) do update set subject = excluded.subject, from_label = excluded.from_label,
                  last_date = excluded.last_date, snippet = excluded.snippet, unread = excluded.unread, count = excluded.count,
                  in_inbox = excluded.in_inbox`)
      .run(accountId, threadKey, first || latest.subject, addressLabel(latest.from_json ? JSON.parse(latest.from_json) : undefined),
        agg.last_date, latest.snippet, agg.unread, agg.n, agg.in_inbox);
    return wasInInbox || agg.in_inbox === 1;
  }

  // --- Queries for the renderer

  rows(split: SplitId, limit = 5000): ThreadRow[] {
    if (split !== 'inbox') return [];
    return (this.db
      .prepare(`select account_id, thread_key, subject, from_label, last_date, snippet, unread, count
                from threads where in_inbox = 1 order by last_date desc limit ?`)
      .all(limit) as { account_id: string; thread_key: string; subject: string; from_label: string; last_date: number; snippet: string; unread: number; count: number }[])
      .map((r) => ({
        key: `${r.account_id}:${r.thread_key}`, accountId: r.account_id, subject: r.subject, from: r.from_label,
        date: r.last_date, snippet: r.snippet, unread: r.unread === 1, count: r.count,
      }));
  }

  thread(key: string): ThreadMessage[] {
    const i = key.indexOf(':');
    const accountId = key.slice(0, i), threadKey = key.slice(i + 1);
    return (this.db
      .prepare(`select m.id, m.from_json, m.to_json, m.date, m.subject, b.text from messages m left join bodies b on b.message_id = m.id
                where m.account_id = ? and m.thread_key = ? order by m.date asc, m.id asc`)
      .all(accountId, threadKey) as { id: number; from_json: string | null; to_json: string; date: number; subject: string; text: string | null }[])
      .map((r) => ({
        id: r.id, from: r.from_json ? JSON.parse(r.from_json) : undefined, to: JSON.parse(r.to_json), date: r.date,
        subject: r.subject, text: r.text,
      }));
  }

  /** Where a message lives, so the sync process can fetch its body on demand. */
  messageLocation(id: number): { accountId: AccountId; mailbox: string; uid: number } | undefined {
    const r = this.db.prepare('select account_id, mailbox, uid from messages where id = ?').get(id) as { account_id: string; mailbox: string; uid: number } | undefined;
    return r && { accountId: r.account_id, mailbox: r.mailbox, uid: r.uid };
  }
}

export function snippetOf(text: string): string {
  return text
    .split('\n')
    .filter((l) => !l.startsWith('>'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}
