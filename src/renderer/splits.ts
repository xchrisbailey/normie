// The Splits: tabs over the Unified Inbox, from local rules over each row's tags. Pure.
// splits.json (in the app's data folder) can reorder, rename, hide and add them:
//   [ { "id": "important", "notify": true },
//     { "id": "work", "name": "Work", "from": ["@acme.com"], "newsletter": false },
//     { "id": "newsletters" }, { "id": "accounts" } ]
// Listed tabs show in that order; built-ins left out are hidden. Inbox is always first.
import { expected } from '../core/errors';
import type { ThreadRow } from '../core/types';
import { isRecord } from './dom';

export interface SplitDef {
  id: string;
  name: string;
  match: (r: ThreadRow) => boolean;
  /** New mail here shows a notification (#62). */
  notify: boolean;
}

const t = (r: ThreadRow) => r.tags ?? { newsletter: false, vip: false, known: false };
const isSnoozed = (r: ThreadRow) => r.tags?.snoozedUntil !== undefined;

/** Snoozed Threads wait in their own tab, always the last; every other tab leaves them out. */
const SNOOZED_SPLIT: SplitDef = { id: 'snoozed', name: 'Snoozed', match: isSnoozed, notify: false };
const awake = (s: SplitDef): SplitDef => ({ ...s, match: (r) => !isSnoozed(r) && s.match(r) });

const BUILT_IN = new Map<string, Omit<SplitDef, 'id'>>([
  ['inbox', { name: 'Inbox', match: () => true, notify: false }],
  ['important', { name: 'Important', match: (r) => !t(r).newsletter && (t(r).vip || t(r).known), notify: true }],
  ['other', { name: 'Other', match: (r) => !t(r).newsletter && !t(r).vip && !t(r).known, notify: false }],
  ['newsletters', { name: 'Newsletters', match: (r) => t(r).newsletter, notify: false }],
  ['vip', { name: 'VIP', match: (r) => t(r).vip, notify: false }],
]);

const accountSplits = (accounts: Array<{ id: string; name: string }>, notify = false): Array<SplitDef> =>
  accounts.length > 1 ? accounts.map((a) => ({ id: `account:${a.id}`, name: a.name, match: (r: ThreadRow) => r.accountId === a.id, notify })) : [];

/**
 * Inbox (everything), Important (VIPs and people I've written to, not newsletters), Other (the rest of the
 * non-newsletters), Newsletters, VIP; then one per Account when there's more than one. A Thread can be in several.
 */
export function builtInSplits(accounts: Array<{ id: string; name: string }>): Array<SplitDef> {
  return [...[...[...BUILT_IN].map(([id, d]) => ({ id, ...d })), ...accountSplits(accounts)].map(awake), SNOOZED_SPLIT];
}

const RULE_KEYS = ['from', 'account', 'label', 'newsletter', 'vip'] as const;
const KNOWN_KEYS = new Set<string>(['id', 'name', 'notify', ...RULE_KEYS]);
const strings = (v: unknown): Array<string> | null => (typeof v === 'string' ? [v] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null);

export interface SplitsResult {
  splits: Array<SplitDef>;
  problems: Array<string>;
}

/** The Splits from splits.json (none: the built-ins), and what was wrong with it. */
export function splitsFrom(file: unknown, accounts: Array<{ id: string; name: string }>): SplitsResult {
  if (file === undefined || file === null) {
    return { splits: builtInSplits(accounts), problems: [] };
  }
  if (!Array.isArray(file)) {
    return { splits: builtInSplits(accounts), problems: ['splits.json must be a list of Splits, in the order of the tabs.'] };
  }
  const problems: Array<string> = [];
  const out: Array<SplitDef> = [];
  const seen = new Set<string>();
  const entries: Array<unknown> = file;
  for (const [i, entry] of entries.entries()) {
    const where = `Split ${i + 1}`;
    if (!isRecord(entry)) {
      problems.push(`${where}: give it as { "id": … }.`);
      continue;
    }
    const e = entry;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    if (!/^[a-z0-9-]+$/.test(id)) {
      problems.push(`${where}: "id" is lowercase letters, digits and -.`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`"${id}" is listed twice; the first one is kept.`);
      continue;
    }
    for (const k of Object.keys(e)) {
      if (!KNOWN_KEYS.has(k)) {
        problems.push(`"${id}": unknown setting "${k}".`);
      }
    }
    const notify = typeof e.notify === 'boolean' ? e.notify : undefined;
    const name = typeof e.name === 'string' && e.name.trim() ? e.name.trim() : undefined;
    const hasRules = RULE_KEYS.some((k) => k in e);
    if (id === 'snoozed') {
      problems.push('"snoozed" is always the last tab; leave it out.');
      continue;
    }
    if (id === 'accounts') {
      seen.add(id);
      out.push(...accountSplits(accounts, notify ?? false));
      continue;
    }
    const builtIn = BUILT_IN.get(id);
    if (builtIn) {
      if (hasRules) {
        problems.push(`"${id}" is built in; its rules can't change (make your own Split instead).`);
        continue;
      }
      seen.add(id);
      const split: SplitDef = { id, ...builtIn };
      if (name) {
        split.name = name;
      }
      if (notify !== undefined) {
        split.notify = notify;
      }
      out.push(split);
      continue;
    }
    if (!name) {
      problems.push(`"${id}": a Split of your own needs a "name".`);
      continue;
    }
    const tests: Array<(r: ThreadRow) => boolean> = [];
    let bad = false;
    if ('from' in e) {
      const from = strings(e.from)?.map((f) => f.trim().toLowerCase());
      if (!from) {
        bad = !!problems.push(`"${id}": "from" is an address, "@domain", or a list of them.`);
      } else {
        tests.push((r) => {
          const sender = t(r).sender;
          return !!sender && from.some((f) => (f.startsWith('@') ? sender.endsWith(f) : sender === f));
        });
      }
    }
    if ('account' in e) {
      const want = typeof e.account === 'string' ? e.account.trim().toLowerCase() : '';
      const acct = accounts.find((a) => a.id.toLowerCase() === want || a.name.toLowerCase() === want);
      if (!acct) {
        bad = !!problems.push(`"${id}": no Account "${String(e.account)}".`);
      } else {
        tests.push((r) => r.accountId === acct.id);
      }
    }
    if ('label' in e) {
      const labels = strings(e.label)?.map((l) => l.toLowerCase());
      if (!labels) {
        bad = !!problems.push(`"${id}": "label" is a Label name or a list of them.`);
      } else {
        tests.push((r) => (t(r).labels ?? []).some((l) => labels.includes(l.toLowerCase())));
      }
    }
    for (const flag of ['newsletter', 'vip'] as const) {
      if (!(flag in e)) {
        continue;
      }
      if (typeof e[flag] !== 'boolean') {
        bad = !!problems.push(`"${id}": "${flag}" is true or false.`);
      } else {
        const want = e[flag];
        tests.push((r) => t(r)[flag] === want);
      }
    }
    // A Split with a broken rule would show the wrong mail: leave it out until it's fixed.
    if (bad) {
      continue;
    }
    seen.add(id);
    out.push({ id, name, notify: notify ?? false, match: (r) => tests.every((f) => f(r)) });
  }
  // The Unified Inbox is always the first tab, and Snoozed the last.
  const inbox = out.find((s) => s.id === 'inbox') ?? { id: 'inbox', ...expected(BUILT_IN.get('inbox'), 'the built-in Inbox') };
  return { splits: [inbox, ...out.filter((s) => s.id !== 'inbox')].map(awake).concat(SNOOZED_SPLIT), problems };
}

/** What a Split's tab shows: how many Threads, whether any is unread, and its newest few for the peek. */
export interface SplitSummary {
  count: number;
  unread: boolean;
  newest: Array<ThreadRow>;
}

/** Each Split's summary, in one pass over the rows (newest first, as the list keeps them). */
export function splitSummaries(splits: Array<SplitDef>, rows: Array<ThreadRow>, peek = 3): Map<string, SplitSummary> {
  const out = new Map(splits.map((s): [string, SplitSummary] => [s.id, { count: 0, unread: false, newest: [] }]));
  for (const r of rows) {
    for (const s of splits) {
      const sum = out.get(s.id);
      if (sum && s.match(r)) {
        sum.count++;
        sum.unread ||= r.unread;
        if (sum.newest.length < peek) {
          sum.newest.push(r);
        }
      }
    }
  }
  return out;
}

/** Each Split's count, in one pass over the rows. */
export function splitCounts(splits: Array<SplitDef>, rows: Array<ThreadRow>): Map<string, number> {
  return new Map([...splitSummaries(splits, rows, 0)].map(([id, s]) => [id, s.count]));
}
