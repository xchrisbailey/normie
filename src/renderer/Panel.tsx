// A panel that drops from the header over the column: a ui-sdk Dialog, open while it's rendered. The list behind it
// blurs, Escape or a press outside closes it, and focus goes back where it was.
import { Dialog, DialogBackdrop, DialogContent, DialogTitle } from '@ui-sdk/react/dialog';
import type { ReactNode } from 'react';

export function Panel({
  title,
  className,
  onClose,
  initialFocus,
  dismissible = true,
  children,
}: {
  /** Names the panel for screen readers. */
  title: string;
  className?: string;
  onClose: () => void;
  /** A selector for where focus starts, when not the first field. */
  initialFocus?: string;
  /** False when the panel closes itself, as Compose does to save its draft. */
  dismissible?: boolean;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      dismissible={dismissible}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogBackdrop className="panel-backdrop" />
      <DialogContent className={className ? `panel ${className}` : 'panel'} initialFocus={initialFocus}>
        <DialogTitle className="visually-hidden">{title}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}
