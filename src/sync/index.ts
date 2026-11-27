// The sync process: talks to mail servers and hands changes to the data process.
// Main tells it which Accounts exist; it keeps one SyncEngine per Account in step with that list.
import type { MessagePortMain } from 'electron';
import { DATA_PORT_METHODS, type DataPort } from '../core/data-service';
import { FakeProvider, seedDemo, seedNewsletter } from '../core/fake-provider';
import { connect, mainPortChannel, proxy, type Client } from '../core/rpc';
import { SyncEngine } from '../core/sync-engine';
import type { MailProvider } from '../core/types';
import { extractText } from './extract-text';
import { gmailConfig, ImapProvider } from './imap-provider';

export type AccountConfig =
  | { kind: 'fake'; accountId: string; email: string; seed?: number }
  | { kind: 'gmail'; accountId: string; email: string; status?: 'ok' | 'needs-sign-in' };

type Message =
  | { type: 'accounts'; accounts: AccountConfig[] }
  | { type: 'poll' }
  | { type: 'data-port' }
  | { type: 'main-port' };

const log = (m: string) => console.log(`[sync] ${m}`);
let data: DataPort | undefined;
let dataClient: Client | undefined;
let mainClient: Client | undefined;
let wanted: AccountConfig[] | undefined;
const engines = new Map<string, SyncEngine>();
const starting = new Set<string>();

/** Access tokens come from main, which holds the secrets. */
const accessToken = (accountId: string) => mainClient!.call<string>('accessToken', accountId);

function providerFor(a: AccountConfig): { provider: MailProvider; extractText: (raw: Uint8Array) => Promise<string> } {
  if (a.kind === 'gmail') return { provider: new ImapProvider(gmailConfig(a.email, () => accessToken(a.accountId), log)), extractText };
  const p = new FakeProvider();
  seedDemo(p, a.seed ?? 40);
  if (!a.seed) seedNewsletter(p);
  return { provider: p, extractText };
}

async function startAccount(a: AccountConfig) {
  if (!data || engines.has(a.accountId) || starting.has(a.accountId)) return;
  if (a.kind === 'gmail' && a.status === 'needs-sign-in') return;
  starting.add(a.accountId);
  const { provider, extractText: extract } = providerFor(a);
  const engine = new SyncEngine({ accountId: a.accountId, kind: a.kind, email: a.email, provider, data, extractText: extract, log });
  try {
    await engine.start();
    engines.set(a.accountId, engine);
    log(`${a.accountId}: syncing ${engine.primaryMailbox}`);
    await engine.syncOnce();
    log(`${a.accountId}: first sync done; watching for changes`);
    if (engines.get(a.accountId) === engine) engine.startLive();
  } catch (e) {
    log(`${a.accountId}: ${(e as Error).message}`);
    engines.delete(a.accountId);
    await engine.stop().catch(() => {});
  } finally {
    starting.delete(a.accountId);
  }
}

async function reconcile() {
  if (!data || !mainClient || !wanted) return;
  const ids = new Set(wanted.map((a) => a.accountId));
  for (const [id, engine] of engines) {
    const w = wanted.find((a) => a.accountId === id);
    if (!w || (w.kind === 'gmail' && w.status === 'needs-sign-in')) {
      engines.delete(id);
      await engine.stop().catch(() => {});
      if (!w) await data.removeAccount(id);
    }
  }
  for (const a of wanted) if (ids.has(a.accountId)) void startAccount(a);
}

process.parentPort.on('message', (e) => {
  const msg = e.data as Message;
  if (msg.type === 'poll') return void engines.forEach((engine) => engine.pollNow());
  if (msg.type === 'accounts') wanted = msg.accounts;
  else if (msg.type === 'data-port' && e.ports[0]) {
    dataClient = connect(mainPortChannel(e.ports[0] as MessagePortMain));
    data = proxy<DataPort>(dataClient, DATA_PORT_METHODS);
    dataClient.on('fetch-body', (payload) => {
      const loc = payload as { accountId: string; mailbox: string; uid: number };
      engines.get(loc.accountId)?.fetchBodies(loc.mailbox, [loc.uid]).catch((err) => log(`body fetch failed: ${err.message}`));
    });
    dataClient.on('replay', (payload) => engines.get((payload as { accountId: string }).accountId)?.replaySoon());
  } else if (msg.type === 'main-port' && e.ports[0]) mainClient = connect(mainPortChannel(e.ports[0] as MessagePortMain));
  void reconcile();
});
