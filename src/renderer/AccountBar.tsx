// Shows which Accounts are signed in, and a quiet way to sign in again when one has expired.
import { useEffect, useState } from 'react';

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
  return (
    <div className="accounts">
      {accounts.map((a) =>
        a.status === 'ok' ? (
          <span key={a.id} className="account" title={`Signed in as ${a.email}`}>{a.email}</span>
        ) : (
          <button key={a.id} className="account needs-sign-in" disabled={busy} onClick={() => void add(a.email)} title="Google sign-in expired or was revoked">
            {a.email} · Sign in again
          </button>
        ),
      )}
      {!window.normie.fake && (
        <button className="account add" disabled={busy} onClick={() => void add()} title="Sign in with Google in your browser">
          {busy ? 'Waiting for Google…' : '+ Add Gmail'}
        </button>
      )}
      {error && <span className="account-error">{error}</span>}
    </div>
  );
}

export function EmptyState() {
  const { add, busy, error } = useAddGmail();
  return (
    <div className="empty">
      <p>No Accounts yet.</p>
      <button className="primary" disabled={busy} onClick={() => void add()}>
        {busy ? 'Waiting for Google in your browser…' : 'Add Gmail Account'}
      </button>
      {error && <p className="account-error">{error}</p>}
    </div>
  );
}
