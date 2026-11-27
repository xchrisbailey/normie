// A quiet badge for changes on their way to the server, and a short note when one had to be undone. Never a dialog.
import { useEffect, useState } from 'react';
import type { PendingStatus } from '../core/types';
import type { CoreClient } from './core-client';

const NOTE_MS = 8000;

export function SyncBadge({ core }: { core: CoreClient | null }) {
  const [status, setStatus] = useState<PendingStatus>({ count: 0, waiting: 0 });
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!core) {
      return;
    }
    void core.pending().then(setStatus);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = core.onNotice((n) => {
      if (n.type === 'pending') {
        setStatus({ count: n.count, waiting: n.waiting });
      }
      if (n.type === 'change-failed') {
        setNote(`Couldn't change "${n.subject}" on the server, so it's back as it was`);
        clearTimeout(timer);
        timer = setTimeout(() => setNote(null), NOTE_MS);
      }
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [core]);

  return (
    <>
      {status.waiting > 0 && (
        <span className="sync-badge" title={`${status.count} change${status.count === 1 ? '' : 's'} waiting for the server; retrying`}>
          ↻ {status.count}
        </span>
      )}
      {note && <span className="sync-note">{note}</span>}
    </>
  );
}
