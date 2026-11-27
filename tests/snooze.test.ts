// Snooze and the scheduler (#76), at the core seam with a clock the test moves.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore } from '../src/core/core';
import type { TestCore } from '../src/core/core';
import { FakeProvider, fakeExtractText, ICLOUD_CAPS } from '../src/core/fake-provider';

const HOUR = 3_600_000;
let now = Date.UTC(2026, 10, 27, 12);
const cores: Array<TestCore> = [];
const dirs: Array<string> = [];
afterEach(async () => {
  for (const c of cores.splice(0)) {
    await c.close();
  }
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

async function start(p: FakeProvider, opts: { dbPath?: string; accountId?: string } = {}) {
  const c = await createCore({ provider: p, extractText: fakeExtractText, now: () => now, ...opts });
  cores.push(c);
  await c.engine.syncOnce();
  return c;
}
const inbox = async (c: TestCore) => (await c.rows('inbox')).filter((r) => !r.tags?.snoozedUntil).map((r) => r.subject);
const snoozed = async (c: TestCore) => (await c.rows('inbox')).filter((r) => r.tags?.snoozedUntil).map((r) => [r.subject, r.tags!.snoozedUntil]);
const keyOf = async (c: TestCore, s: string) => (await c.rows('inbox')).find((r) => r.subject === s)!.key;

describe('Snooze on Gmail', () => {
  it('takes the Thread out of the Inbox into the Snoozed label, and brings it back on top when it wakes', async () => {
    const p = new FakeProvider();
    const trip = p.deliver({ subject: 'Trip', threadId: 't-trip', date: now - 3 * HOUR });
    p.deliver({ subject: 'Lunch', threadId: 't-lunch', date: now - HOUR });
    const c = await start(p);
    const until = now + 2 * HOUR;
    await c.act(await keyOf(c, 'Trip'), { type: 'snooze', until });
    expect(await inbox(c)).toEqual(['Lunch']);
    expect(await snoozed(c)).toEqual([['Trip', until]]);
    await c.engine.replay();
    expect(p.edits).toEqual([{ mailbox: '[Gmail]/All Mail', uids: [trip], edit: { removeLabels: [String.raw`\Inbox`], addLabels: ['Snoozed'] } }]);

    now += HOUR;
    expect(c.data.runDue()).toBe(0);
    now += HOUR;
    expect(c.data.runDue()).toBe(1);
    expect(await inbox(c)).toEqual(['Trip', 'Lunch']);
    expect(await snoozed(c)).toEqual([]);
    await c.engine.replay();
    expect(p.edits.at(-1)).toEqual({ mailbox: '[Gmail]/All Mail', uids: [trip], edit: { addLabels: [String.raw`\Inbox`], removeLabels: ['Snoozed'] } });
    await c.engine.syncOnce();
    expect(await inbox(c)).toEqual(['Trip', 'Lunch']);
  });

  it('can be unsnoozed early', async () => {
    const p = new FakeProvider();
    p.deliver({ subject: 'Trip', threadId: 't-trip', date: now - HOUR });
    const c = await start(p);
    await c.act(await keyOf(c, 'Trip'), { type: 'snooze', until: now + 24 * HOUR });
    await c.act(await keyOf(c, 'Trip'), { type: 'unsnooze' });
    expect(await inbox(c)).toEqual(['Trip']);
    expect(c.data.store.nextWakeAt()).toBeUndefined();
  });

  it('is undone with z, and then never wakes', async () => {
    const p = new FakeProvider();
    p.deliver({ subject: 'Trip', threadId: 't-trip', date: now - HOUR });
    const c = await start(p);
    const ids = await c.act(await keyOf(c, 'Trip'), { type: 'snooze', until: now + HOUR });
    await c.undo(ids);
    expect(await inbox(c)).toEqual(['Trip']);
    expect(c.data.store.nextWakeAt()).toBeUndefined();
  });

  it('wakes at the next start when it came due while Normie was closed', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'normie-snooze-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'store.sqlite');
    const p = new FakeProvider();
    p.deliver({ subject: 'Trip', threadId: 't-trip', date: now - HOUR });
    const first = await start(p, { dbPath });
    await first.act(await keyOf(first, 'Trip'), { type: 'snooze', until: now + HOUR });
    await first.engine.replay();
    await first.close();
    cores.splice(cores.indexOf(first), 1);

    now += 3 * HOUR;
    const second = await start(p, { dbPath });
    expect(await inbox(second)).toEqual(['Trip']);
  });
});

describe('Snooze on a folder server', () => {
  it('moves the Thread to a Snoozed folder (made when needed), keeps it in view, and moves it back on waking', async () => {
    const p = new FakeProvider({ caps: ICLOUD_CAPS });
    p.deliver({ subject: 'Trip', messageId: '<a@x>', date: now - HOUR }, 'INBOX');
    const c = await start(p, { accountId: 'icloud:me' });
    await c.act(await keyOf(c, 'Trip'), { type: 'snooze', until: now + HOUR });
    await c.engine.replay();
    expect(p.moves.at(-1)).toMatchObject({ from: 'INBOX', to: 'Snoozed' });
    await c.engine.syncOnce();
    expect(c.engine.syncedMailboxes).toContain('Snoozed');
    expect((await snoozed(c)).map((s) => s[0])).toEqual(['Trip']);

    now += 2 * HOUR;
    c.data.runDue();
    expect(await inbox(c)).toEqual(['Trip']);
    await c.engine.replay();
    expect(p.moves.at(-1)).toMatchObject({ from: 'Snoozed', to: 'INBOX' });
    await c.engine.syncOnce();
    expect(await inbox(c)).toEqual(['Trip']);
  });
});
