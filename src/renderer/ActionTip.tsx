// Buttons that run a keymap action show its name and key in a tooltip, as the header's icons do.
import { Tooltip, TooltipContent, TooltipTrigger } from '@ui-sdk/react/tooltip';
import type { ReactElement, ReactNode } from 'react';
import type { ActionId } from './commands/registry';

/** Runs actions as the keymap would, and says which key each one has. */
export interface ActionRunner {
  run: (id: ActionId) => void;
  /** The action's first key, labelled for display, or undefined when it has none. */
  key: (id: ActionId) => string | undefined;
}

export function ActionTip({
  id,
  label,
  runner,
  render,
  children,
}: {
  id: ActionId;
  label: string;
  runner: ActionRunner;
  /** The button, with its own click handler. */
  render: ReactElement;
  children: ReactNode;
}) {
  const key = runner.key(id);
  return (
    <Tooltip delay={400}>
      <TooltipTrigger render={render}>{children}</TooltipTrigger>
      <TooltipContent className="tip" side="bottom" sideOffset={6}>
        {label}
        {key && <kbd>{key}</kbd>}
      </TooltipContent>
    </Tooltip>
  );
}
