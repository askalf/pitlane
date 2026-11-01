// node --test runners/pitlane-slices.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseFlat, parsePsiSome, pushSample, sampleSlice, windowRates } from './pitlane-slices.mjs';
import { slicePressure, THRESHOLDS } from './pitlane-supervisor-detect.mjs';
import { metricsText } from './pitlane-supervisor.mjs';

const MIN = 60000;
const smp = (at, o = {}) => ({ at, periods: 0, throttled: 0, throttledUs: 0, usageUs: 0, cpuStallUs: 0, memStallUs: 0, memCurrent: 4e9, memMax: 8e9, memAtMax: 0, oomKills: 0, ...o });

test('flat and pressure files parse to numbers', () => {
  assert.deepEqual(parseFlat('nr_periods 10\nnr_throttled 3\nthrottled_usec 99\nbad line\n'), { nr_periods: 10, nr_throttled: 3, throttled_usec: 99 });
  assert.equal(parsePsiSome('some avg10=0.48 avg60=0.23 avg300=0.05 total=123456\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=9\n'), 123456);
  assert.equal(parsePsiSome(''), null);
});

test('a slice directory reads into counters, its limit and its memory', () => {
  const root = mkdtempSync(join(tmpdir(), 'cg-'));
  const d = join(root, 'gha.slice', 'gha-exec.slice');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'cpu.stat'), 'usage_usec 500\nnr_periods 100\nnr_throttled 6\nthrottled_usec 70\n');
  writeFileSync(join(d, 'cpu.pressure'), 'some avg10=0.00 avg60=0.00 avg300=0.00 total=40\n');
  writeFileSync(join(d, 'memory.pressure'), 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n');
  writeFileSync(join(d, 'memory.current'), '2000\n');
  writeFileSync(join(d, 'memory.max'), '8000\n');
  writeFileSync(join(d, 'memory.events'), 'low 0\nhigh 0\nmax 7\noom 0\noom_kill 2\n');
  const s = sampleSlice(root, 'gha.slice/gha-exec.slice', 1000);
  assert.deepEqual([s.periods, s.throttled, s.cpuStallUs, s.memStallUs, s.memCurrent, s.memMax, s.memAtMax, s.oomKills], [100, 6, 40, 0, 2000, 8000, 7, 2]);
  assert.equal(sampleSlice(root, 'gha.slice/none.slice', 1000), null);
  writeFileSync(join(d, 'memory.max'), 'max\n');
  assert.equal(sampleSlice(root, 'gha.slice/gha-exec.slice', 1000).memMax, null);
});

test('a window is the change between its first and last sample', () => {
  const ring = [];
  pushSample(ring, smp(0));
  pushSample(ring, smp(15 * MIN, { periods: 1000, throttled: 250, cpuStallUs: 90e6, memStallUs: 9e6, memAtMax: 40, oomKills: 1, memCurrent: 6e9 }));
  const w = windowRates(ring);
  assert.equal(w.throttledShare, 0.25);
  assert.equal(w.cpuStallShare, 0.1);
  assert.equal(w.memStallShare, 0.01);
  assert.deepEqual([w.memAtMaxHits, w.oomKills, w.memUsedShare], [40, 1, 0.75]);
});

test('no figure until the ring spans half the window; old samples fall away', () => {
  const ring = [];
  pushSample(ring, smp(0));
  pushSample(ring, smp(5 * MIN));
  assert.equal(windowRates(ring), null);
  for (let t = 10; t <= 120; t += 5) pushSample(ring, smp(t * MIN, { periods: t * 10, throttled: t }));
  assert.ok(ring.length <= 9, `kept ${ring.length}`);
  assert.equal(windowRates(ring).spanMs, 15 * MIN);
});

test('slicePressure: throttling, stalls and OOM kills are named; quiet and unmeasured slices are not', () => {
  const quiet = { throttledShare: 0.02, cpuStallShare: 0.01, memStallShare: 0, oomKills: 0, memAtMaxHits: 5000 };
  assert.deepEqual(slicePressure({ slices: { 'gha-exec.slice': quiet, 'gha-read.slice': null } }), []);
  assert.deepEqual(slicePressure({}), []);
  const out = slicePressure({ slices: { 'gha-exec.slice': { ...quiet, throttledShare: 0.3, cpuStallShare: 0.2, memStallShare: 0.5, oomKills: 1 } } });
  assert.equal(out.length, 4);
  assert.equal(out[0].severity, 'crit');
  assert.match(out[1].msg, /throttled in 30% of periods/);
  assert.ok(THRESHOLDS.throttleWarn > 0);
});

test('metrics text carries the slice figures', () => {
  const w = { throttledShare: 0.058, cpuStallShare: 0.01, memStallShare: null, oomKills: 0, memAtMaxHits: 12, memUsedShare: 0.5 };
  const t = metricsText({ at: 5000, rows: 1, ghCalls: 0, findings: [], slices: { 'gha-exec.slice': w } });
  assert.match(t, /pitlane_slice_cpu_throttled_ratio\{slice="gha-exec.slice",window="15m"\} 0.0580\n/);
  assert.match(t, /pitlane_slice_memory_used_ratio\{slice="gha-exec.slice"\} 0.5000\n/);
  assert.doesNotMatch(t, /memory_stall_ratio/);
});
