// An address field that suggests people as you type the current entry (after the last comma).
// Arrows move, Tab or Enter picks, Esc dismisses. Typing a comma just starts the next entry.
import { forwardRef, useEffect, useRef, useState } from 'react';
import { formatAddresses } from '../core/addresses';
import type { Address } from '../core/types';

/** The entry being typed: everything after the last separator outside quotes and angle brackets. */
export interface CurrentEntry {
  head: string;
  entry: string;
}

export function currentEntry(value: string): CurrentEntry {
  let quoted = false;
  let angle = 0;
  let cut = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"') {quoted = !quoted;}
    else if (ch === '<' && !quoted) {angle++;}
    else if (ch === '>' && !quoted) {angle = Math.max(0, angle - 1);}
    else if ((ch === ',' || ch === ';') && !quoted && !angle) {cut = i + 1;}
  }
  return { head: value.slice(0, cut), entry: value.slice(cut).trim() };
}

export const AddressField = forwardRef<HTMLInputElement, {
  value: string;
  onChange: (v: string) => void;
  suggest: (query: string) => Promise<Array<Address>>;
}>(function AddressField({ value, onChange, suggest }, ref) {
  const [options, setOptions] = useState<Array<Address>>([]);
  const [index, setIndex] = useState(0);
  const asked = useRef(0);

  useEffect(() => {
    const { entry } = currentEntry(value);
    if (entry.length < 1 || entry.includes('<')) {return setOptions([]);}
    const n = ++asked.current;
    void suggest(entry).then((list) => {
      if (n !== asked.current) {return;}
      // Nothing to suggest once the entry is exactly a suggestion.
      setOptions(list.length === 1 && list[0]?.address === entry.toLowerCase() ? [] : list);
      setIndex(0);
    });
  }, [value, suggest]);

  const pick = (a: Address) => {
    onChange(`${currentEntry(value).head}${currentEntry(value).head ? ' ' : ''}${formatAddresses([a])}, `);
    setOptions([]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!options.length) {return;}
    if (e.key === 'ArrowDown') {setIndex((i) => Math.min(options.length - 1, i + 1));}
    else if (e.key === 'ArrowUp') {setIndex((i) => Math.max(0, i - 1));}
    else if ((e.key === 'Tab' || e.key === 'Enter') && !e.metaKey && !e.ctrlKey) {
      const chosen = options[index];
      if (!chosen) {return;}
      pick(chosen);
    }
    else if (e.key === 'Escape') {setOptions([]);}
    else {return;}
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <span className="address-field">
      <input ref={ref} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} onBlur={() => setOptions([])} spellCheck={false}
        role="combobox" aria-expanded={options.length > 0} aria-autocomplete="list" />
      {options.length > 0 && (
        <ul className="suggestions" role="listbox">
          {options.map((a, i) => (
            <li key={a.address} role="option" aria-selected={i === index} className={i === index ? 'selected' : ''} onMouseDown={(e) => {
              e.preventDefault();
              pick(a);
            }}>
              {a.name ? <><span>{a.name}</span> <span className="address">{a.address}</span></> : <span>{a.address}</span>}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
});
