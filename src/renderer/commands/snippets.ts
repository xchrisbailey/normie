// Snippets: reusable text from snippets.json in the app's data folder. Pure, so it's testable.
//   { "thanks": "Thanks so much!", "sig": { "name": "Signature", "text": "Chris\nSent from Normie" } }
// Typing ;thanks then Tab in the body expands it; the palette inserts one by name.
import { isRecord } from '../dom';

export interface Snippet {
  trigger: string;
  name: string;
  text: string;
}

const TRIGGER = /^[a-z0-9][a-z0-9_-]*$/i;

export interface ParsedSnippets {
  snippets: Array<Snippet>;
  problems: Array<string>;
}

/** The result of an edit to the text: the new text, and where the cursor goes. */
export interface TextEdit {
  text: string;
  cursor: number;
}

export function parseSnippets(file: unknown): ParsedSnippets {
  const problems: Array<string> = [];
  if (file === undefined || file === null) {
    return { snippets: [], problems };
  }
  if (!isRecord(file)) {
    return { snippets: [], problems: ['snippets.json must be a JSON object of triggers to text.'] };
  }
  const snippets: Array<Snippet> = [];
  for (const [trigger, value] of Object.entries(file)) {
    if (!TRIGGER.test(trigger)) {
      problems.push(`"${trigger}": a trigger is letters, digits, - and _ only.`);
      continue;
    }
    if (typeof value === 'string') {
      snippets.push({ trigger, name: trigger, text: value });
    } else if (isRecord(value) && typeof value.text === 'string') {
      snippets.push({ trigger, name: typeof value.name === 'string' && value.name ? value.name : trigger, text: value.text });
    } else {
      problems.push(`"${trigger}": give the text as a string, or as { "name": …, "text": … }.`);
    }
  }
  return { snippets, problems };
}

/**
 * Expand ";trigger" just before the cursor. Returns the new text and cursor, or null when there's nothing to expand
 * (so Tab can do what it normally does).
 */
export function expandAt(text: string, cursor: number, snippets: ReadonlyArray<Snippet>): TextEdit | null {
  const m = /(?:^|[\s(])(;([a-z0-9][a-z0-9_-]*))$/i.exec(text.slice(0, cursor));
  if (!m) {
    return null;
  }
  const snippet = snippets.find((s) => s.trigger.toLowerCase() === m[2]?.toLowerCase());
  if (!snippet) {
    return null;
  }
  const start = cursor - (m[1]?.length ?? 0);
  return { text: text.slice(0, start) + snippet.text + text.slice(cursor), cursor: start + snippet.text.length };
}

/** Insert text at the cursor (replacing any selection). */
export function insertAt(text: string, start: number, end: number, insert: string): TextEdit {
  return { text: text.slice(0, start) + insert + text.slice(end), cursor: start + insert.length };
}
