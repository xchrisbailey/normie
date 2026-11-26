// The one registry of actions. The key handler, and later the palette and native menus, are views over it.
import type { ActionDef } from './keys';

export const ACTIONS = [
  { id: 'list.down', name: 'Next Thread', keys: ['j', 'ArrowDown'], contexts: ['list'] },
  { id: 'list.up', name: 'Previous Thread', keys: ['k', 'ArrowUp'], contexts: ['list'] },
  { id: 'list.top', name: 'First Thread', keys: ['g g'], contexts: ['list'] },
  { id: 'list.bottom', name: 'Last Thread', keys: ['Shift-G'], contexts: ['list'] },
  { id: 'list.open', name: 'Open Thread', keys: ['Enter', 'o'], contexts: ['list'] },
  { id: 'go.inbox', name: 'Go to Inbox', keys: ['g i'], contexts: ['list', 'reader'] },
] as const satisfies readonly ActionDef[];

export type ActionId = (typeof ACTIONS)[number]['id'];
