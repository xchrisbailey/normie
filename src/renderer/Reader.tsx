// The plain-text reader: every message in the Thread, oldest to newest. HTML rendering is milestone 3.
import { memo } from 'react';
import type { Address, ThreadMessage } from '../core/types';

const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const who = (a?: Address) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : 'Unknown sender');

const Message = memo(function Message({ m }: { m: ThreadMessage }) {
  return (
    <article className="message">
      <header>
        <div className="from">{who(m.from)}</div>
        <time>{full.format(m.date)}</time>
        <div className="to">To: {m.to.map(who).join(', ') || '—'}</div>
      </header>
      {m.text === null ? <p className="pending">Downloading this message…</p> : <pre className="body">{m.text || '(no text)'}</pre>}
    </article>
  );
});

export function Reader({ subject, messages }: { subject: string; messages: ThreadMessage[] | undefined }) {
  return (
    <section className="reader" aria-label="Reader">
      <h1>{subject || '(no subject)'}</h1>
      {messages ? messages.map((m) => <Message key={m.id} m={m} />) : <p className="pending">Loading…</p>}
    </section>
  );
}
