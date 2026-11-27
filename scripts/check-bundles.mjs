// Each process loads only what it should. Run after a build (npm run verify does).
// The sync process talks to mail servers; it must never load SQLite (the data process owns the store). The renderer
// is sandboxed web code: no Node modules at all. The data process needs no network libraries.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const read = (f) => readFileSync(f, 'utf8');
const renderer = readdirSync('out/renderer/assets').filter((f) => f.endsWith('.js')).map((f) => path.join('out/renderer/assets', f));
const rules = [
  { files: ['out/sync/index.js'], banned: ['better-sqlite3'], why: 'sync must not load SQLite; import from keys.ts/types.ts, not store.ts' },
  { files: ['out/data/index.js'], banned: ['imapflow', 'nodemailer'], why: 'the data process makes no network connections' },
  { files: renderer, banned: ['better-sqlite3', 'imapflow', 'nodemailer', 'mailparser', 'require("node:', 'require("fs")'], why: 'the renderer is sandboxed: no Node modules' },
];

let failed = false;
for (const r of rules) {
  for (const f of r.files) {
    const src = read(f);
    for (const b of r.banned) {
      const needle = b.startsWith('require(') ? b : `require("${b}")`;
      const hit = src.includes(needle) || (!b.startsWith('require(') && src.includes(`from "${b}"`));
      if (hit) {
        console.error(`check-bundles: ${f} loads ${b} (${r.why})`);
        failed = true;
      }
    }
  }
}
if (failed) process.exit(1);
console.log(`check-bundles: ok (${rules.reduce((n, r) => n + r.files.length, 0)} bundles)`);
