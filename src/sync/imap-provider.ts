// The IMAP provider over ImapFlow. Gmail, iCloud and generic servers all use it and differ in caps
// (read from the server after login) and a few overrides. Facts it relies on are from spike #2.
import { ImapFlow } from 'imapflow';
import type { FetchMessageObject, FetchOptions, ImapFlowOptions, ListResponse, MessageAddressObject, SearchObject } from 'imapflow';
import { errorMessage } from '../core/errors';
import type { ServerQuery } from '../core/search-query';
import { ServerRejectedError } from '../core/types';
import type {
  Address,
  Caps,
  ChangeSet,
  ChangesOptions,
  FlagChange,
  Mailbox,
  MailboxRole,
  MailEvent,
  MailProvider,
  MessageEdit,
  RawMessage,
  RemoteHeader,
  SyncState,
} from '../core/types';

export interface ImapConfig {
  host: string;
  port: number;
  /** TLS from the start (the default), STARTTLS, or (localhost only) none. */
  security?: 'tls' | 'starttls' | 'none';
  user: string;
  /** OAuth (XOAUTH2): a fresh access token for each new connection. */
  accessToken?: () => Promise<string>;
  password?: string;
  /** The server files SMTP mail in Sent by itself (Gmail does, iCloud doesn't). */
  savesSent: boolean;
  log?: (msg: string) => void;
}

export const gmailConfig = (user: string, accessToken: () => Promise<string>, log?: (m: string) => void): ImapConfig => ({
  host: 'imap.gmail.com',
  port: 993,
  user,
  accessToken,
  savesSent: true,
  log,
});

const SPECIAL_USE = new Map<string, MailboxRole>([
  [String.raw`\Inbox`, 'inbox'],
  [String.raw`\Sent`, 'sent'],
  [String.raw`\Drafts`, 'drafts'],
  [String.raw`\All`, 'all'],
  [String.raw`\Trash`, 'trash'],
  [String.raw`\Junk`, 'junk'],
  [String.raw`\Flagged`, 'flagged'],
  [String.raw`\Archive`, 'archive'],
]);

/**
 * The role of a listed mailbox. When the server reports special-use flags, only those count: a folder merely
 * named "Sent Messages" on Gmail is not Sent. Without the extension (iCloud), ImapFlow's name matching is used.
 */
export function roleOf(entry: Pick<ListResponse, 'path' | 'specialUse' | 'specialUseSource'>, serverHasSpecialUse: boolean): MailboxRole | undefined {
  if (entry.path.toUpperCase() === 'INBOX') {
    return 'inbox';
  }
  if (!entry.specialUse) {
    return undefined;
  }
  if (serverHasSpecialUse && entry.specialUseSource !== 'extension') {
    return undefined;
  }
  return SPECIAL_USE.get(entry.specialUse);
}

function addr(a?: MessageAddressObject): Address | undefined {
  if (!a?.address) {
    return undefined;
  }
  const out: Address = { address: a.address };
  if (a.name) {
    out.name = a.name;
  }
  return out;
}

/** Whether headers say the message was sent to a list: List-Unsubscribe, List-Id, or Precedence: bulk, list or junk. */
export function isListMail(headers?: Buffer | string): boolean {
  if (!headers) {
    return false;
  }
  const text = headers.toString().replaceAll(/\r?\n[ \t]+/g, ' ');
  return /^(list-unsubscribe|list-id):/im.test(text) || /^precedence:\s*(bulk|list|junk)\b/im.test(text);
}

/** Message-IDs in a References header, oldest first. */
export function referencesOf(headers?: Buffer | string): Array<string> {
  if (!headers) {
    return [];
  }
  const text = headers.toString().replaceAll(/\r?\n[ \t]+/g, ' ');
  const line = /^references:(.*)$/im.exec(text)?.[1] ?? '';
  return line.match(/<[^<>\s]+>/g) ?? [];
}

export function headerOf(m: FetchMessageObject, path: string, gmail: boolean): RemoteHeader {
  const env = m.envelope ?? {};
  const references = gmail ? [] : referencesOf(m.headers);
  const date = env.date ? new Date(env.date).getTime() : m.internalDate ? new Date(m.internalDate).getTime() : 0;
  const header: RemoteHeader = {
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
  if (references.length) {
    header.references = references;
  }
  if (m.headers) {
    header.isList = isListMail(m.headers);
  }
  return header;
}

/** A flag change from a fetched message; Gmail's also carry its labels. */
function flagChangeOf(m: FetchMessageObject, gmail: boolean): FlagChange {
  const change: FlagChange = { uid: m.uid, flags: [...(m.flags ?? [])] };
  if (gmail) {
    change.labels = [...(m.labels ?? [])];
  }
  return change;
}

const HEADER_QUERY = { uid: true, envelope: true, flags: true, internalDate: true } as const;
const CHUNK = 500;
const LIST_HEADERS = ['list-unsubscribe', 'list-id', 'precedence'];

function chunks<T>(xs: Array<T>, n: number): Array<Array<T>> {
  const out: Array<Array<T>> = [];
  for (let i = 0; i < xs.length; i += n) {
    out.push(xs.slice(i, i + n));
  }
  return out;
}

type MailboxInfo = { uidValidity: string; uidNext: number; highestModseq?: string };

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
    if (!this.client?.usable) {
      throw new Error('IMAP connection is not open');
    }
    return this.client;
  }

  /** A new connection with fresh credentials (a new access token each time, for OAuth). */
  private async newClient(): Promise<ImapFlow> {
    const auth = this.cfg.accessToken
      ? { user: this.cfg.user, accessToken: await this.cfg.accessToken() }
      : { user: this.cfg.user, pass: this.cfg.password ?? '' };
    const security = this.cfg.security ?? 'tls';
    const options: ImapFlowOptions = { host: this.cfg.host, port: this.cfg.port, secure: security === 'tls', auth, qresync: true, logger: false };
    if (security === 'starttls') {
      options.doSTARTTLS = true;
    }
    const client = new ImapFlow(options);
    client.on('error', (e: Error) => this.cfg.log?.(`imap error: ${errorMessage(e)}`));
    await client.connect();
    return client;
  }

  async connect() {
    const client = await this.newClient();
    this.client = client;
    this.serverCaps = new Set(client.capabilities.keys());
    this.enabled = new Set(client.enabled ?? []);
    this.hasSpecialUse = this.serverCaps.has('SPECIAL-USE') || this.serverCaps.has('XLIST');
  }

  async close() {
    const c = this.client;
    this.client = undefined;
    if (c?.usable) {
      await c.logout().catch(() => c.close());
    }
  }

  async listMailboxes(): Promise<Array<Mailbox>> {
    const list = await this.c.list();
    return list
      .filter((e) => !e.flags.has(String.raw`\Noselect`) && !e.flags.has(String.raw`\NonExistent`))
      .map((e) => {
        const role = roleOf(e, this.hasSpecialUse);
        return role ? { path: e.path, role } : { path: e.path };
      });
  }

  private async withMailbox<T>(path: string, fn: (info: MailboxInfo) => Promise<T>, readOnly = true): Promise<T> {
    const lock = await this.c.getMailboxLock(path, { readOnly });
    try {
      const mb = this.c.mailbox;
      if (!mb) {
        throw new Error(`could not open ${path}`);
      }
      const info: MailboxInfo = { uidValidity: String(mb.uidValidity), uidNext: mb.uidNext };
      if (mb.highestModseq !== undefined) {
        info.highestModseq = String(mb.highestModseq);
      }
      return await fn(info);
    } finally {
      lock.release();
    }
  }

  private async searchWindow(windowStart: number, extra: SearchObject = {}): Promise<Array<number>> {
    const r = await this.c.search({ since: new Date(windowStart), ...extra }, { uid: true });
    return r ? [...r].sort((a, b) => a - b) : [];
  }

  private async fetchHeaders(path: string, uids: Array<number>): Promise<Array<RemoteHeader>> {
    const out: Array<RemoteHeader> = [];
    // Gmail supplies thread ids; elsewhere Threads are built from References (see Store.localThread).
    // Everywhere: the list headers, for the Newsletters Split.
    const query = this.gmail
      ? { ...HEADER_QUERY, labels: true, threadId: true, emailId: true, headers: LIST_HEADERS }
      : { ...HEADER_QUERY, headers: ['references', ...LIST_HEADERS] };
    for (const part of chunks(uids, CHUNK)) {
      for await (const m of this.c.fetch(part.join(','), query, { uid: true })) {
        out.push(headerOf(m, path, this.gmail));
      }
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
      const vanished: Array<number> = [];
      const onExpunge = (e: { path: string; uid?: number; vanished?: boolean }) => {
        if (e.path === path && e.uid !== undefined) {
          vanished.push(e.uid);
        }
      };
      this.c.on('expunge', onExpunge);
      try {
        const newUids =
          since.uidNext < state.uidNext ? (await this.searchWindow(opts.windowStart, { uid: `${since.uidNext}:*` })).filter((u) => u >= since.uidNext) : [];
        const headers = await this.fetchHeaders(path, newUids.reverse());
        const flagChanges: Array<FlagChange> = [];
        const flagQuery = this.gmail ? { uid: true, flags: true, labels: true } : { uid: true, flags: true };
        if (this.caps.condstore && since.highestModseq) {
          if (since.highestModseq !== state.highestModseq && since.uidNext > 1) {
            const fetchOpts: FetchOptions & { uidValidity?: bigint } = { uid: true, changedSince: BigInt(since.highestModseq) };
            if (this.caps.qresync) {
              fetchOpts.uidValidity = BigInt(since.uidValidity);
            }
            for await (const m of this.c.fetch(`1:${since.uidNext - 1}`, flagQuery, fetchOpts)) {
              flagChanges.push(flagChangeOf(m, this.gmail));
            }
          }
        } else {
          const known = (await this.searchWindow(opts.windowStart)).filter((u) => u < since.uidNext);
          for (const part of chunks(known, CHUNK)) {
            for await (const m of this.c.fetch(part.join(','), flagQuery, { uid: true })) {
              flagChanges.push(flagChangeOf(m, this.gmail));
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

  async headers(path: string, uids: Array<number>): Promise<Array<RemoteHeader>> {
    if (!uids.length) {
      return [];
    }
    return this.withMailbox(path, () => this.fetchHeaders(path, uids));
  }

  async fetchBodies(path: string, uids: Array<number>): Promise<Array<RawMessage>> {
    if (!uids.length) {
      return [];
    }
    return this.withMailbox(path, async () => {
      const out: Array<RawMessage> = [];
      for await (const m of this.c.fetch(uids.join(','), { uid: true, source: true }, { uid: true })) {
        if (m.source) {
          out.push({ uid: m.uid, raw: new Uint8Array(m.source) });
        }
      }
      return out;
    });
  }

  /** Flag and Label changes. Opens the mailbox read-write (SELECT): a read-only one drops added flags. */
  async edit(path: string, uids: Array<number>, edit: MessageEdit) {
    if (!uids.length) {
      return;
    }
    await this.withMailbox(
      path,
      async () => {
        const range = uids.join(',');
        const steps: Array<[Array<string> | undefined, 'add' | 'remove', boolean]> = [
          [edit.addFlags, 'add', false],
          [edit.removeFlags, 'remove', false],
          [this.gmail ? edit.addLabels : undefined, 'add', true],
          [this.gmail ? edit.removeLabels : undefined, 'remove', true],
        ];
        for (const [items, op, useLabels] of steps) {
          if (!items?.length) {
            continue;
          }
          const ok =
            op === 'add'
              ? await this.c.messageFlagsAdd(range, items, { uid: true, useLabels })
              : await this.c.messageFlagsRemove(range, items, { uid: true, useLabels });
          if (!ok) {
            // ImapFlow reports every STORE failure as false. A connection that's still up means the server said no.
            const what = `${op} ${useLabels ? 'labels' : 'flags'} ${items.join(' ')}`;
            if (this.client?.usable) {
              throw new ServerRejectedError(`server refused to ${what}`);
            }
            throw new Error(`connection lost while trying to ${what}`);
          }
        }
      },
      false,
    );
  }

  async append(path: string, raw: Uint8Array, flags: Array<string>) {
    const r = await this.c.append(path, Buffer.from(raw), flags);
    if (!r) {
      if (this.client?.usable) {
        throw new ServerRejectedError(`server refused to append to ${path}`);
      }
      throw new Error(`connection lost while appending to ${path}`);
    }
    return r.uid ? { uid: r.uid } : {};
  }

  /** Search the server: Gmail takes the query as typed (X-GM-RAW); elsewhere each term becomes a SEARCH key. */
  async search(path: string, query: ServerQuery) {
    return this.withMailbox(path, async () => {
      let criteria: SearchObject;
      if (this.gmail) {
        criteria = { gmraw: query.raw };
      } else {
        criteria = {};
        const words: Array<string> = [];
        for (const t of query.terms) {
          if (t.field && !criteria[t.field]) {
            criteria[t.field] = t.text;
          } else {
            words.push(t.text);
          }
        }
        if (words.length) {
          criteria.text = words.join(' ');
        }
      }
      const r = await this.c.search(criteria, { uid: true });
      return r ? [...r] : [];
    });
  }

  /**
   * Move messages. ImapFlow uses MOVE where the server has it, else COPY + \\Deleted + EXPUNGE. New UIDs come from
   * COPYUID (UIDPLUS); without it they're found by Message-ID in the destination.
   */
  async move(path: string, uids: Array<number>, destination: string) {
    if (!uids.length) {
      return { uids: [] };
    }
    const ids = new Map<number, string>();
    const moved = await this.withMailbox(
      path,
      async () => {
        for await (const m of this.c.fetch(uids.join(','), { uid: true, envelope: true }, { uid: true })) {
          if (m.envelope?.messageId) {
            ids.set(m.uid, m.envelope.messageId);
          }
        }
        const r = await this.c.messageMove(uids.join(','), destination, { uid: true });
        if (!r) {
          if (this.client?.usable) {
            throw new ServerRejectedError(`server refused to move to ${destination}`);
          }
          throw new Error(`connection lost while moving to ${destination}`);
        }
        return r.uidMap;
      },
      false,
    );
    const out = uids.map((u) => moved?.get(u) ?? 0);
    if (out.some((u) => !u) && ids.size) {
      await this.withMailbox(destination, async () => {
        for (let i = 0; i < uids.length; i++) {
          const uid = uids[i];
          const id = uid === undefined ? undefined : ids.get(uid);
          if (out[i] || !id) {
            continue;
          }
          const found = await this.c.search({ header: { 'message-id': id } }, { uid: true });
          if (found && found.length) {
            out[i] = Math.max(...found);
          }
        }
      });
    }
    return { uids: out };
  }

  async createMailbox(path: string) {
    await this.c.mailboxCreate(path);
  }

  async remove(path: string, uids: Array<number>) {
    if (!uids.length) {
      return;
    }
    await this.withMailbox(
      path,
      async () => {
        const ok = await this.c.messageDelete(uids.join(','), { uid: true });
        if (!ok) {
          if (this.client?.usable) {
            throw new ServerRejectedError(`server refused to delete from ${path}`);
          }
          throw new Error(`connection lost while deleting from ${path}`);
        }
      },
      false,
    );
  }

  /**
   * Live events over IDLE, on a second connection of its own, so fetches and writes never wait on it.
   * ImapFlow idles whenever the selected mailbox has no command running, and restarts IDLE before servers drop it.
   * Throws when the connection closes, so the engine reconnects with backoff.
   */
  async *watch(path: string, signal: AbortSignal): AsyncIterable<MailEvent> {
    const client = await this.newClient();
    const queue: Array<MailEvent> = [];
    let failed: Error | undefined;
    let wake: (() => void) | undefined;
    const push = (e: MailEvent) => {
      queue.push(e);
      wake?.();
    };
    client.on('exists', (d: { path: string }) => push({ type: 'exists', mailbox: d.path }));
    client.on('expunge', (d: { path: string; uid?: number }) => {
      const event: MailEvent = { type: 'expunge', mailbox: d.path };
      if (d.uid !== undefined) {
        event.uid = d.uid;
      }
      push(event);
    });
    client.on('flags', (d: { path: string; uid?: number; flags: Set<string> }) =>
      push({ type: 'flags', mailbox: d.path, uid: d.uid ?? 0, flags: [...d.flags] }),
    );
    client.on('close', () => {
      failed ??= new Error('IDLE connection closed');
      wake?.();
    });
    client.on('error', (e: Error) => {
      failed ??= e;
      wake?.();
    });
    const onAbort = () => wake?.();
    signal.addEventListener('abort', onAbort);
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      while (!signal.aborted) {
        if (!queue.length && !failed) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        wake = undefined;
        if (failed && !signal.aborted) {
          throw failed;
        }
        for (let next = queue.shift(); next; next = queue.shift()) {
          yield next;
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      lock.release();
      if (client.usable) {
        await client.logout().catch(() => client.close());
      }
    }
  }
}
