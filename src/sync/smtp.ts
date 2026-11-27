// SMTP over Nodemailer. Gmail: smtp.gmail.com with XOAUTH2, a fresh access token per send.
import nodemailer from 'nodemailer';
import { errorMessage } from '../core/errors';
import { ServerRejectedError } from '../core/types';
import type { MailTransport } from '../core/types';

const isErrorLike = (e: unknown): e is Error => typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string';

/** A 5xx reply means the server said no to this message; anything else (4xx, network) is worth retrying. */
function classify(e: unknown): Error {
  const code = typeof e === 'object' && e !== null && 'responseCode' in e && typeof e.responseCode === 'number' ? e.responseCode : undefined;
  if (code && code >= 500 && code < 600) {
    return new ServerRejectedError(errorMessage(e));
  }
  return isErrorLike(e) ? e : new Error(errorMessage(e));
}

export function gmailTransport(user: string, accessToken: () => Promise<string>): MailTransport {
  return {
    async send(raw, envelope) {
      const t = nodemailer.createTransport({
        host: 'smtp.gmail.com', port: 465, secure: true,
        auth: { type: 'OAuth2', user, accessToken: await accessToken() },
        connectionTimeout: 20_000, socketTimeout: 60_000,
      });
      try {
        await t.sendMail({ envelope, raw: Buffer.from(raw) });
      } catch (error) {
        throw classify(error);
      } finally {
        t.close();
      }
    },
  };
}

/** SMTP with a password (iCloud, other servers). */
export function passwordTransport(server: { host: string; port: number; security: 'tls' | 'starttls' | 'none' }, user: string, pass: string): MailTransport {
  return {
    async send(raw, envelope) {
      const t = nodemailer.createTransport({
        host: server.host, port: server.port, secure: server.security === 'tls', requireTLS: server.security === 'starttls',
        auth: { user, pass }, connectionTimeout: 20_000, socketTimeout: 60_000,
      });
      try {
        await t.sendMail({ envelope, raw: Buffer.from(raw) });
      } catch (error) {
        throw classify(error);
      } finally {
        t.close();
      }
    },
  };
}
