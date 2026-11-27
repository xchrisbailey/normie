// Times in plain words (#76).
import { describe, expect, it } from 'vitest';
import { parseWhen, suggestions } from '../src/core/when';

// Friday 27 Nov 2026, 10:30 local time.
const NOW = new Date(2026, 10, 27, 10, 30);
const when = (s: string) => {
  const d = parseWhen(s, NOW);
  return d ? `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}` : null;
};

describe('plain-word times', () => {
  it('reads relative times', () => {
    expect(when('in 20 minutes')).toBe('2026-11-27 10:50');
    expect(when('2h')).toBe('2026-11-27 12:30');
    expect(when('in 3 days')).toBe('2026-11-30 10:30');
    expect(when('a week')).toBe('2026-12-4 10:30');
  });

  it('reads days, with or without a time', () => {
    expect(when('tomorrow')).toBe('2026-11-28 8:00');
    expect(when('tomorrow 9')).toBe('2026-11-28 9:00');
    expect(when('Tomorrow at 2:15pm')).toBe('2026-11-28 14:15');
    expect(when('tonight')).toBe('2026-11-27 20:00');
    expect(when('monday')).toBe('2026-11-30 8:00');
    expect(when('fri 9am')).toBe('2026-12-4 9:00');
    expect(when('next week')).toBe('2026-11-30 8:00');
    expect(when('this weekend')).toBe('2026-11-28 9:00');
    expect(when('next month')).toBe('2026-12-1 8:00');
  });

  it('reads a time alone as the next time it comes round', () => {
    expect(when('14:30')).toBe('2026-11-27 14:30');
    expect(when('9am')).toBe('2026-11-28 9:00');
    expect(when('at 3')).toBe('2026-11-27 15:00');
    expect(when('noon')).toBe('2026-11-27 12:00');
  });

  it('reads dates, rolling into next year when past', () => {
    expect(when('dec 3')).toBe('2026-12-3 8:00');
    expect(when('dec 3 8am')).toBe('2026-12-3 8:00');
    expect(when('dec 3 at 14:00')).toBe('2026-12-3 14:00');
    expect(when('3 december 8pm')).toBe('2026-12-3 20:00');
    expect(when('december 3rd at 9')).toBe('2026-12-3 9:00');
    expect(when('jan 5')).toBe('2027-1-5 8:00');
    expect(when('12/24')).toBe('2026-12-24 8:00');
    expect(when('2027-02-01 10:00')).toBe('2027-2-1 10:00');
  });

  it('refuses nonsense and the past', () => {
    for (const s of ['', 'whenever', 'feb 30', 'today 9am', '25:00', 'tomorrow at 13pm', '2026-11-01', 'blursday']) expect(when(s), s).toBeNull();
  });

  it('suggests the usual choices, all in the future', () => {
    const s = suggestions(NOW);
    expect(s.map((x) => x.label)).toEqual(['Later today', 'This evening', 'Tomorrow', 'Next week']);
    expect(s.every((x) => x.at > NOW)).toBe(true);
  });
});
