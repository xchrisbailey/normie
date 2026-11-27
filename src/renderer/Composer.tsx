// The composer: To, Cc, Bcc, Subject and a Markdown body. Cmd-Enter sends, Esc closes.
// Loaded lazily, so it costs nothing at launch.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatAddresses, parseAddresses } from '../core/addresses';
import { AddressField } from './AddressField';
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
const sizeOf = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

async function readFiles(files: FileList | File[]): Promise<Attachment[]> {
  return Promise.all([...files].map(async (f) => ({ filename: f.name, contentType: f.type || 'application/octet-stream', content: new Uint8Array(await f.arrayBuffer()) })));
}

export default function Composer({ start, identities, onSend, onClose, onSaveDraft, onDiscard, suggest }: {
  start: ComposeStart;
  identities: Identity[];
  onSend: (m: OutgoingMessage, draftId?: number) => void;
  onClose: () => void;
  /** Save the draft; resolves with its id. */
  onSaveDraft: (draftId: number | null, content: DraftContent) => Promise<number>;
  onDiscard: (draftId: number | null) => void;
  /** People to suggest in address fields. */
  suggest: (query: string) => Promise<Address[]>;
}) {
  const same = (a?: Address, b?: Address) => !!a && !!b && a.address.toLowerCase() === b.address.toLowerCase();
  const first = identities.find((i) => i.accountId === start.accountId && same(i.from, start.from))
    ?? identities.find((i) => i.accountId === start.accountId) ?? identities[0];
  const [identity, setIdentity] = useState(first ? identities.indexOf(first) : 0);
  const [to, setTo] = useState(start.toText ?? formatAddresses(start.to ?? []));
  const [cc, setCc] = useState(start.ccText ?? formatAddresses(start.cc ?? []));
  const [bcc, setBcc] = useState(start.bccText ?? formatAddresses(start.bcc ?? []));
  const [showCopies, setShowCopies] = useState(!!(start.cc?.length || start.bcc?.length || start.ccText || start.bccText));
  const [subject, setSubject] = useState(start.subject ?? '');
  const [body, setBody] = useState(start.body ?? '');
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>(start.attachments ?? []);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const attach = (files: FileList | File[] | null) => {
    if (files?.length) void readFiles(files).then((list) => setAttachments((a) => [...a, ...list]));
  };
  const toField = useRef<HTMLInputElement>(null);
  const bodyField = useRef<HTMLTextAreaElement>(null);

  // The draft: saved a moment after typing stops, and once more on close. Nothing is saved until something is typed.
  const draftId = useRef<number | null>(start.draftId ?? null);
  const saving = useRef<Promise<number> | null>(null);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const content = (): DraftContent => {
    const id = identities[identity];
    return {
      accountId: id?.accountId ?? start.accountId ?? '', ...(id ? { from: id.from } : {}), to, cc, bcc, subject, body,
      ...(start.inReplyTo ? { inReplyTo: start.inReplyTo } : {}), ...(start.references ? { references: start.references } : {}),
      ...(attachments.length ? { attachments } : {}),
    };
  };
  const latestContent = useRef(content);
  latestContent.current = content;
  const saveNow = () => {
    clearTimeout(timer.current);
    if (!dirty.current) return;
    dirty.current = false;
    const after = saving.current ?? Promise.resolve(draftId.current);
    saving.current = after.then((id) => onSaveDraft(id, latestContent.current())).then((id) => (draftId.current = id));
  };
  const mounted = useRef(true);
  useEffect(() => {
    if (mounted.current) return void (mounted.current = false);
    dirty.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(saveNow, DRAFT_SAVE_MS);
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
    if (field === bodyField.current) bodyField.current?.setSelectionRange(0, 0);
  }, []);

  const send = () => {
    const id = identities[identity];
    if (!id) return setError('Add an Account before sending.');
    const lists = [parseAddresses(to), parseAddresses(cc), parseAddresses(bcc)];
    const invalid = lists.flatMap((l) => l.invalid);
    if (invalid.length) return setError(`Not an address: ${invalid.join(', ')}`);
    if (!lists.some((l) => l.addresses.length)) return setError('Add at least one recipient.');
    const total = attachments.reduce((n, a) => n + a.content.length, 0);
    if (total > ATTACHMENT_LIMIT) return setError(`Attachments come to ${sizeOf(total)}; the limit is 25 MB.`);
    clearTimeout(timer.current);
    dirty.current = false;
    const message: OutgoingMessage = {
      accountId: id.accountId, from: id.from, to: lists[0]!.addresses, cc: lists[1]!.addresses, bcc: lists[2]!.addresses, subject, body,
      ...(start.inReplyTo ? { inReplyTo: start.inReplyTo } : {}),
      ...(start.references?.length ? { references: start.references } : {}),
      ...(attachments.length ? { attachments } : {}),
    };
    // Wait for a save in flight, so the draft it creates is the one removed.
    if (saving.current) void saving.current.then((d) => onSend(message, d));
    else onSend(message, draftId.current ?? undefined);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
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
        if (![...e.dataTransfer.types].includes('Files')) return;
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
              {identities.map((i, n) => <option key={`${i.accountId}:${i.from.address}`} value={n}>{i.from.address}</option>)}
            </select>
          </label>
        ) : (
          <label>
            <span>From</span>
            <output>{identities[0]?.from.address ?? 'No Account'}</output>
          </label>
        )}
        <label>
          <span>To</span>
          <AddressField ref={toField} value={to} onChange={setTo} suggest={suggest} />
          {!showCopies && <button type="button" className="link" onClick={() => setShowCopies(true)} tabIndex={-1}>Cc Bcc</button>}
        </label>
        {showCopies && (
          <>
            <label><span>Cc</span><AddressField value={cc} onChange={setCc} suggest={suggest} /></label>
            <label><span>Bcc</span><AddressField value={bcc} onChange={setBcc} suggest={suggest} /></label>
          </>
        )}
        <label><span>Subject</span><input value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
      </div>
      <textarea ref={bodyField} className="body" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write in Markdown" />
      {attachments.length > 0 && (
        <ul className="attachments" aria-label="Attachments">
          {attachments.map((a, i) => (
            <li key={`${a.filename}:${i}`}>
              <span>{a.filename}</span>
              <span className="size">{sizeOf(a.content.length)}</span>
              <button type="button" aria-label={`Remove ${a.filename}`} onClick={() => setAttachments((list) => list.filter((_, n) => n !== i))}>×</button>
            </li>
          ))}
        </ul>
      )}
      <input ref={picker} type="file" multiple hidden onChange={(e) => {
        attach(e.target.files);
        e.target.value = '';
      }} />
      <footer>
        {error ? <span className="error">{error}</span> : <span className="hint">Markdown · ⌘↩ send · ⌘⇧A attach · Esc keeps a draft · ⌘⇧⌫ discard</span>}
        <span className="actions">
          <button type="button" className="quiet" onClick={discard}>Discard</button>
          <button type="button" className="primary" onClick={send}>Send</button>
        </span>
      </footer>
    </section>
  );
}
