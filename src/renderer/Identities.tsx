// Editing an Account's Identities: the From names and addresses it sends as. The first is the default.
import { useState } from 'react';

type Row = { name: string; address: string };

export function IdentitiesEditor({ account, onDone }: { account: AccountRecord; onDone: () => void }) {
  const start = account.identities?.length ? account.identities : [{ address: account.email }];
  const [rows, setRows] = useState<Row[]>(start.map((i) => ({ name: i.name ?? '', address: i.address })));
  const [error, setError] = useState<string | null>(null);
  const update = (i: number, patch: Partial<Row>) => setRows((r) => r.map((x, n) => (n === i ? { ...x, ...patch } : x)));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await window.normie.accounts.setIdentities(account.id, rows.filter((x) => x.address.trim()).map((x) => (x.name.trim() ? x : { address: x.address })));
    if (r.ok) onDone();
    else setError(r.error);
  };

  return (
    <div className="palette-backdrop" onMouseDown={onDone}>
      <form className="sheet" onSubmit={(e) => void save(e)} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onDone()}>
        <h2>Identities for {account.email}</h2>
        <p className="help">The names and addresses this Account sends from. A reply goes out from the one the message was sent to; new mail uses the default. The server must allow sending as each address (an iCloud custom domain, a Gmail “Send mail as” address).</p>
        {rows.map((r, i) => (
          <label key={i}>
            <input type="radio" name="default" checked={i === 0} onChange={() => setRows((all) => [all[i]!, ...all.filter((_, n) => n !== i)])} title="Default" />
            <input value={r.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="Name" />
            <input value={r.address} onChange={(e) => update(i, { address: e.target.value })} placeholder="address@example.com" spellCheck={false} />
            <button type="button" className="quiet" onClick={() => setRows((all) => all.filter((_, n) => n !== i))} disabled={rows.length === 1} aria-label="Remove">×</button>
          </label>
        ))}
        <button type="button" className="quiet add-row" onClick={() => setRows((r) => [...r, { name: r[0]?.name ?? '', address: '' }])}>+ Add Identity</button>
        {error && <p className="account-error">{error}</p>}
        <footer>
          <button type="button" className="quiet" onClick={onDone}>Cancel</button>
          <button type="submit" className="primary">Save</button>
        </footer>
      </form>
    </div>
  );
}
