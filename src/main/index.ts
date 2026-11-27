// The main process: windows, process wiring and (later) sign-in and secrets.
import { app, BrowserWindow, ipcMain, Menu, MessageChannelMain, shell, utilityProcess, type MenuItemConstructorOptions, type UtilityProcess } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { mainPortChannel, serve } from '../core/rpc';
import type { AccountConfig } from '../sync/index';
import { Accounts, type AccountRecord } from './auth/accounts';
import { JsonAccountList, SafeStorageSecrets } from './auth/electron-stores';
import { loadGoogleClient } from './auth/google-oauth';
import { BUDGETS } from '../core/budgets';
import { mergeKeymap } from '../renderer/commands/keymap';
import { menuSections } from '../renderer/commands/menu';
import { ACTIONS } from '../renderer/commands/registry';

const smoke = process.env.NORMIE_SMOKE === '1';
const bench = process.env.NORMIE_BENCH === '1';
/** One cold launch for the cold-start benchmark: report time to the first useful frame, then quit. */
const coldStartRun = process.env.NORMIE_BENCH === 'coldstart';
/** 'fake' runs a fake mailbox; 'none' runs with sync off (the benchmark fixture). Neither uses real Accounts. */
const provider = process.env.NORMIE_PROVIDER;
const useFake = provider === 'fake';
const noRealAccounts = provider === 'fake' || provider === 'none';
const launchedAt = performance.now();
// Smoke runs never touch the real Accounts or mail database; benchmark runs can name their own folder.
if (process.env.NORMIE_USER_DATA) app.setPath('userData', process.env.NORMIE_USER_DATA);
else if (smoke) app.setPath('userData', path.join(app.getPath('temp'), `normie-smoke-${process.pid}`));

let dataProc: UtilityProcess | undefined;
let syncProc: UtilityProcess | undefined;
let win: BrowserWindow | undefined;

function dbPath() {
  if (process.env.NORMIE_DB) return process.env.NORMIE_DB;
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
  accounts.onChange((list) => {
    win?.webContents.send('accounts:changed', list);
    syncProc?.postMessage({ type: 'accounts', accounts: syncAccounts() });
  });
}

function syncAccounts(): AccountConfig[] {
  if (provider === 'none') return [];
  if (useFake) {
    const seed = Number(process.env.NORMIE_FAKE_SEED) || undefined;
    return [{ kind: 'fake', accountId: 'fake-1', email: 'me@example.com', seed }];
  }
  return accounts.list().map((a) => ({ kind: a.kind, accountId: a.id, email: a.email, status: a.status }));
}

/** The data process starts at once: the first frame needs rows. */
function startData() {
  dataProc = utilityProcess.fork(path.join(__dirname, '../data/index.js'), [], { serviceName: 'Normie Data', stdio: 'inherit' });
  const keepAccounts = noRealAccounts ? undefined : accounts.list().map((a) => a.id);
  dataProc.postMessage({ type: 'init', dbPath: dbPath(), keepAccounts });
  watchExit('data', dataProc);
}

/** Sync starts after the first paint, so the network never competes with drawing the inbox. */
function startSync() {
  if (syncProc || !dataProc) return;
  syncProc = utilityProcess.fork(path.join(__dirname, '../sync/index.js'), [], { serviceName: 'Normie Sync', stdio: 'inherit' });
  const dataSync = new MessageChannelMain();
  dataProc.postMessage({ type: 'sync-port' }, [dataSync.port1]);
  syncProc.postMessage({ type: 'data-port' }, [dataSync.port2]);
  // Sync asks main for access tokens; main holds the secrets and refreshes them.
  const mainSync = new MessageChannelMain();
  serve(mainPortChannel(mainSync.port1), { accessToken: (id: string) => accounts.accessToken(id) });
  syncProc.postMessage({ type: 'main-port' }, [mainSync.port2]);
  syncProc.postMessage({ type: 'accounts', accounts: syncAccounts() });
  watchExit('sync', syncProc);
}

function watchExit(name: string, proc: UtilityProcess) {
  proc.on('exit', (code) => {
    if (code !== 0 && !quitting) console.error(`[main] ${name} process exited with ${code}`);
  });
}

// --- Snapshot: the top rows of the last Split, drawn on launch before the core answers.

const snapshotFile = () => path.join(app.getPath('userData'), 'snapshot.json');
let snapshot: unknown[] = [];

function loadSnapshot() {
  try {
    snapshot = JSON.parse(readFileSync(snapshotFile(), 'utf8')) as unknown[];
  } catch {
    snapshot = [];
  }
}

function saveSnapshot() {
  try {
    writeFileSync(snapshotFile(), JSON.stringify(snapshot));
  } catch (e) {
    console.error(`[main] could not save snapshot: ${(e as Error).message}`);
  }
}

ipcMain.on('snapshot:get', (e) => (e.returnValue = snapshot));
ipcMain.on('snapshot:set', (_e, rows: unknown[]) => {
  if (Array.isArray(rows)) snapshot = rows.slice(0, 100);
});

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
      additionalArguments: noRealAccounts ? ['--normie-fake'] : [],
      backgroundThrottling: !bench,
    },
  });
  const w = win;
  w.webContents.on('did-finish-load', () => connectRenderer(w));
  // Coming back to the window is a good moment to check for changes.
  w.on('focus', () => syncProc?.postMessage({ type: 'poll' }));
  // Links never navigate the app window: http, https and mailto go to the system, everything else is dropped.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  // Shown once the first useful frame is painted (see renderer-ready), with a fallback so it always appears.
  if (!smoke && !bench && !coldStartRun) showTimer = setTimeout(() => showWindow(w), 3000);
  void w.loadFile(path.join(__dirname, '../renderer/index.html'));
}

let quitting = false;

let readyTimeout: NodeJS.Timeout | undefined;
let showTimer: NodeJS.Timeout | undefined;

function showWindow(w: BrowserWindow) {
  clearTimeout(showTimer);
  if (w.isVisible() || smoke || coldStartRun) return;
  if (bench) w.showInactive();
  else w.show();
}

ipcMain.on('renderer-first-paint', async (_e, info: { rows: number; fromSnapshot: boolean }) => {
  const msSinceProcessStart = Math.round(process.uptime() * 1000);
  if (win) showWindow(win);
  startSync();
  if (coldStartRun) {
    clearTimeout(readyTimeout);
    console.log(`[coldstart] ${JSON.stringify({ ms: msSinceProcessStart, fromSnapshot: info.fromSnapshot, rows: info.rows, budget: BUDGETS.coldStartMs })}`);
    // Give the renderer a moment to hand over a fresh snapshot for the next launch.
    await new Promise((r) => setTimeout(r, 1500));
    saveSnapshot();
    quitting = true;
    return void app.exit(0);
  }
});

ipcMain.on('renderer-ready', async (_e, info: { rows: number; view: 'list' | 'empty' }) => {
  clearTimeout(readyTimeout);
  if (bench && win) return void runBench(win, info);
  if (!smoke || !win) return;
  const msSinceLaunch = Math.round(performance.now() - launchedAt);
  const keys = info.view === 'list' ? await smokeKeys(win) : undefined;
  console.log(`[smoke] ${JSON.stringify({ ...info, msSinceLaunch, packaged: app.isPackaged, keys })}`);
  quitting = true;
  const ok = info.view === 'list' ? info.rows > 0 && keys!.ok : !noRealAccounts && info.view === 'empty';
  app.exit(ok ? 0 : 1);
});

/** The benchmark: real key presses against the 100,000-message fixture, checked against the budgets. */
async function runBench(w: BrowserWindow, info: { rows: number }) {
  const budgets = { ...BUDGETS, keyMoveMs: Number(process.env.NORMIE_BUDGET_KEY_MS) || BUDGETS.keyMoveMs };
  const press = async (keyCode: string, modifiers: 'meta'[] = []) => {
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (!modifiers.length) w.webContents.sendInputEvent({ type: 'char', keyCode });
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await new Promise((r) => setTimeout(r, 25));
  };
  await new Promise((r) => setTimeout(r, 500)); // let the first frames settle
  await w.webContents.executeJavaScript('window.__normiePerf.clear()');
  for (let i = 0; i < 200; i++) await press('j');
  for (let i = 0; i < 100; i++) await press('k');
  await new Promise((r) => setTimeout(r, 200));
  // Opening: Enter on the selected Thread, then j through the next 30 in the reader. Each step's Thread
  // was prefetched while the one before it was open.
  await press('Enter');
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 150));
    await press('j');
  }
  await new Promise((r) => setTimeout(r, 200));
  await press('Escape');
  // Triage: Done on 50 Threads in a row (the main run works on a copy of the fixture).
  await new Promise((r) => setTimeout(r, 200));
  for (let i = 0; i < 50; i++) await press('e');
  await new Promise((r) => setTimeout(r, 200));
  // The palette: open with Cmd-K, close with Escape.
  for (let i = 0; i < 40; i++) {
    await press('K', ['meta']);
    await new Promise((r) => setTimeout(r, 50));
    await press('Escape');
  }
  await new Promise((r) => setTimeout(r, 200));
  const samples = (await w.webContents.executeJavaScript('window.__normiePerf.samples()')) as { action: string; ms: number }[];
  const sorted = (xs: { ms: number }[]) => xs.map((s) => s.ms).sort((a, b) => a - b);
  const pctOf = (xs: number[]) => (p: number) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? Infinity;
  const ms = sorted(samples.filter((s) => s.action === 'list.down' || s.action === 'list.up'));
  const pct = pctOf(ms);
  const opens = sorted(samples.filter((s) => s.action === 'list.open' || s.action === 'reader.next'));
  const openPct = pctOf(opens);
  const dones = sorted(samples.filter((s) => s.action === 'thread.done'));
  const donePct = pctOf(dones);
  const palettes = sorted(samples.filter((s) => s.action === 'palette.open'));
  const palettePct = pctOf(palettes);
  // Memory is a steady-state budget: Chromium caches raster tiles while scrolling and frees them once idle
  // (measured: 444 MB right after 300 rapid presses, 271 MB about 7 s later). Report the peak, judge the settled value.
  const peak = measureMemory();
  await new Promise((r) => setTimeout(r, Number(process.env.NORMIE_BENCH_SETTLE_MS) || 8000));
  const memory = measureMemory();
  const results = [
    { budget: 'keyMoveMs', value: pct(95), limit: budgets.keyMoveMs, detail: `p50 ${pct(50).toFixed(1)}, p95 ${pct(95).toFixed(1)}, max ${(ms.at(-1) ?? 0).toFixed(1)} ms over ${ms.length} presses` },
    { budget: 'openCachedMs', value: openPct(95), limit: budgets.openCachedMs, detail: `p50 ${openPct(50).toFixed(1)}, p95 ${openPct(95).toFixed(1)}, max ${(opens.at(-1) ?? 0).toFixed(1)} ms over ${opens.length} opens` },
    { budget: 'triageMs', value: donePct(95), limit: budgets.triageMs, detail: `Done: p50 ${donePct(50).toFixed(1)}, p95 ${donePct(95).toFixed(1)}, max ${(dones.at(-1) ?? 0).toFixed(1)} ms over ${dones.length} Threads` },
    { budget: 'paletteMs', value: palettePct(95), limit: budgets.paletteMs, detail: `Cmd-K: p50 ${palettePct(50).toFixed(1)}, p95 ${palettePct(95).toFixed(1)}, max ${(palettes.at(-1) ?? 0).toFixed(1)} ms over ${palettes.length} opens` },
    { budget: 'memoryMb', value: memory.mb, limit: budgets.memoryMb, detail: `settled; ${memory.detail}; peak while scrolling ${peak.mb.toFixed(0)}` },
  ];
  const pressesOk = ms.length === 300 && opens.length === 31 && dones.length === 50 && palettes.length === 40;
  console.log(`\n[bench] fixture: ${info.rows} Inbox rows in the renderer`);
  for (const r of results) console.log(`[bench] ${r.value <= r.limit ? 'ok  ' : 'FAIL'} ${r.budget.padEnd(12)} ${r.value.toFixed(1).padStart(7)} / ${r.limit}   ${r.detail}`);
  if (!pressesOk) console.log(`[bench] FAIL expected 300 moves, 31 opens, 50 Dones and 40 palettes, got ${ms.length}, ${opens.length}, ${dones.length} and ${palettes.length}`);
  quitting = true;
  app.exit(pressesOk && results.every((r) => r.value <= r.limit) ? 0 : 1);
}

/** Total memory across the app's processes: physical footprint on macOS (as Activity Monitor shows), else working set. */
function measureMemory(): { mb: number; detail: string } {
  const metrics = app.getAppMetrics();
  if (process.platform === 'darwin') {
    try {
      const per = metrics.map((m) => {
        const out = execFileSync('footprint', ['-p', String(m.pid)], { encoding: 'utf8' });
        const [, n, unit] = /phys_footprint:\s+([\d.]+)\s+(KB|MB|GB)/.exec(out) ?? [];
        const mb = Number(n) * (unit === 'GB' ? 1024 : unit === 'KB' ? 1 / 1024 : 1);
        return { name: m.serviceName?.replace(/^(node|network)\.mojom\./, '') || m.type, mb };
      });
      return { mb: per.reduce((a, p) => a + p.mb, 0), detail: `physical footprint: ${per.map((p) => `${p.name} ${p.mb.toFixed(0)}`).join(', ')}` };
    } catch {
      // fall through to working set
    }
  }
  return { mb: metrics.reduce((a, m) => a + m.memory.workingSetSize, 0) / 1024, detail: `working set over ${metrics.length} processes` };
}

/** Smoke check: real key presses move the selection through the registry. */
async function smokeKeys(w: BrowserWindow) {
  const selectedIndex = () =>
    w.webContents.executeJavaScript(
      `(() => { const s = document.querySelector('.row.selected'); return s ? Math.round(s.offsetTop / s.offsetHeight) : -1; })()`,
    ) as Promise<number>;
  const press = async (keyCode: string, n = 1, modifiers: ('meta' | 'shift')[] = []) => {
    for (let i = 0; i < n; i++) {
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      if (!modifiers.includes('meta')) w.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
      w.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
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
  await press('Enter');
  await new Promise((r) => setTimeout(r, 300));
  const readerText = (await w.webContents.executeJavaScript(`document.querySelector('.reader .body')?.textContent ?? null`)) as string | null;
  await press('Escape');
  const readerClosed = (await w.webContents.executeJavaScript(`!document.querySelector('.reader')`)) as boolean;
  const reader = !!readerText && readerClosed;
  // Done takes the selected Thread out of the list.
  const count = () => w.webContents.executeJavaScript(`Number(document.querySelector('.split-bar .count')?.textContent)`) as Promise<number>;
  const before = await count();
  await press('e');
  const done = (await count()) === before - 1;
  // z brings it back.
  await press('z');
  const undone = (await count()) === before;
  // s stars the selected Thread.
  await press('s');
  const starred = (await w.webContents.executeJavaScript(`!!document.querySelector('.row.selected .star')`)) as boolean;
  // Cmd-K, type "done", Enter: the palette runs Mark Done and closes.
  const beforePalette = await count();
  await press('K', 1, ['meta']);
  const paletteOpen = (await w.webContents.executeJavaScript(`!!document.querySelector('.palette input')`)) as boolean;
  for (const ch of 'done') await press(ch);
  await press('Enter');
  const palette = paletteOpen && (await count()) === beforePalette - 1 && !((await w.webContents.executeJavaScript(`!!document.querySelector('.palette')`)) as boolean);
  // l opens the Label picker with the Account's Labels.
  await press('l');
  const labelItems = (await w.webContents.executeJavaScript(`[...document.querySelectorAll('.palette li span')].map((s) => s.textContent)`)) as string[];
  await press('Escape');
  const label = labelItems.includes('Receipts');
  // keymap.json is picked up without a restart: bind star to y, and y toggles the selected Thread's star.
  const isStarred = () => w.webContents.executeJavaScript(`!!document.querySelector('.row.selected .star')`) as Promise<boolean>;
  const starBefore = await isStarred();
  writeFileSync(keymapPath(), JSON.stringify({ 'thread.star': 'y' }));
  await new Promise((r) => setTimeout(r, 600));
  await press('y');
  const keymapOk = (await isStarred()) !== starBefore;
  const ok = start === 0 && afterJ === 5 && afterK === 3 && afterGG === 0 && reader && done && undone && starred && palette && label && keymapOk;
  return { ok, start, afterJ, afterK, afterGG, reader, done, undone, starred, palette, label, keymap: keymapOk };
}

ipcMain.handle('accounts:list', () => accounts.list());
ipcMain.handle('accounts:add-gmail', async (_e, loginHint?: string): Promise<AccountRecord> => {
  const acct = await accounts.addGmail(loginHint);
  app.focus({ steal: true });
  win?.focus();
  return acct;
});
ipcMain.handle('accounts:remove', (_e, id: string) => accounts.remove(id));

// --- Keymap: the user's key overrides, in keymap.json next to the store. Read at launch and whenever it changes.

type KeymapFile = { file?: unknown; error?: string };
const keymapPath = () => path.join(app.getPath('userData'), 'keymap.json');
let keymap: KeymapFile = {};

function readKeymap(): KeymapFile {
  if (!existsSync(keymapPath())) return {};
  try {
    return { file: JSON.parse(readFileSync(keymapPath(), 'utf8')) as unknown };
  } catch (e) {
    return { error: `keymap.json isn't valid JSON: ${(e as Error).message}` };
  }
}

function watchKeymap() {
  keymap = readKeymap();
  let timer: NodeJS.Timeout | undefined;
  try {
    // Watch the folder, not the file: editors often save by replacing it.
    watch(app.getPath('userData'), (_event, name) => {
      if (name !== 'keymap.json') return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        keymap = readKeymap();
        buildMenu();
        win?.webContents.send('keymap:changed', keymap);
      }, 100);
    });
  } catch (e) {
    console.error(`[main] can't watch keymap.json: ${(e as Error).message}`);
  }
}
ipcMain.handle('keymap:get', () => keymap);

/** Native menus: the standard Mac menus plus Go, Thread and View built from the registry, with the user's keys. */
function buildMenu() {
  const fromRegistry: MenuItemConstructorOptions[] = menuSections(mergeKeymap(ACTIONS, keymap.file).actions).map((s) => ({
    label: s.label,
    submenu: s.entries.map((e) => ({
      label: e.label,
      ...(e.accelerator ? { accelerator: e.accelerator, registerAccelerator: e.registerAccelerator } : {}),
      click: () => win?.webContents.send('menu:action', e.ids),
    })),
  }));
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : [{ role: 'fileMenu' as const }]),
    { role: 'editMenu' },
    ...fromRegistry,
    { role: 'windowMenu' },
  ];
  if (!app.isPackaged) (template.at(-2)!.submenu as MenuItemConstructorOptions[]).push({ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  watchKeymap();
  buildMenu();
  loadSnapshot();
  initAccounts();
  startData();
  createWindow();
  // If the renderer never reports a first frame, still start sync.
  setTimeout(startSync, 5000);
  if (smoke || bench || coldStartRun) readyTimeout = setTimeout(() => {
    console.error('[smoke/bench] renderer never reported ready');
    app.exit(1);
  }, 20_000);
});

app.on('before-quit', () => {
  quitting = true;
  saveSnapshot();
  dataProc?.kill();
  syncProc?.kill();
});

app.on('window-all-closed', () => app.quit());
