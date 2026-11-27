import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useEffect, useRef } from 'react';
import type { ThreadRow } from '../core/types';

const ROW_HEIGHT = 36;
const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function when(ms: number) {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? timeFmt.format(d) : dateFmt.format(d);
}

const Row = memo(function Row({ row, selected, top, marker }: { row: ThreadRow; selected: boolean; top: number; marker?: string }) {
  return (
    <div
      className={`row${row.unread ? ' unread' : ''}${selected ? ' selected' : ''}`}
      style={{ top }}
      role="option"
      aria-selected={selected}
      data-key={row.key}
    >
      <span className="from">
        {marker && <span className="acct" style={{ background: marker }} />}
        {row.starred && <span className="star" aria-label="Starred">★</span>}
        {row.from}
      </span>
      <span className="subject">
        {row.subject}
        {row.count > 1 && <span className="n">{row.count}</span>}
        <span className="snippet">{row.snippet}</span>
      </span>
      {row.tags?.reminder ? <time className="date reminder" title="Back because nobody replied">No reply</time> : row.tags?.snoozedUntil !== undefined
        ? <time className="date snoozed" title="Snoozed until">⏰ {when(row.tags.snoozedUntil)}</time>
        : <time className="date">{when(row.date)}</time>}
    </div>
  );
});

/** Memoized: opening the palette or an overlay shouldn't re-render the list. */
export const ThreadList = memo(function ThreadList({ rows, selected, markers }: {
  rows: Array<ThreadRow>;
  selected: number;
  /** A color per Account, when there's more than one. */
  markers?: Map<string, string>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_HEIGHT, overscan: 12 });

  useEffect(() => {
    if (rows.length) {v.scrollToIndex(selected, { align: 'auto' });}
  }, [selected, rows.length, v]);

  return (
    <div ref={scroller} className="thread-list" role="listbox" aria-label="Threads">
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((item) => {
          const row = rows[item.index];
          return row ? <Row key={row.key} row={row} selected={item.index === selected} top={item.start} marker={markers?.get(row.accountId)} /> : null;
        })}
      </div>
    </div>
  );
});
