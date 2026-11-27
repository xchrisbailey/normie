// Cmd-K: a fuzzy palette over every action that applies where the user is (and, later, Labels and Accounts).
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { rankItems } from './commands/palette';
import type { PaletteItem } from './commands/palette';

export function Palette({
  items,
  onRun,
  onClose,
  placeholder = 'Type a command',
}: {
  items: Array<PaletteItem>;
  onRun: (item: PaletteItem) => void;
  onClose: () => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => rankItems(query, items), [query, items]);

  useLayoutEffect(() => input.current?.focus(), []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n');
    const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p');
    if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) {
      onClose();
    } else if (down) {
      setIndex((i) => Math.min(shown.length - 1, i + 1));
    } else if (up) {
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && shown[index]) {
      onRun(shown[index]);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={query}
          placeholder={placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
          onBlur={onClose}
          spellCheck={false}
          aria-label={placeholder}
        />
        <ul role="listbox">
          {shown.map((item, i) => (
            <li key={item.id} role="option" aria-selected={i === index} className={i === index ? 'selected' : ''} onMouseDown={() => onRun(item)}>
              <span>{item.name}</span>
              {item.hint && <kbd>{item.hint}</kbd>}
            </li>
          ))}
          {!shown.length && <li className="none">No matches</li>}
        </ul>
      </div>
    </div>
  );
}
