// The user keymap file laid over the registry (#23).
import { describe, expect, it } from 'vitest';
import { KeyResolver } from '../src/renderer/commands/keys';
import { mergeKeymap, normalizeKey } from '../src/renderer/commands/keymap';
import { ACTIONS } from '../src/renderer/commands/registry';

const keysOf = (actions: Array<{ id: string; keys: ReadonlyArray<string> }>, id: string) => actions.find((a) => a.id === id)!.keys;

describe('keymap file', () => {
  it('keeps the defaults when there is no file', () => {
    expect(mergeKeymap(ACTIONS, undefined)).toEqual({ actions: [...ACTIONS], problems: [] });
  });

  it('replaces an action’s keys, and the resolver uses them', () => {
    const { actions, problems } = mergeKeymap(ACTIONS, { 'thread.done': ['y', 'Cmd-Shift-E'], 'thread.star': [] });
    expect(problems).toEqual([]);
    expect(keysOf(actions, 'thread.done')).toEqual(['y', 'Cmd-Shift-E']);
    expect(keysOf(actions, 'thread.star')).toEqual([]);
    const r = new KeyResolver(actions);
    expect(r.feed('y', 'list')).toEqual({ type: 'action', id: 'thread.done' });
    expect(r.feed('e', 'list')).toEqual({ type: 'none' });
    expect(r.feed('s', 'list')).toEqual({ type: 'none' });
  });

  it('writes keys the way key presses are named', () => {
    expect(normalizeKey('cmd-shift-d')).toBe('Cmd-Shift-D');
    expect(normalizeKey('shift-h')).toBe('Shift-H');
    expect(normalizeKey('Shift-#')).toBe('#');
    expect(normalizeKey('G  I')).toBe('g i');
    expect(normalizeKey('ctrl-k')).toBe('Cmd-K');
    expect(normalizeKey('Hyper-x')).toBeNull();
    expect(normalizeKey('escape')).toBeNull();
  });

  it('gives a user key to the user: a default that clashes with it is dropped', () => {
    const { actions, problems } = mergeKeymap(ACTIONS, { 'thread.star': 'e' });
    expect(problems).toEqual(['"thread.done" lost its default key "e" to "thread.star".']);
    expect(keysOf(actions, 'thread.done')).toEqual([]);
    expect(new KeyResolver(actions).feed('e', 'list')).toEqual({ type: 'action', id: 'thread.star' });
  });

  it('reports unknown actions, bad values, bad keys and clashes, and skips just those', () => {
    const { actions, problems } = mergeKeymap(ACTIONS, {
      'thread.explode': 'x',
      'thread.mute': 42,
      'thread.done': ['y', 'Hyper-q'],
      'thread.star': 'y',
      'list.down': 'g',
    });
    expect(problems).toHaveLength(6);
    expect(problems.join('\n')).toMatch(/Unknown action "thread.explode"/);
    expect(problems.join('\n')).toMatch(/"thread.mute": keys must be/);
    expect(problems.join('\n')).toMatch(/"Hyper-q"/);
    expect(problems.join('\n')).toMatch(/"thread.star": "y" clashes/);
    // "g" would shadow "g g" and "g i": the user's key wins, and the lost defaults are reported.
    expect(problems.join('\n')).toMatch(/"list.top" lost its default key "g g"/);
    expect(problems.join('\n')).toMatch(/"go.inbox" lost its default key "g i"/);
    expect(keysOf(actions, 'list.top')).toEqual([]);
    expect(keysOf(actions, 'thread.done')).toEqual(['y']);
    expect(keysOf(actions, 'thread.star')).toEqual([]);
    expect(keysOf(actions, 'thread.mute')).toEqual(['m']);
  });

  it('rejects a file that is not an object', () => {
    expect(mergeKeymap(ACTIONS, ['e']).problems).toHaveLength(1);
    expect(mergeKeymap(ACTIONS, ['e']).actions).toEqual([...ACTIONS]);
  });

  it('lets the same key mean different things in contexts that never overlap', () => {
    const { problems } = mergeKeymap(ACTIONS, { 'list.open': 'x', 'reader.close': 'x' });
    expect(problems).toEqual([]);
  });
});
