// Triage actions (#21): the store changes at once, the change is queued, and sync replays it to the server.
// At the core seam over the fake provider.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore, type TestCore } from '../src/core/core';
import { FakeProvider, fakeExtractText } from '../src/core/fake-provider';

const NOW = Date.UTC(2026, 10, 26, 12);
const HOUR = 3_600_000;
const cores: TestCore[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const c of cores.splice(0)) await c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
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
  const a2 = p.deliver({ subject: 'Re: Lunch', threadId: 't-lunch', date: NOW - 2 * HOUR, labels: ['\\Sent'], flags: ['\\Seen'] });
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
    expect(p.edits).toEqual([{ mailbox: '[Gmail]/All Mail', uids: lunch.inbox, edit: { removeLabels: ['\\Inbox'] } }]);
    expect(c.data.pendingChanges('acct-1')).toEqual([]);
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
    expect(c.data.pendingChanges('acct-1')).toMatchObject([{ uids: lunch.inbox, attempts: 1 }]);
    expect(await subjects(c)).toEqual(['Invoice']);

    await c.engine.syncOnce();
    expect(p.edits).toHaveLength(1);
    expect(c.data.pendingChanges('acct-1')).toEqual([]);
  });

  it("doesn't bring the Thread back when a sync lands before the change reaches the server", async () => {
    const { p, lunch } = mailbox();
    const c = await start(p);
    p.failNext = 1;
    await c.act(await keyOf(c, 'Lunch'), { type: 'done' });
    await c.engine.idle();
    // Meanwhile my phone marks the message read; the server still has it in the Inbox.
    p.setFlags(lunch.inbox[1]!, { flags: ['\\Seen'] });
    p.failNext = 1; // the replay at the start of the pass fails again; the header sync goes through
    await c.engine.syncOnce();
    expect(await subjects(c)).toEqual(['Invoice']);
    expect(c.data.pendingChanges('acct-1')).toHaveLength(1);
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
    expect(p.edits).toEqual([{ mailbox: '[Gmail]/All Mail', uids: lunch.inbox, edit: { removeLabels: ['\\Inbox'] } }]);
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
