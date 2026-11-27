// Builds every process: esbuild for main, preload, data and sync; Vite for the renderer.
import { build as esbuild } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import { build as vite } from 'vite';

// Which build this is, shown in the About panel and the menu bar: the commit (with "+" when there were uncommitted
// changes) and when it was built. So it's clear whether the app you're running has a fix.
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const build = {
  commit: `${git('rev-parse', '--short', 'HEAD')}${git('status', '--porcelain') ? '+' : ''}`,
  time: new Date().toISOString(),
};

const node = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: 'linked',
  logLevel: 'warning',
  // Native and heavy Node dependencies stay in node_modules; electron is provided at runtime.
  external: ['electron', 'better-sqlite3', 'imapflow', 'nodemailer', 'mailparser'],
};

await Promise.all([
  esbuild({
    ...node,
    entryPoints: { 'main/index': 'src/main/index.ts', 'data/index': 'src/data/index.ts', 'sync/index': 'src/sync/index.ts' },
    outdir: 'out',
    define: { __NORMIE_BUILD__: JSON.stringify(build) },
  }),
  esbuild({ ...node, entryPoints: { 'preload/index': 'src/preload/index.ts' }, outdir: 'out' }),
  esbuild({ ...node, entryPoints: { 'bench/make-fixture': 'bench/make-fixture.ts' }, outdir: 'out', sourcemap: false }),
]);
await vite({ configFile: 'vite.renderer.config.mts', logLevel: 'warn' });
// Images main uses at runtime (the menu bar icon).
cpSync('src/main/assets', 'out/main/assets', { recursive: true });
console.log('built out/');
