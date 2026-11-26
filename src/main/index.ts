// The main process: windows, process wiring and (later) sign-in and secrets.
import { app, BrowserWindow, ipcMain, MessageChannelMain, shell, utilityProcess, type UtilityProcess } from 'electron';
import { rmSync } from 'node:fs';
import path from 'node:path';
import type { AccountConfig } from '../sync/index';

const smoke = process.env.NORMIE_SMOKE === '1';
const useFake = process.env.NORMIE_PROVIDER === 'fake';
const launchedAt = performance.now();

let dataProc: UtilityProcess | undefined;
let syncProc: UtilityProcess | undefined;
let win: BrowserWindow | undefined;

function dbPath() {
  const name = useFake ? 'normie-fake.sqlite' : 'normie.sqlite';
  const p = path.join(app.getPath('userData'), name);
  if (smoke) for (const ext of ['', '-wal', '-shm']) rmSync(p + ext, { force: true });
  return p;
}

function accounts(): AccountConfig[] {
  // Milestone 1, ticket #4: only the fake provider exists. Gmail arrives in #6 and #8.
  const seed = Number(process.env.NORMIE_FAKE_SEED) || undefined;
  return [{ kind: 'fake', accountId: 'fake-1', email: 'me@example.com', seed }];
}

function startCore() {
  dataProc = utilityProcess.fork(path.join(__dirname, '../data/index.js'), [], { serviceName: 'Normie Data', stdio: 'inherit' });
  syncProc = utilityProcess.fork(path.join(__dirname, '../sync/index.js'), [], { serviceName: 'Normie Sync', stdio: 'inherit' });
  dataProc.postMessage({ type: 'init', dbPath: dbPath() });

  const dataSync = new MessageChannelMain();
  dataProc.postMessage({ type: 'sync-port' }, [dataSync.port1]);
  syncProc.postMessage({ type: 'data-port' }, [dataSync.port2]);
  syncProc.postMessage({ type: 'init', accounts: accounts() });

  for (const [name, proc] of [['data', dataProc], ['sync', syncProc]] as const) {
    proc.on('exit', (code) => {
      if (code !== 0 && !quitting) console.error(`[main] ${name} process exited with ${code}`);
    });
  }
}

/** Give the renderer a fresh port to the data process. Called on every load, so reloads work. */
function connectRenderer(w: BrowserWindow) {
  const ch = new MessageChannelMain();
  dataProc!.postMessage({ type: 'renderer-port' }, [ch.port1]);
  w.webContents.postMessage('core-port', null, [ch.port2]);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    backgroundColor: '#1e1e2e',
    title: 'Normie',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const w = win;
  w.webContents.on('did-finish-load', () => connectRenderer(w));
  // Links never navigate the app window: http, https and mailto go to the system, everything else is dropped.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.once('ready-to-show', () => {
    if (!smoke) w.show();
  });
  void w.loadFile(path.join(__dirname, '../renderer/index.html'));
}

let quitting = false;

ipcMain.on('renderer-ready', async (_e, info: { rows: number }) => {
  if (!smoke || !win) return;
  const msSinceLaunch = Math.round(performance.now() - launchedAt);
  const keys = await smokeKeys(win);
  console.log(`[smoke] ${JSON.stringify({ ...info, msSinceLaunch, packaged: app.isPackaged, keys })}`);
  quitting = true;
  app.exit(info.rows > 0 && keys.ok ? 0 : 1);
});

/** Smoke check: real key presses move the selection through the registry. */
async function smokeKeys(w: BrowserWindow) {
  const selectedIndex = () =>
    w.webContents.executeJavaScript(
      `(() => { const rows = [...document.querySelectorAll('.row')]; const s = document.querySelector('.row.selected');
        return s ? Math.round(new DOMMatrix(getComputedStyle(s).transform).m42 / s.offsetHeight) : -1; })()`,
    ) as Promise<number>;
  const press = async (keyCode: string, n = 1) => {
    for (let i = 0; i < n; i++) {
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      w.webContents.sendInputEvent({ type: 'char', keyCode });
      w.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    }
    await new Promise((r) => setTimeout(r, 100));
  };
  const start = await selectedIndex();
  await press('j', 5);
  const afterJ = await selectedIndex();
  await press('k', 2);
  const afterK = await selectedIndex();
  await press('g');
  await press('g');
  const afterGG = await selectedIndex();
  return { ok: start === 0 && afterJ === 5 && afterK === 3 && afterGG === 0, start, afterJ, afterK, afterGG };
}

app.whenReady().then(() => {
  startCore();
  createWindow();
  if (smoke) setTimeout(() => {
    console.error('[smoke] renderer never reported ready');
    app.exit(1);
  }, 20_000);
});

app.on('before-quit', () => {
  quitting = true;
  dataProc?.kill();
  syncProc?.kill();
});

app.on('window-all-closed', () => app.quit());
