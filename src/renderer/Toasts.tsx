// Notes and data-folder problems, as toasts at the foot of the column.
import { Toast, ToastClose, ToastDescription, ToastRegion, ToastTitle, toast } from '@ui-sdk/react/toast';
import { useEffect } from 'react';

/** A short message that goes by itself. A new one replaces the one showing. */
export function note(text: string) {
  toast(text, { id: 'note', duration: 8000 });
}

/** A change the server refused, undone here: it stays a little longer, and is announced at once. */
export function failureNote(text: string) {
  toast.error(text, { duration: 12_000 });
}

/** A data-folder file's problems (splits.json, keymap.json…) stay up until they're fixed or dismissed. */
export function useProblems(file: string, problems: ReadonlyArray<string>) {
  const text = problems.join('\n');
  useEffect(() => {
    const id = `problems:${file}`;
    if (!text) {
      toast.dismiss(id);
      return;
    }
    const n = text.split('\n').length;
    toast.warning({ id, title: `${file}: ${n} ${n === 1 ? 'problem' : 'problems'}`, description: text, duration: Infinity });
  }, [file, text]);
}

export function Toasts() {
  return (
    <ToastRegion className="toasts" side="bottom" align="center" maxVisible={3}>
      {() => (
        <Toast className="toast">
          <ToastTitle className="toast-title" />
          <ToastDescription className="toast-description" />
          <ToastClose className="toast-close" aria-label="Dismiss">
            ×
          </ToastClose>
        </Toast>
      )}
    </ToastRegion>
  );
}
