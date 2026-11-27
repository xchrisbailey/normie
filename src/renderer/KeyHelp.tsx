// ?: a panel listing every key. Esc or ? closes it.
import type { ActionDef } from './commands/keys';
import { helpSections } from './commands/help';
import { Panel } from './Panel';

export function KeyHelp({ actions, onClose }: { actions: ReadonlyArray<ActionDef>; onClose: () => void }) {
  return (
    <Panel title="Keyboard shortcuts" className="key-help" onClose={onClose} initialFocus=".key-help-body">
      <div
        className="key-help-body"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === '?') {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <h2>
          Keys <span className="help">· everything is also in ⌘K · change them in keymap.json</span>
        </h2>
        <div className="key-help-columns">
          {helpSections(actions).map((s) => (
            <section key={s.title}>
              <h3>{s.title}</h3>
              <dl>
                {s.rows.map((r) => (
                  <div key={r.name} className="key-row">
                    <dt>{r.name}</dt>
                    <dd>
                      {r.keys.map((k) => (
                        <kbd key={k}>{k}</kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </Panel>
  );
}
