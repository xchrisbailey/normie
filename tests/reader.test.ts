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

describe('HTML mail', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const newsletter = [
    'Subject: News', 'MIME-Version: 1.0', 'Content-Type: multipart/related; boundary="rel"', '',
    '--rel', 'Content-Type: multipart/alternative; boundary="alt"', '',
    '--alt', 'Content-Type: text/plain; charset=utf-8', '', 'Plain news', '',
    '--alt', 'Content-Type: text/html; charset=utf-8', '', '<p>Hello <b>news</b> <img src="cid:logo@x"> <img src="https://tracker.example/p.gif"></p>', '',
    '--alt--', '',
    '--rel', 'Content-Type: image/png', 'Content-Transfer-Encoding: base64', 'Content-ID: <logo@x>', 'Content-Disposition: inline', '', PNG, '',
    '--rel--', '',
  ].join('\r\n');

  const startReal = async (p: FakeProvider) => {
    const { readMessage, attachmentContent } = await import('../src/core/mime');
    const { extractText } = await import('../src/sync/extract-text');
    return (core = await createCore({ provider: p, extractText, mime: { readMessage, attachmentContent }, now: () => NOW }));
  };

  it('gives the reader the HTML part, with inline images embedded, and plain text alongside', async () => {
    const p = new FakeProvider();
    p.deliver({ subject: 'News', date: NOW - DAY, from: { address: 'News@Example.com' }, raw: newsletter });
    const c = await startReal(p);
    await c.engine.syncOnce();
    const [row] = await c.rows('inbox');
    const [m] = await c.thread(row!.key);
    expect(m!.text).toBe('Plain news');
    expect(m!.html).toContain('<b>news</b>');
    expect(m!.html).toContain(`data:image/png;base64,${PNG}`);
    expect(m!.html).not.toContain('cid:');
    expect(m!.imagesAllowed).toBe(false);
  });

  it('has no HTML for a plain-text message', async () => {
    const p = new FakeProvider();
    p.deliver({ subject: 'Plain', date: NOW - DAY, text: 'Just text' });
    const c = await startReal(p);
    await c.engine.syncOnce();
    const [row] = await c.rows('inbox');
    expect((await c.thread(row!.key))[0]).toMatchObject({ text: 'Just text', html: null });
  });

  it('remembers senders whose images always load, whatever the case of their address', async () => {
    const p = new FakeProvider();
    p.deliver({ subject: 'News', date: NOW - DAY, from: { address: 'News@Example.com' }, raw: newsletter });
    const c = await startReal(p);
    await c.engine.syncOnce();
    const [row] = await c.rows('inbox');
    await c.allowImagesFrom('news@example.com');
    expect((await c.thread(row!.key))[0]!.imagesAllowed).toBe(true);
  });
});

describe('attachments', () => {
  const withFiles = [
    'Subject: Invoice', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="mix"', '',
    '--mix', 'Content-Type: multipart/related; boundary="rel"', '',
    '--rel', 'Content-Type: text/html; charset=utf-8', '', '<p>See attached <img src="cid:sig@x"></p>', '',
    '--rel', 'Content-Type: image/png', 'Content-Transfer-Encoding: base64', 'Content-ID: <sig@x>', 'Content-Disposition: inline', '',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', '',
    '--rel--', '',
    '--mix', 'Content-Type: application/pdf; name="invoice 42.pdf"', 'Content-Disposition: attachment; filename="invoice 42.pdf"',
    'Content-Transfer-Encoding: base64', '', Buffer.from('%PDF-1.4 fake').toString('base64'), '',
    '--mix--', '',
  ].join('\r\n');

  const startReal = async (p: FakeProvider) => {
    const { readMessage, attachmentContent } = await import('../src/core/mime');
    const { extractText } = await import('../src/sync/extract-text');
    return (core = await createCore({ provider: p, extractText, mime: { readMessage, attachmentContent }, now: () => NOW }));
  };

  it('lists files attached, leaving out images shown in the body', async () => {
    const p = new FakeProvider();
    p.deliver({ subject: 'Invoice', date: NOW - DAY, raw: withFiles });
    const c = await startReal(p);
    await c.engine.syncOnce();
    const [row] = await c.rows('inbox');
    const [m] = await c.thread(row!.key);
    expect(m!.attachments).toEqual([{ index: 1, filename: 'invoice 42.pdf', contentType: 'application/pdf', size: 13 }]);
  });

  it("returns an attachment's bytes from the stored message", async () => {
    const p = new FakeProvider();
    p.deliver({ subject: 'Invoice', date: NOW - DAY, raw: withFiles });
    const c = await startReal(p);
    await c.engine.syncOnce();
    const [row] = await c.rows('inbox');
    const [m] = await c.thread(row!.key);
    const file = await c.attachment(m!.id, 1);
    expect(file).toMatchObject({ filename: 'invoice 42.pdf', contentType: 'application/pdf' });
    expect(new TextDecoder().decode(file!.content)).toBe('%PDF-1.4 fake');
    expect(await c.attachment(m!.id, 9)).toBeNull();
  });
});
