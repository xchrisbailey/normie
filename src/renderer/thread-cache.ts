// Opened and prefetched Threads, held in renderer memory so opening a cached Thread needs no message
// to another process. Entries refresh when the core says a Thread changed (for example, a body arrived).
import type { ThreadMessage } from '../core/types';
import type { CoreClient } from './core-client';
import { sanitized } from './sanitize-cache';

const MAX = 50;

export class ThreadCache {
  private entries = new Map<string, ThreadMessage[]>();
  private inflight = new Map<string, Promise<ThreadMessage[]>>();
  private listeners = new Set<(key: string, messages: ThreadMessage[]) => void>();

  constructor(private readonly core: CoreClient) {
    core.onNotice((n) => {
      if (n.type === 'thread-changed' && this.entries.has(n.key)) void this.load(n.key, true);
    });
  }

  get(key: string): ThreadMessage[] | undefined {
    const v = this.entries.get(key);
    if (v) {
      // Keep recently used entries last, so the oldest are dropped first.
      this.entries.delete(key);
      this.entries.set(key, v);
    }
    return v;
  }

  load(key: string, force = false): Promise<ThreadMessage[]> {
    if (!force) {
      const hit = this.get(key);
      if (hit) return Promise.resolve(hit);
      const p = this.inflight.get(key);
      if (p) return p;
    }
    const p = this.core.thread(key).then((messages) => {
      this.inflight.delete(key);
      this.entries.set(key, messages);
      while (this.entries.size > MAX) this.entries.delete(this.entries.keys().next().value!);
      for (const fn of this.listeners) fn(key, messages);
      return messages;
    });
    this.inflight.set(key, p);
    return p;
  }

  /** Load Threads in idle time, so they open instantly. */
  prefetch(keys: string[]) {
    const missing = keys.filter((k) => !this.entries.has(k) && !this.inflight.has(k));
    if (!missing.length) return;
    // Load, then sanitize their HTML in idle time too, so opening one does no work on the key path.
    requestIdleCallback(() => missing.forEach((k) => void this.load(k).then((ms) => requestIdleCallback(() => ms.forEach((m) => sanitized(m, m.imagesAllowed))))), { timeout: 500 });
  }

  onLoaded(fn: (key: string, messages: ThreadMessage[]) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
}
