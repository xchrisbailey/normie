// The main process: windows, process wiring and (later) sign-in and secrets.
import { app, BrowserWindow, dialog, ipcMain, Menu, MessageChannelMain, shell, utilityProcess, type MenuItemConstructorOptions, type UtilityProcess } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { mainPortChannel, serve } from '../core/rpc';
import { isRisky, quarantine, safeFilename } from './attachments';
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
  // The reader frame is filled from this page and never navigates; nor does any other frame.
  w.webContents.on('will-frame-navigate', (e) => {
    if (!e.isMainFrame && !/^about:(srcdoc|blank)$/.test(e.url)) e.preventDefault();
  });
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
  await new Promise((r) => setTimeout(r, 500));
  // The newest fake Thread is an HTML newsletter with a script, a tracking pixel and a javascript: link.
  const frame = (await w.webContents.executeJavaScript(`(() => {
    const f = document.querySelector('.mail-frame');
    const d = f && f.contentDocument;
    const sr = d && d.querySelector('.html') && d.querySelector('.html').shadowRoot;
    const r = f ? f.getBoundingClientRect() : null;
    return { sandbox: f && f.getAttribute('sandbox'), html: sr ? sr.innerHTML : '', text: sr ? sr.textContent : '',
      bar: !!document.querySelector('.images-bar'), x: r ? r.left + r.width / 2 : 0, y: r ? r.top + 60 : 0,
      attachment: d ? [...d.querySelectorAll('.attachment')].map((a) => a.textContent).join('|') : '' };
  })()`)) as { sandbox: string | null; html: string; text: string; bar: boolean; x: number; y: number; attachment: string };
  const html = frame.sandbox === 'allow-same-origin' && frame.text.includes('Hello from Normie') && frame.bar && frame.attachment.includes('agenda.txt')
    && !/<script|tracker\.example|javascript:/i.test(frame.html);
  // Click into the message, then Esc: keys still reach the app from inside the frame.
  for (const type of ['mouseDown', 'mouseUp'] as const) w.webContents.sendInputEvent({ type, x: Math.round(frame.x), y: Math.round(frame.y), button: 'left', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 100));
  const focusedFrame = (await w.webContents.executeJavaScript(`document.activeElement?.className === 'mail-frame'`)) as boolean;
  await press('Escape');
  const readerClosed = (await w.webContents.executeJavaScript(`!document.querySelector('.reader')`)) as boolean;
  // Main refuses to open a file that would run code.
  const riskyRefused = ((await w.webContents.executeJavaScript(
    `window.normie.openAttachment({ filename: 'setup.command', content: new TextEncoder().encode('echo hi') }).then((r) => r.reason)`,
  )) as string) === 'risky';
  const reader = html && focusedFrame && readerClosed && riskyRefused;
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
  // c, type a message, Cmd-Enter sends; Cmd-Z inside the undo window brings it back; Esc closes.
  const typeText = async (text: string) => {
    for (const ch of text) w.webContents.sendInputEvent({ type: 'char', keyCode: ch });
    await new Promise((r) => setTimeout(r, 50));
  };
  await press('c');
  await new Promise((r) => setTimeout(r, 300));
  const composerOpen = (await w.webContents.executeJavaScript(`!!document.querySelector('.composer textarea')`)) as boolean;
  await typeText('ada@example.com');
  await press('Tab');
  await typeText('Smoke test');
  await press('Tab');
  await typeText('Hello **there**');
  await press('Return', 1, ['meta']);
  const sentClosed = (await w.webContents.executeJavaScript(`!document.querySelector('.composer')`)) as boolean;
  await press('Z', 1, ['meta']);
  await new Promise((r) => setTimeout(r, 300));
  const reopened = (await w.webContents.executeJavaScript(
    `(() => { const c = document.querySelector('.composer'); if (!c) return ''; return [...c.querySelectorAll('input:not([type=file])')].map((i) => i.value).join('|') + '|' + c.querySelector('textarea').value; })()`,
  )) as string;
  await press('Escape');
  const compose = composerOpen && sentClosed && reopened === 'ada@example.com|Smoke test|Hello **there**'
    && ((await w.webContents.executeJavaScript(`!document.querySelector('.composer')`)) as boolean);
  // r replies to the selected Thread: someone to write to, "Re:", and the quote below the cursor.
  await press('r');
  await new Promise((r) => setTimeout(r, 500));
  const replyFields = (await w.webContents.executeJavaScript(
    `(() => { const c = document.querySelector('.composer'); if (!c) return null; const i = [...c.querySelectorAll('input:not([type=file])')].map((x) => x.value); return { to: i[0], subject: i[i.length - 1], body: c.querySelector('textarea').value, focused: document.activeElement === c.querySelector('textarea') }; })()`,
  )) as { to: string; subject: string; body: string; focused: boolean } | null;
  await press('Escape');
  const reply = !!replyFields && /@/.test(replyFields.to) && replyFields.subject.startsWith('Re: ') && /^\n\nOn .* wrote:\n> /.test(replyFields.body) && replyFields.focused;
  // A draft: type, Esc keeps it, Cmd-K "draft" reopens it; Cmd-Shift-Backspace discards it.
  await press('c');
  await new Promise((r) => setTimeout(r, 300));
  await typeText('grace@example.com');
  await new Promise((r) => setTimeout(r, 1200));
  await press('Escape');
  await press('K', 1, ['meta']);
  await new Promise((r) => setTimeout(r, 300));
  await typeText('draft');
  const draftListed = (await w.webContents.executeJavaScript(`[...document.querySelectorAll('.palette li span')].some((s) => s.textContent.startsWith('Draft:'))`)) as boolean;
  await press('Return');
  await new Promise((r) => setTimeout(r, 300));
  const draftTo = (await w.webContents.executeJavaScript(`document.querySelector('.composer input')?.value ?? ''`)) as string;
  w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace', modifiers: ['meta', 'shift'] });
  w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace', modifiers: ['meta', 'shift'] });
  await new Promise((r) => setTimeout(r, 300));
  await press('K', 1, ['meta']);
  await new Promise((r) => setTimeout(r, 300));
  await typeText('draft');
  const draftGone = !((await w.webContents.executeJavaScript(`[...document.querySelectorAll('.palette li span')].some((s) => s.textContent.startsWith('Draft:'))`)) as boolean);
  await press('Escape');
  const drafts = draftListed && draftTo === 'grace@example.com' && draftGone;
  // Attach by dropping a file on the composer; it goes with the message and comes back with Undo Send.
  await press('c');
  await new Promise((r) => setTimeout(r, 300));
  await w.webContents.executeJavaScript(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['bring snacks'], 'plan.txt', { type: 'text/plain' }));
    const c = document.querySelector('.composer');
    c.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    c.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  const chip = () => w.webContents.executeJavaScript(`[...document.querySelectorAll('.composer .attachments li')].map((l) => l.textContent).join('|')`) as Promise<string>;
  const dropped = await chip();
  await typeText('ada@example.com');
  await press('Return', 1, ['meta']);
  await press('Z', 1, ['meta']);
  await new Promise((r) => setTimeout(r, 300));
  const keptOnUndo = await chip();
  await press('Escape');
  const attachments = dropped.startsWith('plan.txt') && keptOnUndo.startsWith('plan.txt');
  // Address suggestions: "gra", Tab → Grace Hopper.
  await press('c');
  await new Promise((r) => setTimeout(r, 300));
  await typeText('gra');
  await new Promise((r) => setTimeout(r, 200));
  const suggested = (await w.webContents.executeJavaScript(`[...document.querySelectorAll('.suggestions li')].map((l) => l.textContent).join('|')`)) as string;
  await press('Tab');
  const picked = (await w.webContents.executeJavaScript(`document.querySelector('.composer input:not([type=file])').value`)) as string;
  await press('Escape');
  const autocomplete = suggested.startsWith('Grace Hopper') && picked === 'Grace Hopper <grace@example.com>, ';
  // Snippets: snippets.json is picked up without a restart; ";thanks" then Tab in the body expands it.
  writeFileSync(snippetsPath(), JSON.stringify({ thanks: 'Thanks so much!' }));
  await new Promise((r) => setTimeout(r, 600));
  await press('c');
  await new Promise((r) => setTimeout(r, 300));
  await typeText('ada@example.com');
  await press('Tab');
  await press('Tab');
  await typeText('Great work. ;thanks');
  await press('Tab');
  const expanded = (await w.webContents.executeJavaScript(`document.querySelector('.composer textarea').value`)) as string;
  await press('Escape');
  const snippet = expanded === 'Great work. Thanks so much!';
  const ok = start === 0 && afterJ === 5 && afterK === 3 && afterGG === 0 && reader && done && undone && starred && palette && label && keymapOk && compose && reply && drafts && attachments && autocomplete && snippet;
  return { ok, start, afterJ, afterK, afterGG, reader, html, focusedFrame, readerClosed, riskyRefused, done, undone, starred, palette, label, keymap: keymapOk, compose, reopened, reply, drafts, attachments, autocomplete, snippet, expanded };
}

type AttachmentFile = { filename: string; content: Uint8Array };
const validFile = (f: unknown): f is AttachmentFile =>
  !!f && typeof (f as AttachmentFile).filename === 'string' && (f as AttachmentFile).content instanceof Uint8Array;

/** Open an attachment with the system's app for it. Anything that runs code is refused: save it instead. */
ipcMain.handle('attachment:open', async (_e, file: unknown): Promise<{ ok: boolean; reason?: string }> => {
  if (!validFile(file)) return { ok: false, reason: 'bad request' };
  const name = safeFilename(file.filename);
  if (isRisky(name)) return { ok: false, reason: 'risky' };
  const dir = mkdtempSync(path.join(app.getPath('temp'), 'normie-attachment-'));
  const target = path.join(dir, name);
  writeFileSync(target, file.content, { mode: 0o600 });
  await quarantine(target);
  const error = await shell.openPath(target);
  return error ? { ok: false, reason: error } : { ok: true };
});

/** Save an attachment where the user chooses. */
ipcMain.handle('attachment:save', async (_e, file: unknown): Promise<{ ok: boolean; path?: string }> => {
  if (!validFile(file) || !win) return { ok: false };
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), safeFilename(file.filename)) });
  if (r.canceled || !r.filePath) return { ok: false };
  writeFileSync(r.filePath, file.content);
  await quarantine(r.filePath);
  return { ok: true, path: r.filePath };
});

ipcMain.on('open-link', (_e, url: unknown) => {
  if (typeof url === 'string' && /^(https?|mailto):/i.test(url)) void shell.openExternal(url);
});

ipcMain.handle('accounts:list', () => accounts.list());
ipcMain.handle('accounts:add-gmail', async (_e, loginHint?: string): Promise<AccountRecord> => {
  const acct = await accounts.addGmail(loginHint);
  app.focus({ steal: true });
  win?.focus();
  return acct;
});
ipcMain.handle('accounts:remove', (_e, id: string) => accounts.remove(id));

// --- Keymap: the user's key overrides, in keymap.json next to the store. Read at launch and whenever it changes.

// The user's own files next to the store: keymap.json (keys) and snippets.json (text to insert while writing).
type UserFile = { file?: unknown; error?: string };
const keymapPath = () => path.join(app.getPath('userData'), 'keymap.json');
const snippetsPath = () => path.join(app.getPath('userData'), 'snippets.json');
let keymap: UserFile = {};
let snippets: UserFile = {};

function readUserFile(file: string): UserFile {
  if (!existsSync(file)) return {};
  try {
    return { file: JSON.parse(readFileSync(file, 'utf8')) as unknown };
  } catch (e) {
    return { error: `${path.basename(file)} isn't valid JSON: ${(e as Error).message}` };
  }
}

function watchUserFiles() {
  keymap = readUserFile(keymapPath());
  snippets = readUserFile(snippetsPath());
  const timers: Record<string, NodeJS.Timeout | undefined> = {};
  try {
    // Watch the folder, not the files: editors often save by replacing them.
    watch(app.getPath('userData'), (_event, name) => {
      if (name !== 'keymap.json' && name !== 'snippets.json') return;
      clearTimeout(timers[name]);
      timers[name] = setTimeout(() => {
        if (name === 'keymap.json') {
          keymap = readUserFile(keymapPath());
          buildMenu();
          win?.webContents.send('keymap:changed', keymap);
        } else {
          snippets = readUserFile(snippetsPath());
          win?.webContents.send('snippets:changed', snippets);
        }
      }, 100);
    });
  } catch (e) {
    console.error(`[main] can't watch the data folder: ${(e as Error).message}`);
  }
}
ipcMain.handle('keymap:get', () => keymap);
ipcMain.handle('snippets:get', () => snippets);

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
    // Undo is ours: in a text field it undoes typing; elsewhere it's Undo Send.
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CommandOrControl+Z', click: () => win?.webContents.send('menu:action', ['edit.undo']) },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    ...fromRegistry,
    { role: 'windowMenu' },
  ];
  if (!app.isPackaged) (template.at(-2)!.submenu as MenuItemConstructorOptions[]).push({ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  watchUserFiles();
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
