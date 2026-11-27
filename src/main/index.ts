// The main process: windows, process wiring and (later) sign-in and secrets.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, Tray, MessageChannelMain, shell, utilityProcess } from 'electron';
import type { MenuItemConstructorOptions, UtilityProcess } from 'electron';
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { types } from 'node:util';
import { errorMessage, expected } from '../core/errors';
import { parseJson } from '../core/json';
import { log, logError } from '../core/log';
import { sleep } from '../core/sleep';
import { mainPortChannel, serve } from '../core/rpc';
import { isRisky, quarantine, safeFilename } from './attachments';
import type { AccountConfig } from '../sync/index';
import { Accounts, identitiesOf } from './auth/accounts';
import type { AccountRecord, Identity } from './auth/accounts';
import { JsonAccountList, SafeStorageSecrets } from './auth/electron-stores';
import { loadGoogleClient } from './auth/google-oauth';
import { AccountSetupError } from './auth/password-accounts';
import type { PasswordAccountInput } from './auth/password-accounts';
import { verifyPasswordAccount } from './auth/verify';
import { BUDGETS } from '../core/budgets';
import { mergeKeymap } from '../renderer/commands/keymap';
import { menuSections } from '../renderer/commands/menu';
import { runBench } from './bench';
import { runSmoke } from './smoke';
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
if (process.env.NORMIE_USER_DATA) {
  app.setPath('userData', process.env.NORMIE_USER_DATA);
} else if (smoke) {
  app.setPath('userData', path.join(app.getPath('temp'), `normie-smoke-${process.pid}`));
}

let dataProc: UtilityProcess | undefined;
let syncProc: UtilityProcess | undefined;
let win: BrowserWindow | undefined;

function dbPath() {
  if (process.env.NORMIE_DB) {
    return process.env.NORMIE_DB;
  }
  const name = useFake ? 'normie-fake.sqlite' : 'normie.sqlite';
  const p = path.join(app.getPath('userData'), name);
  if (smoke) {
    for (const ext of ['', '-wal', '-shm']) {
      rmSync(p + ext, { force: true });
    }
  }
  return p;
}

/** The Desktop OAuth client from Google Cloud. It lives outside the repo. */
const googleClientPath = () => process.env.NORMIE_GOOGLE_CLIENT ?? path.join(homedir(), '.config/normie/google-oauth-client.json');

let accounts: Accounts;

function initAccounts() {
  const dir = app.getPath('userData');
  // The fake smoke run has an iCloud Account whose password stopped working, to check "Sign in again" opens its own form.
  if (smoke && useFake) {
    writeFileSync(
      path.join(dir, 'accounts.json'),
      JSON.stringify([
        {
          id: 'icloud:smoke@icloud.com@imap.mail.me.com',
          kind: 'imap',
          email: 'smoke@icloud.com',
          status: 'needs-sign-in',
          settings: {
            provider: 'icloud',
            email: 'smoke@icloud.com',
            user: 'smoke@icloud.com',
            savesSent: false,
            imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' },
            smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
          },
        },
      ]),
    );
  }
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

function syncAccounts(): Array<AccountConfig> {
  if (provider === 'none') {
    return [];
  }
  if (useFake) {
    const seed = Number(process.env.NORMIE_FAKE_SEED) || undefined;
    return [{ kind: 'fake', accountId: 'fake:me@example.com', email: 'me@example.com', seed }];
  }
  return accounts.list().map((a): AccountConfig => {
    const identities = identitiesOf(a).map((i) => i.address);
    return a.kind === 'imap'
      ? { kind: 'imap', accountId: a.id, email: a.email, status: a.status, settings: a.settings, identities }
      : { kind: 'gmail', accountId: a.id, email: a.email, status: a.status, identities };
  });
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
  if (syncProc || !dataProc) {
    return;
  }
  syncProc = utilityProcess.fork(path.join(__dirname, '../sync/index.js'), [], { serviceName: 'Normie Sync', stdio: 'inherit' });
  const dataSync = new MessageChannelMain();
  dataProc.postMessage({ type: 'sync-port' }, [dataSync.port1]);
  syncProc.postMessage({ type: 'data-port' }, [dataSync.port2]);
  // Sync asks main for access tokens; main holds the secrets and refreshes them.
  const mainSync = new MessageChannelMain();
  serve(mainPortChannel(mainSync.port1), { accessToken: (id: string) => accounts.accessToken(id), password: (id: string) => accounts.password(id) });
  syncProc.postMessage({ type: 'main-port' }, [mainSync.port2]);
  syncProc.postMessage({ type: 'accounts', accounts: syncAccounts() });
  watchExit('sync', syncProc);
}

function watchExit(name: string, proc: UtilityProcess) {
  proc.on('exit', (code) => {
    if (code !== 0 && !quitting) {
      logError(`[main] ${name} process exited with ${code}`);
    }
  });
}

// --- Snapshot: the top rows of the last Split, drawn on launch before the core answers.

const snapshotFile = () => path.join(app.getPath('userData'), 'snapshot.json');
let snapshot: Array<unknown> = [];

function loadSnapshot() {
  try {
    const rows = parseJson(readFileSync(snapshotFile(), 'utf8'));
    snapshot = Array.isArray(rows) ? rows : [];
  } catch {
    snapshot = [];
  }
}

function saveSnapshot() {
  try {
    writeFileSync(snapshotFile(), JSON.stringify(snapshot));
  } catch (error) {
    logError(`[main] could not save snapshot: ${errorMessage(error)}`);
  }
}

ipcMain.on('snapshot:get', (e) => (e.returnValue = snapshot));
ipcMain.on('snapshot:set', (_e, rows: Array<unknown>) => {
  if (Array.isArray(rows)) {
    snapshot = rows.slice(0, 100);
  }
});

/** Give the renderer a fresh port to the data process. Called on every load, so reloads work. */
function connectRenderer(w: BrowserWindow) {
  const ch = new MessageChannelMain();
  dataProc?.postMessage({ type: 'renderer-port' }, [ch.port1]);
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
  // Closing the window keeps Normie running in the menu bar, so sync and timed work carry on. Quit really quits.
  w.on('close', (e) => {
    if (quitting) {
      return;
    }
    e.preventDefault();
    w.hide();
    if (process.platform === 'darwin') {
      app.dock?.hide();
    }
  });
  // Coming back to the window is a good moment to check for changes.
  w.on('focus', () => syncProc?.postMessage({ type: 'poll' }));
  // Links never navigate the app window: http, https and mailto go to the system, everything else is dropped.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  // The reader frame is filled from this page and never navigates; nor does any other frame.
  w.webContents.on('will-frame-navigate', (e) => {
    if (!e.isMainFrame && !/^about:(srcdoc|blank)$/.test(e.url)) {
      e.preventDefault();
    }
  });
  // Shown once the first useful frame is painted (see renderer-ready), with a fallback so it always appears.
  if (!smoke && !bench && !coldStartRun) {
    showTimer = setTimeout(() => showWindow(w), 3000);
  }
  void w.loadFile(path.join(__dirname, '../renderer/index.html'));
}

let quitting = false;

let readyTimeout: NodeJS.Timeout | undefined;
let shownOnce = false;
const openedAtLogin = process.platform === 'darwin' && app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin;

// --- The menu bar item: open Normie, the Inbox count, start at login, quit.

/** Which build this is (set by scripts/build.mjs): commit and build time. */
declare const __NORMIE_BUILD__: { commit: string; time: string } | undefined;
const buildInfo = __NORMIE_BUILD__ === undefined ? { commit: 'dev', time: '' } : __NORMIE_BUILD__;
const buildLabel = `${buildInfo.commit}${buildInfo.time ? `, built ${new Date(buildInfo.time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : ''}`;

let tray: Tray | undefined;
let inboxCount = 0;

/** Bring the window back (from the menu bar, the Dock, or a notification). */
function openWindow() {
  shownOnce = true;
  if (!win) {
    return;
  }
  if (process.platform === 'darwin') {
    void app.dock?.show();
  }
  win.show();
  win.focus();
}

function buildTray() {
  if (bench || coldStartRun) {
    return;
  }
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Normie');
  updateTray();
}

function updateTray() {
  if (!tray) {
    return;
  }
  tray.setTitle(inboxCount ? ` ${inboxCount}` : '');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Normie', click: openWindow },
      { label: inboxCount === 1 ? '1 Thread in the Inbox' : `${inboxCount} Threads in the Inbox`, enabled: false },
      { type: 'separator' },
      { label: 'Start at Login', type: 'checkbox', checked: loginItem(), enabled: app.isPackaged, click: (i) => setLoginItem(i.checked) },
      { type: 'separator' },
      { label: `Build ${buildLabel}`, enabled: false },
      { label: 'Quit Normie', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
    ]),
  );
}

// --- Start at login: on by default for the installed app (never for a dev build, which would register Electron).

type Settings = { openAtLogin?: boolean };
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings(): Settings {
  try {
    const v = parseJson(readFileSync(settingsPath(), 'utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof v.openAtLogin === 'boolean' ? { openAtLogin: v.openAtLogin } : {};
  } catch {
    return {};
  }
}
const loginItem = () => readSettings().openAtLogin ?? true;
function setLoginItem(on: boolean) {
  writeFileSync(settingsPath(), JSON.stringify({ ...readSettings(), openAtLogin: on }));
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: on });
  }
  updateTray();
}
ipcMain.handle('login-item:toggle', () => {
  setLoginItem(!loginItem());
  return { on: loginItem(), packaged: app.isPackaged };
});
ipcMain.on('theme', (_e, t: unknown) => {
  if (t !== 'mocha' && t !== 'latte' && t !== 'system') {
    return;
  }
  nativeTheme.themeSource = t === 'mocha' ? 'dark' : t === 'latte' ? 'light' : 'system';
  win?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1e1e2e' : '#eff1f5');
});
ipcMain.on('inbox-count', (_e, n: unknown) => {
  if (typeof n !== 'number' || n === inboxCount) {
    return;
  }
  inboxCount = n;
  updateTray();
});
let showTimer: NodeJS.Timeout | undefined;

function showWindow(w: BrowserWindow) {
  clearTimeout(showTimer);
  if (w.isVisible() || smoke || coldStartRun) {
    return;
  }
  // Started at login: stay in the menu bar until asked.
  if (openedAtLogin && !shownOnce) {
    return;
  }
  shownOnce = true;
  if (process.platform === 'darwin') {
    void app.dock?.show();
  }
  if (bench) {
    w.showInactive();
  } else {
    w.show();
  }
}

async function onFirstPaint(info: { rows: number; fromSnapshot: boolean }) {
  const msSinceProcessStart = Math.round(process.uptime() * 1000);
  if (win) {
    showWindow(win);
  }
  startSync();
  if (coldStartRun) {
    clearTimeout(readyTimeout);
    log(`[coldstart] ${JSON.stringify({ ms: msSinceProcessStart, fromSnapshot: info.fromSnapshot, rows: info.rows, budget: BUDGETS.coldStartMs })}`);
    // Give the renderer a moment to hand over a fresh snapshot for the next launch.
    await sleep(1500);
    saveSnapshot();
    quitting = true;
    return void app.exit(0);
  }
}
ipcMain.on('renderer-first-paint', (_e, info: { rows: number; fromSnapshot: boolean }) => {
  onFirstPaint(info).catch(logError);
});

async function onRendererReady(info: { rows: number; view: 'list' | 'empty' }) {
  clearTimeout(readyTimeout);
  if (bench && win && dataProc) {
    const ok = await runBench(win, info, dataProc);
    quitting = true;
    return void app.exit(ok ? 0 : 1);
  }
  if (!smoke || !win) {
    return;
  }
  const { ok, report } = await runSmoke(
    win,
    info,
    {
      trayAlive: () => !!tray && !tray.isDestroyed(),
      userFile: (name) => path.join(app.getPath('userData'), name),
      noRealAccounts,
    },
    Math.round(performance.now() - launchedAt),
  );
  log(`[smoke] ${JSON.stringify(report)}`);
  quitting = true;
  app.exit(ok ? 0 : 1);
}
ipcMain.on('renderer-ready', (_e, info: { rows: number; view: 'list' | 'empty' }) => {
  onRendererReady(info).catch(logError);
});

type AttachmentFile = { filename: string; content: Uint8Array };
const validFile = (f: unknown): f is AttachmentFile =>
  typeof f === 'object' && f !== null && 'filename' in f && typeof f.filename === 'string' && 'content' in f && types.isUint8Array(f.content);

/** Open an attachment with the system's app for it. Anything that runs code is refused: save it instead. */
ipcMain.handle('attachment:open', async (_e, file: unknown): Promise<{ ok: boolean; reason?: string }> => {
  if (!validFile(file)) {
    return { ok: false, reason: 'bad request' };
  }
  const name = safeFilename(file.filename);
  if (isRisky(name)) {
    return { ok: false, reason: 'risky' };
  }
  const dir = mkdtempSync(path.join(app.getPath('temp'), 'normie-attachment-'));
  const target = path.join(dir, name);
  writeFileSync(target, file.content, { mode: 0o600 });
  await quarantine(target);
  const error = await shell.openPath(target);
  return error ? { ok: false, reason: error } : { ok: true };
});

/** Save an attachment where the user chooses. */
ipcMain.handle('attachment:save', async (_e, file: unknown): Promise<{ ok: boolean; path?: string }> => {
  if (!validFile(file) || !win) {
    return { ok: false };
  }
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), safeFilename(file.filename)) });
  if (r.canceled || !r.filePath) {
    return { ok: false };
  }
  writeFileSync(r.filePath, file.content);
  await quarantine(r.filePath);
  return { ok: true, path: r.filePath };
});

/** New mail in a notifying Split. Clicking brings Normie forward with that Thread open. */
ipcMain.on('notify', (_e, n: { key: string; title: string; body: string }) => {
  if (!Notification.isSupported() || typeof n?.key !== 'string') {
    return;
  }
  const note = new Notification({ title: String(n.title).slice(0, 120), body: String(n.body).slice(0, 240) });
  note.on('click', () => {
    openWindow();
    win?.webContents.send('open-thread', n.key);
  });
  note.show();
});

ipcMain.on('open-link', (_e, url: unknown) => {
  if (typeof url === 'string' && /^(https?|mailto):/i.test(url)) {
    void shell.openExternal(url);
  }
});

ipcMain.handle('accounts:list', () => accounts.list());
ipcMain.handle('accounts:add-gmail', async (_e, loginHint?: string): Promise<AccountRecord> => {
  const acct = await accounts.addGmail(loginHint);
  app.focus({ steal: true });
  win?.focus();
  return acct;
});
ipcMain.handle('accounts:remove', (_e, id: string) => accounts.remove(id));
/** Replace an Account's Identities (the first is the default). */
ipcMain.handle('accounts:set-identities', (_e, id: string, identities: Array<Identity>): { ok: true } | { ok: false; error: string } => {
  try {
    accounts.setIdentities(id, identities);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
});

type AddPasswordFailure = { ok: false; error: string; field?: string };

/** Add an iCloud or IMAP Account. Errors come back as plain messages the form shows. */
ipcMain.handle(
  'accounts:add-password',
  async (_e, input: PasswordAccountInput): Promise<{ ok: true; account: AccountRecord } | { ok: false; error: string; field?: string }> => {
    try {
      return { ok: true, account: await accounts.addPassword(input, verifyPasswordAccount) };
    } catch (error) {
      const failure: AddPasswordFailure = { ok: false, error: errorMessage(error) };
      if (error instanceof AccountSetupError && error.field) {
        failure.field = error.field;
      }
      return failure;
    }
  },
);

// --- Keymap: the user's key overrides, in keymap.json next to the store. Read at launch and whenever it changes.

// The user's own files next to the store: keymap.json (keys) and snippets.json (text to insert while writing).
type UserFile = { file?: unknown; error?: string };
const keymapPath = () => path.join(app.getPath('userData'), 'keymap.json');
const snippetsPath = () => path.join(app.getPath('userData'), 'snippets.json');
const splitsPath = () => path.join(app.getPath('userData'), 'splits.json');
let keymap: UserFile = {};
let snippets: UserFile = {};
let splitsFile: UserFile = {};

function readUserFile(file: string): UserFile {
  if (!existsSync(file)) {
    return {};
  }
  try {
    return { file: parseJson(readFileSync(file, 'utf8')) };
  } catch (error) {
    return { error: `${path.basename(file)} isn't valid JSON: ${errorMessage(error)}` };
  }
}

function watchUserFiles() {
  keymap = readUserFile(keymapPath());
  snippets = readUserFile(snippetsPath());
  splitsFile = readUserFile(splitsPath());
  const timers: Record<string, NodeJS.Timeout | undefined> = {};
  try {
    // Watch the folder, not the files: editors often save by replacing them.
    watch(app.getPath('userData'), (_event, name) => {
      if (name !== 'keymap.json' && name !== 'snippets.json' && name !== 'splits.json') {
        return;
      }
      clearTimeout(timers[name]);
      timers[name] = setTimeout(() => {
        if (name === 'keymap.json') {
          keymap = readUserFile(keymapPath());
          buildMenu();
          win?.webContents.send('keymap:changed', keymap);
        } else if (name === 'snippets.json') {
          snippets = readUserFile(snippetsPath());
          win?.webContents.send('snippets:changed', snippets);
        } else {
          splitsFile = readUserFile(splitsPath());
          win?.webContents.send('splits:changed', splitsFile);
        }
      }, 100);
    });
  } catch (error) {
    logError(`[main] can't watch the data folder: ${errorMessage(error)}`);
  }
}
ipcMain.handle('keymap:get', () => keymap);
ipcMain.handle('snippets:get', () => snippets);
ipcMain.handle('splits:get', () => splitsFile);

/** Native menus: the standard Mac menus plus Go, Thread and View built from the registry, with the user's keys. */
function buildMenu() {
  const fromRegistry: Array<MenuItemConstructorOptions> = menuSections(mergeKeymap(ACTIONS, keymap.file).actions).map((s) => ({
    label: s.label,
    submenu: s.entries.map((e) => {
      const item: MenuItemConstructorOptions = { label: e.label, click: () => win?.webContents.send('menu:action', e.ids) };
      if (e.accelerator) {
        item.accelerator = e.accelerator;
        item.registerAccelerator = e.registerAccelerator;
      }
      return item;
    }),
  }));
  const template: Array<MenuItemConstructorOptions> = [
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
  if (!app.isPackaged) {
    const view = expected(template.at(-2), 'the View menu').submenu;
    if (Array.isArray(view)) {
      view.push({ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' });
    }
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('activate', openWindow);

app.once('ready', () => {
  app.setAboutPanelOptions({
    applicationName: 'Normie',
    applicationVersion: app.getVersion(),
    version: buildLabel,
    credits: 'A keyboard-first mail client for Gmail, iCloud and IMAP.',
  });
  if (app.isPackaged && !smoke) {
    app.setLoginItemSettings({ openAtLogin: loginItem() });
  }
  buildTray();
  watchUserFiles();
  buildMenu();
  loadSnapshot();
  initAccounts();
  startData();
  createWindow();
  // If the renderer never reports a first frame, still start sync.
  setTimeout(startSync, 5000);
  if (smoke || bench || coldStartRun) {
    readyTimeout = setTimeout(() => {
      logError('[smoke/bench] renderer never reported ready');
      app.exit(1);
    }, 20_000);
  }
});

app.on('before-quit', () => {
  quitting = true;
  saveSnapshot();
  dataProc?.kill();
  syncProc?.kill();
});

// The window only ever hides (see createWindow); Normie lives on in the menu bar until Quit.
app.on('window-all-closed', () => {});
