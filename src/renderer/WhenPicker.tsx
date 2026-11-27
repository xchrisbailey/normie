// Picking a time in plain words: suggestions to start, and whatever is typed read back as a time.
// Used by Snooze, Send Later and Reminders.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { describeWhen, parseWhen, suggestions } from '../core/when';

export function WhenPicker({ title, onPick, onClose }: { title: string; onPick: (at: number) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => input.current?.focus(), []);
  const now = useMemo(() => new Date(), []);
  const typed = text.trim() ? parseWhen(text, new Date()) : null;
  const choices = text.trim()
    ? typed ? [{ label: describeWhen(typed, new Date()), at: typed }] : []
    : suggestions(now).map((s) => ({ label: `${s.label} · ${describeWhen(s.at, now)}`, at: s.at }));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {onClose();}
    else if (e.key === 'ArrowDown') {setIndex((i) => Math.min(choices.length - 1, i + 1));}
    else if (e.key === 'ArrowUp') {setIndex((i) => Math.max(0, i - 1));}
    else if (e.key === 'Enter' && choices[index]) {onPick(choices[index].at.getTime());}
    else {return;}
    e.preventDefault();
    e.stopPropagation();
  };

  return createPortal(
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <input ref={input} value={text} placeholder={`${title}: tomorrow 9, monday, in 2 hours…`} spellCheck={false}
          onChange={(e) => { setText(e.target.value); setIndex(0); }} onKeyDown={onKeyDown} onBlur={onClose} />
        <ul role="listbox">
          {choices.map((c, i) => (
            <li key={c.at.getTime()} role="option" aria-selected={i === index} className={i === index ? 'selected' : ''} onMouseDown={() => onPick(c.at.getTime())}>
              <span>{c.label}</span>
            </li>
          ))}
          {!choices.length && <li className="none">Try “tomorrow 9”, “fri 2pm”, “dec 3” or “in 3 hours”</li>}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
