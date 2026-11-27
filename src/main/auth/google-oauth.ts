// Google OAuth for a Desktop client: PKCE in the system browser with a loopback redirect (spike #2).
// Pure Node: the browser opener and fetch are injected, so tests drive the whole flow.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { parseJson } from '../../core/json';

export const GMAIL_SCOPE = 'https://mail.google.com/';

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
  authUri: string;
  tokenUri: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** ms since epoch */
  expiresAt: number;
}

export type Fetch = typeof fetch;

/** The refresh token was revoked or expired: the user has to sign in again. */
export class SignInRequiredError extends Error {
  constructor(detail: string) {
    super(`Sign-in required: ${detail}`);
    this.name = 'SignInRequiredError';
  }
}

/** Reads the Desktop client JSON downloaded from Google Cloud. It lives outside the repo. */
export function loadGoogleClient(path: string): GoogleClient {
  const json = parseJson(readFileSync(path, 'utf8'));
  const c = typeof json === 'object' && json !== null && !Array.isArray(json) ? json.installed : undefined;
  if (
    typeof c !== 'object' ||
    c === null ||
    Array.isArray(c) ||
    typeof c.client_id !== 'string' ||
    !c.client_id ||
    typeof c.client_secret !== 'string' ||
    !c.client_secret
  ) {
    throw new Error(`${path} is not a Google Desktop OAuth client`);
  }
  return {
    clientId: c.client_id,
    clientSecret: c.client_secret,
    authUri: typeof c.auth_uri === 'string' ? c.auth_uri : 'https://accounts.google.com/o/oauth2/auth',
    tokenUri: typeof c.token_uri === 'string' ? c.token_uri : 'https://oauth2.googleapis.com/token',
  };
}

const b64url = (b: Buffer) => b.toString('base64url');
export const challengeOf = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** The fields of Google's token reply that are there and the right type. */
function tokenResponseOf(v: unknown): TokenResponse {
  const tok: TokenResponse = {};
  if (typeof v !== 'object' || v === null) {
    return tok;
  }
  if ('access_token' in v && typeof v.access_token === 'string') {
    tok.access_token = v.access_token;
  }
  if ('refresh_token' in v && typeof v.refresh_token === 'string') {
    tok.refresh_token = v.refresh_token;
  }
  if ('expires_in' in v && typeof v.expires_in === 'number') {
    tok.expires_in = v.expires_in;
  }
  if ('error' in v && typeof v.error === 'string') {
    tok.error = v.error;
  }
  if ('error_description' in v && typeof v.error_description === 'string') {
    tok.error_description = v.error_description;
  }
  return tok;
}

async function tokenRequest(client: GoogleClient, body: Record<string, string>, fetchFn: Fetch, now: number) {
  const res = await fetchFn(client.tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...body }),
  });
  const tok = tokenResponseOf(await res.json());
  if (!res.ok || !tok.access_token) {
    if (tok.error === 'invalid_grant') {
      throw new SignInRequiredError(tok.error_description ?? 'refresh token no longer valid');
    }
    throw new Error(`Google token request failed: ${tok.error ?? res.status}`);
  }
  return { accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: now + (tok.expires_in ?? 3600) * 1000 };
}

export interface SignInOptions {
  client: GoogleClient;
  openUrl: (url: string) => void | Promise<void>;
  fetch?: Fetch;
  loginHint?: string;
  timeoutMs?: number;
  now?: () => number;
}

/** Runs the browser sign-in. Resolves with tokens once the user approves. */
export async function signInWithGoogle(o: SignInOptions): Promise<TokenSet> {
  const fetchFn = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const verifier = b64url(randomBytes(48));
  const state = b64url(randomBytes(16));

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    let redirectUri = '';
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Google sign-in timed out'));
    }, o.timeoutMs ?? 300_000);
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/') {
        return void res.writeHead(404).end();
      }
      const err = url.searchParams.get('error');
      const gotCode = url.searchParams.get('code');
      const ok = !err && gotCode && url.searchParams.get('state') === state;
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          `<!doctype html><meta charset="utf-8"><title>Normie</title><body style="font:15px system-ui;padding:3em">${
            ok ? 'Signed in to Normie. You can close this tab.' : 'Sign-in did not complete. You can close this tab and try again from Normie.'
          }</body>`,
        );
      clearTimeout(timer);
      server.close();
      if (ok) {
        resolve({ code: gotCode, redirectUri });
      } else {
        reject(new Error(err ? `Google sign-in failed: ${err}` : 'Google sign-in returned an unexpected response'));
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      redirectUri = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      const auth = new URL(o.client.authUri);
      const params = new URLSearchParams({
        client_id: o.client.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GMAIL_SCOPE,
        code_challenge: challengeOf(verifier),
        code_challenge_method: 'S256',
        state,
        access_type: 'offline',
        prompt: 'consent',
      });
      if (o.loginHint) {
        params.set('login_hint', o.loginHint);
      }
      auth.search = params.toString();
      const open = async () => {
        try {
          await o.openUrl(auth.toString());
        } catch (error) {
          clearTimeout(timer);
          server.close();
          reject(error);
        }
      };
      void open();
    });
  });

  const t = await tokenRequest(o.client, { code, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }, fetchFn, now());
  if (!t.refreshToken) {
    throw new Error('Google did not return a refresh token');
  }
  return { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt };
}

/** Swap a refresh token for a fresh access token. Throws SignInRequiredError when it's been revoked. */
export async function refreshGoogle(client: GoogleClient, refreshToken: string, fetchFn: Fetch = fetch, now = Date.now()): Promise<TokenSet> {
  const t = await tokenRequest(client, { refresh_token: refreshToken, grant_type: 'refresh_token' }, fetchFn, now);
  return { accessToken: t.accessToken, refreshToken: t.refreshToken ?? refreshToken, expiresAt: t.expiresAt };
}

/** The signed-in Gmail address, from the Gmail API profile (covered by the mail scope). */
export async function gmailAddress(accessToken: string, fetchFn: Fetch = fetch): Promise<string> {
  const res = await fetchFn('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new Error(`Could not read the Gmail address (${res.status})`);
  }
  const profile: unknown = await res.json();
  if (typeof profile !== 'object' || profile === null || !('emailAddress' in profile) || typeof profile.emailAddress !== 'string') {
    throw new Error('Could not read the Gmail address (no address in the reply)');
  }
  return profile.emailAddress;
}
