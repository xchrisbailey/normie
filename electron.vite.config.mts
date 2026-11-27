// Builds every process with electron-vite: main, data and sync (one build, three entries), the preload, and the
// renderer. The output keeps the layout the app, the checks and the packaged app expect:
//   out/main/index.js  out/data/index.js  out/sync/index.js  out/chunks/*  out/preload/index.js  out/renderer/
// Code shared by main, data and sync goes in out/chunks; scripts/check-bundles.mjs follows it.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { execFileSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import path from 'node:path';

const root = import.meta.dirname;
const out = (...parts: Array<string>) => path.join(root, 'out', ...parts);

// Which build this is, shown in the About panel and the menu bar: the commit (with "+" when there were uncommitted
// changes) and when it was built. So it's clear whether the app you're running has a fix.
const git = (...args: Array<string>) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const buildInfo = {
  commit: `${git('rev-parse', '--short', 'HEAD')}${git('status', '--porcelain') ? '+' : ''}`,
  time: new Date().toISOString(),
};

/** Images main uses at runtime (the menu bar icon, with its @2x beside it), next to main's bundle. */
const mainAssets = (): Plugin => ({
  name: 'normie-main-assets',
  writeBundle() {
    cpSync(path.join(root, 'src/main/assets'), out('main/assets'), { recursive: true });
  },
});

export default defineConfig({
  main: {
    define: { __NORMIE_BUILD__: JSON.stringify(buildInfo) },
    plugins: [mainAssets()],
    build: {
      outDir: out(),
      // The preload and renderer builds write into out/ too: each empties only its own folder.
      emptyOutDir: false,
      sourcemap: true,
      // Native and heavy Node dependencies stay in node_modules (better-sqlite3, imapflow, nodemailer, mailparser).
      externalizeDeps: true,
      rolldownOptions: {
        input: {
          'main/index': path.join(root, 'src/main/index.ts'),
          'data/index': path.join(root, 'src/data/index.ts'),
          'sync/index': path.join(root, 'src/sync/index.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' },
      },
    },
  },
  preload: {
    build: {
      outDir: out('preload'),
      sourcemap: true,
      // The window is sandboxed: its preload is one CommonJS file that requires only electron.
      rolldownOptions: {
        input: { index: path.join(root, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: path.join(root, 'src/renderer'),
    base: './',
    plugins: [react()],
    build: {
      outDir: out('renderer'),
      emptyOutDir: true,
      target: 'chrome140',
      modulePreload: false,
      // electron-vite leaves the renderer unminified; minified, the first frame parses less.
      minify: true,
      rolldownOptions: { input: path.join(root, 'src/renderer/index.html') },
    },
  },
});
