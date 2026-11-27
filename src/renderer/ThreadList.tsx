// The list of Threads: a ui-sdk Listbox over a virtual list. The app's keymap moves the selection; the Listbox gives
// the rows their roles, the pointer's choice and what a screen reader follows.
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type { Range } from '@tanstack/react-virtual';
import { Listbox, ListboxItem, createListboxController } from '@ui-sdk/react/listbox';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { ROW_HEIGHT } from '../core/appearance';
import { hour12Of } from '../core/prefs';
import type { Clock } from '../core/prefs';
import type { ThreadRow } from '../core/types';
import { ActionTip } from './ActionTip';
import { reducedMotion, useAppearance } from './appearance';
import { usePrefs } from './prefs';
import type { ActionRunner } from './ActionTip';
import { DoneIcon, SnoozeIcon } from './icons';

const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const timeFmts = new Map<Clock, Intl.DateTimeFormat>();
function timeFmt(clock: Clock) {
  let f = timeFmts.get(clock);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', hour12: hour12Of(clock) });
    timeFmts.set(clock, f);
  }
  return f;
}

function when(ms: number, clock: Clock) {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? timeFmt(clock).format(d) : dateFmt.format(d);
}

/**
 * The app's keymap moves through the list (and the keys can be remapped), so the Listbox's own arrows, Home, End,
 * Space, Enter and typeahead stand aside. Keys with Cmd, Ctrl or Alt, Tab and Escape pass as they are.
 */
function keysBelongToApp(e: KeyboardEvent) {
  if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key !== 'Tab' && e.key !== 'Escape') {
    e.preventDefault();
  }
}

type RowAction = 'thread.done' | 'thread.snooze';

function Act({ id, label, runner, children }: { id: RowAction; label: string; runner: ActionRunner; children: ReactNode }) {
  return (
    <ActionTip
      id={id}
      label={label}
      runner={runner}
      render={
        <button
          type="button"
          className="act"
          data-act={id}
          aria-label={label}
          tabIndex={-1}
          // The row is already selected: the press is the button's alone.
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            runner.run(id);
          }}
        />
      }
    >
      {children}
    </ActionTip>
  );
}

const RowFace = memo(function RowFace({ row, marker, actions, clock }: { row: ThreadRow; marker?: string; actions?: ActionRunner; clock: Clock }) {
  return (
    <>
      <span className="from">
        {marker && <span className="acct" style={{ background: marker }} role="img" aria-label="Account" />}
        {row.starred && (
          <span className="star" aria-label="Starred">
            ★
          </span>
        )}
        {row.from}
      </span>
      <span className="subject">
        {row.subject}
        {row.count > 1 && <span className="n">{row.count}</span>}
        <span className="snippet">{row.snippet}</span>
      </span>
      {actions ? (
        <span className="acts">
          <Act id="thread.done" label="Done" runner={actions}>
            <DoneIcon />
          </Act>
          <Act id="thread.snooze" label="Snooze" runner={actions}>
            <SnoozeIcon />
          </Act>
        </span>
      ) : row.tags?.reminder ? (
        <time className="date reminder" title="Back because nobody replied">
          No reply
        </time>
      ) : row.tags?.snoozedUntil !== undefined ? (
        <time className="date snoozed" title="Snoozed until">
          ⏰ {when(row.tags.snoozedUntil, clock)}
        </time>
      ) : (
        <time className="date">{when(row.date, clock)}</time>
      )}
    </>
  );
});

/** Memoized: opening the palette or an overlay shouldn't re-render the list. */
export const ThreadList = memo(function ThreadList({
  rows,
  selected,
  markers,
  view,
  onSelect,
  onOpen,
  actions,
}: {
  rows: Array<ThreadRow>;
  selected: number;
  /** A color per Account, when there's more than one. */
  markers?: Map<string, string>;
  /** Which list this is (the open Split, or a search). A new one rises into place. */
  view: string;
  /** A row was chosen with the pointer. */
  onSelect: (key: string) => void;
  /** A row was double-clicked. */
  onOpen: (key: string) => void;
  /** Runs the selected row's buttons. */
  actions: ActionRunner;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  // The selected row stays rendered even when scrolled away, so the list always has its active option.
  const keep = useRef(selected);
  useLayoutEffect(() => {
    keep.current = selected;
  });
  const rangeExtractor = useCallback((range: Range) => {
    const indexes = defaultRangeExtractor(range);
    const s = keep.current;
    return s < range.count && !indexes.includes(s) ? [...indexes, s].sort((a, b) => a - b) : indexes;
  }, []);
  const rowHeight = ROW_HEIGHT[useAppearance().density];
  const { clock } = usePrefs();
  // oxlint-disable-next-line react/incompatible-library -- no React Compiler here: the list is memoized by hand and redraws when its props change
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => rowHeight, overscan: 12, rangeExtractor });
  useLayoutEffect(() => v.measure(), [v, rowHeight]);

  const value = rows[selected]?.key ?? null;
  // Keys move the selection through the app's keymap, so the highlight a screen reader follows is moved to match.
  const [list] = useState(() => createListboxController());
  useEffect(() => {
    if (rows.length) {
      v.scrollToIndex(selected, { align: 'auto' });
    }
    list.highlight(value);
  }, [selected, rows.length, v, list, value]);

  // A new Split rises into place. Transform and opacity only, on the compositor: the list's first frame costs the same.
  const shownView = useRef(view);
  useLayoutEffect(() => {
    const el = scroller.current?.firstElementChild;
    if (shownView.current === view || !el || reducedMotion()) {
      shownView.current = view;
      return;
    }
    shownView.current = view;
    el.animate(
      [
        { transform: 'translateY(24px)', opacity: 0 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
  }, [view]);

  return (
    <Listbox
      ref={scroller}
      className="thread-list"
      aria-label="Threads"
      virtualFocus
      keepInView={false}
      controller={list}
      value={value}
      onValueChange={(key, details) => {
        if (key === null) {
          return details.cancel();
        }
        onSelect(key);
      }}
      onKeyDown={keysBelongToApp}
    >
      <div className="rows" style={{ height: v.getTotalSize() }}>
        {v.getVirtualItems().map((item) => {
          const row = rows[item.index];
          return row ? (
            <ListboxItem
              key={row.key}
              value={row.key}
              index={item.index}
              // The Listbox only sees the rows on screen; this is where they sit in the whole list.
              render={<div aria-setsize={rows.length} />}
              label=""
              className={row.unread ? 'row unread' : 'row'}
              style={{ top: item.start }}
              data-key={row.key}
              onDoubleClick={() => onOpen(row.key)}
            >
              <RowFace row={row} marker={markers?.get(row.accountId)} actions={item.index === selected ? actions : undefined} clock={clock} />
            </ListboxItem>
          ) : null;
        })}
      </div>
    </Listbox>
  );
});
