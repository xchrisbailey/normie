// Gmail sign-in: the browser and Google's endpoints are faked; the loopback server is real.
import { describe, expect, it } from 'vitest';
import { Accounts } from '../src/main/auth/accounts';
import type { AccountList, AccountRecord, SecretStore } from '../src/main/auth/accounts';
import { challengeOf, SignInRequiredError } from '../src/main/auth/google-oauth';
import type { Fetch, GoogleClient } from '../src/main/auth/google-oauth';

const CLIENT: GoogleClient = { clientId: 'cid', clientSecret: 'csecret', authUri: 'https://accounts.example/auth', tokenUri: 'https://oauth.example/token' };

class MemSecrets implements SecretStore {
  m = new Map<string, string>();
  async get(id: string) {
    return this.m.get(id);
  }
  async set(id: string, v: string) {
    this.m.set(id, v);
  }
  async delete(id: string) {
    this.m.delete(id);
  }
}
class MemList implements AccountList {
  saved: Array<AccountRecord> = [];
  load() {
    return structuredClone(this.saved);
  }
  save(a: Array<AccountRecord>) {
    this.saved = structuredClone(a);
  }
}

/** A fake Google: issues codes, checks PKCE, hands out and refreshes tokens. */
function fakeGoogle() {
  const g = { challenge: '', issued: 0, refreshes: 0, revoked: false, lastTokenBody: undefined as URLSearchParams | undefined, realFetch: fetch };
  const fetchFn: Fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('http://127.0.0.1')) {
      return g.realFetch(input, init);
    }
    if (url === CLIENT.tokenUri) {
      const body = new URLSearchParams(String(init!.body));
      g.lastTokenBody = body;
      if (body.get('grant_type') === 'authorization_code') {
        if (challengeOf(body.get('code_verifier')!) !== g.challenge) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        g.issued++;
        return Response.json({ access_token: `at-${g.issued}`, refresh_token: 'rt-1', expires_in: 3600 });
      }
      if (g.revoked) {
        return Response.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 });
      }
      g.refreshes++;
      return Response.json({ access_token: `at-refreshed-${g.refreshes}`, expires_in: 3600 });
    }
    if (url.endsWith('/users/me/profile')) {
      return Response.json({ emailAddress: 'Chris@Example.com' });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  /** Plays the user approving in the browser: follows the redirect with a code. */
  const openUrl = async (authUrl: string) => {
    const u = new URL(authUrl);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toBe('https://mail.google.com/');
    g.challenge = u.searchParams.get('code_challenge')!;
    const redirect = new URL(u.searchParams.get('redirect_uri')!);
    expect(redirect.hostname).toBe('127.0.0.1');
    redirect.search = new URLSearchParams({ code: 'the-code', state: u.searchParams.get('state')! }).toString();
    await g.realFetch(redirect);
  };
  return { g, fetchFn, openUrl };
}

function setup(now = { t: 1_000_000 }) {
  const { g, fetchFn, openUrl } = fakeGoogle();
  const secrets = new MemSecrets();
  const list = new MemList();
  const make = () => new Accounts({ secrets, list, googleClient: () => CLIENT, openUrl, fetch: fetchFn, now: () => now.t });
  return { g, secrets, list, make, now };
}

describe('Gmail sign-in', () => {
  it('signs in through the browser with PKCE and records the Account', async () => {
    const { make, secrets, list, g } = setup();
    const accounts = make();
    const changes: Array<Array<AccountRecord>> = [];
    accounts.onChange((a) => changes.push(a));
    const acct = await accounts.addGmail();
    expect(acct).toEqual({ id: 'gmail:chris@example.com', kind: 'gmail', email: 'Chris@Example.com', status: 'ok' });
    expect(g.lastTokenBody?.get('code')).toBe('the-code');
    expect(list.saved).toHaveLength(1);
    expect(changes.at(-1)?.[0]?.status).toBe('ok');
    // The list holds no secrets; the secret store holds the tokens.
    expect(JSON.stringify(list.saved)).not.toContain('rt-1');
    expect(secrets.m.get(acct.id)).toContain('rt-1');
  });

  it('stays signed in after a restart without opening the browser', async () => {
    const { make, g } = setup();
    await make().addGmail();
    const afterRestart = make();
    expect(afterRestart.list()[0]?.status).toBe('ok');
    expect(await afterRestart.accessToken('gmail:chris@example.com')).toBe('at-1');
    expect(g.issued).toBe(1);
  });

  it('refreshes silently shortly before the token expires, once for concurrent callers', async () => {
    const { make, g, now } = setup();
    const accounts = make();
    const { id } = await accounts.addGmail();
    expect(await accounts.accessToken(id)).toBe('at-1');
    now.t += 56 * 60_000; // within the 5-minute margin of the 60-minute token
    const [a, b] = await Promise.all([accounts.accessToken(id), accounts.accessToken(id)]);
    expect([a, b]).toEqual(['at-refreshed-1', 'at-refreshed-1']);
    expect(g.refreshes).toBe(1);
    expect(await accounts.accessToken(id)).toBe('at-refreshed-1');
  });

  it('marks the Account as needing sign-in when Google revokes it, and signing in again fixes it', async () => {
    const { make, g, now, list } = setup();
    const accounts = make();
    const { id } = await accounts.addGmail();
    g.revoked = true;
    now.t += 2 * 3_600_000;
    await expect(accounts.accessToken(id)).rejects.toBeInstanceOf(SignInRequiredError);
    expect(list.saved[0]?.status).toBe('needs-sign-in');
    await expect(accounts.accessToken(id)).rejects.toBeInstanceOf(SignInRequiredError);
    g.revoked = false;
    await accounts.addGmail();
    expect(accounts.list()).toHaveLength(1);
    expect(accounts.list()[0]?.status).toBe('ok');
    expect(await accounts.accessToken(id)).toBe('at-2');
  });

  it('rejects a redirect whose state does not match', async () => {
    const { g, fetchFn } = fakeGoogle();
    const accounts = new Accounts({
      secrets: new MemSecrets(),
      list: new MemList(),
      googleClient: () => CLIENT,
      fetch: fetchFn,
      openUrl: async (authUrl) => {
        const redirect = new URL(new URL(authUrl).searchParams.get('redirect_uri')!);
        redirect.search = 'code=x&state=forged';
        await g.realFetch(redirect);
      },
    });
    await expect(accounts.addGmail()).rejects.toThrow(/unexpected response/);
  });

  it('removes an Account and its secrets', async () => {
    const { make, secrets } = setup();
    const accounts = make();
    const { id } = await accounts.addGmail();
    await accounts.remove(id);
    expect(accounts.list()).toEqual([]);
    expect(secrets.m.has(id)).toBe(false);
  });
});
