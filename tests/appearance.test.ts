// Appearance from settings.json: each part checked on its own, so one bad value doesn't cost the rest.
import { expect, it } from 'vitest';
import { appearanceFrom, DEFAULT_APPEARANCE } from '../src/core/appearance';

it('reads a saved appearance', () => {
  const saved = { font: 'mono', size: 16, density: 'roomy', width: 'narrow', reduceMotion: true };
  expect(appearanceFrom(saved)).toEqual(saved);
});

it('keeps the default for each part that is missing or unknown', () => {
  expect(appearanceFrom(undefined)).toEqual(DEFAULT_APPEARANCE);
  expect(appearanceFrom('serif')).toEqual(DEFAULT_APPEARANCE);
  expect(appearanceFrom({ font: 'comic', size: 40, density: 'compact', reduceMotion: 'yes' })).toEqual({ ...DEFAULT_APPEARANCE, density: 'compact' });
});
