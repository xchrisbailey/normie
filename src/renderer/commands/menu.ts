// The native menus as a view over the registry. Pure data, so main can build menus from it and tests can check it.
import type { ActionDef } from './keys';

export interface MenuEntry {
  label: string;
  /** Actions with this label; the renderer runs the one that applies where the user is. */
  ids: string[];
  /** Electron accelerator. */
  accelerator?: string;
  /** False for plain keys: shown in the menu, but left to the page so typing in a field still works. */
  registerAccelerator: boolean;
}

export interface MenuSection {
  label: string;
  entries: MenuEntry[];
}

const ACCEL_KEYS: Record<string, string> = { ArrowDown: 'Down', ArrowUp: 'Up', ArrowLeft: 'Left', ArrowRight: 'Right', Cmd: 'CommandOrControl' };

/** A registry key as an Electron accelerator, or undefined for sequences such as "g i". */
export function acceleratorOf(key: string): string | undefined {
  if (key.includes(' ')) return undefined;
  const parts = key === '-' ? ['-'] : key.split('-');
  return parts.map((p) => ACCEL_KEYS[p] ?? (p.length === 1 ? p.toUpperCase() : p)).join('+');
}

const SECTION_OF = (id: string) =>
  id.startsWith('compose.') || id.startsWith('send.') ? 'Message'
  : id.startsWith('thread.') || id === 'undo' ? 'Thread'
  : id.startsWith('dev.') || id.startsWith('palette.') ? 'View' : 'Go';

/** Shortcuts the Edit menu owns (main builds it): shown on registry items, never registered twice. */
const EDIT_MENU_KEYS = new Set(['Cmd-Z', 'Cmd-Shift-Z', 'Cmd-X', 'Cmd-C', 'Cmd-V', 'Cmd-A']);

export function menuSections(actions: readonly ActionDef[]): MenuSection[] {
  const sections = new Map<string, MenuSection>();
  for (const label of ['Go', 'Thread', 'Message', 'View']) sections.set(label, { label, entries: [] });
  for (const a of actions) {
    const section = sections.get(SECTION_OF(a.id))!;
    const same = section.entries.find((e) => e.label === a.name);
    if (same) {
      same.ids.push(a.id);
      continue;
    }
    const key = a.keys.find((k) => acceleratorOf(k));
    const accelerator = key ? acceleratorOf(key) : undefined;
    section.entries.push({
      label: a.name, ids: [a.id], ...(accelerator ? { accelerator } : {}),
      registerAccelerator: !!key && key.startsWith('Cmd-') && !EDIT_MENU_KEYS.has(key),
    });
  }
  return [...sections.values()];
}
