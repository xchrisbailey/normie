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

const Row = memo(function Row({ row, selected, top }: { row: ThreadRow; selected: boolean; top: number }) {
  return (
    <div
      className={`row${row.unread ? ' unread' : ''}${selected ? ' selected' : ''}`}
      style={{ top }}
      role="option"
      aria-selected={selected}
    >
      <span className="from">
        {row.starred && <span className="star" aria-label="Starred">★</span>}
        {row.from}
      </span>
      <span className="subject">
        {row.subject}
        {row.count > 1 && <span className="n">{row.count}</span>}
        <span className="snippet">{row.snippet}</span>
      </span>
      <time className="date">{when(row.date)}</time>
    </div>
  );
});

export function ThreadList({ rows, selected }: { rows: ThreadRow[]; selected: number }) {
  const scroller = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_HEIGHT, overscan: 12 });

  useEffect(() => {
    if (rows.length) v.scrollToIndex(selected, { align: 'auto' });
  }, [selected, rows.length, v]);

  return (
    <div ref={scroller} className="thread-list" role="listbox" aria-label="Threads">
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((item) => (
          <Row key={rows[item.index]!.key} row={rows[item.index]!} selected={item.index === selected} top={item.start} />
        ))}
      </div>
    </div>
  );
}
