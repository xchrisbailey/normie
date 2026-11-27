// @vitest-environment jsdom
// The HTML mail sanitizer (#38): hostile input in, inert HTML out.
import { describe, expect, it } from 'vitest';
import { createSanitizer } from '../src/renderer/sanitize';

const clean = createSanitizer(window as Window & typeof globalThis);

describe('sanitizing HTML mail', () => {
  it('removes scripts, handlers, forms, frames and javascript: links', () => {
    const { html } = clean(`
      <p onclick="steal()">Hi<script>alert(1)</script></p>
      <img src=x onerror="alert(1)">
      <a href="javascript:alert(1)">click</a>
      <a href="vbscript:x">vb</a>
      <form action="https://evil.example"><input name=p><button>Go</button></form>
      <iframe src="https://evil.example"></iframe>
      <object data="x.swf"></object><embed src="x">
      <svg><script>alert(1)</script></svg>
      <meta http-equiv="refresh" content="0;url=https://evil.example">
      <base href="https://evil.example/">
      <style>@import url(https://evil.example/x.css); @import "https://evil.example/y.css";</style>`);
    expect(html).not.toContain('evil.example');
    for (const bad of ['<script', 'onclick', 'onerror', 'javascript:', 'vbscript:', '<form', '<input', '<button', '<iframe', '<object', '<embed', '<svg', '<meta', '<base']) {
      expect(html.toLowerCase(), bad).not.toContain(bad);
    }
    expect(html).toContain('Hi');
  });

  it('keeps ordinary mail formatting and safe links', () => {
    const { html } = clean(`<style>p { color: red }</style><table><tr><td bgcolor="#eee"><b>Bold</b> <a href="https://example.com/x">link</a> <a href="mailto:a@b.c">mail</a></td></tr></table>`);
    expect(html).toContain('<style>');
    expect(html).toContain('<table>');
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain('href="mailto:a@b.c"');
  });

  it('strips remote images and remote CSS by default, and counts them', () => {
    const { html, remoteImages } = clean(`
      <img src="https://tracker.example/p.gif">
      <img srcset="https://cdn.example/a.png 1x, https://cdn.example/b.png 2x">
      <div style="background-image: url('https://cdn.example/bg.png')">x</div>
      <style>.h { background: url(//cdn.example/h.png) }</style>
      <img src="data:image/png;base64,iVBORw0KGgo=">`);
    expect(remoteImages).toBe(4);
    expect(html).not.toContain('tracker.example');
    expect(html).not.toContain('cdn.example');
    expect(html).toContain('data:image/png;base64');
  });

  it('keeps remote images once allowed', () => {
    const { html, remoteImages } = clean(`<img src="https://cdn.example/logo.png"><div style="background:url(https://cdn.example/bg.png)">x</div>`, { allowRemote: true });
    expect(remoteImages).toBe(2);
    expect(html).toContain('https://cdn.example/logo.png');
    expect(html).toContain('https://cdn.example/bg.png');
  });

  it('drops links that would open anything but the web or mail', () => {
    const { html } = clean(`<a href="file:///etc/passwd">f</a><a href="normie://x">n</a><a href="https://ok.example" target="_top">ok</a>`);
    expect(html).not.toContain('file:');
    expect(html).not.toContain('normie:');
    expect(html).not.toContain('target');
    expect(html).toContain('https://ok.example');
  });
});
