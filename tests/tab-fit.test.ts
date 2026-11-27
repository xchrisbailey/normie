// The header row: Split tabs that fit, the rest in More.
import { describe, expect, it } from 'vitest';
import { splitTabs, tabsThatFit } from '../src/renderer/tab-fit';

const ids = (r: ReturnType<typeof splitTabs<{ id: string }>>) => [r.shown.map((s) => s.id), r.more.map((s) => s.id)];

describe('the Split tabs in the header', () => {
  it('shows every tab that fits, keeping room for More when some do not', () => {
    expect(tabsThatFit([80, 80, 80], 244, 40, 2)).toBe(3);
    expect(tabsThatFit([80, 80, 80], 243, 40, 2)).toBe(2);
    expect(tabsThatFit([80, 80, 80], 120, 40, 2)).toBe(0);
  });

  it('always shows the open Split, in the last place that fits', () => {
    const splits = ['inbox', 'important', 'other', 'newsletters', 'snoozed'].map((id) => ({ id }));
    expect(ids(splitTabs(splits, 3, 'important'))).toEqual([
      ['inbox', 'important', 'other'],
      ['newsletters', 'snoozed'],
    ]);
    expect(ids(splitTabs(splits, 3, 'snoozed'))).toEqual([
      ['inbox', 'important', 'snoozed'],
      ['other', 'newsletters'],
    ]);
    expect(ids(splitTabs(splits, 0, 'other'))[0]).toEqual(['other']);
  });
});
