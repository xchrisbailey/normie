// The native menus as a view over the registry. Pure data, so main can build menus from it and tests can check it.
import { expected } from '../../core/errors';
import type { ActionDef } from './keys';

export interface MenuEntry {
  label: string;
  /** Actions with this label; the renderer runs the one that applies where the user is. */
  ids: Array<string>;
  /** Electron accelerator. */
  accelerator?: string;
  /** Whether the accelerator is a real one (always, now: only Cmd shortcuts get one). */
  registerAccelerator: boolean;
}

export interface MenuSection {
  label: string;
  entries: Array<MenuEntry>;
}

const ACCEL_KEYS = new Map([['ArrowDown', 'Down'], ['ArrowUp', 'Up'], ['ArrowLeft', 'Left'], ['ArrowRight', 'Right'], ['Cmd', 'CommandOrControl']]);

/** A registry key as an Electron accelerator, or undefined for sequences such as "g i". */
export function acceleratorOf(key: string): string | undefined {
  if (key.includes(' ')) {return undefined;}
  const parts = key === '-' ? ['-'] : key.split('-');
  return parts.map((p) => ACCEL_KEYS.get(p) ?? (p.length === 1 ? p.toUpperCase() : p)).join('+');
}

const SECTION_OF = (id: string) =>
  id.startsWith('compose.') || id.startsWith('send.') ? 'Message'
  : id.startsWith('thread.') || id === 'undo' ? 'Thread'
  : /^(dev|palette|help|theme|app)\./.test(id) ? 'View' : 'Go';

/** Shortcuts the Edit menu owns (main builds it): shown on registry items, never registered twice. */
const EDIT_MENU_KEYS = new Set(['Cmd-Z', 'Cmd-Shift-Z', 'Cmd-X', 'Cmd-C', 'Cmd-V', 'Cmd-A']);

export function menuSections(actions: ReadonlyArray<ActionDef>): Array<MenuSection> {
  const sections = new Map<string, MenuSection>();
  for (const label of ['Go', 'Thread', 'Message', 'View']) {sections.set(label, { label, entries: [] });}
  for (const a of actions) {
    const section = expected(sections.get(SECTION_OF(a.id)), 'a section for the action');
    const same = section.entries.find((e) => e.label === a.name);
    if (same) {
      same.ids.push(a.id);
      continue;
    }
    // Only Cmd shortcuts go in the menus. A plain key there becomes a macOS key equivalent: when the page is slow to
    // answer a key press (fast typing), Chromium hands the key to the menu, which then runs the action even though
    // the key was typed into a field. Plain keys are listed by ? and the palette instead.
    const key = a.keys.find((k) => k.startsWith('Cmd-') && !EDIT_MENU_KEYS.has(k) && acceleratorOf(k));
    const accelerator = key ? acceleratorOf(key) : undefined;
    const entry: MenuEntry = { label: a.name, ids: [a.id], registerAccelerator: !!accelerator };
    if (accelerator) {entry.accelerator = accelerator;}
    section.entries.push(entry);
  }
  return [...sections.values()];
}
