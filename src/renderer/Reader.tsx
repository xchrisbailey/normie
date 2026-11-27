// The reader, in the column: Back and the Thread's actions, its subject, a quiet bar when remote images are hidden,
// and the sandboxed mail frame.
import { Toolbar, ToolbarButton } from '@ui-sdk/react/toolbar';
import { memo, useCallback } from 'react';
import type { ReactNode } from 'react';
import type { ThreadMessage } from '../core/types';
import { ActionTip } from './ActionTip';
import type { ActionRunner } from './ActionTip';
import type { ActionId } from './commands/registry';
import { BackIcon, DoneIcon, ReplyIcon, SnoozeIcon } from './icons';
import { MailFrame } from './MailFrame';
import type { AttachmentAction, FrameHandle } from './MailFrame';
import { sanitized } from './sanitize-cache';

/** Messages whose remote images are hidden right now. */
export function blockedMessages(messages: Array<ThreadMessage> | undefined, allowed: ReadonlySet<number>): Array<ThreadMessage> {
  return (messages ?? []).filter((m) => m.html && !m.imagesAllowed && !allowed.has(m.id) && sanitized(m, false).remoteImages > 0);
}

function Act({ id, label, runner, children }: { id: ActionId; label: string; runner: ActionRunner; children: ReactNode }) {
  return (
    <ActionTip id={id} label={label} runner={runner} render={<ToolbarButton className="act" data-act={id} aria-label={label} onClick={() => runner.run(id)} />}>
      {children}
    </ActionTip>
  );
}

export const Reader = memo(function Reader({
  threadKey,
  subject,
  messages,
  allowed,
  frame,
  onLoadImages,
  onAlwaysLoadImages,
  onAttachment,
  theme,
  back,
  runner,
}: {
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
  /** Where Back goes: the open Split's name, or Search. */
  back: string;
  runner: ActionRunner;
}) {
  const allow = useCallback((m: ThreadMessage) => m.imagesAllowed || allowed.has(m.id), [allowed]);
  const blocked = blockedMessages(messages, allowed);
  const remote = (messages ?? []).some((m) => m.html && allow(m));
  return (
    <section className="reader" aria-label="Reader">
      <Toolbar className="reader-bar" aria-label="Thread">
        <ToolbarButton className="back" aria-label={`Back to ${back}`} onClick={() => runner.run('reader.close')}>
          <BackIcon />
          {back}
          <kbd>{runner.key('reader.close') ?? 'esc'}</kbd>
        </ToolbarButton>
        <span className="grow" />
        <Act id="compose.reply" label="Reply" runner={runner}>
          <ReplyIcon />
        </Act>
        <Act id="thread.snooze" label="Snooze" runner={runner}>
          <SnoozeIcon />
        </Act>
        <Act id="thread.done" label="Done" runner={runner}>
          <DoneIcon />
        </Act>
      </Toolbar>
      <h1>{subject || '(no subject)'}</h1>
      {blocked.length > 0 && (
        <div className="images-bar" role="note">
          <span>Remote images are hidden. Loading them tells the sender you opened this.</span>
          <button type="button" onClick={onLoadImages}>
            Load images <kbd>I</kbd>
          </button>
          <button type="button" onClick={onAlwaysLoadImages}>
            Always from {blocked.length === 1 ? 'this sender' : 'these senders'} <kbd>⇧I</kbd>
          </button>
        </div>
      )}
      {messages ? (
        <MailFrame threadKey={threadKey} messages={messages} allow={allow} remote={remote} handle={frame} onAttachment={onAttachment} theme={theme} />
      ) : (
        <p className="pending">Loading…</p>
      )}
    </section>
  );
});
