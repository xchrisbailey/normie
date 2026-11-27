// The contract between the renderer and the core. No runtime dependencies, so the renderer can import it.
import type { PendingStatus, SplitId, ThreadAction, ThreadMessage, ThreadRow } from './types';

/** What the renderer can ask of the core. Every method is async because it crosses a MessagePort in the app. */
export interface CoreApi {
  rows(split: SplitId, limit?: number): Promise<ThreadRow[]>;
  thread(key: string): Promise<ThreadMessage[]>;
  /** A triage action on a Thread. The store changes at once; the server catches up. Returns the pending change ids. */
  act(key: string, action: ThreadAction): Promise<number[]>;
  /** Changes still on their way to the server. Kept current by 'pending' notices. */
  pending(): Promise<PendingStatus>;
}

export const CORE_API_METHODS = ['rows', 'thread', 'act', 'pending'] as const satisfies readonly (keyof CoreApi)[];
