// Done, delete and Labels as moves on folder servers (#57). At the core seam over iCloud-like fakes.
import { afterEach, describe, expect, it } from 'vitest';
import { createCore, type TestCore } from '../src/core/core';
import { FakeProvider, fakeExtractText, ICLOUD_CAPS } from '../src/core/fake-provider';
import type { Mailbox } from '../src/core/types';

const NOW = Date.UTC(2026, 10, 27, 12);
const HOUR = 3_600_000;
const ACCOUNT = 'icloud:me@icloud.com@imap.mail.me.com';
let core: TestCore | undefined;
afterEach(async () => {
  await core?.close();
  core = undefined;
});

function server(opts: { move?: boolean; mailboxes?: Mailbox[] } = {}) {
  const p = new FakeProvider({ caps: { ...ICLOUD_CAPS, move: !!opts.move }, ...(opts.mailboxes ? { mailboxes: opts.mailboxes } : {}) });
  const trip = p.deliver({ subject: 'Trip', messageId: '<a@x>', date: NOW - 3 * HOUR }, 'INBOX');
  const reply = p.deliver({ subject: 'Re: Trip', messageId: '<b@x>', inReplyTo: '<a@x>', date: NOW - 2 * HOUR }, 'Sent Messages');
  p.deliver({ subject: 'Lunch', messageId: '<c@x>', date: NOW - HOUR }, 'INBOX');
  return { p, trip, reply };
}
const start = async (p: FakeProvider) => {
  core = await createCore({ provider: p, extractText: fakeExtractText, now: () => NOW, accountId: ACCOUNT, deleteHoldMs: 0 });
  await core.engine.syncOnce();
  return core;
};
const subjects = async (c: TestCore) => (await c.rows('inbox')).map((r) => r.subject);
const keyOf = async (c: TestCore, s: string) => (await c.rows('inbox')).find((r) => r.subject === s)!.key;
const subjectsIn = (p: FakeProvider, path: string) => p.contents(path).map((m) => m.subject).sort();

describe('Done on a folder server', () => {
  it('moves the Inbox messages to Archive with copy and delete (no MOVE), leaving Sent alone', async () => {
    const { p, trip } = server();
    const c = await start(p);
    await c.act(await keyOf(c, 'Trip'), { type: 'done' });
    expect(await subjects(c)).toEqual(['Lunch']);
    await c.engine.replay();
    expect(p.moves).toEqual([{ from: 'INBOX', to: 'Archive', uids: [trip], method: 'copy+delete' }]);
    expect(subjectsIn(p, 'Archive')).toEqual(['Trip']);
    expect(subjectsIn(p, 'Sent Messages')).toEqual(['Re: Trip']);
    await c.engine.syncOnce();
    expect(await subjects(c)).toEqual(['Lunch']);
  });

  it('uses MOVE where the server has it', async () => {
    const { p } = server({ move: true });
    const c = await start(p);
    await c.act(await keyOf(c, 'Trip'), { type: 'done' });
    await c.engine.replay();
    expect(p.moves[0]!.method).toBe('move');
  });

  it('creates Archive when the Account has none, and keeps it in sync after', async () => {
    const { p } = server({ mailboxes: [{ path: 'INBOX', role: 'inbox' }, { path: 'Sent Messages', role: 'sent' }] });
    const c = await start(p);
    expect(c.engine.syncedMailboxes).toEqual(['INBOX', 'Sent Messages']);
    await c.act(await keyOf(c, 'Trip'), { type: 'done' });
    await c.engine.replay();
    expect(p.calls).toContain('createMailbox');
    expect(subjectsIn(p, 'Archive')).toEqual(['Trip']);
    expect(c.engine.syncedMailboxes).toContain('Archive');
  });

  it("doesn't bring the Thread back when a sync lands before the move", async () => {
    const { p } = server();
    const c = await start(p);
    p.failNext = 1;
    await c.act(await keyOf(c, 'Trip'), { type: 'done' });
    await c.engine.idle();
    p.failNext = 1; // the replay at the start of the pass fails again
    await c.engine.syncOnce();
    expect(await subjects(c)).toEqual(['Lunch']);
  });
});

describe('delete and Move to on a folder server', () => {
  it('moves the whole Thread to Trash', async () => {
    const { p } = server();
    const c = await start(p);
    await c.act(await keyOf(c, 'Trip'), { type: 'delete' });
    await c.engine.replay();
    expect(subjectsIn(p, 'Deleted Messages')).toEqual(['Re: Trip', 'Trip']);
    expect(await subjects(c)).toEqual(['Lunch']);
  });

  it('lists folders to move to, and moving takes the Thread out of the Inbox', async () => {
    const { p } = server();
    p.addMailbox({ path: 'Receipts' });
    const c = await start(p);
    expect(await c.labels(ACCOUNT)).toEqual({ moves: true, names: ['Receipts'] });
    await c.act(await keyOf(c, 'Trip'), { type: 'label', label: 'Receipts', on: true });
    expect(await subjects(c)).toEqual(['Lunch']);
    await c.engine.replay();
    expect(subjectsIn(p, 'Receipts')).toEqual(['Trip']);
    expect(subjectsIn(p, 'Sent Messages')).toEqual(['Re: Trip']);
  });
});

describe('undoing a move', () => {
  it('cancels a move that has not happened', async () => {
    const { p } = server();
    const c = await start(p);
    p.failNext = 1;
    const ids = await c.act(await keyOf(c, 'Trip'), { type: 'done' });
    await c.engine.idle();
    await c.undo(ids);
    expect(await subjects(c)).toEqual(['Lunch', 'Trip']);
    await c.engine.replay();
    expect(p.moves).toEqual([]);
  });

  it('moves the messages back, by their new UIDs, once the server has moved them', async () => {
    const { p } = server();
    const c = await start(p);
    const ids = await c.act(await keyOf(c, 'Trip'), { type: 'done' });
    await c.engine.replay();
    await c.engine.syncOnce();
    const [archived] = p.contents('Archive');
    await c.undo(ids);
    expect(await subjects(c)).toEqual(['Lunch', 'Trip']);
    await c.engine.replay();
    expect(p.moves.at(-1)).toEqual({ from: 'Archive', to: 'INBOX', uids: [archived!.uid], method: 'copy+delete' });
    await c.engine.syncOnce();
    expect(await subjects(c)).toEqual(['Lunch', 'Trip']);
    expect((await c.rows('inbox')).find((r) => r.subject === 'Trip')!.count).toBe(2);
  });
});
