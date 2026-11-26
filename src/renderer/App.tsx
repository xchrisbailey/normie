import { useEffect, useRef, useState } from 'react';
import type { ThreadRow } from '../core/types';
import type { CoreClient } from './core-client';

const time = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

export function App({ core }: { core: CoreClient }) {
  const [rows, setRows] = useState<ThreadRow[]>([]);
  const reported = useRef(false);

  useEffect(() => {
    let alive = true;
    const load = () => core.rows('inbox').then((r) => alive && setRows(r));
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
    if (rows.length && !reported.current) {
      reported.current = true;
      requestAnimationFrame(() => window.normie.ready({ rows: rows.length }));
    }
  }, [rows]);

  return (
    <main className="app">
      <header className="split-bar">
        <span className="split active">Inbox</span>
        <span className="count">{rows.length}</span>
      </header>
      <ul className="thread-list">
        {rows.map((r) => (
          <li key={r.key} className={r.unread ? 'row unread' : 'row'}>
            <span className="from">{r.from}</span>
            <span className="subject">
              {r.subject}
              {r.count > 1 && <span className="n">{r.count}</span>}
              <span className="snippet">{r.snippet}</span>
            </span>
            <time className="date">{time.format(r.date)}</time>
          </li>
        ))}
      </ul>
    </main>
  );
}
