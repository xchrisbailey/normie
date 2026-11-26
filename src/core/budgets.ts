// Performance budgets from #3, in one place. The benchmark fails the build when one slips.
export const BUDGETS = {
  /** Move in the list (j, k) and switch Split: one frame. Checked at p95 over many presses. */
  keyMoveMs: 16,
  /**
   * Memory of every process with the 100,000-message fixture loaded, as macOS's physical footprint
   * (what Activity Monitor shows). Not the working set: that counts Electron's shared framework pages
   * once per process, which overstated the real figure by about 2.7x when measured (617 MB vs 227 MB).
   * Judged once the app settles: Chromium's GPU raster cache peaks while scrolling and frees itself when idle.
   */
  memoryMb: 400,
} as const;

export type BudgetName = keyof typeof BUDGETS;
