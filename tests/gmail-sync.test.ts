// Gmail Inbox sync (#8), at the core seam over the fake provider, plus the IMAP provider's pure mapping.
import type { FetchMessageObject } from 'imapflow';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore } from '../src/core/core';
import type { TestCore } from '../src/core/core';
import { FakeProvider, fakeExtractText } from '../src/core/fake-provider';
import { headerOf, roleOf } from '../src/sync/imap-provider';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 26, 12);
let core: TestCore | undefined;
afterEach(async () => {
  await core?.close();
  core = undefined;
});
const start = async (p: FakeProvider) => (core = await createCore({ provider: p, extractText: fakeExtractText, now: () => NOW }));

describe('system mailboxes', () => {
  it('syncs the real All Mail, not look-alike folders', async () => {
    const p = new FakeProvider({
      mailboxes: [
        { path: 'INBOX', role: 'inbox' },
        { path: '[Gmail]All Mail' },
        { path: 'Sent Messages' },
        { path: '[Gmail]/All Mail', role: 'all' },
        { path: '[Gmail]/Sent Mail', role: 'sent' },
      ],
    });
    p.deliver({ subject: 'Real', date: NOW - DAY });
    const c = await start(p);
    expect(c.engine.primaryMailbox).toBe('[Gmail]/All Mail');
    await c.engine.syncOnce();
    expect((await c.rows('inbox')).map((r) => r.subject)).toEqual(['Real']);
  });

  it('trusts only special-use flags from servers that report them', () => {
    expect(roleOf({ path: '[Gmail]/Sent Mail', specialUse: String.raw`\Sent`, specialUseSource: 'extension' }, true)).toBe('sent');
    expect(roleOf({ path: 'Sent Messages', specialUse: String.raw`\Sent`, specialUseSource: 'name' }, true)).toBeUndefined();
    expect(roleOf({ path: 'Sent Messages', specialUse: String.raw`\Sent`, specialUseSource: 'name' }, false)).toBe('sent');
    expect(roleOf({ path: 'INBOX' }, true)).toBe('inbox');
    expect(roleOf({ path: 'Receipts' }, true)).toBeUndefined();
  });
});

describe('Gmail headers', () => {
  it('maps Gmail ids, thread ids and labels from an ImapFlow fetch', () => {
    const m = {
      seq: 1,
      uid: 42,
      emailId: '188295',
      threadId: '188290',
      labels: new Set([String.raw`\Inbox`, String.raw`\Important`]),
      flags: new Set([String.raw`\Seen`]),
      envelope: {
        date: new Date(NOW),
        subject: 'Hi',
        messageId: '<a@b>',
        from: [{ name: 'Ada', address: 'ada@example.com' }],
        to: [{ address: 'me@example.com' }],
      },
    } satisfies Partial<FetchMessageObject>;
    expect(headerOf(m, '[Gmail]/All Mail', true)).toMatchObject({
      uid: 42,
      remoteId: '188295',
      threadId: '188290',
      labels: [String.raw`\Inbox`, String.raw`\Important`],
      flags: [String.raw`\Seen`],
      subject: 'Hi',
      from: { name: 'Ada', address: 'ada@example.com' },
      to: [{ address: 'me@example.com' }],
      date: NOW,
    });
  });
});

describe('first sync', () => {
  it('fills the list from headers before any body arrives', async () => {
    const p = new FakeProvider();
    for (let i = 0; i < 1200; i++) {
      p.deliver({ subject: `m${i}`, date: NOW - i * 60_000, threadId: `t${i}` });
    }
    const c = await start(p);
    const order: Array<string> = [];
    c.onNotice(() => order.push(c.data.store.db.prepare('select count(*) from bodies').pluck().get() === 0 ? 'no-bodies' : 'bodies'));
    await c.engine.syncHeaders();
    expect(await c.rows('inbox')).toHaveLength(1200);
    expect(order.length).toBeGreaterThanOrEqual(3); // headers land in chunks of 500
    expect(order.every((o) => o === 'no-bodies')).toBe(true);
    await c.engine.syncBodies();
    expect((await c.rows('inbox'))[0]!.snippet).toBe('Body of m0');
  });

  it('keeps mail older than 90 days as headers only', async () => {
    const p = new FakeProvider();
    p.deliver({ subject: 'Recent', date: NOW - 10 * DAY });
    p.deliver({ subject: 'Ancient', date: NOW - 400 * DAY });
    const c = await start(p);
    await c.engine.syncOnce();
    const rows = c.data.store.db.prepare('select subject, has_body from messages order by date').all();
    expect(rows).toEqual([
      { subject: 'Ancient', has_body: 0 },
      { subject: 'Recent', has_body: 1 },
    ]);
    expect((await c.rows('inbox')).map((r) => r.subject)).toEqual(['Recent', 'Ancient']);
  });

  it('does not treat older, headers-only mail as deleted on the next sync', async () => {
    const p = new FakeProvider({ caps: { qresync: false } });
    p.deliver({ subject: 'Ancient', date: NOW - 400 * DAY });
    p.deliver({ subject: 'Recent', date: NOW - DAY });
    const c = await start(p);
    await c.engine.syncOnce();
    await c.engine.syncHeaders();
    expect((await c.rows('inbox')).map((r) => r.subject).sort()).toEqual(['Ancient', 'Recent']);
  });

  it('shows the Inbox label on Inbox messages read from All Mail', async () => {
    const p = new FakeProvider();
    p.deliver({ subject: 'Inbox one', labels: [String.raw`\Inbox`, String.raw`\Important`], date: NOW - DAY });
    p.deliver({ subject: 'Archived', labels: ['Receipts'], date: NOW - DAY });
    const c = await start(p);
    await c.engine.syncOnce();
    expect((await c.rows('inbox')).map((r) => r.subject)).toEqual(['Inbox one']);
    expect(c.data.store.db.prepare("select labels_json from messages where subject = 'Inbox one'").pluck().get()).toBe(String.raw`["\\Inbox","\\Important"]`);
  });
});
