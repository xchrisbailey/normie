// The composer: To, Cc, Bcc, Subject and a Markdown body. Cmd-Enter sends, Esc closes.
// Loaded lazily, so it costs nothing at launch.
import { useLayoutEffect, useRef, useState } from 'react';
import { formatAddresses, parseAddresses } from '../core/addresses';
import type { Address, OutgoingMessage } from '../core/types';

export interface Identity {
  accountId: string;
  from: Address;
}

/** What the composer starts with: a new message, a reply, or a message taken back from the Outbox. */
export type ComposeStart = Partial<OutgoingMessage> & { accountId?: string };

export default function Composer({ start, identities, onSend, onClose }: {
  start: ComposeStart;
  identities: Identity[];
  onSend: (m: OutgoingMessage) => void;
  onClose: () => void;
}) {
  const first = identities.find((i) => i.accountId === start.accountId && (!start.from || i.from.address === start.from.address)) ?? identities[0];
  const [identity, setIdentity] = useState(first ? identities.indexOf(first) : 0);
  const [to, setTo] = useState(formatAddresses(start.to ?? []));
  const [cc, setCc] = useState(formatAddresses(start.cc ?? []));
  const [bcc, setBcc] = useState(formatAddresses(start.bcc ?? []));
  const [showCopies, setShowCopies] = useState(!!(start.cc?.length || start.bcc?.length));
  const [subject, setSubject] = useState(start.subject ?? '');
  const [body, setBody] = useState(start.body ?? '');
  const [error, setError] = useState<string | null>(null);
  const toField = useRef<HTMLInputElement>(null);
  const bodyField = useRef<HTMLTextAreaElement>(null);

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
    onSend({
      accountId: id.accountId, from: id.from, to: lists[0]!.addresses, cc: lists[1]!.addresses, bcc: lists[2]!.addresses, subject, body,
      ...(start.inReplyTo ? { inReplyTo: start.inReplyTo } : {}),
      ...(start.references?.length ? { references: start.references } : {}),
      ...(start.attachments?.length ? { attachments: start.attachments } : {}),
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <section className="composer" aria-label="Compose" onKeyDown={onKeyDown}>
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
          <input ref={toField} value={to} onChange={(e) => setTo(e.target.value)} spellCheck={false} />
          {!showCopies && <button type="button" className="link" onClick={() => setShowCopies(true)} tabIndex={-1}>Cc Bcc</button>}
        </label>
        {showCopies && (
          <>
            <label><span>Cc</span><input value={cc} onChange={(e) => setCc(e.target.value)} spellCheck={false} /></label>
            <label><span>Bcc</span><input value={bcc} onChange={(e) => setBcc(e.target.value)} spellCheck={false} /></label>
          </>
        )}
        <label><span>Subject</span><input value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
      </div>
      <textarea ref={bodyField} className="body" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write in Markdown" />
      <footer>
        {error ? <span className="error">{error}</span> : <span className="hint">Markdown · ⌘↩ send · Esc close</span>}
        <button type="button" className="primary" onClick={send}>Send</button>
      </footer>
    </section>
  );
}
