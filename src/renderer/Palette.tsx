// Cmd-K: a fuzzy palette over every action that applies where the user is, Labels, drafts and scheduled messages.
// A ui-sdk Command in a Panel; the ranking is ours, so the Command keeps the order it's given.
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList, createCommandController } from '@ui-sdk/react/command';
import { useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { rankItems } from './commands/palette';
import type { PaletteItem } from './commands/palette';
import { Panel } from './Panel';

/**
 * The palette's own keys on its field: Escape (and Cmd-K again) close it at once, rather than first clearing the text,
 * and Ctrl-N and Ctrl-P move like the arrows.
 */
export function paletteKeys(e: KeyboardEvent, onClose: () => void, move: (by: number) => void) {
  const k = e.key.toLowerCase();
  if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && k === 'k')) {
    onClose();
  } else if (e.ctrlKey && (k === 'n' || k === 'p')) {
    move(k === 'n' ? 1 : -1);
  } else {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
}

/** Moves a Command's highlight by `by` places among `values`. */
export function moveHighlight(controller: ReturnType<typeof createCommandController>, values: ReadonlyArray<string>, by: number) {
  const at = values.indexOf(controller.getValue() ?? '');
  const next = values[Math.max(0, Math.min(values.length - 1, at + by))];
  if (next !== undefined) {
    controller.setValue(next);
  }
}

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
  const shown = useMemo(() => rankItems(query, items), [query, items]);
  const [controller] = useState(() => createCommandController());
  return (
    <Panel title={placeholder} className="palette" onClose={onClose}>
      <Command
        controller={controller}
        query={query}
        onQueryChange={setQuery}
        filter={false}
        onAction={(id) => {
          const item = shown.find((i) => i.id === id);
          if (item) {
            onRun(item);
          }
        }}
      >
        <CommandInput
          placeholder={placeholder}
          aria-label={placeholder}
          spellCheck={false}
          onKeyDown={(e) =>
            paletteKeys(e, onClose, (by) =>
              moveHighlight(
                controller,
                shown.map((i) => i.id),
                by,
              ),
            )
          }
        />
        <CommandList className="palette-list">
          {shown.map((item) => (
            <CommandItem key={item.id} value={item.id} label={item.name} className="palette-item">
              <span>{item.name}</span>
              {item.hint && <kbd>{item.hint}</kbd>}
            </CommandItem>
          ))}
        </CommandList>
        <CommandEmpty className="palette-none">No matches</CommandEmpty>
      </Command>
    </Panel>
  );
}
