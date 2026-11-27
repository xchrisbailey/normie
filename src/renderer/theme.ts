// The theme: Catppuccin Mocha (the default), Latte, or following the system. Kept in this window's storage and
// applied before the first frame (see main.tsx), so launch never flashes the wrong colours.
export type Theme = 'mocha' | 'latte' | 'system';

const KEY = 'normie.theme';

export function currentTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'latte' || t === 'system' ? t : 'mocha';
  } catch {
    return 'mocha';
  }
}

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // Remembering is a convenience; the theme still applies now.
  }
  // Native parts (menus, the window behind the page, scrollbars) follow too.
  window.normie.setTheme(t);
}
