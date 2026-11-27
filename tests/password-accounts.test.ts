// iCloud and IMAP Accounts (#54): settings, checks, error wording, saving, removal.
import { describe, expect, it } from 'vitest';
import { Accounts } from '../src/main/auth/accounts';
import type { AccountList, AccountRecord, SecretStore } from '../src/main/auth/accounts';
import type { AccountSetupError} from '../src/main/auth/password-accounts';
import { explainFailure, settingsFrom } from '../src/main/auth/password-accounts';

class MemSecrets implements SecretStore {
  m = new Map<string, string>();
  async get(id: string) { return this.m.get(id); }
  async set(id: string, v: string) { this.m.set(id, v); }
  async delete(id: string) { this.m.delete(id); }
}
class MemList implements AccountList {
  saved: Array<AccountRecord> = [];
  load() { return this.saved; }
  save(a: Array<AccountRecord>) { this.saved = JSON.parse(JSON.stringify(a)); }
}
const setup = () => {
  const secrets = new MemSecrets();
  const list = new MemList();
  const accounts = new Accounts({ secrets, list, googleClient: () => { throw new Error('no Google here'); }, openUrl: () => {} });
  return { secrets, list, accounts };
};
const fieldOf = (f: () => unknown) => {
  try {
    f();
  } catch (error) {
    return [(error as AccountSetupError).field, (error as Error).message];
  }
  return undefined;
};

describe('iCloud settings', () => {
  it('uses the servers spike #2 measured', () => {
    expect(settingsFrom({ provider: 'icloud', email: 'chris@icloud.com', password: 'abcd-efgh-ijkl-mnop' })).toEqual({
      provider: 'icloud', email: 'chris@icloud.com', user: 'chris@icloud.com', savesSent: false,
      imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' }, smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    });
  });

  it('explains that the login must be the @icloud.com address', () => {
    const [field, message] = fieldOf(() => settingsFrom({ provider: 'icloud', email: 'chris@srcery.example', password: 'x' }))!;
    expect(field).toBe('email');
    expect(message).toMatch(/@icloud\.com address to sign in, even if your Apple ID uses another domain/);
  });

  it('says to use an app-specific password when iCloud refuses the sign-in', () => {
    const s = settingsFrom({ provider: 'icloud', email: 'chris@icloud.com', password: 'x' });
    expect(explainFailure(s, 'imap', Object.assign(new Error('Command failed'), { authenticationFailed: true }))).toMatch(/app-specific password/);
  });
});

describe('IMAP settings', () => {
  const base = { provider: 'imap' as const, email: 'me@example.com', password: 'pw', imap: { host: 'imap.example.com' }, smtp: { host: 'smtp.example.com' } };

  it('fills in the usual ports and security, and the login', () => {
    expect(settingsFrom(base)).toMatchObject({ user: 'me@example.com', imap: { port: 993, security: 'tls' }, smtp: { port: 587, security: 'starttls' }, savesSent: false });
  });

  it('points at the field to fix', () => {
    expect(fieldOf(() => settingsFrom({ ...base, email: 'nope' }))![0]).toBe('email');
    expect(fieldOf(() => settingsFrom({ ...base, password: '' }))![0]).toBe('password');
    expect(fieldOf(() => settingsFrom({ ...base, imap: { host: 'not a host' } }))![0]).toBe('imap.host');
    expect(fieldOf(() => settingsFrom({ ...base, smtp: { host: 'smtp.example.com', port: 70_000 } }))![0]).toBe('smtp.port');
    expect(fieldOf(() => settingsFrom({ ...base, imap: { host: 'imap.example.com', security: 'none' } }))).toEqual(['imap.security', expect.stringMatching(/unencrypted/)]);
  });

  it('says which server failed and why', () => {
    const s = settingsFrom(base);
    expect(explainFailure(s, 'smtp', Object.assign(new Error('Invalid login'), { code: 'EAUTH' }))).toBe('SMTP (smtp.example.com:587) didn’t accept the username or password.');
    expect(explainFailure(s, 'imap', Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toMatch(/Couldn’t find imap\.example\.com/);
    expect(explainFailure(s, 'imap', Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toMatch(/refused the connection/);
    expect(explainFailure(s, 'imap', new Error('self-signed certificate in chain'))).toMatch(/certificate isn’t trusted/);
    expect(explainFailure(s, 'smtp', new Error('wrong version number'))).toMatch(/Try TLS/);
  });
});

describe('adding and removing a password Account', () => {
  it('saves nothing when the servers refuse it', async () => {
    const { accounts, secrets, list } = setup();
    await expect(accounts.addPassword({ provider: 'icloud', email: 'me@icloud.com', password: 'bad' }, async () => { throw new Error('iCloud didn’t accept the sign-in'); }))
      .rejects.toThrow(/didn’t accept/);
    expect(list.saved).toEqual([]);
    expect(secrets.m.size).toBe(0);
  });

  it('keeps the password secret, gives it to sync, and forgets it on removal', async () => {
    const { accounts, secrets, list } = setup();
    let checked: string | undefined;
    const a = await accounts.addPassword({ provider: 'icloud', email: 'me@icloud.com', password: 'abcd-efgh-ijkl-mnop' }, async (_s, pw) => void (checked = pw));
    expect(checked).toBe('abcd-efgh-ijkl-mnop');
    expect(a).toMatchObject({ id: 'icloud:me@icloud.com@imap.mail.me.com', kind: 'imap', email: 'me@icloud.com', status: 'ok' });
    expect(JSON.stringify(list.saved)).not.toContain('abcd-efgh');
    expect(await accounts.password(a.id)).toBe('abcd-efgh-ijkl-mnop');
    await accounts.remove(a.id);
    expect(list.saved).toEqual([]);
    expect(secrets.m.size).toBe(0);
  });
});

describe('Identities', () => {
  it('are the login address until set, then the list given, default first, checked and without duplicates', async () => {
    const { accounts, list } = setup();
    const { identitiesOf } = await import('../src/main/auth/accounts');
    const a = await accounts.addPassword({ provider: 'icloud', email: 'me@icloud.com', password: 'pw' }, async () => {});
    expect(identitiesOf(a)).toEqual([{ address: 'me@icloud.com' }]);
    accounts.setIdentities(a.id, [{ name: 'Chris', address: 'chris@srcery.example' }, { address: 'me@icloud.com' }, { address: 'CHRIS@srcery.example' }]);
    expect(list.saved[0]!.identities).toEqual([{ name: 'Chris', address: 'chris@srcery.example' }, { address: 'me@icloud.com' }]);
    expect(() => accounts.setIdentities(a.id, [{ address: 'nope' }])).toThrow(/isn’t an email address/);
    expect(() => accounts.setIdentities(a.id, [])).toThrow(/at least one/);
  });
});
