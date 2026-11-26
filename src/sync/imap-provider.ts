// The IMAP provider over ImapFlow. Gmail, iCloud and generic servers all use it and differ in caps
// (read from the server after login) and a few overrides. Facts it relies on are from spike #2.
import { ImapFlow, type FetchMessageObject, type ListResponse, type MessageAddressObject } from 'imapflow';
import type {
  Address, Caps, ChangeSet, ChangesOptions, FlagChange, Mailbox, MailboxRole, MailEvent, MailProvider, RawMessage, RemoteHeader, SyncState,
} from '../core/types';

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  /** OAuth (XOAUTH2): a fresh access token for each new connection. */
  accessToken?: () => Promise<string>;
  password?: string;
  /** The server files SMTP mail in Sent by itself (Gmail does, iCloud doesn't). */
  savesSent: boolean;
  log?: (msg: string) => void;
}

export const gmailConfig = (user: string, accessToken: () => Promise<string>, log?: (m: string) => void): ImapConfig => ({
  host: 'imap.gmail.com', port: 993, user, accessToken, savesSent: true, log,
});

const SPECIAL_USE: Record<string, MailboxRole> = {
  '\\Inbox': 'inbox', '\\Sent': 'sent', '\\Drafts': 'drafts', '\\All': 'all', '\\Trash': 'trash', '\\Junk': 'junk',
  '\\Flagged': 'flagged', '\\Archive': 'archive',
};

/**
 * The role of a listed mailbox. When the server reports special-use flags, only those count: a folder merely
 * named "Sent Messages" on Gmail is not Sent. Without the extension (iCloud), ImapFlow's name matching is used.
 */
export function roleOf(entry: Pick<ListResponse, 'path' | 'specialUse' | 'specialUseSource'>, serverHasSpecialUse: boolean): MailboxRole | undefined {
  if (entry.path.toUpperCase() === 'INBOX') return 'inbox';
  if (!entry.specialUse) return undefined;
  if (serverHasSpecialUse && entry.specialUseSource !== 'extension') return undefined;
  return SPECIAL_USE[entry.specialUse];
}

const addr = (a?: MessageAddressObject): Address | undefined => (a?.address ? { address: a.address, ...(a.name ? { name: a.name } : {}) } : undefined);

export function headerOf(m: FetchMessageObject, path: string, gmail: boolean): RemoteHeader {
  const env = m.envelope ?? ({} as NonNullable<FetchMessageObject['envelope']>);
  const date = env.date ? new Date(env.date).getTime() : m.internalDate ? new Date(m.internalDate).getTime() : 0;
  return {
    uid: m.uid,
    remoteId: gmail && m.emailId ? m.emailId : `${path}:${m.uid}`,
    threadId: gmail ? m.threadId : undefined,
    messageId: env.messageId,
    inReplyTo: env.inReplyTo,
    subject: env.subject ?? '',
    from: addr(env.from?.[0]),
    to: (env.to ?? []).map(addr).filter((a): a is Address => !!a),
    date,
    flags: [...(m.flags ?? [])],
    // Gmail leaves out the selected mailbox's own label, which is why the primary mailbox is All Mail (spike #2).
    labels: gmail ? [...(m.labels ?? [])] : [path],
  };
}

const HEADER_QUERY = { uid: true, envelope: true, flags: true, internalDate: true } as const;
const CHUNK = 500;

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export class ImapProvider implements MailProvider {
  private client?: ImapFlow;
  private serverCaps = new Set<string>();
  private enabled = new Set<string>();
  private hasSpecialUse = false;

  constructor(private readonly cfg: ImapConfig) {}

  get caps(): Caps {
    const gmail = this.serverCaps.has('X-GM-EXT-1');
    return {
      condstore: this.serverCaps.has('CONDSTORE'),
      qresync: this.enabled.has('QRESYNC'),
      move: this.serverCaps.has('MOVE'),
      labels: gmail,
      serverThreads: gmail,
      savesSent: this.cfg.savesSent,
    };
  }

  private get gmail() {
    return this.serverCaps.has('X-GM-EXT-1');
  }

  private get c(): ImapFlow {
    if (!this.client?.usable) throw new Error('IMAP connection is not open');
    return this.client;
  }

  async connect() {
    const auth = this.cfg.accessToken
      ? { user: this.cfg.user, accessToken: await this.cfg.accessToken() }
      : { user: this.cfg.user, pass: this.cfg.password ?? '' };
    const client = new ImapFlow({ host: this.cfg.host, port: this.cfg.port, secure: true, auth, qresync: true, logger: false });
    client.on('error', (e: Error) => this.cfg.log?.(`imap error: ${e.message}`));
    await client.connect();
    this.client = client;
    this.serverCaps = new Set(client.capabilities.keys());
    this.enabled = new Set(client.enabled ?? []);
    this.hasSpecialUse = this.serverCaps.has('SPECIAL-USE') || this.serverCaps.has('XLIST');
  }

  async close() {
    const c = this.client;
    this.client = undefined;
    if (c?.usable) await c.logout().catch(() => c.close());
  }

  async listMailboxes(): Promise<Mailbox[]> {
    const list = await this.c.list();
    return list
      .filter((e) => !e.flags.has('\\Noselect') && !e.flags.has('\\NonExistent'))
      .map((e) => {
        const role = roleOf(e, this.hasSpecialUse);
        return role ? { path: e.path, role } : { path: e.path };
      });
  }

  private async withMailbox<T>(path: string, fn: (info: { uidValidity: string; uidNext: number; highestModseq?: string }) => Promise<T>): Promise<T> {
    const lock = await this.c.getMailboxLock(path, { readOnly: true });
    try {
      const mb = this.c.mailbox;
      if (!mb) throw new Error(`could not open ${path}`);
      return await fn({
        uidValidity: String(mb.uidValidity),
        uidNext: mb.uidNext,
        ...(mb.highestModseq !== undefined ? { highestModseq: String(mb.highestModseq) } : {}),
      });
    } finally {
      lock.release();
    }
  }

  private async searchWindow(windowStart: number, extra: Record<string, unknown> = {}): Promise<number[]> {
    const r = await this.c.search({ since: new Date(windowStart), ...extra }, { uid: true });
    return r ? [...r].sort((a, b) => a - b) : [];
  }

  private async fetchHeaders(path: string, uids: number[]): Promise<RemoteHeader[]> {
    const out: RemoteHeader[] = [];
    const query = this.gmail ? { ...HEADER_QUERY, labels: true, threadId: true, emailId: true } : HEADER_QUERY;
    for (const part of chunks(uids, CHUNK)) {
      for await (const m of this.c.fetch(part.join(','), query, { uid: true })) out.push(headerOf(m, path, this.gmail));
    }
    return out;
  }

  async changes(path: string, since: SyncState | null, opts: ChangesOptions): Promise<ChangeSet> {
    return this.withMailbox(path, async (state) => {
      if (!since || since.uidValidity !== state.uidValidity) {
        const uids = await this.searchWindow(opts.windowStart);
        // Newest first, so the top of the list fills before older mail.
        const headers = await this.fetchHeaders(path, uids.reverse());
        return { state, reset: true, headers, flagChanges: [], vanished: [] };
      }
      const vanished: number[] = [];
      const onExpunge = (e: { path: string; uid?: number; vanished?: boolean }) => {
        if (e.path === path && e.uid !== undefined) vanished.push(e.uid);
      };
      this.c.on('expunge', onExpunge);
      try {
        const newUids = since.uidNext < state.uidNext ? (await this.searchWindow(opts.windowStart, { uid: `${since.uidNext}:*` })).filter((u) => u >= since.uidNext) : [];
        const headers = await this.fetchHeaders(path, newUids.reverse());
        const flagChanges: FlagChange[] = [];
        const flagQuery = this.gmail ? { uid: true, flags: true, labels: true } : { uid: true, flags: true };
        if (this.caps.condstore && since.highestModseq) {
          if (since.highestModseq !== state.highestModseq && since.uidNext > 1) {
            const fetchOpts = { uid: true, changedSince: BigInt(since.highestModseq), ...(this.caps.qresync ? { uidValidity: BigInt(since.uidValidity) } : {}) };
            for await (const m of this.c.fetch(`1:${since.uidNext - 1}`, flagQuery, fetchOpts)) {
              flagChanges.push({ uid: m.uid, flags: [...(m.flags ?? [])], ...(this.gmail ? { labels: [...(m.labels ?? [])] } : {}) });
            }
          }
        } else {
          const known = (await this.searchWindow(opts.windowStart)).filter((u) => u < since.uidNext);
          for (const part of chunks(known, CHUNK)) {
            for await (const m of this.c.fetch(part.join(','), flagQuery, { uid: true })) {
              flagChanges.push({ uid: m.uid, flags: [...(m.flags ?? [])], ...(this.gmail ? { labels: [...(m.labels ?? [])] } : {}) });
            }
          }
        }
        return { state, reset: false, headers, flagChanges, vanished };
      } finally {
        this.c.off('expunge', onExpunge);
      }
    });
  }

  async uids(path: string, opts: ChangesOptions) {
    return this.withMailbox(path, () => this.searchWindow(opts.windowStart));
  }

  async uidsBefore(path: string, before: number) {
    return this.withMailbox(path, async () => {
      const r = await this.c.search({ before: new Date(before) }, { uid: true });
      return r ? [...r] : [];
    });
  }

  async headers(path: string, uids: number[]): Promise<RemoteHeader[]> {
    if (!uids.length) return [];
    return this.withMailbox(path, () => this.fetchHeaders(path, uids));
  }

  async fetchBodies(path: string, uids: number[]): Promise<RawMessage[]> {
    if (!uids.length) return [];
    return this.withMailbox(path, async () => {
      const out: RawMessage[] = [];
      for await (const m of this.c.fetch(uids.join(','), { uid: true, source: true }, { uid: true })) {
        if (m.source) out.push({ uid: m.uid, raw: new Uint8Array(m.source) });
      }
      return out;
    });
  }

  // Live updates over IDLE arrive in #10.
  // eslint-disable-next-line require-yield
  async *watch(_path: string, signal: AbortSignal): AsyncIterable<MailEvent> {
    await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
  }
}
