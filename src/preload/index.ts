// Preload: the only bridge between the sandboxed renderer and Electron.
// It forwards the core's MessagePort into the page and exposes a tiny API. No Node APIs reach the page.
import { contextBridge, ipcRenderer } from 'electron';

ipcRenderer.on('core-port', (e) => window.postMessage('normie:core-port', '*', e.ports));

type AccountRecord = { id: string; kind: 'gmail'; email: string; status: 'ok' | 'needs-sign-in' };

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
  accounts: {
    list: (): Promise<AccountRecord[]> => ipcRenderer.invoke('accounts:list'),
    addGmail: (loginHint?: string): Promise<AccountRecord> => ipcRenderer.invoke('accounts:add-gmail', loginHint),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('accounts:remove', id),
    onChanged: (fn: (list: AccountRecord[]) => void) => {
      const handler = (_e: unknown, list: AccountRecord[]) => fn(list);
      ipcRenderer.on('accounts:changed', handler);
      return () => void ipcRenderer.off('accounts:changed', handler);
    },
  },
});
