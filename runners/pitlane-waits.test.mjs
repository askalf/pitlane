// node --test runners/pitlane-waits.test.mjs
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { jobTiming } from './pitlane-kick.mjs';
import { ROTATE_BYTES, TARGETS, appendPrivate, badgeDoc, fmtWait, hourly, makePrivate, ownJobRecords, percentile, privateDir, privateMode, publicStats, readWaits, readerGid, recordWait, summarize, summaryText, writeJobRecord, writePrivate, writePublic } from './pitlane-waits.mjs';

const body = (o = {}) => JSON.stringify({
  action: 'in_progress',
  repository: { full_name: 'askalf/dario' },
  workflow_job: { labels: ['self-hosted', 'Linux'], runner_name: 'dario-exec-e1', created_at: '2026-10-15T19:00:00Z', started_at: '2026-10-15T19:00:03Z', ...o },
});

test('jobTiming: a started self-hosted job gives its queue wait', () => {
  const t = jobTiming('workflow_job', body());
  assert.deepEqual([t.repo, t.runner, t.waitMs], ['askalf/dario', 'dario-exec-e1', 3000]);
});

test('jobTiming: queued, completed, hosted, other events and bad times give nothing', () => {
  assert.equal(jobTiming('workflow_job', body().replace('in_progress', 'queued')), null);
  assert.equal(jobTiming('workflow_job', body().replace('in_progress', 'completed')), null);
  assert.equal(jobTiming('workflow_job', body({ labels: ['ubuntu-latest'] })), null);
  assert.equal(jobTiming('push', body()), null);
  assert.equal(jobTiming('workflow_job', 'not json'), null);
  assert.equal(jobTiming('workflow_job', body({ started_at: '2026-10-15T18:59:00Z' })), null);
  assert.equal(jobTiming('workflow_job', body({ started_at: null })), null);
});

test('percentile is nearest rank', () => {
  const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(s, 50), 5);
  assert.equal(percentile(s, 90), 9);
  assert.equal(percentile(s, 100), 10);
  assert.equal(percentile([], 50), null);
});

test('record, read back, and summarize inside the window', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'waits-')), 'sub', 'waits.jsonl');
  const now = 10 * 3600000;
  for (const [at, repo, waitMs] of [[now - 1000, 'askalf/dario', 2000], [now - 2000, 'askalf/dario', 4000], [now - 3000, 'askalf/ci', 90000], [now - 5 * 3600000, 'askalf/ci', 500000]]) {
    recordWait(file, { startedAt: at, repo, runner: 'r', waitMs });
  }
  appendFileSync(file, '{"at": 1, "repo"\n');
  const s = summarize(readWaits(file), now, 3600000);
  assert.equal(s.all.n, 3);
  assert.equal(s.all.max, 90000);
  assert.deepEqual([s.repos['askalf/dario'].n, s.repos['askalf/dario'].p50], [2, 2000]);
  assert.equal(s.repos['askalf/ci'].p90, 90000);
});

test('the file rotates past its size cap and both halves are read', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'waits-')), 'waits.jsonl');
  writeFileSync(file, `${'{"at":5,"repo":"askalf/ci","waitMs":1}\n'.repeat(Math.ceil(ROTATE_BYTES / 36) + 10)}`);
  recordWait(file, { startedAt: 9, repo: 'askalf/ci', runner: 'r', waitMs: 2 });
  const all = readWaits(file);
  assert.ok(all.length > 1000);
  assert.equal(all.at(-1).waitMs, 2);
});

test('an empty record summarizes to nulls, not zeros', () => {
  const s = summarize([], 1000, 500);
  assert.deepEqual(s.all, { n: 0, p50: null, p90: null, max: null });
});

test('jobTiming carries the run id and attempt, or null for a value that is not an integer', () => {
  const t = jobTiming('workflow_job', body({ run_id: 18000000001, run_attempt: 2 }));
  assert.deepEqual([t.runId, t.runAttempt], [18000000001, 2]);
  const u = jobTiming('workflow_job', body({ run_id: '18000000001', run_attempt: 1.5 }));
  assert.deepEqual([u.runId, u.runAttempt], [null, null]);
});

test('fmtWait is whole seconds, minutes past two', () => {
  for (const [ms, text] of [[0, 'under 1 s'], [499, 'under 1 s'], [2049, '2 s'], [16000, '16 s'], [119400, '119 s'], [119600, '2 min 0 s'], [125000, '2 min 5 s']]) {
    assert.equal(fmtWait(ms), text, String(ms));
  }
  for (const bad of [-1, NaN, null, undefined, Infinity]) assert.equal(fmtWait(bad), '');
});

const POSIX = process.platform !== 'win32';
/** A temp record dir and rows root holding row r1; returns both and the record a job on r1 gets. */
function jobDirs() {
  const base = mkdtempSync(join(tmpdir(), 'jobs-'));
  const rows = join(base, 'rows');
  mkdirSync(join(rows, 'r1'), { recursive: true });
  return { base, dir: join(base, 'jobs'), rows };
}
const started = (o = {}) => ({ repo: 'o/r', runner: 'r1', waitMs: 2049, runId: 18000000001, runAttempt: 1, ...o });

test('writeJobRecord writes the run, attempt and wait for the row, readable by the row group only', () => {
  const { dir, rows } = jobDirs();
  const file = writeJobRecord(dir, rows, started());
  assert.equal(file, join(dir, 'r1'));
  assert.equal(readFileSync(file, 'utf8'), '18000000001 1 2049 2 s\n');
  if (POSIX) {
    assert.equal(statSync(file).mode & 0o777, 0o640);
    assert.equal(statSync(file).gid, statSync(join(rows, 'r1')).gid);
    assert.equal(statSync(dir).mode & 0o777, 0o711);
  }
  // The row's next job replaces the record whole; no temp file is left beside it.
  writeJobRecord(dir, rows, started({ runId: 18000000002, waitMs: 125000 }));
  assert.equal(readFileSync(file, 'utf8'), '18000000002 1 125000 2 min 5 s\n');
  assert.deepEqual(readdirSync(dir), ['r1']);
});

test('ownJobRecords gives a record its row group and mode again, root-only for a row that is gone, and leaves a write in progress alone', () => {
  const { dir, rows } = jobDirs();
  mkdirSync(join(rows, 'r2'), { recursive: true });
  writeJobRecord(dir, rows, started());
  writeJobRecord(dir, rows, started({ runner: 'r2' }));
  // A record written before its row had a group of its own: readable by a group the row no longer has, here by everyone.
  chmodSync(join(dir, 'r1'), 0o644);
  // A record of a row whose directory is gone, and a temp file beside the records.
  writeFileSync(join(dir, 'gone'), '18000000003 1 10 under 1 s\n', { mode: 0o644 });
  writeFileSync(join(dir, 'r2.123.tmp'), '', { mode: 0o644 });
  const n = ownJobRecords(dir, rows);
  if (POSIX) {
    assert.equal(n, 2);
    assert.equal(statSync(join(dir, 'r1')).mode & 0o777, 0o640);
    assert.equal(statSync(join(dir, 'r1')).gid, statSync(join(rows, 'r1')).gid);
    assert.equal(statSync(join(dir, 'r2')).mode & 0o777, 0o640);
    assert.equal(statSync(join(dir, 'gone')).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'r2.123.tmp')).mode & 0o777, 0o644);
    // Nothing left to change: a second pass changes nothing.
    assert.equal(ownJobRecords(dir, rows), 0);
  }
  assert.equal(ownJobRecords(join(dir, 'missing'), rows), 0);
});

test('writeJobRecord writes nothing for a name that is not a row, a row that is not a directory, or no run id', () => {
  const { base, dir, rows } = jobDirs();
  writeFileSync(join(rows, 'plain'), '');
  for (const [what, t] of [
    ['a path', started({ runner: '../r1' })],
    ['a dot name', started({ runner: '.hidden' })],
    ['no row directory', started({ runner: 'r2' })],
    ['a file, not a directory', started({ runner: 'plain' })],
    ['no run id', started({ runId: null })],
    ['no attempt', started({ runAttempt: null })],
    ['no wait', started({ waitMs: NaN })],
  ]) assert.equal(writeJobRecord(dir, rows, t), null, what);
  let linked = true;
  try { symlinkSync(join(base, 'elsewhere'), join(rows, 'link'), 'dir'); mkdirSync(join(base, 'elsewhere')); } catch { linked = false; }   // no symlink right on this box
  if (linked) assert.equal(writeJobRecord(dir, rows, started({ runner: 'link' })), null, 'a symlinked row');
  let left = [];
  try { left = readdirSync(dir); } catch { /* never made */ }
  assert.deepEqual(left, []);
});

const AT = Date.parse('2026-10-30T23:00:00Z');
const stats = (waits, outcomes) => publicStats(waits, outcomes, AT);

test('publicStats keeps the 24 h totals and nothing that names a repository or a row', () => {
  const s = stats({ n: 1240, p50: 2049, p90: 16000, max: 90000 }, { n: 1300, classes: { success: 1300 }, suspect: { n: 0, rate: 0, runners: { r1: 0 } } });
  assert.deepEqual(s, { at: '2026-10-30T23:00:00.000Z', window: '24h', jobs: 1240, queueWaitMs: { p50: 2049, p90: 16000 }, targets: TARGETS, finished: 1300, runnerSuspect: 0 });
  assert.deepEqual(stats(undefined, undefined), { at: '2026-10-30T23:00:00.000Z', window: '24h', jobs: 0, queueWaitMs: { p50: null, p90: null }, targets: TARGETS, finished: null, runnerSuspect: null });
});

test('hourly splits the day into hour buckets ending now, oldest first; publicStats carries the hour and the buckets with no repository name', () => {
  const now = 48 * 3600000;
  const entries = [
    { at: now - 30 * 60000, repo: 'a/b', waitMs: 2000 }, { at: now - 90 * 60000, repo: 'a/b', waitMs: 60000 },
    { at: now - 23.5 * 3600000, repo: 'c/d', waitMs: 1000 }, { at: now - 25 * 3600000, repo: 'c/d', waitMs: 9000 },
    // Stamped 30 s ahead of the reader's clock: inside the hour's totals, so inside the newest bucket too.
    { at: now + 30000, repo: 'a/b', waitMs: 2000 },
    // 90 s ahead: outside both.
    { at: now + 90000, repo: 'a/b', waitMs: 999000 },
  ];
  const h = hourly(entries, now);
  assert.equal(h.length, 24);
  assert.deepEqual(h[23], { from: now - 3600000, n: 2, p50: 2000, p90: 2000 });
  assert.equal(summarize(entries, now, 3600000).all.n, h[23].n, 'the last hour and the newest bucket count the same records');
  assert.equal(h.reduce((n, b) => n + b.n, 0), summarize(entries, now, 24 * 3600000).all.n, 'the buckets together are the day');
  assert.deepEqual(h[22], { from: now - 2 * 3600000, n: 1, p50: 60000, p90: 60000 });
  assert.deepEqual(h[0], { from: now - 24 * 3600000, n: 1, p50: 1000, p90: 1000 });
  assert.ok(h.slice(1, 22).every((b) => b.n === 0 && b.p50 === null && b.p90 === null));
  const s = publicStats({ n: 4, p50: 2000, p90: 60000, max: 60000 }, null, now, { lastHour: summarize(entries, now, 3600000).all, hours: h });
  assert.deepEqual(s.lastHour, { jobs: 2, p50: 2000, p90: 2000 });
  assert.equal(s.hours.length, 24);
  assert.deepEqual(s.hours[23], { from: new Date(now - 3600000).toISOString(), jobs: 2, p50: 2000, p90: 2000 });
  assert.deepEqual(s.hours[5], { from: new Date(now - 19 * 3600000).toISOString(), jobs: 0, p50: null, p90: null });
  assert.doesNotMatch(JSON.stringify(s), /a\/b|c\/d/);
  assert.equal('lastHour' in publicStats({ n: 1, p50: 1, p90: 1 }, null, now), false);
});

test('badgeDoc shows the p50, colored by the targets', () => {
  const badge = (p50, p90, n = 10) => badgeDoc(stats({ n, p50, p90 }, null));
  assert.deepEqual(badge(2049, 16000), { schemaVersion: 1, label: 'CI on pitlane', cacheSeconds: 300, message: 'starts in 2 s (p50)', color: 'brightgreen' });
  assert.equal(badge(3000, 40000).color, 'green');
  assert.equal(badge(9000, 40000).color, 'yellow');
  assert.equal(badge(20000, 60000).color, 'orange');
  assert.deepEqual([badge(null, null, 0).message, badge(null, null, 0).color], ['no jobs in 24 h', 'lightgrey']);
});

test('summaryText is the 24 h half of the run-page line', () => {
  assert.equal(summaryText(stats({ n: 1240, p50: 2049, p90: 16000 })), 'p50 2 s, p90 16 s across 1,240 jobs');
  assert.equal(summaryText(stats({ n: 1, p50: 400, p90: 400 })), 'p50 under 1 s, p90 under 1 s across 1 job');
  assert.equal(summaryText(stats({ n: 0, p50: null, p90: null })), '');
});

test('writePublic writes the three files whole, with no repository-shaped name in them', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'public-')), 'public');
  const s = stats({ n: 1240, p50: 2049, p90: 16000 }, { n: 1300, suspect: { n: 2 } });
  writePublic(dir, s);
  assert.deepEqual(readdirSync(dir).sort(), ['badge.json', 'stats.json', 'summary.txt']);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'stats.json'), 'utf8')), s);
  assert.equal(JSON.parse(readFileSync(join(dir, 'badge.json'), 'utf8')).message, 'starts in 2 s (p50)');
  assert.equal(readFileSync(join(dir, 'summary.txt'), 'utf8'), 'p50 2 s, p90 16 s across 1,240 jobs\n');
  for (const f of readdirSync(dir)) {
    assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), /\//, f);
    if (POSIX) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o644, f);
  }
});

// The private state files (docs/isolation.md, Host state files). The group is this process's own, so
// the chown needs no root; the modes are POSIX only (Windows keeps a read-only bit and no group).
const OWN_GID = process.getgid?.() ?? 0;
const mode = (p) => statSync(p).mode & 0o777;
const privateTmp = () => mkdtempSync(join(tmpdir(), 'pitlane-private-'));
// A file from before this change: 0644 whatever the umask.
const worldReadable = (p, text = '') => { writeFileSync(p, text); chmodSync(p, 0o644); };

test('readerGid: a plain number is the group; empty, signed, fractional or anything else is none', () => {
  assert.equal(readerGid('1001'), 1001);
  assert.equal(readerGid('0'), 0);
  for (const v of [null, '', 'abc', '-1', '1.5', ' 1001', '1001x', '12345678901']) assert.equal(readerGid(v), null, String(v));
  assert.equal(privateMode(1001), 0o640);
  assert.equal(privateMode(null), 0o600);
});

test('writePrivate replaces the file whole at 0640 to the reader group, or 0600 with none, past a temp file a crash left', () => {
  const dir = privateTmp();
  const path = join(dir, 'status.json');
  worldReadable(`${path}.tmp`, 'left by a crash');
  writePrivate(path, 'one\n', OWN_GID);
  assert.equal(readFileSync(path, 'utf8'), 'one\n');
  writePrivate(path, 'two\n', OWN_GID);
  assert.equal(readFileSync(path, 'utf8'), 'two\n');
  assert.deepEqual(readdirSync(dir), ['status.json'], 'no temp file is left beside it');
  const alone = join(dir, 'held-mark');
  writePrivate(alone, 'x\n', null);
  if (POSIX) {
    assert.equal(mode(path), 0o640);
    assert.equal(statSync(path).gid, OWN_GID);
    assert.equal(mode(alone), 0o600);
  }
});

test('writePrivate gives the group its read bit back under a umask that takes it at create', { skip: !POSIX }, () => {
  const old = process.umask(0o077);
  try {
    const path = join(privateTmp(), 'metrics.prom');
    writePrivate(path, 'm 1\n', OWN_GID);
    assert.equal(mode(path), 0o640);
  } finally {
    process.umask(old);
  }
});

test('appendPrivate tightens a file from before the change at its next append and keeps what it held', () => {
  const dir = privateTmp();
  const path = join(dir, 'waits.jsonl');
  worldReadable(path, 'old\n');
  appendPrivate(path, 'new\n', OWN_GID);
  assert.equal(readFileSync(path, 'utf8'), 'old\nnew\n');
  const fresh = join(dir, 'outcomes-2026-10-31.jsonl');
  appendPrivate(fresh, 'a\n', null);
  appendPrivate(fresh, 'b\n', null);
  assert.equal(readFileSync(fresh, 'utf8'), 'a\nb\n');
  if (POSIX) {
    assert.equal(mode(path), 0o640);
    assert.equal(statSync(path).gid, OWN_GID);
    assert.equal(mode(fresh), 0o600);
  }
});

test('makePrivate tightens the files that are there and skips the ones that are not; privateDir sets the mode on a directory already there', () => {
  const dir = privateTmp();
  const state = join(dir, 'dispatcher.json');
  worldReadable(state, '{}');
  makePrivate([state, join(dir, 'waits.jsonl.1')], OWN_GID);
  assert.equal(readFileSync(state, 'utf8'), '{}');
  const run = join(dir, 'run');
  mkdirSync(run);
  if (POSIX) chmodSync(run, 0o755);
  privateDir(run, 0o711);
  privateDir(join(run, 'held'), 0o700);
  if (POSIX) {
    assert.equal(mode(state), 0o640);
    assert.equal(mode(run), 0o711);
    assert.equal(mode(join(run, 'held')), 0o700);
  }
});

test('recordWait writes the waits private, and the rotated half keeps its mode', () => {
  const dir = join(privateTmp(), 'run');
  const file = join(dir, 'waits.jsonl');
  recordWait(file, { startedAt: 1, repo: 'askalf/ci', runner: 'r', waitMs: 2 }, OWN_GID);
  if (POSIX) {
    assert.equal(mode(file), 0o640);
    assert.equal(mode(dir), 0o711, 'a directory it makes lists nothing to a job');
  }
  appendFileSync(file, `${'{"at":5,"repo":"askalf/ci","waitMs":1}\n'.repeat(Math.ceil(ROTATE_BYTES / 36) + 10)}`);
  recordWait(file, { startedAt: 9, repo: 'askalf/ci', runner: 'r', waitMs: 3 }, null);
  assert.equal(readWaits(file).at(-1).waitMs, 3);
  if (POSIX) {
    assert.equal(mode(`${file}.1`), 0o640);
    assert.equal(mode(file), 0o600);
  }
});
