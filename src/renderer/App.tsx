import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThreadMessage, ThreadRow } from '../core/types';
import { AccountBar, EmptyState, useAccounts } from './AccountBar';
import type { CoreClient } from './core-client';
import { DevOverlay } from './DevOverlay';
import { Reader } from './Reader';
import { ThreadCache } from './thread-cache';
import { ThreadList } from './ThreadList';
import { useKeys } from './useKeys';

const PREFETCH = 3;

export function App({ core }: { core: CoreClient }) {
  const [rows, setRows] = useState<ThreadRow[]>([]);
  const [selected, setSelected] = useState(0);
  const [open, setOpen] = useState<{ key: string; subject: string; messages?: ThreadMessage[] } | null>(null);
  const selectedKey = useRef<string | undefined>(undefined);
  const reported = useRef(false);
  const accounts = useAccounts();
  const [overlay, setOverlay] = useState(false);
  const cache = useMemo(() => new ThreadCache(core), [core]);

  // Rows for the visible Split live here, in renderer memory. Refreshed when the core says they changed.
  useEffect(() => {
    let alive = true;
    const load = () =>
      core.rows('inbox').then((r) => {
        if (!alive) return;
        setRows(r);
        // Keep the selection on the same Thread when rows above it change.
        const i = selectedKey.current ? r.findIndex((x) => x.key === selectedKey.current) : -1;
        setSelected((s) => (i >= 0 ? i : Math.min(s, Math.max(0, r.length - 1))));
      });
    void load();
    const off = core.onNotice((n) => {
      if (n.type === 'rows-changed' && n.split === 'inbox') void load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [core]);

  // A body that arrives for the open Thread shows up without reopening it.
  useEffect(() => cache.onLoaded((key, messages) => setOpen((o) => (o && o.key === key ? { ...o, messages } : o))), [cache]);

  useEffect(() => {
    selectedKey.current = rows[selected]?.key;
  }, [rows, selected]);

  const empty = !window.normie.fake && accounts !== null && accounts.length === 0 && rows.length === 0;

  // Tell main the first useful screen is up (used by smoke runs and, later, the cold-start budget).
  useEffect(() => {
    if (reported.current || (!rows.length && !empty)) return;
    reported.current = true;
    requestAnimationFrame(() => window.normie.ready({ rows: rows.length, view: rows.length ? 'list' : 'empty' }));
  }, [rows, empty]);

  const clamp = useCallback((i: number) => Math.max(0, Math.min(rows.length - 1, i)), [rows.length]);
  const move = (to: (s: number) => number) => setSelected((s) => clamp(to(s)));

  /** Open the Thread at index i. Instant from the cache; otherwise resolves once its messages are shown. */
  const openAt = (i: number): Promise<unknown> | void => {
    const row = rows[clamp(i)];
    if (!row) return;
    setSelected(clamp(i));
    cache.prefetch(rows.slice(clamp(i) + 1, clamp(i) + 1 + PREFETCH).map((r) => r.key));
    const hit = cache.get(row.key);
    setOpen({ key: row.key, subject: row.subject, messages: hit });
    if (!hit) return cache.load(row.key).then((messages) => setOpen((o) => (o?.key === row.key ? { ...o, messages } : o)));
  };

  // Keep the next Threads warm while moving through the list, too.
  useEffect(() => {
    if (rows.length) cache.prefetch(rows.slice(selected, selected + PREFETCH + 1).map((r) => r.key));
  }, [cache, rows, selected]);

  useKeys(open ? 'reader' : 'list', {
    'list.down': () => move((s) => s + 1),
    'list.up': () => move((s) => s - 1),
    'list.top': () => move(() => 0),
    'list.bottom': () => move(() => rows.length - 1),
    'list.open': () => openAt(selected),
    'reader.next': () => openAt(selected + 1),
    'reader.prev': () => openAt(selected - 1),
    'reader.close': () => setOpen(null),
    'go.inbox': () => {
      setOpen(null);
      move(() => 0);
    },
    'dev.overlay': () => setOverlay((o) => !o),
  });

  return (
    <main className="app">
      <header className="split-bar">
        <span className="split active">Inbox</span>
        <span className="count">{rows.length}</span>
        {accounts && <AccountBar accounts={accounts} />}
      </header>
      {empty ? (
        <EmptyState />
      ) : (
        <div className={open ? 'panes reading' : 'panes'}>
          <ThreadList rows={rows} selected={selected} />
          {open && <Reader subject={open.subject} messages={open.messages} />}
        </div>
      )}
      {overlay && <DevOverlay />}
    </main>
  );
}
