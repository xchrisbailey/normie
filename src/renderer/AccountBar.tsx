// Shows which Accounts are signed in, and a quiet way to sign in again when one has expired.
import { useEffect, useState } from 'react';
import { AddPasswordAccount, type PasswordProvider } from './AddAccount';
import { IdentitiesEditor } from './Identities';

export function useAccounts() {
  const [accounts, setAccounts] = useState<AccountRecord[] | null>(null);
  useEffect(() => {
    void window.normie.accounts.list().then(setAccounts);
    return window.normie.accounts.onChanged(setAccounts);
  }, []);
  return accounts;
}

export function useAddGmail() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async (loginHint?: string) => {
    setBusy(true);
    setError(null);
    try {
      await window.normie.accounts.addGmail(loginHint);
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setBusy(false);
    }
  };
  return { add, busy, error };
}

export function AccountBar({ accounts }: { accounts: AccountRecord[] }) {
  const { add, busy, error } = useAddGmail();
  const [menu, setMenu] = useState(false);
  const [form, setForm] = useState<PasswordProvider | null>(null);
  /** The Account whose chip was clicked: offers Remove, with a confirmation. */
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState<AccountRecord | null>(null);
  return (
    <div className="accounts">
      {accounts.map((a) =>
        a.status === 'ok' ? (
          <span key={a.id} className="account-wrap">
            <button className="account" title={`Signed in as ${a.email}`} onClick={() => {
              setSelected((s) => (s === a.id ? null : a.id));
              setConfirming(false);
            }}>{a.email}</button>
            {selected === a.id && (
              <span className="popover" onMouseLeave={() => setSelected(null)}>
                {confirming ? (
                  <>
                    <span>Remove {a.email}? Its mail on this Mac is deleted; the server keeps it.</span>
                    <button className="danger" onClick={() => void window.normie.accounts.remove(a.id).then(() => setSelected(null))}>Remove</button>
                    <button className="quiet" onClick={() => setConfirming(false)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button className="quiet" onClick={() => { setSelected(null); setEditing(a); }}>Identities…</button>
                    <button className="quiet" onClick={() => setConfirming(true)}>Remove Account…</button>
                  </>
                )}
              </span>
            )}
          </span>
        ) : (
          <button key={a.id} className="account needs-sign-in" disabled={busy} onClick={() => void add(a.email)}
            title={a.kind === 'gmail' ? 'Google sign-in expired or was revoked' : 'The password stopped working'}>
            {a.email} · Sign in again
          </button>
        ),
      )}
      {!window.normie.fake && (
        <span className="account-wrap">
          <button className="account add" disabled={busy} onClick={() => setMenu((m) => !m)} title="Add an Account">
            {busy ? 'Waiting for Google…' : '+ Add Account'}
          </button>
          {menu && (
            <span className="popover" onMouseLeave={() => setMenu(false)}>
              <button className="quiet" onClick={() => { setMenu(false); void add(); }}>Gmail…</button>
              <button className="quiet" onClick={() => { setMenu(false); setForm('icloud'); }}>iCloud…</button>
              <button className="quiet" onClick={() => { setMenu(false); setForm('imap'); }}>Other IMAP…</button>
            </span>
          )}
        </span>
      )}
      {form && <AddPasswordAccount provider={form} onDone={() => setForm(null)} />}
      {editing && <IdentitiesEditor account={editing} onDone={() => setEditing(null)} />}
      {error && <span className="account-error">{error}</span>}
    </div>
  );
}

export function EmptyState() {
  const { add, busy, error } = useAddGmail();
  const [form, setForm] = useState<PasswordProvider | null>(null);
  return (
    <div className="empty">
      <p>No Accounts yet.</p>
      <button className="primary" disabled={busy} onClick={() => void add()}>
        {busy ? 'Waiting for Google in your browser…' : 'Add Gmail Account'}
      </button>
      <span className="or">
        <button className="link" onClick={() => setForm('icloud')}>Add iCloud</button> · <button className="link" onClick={() => setForm('imap')}>Other IMAP</button>
      </span>
      {form && <AddPasswordAccount provider={form} onDone={() => setForm(null)} />}
      {error && <p className="account-error">{error}</p>}
    </div>
  );
}
