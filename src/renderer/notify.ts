// Which new mail deserves a notification: with `splits` (the default), Threads in a Split marked to notify; with `all`,
// any; with `off`, none. One per Thread per burst. Pure.
import type { ThreadRow } from '../core/types';
import type { NotifyChoice } from '../core/prefs';
import type { SplitDef } from './splits';

/** Another message in the same Thread within this long doesn't notify again. */
export const NOTIFY_QUIET_MS = 5 * 60_000;

export interface Notice {
  key: string;
  title: string;
  body: string;
}

export function toNotify(
  keys: Array<string>,
  rows: Array<ThreadRow>,
  splits: Array<SplitDef>,
  recent: Map<string, number>,
  now: number,
  choice: NotifyChoice = 'splits',
): Array<Notice> {
  const out: Array<Notice> = [];
  if (choice === 'off') {
    return out;
  }
  for (const key of new Set(keys)) {
    const row = rows.find((r) => r.key === key);
    if (!row || (choice === 'splits' && !splits.some((s) => s.notify && s.match(row)))) {
      continue;
    }
    const last = recent.get(key);
    if (last !== undefined && now - last < NOTIFY_QUIET_MS) {
      continue;
    }
    recent.set(key, now);
    out.push({ key, title: row.from || 'New mail', body: row.subject || '(no subject)' });
  }
  return out;
}
