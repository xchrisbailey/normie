// The data side of the core: wraps the Store, answers the renderer's queries,
// takes writes from sync, and emits change notices. Runs in the data process.
import { newMessageId } from './ids';
import { Store, type BodyInput } from './store';
import type {
  AccountId, AttachmentInfo, ChangeSet, OutboxItem, OutgoingMessage, CoreNotice, MailboxRole, PendingChange, PendingStatus, SplitId, SyncState, ThreadAction, ThreadMessage, ThreadRow,
} from './types';

/** Reads stored messages (mailparser in the app). Injected, so the core can run without it. */
export interface MimeReader {
  readMessage(raw: Uint8Array): Promise<{ html: string | null; attachments: AttachmentInfo[] }>;
  attachmentContent(raw: Uint8Array, index: number): Promise<{ filename: string; contentType: string; content: Uint8Array } | null>;
}

/** A change the server refuses this many times is given up on and undone locally. */
export const MAX_REJECTIONS = 3;

/** How long a sent message waits in the Outbox, so Cmd-Z can still take it back. */
export const UNDO_SEND_MS = 5000;

export type NoticeListener = (n: CoreNotice) => void;

export class DataService {
  private listeners = new Set<NoticeListener>();
  /** Called when the renderer opens a message whose body isn't stored yet. Set by whoever wires up sync. */
  bodyRequester?: (loc: { accountId: AccountId; mailbox: string; uid: number }) => void;
  /** Called when an Account has new pending changes for the server. Set by whoever wires up sync. */
  replayRequester?: (accountId: AccountId) => void;

  private readonly now: () => number;
  private readonly deleteHoldMs?: number;
  private readonly mime?: MimeReader;
  private readonly undoSendMs: number;
  /** Called when an Account has mail to send. Set by whoever wires up sync. */
  outboxRequester?: (accountId: AccountId) => void;

  constructor(readonly store: Store, opts: { now?: () => number; deleteHoldMs?: number; mime?: MimeReader; undoSendMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.deleteHoldMs = opts.deleteHoldMs;
    this.mime = opts.mime;
    this.undoSendMs = opts.undoSendMs ?? UNDO_SEND_MS;
  }

  // --- Sending

  /** Put a message in the Outbox. It goes out after the undo window. Returns its Outbox id. */
  send(message: OutgoingMessage): number {
    const id = this.store.queueSend(message, newMessageId(message.from), this.now() + this.undoSendMs, this.now());
    this.emitPending();
    this.outboxRequester?.(message.accountId);
    return id;
  }

  /** Take a message back before it's sent (undo send), or after it failed. Null once it's on its way. */
  cancelSend(id: number): OutgoingMessage | null {
    const m = this.store.cancelSend(id);
    this.emitPending();
    return m;
  }

  dueOutbox(accountId: AccountId): OutboxItem[] {
    return this.store.dueOutbox(accountId, this.now());
  }

  nextOutboxAt(accountId: AccountId): number | undefined {
    return this.store.nextOutboxAt(accountId);
  }

  outboxSent(id: number) {
    this.store.outboxSent(id);
    this.emitPending();
  }

  /** Returns whether the message failed for good; the renderer is told so it can reopen it. */
  outboxFailed(id: number, error: string, rejected: boolean): boolean {
    const failed = this.store.outboxFailed(id, error, rejected, MAX_REJECTIONS);
    this.emitPending();
    if (failed) this.emit({ type: 'send-failed', id, error });
    return failed;
  }

  onNotice(fn: NoticeListener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(n: CoreNotice) {
    for (const fn of this.listeners) fn(n);
  }

  // --- Queries (renderer)

  rows(split: SplitId, limit?: number): ThreadRow[] {
    return this.store.rows(split, limit);
  }

  /** A Thread's messages. HTML parts are extracted from the stored message the first time it's opened. */
  async thread(key: string): Promise<ThreadMessage[]> {
    let messages = this.store.thread(key);
    for (const m of messages) {
      if (m.text === null && this.bodyRequester) {
        const loc = this.store.messageLocation(m.id);
        if (loc) this.bodyRequester(loc);
      }
    }
    if (this.mime) {
      const pending = this.store.bodiesWithoutHtml(messages.map((m) => m.id));
      if (pending.length) {
        for (const b of pending) {
          const read = await this.mime.readMessage(b.raw).catch(() => ({ html: null, attachments: [] }));
          this.store.putRead(b.id, read.html ?? '', read.attachments);
        }
        messages = this.store.thread(key);
      }
    }
    return messages;
  }

  /** One attachment's bytes, read from the stored message. */
  async attachment(messageId: number, index: number): Promise<{ filename: string; contentType: string; content: Uint8Array } | null> {
    const raw = this.store.rawOf(messageId);
    if (!raw || !this.mime) return null;
    return this.mime.attachmentContent(raw, index);
  }

  /** Always load remote images from this sender. */
  allowImagesFrom(address: string) {
    this.store.allowImagesFrom(address);
  }

  // --- Commands (renderer)

  /**
   * A triage action: the store changes at once, and the change is queued for the server. Returns the pending change ids.
   * No rows-changed notice: the renderer that asked has already changed its rows, and reloading thousands of rows
   * per key press costs memory for nothing.
   */
  act(key: string, action: ThreadAction): number[] {
    const { changes } = this.store.recordAction(key, action, this.now(), this.deleteHoldMs);
    if (changes.length) this.emitPending();
    const accounts = new Set(changes.map((c) => c.accountId));
    for (const a of accounts) this.replayRequester?.(a);
    return changes.map((c) => c.id);
  }

  // --- Writes (sync)

  /** Changes ready to send now, oldest first. */
  pendingChanges(accountId: AccountId): PendingChange[] {
    return this.store.pendingChanges(accountId, this.now());
  }

  /** When a held change (a fresh delete) may be sent. */
  nextSendAt(accountId: AccountId): number | undefined {
    return this.store.nextSendAt(accountId);
  }

  pending(): PendingStatus {
    return this.store.pendingStatus();
  }

  private emitPending() {
    this.emit({ type: 'pending', ...this.store.pendingStatus() });
  }

  changeApplied(id: number) {
    const replayAgain = this.store.changeApplied(id);
    this.emitPending();
    // It was undone while on its way: its inverse is now queued.
    if (replayAgain) this.replayRequester?.(replayAgain);
  }

  /** Undo triage actions by their change ids. The local copy goes back at once; the server catches up. */
  undo(ids: number[]) {
    const { accounts, inboxChanged } = this.store.undo(ids);
    if (inboxChanged) this.emit({ type: 'rows-changed', split: 'inbox' });
    this.emitPending();
    for (const a of accounts) this.replayRequester?.(a);
  }

  /** Returns whether the change was given up on and rolled back. */
  changeFailed(id: number, error: string, rejected: boolean): boolean {
    const attempts = this.store.changeFailed(id, error, rejected);
    let rolledBack = false;
    if (rejected && attempts >= MAX_REJECTIONS) {
      const r = this.store.rollbackChange(id);
      if (r) {
        rolledBack = true;
        if (r.inboxChanged) this.emit({ type: 'rows-changed', split: 'inbox' });
        this.emit({ type: 'change-failed', subject: r.subject, error });
      }
    }
    this.emitPending();
    return rolledBack;
  }

  upsertAccount(id: AccountId, kind: string, email: string) {
    this.store.upsertAccount(id, kind, email);
  }

  setMailboxes(accountId: AccountId, boxes: { path: string; role?: MailboxRole }[]) {
    this.store.setMailboxes(accountId, boxes);
    this.emit({ type: 'labels-changed', accountId });
  }

  labels(accountId: AccountId): string[] {
    return this.store.labels(accountId);
  }

  /** Delete an Account and all its local mail. */
  removeAccount(accountId: AccountId) {
    this.store.removeAccount(accountId);
    this.emit({ type: 'rows-changed', split: 'inbox' });
  }

  /** Drop local mail for Accounts that no longer exist, such as leftovers from a dev run. */
  pruneAccounts(keep: AccountId[]): AccountId[] {
    const removed = this.store.pruneAccounts(keep);
    if (removed.length) this.emit({ type: 'rows-changed', split: 'inbox' });
    return removed;
  }

  mailboxState(accountId: AccountId, mailbox: string): SyncState | null {
    return this.store.mailboxState(accountId, mailbox);
  }

  knownUids(accountId: AccountId, mailbox: string, since?: number): number[] {
    return this.store.knownUids(accountId, mailbox, since);
  }

  uidsNeedingBodies(accountId: AccountId, mailbox: string, windowStart: number, limit: number): number[] {
    return this.store.uidsNeedingBodies(accountId, mailbox, windowStart, limit);
  }

  applyChanges(accountId: AccountId, mailbox: string, cs: Partial<ChangeSet>) {
    if (this.store.applyChanges(accountId, mailbox, cs)) this.emit({ type: 'rows-changed', split: 'inbox' });
    if (this.store.replayNeeded.size) {
      const accounts = [...this.store.replayNeeded];
      this.store.replayNeeded.clear();
      this.emitPending();
      for (const a of accounts) this.replayRequester?.(a);
    }
  }

  putBodies(accountId: AccountId, mailbox: string, bodies: BodyInput[]) {
    const { keys, inboxChanged } = this.store.putBodies(accountId, mailbox, bodies);
    if (inboxChanged) this.emit({ type: 'rows-changed', split: 'inbox' });
    for (const key of keys) this.emit({ type: 'thread-changed', key });
  }
}

/** The part of DataService that sync uses. Async because in the app it's reached over a MessagePort. */
export interface DataPort {
  upsertAccount(id: AccountId, kind: string, email: string): Promise<void>;
  setMailboxes(accountId: AccountId, boxes: { path: string; role?: MailboxRole }[]): Promise<void>;
  removeAccount(accountId: AccountId): Promise<void>;
  mailboxState(accountId: AccountId, mailbox: string): Promise<SyncState | null>;
  knownUids(accountId: AccountId, mailbox: string, since?: number): Promise<number[]>;
  uidsNeedingBodies(accountId: AccountId, mailbox: string, windowStart: number, limit: number): Promise<number[]>;
  applyChanges(accountId: AccountId, mailbox: string, cs: Partial<ChangeSet>): Promise<void>;
  putBodies(accountId: AccountId, mailbox: string, bodies: BodyInput[]): Promise<void>;
  pendingChanges(accountId: AccountId): Promise<PendingChange[]>;
  nextSendAt(accountId: AccountId): Promise<number | undefined>;
  changeApplied(id: number): Promise<void>;
  changeFailed(id: number, error: string, rejected: boolean): Promise<boolean>;
  dueOutbox(accountId: AccountId): Promise<OutboxItem[]>;
  nextOutboxAt(accountId: AccountId): Promise<number | undefined>;
  outboxSent(id: number): Promise<void>;
  outboxFailed(id: number, error: string, rejected: boolean): Promise<boolean>;
}

export const DATA_PORT_METHODS = [
  'upsertAccount', 'setMailboxes', 'removeAccount', 'mailboxState', 'knownUids', 'uidsNeedingBodies', 'applyChanges', 'putBodies',
  'pendingChanges', 'nextSendAt', 'changeApplied', 'changeFailed', 'dueOutbox', 'nextOutboxAt', 'outboxSent', 'outboxFailed',
] as const satisfies readonly (keyof DataPort)[];

/** Adapts an in-process DataService to the async DataPort. */
export function localDataPort(ds: DataService): DataPort {
  const port = {} as Record<string, unknown>;
  for (const m of DATA_PORT_METHODS) port[m] = async (...args: unknown[]) => (ds[m] as (...a: unknown[]) => unknown)(...args);
  return port as unknown as DataPort;
}
