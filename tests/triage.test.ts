// Triage actions (#21): the store changes at once, the change is queued, and sync replays it to the server.
// At the core seam over the fake provider.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore } from '../src/core/core';
import type { TestCore } from '../src/core/core';
import { FakeProvider, fakeExtractText } from '../src/core/fake-provider';

const NOW = Date.UTC(2026, 10, 26, 12);
const HOUR = 3_600_000;
const cores: Array<TestCore> = [];
const dirs: Array<string> = [];

afterEach(async () => {
  for (const c of cores.splice(0)) {await c.close();}
  for (const d of dirs.splice(0)) {rmSync(d, { recursive: true, force: true });}
});

async function start(provider: FakeProvider, dbPath?: string) {
  const c = await createCore({ provider, extractText: fakeExtractText, now: () => NOW, dbPath });
  cores.push(c);
  await c.engine.syncOnce();
  return c;
}

/** A Gmail-like mailbox with two Inbox Threads; the first has a reply of mine that isn't in the Inbox. */
function mailbox() {
  const p = new FakeProvider();
  const a1 = p.deliver({ subject: 'Lunch', threadId: 't-lunch', date: NOW - 3 * HOUR });
  const a2 = p.deliver({ subject: 'Re: Lunch', threadId: 't-lunch', date: NOW - 2 * HOUR, labels: [String.raw`\Sent`], flags: [String.raw`\Seen`] });
  const a3 = p.deliver({ subject: 'Re: Lunch', threadId: 't-lunch', date: NOW - HOUR });
  const b1 = p.deliver({ subject: 'Invoice', threadId: 't-invoice', date: NOW - 4 * HOUR });
  return { p, lunch: { inbox: [a1, a3], sent: a2 }, invoice: b1 };
}

const subjects = async (c: TestCore) => (await c.rows('inbox')).map((r) => r.subject);
const keyOf = async (c: TestCore, subject: string) => (await c.rows('inbox')).find((r) => r.subject === subject)!.key;

describe('Done', () => {
  it('takes the Thread out of the Inbox at once', async () => {
    const { p } = mailbox();
    const c = await start(p);
    await c.act(await keyOf(c, 'Lunch'), { type: 'done' });
    expect(await subjects(c)).toEqual(['Invoice']);
  });

  it("removes the Inbox label from the Thread's Inbox messages on the server, and leaves my sent reply alone", async () => {
    const { p, lunch } = mailbox();
    const c = await start(p);
    await c.act(await keyOf(c, 'Lunch'), { type: 'done' });
    await c.engine.replay();
    expect(p.edits).toEqual([{ mailbox: '[Gmail]/All Mail', uids: lunch.inbox, edit: { removeLabels: [String.raw`\Inbox`] } }]);
    expect(c.data.pendingChanges('gmail:me@example.com')).toEqual([]);
    // The next sync agrees with what's on screen.
    await c.engine.syncOnce();
    expect(await subjects(c)).toEqual(['Invoice']);
  });

  it('does nothing for a Thread that is already out of the Inbox', async () => {
    const { p } = mailbox();
    const c = await start(p);
    const key = await keyOf(c, 'Lunch');
    await c.act(key, { type: 'done' });
    expect(await c.act(key, { type: 'done' })).toEqual([]);
  });

  it('keeps the change pending while the server is unreachable, then sends it', async () => {
    const { p, lunch } = mailbox();
    const c = await start(p);
    p.failNext = 1;
    await c.act(await keyOf(c, 'Lunch'), { type: 'done' });
    await c.engine.idle();
    expect(p.edits).toEqual([]);
    expect(c.data.pendingChanges('gmail:me@example.com')).toMatchObject([{ uids: lunch.inbox, attempts: 0 }]);
    expect(await subjects(c)).toEqual(['Invoice']);

    await c.engine.syncOnce();
    expect(p.edits).toHaveLength(1);
    expect(c.data.pendingChanges('gmail:me@example.com')).toEqual([]);
  });

  it("doesn't bring the Thread back when a sync lands before the change reaches the server", async () => {
    const { p, lunch } = mailbox();
    const c = await start(p);
    p.failNext = 1;
    await c.act(await keyOf(c, 'Lunch'), { type: 'done' });
    await c.engine.idle();
    // Meanwhile my phone marks the message read; the server still has it in the Inbox.
    p.setFlags(lunch.inbox[1]!, { flags: [String.raw`\Seen`] });
    p.failNext = 1; // the replay at the start of the pass fails again; the header sync goes through
    await c.engine.syncOnce();
    expect(await subjects(c)).toEqual(['Invoice']);
    expect(c.data.pendingChanges('gmail:me@example.com')).toHaveLength(1);
  });

  it('survives a restart and is sent on the next sync', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'normie-triage-'));
    dirs.push(dir);
    const db = path.join(dir, 'store.sqlite');
    const { p, lunch } = mailbox();
    const first = await start(p, db);
    p.failNext = 1;
    await first.act(await keyOf(first, 'Lunch'), { type: 'done' });
    await first.engine.idle();
    await first.close();
    cores.splice(cores.indexOf(first), 1);

    const second = await start(p, db);
    expect(p.edits).toEqual([{ mailbox: '[Gmail]/All Mail', uids: lunch.inbox, edit: { removeLabels: [String.raw`\Inbox`] } }]);
    expect(await subjects(second)).toEqual(['Invoice']);
  });

  it('a new message in the Thread brings it back to the Inbox, as on Gmail', async () => {
    const { p } = mailbox();
    const c = await start(p);
    await c.act(await keyOf(c, 'Lunch'), { type: 'done' });
    await c.engine.replay();
    p.deliver({ subject: 'Re: Lunch', threadId: 't-lunch', date: NOW });
    await c.engine.syncOnce();
    expect(await subjects(c)).toEqual(['Lunch', 'Invoice']);
  });
});

describe('failed changes', () => {
  const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 2000) => {
    const end = Date.now() + ms;
    while (!(await cond())) {
      if (Date.now() > end) {throw new Error('timed out');}
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const fastCore = async (p: FakeProvider) => {
    const c = await createCore({ provider: p, extractText: fakeExtractText, now: () => NOW, backoffMs: () => 10 });
    cores.push(c);
    await c.engine.syncOnce();
    return c;
  };

  it('retries with backoff by itself until the server takes the change', async () => {
    const { p } = mailbox();
    const c = await fastCore(p);
    p.failNext = 3;
    await c.act(await keyOf(c, 'Lunch'), { type: 'done' });
    await waitFor(() => c.data.pendingChanges('gmail:me@example.com').length === 0);
    expect(p.edits).toHaveLength(1);
  });

  it('reports how many changes are pending and how many are waiting after a failure', async () => {
    const { p } = mailbox();
    const c = await start(p);
    p.failNext = 1;
    await c.act(await keyOf(c, 'Lunch'), { type: 'done' });
    expect(await c.pending()).toEqual({ count: 1, waiting: 0 });
    await c.engine.idle();
    expect(await c.pending()).toEqual({ count: 1, waiting: 1 });
    expect(c.notices).toContainEqual({ type: 'pending', count: 1, waiting: 1 });
    await c.engine.replay();
    expect(await c.pending()).toEqual({ count: 0, waiting: 0 });
    expect(c.notices.at(-1)).toEqual({ type: 'pending', count: 0, waiting: 0 });
  });

  it('gives up after the server refuses three times, and puts the Thread back', async () => {
    const { p } = mailbox();
    const c = await fastCore(p);
    p.rejectEdits = 3;
    c.notices.length = 0;
    await c.act(await keyOf(c, 'Lunch'), { type: 'done' });
    expect(await subjects(c)).toEqual(['Invoice']);
    await waitFor(() => c.notices.some((n) => n.type === 'change-failed'));
    expect(await subjects(c)).toEqual(['Lunch', 'Invoice']);
    expect(c.notices).toContainEqual({ type: 'change-failed', subject: 'Lunch', error: 'fake: server refused the edit' });
    expect(c.notices).toContainEqual({ type: 'rows-changed', split: 'inbox' });
    expect(c.data.pendingChanges('gmail:me@example.com')).toEqual([]);
    expect(p.edits).toEqual([]);
  });

  it('never gives up on a change because the connection is down', async () => {
    const { p } = mailbox();
    const c = await fastCore(p);
    p.failNext = 20;
    await c.act(await keyOf(c, 'Lunch'), { type: 'done' });
    await waitFor(() => p.failNext === 0, 3000);
    await c.engine.idle();
    await waitFor(() => c.data.pendingChanges('gmail:me@example.com').length === 0);
    expect(await subjects(c)).toEqual(['Invoice']);
    expect(c.notices.some((n) => n.type === 'change-failed')).toBe(false);
  });

  it('a refused change does not hold up the ones after it', async () => {
    const { p } = mailbox();
    const c = await start(p);
    p.rejectEdits = 1;
    await c.act(await keyOf(c, 'Lunch'), { type: 'done' });
    await c.act(await keyOf(c, 'Invoice'), { type: 'done' });
    await c.engine.idle();
    await c.engine.replay();
    expect(p.edits.map((e) => e.uids)).toContainEqual([mailbox().invoice]);
  });
});

describe('undo', () => {
  it('cancels a change that has not reached the server: it is never sent', async () => {
    const { p } = mailbox();
    const c = await start(p);
    p.failNext = 1;
    const ids = await c.act(await keyOf(c, 'Lunch'), { type: 'done' });
    await c.engine.idle();
    await c.undo(ids);
    expect(await subjects(c)).toEqual(['Lunch', 'Invoice']);
    await c.engine.replay();
    expect(p.edits).toEqual([]);
    expect(await c.pending()).toEqual({ count: 0, waiting: 0 });
  });

  it('sends the inverse of a change the server already has', async () => {
    const { p, lunch } = mailbox();
    const c = await start(p);
    const ids = await c.act(await keyOf(c, 'Lunch'), { type: 'done' });
    await c.engine.replay();
    await c.undo(ids);
    expect(await subjects(c)).toEqual(['Lunch', 'Invoice']);
    await c.engine.replay();
    expect(p.edits.map((e) => e.edit)).toEqual([{ removeLabels: [String.raw`\Inbox`] }, { addLabels: [String.raw`\Inbox`] }]);
    expect(p.edits[1]!.uids).toEqual(lunch.inbox);
    await c.engine.syncOnce();
    expect(await subjects(c)).toEqual(['Lunch', 'Invoice']);
  });

  it('reverses a change that was on its way when it was undone', async () => {
    const { p } = mailbox();
    const c = await start(p);
    p.failNext = 1;
    const ids = await c.act(await keyOf(c, 'Lunch'), { type: 'done' });
    await c.engine.idle();
    // The sync process has picked the change up and is sending it...
    const [inFlight] = c.data.pendingChanges('gmail:me@example.com');
    await c.undo(ids);
    expect(await subjects(c)).toEqual(['Lunch', 'Invoice']);
    // ...and the server takes it.
    await p.edit(inFlight!.mailbox, inFlight!.uids, inFlight!.edit);
    c.data.changeApplied(inFlight!.id);
    await c.engine.idle();
    await c.engine.replay();
    expect(p.edits.map((e) => e.edit)).toEqual([{ removeLabels: [String.raw`\Inbox`] }, { addLabels: [String.raw`\Inbox`] }]);
    await c.engine.syncOnce();
    expect(await subjects(c)).toEqual(['Lunch', 'Invoice']);
  });

  it('walks back through several actions', async () => {
    const { p } = mailbox();
    const c = await start(p);
    const first = await c.act(await keyOf(c, 'Lunch'), { type: 'done' });
    const second = await c.act(await keyOf(c, 'Invoice'), { type: 'done' });
    expect(await subjects(c)).toEqual([]);
    await c.undo(second);
    expect(await subjects(c)).toEqual(['Invoice']);
    await c.undo(first);
    expect(await subjects(c)).toEqual(['Lunch', 'Invoice']);
    await c.engine.replay();
    await c.engine.syncOnce();
    expect(await subjects(c)).toEqual(['Lunch', 'Invoice']);
  });

  it('undoing twice does nothing more', async () => {
    const { p } = mailbox();
    const c = await start(p);
    const ids = await c.act(await keyOf(c, 'Lunch'), { type: 'done' });
    await c.engine.replay();
    await c.undo(ids);
    await c.undo(ids);
    await c.engine.replay();
    expect(p.edits).toHaveLength(2);
  });
});

describe('star, read and delete', () => {
  const rowOf = async (c: TestCore, subject: string) => (await c.rows('inbox')).find((r) => r.subject === subject);

  it('stars the latest message, and unstarring clears every star in the Thread', async () => {
    const { p, lunch } = mailbox();
    const c = await start(p);
    const key = await keyOf(c, 'Lunch');
    await c.act(key, { type: 'star', on: true });
    expect((await rowOf(c, 'Lunch'))!.starred).toBe(true);
    await c.engine.replay();
    expect(p.edits.at(-1)).toEqual({ mailbox: '[Gmail]/All Mail', uids: [lunch.inbox[1]], edit: { addFlags: [String.raw`\Flagged`] } });
    p.setFlags(lunch.inbox[0]!, { flags: [String.raw`\Flagged`] }); // starred elsewhere too
    await c.engine.syncOnce();
    await c.act(key, { type: 'star', on: false });
    expect((await rowOf(c, 'Lunch'))!.starred).toBe(false);
    await c.engine.replay();
    expect(p.edits.at(-1)).toEqual({ mailbox: '[Gmail]/All Mail', uids: lunch.inbox, edit: { removeFlags: [String.raw`\Flagged`] } });
  });

  it('marks every unread message read, and marks the latest one unread', async () => {
    const { p, lunch } = mailbox();
    const c = await start(p);
    const key = await keyOf(c, 'Lunch');
    expect((await rowOf(c, 'Lunch'))!.unread).toBe(true);
    await c.act(key, { type: 'read', on: true });
    expect((await rowOf(c, 'Lunch'))!.unread).toBe(false);
    await c.engine.replay();
    expect(p.edits.at(-1)).toEqual({ mailbox: '[Gmail]/All Mail', uids: lunch.inbox, edit: { addFlags: [String.raw`\Seen`] } });
    await c.act(key, { type: 'read', on: false });
    expect((await rowOf(c, 'Lunch'))!.unread).toBe(true);
    await c.engine.replay();
    expect(p.edits.at(-1)).toEqual({ mailbox: '[Gmail]/All Mail', uids: [lunch.inbox[1]], edit: { removeFlags: [String.raw`\Seen`] } });
  });

  it('deletes the whole Thread to Trash after a short hold', async () => {
    const { p, lunch } = mailbox();
    let now = NOW;
    const c = await createCore({ provider: p, extractText: fakeExtractText, now: () => now, deleteHoldMs: 10_000 });
    cores.push(c);
    await c.engine.syncOnce();
    await c.act(await keyOf(c, 'Lunch'), { type: 'delete' });
    expect(await subjects(c)).toEqual(['Invoice']);
    await c.engine.idle();
    await c.engine.replay();
    expect(p.edits).toEqual([]);
    now += 10_000;
    await c.engine.replay();
    expect(p.edits).toEqual([
      { mailbox: '[Gmail]/All Mail', uids: [lunch.inbox[0], lunch.sent, lunch.inbox[1]], edit: { addLabels: [String.raw`\Trash`] } },
      { mailbox: '[Gmail]/All Mail', uids: lunch.inbox, edit: { removeLabels: [String.raw`\Inbox`] } },
    ]);
  });

  it('a held delete does not hold up changes to other Threads', async () => {
    const { p } = mailbox();
    const c = await start(p);
    await c.act(await keyOf(c, 'Lunch'), { type: 'delete' });
    await c.act(await keyOf(c, 'Invoice'), { type: 'done' });
    await c.engine.idle();
    await c.engine.replay();
    expect(p.edits.map((e) => e.edit)).toEqual([{ removeLabels: [String.raw`\Inbox`] }]);
  });

  it('undo inside the hold cancels a delete; once Gmail has it, undo leaves it in Trash', async () => {
    const { p } = mailbox();
    const c = await createCore({ provider: p, extractText: fakeExtractText, now: () => NOW, deleteHoldMs: 0 });
    cores.push(c);
    await c.engine.syncOnce();

    // Sent already: Trash is outside All Mail, so there's nothing to put back.
    const ids = await c.act(await keyOf(c, 'Lunch'), { type: 'delete' });
    await c.engine.idle();
    await c.engine.replay();
    await c.undo(ids);
    expect(await subjects(c)).toEqual(['Invoice']);

    // Still held: cancelled, never sent.
    const q = mailbox();
    const d = await start(q.p);
    const ids2 = await d.act(await keyOf(d, 'Lunch'), { type: 'delete' });
    await d.undo(ids2);
    expect(await subjects(d)).toEqual(['Lunch', 'Invoice']);
    await d.engine.replay();
    expect(q.p.edits).toEqual([]);
  });

  it('undoes a star by sending the inverse', async () => {
    const { p, lunch } = mailbox();
    const c = await start(p);
    const ids = await c.act(await keyOf(c, 'Lunch'), { type: 'star', on: true });
    await c.engine.replay();
    await c.undo(ids);
    expect((await rowOf(c, 'Lunch'))!.starred).toBe(false);
    await c.engine.replay();
    expect(p.edits.at(-1)).toEqual({ mailbox: '[Gmail]/All Mail', uids: [lunch.inbox[1]], edit: { removeFlags: [String.raw`\Flagged`] } });
  });
});

describe('mute', () => {
  it('marks the Thread Done and keeps new mail in it out of the Inbox', async () => {
    const { p, lunch } = mailbox();
    const c = await start(p);
    const key = await keyOf(c, 'Lunch');
    await c.act(key, { type: 'mute', on: true });
    expect(await subjects(c)).toEqual(['Invoice']);
    await c.engine.replay();
    expect(p.edits).toEqual([{ mailbox: '[Gmail]/All Mail', uids: lunch.inbox, edit: { removeLabels: [String.raw`\Inbox`] } }]);

    const reply = p.deliver({ subject: 'Re: Lunch', threadId: 't-lunch', date: NOW });
    await c.engine.syncOnce();
    expect(await subjects(c)).toEqual(['Invoice']);
    await c.engine.idle();
    await c.engine.replay();
    expect(p.edits.at(-1)).toEqual({ mailbox: '[Gmail]/All Mail', uids: [reply], edit: { removeLabels: [String.raw`\Inbox`] } });
    // The server agrees on the next pass.
    await c.engine.syncOnce();
    expect(await subjects(c)).toEqual(['Invoice']);
  });

  it('unmuting lets new mail bring the Thread back', async () => {
    const { p } = mailbox();
    const c = await start(p);
    const key = await keyOf(c, 'Lunch');
    await c.act(key, { type: 'mute', on: true });
    expect(await c.act(key, { type: 'mute', on: false })).toEqual([]);
    p.deliver({ subject: 'Re: Lunch', threadId: 't-lunch', date: NOW });
    await c.engine.syncOnce();
    expect(await subjects(c)).toEqual(['Lunch', 'Invoice']);
  });

  it('leaves other Threads alone', async () => {
    const { p } = mailbox();
    const c = await start(p);
    await c.act(await keyOf(c, 'Lunch'), { type: 'mute', on: true });
    p.deliver({ subject: 'Re: Invoice', threadId: 't-invoice', date: NOW });
    await c.engine.syncOnce();
    expect(await subjects(c)).toEqual(['Invoice']);
    expect((await c.rows('inbox'))[0]!.count).toBe(2);
  });
});

describe('Labels', () => {
  const labelled = () => {
    const m = mailbox();
    for (const path of ['Receipts', 'Work/Projects', '[Gmail]/Important', '[Gmail]/Starred', 'Sent Messages']) {m.p.addMailbox({ path });}
    return m;
  };

  it("lists the Account's own Labels, not system mailboxes", async () => {
    const { p } = labelled();
    const c = await start(p);
    expect(await c.labels('gmail:me@example.com')).toEqual({ moves: false, names: ['Receipts', 'Sent Messages', 'Work/Projects'] });
  });

  it('adds a Label to every message in the Thread that lacks it, and keeps the Thread in the Inbox', async () => {
    const { p, lunch } = labelled();
    p.setFlags(lunch.inbox[0]!, { labels: [String.raw`\Inbox`, 'Receipts'] });
    const c = await start(p);
    await c.act(await keyOf(c, 'Lunch'), { type: 'label', label: 'Receipts', on: true });
    expect(await subjects(c)).toEqual(['Lunch', 'Invoice']);
    await c.engine.replay();
    expect(p.edits).toEqual([{ mailbox: '[Gmail]/All Mail', uids: [lunch.sent, lunch.inbox[1]], edit: { addLabels: ['Receipts'] } }]);
  });

  it('undoes a Label by taking it off the same messages', async () => {
    const { p, lunch } = labelled();
    const c = await start(p);
    const ids = await c.act(await keyOf(c, 'Lunch'), { type: 'label', label: 'Work/Projects', on: true });
    await c.engine.replay();
    await c.undo(ids);
    await c.engine.replay();
    expect(p.edits.at(-1)).toEqual({ mailbox: '[Gmail]/All Mail', uids: [lunch.inbox[0], lunch.sent, lunch.inbox[1]], edit: { removeLabels: ['Work/Projects'] } });
  });

  it('removes a Label from every message that has it', async () => {
    const { p, lunch } = labelled();
    p.setFlags(lunch.inbox[1]!, { labels: [String.raw`\Inbox`, 'Receipts'] });
    const c = await start(p);
    await c.act(await keyOf(c, 'Lunch'), { type: 'label', label: 'Receipts', on: false });
    await c.engine.replay();
    expect(p.edits).toEqual([{ mailbox: '[Gmail]/All Mail', uids: [lunch.inbox[1]], edit: { removeLabels: ['Receipts'] } }]);
  });
});

describe('real Account ids', () => {
  it('works when the Account id has a colon in it, as Gmail ids do', async () => {
    const { p, lunch } = mailbox();
    const c = await createCore({ provider: p, extractText: fakeExtractText, now: () => NOW, accountId: 'gmail:me@example.com' });
    cores.push(c);
    await c.engine.syncOnce();
    const key = await keyOf(c, 'Lunch');
    expect((await c.thread(key)).map((m) => m.subject)).toEqual(['Lunch', 'Re: Lunch', 'Re: Lunch']);
    await c.act(key, { type: 'star', on: true });
    expect((await c.rows('inbox')).find((r) => r.subject === 'Lunch')!.starred).toBe(true);
    await c.act(key, { type: 'done' });
    expect(await subjects(c)).toEqual(['Invoice']);
    await c.engine.replay();
    expect(p.edits.at(-1)).toEqual({ mailbox: '[Gmail]/All Mail', uids: lunch.inbox, edit: { removeLabels: [String.raw`\Inbox`] } });
    expect((await c.rows('inbox'))[0]!.accountId).toBe('gmail:me@example.com');
  });
});
