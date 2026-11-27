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

/** Changes to the flags and Labels of some messages. Labels apply only on servers with caps.labels. */
export interface MessageEdit {
  addFlags?: string[];
  removeFlags?: string[];
  addLabels?: string[];
  removeLabels?: string[];
}

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
  | { type: 'label'; label: string; on: boolean };

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
  | { type: 'change-failed'; subject: string; error: string };
