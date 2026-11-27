// The benchmark: builds, makes the 100,000-message fixture if needed, then runs the app against it.
// Exits non-zero when a budget slips.  npm run bench   (NORMIE_BENCH_REBUILD=1 regenerates the fixture)
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const run = (cmd, args, env = {}, capture = false) =>
  spawnSync(cmd, args, { stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8', env: { ...process.env, ...env } });
const fixture = path.resolve('bench/.fixtures/store-100k.sqlite');
const electron = path.resolve('node_modules/.bin/electron');
const appEnv = { NORMIE_DB: fixture, NORMIE_PROVIDER: 'none' };

if (run('node', ['scripts/build.mjs']).status !== 0) {process.exit(1);}
if (!existsSync(fixture) || process.env.NORMIE_BENCH_REBUILD === '1') {
  mkdirSync(path.dirname(fixture), { recursive: true });
  if (run('node', ['out/bench/make-fixture.js', fixture]).status !== 0) {process.exit(1);}
}

// Key movement, opening Threads, triage and memory, in one run. Triage changes the store, so it runs on a copy.
const scratch = mkdtempSync(path.join(tmpdir(), 'normie-bench-'));
const copy = path.join(scratch, 'store.sqlite');
copyFileSync(fixture, copy);
const main = run(electron, ['.'], { ...appEnv, NORMIE_DB: copy, NORMIE_USER_DATA: path.join(scratch, 'user-data'), NORMIE_BENCH: '1' }).status ?? 1;
rmSync(scratch, { recursive: true, force: true });

// Cold start: fresh processes against the same store and a snapshot from the run before.
// One warm-up launch writes the snapshot, then the median of 5.
const userData = mkdtempSync(path.join(tmpdir(), 'normie-coldstart-'));
const launches = [];
for (let i = 0; i < 6; i++) {
  const r = run(electron, ['.'], { ...appEnv, NORMIE_BENCH: 'coldstart', NORMIE_USER_DATA: userData }, true);
  const line = r.stdout.split('\n').find((l) => l.startsWith('[coldstart] '));
  if (!line) {
    console.log('[bench] FAIL coldStartMs: a launch never reported its first frame');
    process.exit(1);
  }
  launches.push(JSON.parse(line.slice('[coldstart] '.length)));
}
const measured = launches.slice(1);
const ms = measured.map((l) => l.ms).sort((a, b) => a - b);
const median = ms[Math.floor(ms.length / 2)];
const budget = measured[0].budget;
const snapshotOk = measured.every((l) => l.fromSnapshot && l.rows > 0);
const ok = median <= budget && snapshotOk;
console.log(`[bench] ${ok ? 'ok  ' : 'FAIL'} ${'coldStartMs'.padEnd(12)} ${median.toFixed(1).padStart(7)} / ${budget}   median of 5 launches: ${ms.join(', ')} ms; first frame from snapshot: ${snapshotOk ? 'yes' : 'NO'} (warm-up launch, no snapshot: ${launches[0].ms} ms)`);
process.exit(main === 0 && ok ? 0 : 1);
