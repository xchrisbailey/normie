// Preload: the only bridge between the sandboxed renderer and Electron.
// It forwards the core's MessagePort into the page and exposes a tiny API. No Node APIs reach the page.
import { contextBridge, ipcRenderer } from 'electron';

ipcRenderer.on('core-port', (e) => window.postMessage('normie:core-port', '*', e.ports));

contextBridge.exposeInMainWorld('normie', {
  ready: (info: { rows: number }) => ipcRenderer.send('renderer-ready', info),
  platform: process.platform,
});
