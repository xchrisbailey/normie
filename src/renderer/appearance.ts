// The appearance on screen (font, size, density, width, motion): read from main before the first frame, painted as
// attributes and variables on the root, and saved back when Settings changes it. One store, so the list can follow
// the row height.
import { useSyncExternalStore } from 'react';
import { COLUMN_WIDTH, DEFAULT_APPEARANCE, ROW_HEIGHT } from '../core/appearance';
import type { Appearance } from '../core/appearance';

let current: Appearance = DEFAULT_APPEARANCE;
const listeners = new Set<() => void>();

/** Paint the page in an appearance. */
export function applyAppearance(a: Appearance) {
  current = a;
  const root = document.documentElement;
  root.dataset.family = a.family;
  root.dataset.font = a.font;
  root.style.setProperty('--fs', String(a.size / 13));
  root.style.setProperty('--column', `${COLUMN_WIDTH[a.width]}px`);
  root.style.setProperty('--row-h', `${ROW_HEIGHT[a.density]}px`);
  if (a.reduceMotion) {
    root.dataset.motion = 'reduced';
  } else {
    delete root.dataset.motion;
  }
  for (const fn of listeners) {
    fn();
  }
}

/** Change the appearance: on screen at once, then saved. */
export function setAppearance(change: Partial<Appearance>) {
  const next = { ...current, ...change };
  applyAppearance(next);
  void window.normie.appearance.set(next);
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

export const useAppearance = () => useSyncExternalStore(subscribe, () => current);

/** Whether to skip animations: the user asked to, or the system does. */
export const reducedMotion = () => current.reduceMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
