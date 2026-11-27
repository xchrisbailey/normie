// Picking a time in plain words: suggestions to start, and whatever is typed read back as a time.
// Used by Snooze, Send Later and Reminders.
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList, createCommandController } from '@ui-sdk/react/command';
import { useState } from 'react';
import { describeWhen, parseWhen, suggestions } from '../core/when';
import { moveHighlight, paletteKeys } from './Palette';
import { Panel } from './Panel';
import { hour12 } from './prefs';

export function WhenPicker({ title, onPick, onClose }: { title: string; onPick: (at: number) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  // "Now" as of the mount and each keystroke: the clock isn't read while rendering.
  const [now, setNow] = useState(() => new Date());
  const [controller] = useState(() => createCommandController());
  const typed = text.trim() ? parseWhen(text, now) : null;
  const choices = text.trim()
    ? typed
      ? [{ label: describeWhen(typed, now, hour12()), at: typed }]
      : []
    : suggestions(now).map((s) => ({ label: `${s.label} · ${describeWhen(s.at, now, hour12())}`, at: s.at }));
  const values = choices.map((c) => String(c.at.getTime()));

  return (
    <Panel title={title} className="palette" onClose={onClose}>
      <Command
        controller={controller}
        query={text}
        onQueryChange={(next) => {
          setText(next);
          setNow(new Date());
        }}
        filter={false}
        onAction={(value) => onPick(Number(value))}
      >
        <CommandInput
          placeholder={`${title}: tomorrow 9, monday, in 2 hours…`}
          aria-label={title}
          spellCheck={false}
          onKeyDown={(e) => paletteKeys(e, onClose, (by) => moveHighlight(controller, values, by))}
        />
        <CommandList className="palette-list">
          {choices.map((c, i) => (
            <CommandItem key={values[i]} value={values[i]} label={c.label} className="palette-item">
              <span>{c.label}</span>
            </CommandItem>
          ))}
        </CommandList>
        <CommandEmpty className="palette-none">Try “tomorrow 9”, “fri 2pm”, “dec 3” or “in 3 hours”</CommandEmpty>
      </Command>
    </Panel>
  );
}
