// What the search box means: words (each must appear, as a prefix), "quoted phrases", and from:, to:, subject:.
// Turned into an FTS5 MATCH expression with every term quoted, so nothing typed is read as FTS syntax. Pure.

const FIELDS: Record<string, string> = { from: 'sender', to: 'recipients', subject: 'subject', cc: 'recipients' };

const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;

/** The MATCH expression, or null when there's nothing to search for. */
export function ftsQuery(input: string): string | null {
  const parts: Array<string> = [];
  const re = /(\w+):(?:"([^"]*)"|(\S+))|"([^"]*)"|(\S+)/g;
  for (const m of input.matchAll(re)) {
    const [, field, fieldPhrase, fieldWord, phrase, word] = m;
    const col = field ? FIELDS[field.toLowerCase()] : undefined;
    if (field && !col) {
      // Not an operator we know (a time, a URL): search for it as typed.
      const t = m[0].replaceAll(/[^\p{L}\p{N}@._:-]+/gu, ' ').trim();
      if (t) {parts.push(`${quote(t)}*`);}
      continue;
    }
    const text = (fieldPhrase ?? fieldWord ?? phrase ?? word ?? '').trim();
    if (!text || !/[\p{L}\p{N}]/u.test(text)) {continue;}
    // Phrases match exactly; words match as prefixes ("prop" finds "proposal").
    const term = phrase !== undefined || fieldPhrase !== undefined ? quote(text) : `${quote(text)}*`;
    parts.push(col ? `${col} : ${term}` : term);
  }
  return parts.length ? parts.join(' AND ') : null;
}

/** A search as servers take it: the text as typed (Gmail's X-GM-RAW reads the same operators), and its terms. */
export interface ServerQuery {
  raw: string;
  terms: Array<{ field?: 'from' | 'to' | 'subject'; text: string }>;
}

export function serverQuery(input: string): ServerQuery | null {
  const terms: ServerQuery['terms'] = [];
  for (const m of input.matchAll(/(\w+):(?:"([^"]*)"|(\S+))|"([^"]*)"|(\S+)/g)) {
    const [, field, fieldPhrase, fieldWord, phrase, word] = m;
    const f = field?.toLowerCase();
    const known = f === 'from' || f === 'to' || f === 'subject' ? f : f === 'cc' ? 'to' : undefined;
    const text = (known ? (fieldPhrase ?? fieldWord) : field ? m[0] : (phrase ?? word))?.trim();
    if (!text) {continue;}
    terms.push(known ? { field: known, text } : { text });
  }
  return terms.length ? { raw: input.trim(), terms } : null;
}
