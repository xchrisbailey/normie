import type { ServerQuery } from './search-query';
// Domain types and the provider interface. Vocabulary follows GLOSSARY.md.

export type AccountId = string;

export interface Address {
  name?: string;
  address: string;
}

/** A Split is a saved filter over the Unified Inbox. Milestone 1 has only the Inbox Split. */
export type SplitId = 'inbox';

/** Special-use role of a mailbox, found by flag, never by name. */
export type MailboxRole = 'inbox' | 'sent' | 'drafts' | 'all' | 'trash' | 'junk' | 'flagged' | 'archive';

export interface Mailbox {
  path: string;
  role?: MailboxRole;
}

/** What a server supports, as measured in spike #2. */
export interface Caps {
  condstore: boolean;
  qresync: boolean;
  move: boolean;
  /** Messages can carry several Labels (Gmail). */
  labels: boolean;
  /** The server supplies thread ids (Gmail X-GM-THRID). */
  serverThreads: boolean;
  /** The server files SMTP mail in Sent by itself. */
  savesSent: boolean;
}

/** Where sync left off in one mailbox. */
export interface SyncState {
  uidValidity: string;
  uidNext: number;
  /** Absent when the server has no CONDSTORE. */
  highestModseq?: string;
}

/** A message's headers and state, as the provider reports it. */
export interface RemoteHeader {
  uid: number;
  /** Stable id across mailboxes when the server has one (Gmail X-GM-MSGID); otherwise mailbox:uid. */
  remoteId: string;
  /** Server thread id when caps.serverThreads; otherwise undefined and threads are built locally. */
  threadId?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  subject: string;
  from?: Address;
  to: Address[];
  /** Milliseconds since epoch. */
  date: number;
  flags: string[];
  /** Labels including system ones such as \Inbox. On folder-only servers, the mailbox the message is in. */
  labels: string[];
  /** Sent to a list: List-Unsubscribe, List-Id or Precedence: bulk/list. Undefined when the headers weren't fetched. */
  isList?: boolean;
}

export interface FlagChange {
  uid: number;
  flags: string[];
  labels?: string[];
}

export interface ChangeSet {
  state: SyncState;
  /** True when the server's UIDVALIDITY changed or there was no prior state: replace everything known. */
  reset: boolean;
  /** New messages, or messages to (re)write in full. */
  headers: RemoteHeader[];
  flagChanges: FlagChange[];
  /** UIDs the server reported as gone (QRESYNC VANISHED or EXPUNGE). */
  vanished: number[];
}

export interface RawMessage {
  uid: number;
  raw: Uint8Array;
}

export type MailEvent =
  | { type: 'exists'; mailbox: string }
  | { type: 'flags'; mailbox: string; uid: number; flags: string[] }
  | { type: 'expunge'; mailbox: string; uid?: number };

/**
 * Changes to some messages: flags, Labels (servers with caps.labels), or a move to another mailbox (folder
 * servers). A move is never combined with the others.
 */
export interface MessageEdit {
  addFlags?: string[];
  removeFlags?: string[];
  addLabels?: string[];
  removeLabels?: string[];
  moveTo?: string;
}

/** What a replayed change left behind that undo needs: where moved messages are now. */
export interface ChangeResult {
  /** UIDs in the destination mailbox, in the same order as the change's UIDs (0 where unknown). */
  movedUids?: number[];
}

/** A message the user wrote, as the composer hands it to the core. */
export interface OutgoingMessage {
  accountId: AccountId;
  /** The Identity it goes out from. */
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  /** Markdown; sent as HTML and as plain text. */
  body: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: { filename: string; contentType: string; content: Uint8Array }[];
  /** A Reminder: if nobody but me has written in the Thread by then (ms), it comes back to the Inbox. */
  remindAt?: number;
}

/** A draft as the composer holds it: address fields as typed, since they may not parse yet. */
export interface DraftContent {
  accountId: AccountId;
  from?: Address;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: { filename: string; contentType: string; content: Uint8Array }[];
}

/** A draft in the list the palette shows. */
export interface DraftSummary {
  id: number;
  accountId: AccountId;
  subject: string;
  to: string;
  updatedAt: number;
}

/** A draft whose latest version the server doesn't have yet. */
export interface DraftToSync {
  id: number;
  updatedAt: number;
  messageId: string;
  content: DraftContent;
}

/** A message waiting in the Outbox for a later time (Send Later). */
export interface ScheduledSummary {
  id: number;
  accountId: AccountId;
  subject: string;
  to: string;
  sendAt: number;
}

/** A message in the Outbox, as the sync process sends it. */
export interface OutboxItem {
  id: number;
  messageId: string;
  message: OutgoingMessage;
  attempts: number;
}

/** Sends built messages over SMTP. One per Account; a fake in tests. */
export interface MailTransport {
  send(raw: Uint8Array, envelope: { from: string; to: string[] }): Promise<void>;
}

/** The Label (Gmail) or folder snoozed mail waits in. */
export const SNOOZED = 'Snoozed';

/** The server answered and said no (as opposed to the connection failing). Counts toward giving up on a change. */
export class ServerRejectedError extends Error {
  readonly rejected = true;
}

/** How many pending changes are waiting for the server, and how many of those have failed at least once. */
export interface PendingStatus {
  count: number;
  waiting: number;
}

/** A triage action on a Thread, as the user takes it. */
export type ThreadAction =
  | { type: 'done' }
  /** Delete: to Trash. */
  | { type: 'delete' }
  | { type: 'star'; on: boolean }
  | { type: 'read'; on: boolean }
  /** Mute: Done now, and Done again whenever new mail arrives in the Thread. Off only unmutes. */
  | { type: 'mute'; on: boolean }
  /** Gmail: add or remove a Label. Folder servers, where a Label is a move, come in milestone 4. */
  | { type: 'label'; label: string; on: boolean }
  /** Out of the Inbox until `until` (ms): Gmail's Snoozed label, or a Snoozed folder. */
  | { type: 'snooze'; until: number }
  /** Back to the Inbox now. */
  | { type: 'unsnooze' };

/** An Account's Labels, or on folder servers its folders, where applying one moves the Thread. */
export interface LabelSet {
  moves: boolean;
  names: string[];
}

/** A triage action recorded by the core and waiting to reach the server. */
export interface PendingChange {
  id: number;
  accountId: AccountId;
  threadKey: string;
  mailbox: string;
  uids: number[];
  edit: MessageEdit;
  attempts: number;
}

export interface ChangesOptions {
  /** Only consider messages dated on or after this time (ms). */
  windowStart: number;
}

/** One interface for every kind of Account. Gmail, iCloud and generic IMAP differ only in caps and overrides. */
export interface MailProvider {
  readonly caps: Caps;
  connect(): Promise<void>;
  close(): Promise<void>;
  listMailboxes(): Promise<Mailbox[]>;
  /** What changed in a mailbox since `since` (or everything in the window when `since` is null). */
  changes(mailbox: string, since: SyncState | null, opts: ChangesOptions): Promise<ChangeSet>;
  /** Every UID in the mailbox within the window, for finding deletions when QRESYNC is missing. */
  uids(mailbox: string, opts: ChangesOptions): Promise<number[]>;
  /** UIDs of messages dated before `before` (ms): the history kept as headers only. */
  uidsBefore(mailbox: string, before: number): Promise<number[]>;
  /** Headers for specific UIDs. */
  headers(mailbox: string, uids: number[]): Promise<RemoteHeader[]>;
  fetchBodies(mailbox: string, uids: number[]): Promise<RawMessage[]>;
  /** Change flags and Labels on the server. */
  edit(mailbox: string, uids: number[], edit: MessageEdit): Promise<void>;
  /** UIDs in a mailbox matching a search (Gmail: X-GM-RAW; elsewhere IMAP SEARCH). */
  search(mailbox: string, query: ServerQuery): Promise<number[]>;
  /** Move messages to another mailbox (MOVE, or copy + delete + expunge). Returns their new UIDs, 0 where unknown. */
  move(mailbox: string, uids: number[], destination: string): Promise<{ uids: number[] }>;
  createMailbox(path: string): Promise<void>;
  /** Add a message to a mailbox, such as a sent copy to Sent. Returns its UID when the server says (UIDPLUS). */
  append(mailbox: string, raw: Uint8Array, flags: string[]): Promise<{ uid?: number }>;
  /** Delete messages for good (flag deleted, then expunge), such as an old copy of a draft. */
  remove(mailbox: string, uids: number[]): Promise<void>;
  /** Live events for one mailbox (IMAP IDLE). Ends when the signal aborts. */
  watch(mailbox: string, signal: AbortSignal): AsyncIterable<MailEvent>;
}

/** One row of a Split: a Thread, as the renderer shows it. */
export interface ThreadRow {
  /** Unique across Accounts. */
  key: string;
  accountId: AccountId;
  subject: string;
  from: string;
  /** Latest message date, ms. */
  date: number;
  snippet: string;
  unread: boolean;
  starred: boolean;
  count: number;
  /** What the Split rules need, worked out by the core. */
  tags?: RowTags;
}

/** Facts about a Thread the Splits are built from. */
export interface RowTags {
  /** Sent to a list (a newsletter, notifications). */
  newsletter: boolean;
  /** The sender is on my VIP list. */
  vip: boolean;
  /** I've written to the sender. */
  known: boolean;
  /** The other person in the Thread (its latest sender who isn't me), lowercased. */
  sender?: string;
  /** The Thread's own Labels (Gmail; system ones left out). */
  labels?: string[];
  /** Snoozed until then (ms). */
  snoozedUntil?: number;
  /** Back because nobody replied in time (a Reminder fired). */
  reminder?: boolean;
}

export interface ThreadMessage {
  id: number;
  from?: Address;
  to: Address[];
  date: number;
  subject: string;
  /** Plain text, or null when the body hasn't been downloaded yet. */
  text: string | null;
  /** The HTML part, unsanitized (the renderer sanitizes), or null when there is none. */
  html: string | null;
  /** The sender is on the list whose remote images always load. */
  imagesAllowed: boolean;
  /** Files attached (inline images shown in the body are left out). Empty until the body is stored. */
  attachments: AttachmentInfo[];
}

/** An attachment as the reader lists it. */
export interface AttachmentInfo {
  /** Its position among the message's MIME attachments, used to fetch it. */
  index: number;
  filename: string;
  contentType: string;
  size: number;
}

/** Change notices the core sends to the renderer. */
export type CoreNotice =
  | { type: 'rows-changed'; split: SplitId }
  | { type: 'thread-changed'; key: string }
  | ({ type: 'pending' } & PendingStatus)
  | { type: 'labels-changed'; accountId: AccountId }
  /** A change the server kept refusing was undone locally. */
  | { type: 'change-failed'; subject: string; error: string }
  /** New mail just arrived in these Inbox Threads (not on a first sync, not old mail, not mine). */
  | { type: 'arrived'; keys: string[] }
  /** A message couldn't be sent and was taken out of the Outbox; the renderer reopens it. */
  | { type: 'send-failed'; id: number; error: string };
