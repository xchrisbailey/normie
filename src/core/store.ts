// The local store: one SQLite file in WAL mode, owned by the data process.
import Database from 'better-sqlite3';
import type {
  AccountId, Address, AttachmentInfo, DraftContent, DraftSummary, DraftToSync, FlagChange, OutboxItem, OutgoingMessage, MailboxRole, MessageEdit, PendingChange, RemoteHeader, SplitId, SyncState, ThreadAction,
  ThreadMessage, ThreadRow,
} from './types';

const INBOX_LABEL = '\\Inbox';

/**
 * Contacts from every stored message: senders, and the people on mail I sent (counted as sent-to) or received
 * (counted as seen). My own addresses are left out.
 */
const REBUILD_CONTACTS = `
  delete from contacts;
  insert into contacts(address, name, sent_count, seen_count, last_at)
  select address, max(name), sum(sent), sum(1 - sent), max(date) from (
    select lower(json_extract(m.from_json, '$.address')) address, nullif(json_extract(m.from_json, '$.name'), '') name, 0 sent, m.date date
      from messages m where m.from_json is not null
    union all
    select lower(json_extract(t.value, '$.address')), nullif(json_extract(t.value, '$.name'), ''),
      (lower(json_extract(m.from_json, '$.address')) in (select lower(email) from accounts)), m.date
      from messages m, json_each(m.to_json) t
  ) where address is not null and address like '%@%' and address not in (select lower(email) from accounts)
  group by address;
`;

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
  // Triage actions waiting to reach the server. Each targets messages in one mailbox.
  `
  create table pending_changes (
    id integer primary key,
    account_id text not null,
    thread_key text not null,
    mailbox text not null,
    uids_json text not null,
    edit_json text not null,
    created_at integer not null,
    attempts integer not null default 0,
    last_error text
  );
  create index pending_changes_account on pending_changes (account_id, id);
  `,
  // Applied changes are kept for a while, so they can be undone. See Store.undo.
  `
  alter table pending_changes add column state text not null default 'pending';
  `,
  // Starred (the Flagged flag), per message and per Thread.
  `
  alter table messages add column starred integer not null default 0;
  alter table threads add column starred integer not null default 0;
  update messages set starred = 1 where flags_json like '%Flagged%';
  update threads set starred = 1 where exists (
    select 1 from messages m where m.account_id = threads.account_id and m.thread_key = threads.thread_key and m.starred = 1);
  alter table pending_changes add column send_after integer not null default 0;
  `,
  // Muted Threads: kept here, since Gmail doesn't offer mute over IMAP.
  `
  create table muted_threads (
    account_id text not null,
    thread_key text not null,
    primary key (account_id, thread_key)
  );
  `,
  // HTML parts, extracted on first open (NULL: not yet; '': none), and senders whose remote images always load.
  `
  alter table bodies add column html text;
  create table image_senders (address text primary key);
  `,
  // Attachments listed with the HTML part; existing extractions are redone to fill them in.
  `
  alter table bodies add column attachments_json text;
  update bodies set html = null;
  `,
  // The Outbox: messages waiting to be sent (first for the undo window, then for the connection).
  `
  create table outbox (
    id integer primary key,
    account_id text not null,
    message_id text not null,
    message_json text not null,
    send_at integer not null,
    state text not null default 'queued',
    attempts integer not null default 0,
    last_error text,
    created_at integer not null
  );
  create index outbox_due on outbox (account_id, state, send_at);
  `,
  // Drafts, saved as the user types, and old server copies waiting to be deleted.
  `
  create table drafts (
    id integer primary key,
    account_id text not null,
    content_json text not null,
    updated_at integer not null,
    synced_at integer not null default 0,
    server_mailbox text,
    server_uid integer
  );
  create table draft_deletions (
    id integer primary key,
    account_id text not null,
    mailbox text not null,
    uid integer not null
  );
  `,
  // People to suggest in address fields, built from the mail already here and kept up to date by sync.
  `
  create table contacts (
    address text primary key,
    name text,
    sent_count integer not null default 0,
    seen_count integer not null default 0,
    last_at integer not null default 0
  );
  `,
  REBUILD_CONTACTS,
];

/** How long a delete waits before it's sent, so it can still be undone. */
export const DELETE_HOLD_MS = 10_000;

const FLAGGED = '\\Flagged';
const DRAFT = '\\Draft';
const SEEN = '\\Seen';
const TRASH = '\\Trash';

/** Changes kept after they reach the server, so recent actions can still be undone. */
const KEEP_APPLIED = 500;

const inverseOf = (e: MessageEdit): MessageEdit => ({
  ...(e.removeFlags ? { addFlags: e.removeFlags } : {}),
  ...(e.addFlags ? { removeFlags: e.addFlags } : {}),
  ...(e.removeLabels ? { addLabels: e.removeLabels } : {}),
  ...(e.addLabels ? { removeLabels: e.addLabels } : {}),
});

type WithAttachments = { attachments?: { filename: string; contentType: string; content: Uint8Array }[] };

/** Outgoing messages and drafts are stored as JSON, attachments as base64. */
function encodeMessage<T extends WithAttachments>(m: T): string {
  return JSON.stringify({ ...m, attachments: (m.attachments ?? []).map((a) => ({ ...a, content: Buffer.from(a.content.buffer, a.content.byteOffset, a.content.byteLength).toString('base64') })) });
}

function decodeMessage<T extends WithAttachments = OutgoingMessage>(json: string): T {
  const m = JSON.parse(json) as Omit<T, 'attachments'> & { attachments: { filename: string; contentType: string; content: string }[] };
  return { ...m, attachments: m.attachments.map((a) => ({ ...a, content: new Uint8Array(Buffer.from(a.content, 'base64')) })) } as unknown as T;
}

/** Applies an edit to a list of flags or Labels. */
function edited(xs: string[], add?: string[], remove?: string[]): string[] {
  const s = new Set(xs);
  for (const x of remove ?? []) s.delete(x);
  for (const x of add ?? []) s.add(x);
  return [...s];
}

/**
 * A Thread's key across Accounts: "account:thread", with the Account id escaped so it never holds a colon
 * (real ids do, as in "gmail:me@example.com"). Thread keys themselves may contain colons.
 */
export function threadRowKey(accountId: AccountId, threadKey: string): string {
  return `${encodeURIComponent(accountId)}:${threadKey}`;
}

/** Splits a key made by threadRowKey into its parts. */
export function parseThreadKey(key: string): { accountId: AccountId; threadKey: string } {
  const i = key.indexOf(':');
  return { accountId: decodeURIComponent(key.slice(0, i)), threadKey: key.slice(i + 1) };
}

interface ActionMessage {
  mailbox: string;
  uid: number;
  labels_json: string;
  unread: number;
  starred: number;
  /** The mailbox's role. 'inbox' means a folder server, where Done and delete are moves (milestone 4). */
  role: string | null;
}

/**
 * Which of a Thread's messages (oldest first) an action changes, and how. Only messages the action really
 * changes are picked, so the inverse edit restores exactly what was there.
 */
function planAction(action: ThreadAction, msgs: ActionMessage[]): { pick: ActionMessage[]; edit: MessageEdit }[] {
  const labelled = msgs.filter((m) => m.role !== 'inbox');
  const inInbox = labelled.filter((m) => (JSON.parse(m.labels_json) as string[]).includes(INBOX_LABEL));
  const latest = msgs.at(-1);
  switch (action.type) {
    case 'done':
      // Gmail: remove the Inbox label from the messages that carry it. Sent copies don't, so they're untouched.
      return [{ pick: inInbox, edit: { removeLabels: [INBOX_LABEL] } }];
    case 'label': {
      // Gmail labels the whole Thread: every message that lacks the Label gets it; removing takes it off all.
      const has = (m: ActionMessage) => (JSON.parse(m.labels_json) as string[]).includes(action.label);
      return [action.on
        ? { pick: labelled.filter((m) => !has(m)), edit: { addLabels: [action.label] } }
        : { pick: labelled.filter(has), edit: { removeLabels: [action.label] } }];
    }
    case 'mute':
      // Muting is Done plus a local note (see recordAction); unmuting changes nothing on the server.
      return action.on ? [{ pick: inInbox, edit: { removeLabels: [INBOX_LABEL] } }] : [];
    case 'delete':
      // Gmail: the whole Thread goes to Trash, as in Gmail itself.
      return [{ pick: labelled, edit: { addLabels: [TRASH] } }, { pick: inInbox, edit: { removeLabels: [INBOX_LABEL] } }];
    case 'star':
      // Starring a Thread stars its latest message, as Gmail does; unstarring clears every star in it.
      return [action.on
        ? { pick: msgs.some((m) => m.starred) || !latest ? [] : [latest], edit: { addFlags: [FLAGGED] } }
        : { pick: msgs.filter((m) => m.starred), edit: { removeFlags: [FLAGGED] } }];
    case 'read':
      // Read marks every unread message; unread marks the latest one, so the Thread shows as unread.
      return [action.on
        ? { pick: msgs.filter((m) => m.unread), edit: { addFlags: [SEEN] } }
        : { pick: msgs.some((m) => m.unread) || !latest ? [] : [latest], edit: { removeFlags: [SEEN] } }];
  }
}

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
  /** Accounts with changes queued by the store itself (Done on new mail in a muted Thread), waiting to be replayed. */
  readonly replayNeeded = new Set<AccountId>();
  private mine?: Set<string>;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    // A send cut short by a crash or quit goes back in the queue. (It may go out twice, never not at all.)
    this.db.prepare(`update outbox set state = 'queued' where state = 'sending'`).run();
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
    this.mine = undefined;
    this.db
      .prepare('insert into accounts(id, kind, email) values (?, ?, ?) on conflict(id) do update set kind = excluded.kind, email = excluded.email')
      .run(id, kind, email);
  }

  removeAccount(id: AccountId) {
    this.db.transaction(() => {
      this.db.prepare('delete from bodies where message_id in (select id from messages where account_id = ?)').run(id);
      for (const t of ['threads', 'messages', 'mailboxes', 'pending_changes', 'muted_threads', 'outbox', 'drafts', 'draft_deletions']) this.db.prepare(`delete from ${t} where account_id = ?`).run(id);
      this.db.prepare('delete from accounts where id = ?').run(id);
    })();
  }

  /** Delete every Account not in `keep`, with its mail. Returns the ids removed. */
  pruneAccounts(keep: AccountId[]): AccountId[] {
    const ids = (this.db.prepare('select id from accounts').all() as { id: string }[]).map((r) => r.id).filter((id) => !keep.includes(id));
    for (const id of ids) this.removeAccount(id);
    return ids;
  }

  setMailboxes(accountId: AccountId, boxes: { path: string; role?: MailboxRole }[]) {
    const up = this.db.prepare(
      'insert into mailboxes(account_id, path, role) values (?, ?, ?) on conflict(account_id, path) do update set role = excluded.role',
    );
    this.db.transaction(() => {
      boxes.forEach((b) => up.run(accountId, b.path, b.role ?? null));
      // Labels deleted elsewhere go too; a mailbox Normie syncs keeps its sync state until it's really gone.
      const keep = new Set(boxes.map((b) => b.path));
      const known = this.db.prepare('select path from mailboxes where account_id = ? and uid_validity is null').pluck().all(accountId) as string[];
      for (const path of known) if (!keep.has(path)) this.db.prepare('delete from mailboxes where account_id = ? and path = ?').run(accountId, path);
    })();
  }

  /**
   * The Account's own Labels, sorted: on Gmail these are its mailboxes, less the Inbox and system ones.
   * Folder servers have none until milestone 4.
   */
  labels(accountId: AccountId): string[] {
    const isGmail = this.db.prepare(`select 1 from mailboxes where account_id = ? and role = 'all'`).pluck().get(accountId);
    if (!isGmail) return [];
    return (this.db
      .prepare(`select path from mailboxes where account_id = ? and role is null and upper(path) != 'INBOX'
                and path not like '[Gmail]/%' and path not like '[Google Mail]/%' order by path collate nocase`)
      .pluck()
      .all(accountId) as string[]);
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
    /** Threads that got a message not seen before. */
    const arrived = new Set<string>();
    let inboxChanged = false;
    // On folder servers, being in the Inbox mailbox is what puts a message in the Inbox; on Gmail it's the \Inbox label.
    const isInboxMailbox = this.db.prepare('select role from mailboxes where account_id = ? and path = ?').pluck().get(accountId, mailbox) === 'inbox';
    const inInbox = (labels: string[]) => (isInboxMailbox || labels.includes(INBOX_LABEL) ? 1 : 0);
    const threadOf = this.db.prepare('select thread_key from messages where account_id = ? and mailbox = ? and uid = ?').pluck();
    const insert = this.db.prepare(`
      insert into messages(account_id, mailbox, uid, remote_id, thread_key, message_id, subject, from_json, to_json, date,
                           flags_json, labels_json, in_inbox, unread, starred)
      values (@accountId, @mailbox, @uid, @remoteId, @threadKey, @messageId, @subject, @fromJson, @toJson, @date,
              @flagsJson, @labelsJson, @inInbox, @unread, @starred)
      on conflict(account_id, mailbox, uid) do update set
        remote_id = excluded.remote_id, thread_key = excluded.thread_key, message_id = excluded.message_id,
        subject = excluded.subject, from_json = excluded.from_json, to_json = excluded.to_json, date = excluded.date,
        flags_json = excluded.flags_json, labels_json = excluded.labels_json, in_inbox = excluded.in_inbox, unread = excluded.unread,
        starred = excluded.starred`);
    const updateFlags = this.db.prepare(
      'update messages set flags_json = ?, unread = ?, starred = ?, labels_json = coalesce(?, labels_json), in_inbox = coalesce(?, in_inbox) where account_id = ? and mailbox = ? and uid = ?',
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
        // Drafts are Normie's own business (see the drafts table), not messages in a Thread.
        if (h.flags.includes(DRAFT)) {
          if (old) del.run(accountId, mailbox, h.uid);
          continue;
        }
        const threadKey = h.threadId ?? h.messageId ?? h.remoteId;
        if (!old) {
          arrived.add(threadKey);
          this.noteContacts(h.from, h.to, h.date);
        }
        touched.add(threadKey);
        insert.run({
          accountId, mailbox, uid: h.uid, remoteId: h.remoteId, threadKey, messageId: h.messageId ?? null,
          subject: h.subject, fromJson: h.from ? JSON.stringify(h.from) : null, toJson: JSON.stringify(h.to), date: h.date,
          flagsJson: JSON.stringify(h.flags), labelsJson: JSON.stringify(h.labels),
          inInbox: inInbox(h.labels), unread: h.flags.includes(SEEN) ? 0 : 1, starred: h.flags.includes(FLAGGED) ? 1 : 0,
        });
      }
      for (const f of batch.flagChanges ?? []) {
        const key = threadOf.get(accountId, mailbox, f.uid) as string | undefined;
        if (!key) continue;
        touched.add(key);
        if (f.flags.includes(DRAFT)) {
          del.run(accountId, mailbox, f.uid);
          continue;
        }
        updateFlags.run(
          JSON.stringify(f.flags), f.flags.includes(SEEN) ? 0 : 1, f.flags.includes(FLAGGED) ? 1 : 0,
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
      // The server doesn't know about pending changes yet: lay them back over what it just reported.
      const written = new Set([...(batch.headers ?? []).map((h) => h.uid), ...(batch.flagChanges ?? []).map((f) => f.uid)]);
      if (written.size) {
        for (const c of this.listPending(accountId)) {
          if (c.mailbox !== mailbox) continue;
          const uids = c.uids.filter((u) => written.has(u));
          if (uids.length) this.editMessages(accountId, mailbox, uids, c.edit).forEach((k) => touched.add(k));
        }
      }
      if (batch.state) {
        this.db
          .prepare('update mailboxes set uid_validity = ?, uid_next = ?, highest_modseq = ? where account_id = ? and path = ?')
          .run(batch.state.uidValidity, batch.state.uidNext, batch.state.highestModseq ?? null, accountId, mailbox);
      }
      for (const key of touched) if (this.refreshThread(accountId, key)) inboxChanged = true;
      // New mail in a muted Thread is marked Done straight away, so it never shows in the Inbox.
      const muted = this.db.prepare('select 1 from muted_threads where account_id = ? and thread_key = ?').pluck();
      for (const key of arrived) {
        if (!muted.get(accountId, key)) continue;
        if (this.recordAction(threadRowKey(accountId, key), { type: 'done' }).changes.length) this.replayNeeded.add(accountId);
      }
    })();
    return inboxChanged;
  }

  // --- Triage: local edits and pending changes

  /**
   * Record a triage action on a Thread: change the local copy at once and queue the change for the server.
   * Returns the pending changes made (none when the action changes nothing, such as Done on a Thread already out of the Inbox).
   */
  recordAction(key: string, action: ThreadAction, now = Date.now(), holdMs = DELETE_HOLD_MS): { changes: PendingChange[]; inboxChanged: boolean } {
    const { accountId, threadKey } = parseThreadKey(key);
    const msgs = this.db
      .prepare(`select m.mailbox, m.uid, m.labels_json, m.unread, m.starred, mb.role from messages m
                left join mailboxes mb on mb.account_id = m.account_id and mb.path = m.mailbox
                where m.account_id = ? and m.thread_key = ? order by m.date asc, m.id asc`)
      .all(accountId, threadKey) as { mailbox: string; uid: number; labels_json: string; unread: number; starred: number; role: string | null }[];
    // A delete waits a little before it's sent, so z can still cancel it: once Gmail moves mail to Trash,
    // it leaves All Mail and an inverse change would find nothing there to put back.
    const sendAfter = action.type === 'delete' ? now + holdMs : 0;
    const changes: PendingChange[] = [];
    let inboxChanged = false;
    this.db.transaction(() => {
      if (action.type === 'mute') {
        this.db.prepare(action.on
          ? 'insert into muted_threads(account_id, thread_key) values (?, ?) on conflict do nothing'
          : 'delete from muted_threads where account_id = ? and thread_key = ?').run(accountId, threadKey);
      }
      for (const { pick, edit } of planAction(action, msgs)) {
        const targets = new Map<string, number[]>();
        for (const m of pick) targets.set(m.mailbox, [...(targets.get(m.mailbox) ?? []), m.uid]);
        for (const [mailbox, uids] of targets) {
          const id = this.queueChange(accountId, threadKey, mailbox, uids, edit, now, sendAfter);
          changes.push({ id, accountId, threadKey, mailbox, uids, edit, attempts: 0 });
          for (const k of this.editMessages(accountId, mailbox, uids, edit)) if (this.refreshThread(accountId, k)) inboxChanged = true;
        }
      }
    })();
    return { changes, inboxChanged };
  }

  /** Apply an edit to local messages. Returns the thread keys touched; the caller refreshes them. */
  private editMessages(accountId: AccountId, mailbox: string, uids: number[], edit: MessageEdit): string[] {
    const isInboxMailbox = this.db.prepare('select role from mailboxes where account_id = ? and path = ?').pluck().get(accountId, mailbox) === 'inbox';
    const get = this.db.prepare('select flags_json, labels_json, thread_key from messages where account_id = ? and mailbox = ? and uid = ?');
    const set = this.db.prepare('update messages set flags_json = ?, labels_json = ?, unread = ?, starred = ?, in_inbox = ? where account_id = ? and mailbox = ? and uid = ?');
    const keys = new Set<string>();
    for (const uid of uids) {
      const m = get.get(accountId, mailbox, uid) as { flags_json: string; labels_json: string; thread_key: string } | undefined;
      if (!m) continue;
      const flags = edited(JSON.parse(m.flags_json) as string[], edit.addFlags, edit.removeFlags);
      const labels = edited(JSON.parse(m.labels_json) as string[], edit.addLabels, edit.removeLabels);
      set.run(
        JSON.stringify(flags), JSON.stringify(labels), flags.includes(SEEN) ? 0 : 1, flags.includes(FLAGGED) ? 1 : 0,
        isInboxMailbox || labels.includes(INBOX_LABEL) ? 1 : 0, accountId, mailbox, uid,
      );
      keys.add(m.thread_key);
    }
    return [...keys];
  }

  /**
   * Changes still to send for an Account, oldest first. Called at the start of each replay, when nothing of
   * this Account's is in flight, so it also clears out changes that were cancelled before they were sent.
   */
  pendingChanges(accountId: AccountId, now = Date.now()): PendingChange[] {
    this.db.prepare(`delete from pending_changes where account_id = ? and state = 'cancelled'`).run(accountId);
    // A change still held (a fresh delete) holds back later changes to the same Thread, so they stay in order.
    const held = new Set<string>();
    const out: PendingChange[] = [];
    for (const { sendAfter, ...c } of this.listPending(accountId, true)) {
      if (sendAfter > now || held.has(c.threadKey)) held.add(c.threadKey);
      else out.push(c);
    }
    return out;
  }

  /** When the next held change of an Account may be sent, if any. */
  nextSendAt(accountId: AccountId): number | undefined {
    return (this.db.prepare(`select min(send_after) from pending_changes where account_id = ? and state = 'pending' and send_after > 0`)
      .pluck().get(accountId) as number | null) ?? undefined;
  }

  private listPending(accountId: AccountId, withSendAfter: true): (PendingChange & { sendAfter: number })[];
  private listPending(accountId: AccountId): PendingChange[];
  private listPending(accountId: AccountId, withSendAfter = false): (PendingChange & { sendAfter?: number })[] {
    return (this.db
      .prepare(`select id, account_id, thread_key, mailbox, uids_json, edit_json, attempts, send_after from pending_changes
                where account_id = ? and state = 'pending' order by id`)
      .all(accountId) as { id: number; account_id: string; thread_key: string; mailbox: string; uids_json: string; edit_json: string; attempts: number; send_after: number }[])
      .map((r) => ({
        id: r.id, accountId: r.account_id, threadKey: r.thread_key, mailbox: r.mailbox,
        uids: JSON.parse(r.uids_json) as number[], edit: JSON.parse(r.edit_json) as MessageEdit, attempts: r.attempts,
        ...(withSendAfter ? { sendAfter: r.send_after } : {}),
      }));
  }

  private changeRow(id: number) {
    return this.db.prepare('select account_id, thread_key, mailbox, uids_json, edit_json, state from pending_changes where id = ?').get(id) as
      | { account_id: string; thread_key: string; mailbox: string; uids_json: string; edit_json: string; state: 'pending' | 'applied' | 'cancelled' | 'undone' }
      | undefined;
  }

  private queueChange(accountId: AccountId, threadKey: string, mailbox: string, uids: number[], edit: MessageEdit, now = Date.now(), sendAfter = 0): number {
    return Number(this.db
      .prepare('insert into pending_changes(account_id, thread_key, mailbox, uids_json, edit_json, created_at, send_after) values (?, ?, ?, ?, ?, ?, ?)')
      .run(accountId, threadKey, mailbox, JSON.stringify(uids), JSON.stringify(edit), now, sendAfter).lastInsertRowid);
  }

  /**
   * The server has the change. Kept as applied, so it can be undone. If it was cancelled while on its way,
   * its inverse is queued instead; returns that Account so the caller can replay again.
   */
  changeApplied(id: number): AccountId | undefined {
    const c = this.changeRow(id);
    if (!c) return undefined;
    if (c.state === 'cancelled') {
      // The local copy was already put back when it was cancelled: only the server needs the inverse.
      this.db.transaction(() => {
        this.queueChange(c.account_id, c.thread_key, c.mailbox, JSON.parse(c.uids_json) as number[], inverseOf(JSON.parse(c.edit_json) as MessageEdit));
        this.db.prepare('delete from pending_changes where id = ?').run(id);
      })();
      return c.account_id;
    }
    this.db.prepare(`update pending_changes set state = 'applied', last_error = null where id = ?`).run(id);
    this.db.prepare(`delete from pending_changes where state in ('applied', 'undone') and id <= (select max(id) from pending_changes) - ?`).run(KEEP_APPLIED);
    return undefined;
  }

  /**
   * Sending the change failed; it stays pending. Only refusals from the server count as attempts:
   * a dropped connection says nothing about the change. Returns the attempts so far.
   */
  changeFailed(id: number, error: string, rejected: boolean): number {
    if (this.changeRow(id)?.state === 'cancelled') {
      // Cancelled while on its way, and it never arrived: nothing left to do.
      this.db.prepare('delete from pending_changes where id = ?').run(id);
      return 0;
    }
    this.db.prepare('update pending_changes set attempts = attempts + ?, last_error = ? where id = ?').run(rejected ? 1 : 0, error, id);
    return (this.db.prepare('select attempts from pending_changes where id = ?').pluck().get(id) as number | undefined) ?? 0;
  }

  /** Put the local copy back as it was before a change. Returns whether the Inbox Split was affected. */
  private revertLocally(c: { account_id: string; mailbox: string; uids_json: string; edit_json: string }): boolean {
    let inboxChanged = false;
    for (const k of this.editMessages(c.account_id, c.mailbox, JSON.parse(c.uids_json) as number[], inverseOf(JSON.parse(c.edit_json) as MessageEdit))) {
      if (this.refreshThread(c.account_id, k)) inboxChanged = true;
    }
    return inboxChanged;
  }

  /** Give up on a change: undo its local edit and forget it. Returns the Thread's subject for telling the user. */
  rollbackChange(id: number): { subject: string; inboxChanged: boolean } | undefined {
    const c = this.changeRow(id);
    if (!c || c.state !== 'pending') return undefined;
    let inboxChanged = false;
    this.db.transaction(() => {
      this.db.prepare('delete from pending_changes where id = ?').run(id);
      inboxChanged = this.revertLocally(c);
    })();
    const subject = (this.db.prepare('select subject from threads where account_id = ? and thread_key = ?').pluck().get(c.account_id, c.thread_key) as string | undefined) ?? '';
    return { subject, inboxChanged };
  }

  /**
   * Undo changes (newest first). One not yet sent is cancelled and never reaches the server; one already
   * applied gets its inverse queued. Either way the local copy goes back at once. Returns the Accounts to replay.
   */
  undo(ids: number[]): { accounts: AccountId[]; inboxChanged: boolean } {
    const accounts = new Set<AccountId>();
    let inboxChanged = false;
    // A delete Gmail already has can't come back from here: Trash is outside All Mail. Undo stops at the hold.
    const sentToTrash = ids.some((id) => {
      const c = this.changeRow(id);
      return c?.state === 'applied' && (JSON.parse(c.edit_json) as MessageEdit).addLabels?.includes(TRASH);
    });
    if (sentToTrash) return { accounts: [], inboxChanged: false };
    this.db.transaction(() => {
      for (const id of [...ids].sort((a, b) => b - a)) {
        const c = this.changeRow(id);
        if (!c || c.state === 'cancelled' || c.state === 'undone') continue;
        if (c.state === 'pending') {
          this.db.prepare(`update pending_changes set state = 'cancelled' where id = ?`).run(id);
        } else {
          this.db.prepare(`update pending_changes set state = 'undone' where id = ?`).run(id);
          this.queueChange(c.account_id, c.thread_key, c.mailbox, JSON.parse(c.uids_json) as number[], inverseOf(JSON.parse(c.edit_json) as MessageEdit));
          accounts.add(c.account_id);
        }
        if (this.revertLocally(c)) inboxChanged = true;
      }
    })();
    return { accounts: [...accounts], inboxChanged };
  }

  pendingStatus(): { count: number; waiting: number } {
    const r = this.db.prepare(`select count(*) count, count(last_error) waiting from pending_changes where state = 'pending'`).get() as { count: number; waiting: number };
    const o = this.db.prepare(`select count(*) count, count(last_error) waiting from outbox where state in ('queued', 'sending')`).get() as { count: number; waiting: number };
    return { count: r.count + o.count, waiting: r.waiting + o.waiting };
  }

  // --- Contacts

  /** My own addresses: never suggested, and what makes a message "sent". */
  private myAddresses(): Set<string> {
    this.mine ??= new Set((this.db.prepare('select lower(email) from accounts').pluck().all() as string[]));
    return this.mine;
  }

  /** Count the people on a newly stored message. */
  private noteContacts(from: Address | undefined, to: Address[], date: number) {
    const mine = this.myAddresses();
    const sent = !!from && mine.has(from.address.toLowerCase());
    const up = this.db.prepare(`insert into contacts(address, name, sent_count, seen_count, last_at) values (?, ?, ?, ?, ?)
      on conflict(address) do update set name = coalesce(excluded.name, name), sent_count = sent_count + excluded.sent_count,
        seen_count = seen_count + excluded.seen_count, last_at = max(last_at, excluded.last_at)`);
    const note = (a: Address, isSent: boolean) => {
      const address = a.address.toLowerCase();
      if (!address.includes('@') || mine.has(address)) return;
      up.run(address, a.name || null, isSent ? 1 : 0, isSent ? 0 : 1, date);
    };
    if (from) note(from, false);
    for (const a of to) note(a, sent);
  }

  /** Rebuild the contacts from every stored message. */
  rebuildContacts() {
    this.mine = undefined;
    this.db.exec(REBUILD_CONTACTS);
  }

  /**
   * People matching what's typed (the start of the address, or of any word of the name): people I've written to
   * first, then by how often and how recently they come up.
   */
  contacts(query: string, limit = 8, now = Date.now()): Address[] {
    const q = query.trim().toLowerCase().replace(/[%_\\]/g, '');
    if (!q) return [];
    return (this.db
      .prepare(`select address, name from contacts
                where address like ? || '%' or lower(name) like ? || '%' or lower(name) like '% ' || ? || '%'
                order by (sent_count > 0) desc,
                  (sent_count * 4 + seen_count) * (1.0 / (1 + (? - last_at) / 2592000000.0)) desc, last_at desc
                limit ?`)
      .all(q, q, q, now, limit) as { address: string; name: string | null }[])
      .map((r) => (r.name ? { name: r.name, address: r.address } : { address: r.address }));
  }

  // --- Drafts

  /** Save a draft (new when `id` is null). Returns its id. */
  saveDraft(id: number | null, content: DraftContent, now = Date.now()): number {
    if (id !== null && this.db.prepare('select 1 from drafts where id = ?').get(id)) {
      this.db.prepare('update drafts set account_id = ?, content_json = ?, updated_at = ? where id = ?').run(content.accountId, encodeMessage(content), now, id);
      return id;
    }
    return Number(this.db.prepare('insert into drafts(account_id, content_json, updated_at) values (?, ?, ?)')
      .run(content.accountId, encodeMessage(content), now).lastInsertRowid);
  }

  /** Delete a draft here, and queue its server copy for deletion. Returns the Account, if there's one to tidy up. */
  deleteDraft(id: number): AccountId | undefined {
    const r = this.db.prepare('select account_id, server_mailbox, server_uid from drafts where id = ?').get(id) as
      | { account_id: string; server_mailbox: string | null; server_uid: number | null } | undefined;
    if (!r) return undefined;
    this.db.transaction(() => {
      this.db.prepare('delete from drafts where id = ?').run(id);
      if (r.server_mailbox && r.server_uid) {
        this.db.prepare('insert into draft_deletions(account_id, mailbox, uid) values (?, ?, ?)').run(r.account_id, r.server_mailbox, r.server_uid);
      }
    })();
    return r.server_uid ? r.account_id : undefined;
  }

  drafts(): DraftSummary[] {
    return (this.db.prepare('select id, account_id, content_json, updated_at from drafts order by updated_at desc').all() as
      { id: number; account_id: string; content_json: string; updated_at: number }[]).map((r) => {
      const c = JSON.parse(r.content_json) as DraftContent;
      return { id: r.id, accountId: r.account_id, subject: c.subject, to: c.to, updatedAt: r.updated_at };
    });
  }

  draft(id: number): DraftContent | null {
    const json = this.db.prepare('select content_json from drafts where id = ?').pluck().get(id) as string | undefined;
    return json ? decodeMessage<DraftContent>(json) : null;
  }

  /** Drafts whose latest version the server doesn't have. */
  draftsToSync(accountId: AccountId): Omit<DraftToSync, 'messageId'>[] {
    return (this.db.prepare('select id, content_json, updated_at from drafts where account_id = ? and updated_at > synced_at').all(accountId) as
      { id: number; content_json: string; updated_at: number }[]).map((r) => ({ id: r.id, updatedAt: r.updated_at, content: decodeMessage<DraftContent>(r.content_json) }));
  }

  /**
   * The server has this version of a draft, at `uid`. The previous copy is queued for deletion; if the draft was
   * sent or discarded meanwhile, so is this one.
   */
  draftSynced(id: number, accountId: AccountId, updatedAt: number, mailbox: string, uid: number | undefined) {
    const queue = this.db.prepare('insert into draft_deletions(account_id, mailbox, uid) values (?, ?, ?)');
    this.db.transaction(() => {
      const r = this.db.prepare('select server_mailbox, server_uid from drafts where id = ?').get(id) as
        | { server_mailbox: string | null; server_uid: number | null } | undefined;
      if (!r) {
        if (uid) queue.run(accountId, mailbox, uid);
        return;
      }
      if (r.server_mailbox && r.server_uid && r.server_uid !== uid) queue.run(accountId, r.server_mailbox, r.server_uid);
      this.db.prepare('update drafts set synced_at = max(synced_at, ?), server_mailbox = ?, server_uid = ? where id = ?').run(updatedAt, mailbox, uid ?? null, id);
    })();
  }

  draftDeletions(accountId: AccountId): { id: number; mailbox: string; uid: number }[] {
    return this.db.prepare('select id, mailbox, uid from draft_deletions where account_id = ? order by id').all(accountId) as { id: number; mailbox: string; uid: number }[];
  }

  draftDeleted(id: number) {
    this.db.prepare('delete from draft_deletions where id = ?').run(id);
  }

  // --- The Outbox

  queueSend(message: OutgoingMessage, messageId: string, sendAt: number, now = Date.now()): number {
    return Number(this.db
      .prepare('insert into outbox(account_id, message_id, message_json, send_at, created_at) values (?, ?, ?, ?, ?)')
      .run(message.accountId, messageId, encodeMessage(message), sendAt, now).lastInsertRowid);
  }

  /** Take a message back out of the Outbox, if it isn't on its way already. */
  cancelSend(id: number): OutgoingMessage | null {
    const r = this.db.prepare(`select message_json from outbox where id = ? and state in ('queued', 'failed')`).pluck().get(id) as string | undefined;
    if (!r) return null;
    this.db.prepare('delete from outbox where id = ?').run(id);
    return decodeMessage(r);
  }

  /** Messages due now for an Account, marked as on their way. */
  dueOutbox(accountId: AccountId, now: number): OutboxItem[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(`select id, message_id, message_json, attempts from outbox where account_id = ? and state = 'queued' and send_at <= ? order by send_at, id`)
        .all(accountId, now) as { id: number; message_id: string; message_json: string; attempts: number }[];
      const mark = this.db.prepare(`update outbox set state = 'sending' where id = ?`);
      for (const r of rows) mark.run(r.id);
      return rows.map((r) => ({ id: r.id, messageId: r.message_id, message: decodeMessage(r.message_json), attempts: r.attempts }));
    })();
  }

  nextOutboxAt(accountId: AccountId): number | undefined {
    return (this.db.prepare(`select min(send_at) from outbox where account_id = ? and state = 'queued'`).pluck().get(accountId) as number | null) ?? undefined;
  }

  outboxSent(id: number) {
    this.db.prepare('delete from outbox where id = ?').run(id);
  }

  /** Sending failed. Back in the queue, unless the server has refused it too often: then it's failed. Returns whether it failed. */
  outboxFailed(id: number, error: string, rejected: boolean, maxRejections: number): boolean {
    this.db.prepare(`update outbox set attempts = attempts + ?, last_error = ?, state = 'queued' where id = ?`).run(rejected ? 1 : 0, error, id);
    const attempts = this.db.prepare('select attempts from outbox where id = ?').pluck().get(id) as number | undefined;
    if (attempts === undefined || attempts < maxRejections) return false;
    this.db.prepare(`update outbox set state = 'failed' where id = ?`).run(id);
    return true;
  }

  /** Store bodies. Returns the keys of the Threads touched and whether the Inbox Split was affected. */
  putBodies(accountId: AccountId, mailbox: string, bodies: BodyInput[]): { keys: string[]; inboxChanged: boolean } {
    const idOf = this.db.prepare('select id, thread_key from messages where account_id = ? and mailbox = ? and uid = ?');
    const put = this.db.prepare('insert into bodies(message_id, raw, text) values (?, ?, ?) on conflict(message_id) do update set raw = excluded.raw, text = excluded.text, html = null');
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
    return { keys: [...touched].map((k) => threadRowKey(accountId, k)), inboxChanged };
  }

  /** Recompute one Thread's row from its messages. Returns whether the Inbox Split was affected. */
  private refreshThread(accountId: AccountId, threadKey: string): boolean {
    const wasInInbox = this.db.prepare('select in_inbox from threads where account_id = ? and thread_key = ?').pluck().get(accountId, threadKey) === 1;
    const agg = this.db
      .prepare(`select count(*) n, max(date) last_date, max(unread) unread, max(in_inbox) in_inbox, max(starred) starred
                from messages where account_id = ? and thread_key = ?`)
      .get(accountId, threadKey) as { n: number; last_date: number; unread: number; in_inbox: number; starred: number };
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
      .prepare(`insert into threads(account_id, thread_key, subject, from_label, last_date, snippet, unread, count, in_inbox, starred)
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(account_id, thread_key) do update set subject = excluded.subject, from_label = excluded.from_label,
                  last_date = excluded.last_date, snippet = excluded.snippet, unread = excluded.unread, count = excluded.count,
                  in_inbox = excluded.in_inbox, starred = excluded.starred`)
      .run(accountId, threadKey, first || latest.subject, addressLabel(latest.from_json ? JSON.parse(latest.from_json) : undefined),
        agg.last_date, latest.snippet, agg.unread, agg.n, agg.in_inbox, agg.starred);
    return wasInInbox || agg.in_inbox === 1;
  }

  // --- Queries for the renderer

  rows(split: SplitId, limit = 5000): ThreadRow[] {
    if (split !== 'inbox') return [];
    return (this.db
      .prepare(`select account_id, thread_key, subject, from_label, last_date, snippet, unread, starred, count
                from threads where in_inbox = 1 order by last_date desc limit ?`)
      .all(limit) as {
        account_id: string; thread_key: string; subject: string; from_label: string; last_date: number; snippet: string;
        unread: number; starred: number; count: number;
      }[])
      .map((r) => ({
        key: threadRowKey(r.account_id, r.thread_key), accountId: r.account_id, subject: r.subject, from: r.from_label,
        date: r.last_date, snippet: r.snippet, unread: r.unread === 1, starred: r.starred === 1, count: r.count,
      }));
  }

  thread(key: string): ThreadMessage[] {
    const { accountId, threadKey } = parseThreadKey(key);
    return (this.db
      .prepare(`select m.id, m.from_json, m.to_json, m.date, m.subject, b.text, b.html, b.attachments_json,
                exists (select 1 from image_senders s where s.address = lower(json_extract(m.from_json, '$.address'))) images_allowed
                from messages m left join bodies b on b.message_id = m.id
                where m.account_id = ? and m.thread_key = ? order by m.date asc, m.id asc`)
      .all(accountId, threadKey) as {
        id: number; from_json: string | null; to_json: string; date: number; subject: string; text: string | null; html: string | null;
        attachments_json: string | null; images_allowed: number;
      }[])
      .map((r) => ({
        id: r.id, from: r.from_json ? JSON.parse(r.from_json) : undefined, to: JSON.parse(r.to_json), date: r.date,
        subject: r.subject, text: r.text, html: r.html || null, imagesAllowed: r.images_allowed === 1,
        attachments: r.attachments_json ? (JSON.parse(r.attachments_json) as AttachmentInfo[]) : [],
      }));
  }

  /** Stored bodies among these messages whose HTML part hasn't been extracted yet. */
  bodiesWithoutHtml(ids: number[]): { id: number; raw: Uint8Array }[] {
    if (!ids.length) return [];
    return (this.db
      .prepare(`select message_id id, raw from bodies where html is null and message_id in (${ids.map(() => '?').join(',')})`)
      .all(...ids) as { id: number; raw: Buffer }[]).map((r) => ({ id: r.id, raw: new Uint8Array(r.raw) }));
  }

  /** Store what was read from a message: its HTML part ('' for none) and its attachments. */
  putRead(id: number, html: string, attachments: AttachmentInfo[]) {
    this.db.prepare('update bodies set html = ?, attachments_json = ? where message_id = ?').run(html, JSON.stringify(attachments), id);
  }

  /** A message as the store knows it, for replying when its body isn't downloaded. */
  messageSummary(id: number): { messageId?: string; from?: Address; to: Address[]; subject: string; date: number; text: string | null } | undefined {
    const r = this.db.prepare('select m.message_id, m.from_json, m.to_json, m.subject, m.date, b.text from messages m left join bodies b on b.message_id = m.id where m.id = ?')
      .get(id) as { message_id: string | null; from_json: string | null; to_json: string; subject: string; date: number; text: string | null } | undefined;
    if (!r) return undefined;
    return {
      ...(r.message_id ? { messageId: r.message_id } : {}), ...(r.from_json ? { from: JSON.parse(r.from_json) as Address } : {}),
      to: JSON.parse(r.to_json) as Address[], subject: r.subject, date: r.date, text: r.text,
    };
  }

  /** A stored message's raw bytes, for reading an attachment out of it. */
  rawOf(id: number): Uint8Array | undefined {
    const raw = this.db.prepare('select raw from bodies where message_id = ?').pluck().get(id) as Buffer | undefined;
    return raw ? new Uint8Array(raw) : undefined;
  }

  /** Always load remote images from this sender. */
  allowImagesFrom(address: string) {
    this.db.prepare('insert into image_senders(address) values (?) on conflict do nothing').run(address.toLowerCase());
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
