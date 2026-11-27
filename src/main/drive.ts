// Driving the app as a person does, for the smoke checks and the benchmark. Every helper goes through the same input
// path real hands do (key-down, character, key-up; mouse at a point), never straight into the DOM, so a check sees
// what a person would: a field that doesn't get the keys, a sheet covered by the list.
import type { BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { sleep } from '../core/sleep';

type Modifier = 'meta' | 'shift';

/** Electron names a few keys differently from the characters they type. */
const KEY_CODE = new Map([[' ', 'Space']]);

export function drive(w: BrowserWindow) {
  const wc = w.webContents;
  const pause = sleep;
  /**
   * Run code in the page and get its result. `T` is what that code returns: the checks read it and assert on it,
   * so a wrong guess fails the check rather than hiding.
   */
  const js = async <T>(code: string): Promise<T> => {
    const value: unknown = await wc.executeJavaScript(code);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the page code is written beside its T; checks assert on it
    return value as T;
  };

  return {
    pause,
    js,

    /** Press a key (n times): key-down, the character it types (not with Cmd), key-up. Then let the frame settle. */
    press: async (keyCode: string, n = 1, modifiers: Array<Modifier> = []) => {
      for (let i = 0; i < n; i++) {
        wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        if (!modifiers.includes('meta')) {wc.sendInputEvent({ type: 'char', keyCode, modifiers });}
        wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      }
      await pause(100);
    },

    /** Type text with real key presses, as fast as the events go (fast typing is when keys get lost or misrouted). */
    type: async (text: string) => {
      for (const ch of text) {
        const keyCode = KEY_CODE.get(ch) ?? ch;
        wc.sendInputEvent({ type: 'keyDown', keyCode });
        wc.sendInputEvent({ type: 'char', keyCode: ch });
        wc.sendInputEvent({ type: 'keyUp', keyCode });
      }
      await pause(80);
    },

    /**
     * Click the middle of an element, as the mouse would. `hit` says whether the element (or something inside it) was
     * really what's under the pointer: false when something covers it.
     */
    clickAt: async (selector: string, offset = { x: 0.5, y: 0.5 }) => {
      const at = await js<{ x: number; y: number; hit: boolean } | null>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const x = r.left + r.width * ${offset.x}, y = r.top + r.height * ${offset.y};
        const top = document.elementFromPoint(x, y);
        return { x, y, hit: !!top && (top === el || el.contains(top)) };
      })()`);
      if (!at) {return { found: false, hit: false };}
      for (const type of ['mouseDown', 'mouseUp'] as const) {
        wc.sendInputEvent({ type, x: Math.round(at.x), y: Math.round(at.y), button: 'left', clickCount: 1 });
      }
      await pause(100);
      return { found: true, hit: at.hit };
    },

    /** A command from the menu bar, as a menu item (or a key equivalent the menu caught) sends it. */
    menuAction: async (...ids: Array<string>) => {
      wc.send('menu:action', ids);
      await pause(100);
    },

    /** With NORMIE_SMOKE_SHOTS=<folder>, save a screenshot to look at (a hidden window still renders). */
    shot: async (name: string) => {
      const dir = process.env.NORMIE_SMOKE_SHOTS;
      if (dir) {writeFileSync(path.join(dir, `${name}.png`), (await wc.capturePage()).toPNG());}
    },
  };
}
