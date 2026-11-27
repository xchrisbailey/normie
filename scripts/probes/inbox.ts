// An example probe: the Inbox and its Splits' tags, the schema version, and a search, on the real store's copy.
// Copy this file to check a change against real mail (npm run real-copy -- scripts/probes/<yours>.ts).
import type { Store } from '../../src/core/store';

export default async function probe(store: Store) {
  const rows = store.rows('inbox');
  while (store.indexSearchBatch(2000));
  return {
    schema: store.db.pragma('user_version', { simple: true }),
    inbox: rows.length,
    newsletters: rows.filter((r) => r.tags?.newsletter).length,
    snoozed: rows.filter((r) => r.tags?.snoozedUntil).length,
    searchInvoice: store.search('invoice').length,
  };
}
