// The sync process: talks to mail servers and hands changes to the data process.
import type { MessagePortMain } from 'electron';
import { DATA_PORT_METHODS, type DataPort } from '../core/data-service';
import { FakeProvider, fakeExtractText, seedDemo } from '../core/fake-provider';
import { connect, mainPortChannel, proxy } from '../core/rpc';
import { SyncEngine } from '../core/sync-engine';
import type { MailProvider } from '../core/types';

export type AccountConfig = { kind: 'fake'; accountId: string; email: string; seed?: number };

type InitMessage = { type: 'init'; accounts: AccountConfig[] };

const log = (m: string) => console.log(`[sync] ${m}`);
let dataPortMain: MessagePortMain | undefined;
let accounts: AccountConfig[] | undefined;
const engines = new Map<string, SyncEngine>();

function providerFor(a: AccountConfig): { provider: MailProvider; extractText: (raw: Uint8Array) => Promise<string> } {
  const p = new FakeProvider();
  seedDemo(p, a.seed ?? 40);
  return { provider: p, extractText: fakeExtractText };
}

let started = false;

async function run() {
  if (started || !dataPortMain || !accounts) return;
  started = true;
  const client = connect(mainPortChannel(dataPortMain));
  const data = proxy<DataPort>(client, DATA_PORT_METHODS);
  client.on('fetch-body', (payload) => {
    const loc = payload as { accountId: string; mailbox: string; uid: number };
    engines.get(loc.accountId)?.fetchBodies(loc.mailbox, [loc.uid]).catch((e) => log(`body fetch failed: ${e.message}`));
  });
  for (const a of accounts) {
    const { provider, extractText } = providerFor(a);
    const engine = new SyncEngine({ accountId: a.accountId, kind: a.kind, email: a.email, provider, data, extractText, log });
    engines.set(a.accountId, engine);
    try {
      await engine.start();
      await engine.syncOnce();
    } catch (e) {
      log(`${a.accountId}: ${(e as Error).message}`);
    }
  }
}

process.parentPort.on('message', (e) => {
  const msg = e.data as InitMessage | { type: 'data-port' };
  if (msg.type === 'init') accounts = msg.accounts;
  else if (msg.type === 'data-port') dataPortMain = e.ports[0];
  void run();
});
