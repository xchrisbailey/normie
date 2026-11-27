// New-mail notifications (#62): what the core reports as news, and what the renderer notifies about.
import { afterEach, describe, expect, it } from 'vitest';
import { createCore } from '../src/core/core';
import type { TestCore } from '../src/core/core';
import { FakeProvider, fakeExtractText } from '../src/core/fake-provider';
import type { CoreNotice, ThreadRow } from '../src/core/types';
import { NOTIFY_QUIET_MS, toNotify } from '../src/renderer/notify';
import { builtInSplits, splitsFrom } from '../src/renderer/splits';

const NOW = Date.UTC(2026, 10, 27, 12);
const DAY = 86_400_000;
let core: TestCore | undefined;
afterEach(async () => {
  await core?.close();
  core = undefined;
});

async function start(p: FakeProvider) {
  core = await createCore({ provider: p, extractText: fakeExtractText, now: () => NOW, email: 'me@example.com' });
  await core.engine.syncOnce();
  return core;
}
const arrivals = (c: TestCore) => c.notices.filter((n): n is Extract<CoreNotice, { type: 'arrived' }> => n.type === 'arrived').flatMap((n) => n.keys);

describe('news from the core', () => {
  it('is quiet on the first sync, then reports a Thread that gets new mail, once', async () => {
    const p = new FakeProvider();
    p.deliver({ subject: 'Old', threadId: 't-old', date: NOW - DAY });
    const c = await start(p);
    expect(arrivals(c)).toEqual([]);
    p.deliver({ subject: 'Lunch?', threadId: 't-lunch', date: NOW });
    p.deliver({ subject: 'Re: Lunch?', threadId: 't-lunch', date: NOW });
    await c.engine.syncOnce();
    const key = (await c.rows('inbox')).find((r) => r.subject === 'Lunch?')!.key;
    expect(arrivals(c)).toEqual([key]);
  });

  it("ignores my own mail, mail that isn't in the Inbox, muted Threads and old history", async () => {
    const p = new FakeProvider();
    p.deliver({ subject: 'Muted', threadId: 't-muted', date: NOW - DAY });
    const c = await start(p);
    await c.act((await c.rows('inbox'))[0]!.key, { type: 'mute', on: true });
    c.notices.length = 0;
    p.deliver({ subject: 'Mine', threadId: 't-mine', from: { address: 'me@example.com' }, date: NOW });
    p.deliver({ subject: 'Archived', threadId: 't-arch', labels: ['Receipts'], date: NOW });
    p.deliver({ subject: 'Re: Muted', threadId: 't-muted', date: NOW });
    p.deliver({ subject: 'Ancient', threadId: 't-ancient', date: NOW - 400 * DAY });
    await c.engine.syncOnce();
    expect(arrivals(c)).toEqual([]);
  });
});

const row = (key: string, over: Partial<ThreadRow['tags']> = {}): ThreadRow => ({
  key,
  accountId: 'a',
  subject: `Subject ${key}`,
  from: `From ${key}`,
  date: NOW,
  snippet: '',
  unread: true,
  starred: false,
  count: 1,
  tags: { newsletter: false, vip: false, known: false, ...over },
});

describe('what notifies', () => {
  const rows = [row('known', { known: true }), row('stranger'), row('news', { known: true, newsletter: true })];

  it('only Threads in a notifying Split (Important by default)', () => {
    expect(toNotify(['known', 'stranger', 'news', 'gone'], rows, builtInSplits([]), new Map(), NOW)).toEqual([
      { key: 'known', title: 'From known', body: 'Subject known' },
    ]);
  });

  it('follows splits.json', () => {
    const { splits } = splitsFrom(
      [
        { id: 'important', notify: false },
        { id: 'other', notify: true },
      ],
      [],
    );
    expect(toNotify(['known', 'stranger'], rows, splits, new Map(), NOW).map((n) => n.key)).toEqual(['stranger']);
  });

  it('once per Thread in a burst', () => {
    const recent = new Map<string, number>();
    const splits = builtInSplits([]);
    expect(toNotify(['known'], rows, splits, recent, NOW)).toHaveLength(1);
    expect(toNotify(['known'], rows, splits, recent, NOW + 60_000)).toHaveLength(0);
    expect(toNotify(['known'], rows, splits, recent, NOW + NOTIFY_QUIET_MS)).toHaveLength(1);
  });
});
