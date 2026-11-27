// The sync side of the core: pulls changes from a MailProvider and hands them to the data side.
// Runs in the sync process. Talks to the store only through DataPort.
import type { DataPort } from './data-service';
import { parseAddresses } from './addresses';
import { buildMime } from './compose';
import type { ServerQuery } from './search-query';
import { ServerRejectedError, SNOOZED } from './types';
import type { AccountId, Mailbox, MailProvider, MailTransport } from './types';

export type TextExtractor = (raw: Uint8Array) => Promise<string>;

export interface SyncEngineOptions {
  accountId: AccountId;
  kind: string;
  email: string;
  /** The addresses this Account sends as (its Identities); the login address when absent. */
  identities?: Array<string>;
  provider: MailProvider;
  data: DataPort;
  extractText: TextExtractor;
  /** Days of history kept with full bodies. */
  windowDays?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  bodyBatch?: number;
  log?: (msg: string) => void;
  /** How often to check for changes without an IDLE event (other mailboxes, missed events). */
  pollMs?: number;
  /** Gather bursts of IDLE events into one sync. */
  debounceMs?: number;
  /** Delay before reconnect attempt n (0-based). */
  backoffMs?: (attempt: number) => number;
  /** Sends mail. Without one, the Outbox just waits. */
  transport?: MailTransport;
  /** Gather draft saves (one every keystroke pause) into one upload. */
  draftDebounceMs?: number;
}

const DAY = 86_400_000;

const defaultBackoff = (attempt: number) => Math.min(60_000, 1000 * 2 ** attempt);

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {return resolve();}
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
}

export class SyncEngine {
  private mailboxes: Array<Mailbox> = [];
  private primary?: Mailbox;
  private readonly windowDays: number;
  private readonly now: () => number;
  private readonly bodyBatch: number;
  private readonly log: (msg: string) => void;
  /** Serializes work on the provider connection. */
  private queue: Promise<unknown> = Promise.resolve();
  private live?: AbortController;
  private pollTimer?: ReturnType<typeof setInterval>;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private syncing?: Promise<void>;
  private again = false;
  private inbox?: Mailbox;
  /** A replay that's queued but hasn't started; later requests join it. */
  private replayQueued?: Promise<void>;
  private replayRetry?: ReturnType<typeof setTimeout>;
  private replayFailures = 0;
  private sending?: Promise<void>;
  private sendAgain = false;
  private outboxTimer?: ReturnType<typeof setTimeout>;
  private sendFailures = 0;
  private draftTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  /** Resolves after the next live sync pass completes; for tests. */
  private passWaiters: Array<() => void> = [];

  constructor(private readonly o: SyncEngineOptions) {
    this.windowDays = o.windowDays ?? 90;
    this.now = o.now ?? Date.now;
    this.bodyBatch = o.bodyBatch ?? 25;
    this.log = o.log ?? (() => {});
  }

  get windowStart() {
    return this.now() - this.windowDays * DAY;
  }

  /**
   * The mailboxes kept in sync, Inbox (or All Mail) first. On Gmail, All Mail holds everything. On folder servers:
   * Inbox, Sent (so my replies show in Threads), Archive (where Done puts mail) and Trash. Other folders aren't.
   */
  get syncedMailboxes(): Array<string> {
    if (!this.primary) {return [];}
    if (this.o.provider.caps.labels) {return [this.primary.path];}
    const byRole = (role: string) => this.mailboxes.find((m) => m.role === role)?.path;
    const snoozed = this.mailboxes.find((m) => m.path === SNOOZED)?.path;
    return [this.primary.path, ...[...(['sent', 'archive', 'trash'] as const).map(byRole), snoozed].filter((p): p is string => !!p && p !== this.primary!.path)];
  }

  /** Headers then bodies for every synced mailbox. */
  private async syncAll() {
    for (const m of this.syncedMailboxes) {await this.syncHeaders(m);}
    for (const m of this.syncedMailboxes) {await this.syncBodies(m);}
  }

  /** The mailbox that holds the Account's mail: All Mail on servers with Labels, Inbox elsewhere. */
  get primaryMailbox(): string | undefined {
    return this.primary?.path;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Connect, record the Account and its mailboxes, and pick the primary mailbox. */
  async start() {
    const { provider, data, accountId } = this.o;
    await provider.connect();
    await data.upsertAccount(accountId, this.o.kind, this.o.email);
    await data.setIdentities(accountId, this.o.identities?.length ? this.o.identities : [this.o.email]);
    this.mailboxes = await provider.listMailboxes();
    await data.setMailboxes(accountId, this.mailboxes);
    this.primary = provider.caps.labels
      ? this.mailboxes.find((m) => m.role === 'all')
      : this.mailboxes.find((m) => m.role === 'inbox');
    if (!this.primary) {throw new Error(`No ${provider.caps.labels ? 'All Mail' : 'Inbox'} mailbox found by special-use flag`);}
    this.inbox = this.mailboxes.find((m) => m.role === 'inbox');
  }

  // --- Live updates

  /** Start live updates: IDLE on the Inbox, a poll timer, reconnects with backoff. */
  startLive() {
    if (this.live) {return;}
    this.live = new AbortController();
    void this.watchLoop(this.live.signal);
    this.pollTimer = setInterval(() => this.syncSoon(0), this.o.pollMs ?? 120_000);
  }

  /** Ask for a sync now, such as when the window gains focus. */
  pollNow() {
    this.syncSoon(0);
  }

  /** Resolves once the next live sync pass finishes. */
  nextPass(): Promise<void> {
    return new Promise((r) => this.passWaiters.push(r));
  }

  private async watchLoop(signal: AbortSignal) {
    const path = this.inbox?.path ?? this.primary!.path;
    let attempt = 0;
    while (!signal.aborted) {
      try {
        for await (const _event of this.o.provider.watch(path, signal)) {
          attempt = 0;
          this.syncSoon(this.o.debounceMs ?? 250);
        }
      } catch (error) {
        if (signal.aborted) break;
        this.log(`IDLE on ${path} failed: ${(error as Error).message}`);
      }
      if (signal.aborted) {break;}
      await sleep((this.o.backoffMs ?? defaultBackoff)(attempt++), signal);
      // Catch up on whatever happened while the connection was down.
      this.syncSoon(0);
    }
  }

  private syncSoon(delay: number) {
    if (!this.live || this.live.signal.aborted) {return;}
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.livePass(), delay);
  }

  /** One live sync pass. Never runs two at once; a request during a pass runs one more pass after it. */
  private async livePass() {
    if (this.syncing) {
      this.again = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      do {
        this.again = false;
        try {
          this.outboxSoon();
          await this.replay();
          await this.syncAll();
        } catch (error) {
          this.log(`sync failed, reconnecting: ${(error as Error).message}`);
          await this.reconnect();
        }
      } while (this.again && !this.live?.signal.aborted);
    })();
    try {
      await this.syncing;
    } finally {
      this.syncing = undefined;
      for (const r of this.passWaiters.splice(0)) {r();}
    }
  }

  private async reconnect() {
    const { provider } = this.o;
    for (let attempt = 0; !this.live?.signal.aborted; attempt++) {
      try {
        await provider.close().catch(() => {});
        await provider.connect();
        await this.replay();
        await this.syncAll();
        return;
      } catch (error) {
        this.log(`reconnect failed: ${(error as Error).message}`);
        await sleep((this.o.backoffMs ?? defaultBackoff)(attempt), this.live?.signal);
      }
    }
  }

  /** One full sync pass: window headers, then window bodies, then older history as headers only. */
  async syncOnce() {
    this.outboxSoon();
    this.draftsSoon();
    await this.replay();
    await this.syncAll();
    for (const m of this.syncedMailboxes) {await this.backfillHeaders(m);}
  }

  // --- Search

  /**
   * Search the server for mail that isn't stored: Gmail's All Mail, or every folder of a folder server (including
   * ones not kept in sync). Up to 200 of the newest hits per mailbox are stored as headers; opening one downloads it.
   */
  async searchServer(query: ServerQuery) {
    const { provider, data, accountId } = this.o;
    const boxes = provider.caps.labels
      ? this.syncedMailboxes
      : this.mailboxes.filter((m) => m.role !== 'junk' && m.role !== 'drafts').map((m) => m.path);
    for (const mailbox of boxes) {
      const hits = await this.serial(() => provider.search(mailbox, query));
      const known = new Set(await data.knownUids(accountId, mailbox));
      const missing = hits.filter((u) => !known.has(u)).sort((a, b) => b - a).slice(0, 200);
      if (!missing.length) {continue;}
      const headers = await this.serial(() => provider.headers(mailbox, missing));
      await data.applyChanges(accountId, mailbox, { headers });
    }
  }

  // --- Drafts

  /** Upload changed drafts after a pause, so typing doesn't append a copy per keystroke. */
  draftsSoon() {
    if (this.stopped) {return;}
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => void this.syncDrafts().catch((error) => this.log(`drafts failed: ${(error as Error).message}`)), this.o.draftDebounceMs ?? 3000);
  }

  /**
   * Bring the Drafts mailbox up to date: append each changed draft (as a \Draft message), then delete the copies
   * it replaces, and those of drafts sent or discarded. A failure leaves the rest for the next pass.
   */
  async syncDrafts() {
    const { provider, data, accountId } = this.o;
    const box = this.mailboxes.find((m) => m.role === 'drafts');
    if (!box) {return;}
    for (const d of await data.draftsToSync(accountId)) {
      const c = d.content;
      const { addresses: to } = parseAddresses(c.to);
      const { addresses: cc } = parseAddresses(c.cc);
      const { addresses: bcc } = parseAddresses(c.bcc);
      const built = await buildMime({
        accountId, from: c.from ?? { address: this.o.email }, to, cc, bcc, subject: c.subject, body: c.body,
        ...(c.inReplyTo ? { inReplyTo: c.inReplyTo } : {}), ...(c.references ? { references: c.references } : {}),
        ...(c.attachments ? { attachments: c.attachments } : {}),
      }, d.messageId, new Date(this.now()));
      const { uid } = await this.serial(() => provider.append(box.path, built.raw, [String.raw`\Draft`, String.raw`\Seen`]));
      await data.draftSynced(d.id, accountId, d.updatedAt, box.path, uid);
    }
    for (const del of await data.draftDeletions(accountId)) {
      await this.serial(() => provider.remove(del.mailbox, [del.uid]));
      await data.draftDeleted(del.id);
    }
  }

  // --- The Outbox

  /** Send what's due soon, such as right after the user sends. */
  outboxSoon() {
    void this.sendOutbox().catch((error) => this.log(`outbox failed: ${(error as Error).message}`));
  }

  /**
   * Send every message that's due, then wait for the next one. One pass at a time; a request during a pass runs
   * one more. After a send, a copy goes to Sent unless the server files sent mail itself (Gmail does).
   */
  sendOutbox(): Promise<void> {
    if (this.sending) {
      this.sendAgain = true;
      return this.sending;
    }
    this.sending = (async () => {
      do {
        this.sendAgain = false;
        await this.sendDue();
      } while (this.sendAgain && !this.stopped);
    })().finally(() => (this.sending = undefined));
    return this.sending;
  }

  private async sendDue() {
    const { provider, data, accountId, transport } = this.o;
    if (!transport || this.stopped) {return;}
    clearTimeout(this.outboxTimer);
    let failed = false;
    for (const item of await data.dueOutbox(accountId)) {
      let built;
      try {
        built = await buildMime(item.message, item.messageId, new Date(this.now()));
        await transport.send(built.raw, built.envelope);
      } catch (error) {
        failed = true;
        const rejected = error instanceof ServerRejectedError;
        const gaveUp = await data.outboxFailed(item.id, (error as Error).message, rejected);
        this.log(gaveUp ? `message ${item.id} refused, given back to the user: ${(error as Error).message}` : `message ${item.id} not sent yet: ${(error as Error).message}`);
        if (!rejected) {break;}
        continue;
      }
      // Sent. Filing the copy can fail without sending it twice.
      await data.outboxSent(item.id);
      if (!provider.caps.savesSent) {
        const sent = this.mailboxes.find((m) => m.role === 'sent');
        if (sent) {await this.serial(() => provider.append(sent.path, built.raw, ['\\Seen'])).catch((e) => this.log(`couldn't file a copy in Sent: ${(e as Error).message}`));}
      }
    }
    if (this.stopped) {return;}
    if (failed) {
      this.outboxTimer = setTimeout(() => this.outboxSoon(), (this.o.backoffMs ?? defaultBackoff)(this.sendFailures++));
      return;
    }
    this.sendFailures = 0;
    const next = await data.nextOutboxAt(accountId);
    if (next !== undefined) {this.outboxTimer = setTimeout(() => this.outboxSoon(), Math.max(0, next - this.now()));}
  }

  /** Create a mailbox the Account lacks (Archive or Trash on a folder server), then re-read the list. */
  private async ensureMailbox(path: string) {
    if (this.mailboxes.some((m) => m.path === path)) {return;}
    const { provider, data, accountId } = this.o;
    await provider.createMailbox(path);
    this.mailboxes = await provider.listMailboxes();
    await data.setMailboxes(accountId, this.mailboxes);
    this.log(`created ${path}`);
  }

  // --- Pending changes

  /** Resolves once work already queued on the connection is done; for tests. */
  async idle() {
    await this.queue;
  }

  /** Send pending changes soon, such as right after the user acts. */
  replaySoon() {
    void this.replay().catch((error) => this.log(`replay failed: ${(error as Error).message}`));
  }

  /**
   * Send pending changes to the server, oldest first, dropping each once the server has it.
   * A change that fails stays pending and is tried again on the next pass.
   */
  replay(): Promise<void> {
    if (this.replayQueued) {return this.replayQueued;}
    const run = this.serial(async () => {
      this.replayQueued = undefined;
      clearTimeout(this.replayRetry);
      const { provider, data, accountId } = this.o;
      let failed = false;
      for (const c of await data.pendingChanges(accountId)) {
        try {
          if (c.edit.moveTo !== undefined) {
            await this.ensureMailbox(c.edit.moveTo);
            const moved = await provider.move(c.mailbox, c.uids, c.edit.moveTo);
            await data.changeApplied(c.id, { movedUids: moved.uids });
          } else {
            await provider.edit(c.mailbox, c.uids, c.edit);
            await data.changeApplied(c.id);
          }
        } catch (error) {
          failed = true;
          const rejected = error instanceof ServerRejectedError;
          const msg = (error as Error).message;
          const gaveUp = await data.changeFailed(c.id, msg, rejected);
          this.log(gaveUp ? `change ${c.id} refused by the server, rolled back: ${msg}` : `change ${c.id} not sent yet: ${msg}`);
          // A refusal is about this change only; anything else is most likely the connection, so stop here and keep order.
          if (!rejected) {break;}
        }
      }
      if (!failed) {
        this.replayFailures = 0;
        // A held change (a fresh delete) is sent once its hold is over.
        const next = await data.nextSendAt(accountId);
        if (next !== undefined && !this.stopped) {this.replayRetry = setTimeout(() => this.replaySoon(), Math.max(0, next - this.now()));}
        return;
      }
      if (this.stopped) {return;}
      // Try again with backoff. While live, a full pass also reconnects if the connection is gone.
      this.replayRetry = setTimeout(() => (this.live ? this.syncSoon(0) : this.replaySoon()), (this.o.backoffMs ?? defaultBackoff)(this.replayFailures++));
    });
    this.replayQueued = run;
    return run;
  }

  /** Headers for mail older than the window, newest first, in batches. Resumes where it left off. */
  async backfillHeaders(mailbox = this.primary!.path, batch = 500) {
    const { provider, data, accountId } = this.o;
    const before = this.windowStart;
    const old = await this.serial(() => provider.uidsBefore(mailbox, before));
    const known = new Set(await data.knownUids(accountId, mailbox));
    const missing = old.filter((u) => !known.has(u)).sort((a, b) => b - a);
    for (let i = 0; i < missing.length; i += batch) {
      const headers = await this.serial(() => provider.headers(mailbox, missing.slice(i, i + batch)));
      await data.applyChanges(accountId, mailbox, { headers });
    }
    if (missing.length) {this.log(`${mailbox}: backfilled ${missing.length} older headers`);}
  }

  /** Pull header and flag changes for the primary mailbox. */
  syncHeaders(mailbox = this.primary!.path) {
    return this.serial(async () => {
      const { provider, data, accountId } = this.o;
      const since = await data.mailboxState(accountId, mailbox);
      const cs = await provider.changes(mailbox, since, { windowStart: this.windowStart });
      const vanished = [...cs.vanished];
      // Without QRESYNC the server can't tell us what was deleted: compare UID sets instead.
      if (since && !cs.reset && !provider.caps.qresync) {
        const onServer = new Set(await provider.uids(mailbox, { windowStart: this.windowStart }));
        const newUids = new Set(cs.headers.map((h) => h.uid));
        // Only the window is compared: older history is headers only and isn't rechecked.
        for (const uid of await data.knownUids(accountId, mailbox, this.windowStart)) {
          if (!onServer.has(uid) && !newUids.has(uid)) {vanished.push(uid);}
        }
      }
      // Write headers in chunks so the list fills while a big first sync is still running.
      const CHUNK = 500;
      for (let i = 0; i < cs.headers.length; i += CHUNK) {
        const last = i + CHUNK >= cs.headers.length;
        await data.applyChanges(accountId, mailbox, {
          reset: i === 0 && cs.reset,
          headers: cs.headers.slice(i, i + CHUNK),
          ...(last ? { flagChanges: cs.flagChanges, vanished, state: cs.state } : {}),
        });
      }
      if (!cs.headers.length) {
        await data.applyChanges(accountId, mailbox, { reset: cs.reset, flagChanges: cs.flagChanges, vanished, state: cs.state });
      }
      this.log(`${mailbox}: ${cs.headers.length} headers, ${cs.flagChanges.length} flag changes, ${vanished.length} gone`);
    });
  }

  /** Download bodies for messages in the window that lack one, newest first. */
  async syncBodies(mailbox = this.primary!.path) {
    const { data, accountId } = this.o;
    for (;;) {
      const uids = await data.uidsNeedingBodies(accountId, mailbox, this.windowStart, this.bodyBatch);
      if (!uids.length) {return;}
      await this.fetchBodies(mailbox, uids);
    }
  }

  /** Fetch specific bodies now, such as one the user just opened. */
  fetchBodies(mailbox: string, uids: Array<number>) {
    return this.serial(async () => {
      const { provider, data, accountId } = this.o;
      const raws = await provider.fetchBodies(mailbox, uids);
      const bodies = await Promise.all(raws.map(async (r) => ({ uid: r.uid, raw: r.raw, text: await this.o.extractText(r.raw) })));
      // A message that vanished between listing and fetching comes back without a body; store an empty one so we don't loop.
      const got = new Set(bodies.map((b) => b.uid));
      for (const uid of uids) {if (!got.has(uid)) bodies.push({ uid, raw: new Uint8Array(), text: '' });}
      await data.putBodies(accountId, mailbox, bodies);
    });
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.replayRetry);
    clearTimeout(this.outboxTimer);
    clearTimeout(this.draftTimer);
    await this.sending?.catch(() => {});
    this.live?.abort();
    clearInterval(this.pollTimer);
    clearTimeout(this.debounceTimer);
    await this.syncing?.catch(() => {});
    await this.queue.catch(() => {});
    await this.o.provider.close();
  }
}
