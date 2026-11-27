// The one header row: Split tabs on the left (those that don't fit go into More), plain icons on the right.
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@ui-sdk/react/hover-card';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@ui-sdk/react/menu';
import { Tabs, TabsIndicator, TabsList, TabsTab, TabsTabIcon } from '@ui-sdk/react/tabs';
import { Toolbar, ToolbarButton } from '@ui-sdk/react/toolbar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@ui-sdk/react/tooltip';
import { memo, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { ActionDef } from './commands/keys';
import { keyLabel } from './commands/palette';
import { ComposeIcon, MailIcon, MoreIcon, SearchIcon, splitIcon } from './icons';
import type { SplitSummary } from './splits';
import { splitTabs, tabsThatFit } from './tab-fit';

/** Matches the tab list's CSS gap. */
const TAB_GAP = 2;

interface SplitTab {
  id: string;
  name: string;
}

interface HeaderProps {
  splits: ReadonlyArray<SplitTab>;
  openId: string;
  /** The open Split's count, as the list shows it (triage lands there first). */
  openCount: number;
  summaries: ReadonlyMap<string, SplitSummary>;
  onOpenSplit: (id: string) => void;
  /** Shown instead of the tabs while searching. */
  search: ReactNode;
  /** The sync mark beside the icons. */
  sync: ReactNode;
  actions: ReadonlyArray<ActionDef>;
  onInbox: () => void;
  onSearch: () => void;
  onCompose: () => void;
}

export function Header(props: HeaderProps) {
  const keyOf = (id: string) => props.actions.find((a) => a.id === id)?.keys[0];
  return (
    <header className="top">
      <div className="top-row">
        {props.search ?? <SplitTabs {...props} />}
        <div className="tools">
          {props.sync}
          <Toolbar aria-label="App" className="toolbar">
            <Tool label="Inbox" keys={keyOf('go.inbox')} onPress={props.onInbox}>
              <MailIcon />
            </Tool>
            <Tool label="Search" keys={keyOf('search.open')} onPress={props.onSearch}>
              <SearchIcon />
            </Tool>
            <Tool label="Compose" keys={keyOf('compose.new')} onPress={props.onCompose}>
              <ComposeIcon />
            </Tool>
          </Toolbar>
        </div>
      </div>
    </header>
  );
}

function Tool({ label, keys, onPress, children }: { label: string; keys: string | undefined; onPress: () => void; children: ReactNode }) {
  return (
    <Tooltip delay={400}>
      <TooltipTrigger render={<ToolbarButton className="tool" aria-label={label} onClick={onPress} />}>{children}</TooltipTrigger>
      <TooltipContent className="tip" side="bottom" sideOffset={6}>
        {label}
        {keys && <kbd>{keyLabel(keys)}</kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

function SplitTabs({ splits, openId, openCount, summaries, onOpenSplit }: HeaderProps) {
  const room = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(splits.length);
  useLayoutEffect(() => {
    const r = room.current;
    const m = measure.current;
    if (!r || !m) {
      return;
    }
    const update = () => {
      const widths = [...m.children].map((c) => c.getBoundingClientRect().width);
      const more = widths.pop() ?? 0;
      setFit(tabsThatFit(widths, r.clientWidth, more, TAB_GAP));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(r);
    observer.observe(m);
    return () => observer.disconnect();
  }, []);

  const { shown, more } = splitTabs(splits, fit, openId);
  const face = (s: SplitTab) => {
    const sum = summaries.get(s.id);
    return { count: s.id === openId ? openCount : (sum?.count ?? 0), unread: sum?.unread ?? false, newest: sum?.newest ?? [] };
  };
  return (
    <div className="split-room" ref={room}>
      <Tabs
        value={openId}
        onValueChange={(v, details) => {
          // Moving a tab into More takes it out of the list: that isn't a choice to open another.
          if (v === null || details.reason === 'item-removed') {
            return details.cancel();
          }
          onOpenSplit(v);
        }}
      >
        <TabsList className="splits" aria-label="Splits">
          {shown.map((s) => {
            const f = face(s);
            return (
              <HoverCard key={s.id} delay={500} closeDelay={80} disabled={s.id === openId || f.newest.length === 0}>
                <TabsTab
                  value={s.id}
                  className="split"
                  data-look={splitIcon(s.id).look}
                  render={<HoverCardTrigger href={`#split-${encodeURIComponent(s.id)}`} />}
                >
                  <TabsTabIcon className="split-icon">{splitIcon(s.id).icon}</TabsTabIcon>
                  <TabFace name={s.name} count={f.count} unread={f.unread} />
                </TabsTab>
                <HoverCardContent className="peek" side="bottom" align="start" sideOffset={8}>
                  {f.newest.map((r) => (
                    <div key={r.key} className="peek-card">
                      <b>{r.from}</b>
                      <span>{r.subject}</span>
                    </div>
                  ))}
                </HoverCardContent>
              </HoverCard>
            );
          })}
          <TabsIndicator className="split-ink" />
        </TabsList>
      </Tabs>
      {more.length > 0 && (
        <Menu onAction={onOpenSplit}>
          <MenuTrigger className="split more" aria-label="More Splits">
            <MoreIcon />
            {more.some((s) => face(s).unread) && <span className="unread-dot" role="img" aria-label="unread" />}
          </MenuTrigger>
          <MenuContent className="menu" side="bottom" align="start" sideOffset={6}>
            {more.map((s) => {
              const f = face(s);
              return (
                <MenuItem key={s.id} value={s.id} className="menu-item split-item" data-look={splitIcon(s.id).look}>
                  <span className="split-icon">{splitIcon(s.id).icon}</span>
                  <TabFace name={s.name} count={f.count} unread={f.unread} />
                </MenuItem>
              );
            })}
          </MenuContent>
        </Menu>
      )}
      <MeasureRow splits={splits} summaries={summaries} measure={measure} />
    </div>
  );
}

/** Every tab at its natural width, out of sight, for the fit. Counts come from the summaries, so opening a Split doesn't redo it. */
const MeasureRow = memo(function MeasureRow({
  splits,
  summaries,
  measure,
}: {
  splits: ReadonlyArray<SplitTab>;
  summaries: ReadonlyMap<string, SplitSummary>;
  measure: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="split-measure-row" ref={measure} aria-hidden="true" inert>
      {splits.map((s) => (
        <span key={s.id} className="split-measure">
          <span className="split-icon">{splitIcon(s.id).icon}</span>
          <TabFace name={s.name} count={summaries.get(s.id)?.count ?? 0} unread={summaries.get(s.id)?.unread ?? false} />
        </span>
      ))}
      <span className="split-measure more">
        <MoreIcon />
      </span>
    </div>
  );
});

function TabFace({ name, count, unread }: { name: string; count: number; unread: boolean }) {
  return (
    <>
      <span className="split-name">{name}</span>
      <span className="count">{count || ''}</span>
      {unread && <span className="unread-dot" role="img" aria-label="unread" />}
    </>
  );
}
