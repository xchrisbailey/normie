// The palette's matching and the labels it shows. Pure, so it's testable without a DOM.
import type { ActionDef, Context } from './keys';

/**
 * Fuzzy score of `query` against `text`: every query character must appear in order. Higher is better;
 * null when it doesn't match. Matches at word starts and runs of consecutive characters score higher,
 * so "md" finds "Mark Done" before "Command".
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return null;
    const wordStart = at === 0 || /[\s\-_/.:]/.test(t[at - 1]!);
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
export function rankItems<T extends PaletteItem>(query: string, items: readonly T[], limit = 50): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item, i) => ({ item, i, score: Math.max(fuzzyScore(query, item.name) ?? -Infinity, (fuzzyScore(query, item.keywords ?? '') ?? -Infinity) - 2) }))
    .filter((x) => x.score > -Infinity)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.item);
}

const KEY_GLYPHS: Record<string, string> = {
  Cmd: '⌘', Shift: '⇧', Alt: '⌥', Enter: '↩', Escape: 'Esc', ArrowDown: '↓', ArrowUp: '↑', ArrowLeft: '←', ArrowRight: '→', Tab: '⇥',
};

/** A key as the palette and menus show it: "Cmd-Shift-D" → "⌘⇧D", "g i" → "G I". */
export function keyLabel(key: string): string {
  return key
    .split(' ')
    .map((token) => token.split('-').map((p) => KEY_GLYPHS[p] ?? (p.length === 1 ? p.toUpperCase() : p)).join(''))
    .join(' ');
}

/** Registry actions as palette items, for one context. The first key is the one shown. */
export function actionItems(actions: readonly ActionDef[], context: Context, has: (id: string) => boolean = () => true): PaletteItem[] {
  const seen = new Set<string>();
  const out: PaletteItem[] = [];
  for (const a of actions) {
    if (!a.contexts.includes(context) || !has(a.id) || seen.has(a.name)) continue;
    seen.add(a.name);
    out.push({ id: a.id, name: a.name, ...(a.keys[0] ? { hint: keyLabel(a.keys[0]) } : {}) });
  }
  return out;
}
