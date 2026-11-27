// Drafts (#42): saved as you type, kept on the server in Drafts, gone when sent or discarded. At the core seam.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore, type TestCore } from '../src/core/core';
import { FakeProvider, FakeTransport, fakeExtractText } from '../src/core/fake-provider';
import type { DraftContent } from '../src/core/types';

const cores: TestCore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let now = Date.UTC(2026, 10, 27, 12);
const ACCOUNT = 'gmail:me@example.com';
async function start(provider = new FakeProvider(), dbPath?: string) {
  const c = await createCore({
    provider, transport: new FakeTransport(), extractText: fakeExtractText, now: () => (now += 1), accountId: ACCOUNT, dbPath, draftDebounceMs: 60_000,
  });
  cores.push(c);
  await c.engine.syncOnce();
  return { c, provider };
}
const draft = (over: Partial<DraftContent> = {}): DraftContent => ({
  accountId: ACCOUNT, from: { address: 'me@example.com' }, to: 'Ada <ada@example.com>, half-typed@', cc: '', bcc: '', subject: 'Plans', body: 'Thinking about…', ...over,
});

describe('drafts', () => {
  it('are saved here at once and listed', async () => {
    const { c } = await start();
    const id = await c.saveDraft(null, draft());
    expect(await c.drafts()).toEqual([{ id, accountId: ACCOUNT, subject: 'Plans', to: 'Ada <ada@example.com>, half-typed@', updatedAt: expect.any(Number) }]);
    expect(await c.draft(id)).toMatchObject({ to: 'Ada <ada@example.com>, half-typed@', body: 'Thinking about…' });
  });

  it('go to the Drafts mailbox, and each new version replaces the last', async () => {
    const { c, provider } = await start();
    const id = await c.saveDraft(null, draft());
    await c.engine.syncDrafts();
    expect(provider.contents('[Gmail]/Drafts')).toEqual([{ uid: 1, subject: 'Plans', flags: ['\\Draft', '\\Seen'] }]);
    expect(provider.appends[0]!.raw).toMatch(/^To: Ada <ada@example\.com>$/m);

    await c.saveDraft(id, draft({ subject: 'Plans for Friday' }));
    await c.engine.syncDrafts();
    expect(provider.contents('[Gmail]/Drafts')).toEqual([{ uid: 2, subject: 'Plans for Friday', flags: ['\\Draft', '\\Seen'] }]);

    // Nothing new: nothing sent.
    await c.engine.syncDrafts();
    expect(provider.appends).toHaveLength(2);
  });

  it('are gone, here and on the server, once sent', async () => {
    const { c, provider } = await start();
    const id = await c.saveDraft(null, draft());
    await c.engine.syncDrafts();
    await c.send({ accountId: ACCOUNT, from: { address: 'me@example.com' }, to: [{ address: 'ada@example.com' }], cc: [], bcc: [], subject: 'Plans', body: 'Done.' }, id);
    expect(await c.drafts()).toEqual([]);
    await c.engine.syncDrafts();
    expect(provider.contents('[Gmail]/Drafts')).toEqual([]);
  });

  it('are gone when discarded', async () => {
    const { c, provider } = await start();
    const id = await c.saveDraft(null, draft());
    await c.engine.syncDrafts();
    await c.deleteDraft(id);
    await c.engine.syncDrafts();
    expect(await c.drafts()).toEqual([]);
    expect(provider.removed).toEqual([{ mailbox: '[Gmail]/Drafts', uids: [1] }]);
  });

  it('never show up as messages in a Thread', async () => {
    const { c } = await start();
    await c.saveDraft(null, draft());
    await c.engine.syncDrafts();
    await c.engine.syncOnce();
    expect(await c.rows('inbox')).toEqual([]);
  });

  it('survive a restart, attachments too', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'normie-drafts-'));
    dirs.push(dir);
    const db = path.join(dir, 'store.sqlite');
    const provider = new FakeProvider();
    const first = await start(provider, db);
    const id = await first.c.saveDraft(null, draft({ attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: new TextEncoder().encode('hi') }] }));
    await first.c.close();
    cores.splice(cores.indexOf(first.c), 1);
    const second = await start(provider, db);
    const back = await second.c.draft(id);
    expect(back?.subject).toBe('Plans');
    expect(new TextDecoder().decode(back!.attachments![0]!.content)).toBe('hi');
  });
});
