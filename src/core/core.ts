// The core's command and query interface: the main test seam (see #3, Testing Decisions).
// In the app, DataService runs in the data process and SyncEngine in the sync process,
// joined by MessagePorts. createCore joins them in one process, for tests and the benchmark.
import { DataService, localDataPort } from './data-service';
import { Store } from './store';
import { SyncEngine, type TextExtractor } from './sync-engine';
import type { CoreApi } from './api';
import type { AccountId, CoreNotice, MailProvider } from './types';

export { CORE_API_METHODS, type CoreApi } from './api';

export function coreApiOf(ds: DataService): CoreApi {
  return {
    rows: async (split, limit) => ds.rows(split, limit),
    thread: (key) => ds.thread(key),
    act: async (key, action) => ds.act(key, action),
    undo: async (ids) => ds.undo(ids),
    pending: async () => ds.pending(),
    labels: async (accountId) => ds.labels(accountId),
    allowImagesFrom: async (address) => ds.allowImagesFrom(address),
  };
}

export interface TestCore extends CoreApi {
  data: DataService;
  engine: SyncEngine;
  notices: CoreNotice[];
  onNotice(fn: (n: CoreNotice) => void): () => void;
  close(): Promise<void>;
}

export interface CreateCoreOptions {
  provider: MailProvider;
  extractText: TextExtractor;
  dbPath?: string;
  accountId?: AccountId;
  kind?: string;
  email?: string;
  now?: () => number;
  windowDays?: number;
  pollMs?: number;
  debounceMs?: number;
  backoffMs?: (attempt: number) => number;
  deleteHoldMs?: number;
  extractHtml?: (raw: Uint8Array) => Promise<string | null>;
}

/** The whole core in one process: store, data service and one Account's sync engine. */
export async function createCore(o: CreateCoreOptions): Promise<TestCore> {
  const data = new DataService(new Store(o.dbPath ?? ':memory:'), { now: o.now, deleteHoldMs: o.deleteHoldMs, extractHtml: o.extractHtml });
  const notices: CoreNotice[] = [];
  data.onNotice((n) => notices.push(n));
  const engine = new SyncEngine({
    accountId: o.accountId ?? 'acct-1',
    kind: o.kind ?? 'fake',
    email: o.email ?? 'me@example.com',
    provider: o.provider,
    data: localDataPort(data),
    extractText: o.extractText,
    now: o.now,
    windowDays: o.windowDays,
    pollMs: o.pollMs,
    debounceMs: o.debounceMs,
    backoffMs: o.backoffMs,
  });
  data.bodyRequester = (loc) => void engine.fetchBodies(loc.mailbox, [loc.uid]).catch(() => {});
  data.replayRequester = () => engine.replaySoon();
  await engine.start();
  return {
    ...coreApiOf(data),
    data,
    engine,
    notices,
    onNotice: (fn) => data.onNotice(fn),
    close: async () => {
      await engine.stop();
      data.store.close();
    },
  };
}
