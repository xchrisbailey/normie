// PROTOTYPE, throw away. Reads iCloud capabilities, then sends ONE test message
// to yourself and checks whether iCloud files it in Sent by itself.
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { capabilityReport, mailboxReport, mailboxState, print, need } from './report.js';

const user = need('ICLOUD_USER');
const pass = need('ICLOUD_APP_PASSWORD');
const fromAddr = process.env.ICLOUD_FROM || user;

const client = new ImapFlow({
  host: 'imap.mail.me.com', port: 993, secure: true, auth: { user, pass }, qresync: true, logger: false,
});
await client.connect();
print('iCloud IMAP capabilities', capabilityReport(client));
const boxes = await client.list();
print('iCloud mailboxes', await mailboxReport(client));
const sent = boxes.find((b) => b.specialUse === '\\Sent') || boxes.find((b) => /^sent/i.test(b.path));
print('iCloud INBOX state', mailboxState(await client.mailboxOpen('INBOX', { readOnly: true })));
if (!sent) { print('iCloud Sent check', { error: 'no Sent mailbox found' }); process.exit(1); }

const token = `normie-spike-${Date.now()}`;
const smtp = nodemailer.createTransport({
  host: 'smtp.mail.me.com', port: 587, secure: false, requireTLS: true, auth: { user, pass },
});
await smtp.sendMail({
  from: fromAddr, to: fromAddr, subject: `Normie spike test ${token}`,
  text: 'Throwaway message from the Normie IMAP spike. Safe to delete.',
});
console.log(`\n[icloud] sent test message "${token}", watching "${sent.path}" for 45 s...`);

let foundInSent = false, foundInInbox = false;
for (let i = 0; i < 9 && !(foundInSent && foundInInbox); i++) {
  await new Promise((r) => setTimeout(r, 5000));
  await client.mailboxOpen(sent.path, { readOnly: true });
  foundInSent ||= (await client.search({ subject: token }, { uid: true })).length > 0;
  await client.mailboxOpen('INBOX', { readOnly: true });
  foundInInbox ||= (await client.search({ subject: token }, { uid: true })).length > 0;
}
print('iCloud Sent check', {
  sentMailbox: sent.path, foundInSent, foundInInbox,
  verdict: foundInSent ? 'iCloud saves SMTP mail to Sent itself: do NOT IMAP APPEND' : 'iCloud did not save it: Normie must IMAP APPEND to Sent',
});
await client.logout();
