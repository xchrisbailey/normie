// Live contract test against the real Gmail Account. Opt-in, run by hand, never in CI:
//   GMAIL_USER=you@yourdomain npm run test:live
// It opens the browser for Google sign-in, then only reads.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadGoogleClient, signInWithGoogle } from '../../src/main/auth/google-oauth';
import { extractText } from '../../src/sync/extract-text';
import { gmailConfig, ImapProvider } from '../../src/sync/imap-provider';

const user = process.env.GMAIL_USER;
const DAY = 86_400_000;

describe.skipIf(!user)('Gmail provider against the real server', () => {
  let p: ImapProvider;
  let allMail: string;

  beforeAll(async () => {
    const client = loadGoogleClient(process.env.NORMIE_GOOGLE_CLIENT ?? path.join(homedir(), '.config/normie/google-oauth-client.json'));
    const tokens = await signInWithGoogle({ client, loginHint: user, openUrl: (url) => void execFile('open', [url]) });
    p = new ImapProvider(gmailConfig(user!, async () => tokens.accessToken));
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
      const b = boxes.find((x) => x.path === lookAlike);
      if (b) expect(b.role, lookAlike).toBeUndefined();
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
});
