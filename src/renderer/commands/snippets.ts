// Snippets: reusable text from snippets.json in the app's data folder. Pure, so it's testable.
//   { "thanks": "Thanks so much!", "sig": { "name": "Signature", "text": "Chris\nSent from Normie" } }
// Typing ;thanks then Tab in the body expands it; the palette inserts one by name.

export interface Snippet {
  trigger: string;
  name: string;
  text: string;
}

const TRIGGER = /^[a-z0-9][a-z0-9_-]*$/i;

export function parseSnippets(file: unknown): { snippets: Snippet[]; problems: string[] } {
  const problems: string[] = [];
  if (file === undefined || file === null) return { snippets: [], problems };
  if (typeof file !== 'object' || Array.isArray(file)) return { snippets: [], problems: ['snippets.json must be a JSON object of triggers to text.'] };
  const snippets: Snippet[] = [];
  for (const [trigger, value] of Object.entries(file as Record<string, unknown>)) {
    if (!TRIGGER.test(trigger)) {
      problems.push(`"${trigger}": a trigger is letters, digits, - and _ only.`);
      continue;
    }
    if (typeof value === 'string') snippets.push({ trigger, name: trigger, text: value });
    else if (value && typeof value === 'object' && typeof (value as Snippet).text === 'string') {
      const v = value as { name?: unknown; text: string };
      snippets.push({ trigger, name: typeof v.name === 'string' && v.name ? v.name : trigger, text: v.text });
    } else problems.push(`"${trigger}": give the text as a string, or as { "name": …, "text": … }.`);
  }
  return { snippets, problems };
}

/**
 * Expand ";trigger" just before the cursor. Returns the new text and cursor, or null when there's nothing to expand
 * (so Tab can do what it normally does).
 */
export function expandAt(text: string, cursor: number, snippets: readonly Snippet[]): { text: string; cursor: number } | null {
  const m = /(?:^|[\s(])(;([a-z0-9][a-z0-9_-]*))$/i.exec(text.slice(0, cursor));
  if (!m) return null;
  const snippet = snippets.find((s) => s.trigger.toLowerCase() === m[2]!.toLowerCase());
  if (!snippet) return null;
  const start = cursor - m[1]!.length;
  return { text: text.slice(0, start) + snippet.text + text.slice(cursor), cursor: start + snippet.text.length };
}

/** Insert text at the cursor (replacing any selection). */
export function insertAt(text: string, start: number, end: number, insert: string): { text: string; cursor: number } {
  return { text: text.slice(0, start) + insert + text.slice(end), cursor: start + insert.length };
}
