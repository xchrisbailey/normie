// PROTOTYPE, throw away. Read-only against Gmail (Workspace) over OAuth.
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { googleAccessToken } from './oauth.js';
import { capabilityReport, mailboxReport, mailboxState, print, need } from './report.js';

const user = need('GMAIL_USER');
const { accessToken, info } = await googleAccessToken(user);
print('Gmail OAuth token (no secrets shown)', info);

const client = new ImapFlow({
  host: 'imap.gmail.com', port: 993, secure: true,
  auth: { user, accessToken }, qresync: true, logger: false,
});
await client.connect();
print('Gmail IMAP capabilities', capabilityReport(client));
print('Gmail mailboxes', await mailboxReport(client));

const inbox = await client.mailboxOpen('INBOX', { readOnly: true });
print('Gmail INBOX state', mailboxState(inbox));

const recent = [];
const from = Math.max(1, inbox.exists - 4);
if (inbox.exists) {
  for await (const m of client.fetch(`${from}:*`, { uid: true, envelope: true, flags: true, threadId: true, labels: true, emailId: true })) {
    recent.push({
      uid: m.uid, emailId: m.emailId, threadId: m.threadId,
      labels: [...(m.labels || [])], flags: [...(m.flags || [])],
      subjectLength: (m.envelope?.subject || '').length, // lengths only: keep your mail out of the log
    });
  }
}
print('Gmail last 5 INBOX messages (ids, labels, flags; subjects redacted)', recent);

if (inbox.highestModseq !== undefined && inbox.exists) {
  let changed = 0;
  for await (const _ of client.fetch('1:*', { uid: true, flags: true }, { changedSince: inbox.highestModseq - 50n })) changed++;
  print('Gmail CHANGEDSINCE (last 50 modseqs)', { worked: true, changedMessages: changed });
}
await client.logout();

const smtp = nodemailer.createTransport({
  host: 'smtp.gmail.com', port: 465, secure: true, auth: { type: 'OAuth2', user, accessToken },
});
try { await smtp.verify(); print('Gmail SMTP over OAuth', { verified: true }); }
catch (e) { print('Gmail SMTP over OAuth', { verified: false, error: e.message }); }
