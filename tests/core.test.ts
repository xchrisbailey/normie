// Tests at the core's command and query seam, over the fake MailProvider.
import { afterEach, describe, expect, it } from 'vitest';
import { createCore } from '../src/core/core';
import type { TestCore } from '../src/core/core';
import { FakeProvider, fakeExtractText, seedDemo } from '../src/core/fake-provider';

const NOW = Date.UTC(2026, 10, 26, 12);
const HOUR = 3_600_000;
let core: TestCore | undefined;

async function start(provider: FakeProvider) {
  core = await createCore({ provider, extractText: fakeExtractText, now: () => NOW });
  return core;
}

afterEach(async () => {
  await core?.close();
  core = undefined;
});

describe('Inbox Split', () => {
  it('lists seeded Inbox messages as Threads, newest first', async () => {
    const p = new FakeProvider();
    p.deliver({ subject: 'Older', date: NOW - 2 * HOUR });
    p.deliver({ subject: 'Newer', date: NOW - HOUR, from: { name: 'Ada', address: 'ada@example.com' } });
    const c = await start(p);
    await c.engine.syncOnce();
    const rows = await c.rows('inbox');
    expect(rows.map((r) => r.subject)).toEqual(['Newer', 'Older']);
    expect(rows[0]).toMatchObject({ from: 'Ada', unread: true, count: 1 });
  });

  it('leaves out messages that are not in the Inbox', async () => {
    const p = new FakeProvider();
    p.deliver({ subject: 'Done already', labels: [], date: NOW - HOUR });
    p.deliver({ subject: 'Still here', date: NOW - HOUR });
    const c = await start(p);
    await c.engine.syncOnce();
    expect((await c.rows('inbox')).map((r) => r.subject)).toEqual(['Still here']);
  });

  it('groups messages that share a server thread id into one Thread', async () => {
    const p = new FakeProvider();
    p.deliver({ subject: 'Trip', threadId: 'trip', date: NOW - 3 * HOUR, flags: [String.raw`\Seen`] });
    p.deliver({ subject: 'Re: Trip', threadId: 'trip', date: NOW - HOUR, from: { name: 'Grace', address: 'g@example.com' } });
    const c = await start(p);
    await c.engine.syncOnce();
    const rows = await c.rows('inbox');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject: 'Trip', from: 'Grace', count: 2, unread: true });
  });

  it('notifies the renderer when the Inbox Split changes', async () => {
    const p = new FakeProvider();
    p.deliver({ subject: 'Hello', date: NOW - HOUR });
    const c = await start(p);
    await c.engine.syncOnce();
    expect(c.notices).toContainEqual({ type: 'rows-changed', split: 'inbox' });
  });
});

describe('Accounts in the store', () => {
  it('drops local mail for Accounts that are no longer signed in, and keeps the rest', async () => {
    const provider = new FakeProvider();
    seedDemo(provider, 4, NOW);
    const c = await start(provider);
    await c.engine.syncOnce();
    const before = await c.rows('inbox');
    expect(before.length).toBeGreaterThan(0);
    c.data.upsertAccount('gone', 'fake', 'old@example.com');
    const notices: Array<unknown> = [];
    c.onNotice((n) => notices.push(n));

    expect(c.data.pruneAccounts(['gmail:me@example.com', 'never-synced'])).toEqual(['gone']);
    expect(await c.rows('inbox')).toEqual(before);

    expect(c.data.pruneAccounts([])).toEqual(['gmail:me@example.com']);
    expect(await c.rows('inbox')).toEqual([]);
    expect(notices).toContainEqual({ type: 'rows-changed', split: 'inbox' });
  });
});

describe('Unified Inbox', () => {
  it('interleaves Accounts by date, keeps their Threads apart, and acts on each row’s own Account', async () => {
    const provider = new FakeProvider();
    provider.deliver({ subject: 'Work', threadId: 't-1', date: NOW - 3 * HOUR });
    provider.deliver({ subject: 'Work again', threadId: 't-3', date: NOW - HOUR });
    const c = await start(provider);
    await c.engine.syncOnce();
    // A second Account in the same store, with a message sharing a thread id.
    c.data.upsertAccount('icloud:me', 'imap', 'me@icloud.com');
    c.data.setMailboxes('icloud:me', [{ path: 'INBOX', role: 'inbox' }]);
    c.data.applyChanges('icloud:me', 'INBOX', {
      headers: [
        { uid: 1, remoteId: 'INBOX:1', threadId: 't-1', messageId: '<p@x>', subject: 'Personal', to: [], date: NOW - 2 * HOUR, flags: [], labels: ['INBOX'] },
      ],
    });
    const rows = await c.rows('inbox');
    expect(rows.map((r) => [r.subject, r.accountId])).toEqual([
      ['Work again', 'gmail:me@example.com'],
      ['Personal', 'icloud:me'],
      ['Work', 'gmail:me@example.com'],
    ]);
    await c.act(rows[1]!.key, { type: 'star', on: true });
    expect(c.data.pendingChanges('icloud:me')).toMatchObject([{ accountId: 'icloud:me', mailbox: 'INBOX', uids: [1] }]);
    expect(c.data.pendingChanges('gmail:me@example.com')).toEqual([]);
  });
});
