// Run a probe against a read-only copy of the real store: how a change behaves on real mail, without touching it.
//   npm run real-copy -- scripts/probes/inbox.ts
// A probe's default export gets a Store opened on the copy (migrations run on the copy) and returns anything
// JSON-able; it's printed. The copy is made with SQLite's backup (safe while Normie runs) and deleted afterwards.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const probe = process.argv[2];
if (!probe || !existsSync(probe)) {
  console.error('usage: npm run real-copy -- <probe.ts>   (see scripts/probes/)');
  process.exit(1);
}
const store = process.env.NORMIE_DB ?? path.join(homedir(), 'Library/Application Support/normie/normie.sqlite');
const dir = mkdtempSync(path.join(tmpdir(), 'normie-real-copy-'));
try {
  const copy = path.join(dir, 'copy.sqlite');
  execFileSync('sqlite3', ['-readonly', store, `.backup ${copy}`]);
  const entry = path.join(dir, 'run.ts');
  writeFileSync(entry, `
    import probe from ${JSON.stringify(path.resolve(probe))};
    import { Store } from ${JSON.stringify(path.resolve('src/core/store'))};
    const store = new Store(${JSON.stringify(copy)});
    const t = performance.now();
    Promise.resolve(probe(store)).then((result) => {
      console.log(JSON.stringify({ ms: Math.round(performance.now() - t), result }, null, 2));
      store.close();
    });
  `);
  const out = path.join(dir, 'run.cjs');
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'warning', external: ['better-sqlite3', 'mailparser', 'imapflow', 'nodemailer'], nodePaths: [path.resolve('node_modules')] });
  execFileSync(process.execPath, [out], { stdio: 'inherit', env: { ...process.env, NODE_PATH: path.resolve('node_modules') } });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
