// Settings fill the window: Accounts, the theme and Start at Login, as tabs over one column.
import { Button } from '@ui-sdk/react/button';
import { createListboxController, Listbox, ListboxItem } from '@ui-sdk/react/listbox';
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from '@ui-sdk/react/segmented-control';
import { Select, SelectContent, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@ui-sdk/react/select';
import { Switch, SwitchThumb } from '@ui-sdk/react/switch';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs';
import { useEffect, useId, useMemo, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { DENSITIES, FAMILIES, FAMILY_FONTS, TEXT_SIZES, WIDTHS } from '../core/appearance';
import type { Appearance } from '../core/appearance';
import { AFTER_TRIAGE, CLOCK, fromKey, MARK_READ, MENU_COUNT, NOTIFY, REMOTE_IMAGES, UNDO_SEND } from '../core/prefs';
import type { Prefs } from '../core/prefs';
import type { ActiveTheme, ThemeChoice, ThemeSummary } from '../core/vscode-theme';
import { DEFAULT_DARK, DEFAULT_LIGHT } from '../core/vscode-theme';
import { useAddGmail } from './AccountBar';
import { setAppearance, useAppearance } from './appearance';
import { setPrefs, usePrefs } from './prefs';
import { BackIcon } from './icons';
import { AddPasswordAccount } from './AddAccount';
import type { PasswordProvider } from './AddAccount';
import { IdentitiesEditor } from './Identities';
import { Panel } from './Panel';
import { themeTokens } from './theme-tokens';

export type SettingsTab = 'accounts' | 'appearance' | 'mail' | 'general';

export function SettingsPanel({
  accounts,
  theme,
  themes,
  onChooseTheme,
  start = 'accounts',
  onClose,
}: {
  accounts: Array<AccountRecord>;
  theme: ActiveTheme;
  themes: Array<ThemeSummary>;
  onChooseTheme: (choice: ThemeChoice) => void;
  start?: SettingsTab;
  onClose: () => void;
}) {
  return (
    <Panel title="Settings" className="settings-panel" onClose={onClose} initialFocus=".settings-tabs [data-selected]">
      <Tabs defaultValue={start}>
        <div className="settings-head">
          <Button className="tool" aria-label="Close Settings" onClick={onClose}>
            <BackIcon />
          </Button>
          <span className="settings-title" aria-hidden="true">
            Settings
          </span>
        </div>
        <TabsList aria-label="Settings" className="settings-tabs">
          <TabsTab value="accounts">Accounts</TabsTab>
          <TabsTab value="appearance">Appearance</TabsTab>
          <TabsTab value="mail">Mail</TabsTab>
          <TabsTab value="general">General</TabsTab>
        </TabsList>
        <TabsPanel value="accounts" className="settings-body">
          <AccountSettings accounts={accounts} />
        </TabsPanel>
        <TabsPanel value="appearance" className="settings-body">
          <LookSettings />
          <ThemeSettings theme={theme} themes={themes} onChoose={onChooseTheme} />
        </TabsPanel>
        <TabsPanel value="mail" className="settings-body">
          <MailSettings accounts={accounts} />
        </TabsPanel>
        <TabsPanel value="general" className="settings-body">
          <GeneralSettings />
        </TabsPanel>
      </Tabs>
    </Panel>
  );
}

const kindOf = (a: AccountRecord) => (a.kind === 'gmail' ? 'Gmail' : a.settings?.provider === 'icloud' ? 'iCloud' : 'IMAP');

function AccountSettings({ accounts }: { accounts: Array<AccountRecord> }) {
  const { add, busy, error } = useAddGmail();
  const [form, setForm] = useState<PasswordProvider | null>(null);
  const [reauth, setReauth] = useState<AccountRecord | null>(null);
  const [editing, setEditing] = useState<AccountRecord | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  return (
    <>
      {accounts.length ? (
        <ul className="settings-accounts" aria-label="Accounts">
          {accounts.map((a) => (
            <li key={a.id} className="settings-account">
              <span className="settings-account-email">{a.email}</span>
              <span className="settings-account-kind">{kindOf(a)}</span>
              {removing === a.id ? (
                <span className="settings-confirm">
                  <span>Its mail on this Mac is deleted; the server keeps it.</span>
                  <Button className="quiet" onClick={() => setRemoving(null)}>
                    Cancel
                  </Button>
                  <Button
                    className="danger"
                    data-agent-confirm={`Removes ${a.email} and deletes its mail on this Mac`}
                    onClick={() => window.normie.accounts.remove(a.id).then(() => setRemoving(null))}
                  >
                    Remove forever
                  </Button>
                </span>
              ) : (
                <span className="settings-actions">
                  {a.status === 'ok' ? (
                    <Button className="quiet" onClick={() => setEditing(a)} aria-label={`Identities for ${a.email}…`}>
                      Identities…
                    </Button>
                  ) : (
                    <Button
                      className="attention"
                      disabled={busy}
                      aria-label={`Sign in to ${a.email} again`}
                      onClick={() => (a.kind === 'imap' ? setReauth(a) : void add(a.email))}
                    >
                      Sign in again
                    </Button>
                  )}
                  <Button className="quiet" onClick={() => setRemoving(a.id)} aria-label={`Remove ${a.email}…`}>
                    Remove…
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-note">No Accounts yet.</p>
      )}
      <div className="settings-add" role="group" aria-label="Add an Account">
        <span>Add an Account</span>
        <Button className="quiet" data-provider="gmail" disabled={busy} onClick={() => void add()}>
          {busy ? 'Waiting for Google…' : 'Gmail…'}
        </Button>
        <Button className="quiet" data-provider="icloud" onClick={() => setForm('icloud')}>
          iCloud…
        </Button>
        <Button className="quiet" data-provider="imap" onClick={() => setForm('imap')}>
          Other IMAP…
        </Button>
      </div>
      {error && <p className="account-error">{error}</p>}
      {form && <AddPasswordAccount provider={form} onDone={() => setForm(null)} />}
      {reauth && <AddPasswordAccount provider={reauth.settings?.provider ?? 'imap'} existing={reauth} onDone={() => setReauth(null)} />}
      {editing && <IdentitiesEditor account={editing} onDone={() => setEditing(null)} />}
    </>
  );
}

const FAMILY_NAMES: Record<Appearance['family'], string> = { geist: 'Geist', katagami: 'Katagami' };
const FONT_NAMES: Record<Appearance['font'], string> = { sans: 'Sans', round: 'Round', text: 'Text', serif: 'Serif', mono: 'Mono' };
const SIZE_NAMES: Record<Appearance['size'], string> = { 12: 'Small', 13: 'Default', 14: 'Large', 15: 'Larger', 16: 'Largest' };
const DENSITY_NAMES: Record<Appearance['density'], string> = { compact: 'Compact', comfortable: 'Comfortable', roomy: 'Roomy' };
const WIDTH_NAMES: Record<Appearance['width'], string> = { narrow: 'Narrow', standard: 'Standard', wide: 'Wide' };

/** Text, layout and motion: each a row of choices that takes effect at once. */
function LookSettings() {
  const a = useAppearance();
  const motionNote = useId();
  const heading = useId();
  return (
    <section className="settings-section" aria-labelledby={heading}>
      <h3 className="settings-heading" id={heading}>
        Text and layout
      </h3>
      <Choice
        label="Typeface"
        value={a.family}
        options={FAMILIES}
        names={FAMILY_NAMES}
        // A face the new family doesn't draw (Katagami's Round or Text, in Geist) becomes its Sans.
        onChange={(family) => setAppearance({ family, font: FAMILY_FONTS[family].includes(a.font) ? a.font : 'sans' })}
        itemClass={(f) => `family-${f}`}
      />
      <Choice
        label="Font"
        value={a.font}
        options={FAMILY_FONTS[a.family]}
        names={FONT_NAMES}
        onChange={(font) => setAppearance({ font })}
        itemClass={(f) => `font-${f}`}
      />
      <Choice
        label="Text size"
        value={String(a.size)}
        options={TEXT_SIZES.map(String)}
        names={Object.fromEntries(TEXT_SIZES.map((n) => [String(n), SIZE_NAMES[n]]))}
        onChange={(size) => setAppearance({ size: TEXT_SIZES.find((n) => String(n) === size) ?? 13 })}
        glyph={(size) => (
          <span className="size-glyph" data-size={size}>
            A
          </span>
        )}
      />
      <Choice label="Row height" value={a.density} options={DENSITIES} names={DENSITY_NAMES} onChange={(density) => setAppearance({ density })} />
      <Choice label="Column width" value={a.width} options={WIDTHS} names={WIDTH_NAMES} onChange={(width) => setAppearance({ width })} />
      <label className="settings-switch">
        <span>
          Reduce motion
          <span className="settings-note" id={motionNote}>
            No sliding or fading, even when your system allows it.
          </span>
        </span>
        <Switch
          checked={a.reduceMotion}
          onCheckedChange={(reduceMotion) => flushSync(() => setAppearance({ reduceMotion }))}
          aria-label="Reduce motion"
          aria-describedby={motionNote}
        >
          <SwitchThumb />
        </Switch>
      </label>
    </section>
  );
}

/** One setting as a labelled segmented control. A glyph, when given, stands in for the name (which still names it). */
function Choice<T extends string>({
  label,
  value,
  options,
  names,
  onChange,
  itemClass,
  glyph,
  note,
}: {
  label: string;
  /** A line under the label, saying what the choice means. */
  note?: string;
  value: T;
  options: ReadonlyArray<T>;
  names: Record<T, string>;
  onChange: (value: T) => void;
  itemClass?: (value: T) => string;
  glyph?: (value: T) => ReactNode;
}) {
  const id = useId();
  const noteId = useId();
  return (
    <div className="settings-row">
      <span>
        <span id={id}>{label}</span>
        {note && (
          <span className="settings-note" id={noteId}>
            {note}
          </span>
        )}
      </span>
      <SegmentedControl
        aria-labelledby={id}
        aria-describedby={note ? noteId : undefined}
        className="segmented"
        value={value}
        onValueChange={(v) => {
          const next = options.find((o) => o === v);
          if (next) {
            flushSync(() => onChange(next));
          }
        }}
      >
        <SegmentedControlIndicator className="segmented-indicator" />
        {options.map((o) => (
          <SegmentedControlItem
            key={o}
            value={o}
            data-value={o}
            className={itemClass ? `segmented-item ${itemClass(o)}` : 'segmented-item'}
            aria-label={glyph ? names[o] : undefined}
          >
            {glyph ? glyph(o) : names[o]}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
    </div>
  );
}

/**
 * One grid of theme tiles, each a small picture of the app in that theme. Fixed: the pick is the theme. Following the
 * system: a light pick is the light half of the pair, a dark pick the dark half. Arrow keys pick as they move, so the
 * app itself is the preview too.
 */
function ThemeSettings({ theme, themes, onChoose }: { theme: ActiveTheme; themes: Array<ThemeSummary>; onChoose: (choice: ThemeChoice) => void }) {
  const { choice } = theme;
  // A pick shows at once (an agent's change must take right away); the theme comes back from main a moment later.
  const [following, setFollowing] = useState(choice.mode === 'system');
  const [picked, setPicked] = useState(theme.theme.id);
  const [seen, setSeen] = useState(theme);
  const [grid] = useState(() => createListboxController<string>());
  if (seen !== theme) {
    setSeen(theme);
    setFollowing(choice.mode === 'system');
    setPicked(theme.theme.id);
  }
  const pick = (id: string) => {
    const t = themes.find((x) => x.id === id);
    if (!t) {
      return;
    }
    if (choice.mode === 'system') {
      onChoose(t.type === 'light' ? { ...choice, light: id } : { ...choice, dark: id });
    } else {
      onChoose({ mode: 'fixed', id });
    }
  };
  const follow = (on: boolean) => {
    flushSync(() => setFollowing(on));
    if (!on) {
      onChoose({ mode: 'fixed', id: theme.theme.id });
    } else if (theme.theme.type === 'light') {
      onChoose({ mode: 'system', light: theme.theme.id, dark: DEFAULT_DARK });
    } else {
      onChoose({ mode: 'system', light: DEFAULT_LIGHT, dark: theme.theme.id });
    }
  };
  // The listbox moves left and right; up and down go a row, as many tiles as the grid fits across.
  const rowKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') {
      return;
    }
    const tiles = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-theme-id]')];
    const at = tiles.findIndex((t) => t.contains(document.activeElement));
    const across = tiles.filter((t) => t.offsetTop === tiles[0]?.offsetTop).length || 1;
    const to = tiles[at + (e.key === 'ArrowDown' ? across : -across)];
    e.preventDefault();
    if (at >= 0 && to?.dataset.themeId) {
      grid.highlight(to.dataset.themeId);
      to.focus();
      grid.setValue(to.dataset.themeId);
    }
  };
  const heading = useId();
  const paired = (id: string) => choice.mode === 'system' && (id === choice.light || id === choice.dark);
  const note = useId();
  return (
    <section className="settings-section" aria-labelledby={heading}>
      <h3 className="settings-heading" id={heading}>
        Theme
      </h3>
      <label className="settings-switch">
        <span>
          Match the system’s light and dark
          <span className="settings-note" id={note}>
            Pick a light and a dark theme, and Normie switches with your system.
          </span>
        </span>
        <Switch checked={following} onCheckedChange={follow} aria-label="Match the system’s light and dark" aria-describedby={note}>
          <SwitchThumb />
        </Switch>
      </label>
      <Listbox
        aria-label="Theme"
        className="theme-grid"
        orientation="horizontal"
        activation="automatic"
        controller={grid}
        value={picked}
        onKeyDown={rowKey}
        onValueChange={(id) => {
          if (id !== null) {
            flushSync(() => setPicked(id));
            pick(id);
          }
        }}
      >
        {themes.map((t) => (
          <ListboxItem key={t.id} value={t.id} label={t.name} className="theme-item" data-theme-id={t.id} data-paired={paired(t.id) || undefined}>
            <ThemePreview theme={t} />
            <span className="theme-caption">
              <span className="theme-name">{t.name}</span>
              <span className="theme-meta">
                {t.type === 'light' ? 'Light' : 'Dark'}
                {t.source === 'user' && ' · yours'}
              </span>
            </span>
          </ListboxItem>
        ))}
      </Listbox>
      <p className="settings-note">More themes: put VS Code color theme files in the themes folder in Normie’s data folder.</p>
    </section>
  );
}

/** The app in miniature, painted in a theme's own colors: a header with tabs, then three rows, the first selected. */
function ThemePreview({ theme }: { theme: ThemeSummary }) {
  const vars = useMemo(() => themeTokens(theme.colors, theme.type), [theme.colors, theme.type]);
  return (
    <span className="theme-preview" style={vars} aria-hidden="true">
      <span className="tp-head">
        <span className="tp-tab tp-on" />
        <span className="tp-tab" />
        <span className="tp-tab" />
        <span className="tp-dots">
          <i />
          <i />
          <i />
        </span>
      </span>
      {[0, 1, 2].map((r) => (
        <span key={r} className={r === 0 ? 'tp-row tp-sel' : 'tp-row'}>
          <span className="tp-dot" />
          <span className="tp-from" />
          <span className="tp-subject" />
        </span>
      ))}
    </span>
  );
}

function GeneralSettings() {
  const [login, setLogin] = useState<{ on: boolean; packaged: boolean } | null>(null);
  useEffect(() => {
    void window.normie.loginItem().then(setLogin);
  }, []);
  const prefs = usePrefs();
  const heading = useId();
  return (
    <section className="settings-section" aria-labelledby={heading}>
      <h3 className="settings-heading" id={heading}>
        General
      </h3>
      <label className="settings-switch">
        <span>
          Start at Login
          {login && !login.packaged && <span className="settings-note">Applies to the installed app.</span>}
        </span>
        <Switch
          checked={login?.on ?? false}
          disabled={!login}
          aria-label="Start at Login"
          onCheckedChange={(on) => {
            flushSync(() => setLogin((l) => l && { ...l, on }));
            void window.normie.setLoginItem(on).then(setLogin);
          }}
        >
          <SwitchThumb />
        </Switch>
      </label>
      <Choice
        label="Notifications"
        note="Important means the Splits set to notify: Important, unless you changed splits.json."
        value={prefs.notify}
        options={NOTIFY}
        names={NOTIFY_NAMES}
        onChange={(notify) => setPrefs({ notify })}
      />
      <Choice label="Menu bar count" value={prefs.menuCount} options={MENU_COUNT} names={MENU_COUNT_NAMES} onChange={(menuCount) => setPrefs({ menuCount })} />
      <Choice label="Time format" value={prefs.clock} options={CLOCK} names={CLOCK_NAMES} onChange={(clock) => setPrefs({ clock })} />
    </section>
  );
}

const MARK_READ_NAMES: Record<Prefs['markRead'], string> = { open: 'When opened', delay: 'After 2 seconds', manual: 'By hand' };
const IMAGES_NAMES: Record<Prefs['remoteImages'], string> = { ask: 'Ask', known: 'From people I know', always: 'Always' };
const AFTER_NAMES: Record<Prefs['afterTriage'], string> = { next: 'Next Thread', previous: 'Previous Thread', list: 'Back to the list' };
const UNDO_NAMES = { '0': 'Off', '5': '5 s', '10': '10 s', '20': '20 s', '30': '30 s' } satisfies Record<`${(typeof UNDO_SEND)[number]}`, string>;
const NOTIFY_NAMES: Record<Prefs['notify'], string> = { off: 'Off', splits: 'Important', all: 'All new mail' };
const MENU_COUNT_NAMES: Record<Prefs['menuCount'], string> = { inbox: 'Inbox', unread: 'Unread', off: 'None' };
const CLOCK_NAMES: Record<Prefs['clock'], string> = { system: 'System', '12': '12-hour', '24': '24-hour' };

/** Reading and sending: how Threads get marked read, remote images, where Done goes next, undo send and the From. */
function MailSettings({ accounts }: { accounts: Array<AccountRecord> }) {
  const prefs = usePrefs();
  const reading = useId();
  const sending = useId();
  const froms = accounts
    .filter((a) => a.status === 'ok')
    .flatMap((a) => (a.identities?.length ? a.identities : [{ address: a.email }]).map((f) => ({ key: fromKey(a.id, f.address), from: f })))
    .map((f) => ({ ...f, label: f.from.name ? `${f.from.name} <${f.from.address}>` : f.from.address }));
  return (
    <>
      <section className="settings-section" aria-labelledby={reading}>
        <h3 className="settings-heading" id={reading}>
          Reading
        </h3>
        <Choice label="Mark as read" value={prefs.markRead} options={MARK_READ} names={MARK_READ_NAMES} onChange={(markRead) => setPrefs({ markRead })} />
        <Choice
          label="Remote images"
          note="Loading them tells the sender you opened their mail. People you know: anyone you've written to, and VIPs."
          value={prefs.remoteImages}
          options={REMOTE_IMAGES}
          names={IMAGES_NAMES}
          onChange={(remoteImages) => setPrefs({ remoteImages })}
        />
        <Choice
          label="After Done or Snooze"
          value={prefs.afterTriage}
          options={AFTER_TRIAGE}
          names={AFTER_NAMES}
          onChange={(afterTriage) => setPrefs({ afterTriage })}
        />
      </section>
      <section className="settings-section" aria-labelledby={sending}>
        <h3 className="settings-heading" id={sending}>
          Sending
        </h3>
        <Choice
          label="Undo send"
          note="How long a sent message waits, so ⌘Z can take it back."
          value={String(prefs.undoSend)}
          options={UNDO_SEND.map(String)}
          names={UNDO_NAMES}
          onChange={(v) => setPrefs({ undoSend: UNDO_SEND.find((n) => String(n) === v) ?? 5 })}
        />
        {froms.length > 1 && (
          <div className="settings-row">
            <Select
              items={froms.map((f) => ({ value: f.key, label: f.label }))}
              value={froms.some((f) => f.key === prefs.defaultFrom) ? prefs.defaultFrom : (froms[0]?.key ?? null)}
              onValueChange={(v) => {
                if (typeof v === 'string') {
                  flushSync(() => setPrefs({ defaultFrom: v }));
                }
              }}
            >
              <SelectLabel className="settings-label">New mail from</SelectLabel>
              <SelectTrigger className="select-trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="menu select-menu">
                {froms.map((f) => (
                  <SelectItem key={f.key} value={f.key} className="menu-item">
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </section>
    </>
  );
}
