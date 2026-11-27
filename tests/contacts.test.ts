// Address autocomplete (#44): who's suggested, in what order. At the core seam.
import { afterEach, describe, expect, it } from 'vitest';
import { createCore } from '../src/core/core';
import type { TestCore } from '../src/core/core';
import { FakeProvider, fakeExtractText } from '../src/core/fake-provider';

const NOW = Date.UTC(2026, 10, 27, 12);
const DAY = 86_400_000;
let core: TestCore | undefined;
afterEach(async () => {
  await core?.close();
  core = undefined;
});

const me = { name: 'Me', address: 'me@example.com' };
async function start(build: (p: FakeProvider) => void) {
  const p = new FakeProvider();
  build(p);
  core = await createCore({ provider: p, extractText: fakeExtractText, now: () => NOW, email: 'me@example.com' });
  await core.engine.syncOnce();
  return core;
}

describe('address suggestions', () => {
  it('puts people I have written to first, then the people who write often and lately', async () => {
    const c = await start((p) => {
      // Ada writes a lot but I never answer; Adam I wrote to once; Adele wrote once, long ago.
      for (let i = 0; i < 5; i++) {p.deliver({ subject: `News ${i}`, from: { name: 'Ada Newsletter', address: 'ada@news.example' }, date: NOW - i * DAY });}
      p.deliver({ subject: 'Hi', from: me, to: [{ name: 'Adam Smith', address: 'adam@example.com' }], date: NOW - 30 * DAY, labels: [String.raw`\Sent`] });
      p.deliver({ subject: 'Old', from: { name: 'Adele', address: 'adele@example.com' }, date: NOW - 300 * DAY });
    });
    expect((await c.contacts('ad')).map((a) => a.address)).toEqual(['adam@example.com', 'ada@news.example', 'adele@example.com']);
  });

  it('matches the start of the address or of any word in the name, and never suggests me', async () => {
    const c = await start((p) => {
      p.deliver({ subject: 'A', from: { name: 'Grace Hopper', address: 'ghopper@navy.example' }, to: [me], date: NOW - DAY });
      p.deliver({ subject: 'B', from: me, to: [{ address: 'team@example.com' }], date: NOW - DAY, labels: [String.raw`\Sent`] });
    });
    expect(await c.contacts('hop')).toEqual([{ name: 'Grace Hopper', address: 'ghopper@navy.example' }]);
    expect(await c.contacts('grace')).toEqual([{ name: 'Grace Hopper', address: 'ghopper@navy.example' }]);
    expect(await c.contacts('gh')).toEqual([{ name: 'Grace Hopper', address: 'ghopper@navy.example' }]);
    expect(await c.contacts('me')).toEqual([]);
    expect(await c.contacts('%')).toEqual([]);
  });

  it('learns from new mail as it syncs, and the full rebuild agrees', async () => {
    let provider!: FakeProvider;
    const c = await start((p) => (provider = p));
    expect(await c.contacts('lin')).toEqual([]);
    provider.deliver({ subject: 'Patch', from: { name: 'Linus', address: 'linus@kernel.example' }, date: NOW });
    await c.engine.syncOnce();
    expect(await c.contacts('lin')).toEqual([{ name: 'Linus', address: 'linus@kernel.example' }]);
    c.data.store.rebuildContacts();
    expect(await c.contacts('lin')).toEqual([{ name: 'Linus', address: 'linus@kernel.example' }]);
  });
});

describe('Identities and suggestions', () => {
  it('never suggests any of my Identities, and counts mail from them as sent', async () => {
    const p = new FakeProvider();
    p.deliver({ subject: 'Hi', from: { address: 'chris@srcery.example' }, to: [{ name: 'Zoe', address: 'zoe@example.com' }], date: NOW - DAY, labels: [String.raw`\Sent`] });
    p.deliver({ subject: 'News', from: { name: 'Zed', address: 'zed@news.example' }, date: NOW - DAY });
    core = await createCore({ provider: p, extractText: fakeExtractText, now: () => NOW, email: 'me@example.com', identities: ['me@example.com', 'chris@srcery.example'] });
    await core.engine.syncOnce();
    expect(await core.contacts('chris')).toEqual([]);
    expect((await core.contacts('z')).map((a) => a.address)).toEqual(['zoe@example.com', 'zed@news.example']);
  });
});
