// Splits (#60): the rules over tagged rows, and the tags the core gives them.
import { afterEach, describe, expect, it } from 'vitest';
import { createCore } from '../src/core/core';
import type { TestCore } from '../src/core/core';
import { FakeProvider, fakeExtractText } from '../src/core/fake-provider';
import type { ThreadRow } from '../src/core/types';
import { builtInSplits, splitCounts, splitsFrom } from '../src/renderer/splits';
import { isListMail } from '../src/sync/imap-provider';

const NOW = Date.UTC(2026, 10, 27, 12);
const HOUR = 3_600_000;
const me = { address: 'me@example.com' };
let core: TestCore | undefined;
afterEach(async () => {
  await core?.close();
  core = undefined;
});

const inSplits = (rows: Array<ThreadRow>, subject: string) => {
  const r = rows.find((x) => x.subject === subject)!;
  return builtInSplits([])
    .filter((s) => s.match(r))
    .map((s) => s.id);
};

async function inbox() {
  const p = new FakeProvider();
  p.deliver({ subject: 'Hi from Ada', threadId: 't-ada', from: { address: 'ada@example.com' }, date: NOW - 5 * HOUR });
  p.deliver({
    subject: 'Re: Hi from Ada',
    threadId: 't-ada',
    from: me,
    to: [{ address: 'ada@example.com' }],
    date: NOW - 4 * HOUR,
    labels: [String.raw`\Sent`],
  });
  p.deliver({ subject: 'Weekly digest', threadId: 't-news', from: { address: 'news@example.com' }, list: true, date: NOW - 3 * HOUR });
  p.deliver({ subject: 'Who is this', threadId: 't-stranger', from: { address: 'stranger@example.com' }, date: NOW - 2 * HOUR });
  p.deliver({ subject: 'Boss newsletter', threadId: 't-boss', from: { address: 'boss@example.com' }, list: true, date: NOW - HOUR });
  core = await createCore({ provider: p, extractText: fakeExtractText, now: () => NOW, email: 'me@example.com' });
  await core.engine.syncOnce();
  return core;
}

describe('Splits', () => {
  it('put people I have written to in Important, lists in Newsletters, and the rest in Other', async () => {
    const c = await inbox();
    const rows = await c.rows('inbox');
    // I replied last in Ada's Thread; it's still Ada's.
    expect(rows.find((r) => r.subject === 'Hi from Ada')!.tags!.sender).toBe('ada@example.com');
    expect(inSplits(rows, 'Hi from Ada')).toEqual(['inbox', 'important']);
    expect(inSplits(rows, 'Weekly digest')).toEqual(['inbox', 'newsletters']);
    expect(inSplits(rows, 'Who is this')).toEqual(['inbox', 'other']);
  });

  it("show a VIP's newsletter in both VIP and Newsletters, and a VIP's mail in Important", async () => {
    const c = await inbox();
    await c.setVip('Boss@Example.com', true);
    await c.setVip('stranger@example.com', true);
    const rows = await c.rows('inbox');
    expect(inSplits(rows, 'Boss newsletter')).toEqual(['inbox', 'newsletters', 'vip']);
    expect(inSplits(rows, 'Who is this')).toEqual(['inbox', 'important', 'vip']);
    await c.setVip('stranger@example.com', false);
    expect(inSplits(await c.rows('inbox'), 'Who is this')).toEqual(['inbox', 'other']);
  });

  it('count each Split, and add one per Account when there are several', async () => {
    const c = await inbox();
    const rows = await c.rows('inbox');
    expect(Object.fromEntries(splitCounts(builtInSplits([]), rows))).toEqual({ inbox: 4, important: 1, other: 1, newsletters: 2, vip: 0, snoozed: 0 });
    const two = builtInSplits([
      { id: 'gmail:me@example.com', name: 'Work' },
      { id: 'icloud:me', name: 'Home' },
    ]);
    expect(two.map((s) => s.name)).toEqual(['Inbox', 'Important', 'Other', 'Newsletters', 'VIP', 'Work', 'Home', 'Snoozed']);
    expect(splitCounts(two, rows).get('account:gmail:me@example.com')).toBe(4);
  });

  it('read list headers', () => {
    expect(isListMail('List-Unsubscribe: <mailto:x@y>\r\n')).toBe(true);
    expect(isListMail('Subject: x\r\nList-Id: Foo <foo.example.com>\r\n')).toBe(true);
    expect(isListMail('Precedence: bulk\r\n')).toBe(true);
    expect(isListMail('Precedence: first-class\r\nSubject: hi\r\n')).toBe(false);
    expect(isListMail(undefined)).toBe(false);
  });

  it('tag mail stored before list headers were fetched, from the stored message', async () => {
    const p = new FakeProvider();
    p.deliver({
      subject: 'Old digest',
      from: { address: 'old@news.example' },
      date: NOW - HOUR,
      raw: 'Subject: Old digest\r\nList-Unsubscribe: <https://x>\r\n\r\nHi',
    });
    core = await createCore({ provider: p, extractText: fakeExtractText, now: () => NOW });
    await core.engine.syncOnce();
    // As if it had been stored before this version: unknown.
    core.data.store.db.prepare('update messages set is_list = null').run();
    core.data.store.db.prepare('update threads set is_list = 0').run();
    expect((await core.rows('inbox'))[0]!.tags!.newsletter).toBe(false);
    while (core.data.backfillListFlags(10)) {
      // Each call does one batch; it returns false once there's nothing left.
    }
    expect((await core.rows('inbox'))[0]!.tags!.newsletter).toBe(true);
  });
});

const row = (over: Omit<Partial<ThreadRow>, 'tags'> & { tags?: Partial<NonNullable<ThreadRow['tags']>> } = {}): ThreadRow => ({
  key: 'k',
  accountId: 'gmail:work@acme.com',
  subject: 's',
  from: 'f',
  date: 0,
  snippet: '',
  unread: false,
  starred: false,
  count: 1,
  ...over,
  tags: { newsletter: false, vip: false, known: false, ...over.tags },
});

describe('splits.json', () => {
  const accounts = [
    { id: 'gmail:work@acme.com', name: 'work@acme.com' },
    { id: 'icloud:me', name: 'me@icloud.com' },
  ];

  it('keeps the built-ins when there is no file', () => {
    const { splits, problems } = splitsFrom(undefined, accounts);
    expect(problems).toEqual([]);
    expect(splits.map((s) => s.id)).toEqual([
      'inbox',
      'important',
      'other',
      'newsletters',
      'vip',
      'account:gmail:work@acme.com',
      'account:icloud:me',
      'snoozed',
    ]);
    expect(splits.filter((s) => s.notify).map((s) => s.id)).toEqual(['important']);
  });

  it('orders, renames and hides built-ins, places the Account tabs, and always starts with Inbox', () => {
    const { splits } = splitsFrom([{ id: 'newsletters', name: 'Reading' }, { id: 'accounts' }, { id: 'important', notify: false }], accounts);
    expect(splits.map((s) => s.name)).toEqual(['Inbox', 'Reading', 'work@acme.com', 'me@icloud.com', 'Important', 'Snoozed']);
    expect(splits.some((s) => s.notify)).toBe(false);
  });

  it('matches my own Splits on every rule given', () => {
    const { splits, problems } = splitsFrom(
      [
        { id: 'acme', name: 'Acme', from: ['@acme.com', 'boss@elsewhere.com'], newsletter: false, notify: true },
        { id: 'home', name: 'Home', account: 'me@icloud.com' },
        { id: 'clients', name: 'Clients', label: 'Clients' },
        { id: 'vips', name: 'VIP lists', vip: true, newsletter: true },
      ],
      accounts,
    );
    expect(problems).toEqual([]);
    const by = (id: string) => splits.find((s) => s.id === id)!;
    expect(by('acme').match(row({ tags: { sender: 'ana@acme.com' } }))).toBe(true);
    expect(by('acme').match(row({ tags: { sender: 'boss@elsewhere.com' } }))).toBe(true);
    expect(by('acme').match(row({ tags: { sender: 'ana@acme.com', newsletter: true } }))).toBe(false);
    expect(by('acme').match(row({ tags: { sender: 'x@notacme.com' } }))).toBe(false);
    expect(by('acme').notify).toBe(true);
    expect(by('home').match(row({ accountId: 'icloud:me' }))).toBe(true);
    expect(by('home').match(row())).toBe(false);
    expect(by('clients').match(row({ tags: { labels: ['clients'] } }))).toBe(true);
    expect(by('vips').match(row({ tags: { vip: true, newsletter: true } }))).toBe(true);
    expect(by('vips').match(row({ tags: { vip: true } }))).toBe(false);
  });

  it('reports problems and skips just those entries', () => {
    const { splits, problems } = splitsFrom(
      [
        { id: 'Bad Id' },
        { id: 'nameless', from: '@x.com' },
        { id: 'vip', from: '@x.com' },
        { id: 'vip' },
        { id: 'who', name: 'Who', account: 'nobody@nowhere' },
        { id: 'odd', name: 'Odd', colour: 'red' },
        'nope',
      ],
      accounts,
    );
    // Bad id, nameless, rules on a built-in, unknown Account, unknown setting, not an object. A broken Split is left out.
    expect(problems).toHaveLength(6);
    expect(splits.map((s) => s.id)).toEqual(['inbox', 'vip', 'odd', 'snoozed']);
    expect(splitsFrom([{ id: 'vip' }, { id: 'vip' }], accounts).problems).toEqual(['"vip" is listed twice; the first one is kept.']);
    expect(splitsFrom({ not: 'a list' }, accounts).problems).toHaveLength(1);
  });
});

const snoozableRow = (key: string, snoozedUntil?: number): ThreadRow => {
  const row: ThreadRow = {
    key,
    accountId: 'a',
    subject: key,
    from: 'f',
    date: 0,
    snippet: '',
    unread: false,
    starred: false,
    count: 1,
    tags: { newsletter: false, vip: false, known: true },
  };
  if (snoozedUntil && row.tags) {
    row.tags.snoozedUntil = snoozedUntil;
  }
  return row;
};

describe('the Snoozed tab', () => {
  it('holds snoozed Threads, always last, and every other tab leaves them out', () => {
    const r = snoozableRow;
    const rows = [r('awake'), r('asleep', 123)];
    const { splits } = splitsFrom([{ id: 'important' }], []);
    expect(splits.at(-1)!.id).toBe('snoozed');
    expect(Object.fromEntries(splitCounts(splits, rows))).toEqual({ inbox: 1, important: 1, snoozed: 1 });
  });
});
