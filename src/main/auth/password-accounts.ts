// iCloud and generic IMAP/SMTP Accounts: their settings, checks before saving, and plain explanations of failures.
// Pure; the real connection test is injected (see verify.ts).

export type Security = 'tls' | 'starttls' | 'none';

export interface ServerSettings {
  host: string;
  port: number;
  security: Security;
}

export interface PasswordAccountSettings {
  provider: 'icloud' | 'imap';
  /** The address mail is sent from by default. */
  email: string;
  /** The login; the email address unless the server wants something else. */
  user: string;
  imap: ServerSettings;
  smtp: ServerSettings;
  /** The server files sent mail in Sent itself (iCloud and most IMAP servers don't). */
  savesSent: boolean;
}

/** What the add-Account form sends. */
export interface PasswordAccountInput {
  provider: 'icloud' | 'imap';
  email: string;
  user?: string;
  password: string;
  imap?: Partial<ServerSettings>;
  smtp?: Partial<ServerSettings>;
  savesSent?: boolean;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ICLOUD_LOGIN = /@(icloud|me|mac)\.com$/i;

/** Measured in spike #2: iCloud IMAP on 993 (TLS), SMTP on 587 (STARTTLS), login must be the @icloud.com address. */
export const ICLOUD = { imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' }, smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' } } as const;

export class AccountSetupError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
  }
}

/** Settings from the form, checked. Throws AccountSetupError with a message for the person, and the field to fix. */
export function settingsFrom(input: PasswordAccountInput): PasswordAccountSettings {
  const email = input.email.trim();
  if (!EMAIL.test(email)) throw new AccountSetupError('That doesn’t look like an email address.', 'email');
  if (!input.password) throw new AccountSetupError('Enter the password.', 'password');
  if (input.provider === 'icloud') {
    if (!ICLOUD_LOGIN.test(email)) {
      throw new AccountSetupError(
        'iCloud needs your @icloud.com address to sign in, even if your Apple ID uses another domain. Sign in with it here; you can send from your own domain once the Account is added (as an Identity).',
        'email',
      );
    }
    return { provider: 'icloud', email, user: email, imap: { ...ICLOUD.imap }, smtp: { ...ICLOUD.smtp }, savesSent: false };
  }
  const server = (s: Partial<ServerSettings> | undefined, kind: 'IMAP' | 'SMTP', field: string, defaults: { port: number; security: Security }): ServerSettings => {
    const host = (s?.host ?? '').trim().toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$|^localhost$/.test(host)) throw new AccountSetupError(`Enter the ${kind} server, such as ${kind === 'IMAP' ? 'imap' : 'smtp'}.example.com.`, `${field}.host`);
    const port = Number(s?.port ?? defaults.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AccountSetupError(`The ${kind} port is a number from 1 to 65535.`, `${field}.port`);
    const security = s?.security ?? defaults.security;
    if (security === 'none' && host !== 'localhost') {
      throw new AccountSetupError(`Normie won’t send your password unencrypted. Use TLS or STARTTLS for ${kind}.`, `${field}.security`);
    }
    return { host, port, security };
  };
  return {
    provider: 'imap', email, user: (input.user ?? '').trim() || email,
    imap: server(input.imap, 'IMAP', 'imap', { port: 993, security: 'tls' }),
    smtp: server(input.smtp, 'SMTP', 'smtp', { port: 587, security: 'starttls' }),
    savesSent: !!input.savesSent,
  };
}

/** A connection-test failure in words. `stage` says which server failed. */
export function explainFailure(settings: PasswordAccountSettings, stage: 'imap' | 'smtp', err: unknown): string {
  const e = err as { code?: string; authenticationFailed?: boolean; responseCode?: number; message?: string };
  const server = stage === 'imap' ? settings.imap : settings.smtp;
  const which = `${stage.toUpperCase()} (${server.host}:${server.port})`;
  const auth = e.authenticationFailed || e.code === 'EAUTH' || e.responseCode === 535 || /auth|credentials|password|login/i.test(e.message ?? '');
  if (auth) {
    return settings.provider === 'icloud'
      ? `iCloud didn’t accept the sign-in. Use an app-specific password from account.apple.com (not your Apple ID password), with your @icloud.com address.`
      : `${which} didn’t accept the username or password.`;
  }
  if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return `Couldn’t find ${server.host}. Check the ${stage.toUpperCase()} server name, or your connection.`;
  if (e.code === 'ECONNREFUSED') return `${which} refused the connection. Check the port.`;
  if (e.code === 'ETIMEDOUT' || e.code === 'ETIMEOUT' || e.code === 'ECONNRESET') return `${which} didn’t answer. Check the port and security setting, or your connection.`;
  if (/certificate|self.signed|CERT_/i.test(`${e.code} ${e.message}`)) return `${which}’s certificate isn’t trusted, so Normie won’t connect.`;
  if (/wrong version number|ssl|tls/i.test(e.message ?? '')) return `${which}: the security setting doesn’t match the server. Try ${server.security === 'tls' ? 'STARTTLS' : 'TLS'}.`;
  return `${which}: ${e.message ?? 'the connection failed'}.`;
}

export const accountIdOf = (s: PasswordAccountSettings) => `${s.provider}:${s.user.toLowerCase()}@${s.imap.host}`;
