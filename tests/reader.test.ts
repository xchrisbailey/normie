// Opening Threads (#9), at the core seam over the fake provider.
import { afterEach, describe, expect, it } from 'vitest';
import { createCore, type TestCore } from '../src/core/core';
import { FakeProvider, fakeExtractText } from '../src/core/fake-provider';
import type { CoreNotice } from '../src/core/types';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 26, 12);
let core: TestCore | undefined;
afterEach(async () => {
  await core?.close();
  core = undefined;
});
const start = async (p: FakeProvider) => (core = await createCore({ provider: p, extractText: fakeExtractText, now: () => NOW }));
const next = (c: TestCore, pred: (n: CoreNotice) => boolean) =>
  new Promise<CoreNotice>((resolve) => {
    const off = c.onNotice((n) => {
      if (pred(n)) {
        off();
        resolve(n);
      }
    });
  });

describe('opening a Thread', () => {
  it('returns every message as plain text, oldest to newest, with From, To and date', async () => {
    const p = new FakeProvider();
    p.deliver({ subject: 'Trip', threadId: 'trip', date: NOW - 2 * DAY, from: { name: 'Ada', address: 'ada@example.com' }, text: 'Shall we go?' });
    p.deliver({ subject: 'Re: Trip', threadId: 'trip', date: NOW - DAY, from: { name: 'Me', address: 'me@example.com' }, to: [{ name: 'Ada', address: 'ada@example.com' }], text: 'Yes!\n\n> Shall we go?' });
    const c = await start(p);
    await c.engine.syncOnce();
    const [row] = await c.rows('inbox');
    const messages = await c.thread(row!.key);
    expect(messages.map((m) => [m.from?.name, m.text])).toEqual([['Ada', 'Shall we go?'], ['Me', 'Yes!\n\n> Shall we go?']]);
    expect(messages[1]).toMatchObject({ to: [{ name: 'Ada', address: 'ada@example.com' }], date: NOW - DAY });
  });

  it('downloads the body of a headers-only message when it is opened', async () => {
    const p = new FakeProvider();
    p.deliver({ subject: 'Old news', date: NOW - 200 * DAY, text: 'From long ago' });
    const c = await start(p);
    await c.engine.syncOnce();
    const [row] = await c.rows('inbox');
    const changed = next(c, (n) => n.type === 'thread-changed' && n.key === row!.key);
    const first = await c.thread(row!.key);
    expect(first[0]!.text).toBeNull();
    await changed;
    expect((await c.thread(row!.key))[0]!.text).toBe('From long ago');
    expect(p.calls.filter((x) => x === 'fetchBodies')).toHaveLength(1);
  });

  it('does not refetch a body that is already stored', async () => {
    const p = new FakeProvider();
    p.deliver({ subject: 'Recent', date: NOW - DAY });
    const c = await start(p);
    await c.engine.syncOnce();
    const fetchesAfterSync = p.calls.filter((x) => x === 'fetchBodies').length;
    const [row] = await c.rows('inbox');
    await c.thread(row!.key);
    await new Promise((r) => setTimeout(r, 10));
    expect(p.calls.filter((x) => x === 'fetchBodies')).toHaveLength(fetchesAfterSync);
  });
});
