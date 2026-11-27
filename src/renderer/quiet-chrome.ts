// While the keys move through the list or a Thread, the header steps back; moving the mouse brings it back. Set on the
// root directly, not through React, so a key press re-renders nothing for it.

/** Actions that read or triage: the header has nothing to say while these run. */
const QUIETS = /^(list|reader|thread)\./;

export function quietFor(id: string) {
  if (QUIETS.test(id) && !('quiet' in document.documentElement.dataset)) {
    document.documentElement.dataset.quiet = '';
  }
}

/** Brings the header back on a real mouse move. Chromium also sends moves when the page scrolls under a still pointer: those keep their place. */
export function wakeOnMouse() {
  let x = Number.NaN;
  let y = Number.NaN;
  const onMove = (e: MouseEvent) => {
    if (e.clientX === x && e.clientY === y) {
      return;
    }
    x = e.clientX;
    y = e.clientY;
    if ('quiet' in document.documentElement.dataset) {
      delete document.documentElement.dataset.quiet;
    }
  };
  window.addEventListener('mousemove', onMove, { passive: true });
  return () => window.removeEventListener('mousemove', onMove);
}
