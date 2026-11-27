// Accounts and their sign-in state. Pure: storage, sign-in and the clock are injected.
import { expected } from '../../core/errors';
import { parseJson } from '../../core/json';
import { refreshGoogle, SignInRequiredError, signInWithGoogle, gmailAddress } from './google-oauth';
import type { Fetch, GoogleClient, TokenSet } from './google-oauth';
import { accountIdOf, settingsFrom } from './password-accounts';
import type { PasswordAccountInput, PasswordAccountSettings } from './password-accounts';

/** The stored sign-in, if what's in the secret store is one. */
function tokenSetFrom(raw: string): TokenSet | undefined {
  const v = parseJson(raw);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return undefined;
  }
  const { accessToken, refreshToken, expiresAt } = v;
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || typeof expiresAt !== 'number') {
    return undefined;
  }
  return { accessToken, refreshToken, expiresAt };
}

/** The stored password, if what's in the secret store holds one. */
function passwordFrom(raw: string): string | undefined {
  const v = parseJson(raw);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return undefined;
  }
  return typeof v.password === 'string' ? v.password : undefined;
}

export type AccountStatus = 'ok' | 'needs-sign-in';

/** A From name and address an Account can send as. It can differ from the login (iCloud: a custom domain). */
export interface Identity {
  name?: string;
  address: string;
}

type Common = {
  id: string;
  email: string;
  status: AccountStatus;
  /** The Identities this Account sends as, the default first. Absent means just the login address. */
  identities?: Array<Identity>;
};

export type AccountRecord =
  | (Common & { kind: 'gmail' })
  /** iCloud or another IMAP/SMTP server, signed in with a password. */
  | (Common & { kind: 'imap'; settings: PasswordAccountSettings });

/** An Account's Identities, the default first; the login address when none were set. */
export const identitiesOf = (a: AccountRecord): Array<Identity> => (a.identities?.length ? a.identities : [{ address: a.email }]);

const IDENTITY_ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** Where secrets live. In the app: safeStorage (Keychain). Values are opaque strings. */
export interface SecretStore {
  get(id: string): Promise<string | undefined>;
  set(id: string, value: string): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Where the non-secret Account list lives. In the app: a JSON file in userData. */
export interface AccountList {
  load(): Array<AccountRecord>;
  save(accounts: Array<AccountRecord>): void;
}

export interface AccountsOptions {
  secrets: SecretStore;
  list: AccountList;
  /** Loaded lazily, so a missing client file only matters when someone signs in. */
  googleClient: () => GoogleClient;
  openUrl: (url: string) => void | Promise<void>;
  fetch?: Fetch;
  now?: () => number;
  /** Refresh this long before expiry. */
  refreshMarginMs?: number;
}

export class Accounts {
  private accounts: Array<AccountRecord>;
  private tokens = new Map<string, TokenSet>();
  private refreshing = new Map<string, Promise<string>>();
  private listeners = new Set<(a: Array<AccountRecord>) => void>();
  private readonly now: () => number;
  private readonly margin: number;

  constructor(private readonly o: AccountsOptions) {
    this.accounts = o.list.load();
    this.now = o.now ?? Date.now;
    this.margin = o.refreshMarginMs ?? 5 * 60_000;
  }

  list(): Array<AccountRecord> {
    return this.accounts.map((a) => ({ ...a }));
  }

  onChange(fn: (a: Array<AccountRecord>) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private commit() {
    this.o.list.save(this.accounts);
    const snapshot = this.list();
    for (const fn of this.listeners) {
      fn(snapshot);
    }
  }

  /** Sign in to Gmail in the browser and add (or re-authorize) the Account. */
  async addGmail(loginHint?: string): Promise<AccountRecord> {
    const fetchFn = this.o.fetch ?? fetch;
    const tokens = await signInWithGoogle({ client: this.o.googleClient(), openUrl: this.o.openUrl, fetch: fetchFn, loginHint, now: this.now });
    const email = await gmailAddress(tokens.accessToken, fetchFn);
    const id = `gmail:${email.toLowerCase()}`;
    await this.o.secrets.set(id, JSON.stringify(tokens));
    this.tokens.set(id, tokens);
    const existing = this.accounts.find((a) => a.id === id);
    if (existing) {
      existing.status = 'ok';
    } else {
      this.accounts.push({ id, kind: 'gmail', email, status: 'ok' });
    }
    this.commit();
    return {
      ...expected(
        this.accounts.find((a) => a.id === id),
        'the Account just saved',
      ),
    };
  }

  /**
   * Add (or update) an iCloud or IMAP Account. The settings are checked, then `verify` tries them against the real
   * servers; only then is anything saved. Throws with a message for the person when something's wrong.
   */
  async addPassword(input: PasswordAccountInput, verify: (s: PasswordAccountSettings, password: string) => Promise<void>): Promise<AccountRecord> {
    const settings = settingsFrom(input);
    await verify(settings, input.password);
    const id = accountIdOf(settings);
    await this.o.secrets.set(id, JSON.stringify({ password: input.password }));
    const record: AccountRecord = { id, kind: 'imap', email: settings.email, status: 'ok', settings };
    const i = this.accounts.findIndex((a) => a.id === id);
    if (i >= 0) {
      this.accounts[i] = record;
    } else {
      this.accounts.push(record);
    }
    this.commit();
    return { ...record };
  }

  /** The password of an iCloud or IMAP Account. */
  async password(id: string): Promise<string> {
    const acct = this.accounts.find((a) => a.id === id);
    if (!acct) {
      throw new Error(`No Account ${id}`);
    }
    const raw = await this.o.secrets.get(id);
    if (!raw) {
      return this.markNeedsSignIn(acct, 'no stored password');
    }
    const password = passwordFrom(raw);
    if (password === undefined) {
      return this.markNeedsSignIn(acct, 'no stored password');
    }
    return password;
  }

  /**
   * Replace an Account's Identities; the first is the default. Addresses are checked, duplicates dropped, and at
   * least one must stay.
   */
  setIdentities(id: string, identities: Array<Identity>): AccountRecord {
    const acct = this.accounts.find((a) => a.id === id);
    if (!acct) {
      throw new Error(`No Account ${id}`);
    }
    const clean: Array<Identity> = [];
    for (const i of identities) {
      const address = i.address.trim();
      if (!IDENTITY_ADDRESS.test(address)) {
        throw new Error(`“${address || '(empty)'}” isn’t an email address.`);
      }
      if (clean.some((c) => c.address.toLowerCase() === address.toLowerCase())) {
        continue;
      }
      const name = i.name?.trim();
      clean.push(name ? { name, address } : { address });
    }
    if (!clean.length) {
      throw new Error('An Account needs at least one Identity to send from.');
    }
    acct.identities = clean;
    this.commit();
    return { ...acct };
  }

  async remove(id: string) {
    await this.o.secrets.delete(id);
    this.tokens.delete(id);
    this.accounts = this.accounts.filter((a) => a.id !== id);
    this.commit();
  }

  /** A valid access token, refreshed silently when it's close to expiring. */
  async accessToken(id: string): Promise<string> {
    const acct = this.accounts.find((a) => a.id === id);
    if (!acct) {
      throw new Error(`No Account ${id}`);
    }
    if (acct.status === 'needs-sign-in') {
      throw new SignInRequiredError(acct.email);
    }
    let t = this.tokens.get(id);
    if (!t) {
      const raw = await this.o.secrets.get(id);
      if (!raw) {
        return this.markNeedsSignIn(acct, 'no stored sign-in');
      }
      t = tokenSetFrom(raw);
      if (!t) {
        return this.markNeedsSignIn(acct, 'no stored sign-in');
      }
      this.tokens.set(id, t);
    }
    if (t.expiresAt - this.now() > this.margin) {
      return t.accessToken;
    }
    // One refresh at a time per Account; concurrent callers share it.
    let p = this.refreshing.get(id);
    if (!p) {
      p = this.refresh(acct, t).finally(() => this.refreshing.delete(id));
      this.refreshing.set(id, p);
    }
    return p;
  }

  private async refresh(acct: AccountRecord, t: TokenSet): Promise<string> {
    try {
      const fresh = await refreshGoogle(this.o.googleClient(), t.refreshToken, this.o.fetch ?? fetch, this.now());
      this.tokens.set(acct.id, fresh);
      await this.o.secrets.set(acct.id, JSON.stringify(fresh));
      return fresh.accessToken;
    } catch (error) {
      if (error instanceof SignInRequiredError) {
        return this.markNeedsSignIn(acct, error.message);
      }
      throw error;
    }
  }

  private markNeedsSignIn(acct: AccountRecord, why: string): never {
    acct.status = 'needs-sign-in';
    this.tokens.delete(acct.id);
    this.commit();
    throw new SignInRequiredError(`${acct.email}: ${why}`);
  }
}
