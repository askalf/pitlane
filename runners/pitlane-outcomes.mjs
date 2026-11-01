// Job outcome record: one line per finished self-hosted job, from the workflow_job `completed`
// delivery, so it costs no GitHub requests. It is kept on disk in one file per UTC day, so a window of
// weeks can be read back; the queue-wait record in pitlane-waits.mjs lives in /run and is gone at reboot.
//
// What it answers: of the jobs the runners took, how many ended in a way that points at the runner and
// not at the workflow. The class is read from the delivery alone, so it is a suspicion, not proof:
//   success, skipped        as reported
//   cancelled-queued        cancelled before any runner took it
//   cancelled, timed-out    the job's own cancellation or time limit
//   job-failed              a step of the job failed
//   setup-failed            "Set up job" failed: the runner could not start the job (an action that
//                           would not download lands here too, so this is an upper bound)
//   runner-lost-suspect     the job failed and no step reports a failure: the runner went away
//   other                   any other conclusion
// `bad` keeps the non-success step names of a suspect job so the classes can be refined from real data.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { appendPrivate, percentile } from './pitlane-waits.mjs';

export const KEEP_DAYS = 45;
export const SUSPECT_CLASSES = ['setup-failed', 'runner-lost-suspect'];

const DAY_MS = 86400000;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const FILE = /^outcomes-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** The class of a finished job from its workflow_job object. Pure, exported for tests. */
export function classifyJob(j) {
  const c = j?.conclusion;
  if (c === 'success') return 'success';
  if (c === 'skipped') return 'skipped';
  if (c === 'cancelled') return j?.runner_name ? 'cancelled' : 'cancelled-queued';
  if (c === 'timed_out') return 'timed-out';
  if (c !== 'failure') return 'other';
  const failed = (Array.isArray(j.steps) ? j.steps : []).filter((s) => s?.conclusion === 'failure');
  if (failed.some((s) => s.name === 'Set up job')) return 'setup-failed';
  return failed.length ? 'job-failed' : 'runner-lost-suspect';
}

/**
 * One finished self-hosted job from a `completed` delivery, or null for any other delivery, a job that
 * is not self-hosted, or one without an id, repository or completion time. Exported for tests.
 */
export function jobOutcome(event, body) {
  if (event !== 'workflow_job') return null;
  let p;
  try { p = JSON.parse(body); } catch { return null; }
  const j = p?.workflow_job;
  if (p?.action !== 'completed' || !Array.isArray(j?.labels) || !j.labels.includes('self-hosted')) return null;
  const repo = p?.repository?.full_name;
  const completed = Date.parse(j.completed_at);
  if (typeof repo !== 'string' || !Number.isFinite(j.id) || !Number.isFinite(completed)) return null;
  const runner = String(j.runner_name ?? '');
  const created = Date.parse(j.created_at);
  const started = Date.parse(j.started_at);
  const cls = classifyJob(j);
  const e = {
    id: j.id,
    at: completed,
    repo,
    runner,
    conclusion: String(j.conclusion ?? ''),
    class: cls,
    waitMs: runner && Number.isFinite(created) && Number.isFinite(started) && started >= created ? started - created : null,
    runMs: runner && Number.isFinite(started) && completed >= started ? completed - started : null,
  };
  if (SUSPECT_CLASSES.includes(cls)) {
    e.bad = (Array.isArray(j.steps) ? j.steps : [])
      .filter((s) => s?.conclusion && s.conclusion !== 'success' && s.conclusion !== 'skipped')
      .slice(0, 4).map((s) => `${String(s.name ?? '').slice(0, 60)}:${s.conclusion}`);
  }
  return e;
}

let lastPrune = '';

/**
 * Append one outcome to its UTC day's file; the first write of a day also drops files older than KEEP_DAYS.
 * The lines name repositories, rows and steps, and only root reads them (the supervisor), so the
 * directory is 0700 and the files 0600 (docs/isolation.md, Host state files).
 */
export function recordOutcome(dir, e, now = Date.now()) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendPrivate(join(dir, `outcomes-${day(e.at)}.jsonl`), `${JSON.stringify(e)}\n`, null);
  const today = day(now);
  if (today === lastPrune) return;
  lastPrune = today;
  const oldest = day(now - KEEP_DAYS * DAY_MS);
  for (const f of readdirSync(dir)) {
    const m = FILE.exec(f);
    if (m && m[1] < oldest) rmSync(join(dir, f), { force: true });
  }
}

/** Outcomes with `at` inside [since, until + 1 min], oldest first. A damaged line is skipped, and a job delivered twice counts once. */
export function readOutcomes(dir, since, until = Date.now()) {
  if (!existsSync(dir)) return [];
  const byId = new Map();
  for (const f of readdirSync(dir).sort()) {
    const m = FILE.exec(f);
    if (!m || m[1] < day(since) || m[1] > day(until + 60000)) continue;
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (Number.isFinite(e.at) && Number.isFinite(e.id) && typeof e.repo === 'string' && typeof e.class === 'string' && e.at >= since && e.at <= until + 60000 && !byId.has(e.id)) byId.set(e.id, e);
      } catch { /* a half-written line */ }
    }
  }
  return [...byId.values()].sort((a, b) => a.at - b.at);
}

/** Counts by class, the runner-suspect share, and run and wait percentiles, for the entries inside the window. */
export function summarizeOutcomes(entries, now, windowMs) {
  const inWin = entries.filter((e) => e.at > now - windowMs && e.at <= now + 60000);
  const classes = {};
  for (const e of inWin) classes[e.class] = (classes[e.class] ?? 0) + 1;
  const runners = {};
  let suspect = 0;
  for (const e of inWin) {
    if (!SUSPECT_CLASSES.includes(e.class)) continue;
    suspect++;
    runners[e.runner || '(none)'] = (runners[e.runner || '(none)'] ?? 0) + 1;
  }
  const pct = (key) => {
    const v = inWin.map((e) => e[key]).filter(Number.isFinite).sort((a, b) => a - b);
    return { n: v.length, p50: percentile(v, 50), p90: percentile(v, 90) };
  };
  return { n: inWin.length, classes, suspect: { n: suspect, rate: inWin.length ? suspect / inWin.length : null, runners }, runMs: pct('runMs'), waitMs: pct('waitMs') };
}
