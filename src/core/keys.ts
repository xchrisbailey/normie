// Thread row keys across Accounts. No dependencies, so every process can use them.
import type { AccountId } from './types';

/**
 * A Thread's key across Accounts: "account:thread", with the Account id escaped so it never holds a colon
 * (real ids do, as in "gmail:me@example.com"). Thread keys themselves may contain colons.
 */
export function threadRowKey(accountId: AccountId, threadKey: string): string {
  return `${encodeURIComponent(accountId)}:${threadKey}`;
}

/** Splits a key made by threadRowKey into its parts. */
export function parseThreadKey(key: string) {
  const i = key.indexOf(':');
  return { accountId: decodeURIComponent(key.slice(0, i)), threadKey: key.slice(i + 1) };
}
