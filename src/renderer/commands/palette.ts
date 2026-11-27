// The palette's matching and the labels it shows. Pure, so it's testable without a DOM.
import type { ActionDef, Context } from './keys';

/**
 * Fuzzy score of `query` against `text`: every query character must appear in order. Higher is better;
 * null when it doesn't match. Matches at word starts and runs of consecutive characters score higher,
 * so "md" finds "Mark Done" before "Command".
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replaceAll(/\s+/g, '');
  if (!q) {return 0;}
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) {return null;}
    const wordStart = at === 0 || /[\s\-_/.:]/.test(t.charAt(at - 1));
    run = at === ti && ti > 0 ? run + 1 : 0;
    score += 1 + (wordStart ? 8 : 0) + run * 4 - Math.min(at - ti, 10) * 0.5;
    ti = at + 1;
  }
  // Shorter names win ties: the query covers more of them.
  return score - t.length * 0.05;
}

export interface PaletteItem {
  id: string;
  name: string;
  /** Shown on the right, such as the action's key. */
  hint?: string;
  /** Searched too, but not shown: other words for the item. */
  keywords?: string;
}

/** Items matching the query, best first. An empty query keeps the given order. */
export function rankItems<T extends PaletteItem>(query: string, items: ReadonlyArray<T>, limit = 50): Array<T> {
  if (!query.trim()) {return items.slice(0, limit);}
  return items
    .flatMap((item, i) => {
      const score = Math.max(fuzzyScore(query, item.name) ?? -Infinity, (fuzzyScore(query, item.keywords ?? '') ?? -Infinity) - 2);
      return score > -Infinity ? [{ item, i, score }] : [];
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.item);
}

const KEY_GLYPHS = new Map([
  ['Cmd', '⌘'], ['Shift', '⇧'], ['Alt', '⌥'], ['Enter', '↩'], ['Escape', 'Esc'], ['ArrowDown', '↓'], ['ArrowUp', '↑'], ['ArrowLeft', '←'], ['ArrowRight', '→'], ['Tab', '⇥'],
]);

/** A key as the palette and menus show it: "Cmd-Shift-D" → "⌘⇧D", "g i" → "G I". */
export function keyLabel(key: string): string {
  return key
    .split(' ')
    .map((token) => token.split('-').map((p) => KEY_GLYPHS.get(p) ?? (p.length === 1 ? p.toUpperCase() : p)).join(''))
    .join(' ');
}

/** Registry actions as palette items, for one context. The first key is the one shown. */
export function actionItems(actions: ReadonlyArray<ActionDef>, context: Context, has: (id: string) => boolean = () => true): Array<PaletteItem> {
  const seen = new Set<string>();
  const out: Array<PaletteItem> = [];
  for (const a of actions) {
    if (!a.contexts.includes(context) || !has(a.id) || seen.has(a.name)) {continue;}
    seen.add(a.name);
    const item: PaletteItem = { id: a.id, name: a.name };
    if (a.keys[0]) {item.hint = keyLabel(a.keys[0]);}
    out.push(item);
  }
  return out;
}
