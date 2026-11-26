// Preload: the only bridge between the sandboxed renderer and Electron.
// It forwards the core's MessagePort into the page and exposes a tiny API. No Node APIs reach the page.
import { contextBridge, ipcRenderer } from 'electron';

ipcRenderer.on('core-port', (e) => window.postMessage('normie:core-port', '*', e.ports));

type AccountRecord = { id: string; kind: 'gmail'; email: string; status: 'ok' | 'needs-sign-in' };

contextBridge.exposeInMainWorld('normie', {
  ready: (info: { rows: number; view: 'list' | 'empty' }) => ipcRenderer.send('renderer-ready', info),
  platform: process.platform,
  /** Running against the fake provider: there are no real Accounts to add. */
  fake: process.argv.includes('--normie-fake'),
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
