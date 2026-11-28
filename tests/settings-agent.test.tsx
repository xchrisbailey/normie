// @vitest-environment jsdom
// An agent (through ui-sdk's bridge) finds every control in Settings by name and changes them as a person would.
import { createAgent } from '@ui-sdk/react/agent';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { Appearance } from '../src/core/appearance';
import type { Prefs } from '../src/core/prefs';
import type { ActiveTheme, ThemeChoice, ThemeSummary } from '../src/core/vscode-theme';
import { SettingsPanel } from '../src/renderer/SettingsPanel';

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLElement.prototype.showPopover = function () {};
  HTMLElement.prototype.hidePopover = function () {};
  Element.prototype.getAnimations = () => [];
  Element.prototype.scrollIntoView = function () {};
  Element.prototype.checkVisibility = () => true;
  const none = document.createElement('div').getClientRects();
  Element.prototype.getClientRects = () => none;
  document.elementFromPoint = () => null;
  document.elementsFromPoint = () => [];
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const themes: Array<ThemeSummary> = [
  { id: 'normie-light', name: 'Normie Light', type: 'light', source: 'bundled', colors: {} },
  { id: 'normie-dark', name: 'Normie Dark', type: 'dark', source: 'bundled', colors: {} },
  { id: 'solarized-light', name: 'Solarized Light', type: 'light', source: 'bundled', colors: {} },
];
const active: ActiveTheme = {
  theme: { id: 'normie-light', name: 'Normie Light', type: 'light', colors: {} },
  choice: { mode: 'fixed', id: 'normie-light' },
};
const accounts: Array<AccountRecord> = [
  { id: 'a1', kind: 'gmail', email: 'ada@example.com', status: 'ok' },
  { id: 'a2', kind: 'imap', email: 'ada@work.example', status: 'ok' },
];

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

let approve = false;
const agent = createAgent({ allow: (step) => !step.confirm || approve });
const named = () => agent.snapshot().filter((e) => !e.offPage && e.component !== 'more');

test('an agent can find and change every setting', async () => {
  const setLoginItem = vi.fn(async (on: boolean) => ({ on, packaged: true }));
  const remove = vi.fn(async () => {});
  const saveAppearance = vi.fn(async (a: Appearance) => a);
  const savePrefs = vi.fn(async (p: Prefs) => p);
  Object.assign(window, {
    normie: {
      loginItem: async () => ({ on: true, packaged: true }),
      setLoginItem,
      accounts: { remove, addGmail: async () => accounts[0] },
      appearance: { set: saveAppearance },
      prefs: { set: savePrefs },
    },
  });
  const chosen: Array<ThemeChoice> = [];
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(<SettingsPanel accounts={accounts} theme={active} themes={themes} onChooseTheme={(c) => chosen.push(c)} onClose={() => {}} />),
  );

  for (const entry of named()) {
    expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  }
  const labels = named().map((e) => e.label);
  for (const label of ['Settings', 'Close Settings', 'Identities for ada@example.com…', 'Remove ada@example.com…', 'Gmail…', 'iCloud…', 'Other IMAP…']) {
    expect(labels, `${label} is missing from the snapshot`).toContain(label);
  }

  // Removing an Account needs the person.
  await act(async () => void (await agent.act({ steps: [{ ref: 'Remove ada@example.com…', action: 'press' }] })));
  const removeStep = { steps: [{ ref: 'Remove forever', action: 'press' }] };
  let result = await act(async () => agent.act(removeStep));
  expect(result.ok).toBe(false);
  expect(remove).not.toHaveBeenCalled();
  approve = true;
  result = await act(async () => agent.act(removeStep));
  expect(result.ok, result.error?.message).toBe(true);
  expect(remove).toHaveBeenCalledWith('a1');

  result = await act(async () => agent.act({ steps: [{ ref: 'Settings', action: 'setValue', args: ['appearance'] }] }));
  expect(result.ok, result.error?.message).toBe(true);
  result = await act(async () => agent.act({ steps: [{ ref: 'Theme', action: 'setValue', args: ['solarized-light'] }] }));
  expect(result.ok, result.error?.message).toBe(true);
  expect(chosen).toContainEqual({ mode: 'fixed', id: 'solarized-light' });
  result = await act(async () => agent.act({ steps: [{ ref: 'Match the system’s light and dark', action: 'setChecked', args: [true] }] }));
  expect(result.ok, result.error?.message).toBe(true);
  expect(chosen).toContainEqual({ mode: 'system', light: 'normie-light', dark: 'normie-dark' });

  // Text and layout take at once, on the page, and are saved.
  for (const [ref, value] of [
    ['Font', 'serif'],
    ['Text size', '15'],
    ['Row height', 'compact'],
    ['Column width', 'wide'],
  ] as const) {
    result = await act(async () => agent.act({ steps: [{ ref, action: 'setValue', args: [value] }] }));
    expect(result.ok, `${ref}: ${result.error?.message}`).toBe(true);
  }
  result = await act(async () => agent.act({ steps: [{ ref: 'Reduce motion', action: 'setChecked', args: [true] }] }));
  expect(result.ok, result.error?.message).toBe(true);
  const page = document.documentElement;
  expect([page.dataset.font, page.dataset.motion, page.style.getPropertyValue('--column'), page.style.getPropertyValue('--row-h')]).toEqual([
    'serif',
    'reduced',
    '900px',
    '36px',
  ]);
  expect(saveAppearance).toHaveBeenLastCalledWith({ family: 'geist', font: 'serif', size: 15, density: 'compact', width: 'wide', reduceMotion: true });

  // Katagami: its own faces appear, and Serif carries over; back to Geist, Round becomes Sans.
  result = await act(async () => agent.act({ steps: [{ ref: 'Typeface', action: 'setValue', args: ['katagami'] }] }));
  expect(result.ok, result.error?.message).toBe(true);
  expect([page.dataset.family, page.dataset.font]).toEqual(['katagami', 'serif']);
  result = await act(async () => agent.act({ steps: [{ ref: 'Font', action: 'setValue', args: ['round'] }] }));
  expect(result.ok, result.error?.message).toBe(true);
  expect(page.dataset.font).toBe('round');
  result = await act(async () => agent.act({ steps: [{ ref: 'Typeface', action: 'setValue', args: ['geist'] }] }));
  expect(result.ok, result.error?.message).toBe(true);
  expect([page.dataset.family, page.dataset.font]).toEqual(['geist', 'sans']);
  expect(saveAppearance).toHaveBeenLastCalledWith({ family: 'geist', font: 'sans', size: 15, density: 'compact', width: 'wide', reduceMotion: true });

  // Mail and General: each choice takes at once and is saved.
  result = await act(async () => agent.act({ steps: [{ ref: 'Settings', action: 'setValue', args: ['mail'] }] }));
  expect(result.ok, result.error?.message).toBe(true);
  for (const [ref, value] of [
    ['Mark as read', 'manual'],
    ['Remote images', 'known'],
    ['After Done or Snooze', 'list'],
    ['Undo send', '20'],
    ['New mail from', 'a2 ada@work.example'],
  ] as const) {
    result = await act(async () => agent.act({ steps: [{ ref, action: 'setValue', args: [value] }] }));
    expect(result.ok, `${ref}: ${result.error?.message}`).toBe(true);
  }
  result = await act(async () => agent.act({ steps: [{ ref: 'Settings', action: 'setValue', args: ['general'] }] }));
  expect(result.ok, result.error?.message).toBe(true);
  for (const [ref, value] of [
    ['Notifications', 'all'],
    ['Menu bar count', 'unread'],
    ['Time format', '24'],
  ] as const) {
    result = await act(async () => agent.act({ steps: [{ ref, action: 'setValue', args: [value] }] }));
    expect(result.ok, `${ref}: ${result.error?.message}`).toBe(true);
  }
  expect(savePrefs).toHaveBeenLastCalledWith({
    markRead: 'manual',
    remoteImages: 'known',
    afterTriage: 'list',
    undoSend: 20,
    defaultFrom: 'a2 ada@work.example',
    notify: 'all',
    menuCount: 'unread',
    clock: '24',
  });

  result = await act(async () => agent.act({ steps: [{ ref: 'Settings', action: 'setValue', args: ['general'] }] }));
  expect(result.ok, result.error?.message).toBe(true);
  result = await act(async () => agent.act({ steps: [{ ref: 'Start at Login', action: 'setChecked', args: [false] }] }));
  expect(result.ok, result.error?.message).toBe(true);
  expect(setLoginItem).toHaveBeenCalledWith(false);
});
