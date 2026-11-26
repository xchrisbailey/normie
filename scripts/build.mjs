// Builds every process: esbuild for main, preload, data and sync; Vite for the renderer.
import { build as esbuild } from 'esbuild';
import { build as vite } from 'vite';

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
  esbuild({ ...node, entryPoints: { 'main/index': 'src/main/index.ts', 'data/index': 'src/data/index.ts', 'sync/index': 'src/sync/index.ts' }, outdir: 'out' }),
  esbuild({ ...node, entryPoints: { 'preload/index': 'src/preload/index.ts' }, outdir: 'out' }),
]);
await vite({ configFile: 'vite.renderer.config.mts', logLevel: 'warn' });
console.log('built out/');
