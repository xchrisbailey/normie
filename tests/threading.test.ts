// Threads built locally on folder servers (#55), at the core seam over the iCloud-like fake.
import { afterEach, describe, expect, it } from 'vitest';
import { createCore } from '../src/core/core';
import type { TestCore } from '../src/core/core';
import { FakeProvider, fakeExtractText, ICLOUD_CAPS } from '../src/core/fake-provider';
import { referencesOf } from '../src/sync/imap-provider';

const NOW = Date.UTC(2026, 10, 27, 12);
const HOUR = 3_600_000;
const cores: Array<TestCore> = [];
afterEach(async () => {
  for (const c of cores.splice(0)) {await c.close();}
});

async function sync(p: FakeProvider, accountId = 'icloud:me@icloud.com@imap.mail.me.com') {
  const c = await createCore({ provider: p, extractText: fakeExtractText, now: () => NOW, accountId });
  cores.push(c);
  await c.engine.syncOnce();
  return c;
}
const threads = async (c: TestCore) => (await c.rows('inbox')).map((r) => [r.subject, r.count]);

describe('local threading', () => {
  it('puts a reply in its parent’s Thread', async () => {
    const p = new FakeProvider({ caps: ICLOUD_CAPS });
    p.deliver({ subject: 'Trip', messageId: '<a@x>', date: NOW - 3 * HOUR });
    p.deliver({ subject: 'Re: Trip', messageId: '<b@x>', inReplyTo: '<a@x>', references: ['<a@x>'], date: NOW - 2 * HOUR });
    p.deliver({ subject: 'Lunch', messageId: '<c@x>', date: NOW - HOUR });
    expect(await threads(await sync(p))).toEqual([['Lunch', 1], ['Trip', 2]]);
  });

  it('follows References when In-Reply-To is missing', async () => {
    const p = new FakeProvider({ caps: ICLOUD_CAPS });
    p.deliver({ subject: 'Trip', messageId: '<a@x>', date: NOW - 3 * HOUR });
    p.deliver({ subject: 'Re: Trip', messageId: '<c@x>', references: ['<a@x>', '<b@x>'], date: NOW - HOUR });
    expect(await threads(await sync(p))).toEqual([['Trip', 2]]);
  });

  it('joins a parent that arrives after its reply', async () => {
    const p = new FakeProvider({ caps: ICLOUD_CAPS });
    p.deliver({ subject: 'Re: Trip', messageId: '<b@x>', inReplyTo: '<a@x>', references: ['<a@x>'], date: NOW - HOUR });
    const c = await sync(p);
    expect(await threads(c)).toEqual([['Re: Trip', 1]]);
    p.deliver({ subject: 'Trip', messageId: '<a@x>', date: NOW - 2 * HOUR });
    await c.engine.syncOnce();
    expect(await threads(c)).toEqual([['Trip', 2]]);
  });

  it('merges two Threads when a message links them', async () => {
    const p = new FakeProvider({ caps: ICLOUD_CAPS });
    p.deliver({ subject: 'Plan', messageId: '<a@x>', date: NOW - 4 * HOUR });
    // C answers B, which isn't here yet; so C starts a Thread named after B.
    p.deliver({ subject: 'Re: Re: Plan', messageId: '<c@x>', inReplyTo: '<b@x>', date: NOW - 2 * HOUR });
    const c = await sync(p);
    expect(await threads(c)).toHaveLength(2);
    // B answers A: it links the two.
    p.deliver({ subject: 'Re: Plan', messageId: '<b@x>', inReplyTo: '<a@x>', date: NOW - 3 * HOUR });
    await c.engine.syncOnce();
    expect(await threads(c)).toEqual([['Plan', 3]]);
  });

  it('gives a message with no known relatives its own Thread', async () => {
    const p = new FakeProvider({ caps: ICLOUD_CAPS });
    p.deliver({ subject: 'One', messageId: '<a@x>', date: NOW - 2 * HOUR });
    p.deliver({ subject: 'Two', messageId: '<b@x>', inReplyTo: '<gone@x>', date: NOW - HOUR });
    expect(await threads(await sync(p))).toEqual([['Two', 1], ['One', 1]]);
  });

  it('never joins Threads across Accounts, even for the same Message-ID', async () => {
    const p = new FakeProvider({ caps: ICLOUD_CAPS });
    p.deliver({ subject: 'Trip', messageId: '<a@x>', date: NOW - 2 * HOUR });
    const c = await sync(p);
    // A second Account in the same store gets a reply to the same message.
    c.data.upsertAccount('imap:two', 'imap', 'two@example.com');
    c.data.setMailboxes('imap:two', [{ path: 'INBOX', role: 'inbox' }]);
    c.data.applyChanges('imap:two', 'INBOX', { headers: [{
      uid: 1, remoteId: 'INBOX:1', messageId: '<b@x>', inReplyTo: '<a@x>', references: ['<a@x>'], subject: 'Re: Trip',
      to: [], date: NOW - HOUR, flags: [], labels: ['INBOX'],
    }] });
    const rows = await c.rows('inbox');
    expect(rows.map((r) => [r.subject, r.count, r.accountId])).toEqual([
      ['Re: Trip', 1, 'imap:two'], ['Trip', 1, 'icloud:me@icloud.com@imap.mail.me.com'],
    ]);
  });
});

describe('References header', () => {
  it('reads every id, oldest first, across folded lines', () => {
    expect(referencesOf('References: <a@x>\r\n <b@x>\r\n\t<c@x>\r\n\r\n')).toEqual(['<a@x>', '<b@x>', '<c@x>']);
    expect(referencesOf(undefined)).toEqual([]);
    expect(referencesOf('Subject: x\r\n\r\n')).toEqual([]);
  });
});
