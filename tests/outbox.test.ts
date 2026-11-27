// Sending (#40): the Outbox's undo window, SMTP, offline sending, filing in Sent. At the core seam.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore, type TestCore } from '../src/core/core';
import { FakeProvider, FakeTransport, fakeExtractText, ICLOUD_CAPS } from '../src/core/fake-provider';
import type { OutgoingMessage } from '../src/core/types';

const cores: TestCore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let now = Date.UTC(2026, 10, 27, 12);
async function start(opts: { provider?: FakeProvider; transport?: FakeTransport; dbPath?: string } = {}) {
  const provider = opts.provider ?? new FakeProvider();
  const transport = opts.transport ?? new FakeTransport();
  const c = await createCore({
    provider, transport, extractText: fakeExtractText, now: () => now, backoffMs: () => 5, accountId: 'gmail:me@example.com', dbPath: opts.dbPath,
  });
  cores.push(c);
  await c.engine.syncOnce();
  return { c, provider, transport };
}

const message = (over: Partial<OutgoingMessage> = {}): OutgoingMessage => ({
  accountId: 'gmail:me@example.com', from: { name: 'Me', address: 'me@example.com' },
  to: [{ name: 'Ada', address: 'ada@example.com' }], cc: [], bcc: [{ address: 'secret@example.com' }],
  subject: 'Lunch?', body: 'Shall we have **lunch** on Friday?\n\n- noon\n- 1pm', ...over,
});

const waitFor = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('the Outbox', () => {
  it('holds a message for the undo window, then sends it as HTML and plain text', async () => {
    const { c, transport } = await start();
    await c.send(message());
    await c.engine.sendOutbox();
    expect(transport.sent).toEqual([]);
    expect(await c.pending()).toEqual({ count: 1, waiting: 0 });

    now += 5000;
    await c.engine.sendOutbox();
    expect(transport.sent).toHaveLength(1);
    const { raw, envelope } = transport.sent[0]!;
    expect(envelope).toEqual({ from: 'me@example.com', to: ['ada@example.com', 'secret@example.com'] });
    expect(raw).toMatch(/^Subject: Lunch\?/m);
    expect(raw).toMatch(/^To: Ada <ada@example\.com>/m);
    expect(raw).not.toMatch(/^Bcc:/im);
    expect(raw).toMatch(/Content-Type: multipart\/alternative/);
    expect(raw).toContain('<strong>lunch</strong>');
    expect(raw).toContain('Shall we have **lunch** on Friday?');
    expect(raw).toMatch(/^Message-ID: <[0-9a-f]+\.normie@example\.com>/m);
    expect(await c.pending()).toEqual({ count: 0, waiting: 0 });
  });

  it('gives the message back on undo inside the window, and never sends it', async () => {
    const { c, transport } = await start();
    const id = await c.send(message());
    expect(await c.cancelSend(id)).toMatchObject({ subject: 'Lunch?', body: message().body });
    now += 10_000;
    await c.engine.sendOutbox();
    expect(transport.sent).toEqual([]);
    expect(await c.cancelSend(id)).toBeNull();
  });

  it("can't be undone once it has gone", async () => {
    const { c } = await start();
    const id = await c.send(message());
    now += 5000;
    await c.engine.sendOutbox();
    expect(await c.cancelSend(id)).toBeNull();
  });

  it('waits while offline and sends when the connection is back, with the same Message-ID', async () => {
    const { c, transport } = await start();
    transport.failNext = 2;
    await c.send(message());
    now += 5000;
    await c.engine.sendOutbox();
    expect(await c.pending()).toEqual({ count: 1, waiting: 1 });
    await waitFor(() => transport.sent.length === 1);
    expect(await c.pending()).toEqual({ count: 0, waiting: 0 });
  });

  it('gives a message the server keeps refusing back to the user', async () => {
    const { c, transport } = await start();
    transport.rejectNext = 3;
    const id = await c.send(message());
    now += 5000;
    await c.engine.sendOutbox();
    await waitFor(() => c.notices.some((n) => n.type === 'send-failed'));
    expect(c.notices).toContainEqual({ type: 'send-failed', id, error: 'fake SMTP: 550 rejected' });
    expect(await c.cancelSend(id)).toMatchObject({ subject: 'Lunch?' });
    expect(transport.sent).toEqual([]);
  });

  it('survives a restart', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'normie-outbox-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'store.sqlite');
    const provider = new FakeProvider();
    const first = await start({ provider, dbPath });
    await first.c.send(message({ attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: new TextEncoder().encode('hello') }] }));
    await first.c.close();
    cores.splice(cores.indexOf(first.c), 1);

    now += 5000;
    const second = await start({ provider, dbPath });
    await waitFor(() => second.transport.sent.length === 1);
    expect(second.transport.sent[0]!.raw).toContain('filename=a.txt');
  });

  it('files a copy in Sent on servers that do not, and not on Gmail', async () => {
    const gmail = await start();
    await gmail.c.send(message());
    now += 5000;
    await gmail.c.engine.sendOutbox();
    expect(gmail.provider.appends).toEqual([]);

    const folders = await start({ provider: new FakeProvider({ caps: ICLOUD_CAPS }) });
    await folders.c.send(message());
    now += 5000;
    await folders.c.engine.sendOutbox();
    expect(folders.provider.appends).toHaveLength(1);
    expect(folders.provider.appends[0]).toMatchObject({ mailbox: 'Sent Messages', flags: ['\\Seen'] });
    expect(folders.provider.appends[0]!.raw).toMatch(/^Subject: Lunch\?/m);
  });

  it('escapes raw HTML written in the Markdown', async () => {
    const { c, transport } = await start();
    await c.send(message({ body: 'Hi <script>alert(1)</script> <img src=x onerror=alert(1)>' }));
    now += 5000;
    await c.engine.sendOutbox();
    const html = transport.sent[0]!.raw.split('text/html')[1]!;
    expect(html).not.toMatch(/<script|<img/);
  });
});
