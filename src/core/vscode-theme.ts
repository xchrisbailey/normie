// VS Code color themes as normie's themes. A theme file is read as VS Code writes it: JSON with comments and
// trailing commas, an optional `include` of a base theme, and a `colors` map. Only `colors` is used; the token colors
// are for code. Pure: main hands in a way to read a file by name.
import { errorMessage } from './errors';
import { isJsonObject, parseJson } from './json';

export type ThemeType = 'light' | 'dark';

export interface ThemeFile {
  name?: string;
  type?: ThemeType;
  include?: string;
  colors: Record<string, string>;
}

/** A theme ready to apply: its colors merged over every theme it includes. */
export interface ResolvedTheme {
  id: string;
  name: string;
  type: ThemeType;
  colors: Record<string, string>;
}

/** JSONC to JSON: drops // and block comments, then trailing commas, leaving strings alone. */
export function stripJsonc(text: string): string {
  const noComments = walk(text, (c, i) => {
    if (c !== '/' || (text[i + 1] !== '/' && text[i + 1] !== '*')) {
      return -1;
    }
    const end = text[i + 1] === '/' ? text.indexOf('\n', i) : text.indexOf('*/', i + 2);
    return end < 0 ? text.length : text[i + 1] === '/' ? end : end + 2;
  });
  return walk(noComments, (c, i) => {
    if (c !== ',') {
      return -1;
    }
    let j = i + 1;
    while (j < noComments.length && /\s/.test(noComments.charAt(j))) {
      j++;
    }
    return noComments[j] === '}' || noComments[j] === ']' ? i + 1 : -1;
  });
}

/**
 * Copy `text`, skipping what `skip` asks to: given a character outside a string, it returns the index past it where
 * copying resumes, or -1 to keep the character.
 */
function walk(text: string, skip: (c: string, i: number) => number): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        j += text[j] === '\\' ? 2 : 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const resume = skip(c, i);
    if (resume === -1) {
      out += c;
      i++;
    } else {
      i = resume;
    }
  }
  return out;
}

/** VS Code's `type` values (and the older `uiTheme` ones) as light or dark. */
export function themeTypeOf(value: unknown): ThemeType | undefined {
  if (value === 'light' || value === 'hc-light' || value === 'vs') {
    return 'light';
  }
  if (value === 'dark' || value === 'hc-dark' || value === 'hc-black' || value === 'vs-dark') {
    return 'dark';
  }
  return undefined;
}

/** Parse a theme file's text. Throws with a reason a person can act on. */
export function parseThemeFile(text: string): ThemeFile {
  let v;
  try {
    v = parseJson(stripJsonc(text));
  } catch (error) {
    throw new Error(`isn't valid JSON: ${errorMessage(error)}`, { cause: error });
  }
  if (!isJsonObject(v)) {
    throw new Error('should be a VS Code color theme: an object with "colors"');
  }
  const colors: Record<string, string> = {};
  const raw = v.colors;
  if (raw !== undefined && !isJsonObject(raw)) {
    throw new Error('"colors" should be an object of color names to colors');
  }
  for (const [k, c] of Object.entries(raw ?? {})) {
    // null is VS Code's way to say "use the default": leaving the key out does the same here.
    if (typeof c === 'string' && isColor(c)) {
      colors[k] = c;
    }
  }
  const file: ThemeFile = { colors };
  if (typeof v.name === 'string' && v.name.trim()) {
    file.name = v.name.trim();
  } else if (typeof v.displayName === 'string' && v.displayName.trim()) {
    file.name = v.displayName.trim();
  }
  const type = themeTypeOf(v.type);
  if (type) {
    file.type = type;
  }
  if (typeof v.include === 'string' && v.include.trim()) {
    file.include = v.include.trim();
  }
  if (raw === undefined && !file.include) {
    throw new Error('has no "colors" (only color themes work, not icon or product themes)');
  }
  return file;
}

/** A color VS Code accepts in a theme: #rgb, #rgba, #rrggbb or #rrggbbaa. */
export const isColor = (c: string) => /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c);

const lin = (x: number) => {
  const s = x / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** Relative luminance of a #hex color, ignoring alpha. */
export function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** A #hex color's red, green, blue (0–255) and alpha (0–1). */
export function rgbOf(hex: string): [number, number, number, number] {
  let h = hex.slice(1);
  if (h.length <= 4) {
    h = h
      .split('')
      .map((x) => x + x)
      .join('');
  }
  const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
}

/**
 * Read a theme and every theme it includes, base first, so the theme's own colors win. `read` gets a theme's file
 * by the path in `include` relative to the including file, or by id for the top one.
 */
export function resolveTheme(id: string, read: (ref: string, from?: string) => { text: string; ref: string }): ResolvedTheme {
  const chain: Array<ThemeFile> = [];
  const seen = new Set<string>();
  let ref: string | undefined = id;
  let from: string | undefined;
  while (ref !== undefined) {
    if (chain.length >= 8) {
      throw new Error('includes too many themes (8 at most)');
    }
    const got = read(ref, from);
    if (seen.has(got.ref)) {
      throw new Error(`includes itself (${ref})`);
    }
    seen.add(got.ref);
    let file;
    try {
      file = parseThemeFile(got.text);
    } catch (error) {
      throw new Error(chain.length ? `its base theme ${ref} ${errorMessage(error)}` : errorMessage(error), { cause: error });
    }
    chain.push(file);
    from = got.ref;
    ref = file.include;
  }
  const top = chain[0];
  const colors: Record<string, string> = {};
  for (const f of chain.toReversed()) {
    Object.assign(colors, f.colors);
  }
  const bg = colors['editor.background'];
  const type = chain.map((f) => f.type).find((t) => t !== undefined) ?? (bg && luminance(bg) > 0.4 ? 'light' : 'dark');
  return { id, name: top?.name ?? id, type, colors };
}

/** What the renderer needs to list a theme without loading it. */
export interface ThemeSummary {
  id: string;
  name: string;
  type: ThemeType;
  /** Bundled with the app, or from the user's themes folder. */
  source: 'bundled' | 'user';
}

/** How the user picked: one theme always, or a light and a dark one that follow the system. */
export type ThemeChoice = { mode: 'fixed'; id: string } | { mode: 'system'; light: string; dark: string };

export const DEFAULT_LIGHT = 'normie-light';
export const DEFAULT_DARK = 'normie-dark';
export const DEFAULT_CHOICE: ThemeChoice = { mode: 'system', light: DEFAULT_LIGHT, dark: DEFAULT_DARK };

/** A choice from settings.json, or the default when it's missing or malformed. */
export function choiceFrom(v: unknown): ThemeChoice {
  if (typeof v === 'object' && v !== null && 'mode' in v) {
    if (v.mode === 'fixed' && 'id' in v && typeof v.id === 'string') {
      return { mode: 'fixed', id: v.id };
    }
    if (v.mode === 'system') {
      const light = 'light' in v && typeof v.light === 'string' ? v.light : DEFAULT_LIGHT;
      const dark = 'dark' in v && typeof v.dark === 'string' ? v.dark : DEFAULT_DARK;
      return { mode: 'system', light, dark };
    }
  }
  return DEFAULT_CHOICE;
}

/** The theme on screen, the choice that picked it, and why it isn't the chosen one when a file was missing or broken. */
export interface ActiveTheme {
  theme: ResolvedTheme;
  choice: ThemeChoice;
  problem?: string;
}

export interface ThemeList {
  themes: Array<ThemeSummary>;
  /** Files that couldn't be used, and why: shown like the other data-folder files' problems. */
  problems: Array<string>;
}

/** The theme chosen before themes were files (kept in the window's storage): the file that keeps that look. */
export function legacyChoice(old: unknown): ThemeChoice | undefined {
  if (old === 'mocha') {
    return { mode: 'fixed', id: 'catppuccin-mocha' };
  }
  if (old === 'latte') {
    return { mode: 'fixed', id: 'catppuccin-latte' };
  }
  if (old === 'system') {
    return { mode: 'system', light: 'catppuccin-latte', dark: 'catppuccin-mocha' };
  }
  return undefined;
}
