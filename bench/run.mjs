// The benchmark: builds, makes the 100,000-message fixture if needed, then runs the app against it.
// Exits non-zero when a budget slips.  npm run bench   (NORMIE_BENCH_REBUILD=1 regenerates the fixture)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const run = (cmd, args, env = {}) => spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } }).status ?? 1;
const fixture = path.resolve('bench/.fixtures/store-100k.sqlite');

if (run('node', ['scripts/build.mjs']) !== 0) process.exit(1);
if (!existsSync(fixture) || process.env.NORMIE_BENCH_REBUILD === '1') {
  mkdirSync(path.dirname(fixture), { recursive: true });
  if (run('node', ['out/bench/make-fixture.js', fixture]) !== 0) process.exit(1);
}
const electron = path.resolve('node_modules/.bin/electron');
process.exit(run(electron, ['.'], { NORMIE_BENCH: '1', NORMIE_DB: fixture, NORMIE_PROVIDER: 'none' }));
