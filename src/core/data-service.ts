// The data side of the core: wraps the Store, answers the renderer's queries,
// takes writes from sync, and emits change notices. Runs in the data process.
import { Store, type BodyInput } from './store';
import type {
  AccountId, ChangeSet, CoreNotice, MailboxRole, PendingChange, PendingStatus, SplitId, SyncState, ThreadAction, ThreadMessage, ThreadRow,
} from './types';

/** A change the server refuses this many times is given up on and undone locally. */
export const MAX_REJECTIONS = 3;

export type NoticeListener = (n: CoreNotice) => void;

export class DataService {
  private listeners = new Set<NoticeListener>();
  /** Called when the renderer opens a message whose body isn't stored yet. Set by whoever wires up sync. */
  bodyRequester?: (loc: { accountId: AccountId; mailbox: string; uid: number }) => void;
  /** Called when an Account has new pending changes for the server. Set by whoever wires up sync. */
  replayRequester?: (accountId: AccountId) => void;

  private readonly now: () => number;
  private readonly deleteHoldMs?: number;

  constructor(readonly store: Store, opts: { now?: () => number; deleteHoldMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.deleteHoldMs = opts.deleteHoldMs;
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

  thread(key: string): ThreadMessage[] {
    const messages = this.store.thread(key);
    for (const m of messages) {
      if (m.text === null && this.bodyRequester) {
        const loc = this.store.messageLocation(m.id);
        if (loc) this.bodyRequester(loc);
      }
    }
    return messages;
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
}

export const DATA_PORT_METHODS = [
  'upsertAccount', 'setMailboxes', 'removeAccount', 'mailboxState', 'knownUids', 'uidsNeedingBodies', 'applyChanges', 'putBodies',
  'pendingChanges', 'nextSendAt', 'changeApplied', 'changeFailed',
] as const satisfies readonly (keyof DataPort)[];

/** Adapts an in-process DataService to the async DataPort. */
export function localDataPort(ds: DataService): DataPort {
  const port = {} as Record<string, unknown>;
  for (const m of DATA_PORT_METHODS) port[m] = async (...args: unknown[]) => (ds[m] as (...a: unknown[]) => unknown)(...args);
  return port as unknown as DataPort;
}
