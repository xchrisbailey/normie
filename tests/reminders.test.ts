// Reminders (#79): a Thread I wrote comes back if nobody answers by the date. At the core seam.
import { afterEach, describe, expect, it } from 'vitest';
import { createCore, type TestCore } from '../src/core/core';
import { FakeProvider, FakeTransport, fakeExtractText } from '../src/core/fake-provider';

const HOUR = 3_600_000;
let now = Date.UTC(2026, 10, 27, 12);
let core: TestCore | undefined;
afterEach(async () => {
  await core?.close();
  core = undefined;
});

/** A Gmail-like mailbox whose sent mail comes back in All Mail, threaded with what it answers. */
async function start() {
  const p = new FakeProvider();
  const t = new FakeTransport();
  const send = t.send.bind(t);
  t.send = async (raw, env) => {
    await send(raw, env);
    const text = new TextDecoder().decode(raw);
    p.deliver({ subject: /^Subject: (.*)$/m.exec(text)![1]!.trim(), raw: text, from: { address: 'me@example.com' }, labels: ['\\Sent'], flags: ['\\Seen'], date: now });
  };
  core = await createCore({ provider: p, transport: t, extractText: fakeExtractText, now: () => now, email: 'me@example.com' });
  await core.engine.syncOnce();
  return { c: core, p };
}

async function sendWithReminder(c: TestCore, remindAt: number) {
  const id = await c.send({
    accountId: 'acct-1', from: { address: 'me@example.com' }, to: [{ address: 'ada@example.com' }], cc: [], bcc: [], subject: 'Proposal', body: 'Thoughts?', remindAt,
  });
  now += 5000;
  await c.engine.sendOutbox();
  await c.engine.syncOnce();
  return id;
}
const reminders = async (c: TestCore) => (await c.rows('inbox')).filter((r) => r.tags?.reminder).map((r) => r.subject);

describe('Reminders', () => {
  it('bring my Thread back to the Inbox when nobody has answered by the date', async () => {
    const { c } = await start();
    await sendWithReminder(c, now + 2 * 24 * HOUR);
    expect(await c.rows('inbox')).toEqual([]);
    now += 24 * HOUR;
    c.data.runDue();
    expect(await reminders(c)).toEqual([]);
    now += 24 * HOUR;
    c.data.runDue();
    expect(await reminders(c)).toEqual(['Proposal']);
  });

  it('clear themselves when someone else answers first', async () => {
    const { c, p } = await start();
    await sendWithReminder(c, now + 2 * 24 * HOUR);
    const sentId = (c.data.store.db.prepare(`select message_id from messages where subject = 'Proposal'`).pluck().get()) as string;
    now += HOUR;
    p.deliver({ subject: 'Re: Proposal', from: { address: 'ada@example.com' }, inReplyTo: sentId, date: now });
    await c.engine.syncOnce();
    now += 2 * 24 * HOUR;
    c.data.runDue();
    expect(await reminders(c)).toEqual([]);
    expect(c.data.store.nextReminderAt()).toBeUndefined();
  });

  it("don't count my own follow-up as an answer", async () => {
    const { c, p } = await start();
    await sendWithReminder(c, now + 2 * 24 * HOUR);
    const sentId = (c.data.store.db.prepare(`select message_id from messages where subject = 'Proposal'`).pluck().get()) as string;
    now += HOUR;
    p.deliver({ subject: 'Re: Proposal', from: { address: 'me@example.com' }, inReplyTo: sentId, labels: ['\\Sent'], date: now });
    await c.engine.syncOnce();
    now += 2 * 24 * HOUR;
    c.data.runDue();
    expect(await reminders(c)).toEqual(['Proposal']);
  });

  it('are settled by dealing with the Thread', async () => {
    const { c } = await start();
    await sendWithReminder(c, now + HOUR);
    now += 2 * HOUR;
    c.data.runDue();
    const [row] = await c.rows('inbox');
    await c.act(row!.key, { type: 'done' });
    expect(await reminders(c)).toEqual([]);
  });

  it('go with the message when its send is undone', async () => {
    const { c } = await start();
    const id = await c.send({
      accountId: 'acct-1', from: { address: 'me@example.com' }, to: [{ address: 'ada@example.com' }], cc: [], bcc: [], subject: 'Proposal', body: 'x', remindAt: now + HOUR,
    });
    expect((await c.cancelSend(id))?.remindAt).toBe(now + HOUR);
    expect(c.data.store.nextReminderAt()).toBeUndefined();
  });
});
