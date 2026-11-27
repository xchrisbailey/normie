// The choices in Settings that change how the app behaves (see core/prefs): read from main at launch, kept in one
// store the app and Settings both follow, and saved back on each change.
import { useSyncExternalStore } from 'react';
import { DEFAULT_PREFS, hour12Of } from '../core/prefs';
import type { Prefs } from '../core/prefs';

let current: Prefs = DEFAULT_PREFS;
const listeners = new Set<() => void>();

const publish = (p: Prefs) => {
  current = p;
  for (const fn of listeners) {
    fn();
  }
};

/** The prefs saved last time, before the first frame. */
export function loadPrefs() {
  publish(window.normie.prefs.current());
}

/** Change a pref: in effect at once, then saved. */
export function setPrefs(change: Partial<Prefs>) {
  publish({ ...current, ...change });
  void window.normie.prefs.set(current);
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

export const usePrefs = () => useSyncExternalStore(subscribe, () => current);
/** The prefs now, for code outside React's render (event handlers, notices). */
export const prefsNow = () => current;
/** Intl's `hour12` for the clock choice. */
export const hour12 = () => hour12Of(current.clock);
