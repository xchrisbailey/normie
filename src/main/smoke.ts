// The smoke checks, run inside the app (NORMIE_SMOKE=1 via npm run smoke and smoke:packaged). Every new piece of UI
// gets a step here that reaches it the way a person does (the top bar, a key, the palette), over a full list, using
// drive.ts: real key presses, clicks checked with elementFromPoint, menu commands. A step for a bug fix should fail on
// the old code first.
import type { BrowserWindow } from 'electron';
import { app } from 'electron';
import { writeFileSync } from 'node:fs';
import { sleep } from '../core/sleep';
import { drive } from './drive';

/** What the smoke checks need from the app around them. */
export interface SmokeContext {
  /** The menu bar item exists. */
  trayAlive: () => boolean;
  /** A file in the app's data folder (keymap.json, snippets.json, splits.json). */
  userFile: (name: string) => string;
  /** Running without real Accounts (fake or benchmark). */
  noRealAccounts: boolean;
}

/** Run the checks for the view the app came up in. Returns whether they all passed, and the report to print. */
export async function runSmoke(w: BrowserWindow, info: { rows: number; view: 'list' | 'empty' }, ctx: SmokeContext, msSinceLaunch: number) {
  const reauth = info.view === 'list' ? await smokeReauth(w) : undefined;
  const form = info.view === 'list' ? await smokeAddAccountForm(w) : undefined;
  const header = info.view === 'list' ? await smokeHeader(w) : undefined;
  const settings = info.view === 'list' ? await smokeSettings(w) : undefined;
  const list = info.view === 'list' ? await smokeList(w) : undefined;
  const quiet = info.view === 'list' ? await smokeQuiet(w) : undefined;
  const allDone = info.view === 'list' ? await smokeAllDone(w) : undefined;
  const keys = info.view === 'list' ? await smokeKeys(w, ctx) : undefined;
  const empty = info.view === 'empty' ? await smokeEmpty(w) : undefined;
  const ok =
    info.view === 'list'
      ? info.rows > 0 && !!keys?.ok && !!header?.ok && !!list?.ok && !!form?.ok && !!reauth?.ok && !!settings?.ok && !!quiet?.ok && !!allDone?.ok
      : !ctx.noRealAccounts && info.view === 'empty' && !!empty?.ok;
  return { ok, report: { ...info, msSinceLaunch, packaged: app.isPackaged, reauth, form, settings, quiet, allDone, keys, header, list, empty } };
}

/** "Sign in again" on an iCloud Account opens that Account's password form, filled in, not Google's sign-in. */
async function smokeReauth(w: BrowserWindow) {
  const d = drive(w);
  await w.webContents.executeJavaScript(`document.querySelector('.account.needs-sign-in').click()`);
  await sleep(200);
  const form = await d.js<{ title: string; email: string; focused: string } | null>(`(() => {
    const s = document.querySelector('.sheet');
    return s ? { title: s.querySelector('h2').textContent, email: s.querySelector('input').value, focused: document.activeElement?.type } : null;
  })()`);
  await w.webContents.executeJavaScript(`document.querySelector('.sheet .quiet').click()`);
  await sleep(100);
  return { ok: form?.title === 'Sign in to smoke@icloud.com again' && form.email === 'smoke@icloud.com' && form.focused === 'password', form };
}

/** The header's nth Split tab (from 0). */
const nthTab = (i: number) => `.splits .split:nth-of-type(${i + 1})`;

/**
 * The header row, used with the mouse: a click opens a tab and the underline follows it; resting on a tab peeks at its
 * newest Threads; the icons open Search; a narrow window puts the last tabs in More, and choosing one opens it.
 */
async function smokeHeader(w: BrowserWindow) {
  const d = drive(w);
  // Hover and the tab underline's animation need a window on screen: shown from here on, without taking focus.
  w.showInactive();
  await sleep(300);
  const tabNames = () => d.js<Array<string>>(`[...document.querySelectorAll('.split .split-name')].map((s) => s.textContent)`);
  const openName = () => d.js<string>(`document.querySelector('.split[data-selected] .split-name')?.textContent ?? ''`);
  const names = await tabNames();
  const target = names[1] ?? '';
  const clicked = await d.clickAt(nthTab(1));
  await sleep(300);
  const listCount = await d.js<number>(`document.querySelectorAll('.row').length`);
  const tabCount = await d.js<number>(`Number(document.querySelector('.split[data-selected] .count')?.textContent || 0)`);
  const clickOpens = clicked.hit && (await openName()) === target && listCount > 0 === tabCount > 0;
  // The underline sits under the open tab once it has moved there.
  await sleep(500);
  const inkUnder = await d.js<boolean>(`(() => {
    const ink = document.querySelector('.split-ink')?.getBoundingClientRect();
    const tab = document.querySelector('.split[data-selected]')?.getBoundingClientRect();
    return !!ink && !!tab && ink.width > 0 && ink.left >= tab.left && ink.right <= tab.right + 0.5 && Math.abs(ink.bottom - tab.bottom) < 1;
  })()`);
  // Rest the pointer on the first tab (now closed): its peek shows its newest Threads.
  const first = await d.js<{ x: number; y: number }>(
    `(() => { const r = document.querySelector('${nthTab(0)}').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
  );
  w.webContents.sendInputEvent({ type: 'mouseMove', ...first });
  await sleep(900);
  await d.shot('header-peek');
  const peekCards = await d.js<number>(`document.querySelectorAll('.peek[data-open] .peek-card').length`);
  w.webContents.sendInputEvent({ type: 'mouseMove', x: first.x, y: first.y + 300 });
  await sleep(300);
  const peek = peekCards >= 1 && peekCards <= 3;
  // The Search icon opens the search, typing in it; Esc closes it.
  const searchIcon = await d.clickAt('.tool[aria-label="Search"]');
  await sleep(200);
  const searchFocus = await d.js<string>(`(() => {
    const a = document.activeElement;
    return a === document.querySelector('.search-bar input') ? 'input' : a ? a.tagName + '.' + a.className : 'none';
  })()`);
  await d.press('Escape');
  const searchClosed = !(await d.js<boolean>(`!!document.querySelector('.search-bar')`));
  const icons = searchIcon.hit && searchFocus === 'input' && searchClosed;
  // A narrow window: the last tabs move into More, and choosing one from it opens that Split.
  const [width, height] = w.getSize();
  // The resize lands a while later on a busy runner: wait until the page is narrow and the header has measured it.
  const narrowed = async () => {
    for (let waited = 0; waited < 3000; waited += 100) {
      if (await d.js<boolean>(`innerWidth <= 460 && !!document.querySelector('.split.more')`)) {
        return true;
      }
      await sleep(100);
    }
    return false;
  };
  w.setSize(420, height ?? 820);
  let narrow = await narrowed();
  if (!narrow) {
    w.setBounds({ ...w.getBounds(), width: 420 });
    narrow = await narrowed();
  }
  const narrowSize = { narrow, window: w.getSize().join('x'), page: await d.js<number>(`innerWidth`) };
  await sleep(200);
  await d.shot('header-narrow');
  const shownNarrow = await tabNames();
  const moreClick = await d.clickAt('.split.more');
  await sleep(300);
  const items = await d.js<Array<string>>(`[...document.querySelectorAll('.menu .split-item .split-name')].map((s) => s.textContent)`);
  const pick = items.at(-1) ?? '';
  const itemClick = await d.clickAt('.menu .split-item:last-of-type');
  await sleep(300);
  const opened = await openName();
  const stillFits = await d.js<boolean>(`document.querySelector('.top-row').scrollWidth <= document.querySelector('.top-row').clientWidth`);
  w.setSize(width ?? 1280, height ?? 820);
  await sleep(300);
  const more =
    shownNarrow.length < names.length &&
    moreClick.hit &&
    items.length > 0 &&
    itemClick.hit &&
    opened === pick &&
    stillFits &&
    (await tabNames()).length === names.length;
  // Back to the Inbox, with the pointer off the header, for whatever runs next.
  await d.clickAt('.tool[aria-label="Inbox"]');
  w.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 400 });
  await sleep(300);
  return {
    ok: clickOpens && inkUnder && peek && icons && more,
    names,
    clickOpens,
    inkUnder,
    peekCards,
    icons,
    search: { hit: searchIcon.hit, focus: searchFocus, closed: searchClosed },
    shownNarrow,
    narrowSize,
    items,
    opened,
    more,
  };
}

/**
 * The list: a click selects a row and gives the list the keys, j then moves one row (the list's own arrows don't add
 * a second move), and the selected row's Done and Snooze buttons take its Thread out of the Inbox. z brings each back.
 * A double-click opens a Thread in the column, and the reader's Back returns to the list.
 */
async function smokeList(w: BrowserWindow) {
  const d = drive(w);
  const selectedKey = () => d.js<string>(`document.querySelector('.row[data-selected]')?.dataset.key ?? ''`);
  const inbox = () => d.js<number>(`Number(document.querySelector('.split[data-selected] .count')?.textContent)`);
  const third = await d.js<string>(`document.querySelectorAll('.row')[2]?.dataset.key ?? ''`);
  const clicked = await d.clickAt('.row:nth-child(3) .subject');
  const clickSelects = clicked.hit && (await selectedKey()) === third;
  const fourth = await d.js<string>(`document.querySelectorAll('.row')[3]?.dataset.key ?? ''`);
  await d.press('j');
  const follows = await d.js<{ focused: boolean; active: boolean }>(`(() => {
    const list = document.querySelector('.thread-list');
    const sel = document.querySelector('.row[data-selected]');
    return { focused: document.activeElement === list, active: !!sel && list.getAttribute('aria-activedescendant') === sel.id };
  })()`);
  const oneStep = (await selectedKey()) === fourth && follows.focused && follows.active;
  // Only the selected row shows its snippet and buttons, in place of the date.
  const face = await d.js<{ acts: number; snippets: number; selectedDate: boolean }>(`({
    acts: document.querySelectorAll('.row .acts').length,
    snippets: [...document.querySelectorAll('.row .snippet')].filter((s) => s.offsetWidth > 0).length,
    selectedDate: !!document.querySelector('.row[data-selected] .date'),
  })`);
  await d.shot('list');
  const quiet = face.acts === 1 && face.snippets <= 1 && !face.selectedDate;
  const before = await inbox();
  const doneClick = await d.clickAt('.row[data-selected] .act[data-act="thread.done"]');
  await sleep(200);
  const left = await d.js<boolean>(`!document.querySelector('.row[data-key="${fourth}"]')`);
  const done = doneClick.hit && left && (await inbox()) === before - 1;
  await d.press('z');
  await sleep(200);
  const doneBack = (await inbox()) === before;
  const snoozing = await selectedKey();
  const snoozeClick = await d.clickAt('.row[data-selected] .act[data-act="thread.snooze"]');
  await sleep(200);
  await d.type('tomorrow 9');
  await d.press('Return');
  await sleep(300);
  const snoozed = snoozeClick.hit && (await inbox()) === before - 1 && (await d.js<boolean>(`!document.querySelector('.row[data-key="${snoozing}"]')`));
  await d.press('z');
  await sleep(300);
  const snoozeBack = (await inbox()) === before;
  // A double-click opens the row in the column, in the list's place; Back returns to the list with it still selected.
  const opening = await d.js<{ key: string; subject: string }>(
    `(() => { const r = document.querySelectorAll('.row')[1]; return { key: r.dataset.key, subject: r.querySelector('.subject').firstChild.textContent }; })()`,
  );
  const dbl = await d.clickAt('.row:nth-child(2) .from', undefined, 2);
  await sleep(500);
  const reading = await d.js<{ subject: string; listInert: boolean; width: number; column: number }>(`({
    subject: document.querySelector('.reader h1')?.textContent ?? '',
    listInert: !!document.querySelector('.lists')?.inert,
    width: Math.round(document.querySelector('.reader .mail-frame')?.getBoundingClientRect().width ?? 0),
    column: Math.round(document.querySelector('.view')?.getBoundingClientRect().width ?? 0),
  })`);
  await d.shot('reader-column');
  const opened = dbl.hit && reading.subject === opening.subject && reading.listInert && reading.width > 0 && reading.width === reading.column;
  const back = await d.clickAt('.reader-bar .back');
  await sleep(500);
  const backToList =
    back.hit &&
    !(await d.js<boolean>(`!!document.querySelector('.reader') || !!document.querySelector('.lists')?.inert`)) &&
    (await selectedKey()) === opening.key;
  // Back to the top, for the key checks after this.
  await d.press('g');
  await d.press('g');
  const ok = clickSelects && oneStep && quiet && done && doneBack && snoozed && snoozeBack && opened && backToList;
  return { ok, clickSelects, oneStep, follows, face, done, doneBack, snoozed, snoozeBack, opened, reading, backToList };
}

/** Smoke check with no Accounts: the iCloud form explains that the login must be the @icloud.com address. */
/** The Add Account form, opened from Settings as a person would: on top of everything, and it gets the keys. */
async function smokeAddAccountForm(w: BrowserWindow) {
  const d = drive(w);
  await d.menuAction('settings.open');
  await sleep(200);
  await w.webContents.executeJavaScript(`document.querySelector('.settings-add [data-provider=icloud]').click()`);
  await sleep(200);
  const onTop = await d.js<boolean>(`(() => {
    const s = document.querySelector('.sheet').getBoundingClientRect();
    const hit = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
    return !!hit && !!hit.closest('.sheet') && document.activeElement?.tagName === 'INPUT' && !!document.activeElement.closest('.sheet');
  })()`);
  // Click into the field (as a person would), then type keys the list would take: they must land in the field.
  const field = await d.js<{ x: number; y: number }>(
    `(() => { const r = document.querySelector('.sheet input').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`,
  );
  for (const type of ['mouseDown', 'mouseUp'] as const) {
    w.webContents.sendInputEvent({ type, x: Math.round(field.x), y: Math.round(field.y), button: 'left', clickCount: 1 });
  }
  const selectedBefore = await d.js<string>(`document.querySelector('.row[data-selected]')?.dataset.key ?? ''`);
  const countBefore = await d.js<number>(`Number(document.querySelector('.split[data-selected] .count')?.textContent)`);
  // A menu command arriving while typing in the form (as a key equivalent would, when the page answers slowly) is ignored.
  await drive(w).menuAction('thread.done');
  // Real key presses (down, char, up), as fast as the events go: none may reach the app's keys.
  const fast = 'jjekzs#gg';
  await drive(w).type(fast);
  await sleep(300);
  const typed = await d.js<string>(`document.querySelector('.sheet input')?.value ?? '(no form)'`);
  const selectedAfter = await d.js<string>(`document.querySelector('.row[data-selected]')?.dataset.key ?? ''`);
  await w.webContents.executeJavaScript(`document.querySelector('.sheet .quiet').click()`);
  await sleep(100);
  await d.press('Escape');
  await sleep(100);
  const countAfter = await d.js<number>(`Number(document.querySelector('.split[data-selected] .count')?.textContent)`);
  return {
    ok: onTop && typed === fast && selectedBefore === selectedAfter && countBefore === countAfter,
    onTop,
    typed,
    moved: selectedBefore !== selectedAfter,
    menuRan: countBefore !== countAfter,
  };
}

/**
 * Settings: Cmd-, opens it on Accounts; Appearance lists the themes, and a click or an arrow key changes the app's theme;
 * Start at Login is a switch; Esc closes it. The header icon opens it too.
 */
async function smokeSettings(w: BrowserWindow) {
  const d = drive(w);
  await d.press(',', 1, ['meta']);
  await sleep(300);
  const accounts = await d.js<Array<string>>(`[...document.querySelectorAll('.settings-account-email')].map((e) => e.textContent)`);
  const opened = (await d.js<string>(`document.querySelector('.settings-tabs [data-selected]')?.textContent ?? ''`)) === 'Accounts' && accounts.length > 0;
  await d.shot('settings-accounts');
  await d.clickAt('.settings-tabs [data-slot="tabs-tab"]:nth-child(2)');
  await sleep(200);
  const themeNow = () => d.js<string>(`document.documentElement.dataset.theme ?? ''`);
  const before = await themeNow();
  const pickTheme = async (id: string) => {
    await d.js(`document.querySelector('.theme-item[data-theme-id="${id}"]')?.scrollIntoView({ block: 'nearest' })`);
    const r = await d.clickAt(`.theme-item[data-theme-id="${id}"]`);
    await sleep(300);
    return r.hit;
  };
  const hit = await pickTheme('solarized-light');
  const clicked = await themeNow();
  // An arrow key moves through the list and picks as it goes. Following the system, a dark pick is the dark half of
  // the pair (marked in the list) while the light one stays on screen.
  const chosen = () =>
    d.js<string>(
      `[document.documentElement.dataset.theme, ...[...document.querySelectorAll('.theme-item[data-paired]')].map((i) => i.dataset.themeId)].join('|')`,
    );
  const chosenBefore = await chosen();
  await d.press('Up');
  await sleep(300);
  const arrowed = await chosen();
  const picked = hit && clicked === 'solarized-light' && arrowed !== chosenBefore;
  // Back to the pair it started with.
  await pickTheme('normie-dark');
  await pickTheme(before);
  const restored = (await themeNow()) === before;
  await d.shot('settings-appearance');
  await d.clickAt('.settings-tabs [data-slot="tabs-tab"]:nth-child(3)');
  await sleep(200);
  const checked = () => d.js<string>(`document.querySelector('.settings-switch [data-slot="switch"]')?.getAttribute('aria-checked') ?? ''`);
  const loginBefore = await checked();
  await d.clickAt('.settings-switch [data-slot="switch"]');
  await sleep(300);
  const loginFlipped = await checked();
  await d.clickAt('.settings-switch [data-slot="switch"]');
  await sleep(300);
  const login = loginBefore !== '' && loginFlipped !== loginBefore && (await checked()) === loginBefore;
  await d.press('Escape');
  await sleep(200);
  const closed = await d.js<boolean>(`!document.querySelector('.settings-panel')`);
  const icon = await d.clickAt('.tool[aria-label="Settings"]');
  await sleep(300);
  const byIcon = icon.hit && (await d.js<boolean>(`!!document.querySelector('.settings-panel')`));
  await d.press('Escape');
  await sleep(200);
  const ok = opened && picked && restored && login && closed && byIcon && !(await d.js<boolean>(`!!document.querySelector('.settings-panel')`));
  return { ok, opened, accounts: accounts.length, themes: { before, clicked, arrowed, restored }, login, closed, byIcon };
}

/** Moving through the list with keys fades the header; moving the mouse brings it back. */
async function smokeQuiet(w: BrowserWindow) {
  const d = drive(w);
  const header = () =>
    d.js<{ quiet: boolean; opacity: number }>(
      `({ quiet: 'quiet' in document.documentElement.dataset, opacity: Number(getComputedStyle(document.querySelector('.top-row .tools')).opacity) })`,
    );
  w.webContents.sendInputEvent({ type: 'mouseMove', x: 700, y: 400 });
  await sleep(100);
  const awake = await header();
  await d.press('j');
  await sleep(900);
  const faded = await header();
  await d.shot('quiet');
  w.webContents.sendInputEvent({ type: 'mouseMove', x: 720, y: 420 });
  await sleep(900);
  const back = await header();
  await d.press('k');
  const ok = !awake.quiet && faded.quiet && faded.opacity < 0.3 && !back.quiet && back.opacity > 0.9;
  return { ok, awake, faded, back };
}

/** Marking the last Newsletter Done leaves a calm "All done"; Undo brings it back. A search that finds nothing says so. */
async function smokeAllDone(w: BrowserWindow) {
  const d = drive(w);
  const index = await d.js<number>(
    `[...document.querySelectorAll('.splits .split')].findIndex((s) => s.querySelector('.split-name')?.textContent === 'Newsletters')`,
  );
  await d.clickAt(nthTab(index));
  await sleep(500);
  const rows = () => d.js<number>(`document.querySelectorAll('.row').length`);
  const before = await rows();
  await d.press('e', before);
  await sleep(600);
  const empty = await d.js<string>(`document.querySelector('.list-empty')?.textContent ?? ''`);
  await d.shot('all-done');
  await d.press('z');
  await sleep(600);
  const back = (await rows()) === before && (await d.js<boolean>(`!document.querySelector('.list-empty')`));
  await d.press('0');
  await sleep(300);
  await d.press('/');
  await sleep(200);
  await d.type('qqzzxxnothing');
  await sleep(400);
  await d.press('Return');
  await sleep(600);
  const nothing = await d.js<string>(`document.querySelector('.list-empty')?.textContent ?? ''`);
  await d.press('Escape');
  await sleep(200);
  const ok = before > 0 && empty.startsWith('All done') && empty.includes('Newsletters') && back && nothing.startsWith('Nothing matches');
  return { ok, before, empty, back, nothing };
}

/** Smoke check with no Accounts: the iCloud form explains that the login must be the @icloud.com address. */
async function smokeEmpty(w: BrowserWindow) {
  const d = drive(w);
  const welcome = await d.js<string>(`document.querySelector('.empty .list-empty-title')?.textContent ?? ''`);
  await w.webContents.executeJavaScript(`document.querySelector('.or .link').click()`);
  await sleep(200);
  await drive(w).type('me@custom.example');
  await w.webContents.executeJavaScript(`(() => {
    const pw = document.querySelector('.sheet input[type=password]');
    pw.focus();
  })()`);
  await drive(w).type('abcd-efgh-ijkl-mnop');
  await w.webContents.executeJavaScript(`document.querySelector('.sheet button[type=submit]').click()`);
  await sleep(300);
  const error = await d.js<string>(`document.querySelector('.sheet .account-error')?.textContent ?? ''`);
  return { ok: welcome === 'Welcome to Normie' && /@icloud\.com address to sign in/.test(error), welcome, error: error.slice(0, 60) };
}

/** Smoke check: real key presses move the selection through the registry. */
async function smokeKeys(w: BrowserWindow, ctx: SmokeContext) {
  const selectedIndex = () =>
    d.js<number>(`(() => { const s = document.querySelector('.row[data-selected]'); return s ? Math.round(s.offsetTop / s.offsetHeight) : -1; })()`);
  const d = drive(w);
  const press = d.press;
  const start = await selectedIndex();
  await press('j', 5);
  const afterJ = await selectedIndex();
  await press('k', 2);
  const afterK = await selectedIndex();
  await press('g');
  await press('g');
  const afterGG = await selectedIndex();
  await press('Enter');
  await sleep(500);
  // The newest fake Thread is an HTML newsletter with a script, a tracking pixel and a javascript: link.
  const frame = await d.js<{ sandbox: string | null; html: string; text: string; bar: boolean; x: number; y: number; attachment: string }>(`(() => {
    const f = document.querySelector('.mail-frame');
    const d = f && f.contentDocument;
    const sr = d && d.querySelector('.html') && d.querySelector('.html').shadowRoot;
    const r = f ? f.getBoundingClientRect() : null;
    return { sandbox: f && f.getAttribute('sandbox'), html: sr ? sr.innerHTML : '', text: sr ? sr.textContent : '',
      bar: !!document.querySelector('.images-bar'), x: r ? r.left + r.width / 2 : 0, y: r ? r.top + 60 : 0,
      attachment: d ? [...d.querySelectorAll('.attachment')].map((a) => a.textContent).join('|') : '' };
  })()`);
  const html =
    frame.sandbox === 'allow-same-origin' &&
    frame.text.includes('Hello from Normie') &&
    frame.bar &&
    frame.attachment.includes('agenda.txt') &&
    !/<script|tracker\.example|javascript:/i.test(frame.html);
  // Click into the message, then Esc: keys still reach the app from inside the frame.
  for (const type of ['mouseDown', 'mouseUp'] as const) {
    w.webContents.sendInputEvent({ type, x: Math.round(frame.x), y: Math.round(frame.y), button: 'left', clickCount: 1 });
  }
  await sleep(100);
  const focusedFrame = await d.js<boolean>(`document.activeElement?.className === 'mail-frame'`);
  await press('Escape');
  const readerClosed = await d.js<boolean>(`!document.querySelector('.reader')`);
  // Main refuses to open a file that would run code.
  const riskyRefused =
    (await d.js<string>(`window.normie.openAttachment({ filename: 'setup.command', content: new TextEncoder().encode('echo hi') }).then((r) => r.reason)`)) ===
    'risky';
  const reader = html && focusedFrame && readerClosed && riskyRefused;
  // Done takes the selected Thread out of the list.
  const count = () => d.js<number>(`Number(document.querySelector('.split[data-selected] .count')?.textContent)`);
  const before = await count();
  await press('e');
  const done = (await count()) === before - 1;
  // z brings it back.
  await press('z');
  const undone = (await count()) === before;
  // s stars the selected Thread.
  await press('s');
  const starred = await d.js<boolean>(`!!document.querySelector('.row[data-selected] .star')`);
  // Cmd-K, type "done", Enter: the palette runs Mark Done and closes.
  const beforePalette = await count();
  await press('K', 1, ['meta']);
  const paletteOpen = await d.js<boolean>(`!!document.querySelector('.palette input')`);
  for (const ch of 'done') {
    await press(ch);
  }
  await press('Enter');
  const palette = paletteOpen && (await count()) === beforePalette - 1 && !(await d.js<boolean>(`!!document.querySelector('.palette')`));
  // l opens the Label picker with the Account's Labels.
  await press('l');
  const labelItems = await d.js<Array<string>>(`[...document.querySelectorAll('.palette .palette-item span')].map((s) => s.textContent)`);
  await press('Escape');
  const label = labelItems.includes('Receipts');
  // keymap.json is picked up without a restart: bind star to y, and y toggles the selected Thread's star.
  const isStarred = () => d.js<boolean>(`!!document.querySelector('.row[data-selected] .star')`);
  const starBefore = await isStarred();
  writeFileSync(ctx.userFile('keymap.json'), JSON.stringify({ 'thread.star': 'y' }));
  await sleep(600);
  await press('y');
  const keymapOk = (await isStarred()) !== starBefore;
  // c, type a message, Cmd-Enter sends; Cmd-Z inside the undo window brings it back; Esc closes.
  const typeText = d.type;
  await press('c');
  await sleep(300);
  const composerOpen = await d.js<boolean>(`!!document.querySelector('.composer textarea')`);
  await typeText('ada@example.com');
  await press('Tab');
  await typeText('Smoke test');
  await press('Tab');
  await typeText('Hello **there**');
  await d.shot('composer');
  await press('Return', 1, ['meta']);
  const sentClosed = await d.js<boolean>(`!document.querySelector('.composer')`);
  await press('Z', 1, ['meta']);
  await sleep(300);
  const reopened = await d.js<string>(
    `(() => { const c = document.querySelector('.composer'); if (!c) return ''; return [...c.querySelectorAll('input:not([type=file])')].map((i) => i.value).join('|') + '|' + c.querySelector('textarea').value; })()`,
  );
  await press('Escape');
  const compose =
    composerOpen && sentClosed && reopened === 'ada@example.com|Smoke test|Hello **there**' && (await d.js<boolean>(`!document.querySelector('.composer')`));
  // r replies to the selected Thread: someone to write to, "Re:", and the quote below the cursor.
  await press('r');
  await sleep(500);
  const replyFields = await d.js<{ to: string; subject: string; body: string; focused: boolean } | null>(
    `(() => { const c = document.querySelector('.composer'); if (!c) return null; const i = [...c.querySelectorAll('input:not([type=file])')].map((x) => x.value); return { to: i[0], subject: i[i.length - 1], body: c.querySelector('textarea').value, focused: document.activeElement === c.querySelector('textarea') }; })()`,
  );
  await press('Escape');
  const reply =
    !!replyFields &&
    /@/.test(replyFields.to) &&
    replyFields.subject.startsWith('Re: ') &&
    /^\n\nOn .* wrote:\n> /.test(replyFields.body) &&
    replyFields.focused;
  // A draft: type, Esc keeps it, Cmd-K "draft" reopens it; Cmd-Shift-Backspace discards it.
  await press('c');
  await sleep(300);
  await typeText('grace@example.com');
  await sleep(1200);
  await press('Escape');
  await press('K', 1, ['meta']);
  await sleep(300);
  await typeText('draft');
  const draftListed = await d.js<boolean>(`[...document.querySelectorAll('.palette .palette-item span')].some((s) => s.textContent.startsWith('Draft:'))`);
  await press('Return');
  await sleep(300);
  const draftTo = await d.js<string>(`document.querySelector('.composer input')?.value ?? ''`);
  w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace', modifiers: ['meta', 'shift'] });
  w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace', modifiers: ['meta', 'shift'] });
  await sleep(300);
  await press('K', 1, ['meta']);
  await sleep(300);
  await typeText('draft');
  const draftGone = !(await d.js<boolean>(`[...document.querySelectorAll('.palette .palette-item span')].some((s) => s.textContent.startsWith('Draft:'))`));
  await press('Escape');
  const drafts = draftListed && draftTo === 'grace@example.com' && draftGone;
  // Attach by dropping a file on the composer; it goes with the message and comes back with Undo Send.
  await press('c');
  await sleep(300);
  await w.webContents.executeJavaScript(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['bring snacks'], 'plan.txt', { type: 'text/plain' }));
    const c = document.querySelector('.composer');
    c.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    c.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  })()`);
  await sleep(200);
  const chip = () => d.js<string>(`[...document.querySelectorAll('.composer .attachments li')].map((l) => l.textContent).join('|')`);
  const dropped = await chip();
  await typeText('ada@example.com');
  await press('Return', 1, ['meta']);
  await press('Z', 1, ['meta']);
  await sleep(300);
  const keptOnUndo = await chip();
  await press('Escape');
  const attachments = dropped.startsWith('plan.txt') && keptOnUndo.startsWith('plan.txt');
  // Address suggestions: "gra", Tab → Grace Hopper.
  await press('c');
  await sleep(300);
  await typeText('gra');
  await sleep(200);
  const suggested = await d.js<string>(`[...document.querySelectorAll('.suggestions li')].map((l) => l.textContent).join('|')`);
  await press('Tab');
  const picked = await d.js<string>(`document.querySelector('.composer input:not([type=file])').value`);
  await press('Escape');
  const autocomplete = suggested.startsWith('Grace Hopper') && picked === 'Grace Hopper <grace@example.com>, ';
  // Snippets: snippets.json is picked up without a restart; ";thanks" then Tab in the body expands it.
  writeFileSync(ctx.userFile('snippets.json'), JSON.stringify({ thanks: 'Thanks so much!' }));
  await sleep(600);
  await press('c');
  await sleep(300);
  await typeText('ada@example.com');
  await press('Tab');
  await press('Tab');
  await typeText('Great work. ;thanks');
  await press('Tab');
  const expanded = await d.js<string>(`document.querySelector('.composer textarea').value`);
  // Cmd-K (the menu's key equivalent, from a field) over the compose panel lists the snippets; Enter puts one in at the cursor.
  await drive(w).menuAction('palette.open');
  await sleep(300);
  await typeText('thanks');
  await press('Return');
  await sleep(200);
  const inserted = await d.js<{ body: string; focused: boolean }>(
    `(() => { const t = document.querySelector('.composer textarea'); return { body: t?.value ?? '', focused: document.activeElement === t }; })()`,
  );
  await press('Escape');
  const snippet =
    expanded === 'Great work. Thanks so much!' &&
    inserted.body === 'Great work. Thanks so much!Thanks so much!' &&
    inserted.focused &&
    !(await d.js<boolean>(`!!document.querySelector('.composer')`));
  // Tab steps through the Splits; Newsletters holds the fake newsletter; 0 goes back to the whole Inbox.
  const activeSplit = () => d.js<string>(`document.querySelector('.split[data-selected] .split-name')?.textContent`);
  const tabs: Array<string> = [];
  for (let i = 0; i < 4; i++) {
    await press('Tab');
    tabs.push(await activeSplit());
  }
  await press('0');
  const builtIns = tabs.join('|') === 'Important|Other|Newsletters|VIP' && (await activeSplit()) === 'Inbox';
  // splits.json reorders, renames and hides tabs without a restart.
  writeFileSync(ctx.userFile('splits.json'), JSON.stringify([{ id: 'newsletters', name: 'Reading' }, { id: 'other' }]));
  await sleep(600);
  const ownTabs = await d.js<string>(`[...document.querySelectorAll('.split .split-name')].map((s) => s.textContent).join('|')`);
  const splits = builtIns && ownTabs === 'Inbox|Reading|Other|Snoozed';
  // Clicking a notification opens its Thread (main sends open-thread with the key).
  const target = await d.js<{ key: string; subject: string }>(
    `(() => { const r = document.querySelectorAll('.row')[2]; return { key: r.dataset.key, subject: r.querySelector('.subject').firstChild.textContent }; })()`,
  );
  w.webContents.send('open-thread', target.key);
  await sleep(400);
  const openedSubject = await d.js<string>(`document.querySelector('.reader h1')?.textContent ?? ''`);
  await press('Escape');
  const notifyClick = openedSubject === target.subject;
  // h, "tomorrow 9", Enter: the Thread leaves the Inbox for the Snoozed tab.
  const tabCount = (name: string) =>
    d.js<number>(
      `Number([...document.querySelectorAll('.split')].find((s) => s.querySelector('.split-name')?.textContent === '${name}')?.querySelector('.count')?.textContent)`,
    );
  const inboxBefore = await tabCount('Inbox');
  await press('h');
  await sleep(200);
  await drive(w).type('tomorrow 9');
  await sleep(100);
  const pickerShows = await d.js<string>(`document.querySelector('.palette .palette-item span')?.textContent ?? ''`);
  await press('Return');
  await sleep(300);
  const snooze = pickerShows.startsWith('Tomorrow, 9') && (await tabCount('Inbox')) === inboxBefore - 1 && (await tabCount('Snoozed')) === 1;
  // Send Later: Cmd-Shift-Enter, "tomorrow 9", Enter → scheduled; Cmd-K "scheduled" reopens it.
  await press('c');
  await sleep(300);
  await typeText('ada@example.com');
  await press('Return', 1, ['meta', 'shift']);
  await sleep(200);
  await drive(w).type('tomorrow 9');
  await sleep(100);
  await press('Return');
  await sleep(300);
  const scheduledNote = await d.js<string>(`document.querySelector('.toast-title')?.textContent ?? ''`);
  await press('K', 1, ['meta']);
  await sleep(300);
  await typeText('scheduled');
  const listed = await d.js<string>(`[...document.querySelectorAll('.palette .palette-item span')].map((s) => s.textContent).join('|')`);
  await press('Return');
  await sleep(300);
  const reopenedTo = await d.js<string>(`document.querySelector('.composer input:not([type=file])')?.value ?? ''`);
  await press('Escape');
  const sendLater = scheduledNote.startsWith('Scheduled for Tomorrow, 9') && listed.includes('Scheduled: ') && reopenedTo === 'ada@example.com';

  // A Reminder from the composer: Cmd-Shift-H, "tomorrow", Enter → shown above the footer.
  await press('c');
  await sleep(300);
  await press('H', 1, ['meta', 'shift']);
  await sleep(200);
  await drive(w).type('tomorrow');
  await sleep(100);
  await press('Return');
  await sleep(200);
  const reminderLine = await d.js<string>(`document.querySelector('.reminder-line')?.textContent ?? ''`);
  await press('Escape');
  const reminder = reminderLine.includes('Back in the Inbox Tomorrow');

  // Search: /, "budget", Enter → results; j/Enter opens one; Esc closes the reader, Esc again closes the search.
  await press('/');
  await sleep(200);
  await drive(w).type('budget');
  await sleep(400);
  await d.shot('search');
  await press('Return');
  await sleep(200);
  // Enter: the panel goes up, the results stay in the list, and the header says what was searched.
  await d.shot('search-results');
  const chipShown = await d.js<boolean>(`!document.querySelector('.search-panel') && /budget/.test(document.querySelector('.search-chip')?.textContent ?? '')`);
  const results = await d.js<Array<string>>(`[...document.querySelectorAll('.row .subject')].map((s) => s.firstChild.textContent)`);
  await press('Return');
  await sleep(400);
  const resultOpened = await d.js<string>(`document.querySelector('.reader h1')?.textContent ?? ''`);
  await press('Escape');
  await press('Escape');
  const searchClosed = await d.js<boolean>(`!document.querySelector('.search-bar, .search-chip') && !!document.querySelector('.splits')`);
  // Nothing local: the server is asked by itself (the fake server has nothing more either).
  await press('/');
  await sleep(200);
  await drive(w).type('zebra');
  await sleep(800);
  const serverStatus = await d.js<string>(`document.querySelector('.search-bar .sync-note')?.textContent ?? ''`);
  await press('Escape');
  const search =
    chipShown &&
    results.length > 0 &&
    results.every((r) => /budget/i.test(r)) &&
    /budget/i.test(resultOpened) &&
    searchClosed &&
    serverStatus === 'Server searched';

  // Themes: Cmd-K "Theme: Normie Light" turns the page and the reader frame light; "Catppuccin Mocha" turns them dark.
  const paletteRun = async (text: string) => {
    await press('K', 1, ['meta']);
    await sleep(200);
    await typeText(text);
    await press('Return');
    await sleep(300);
  };
  const bg = () => d.js<string>(`getComputedStyle(document.body).backgroundColor`);
  /** With NORMIE_SMOKE_SHOTS=<folder>, smoke saves screenshots to look at (a hidden window still renders). */
  const shot = d.shot;
  await paletteRun('theme normie light');
  const lightBody = await bg();
  await shot('light-list');
  await press('Enter');
  await sleep(400);
  await shot('light-reader');
  const lightFrame = await d.js<string>(
    `(() => { const d = document.querySelector('.mail-frame')?.contentDocument; return d ? getComputedStyle(d.body).backgroundColor : ''; })()`,
  );
  await press('Escape');
  await paletteRun('theme catppuccin mocha');
  const mochaBody = await bg();
  // A VS Code theme dropped in the themes folder is in Cmd-K without a restart, and picking it applies it.
  writeFileSync(
    ctx.userFile('themes/smoke-paper.json'),
    '{ "name": "Smoke Paper", // a comment, as VS Code allows\n "colors": { "editor.background": "#f4ecd8", "editor.foreground": "#3b2f1e", }, }',
  );
  await sleep(600);
  await paletteRun('theme smoke paper');
  const ownBody = await bg();
  await paletteRun('theme catppuccin mocha');
  const themes =
    lightBody === 'rgb(251, 250, 255)' && lightFrame === 'rgb(251, 250, 255)' && mochaBody === 'rgb(30, 30, 46)' && ownBody === 'rgb(244, 236, 216)';

  // ? lists the keys (Snooze among them); Esc closes it.
  await press('?');
  await sleep(300);
  await shot('key-help');
  const helpText = await d.js<string>(`document.querySelector('.key-help')?.textContent ?? ''`);
  await press('Escape');
  const keyHelp = helpText.includes('Snooze') && helpText.includes('Composer') && !(await d.js<boolean>(`!!document.querySelector('.key-help')`));

  // Closing the window keeps Normie running: the window hides, the page still answers, the menu bar item stays.
  w.close();
  await sleep(200);
  const stillAnswers = (await w.webContents.executeJavaScript('1 + 1').catch(() => 0)) === 2;
  const keepsRunning = !w.isDestroyed() && !w.isVisible() && stillAnswers && ctx.trayAlive();
  const ok =
    start === 0 &&
    afterJ === 5 &&
    afterK === 3 &&
    afterGG === 0 &&
    reader &&
    done &&
    undone &&
    starred &&
    palette &&
    label &&
    keymapOk &&
    compose &&
    reply &&
    drafts &&
    attachments &&
    autocomplete &&
    snippet &&
    splits &&
    notifyClick &&
    snooze &&
    keepsRunning &&
    sendLater &&
    reminder &&
    search &&
    themes &&
    keyHelp;
  return {
    ok,
    start,
    afterJ,
    afterK,
    afterGG,
    reader,
    html,
    focusedFrame,
    readerClosed,
    riskyRefused,
    done,
    undone,
    starred,
    palette,
    label,
    keymap: keymapOk,
    compose,
    reopened,
    reply,
    drafts,
    attachments,
    autocomplete,
    snippet,
    splits,
    notifyClick,
    snooze,
    keepsRunning,
    sendLater,
    reminder,
    search,
    themes,
    themeColors: { lightBody, lightFrame, mochaBody, ownBody },
    keyHelp,
  };
}
