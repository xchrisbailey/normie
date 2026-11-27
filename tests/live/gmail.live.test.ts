// Live contract test against the real Gmail Account. Opt-in, run by hand, never in CI:
//   GMAIL_USER=you@yourdomain npm run test:live
// It opens the browser for Google sign-in, then only reads, unless GMAIL_LIVE_WRITE=1 is set too: then it
// also marks the newest Inbox message Done and puts it straight back (#21). With GMAIL_LIVE_SEND=1 it sends one
// message to yourself over SMTP (#40).
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadGoogleClient, signInWithGoogle } from '../../src/main/auth/google-oauth';
import { extractText } from '../../src/sync/extract-text';
import { buildMime } from '../../src/core/compose';
import { newMessageId } from '../../src/core/ids';
import { gmailConfig, ImapProvider } from '../../src/sync/imap-provider';
import { gmailTransport } from '../../src/sync/smtp';

const user = process.env.GMAIL_USER;
const DAY = 86_400_000;

describe.skipIf(!user)('Gmail provider against the real server', () => {
  let p: ImapProvider;
  let allMail: string;
  let token: () => Promise<string>;

  beforeAll(async () => {
    const client = loadGoogleClient(process.env.NORMIE_GOOGLE_CLIENT ?? path.join(homedir(), '.config/normie/google-oauth-client.json'));
    const tokens = await signInWithGoogle({ client, loginHint: user, openUrl: (url) => void execFile('open', [url]) });
    token = async () => tokens.accessToken;
    p = new ImapProvider(gmailConfig(user!, token));
    await p.connect();
  }, 300_000);

  afterAll(async () => p?.close());

  it('reports the capabilities spike #2 found', () => {
    expect(p.caps).toMatchObject({ condstore: true, qresync: false, move: true, labels: true, serverThreads: true });
  });

  it('finds system mailboxes by flag and ignores look-alikes', async () => {
    const boxes = await p.listMailboxes();
    allMail = boxes.find((b) => b.role === 'all')!.path;
    expect(allMail).toBe('[Gmail]/All Mail');
    expect(boxes.find((b) => b.role === 'sent')?.path).toBe('[Gmail]/Sent Mail');
    for (const lookAlike of ['Sent Messages', 'Deleted Messages', '[Gmail]All Mail', '[Gmail]Trash']) {
      expect(boxes.find((x) => x.path === lookAlike)?.role, lookAlike).toBeUndefined();
    }
  });

  it('reads recent headers with thread ids, and the Inbox label from All Mail', async () => {
    const cs = await p.changes(allMail, null, { windowStart: Date.now() - 7 * DAY });
    expect(cs.reset).toBe(true);
    expect(cs.state.highestModseq).toBeDefined();
    expect(cs.headers.length).toBeGreaterThan(0);
    expect(cs.headers.every((h) => h.threadId && h.remoteId)).toBe(true);
    expect(cs.headers.some((h) => h.labels.includes('\\Inbox'))).toBe(true);
  });

  it('reports flag changes since a modseq with CHANGEDSINCE', async () => {
    const first = await p.changes(allMail, null, { windowStart: Date.now() - 2 * DAY });
    const again = await p.changes(allMail, first.state, { windowStart: Date.now() - 2 * DAY });
    expect(again.reset).toBe(false);
    expect(again.headers.length).toBeLessThanOrEqual(1);
  });

  it('lists older UIDs and downloads a body as text', async () => {
    const old = await p.uidsBefore(allMail, Date.now() - 90 * DAY);
    expect(old.length).toBeGreaterThan(0);
    const [raw] = await p.fetchBodies(allMail, [Math.max(...(await p.uids(allMail, { windowStart: Date.now() - 7 * DAY })))]);
    expect(raw).toBeDefined();
    expect((await extractText(raw!.raw)).length).toBeGreaterThan(0);
  });

  it.skipIf(process.env.GMAIL_LIVE_WRITE !== '1')('marks a message Done by removing the Inbox label, then puts it back', async () => {
    const recent = await p.changes(allMail, null, { windowStart: Date.now() - 7 * DAY });
    const target = recent.headers.filter((h) => h.labels.includes('\\Inbox')).sort((a, b) => b.date - a.date)[0];
    expect(target, 'an Inbox message from the last 7 days').toBeDefined();
    const labelsNow = async () => (await p.headers(allMail, [target!.uid]))[0]!.labels;
    try {
      await p.edit(allMail, [target!.uid], { removeLabels: ['\\Inbox'] });
      expect(await labelsNow()).not.toContain('\\Inbox');
    } finally {
      await p.edit(allMail, [target!.uid], { addLabels: ['\\Inbox'] });
    }
    expect(await labelsNow()).toContain('\\Inbox');
  });

  it.skipIf(process.env.GMAIL_LIVE_SEND !== '1')('sends a message to yourself over SMTP, and Gmail files it in Sent', async () => {
    const from = { address: user! };
    const messageId = newMessageId(from);
    const built = await buildMime({ accountId: 'live', from, to: [from], cc: [], bcc: [], subject: `Normie live test ${new Date().toISOString()}`, body: 'Sent by **Normie**’s live test. Safe to delete.' }, messageId);
    await gmailTransport(user!, token).send(built.raw, built.envelope);
    // Gmail files SMTP mail in Sent itself (savesSent), so it shows up in All Mail with the \Sent label.
    let found = false;
    for (let i = 0; i < 10 && !found; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const recent = await p.changes(allMail, null, { windowStart: Date.now() - DAY });
      found = recent.headers.some((h) => h.messageId === messageId && h.labels.includes('\\Sent'));
    }
    expect(found).toBe(true);
  }, 60_000);

  it('searches All Mail with Gmail search syntax (X-GM-RAW)', async () => {
    const hits = await p.search(allMail, { raw: 'newer_than:30d', terms: [{ text: 'newer_than:30d' }] });
    expect(hits.length).toBeGreaterThan(0);
    const none = await p.search(allMail, { raw: '"zq9x-no-such-phrase-normie"', terms: [{ text: 'zq9x-no-such-phrase-normie' }] });
    expect(none).toEqual([]);
  });

  it('holds an IDLE connection on INBOX and closes it cleanly', async () => {
    const ac = new AbortController();
    const it = p.watch('INBOX', ac.signal)[Symbol.asyncIterator]();
    const nextEvent = it.next();
    await new Promise((r) => setTimeout(r, 3000));
    ac.abort();
    const res = await nextEvent;
    expect(res.done).toBe(true);
  });
});
