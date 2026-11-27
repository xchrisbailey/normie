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

describe('replying through the core', () => {
  it('sends a reply with threading headers, and it joins the Thread after the next sync', async () => {
    const { planReply } = await import('../src/core/reply');
    const { readMessage, attachmentContent, readOriginal } = await import('../src/core/mime');
    const provider = new FakeProvider();
    const transport = new FakeTransport();
    // Like Gmail, sent mail lands in All Mail by itself.
    const send = transport.send.bind(transport);
    transport.send = async (raw, env) => {
      await send(raw, env);
      provider.deliver({ subject: 'Re: Lunch', raw: new TextDecoder().decode(raw), labels: ['\\Sent'], flags: ['\\Seen'] });
    };
    provider.deliver({
      subject: 'Lunch', threadId: 't-lunch', date: now - 3_600_000,
      raw: ['From: Ada <ada@example.com>', 'To: me@example.com', 'Cc: Grace <grace@example.com>', 'Subject: Lunch',
        'Message-ID: <lunch-1@example.com>', 'References: <older@example.com>', '', 'Friday?'].join('\r\n'),
    });
    const c = await createCore({
      provider, transport, extractText: fakeExtractText, mime: { readMessage, attachmentContent, readOriginal }, now: () => now, accountId: 'gmail:me@example.com',
    });
    cores.push(c);
    await c.engine.syncOnce();
    const [row] = await c.rows('inbox');
    const [m] = await c.thread(row!.key);
    const o = await c.original(m!.id, false);
    const reply = planReply('replyAll', o!, [{ address: 'me@example.com' }]);
    expect(reply.to).toEqual([{ name: 'Ada', address: 'ada@example.com' }]);
    expect(reply.cc).toEqual([{ name: 'Grace', address: 'grace@example.com' }]);

    await c.send({ accountId: 'gmail:me@example.com', from: { address: 'me@example.com' }, ...reply, body: `Yes!${reply.body}` });
    now += 5000;
    await c.engine.sendOutbox();
    const raw = transport.sent[0]!.raw;
    expect(raw).toMatch(/^In-Reply-To: <lunch-1@example\.com>/m);
    expect(raw).toMatch(/^References: <older@example\.com> <lunch-1@example\.com>/m);
    expect(raw).toMatch(/^Subject: Re: Lunch/m);

    await c.engine.syncOnce();
    expect((await c.rows('inbox'))[0]).toMatchObject({ key: row!.key, count: 2 });
  });
});
