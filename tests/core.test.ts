// Tests at the core's command and query seam, over the fake MailProvider.
import { afterEach, describe, expect, it } from 'vitest';
import { createCore, type TestCore } from '../src/core/core';
import { FakeProvider, fakeExtractText } from '../src/core/fake-provider';

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
    p.deliver({ subject: 'Trip', threadId: 'trip', date: NOW - 3 * HOUR, flags: ['\\Seen'] });
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
