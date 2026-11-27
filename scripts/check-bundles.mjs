// Each process loads only what it should. Run after a build (npm run verify does).
// The sync process talks to mail servers; it must never load SQLite (the data process owns the store). The renderer
// is sandboxed web code: no Node modules at all. The data process needs no network libraries.
//
// main, data and sync are built together, so code they share sits in out/chunks: each process is checked with every
// chunk it requires, followed all the way down. A banned name matches that package's own entry, not its subpaths
// (data composes drafts with nodemailer/lib/mail-composer, which makes no connection).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** A bundle and every local file it requires, transitively. */
function withChunks(entry) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) {
      return;
    }
    seen.add(file);
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(/require\("(\.{1,2}\/[^"]+)"\)/g)) {
      const next = path.resolve(path.dirname(file), spec);
      if (existsSync(next)) {
        visit(next);
      }
    }
  };
  visit(path.resolve(entry));
  return [...seen];
}

const renderer = readdirSync('out/renderer/assets')
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.join('out/renderer/assets', f));
const rules = [
  {
    entry: 'out/sync/index.js',
    files: withChunks('out/sync/index.js'),
    banned: ['better-sqlite3'],
    why: 'sync must not load SQLite; import from keys.ts/types.ts, not store.ts',
  },
  {
    entry: 'out/data/index.js',
    files: withChunks('out/data/index.js'),
    banned: ['imapflow', 'nodemailer'],
    why: 'the data process makes no network connections',
  },
  {
    entry: 'the renderer',
    files: renderer,
    banned: ['better-sqlite3', 'imapflow', 'nodemailer', 'mailparser', 'require("node:', 'require("fs")'],
    why: 'the renderer is sandboxed: no Node modules',
  },
];

let failed = false;
for (const r of rules) {
  for (const f of r.files) {
    const src = readFileSync(f, 'utf8');
    for (const b of r.banned) {
      const needle = b.startsWith('require(') ? b : `require("${b}")`;
      const hit = src.includes(needle) || (!b.startsWith('require(') && src.includes(`from "${b}"`));
      if (hit) {
        const via = path.relative('.', f) === r.entry ? '' : ` (through ${path.relative('.', f)})`;
        console.error(`check-bundles: ${r.entry} loads ${b}${via} (${r.why})`);
        failed = true;
      }
    }
  }
}
if (failed) {
  process.exit(1);
}
console.log(`check-bundles: ok (${rules.reduce((n, r) => n + r.files.length, 0)} files)`);
