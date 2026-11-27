// Settings drop from the header: Accounts, the theme and Start at Login, as tabs in one panel.
import { Listbox, ListboxItem } from '@ui-sdk/react/listbox';
import { Switch, SwitchThumb } from '@ui-sdk/react/switch';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs';
import { useEffect, useState } from 'react';
import type { ActiveTheme, ThemeChoice, ThemeSummary } from '../core/vscode-theme';
import { DEFAULT_DARK, DEFAULT_LIGHT } from '../core/vscode-theme';
import { useAddGmail } from './AccountBar';
import { AddPasswordAccount } from './AddAccount';
import type { PasswordProvider } from './AddAccount';
import { IdentitiesEditor } from './Identities';
import { Panel } from './Panel';

export type SettingsTab = 'accounts' | 'appearance' | 'general';
const isTab = (v: string | null): v is SettingsTab => v === 'accounts' || v === 'appearance' || v === 'general';

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
  const [tab, setTab] = useState<SettingsTab>(start);
  return (
    <Panel title="Settings" className="settings-panel" onClose={onClose} initialFocus=".settings-tabs [data-selected]">
      <Tabs value={tab} onValueChange={(v) => isTab(v) && setTab(v)}>
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
                  <button type="button" className="quiet" onClick={() => setRemoving(null)}>
                    Cancel
                  </button>
                  <button type="button" className="danger" onClick={() => void window.normie.accounts.remove(a.id).then(() => setRemoving(null))}>
                    Remove
                  </button>
                </span>
              ) : (
                <span className="settings-actions">
                  {a.status === 'ok' ? (
                    <button type="button" className="quiet" onClick={() => setEditing(a)}>
                      Identities…
                    </button>
                  ) : (
                    <button type="button" className="attention" disabled={busy} onClick={() => (a.kind === 'imap' ? setReauth(a) : void add(a.email))}>
                      Sign in again
                    </button>
                  )}
                  <button type="button" className="quiet" onClick={() => setRemoving(a.id)} aria-label={`Remove ${a.email}`}>
                    Remove…
                  </button>
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
        <button type="button" className="quiet" data-provider="gmail" disabled={busy} onClick={() => void add()}>
          {busy ? 'Waiting for Google…' : 'Gmail…'}
        </button>
        <button type="button" className="quiet" data-provider="icloud" onClick={() => setForm('icloud')}>
          iCloud…
        </button>
        <button type="button" className="quiet" data-provider="imap" onClick={() => setForm('imap')}>
          Other IMAP…
        </button>
      </div>
      {error && <p className="account-error">{error}</p>}
      {form && <AddPasswordAccount provider={form} onDone={() => setForm(null)} />}
      {reauth && <AddPasswordAccount provider={reauth.settings?.provider ?? 'imap'} existing={reauth} onDone={() => setReauth(null)} />}
      {editing && <IdentitiesEditor account={editing} onDone={() => setEditing(null)} />}
    </>
  );
}

/**
 * One list of themes. Fixed: the pick is the theme. Following the system: a light pick is the light half of the
 * pair, a dark pick the dark half. Arrow keys pick as they move, so the app itself is the preview.
 */
function ThemeSettings({ theme, themes, onChoose }: { theme: ActiveTheme; themes: Array<ThemeSummary>; onChoose: (choice: ThemeChoice) => void }) {
  const { choice } = theme;
  const following = choice.mode === 'system';
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
    if (!on) {
      onChoose({ mode: 'fixed', id: theme.theme.id });
    } else if (theme.theme.type === 'light') {
      onChoose({ mode: 'system', light: theme.theme.id, dark: DEFAULT_DARK });
    } else {
      onChoose({ mode: 'system', light: DEFAULT_LIGHT, dark: theme.theme.id });
    }
  };
  const paired = (id: string) => choice.mode === 'system' && (id === choice.light || id === choice.dark);
  return (
    <>
      <label className="settings-switch">
        <span>
          Match the system’s light and dark
          <span className="settings-note">Pick a light and a dark theme, and Normie switches with your system.</span>
        </span>
        <Switch checked={following} onCheckedChange={follow}>
          <SwitchThumb />
        </Switch>
      </label>
      <Listbox aria-label="Theme" className="theme-list" activation="automatic" value={theme.theme.id} onValueChange={(id) => id !== null && pick(id)}>
        {themes.map((t) => (
          <ListboxItem key={t.id} value={t.id} className="theme-item" data-theme-id={t.id} data-paired={paired(t.id) || undefined}>
            <span className="theme-name">{t.name}</span>
            <span className="theme-meta">
              {t.type === 'light' ? 'Light' : 'Dark'}
              {t.source === 'user' && ' · yours'}
            </span>
          </ListboxItem>
        ))}
      </Listbox>
      <p className="settings-note">More themes: put VS Code color theme files in the themes folder in Normie’s data folder.</p>
    </>
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
      <Switch checked={login?.on ?? false} disabled={!login} onCheckedChange={(on) => void window.normie.setLoginItem(on).then(setLogin)}>
        <SwitchThumb />
      </Switch>
    </label>
  );
}
