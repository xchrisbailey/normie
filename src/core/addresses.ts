// Address lists as people type them: "Ada <ada@example.com>, grace@example.com". Pure; no dependencies.
import type { Address } from './types';

const ADDRESS = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** Split on commas and semicolons outside quotes and angle brackets. */
function split(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = 0;
  for (const ch of input) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<' && !quoted) angle++;
    else if (ch === '>' && !quoted) angle = Math.max(0, angle - 1);
    if ((ch === ',' || ch === ';') && !quoted && !angle) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Parse a typed list. Entries that aren't addresses come back in `invalid`. */
export function parseAddresses(input: string): { addresses: Address[]; invalid: string[] } {
  const addresses: Address[] = [];
  const invalid: string[] = [];
  for (const part of split(input)) {
    const m = /^(.*)<([^>]+)>$/.exec(part);
    const address = (m ? m[2]! : part).trim();
    const name = m ? m[1]!.trim().replace(/^"(.*)"$/, '$1').trim() : '';
    if (!ADDRESS.test(address)) invalid.push(part);
    else addresses.push(name ? { name, address } : { address });
  }
  return { addresses, invalid };
}

/** An address list as it's shown in a field. */
export function formatAddresses(list: Address[]): string {
  return list.map((a) => (a.name ? `${/[,;"]/.test(a.name) ? `"${a.name.replace(/"/g, '')}"` : a.name} <${a.address}>` : a.address)).join(', ');
}
