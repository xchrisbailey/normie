// Search (#80): the query language, and finding Threads at the core seam.
import { afterEach, describe, expect, it } from 'vitest';
import { createCore, type TestCore } from '../src/core/core';
import { FakeProvider, fakeExtractText } from '../src/core/fake-provider';
import { ftsQuery } from '../src/core/search-query';

describe('the search box', () => {
  it('turns words, phrases and operators into a safe FTS5 query', () => {
    expect(ftsQuery('lunch friday')).toBe('"lunch"* AND "friday"*');
    expect(ftsQuery('"quarterly budget"')).toBe('"quarterly budget"');
    expect(ftsQuery('from:ada subject:"design review"')).toBe('sender : "ada"* AND subject : "design review"');
    expect(ftsQuery('to:grace@example.com')).toBe('recipients : "grace@example.com"*');
    expect(ftsQuery('NEAR(a b) OR "x" AND')).toBe('"NEAR(a"* AND "b)"* AND "OR"* AND "x" AND "AND"*');
    expect(ftsQuery('at 10:30')).toBe('"at"* AND "10:30"*');
    expect(ftsQuery('   ')).toBeNull();
    expect(ftsQuery('"" ***')).toBeNull();
  });
});

const NOW = Date.UTC(2026, 10, 27, 12);
const HOUR = 3_600_000;
let core: TestCore | undefined;
afterEach(async () => {
  await core?.close();
  core = undefined;
});

async function mailbox() {
  const p = new FakeProvider();
  p.deliver({ subject: 'Quarterly budget', threadId: 't-budget', from: { name: 'Ada Lovelace', address: 'ada@example.com' }, text: 'Numbers for Q3 attached.', date: NOW - 5 * HOUR });
  p.deliver({ subject: 'Re: Quarterly budget', threadId: 't-budget', from: { name: 'Grace Hopper', address: 'grace@example.com' }, text: 'Looks fine to me.', date: NOW - 4 * HOUR });
  p.deliver({ subject: 'Lunch', threadId: 't-lunch', from: { name: 'Alan Turing', address: 'alan@example.com' }, to: [{ name: 'Grace', address: 'grace@example.com' }], text: 'Friday at noon? Bring the budget.', date: NOW - 2 * HOUR });
  p.deliver({ subject: 'Old archive', threadId: 't-old', from: { address: 'ada@example.com' }, labels: ['Archive'], text: 'From long ago, about budgets.', date: NOW - 50 * 24 * HOUR });
  core = await createCore({ provider: p, extractText: fakeExtractText, now: () => NOW });
  await core.engine.syncOnce();
  return core;
}
const subjects = async (c: TestCore, q: string) => (await c.search(q)).map((r) => r.subject);

describe('searching', () => {
  it('finds Threads by subject, people and body, newest first, in and out of the Inbox', async () => {
    const c = await mailbox();
    expect(await subjects(c, 'budget')).toEqual(['Lunch', 'Quarterly budget', 'Old archive']);
    expect(await subjects(c, 'noon')).toEqual(['Lunch']);
    expect(await subjects(c, 'grace')).toEqual(['Lunch', 'Quarterly budget']);
    expect(await subjects(c, 'nothing-like-this')).toEqual([]);
  });

  it('narrows with from:, to:, subject: and phrases', async () => {
    const c = await mailbox();
    expect(await subjects(c, 'from:ada')).toEqual(['Quarterly budget', 'Old archive']);
    expect(await subjects(c, 'to:grace')).toEqual(['Lunch']);
    expect(await subjects(c, 'subject:budget')).toEqual(['Quarterly budget']);
    expect(await subjects(c, '"looks fine"')).toEqual(['Quarterly budget']);
    expect(await subjects(c, '"fine looks"')).toEqual([]);
  });

  it('indexes mail stored before search existed, in the background', async () => {
    const c = await mailbox();
    // As if these were stored before the index: empty it, and mark everything as still to do.
    c.data.store.db.exec(`delete from search; update meta set value = (select max(id) + 1 from messages) where key = 'search_backfill_below'`);
    expect(await subjects(c, 'budget')).toEqual([]);
    while (c.data.store.indexSearchBatch(2));
    expect(await subjects(c, 'budget')).toEqual(['Lunch', 'Quarterly budget', 'Old archive']);
  });
});

describe('searching the server', () => {
  it('turns the search box into server terms', async () => {
    const { serverQuery } = await import('../src/core/search-query');
    expect(serverQuery('invoice from:acme "march 2024"')).toEqual({
      raw: 'invoice from:acme "march 2024"',
      terms: [{ text: 'invoice' }, { field: 'from', text: 'acme' }, { text: 'march 2024' }],
    });
    expect(serverQuery('  ')).toBeNull();
  });

  it('finds Gmail mail older than what is stored, and stores it as headers', async () => {
    const p = new FakeProvider();
    p.deliver({ subject: 'Tax return 2019', threadId: 't-tax', from: { address: 'accountant@example.com' }, text: 'Attached.', date: NOW - 2000 * 24 * HOUR });
    p.deliver({ subject: 'Lunch', threadId: 't-lunch', date: NOW - HOUR });
    core = await createCore({ provider: p, extractText: fakeExtractText, now: () => NOW });
    // Only the recent window so far; the old history hasn't been backfilled yet.
    await core.engine.syncHeaders();
    expect(await core.search('tax')).toEqual([]);
    const found = await core.searchServer('tax');
    expect(found.map((r) => r.subject)).toEqual(['Tax return 2019']);
    expect(p.calls.filter((c) => c === 'search')).toHaveLength(1);
    // Stored now: the next local search finds it without asking.
    expect((await core.search('tax')).map((r) => r.subject)).toEqual(['Tax return 2019']);
  });

  it('looks in folders a folder server keeps that Normie does not sync', async () => {
    const { ICLOUD_CAPS } = await import('../src/core/fake-provider');
    const p = new FakeProvider({ caps: ICLOUD_CAPS });
    p.addMailbox({ path: 'Receipts' });
    p.deliver({ subject: 'Your receipt', messageId: '<r@x>', from: { address: 'shop@example.com' }, text: 'Order 42', date: NOW - 24 * HOUR }, 'Receipts');
    core = await createCore({ provider: p, extractText: fakeExtractText, now: () => NOW, accountId: 'icloud:me' });
    await core.engine.syncOnce();
    expect(await core.search('receipt')).toEqual([]);
    expect((await core.searchServer('from:shop')).map((r) => r.subject)).toEqual(['Your receipt']);
  });
});
