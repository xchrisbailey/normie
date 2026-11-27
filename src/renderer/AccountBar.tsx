// Shows which Accounts are signed in, and a quiet way to sign in again when one has expired.
import { useEffect, useState } from 'react';
import { errorMessage } from '../core/errors';
import { AddPasswordAccount } from './AddAccount';
import { DoneMark } from './icons';
import type { PasswordProvider } from './AddAccount';

export function useAccounts() {
  const [accounts, setAccounts] = useState<Array<AccountRecord> | null>(null);
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
    } catch (error_) {
      setError(errorMessage(error_).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setBusy(false);
    }
  };
  return { add, busy, error };
}

/** Below the list, only when an Account needs attention: its sign-in expired. Everything else is in Settings. */
export function AccountBar({ accounts }: { accounts: Array<AccountRecord> }) {
  const { add, busy, error } = useAddGmail();
  /** An iCloud or IMAP Account to sign in to again, with its own password form (not Google's). */
  const [reauth, setReauth] = useState<AccountRecord | null>(null);
  return (
    <div className="accounts">
      {accounts
        .filter((a) => a.status !== 'ok')
        .map((a) => (
          <button
            type="button"
            key={a.id}
            className="account needs-sign-in"
            disabled={busy}
            onClick={() => (a.kind === 'imap' ? setReauth(a) : void add(a.email))}
            title={a.kind === 'gmail' ? 'Google sign-in expired or was revoked' : 'The password stopped working'}
          >
            {a.email} · Sign in again
          </button>
        ))}
      {reauth && <AddPasswordAccount provider={reauth.settings?.provider ?? 'imap'} existing={reauth} onDone={() => setReauth(null)} />}
      {error && <span className="account-error">{error}</span>}
    </div>
  );
}

export function EmptyState() {
  const { add, busy, error } = useAddGmail();
  const [form, setForm] = useState<PasswordProvider | null>(null);
  return (
    <div className="empty">
      <DoneMark />
      <h1 className="list-empty-title">Welcome to Normie</h1>
      <p className="list-empty-note">Add an Account to start. Its mail is kept on this Mac, so the keys stay fast.</p>
      <button type="button" className="primary" disabled={busy} onClick={() => void add()}>
        {busy ? 'Waiting for Google in your browser…' : 'Add Gmail Account'}
      </button>
      <span className="or">
        or{' '}
        <button type="button" className="link" onClick={() => setForm('icloud')}>
          Add iCloud
        </button>{' '}
        ·{' '}
        <button type="button" className="link" onClick={() => setForm('imap')}>
          Other IMAP
        </button>
      </span>
      {form && <AddPasswordAccount provider={form} onDone={() => setForm(null)} />}
      {error && <p className="account-error">{error}</p>}
    </div>
  );
}
