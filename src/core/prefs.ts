// How the app behaves, as chosen in Settings: reading, sending, notifications, the menu bar and the clock. Kept in
// settings.json beside the appearance. Pure.

export const MARK_READ = ['open', 'delay', 'manual'] as const;
export type MarkRead = (typeof MARK_READ)[number];
/** How long a Thread stays open before it's marked read, with `delay`. */
export const MARK_READ_DELAY_MS = 2000;

export const REMOTE_IMAGES = ['ask', 'known', 'always'] as const;
export type RemoteImages = (typeof REMOTE_IMAGES)[number];

export const AFTER_TRIAGE = ['next', 'previous', 'list'] as const;
export type AfterTriage = (typeof AFTER_TRIAGE)[number];

/** Seconds a sent message waits in the Outbox, so Cmd-Z can take it back. */
export const UNDO_SEND = [0, 5, 10, 20, 30] as const;
export type UndoSend = (typeof UNDO_SEND)[number];

export const NOTIFY = ['off', 'splits', 'all'] as const;
export type NotifyChoice = (typeof NOTIFY)[number];

export const MENU_COUNT = ['inbox', 'unread', 'off'] as const;
export type MenuCount = (typeof MENU_COUNT)[number];

export const CLOCK = ['system', '12', '24'] as const;
export type Clock = (typeof CLOCK)[number];

export interface Prefs {
  markRead: MarkRead;
  remoteImages: RemoteImages;
  afterTriage: AfterTriage;
  undoSend: UndoSend;
  /** The identity new mail starts from (`accountId address`), or empty for the first one. */
  defaultFrom: string;
  notify: NotifyChoice;
  menuCount: MenuCount;
  clock: Clock;
}

export const DEFAULT_PREFS: Prefs = {
  markRead: 'open',
  remoteImages: 'ask',
  afterTriage: 'next',
  undoSend: 5,
  defaultFrom: '',
  notify: 'splits',
  menuCount: 'inbox',
  clock: 'system',
};

const oneOf = <T extends string | number>(options: ReadonlyArray<T>, v: unknown, fallback: T): T => options.find((o) => o === v) ?? fallback;

/** Prefs from settings.json (or a renderer's request): each part that's missing or unknown is the default. */
export function prefsFrom(v: unknown): Prefs {
  const d = DEFAULT_PREFS;
  if (typeof v !== 'object' || v === null) {
    return d;
  }
  return {
    markRead: oneOf(MARK_READ, 'markRead' in v ? v.markRead : undefined, d.markRead),
    remoteImages: oneOf(REMOTE_IMAGES, 'remoteImages' in v ? v.remoteImages : undefined, d.remoteImages),
    afterTriage: oneOf(AFTER_TRIAGE, 'afterTriage' in v ? v.afterTriage : undefined, d.afterTriage),
    undoSend: oneOf(UNDO_SEND, 'undoSend' in v ? v.undoSend : undefined, d.undoSend),
    defaultFrom: 'defaultFrom' in v && typeof v.defaultFrom === 'string' ? v.defaultFrom.slice(0, 400) : d.defaultFrom,
    notify: oneOf(NOTIFY, 'notify' in v ? v.notify : undefined, d.notify),
    menuCount: oneOf(MENU_COUNT, 'menuCount' in v ? v.menuCount : undefined, d.menuCount),
    clock: oneOf(CLOCK, 'clock' in v ? v.clock : undefined, d.clock),
  };
}

/** An identity's key for `defaultFrom`. */
export const fromKey = (accountId: string, address: string) => `${accountId} ${address.toLowerCase()}`;

/** `hour12` for Intl, from the clock choice: undefined follows the system. */
export const hour12Of = (clock: Clock): boolean | undefined => (clock === 'system' ? undefined : clock === '12');
