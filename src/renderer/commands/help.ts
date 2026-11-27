// The ? sheet: every action that has a key, grouped as the menus are, plus the composer's own keys. Pure.
import type { ActionDef } from './keys';
import { menuSections } from './menu';
import { keyLabel } from './palette';

export interface HelpSection {
  title: string;
  rows: Array<{ name: string; keys: string[] }>;
}

/** Keys that live in the composer itself, not in the registry. */
const COMPOSER: HelpSection = {
  title: 'Composer',
  rows: [
    { name: 'Send', keys: ['⌘↩'] },
    { name: 'Send Later', keys: ['⌘⇧↩'] },
    { name: 'Remind Me If No Reply', keys: ['⌘⇧H'] },
    { name: 'Attach Files', keys: ['⌘⇧A'] },
    { name: 'Close, Keeping the Draft', keys: ['Esc'] },
    { name: 'Discard', keys: ['⌘⇧⌫'] },
    { name: 'Expand a Snippet', keys: [';name ⇥'] },
  ],
};

export function helpSections(actions: ReadonlyArray<ActionDef>): Array<HelpSection> {
  const byId = new Map(actions.map((a) => [a.id, a]));
  const sections = menuSections(actions).map((s) => ({
    title: s.label,
    rows: s.entries.flatMap((e) => {
      // Same-named actions (Next Thread in the list and in the reader) share one row, with every key once.
      const keys = [...new Set(e.ids.flatMap((id) => byId.get(id)?.keys ?? []))];
      return keys.length ? [{ name: e.label, keys: keys.map(keyLabel) }] : [];
    }),
  }));
  // The nine "Show Account n" rows read as one.
  for (const s of sections) {
    const accountRows = s.rows.filter((r) => /^Show Account \d$/.test(r.name));
    if (accountRows.length > 1) {
      const at = s.rows.indexOf(accountRows[0]!);
      s.rows = s.rows.filter((r) => !accountRows.includes(r));
      s.rows.splice(at, 0, { name: "Show an Account's Tab", keys: [`${accountRows[0]!.keys[0]}–${accountRows.at(-1)!.keys[0]}`] });
    }
  }
  return [...sections.filter((s) => s.rows.length), COMPOSER];
}
