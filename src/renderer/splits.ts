// The Splits: tabs over the Unified Inbox, from local rules over each row's tags. Pure.
import type { ThreadRow } from '../core/types';

export interface SplitDef {
  id: string;
  name: string;
  match: (r: ThreadRow) => boolean;
}

const t = (r: ThreadRow) => r.tags ?? { newsletter: false, vip: false, known: false };

/**
 * Inbox (everything), Important (VIPs and people I've written to, not newsletters), Other (the rest of the
 * non-newsletters), Newsletters, VIP; then one per Account when there's more than one. A Thread can be in several.
 */
export function builtInSplits(accounts: { id: string; name: string }[]): SplitDef[] {
  const splits: SplitDef[] = [
    { id: 'inbox', name: 'Inbox', match: () => true },
    { id: 'important', name: 'Important', match: (r) => !t(r).newsletter && (t(r).vip || t(r).known) },
    { id: 'other', name: 'Other', match: (r) => !t(r).newsletter && !t(r).vip && !t(r).known },
    { id: 'newsletters', name: 'Newsletters', match: (r) => t(r).newsletter },
    { id: 'vip', name: 'VIP', match: (r) => t(r).vip },
  ];
  if (accounts.length > 1) for (const a of accounts) splits.push({ id: `account:${a.id}`, name: a.name, match: (r) => r.accountId === a.id });
  return splits;
}

/** Each Split's count, in one pass over the rows. */
export function splitCounts(splits: SplitDef[], rows: ThreadRow[]): Map<string, number> {
  const counts = new Map(splits.map((s) => [s.id, 0]));
  for (const r of rows) for (const s of splits) if (s.match(r)) counts.set(s.id, counts.get(s.id)! + 1);
  return counts;
}
