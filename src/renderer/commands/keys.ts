// Key handling: turns keydown events into tokens and resolves tokens (and sequences such as "g i")
// to registry actions. Pure, so it's testable without a DOM.

export type Context = 'list' | 'reader' | 'composer';

export interface ActionDef {
  id: string;
  /** Shown in the palette and menus. */
  name: string;
  /** Default keys. Each entry is a token or a space-separated sequence, e.g. "j", "Shift-H", "Cmd-K", "g i". */
  keys: readonly string[];
  /** Contexts where the keys work. */
  contexts: readonly Context[];
}

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

const MODIFIER_KEYS = new Set(['Shift', 'Meta', 'Control', 'Alt', 'CapsLock']);

/**
 * One token per key press. Cmd on the Mac is Ctrl elsewhere, so both come out as "Cmd".
 * A shifted letter becomes "Shift-H"; shifted symbols keep their own character ("#").
 */
export function tokenOf(e: KeyLike, platform = 'darwin'): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const cmd = platform === 'darwin' ? e.metaKey : e.ctrlKey;
  let key = e.key.length === 1 ? e.key : e.key;
  const parts: string[] = [];
  if (cmd) parts.push('Cmd');
  if (e.altKey) parts.push('Alt');
  const isLetter = /^[a-z]$/i.test(key);
  if (e.shiftKey && (isLetter || key.length > 1)) parts.push('Shift');
  if (isLetter) key = parts.length ? key.toUpperCase() : key.toLowerCase();
  return [...parts, key].join('-');
}

export type Resolution = { type: 'action'; id: string } | { type: 'pending' } | { type: 'none' };

/** Resolves tokens to actions, holding a partial sequence until it completes, fails or times out. */
export class KeyResolver {
  private bindings: { seq: string[]; id: string; contexts: readonly Context[] }[] = [];
  private pending: string[] = [];
  private pendingAt = 0;

  constructor(actions: readonly ActionDef[], private readonly timeoutMs = 1000, private readonly now = () => performance.now()) {
    for (const a of actions) for (const k of a.keys) this.bindings.push({ seq: k.split(' '), id: a.id, contexts: a.contexts });
  }

  feed(token: string, context: Context): Resolution {
    if (this.pending.length && this.now() - this.pendingAt > this.timeoutMs) this.pending = [];
    const seq = [...this.pending, token];
    const live = this.bindings.filter((b) => b.contexts.includes(context) && seq.every((t, i) => b.seq[i] === t));
    const exact = live.find((b) => b.seq.length === seq.length);
    if (exact && live.length === 1) {
      this.pending = [];
      return { type: 'action', id: exact.id };
    }
    if (live.length) {
      this.pending = seq;
      this.pendingAt = this.now();
      return { type: 'pending' };
    }
    this.pending = [];
    // A failed sequence starts fresh with this token, so "g x j" still moves down on j.
    return seq.length > 1 ? this.feed(token, context) : { type: 'none' };
  }

  reset() {
    this.pending = [];
  }
}
