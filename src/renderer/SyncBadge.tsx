// A quiet mark for changes on their way to the server, and a toast when one had to be undone. Never a dialog.
import { useEffect, useState } from 'react';
import type { PendingStatus } from '../core/types';
import type { CoreClient } from './core-client';
import { failureNote } from './Toasts';

export function SyncBadge({ core }: { core: CoreClient | null }) {
  const [status, setStatus] = useState<PendingStatus>({ count: 0, waiting: 0 });

  useEffect(() => {
    if (!core) {
      return;
    }
    void core.pending().then(setStatus);
    const off = core.onNotice((n) => {
      if (n.type === 'pending') {
        setStatus({ count: n.count, waiting: n.waiting });
      }
      if (n.type === 'change-failed') {
        failureNote(`Couldn't change "${n.subject}" on the server, so it's back as it was`);
      }
    });
    return off;
  }, [core]);

  return status.waiting > 0 ? (
    <span className="sync-badge" title={`${status.count} change${status.count === 1 ? '' : 's'} waiting for the server; retrying`}>
      ↻ {status.count}
    </span>
  ) : null;
}
