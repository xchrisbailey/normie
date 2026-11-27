import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThreadAction, ThreadMessage, ThreadRow } from '../core/types';
import { AccountBar, EmptyState, useAccounts } from './AccountBar';
import type { CoreClient } from './core-client';
import { DevOverlay } from './DevOverlay';
import { Reader } from './Reader';
import { SyncBadge } from './SyncBadge';
import { ThreadCache } from './thread-cache';
import { ThreadList } from './ThreadList';
import { useKeys } from './useKeys';

const PREFETCH = 3;

export function App({ corePromise }: { corePromise: Promise<CoreClient> }) {
  const [core, setCore] = useState<CoreClient | null>(null);
  useEffect(() => void corePromise.then(setCore), [corePromise]);
  return <Inbox core={core} />;
}

const SNAPSHOT_ROWS = 60;

function Inbox({ core }: { core: CoreClient | null }) {
  // The first frame draws the last Split from the snapshot; the core's rows replace it as soon as they arrive.
  const [rows, setRows] = useState<ThreadRow[]>(() => window.normie.snapshot() ?? []);
  const fromSnapshot = useRef(true);
  const [coreAnswered, setCoreAnswered] = useState(false);
  const painted = useRef(false);
  const [selected, setSelected] = useState(0);
  const [open, setOpen] = useState<{ key: string; subject: string; messages?: ThreadMessage[] } | null>(null);
  const selectedKey = useRef<string | undefined>(undefined);
  const reported = useRef(false);
  const accounts = useAccounts();
  const [overlay, setOverlay] = useState(false);
  const cache = useMemo(() => (core ? new ThreadCache(core) : null), [core]);
  /**
   * Triage changes the rows in memory first; these overrides stay laid over the core's rows until the core
   * has recorded the action, so a reload in between can't bring a Thread back.
   */
  const overrides = useRef(new Map<string, (r: ThreadRow) => ThreadRow | null>());
  const withOverrides = (r: ThreadRow[]) => {
    if (!overrides.current.size) return r;
    return r.flatMap((row) => {
      const f = overrides.current.get(row.key);
      const out = f ? f(row) : row;
      return out ? [out] : [];
    });
  };
  const loadRows = useRef<() => void>(() => {});

  // Rows for the visible Split live here, in renderer memory. Refreshed when the core says they changed.
  useEffect(() => {
    if (!core) return;
    let alive = true;
    const load = () =>
      core.rows('inbox').then((r) => {
        if (!alive) return;
        fromSnapshot.current = false;
        setCoreAnswered(true);
        r = withOverrides(r);
        setRows(r);
        // Keep the selection on the same Thread when rows above it change.
        const i = selectedKey.current ? r.findIndex((x) => x.key === selectedKey.current) : -1;
        setSelected((s) => (i >= 0 ? i : Math.min(s, Math.max(0, r.length - 1))));
      });
    loadRows.current = () => void load();
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
  useEffect(() => cache?.onLoaded((key, messages) => setOpen((o) => (o && o.key === key ? { ...o, messages } : o))), [cache]);

  // Keep the snapshot fresh for the next launch.
  useEffect(() => {
    if (fromSnapshot.current) return;
    const t = setTimeout(() => window.normie.saveSnapshot(rows.slice(0, SNAPSHOT_ROWS)), 1000);
    return () => clearTimeout(t);
  }, [rows]);

  useEffect(() => {
    selectedKey.current = rows[selected]?.key;
  }, [rows, selected]);

  const empty = !window.normie.fake && core !== null && accounts !== null && accounts.length === 0 && rows.length === 0;

  // The first useful frame: snapshot rows, or whatever the core first answered. Main shows the window and starts sync.
  useEffect(() => {
    if (painted.current || (!rows.length && !coreAnswered)) return;
    painted.current = true;
    const info = { rows: rows.length, fromSnapshot: fromSnapshot.current };
    requestAnimationFrame(() => window.normie.firstPaint(info));
  }, [rows, coreAnswered]);

  // Tell main the first useful screen is up (used by smoke runs and, later, the cold-start budget).
  useEffect(() => {
    if (reported.current || (!rows.length && !empty)) return;
    reported.current = true;
    const info = { rows: rows.length, view: rows.length ? ('list' as const) : ('empty' as const), fromSnapshot: false };
    requestAnimationFrame(() => window.normie.ready(info));
  }, [rows, empty]);

  const clamp = useCallback((i: number) => Math.max(0, Math.min(rows.length - 1, i)), [rows.length]);
  const move = (to: (s: number) => number) => setSelected((s) => clamp(to(s)));

  /** Open the Thread at index i. Instant from the cache; otherwise resolves once its messages are shown. */
  const openAt = (i: number): Promise<unknown> | void => {
    const row = rows[clamp(i)];
    if (!row) return;
    return openRow(row, clamp(i), rows);
  };

  function openRow(row: ThreadRow, i: number, list: ThreadRow[]): Promise<unknown> | void {
    if (!cache) return;
    setSelected(i);
    cache.prefetch(list.slice(i + 1, i + 1 + PREFETCH).map((r) => r.key));
    const hit = cache.get(row.key);
    setOpen({ key: row.key, subject: row.subject, messages: hit });
    if (!hit) return cache.load(row.key).then((messages) => setOpen((o) => (o?.key === row.key ? { ...o, messages } : o)));
  }

  // Keep the next Threads warm while moving through the list, too.
  useEffect(() => {
    if (rows.length && cache) cache.prefetch(rows.slice(selected, selected + PREFETCH + 1).map((r) => r.key));
  }, [cache, rows, selected]);

  /**
   * A triage action on the selected Thread: the row changes in this frame, then the core records it.
   * When the change removes the row, the selection stays put and lands on the next Thread (opened, in the reader).
   */
  const triage = (action: ThreadAction, change: (r: ThreadRow) => ThreadRow | null) => {
    const i = clamp(selected);
    const row = rows[i];
    if (!row || !core) return;
    overrides.current.set(row.key, change);
    const next = withOverrides(rows);
    setRows(next);
    const removed = next.length < rows.length;
    if (removed) {
      const to = Math.min(i, next.length - 1);
      setSelected(Math.max(0, to));
      selectedKey.current = next[to]?.key;
      if (open) {
        if (next[to]) openRow(next[to]!, to, next);
        else setOpen(null);
      }
    }
    void core.act(row.key, action).then(
      (ids) => {
        overrides.current.delete(row.key);
        // Nothing changed in the store, so no notice will come: reload to drop the override.
        if (!ids.length) loadRows.current();
      },
      () => {
        overrides.current.delete(row.key);
        loadRows.current();
      },
    );
  };

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
    'thread.done': () => triage({ type: 'done' }, () => null),
    'dev.overlay': () => setOverlay((o) => !o),
  });

  return (
    <main className="app">
      <header className="split-bar">
        <span className="split active">Inbox</span>
        <span className="count">{rows.length}</span>
        <SyncBadge core={core} />
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
