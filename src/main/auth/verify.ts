// Checking a password Account's settings against the real servers before saving it: an IMAP login, then SMTP.
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { explainFailure, type PasswordAccountSettings } from './password-accounts';

export class VerifyError extends Error {}

export async function verifyPasswordAccount(s: PasswordAccountSettings, password: string): Promise<void> {
  const imap = new ImapFlow({
    host: s.imap.host, port: s.imap.port, secure: s.imap.security === 'tls', doSTARTTLS: s.imap.security === 'starttls' ? true : undefined,
    auth: { user: s.user, pass: password }, logger: false, connectionTimeout: 20_000, greetingTimeout: 15_000,
  });
  imap.on('error', () => {});
  try {
    await imap.connect();
  } catch (e) {
    throw new VerifyError(explainFailure(s, 'imap', e));
  } finally {
    await imap.logout().catch(() => imap.close());
  }
  const smtp = nodemailer.createTransport({
    host: s.smtp.host, port: s.smtp.port, secure: s.smtp.security === 'tls', requireTLS: s.smtp.security === 'starttls',
    auth: { user: s.user, pass: password }, connectionTimeout: 20_000,
  });
  try {
    await smtp.verify();
  } catch (e) {
    throw new VerifyError(explainFailure(s, 'smtp', e));
  } finally {
    smtp.close();
  }
}
