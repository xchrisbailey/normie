// Builds the benchmark's fixture maker (bench/make-fixture.ts → out/bench/make-fixture.js), which bench/run.mjs runs
// with plain Node. The app itself is built by electron-vite (electron.vite.config.mts).
import { build } from 'esbuild';

await build({
  entryPoints: { 'bench/make-fixture': 'bench/make-fixture.ts' },
  outdir: 'out',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'warning',
  external: ['better-sqlite3', 'imapflow', 'nodemailer', 'mailparser'],
});
