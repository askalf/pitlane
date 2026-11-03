// Queue-wait record: the dispatcher appends one line per started self-hosted job (from the webhook,
// so it costs no GitHub requests); the supervisor reads the lines back and reports p50 and p90.
// The targets this measures: p50 under 5 s, p90 under 30 s.
//
// The same record feeds what is shown outside the box (docs/showcase.md): each job's own wait, for its
// run-page line, and the 24 h numbers for the badge. Neither names a repository, so a private one's
// jobs count in the numbers without showing up in them.
import { appendFileSync, chmodSync, chownSync, closeSync, existsSync, fchmodSync, fchownSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const ROTATE_BYTES = 1024 * 1024;
export const TARGETS = { p50Ms: 5000, p90Ms: 30000 };

/** The p-th percentile (0 to 100) by nearest rank; null for no samples. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/**
 * The group that may read the private state files: status.json, metrics.prom, dispatcher.json,
 * dispatcher.beat and waits.jsonl (docs/isolation.md, Host state files). They name repositories and
 * rows, so no job may read them; the dashboard does, through a read-only bind, as gid 1001. The units set
 * PITLANE_READ_GID to that; unset or not a number gives null, and the files are root's alone.
 */
export function readerGid(value = process.env.PITLANE_READ_GID) {
  return /^\d{1,10}$/.test(String(value ?? '')) ? Number(value) : null;
}

/** 0640 with a reader group, 0600 without one. */
export const privateMode = (gid) => (gid === null ? 0o600 : 0o640);

/** The owner stays this process (root on the box) and the group becomes the reader's; no owners without getuid (Windows). */
function ownPath(path, gid) {
  if (gid !== null && typeof process.getuid === 'function') chownSync(path, process.getuid(), gid);
}

/** mkdir -p at mode, and the mode set again on a directory that was already there (made before this change). */
export function privateDir(dir, mode) {
  mkdirSync(dir, { recursive: true, mode });
  chmodSync(dir, mode);
}

/**
 * Replaces path whole with text, private from its first byte: the temp file is created at the private
 * mode and given its group before it takes the name, so a reader sees the old file or the new one,
 * whole, and no account outside the group ever sees either.
 */
export function writePrivate(path, text, gid) {
  const mode = privateMode(gid);
  const tmp = `${path}.tmp`;
  // Created new ('wx'): a mode given to a write applies only to a file it creates, and a temp file a
  // crash left behind may be 0644 from before this change.
  rmSync(tmp, { force: true });
  writeFileSync(tmp, text, { mode, flag: 'wx' });
  try {
    ownPath(tmp, gid);
    chmodSync(tmp, mode);   // the umask may have taken the group's read bit at create
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  renameSync(tmp, path);
}

/**
 * Appends text at the private mode. The mode given to an append applies only when it creates the file,
 * and the files from before this change are 0644, so each append sets the owner and mode on the open
 * file before it writes.
 */
export function appendPrivate(path, text, gid) {
  const mode = privateMode(gid);
  const fd = openSync(path, 'a', mode);
  try {
    if (gid !== null && typeof process.getuid === 'function') fchownSync(fd, process.getuid(), gid);
    fchmodSync(fd, mode);
    appendFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/**
 * Gives files written before this change the private owner and mode; a file not there is skipped. The
 * rewrites do the rest, but a rotated waits.jsonl.1 is only ever renamed, never written.
 */
export function makePrivate(paths, gid) {
  for (const p of paths) {
    try {
      ownPath(p, gid);
      chmodSync(p, privateMode(gid));
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
}

/**
 * Append one job's timing, private (appendPrivate). When the file passes ROTATE_BYTES it becomes
 * `<file>.1`, replacing the last; the rename keeps its owner and mode.
 */
export function recordWait(file, t, gid = readerGid()) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o711 });
  if (existsSync(file) && statSync(file).size > ROTATE_BYTES) renameSync(file, `${file}.1`);
  appendPrivate(file, `${JSON.stringify({ at: t.startedAt, repo: t.repo, runner: t.runner, waitMs: t.waitMs })}\n`, gid);
}

/** Lines of both files (older first) as entries; a damaged line is skipped, not fatal. */
export function readWaits(file) {
  const out = [];
  for (const f of [`${file}.1`, file]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (Number.isFinite(e.at) && Number.isFinite(e.waitMs) && typeof e.repo === 'string') out.push(e);
      } catch { /* a half-written line */ }
    }
  }
  return out;
}

/** { n, p50, p90, max } in ms of a list of entries; nulls, not zeros, for none. */
const statOf = (list) => {
  const w = list.map((e) => e.waitMs).sort((a, b) => a - b);
  return { n: w.length, p50: percentile(w, 50), p90: percentile(w, 90), max: w.length ? w[w.length - 1] : null };
};

/** { n, p50, p90, max } in ms for the entries inside the window; overall and per repository. */
export function summarize(entries, now, windowMs) {
  const inWin = entries.filter((e) => e.at > now - windowMs && e.at <= now + AHEAD_MS);
  const repos = {};
  for (const r of new Set(inWin.map((e) => e.repo))) repos[r] = statOf(inWin.filter((e) => e.repo === r));
  return { all: statOf(inWin), repos };
}

/** summarize() takes a record stamped up to this far ahead of now: the clocks that stamp and read differ by seconds. */
const AHEAD_MS = 60000;

/**
 * The last `count` hours as buckets ending now, oldest first: { from (ms), n, p50, p90 }. A day's p90
 * can be one hour's burst, and the buckets say which hour; none of them names a repository. The newest
 * bucket ends where summarize()'s window ends (now plus AHEAD_MS), so every record in the totals is in
 * exactly one bucket and the card and the bars never disagree.
 */
export function hourly(entries, now, count = 24) {
  const out = [];
  for (let i = count; i >= 1; i--) {
    const from = now - i * 3600000, to = i === 1 ? now + AHEAD_MS : from + 3600000;
    const s = statOf(entries.filter((e) => e.at > from && e.at <= to));
    out.push({ from, n: s.n, p50: s.p50, p90: s.p90 });
  }
  return out;
}

/**
 * A wait as people read it: "under 1 s", "14 s", "2 min 5 s"; '' for no number. Whole seconds only:
 * GitHub's created_at and started_at carry no fraction, so a tenth would be made up.
 */
export function fmtWait(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s === 0) return 'under 1 s';
  return s < 120 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** A runner name as a row gets it; anything else is never made into a path here. */
const ROW_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The record a job's completed hook reads (pitlane-job-summary.sh), at <dir>/<runner>:
 * "<runId> <runAttempt> <waitMs> <wait as text>". Only a runner with an instance directory under
 * rowsRoot gets one. The file takes that directory's group at 0640, so the row's own account can read
 * it and no other row's can; the directory is 0711, so no job can list the rows in it. A row takes one
 * job at a time, so the record a hook finds is its own job's unless this delivery came late, and the
 * run id and attempt are how the hook tells. Returns the path, or null when there is nothing to write.
 */
export function writeJobRecord(dir, rowsRoot, t) {
  if (!ROW_NAME.test(String(t?.runner ?? '')) || !Number.isSafeInteger(t.runId) || !Number.isSafeInteger(t.runAttempt) || !Number.isFinite(t.waitMs)) return null;
  let row;
  try { row = lstatSync(join(rowsRoot, t.runner)); } catch { return null; }
  if (!row.isDirectory()) return null;
  mkdirSync(dir, { recursive: true, mode: 0o711 });
  chmodSync(dir, 0o711);
  const file = join(dir, t.runner);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${t.runId} ${t.runAttempt} ${Math.round(t.waitMs)} ${fmtWait(t.waitMs)}\n`, { mode: 0o640 });
  try {
    // A file the row's group cannot read is worse than none: the hook would say nothing about the wait.
    if (typeof process.getuid === 'function') chownSync(tmp, process.getuid(), row.gid);
    chmodSync(tmp, 0o640);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  renameSync(tmp, file);
  return file;
}

/**
 * Every job record given its row's current group again, at 0640 (ownJobRecords). A record takes the
 * row directory's group when it is written, so a record written before the row had a group of its
 * own keeps the shared group it had, and every row in that group can read it until the row's next
 * job rewrites it; a row that stays idle keeps the leak. A record whose row directory is gone is
 * made root-only: no row owns it. A temp file beside a record is a write in progress and is left
 * alone. Called on start, before the first tick. Returns the number of records changed.
 */
export function ownJobRecords(dir, rowsRoot) {
  let names;
  try { names = readdirSync(dir); } catch { return 0; }
  let changed = 0;
  for (const name of names) {
    if (!ROW_NAME.test(name) || name.endsWith('.tmp')) continue;
    const file = join(dir, name);
    let rec;
    try { rec = lstatSync(file); } catch { continue; }
    if (!rec.isFile()) continue;
    let row = null;
    try { row = lstatSync(join(rowsRoot, name)); } catch { /* no row directory: the record has no reader */ }
    const gid = row?.isDirectory() ? row.gid : null;
    const mode = privateMode(gid);
    const sameGroup = gid === null || typeof process.getuid !== 'function' || rec.gid === gid;
    if (sameGroup && (rec.mode & 0o777) === mode) continue;
    ownPath(file, gid);
    chmodSync(file, mode);
    changed += 1;
  }
  return changed;
}

/**
 * The numbers anyone may read (docs/showcase.md): the 24 h totals from summarize().all and
 * summarizeOutcomes(), and when given, the last hour (summarize().all over one hour) and the hour
 * buckets from hourly(). Nothing here names a repository or a row. Run and felt time come from the
 * outcome record (runMs, feltMs), so they count the jobs that finished in the window, while the queue
 * wait counts the jobs that started in it; every key a reader had before stays where it was.
 */
export function publicStats(waits24, outcomes24, now, { lastHour, hours } = {}) {
  const stats = {
    at: new Date(now).toISOString(),
    window: '24h',
    jobs: waits24?.n ?? 0,
    queueWaitMs: { p50: waits24?.p50 ?? null, p90: waits24?.p90 ?? null },
    targets: { ...TARGETS },
    finished: outcomes24?.n ?? null,
    runnerSuspect: outcomes24?.suspect?.n ?? null,
    ran: outcomes24?.runMs?.n ?? null,
    runMs: { p50: outcomes24?.runMs?.p50 ?? null, p90: outcomes24?.runMs?.p90 ?? null },
    feltMs: { p50: outcomes24?.feltMs?.p50 ?? null, p90: outcomes24?.feltMs?.p90 ?? null },
  };
  if (lastHour) stats.lastHour = { jobs: lastHour.n ?? 0, p50: lastHour.p50 ?? null, p90: lastHour.p90 ?? null };
  if (hours) stats.hours = hours.map((h) => ({ from: new Date(h.from).toISOString(), jobs: h.n, p50: h.p50, p90: h.p90 }));
  return stats;
}

const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * A shields.io endpoint badge with two 24 h receipts, the median start (queue wait) and the median run:
 * "start 2 s · run 18 s". The colour reads the start alone, against its targets: green inside both,
 * grey with no jobs. With no run number yet the message is the start alone.
 */
export const BADGE_LABEL = 'CI measured';
export function badgeDoc(stats) {
  const base = { schemaVersion: 1, label: BADGE_LABEL, cacheSeconds: 300 };
  const { p50, p90 } = stats?.queueWaitMs ?? {};
  if (!stats?.jobs || !Number.isFinite(p50)) return { ...base, message: 'no jobs in 24 h', color: 'lightgrey' };
  const color = p50 < TARGETS.p50Ms && p90 < TARGETS.p90Ms ? 'brightgreen'
    : p50 < TARGETS.p50Ms ? 'green'
      : p50 < 3 * TARGETS.p50Ms ? 'yellow' : 'orange';
  const run = stats?.runMs?.p50;
  return { ...base, message: Number.isFinite(run) ? `start ${fmtWait(p50)} · run ${fmtWait(run)}` : `start ${fmtWait(p50)}`, color };
}

/** The 24 h half of the run-page line, "p50 2 s, p90 16 s across 1,240 jobs"; '' with no jobs. */
export function summaryText(stats) {
  const { p50, p90 } = stats?.queueWaitMs ?? {};
  if (!stats?.jobs || !Number.isFinite(p50) || !Number.isFinite(p90)) return '';
  return `p50 ${fmtWait(p50)}, p90 ${fmtWait(p90)} across ${grouped(stats.jobs)} ${stats.jobs === 1 ? 'job' : 'jobs'}`;
}

/** stats.json, badge.json and summary.txt in dir, each replaced whole (readers never see half a file). */
export function writePublic(dir, stats) {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  for (const [name, text] of [
    ['stats.json', `${JSON.stringify(stats)}\n`],
    ['badge.json', `${JSON.stringify(badgeDoc(stats))}\n`],
    ['summary.txt', `${summaryText(stats)}\n`],
  ]) {
    const f = join(dir, name);
    writeFileSync(`${f}.tmp`, text, { mode: 0o644 });
    renameSync(`${f}.tmp`, f);
  }
}
