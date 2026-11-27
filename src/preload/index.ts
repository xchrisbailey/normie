// Preload: the only bridge between the sandboxed renderer and Electron.
// It forwards the core's MessagePort into the page and exposes a tiny API. No Node APIs reach the page.
import { contextBridge, ipcRenderer, webFrame } from 'electron';

ipcRenderer.on('core-port', (e) => window.postMessage('normie:core-port', '*', e.ports));

type AccountRecord = { id: string; kind: 'gmail' | 'imap'; email: string; status: 'ok' | 'needs-sign-in'; identities?: { name?: string; address: string }[] };

contextBridge.exposeInMainWorld('normie', {
  /** The first useful frame is painted: from the snapshot, or from the core's first answer (even an empty one). */
  firstPaint: (info: { rows: number; fromSnapshot: boolean }) => ipcRenderer.send('renderer-first-paint', info),
  ready: (info: { rows: number; view: 'list' | 'empty'; fromSnapshot: boolean }) => ipcRenderer.send('renderer-ready', info),
  /** The top rows of the last Split, saved at the end of the previous run. Read once, synchronously, at launch. */
  snapshot: (): unknown[] => ipcRenderer.sendSync('snapshot:get'),
  saveSnapshot: (rows: unknown[]) => ipcRenderer.send('snapshot:set', rows),
  platform: process.platform,
  /** Running against the fake provider: there are no real Accounts to add. */
  fake: process.argv.includes('--normie-fake'),
  /** Give back memory Blink holds for things no longer shown (an old reader frame's resources, decoded images). */
  trimMemory: () => webFrame.clearCache(),
  /** Open a link from a message in the system browser (main checks it's http, https or mailto). */
  openLink: (url: string) => ipcRenderer.send('open-link', url),
  openAttachment: (file: { filename: string; content: Uint8Array }): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('attachment:open', file),
  saveAttachment: (file: { filename: string; content: Uint8Array }): Promise<{ ok: boolean; path?: string }> => ipcRenderer.invoke('attachment:save', file),
  /** The theme, for the parts main draws (menus, the window's background). */
  setTheme: (t: 'mocha' | 'latte' | 'system') => ipcRenderer.send('theme', t),
  /** The Inbox count, for the menu bar. */
  setInboxCount: (n: number) => ipcRenderer.send('inbox-count', n),
  toggleLoginItem: (): Promise<{ on: boolean; packaged: boolean }> => ipcRenderer.invoke('login-item:toggle'),
  /** Show a notification for new mail. */
  notify: (n: { key: string; title: string; body: string }) => ipcRenderer.send('notify', n),
  /** A notification was clicked: open that Thread. */
  onOpenThread: (fn: (key: string) => void) => {
    const handler = (_e: unknown, key: string) => fn(key);
    ipcRenderer.on('open-thread', handler);
    return () => void ipcRenderer.off('open-thread', handler);
  },
  /** A native menu item was chosen: the registry action ids it stands for. */
  onMenuAction: (fn: (ids: string[]) => void) => {
    const handler = (_e: unknown, ids: string[]) => fn(ids);
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
    list: (): Promise<AccountRecord[]> => ipcRenderer.invoke('accounts:list'),
    addGmail: (loginHint?: string): Promise<AccountRecord> => ipcRenderer.invoke('accounts:add-gmail', loginHint),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('accounts:remove', id),
    setIdentities: (id: string, identities: { name?: string; address: string }[]): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('accounts:set-identities', id, identities),
    addPassword: (input: unknown): Promise<{ ok: true; account: AccountRecord } | { ok: false; error: string; field?: string }> => ipcRenderer.invoke('accounts:add-password', input),
    onChanged: (fn: (list: AccountRecord[]) => void) => {
      const handler = (_e: unknown, list: AccountRecord[]) => fn(list);
      ipcRenderer.on('accounts:changed', handler);
      return () => void ipcRenderer.off('accounts:changed', handler);
    },
  },
});
