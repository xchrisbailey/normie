// The benchmark, run inside the app (NORMIE_BENCH=1 via npm run bench): real key presses against the 100,000-message
// fixture, timed to the next frame and checked against the budgets in src/core/budgets.ts.
import { app } from 'electron';
import type { BrowserWindow, UtilityProcess } from 'electron';
import { execFileSync } from 'node:child_process';
import { BUDGETS } from '../core/budgets';
import { log } from '../core/log';
import { sleep } from '../core/sleep';
import { drive } from './drive';

type Sample = { action: string; ms: number };
type SearchTime = { q: string; n: number; ms: number };
type Memory = { mb: number; detail: string };

const sorted = (xs: Array<{ ms: number }>) => xs.map((s) => s.ms).sort((a, b) => a - b);
const pctOf = (xs: Array<number>) => (p: number) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? Infinity;

function isSearchTimes(v: unknown): v is Array<SearchTime> {
  return (
    Array.isArray(v) &&
    v.every((t: unknown) => typeof t === 'object' && t !== null && 'q' in t && 'n' in t && 'ms' in t && typeof t.ms === 'number')
  );
}

/** The benchmark: real key presses against the 100,000-message fixture, checked against the budgets. */
export async function runBench(w: BrowserWindow, info: { rows: number }, dataProc: UtilityProcess): Promise<boolean> {
  const d = drive(w);
  const budgets = { ...BUDGETS, keyMoveMs: Number(process.env.NORMIE_BUDGET_KEY_MS) || BUDGETS.keyMoveMs };
  const press = async (keyCode: string, modifiers: Array<'meta'> = []) => {
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (!modifiers.length) {w.webContents.sendInputEvent({ type: 'char', keyCode });}
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(25);
  };
  await sleep(500); // let the first frames settle
  await d.js<void>('window.__normiePerf.clear()');
  for (let i = 0; i < 200; i++) {await press('j');}
  for (let i = 0; i < 100; i++) {await press('k');}
  await sleep(200);
  // Opening: Enter on the selected Thread, then j through the next 30 in the reader. Each step's Thread
  // was prefetched while the one before it was open.
  await press('Enter');
  for (let i = 0; i < 30; i++) {
    await sleep(150);
    await press('j');
  }
  await sleep(200);
  await press('Escape');
  // Triage: Done on 50 Threads in a row (the main run works on a copy of the fixture).
  await sleep(200);
  for (let i = 0; i < 50; i++) {await press('e');}
  await sleep(200);
  // Switching Splits (Tab through all five and back) redraws the list from memory.
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 5; j++) {await press('Tab');}
  }
  await sleep(200);
  // The palette: open with Cmd-K, close with Escape.
  for (let i = 0; i < 40; i++) {
    await press('K', ['meta']);
    await sleep(50);
    await press('Escape');
  }
  await sleep(200);
  const samples = await d.js<Array<Sample>>('window.__normiePerf.samples()');
  const ms = sorted(samples.filter((s) => s.action === 'list.down' || s.action === 'list.up'));
  const pct = pctOf(ms);
  const opens = sorted(samples.filter((s) => s.action === 'list.open' || s.action === 'reader.next'));
  const openPct = pctOf(opens);
  const dones = sorted(samples.filter((s) => s.action === 'thread.done'));
  const donePct = pctOf(dones);
  const palettes = sorted(samples.filter((s) => s.action === 'palette.open'));
  const switches = sorted(samples.filter((s) => s.action.startsWith('split.')));
  const switchPct = pctOf(switches);
  const palettePct = pctOf(palettes);
  // Memory is a steady-state budget: Chromium caches raster tiles while scrolling and frees them once idle
  // (measured: 444 MB right after 300 rapid presses, 271 MB about 7 s later). Report the peak, judge the settled value.
  const peak = measureMemory();
  await sleep(Number(process.env.NORMIE_BENCH_SETTLE_MS) || 8000);
  const memory = measureMemory();
  // Search: words common and rare, operators and phrases, each run a few times.
  const queries = ['review', 'the', 'budget 1234', 'from:ada', 'subject:"design review"', 'schedule numbers', 'thanks', 'offsite agenda', 'zzzz', 'to:me'];
  const searchTimes = await new Promise<Array<SearchTime>>((resolve) => {
    const onMessage = (m: unknown) => {
      if (typeof m !== 'object' || m === null || !('type' in m) || m.type !== 'debug-search') {return;}
      dataProc.off('message', onMessage);
      resolve('times' in m && isSearchTimes(m.times) ? m.times : []);
    };
    dataProc.on('message', onMessage);
    dataProc.postMessage({ type: 'debug-search', queries: [...queries, ...queries, ...queries] });
  });
  const searchMs = searchTimes.map((t) => t.ms).sort((a, b) => a - b);
  const searchPct = pctOf(searchMs);
  // Where the memory is, inside the data process and the renderer (for #75).
  const dataMem = await new Promise<unknown>((resolve) => {
    dataProc.once('message', (m: unknown) => {
      resolve(m);
    });
    dataProc.postMessage({ type: 'debug-memory' });
  });
  const tabMem = await d.js<{ used: number; total: number }>(`(() => { const m = performance.memory; return { used: Math.round(m.usedJSHeapSize / 1048576), total: Math.round(m.totalJSHeapSize / 1048576) }; })()`);
  log(`[bench] inside: data ${JSON.stringify(dataMem)} renderer heap ${JSON.stringify(tabMem)}`);
  const results = [
    { budget: 'keyMoveMs', value: pct(95), limit: budgets.keyMoveMs, detail: `p50 ${pct(50).toFixed(1)}, p95 ${pct(95).toFixed(1)}, max ${(ms.at(-1) ?? 0).toFixed(1)} ms over ${ms.length} presses` },
    { budget: 'openCachedMs', value: openPct(95), limit: budgets.openCachedMs, detail: `p50 ${openPct(50).toFixed(1)}, p95 ${openPct(95).toFixed(1)}, max ${(opens.at(-1) ?? 0).toFixed(1)} ms over ${opens.length} opens` },
    { budget: 'triageMs', value: donePct(95), limit: budgets.triageMs, detail: `Done: p50 ${donePct(50).toFixed(1)}, p95 ${donePct(95).toFixed(1)}, max ${(dones.at(-1) ?? 0).toFixed(1)} ms over ${dones.length} Threads` },
    { budget: 'switchMs', value: switchPct(95), limit: budgets.switchMs, detail: `Split: p50 ${switchPct(50).toFixed(1)}, p95 ${switchPct(95).toFixed(1)}, max ${(switches.at(-1) ?? 0).toFixed(1)} ms over ${switches.length} switches` },
    { budget: 'paletteMs', value: palettePct(95), limit: budgets.paletteMs, detail: `Cmd-K: p50 ${palettePct(50).toFixed(1)}, p95 ${palettePct(95).toFixed(1)}, max ${(palettes.at(-1) ?? 0).toFixed(1)} ms over ${palettes.length} opens` },
    { budget: 'searchMs', value: searchPct(95), limit: budgets.searchMs, detail: `p50 ${searchPct(50).toFixed(1)}, p95 ${searchPct(95).toFixed(1)}, max ${(searchMs.at(-1) ?? 0).toFixed(1)} ms over ${searchMs.length} queries (slowest: ${searchTimes.sort((a, b) => b.ms - a.ms)[0]?.q})` },
    { budget: 'memoryMb', value: memory.mb, limit: budgets.memoryMb, detail: `settled; ${memory.detail}; peak while scrolling ${peak.mb.toFixed(0)}` },
  ];
  const pressesOk = ms.length === 300 && opens.length === 31 && dones.length === 50 && palettes.length === 40 && switches.length === 40;
  log(`\n[bench] fixture: ${info.rows} Inbox rows in the renderer`);
  for (const r of results) {log(`[bench] ${r.value <= r.limit ? 'ok  ' : 'FAIL'} ${r.budget.padEnd(12)} ${r.value.toFixed(1).padStart(7)} / ${r.limit}   ${r.detail}`);}
  if (!pressesOk) {log(`[bench] FAIL expected 300 moves, 31 opens, 50 Dones and 40 palettes, got ${ms.length}, ${opens.length}, ${dones.length} and ${palettes.length}`);}
  return pressesOk && results.every((r) => r.value <= r.limit);
}

/** Total memory across the app's processes: physical footprint on macOS (as Activity Monitor shows), else working set. */
export function measureMemory(): Memory {
  const metrics = app.getAppMetrics();
  if (process.platform === 'darwin') {
    try {
      const per = metrics.map((m) => {
        const out = execFileSync('footprint', ['-p', String(m.pid)], { encoding: 'utf8' });
        const [, n, unit] = /phys_footprint:\s+([\d.]+)\s+(KB|MB|GB)/.exec(out) ?? [];
        const mb = Number(n) * (unit === 'GB' ? 1024 : unit === 'KB' ? 1 / 1024 : 1);
        return { name: m.serviceName?.replace(/^(node|network)\.mojom\./, '') || m.type, mb };
      });
      return { mb: per.reduce((a, p) => a + p.mb, 0), detail: `physical footprint: ${per.map((p) => `${p.name} ${p.mb.toFixed(0)}`).join(', ')}` };
    } catch {
      // fall through to working set
    }
  }
  return { mb: metrics.reduce((a, m) => a + m.memory.workingSetSize, 0) / 1024, detail: `working set over ${metrics.length} processes` };
}

