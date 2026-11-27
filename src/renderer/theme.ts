// The theme on screen: a VS Code color theme, picked in settings and read from main before the first frame (see
// main.tsx), so launch never flashes the wrong colours. Its colors become the page's CSS variables (theme-tokens).
import { useEffect, useState } from 'react';
import type { ActiveTheme, ThemeChoice, ThemeList } from '../core/vscode-theme';
import { themeTokens } from './theme-tokens';

/** Where the window kept its theme before themes were files: read once, to carry the choice over, then cleared. */
const LEGACY_KEY = 'normie.theme';

let launch: ActiveTheme | undefined;

/** The theme to show at launch (asked of main once). */
export function launchTheme(): ActiveTheme {
  if (!launch) {
    let legacy: string | null = null;
    try {
      legacy = localStorage.getItem(LEGACY_KEY);
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      // Carrying an old choice over is a convenience; the default theme still applies.
    }
    launch = window.normie.themes.current(legacy);
  }
  return launch;
}

/** Paint the page in a theme: its variables on the root, its light or dark for native controls and the reader. */
export function applyTheme({ theme }: ActiveTheme) {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(themeTokens(theme.colors, theme.type))) {
    root.style.setProperty(name, value);
  }
  root.style.colorScheme = theme.type;
  root.dataset.theme = theme.id;
  root.dataset.themeType = theme.type;
}

/** The theme on screen, repainted whenever main says it changed (a new choice, the system's appearance, an edited file). */
export function useTheme(): ActiveTheme {
  const [active, setActive] = useState(launchTheme);
  useEffect(
    () =>
      window.normie.themes.onChanged((t) => {
        applyTheme(t);
        setActive(t);
      }),
    [],
  );
  return active;
}

/** Every theme that loads, and the files in the themes folder that don't. Updates when the folder changes. */
export function useThemes(): ThemeList {
  const [list, setList] = useState<ThemeList>({ themes: [], problems: [] });
  useEffect(() => {
    void window.normie.themes.list().then(setList);
    return window.normie.themes.onListChanged(setList);
  }, []);
  return list;
}

/** Pick a theme. Main saves the choice and sends the theme back through useTheme. */
export const chooseTheme = (choice: ThemeChoice) => window.normie.themes.choose(choice);
