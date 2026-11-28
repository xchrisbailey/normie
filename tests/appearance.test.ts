// Appearance from settings.json: each part checked on its own, so one bad value doesn't cost the rest.
import { expect, it } from 'vitest';
import { appearanceFrom, DEFAULT_APPEARANCE } from '../src/core/appearance';

it('reads a saved appearance', () => {
  const saved = { family: 'geist', font: 'mono', size: 16, density: 'roomy', width: 'narrow', reduceMotion: true };
  expect(appearanceFrom(saved)).toEqual(saved);
});

it('keeps the default for each part that is missing or unknown', () => {
  expect(appearanceFrom(undefined)).toEqual(DEFAULT_APPEARANCE);
  expect(appearanceFrom('serif')).toEqual(DEFAULT_APPEARANCE);
  expect(appearanceFrom({ font: 'comic', size: 40, density: 'compact', reduceMotion: 'yes' })).toEqual({ ...DEFAULT_APPEARANCE, density: 'compact' });
});

it('reads Katagami and its faces, and keeps Geist to the faces it draws', () => {
  expect(appearanceFrom({ family: 'katagami', font: 'round' })).toMatchObject({ family: 'katagami', font: 'round' });
  expect(appearanceFrom({ family: 'katagami', font: 'text' })).toMatchObject({ family: 'katagami', font: 'text' });
  // Saved before there were families: Geist, as it was.
  expect(appearanceFrom({ font: 'serif' })).toMatchObject({ family: 'geist', font: 'serif' });
  expect(appearanceFrom({ family: 'geist', font: 'round' })).toMatchObject({ family: 'geist', font: 'sans' });
  expect(appearanceFrom({ family: 'comic', font: 'mono' })).toMatchObject({ family: 'geist', font: 'mono' });
});
