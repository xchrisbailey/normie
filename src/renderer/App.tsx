import { useCallback, useEffect, useRef, useState } from 'react';
import type { ThreadRow } from '../core/types';
import type { CoreClient } from './core-client';
import { ThreadList } from './ThreadList';
import { useKeys } from './useKeys';

export function App({ core }: { core: CoreClient }) {
  const [rows, setRows] = useState<ThreadRow[]>([]);
  const [selected, setSelected] = useState(0);
  const selectedKey = useRef<string | undefined>(undefined);
  const reported = useRef(false);

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

  useEffect(() => {
    selectedKey.current = rows[selected]?.key;
  }, [rows, selected]);

  useEffect(() => {
    if (rows.length && !reported.current) {
      reported.current = true;
      requestAnimationFrame(() => window.normie.ready({ rows: rows.length }));
    }
  }, [rows]);

  const move = useCallback(
    (to: (s: number) => number) => setSelected((s) => Math.max(0, Math.min(rows.length - 1, to(s)))),
    [rows.length],
  );

  useKeys('list', {
    'list.down': () => move((s) => s + 1),
    'list.up': () => move((s) => s - 1),
    'list.top': () => move(() => 0),
    'list.bottom': () => move(() => rows.length - 1),
    'go.inbox': () => move(() => 0),
  });

  return (
    <main className="app">
      <header className="split-bar">
        <span className="split active">Inbox</span>
        <span className="count">{rows.length}</span>
      </header>
      <ThreadList rows={rows} selected={selected} />
    </main>
  );
}
