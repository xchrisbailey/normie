// The contract between the renderer and the core. No runtime dependencies, so the renderer can import it.
import type { SplitId, ThreadMessage, ThreadRow } from './types';

/** What the renderer can ask of the core. Every method is async because it crosses a MessagePort in the app. */
export interface CoreApi {
  rows(split: SplitId, limit?: number): Promise<ThreadRow[]>;
  thread(key: string): Promise<ThreadMessage[]>;
}

export const CORE_API_METHODS = ['rows', 'thread'] as const satisfies readonly (keyof CoreApi)[];
