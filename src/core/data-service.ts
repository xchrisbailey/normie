// The data side of the core: wraps the Store, answers the renderer's queries,
// takes writes from sync, and emits change notices. Runs in the data process.
import { Store, type BodyInput } from './store';
import type { AccountId, ChangeSet, CoreNotice, MailboxRole, SplitId, SyncState, ThreadMessage, ThreadRow } from './types';

export type NoticeListener = (n: CoreNotice) => void;

export class DataService {
  private listeners = new Set<NoticeListener>();
  /** Called when the renderer opens a message whose body isn't stored yet. Set by whoever wires up sync. */
  bodyRequester?: (loc: { accountId: AccountId; mailbox: string; uid: number }) => void;

  constructor(readonly store: Store) {}

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

  // --- Writes (sync)

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
}

export const DATA_PORT_METHODS = [
  'upsertAccount', 'setMailboxes', 'removeAccount', 'mailboxState', 'knownUids', 'uidsNeedingBodies', 'applyChanges', 'putBodies',
] as const satisfies readonly (keyof DataPort)[];

/** Adapts an in-process DataService to the async DataPort. */
export function localDataPort(ds: DataService): DataPort {
  const port = {} as Record<string, unknown>;
  for (const m of DATA_PORT_METHODS) port[m] = async (...args: unknown[]) => (ds[m] as (...a: unknown[]) => unknown)(...args);
  return port as unknown as DataPort;
}
