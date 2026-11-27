// Preload: the only bridge between the sandboxed renderer and Electron.
// It forwards the core's MessagePort into the page and exposes a tiny API. No Node APIs reach the page.
import { contextBridge, ipcRenderer, webFrame } from 'electron';
import type { Appearance } from '../core/appearance';
import type { ActiveTheme, ThemeChoice, ThemeList } from '../core/vscode-theme';

ipcRenderer.on('core-port', (e) => window.postMessage('normie:core-port', '*', e.ports));

type AccountRecord = {
  id: string;
  kind: 'gmail' | 'imap';
  email: string;
  status: 'ok' | 'needs-sign-in';
  identities?: Array<{ name?: string; address: string }>;
};

contextBridge.exposeInMainWorld('normie', {
  /** The first useful frame is painted: from the snapshot, or from the core's first answer (even an empty one). */
  firstPaint: (info: { rows: number; fromSnapshot: boolean }) => ipcRenderer.send('renderer-first-paint', info),
  ready: (info: { rows: number; view: 'list' | 'empty'; fromSnapshot: boolean }) => ipcRenderer.send('renderer-ready', info),
  /** The top rows of the last Split, saved at the end of the previous run. Read once, synchronously, at launch. */
  snapshot: (): Array<unknown> => {
    const rows: unknown = ipcRenderer.sendSync('snapshot:get');
    return Array.isArray(rows) ? rows : [];
  },
  saveSnapshot: (rows: Array<unknown>) => ipcRenderer.send('snapshot:set', rows),
  platform: process.platform,
  /** Running against the fake provider: there are no real Accounts to add. */
  fake: process.argv.includes('--normie-fake'),
  /** Give back memory Blink holds for things no longer shown (an old reader frame's resources, decoded images). */
  trimMemory: () => webFrame.clearCache(),
  /** Open a link from a message in the system browser (main checks it's http, https or mailto). */
  openLink: (url: string) => ipcRenderer.send('open-link', url),
  openAttachment: (file: { filename: string; content: Uint8Array }): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('attachment:open', file),
  saveAttachment: (file: { filename: string; content: Uint8Array }): Promise<{ ok: boolean; path?: string }> => ipcRenderer.invoke('attachment:save', file),
  themes: {
    /** The theme to show now, read before the first frame. `legacy`: the choice kept in the window's storage before themes were files. */
    current: (legacy: string | null): ActiveTheme => {
      const t: unknown = ipcRenderer.sendSync('theme:current', legacy);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- main answers with activeTheme(), typed there
      return t as ActiveTheme;
    },
    list: (): Promise<ThemeList> => ipcRenderer.invoke('themes:list'),
    choose: (choice: ThemeChoice): Promise<ActiveTheme> => ipcRenderer.invoke('theme:choose', choice),
    /** The theme on screen changed: a new choice, the system's appearance, or the file was edited. */
    onChanged: (fn: (t: ActiveTheme) => void) => {
      const handler = (_e: unknown, t: ActiveTheme) => fn(t);
      ipcRenderer.on('theme:changed', handler);
      return () => void ipcRenderer.off('theme:changed', handler);
    },
    /** A file in the themes folder was added, changed or removed. */
    onListChanged: (fn: (l: ThemeList) => void) => {
      const handler = (_e: unknown, l: ThemeList) => fn(l);
      ipcRenderer.on('themes:changed', handler);
      return () => void ipcRenderer.off('themes:changed', handler);
    },
  },
  appearance: {
    /** Font, size, density, width and motion, read before the first frame like the theme. */
    current: (): Appearance => {
      const a: unknown = ipcRenderer.sendSync('appearance:current');
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- main answers with appearanceFrom(), typed there
      return a as Appearance;
    },
    set: (a: Appearance): Promise<Appearance> => ipcRenderer.invoke('appearance:set', a),
  },
  /** The Inbox count, for the menu bar. */
  setInboxCount: (n: number) => ipcRenderer.send('inbox-count', n),
  toggleLoginItem: (): Promise<{ on: boolean; packaged: boolean }> => ipcRenderer.invoke('login-item:toggle'),
  loginItem: (): Promise<{ on: boolean; packaged: boolean }> => ipcRenderer.invoke('login-item:get'),
  setLoginItem: (on: boolean): Promise<{ on: boolean; packaged: boolean }> => ipcRenderer.invoke('login-item:set', on),
  /** Show a notification for new mail. */
  notify: (n: { key: string; title: string; body: string }) => ipcRenderer.send('notify', n),
  /** A notification was clicked: open that Thread. */
  onOpenThread: (fn: (key: string) => void) => {
    const handler = (_e: unknown, key: string) => fn(key);
    ipcRenderer.on('open-thread', handler);
    return () => void ipcRenderer.off('open-thread', handler);
  },
  /** A native menu item was chosen: the registry action ids it stands for. */
  onMenuAction: (fn: (ids: Array<string>) => void) => {
    const handler = (_e: unknown, ids: Array<string>) => fn(ids);
    ipcRenderer.on('menu:action', handler);
    return () => void ipcRenderer.off('menu:action', handler);
  },
  /** The user's keymap file, parsed (or why it couldn't be). */
  keymap: (): Promise<{ file?: unknown; error?: string }> => ipcRenderer.invoke('keymap:get'),
  onKeymapChanged: (fn: (k: { file?: unknown; error?: string }) => void) => {
    const handler = (_e: unknown, k: { file?: unknown; error?: string }) => fn(k);
    ipcRenderer.on('keymap:changed', handler);
    return () => void ipcRenderer.off('keymap:changed', handler);
  },
  snippets: (): Promise<{ file?: unknown; error?: string }> => ipcRenderer.invoke('snippets:get'),
  onSnippetsChanged: (fn: (k: { file?: unknown; error?: string }) => void) => {
    const handler = (_e: unknown, k: { file?: unknown; error?: string }) => fn(k);
    ipcRenderer.on('snippets:changed', handler);
    return () => void ipcRenderer.off('snippets:changed', handler);
  },
  splits: (): Promise<{ file?: unknown; error?: string }> => ipcRenderer.invoke('splits:get'),
  onSplitsChanged: (fn: (k: { file?: unknown; error?: string }) => void) => {
    const handler = (_e: unknown, k: { file?: unknown; error?: string }) => fn(k);
    ipcRenderer.on('splits:changed', handler);
    return () => void ipcRenderer.off('splits:changed', handler);
  },
  accounts: {
    list: (): Promise<Array<AccountRecord>> => ipcRenderer.invoke('accounts:list'),
    addGmail: (loginHint?: string): Promise<AccountRecord> => ipcRenderer.invoke('accounts:add-gmail', loginHint),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('accounts:remove', id),
    setIdentities: (id: string, identities: Array<{ name?: string; address: string }>): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('accounts:set-identities', id, identities),
    addPassword: (input: unknown): Promise<{ ok: true; account: AccountRecord } | { ok: false; error: string; field?: string }> =>
      ipcRenderer.invoke('accounts:add-password', input),
    onChanged: (fn: (list: Array<AccountRecord>) => void) => {
      const handler = (_e: unknown, list: Array<AccountRecord>) => fn(list);
      ipcRenderer.on('accounts:changed', handler);
      return () => void ipcRenderer.off('accounts:changed', handler);
    },
  },
});
