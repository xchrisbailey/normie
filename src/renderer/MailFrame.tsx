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

const SHELL_CSS = `
  :root { color-scheme: dark; }
  html, body { margin: 0; background: #1e1e2e; color: #cdd6f4; font: 14px/1.55 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
  body { padding: 0 28px 40px; }
  article { border-top: 1px solid #313244; padding: 14px 0; }
  article:first-child { border-top: 0; }
  header { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; margin-bottom: 10px; }
  .from { font-weight: 600; }
  time { color: #7f849c; font-variant-numeric: tabular-nums; }
  .to { grid-column: 1 / -1; color: #7f849c; font-size: 12px; }
  pre { margin: 0; white-space: pre-wrap; word-wrap: break-word; font: inherit; }
  .pending { color: #7f849c; font-style: italic; }
  .html { background: #fff; color: #111; border-radius: 8px; padding: 16px; overflow-x: auto; }
`;
const PAPER_CSS = `:host { display: block; } img { max-width: 100%; height: auto; } table { max-width: 100%; }`;

const shell = (remote: boolean) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp(remote)}"><style>${SHELL_CSS}</style></head><body></body></html>`;

/** Fill the frame's document with the Thread's messages. */
function render(doc: Document, messages: ThreadMessage[], allow: (m: ThreadMessage) => boolean) {
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
    body.append(article);
  }
  doc.defaultView?.scrollTo(0, 0);
}

export interface FrameHandle {
  scrollPage(direction: 1 | -1): void;
}

export const MailFrame = memo(function MailFrame({ threadKey, messages, allow, remote, handle }: {
  threadKey: string;
  messages: ThreadMessage[];
  allow: (m: ThreadMessage) => boolean;
  /** Any message in view may load remote images: the frame's CSP lets them through. */
  remote: boolean;
  handle?: React.MutableRefObject<FrameHandle | null>;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const latest = useRef({ messages, allow });
  latest.current = { messages, allow };

  const fill = () => {
    const doc = frame.current?.contentDocument;
    if (ready.current && doc?.body) render(doc, latest.current.messages, latest.current.allow);
  };

  // Hook up the frame's document once it has loaded: keys go to the app, links to the system browser.
  const onLoad = () => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    ready.current = true;
    doc.addEventListener('keydown', (e) => {
      const forwarded = new KeyboardEvent('keydown', {
        key: e.key, code: e.code, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, cancelable: true,
      });
      window.dispatchEvent(forwarded);
      if (forwarded.defaultPrevented) e.preventDefault();
    });
    doc.addEventListener('click', (e) => {
      const a = (e.composedPath().find((n) => (n as Element).tagName === 'A') as HTMLAnchorElement | undefined) ?? null;
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href');
      if (href && /^(https?:|mailto:)/i.test(href.trim())) window.normie.openLink(href.trim());
    }, true);
    fill();
  };

  // Before paint, so the frame that shows the Thread already has its messages in it.
  useLayoutEffect(fill, [threadKey, messages, allow]);

  if (handle) {
    handle.current = {
      scrollPage: (d) => {
        const w = frame.current?.contentWindow;
        if (w) w.scrollBy({ top: d * w.innerHeight * 0.85 });
      },
    };
  }

  return (
    <iframe
      key={remote ? 'remote' : 'blocked'}
      ref={frame}
      className="mail-frame"
      title="Message"
      sandbox="allow-same-origin"
      srcDoc={shell(remote)}
      onLoad={() => {
        ready.current = false;
        onLoad();
      }}
    />
  );
});
