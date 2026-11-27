// ?: a sheet listing every key. Esc or ? closes it.
import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ActionDef } from './commands/keys';
import { helpSections } from './commands/help';

export function KeyHelp({ actions, onClose }: { actions: readonly ActionDef[]; onClose: () => void }) {
  const sheet = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => sheet.current?.focus(), []);
  return createPortal(
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        ref={sheet}
        className="sheet key-help"
        role="dialog"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || e.key === '?') {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <h2>Keys <span className="help">· everything is also in ⌘K · change them in keymap.json</span></h2>
        <div className="key-help-columns">
          {helpSections(actions).map((s) => (
            <section key={s.title}>
              <h3>{s.title}</h3>
              <dl>
                {s.rows.map((r) => (
                  <div key={r.name} className="key-row">
                    <dt>{r.name}</dt>
                    <dd>{r.keys.map((k) => <kbd key={k}>{k}</kbd>)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
