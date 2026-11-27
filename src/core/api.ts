// The contract between the renderer and the core. No runtime dependencies, so the renderer can import it.
import type { Original } from './reply';
import type { OutgoingMessage, PendingStatus, SplitId, ThreadAction, ThreadMessage, ThreadRow } from './types';

/** What the renderer can ask of the core. Every method is async because it crosses a MessagePort in the app. */
export interface CoreApi {
  rows(split: SplitId, limit?: number): Promise<ThreadRow[]>;
  thread(key: string): Promise<ThreadMessage[]>;
  /** A triage action on a Thread. The store changes at once; the server catches up. Returns the pending change ids. */
  act(key: string, action: ThreadAction): Promise<number[]>;
  /** Put a message in the Outbox; it goes out after the undo window. Returns its Outbox id. */
  send(message: OutgoingMessage): Promise<number>;
  /** Take a message back out of the Outbox (undo send, or after it failed). Null once it's on its way. */
  cancelSend(id: number): Promise<OutgoingMessage | null>;
  /** What a reply or forward needs from a message (attachments only for a forward). */
  original(messageId: number, withAttachments: boolean): Promise<Original | null>;
  /** One attachment's bytes. */
  attachment(messageId: number, index: number): Promise<{ filename: string; contentType: string; content: Uint8Array } | null>;
  /** Always load remote images from this sender. */
  allowImagesFrom(address: string): Promise<void>;
  /** An Account's own Labels, for the Label picker. Kept current by 'labels-changed' notices. */
  labels(accountId: string): Promise<string[]>;
  /** Undo the changes an `act` returned. */
  undo(ids: number[]): Promise<void>;
  /** Changes still on their way to the server. Kept current by 'pending' notices. */
  pending(): Promise<PendingStatus>;
}

export const CORE_API_METHODS = ['rows', 'thread', 'act', 'undo', 'pending', 'labels', 'allowImagesFrom', 'attachment', 'send', 'cancelSend', 'original'] as const satisfies readonly (keyof CoreApi)[];
