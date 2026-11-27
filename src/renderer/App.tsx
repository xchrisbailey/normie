import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DraftSummary, LabelSet, OutgoingMessage, ScheduledSummary, ThreadAction, ThreadMessage, ThreadRow } from '../core/types';
import type { ComposerHandle, ComposeStart, Identity } from './Composer';
import { planReply, type ReplyKind } from '../core/reply';
import { AccountBar, EmptyState, useAccounts } from './AccountBar';
import type { CoreClient } from './core-client';
import { DevOverlay } from './DevOverlay';
import { actionItems, type PaletteItem } from './commands/palette';
import { ACTIONS } from './commands/registry';
import { Palette } from './Palette';
import type { FrameHandle } from './MailFrame';
import { blockedMessages, Reader } from './Reader';
import { SyncBadge } from './SyncBadge';
import { ThreadCache } from './thread-cache';
import { toNotify } from './notify';
import { KeyHelp } from './KeyHelp';
import { applyTheme, currentTheme, type Theme } from './theme';
import { WhenPicker } from './WhenPicker';
import { describeWhen } from '../core/when';
import { splitCounts, splitsFrom } from './splits';
import { ThreadList } from './ThreadList';
import { useKeymap, useKeys, useSnippets, useSplitsFile, type Handlers } from './useKeys';

const PREFETCH = 3;

export function App({ corePromise }: { corePromise: Promise<CoreClient> }) {
  const [core, setCore] = useState<CoreClient | null>(null);
  useEffect(() => void corePromise.then(setCore), [corePromise]);
  return <Inbox core={core} />;
}

const SNAPSHOT_ROWS = 60;
/** Loaded on first use, so the composer costs nothing at launch. */
const Composer = lazy(() => import('./Composer'));
/** Each composer start gets its own key, so opening a draft while composing starts fresh. */
const composeKeys = new WeakMap<object, number>();
let nextComposeKey = 0;
const composeKey = (s: object) => composeKeys.get(s) ?? (composeKeys.set(s, ++nextComposeKey), nextComposeKey);

/** How long Cmd-Z can take a sent message back (the Outbox waits 5 s; a little slack for the round trip). */
const UNDO_SEND_WINDOW_MS = 4500;
const LABEL_ITEM = 'label:';
const DRAFT_ITEM = 'draft:';
/** One color per Account, for the marker on each row. */
const ACCOUNT_COLORS = ['blue', 'green', 'peach', 'pink', 'teal', 'yellow', 'mauve', 'maroon', 'sapphire'].map((c) => `var(--${c})`);
const SNIPPET_ITEM = 'snippet:';
const SCHEDULED_ITEM = 'scheduled:';

/** Each Account's Labels, fetched once and again whenever the core says they changed. */
function useLabels(core: CoreClient | null) {
  const [labels, setLabels] = useState(new Map<string, LabelSet>());
  const accounts = useAccounts();
  useEffect(() => {
    if (!core) return;
    const load = (id: string) => void core.labels(id).then((l) => setLabels((m) => new Map(m).set(id, l)));
    const ids = window.normie.fake ? ['fake:me@example.com'] : (accounts ?? []).map((a) => a.id);
    ids.forEach(load);
    return core.onNotice((n) => {
      if (n.type === 'labels-changed') load(n.accountId);
    });
  }, [core, accounts]);
  return labels;
}

function Inbox({ core }: { core: CoreClient | null }) {
  // The first frame draws the last Split from the snapshot; the core's rows replace it as soon as they arrive.
  // Every Account's Inbox Threads, interleaved by date (the Unified Inbox)…
  const [allRows, setAllRows] = useState<ThreadRow[]>(() => window.normie.snapshot() ?? []);
  const accounts = useAccounts();
  /** Accounts in order, for the per-Account Splits, 1–9 and the row markers: the Account list, else those in the rows. */
  const accountOrder = useMemo(
    () => (accounts?.length ? accounts.map((a) => a.id) : [...new Set(allRows.map((r) => r.accountId))].sort()),
    [accounts, allRows],
  );
  const accountName = useCallback((id: string) => accounts?.find((a) => a.id === id)?.email ?? id, [accounts]);
  // …split into tabs by local rules; the rows shown are the open Split's (Tab and Shift-Tab, 1–9 for an Account).
  const splitsFile = useSplitsFile();
  const { splits, problems: splitProblems } = useMemo(() => {
    const parsed = splitsFrom(splitsFile.file, accountOrder.map((id) => ({ id, name: accountName(id) })));
    const problems = splitsFile.error ? [splitsFile.error] : parsed.problems;
    for (const p of problems) console.warn(`[splits] ${p}`);
    return { splits: parsed.splits, problems };
  }, [splitsFile, accountOrder, accountName]);
  const [splitId, setSplitId] = useState('inbox');
  const split = splits.find((s) => s.id === splitId) ?? splits[0]!;
  const filterOf = useCallback((list: ThreadRow[]) => list.filter(split.match), [split]);
  const withOverridesRef = useRef<(r: ThreadRow[]) => ThreadRow[]>((r) => r);
  /** Search: the query and its results; while it's open, the list shows the results instead of a Split. */
  const [search, setSearch] = useState<{ query: string; results: ThreadRow[]; server?: 'searching' | 'done' } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchRef = useRef(search);
  searchRef.current = search;
  // Overrides (triage) lay over search results too; recomputed whenever the rows change.
  const rows = useMemo(() => (search ? withOverridesRef.current(search.results) : filterOf(allRows)), [allRows, filterOf, search]);
  const counts = useMemo(() => splitCounts(splits, allRows), [splits, allRows]);
  // The menu bar shows the Inbox count.
  useEffect(() => window.normie.setInboxCount(counts.get('inbox') ?? 0), [counts]);
  const fromSnapshot = useRef(true);
  const [coreAnswered, setCoreAnswered] = useState(false);
  const painted = useRef(false);
  const [selected, setSelected] = useState(0);
  const [open, setOpen] = useState<{ key: string; subject: string; messages?: ThreadMessage[] } | null>(null);
  const selectedKey = useRef<string | undefined>(undefined);
  const reported = useRef(false);
  const [overlay, setOverlay] = useState(false);
  const [keyHelp, setKeyHelp] = useState(false);
  const [theme, setThemeState] = useState<Theme>(currentTheme);
  const setTheme = (t: Theme) => {
    applyTheme(t);
    setThemeState(t);
    setNote(t === 'system' ? 'Theme follows the system' : `Theme: ${t === 'latte' ? 'Latte' : 'Mocha'}`);
  };
  /** The open palette: every action, or Labels for the selected Thread. */
  const [palette, setPalette] = useState<null | 'actions' | 'label'>(null);
  /** The time picker, and what it's for. */
  const [picker, setPicker] = useState<null | 'snooze'>(null);
  /** Drafts, fetched when the palette opens. */
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  /** Messages scheduled with Send Later, fetched when the palette opens. */
  const [scheduled, setScheduled] = useState<ScheduledSummary[]>([]);
  /** A short message in the top bar, gone after a few seconds. */
  const [note, setNoteState] = useState<string | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const setNote = useCallback((text: string) => {
    setNoteState(text);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNoteState(null), 8000);
  }, []);
  /** Messages whose remote images the user loaded this session. */
  const [imagesAllowed, setImagesAllowed] = useState<ReadonlySet<number>>(new Set());
  const frame = useRef<FrameHandle | null>(null);
  /** The open composer and what it started with. */
  const [compose, setCompose] = useState<ComposeStart | null>(null);
  const composer = useRef<ComposerHandle | null>(null);
  const { snippets, problems: snippetProblems } = useSnippets();
  const lastSent = useRef<{ id: number; at: number } | null>(null);
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
  withOverridesRef.current = withOverrides;
  /** Recent triage actions, newest last, for z. */
  const undoStack = useRef<{ key: string; prev: ThreadRow; ids: Promise<number[]>; after?: ThreadAction }[]>([]);
  const loadRows = useRef<() => void>(() => {});
  const filterRef = useRef<(r: ThreadRow[]) => ThreadRow[]>((r) => r);
  filterRef.current = filterOf;

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
        setAllRows(r);
        // Keep the selection on the same Thread when rows above it change.
        const shown = filterRef.current(r);
        const i = selectedKey.current ? shown.findIndex((x) => x.key === selectedKey.current) : -1;
        setSelected((s) => (i >= 0 ? i : Math.min(s, Math.max(0, shown.length - 1))));
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
    const t = setTimeout(() => window.normie.saveSnapshot(allRows.slice(0, SNAPSHOT_ROWS)), 1000);
    return () => clearTimeout(t);
  }, [allRows]);

  useEffect(() => {
    selectedKey.current = rows[selected]?.key;
  }, [rows, selected]);

  const empty = !window.normie.fake && core !== null && accounts !== null && accounts.length === 0 && allRows.length === 0;

  // The first useful frame: snapshot rows, or whatever the core first answered. Main shows the window and starts sync.
  useEffect(() => {
    if (painted.current || (!allRows.length && !coreAnswered)) return;
    painted.current = true;
    const info = { rows: allRows.length, fromSnapshot: fromSnapshot.current };
    requestAnimationFrame(() => window.normie.firstPaint(info));
  }, [allRows, coreAnswered]);

  // Tell main the first useful screen is up (used by smoke runs and, later, the cold-start budget).
  useEffect(() => {
    if (reported.current || (!allRows.length && !empty)) return;
    reported.current = true;
    const info = { rows: allRows.length, view: allRows.length ? ('list' as const) : ('empty' as const), fromSnapshot: false };
    requestAnimationFrame(() => window.normie.ready(info));
  }, [allRows, empty]);

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
    const nextAll = withOverrides(allRows);
    setAllRows(nextAll);
    const next = searchRef.current ? withOverrides(searchRef.current.results) : filterOf(nextAll);
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
    setAllRows((rs) => rs.map((r) => (r.key === row.key ? change(r) : r)));
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
    const nextAll = withOverrides(allRows);
    setAllRows(nextAll);
    const next = searchRef.current ? withOverrides(searchRef.current.results) : filterOf(nextAll);
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

  const context = compose ? 'composer' : open ? 'reader' : 'list';

  const markers = useMemo(
    () => (accountOrder.length > 1 ? new Map(accountOrder.map((id, i) => [id, ACCOUNT_COLORS[i % ACCOUNT_COLORS.length]!])) : undefined),
    [accountOrder],
  );
  /** Open a Split: the list starts at its top. */
  const openSplit = (id: string) => {
    if (!splits.some((s) => s.id === id)) return;
    setSplitId(id);
    setSelected(0);
    selectedKey.current = undefined;
    setOpen(null);
  };
  const stepSplit = (d: 1 | -1) => openSplit(splits[(splits.indexOf(split) + d + splits.length) % splits.length]!.id);
  /** 1–9: one Account's Split (or, with one Account, the whole Inbox). 0: the whole Inbox. */
  const filterAccount = (n: number) => {
    if (n === 0 || accountOrder.length < 2) return openSplit('inbox');
    const id = accountOrder[n - 1];
    if (id) openSplit(`account:${id}`);
  };
  /** Add the selected Thread's sender to the VIP list, or take them off. */
  const setVip = (on: boolean) => {
    const sender = rows[clamp(selected)]?.tags?.sender;
    if (!sender || !core) return;
    void core.setVip(sender, on).then(() => setNote(on ? `${sender} is a VIP` : `${sender} is no longer a VIP`));
  };
  const handlers: Handlers = {
    'list.down': () => move((s) => s + 1),
    'list.up': () => move((s) => s - 1),
    'list.top': () => move(() => 0),
    'list.bottom': () => move(() => rows.length - 1),
    'list.open': () => openAt(selected),
    'reader.next': () => openAt(selected + 1),
    'reader.prev': () => openAt(selected - 1),
    'reader.close': () => setOpen(null),
    'reader.pageDown': () => frame.current?.scrollPage(1),
    'reader.pageUp': () => frame.current?.scrollPage(-1),
    'reader.images': () => loadImages(false),
    'reader.imagesAlways': () => loadImages(true),
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
    'help.keys': () => setKeyHelp(true),
    'filter.all': () => filterAccount(0),
    'split.next': () => stepSplit(1),
    'split.prev': () => stepSplit(-1),
    'app.loginItem': () => {
      void window.normie.toggleLoginItem().then((r) => setNote(r.packaged ? `Start at login is ${r.on ? 'on' : 'off'}` : `Start at login is ${r.on ? 'on' : 'off'} (it applies to the installed app)`));
    },
    'search.open': () => {
      setOpen(null);
      setSearch((s) => s ?? { query: '', results: [] });
      requestAnimationFrame(() => searchInput.current?.focus());
    },
    'search.close': () => closeSearch(),
    'theme.mocha': () => setTheme('mocha'),
    'theme.latte': () => setTheme('latte'),
    'theme.system': () => setTheme('system'),
    'thread.snooze': () => {
      if (rows[clamp(selected)]) setPicker('snooze');
    },
    'thread.unsnooze': () => triage({ type: 'unsnooze' }, (r) => ({ ...r, date: Date.now(), tags: { ...r.tags!, snoozedUntil: undefined } })),
    'vip.add': () => setVip(true),
    'vip.remove': () => setVip(false),
    ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`filter.${n}`, () => filterAccount(n)])),
    'compose.new': () => setCompose({ accountId: rows[clamp(selected)]?.accountId }),
    'send.undo': undoSend,
    'compose.reply': () => replyTo('reply'),
    'compose.replyAll': () => replyTo('replyAll'),
    'compose.forward': () => replyTo('forward'),
    'thread.label': () => {
      if (rows[clamp(selected)]) setPalette('label');
    },
  };
  const keymap = useKeymap();
  useKeys(context, handlers, keymap.actions);

  /** Run a registry action by id, as the palette and the native menus do. Of several ids, the one that applies here. */
  const latest = useRef({ handlers, context });
  latest.current = { handlers, context };
  const runAction = useCallback((ids: string[], fromMenu = false) => {
    const { handlers: h, context: ctx } = latest.current;
    // The Edit menu's Undo: typing in a field, or else Undo Send.
    const el = document.activeElement as HTMLElement | null;
    const typing = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    if (ids[0] === 'edit.undo') {
      if (typing) return void document.execCommand('undo');
      return void h['send.undo']?.();
    }
    // From the menus while typing in a field, or with a form or the palette open: only Cmd commands run. (A plain key
    // can reach the menu as a key equivalent when the page answers slowly.) The palette's own choices always run.
    if (fromMenu && (typing || document.querySelector('.palette-backdrop')) && !ids.some((x) => ACTIONS.find((a) => a.id === x)?.keys.some((k) => k.startsWith('Cmd-')))) return;
    const id = ids.find((x) => ACTIONS.some((a) => a.id === x && (a.contexts as readonly string[]).includes(ctx)) && h[x as keyof Handlers]);
    if (id) void h[id as keyof Handlers]!();
  }, []);
  useEffect(() => window.normie.onMenuAction((ids) => runAction(ids, true)), [runAction]);

  /** Show the open Thread's hidden images; `always` also remembers each sender. */
  function loadImages(always: boolean) {
    if (!open?.messages) return;
    const blocked = blockedMessages(open.messages, imagesAllowed);
    if (!blocked.length) return;
    setImagesAllowed((s) => new Set([...s, ...blocked.map((m) => m.id)]));
    if (always && core) {
      const senders = new Set(blocked.flatMap((m) => (m.from ? [m.from.address.toLowerCase()] : [])));
      void Promise.all([...senders].map((a) => core.allowImagesFrom(a))).then(() => cache?.load(open.key, true));
    }
  }

  /** Open or save an attachment. Files that would run code are only ever saved. */
  const onAttachment = useCallback((action: 'open' | 'save', messageId: number, index: number) => {
    if (!core) return;
    void core.attachment(messageId, index).then(async (file) => {
      if (!file) return setNote('That attachment is no longer available.');
      if (action === 'save') return void (await window.normie.saveAttachment(file));
      const r = await window.normie.openAttachment(file);
      if (r.reason === 'risky') setNote(`"${file.filename}" could run code, so Normie won't open it. Save it to look at it.`);
      else if (!r.ok) setNote(`Couldn't open "${file.filename}": ${r.reason}`);
    });
  }, [core, setNote]);

  /** The Identities mail can go out from: one per Account for now (several come with milestone 4). */
  const identities: Identity[] = window.normie.fake
    ? [{ accountId: 'fake:me@example.com', from: { address: 'me@example.com' } }]
    : (accounts ?? []).filter((a) => a.status === 'ok').flatMap((a) =>
      (a.identities?.length ? a.identities : [{ address: a.email }]).map((from) => ({ accountId: a.id, from })));

  const suggestContacts = useCallback((q: string) => (core ? core.contacts(q, 6) : Promise.resolve([])), [core]);

  const sendMessage = (m: OutgoingMessage, draftId?: number, sendAt?: number) => {
    if (!core) return;
    setCompose(null);
    if (sendAt !== undefined) {
      void core.send(m, draftId, sendAt).then(() => setNote(`Scheduled for ${describeWhen(new Date(sendAt), new Date())}`));
      return;
    }
    void core.send(m, draftId).then((id) => {
      lastSent.current = { id, at: performance.now() };
      setNote('Sending… ⌘Z to undo');
    });
  };

  /** Reply, reply all or forward the latest message of the selected Thread. */
  function replyTo(kind: ReplyKind) {
    const row = rows[clamp(selected)];
    if (!row || !core || !cache) return;
    void cache.load(row.key).then(async (messages) => {
      const last = messages.at(-1);
      const original = last && (await core.original(last.id, kind === 'forward'));
      if (!original) return setNote("Couldn't read that message.");
      setCompose({ accountId: row.accountId, ...planReply(kind, original, identities.map((i) => i.from)) });
    });
  }

  /** Cmd-Z after sending: take the message back from the Outbox and reopen it. */
  function undoSend() {
    const sent = lastSent.current;
    if (!core || !sent || performance.now() - sent.at > UNDO_SEND_WINDOW_MS) return;
    lastSent.current = null;
    void core.cancelSend(sent.id).then((m) => {
      if (m) {
        setCompose(m);
        setNote('Send undone');
      } else setNote('Already sent');
    });
  }

  // New mail in a notifying Split: a notification (unless Normie is in front), one per Thread per burst.
  const notified = useRef(new Map<string, number>());
  const splitsRef = useRef(splits);
  splitsRef.current = splits;
  useEffect(() => core?.onNotice((n) => {
    if (n.type !== 'arrived') return;
    void core.rows('inbox').then((r) => {
      const notices = toNotify(n.keys, r, splitsRef.current, notified.current, Date.now());
      if (document.hasFocus()) return;
      for (const note of notices) window.normie.notify(note);
    });
  }), [core]);

  // A clicked notification opens its Thread, in the whole Inbox.
  const openThreadRef = useRef<(key: string) => void>(() => {});
  openThreadRef.current = (key) => {
    const i = allRows.findIndex((r) => r.key === key);
    if (i < 0) return;
    setSplitId('inbox');
    setCompose(null);
    openRow(allRows[i]!, i, allRows);
  };
  useEffect(() => window.normie.onOpenThread((key) => openThreadRef.current(key)), []);

  // A message the server kept refusing comes back to the composer, with the reason.
  useEffect(() => core?.onNotice((n) => {
    if (n.type !== 'send-failed') return;
    void core.cancelSend(n.id).then((m) => {
      if (m) setCompose(m);
      setNote(`Couldn't send: ${n.error}`);
    });
  }), [core, setNote]);

  /** Run the search as the query changes (a short pause between keys first). */
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onSearchInput = (query: string) => {
    setSearch((s) => ({ query, results: s?.results ?? [] }));
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      if (!core) return;
      void core.search(query).then((results) => {
        if (searchRef.current?.query !== query) return;
        setSearch({ query, results });
        setSelected(0);
        selectedKey.current = undefined;
        // Nothing here: ask the servers by themselves.
        if (!results.length && query.trim().length >= 2) searchServer(query);
      });
    }, 60);
  };
  /** Search the servers for mail that isn't stored here (older than what's synced, or in folders not synced). */
  function searchServer(query = searchRef.current?.query ?? '') {
    if (!core || !query.trim()) return;
    setSearch((s) => (s && s.query === query ? { ...s, server: 'searching' } : s));
    void core.searchServer(query).then((results) => {
      if (searchRef.current?.query !== query) return;
      setSearch({ query, results, server: 'done' });
    });
  }
  function closeSearch() {
    clearTimeout(searchTimer.current);
    setSearch(null);
    setSelected(0);
    selectedKey.current = undefined;
  }

  /** Labels of the selected Thread's Account. */
  /** The selected Thread's Account's Labels, or folders to move to. */
  const rowLabels = (): LabelSet => labels.get(rows[clamp(selected)]?.accountId ?? '') ?? { moves: false, names: [] };
  // On a folder server a "Label" is a move, which takes the Thread out of the Inbox.
  const applyLabel = (label: string) => triage({ type: 'label', label, on: true }, rowLabels().moves ? () => null : (r) => r);
  const paletteItems = (mode: 'actions' | 'label'): PaletteItem[] => {
    const set = rowLabels();
    const labelItems = set.names.map((l) => ({ id: LABEL_ITEM + l, name: mode === 'label' ? l : `${set.moves ? 'Move to' : 'Label'}: ${l}`, keywords: l }));
    if (mode === 'label') return labelItems;
    // While writing: snippets, by name, with their trigger.
    if (compose) return snippets.map((s) => ({ id: SNIPPET_ITEM + s.trigger, name: `Snippet: ${s.name}`, hint: `;${s.trigger}`, keywords: `${s.trigger} ${s.text.slice(0, 60)}` }));
    const scheduledItems = scheduled.map((s) => ({ id: SCHEDULED_ITEM + s.id, name: `Scheduled: ${s.subject || '(no subject)'}`, keywords: `scheduled later ${s.to}`, hint: describeWhen(new Date(s.sendAt), new Date()) }));
    const draftItems = drafts.map((d) => ({ id: DRAFT_ITEM + d.id, name: `Draft: ${d.subject || '(no subject)'}`, keywords: `draft ${d.to}`, ...(d.to ? { hint: d.to.slice(0, 30) } : {}) }));
    return [...actionItems(keymap.actions, context, (id) => id !== 'palette.open' && !!handlers[id as keyof Handlers]), ...scheduledItems, ...draftItems, ...(rows.length ? labelItems : [])];
  };

  useEffect(() => {
    if (palette === 'actions' && core) {
      void core.drafts().then(setDrafts);
      void core.scheduled().then(setScheduled);
    }
  }, [palette, core]);

  /** Take a scheduled message out of the Outbox and into the composer: edit it, send it now, schedule it again, or discard it. */
  function openScheduled(id: number) {
    void core?.cancelSend(id).then((m) => {
      if (!m) return setNote('That message has already gone.');
      setCompose(m);
      setNote('Out of the schedule: ⌘↩ sends now, ⌘⇧↩ schedules again, Discard cancels it');
    });
  }

  /** Reopen a draft where it was left. */
  function openDraft(id: number) {
    void core?.draft(id).then((d) => {
      if (!d) return setNote('That draft is gone.');
      setCompose({
        accountId: d.accountId, ...(d.from ? { from: d.from } : {}), draftId: id, toText: d.to, ccText: d.cc, bccText: d.bcc, subject: d.subject, body: d.body,
        ...(d.inReplyTo ? { inReplyTo: d.inReplyTo } : {}), ...(d.references ? { references: d.references } : {}), ...(d.attachments ? { attachments: d.attachments } : {}),
      });
    });
  }

  return (
    <main className="app">
      <header className="split-bar">
        {search ? (
          <span className="search-bar">
            <input
              ref={searchInput}
              value={search.query}
              placeholder="Search: words, &quot;a phrase&quot;, from:, to:, subject:"
              spellCheck={false}
              onChange={(e) => onSearchInput(e.target.value)}
              onKeyDown={(e) => {
                // Enter or ↓ moves to the results (then j, k, Enter, e…); Esc closes the search.
                if (e.key === 'Enter' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  e.currentTarget.blur();
                  setSelected(0);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  closeSearch();
                }
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) searchServer();
              }}
            />
            <span className="count">{search.results.length}</span>
            {search.server === 'searching' ? (
              <span className="sync-note">Searching the server…</span>
            ) : search.server === 'done' ? (
              <span className="sync-note">Server searched</span>
            ) : search.query.trim() ? (
              <button className="quiet search-server" onClick={() => searchServer()} tabIndex={-1} title="Also search mail that isn't stored on this Mac (⌘↩)">Search the server</button>
            ) : null}
          </span>
        ) : (
        <nav className="splits" aria-label="Splits">
          {splits.map((s) => (
            <button key={s.id} className={s.id === split.id ? 'split active' : 'split'} onClick={() => openSplit(s.id)} tabIndex={-1}>
              {s.name} <span className="count">{s.id === split.id ? rows.length : counts.get(s.id)}</span>
            </button>
          ))}
        </nav>
        )}
        <SyncBadge core={core} />
        {note && <span className="sync-note">{note}</span>}
        {splitProblems.length > 0 && (
          <span className="keymap-note" title={splitProblems.join('\n')}>
            splits.json: {splitProblems.length} {splitProblems.length === 1 ? 'problem' : 'problems'}
          </span>
        )}
        {snippetProblems.length > 0 && (
          <span className="keymap-note" title={snippetProblems.join('\n')}>
            snippets.json: {snippetProblems.length} {snippetProblems.length === 1 ? 'problem' : 'problems'}
          </span>
        )}
        {keymap.problems.length > 0 && (
          <span className="keymap-note" title={keymap.problems.join('\n')}>
            keymap.json: {keymap.problems.length} {keymap.problems.length === 1 ? 'problem' : 'problems'}
          </span>
        )}
        {accounts && <AccountBar accounts={accounts} />}
      </header>
      {empty ? (
        <EmptyState />
      ) : (
        <div className={open || compose ? 'panes reading' : 'panes'}>
          <ThreadList rows={rows} selected={selected} markers={markers} />
          {compose && (
            <Suspense fallback={<section className="composer" />}>
              <Composer
                key={composeKey(compose)}
                start={compose}
                identities={identities}
                onSend={sendMessage}
                onClose={() => setCompose(null)}
                onSaveDraft={(id, content) => core!.saveDraft(id, content)}
                suggest={suggestContacts}
                snippets={snippets}
                handle={composer}
                onDiscard={(id) => {
                  if (id !== null) void core?.deleteDraft(id);
                  setNote('Draft discarded');
                }}
              />
            </Suspense>
          )}
          {open && !compose && (
            <Reader
              threadKey={open.key}
              subject={open.subject}
              messages={open.messages}
              allowed={imagesAllowed}
              frame={frame}
              onLoadImages={() => loadImages(false)}
              onAlwaysLoadImages={() => loadImages(true)}
              onAttachment={onAttachment}
              theme={theme}
            />
          )}
        </div>
      )}
      {overlay && <DevOverlay />}
      {keyHelp && <KeyHelp actions={keymap.actions} onClose={() => setKeyHelp(false)} />}
      {picker === 'snooze' && (
        <WhenPicker
          title="Snooze until"
          onClose={() => setPicker(null)}
          onPick={(until) => {
            setPicker(null);
            triage({ type: 'snooze', until }, (r) => ({ ...r, tags: { ...(r.tags ?? { newsletter: false, vip: false, known: false }), snoozedUntil: until } }));
          }}
        />
      )}
      {palette && (
        <Palette
          items={paletteItems(palette)}
          placeholder={palette === 'label' ? (rowLabels().moves ? 'Move to…' : 'Apply a Label') : compose ? 'Insert a snippet' : 'Type a command or Label'}
          onClose={() => setPalette(null)}
          onRun={(item) => {
            setPalette(null);
            if (item.id.startsWith(LABEL_ITEM)) applyLabel(item.id.slice(LABEL_ITEM.length));
            else if (item.id.startsWith(DRAFT_ITEM)) openDraft(Number(item.id.slice(DRAFT_ITEM.length)));
            else if (item.id.startsWith(SCHEDULED_ITEM)) openScheduled(Number(item.id.slice(SCHEDULED_ITEM.length)));
            else if (item.id.startsWith(SNIPPET_ITEM)) composer.current?.insert(snippets.find((s) => s.trigger === item.id.slice(SNIPPET_ITEM.length))?.text ?? '');
            else runAction([item.id]);
          }}
        />
      )}
    </main>
  );
}
