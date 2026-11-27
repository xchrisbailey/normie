// Folder servers sync Sent, Archive and Trash too (#56). At the core seam over the iCloud-like fake.
import { afterEach, describe, expect, it } from 'vitest';
import { createCore } from '../src/core/core';
import type { TestCore } from '../src/core/core';
import { FakeProvider, fakeExtractText, ICLOUD_CAPS } from '../src/core/fake-provider';

const NOW = Date.UTC(2026, 10, 27, 12);
const HOUR = 3_600_000;
let core: TestCore | undefined;
afterEach(async () => {
  await core?.close();
  core = undefined;
});
const start = async (p: FakeProvider) => {
  core = await createCore({ provider: p, extractText: fakeExtractText, now: () => NOW, accountId: 'icloud:me', pollMs: 60_000, debounceMs: 1 });
  await core.engine.syncOnce();
  return core;
};
const rows = async (c: TestCore) => (await c.rows('inbox')).map((r) => [r.subject, r.count]);

describe('folder servers', () => {
  it('sync Inbox, Sent, Archive and Trash, and no other folder', async () => {
    const p = new FakeProvider({ caps: ICLOUD_CAPS });
    p.addMailbox({ path: 'Receipts' });
    const c = await start(p);
    expect(c.engine.syncedMailboxes).toEqual(['INBOX', 'Sent Messages', 'Archive', 'Deleted Messages']);
  });

  it('show my reply from Sent in the Thread with the Inbox message', async () => {
    const p = new FakeProvider({ caps: ICLOUD_CAPS });
    p.deliver({ subject: 'Trip', messageId: '<a@x>', date: NOW - 2 * HOUR }, 'INBOX');
    p.deliver({ subject: 'Re: Trip', messageId: '<b@x>', inReplyTo: '<a@x>', from: { address: 'me@icloud.com' }, date: NOW - HOUR }, 'Sent Messages');
    p.deliver({ subject: 'Old news', messageId: '<c@x>', date: NOW - 3 * HOUR }, 'Archive');
    const c = await start(p);
    expect(await rows(c)).toEqual([['Trip', 2]]);
    const [row] = await c.rows('inbox');
    expect((await c.thread(row!.key)).map((m) => m.subject)).toEqual(['Trip', 'Re: Trip']);
  });

  it('keep a Thread in the Inbox only while one of its messages is in the Inbox mailbox', async () => {
    const p = new FakeProvider({ caps: ICLOUD_CAPS });
    const uid = p.deliver({ subject: 'Trip', messageId: '<a@x>', date: NOW - 2 * HOUR }, 'INBOX');
    p.deliver({ subject: 'Re: Trip', messageId: '<b@x>', inReplyTo: '<a@x>', date: NOW - HOUR }, 'Sent Messages');
    const c = await start(p);
    expect(await rows(c)).toEqual([['Trip', 2]]);
    // Archived on my phone: gone from INBOX, now in Archive.
    p.expunge(uid, 'INBOX');
    p.deliver({ subject: 'Trip', messageId: '<a@x>', date: NOW - 2 * HOUR }, 'Archive');
    await c.engine.syncOnce();
    expect(await rows(c)).toEqual([]);
  });

  it('notice deletions in each mailbox', async () => {
    const p = new FakeProvider({ caps: ICLOUD_CAPS });
    p.deliver({ subject: 'Trip', messageId: '<a@x>', date: NOW - 2 * HOUR }, 'INBOX');
    const sent = p.deliver({ subject: 'Re: Trip', messageId: '<b@x>', inReplyTo: '<a@x>', date: NOW - HOUR }, 'Sent Messages');
    const c = await start(p);
    p.expunge(sent, 'Sent Messages');
    await c.engine.syncOnce();
    expect(await rows(c)).toEqual([['Trip', 1]]);
  });

  it('pick up a reply sent from my phone on the next poll, with IDLE on the Inbox', async () => {
    const p = new FakeProvider({ caps: ICLOUD_CAPS });
    p.deliver({ subject: 'Trip', messageId: '<a@x>', date: NOW - 2 * HOUR }, 'INBOX');
    const c = await start(p);
    c.engine.startLive();
    p.deliver({ subject: 'Re: Trip', messageId: '<b@x>', inReplyTo: '<a@x>', date: NOW - HOUR }, 'Sent Messages');
    const pass = c.engine.nextPass();
    c.engine.pollNow();
    await pass;
    expect(await rows(c)).toEqual([['Trip', 2]]);
  });
});
