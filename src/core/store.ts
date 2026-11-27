// The local store: one SQLite file in WAL mode, owned by the data process.
import Database from 'better-sqlite3';
import { SNOOZED } from './types';
import type {
  AccountId, Address, AttachmentInfo, ChangeResult, ScheduledSummary, DraftContent, LabelSet, DraftSummary, DraftToSync, FlagChange, OutboxItem, OutgoingMessage, MailboxRole, MessageEdit, PendingChange, RemoteHeader, SplitId, SyncState, ThreadAction,
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
      (lower(json_extract(m.from_json, '$.address')) in (select lower(email) from accounts union select address from identities)), m.date
      from messages m, json_each(m.to_json) t
  ) where address is not null and address like '%@%' and address not in (select lower(email) from accounts)
  group by address;
`;

/** The contacts rebuild as migration 11 ran it, before Identities existed. Migrations never change. */
const REBUILD_CONTACTS_V1 = `
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
  REBUILD_CONTACTS_V1,
  // Local threading on folder servers: every Message-ID seen (in a message or its references) and its Thread.
  `
  create table thread_refs (
    account_id text not null,
    message_id text not null,
    thread_key text not null,
    primary key (account_id, message_id)
  );
  create index thread_refs_thread on thread_refs (account_id, thread_key);
  `,
  // What a replayed change left behind for undo (where moved messages are now).
  `
  alter table pending_changes add column result_json text;
  `,
  // Every address that's mine: each Account's Identities.
  `
  create table identities (
    account_id text not null,
    address text not null,
    primary key (account_id, address)
  );
  `,
  // Splits: whether a message went to a list (NULL: not known yet), each Thread's other person, and my VIPs.
  `
  alter table messages add column is_list integer;
  alter table threads add column is_list integer not null default 0;
  alter table threads add column sender text;
  create table vip (address text primary key);
  update threads set sender = (
    select lower(json_extract(m.from_json, '$.address')) from messages m
    where m.account_id = threads.account_id and m.thread_key = threads.thread_key and m.from_json is not null
      and lower(json_extract(m.from_json, '$.address')) not in (select lower(email) from accounts union select address from identities)
    order by m.date desc limit 1);
  `,
  // Each Thread's own Labels, for Split rules.
  `
  alter table threads add column labels_json text not null default '[]';
  update threads set labels_json = coalesce((
    select json_group_array(distinct j.value) from messages m, json_each(m.labels_json) j
    where m.account_id = threads.account_id and m.thread_key = threads.thread_key and substr(j.value, 1, 1) != '\\'), '[]')
  where exists (select 1 from mailboxes mb where mb.account_id = threads.account_id and mb.role = 'all');
  `,
  // When each mailbox was last checked: mail dated before it isn't news.
  `
  alter table mailboxes add column checked_at integer;
  `,
  // Snooze: when each snoozed Thread wakes, and the changes that snoozed it (undone to wake it). Woken Threads go on top.
  `
  create table snoozes (
    account_id text not null,
    thread_key text not null,
    wake_at integer not null,
    change_ids_json text not null,
    primary key (account_id, thread_key)
  );
  create index snoozes_wake on snoozes (wake_at);
  alter table threads add column woke_at integer;
  create index threads_woke on threads (woke_at) where woke_at is not null;
  `,
];

/** Mail dated a little before the last check still counts as news (clocks differ; servers deliver late). */
const NEWS_SLACK_MS = 10 * 60_000;

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

export { parseThreadKey, threadRowKey } from './keys';
import { parseThreadKey, threadRowKey } from './keys';


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
/** Where moves go on a folder server; created when the Account has none. */
interface Folders {
  archive: string;
  trash: string;
  snoozed: string;
}

function planAction(action: ThreadAction, msgs: ActionMessage[], folders?: Folders): { pick: ActionMessage[]; edit: MessageEdit }[] {
  if (folders) {
    const plan = planFolderAction(action, msgs, folders);
    if (plan) return plan;
  }
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
    case 'snooze':
      // Gmail: out of the Inbox and into the Snoozed label, so the phone hides it too.
      return [{ pick: inInbox, edit: { removeLabels: [INBOX_LABEL], addLabels: [SNOOZED] } }];
    case 'unsnooze':
      return [];
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

/**
 * Done, delete, mute and Labels on folder servers, where they're moves. Flags (star, read) are the same as on Gmail,
 * so those return null and planAction handles them.
 */
function planFolderAction(action: ThreadAction, msgs: ActionMessage[], f: Folders): { pick: ActionMessage[]; edit: MessageEdit }[] | null {
  const inInbox = msgs.filter((m) => m.role === 'inbox');
  switch (action.type) {
    case 'done':
      // Only the Inbox messages move to Archive; my copies in Sent stay where they are.
      return [{ pick: inInbox, edit: { moveTo: f.archive } }];
    case 'mute':
      return action.on ? [{ pick: inInbox, edit: { moveTo: f.archive } }] : [];
    case 'snooze':
      return [{ pick: inInbox, edit: { moveTo: f.snoozed } }];
    case 'delete':
      return [{ pick: msgs.filter((m) => m.mailbox !== f.trash), edit: { moveTo: f.trash } }];
    case 'label':
      // A folder is a place: the Thread's mail (not Sent, Drafts or Trash) moves there. Taking a "Label" off moves nothing.
      if (!action.on) return [];
      return [{ pick: msgs.filter((m) => (m.role === null || m.role === 'inbox' || m.role === 'archive') && m.mailbox !== action.label), edit: { moveTo: action.label } }];
    default:
      return null;
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
  /**
   * Prepared statements, kept: preparing one per call left native statements waiting for a garbage collection that,
   * with so little JavaScript in this process, rarely came (most of the data process's memory, #75).
   */
  private statements = new Map<string, Database.Statement>();
  /** Accounts with changes queued by the store itself (Done on new mail in a muted Thread), waiting to be replayed. */
  readonly replayNeeded = new Set<AccountId>();
  /** Thread keys that just got news, gathered by applyChanges for the caller to announce and clear. */
  readonly arrivals = new Set<string>();
  private mine?: Set<string>;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    // A send cut short by a crash or quit goes back in the queue. (It may go out twice, never not at all.)
    this.sql(`update outbox set state = 'queued' where state = 'sending'`).run();
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
    this.statements.clear();
    this.db.close();
  }

  /** Hand SQLite's page cache back to the system; called when the data process goes quiet. */
  shrinkMemory() {
    this.db.pragma('shrink_memory');
  }

  /** A prepared statement for this SQL, made once. Returned in its default mode; callers may .pluck() it. */
  private sql(text: string): Database.Statement {
    let st = this.statements.get(text);
    if (!st) {
      // SQL built from parts (IN lists of varying length) can't grow this without bound.
      if (this.statements.size > 1000) this.statements.clear();
      st = this.db.prepare(text);
      this.statements.set(text, st);
    }
    return st.reader ? st.pluck(false) : st;
  }

  // --- Accounts and mailboxes

  upsertAccount(id: AccountId, kind: string, email: string) {
    this.mine = undefined;
    this
      .sql('insert into accounts(id, kind, email) values (?, ?, ?) on conflict(id) do update set kind = excluded.kind, email = excluded.email')
      .run(id, kind, email);
  }

  removeAccount(id: AccountId) {
    this.db.transaction(() => {
      this.sql('delete from bodies where message_id in (select id from messages where account_id = ?)').run(id);
      for (const t of ['threads', 'messages', 'mailboxes', 'pending_changes', 'muted_threads', 'outbox', 'drafts', 'draft_deletions', 'thread_refs', 'identities', 'snoozes']) this.sql(`delete from ${t} where account_id = ?`).run(id);
      this.sql('delete from accounts where id = ?').run(id);
    })();
  }

  /** The addresses an Account sends as. They're mine: never suggested, and mail from them counts as sent. */
  setIdentities(accountId: AccountId, addresses: string[]) {
    this.db.transaction(() => {
      this.sql('delete from identities where account_id = ?').run(accountId);
      const put = this.sql('insert or ignore into identities(account_id, address) values (?, ?)');
      for (const a of addresses) put.run(accountId, a.toLowerCase());
      // Contacts that turn out to be me go.
      for (const a of addresses) this.sql('delete from contacts where address = ?').run(a.toLowerCase());
    })();
    this.mine = undefined;
  }

  /** Delete every Account not in `keep`, with its mail. Returns the ids removed. */
  pruneAccounts(keep: AccountId[]): AccountId[] {
    const ids = (this.sql('select id from accounts').all() as { id: string }[]).map((r) => r.id).filter((id) => !keep.includes(id));
    for (const id of ids) this.removeAccount(id);
    return ids;
  }

  setMailboxes(accountId: AccountId, boxes: { path: string; role?: MailboxRole }[]) {
    const up = this.sql(
      'insert into mailboxes(account_id, path, role) values (?, ?, ?) on conflict(account_id, path) do update set role = excluded.role',
    );
    this.db.transaction(() => {
      boxes.forEach((b) => up.run(accountId, b.path, b.role ?? null));
      // Labels deleted elsewhere go too; a mailbox Normie syncs keeps its sync state until it's really gone.
      const keep = new Set(boxes.map((b) => b.path));
      const known = this.sql('select path from mailboxes where account_id = ? and uid_validity is null').pluck().all(accountId) as string[];
      for (const path of known) if (!keep.has(path)) this.sql('delete from mailboxes where account_id = ? and path = ?').run(accountId, path);
    })();
  }

  /**
   * The Account's own Labels, sorted: on Gmail these are its mailboxes, less the Inbox and system ones.
   * Folder servers have none until milestone 4.
   */
  labels(accountId: AccountId): LabelSet {
    const boxes = this.sql('select path, role from mailboxes where account_id = ? order by path collate nocase').all(accountId) as { path: string; role: string | null }[];
    // Gmail: Labels are its mailboxes, less the Inbox and system ones. Folder servers: their own folders, to move to.
    const names = boxes
      .filter((b) => b.role === null && b.path.toUpperCase() !== 'INBOX' && !/^\[(Gmail|Google Mail)\]\//.test(b.path))
      .map((b) => b.path);
    return { moves: !boxes.some((b) => b.role === 'all'), names: boxes.length ? names : [] };
  }

  mailboxState(accountId: AccountId, path: string): SyncState | null {
    const r = this
      .sql('select uid_validity, uid_next, highest_modseq from mailboxes where account_id = ? and path = ?')
      .get(accountId, path) as { uid_validity: string | null; uid_next: number | null; highest_modseq: string | null } | undefined;
    if (!r || r.uid_validity === null) return null;
    return { uidValidity: r.uid_validity, uidNext: r.uid_next ?? 0, ...(r.highest_modseq ? { highestModseq: r.highest_modseq } : {}) };
  }

  /** UIDs already stored, optionally only those dated on or after `since`. */
  knownUids(accountId: AccountId, mailbox: string, since = 0): number[] {
    return this
      .sql('select uid from messages where account_id = ? and mailbox = ? and date >= ? order by uid')
      .pluck()
      .all(accountId, mailbox, since) as number[];
  }

  /** UIDs of messages in the window that still need their body, newest first. */
  uidsNeedingBodies(accountId: AccountId, mailbox: string, windowStart: number, limit: number): number[] {
    return this
      .sql('select uid from messages where account_id = ? and mailbox = ? and has_body = 0 and date >= ? order by date desc limit ?')
      .pluck()
      .all(accountId, mailbox, windowStart, limit) as number[];
  }

  // --- Writes from sync

  /** Apply one batch of changes from a provider in a single transaction. Returns whether the Inbox Split changed. */
  applyChanges(
    accountId: AccountId,
    mailbox: string,
    batch: { state?: SyncState; reset?: boolean; headers?: RemoteHeader[]; flagChanges?: FlagChange[]; vanished?: number[] },
    now = Date.now(),
  ): boolean {
    const touched = new Set<string>();
    /** Threads that got a message not seen before. */
    const arrived = new Set<string>();
    /** Of those, the ones with news: mail from someone else, dated after the last check, in a mailbox already synced once. */
    const news = new Set<string>();
    const checkedAt = this.sql('select checked_at from mailboxes where account_id = ? and path = ?').pluck().get(accountId, mailbox) as number | null | undefined;
    const mine = this.myAddresses();
    let inboxChanged = false;
    // On folder servers, being in the Inbox mailbox is what puts a message in the Inbox; on Gmail it's the \Inbox label.
    const isInboxMailbox = this.sql('select role from mailboxes where account_id = ? and path = ?').pluck().get(accountId, mailbox) === 'inbox';
    const inInbox = (labels: string[]) => (isInboxMailbox || labels.includes(INBOX_LABEL) ? 1 : 0);
    const threadOf = this.sql('select thread_key from messages where account_id = ? and mailbox = ? and uid = ?').pluck();
    const insert = this.sql(`
      insert into messages(account_id, mailbox, uid, remote_id, thread_key, message_id, subject, from_json, to_json, date,
                           flags_json, labels_json, in_inbox, unread, starred, is_list)
      values (@accountId, @mailbox, @uid, @remoteId, @threadKey, @messageId, @subject, @fromJson, @toJson, @date,
              @flagsJson, @labelsJson, @inInbox, @unread, @starred, @isList)
      on conflict(account_id, mailbox, uid) do update set
        remote_id = excluded.remote_id, thread_key = excluded.thread_key, message_id = excluded.message_id,
        subject = excluded.subject, from_json = excluded.from_json, to_json = excluded.to_json, date = excluded.date,
        flags_json = excluded.flags_json, labels_json = excluded.labels_json, in_inbox = excluded.in_inbox, unread = excluded.unread,
        starred = excluded.starred, is_list = coalesce(excluded.is_list, is_list)`);
    const updateFlags = this.sql(
      'update messages set flags_json = ?, unread = ?, starred = ?, labels_json = coalesce(?, labels_json), in_inbox = coalesce(?, in_inbox) where account_id = ? and mailbox = ? and uid = ?',
    );
    const del = this.sql('delete from messages where account_id = ? and mailbox = ? and uid = ?');

    this.db.transaction(() => {
      if (batch.reset) {
        const keys = this.sql('select distinct thread_key from messages where account_id = ? and mailbox = ?').pluck().all(accountId, mailbox) as string[];
        keys.forEach((k) => touched.add(k));
        this.sql('delete from messages where account_id = ? and mailbox = ?').run(accountId, mailbox);
      }
      for (const h of batch.headers ?? []) {
        const old = threadOf.get(accountId, mailbox, h.uid) as string | undefined;
        if (old) touched.add(old);
        // Drafts are Normie's own business (see the drafts table), not messages in a Thread.
        if (h.flags.includes(DRAFT)) {
          if (old) del.run(accountId, mailbox, h.uid);
          continue;
        }
        const threadKey = h.threadId ?? this.localThread(accountId, h, touched);
        if (!old) {
          arrived.add(threadKey);
          this.noteContacts(h.from, h.to, h.date);
          if (!batch.reset && checkedAt && h.date >= checkedAt - NEWS_SLACK_MS && !(h.from && mine.has(h.from.address.toLowerCase()))) news.add(threadKey);
        }
        touched.add(threadKey);
        insert.run({
          accountId, mailbox, uid: h.uid, remoteId: h.remoteId, threadKey, messageId: h.messageId ?? null,
          subject: h.subject, fromJson: h.from ? JSON.stringify(h.from) : null, toJson: JSON.stringify(h.to), date: h.date,
          flagsJson: JSON.stringify(h.flags), labelsJson: JSON.stringify(h.labels),
          inInbox: inInbox(h.labels), unread: h.flags.includes(SEEN) ? 0 : 1, starred: h.flags.includes(FLAGGED) ? 1 : 0,
          isList: h.isList === undefined ? null : h.isList ? 1 : 0,
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
        this.sql('update mailboxes set checked_at = ? where account_id = ? and path = ?').run(now, accountId, mailbox);
        this
          .sql('update mailboxes set uid_validity = ?, uid_next = ?, highest_modseq = ? where account_id = ? and path = ?')
          .run(batch.state.uidValidity, batch.state.uidNext, batch.state.highestModseq ?? null, accountId, mailbox);
      }
      for (const key of touched) if (this.refreshThread(accountId, key)) inboxChanged = true;
      // News, if the Thread is (still) in the Inbox; muted Threads are handled next and never notify.
      const inInboxNow = this.sql('select in_inbox from threads where account_id = ? and thread_key = ?').pluck();
      const muted0 = this.sql('select 1 from muted_threads where account_id = ? and thread_key = ?').pluck();
      for (const key of news) if (inInboxNow.get(accountId, key) === 1 && !muted0.get(accountId, key)) this.arrivals.add(threadRowKey(accountId, key));
      // New mail in a muted Thread is marked Done straight away, so it never shows in the Inbox.
      const muted = this.sql('select 1 from muted_threads where account_id = ? and thread_key = ?').pluck();
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
    const msgs = this
      .sql(`select m.mailbox, m.uid, m.labels_json, m.unread, m.starred, mb.role from messages m
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
        this.sql(action.on
          ? 'insert into muted_threads(account_id, thread_key) values (?, ?) on conflict do nothing'
          : 'delete from muted_threads where account_id = ? and thread_key = ?').run(accountId, threadKey);
      }
      for (const { pick, edit } of planAction(action, msgs, this.foldersOf(accountId))) {
        const targets = new Map<string, number[]>();
        for (const m of pick) targets.set(m.mailbox, [...(targets.get(m.mailbox) ?? []), m.uid]);
        for (const [mailbox, uids] of targets) {
          const id = this.queueChange(accountId, threadKey, mailbox, uids, edit, now, sendAfter);
          changes.push({ id, accountId, threadKey, mailbox, uids, edit, attempts: 0 });
          for (const k of this.editMessages(accountId, mailbox, uids, edit)) if (this.refreshThread(accountId, k)) inboxChanged = true;
        }
      }
      if (action.type === 'snooze' && changes.length) {
        this.sql('insert or replace into snoozes(account_id, thread_key, wake_at, change_ids_json) values (?, ?, ?, ?)')
          .run(accountId, threadKey, action.until, JSON.stringify(changes.map((c) => c.id)));
      }
    })();
    return { changes, inboxChanged };
  }

  /** Where moves go, for a folder-server Account (none for Gmail, which has All Mail). */
  private foldersOf(accountId: AccountId): Folders | undefined {
    const boxes = this.sql('select path, role from mailboxes where account_id = ?').all(accountId) as { path: string; role: string | null }[];
    if (!boxes.length || boxes.some((b) => b.role === 'all')) return undefined;
    return {
      archive: boxes.find((b) => b.role === 'archive')?.path ?? 'Archive',
      trash: boxes.find((b) => b.role === 'trash')?.path ?? 'Trash',
      snoozed: SNOOZED,
    };
  }

  /** Apply an edit to local messages. Returns the thread keys touched; the caller refreshes them. */
  private editMessages(accountId: AccountId, mailbox: string, uids: number[], edit: MessageEdit): string[] {
    const roleOf = this.sql('select role from mailboxes where account_id = ? and path = ?').pluck();
    if (edit.moveTo !== undefined) {
      // A move only changes where the message counts: in the Inbox if it's going to the Inbox. The server moves it;
      // the next sync sees it gone from here and arrived there.
      const inbox = roleOf.get(accountId, edit.moveTo) === 'inbox' ? 1 : 0;
      const set = this.sql('update messages set in_inbox = ? where account_id = ? and mailbox = ? and uid = ? returning thread_key').pluck();
      return [...new Set(uids.flatMap((uid) => (set.all(inbox, accountId, mailbox, uid) as string[])))];
    }
    const isInboxMailbox = roleOf.get(accountId, mailbox) === 'inbox';
    const get = this.sql('select flags_json, labels_json, thread_key from messages where account_id = ? and mailbox = ? and uid = ?');
    const set = this.sql('update messages set flags_json = ?, labels_json = ?, unread = ?, starred = ?, in_inbox = ? where account_id = ? and mailbox = ? and uid = ?');
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
    this.sql(`delete from pending_changes where account_id = ? and state = 'cancelled'`).run(accountId);
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
    return (this.sql(`select min(send_after) from pending_changes where account_id = ? and state = 'pending' and send_after > 0`)
      .pluck().get(accountId) as number | null) ?? undefined;
  }

  private listPending(accountId: AccountId, withSendAfter: true): (PendingChange & { sendAfter: number })[];
  private listPending(accountId: AccountId): PendingChange[];
  private listPending(accountId: AccountId, withSendAfter = false): (PendingChange & { sendAfter?: number })[] {
    return (this
      .sql(`select id, account_id, thread_key, mailbox, uids_json, edit_json, attempts, send_after from pending_changes
                where account_id = ? and state = 'pending' order by id`)
      .all(accountId) as { id: number; account_id: string; thread_key: string; mailbox: string; uids_json: string; edit_json: string; attempts: number; send_after: number }[])
      .map((r) => ({
        id: r.id, accountId: r.account_id, threadKey: r.thread_key, mailbox: r.mailbox,
        uids: JSON.parse(r.uids_json) as number[], edit: JSON.parse(r.edit_json) as MessageEdit, attempts: r.attempts,
        ...(withSendAfter ? { sendAfter: r.send_after } : {}),
      }));
  }

  private changeRow(id: number) {
    return this.sql('select account_id, thread_key, mailbox, uids_json, edit_json, state, result_json from pending_changes where id = ?').get(id) as
      | { account_id: string; thread_key: string; mailbox: string; uids_json: string; edit_json: string; result_json: string | null; state: 'pending' | 'applied' | 'cancelled' | 'undone' }
      | undefined;
  }

  /**
   * The change that undoes a change the server already has: the inverse edit, where the messages are now. A move goes
   * back from its destination, by the UIDs the server gave them there; null when those aren't known.
   */
  private inverseChange(c: { mailbox: string; uids_json: string; edit_json: string; result_json: string | null }): { mailbox: string; uids: number[]; edit: MessageEdit } | null {
    const edit = JSON.parse(c.edit_json) as MessageEdit;
    if (edit.moveTo === undefined) return { mailbox: c.mailbox, uids: JSON.parse(c.uids_json) as number[], edit: inverseOf(edit) };
    const moved = ((c.result_json ? (JSON.parse(c.result_json) as ChangeResult) : {}).movedUids ?? []).filter((u) => u > 0);
    return moved.length ? { mailbox: edit.moveTo, uids: moved, edit: { moveTo: c.mailbox } } : null;
  }

  private queueChange(accountId: AccountId, threadKey: string, mailbox: string, uids: number[], edit: MessageEdit, now = Date.now(), sendAfter = 0): number {
    return Number(this
      .sql('insert into pending_changes(account_id, thread_key, mailbox, uids_json, edit_json, created_at, send_after) values (?, ?, ?, ?, ?, ?, ?)')
      .run(accountId, threadKey, mailbox, JSON.stringify(uids), JSON.stringify(edit), now, sendAfter).lastInsertRowid);
  }

  /**
   * The server has the change. Kept as applied, so it can be undone. If it was cancelled while on its way,
   * its inverse is queued instead; returns that Account so the caller can replay again.
   */
  changeApplied(id: number, result?: ChangeResult): AccountId | undefined {
    const c = this.changeRow(id);
    if (!c) return undefined;
    if (c.state === 'cancelled') {
      // The local copy was already put back when it was cancelled: only the server needs the inverse.
      const inverse = this.inverseChange({ ...c, result_json: result ? JSON.stringify(result) : null });
      this.db.transaction(() => {
        if (inverse) this.queueChange(c.account_id, c.thread_key, inverse.mailbox, inverse.uids, inverse.edit);
        this.sql('delete from pending_changes where id = ?').run(id);
      })();
      return inverse ? c.account_id : undefined;
    }
    this.sql(`update pending_changes set state = 'applied', last_error = null, result_json = ? where id = ?`).run(result ? JSON.stringify(result) : null, id);
    this.sql(`delete from pending_changes where state in ('applied', 'undone') and id <= (select max(id) from pending_changes) - ?`).run(KEEP_APPLIED);
    return undefined;
  }

  /**
   * Sending the change failed; it stays pending. Only refusals from the server count as attempts:
   * a dropped connection says nothing about the change. Returns the attempts so far.
   */
  changeFailed(id: number, error: string, rejected: boolean): number {
    if (this.changeRow(id)?.state === 'cancelled') {
      // Cancelled while on its way, and it never arrived: nothing left to do.
      this.sql('delete from pending_changes where id = ?').run(id);
      return 0;
    }
    this.sql('update pending_changes set attempts = attempts + ?, last_error = ? where id = ?').run(rejected ? 1 : 0, error, id);
    return (this.sql('select attempts from pending_changes where id = ?').pluck().get(id) as number | undefined) ?? 0;
  }

  /** Put the local copy back as it was before a change. Returns whether the Inbox Split was affected. */
  private revertLocally(c: { account_id: string; mailbox: string; uids_json: string; edit_json: string; result_json?: string | null }): boolean {
    const edit = JSON.parse(c.edit_json) as MessageEdit;
    const keys = new Set<string>();
    if (edit.moveTo === undefined) {
      this.editMessages(c.account_id, c.mailbox, JSON.parse(c.uids_json) as number[], inverseOf(edit)).forEach((k) => keys.add(k));
    } else {
      // Back where they came from: wherever the messages are by now (still here, or already synced there).
      const back: MessageEdit = { moveTo: c.mailbox };
      this.editMessages(c.account_id, c.mailbox, JSON.parse(c.uids_json) as number[], back).forEach((k) => keys.add(k));
      const moved = (c.result_json ? (JSON.parse(c.result_json) as ChangeResult) : {}).movedUids?.filter((u) => u > 0) ?? [];
      if (moved.length) this.editMessages(c.account_id, edit.moveTo, moved, back).forEach((k) => keys.add(k));
    }
    let inboxChanged = false;
    for (const k of keys) if (this.refreshThread(c.account_id, k)) inboxChanged = true;
    return inboxChanged;
  }

  /** Give up on a change: undo its local edit and forget it. Returns the Thread's subject for telling the user. */
  rollbackChange(id: number): { subject: string; inboxChanged: boolean } | undefined {
    const c = this.changeRow(id);
    if (!c || c.state !== 'pending') return undefined;
    let inboxChanged = false;
    this.db.transaction(() => {
      this.sql('delete from pending_changes where id = ?').run(id);
      inboxChanged = this.revertLocally(c);
    })();
    const subject = (this.sql('select subject from threads where account_id = ? and thread_key = ?').pluck().get(c.account_id, c.thread_key) as string | undefined) ?? '';
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
    // Nor can a move whose new UIDs the server never told us.
    const stuck = ids.some((id) => {
      const c = this.changeRow(id);
      return c?.state === 'applied' && ((JSON.parse(c.edit_json) as MessageEdit).addLabels?.includes(TRASH) || !this.inverseChange(c));
    });
    if (stuck) return { accounts: [], inboxChanged: false };
    this.db.transaction(() => {
      for (const id of [...ids].sort((a, b) => b - a)) {
        const c = this.changeRow(id);
        if (!c || c.state === 'cancelled' || c.state === 'undone') continue;
        if (c.state === 'pending') {
          this.sql(`update pending_changes set state = 'cancelled' where id = ?`).run(id);
        } else {
          this.sql(`update pending_changes set state = 'undone' where id = ?`).run(id);
          const inverse = this.inverseChange(c)!;
          this.queueChange(c.account_id, c.thread_key, inverse.mailbox, inverse.uids, inverse.edit);
          accounts.add(c.account_id);
        }
        if (this.revertLocally(c)) inboxChanged = true;
      }
    })();
    return { accounts: [...accounts], inboxChanged };
  }

  // --- Snooze

  /** Snoozed Threads whose time has come. */
  dueSnoozes(now: number): { accountId: AccountId; threadKey: string }[] {
    return (this.sql('select account_id, thread_key from snoozes where wake_at <= ? order by wake_at').all(now) as { account_id: string; thread_key: string }[])
      .map((r) => ({ accountId: r.account_id, threadKey: r.thread_key }));
  }

  nextWakeAt(): number | undefined {
    return (this.sql('select min(wake_at) from snoozes').pluck().get() as number | null) ?? undefined;
  }

  /**
   * Wake a snoozed Thread: undo the changes that snoozed it (back to the Inbox on the server too) and put it on top.
   * Returns the Accounts with changes to replay, or undefined when it wasn't snoozed.
   */
  wake(accountId: AccountId, threadKey: string, now: number): AccountId[] | undefined {
    const ids = this.sql('select change_ids_json from snoozes where account_id = ? and thread_key = ?').pluck().get(accountId, threadKey) as string | undefined;
    if (ids === undefined) return undefined;
    let accounts: AccountId[] = [];
    this.db.transaction(() => {
      this.sql('delete from snoozes where account_id = ? and thread_key = ?').run(accountId, threadKey);
      accounts = this.undo(JSON.parse(ids) as number[]).accounts;
      this.sql('update threads set woke_at = ? where account_id = ? and thread_key = ?').run(now, accountId, threadKey);
    })();
    return accounts;
  }

  /** Forget snoozes made by these changes (they were undone). */
  dropSnoozesFor(changeIds: number[]) {
    const rows = this.sql('select account_id, thread_key, change_ids_json from snoozes').all() as { account_id: string; thread_key: string; change_ids_json: string }[];
    for (const r of rows) {
      if ((JSON.parse(r.change_ids_json) as number[]).some((id) => changeIds.includes(id))) {
        this.sql('delete from snoozes where account_id = ? and thread_key = ?').run(r.account_id, r.thread_key);
      }
    }
  }

  pendingStatus(): { count: number; waiting: number } {
    const r = this.sql(`select count(*) count, count(last_error) waiting from pending_changes where state = 'pending'`).get() as { count: number; waiting: number };
    const o = this.sql(`select count(*) count, count(last_error) waiting from outbox where state in ('queued', 'sending')`).get() as { count: number; waiting: number };
    return { count: r.count + o.count, waiting: r.waiting + o.waiting };
  }

  // --- Contacts

  /** My own addresses: never suggested, and what makes a message "sent". */
  private myAddresses(): Set<string> {
    this.mine ??= new Set((this.sql('select lower(email) from accounts union select lower(address) from identities').pluck().all() as string[]));
    return this.mine;
  }

  /** Count the people on a newly stored message. */
  private noteContacts(from: Address | undefined, to: Address[], date: number) {
    const mine = this.myAddresses();
    const sent = !!from && mine.has(from.address.toLowerCase());
    const up = this.sql(`insert into contacts(address, name, sent_count, seen_count, last_at) values (?, ?, ?, ?, ?)
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
    return (this
      .sql(`select address, name from contacts
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
    if (id !== null && this.sql('select 1 from drafts where id = ?').get(id)) {
      this.sql('update drafts set account_id = ?, content_json = ?, updated_at = ? where id = ?').run(content.accountId, encodeMessage(content), now, id);
      return id;
    }
    return Number(this.sql('insert into drafts(account_id, content_json, updated_at) values (?, ?, ?)')
      .run(content.accountId, encodeMessage(content), now).lastInsertRowid);
  }

  /** Delete a draft here, and queue its server copy for deletion. Returns the Account, if there's one to tidy up. */
  deleteDraft(id: number): AccountId | undefined {
    const r = this.sql('select account_id, server_mailbox, server_uid from drafts where id = ?').get(id) as
      | { account_id: string; server_mailbox: string | null; server_uid: number | null } | undefined;
    if (!r) return undefined;
    this.db.transaction(() => {
      this.sql('delete from drafts where id = ?').run(id);
      if (r.server_mailbox && r.server_uid) {
        this.sql('insert into draft_deletions(account_id, mailbox, uid) values (?, ?, ?)').run(r.account_id, r.server_mailbox, r.server_uid);
      }
    })();
    return r.server_uid ? r.account_id : undefined;
  }

  drafts(): DraftSummary[] {
    return (this.sql('select id, account_id, content_json, updated_at from drafts order by updated_at desc').all() as
      { id: number; account_id: string; content_json: string; updated_at: number }[]).map((r) => {
      const c = JSON.parse(r.content_json) as DraftContent;
      return { id: r.id, accountId: r.account_id, subject: c.subject, to: c.to, updatedAt: r.updated_at };
    });
  }

  draft(id: number): DraftContent | null {
    const json = this.sql('select content_json from drafts where id = ?').pluck().get(id) as string | undefined;
    return json ? decodeMessage<DraftContent>(json) : null;
  }

  /** Drafts whose latest version the server doesn't have. */
  draftsToSync(accountId: AccountId): Omit<DraftToSync, 'messageId'>[] {
    return (this.sql('select id, content_json, updated_at from drafts where account_id = ? and updated_at > synced_at').all(accountId) as
      { id: number; content_json: string; updated_at: number }[]).map((r) => ({ id: r.id, updatedAt: r.updated_at, content: decodeMessage<DraftContent>(r.content_json) }));
  }

  /**
   * The server has this version of a draft, at `uid`. The previous copy is queued for deletion; if the draft was
   * sent or discarded meanwhile, so is this one.
   */
  draftSynced(id: number, accountId: AccountId, updatedAt: number, mailbox: string, uid: number | undefined) {
    const queue = this.sql('insert into draft_deletions(account_id, mailbox, uid) values (?, ?, ?)');
    this.db.transaction(() => {
      const r = this.sql('select server_mailbox, server_uid from drafts where id = ?').get(id) as
        | { server_mailbox: string | null; server_uid: number | null } | undefined;
      if (!r) {
        if (uid) queue.run(accountId, mailbox, uid);
        return;
      }
      if (r.server_mailbox && r.server_uid && r.server_uid !== uid) queue.run(accountId, r.server_mailbox, r.server_uid);
      this.sql('update drafts set synced_at = max(synced_at, ?), server_mailbox = ?, server_uid = ? where id = ?').run(updatedAt, mailbox, uid ?? null, id);
    })();
  }

  draftDeletions(accountId: AccountId): { id: number; mailbox: string; uid: number }[] {
    return this.sql('select id, mailbox, uid from draft_deletions where account_id = ? order by id').all(accountId) as { id: number; mailbox: string; uid: number }[];
  }

  draftDeleted(id: number) {
    this.sql('delete from draft_deletions where id = ?').run(id);
  }

  // --- The Outbox

  queueSend(message: OutgoingMessage, messageId: string, sendAt: number, now = Date.now()): number {
    return Number(this
      .sql('insert into outbox(account_id, message_id, message_json, send_at, created_at) values (?, ?, ?, ?, ?)')
      .run(message.accountId, messageId, encodeMessage(message), sendAt, now).lastInsertRowid);
  }

  /** Take a message back out of the Outbox, if it isn't on its way already. */
  cancelSend(id: number): OutgoingMessage | null {
    const r = this.sql(`select message_json from outbox where id = ? and state in ('queued', 'failed')`).pluck().get(id) as string | undefined;
    if (!r) return null;
    this.sql('delete from outbox where id = ?').run(id);
    return decodeMessage(r);
  }

  /** Messages due now for an Account, marked as on their way. */
  dueOutbox(accountId: AccountId, now: number): OutboxItem[] {
    return this.db.transaction(() => {
      const rows = this
        .sql(`select id, message_id, message_json, attempts from outbox where account_id = ? and state = 'queued' and send_at <= ? order by send_at, id`)
        .all(accountId, now) as { id: number; message_id: string; message_json: string; attempts: number }[];
      const mark = this.sql(`update outbox set state = 'sending' where id = ?`);
      for (const r of rows) mark.run(r.id);
      return rows.map((r) => ({ id: r.id, messageId: r.message_id, message: decodeMessage(r.message_json), attempts: r.attempts }));
    })();
  }

  /** Messages set to go out later than the undo window: Send Later. */
  scheduled(after: number): ScheduledSummary[] {
    return (this.sql(`select id, account_id, message_json, send_at from outbox where state = 'queued' and send_at > ? order by send_at`).all(after) as
      { id: number; account_id: string; message_json: string; send_at: number }[]).map((r) => {
      const m = JSON.parse(r.message_json) as OutgoingMessage;
      return { id: r.id, accountId: r.account_id, subject: m.subject, to: m.to.map((a) => a.name || a.address).join(', '), sendAt: r.send_at };
    });
  }

  nextOutboxAt(accountId: AccountId): number | undefined {
    return (this.sql(`select min(send_at) from outbox where account_id = ? and state = 'queued'`).pluck().get(accountId) as number | null) ?? undefined;
  }

  outboxSent(id: number) {
    this.sql('delete from outbox where id = ?').run(id);
  }

  /** Sending failed. Back in the queue, unless the server has refused it too often: then it's failed. Returns whether it failed. */
  outboxFailed(id: number, error: string, rejected: boolean, maxRejections: number): boolean {
    this.sql(`update outbox set attempts = attempts + ?, last_error = ?, state = 'queued' where id = ?`).run(rejected ? 1 : 0, error, id);
    const attempts = this.sql('select attempts from outbox where id = ?').pluck().get(id) as number | undefined;
    if (attempts === undefined || attempts < maxRejections) return false;
    this.sql(`update outbox set state = 'failed' where id = ?`).run(id);
    return true;
  }

  /**
   * The Thread of a message on a server without thread ids, from its Message-ID, In-Reply-To and References.
   * It joins the Thread of the first id already known (oldest reference first); when none is, the Thread is named
   * after the oldest reference, so a parent arriving later lands in it too. A message that links two Threads merges
   * them. Threads never span Accounts.
   */
  private localThread(accountId: AccountId, h: RemoteHeader, touched: Set<string>): string {
    const ids = [...new Set([...(h.references ?? []), ...(h.inReplyTo ? [h.inReplyTo] : []), ...(h.messageId ? [h.messageId] : [])])];
    if (!ids.length) return h.remoteId;
    const keyOf = this.sql('select thread_key from thread_refs where account_id = ? and message_id = ?').pluck();
    const known = [...new Set(ids.map((id) => keyOf.get(accountId, id) as string | undefined).filter((k): k is string => !!k))];
    const key = known[0] ?? ids[0]!;
    for (const other of known.slice(1)) this.mergeThreads(accountId, other, key, touched);
    const put = this.sql('insert into thread_refs(account_id, message_id, thread_key) values (?, ?, ?) on conflict(account_id, message_id) do update set thread_key = excluded.thread_key');
    for (const id of ids) put.run(accountId, id, key);
    return key;
  }

  /** Fold Thread `from` into Thread `into`: its messages, known ids, mute and pending changes. */
  private mergeThreads(accountId: AccountId, from: string, into: string, touched: Set<string>) {
    for (const t of ['messages', 'thread_refs', 'pending_changes']) {
      this.sql(`update ${t} set thread_key = ? where account_id = ? and thread_key = ?`).run(into, accountId, from);
    }
    if (this.sql('delete from muted_threads where account_id = ? and thread_key = ?').run(accountId, from).changes) {
      this.sql('insert into muted_threads(account_id, thread_key) values (?, ?) on conflict do nothing').run(accountId, into);
    }
    touched.add(from);
    touched.add(into);
  }

  /** Store bodies. Returns the keys of the Threads touched and whether the Inbox Split was affected. */
  putBodies(accountId: AccountId, mailbox: string, bodies: BodyInput[]): { keys: string[]; inboxChanged: boolean } {
    const idOf = this.sql('select id, thread_key from messages where account_id = ? and mailbox = ? and uid = ?');
    const put = this.sql('insert into bodies(message_id, raw, text) values (?, ?, ?) on conflict(message_id) do update set raw = excluded.raw, text = excluded.text, html = null');
    const mark = this.sql('update messages set has_body = 1, snippet = ? where id = ?');
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
    const wasInInbox = this.sql('select in_inbox from threads where account_id = ? and thread_key = ?').pluck().get(accountId, threadKey) === 1;
    const agg = this
      .sql(`select count(*) n, max(date) last_date, max(unread) unread, max(in_inbox) in_inbox, max(starred) starred,
                  coalesce(max(is_list), 0) is_list
                from messages where account_id = ? and thread_key = ?`)
      .get(accountId, threadKey) as { n: number; last_date: number; unread: number; in_inbox: number; starred: number; is_list: number };
    if (!agg.n) {
      this.sql('delete from threads where account_id = ? and thread_key = ?').run(accountId, threadKey);
      return wasInInbox;
    }
    const latest = this
      .sql('select subject, from_json, snippet from messages where account_id = ? and thread_key = ? order by date desc limit 1')
      .get(accountId, threadKey) as { subject: string; from_json: string | null; snippet: string };
    const first = this
      .sql('select subject from messages where account_id = ? and thread_key = ? order by date asc limit 1')
      .pluck()
      .get(accountId, threadKey) as string;
    // The other person: the latest sender who isn't me (so my own reply doesn't make a Thread mine).
    const mine = this.myAddresses();
    const senders = this.sql('select from_json from messages where account_id = ? and thread_key = ? and from_json is not null order by date desc limit 20')
      .pluck().all(accountId, threadKey) as string[];
    const sender = senders.map((j) => (JSON.parse(j) as Address).address.toLowerCase()).find((a) => !mine.has(a)) ?? null;
    // Labels mean something only where messages carry several (Gmail); on folder servers they're the mailbox.
    const isGmail = !!this.sql(`select 1 from mailboxes where account_id = ? and role = 'all'`).pluck().get(accountId);
    const labels = isGmail
      ? (this.sql(`select distinct j.value from messages m, json_each(m.labels_json) j
                          where m.account_id = ? and m.thread_key = ? and substr(j.value, 1, 1) != '\\'`).pluck().all(accountId, threadKey) as string[])
      : [];
    this
      .sql(`insert into threads(account_id, thread_key, subject, from_label, last_date, snippet, unread, count, in_inbox, starred, is_list, sender, labels_json)
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(account_id, thread_key) do update set subject = excluded.subject, from_label = excluded.from_label,
                  last_date = excluded.last_date, snippet = excluded.snippet, unread = excluded.unread, count = excluded.count,
                  in_inbox = excluded.in_inbox, starred = excluded.starred, is_list = excluded.is_list, sender = excluded.sender,
                  labels_json = excluded.labels_json`)
      .run(accountId, threadKey, first || latest.subject, addressLabel(latest.from_json ? JSON.parse(latest.from_json) : undefined),
        agg.last_date, latest.snippet, agg.unread, agg.n, agg.in_inbox, agg.starred, agg.is_list, sender, JSON.stringify(labels));
    return wasInInbox || agg.in_inbox === 1;
  }

  // --- Queries for the renderer

  /** The Inbox's Threads, newest first, each tagged with what the Split rules need (the renderer splits them). */
  rows(split: SplitId, limit = 5000): ThreadRow[] {
    if (split !== 'inbox') return [];
    // Three queries that each use an index, merged here: an OR across them made SQLite scan and sort every Thread.
    const cols = `t.account_id, t.thread_key, t.subject, t.from_label, t.last_date, t.snippet, t.unread, t.starred, t.count, t.is_list, t.sender,
                  t.labels_json, t.woke_at, t.sender in (select address from vip) vip, t.sender in (select address from contacts where sent_count > 0) known`;
    type Row = {
      account_id: string; thread_key: string; subject: string; from_label: string; last_date: number; snippet: string;
      unread: number; starred: number; count: number; is_list: number; sender: string | null; labels_json: string; woke_at: number | null;
      vip: number | null; known: number | null; wake_at?: number;
    };
    // The Inbox, newest first; woken Threads (rare) are fetched apart, since waking puts an old Thread on top.
    const inbox = this.sql(`select ${cols} from threads t where t.in_inbox = 1 order by t.last_date desc limit ?`).all(limit) as Row[];
    const woken = this.sql(`select ${cols} from threads t where t.woke_at is not null and t.woke_at > t.last_date and t.in_inbox = 1`).all() as Row[];
    const snoozed = this.sql(`select ${cols}, s.wake_at from snoozes s join threads t on t.account_id = s.account_id and t.thread_key = s.thread_key`).all() as Row[];
    const seen = new Set<string>();
    const all: (Row & { sort: number })[] = [];
    for (const r of [...snoozed, ...woken, ...inbox]) {
      const k = `${r.account_id}\u0000${r.thread_key}`;
      if (seen.has(k)) continue;
      seen.add(k);
      all.push({ ...r, sort: Math.max(r.last_date, r.woke_at ?? 0) });
    }
    all.sort((x, y) => y.sort - x.sort);
    return all.slice(0, limit).map((r) => ({
      key: threadRowKey(r.account_id, r.thread_key), accountId: r.account_id, subject: r.subject, from: r.from_label,
      date: r.sort, snippet: r.snippet, unread: r.unread === 1, starred: r.starred === 1, count: r.count,
      tags: {
        ...(r.wake_at !== undefined ? { snoozedUntil: r.wake_at } : {}),
        newsletter: r.is_list === 1, vip: r.vip === 1, known: r.known === 1, ...(r.sender ? { sender: r.sender } : {}),
        ...(r.labels_json !== '[]' ? { labels: JSON.parse(r.labels_json) as string[] } : {}),
      },
    }));
  }


  /** Mark a sender as VIP, or not. */
  setVip(address: string, on: boolean) {
    const a = address.toLowerCase();
    if (on) this.sql('insert or ignore into vip(address) values (?)').run(a);
    else this.sql('delete from vip where address = ?').run(a);
  }

  /**
   * Mail stored before list headers were fetched: read them from the stored message. A batch at a time, so the data
   * process stays responsive. Returns how many were done (0 when finished).
   */
  backfillListFlags(batch = 1000): number {
    const rows = this.sql(`select m.id, m.account_id, m.thread_key, substr(b.raw, 1, 16384) head from messages m join bodies b on b.message_id = m.id
                                  where m.is_list is null limit ?`).all(batch) as { id: number; account_id: string; thread_key: string; head: Buffer }[];
    if (!rows.length) {
      // Headers-only mail has nothing to read: it stays "not a list".
      this.sql('update messages set is_list = 0 where is_list is null').run();
      return 0;
    }
    const set = this.sql('update messages set is_list = ? where id = ?');
    const lists = new Set<string>();
    this.db.transaction(() => {
      for (const r of rows) {
        const head = Buffer.from(r.head).toString('latin1').split(/\r?\n\r?\n/)[0]!.replace(/\r?\n[ \t]+/g, ' ');
        const isList = /^(list-unsubscribe|list-id):/im.test(head) || /^precedence:\s*(bulk|list|junk)\b/im.test(head);
        set.run(isList ? 1 : 0, r.id);
        if (isList) lists.add(`${r.account_id}\u0000${r.thread_key}`);
      }
      const mark = this.sql('update threads set is_list = 1 where account_id = ? and thread_key = ?');
      for (const k of lists) mark.run(...(k.split('\u0000') as [string, string]));
    })();
    return rows.length;
  }

  thread(key: string): ThreadMessage[] {
    const { accountId, threadKey } = parseThreadKey(key);
    return (this
      .sql(`select m.id, m.from_json, m.to_json, m.date, m.subject, b.text, b.html, b.attachments_json,
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
    return (this
      .sql(`select message_id id, raw from bodies where html is null and message_id in (${ids.map(() => '?').join(',')})`)
      .all(...ids) as { id: number; raw: Buffer }[]).map((r) => ({ id: r.id, raw: new Uint8Array(r.raw) }));
  }

  /** Store what was read from a message: its HTML part ('' for none) and its attachments. */
  putRead(id: number, html: string, attachments: AttachmentInfo[]) {
    this.sql('update bodies set html = ?, attachments_json = ? where message_id = ?').run(html, JSON.stringify(attachments), id);
  }

  /** A message as the store knows it, for replying when its body isn't downloaded. */
  messageSummary(id: number): { messageId?: string; from?: Address; to: Address[]; subject: string; date: number; text: string | null } | undefined {
    const r = this.sql('select m.message_id, m.from_json, m.to_json, m.subject, m.date, b.text from messages m left join bodies b on b.message_id = m.id where m.id = ?')
      .get(id) as { message_id: string | null; from_json: string | null; to_json: string; subject: string; date: number; text: string | null } | undefined;
    if (!r) return undefined;
    return {
      ...(r.message_id ? { messageId: r.message_id } : {}), ...(r.from_json ? { from: JSON.parse(r.from_json) as Address } : {}),
      to: JSON.parse(r.to_json) as Address[], subject: r.subject, date: r.date, text: r.text,
    };
  }

  /** A stored message's raw bytes, for reading an attachment out of it. */
  rawOf(id: number): Uint8Array | undefined {
    const raw = this.sql('select raw from bodies where message_id = ?').pluck().get(id) as Buffer | undefined;
    return raw ? new Uint8Array(raw) : undefined;
  }

  /** Always load remote images from this sender. */
  allowImagesFrom(address: string) {
    this.sql('insert into image_senders(address) values (?) on conflict do nothing').run(address.toLowerCase());
  }

  /** Where a message lives, so the sync process can fetch its body on demand. */
  messageLocation(id: number): { accountId: AccountId; mailbox: string; uid: number } | undefined {
    const r = this.sql('select account_id, mailbox, uid from messages where id = ?').get(id) as { account_id: string; mailbox: string; uid: number } | undefined;
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
