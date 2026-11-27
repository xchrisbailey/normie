// The smoke checks, run inside the app (NORMIE_SMOKE=1 via npm run smoke and smoke:packaged). Every new piece of UI
// gets a step here that reaches it the way a person does (the top bar, a key, the palette), over a full list, using
// drive.ts: real key presses, clicks checked with elementFromPoint, menu commands. A step for a bug fix should fail on
// the old code first.
import type { BrowserWindow } from 'electron';
import { app } from 'electron';
import { writeFileSync } from 'node:fs';
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
  const keys = info.view === 'list' ? await smokeKeys(w, ctx) : undefined;
  const empty = info.view === 'empty' ? await smokeEmpty(w) : undefined;
  const ok = info.view === 'list' ? info.rows > 0 && keys!.ok && form!.ok && reauth!.ok : !ctx.noRealAccounts && info.view === 'empty' && empty!.ok;
  return { ok, report: { ...info, msSinceLaunch, packaged: app.isPackaged, reauth, form, keys, empty } };
}

/** "Sign in again" on an iCloud Account opens that Account's password form, filled in, not Google's sign-in. */
async function smokeReauth(w: BrowserWindow) {
  await w.webContents.executeJavaScript(`document.querySelector('.account.needs-sign-in').click()`);
  await new Promise((r) => setTimeout(r, 200));
  const form = (await w.webContents.executeJavaScript(`(() => {
    const s = document.querySelector('.sheet');
    return s ? { title: s.querySelector('h2').textContent, email: s.querySelector('input').value, focused: document.activeElement?.type } : null;
  })()`)) as { title: string; email: string; focused: string } | null;
  await w.webContents.executeJavaScript(`document.querySelector('.sheet .quiet').click()`);
  await new Promise((r) => setTimeout(r, 100));
  return { ok: form?.title === 'Sign in to smoke@icloud.com again' && form.email === 'smoke@icloud.com' && form.focused === 'password', form };
}

/** Smoke check with no Accounts: the iCloud form explains that the login must be the @icloud.com address. */
/** The Add Account form, opened from the top bar as a person would: on top of everything, and it gets the keys. */
async function smokeAddAccountForm(w: BrowserWindow) {
  await w.webContents.executeJavaScript(`document.querySelector('.accounts .account.add').click()`);
  await new Promise((r) => setTimeout(r, 100));
  await w.webContents.executeJavaScript(`[...document.querySelectorAll('.popover .quiet')].find((b) => b.textContent.startsWith('iCloud')).click()`);
  await new Promise((r) => setTimeout(r, 200));
  const onTop = (await w.webContents.executeJavaScript(`(() => {
    const s = document.querySelector('.sheet').getBoundingClientRect();
    const hit = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
    return !!hit && !!hit.closest('.sheet') && document.activeElement?.tagName === 'INPUT' && !!document.activeElement.closest('.sheet');
  })()`)) as boolean;
  // Click into the field (as a person would), then type keys the list would take: they must land in the field.
  const field = (await w.webContents.executeJavaScript(`(() => { const r = document.querySelector('.sheet input').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`)) as { x: number; y: number };
  for (const type of ['mouseDown', 'mouseUp'] as const) w.webContents.sendInputEvent({ type, x: Math.round(field.x), y: Math.round(field.y), button: 'left', clickCount: 1 });
  const selectedBefore = (await w.webContents.executeJavaScript(`document.querySelector('.row.selected')?.dataset.key ?? ''`)) as string;
  const countBefore = (await w.webContents.executeJavaScript(`Number(document.querySelector('.split.active .count')?.textContent)`)) as number;
  // A menu command arriving while typing in the form (as a key equivalent would, when the page answers slowly) is ignored.
  await drive(w).menuAction('thread.done');
  // Real key presses (down, char, up), as fast as the events go: none may reach the app's keys.
  const fast = 'jjekzs#gg';
  await drive(w).type(fast);
  await new Promise((r) => setTimeout(r, 300));
  const typed = (await w.webContents.executeJavaScript(`document.querySelector('.sheet input')?.value ?? '(no form)'`)) as string;
  const selectedAfter = (await w.webContents.executeJavaScript(`document.querySelector('.row.selected')?.dataset.key ?? ''`)) as string;
  await w.webContents.executeJavaScript(`document.querySelector('.sheet .quiet').click()`);
  await new Promise((r) => setTimeout(r, 100));
  const countAfter = (await w.webContents.executeJavaScript(`Number(document.querySelector('.split.active .count')?.textContent)`)) as number;
  return { ok: onTop && typed === fast && selectedBefore === selectedAfter && countBefore === countAfter, onTop, typed, moved: selectedBefore !== selectedAfter, menuRan: countBefore !== countAfter };
}

/** Smoke check with no Accounts: the iCloud form explains that the login must be the @icloud.com address. */
async function smokeEmpty(w: BrowserWindow) {
  await w.webContents.executeJavaScript(`document.querySelector('.or .link').click()`);
  await new Promise((r) => setTimeout(r, 200));
  await drive(w).type('me@custom.example');
  await w.webContents.executeJavaScript(`(() => {
    const pw = document.querySelector('.sheet input[type=password]');
    pw.focus();
  })()`);
  await drive(w).type('abcd-efgh-ijkl-mnop');
  await w.webContents.executeJavaScript(`document.querySelector('.sheet button[type=submit]').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const error = (await w.webContents.executeJavaScript(`document.querySelector('.sheet .account-error')?.textContent ?? ''`)) as string;
  return { ok: /@icloud\.com address to sign in/.test(error), error: error.slice(0, 60) };
}

/** Smoke check: real key presses move the selection through the registry. */
async function smokeKeys(w: BrowserWindow, ctx: SmokeContext) {
  const selectedIndex = () =>
    w.webContents.executeJavaScript(
      `(() => { const s = document.querySelector('.row.selected'); return s ? Math.round(s.offsetTop / s.offsetHeight) : -1; })()`,
    ) as Promise<number>;
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
  const count = () => w.webContents.executeJavaScript(`Number(document.querySelector('.split.active .count')?.textContent)`) as Promise<number>;
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
  writeFileSync(ctx.userFile('keymap.json'), JSON.stringify({ 'thread.star': 'y' }));
  await new Promise((r) => setTimeout(r, 600));
  await press('y');
  const keymapOk = (await isStarred()) !== starBefore;
  // c, type a message, Cmd-Enter sends; Cmd-Z inside the undo window brings it back; Esc closes.
  const typeText = d.type;
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
  writeFileSync(ctx.userFile('snippets.json'), JSON.stringify({ thanks: 'Thanks so much!' }));
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
  // Tab steps through the Splits; Newsletters holds the fake newsletter; 0 goes back to the whole Inbox.
  const activeSplit = () => w.webContents.executeJavaScript(`document.querySelector('.split.active')?.firstChild?.textContent?.trim()`) as Promise<string>;
  const tabs: string[] = [];
  for (let i = 0; i < 4; i++) {
    await press('Tab');
    tabs.push(await activeSplit());
  }
  await press('0');
  const builtIns = tabs.join('|') === 'Important|Other|Newsletters|VIP' && (await activeSplit()) === 'Inbox';
  // splits.json reorders, renames and hides tabs without a restart.
  writeFileSync(ctx.userFile('splits.json'), JSON.stringify([{ id: 'newsletters', name: 'Reading' }, { id: 'other' }]));
  await new Promise((r) => setTimeout(r, 600));
  const ownTabs = (await w.webContents.executeJavaScript(`[...document.querySelectorAll('.split')].map((s) => s.firstChild.textContent.trim()).join('|')`)) as string;
  const splits = builtIns && ownTabs === 'Inbox|Reading|Other|Snoozed';
  // Clicking a notification opens its Thread (main sends open-thread with the key).
  const target = (await w.webContents.executeJavaScript(`(() => { const r = document.querySelectorAll('.row')[2]; return { key: r.dataset.key, subject: r.querySelector('.subject').firstChild.textContent }; })()`)) as { key: string; subject: string };
  w.webContents.send('open-thread', target.key);
  await new Promise((r) => setTimeout(r, 400));
  const openedSubject = (await w.webContents.executeJavaScript(`document.querySelector('.reader h1')?.textContent ?? ''`)) as string;
  await press('Escape');
  const notifyClick = openedSubject === target.subject;
  // h, "tomorrow 9", Enter: the Thread leaves the Inbox for the Snoozed tab.
  const tabCount = (name: string) => w.webContents.executeJavaScript(`Number([...document.querySelectorAll('.split')].find((s) => s.firstChild.textContent.trim() === '${name}')?.querySelector('.count')?.textContent)`) as Promise<number>;
  const inboxBefore = await tabCount('Inbox');
  await press('h');
  await new Promise((r) => setTimeout(r, 200));
  await drive(w).type('tomorrow 9');
  await new Promise((r) => setTimeout(r, 100));
  const pickerShows = (await w.webContents.executeJavaScript(`document.querySelector('.palette li span')?.textContent ?? ''`)) as string;
  await press('Return');
  await new Promise((r) => setTimeout(r, 300));
  const snooze = pickerShows.startsWith('Tomorrow, 9') && (await tabCount('Inbox')) === inboxBefore - 1 && (await tabCount('Snoozed')) === 1;
  // Send Later: Cmd-Shift-Enter, "tomorrow 9", Enter → scheduled; Cmd-K "scheduled" reopens it.
  await press('c');
  await new Promise((r) => setTimeout(r, 300));
  await typeText('ada@example.com');
  await press('Return', 1, ['meta', 'shift']);
  await new Promise((r) => setTimeout(r, 200));
  await drive(w).type('tomorrow 9');
  await new Promise((r) => setTimeout(r, 100));
  await press('Return');
  await new Promise((r) => setTimeout(r, 300));
  const scheduledNote = (await w.webContents.executeJavaScript(`document.querySelector('.sync-note')?.textContent ?? ''`)) as string;
  await press('K', 1, ['meta']);
  await new Promise((r) => setTimeout(r, 300));
  await typeText('scheduled');
  const listed = (await w.webContents.executeJavaScript(`[...document.querySelectorAll('.palette li span')].map((s) => s.textContent).join('|')`)) as string;
  await press('Return');
  await new Promise((r) => setTimeout(r, 300));
  const reopenedTo = (await w.webContents.executeJavaScript(`document.querySelector('.composer input:not([type=file])')?.value ?? ''`)) as string;
  await press('Escape');
  const sendLater = scheduledNote.startsWith('Scheduled for Tomorrow, 9') && listed.includes('Scheduled: ') && reopenedTo === 'ada@example.com';

  // A Reminder from the composer: Cmd-Shift-H, "tomorrow", Enter → shown above the footer.
  await press('c');
  await new Promise((r) => setTimeout(r, 300));
  await press('H', 1, ['meta', 'shift']);
  await new Promise((r) => setTimeout(r, 200));
  await drive(w).type('tomorrow');
  await new Promise((r) => setTimeout(r, 100));
  await press('Return');
  await new Promise((r) => setTimeout(r, 200));
  const reminderLine = (await w.webContents.executeJavaScript(`document.querySelector('.reminder-line')?.textContent ?? ''`)) as string;
  await press('Escape');
  const reminder = reminderLine.includes('Back in the Inbox Tomorrow');

  // Search: /, "budget", Enter → results; j/Enter opens one; Esc closes the reader, Esc again closes the search.
  await press('/');
  await new Promise((r) => setTimeout(r, 200));
  await drive(w).type('budget');
  await new Promise((r) => setTimeout(r, 400));
  await press('Return');
  const results = (await w.webContents.executeJavaScript(`[...document.querySelectorAll('.row .subject')].map((s) => s.firstChild.textContent)`)) as string[];
  await press('Return');
  await new Promise((r) => setTimeout(r, 400));
  const resultOpened = (await w.webContents.executeJavaScript(`document.querySelector('.reader h1')?.textContent ?? ''`)) as string;
  await press('Escape');
  await press('Escape');
  const searchClosed = (await w.webContents.executeJavaScript(`!document.querySelector('.search-bar') && !!document.querySelector('.splits')`)) as boolean;
  // Nothing local: the server is asked by itself (the fake server has nothing more either).
  await press('/');
  await new Promise((r) => setTimeout(r, 200));
  await drive(w).type('zebra');
  await new Promise((r) => setTimeout(r, 800));
  const serverStatus = (await w.webContents.executeJavaScript(`document.querySelector('.search-bar .sync-note')?.textContent ?? ''`)) as string;
  await press('Escape');
  const search = results.length > 0 && results.every((r) => /budget/i.test(r)) && /budget/i.test(resultOpened) && searchClosed && serverStatus === 'Server searched';

  // Themes: Cmd-K "latte" turns the page and the reader frame light; "mocha" back to dark.
  const paletteRun = async (text: string) => {
    await press('K', 1, ['meta']);
    await new Promise((r) => setTimeout(r, 200));
    await typeText(text);
    await press('Return');
    await new Promise((r) => setTimeout(r, 300));
  };
  const bg = () => w.webContents.executeJavaScript(`getComputedStyle(document.body).backgroundColor`) as Promise<string>;
  /** With NORMIE_SMOKE_SHOTS=<folder>, smoke saves screenshots to look at (a hidden window still renders). */
  const shot = d.shot;
  await paletteRun('theme latte');
  const latteBody = await bg();
  await shot('latte-list');
  await press('Enter');
  await new Promise((r) => setTimeout(r, 400));
  await shot('latte-reader');
  const latteFrame = (await w.webContents.executeJavaScript(`(() => { const d = document.querySelector('.mail-frame')?.contentDocument; return d ? getComputedStyle(d.body).backgroundColor : ''; })()`)) as string;
  await press('Escape');
  await paletteRun('theme mocha');
  const mochaBody = await bg();
  const themes = latteBody === 'rgb(239, 241, 245)' && latteFrame === 'rgb(239, 241, 245)' && mochaBody === 'rgb(30, 30, 46)';

  // ? lists the keys (Snooze among them); Esc closes it.
  await press('?');
  await new Promise((r) => setTimeout(r, 300));
  await shot('key-help');
  const helpText = (await w.webContents.executeJavaScript(`document.querySelector('.key-help')?.textContent ?? ''`)) as string;
  await press('Escape');
  const keyHelp = helpText.includes('Snooze') && helpText.includes('Composer') && !((await w.webContents.executeJavaScript(`!!document.querySelector('.key-help')`)) as boolean);

  // Closing the window keeps Normie running: the window hides, the page still answers, the menu bar item stays.
  w.close();
  await new Promise((r) => setTimeout(r, 200));
  const stillAnswers = (await w.webContents.executeJavaScript('1 + 1').catch(() => 0)) === 2;
  const keepsRunning = !w.isDestroyed() && !w.isVisible() && stillAnswers && ctx.trayAlive();
  const ok = start === 0 && afterJ === 5 && afterK === 3 && afterGG === 0 && reader && done && undone && starred && palette && label && keymapOk && compose && reply && drafts && attachments && autocomplete && snippet && splits && notifyClick && snooze && keepsRunning && sendLater && reminder && search && themes && keyHelp;
  return { ok, start, afterJ, afterK, afterGG, reader, html, focusedFrame, readerClosed, riskyRefused, done, undone, starred, palette, label, keymap: keymapOk, compose, reopened, reply, drafts, attachments, autocomplete, snippet, splits, notifyClick, snooze, keepsRunning, sendLater, reminder, search, themes, keyHelp };
}

