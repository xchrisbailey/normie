// Ids for outgoing mail. Small and dependency-free, so the data process can use it.
import type { Address } from './types';

/** A Message-ID for a new message, on the sender's domain. Kept with the Outbox row, so a retry reuses it. */
export function newMessageId(from: Address): string {
  const domain = from.address.split('@')[1] || 'normie.local';
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
  return `<${rand}.normie@${domain}>`;
}
