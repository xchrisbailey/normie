// One keydown handler for the whole window. Resolves keys through the registry and runs the action.
// Runs entirely in renderer memory: no message to another process on the key path.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { warn } from '../core/log';
import { isHtmlElement } from './dom';
import { KeyResolver, tokenOf } from './commands/keys';
import type { ActionDef, Context } from './commands/keys';
import { mergeKeymap } from './commands/keymap';
import { parseSnippets } from './commands/snippets';
import type { Snippet } from './commands/snippets';
import { ACTIONS } from './commands/registry';
import { isActionId } from './commands/registry';
import type { ActionId } from './commands/registry';
import { measureToNextFrame } from './perf';

/** A handler may return a promise; the action is measured to the frame after it settles. */
export type Handlers = Partial<Record<ActionId, () => void | Promise<void>>>;

/** The registry with the user's keymap laid over it, plus any problems with the file. Updates when the file changes. */
export function useKeymap() {
  const [state, setState] = useState<{ actions: ReadonlyArray<ActionDef>; problems: Array<string> }>({ actions: ACTIONS, problems: [] });
  useEffect(() => {
    const apply = (k: { file?: unknown; error?: string }) => {
      const merged = mergeKeymap(ACTIONS, k.file);
      const problems = k.error ? [k.error] : merged.problems;
      for (const p of problems) {
        warn(`[keymap] ${p}`);
      }
      setState({ actions: merged.actions, problems });
    };
    void window.normie.keymap().then(apply);
    return window.normie.onKeymapChanged(apply);
  }, []);
  return state;
}

/** splits.json as read (or why it couldn't be). Updates when the file changes. */
export function useSplitsFile() {
  const [state, setState] = useState<{ file?: unknown; error?: string }>({});
  useEffect(() => {
    void window.normie.splits().then(setState);
    return window.normie.onSplitsChanged(setState);
  }, []);
  return state;
}

/** Snippets from snippets.json, plus any problems with it. Updates when the file changes. */
export function useSnippets() {
  const [state, setState] = useState<{ snippets: Array<Snippet>; problems: Array<string> }>({ snippets: [], problems: [] });
  useEffect(() => {
    const apply = (k: { file?: unknown; error?: string }) => {
      const parsed = parseSnippets(k.file);
      const problems = k.error ? [k.error] : parsed.problems;
      for (const p of problems) {
        warn(`[snippets] ${p}`);
      }
      setState({ snippets: parsed.snippets, problems });
    };
    void window.normie.snippets().then(apply);
    return window.normie.onSnippetsChanged(apply);
  }, []);
  return state;
}

export function useKeys(context: Context, handlers: Handlers, actions: ReadonlyArray<ActionDef> = ACTIONS) {
  const latest = useRef({ context, handlers });
  // Written after every commit, before any key event can run (layout effects flush synchronously).
  useLayoutEffect(() => {
    latest.current = { context, handlers };
  });

  useEffect(() => {
    const resolver = new KeyResolver(actions);
    const onKeyDown = (e: KeyboardEvent) => {
      const target = isHtmlElement(e.target) ? e.target : null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
        return;
      }
      // While a form or the palette is open, keys are its own: none reach the list behind it.
      if (document.querySelector('.palette-backdrop')) {
        return;
      }
      const token = tokenOf(e, window.normie.platform);
      if (!token) {
        return;
      }
      const res = resolver.feed(token, latest.current.context);
      if (res.type === 'none') {
        return;
      }
      e.preventDefault();
      if (res.type !== 'action') {
        return;
      }
      if (!isActionId(res.id)) {
        return;
      }
      const run = latest.current.handlers[res.id];
      if (!run) {
        return;
      }
      const result = run();
      const id = res.id;
      if (result) {
        void result.then(() => measureToNextFrame(id, e.timeStamp));
      } else {
        measureToNextFrame(id, e.timeStamp);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [actions]);
}
