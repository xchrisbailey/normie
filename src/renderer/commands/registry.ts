// The one registry of actions. The key handler, and later the palette and native menus, are views over it.
import type { ActionDef } from './keys';

export const ACTIONS = [
  { id: 'list.down', name: 'Next Thread', keys: ['j', 'ArrowDown'], contexts: ['list'] },
  { id: 'list.up', name: 'Previous Thread', keys: ['k', 'ArrowUp'], contexts: ['list'] },
  { id: 'list.top', name: 'First Thread', keys: ['g g'], contexts: ['list'] },
  { id: 'list.bottom', name: 'Last Thread', keys: ['Shift-G'], contexts: ['list'] },
  { id: 'list.open', name: 'Open Thread', keys: ['Enter', 'o'], contexts: ['list'] },
  { id: 'reader.next', name: 'Next Thread', keys: ['j', 'ArrowDown'], contexts: ['reader'] },
  { id: 'reader.prev', name: 'Previous Thread', keys: ['k', 'ArrowUp'], contexts: ['reader'] },
  { id: 'reader.close', name: 'Back to List', keys: ['Escape'], contexts: ['reader'] },
  { id: 'thread.done', name: 'Mark Done', keys: ['e'], contexts: ['list', 'reader'] },
  { id: 'thread.star', name: 'Star or Unstar', keys: ['s'], contexts: ['list', 'reader'] },
  { id: 'thread.delete', name: 'Delete', keys: ['#'], contexts: ['list', 'reader'] },
  { id: 'thread.toggleRead', name: 'Mark Read or Unread', keys: ['u'], contexts: ['list', 'reader'] },
  { id: 'thread.mute', name: 'Mute', keys: ['m'], contexts: ['list', 'reader'] },
  { id: 'thread.unmute', name: 'Unmute', keys: [], contexts: ['list', 'reader'] },
  { id: 'undo', name: 'Undo', keys: ['z'], contexts: ['list', 'reader'] },
  { id: 'go.inbox', name: 'Go to Inbox', keys: ['g i'], contexts: ['list', 'reader'] },
  { id: 'palette.open', name: 'Command Palette', keys: ['Cmd-K'], contexts: ['list', 'reader'] },
  { id: 'dev.overlay', name: 'Toggle Performance Overlay', keys: ['Cmd-Shift-D'], contexts: ['list', 'reader', 'composer'] },
] as const satisfies readonly ActionDef[];

export type ActionId = (typeof ACTIONS)[number]['id'];
