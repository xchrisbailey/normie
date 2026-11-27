// A VS Code color theme's `colors` as normie's CSS variables. Pure. Each variable takes the first of its VS Code
// keys the theme sets; one it leaves out is mixed from the editor's background and foreground. Text colors are
// checked against the background and moved toward the foreground until they're readable.
import { isColor, luminance, rgbOf } from '../core/vscode-theme';
import type { ThemeType } from '../core/vscode-theme';

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;
const ANSI_KEYS = [...ANSI.map((c) => [c, c] as const), ...ANSI.map((c) => [`bright-${c}`, `bright${c[0]?.toUpperCase()}${c.slice(1)}`] as const)];

/** VS Code's own terminal colors, for a theme that sets none. */
const DEFAULT_ANSI: Record<ThemeType, Array<string>> = {
  dark: [
    '#000000',
    '#cd3131',
    '#0dbc79',
    '#e5e510',
    '#2472c8',
    '#bc3fbc',
    '#11a8cd',
    '#e5e5e5',
    '#666666',
    '#f14c4c',
    '#23d18b',
    '#f5f543',
    '#3b8eea',
    '#d670d6',
    '#29b8db',
    '#e5e5e5',
  ],
  light: [
    '#000000',
    '#cd3131',
    '#00bc00',
    '#949800',
    '#0451a5',
    '#bc05bc',
    '#0598bc',
    '#555555',
    '#666666',
    '#cd3131',
    '#14ce14',
    '#b5ba00',
    '#0451a5',
    '#bc05bc',
    '#0598bc',
    '#a5a5a5',
  ],
};
const DEFAULT_BG: Record<ThemeType, string> = { dark: '#1e1e1e', light: '#ffffff' };
const DEFAULT_FG: Record<ThemeType, string> = { dark: '#cccccc', light: '#3b3b3b' };

/** Every variable a theme sets, so a test (and the stylesheet's defaults) can check none is missing. */
export const THEME_VARS = [
  '--ground',
  '--paper',
  '--well',
  '--sel',
  '--line',
  '--line2',
  '--fg',
  '--fg2',
  '--fg3',
  '--accent',
  '--accent-fg',
  '--shadow',
  '--scrim',
  ...ANSI_KEYS.map(([name]) => `--ansi-${name}` as const),
] as const;
export type ThemeVar = (typeof THEME_VARS)[number];

const hex2 = (n: number) =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, '0');

/** `a` drawn over `under` at its own alpha, as an opaque #rrggbb. */
function flatten(a: string, under: string): string {
  const [r, g, b, al] = rgbOf(a);
  const [r2, g2, b2] = rgbOf(under);
  return `#${hex2(r * al + r2 * (1 - al))}${hex2(g * al + g2 * (1 - al))}${hex2(b * al + b2 * (1 - al))}`;
}

/** `t` of the way from `a` to `b` (both opaque). */
export function mix(a: string, b: string, t: number): string {
  const [r, g, bl] = rgbOf(a);
  const [r2, g2, b2] = rgbOf(b);
  return `#${hex2(r + (r2 - r) * t)}${hex2(g + (g2 - g) * t)}${hex2(bl + (b2 - bl) * t)}`;
}

/** WCAG contrast ratio of two opaque colors. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** `c`, moved toward `toward` in tenths until it reaches `min` contrast against `bg`. */
function readable(c: string, bg: string, toward: string, min: number): string {
  let out = flatten(c, bg);
  for (let t = 0.1; contrast(out, bg) < min && t <= 1; t += 0.1) {
    out = mix(flatten(c, bg), toward, t);
  }
  return out;
}

/** The first of `colors` that's set and passes `ok` once drawn over `ground`, drawn over it. */
function firstOpaque(colors: Array<string | undefined>, ground: string, ok: (c: string) => boolean): string | undefined {
  for (const c of colors) {
    const flat = c === undefined ? undefined : flatten(c, ground);
    if (flat !== undefined && ok(flat)) {
      return flat;
    }
  }
  return undefined;
}

export function themeTokens(colors: Readonly<Record<string, string>>, type: ThemeType): Record<ThemeVar, string> {
  // A color with zero alpha is a theme's way to hide a border: treat it as unset.
  const set = (k: string) => {
    const c = colors[k];
    return c && isColor(c) && rgbOf(c)[3] > 0 ? c : undefined;
  };
  const first = (...keys: Array<string>) => keys.map(set).find((c) => c !== undefined);

  const ground = flatten(first('editor.background') ?? DEFAULT_BG[type], DEFAULT_BG[type]);
  const toward = type === 'dark' ? '#ffffff' : '#000000';
  const themeFg = readable(first('editor.foreground', 'foreground') ?? DEFAULT_FG[type], ground, toward, 4.5);

  // A selection painted in a strong accent (Light+ is #0060c0) is made for white text; rows keep theirs.
  const sel =
    firstOpaque([first('list.inactiveSelectionBackground'), first('list.activeSelectionBackground')], ground, (x) => contrast(themeFg, x) >= 4.5) ??
    mix(ground, themeFg, 0.12);
  // Text that only just reads on the background (Solarized's) is lifted a little so it reads on a selected row too.
  const fg = readable(themeFg, sel, toward, 4.5);
  const blend = (t: number) => mix(ground, fg, t);
  const surface = (fallback: number, ...keys: Array<string>) => {
    const c = first(...keys);
    return c ? flatten(c, ground) : blend(fallback);
  };

  const ansi = ANSI_KEYS.map(([, key], i) => first(`terminal.ansi${key[0]?.toUpperCase()}${key.slice(1)}`) ?? DEFAULT_ANSI[type][i] ?? fg);
  const accent =
    firstOpaque([first('focusBorder'), first('button.background'), first('textLink.foreground'), ansi[4]], ground, (x) => contrast(x, ground) >= 3) ?? fg;
  const buttonFg = first('button.foreground');
  const accentFg = buttonFg && contrast(flatten(buttonFg, accent), accent) >= 4.5 ? flatten(buttonFg, accent) : luminance(accent) > 0.4 ? '#000000' : '#ffffff';

  return {
    '--ground': ground,
    '--paper': surface(0.04, 'editorWidget.background', 'sideBar.background'),
    '--well': surface(0.06, 'list.hoverBackground'),
    '--sel': sel,
    '--line': surface(0.14, 'editorGroup.border', 'panel.border', 'sideBar.border', 'editorWidget.border'),
    '--line2': surface(0.24, 'input.border', 'dropdown.border'),
    '--fg': fg,
    '--fg2': readable(first('descriptionForeground') ?? blend(0.7), ground, fg, 4.5),
    '--fg3': readable(first('editorLineNumber.foreground', 'disabledForeground') ?? blend(0.5), ground, fg, 3),
    '--accent': accent,
    '--accent-fg': accentFg,
    '--shadow': first('widget.shadow') ?? (type === 'dark' ? '#0000005c' : '#00000029'),
    '--scrim': `${ground}8c`,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one entry for each ANSI_KEYS name, as THEME_VARS lists them
    ...(Object.fromEntries(ANSI_KEYS.map(([name], i) => [`--ansi-${name}`, ansi[i] ?? fg])) as Record<`--ansi-${(typeof ANSI_KEYS)[number][0]}`, string>),
  };
}
