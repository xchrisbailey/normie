// The local store: one SQLite file in WAL mode, owned by the data process.
import Database from 'better-sqlite3';
import type {
  AccountId, Address, FlagChange, MailboxRole, MessageEdit, PendingChange, RemoteHeader, SplitId, SyncState, ThreadAction,
  ThreadMessage, ThreadRow,
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
];

/** How long a delete waits before it's sent, so it can still be undone. */
export const DELETE_HOLD_MS = 10_000;

const FLAGGED = '\\Flagged';
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
      for (const t of ['threads', 'messages', 'mailboxes', 'pending_changes', 'muted_threads']) this.db.prepare(`delete from ${t} where account_id = ?`).run(id);
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
        const threadKey = h.threadId ?? h.messageId ?? h.remoteId;
        if (!old) arrived.add(threadKey);
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
    return { count: r.count, waiting: r.waiting };
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
      .prepare(`select m.id, m.from_json, m.to_json, m.date, m.subject, b.text, b.html,
                exists (select 1 from image_senders s where s.address = lower(json_extract(m.from_json, '$.address'))) images_allowed
                from messages m left join bodies b on b.message_id = m.id
                where m.account_id = ? and m.thread_key = ? order by m.date asc, m.id asc`)
      .all(accountId, threadKey) as {
        id: number; from_json: string | null; to_json: string; date: number; subject: string; text: string | null; html: string | null; images_allowed: number;
      }[])
      .map((r) => ({
        id: r.id, from: r.from_json ? JSON.parse(r.from_json) : undefined, to: JSON.parse(r.to_json), date: r.date,
        subject: r.subject, text: r.text, html: r.html || null, imagesAllowed: r.images_allowed === 1,
      }));
  }

  /** Stored bodies among these messages whose HTML part hasn't been extracted yet. */
  bodiesWithoutHtml(ids: number[]): { id: number; raw: Uint8Array }[] {
    if (!ids.length) return [];
    return (this.db
      .prepare(`select message_id id, raw from bodies where html is null and message_id in (${ids.map(() => '?').join(',')})`)
      .all(...ids) as { id: number; raw: Buffer }[]).map((r) => ({ id: r.id, raw: new Uint8Array(r.raw) }));
  }

  /** Store a message's extracted HTML part ('' for none). */
  putHtml(id: number, html: string) {
    this.db.prepare('update bodies set html = ? where message_id = ?').run(html, id);
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
