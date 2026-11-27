// Live updates (#10), at the core seam, driven by scripted changes in the fake provider.
// Covers both change-detection paths: CONDSTORE only (Gmail) and CONDSTORE + QRESYNC (iCloud).
import { afterEach, describe, expect, it } from 'vitest';
import { createCore } from '../src/core/core';
import type { TestCore } from '../src/core/core';
import { FakeProvider, fakeExtractText, GMAIL_CAPS, ICLOUD_CAPS } from '../src/core/fake-provider';
import type { Caps } from '../src/core/types';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 26, 12);
let core: TestCore | undefined;
afterEach(async () => {
  await core?.close();
  core = undefined;
});

async function live(caps: Caps, setup: (p: FakeProvider) => void = () => {}) {
  const p = new FakeProvider({ caps });
  p.deliver({ subject: 'Existing', date: NOW - 2 * HOUR });
  setup(p);
  const c = (core = await createCore({ provider: p, extractText: fakeExtractText, now: () => NOW, debounceMs: 0, pollMs: 60_000, backoffMs: () => 5 }));
  await c.engine.syncOnce();
  c.engine.startLive();
  await new Promise((r) => setTimeout(r, 5)); // let IDLE start
  return { p, c };
}
const subjects = async (c: TestCore) => (await c.rows('inbox')).map((r) => r.subject);

for (const [name, caps] of [['Gmail-like (CONDSTORE only)', GMAIL_CAPS], ['iCloud-like (QRESYNC)', ICLOUD_CAPS]] as const) {
  describe(`live updates, ${name}`, () => {
    it('shows new Inbox mail without user action', async () => {
      const { p, c } = await live(caps);
      const pass = c.engine.nextPass();
      p.deliver({ subject: 'Fresh', date: NOW - 60_000 });
      await pass;
      expect(await subjects(c)).toEqual(['Fresh', 'Existing']);
    });

    it('picks up a flag change made on another device', async () => {
      const { p, c } = await live(caps);
      const uid = [...(await c.rows('inbox'))].length && 1;
      expect((await c.rows('inbox'))[0]!.unread).toBe(true);
      const pass = c.engine.nextPass();
      p.setFlags(uid, { flags: [String.raw`\Seen`] });
      await pass;
      expect((await c.rows('inbox'))[0]!.unread).toBe(false);
    });

    it('removes a message deleted on another device', async () => {
      const { p, c } = await live(caps, (fp) => fp.deliver({ subject: 'Doomed', date: NOW - HOUR }));
      expect(await subjects(c)).toContain('Doomed');
      const pass = c.engine.nextPass();
      p.expunge(2);
      await pass;
      expect(await subjects(c)).toEqual(['Existing']);
    });

    it('reconnects after a network drop and catches up without duplicates', async () => {
      const { p, c } = await live(caps);
      p.drop(2);
      p.deliver({ subject: 'While offline', date: NOW - 30_000 });
      // Wait for IDLE to restart and the catch-up pass to land.
      for (let i = 0; i < 50 && !(await subjects(c)).includes('While offline'); i++) {await new Promise((r) => setTimeout(r, 10));}
      expect(await subjects(c)).toEqual(['While offline', 'Existing']);
      const pass = c.engine.nextPass();
      p.deliver({ subject: 'After reconnect', date: NOW - 10_000 });
      await pass;
      expect(await subjects(c)).toEqual(['After reconnect', 'While offline', 'Existing']);
      expect(c.data.store.db.prepare('select count(*) from messages').pluck().get()).toBe(3);
    });
  });
}

describe('sync state', () => {
  it('keeps HIGHESTMODSEQ per mailbox across restarts', async () => {
    const p = new FakeProvider();
    p.deliver({ subject: 'One', date: NOW - HOUR });
    const dbPath = `${process.env.TMPDIR ?? '/tmp'}/normie-test-${process.pid}-${Date.now()}.sqlite`;
    let c = await createCore({ provider: p, extractText: fakeExtractText, now: () => NOW, dbPath });
    await c.engine.syncOnce();
    const before = c.data.mailboxState(c.data.store.db.prepare('select id from accounts').pluck().get() as string, '[Gmail]/All Mail');
    await c.close();
    p.setFlags(1, { flags: [String.raw`\Seen`] });
    c = core = await createCore({ provider: p, extractText: fakeExtractText, now: () => NOW, dbPath });
    expect(c.data.mailboxState('gmail:me@example.com', '[Gmail]/All Mail')).toEqual(before);
    p.calls.length = 0;
    await c.engine.syncHeaders();
    // Resumed from the stored modseq: an incremental fetch, not a full resync.
    expect((await c.rows('inbox'))[0]!.unread).toBe(false);
    expect(c.data.store.db.prepare('select count(*) from messages').pluck().get()).toBe(1);
  });

  it('checks again on a poll even without an IDLE event', async () => {
    const { p, c } = await live(GMAIL_CAPS);
    // A change on a mailbox other than the Inbox raises no IDLE event on the Inbox.
    p.addMailbox({ path: 'Elsewhere' });
    const pass = c.engine.nextPass();
    p.deliver({ subject: 'Labelled elsewhere', labels: [String.raw`\Inbox`], date: NOW - 1000 });
    c.engine.pollNow();
    await pass;
    expect(await subjects(c)).toContain('Labelled elsewhere');
  });
});
