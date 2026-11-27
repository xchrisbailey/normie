import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThreadAction, ThreadMessage, ThreadRow } from '../core/types';
import { AccountBar, EmptyState, useAccounts } from './AccountBar';
import type { CoreClient } from './core-client';
import { DevOverlay } from './DevOverlay';
import { actionItems, type PaletteItem } from './commands/palette';
import { ACTIONS } from './commands/registry';
import { Palette } from './Palette';
import { Reader } from './Reader';
import { SyncBadge } from './SyncBadge';
import { ThreadCache } from './thread-cache';
import { ThreadList } from './ThreadList';
import { useKeys, type Handlers } from './useKeys';

const PREFETCH = 3;

export function App({ corePromise }: { corePromise: Promise<CoreClient> }) {
  const [core, setCore] = useState<CoreClient | null>(null);
  useEffect(() => void corePromise.then(setCore), [corePromise]);
  return <Inbox core={core} />;
}

const SNAPSHOT_ROWS = 60;
const LABEL_ITEM = 'label:';

/** Each Account's Labels, fetched once and again whenever the core says they changed. */
function useLabels(core: CoreClient | null) {
  const [labels, setLabels] = useState(new Map<string, string[]>());
  const accounts = useAccounts();
  useEffect(() => {
    if (!core) return;
    const load = (id: string) => void core.labels(id).then((l) => setLabels((m) => new Map(m).set(id, l)));
    const ids = window.normie.fake ? ['fake-1'] : (accounts ?? []).map((a) => a.id);
    ids.forEach(load);
    return core.onNotice((n) => {
      if (n.type === 'labels-changed') load(n.accountId);
    });
  }, [core, accounts]);
  return labels;
}

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
  /** The open palette: every action, or Labels for the selected Thread. */
  const [palette, setPalette] = useState<null | 'actions' | 'label'>(null);
  const labels = useLabels(core);
  const cache = useMemo(() => (core ? new ThreadCache(core) : null), [core]);
  /**
   * Triage changes the rows in memory first; these overrides stay laid over the core's rows until the core
   * has recorded the action, so a reload in between can't bring a Thread back.
   */
  const overrides = useRef(new Map<string, (r: ThreadRow) => ThreadRow | null>());
  /** Rows to show even when the core's rows don't have them yet: a Thread brought back by undo. */
  const inserts = useRef(new Map<string, ThreadRow>());
  const withOverrides = (r: ThreadRow[]) => {
    if (!overrides.current.size && !inserts.current.size) return r;
    const out = r.flatMap((row) => {
      const f = overrides.current.get(row.key);
      const o = f ? f(row) : row;
      return o ? [o] : [];
    });
    for (const [key, row] of inserts.current) {
      if (out.some((x) => x.key === key)) continue;
      const at = out.findIndex((x) => x.date < row.date);
      out.splice(at < 0 ? out.length : at, 0, row);
    }
    return out;
  };
  /** Recent triage actions, newest last, for z. */
  const undoStack = useRef<{ key: string; prev: ThreadRow; ids: Promise<number[]>; after?: ThreadAction }[]>([]);
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
    if (row.unread) markRead(row);
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
  const triage = (
    action: ThreadAction | ((r: ThreadRow) => ThreadAction),
    change: (r: ThreadRow) => ThreadRow | null,
    /** Run after reverting the server changes on undo, for state kept only locally (mute). */
    undoAfter?: ThreadAction,
  ) => {
    const i = clamp(selected);
    const row = rows[i];
    if (!row || !core) return;
    if (typeof action === 'function') action = action(row);
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
    const ids = core.act(row.key, action);
    undoStack.current.push({ key: row.key, prev: row, ids: ids.catch(() => []), ...(undoAfter ? { after: undoAfter } : {}) });
    if (undoStack.current.length > 50) undoStack.current.shift();
    // Drop the override once the core has the action, unless something newer (an undo) replaced it.
    const settle = (reload: boolean) => {
      if (overrides.current.get(row.key) === change) overrides.current.delete(row.key);
      if (reload) loadRows.current();
    };
    // When nothing changed in the store, no notice will come: reload to drop the override.
    void ids.then((x) => settle(!x.length), () => settle(true));
  };

  /** Opening a Thread marks it read. Not an undoable action: u marks it unread again. */
  function markRead(row: ThreadRow) {
    if (!core) return;
    const change = (r: ThreadRow) => ({ ...r, unread: false });
    overrides.current.set(row.key, change);
    setRows((rs) => rs.map((r) => (r.key === row.key ? change(r) : r)));
    void core.act(row.key, { type: 'read', on: true }).finally(() => {
      if (overrides.current.get(row.key) === change) overrides.current.delete(row.key);
    });
  }

  /** Undo the last triage action: the row comes back as it was in this frame, then the core reverts it. */
  const undo = () => {
    const entry = undoStack.current.pop();
    if (!entry || !core) return;
    const restore = () => entry.prev;
    overrides.current.set(entry.key, restore);
    inserts.current.set(entry.key, entry.prev);
    const next = withOverrides(rows);
    setRows(next);
    const i = next.findIndex((r) => r.key === entry.key);
    if (i >= 0) {
      setSelected(i);
      selectedKey.current = entry.key;
      if (open) openRow(next[i]!, i, next);
    }
    void entry.ids
      .then((ids) => core.undo(ids))
      .then(() => entry.after && core.act(entry.key, entry.after))
      .finally(() => {
        if (overrides.current.get(entry.key) === restore) overrides.current.delete(entry.key);
        if (inserts.current.get(entry.key) === entry.prev) inserts.current.delete(entry.key);
        loadRows.current();
      });
  };

  const context = open ? 'reader' : 'list';
  const handlers: Handlers = {
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
    'thread.delete': () => triage({ type: 'delete' }, () => null),
    'thread.star': () => triage((r) => ({ type: 'star', on: !r.starred }), (r) => ({ ...r, starred: !r.starred })),
    'thread.mute': () => triage({ type: 'mute', on: true }, () => null, { type: 'mute', on: false }),
    'thread.unmute': () => triage({ type: 'mute', on: false }, (r) => r),
    'thread.toggleRead': () => triage((r) => ({ type: 'read', on: r.unread }), (r) => ({ ...r, unread: !r.unread })),
    undo,
    'dev.overlay': () => setOverlay((o) => !o),
    'palette.open': () => setPalette((p) => (p ? null : 'actions')),
    'thread.label': () => {
      if (rows[clamp(selected)]) setPalette('label');
    },
  };
  useKeys(context, handlers);

  /** Run a registry action by id, as the palette and the native menus do. Of several ids, the one that applies here. */
  const latest = useRef({ handlers, context });
  latest.current = { handlers, context };
  const runAction = useCallback((ids: string[]) => {
    const { handlers: h, context: ctx } = latest.current;
    const id = ids.find((x) => ACTIONS.some((a) => a.id === x && (a.contexts as readonly string[]).includes(ctx)) && h[x as keyof Handlers]);
    if (id) void h[id as keyof Handlers]!();
  }, []);
  useEffect(() => window.normie.onMenuAction(runAction), [runAction]);

  /** Labels of the selected Thread's Account. */
  const rowLabels = () => labels.get(rows[clamp(selected)]?.accountId ?? '') ?? [];
  const applyLabel = (label: string) => triage({ type: 'label', label, on: true }, (r) => r);
  const paletteItems = (mode: 'actions' | 'label'): PaletteItem[] => {
    const labelItems = rowLabels().map((l) => ({ id: LABEL_ITEM + l, name: mode === 'label' ? l : `Label: ${l}`, keywords: l }));
    if (mode === 'label') return labelItems;
    return [...actionItems(ACTIONS, context, (id) => id !== 'palette.open' && !!handlers[id as keyof Handlers]), ...(rows.length ? labelItems : [])];
  };

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
      {palette && (
        <Palette
          items={paletteItems(palette)}
          placeholder={palette === 'label' ? 'Apply a Label' : 'Type a command or Label'}
          onClose={() => setPalette(null)}
          onRun={(item) => {
            setPalette(null);
            if (item.id.startsWith(LABEL_ITEM)) applyLabel(item.id.slice(LABEL_ITEM.length));
            else runAction([item.id]);
          }}
        />
      )}
    </main>
  );
}
