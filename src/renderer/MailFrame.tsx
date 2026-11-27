// The reader frame: one reused iframe showing a Thread's messages. Sandboxed without allow-scripts, so nothing in
// a message can run; allow-same-origin lets this page fill it, scroll it and hear its keys. Its own CSP blocks
// every load except inline styles and data: images, plus remote images only when the user allowed them.
// Each message sits in its own shadow root, so one newsletter's <style> can't restyle another message.
import { memo, useLayoutEffect, useRef } from 'react';
import type { Address, ThreadMessage } from '../core/types';
import { sanitized } from './sanitize-cache';

const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const who = (a?: Address) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : 'Unknown sender');

const csp = (remote: boolean) =>
  `default-src 'none'; style-src 'unsafe-inline'; img-src data:${remote ? ' https: http:' : ''}; font-src data:; media-src 'none'`;

/** The frame's own stylesheet, in the app's current theme (its colours are read from the page). */
const shellCss = (c: Record<'base' | 'text' | 'surface0' | 'surface1' | 'overlay', string>, dark: boolean) => `
  :root { color-scheme: ${dark ? 'dark' : 'light'}; }
  html, body { margin: 0; background: ${c.base}; color: ${c.text}; font: 14px/1.55 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
  body { padding: 0 28px 40px; }
  article { border-top: 1px solid ${c.surface0}; padding: 14px 0; }
  article:first-child { border-top: 0; }
  header { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; margin-bottom: 10px; }
  .from { font-weight: 600; }
  time { color: ${c.overlay}; font-variant-numeric: tabular-nums; }
  .to { grid-column: 1 / -1; color: ${c.overlay}; font-size: 12px; }
  pre { margin: 0; white-space: pre-wrap; word-wrap: break-word; font: inherit; }
  .pending { color: ${c.overlay}; font-style: italic; }
  .html { background: #fff; color: #111; border-radius: 8px; padding: 16px; overflow-x: auto; ${dark ? '' : `box-shadow: 0 0 0 1px ${c.surface0};`} }
  .attachments { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .attachment { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px; border-radius: 6px; background: ${c.surface0}; font-size: 12px; }
  .attachment .size { color: ${c.overlay}; }
  .attachment button { font: inherit; color: ${c.text}; background: ${c.surface1}; border: 0; border-radius: 4px; padding: 2px 8px; cursor: pointer; }
`;

/** The page's theme colours right now. */
function themeColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(`--${name}`).trim();
  return { colors: { base: v('base'), text: v('text'), surface0: v('surface0'), surface1: v('surface1'), overlay: v('overlay') }, dark: css.colorScheme !== 'light' };
}
const sizeOf = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const PAPER_CSS = `:host { display: block; } img { max-width: 100%; height: auto; } table { max-width: 100%; }`;

const shell = (remote: boolean, theme: ReturnType<typeof themeColors>) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp(remote)}"><style>${shellCss(theme.colors, theme.dark)}</style></head><body></body></html>`;

/** Fill the frame's document with the Thread's messages. */
function render(doc: Document, messages: Array<ThreadMessage>, allow: (m: ThreadMessage) => boolean) {
  const body = doc.body;
  body.replaceChildren();
  for (const m of messages) {
    const article = doc.createElement('article');
    const header = doc.createElement('header');
    const from = doc.createElement('div');
    from.className = 'from';
    from.textContent = who(m.from);
    const time = doc.createElement('time');
    time.textContent = full.format(m.date);
    const to = doc.createElement('div');
    to.className = 'to';
    to.textContent = `To: ${m.to.map(who).join(', ') || '—'}`;
    header.append(from, time, to);
    article.append(header);
    if (m.text === null && !m.html) {
      const p = doc.createElement('p');
      p.className = 'pending';
      p.textContent = 'Downloading this message…';
      article.append(p);
    } else if (m.html) {
      const host = doc.createElement('div');
      host.className = 'html';
      const root = host.attachShadow({ mode: 'open' });
      // Sanitized just before this line, and nothing changes it after.
      root.innerHTML = `<style>${PAPER_CSS}</style>${sanitized(m, allow(m)).html}`;
      article.append(host);
    } else {
      const pre = doc.createElement('pre');
      pre.textContent = m.text || '(no text)';
      article.append(pre);
    }
    if (m.attachments.length) {
      const list = doc.createElement('div');
      list.className = 'attachments';
      for (const a of m.attachments) {
        const chip = doc.createElement('div');
        chip.className = 'attachment';
        const name = doc.createElement('span');
        name.textContent = a.filename;
        const size = doc.createElement('span');
        size.className = 'size';
        size.textContent = sizeOf(a.size);
        chip.append(name, size);
        for (const [label, action] of [['Open', 'open'], ['Save', 'save']] as const) {
          const b = doc.createElement('button');
          b.textContent = label;
          b.dataset.attachment = `${action}:${m.id}:${a.index}`;
          chip.append(b);
        }
        list.append(chip);
      }
      article.append(list);
    }
    body.append(article);
  }
  doc.defaultView?.scrollTo(0, 0);
}

export interface FrameHandle {
  scrollPage(direction: 1 | -1): void;
}

export type AttachmentAction = (action: 'open' | 'save', messageId: number, index: number) => void;

export const MailFrame = memo(function MailFrame({ threadKey, messages, allow, remote, handle, onAttachment, theme }: {
  threadKey: string;
  messages: Array<ThreadMessage>;
  allow: (m: ThreadMessage) => boolean;
  /** Any message in view may load remote images: the frame's CSP lets them through. */
  remote: boolean;
  handle?: React.MutableRefObject<FrameHandle | null>;
  onAttachment?: AttachmentAction;
  /** The app's theme name: a new one rebuilds the frame in its colours. */
  theme?: string;
}) {
  const colors = themeColors();
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const latest = useRef({ messages, allow, onAttachment });
  latest.current = { messages, allow, onAttachment };

  const fill = () => {
    const doc = frame.current?.contentDocument;
    if (ready.current && doc?.body) {render(doc, latest.current.messages, latest.current.allow);}
  };

  // Hook up the frame's document once it has loaded: keys go to the app, links to the system browser.
  const onLoad = () => {
    const doc = frame.current?.contentDocument;
    if (!doc) {return;}
    ready.current = true;
    doc.addEventListener('keydown', (e) => {
      const forwarded = new KeyboardEvent('keydown', {
        key: e.key, code: e.code, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, cancelable: true,
      });
      window.dispatchEvent(forwarded);
      if (forwarded.defaultPrevented) {e.preventDefault();}
    });
    doc.addEventListener('click', (e) => {
      const button = e.composedPath().find((n) => (n as HTMLElement).dataset?.attachment) as HTMLElement | undefined;
      if (button) {
        e.preventDefault();
        const [action, id, index] = button.dataset.attachment!.split(':');
        latest.current.onAttachment?.(action as 'open' | 'save', Number(id), Number(index));
        return;
      }
      const a = (e.composedPath().find((n) => (n as Element).tagName === 'A') as HTMLAnchorElement | undefined) ?? null;
      if (!a) {return;}
      e.preventDefault();
      const href = a.getAttribute('href');
      if (href && /^(https?:|mailto:)/i.test(href.trim())) {window.normie.openLink(href.trim());}
    }, true);
    fill();
  };

  // Before paint, so the frame that shows the Thread already has its messages in it.
  useLayoutEffect(fill, [threadKey, messages, allow]);

  if (handle) {
    handle.current = {
      scrollPage: (d) => {
        const w = frame.current?.contentWindow;
        if (w) {w.scrollBy({ top: d * w.innerHeight * 0.85 });}
      },
    };
  }

  return (
    <iframe
      key={`${remote ? 'remote' : 'blocked'}:${theme}:${colors.colors.base}`}
      ref={frame}
      className="mail-frame"
      title="Message"
      sandbox="allow-same-origin"
      srcDoc={shell(remote, colors)}
      onLoad={() => {
        ready.current = false;
        onLoad();
      }}
    />
  );
});
