// Prefs from settings.json: each part checked on its own, so one bad value doesn't cost the rest.
import { expect, it } from 'vitest';
import { DEFAULT_PREFS, fromKey, hour12Of, prefsFrom } from '../src/core/prefs';
import { describeWhen } from '../src/core/when';

it('reads saved prefs', () => {
  const saved = {
    markRead: 'manual',
    remoteImages: 'known',
    afterTriage: 'list',
    undoSend: 20,
    defaultFrom: fromKey('gmail:me@example.com', 'Me@Example.com'),
    notify: 'all',
    menuCount: 'unread',
    clock: '24',
  };
  expect(prefsFrom(saved)).toEqual({ ...saved, defaultFrom: 'gmail:me@example.com me@example.com' });
});

it('keeps the default for each part that is missing or unknown', () => {
  expect(prefsFrom(null)).toEqual(DEFAULT_PREFS);
  expect(prefsFrom({ undoSend: 7, notify: 'loud', clock: '12', defaultFrom: 3 })).toEqual({ ...DEFAULT_PREFS, clock: '12' });
});

it('reads times back in the chosen clock', () => {
  const now = new Date(2026, 10, 27, 9);
  const at = new Date(2026, 10, 27, 15, 30);
  expect(hour12Of('system')).toBeUndefined();
  expect(describeWhen(at, now, false)).toMatch(/^Today, 15:30$/);
  expect(describeWhen(at, now, true)).toMatch(/^Today, 3:30\sPM$/);
});
