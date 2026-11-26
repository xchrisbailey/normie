// PROTOTYPE, throw away. Google OAuth for a Desktop client: PKCE + loopback redirect.
// Tokens stay in memory and are never printed or written to disk.
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';

const b64url = (buf) => buf.toString('base64url');

export async function googleAccessToken(loginHint) {
  const file = `${homedir()}/.config/normie/google-oauth-client.json`;
  const { installed: c } = JSON.parse(readFileSync(file, 'utf8'));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));

  const { code, redirectUri } = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/') return res.writeHead(404).end();
      const err = url.searchParams.get('error');
      const ok = !err && url.searchParams.get('state') === state;
      res.writeHead(200, { 'content-type': 'text/plain' })
        .end(ok ? 'Signed in. You can close this tab and go back to the terminal.' : `Sign-in failed: ${err || 'state mismatch'}`);
      server.close();
      ok ? resolve({ code: url.searchParams.get('code'), redirectUri }) : reject(new Error(err || 'state mismatch'));
    });
    let redirectUri;
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}`;
      const auth = new URL(c.auth_uri);
      auth.search = new URLSearchParams({
        client_id: c.client_id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'https://mail.google.com/',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        login_hint: loginHint,
      });
      console.log('[oauth] opening the browser for Google sign-in...');
      execFile('open', [auth.toString()]);
    });
    setTimeout(() => { server.close(); reject(new Error('sign-in timed out after 3 minutes')); }, 180_000).unref();
  });

  const res = await fetch(c.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: c.client_id, client_secret: c.client_secret,
      redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier,
    }),
  });
  const tok = await res.json();
  if (!res.ok) throw new Error(`token exchange failed: ${tok.error} ${tok.error_description || ''}`);
  return {
    accessToken: tok.access_token,
    // What we learned about the token, without the token itself:
    info: {
      expiresInSec: tok.expires_in,
      gotRefreshToken: Boolean(tok.refresh_token),
      refreshTokenExpiresInSec: tok.refresh_token_expires_in ?? 'not set (no fixed expiry reported)',
      scope: tok.scope,
    },
  };
}
