// The core's command and query interface: the main test seam (see #3, Testing Decisions).
// In the app, DataService runs in the data process and SyncEngine in the sync process,
// joined by MessagePorts. createCore joins them in one process, for tests and the benchmark.
import { DataService, localDataPort } from './data-service';
import type { MimeReader } from './data-service';
import { Store } from './store';
import { SyncEngine } from './sync-engine';
import type { SyncEngineOptions, TextExtractor } from './sync-engine';
import type { CoreApi } from './api';
import type { AccountId, CoreNotice, MailProvider, MailTransport } from './types';

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
    attachment: (messageId, index) => ds.attachment(messageId, index),
    send: async (m, draftId, sendAt) => ds.send(m, draftId, sendAt),
    scheduled: async () => ds.scheduled(),
    search: async (q, limit) => ds.search(q, limit),
    searchServer: (q, limit) => ds.searchServer(q, limit),
    saveDraft: async (id, content) => ds.saveDraft(id, content),
    deleteDraft: async (id) => ds.deleteDraft(id),
    drafts: async () => ds.drafts(),
    contacts: async (q, limit) => ds.contacts(q, limit),
    setVip: async (address, on) => ds.setVip(address, on),
    draft: async (id) => ds.draft(id),
    cancelSend: async (id) => ds.cancelSend(id),
    original: (id, withAttachments) => ds.original(id, withAttachments),
  };
}

export interface TestCore extends CoreApi {
  data: DataService;
  engine: SyncEngine;
  notices: Array<CoreNotice>;
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
  identities?: Array<string>;
  now?: () => number;
  windowDays?: number;
  pollMs?: number;
  debounceMs?: number;
  backoffMs?: (attempt: number) => number;
  deleteHoldMs?: number;
  transport?: MailTransport;
  undoSendMs?: number;
  draftDebounceMs?: number;
  mime?: MimeReader;
}

/** The whole core in one process: store, data service and one Account's sync engine. */
export async function createCore(o: CreateCoreOptions): Promise<TestCore> {
  const data = new DataService(new Store(o.dbPath ?? ':memory:'), { now: o.now, deleteHoldMs: o.deleteHoldMs, mime: o.mime, undoSendMs: o.undoSendMs });
  const notices: Array<CoreNotice> = [];
  data.onNotice((n) => notices.push(n));
  const engineOptions: SyncEngineOptions = {
    accountId: o.accountId ?? 'gmail:me@example.com',
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
    transport: o.transport,
    draftDebounceMs: o.draftDebounceMs,
  };
  if (o.identities) {engineOptions.identities = o.identities;}
  const engine = new SyncEngine(engineOptions);
  data.bodyRequester = (loc) => void engine.fetchBodies(loc.mailbox, [loc.uid]).catch(() => {});
  data.replayRequester = () => engine.replaySoon();
  data.outboxRequester = () => engine.outboxSoon();
  data.draftsRequester = () => engine.draftsSoon();
  data.serverSearcher = (q) => engine.searchServer(q);
  await engine.start();
  data.startScheduler();
  return {
    ...coreApiOf(data),
    data,
    engine,
    notices,
    onNotice: (fn) => data.onNotice(fn),
    close: async () => {
      data.stopScheduler();
      await engine.stop();
      data.store.close();
    },
  };
}
