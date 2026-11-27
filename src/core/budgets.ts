// Performance budgets from #3, in one place. The benchmark fails the build when one slips.
export const BUDGETS = {
  /** Move in the list (j, k) and switch Split: one frame. Checked at p95 over many presses. */
  keyMoveMs: 16,
  /** Switch Split or Account filter: keydown to the frame with the new list. Checked at p95. */
  switchMs: 16,
  /** Triage (Done, star, Snooze): keydown to the frame with the list updated. Checked at p95. */
  triageMs: 16,
  /** Open the command palette (Cmd-K): keydown to the frame that shows it. Checked at p95. */
  paletteMs: 16,
  /** Local search over the 100,000-message fixture: query to Thread rows, in the data process. Checked at p95. */
  searchMs: 100,
  /** Launch to a usable inbox (first frame with rows) on Apple silicon, with a store and snapshot from before. Median of 5. */
  coldStartMs: 1500,
  /** Open a cached (prefetched) Thread: keydown to the frame that shows it. Checked at p95. */
  openCachedMs: 50,
  /**
   * Memory of every process with the 100,000-message fixture loaded, as macOS's physical footprint
   * (what Activity Monitor shows). Not the working set: that counts Electron's shared framework pages
   * once per process, which overstated the real figure by about 2.7x when measured (617 MB vs 227 MB).
   * Judged once the app settles: Chromium's GPU raster cache peaks while scrolling and frees itself when idle.
   */
  memoryMb: 400,
} as const;

export type BudgetName = keyof typeof BUDGETS;
