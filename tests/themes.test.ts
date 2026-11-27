// Themes: VS Code color theme files read as normie's colors.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { choiceFrom, DEFAULT_CHOICE, legacyChoice, parseThemeFile, resolveTheme, stripJsonc } from '../src/core/vscode-theme';
import { ThemeStore } from '../src/main/themes';
import { contrast, THEME_VARS, themeTokens } from '../src/renderer/theme-tokens';

const BUNDLED = path.join(import.meta.dirname, '../src/main/assets/themes');
const bundledIds = readdirSync(BUNDLED)
  .filter((n) => n.endsWith('.json'))
  .map((n) => n.slice(0, -5));

let dirs: Array<string> = [];
afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
  dirs = [];
});
const tempDir = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'normie-themes-'));
  dirs.push(d);
  return d;
};

const withBackground = (bg: string) => () => ({ text: `{"colors":{"editor.background":"${bg}"}}`, ref: 'x' });

describe('theme files', () => {
  it('reads JSON with comments and trailing commas, leaving strings alone', () => {
    const text = `{
      // a comment
      "name": "Has // and /* in it, too,",
      /* a block
         comment */
      "colors": { "editor.background": "#112233", }, // trailing
    }`;
    expect(JSON.parse(stripJsonc(text))).toEqual({ name: 'Has // and /* in it, too,', colors: { 'editor.background': '#112233' } });
  });

  it('keeps only real colors, and says what is wrong with a file that is not a color theme', () => {
    expect(parseThemeFile('{"colors":{"a":"#fff","b":null,"c":"red","d":"#12345"}}').colors).toEqual({ a: '#fff' });
    expect(() => parseThemeFile('{"colors": ')).toThrow(/isn't valid JSON/);
    expect(() => parseThemeFile('[]')).toThrow(/VS Code color theme/);
    expect(() => parseThemeFile('{"iconDefinitions":{}}')).toThrow(/has no "colors"/);
  });

  it('merges a theme over the themes it includes, and refuses a loop', () => {
    const files = new Map([
      ['top', '{"name":"Top","include":"./base.json","colors":{"editor.foreground":"#000000"}}'],
      ['./base.json', '{"type":"light","colors":{"editor.background":"#ffffff","editor.foreground":"#333333"}}'],
      ['loop', '{"include":"./loop2.json","colors":{}}'],
      ['./loop2.json', '{"include":"./loop2.json","colors":{}}'],
    ]);
    const read = (ref: string) => ({ text: files.get(ref) ?? '', ref });
    expect(resolveTheme('top', read)).toEqual({
      id: 'top',
      name: 'Top',
      type: 'light',
      colors: { 'editor.background': '#ffffff', 'editor.foreground': '#000000' },
    });
    expect(() => resolveTheme('loop', read)).toThrow(/includes itself/);
  });

  it('tells light from dark by the background when a theme does not say', () => {
    expect(resolveTheme('a', withBackground('#fdf6e3')).type).toBe('light');
    expect(resolveTheme('b', withBackground('#002b36')).type).toBe('dark');
  });
});

describe('theme colors as normie colors', () => {
  it.each(bundledIds)('%s sets every color, with readable text', (id) => {
    const t = new ThemeStore(BUNDLED, tempDir()).resolve(id);
    const tokens = themeTokens(t.colors, t.type);
    expect(Object.keys(tokens).toSorted()).toEqual([...THEME_VARS].toSorted());
    for (const v of Object.values(tokens)) {
      expect(v).toMatch(/^#[0-9a-f]{6,8}$/i);
    }
    expect(contrast(tokens['--fg'], tokens['--ground'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens['--fg2'], tokens['--ground'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens['--fg3'], tokens['--ground'])).toBeGreaterThanOrEqual(3);
    expect(contrast(tokens['--fg'], tokens['--sel'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens['--accent'], tokens['--ground'])).toBeGreaterThanOrEqual(3);
  });

  it('takes Normie Dark as written', () => {
    const t = new ThemeStore(BUNDLED, tempDir()).resolve('normie-dark');
    const tokens = themeTokens(t.colors, t.type);
    expect(tokens['--ground']).toBe('#1a1725');
    expect(tokens['--accent']).toBe('#b49bff');
    expect(tokens['--ansi-yellow']).toBe('#ffd166');
  });

  it('fills what a sparse theme leaves out from its background and foreground', () => {
    const tokens = themeTokens({ 'editor.background': '#ffffff', 'editor.foreground': '#222222' }, 'light');
    expect(tokens['--ground']).toBe('#ffffff');
    expect(tokens['--line']).not.toBe('#ffffff');
    // VS Code's own terminal colors stand in for the Split colors.
    expect(tokens['--ansi-blue']).toBe('#0451a5');
  });

  it('skips a selection meant for white text, and a border that is fully transparent', () => {
    const tokens = themeTokens(
      { 'editor.background': '#ffffff', 'editor.foreground': '#000000', 'list.activeSelectionBackground': '#0060c0', 'editorGroup.border': '#00000000' },
      'light',
    );
    expect(tokens['--sel']).not.toBe('#0060c0');
    expect(tokens['--line']).not.toBe('#000000');
  });

  it('moves text a theme makes too faint toward its foreground', () => {
    const tokens = themeTokens({ 'editor.background': '#ffffff', 'editor.foreground': '#000000', descriptionForeground: '#eeeeee' }, 'light');
    expect(contrast(tokens['--fg2'], '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('the themes folders', () => {
  it('lists bundled and user themes; a user file replaces a bundled one; a broken one is a problem', () => {
    const user = tempDir();
    writeFileSync(path.join(user, 'mine.json'), '{"name":"Mine","type":"dark","colors":{"editor.background":"#101010"}}');
    writeFileSync(path.join(user, 'nord.json'), '{"name":"My Nord","colors":{"editor.background":"#2e3440"}}');
    writeFileSync(path.join(user, 'broken.json'), '{"colors":');
    const { themes, problems } = new ThemeStore(BUNDLED, user).list();
    expect(themes.find((t) => t.id === 'mine')).toEqual({ id: 'mine', name: 'Mine', type: 'dark', source: 'user' });
    expect(themes.find((t) => t.id === 'nord')).toMatchObject({ name: 'My Nord', source: 'user' });
    expect(themes.find((t) => t.id === 'normie-light')).toMatchObject({ name: 'Normie Light', type: 'light', source: 'bundled' });
    expect(problems).toEqual([expect.stringMatching(/^themes\/broken\.json isn't valid JSON/)]);
  });

  it('never includes a file outside the theme folders', () => {
    const user = tempDir();
    const outside = tempDir();
    writeFileSync(path.join(outside, 'secret.json'), '{"colors":{}}');
    mkdirSync(path.join(user, 'sub'));
    writeFileSync(path.join(user, 'sneaky.json'), `{"include":"../${path.basename(outside)}/secret.json","colors":{}}`);
    expect(() => new ThemeStore(BUNDLED, user).resolve('sneaky')).toThrow(/isn't there/);
  });

  it("falls back to Normie's own theme for its side when the chosen one is gone", () => {
    const store = new ThemeStore(BUNDLED, tempDir());
    const { theme, problem } = store.active({ mode: 'fixed', id: 'deleted' }, true);
    expect(theme.id).toBe('normie-dark');
    expect(problem).toMatch(/deleted/);
    expect(store.active(DEFAULT_CHOICE, false).theme.id).toBe('normie-light');
  });

  it('ships a notice for every bundled theme it did not write', () => {
    const notice = readFileSync(path.join(BUNDLED, 'NOTICE.md'), 'utf8');
    for (const id of bundledIds.filter((i) => !i.startsWith('normie-'))) {
      expect(notice).toContain(`${id}.json`);
    }
  });
});

describe('the choice', () => {
  it('reads what settings.json holds, and carries over a theme picked before themes were files', () => {
    expect(choiceFrom({ mode: 'fixed', id: 'nord' })).toEqual({ mode: 'fixed', id: 'nord' });
    expect(choiceFrom({ mode: 'system', dark: 'dracula' })).toEqual({ mode: 'system', light: 'normie-light', dark: 'dracula' });
    expect(choiceFrom('nonsense')).toEqual(DEFAULT_CHOICE);
    expect(legacyChoice('mocha')).toEqual({ mode: 'fixed', id: 'catppuccin-mocha' });
    expect(legacyChoice('system')).toEqual({ mode: 'system', light: 'catppuccin-latte', dark: 'catppuccin-mocha' });
    expect(legacyChoice(null)).toBeUndefined();
  });
});
