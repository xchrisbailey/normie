// The main process: windows, process wiring and (later) sign-in and secrets.
import { app, BrowserWindow, ipcMain, MessageChannelMain, shell, utilityProcess, type UtilityProcess } from 'electron';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { mainPortChannel, serve } from '../core/rpc';
import type { AccountConfig } from '../sync/index';
import { Accounts, type AccountRecord } from './auth/accounts';
import { JsonAccountList, SafeStorageSecrets } from './auth/electron-stores';
import { loadGoogleClient } from './auth/google-oauth';

const smoke = process.env.NORMIE_SMOKE === '1';
const useFake = process.env.NORMIE_PROVIDER === 'fake';
const launchedAt = performance.now();
// Smoke runs never touch the real Accounts or mail database.
if (smoke) app.setPath('userData', path.join(app.getPath('temp'), `normie-smoke-${process.pid}`));

let dataProc: UtilityProcess | undefined;
let syncProc: UtilityProcess | undefined;
let win: BrowserWindow | undefined;

function dbPath() {
  const name = useFake ? 'normie-fake.sqlite' : 'normie.sqlite';
  const p = path.join(app.getPath('userData'), name);
  if (smoke) for (const ext of ['', '-wal', '-shm']) rmSync(p + ext, { force: true });
  return p;
}

/** The Desktop OAuth client from Google Cloud. It lives outside the repo. */
const googleClientPath = () => process.env.NORMIE_GOOGLE_CLIENT ?? path.join(homedir(), '.config/normie/google-oauth-client.json');

let accounts: Accounts;

function initAccounts() {
  const dir = app.getPath('userData');
  accounts = new Accounts({
    secrets: new SafeStorageSecrets(path.join(dir, 'secrets')),
    list: new JsonAccountList(path.join(dir, 'accounts.json')),
    googleClient: () => loadGoogleClient(googleClientPath()),
    openUrl: (url) => shell.openExternal(url),
  });
  accounts.onChange((list) => win?.webContents.send('accounts:changed', list));
}

function syncAccounts(): AccountConfig[] {
  if (useFake) {
    const seed = Number(process.env.NORMIE_FAKE_SEED) || undefined;
    return [{ kind: 'fake', accountId: 'fake-1', email: 'me@example.com', seed }];
  }
  return accounts.list().map((a) => ({ kind: a.kind, accountId: a.id, email: a.email }));
}

function startCore() {
  dataProc = utilityProcess.fork(path.join(__dirname, '../data/index.js'), [], { serviceName: 'Normie Data', stdio: 'inherit' });
  syncProc = utilityProcess.fork(path.join(__dirname, '../sync/index.js'), [], { serviceName: 'Normie Sync', stdio: 'inherit' });
  dataProc.postMessage({ type: 'init', dbPath: dbPath() });

  const dataSync = new MessageChannelMain();
  dataProc.postMessage({ type: 'sync-port' }, [dataSync.port1]);
  syncProc.postMessage({ type: 'data-port' }, [dataSync.port2]);
  // Sync asks main for access tokens; main holds the secrets and refreshes them.
  const mainSync = new MessageChannelMain();
  serve(mainPortChannel(mainSync.port1), { accessToken: (id: string) => accounts.accessToken(id) });
  syncProc.postMessage({ type: 'main-port' }, [mainSync.port2]);
  syncProc.postMessage({ type: 'init', accounts: syncAccounts() });

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
      additionalArguments: useFake ? ['--normie-fake'] : [],
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

ipcMain.on('renderer-ready', async (_e, info: { rows: number; view: 'list' | 'empty' }) => {
  if (!smoke || !win) return;
  const msSinceLaunch = Math.round(performance.now() - launchedAt);
  const keys = info.view === 'list' ? await smokeKeys(win) : undefined;
  console.log(`[smoke] ${JSON.stringify({ ...info, msSinceLaunch, packaged: app.isPackaged, keys })}`);
  quitting = true;
  const ok = info.view === 'list' ? info.rows > 0 && keys!.ok : !useFake && info.view === 'empty';
  app.exit(ok ? 0 : 1);
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

ipcMain.handle('accounts:list', () => accounts.list());
ipcMain.handle('accounts:add-gmail', async (_e, loginHint?: string): Promise<AccountRecord> => {
  const acct = await accounts.addGmail(loginHint);
  app.focus({ steal: true });
  win?.focus();
  return acct;
});
ipcMain.handle('accounts:remove', (_e, id: string) => accounts.remove(id));

app.whenReady().then(() => {
  initAccounts();
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
