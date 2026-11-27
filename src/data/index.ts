// The data process: owns the SQLite file. Serves the renderer's queries and sync's writes.
import type { MessagePortMain } from 'electron';
import { CORE_API_METHODS, coreApiOf } from '../core/core';
import type { CoreEvents } from '../core/api';
import { DATA_PORT_METHODS, DataService } from '../core/data-service';
import type { SyncEvents } from '../core/data-service';
import { mainPortChannel, serve } from '../core/rpc';
import type { Emitter } from '../core/rpc';
import { attachmentContent, readMessage, readOriginal } from '../core/mime';
import { Store } from '../core/store';

type InitMessage =
  | { type: 'init'; dbPath: string; keepAccounts?: Array<string> }
  | { type: 'renderer-port' }
  | { type: 'sync-port' };

let data: DataService | undefined;
const pendingPorts: Array<{ kind: 'renderer-port' | 'sync-port'; port: MessagePortMain }> = [];
let emitToSync: Emitter<SyncEvents> | undefined;
const pendingSearches = new Map<number, () => void>();
let nextSearch = 0;

/** After a few quiet seconds, SQLite gives its page cache back (#75). Every request pushes it back. */
let quietTimer: ReturnType<typeof setTimeout> | undefined;
const busy = () => {
  clearTimeout(quietTimer);
  quietTimer = setTimeout(() => data?.store.shrinkMemory(), 5000);
};

function attach(kind: 'renderer-port' | 'sync-port', port: MessagePortMain) {
  if (!data) {return void pendingPorts.push({ kind, port });}
  const ds = data;
  const ch = mainPortChannel(port);
  port.on('message', busy);
  if (kind === 'renderer-port') {
    const api = coreApiOf(ds);
    const handlers = Object.fromEntries(CORE_API_METHODS.map((m) => [m, api[m]]));
    const emit = serve<CoreEvents>(ch, handlers);
    const off = ds.onNotice((n) => emit('notice', n));
    port.on('close', () => off());
  } else {
    const handlers = Object.fromEntries(DATA_PORT_METHODS.map((m) => [m, (...a: Array<unknown>) => (ds[m] as (...x: Array<unknown>) => unknown)(...a)]));
    // Sync answers a server search by calling back with its id once the hits are stored.
    emitToSync = serve<SyncEvents>(ch, { ...handlers, serverSearchDone: (id: number) => void pendingSearches.get(id)?.() });
  }
}

process.parentPort.on('message', (e) => {
  if ((e.data as { type: string }).type === 'debug-search' && data) {
    // The benchmark: time each query, as the renderer would ask it.
    const ds = data;
    while (ds.indexSearchBatch(5000)){;}
    const times = (e.data as { queries: Array<string> }).queries.map((q) => {
      const t = performance.now();
      const n = ds.search(q).length;
      return { q, n, ms: performance.now() - t };
    });
    return void process.parentPort.postMessage({ type: 'debug-search', times });
  }
  if ((e.data as { type: string }).type === 'debug-memory') {
    const m = process.memoryUsage();
    const mb = (n: number) => Math.round(n / 1_048_576);
    const sqlite = data ? (data.store.db.pragma('cache_size', { simple: true }) as number) : 0;
    return void process.parentPort.postMessage({ type: 'debug-memory', rss: mb(m.rss), heapUsed: mb(m.heapUsed), heapTotal: mb(m.heapTotal), external: mb(m.external), arrayBuffers: mb(m.arrayBuffers), sqliteCache: sqlite });
  }
  const msg = e.data as InitMessage;
  if (msg.type === 'init') {
    data = new DataService(new Store(msg.dbPath), { mime: { readMessage, attachmentContent, readOriginal } });
    // Main sends the Account list when it's the source of truth (not in fake or benchmark runs).
    if (msg.keepAccounts) {
      const removed = data.pruneAccounts(msg.keepAccounts);
      if (removed.length) {console.log(`[data] removed ${removed.length} Account(s) that are no longer signed in`);}
    }
    data.bodyRequester = (loc) => emitToSync?.('fetch-body', loc);
    data.serverSearcher = (query) => new Promise<void>((resolve) => {
      const id = ++nextSearch;
      const done = () => {
        pendingSearches.delete(id);
        resolve();
      };
      pendingSearches.set(id, done);
      // A server that never answers doesn't hold the search up for long.
      setTimeout(done, 30_000);
      if (emitToSync) {emitToSync('search-server', { id, query });}
      else {done();}
    });
    data.startScheduler();
    // Mail stored before list headers were fetched gets its Newsletters tag in the background.
    const ds = data;
    const backfill = () => {
      if (ds.backfillListFlags(1000)) {setTimeout(backfill, 20);}
    };
    setTimeout(backfill, 3000);
    // Mail stored before search existed is indexed in the background, newest first.
    const index = () => {
      if (ds.indexSearchBatch(400)) {setTimeout(index, 30);}
    };
    setTimeout(index, 4000);
    data.replayRequester = (accountId) => emitToSync?.('replay', { accountId });
    data.outboxRequester = (accountId) => emitToSync?.('outbox', { accountId });
    data.draftsRequester = (accountId) => emitToSync?.('drafts', { accountId });
    for (const p of pendingPorts.splice(0)) {attach(p.kind, p.port);}
  } else {
    const port = e.ports[0];
    if (port) {attach(msg.type, port);}
  }
});
