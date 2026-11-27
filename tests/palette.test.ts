// The palette's fuzzy ranking and the native menus, as views over the registry (#22).
import { describe, expect, it } from 'vitest';
import { acceleratorOf, menuSections } from '../src/renderer/commands/menu';
import { actionItems, fuzzyScore, keyLabel, rankItems } from '../src/renderer/commands/palette';
import { ACTIONS } from '../src/renderer/commands/registry';

const names = (q: string) => rankItems(q, actionItems(ACTIONS, 'list')).map((i) => i.name);

describe('fuzzy ranking', () => {
  it('matches characters in order, and only in order', () => {
    expect(fuzzyScore('mkdn', 'Mark Done')).not.toBeNull();
    expect(fuzzyScore('dm', 'Mark Done')).toBeNull();
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('puts word starts and exact prefixes first', () => {
    expect(names('done')[0]).toBe('Mark Done');
    expect(names('md')[0]).toBe('Mark Done');
    expect(names('star')[0]).toBe('Star or Unstar');
    expect(names('del')[0]).toBe('Delete');
    expect(names('un')[0]).toBe('Undo');
  });

  it('keeps registry order for an empty query and drops what does not match', () => {
    expect(names('')).toEqual(actionItems(ACTIONS, 'list').map((i) => i.name));
    expect(names('zzzz')).toEqual([]);
  });
});

describe('palette items', () => {
  it('offers every action that applies in a context, once per name, with its key', () => {
    for (const ctx of ['list', 'reader'] as const) {
      const items = actionItems(ACTIONS, ctx);
      const want = new Set(ACTIONS.filter((a) => (a.contexts as readonly string[]).includes(ctx)).map((a) => a.name));
      expect(new Set(items.map((i) => i.name))).toEqual(want);
    }
    expect(actionItems(ACTIONS, 'list').find((i) => i.id === 'thread.done')?.hint).toBe('E');
    expect(actionItems(ACTIONS, 'reader').some((i) => i.id === 'list.down')).toBe(false);
  });

  it('labels keys the Mac way', () => {
    expect(keyLabel('Cmd-Shift-D')).toBe('⌘⇧D');
    expect(keyLabel('g i')).toBe('G I');
    expect(keyLabel('#')).toBe('#');
    expect(keyLabel('Escape')).toBe('Esc');
  });
});

describe('native menus', () => {
  it('turns registry keys into accelerators', () => {
    expect(acceleratorOf('Cmd-K')).toBe('CommandOrControl+K');
    expect(acceleratorOf('Cmd-Shift-D')).toBe('CommandOrControl+Shift+D');
    expect(acceleratorOf('Shift-G')).toBe('Shift+G');
    expect(acceleratorOf('e')).toBe('E');
    expect(acceleratorOf('#')).toBe('#');
    expect(acceleratorOf('ArrowDown')).toBe('Down');
    expect(acceleratorOf('g i')).toBeUndefined();
  });

  it('lists every action once, registering only Cmd shortcuts so plain keys stay with the page', () => {
    const entries = menuSections(ACTIONS).flatMap((s) => s.entries);
    expect(entries.flatMap((e) => e.ids).sort()).toEqual(ACTIONS.map((a) => a.id).sort());
    expect(entries.find((e) => e.ids.includes('palette.open'))).toMatchObject({ accelerator: 'CommandOrControl+K', registerAccelerator: true });
    expect(entries.find((e) => e.ids.includes('thread.done'))).toMatchObject({ accelerator: 'E', registerAccelerator: false });
    // Next Thread in the list and in the reader is one menu item.
    expect(entries.find((e) => e.label === 'Next Thread')!.ids).toEqual(['list.down', 'reader.next']);
  });
});

describe('the ? sheet', () => {
  it('lists every action with a key, once per name, grouped like the menus, plus the composer keys', async () => {
    const { helpSections } = await import('../src/renderer/commands/help');
    const sections = helpSections(ACTIONS);
    const rows = sections.flatMap((s) => s.rows.map((r) => [s.title, r.name, r.keys.join(' ')]));
    expect(rows).toContainEqual(['Thread', 'Snooze', 'H']);
    expect(rows).toContainEqual(['Go', 'Next Thread', 'J ↓']);
    expect(rows).toContainEqual(['View', 'Show Keyboard Shortcuts', '?']);
    expect(rows).toContainEqual(['Go', "Show an Account's Tab", '1–9']);
    expect(sections.at(-1)!.title).toBe('Composer');
    // Actions without a key (Unmute, VIP) aren't listed.
    expect(rows.some((r) => r[1] === 'Add Sender to VIP')).toBe(false);
    const withKeys = new Set<string>(ACTIONS.filter((a) => a.keys.length && !/^Show Account \d$/.test(a.name)).map((a) => a.name));
    withKeys.add("Show an Account's Tab");
    expect(new Set(sections.slice(0, -1).flatMap((s) => s.rows.map((r) => r.name)))).toEqual(withKeys);
  });
});
