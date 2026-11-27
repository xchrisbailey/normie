// SMTP over Nodemailer. Gmail: smtp.gmail.com with XOAUTH2, a fresh access token per send.
import nodemailer from 'nodemailer';
import { ServerRejectedError, type MailTransport } from '../core/types';

/** A 5xx reply means the server said no to this message; anything else (4xx, network) is worth retrying. */
function classify(e: unknown): Error {
  const err = e as Error & { responseCode?: number };
  return err.responseCode && err.responseCode >= 500 && err.responseCode < 600 ? new ServerRejectedError(err.message) : err;
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
      } catch (e) {
        throw classify(e);
      } finally {
        t.close();
      }
    },
  };
}
