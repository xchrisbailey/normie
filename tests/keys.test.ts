import { describe, expect, it } from 'vitest';
import { KeyResolver, tokenOf } from '../src/renderer/commands/keys';
import type { KeyLike } from '../src/renderer/commands/keys';
import { ACTIONS } from '../src/renderer/commands/registry';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods });

describe('tokenOf', () => {
  it('names plain, shifted and command keys', () => {
    expect(tokenOf(key('j'))).toBe('j');
    expect(tokenOf(key('H', { shiftKey: true }))).toBe('Shift-H');
    expect(tokenOf(key('#', { shiftKey: true }))).toBe('#');
    expect(tokenOf(key('k', { metaKey: true }))).toBe('Cmd-K');
    expect(tokenOf(key('k', { ctrlKey: true }), 'linux')).toBe('Cmd-K');
    expect(tokenOf(key('Enter'))).toBe('Enter');
    expect(tokenOf(key('Shift', { shiftKey: true }))).toBeNull();
  });
});

describe('KeyResolver over the registry', () => {
  it('resolves every default key to its action', () => {
    for (const a of ACTIONS) {
      for (const k of a.keys) {
        const r = new KeyResolver(ACTIONS);
        const tokens = k.split(' ');
        let res;
        for (const t of tokens) {res = r.feed(t, a.contexts[0]);}
        expect(res, `${k} -> ${a.id}`).toEqual({ type: 'action', id: a.id });
      }
    }
  });

  it('holds a partial sequence, then resolves it', () => {
    const r = new KeyResolver(ACTIONS);
    expect(r.feed('g', 'list')).toEqual({ type: 'pending' });
    expect(r.feed('i', 'list')).toEqual({ type: 'action', id: 'go.inbox' });
  });

  it('drops a sequence after the timeout', () => {
    let t = 0;
    const r = new KeyResolver(ACTIONS, 1000, () => t);
    r.feed('g', 'list');
    t = 1500;
    expect(r.feed('i', 'list')).toEqual({ type: 'none' });
  });

  it('starts over when a sequence breaks', () => {
    const r = new KeyResolver(ACTIONS);
    r.feed('g', 'list');
    expect(r.feed('j', 'list')).toEqual({ type: 'action', id: 'list.down' });
  });

  it('ignores keys outside their context', () => {
    const r = new KeyResolver(ACTIONS);
    expect(r.feed('j', 'composer')).toEqual({ type: 'none' });
  });

  it('has no key bound twice in the same context', () => {
    const seen = new Map<string, string>();
    for (const a of ACTIONS) {for (const k of a.keys) for (const c of a.contexts) {
      const id = `${c}:${k}`;
      expect(seen.get(id), `${k} in ${c}`).toBeUndefined();
      seen.set(id, a.id);
    }}
  });
});
