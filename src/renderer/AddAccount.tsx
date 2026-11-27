// Adding an iCloud or IMAP/SMTP Account: a short form, checked against the real servers before it's saved.
import { useState } from 'react';
import { Panel } from './Panel';

interface FormError {
  message: string;
  field?: string;
}
type Security = 'tls' | 'starttls' | 'none';
const isSecurity = (v: string): v is Security => v === 'tls' || v === 'starttls' || v === 'none';
export type PasswordProvider = 'icloud' | 'imap';

export function AddPasswordAccount({
  provider,
  onDone,
  existing,
}: {
  provider: PasswordProvider;
  onDone: () => void;
  /** Signing in again to an Account that has these settings: everything but the password is filled in. */
  existing?: AccountRecord;
}) {
  const s = existing?.settings;
  const [email, setEmail] = useState(s?.email ?? existing?.email ?? '');
  const [user, setUser] = useState(s && s.user !== s.email ? s.user : '');
  const [password, setPassword] = useState('');
  const [imapHost, setImapHost] = useState(s?.imap.host ?? '');
  const [imapPort, setImapPort] = useState(String(s?.imap.port ?? 993));
  const [imapSecurity, setImapSecurity] = useState<Security>(s?.imap.security ?? 'tls');
  const [smtpHost, setSmtpHost] = useState(s?.smtp.host ?? '');
  const [smtpPort, setSmtpPort] = useState(String(s?.smtp.port ?? 587));
  const [smtpSecurity, setSmtpSecurity] = useState<Security>(s?.smtp.security ?? 'starttls');
  const [savesSent, setSavesSent] = useState(s?.savesSent ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FormError | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const input =
      provider === 'icloud'
        ? { provider, email, password }
        : {
            provider,
            email,
            user,
            password,
            savesSent,
            imap: { host: imapHost, port: Number(imapPort), security: imapSecurity },
            smtp: { host: smtpHost, port: Number(smtpPort), security: smtpSecurity },
          };
    const r = await window.normie.accounts.addPassword(input);
    setBusy(false);
    if (r.ok) {
      onDone();
    } else {
      const problem: FormError = { message: r.error };
      if (r.field) {
        problem.field = r.field;
      }
      setError(problem);
    }
  };

  const bad = (field: string) => (error?.field === field ? 'bad' : undefined);
  const security = (value: Security, set: (s: Security) => void) => (
    <select
      value={value}
      onChange={(e) => {
        const next = e.target.value;
        if (isSecurity(next)) {
          set(next);
        }
      }}
    >
      <option value="tls">TLS</option>
      <option value="starttls">STARTTLS</option>
    </select>
  );

  const title = existing ? `Sign in to ${existing.email} again` : provider === 'icloud' ? 'Add iCloud Account' : 'Add IMAP Account';
  // Signing in again goes straight to the password.
  return (
    <Panel title={title} className="sheet-panel" onClose={onDone} dismissible={!busy} initialFocus={existing ? '.sheet input[type=password]' : '.sheet input'}>
      <form className="sheet" onSubmit={(e) => void submit(e)}>
        <h2 aria-hidden="true">{title}</h2>
        {provider === 'icloud' && (
          <p className="help">
            Sign in with your <b>@icloud.com</b> address and an <b>app-specific password</b> from account.apple.com → Sign-In and Security → App-Specific
            Passwords. You can send from your own domain afterwards.
          </p>
        )}
        <label>
          <span>Email</span>
          <input
            className={bad('email')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={provider === 'icloud' ? 'you@icloud.com' : 'you@example.com'}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {provider === 'imap' && (
          <label>
            <span>Username</span>
            <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="Same as email" autoComplete="off" spellCheck={false} />
          </label>
        )}
        <label>
          <span>Password</span>
          <input
            className={bad('password')}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={provider === 'icloud' ? 'abcd-efgh-ijkl-mnop' : ''}
          />
        </label>
        {provider === 'imap' && (
          <>
            <label>
              <span>IMAP</span>
              <input
                className={bad('imap.host')}
                value={imapHost}
                onChange={(e) => setImapHost(e.target.value)}
                placeholder="imap.example.com"
                spellCheck={false}
              />
              <input className={`port ${bad('imap.port') ?? ''}`} value={imapPort} onChange={(e) => setImapPort(e.target.value)} />
              {security(imapSecurity, setImapSecurity)}
            </label>
            <label>
              <span>SMTP</span>
              <input
                className={bad('smtp.host')}
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
                placeholder="smtp.example.com"
                spellCheck={false}
              />
              <input className={`port ${bad('smtp.port') ?? ''}`} value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} />
              {security(smtpSecurity, setSmtpSecurity)}
            </label>
            <label className="check">
              <input type="checkbox" checked={savesSent} onChange={(e) => setSavesSent(e.target.checked)} /> The server files sent mail in Sent itself
            </label>
          </>
        )}
        {error && <p className="account-error">{error.message}</p>}
        <footer>
          <button type="button" className="quiet" onClick={onDone} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Checking…' : existing ? 'Sign In' : 'Add Account'}
          </button>
        </footer>
      </form>
    </Panel>
  );
}
