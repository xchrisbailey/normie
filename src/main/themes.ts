// Themes on disk: the ones bundled in the app (assets/themes) and the user's own (themes/ in the data folder, picked
// up without a restart, like splits.json). A user file with a bundled theme's name replaces it. Reading and parsing
// is in core/vscode-theme; this file only finds the files.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { errorMessage } from '../core/errors';
import { DEFAULT_DARK, DEFAULT_LIGHT, resolveTheme } from '../core/vscode-theme';
import type { ResolvedTheme, ThemeChoice, ThemeList, ThemeSummary } from '../core/vscode-theme';

export class ThemeStore {
  constructor(
    private readonly bundledDir: string,
    private readonly userDir: string,
  ) {}

  /** Every theme that loads, sorted by name, and the files that didn't. */
  list(): ThemeList {
    const themes: Array<ThemeSummary> = [];
    const problems: Array<string> = [];
    for (const [id, source] of this.ids()) {
      try {
        const t = this.resolve(id);
        themes.push({ id, name: t.name, type: t.type, source });
      } catch (error) {
        problems.push(`themes/${id}.json ${errorMessage(error)}`);
      }
    }
    themes.sort((a, b) => a.name.localeCompare(b.name));
    return { themes, problems };
  }

  /** A theme by id, merged over the themes it includes. Throws when it's missing or broken. */
  resolve(id: string): ResolvedTheme {
    return resolveTheme(id, (ref, from) => {
      const file = from ? this.includePath(ref, from) : this.fileOf(ref);
      if (!file || !existsSync(file)) {
        throw new Error(from ? `includes ${ref}, which isn't there` : `there's no theme ${ref}`);
      }
      return { text: readFileSync(file, 'utf8'), ref: file };
    });
  }

  /**
   * The theme a choice stands for right now (`dark`: the system is in dark mode). A missing or broken theme falls
   * back to Normie's own for its side, with the reason.
   */
  active(choice: ThemeChoice, dark: boolean) {
    const id = choice.mode === 'fixed' ? choice.id : dark ? choice.dark : choice.light;
    try {
      return { theme: this.resolve(id), problem: undefined };
    } catch (error) {
      const fallback = dark ? DEFAULT_DARK : DEFAULT_LIGHT;
      return { theme: this.resolve(fallback), problem: `Theme ${id} ${errorMessage(error)}; using ${fallback}` };
    }
  }

  /** Whether a theme id names a file that exists. */
  has(id: string) {
    return this.fileOf(id) !== undefined;
  }

  private ids(): Map<string, ThemeSummary['source']> {
    const ids = new Map<string, ThemeSummary['source']>();
    for (const [dir, source] of [
      [this.bundledDir, 'bundled'],
      [this.userDir, 'user'],
    ] as const) {
      for (const name of jsonFiles(dir)) {
        ids.set(name.slice(0, -'.json'.length), source);
      }
    }
    return ids;
  }

  private fileOf(id: string): string | undefined {
    if (!/^[\w.-]+$/.test(id)) {
      return undefined;
    }
    for (const dir of [this.userDir, this.bundledDir]) {
      const file = path.join(dir, `${id}.json`);
      if (existsSync(file)) {
        return file;
      }
    }
    return undefined;
  }

  /** An `include` resolves next to the file that includes it, and never outside the two theme folders. */
  private includePath(ref: string, from: string): string | undefined {
    const file = path.resolve(path.dirname(from), ref);
    return [this.userDir, this.bundledDir].some((dir) => file.startsWith(path.resolve(dir) + path.sep)) ? file : undefined;
  }
}

function jsonFiles(dir: string): Array<string> {
  try {
    return readdirSync(dir).filter((n) => /^[\w.-]+\.json$/.test(n));
  } catch {
    return [];
  }
}
