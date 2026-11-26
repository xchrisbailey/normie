// One keydown handler for the whole window. Resolves keys through the registry and runs the action.
// Runs entirely in renderer memory: no message to another process on the key path.
import { useEffect, useRef } from 'react';
import { KeyResolver, tokenOf, type Context } from './commands/keys';
import { ACTIONS, type ActionId } from './commands/registry';
import { measureToNextFrame } from './perf';

export type Handlers = Partial<Record<ActionId, () => void>>;

export function useKeys(context: Context, handlers: Handlers) {
  const latest = useRef({ context, handlers });
  latest.current = { context, handlers };

  useEffect(() => {
    const resolver = new KeyResolver(ACTIONS);
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const token = tokenOf(e, window.normie.platform);
      if (!token) return;
      const res = resolver.feed(token, latest.current.context);
      if (res.type === 'none') return;
      e.preventDefault();
      if (res.type !== 'action') return;
      const run = latest.current.handlers[res.id as ActionId];
      if (!run) return;
      run();
      measureToNextFrame(res.id, e.timeStamp);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
