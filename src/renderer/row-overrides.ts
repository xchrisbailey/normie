// Triage changes the rows in memory first; these overrides stay laid over the core's rows until the core has recorded
// the action, so a reload in between can't bring a Thread back. Held in an object of its own (not React state): it
// changes in event handlers and promise callbacks, and the code that does so also sets state to draw again.
import type { ThreadRow } from '../core/types';

export type RowChange = (r: ThreadRow) => ThreadRow | null;

export class RowOverrides {
  private readonly changes = new Map<string, RowChange>();
  /** Rows to show even when the core's rows don't have them yet: a Thread brought back by undo. */
  private readonly inserts = new Map<string, ThreadRow>();

  change(key: string): RowChange | undefined {
    return this.changes.get(key);
  }

  setChange(key: string, change: RowChange): void {
    this.changes.set(key, change);
  }

  /** Drop a Thread's change, unless something newer replaced it. */
  dropChange(key: string, change: RowChange): void {
    if (this.changes.get(key) === change) {
      this.changes.delete(key);
    }
  }

  insert(key: string): ThreadRow | undefined {
    return this.inserts.get(key);
  }

  setInsert(key: string, row: ThreadRow): void {
    this.inserts.set(key, row);
  }

  dropInsert(key: string, row: ThreadRow): void {
    if (this.inserts.get(key) === row) {
      this.inserts.delete(key);
    }
  }

  /** The rows with every change and insert laid over them. */
  apply(rows: Array<ThreadRow>): Array<ThreadRow> {
    if (!this.changes.size && !this.inserts.size) {
      return rows;
    }
    const out = rows.flatMap((row) => {
      const f = this.changes.get(row.key);
      const o = f ? f(row) : row;
      return o ? [o] : [];
    });
    for (const [key, row] of this.inserts) {
      if (out.some((x) => x.key === key)) {
        continue;
      }
      const at = out.findIndex((x) => x.date < row.date);
      out.splice(at < 0 ? out.length : at, 0, row);
    }
    return out;
  }
}
