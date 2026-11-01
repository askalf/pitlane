// Pressure on the CI slices, read from cgroup v2 files. The queue-wait record says that jobs waited;
// this says whether the box was the reason: a slice at its CPU quota is throttled, and a slice short of
// memory stalls its tasks. Counters only grow, so a window's figure is the change between two samples.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SLICES = ['gha.slice', 'gha.slice/gha-exec.slice', 'gha.slice/gha-build.slice', 'gha.slice/gha-read.slice'];
export const WINDOW_MS = 15 * 60000;

/** `key value` lines (cpu.stat, memory.events) as numbers. */
export function parseFlat(text) {
  const o = {};
  for (const line of String(text).split('\n')) {
    const m = /^(\w+) (\d+)$/.exec(line.trim());
    if (m) o[m[1]] = Number(m[2]);
  }
  return o;
}

/** Pressure file: the `total` stall time in microseconds of its `some` line. */
export function parsePsiSome(text) {
  const m = /^some .*\btotal=(\d+)/m.exec(String(text));
  return m ? Number(m[1]) : null;
}

const readOr = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const limit = (t) => (t === null || t.trim() === 'max' ? null : Number(t));

/** One slice's cumulative counters and current memory, or null when the slice has no cgroup. */
export function sampleSlice(root, slice, now) {
  const dir = join(root, slice);
  const cpu = readOr(join(dir, 'cpu.stat'));
  if (cpu === null) return null;
  const c = parseFlat(cpu);
  const ev = parseFlat(readOr(join(dir, 'memory.events')) ?? '');
  return {
    at: now,
    periods: c.nr_periods ?? 0, throttled: c.nr_throttled ?? 0, throttledUs: c.throttled_usec ?? 0, usageUs: c.usage_usec ?? 0,
    cpuStallUs: parsePsiSome(readOr(join(dir, 'cpu.pressure')) ?? ''),
    memStallUs: parsePsiSome(readOr(join(dir, 'memory.pressure')) ?? ''),
    memCurrent: Number(readOr(join(dir, 'memory.current')) ?? 0),
    memMax: limit(readOr(join(dir, 'memory.max'))),
    memAtMax: ev.max ?? 0, oomKills: ev.oom_kill ?? 0,
  };
}

/** Keep samples no older than twice the window, so a window always has a start to measure from. */
export function pushSample(ring, s, windowMs = WINDOW_MS) {
  ring.push(s);
  while (ring.length > 2 && ring[1].at <= s.at - 2 * windowMs) ring.shift();
}

/**
 * The window's figures from a ring of samples: the share of CPU periods that were throttled, the share of
 * wall time any task stalled on CPU or on memory, how many times the memory cap was hit, OOM kills, and
 * memory in use now against its limit. Null until the ring spans at least half the window.
 */
export function windowRates(ring, windowMs = WINDOW_MS) {
  const last = ring[ring.length - 1];
  if (!last) return null;
  const start = ring.find((s) => s.at >= last.at - windowMs) ?? ring[0];
  const span = last.at - start.at;
  if (span < windowMs / 2) return null;
  const share = (a, b) => (a === null || b === null ? null : Math.max(0, Math.min(1, (b - a) / (span * 1000))));
  const dPeriods = last.periods - start.periods;
  return {
    spanMs: span,
    throttledShare: dPeriods > 0 ? Math.max(0, (last.throttled - start.throttled) / dPeriods) : 0,
    cpuStallShare: share(start.cpuStallUs, last.cpuStallUs),
    memStallShare: share(start.memStallUs, last.memStallUs),
    memAtMaxHits: last.memAtMax - start.memAtMax,
    oomKills: last.oomKills - start.oomKills,
    memUsedShare: last.memMax ? last.memCurrent / last.memMax : null,
  };
}
