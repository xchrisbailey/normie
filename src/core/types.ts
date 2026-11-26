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
  fetchBodies(mailbox: string, uids: number[]): Promise<RawMessage[]>;
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
}

/** Change notices the core sends to the renderer. */
export type CoreNotice = { type: 'rows-changed'; split: SplitId } | { type: 'thread-changed'; key: string };
