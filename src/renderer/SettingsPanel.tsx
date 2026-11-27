// Settings fill the window: Accounts, the theme and Start at Login, as tabs over one column.
import { Button } from '@ui-sdk/react/button';
import { createListboxController, Listbox, ListboxItem } from '@ui-sdk/react/listbox';
import { Switch, SwitchThumb } from '@ui-sdk/react/switch';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs';
import { useEffect, useId, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';
import type { ActiveTheme, ThemeChoice, ThemeSummary } from '../core/vscode-theme';
import { DEFAULT_DARK, DEFAULT_LIGHT } from '../core/vscode-theme';
import { useAddGmail } from './AccountBar';
import { BackIcon } from './icons';
import { AddPasswordAccount } from './AddAccount';
import type { PasswordProvider } from './AddAccount';
import { IdentitiesEditor } from './Identities';
import { Panel } from './Panel';
import { themeTokens } from './theme-tokens';

export type SettingsTab = 'accounts' | 'appearance' | 'general';

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
          <TabsTab value="general">General</TabsTab>
        </TabsList>
        <TabsPanel value="accounts" className="settings-body">
          <AccountSettings accounts={accounts} />
        </TabsPanel>
        <TabsPanel value="appearance" className="settings-body">
          <ThemeSettings theme={theme} themes={themes} onChoose={onChooseTheme} />
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
  const paired = (id: string) => choice.mode === 'system' && (id === choice.light || id === choice.dark);
  const note = useId();
  return (
    <>
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
    </>
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
  return (
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
  );
}
