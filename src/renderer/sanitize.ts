// HTML mail is the main attack surface (#3, Risks). DOMPurify is the last step: nothing changes the HTML after it.
// The result is shown in a sandboxed frame without scripts and under a default-src 'none' CSP (see MailFrame).
import createDOMPurify from 'dompurify';
import type { DOMPurify } from 'dompurify';

export interface SanitizedMail {
  html: string;
  /** Remote images (and other remote resources) found. When blocked they're stripped, not just hidden. */
  remoteImages: number;
}

const REMOTE = /^\s*(https?:)?\/\//i;
const CSS_REMOTE_URL = /url\(\s*(['"]?)\s*(?:https?:)?\/\/[^)]*\)/gi;
const SAFE_LINK = /^(https?:|mailto:)/i;

/** Tags that can't do anything good in a mail body: active content, forms, frames, and anything that loads by itself. */
const FORBID_TAGS = [
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'textarea', 'select', 'option',
  'link', 'meta', 'base', 'video', 'audio', 'source', 'track', 'portal', 'template', 'noscript',
];
const FORBID_ATTR = ['action', 'formaction', 'srcdoc', 'ping', 'background', 'poster', 'xlink:href'];

export function createSanitizer(win: Window & typeof globalThis = window) {
  const purify: DOMPurify = createDOMPurify(win);
  let blockRemote = true;
  let remote = 0;

  purify.addHook('uponSanitizeElement', (node) => {
    // <style> blocks: remote url()s are counted and, when blocked, removed.
    if (node.nodeName === 'STYLE' && node.textContent) {
      node.textContent = node.textContent.replaceAll(/@import[^;]*;?/gi, '').replace(CSS_REMOTE_URL, (m) => {
        remote++;
        return blockRemote ? 'none' : m;
      });
    }
  });

  purify.addHook('afterSanitizeAttributes', (node) => {
    const el = node;
    for (const attr of ['src', 'srcset']) {
      const v = el.getAttribute?.(attr);
      if (!v) {continue;}
      if (/^\s*cid:/i.test(v) || /^\s*data:image\//i.test(v)) {continue;}
      if (REMOTE.test(v) || v.split(',').some((part) => REMOTE.test(part))) {
        remote++;
        if (blockRemote) {el.removeAttribute(attr);}
      } else {
        el.removeAttribute(attr);
      }
    }
    const style = el.getAttribute?.('style');
    if (style && CSS_REMOTE_URL.test(style)) {
      CSS_REMOTE_URL.lastIndex = 0;
      el.setAttribute('style', style.replace(CSS_REMOTE_URL, (m) => {
        remote++;
        return blockRemote ? 'none' : m;
      }));
    }
    CSS_REMOTE_URL.lastIndex = 0;
    if (el.nodeName === 'A') {
      const href = el.getAttribute('href');
      if (href && !SAFE_LINK.test(href.trim())) {el.removeAttribute('href');}
      el.removeAttribute('target');
    }
  });

  return (html: string, opts: { allowRemote?: boolean } = {}): SanitizedMail => {
    blockRemote = !opts.allowRemote;
    remote = 0;
    const out = purify.sanitize(html, {
      FORBID_TAGS, FORBID_ATTR, FORCE_BODY: true, ALLOW_DATA_ATTR: false, ALLOW_UNKNOWN_PROTOCOLS: false,
      ADD_TAGS: ['style'], USE_PROFILES: { html: true },
    });
    return { html: out, remoteImages: remote };
  };
}
