// The composer: To, Cc, Bcc, Subject and a Markdown body. Cmd-Enter sends, Esc closes.
// Loaded lazily, so it costs nothing at launch.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatAddresses, parseAddresses } from '../core/addresses';
import { AddressField } from './AddressField';
import { WhenPicker } from './WhenPicker';
import { describeWhen } from '../core/when';
import { expandAt, insertAt } from './commands/snippets';
import type { Snippet } from './commands/snippets';
import type { Address, DraftContent, OutgoingMessage } from '../core/types';

export interface Identity {
  accountId: string;
  from: Address;
}

/** What the composer starts with: a new message, a reply, a draft, or a message taken back from the Outbox. */
export type ComposeStart = Partial<OutgoingMessage> & {
  accountId?: string;
  /** The draft this continues. */
  draftId?: number;
  /** Address fields as typed, from a draft. */
  toText?: string;
  ccText?: string;
  bccText?: string;
};

/** How long typing pauses before the draft is saved. */
const DRAFT_SAVE_MS = 800;
/** Gmail's limit for a message's attachments, all told. */
const ATTACHMENT_LIMIT = 25 * 1024 * 1024;

type Attachment = NonNullable<OutgoingMessage['attachments']>[number];
const same = (a?: Address, b?: Address) => !!a && !!b && a.address.toLowerCase() === b.address.toLowerCase();
const sizeOf = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

async function readFiles(files: FileList | Array<File>): Promise<Array<Attachment>> {
  return Promise.all(
    [...files].map(async (f) => ({ filename: f.name, contentType: f.type || 'application/octet-stream', content: new Uint8Array(await f.arrayBuffer()) })),
  );
}

/** What the app can do to an open composer: insert text at the cursor in the body (a snippet from the palette). */
export interface ComposerHandle {
  insert(text: string): void;
}

export default function Composer({
  start,
  identities,
  onSend,
  onClose,
  onSaveDraft,
  onDiscard,
  suggest,
  snippets,
  handle: handleRef,
}: {
  start: ComposeStart;
  identities: Array<Identity>;
  /** `sendAt` for Send Later. */
  onSend: (m: OutgoingMessage, draftId?: number, sendAt?: number) => void;
  onClose: () => void;
  /** Save the draft; resolves with its id. */
  onSaveDraft: (draftId: number | null, content: DraftContent) => Promise<number>;
  onDiscard: (draftId: number | null) => void;
  /** People to suggest in address fields. */
  suggest: (query: string) => Promise<Array<Address>>;
  snippets: ReadonlyArray<Snippet>;
  handle?: React.MutableRefObject<ComposerHandle | null>;
}) {
  const first =
    identities.find((i) => i.accountId === start.accountId && same(i.from, start.from)) ??
    identities.find((i) => i.accountId === start.accountId) ??
    identities[0];
  const [identity, setIdentity] = useState(first ? identities.indexOf(first) : 0);
  const [to, setTo] = useState(start.toText ?? formatAddresses(start.to ?? []));
  const [cc, setCc] = useState(start.ccText ?? formatAddresses(start.cc ?? []));
  const [bcc, setBcc] = useState(start.bccText ?? formatAddresses(start.bcc ?? []));
  const [showCopies, setShowCopies] = useState(!!(start.cc?.length || start.bcc?.length || start.ccText || start.bccText));
  const [subject, setSubject] = useState(start.subject ?? '');
  const [body, setBody] = useState(start.body ?? '');
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Array<Attachment>>(start.attachments ?? []);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const attach = (files: FileList | Array<File> | null) => {
    if (files?.length) {
      void readFiles(files).then((list) => setAttachments((a) => [...a, ...list]));
    }
  };
  const toField = useRef<HTMLInputElement>(null);
  const bodyField = useRef<HTMLTextAreaElement>(null);
  /** Where to put the cursor after the body changes from code (a snippet). */
  const nextCursor = useRef<number | null>(null);
  const lastSelection = useRef({ start: (start.body ?? '').length, end: (start.body ?? '').length });
  useLayoutEffect(() => {
    if (nextCursor.current === null || !bodyField.current) {
      return;
    }
    bodyField.current.focus();
    bodyField.current.setSelectionRange(nextCursor.current, nextCursor.current);
    // Setting the cursor from code fires no select event.
    lastSelection.current = { start: nextCursor.current, end: nextCursor.current };
    nextCursor.current = null;
  }, [body]);
  const keepSelection = (el: HTMLTextAreaElement) => (lastSelection.current = { start: el.selectionStart, end: el.selectionEnd });
  // After every commit, so `insert` always sees the current body.
  useLayoutEffect(() => {
    if (handleRef) {
      handleRef.current = {
        insert: (text) => {
          const { start: s, end } = lastSelection.current;
          const r = insertAt(body, Math.min(s, body.length), Math.min(end, body.length), text);
          nextCursor.current = r.cursor;
          setBody(r.text);
        },
      };
    }
  });
  const onBodyKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) {
      return;
    }
    const el = e.currentTarget;
    if (el.selectionStart !== el.selectionEnd) {
      return;
    }
    const r = expandAt(body, el.selectionStart, snippets);
    if (!r) {
      return;
    }
    e.preventDefault();
    nextCursor.current = r.cursor;
    setBody(r.text);
  };

  // The draft: saved a moment after typing stops, and once more on close. Nothing is saved until something is typed.
  const draftId = useRef<number | null>(start.draftId ?? null);
  const saving = useRef<Promise<number> | null>(null);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const content = (): DraftContent => {
    const id = identities[identity];
    const draft: DraftContent = { accountId: id?.accountId ?? start.accountId ?? '', to, cc, bcc, subject, body };
    if (id) {
      draft.from = id.from;
    }
    if (start.inReplyTo) {
      draft.inReplyTo = start.inReplyTo;
    }
    if (start.references) {
      draft.references = start.references;
    }
    if (attachments.length) {
      draft.attachments = attachments;
    }
    return draft;
  };
  const latestContent = useRef(content);
  // After every commit, so a save (a timer, a promise) reads what's on screen.
  useLayoutEffect(() => {
    latestContent.current = content;
  });
  const saveNow = () => {
    clearTimeout(timer.current);
    if (!dirty.current) {
      return;
    }
    dirty.current = false;
    const after = saving.current ?? Promise.resolve(draftId.current);
    saving.current = after.then((id) => onSaveDraft(id, latestContent.current())).then((id) => (draftId.current = id));
  };
  const mounted = useRef(true);
  useEffect(() => {
    if (mounted.current) {
      return void (mounted.current = false);
    }
    dirty.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(saveNow, DRAFT_SAVE_MS);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs when the content changes; saveNow reads refs
  }, [to, cc, bcc, subject, body, identity, attachments]);
  const close = () => {
    saveNow();
    onClose();
  };
  const discard = () => {
    clearTimeout(timer.current);
    dirty.current = false;
    void (saving.current ?? Promise.resolve(draftId.current)).then((id) => onDiscard(id));
    onClose();
  };

  useLayoutEffect(() => {
    const field = start.to?.length ? bodyField.current : toField.current;
    field?.focus();
    // A reply starts above the quote.
    if (field === bodyField.current) {
      bodyField.current?.setSelectionRange(0, 0);
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- place the cursor once, when the Composer opens
  }, []);

  const [picking, setPicking] = useState<null | 'later' | 'reminder'>(null);
  /** A Reminder: bring the Thread back if nobody answers by then. */
  const [remindAt, setRemindAt] = useState<number | undefined>(start.remindAt);
  /** When the Reminder was set or the composer opened: what its time reads relative to (the clock isn't read in render). */
  const [remindShownAt, setRemindShownAt] = useState(() => Date.now());
  const send = (sendAt?: number) => {
    const id = identities[identity];
    if (!id) {
      return setError('Add an Account before sending.');
    }
    const toList = parseAddresses(to);
    const ccList = parseAddresses(cc);
    const bccList = parseAddresses(bcc);
    const lists = [toList, ccList, bccList];
    const invalid = lists.flatMap((l) => l.invalid);
    if (invalid.length) {
      return setError(`Not an address: ${invalid.join(', ')}`);
    }
    if (!lists.some((l) => l.addresses.length)) {
      return setError('Add at least one recipient.');
    }
    const total = attachments.reduce((n, a) => n + a.content.length, 0);
    if (total > ATTACHMENT_LIMIT) {
      return setError(`Attachments come to ${sizeOf(total)}; the limit is 25 MB.`);
    }
    clearTimeout(timer.current);
    dirty.current = false;
    const message: OutgoingMessage = {
      accountId: id.accountId,
      from: id.from,
      to: toList.addresses,
      cc: ccList.addresses,
      bcc: bccList.addresses,
      subject,
      body,
    };
    if (start.inReplyTo) {
      message.inReplyTo = start.inReplyTo;
    }
    if (start.references?.length) {
      message.references = start.references;
    }
    if (attachments.length) {
      message.attachments = attachments;
    }
    if (remindAt !== undefined) {
      message.remindAt = remindAt;
    }
    // Wait for a save in flight, so the draft it creates is the one removed.
    if (saving.current) {
      void saving.current.then((d) => onSend(message, d, sendAt));
    } else {
      onSend(message, draftId.current ?? undefined, sendAt);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
      // Send Later: choose when first.
      e.preventDefault();
      setPicking('later');
    } else if (e.key.toLowerCase() === 'h' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setPicking('reminder');
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key.toLowerCase() === 'a' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      picker.current?.click();
    } else if (e.key === 'Backspace' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      discard();
    }
  };

  return (
    <section
      className={dragging ? 'composer dragging' : 'composer'}
      aria-label="Compose"
      onKeyDown={onKeyDown}
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) {
          return;
        }
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        attach(e.dataTransfer.files);
      }}
    >
      <div className="fields">
        {identities.length > 1 ? (
          <label>
            <span>From</span>
            <select value={identity} onChange={(e) => setIdentity(Number(e.target.value))}>
              {identities.map((i, n) => (
                <option key={`${i.accountId}:${i.from.address}`} value={n}>
                  {i.from.name ? `${i.from.name} <${i.from.address}>` : i.from.address}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label>
            <span>From</span>
            <output>
              {identities[0]
                ? identities[0].from.name
                  ? `${identities[0].from.name} <${identities[0].from.address}>`
                  : identities[0].from.address
                : 'No Account'}
            </output>
          </label>
        )}
        <label>
          <span>To</span>
          <AddressField ref={toField} value={to} onChange={setTo} suggest={suggest} />
          {!showCopies && (
            <button type="button" className="link" onClick={() => setShowCopies(true)} tabIndex={-1}>
              Cc Bcc
            </button>
          )}
        </label>
        {showCopies && (
          <>
            <label>
              <span>Cc</span>
              <AddressField value={cc} onChange={setCc} suggest={suggest} />
            </label>
            <label>
              <span>Bcc</span>
              <AddressField value={bcc} onChange={setBcc} suggest={suggest} />
            </label>
          </>
        )}
        <label>
          <span>Subject</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
      </div>
      <textarea
        ref={bodyField}
        className="body"
        value={body}
        onChange={(e) => {
          keepSelection(e.target);
          setBody(e.target.value);
        }}
        onKeyDown={onBodyKeyDown}
        onSelect={(e) => keepSelection(e.currentTarget)}
        placeholder="Write in Markdown"
      />
      {attachments.length > 0 && (
        <ul className="attachments" aria-label="Attachments">
          {attachments.map((a, i) => (
            <li key={`${a.filename}:${i}`}>
              <span>{a.filename}</span>
              <span className="size">{sizeOf(a.content.length)}</span>
              <button type="button" aria-label={`Remove ${a.filename}`} onClick={() => setAttachments((list) => list.filter((_, n) => n !== i))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {picking && (
        <WhenPicker
          title={picking === 'later' ? 'Send at' : 'Remind me if no reply by'}
          onClose={() => {
            setPicking(null);
            bodyField.current?.focus();
          }}
          onPick={(at) => {
            setPicking(null);
            if (picking === 'later') {
              send(at);
            } else {
              setRemindAt(at);
              setRemindShownAt(Date.now());
              bodyField.current?.focus();
            }
          }}
        />
      )}
      {remindAt !== undefined && (
        <div className="reminder-line">
          ⏰ Back in the Inbox {describeWhen(new Date(remindAt), new Date(remindShownAt))} if nobody replies
          <button type="button" className="quiet" onClick={() => setRemindAt(undefined)} aria-label="Remove the Reminder">
            ×
          </button>
        </div>
      )}
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          attach(e.target.files);
          e.target.value = '';
        }}
      />
      <footer>
        {error ? (
          <span className="error">{error}</span>
        ) : (
          <span className="hint">Markdown · ⌘↩ send · ⌘⇧↩ send later · ⌘⇧H remind · ⌘⇧A attach · Esc keeps a draft · ⌘⇧⌫ discard</span>
        )}
        <span className="actions">
          <button type="button" className="quiet" onClick={discard}>
            Discard
          </button>
          <button type="button" className="quiet" onClick={() => setPicking('reminder')}>
            Remind Me…
          </button>
          <button type="button" className="quiet" onClick={() => setPicking('later')}>
            Send Later…
          </button>
          <button type="button" className="primary" onClick={() => send()}>
            Send
          </button>
        </span>
      </footer>
    </section>
  );
}
