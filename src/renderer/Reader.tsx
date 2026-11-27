// The reader: the Thread's subject, a quiet bar when remote images are hidden, and the sandboxed mail frame.
import { memo, useCallback } from 'react';
import type { ThreadMessage } from '../core/types';
import { MailFrame } from './MailFrame';
import type { AttachmentAction, FrameHandle } from './MailFrame';
import { sanitized } from './sanitize-cache';

/** Messages whose remote images are hidden right now. */
export function blockedMessages(messages: Array<ThreadMessage> | undefined, allowed: ReadonlySet<number>): Array<ThreadMessage> {
  return (messages ?? []).filter((m) => m.html && !m.imagesAllowed && !allowed.has(m.id) && sanitized(m, false).remoteImages > 0);
}

export const Reader = memo(function Reader({ threadKey, subject, messages, allowed, frame, onLoadImages, onAlwaysLoadImages, onAttachment, theme }: {
  threadKey: string;
  subject: string;
  messages: Array<ThreadMessage> | undefined;
  /** Messages whose images the user loaded this session. */
  allowed: ReadonlySet<number>;
  frame: React.MutableRefObject<FrameHandle | null>;
  onLoadImages: () => void;
  onAlwaysLoadImages: () => void;
  onAttachment: AttachmentAction;
  theme: string;
}) {
  const allow = useCallback((m: ThreadMessage) => m.imagesAllowed || allowed.has(m.id), [allowed]);
  const blocked = blockedMessages(messages, allowed);
  const remote = (messages ?? []).some((m) => m.html && allow(m));
  return (
    <section className="reader" aria-label="Reader">
      <h1>{subject || '(no subject)'}</h1>
      {blocked.length > 0 && (
        <div className="images-bar" role="note">
          <span>Remote images are hidden. Loading them tells the sender you opened this.</span>
          <button type="button" onClick={onLoadImages}>Load images <kbd>I</kbd></button>
          <button type="button" onClick={onAlwaysLoadImages}>Always from {blocked.length === 1 ? 'this sender' : 'these senders'} <kbd>⇧I</kbd></button>
        </div>
      )}
      {messages ? <MailFrame threadKey={threadKey} messages={messages} allow={allow} remote={remote} handle={frame} onAttachment={onAttachment} theme={theme} /> : <p className="pending">Loading…</p>}
    </section>
  );
});
