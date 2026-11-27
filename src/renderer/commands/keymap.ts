// The user's keymap: a JSON file of overrides laid over the registry's default keys. Pure, so it's testable.
//   { "thread.done": "e", "undo": ["z", "Cmd-Z"], "thread.star": [] }
// Each entry replaces that action's keys; [] unbinds it. Problems are reported and skipped, never fatal.
import { isRecord } from '../dom';
import type { ActionDef } from './keys';

export interface KeymapResult<A extends ActionDef> {
  actions: Array<A>;
  problems: Array<string>;
}

const MODIFIERS = ['Cmd', 'Alt', 'Shift'] as const;

/** One key press written the way tokenOf names it: "cmd-shift-d" → "Cmd-Shift-D", "shift-h" → "Shift-H". Null if malformed. */
export function normalizeToken(raw: string): string | null {
  raw = raw.trim();
  if (raw === '-') {
    return '-';
  }
  const parts = raw.split('-');
  // "-" alone, or a trailing "-" key as in "Cmd--".
  if (raw.endsWith('-') && raw.length > 1) {
    parts.splice(parts.length - 2, 2, '-');
  }
  const key = parts.pop();
  if (!key) {
    return null;
  }
  const mods = new Set<string>();
  for (const p of parts) {
    const m = MODIFIERS.find((x) => x.toLowerCase() === p.toLowerCase() || (x === 'Cmd' && /^(command|meta|ctrl|control)$/i.test(p)));
    if (!m) {
      return null;
    }
    mods.add(m);
  }
  const letter = /^[a-z]$/i.test(key);
  if (key.length > 1 && !/^[A-Z][A-Za-z0-9]*$/.test(key)) {
    return null;
  }
  if (!letter && key.length === 1 && mods.has('Shift')) {
    mods.delete('Shift');
  } // shifted symbols are their own character, like "#"
  const k = letter ? (mods.size ? key.toUpperCase() : key.toLowerCase()) : key;
  return [...MODIFIERS.filter((m) => mods.has(m)), k].join('-');
}

/** A key or sequence ("g i"): each press normalized. Null if any press is malformed. */
export function normalizeKey(raw: string): string | null {
  const presses = raw.trim().split(/\s+/).map(normalizeToken);
  return presses.length && presses.every(Boolean) ? presses.join(' ') : null;
}

const overlaps = (a: ActionDef, b: ActionDef) => a.contexts.some((c) => b.contexts.includes(c));

/** True when one key is the other, or a prefix of it ("g" and "g i"): the shorter one could never fire. */
const collide = (a: string, b: string) => a === b || b.startsWith(`${a} `) || a.startsWith(`${b} `);

export function mergeKeymap<A extends ActionDef>(defaults: ReadonlyArray<A>, file: unknown): KeymapResult<A> {
  const problems: Array<string> = [];
  if (file === undefined || file === null) {
    return { actions: [...defaults], problems };
  }
  if (!isRecord(file)) {
    return { actions: [...defaults], problems: ['The keymap must be a JSON object of action ids to keys.'] };
  }
  const byId = new Map(defaults.map((a) => [a.id, a]));
  /** User keys per action, in file order. */
  const user = new Map<string, Array<string>>();
  for (const [id, value] of Object.entries(file)) {
    if (!byId.has(id)) {
      problems.push(`Unknown action "${id}".`);
      continue;
    }
    const raw = typeof value === 'string' ? [value] : Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : null;
    if (!raw) {
      problems.push(`"${id}": keys must be a string or a list of strings.`);
      continue;
    }
    const keys: Array<string> = [];
    for (const r of raw) {
      const k = normalizeKey(r);
      if (!k) {
        problems.push(`"${id}": "${r}" isn't a key this app understands.`);
      } else {
        keys.push(k);
      }
    }
    // Two of the user's own bindings clash: the earlier one keeps the key.
    for (const [otherId, otherKeys] of user) {
      const other = byId.get(otherId);
      const mine = byId.get(id);
      if (!other || !mine || !overlaps(other, mine)) {
        continue;
      }
      // A copy: the loop takes clashing keys out of `keys` as it goes.
      // oxlint-disable-next-line unicorn/no-useless-spread
      for (const k of [...keys]) {
        const hit = otherKeys.find((o) => collide(o, k));
        if (hit) {
          problems.push(`"${id}": "${k}" clashes with "${hit}" for "${otherId}"; kept it for "${otherId}".`);
          keys.splice(keys.indexOf(k), 1);
        }
      }
    }
    user.set(id, keys);
  }
  // The user's keys win over defaults: a default that clashes with one is dropped, and said so.
  const actions = defaults.map((a) => {
    const own = user.get(a.id);
    if (own) {
      return { ...a, keys: own };
    }
    const keys = a.keys.filter((k) => {
      const by = [...user].find(([uid, uks]) => {
        const other = byId.get(uid);
        return !!other && overlaps(other, a) && uks.some((u) => collide(u, k));
      });
      if (by) {
        problems.push(`"${a.id}" lost its default key "${k}" to "${by[0]}".`);
      }
      return !by;
    });
    return { ...a, keys };
  });
  return { actions, problems };
}
