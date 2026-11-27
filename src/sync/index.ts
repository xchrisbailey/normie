// The sync process: talks to mail servers and hands changes to the data process.
// Main tells it which Accounts exist; it keeps one SyncEngine per Account in step with that list.
import { DATA_PORT_METHODS } from '../core/data-service';
import { errorMessage, expected } from '../core/errors';
import { log as print } from '../core/log';
import type { DataPort, SyncEvents } from '../core/data-service';
import { FakeProvider, FakeTransport, seedDemo, seedNewsletter } from '../core/fake-provider';
import { connect, mainPortChannel, proxy } from '../core/rpc';
import type { Client } from '../core/rpc';
import { SyncEngine } from '../core/sync-engine';
import type { MailProvider, MailTransport } from '../core/types';
import type { PasswordAccountSettings } from '../main/auth/password-accounts';
import { extractText } from './extract-text';
import { gmailConfig, ImapProvider } from './imap-provider';
import { gmailTransport, passwordTransport } from './smtp';

export type AccountConfig =
  | { kind: 'fake'; accountId: string; email: string; seed?: number }
  | { kind: 'gmail'; accountId: string; email: string; status?: 'ok' | 'needs-sign-in'; identities?: Array<string> }
  | { kind: 'imap'; accountId: string; email: string; status?: 'ok' | 'needs-sign-in'; settings: PasswordAccountSettings; identities?: Array<string> };

type Message =
  | { type: 'accounts'; accounts: Array<AccountConfig> }
  | { type: 'poll' }
  | { type: 'data-port' }
  | { type: 'main-port' };

const isMessage = (v: unknown): v is Message =>
  typeof v === 'object' &&
  v !== null &&
  'type' in v &&
  (v.type === 'poll' || v.type === 'data-port' || v.type === 'main-port' || (v.type === 'accounts' && 'accounts' in v && Array.isArray(v.accounts)));

const log = (m: string) => print(`[sync] ${m}`);
let data: DataPort | undefined;
let dataClient: Client<SyncEvents> | undefined;
let mainClient: Client | undefined;
let wanted: Array<AccountConfig> | undefined;
const engines = new Map<string, SyncEngine>();
const starting = new Set<string>();

/** Access tokens and passwords come from main, which holds the secrets. */
const accessToken = (accountId: string) => expected(mainClient, 'main client').call<string>('accessToken', accountId);
const password = (accountId: string) => expected(mainClient, 'main client').call<string>('password', accountId);

async function providerFor(a: AccountConfig): Promise<{ provider: MailProvider; transport: MailTransport; extractText: (raw: Uint8Array) => Promise<string> }> {
  if (a.kind === 'imap') {
    const s = a.settings;
    const pass = await password(a.accountId);
    return {
      provider: new ImapProvider({ host: s.imap.host, port: s.imap.port, security: s.imap.security, user: s.user, password: pass, savesSent: s.savesSent, log }),
      transport: passwordTransport(s.smtp, s.user, pass),
      extractText,
    };
  }
  if (a.kind === 'gmail') {
    const token = () => accessToken(a.accountId);
    return { provider: new ImapProvider(gmailConfig(a.email, token, log)), transport: gmailTransport(a.email, token), extractText };
  }
  const p = new FakeProvider();
  seedDemo(p, a.seed ?? 40);
  if (!a.seed) {seedNewsletter(p);}
  // Like Gmail, the fake files what it sends in Sent by itself.
  const transport = new FakeTransport();
  const send = transport.send.bind(transport);
  transport.send = async (raw, envelope) => {
    await send(raw, envelope);
    const text = new TextDecoder().decode(raw);
    p.deliver({ subject: /^Subject: (.*)$/m.exec(text)?.[1]?.trim() ?? '', raw: text, labels: [String.raw`\Sent`], flags: [String.raw`\Seen`], from: { address: a.email } });
  };
  return { provider: p, transport, extractText };
}

async function startAccount(a: AccountConfig) {
  if (!data || engines.has(a.accountId) || starting.has(a.accountId)) {return;}
  if (a.kind !== 'fake' && a.status === 'needs-sign-in') {return;}
  starting.add(a.accountId);
  let made;
  try {
    made = await providerFor(a);
  } catch (error) {
    log(`${a.accountId}: ${errorMessage(error)}`);
    starting.delete(a.accountId);
    return;
  }
  const { provider, transport, extractText: extract } = made;
  const options: ConstructorParameters<typeof SyncEngine>[0] = { accountId: a.accountId, kind: a.kind, email: a.email, provider, transport, data, extractText: extract, log };
  if (a.kind !== 'fake' && a.identities) {options.identities = a.identities;}
  const engine = new SyncEngine(options);
  try {
    await engine.start();
    engines.set(a.accountId, engine);
    log(`${a.accountId}: syncing ${engine.primaryMailbox}`);
    await engine.syncOnce();
    log(`${a.accountId}: first sync done; watching for changes`);
    if (engines.get(a.accountId) === engine) {engine.startLive();}
  } catch (error) {
    log(`${a.accountId}: ${errorMessage(error)}`);
    engines.delete(a.accountId);
    await engine.stop().catch(() => {});
  } finally {
    starting.delete(a.accountId);
  }
}

async function reconcile() {
  if (!data || !mainClient || !wanted) {return;}
  const ids = new Set(wanted.map((a) => a.accountId));
  for (const [id, engine] of engines) {
    const w = wanted.find((a) => a.accountId === id);
    if (!w || (w.kind !== 'fake' && w.status === 'needs-sign-in')) {
      engines.delete(id);
      await engine.stop().catch(() => {});
      if (!w) {await data.removeAccount(id);}
    } else if (w.kind !== 'fake') {
      // Identities may have changed: the core keeps the list of my addresses current.
      await data.setIdentities(id, w.identities?.length ? w.identities : [w.email]);
    }
  }
  for (const a of wanted) {
    if (ids.has(a.accountId)) {
      void startAccount(a);
    }
  }
}

process.parentPort.on('message', (e) => {
  const msg: unknown = e.data;
  if (!isMessage(msg)) {return;}
  if (msg.type === 'poll') {return void engines.forEach((engine) => engine.pollNow());}
  if (msg.type === 'accounts') {wanted = msg.accounts;}
  else if (msg.type === 'data-port' && e.ports[0]) {
    dataClient = connect<SyncEvents>(mainPortChannel(e.ports[0]));
    data = proxy<DataPort>(dataClient, DATA_PORT_METHODS);
    const client = dataClient;
    client.on('fetch-body', (loc) => {
      engines.get(loc.accountId)?.fetchBodies(loc.mailbox, [loc.uid]).catch((error: unknown) => log(`body fetch failed: ${errorMessage(error)}`));
    });
    client.on('replay', (payload) => engines.get(payload.accountId)?.replaySoon());
    client.on('outbox', (payload) => engines.get(payload.accountId)?.outboxSoon());
    client.on('search-server', ({ id, query }) => {
      void Promise.all([...engines.values()].map((e) => e.searchServer(query).catch((error: unknown) => log(`server search failed: ${errorMessage(error)}`))))
        .then(() => client.call('serverSearchDone', id));
    });
    client.on('drafts', (payload) => engines.get(payload.accountId)?.draftsSoon());
  } else if (msg.type === 'main-port' && e.ports[0]) {mainClient = connect(mainPortChannel(e.ports[0]));}
  void reconcile();
});
