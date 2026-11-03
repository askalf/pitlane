#!/usr/bin/env node
// gha-ondemand: runs the ephemeral first-party runners only while there is work for them.
//
// Idle runner listeners each hold memory for as long as they run. This dispatcher
// keeps each repository-scoped ephemeral row (manifest mode `ephemeral`, scope repo:<owner>/<repo>,
// any owner the manifest names) stopped while nothing waits for it, and starts it when a job does:
//   - every POLL_SEC it lists each repository's queued and in-progress workflow runs and their
//     queued jobs (conditional requests: an unchanged list costs no rate limit), a few repositories
//     at a time; a repository whose listing fails neither starts nor parks a row that tick, and
//     the others go on;
//   - a queued job no idle running listener can take starts a stopped row whose labels cover the
//     job's labels;
//   - a running listener with no job (no Runner.Worker in its unit) for IDLE_MIN, with no queued
//     job it could take, is parked: its GitHub registration removed, marked in PARK_DIR, then
//     stopped. A registration GitHub lists busy, or whose removal it refuses, holds a job: that
//     row is kept (releaseRegistration).
// The runner units are unchanged: each still takes one job and is restarted by systemd
// (Restart=always), so a listener that just finished is idle again and parks after IDLE_MIN.
// The host's runner watchdog reads PARK_DIR and leaves a parked unit alone instead of starting it again. A pool
// row parks itself from its mint step (the mark, then the exit its unit's ExecCondition= reads as
// "not this time"); its mark is this dispatcher's to clear, at the row's next start (clearedMarks).
// Org-scoped rows (the OSS pools) are not managed here: their jobs come from many repositories.
// Each tick still reads their units and lists them in dispatcher.json as `watched` (watchedRows), so
// a reader of the state files sees every row the supervisor watches, not only the ones this dispatcher moves.
//
// Pool rows (scope pool:<owner>, docs/pools.md) belong to no repository. askalf is a User account,
// so GitHub offers it no runner group a warm listener could serve every repository from; a row is
// registered to one repository at a time, and the pool decides which one at each start. A queued
// job that no row of its repository can take now (none idle, none stopped) is written as an entry in
// POOL_QUEUE (<job id>: "repo:<owner>/<name> <labels>") and a stopped pool row is started; the mint
// step claims the oldest entry, registers for that repository with the job's labels, and takes the
// job. Without the pool, a repository with only a few rows of its own waits in the queue while rows
// registered to other repositories idle. A verified webhook kick carries
// the job, so the pool start happens before the next listing (kickPlan).
//
// With HOOK_SECRET set, a loopback server (HOOK_PORT, default 7311, path /pitlane) takes GitHub's
// workflow_job webhook: a queued self-hosted job ticks at once instead of waiting out POLL_SEC.
// The poll stays as the backstop. Delivery: the tunnel routes a path to 127.0.0.1:HOOK_PORT.
//
// MODE=dry (the default) logs every start and park it would make and changes nothing. MODE=on acts.
// WARM names rows kept running whatever the queue says (comma-separated).
// EXEC_CAP (0, off, by default) is how many exec-tier rows may hold a job slot at once across every
// repository, so a burst of pushes queues behind the cap instead of running every job at once on the host's few CPUs.
// The GitHub token is the runner GitHub App's installation token for each repository's owner
// (gha-app-token.sh), whose calls count against the App's own budget; where the App has none, it is
// the host's GitHub token (its token file), shared with other GitHub pollers on the host. Either is
// sent as a header only. Runs as root (it starts and stops units).
//
// Every tick ends by writing its view to /run/askalf/pitlane/dispatcher.json (stateDoc): each managed
// row with what its unit read and what the tick did to it, each queued job and whether it went to
// the pool, the knobs, the token budget, the last hour of starts, parks and kicks, and what the box
// runs (deployRecord: the installed pitlane commit, this process's start, whether its code on disk is
// newer than that start). A reader of the state files draws its grid from this file; without it the only trace of a start or a park is
// a journal line, and a pool unit that ended failed would be visible nowhere.

import { kickServer, makeWaker } from './pitlane-kick.mjs';
import { recordOutcome } from './pitlane-outcomes.mjs';
import { makePrivate, ownJobRecords, privateDir, readerGid, recordWait, writeJobRecord, writePrivate } from './pitlane-waits.mjs';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** One template per account; keep in step with pool_of/template_for in gha-runners-apply.sh and the host's runner watchdog. */
export function unitFor(user, name) {
  if (user === 'gha-oss-read') return `gha-ephemeral-read@${name}.service`;
  if (user === 'gha-oss-write') return `gha-ephemeral-write@${name}.service`;
  if (user === 'gha-redline') return `gha-ephemeral-redline@${name}.service`;
  if (user === 'gha-exec') return `gha-ephemeral-first-party@${name}.service`;
  if (user === 'root') return `gha-ephemeral-build@${name}.service`;
  return `gha-ephemeral@${name}.service`;
}

/** The scope shapes runner-config.mjs accepts, for any owner: repo:<owner>/<repo> and pool:<owner>. */
export const REPO_SCOPE = /^repo:([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)$/;
export const POOL_SCOPE = /^pool:([A-Za-z0-9-]+)$/;

/**
 * The manifest rows this dispatcher manages: ephemeral, scoped to one repository (`repo`), or to the
 * pool of one owner's repositories (`pool`, with `repo` null: its labels come from the job it
 * claims). The owners are the ones the manifest names: none is built in, so a host that serves
 * another account or organization changes nothing here. Pure, exported for tests.
 */
export function managedRows(manifestText) {
  const rows = [];
  for (const line of manifestText.split('\n')) {
    if (/^\s*(#|$)/.test(line)) continue;
    const f = line.trim().split(/\s+/);
    if (f.length !== 7 || f[6] !== 'ephemeral') continue;
    const [name, scope, tier, user, , labels] = f;
    const m = REPO_SCOPE.exec(scope);
    const p = POOL_SCOPE.exec(scope);
    if (!m && !p) continue;
    rows.push({ name, repo: m ? m[1] : null, pool: p ? p[1] : null, tier, user, unit: unitFor(user, name), labels: labels.split(',').map((l) => l.toLowerCase()) });
  }
  return rows;
}

/**
 * The org-scoped ephemeral rows (scope org:<org>, the OSS pools): this dispatcher never starts or
 * parks them, it only reads their units for dispatcher.json. Pure, exported for tests.
 */
export function watchedRows(manifestText) {
  const rows = [];
  for (const line of manifestText.split('\n')) {
    if (/^\s*(#|$)/.test(line)) continue;
    const f = line.trim().split(/\s+/);
    if (f.length !== 7 || f[6] !== 'ephemeral') continue;
    const [name, scope, tier, user, , labels] = f;
    const m = /^org:([A-Za-z0-9-]+)$/.exec(scope);
    if (!m) continue;
    rows.push({ name, org: m[1], tier, user, unit: unitFor(user, name), labels: labels.split(',').map((l) => l.toLowerCase()) });
  }
  return rows;
}

/** Whether a row's labels cover every label a job asks for. */
const covers = (row, job) => job.labels.every((l) => row.labels.includes(String(l).toLowerCase()));

const isExec = (row) => row?.tier === 'exec';
const isPool = (row) => Boolean(row?.pool);
/**
 * The pool rows that may serve a job: those of its repository's owner, for a job one of the
 * repository's plain exec rows covers. A job no row of the repository runs is not the pool's to
 * guess at, and a lane's jobs (label <repo>-fix for the fix lane, <repo>-review for the review
 * lane) stay on that lane's rows: those are the only rows in the group that reads the lane's key
 * (docs/isolation.md, Key files), so a pool job, which may come from any repository, never can.
 */
const LANE_LABEL = /-(fix|review)$/;
const poolFor = (rows, job) => {
  const plain = rows.some((r) => r.repo === job.repo && isExec(r) && covers(r, job) && !r.labels.some((l) => LANE_LABEL.test(l)));
  return plain ? rows.filter((r) => isPool(r) && job.repo.startsWith(`${r.pool}/`)) : [];
};
/** The rows with only the first `max` pool rows (manifest order) kept: the roll-in knob (POOL_MAX); null keeps all, 0 turns the pool off. */
export function limitPool(rows, max) {
  if (max == null) return rows;
  let n = 0;
  return rows.filter((r) => !isPool(r) || n++ < max);
}

/**
 * The decisions for one tick. `state` maps a row name to { active, busy, idleSince } (idleSince:
 * when it was first seen running with no job, else null); `queued` is the queued jobs as
 * { repo, labels }. Each queued job is taken by an idle running listener that covers it if there is
 * one, else by a stopped row that covers it, which is started. A running listener idle for idleMs,
 * not kept warm, that no queued job could use is parked; a stopped warm row is started. A row named
 * in `hold` is never parked: its repository's listing failed this tick, so a job GitHub has just
 * handed it is not known.
 *
 * With `execCap` above 0, no start takes the exec-tier rows holding a slot (running with a job, or
 * running idle and not warm) past execCap. A job that would need one more waits (counted in `held`).
 * While jobs wait, an idle exec listener no queued job can use, not warm and idle for pressureIdleMs,
 * is parked at once to make room (also listed in `room`). An idle warm listener holds no slot until
 * it takes a job, so the warm exec rows can carry the count past the cap by at most their number.
 *
 * A job that no row of its repository can take now (none idle, none stopped: all busy, or already
 * given to an earlier job this tick) goes to the pool, when pool rows of its owner exist: it is
 * listed in `queue` (the host writes it as an entry for the mint step to claim), and a running idle
 * pool row registered for that repository (`state[name].claimed`, from the mint step's claim file),
 * or still minting with no claim yet, is counted as taking it; otherwise a stopped pool row is
 * started, under the exec cap like any exec row. A pool row idle for poolIdleMs is parked: its
 * registration serves one repository, and the pool's worth is being free for the next. Pool rows
 * are never warm. Pure, exported for tests.
 */
export const POOL_IDLE_MS = 45000;
export function plan(rows, state, queued, { now, idleMs, warm = [], hold = [], execCap = 0, pressureIdleMs = 30000, poolIdleMs = POOL_IDLE_MS }) {
  const start = [];
  const park = [];
  const room = [];
  const queue = [];
  const byName = new Map(rows.map((r) => [r.name, r]));
  const free = new Set(rows.filter((r) => state[r.name]?.active && !state[r.name]?.busy).map((r) => r.name));
  // A row the supervisor holds after a crash loop is never started from here, warm or not.
  const stopped = new Set(rows.filter((r) => !state[r.name]?.active && !state[r.name]?.held).map((r) => r.name));
  let load = rows.filter((r) => isExec(r) && state[r.name]?.active && (state[r.name]?.busy || !warm.includes(r.name))).length;
  const idleFor = (name) => {
    const since = state[name]?.idleSince;
    return since === null || since === undefined ? -1 : now - since;
  };
  // A warm row is kept running: one found stopped (parked before it was named warm) is started.
  for (const name of warm) {
    if (stopped.delete(name)) start.push(name);
  }
  // The stopped row to start, the first in manifest order; one whose unit systemd holds failed
  // comes last, so a pool row that will not start (it failed after a job) does not take
  // every pool start while the others sit stopped. It is still tried once nothing else is left:
  // startUnit resets it, and a start that works ends the failed state.
  const firstStopped = (cands) => cands.find((r) => stopped.has(r.name) && state[r.name]?.raw !== 'failed') ?? cands.find((r) => stopped.has(r.name));
  const waiting = [];
  for (const job of queued) {
    const fits = rows.filter((r) => r.repo === job.repo && covers(r, job));
    const idle = fits.find((r) => free.has(r.name));
    if (idle) {
      free.delete(idle.name);
      if (isExec(idle) && warm.includes(idle.name)) load += 1;
      continue;
    }
    let off = firstStopped(fits);
    let candidates = fits;
    if (!off) {
      const pool = poolFor(rows, job);
      if (!pool.length) continue;
      queue.push(job);
      const ready = pool.find((r) => free.has(r.name) && (!state[r.name]?.claimed || state[r.name].claimed === job.repo));
      if (ready) {
        free.delete(ready.name);
        continue;
      }
      off = firstStopped(pool);
      if (!off) continue;
      candidates = pool;
    }
    // Under the cap, exec starts are decided after the room-making parks below, in queue order.
    if (execCap > 0 && isExec(off)) {
      waiting.push(candidates);
      continue;
    }
    stopped.delete(off.name);
    start.push(off.name);
  }
  const short = waiting.length - Math.max(0, execCap - load);
  if (short > 0) {
    const spare = [...free]
      .filter((name) => isExec(byName.get(name)) && !warm.includes(name) && !hold.includes(name) && idleFor(name) >= pressureIdleMs)
      .sort((a, b) => idleFor(b) - idleFor(a))
      .slice(0, short);
    for (const name of spare) {
      free.delete(name);
      park.push(name);
      room.push(name);
      load -= 1;
    }
  }
  let held = 0;
  for (const fits of waiting) {
    const off = firstStopped(fits);
    if (!off) continue;
    if (load >= execCap) {
      held += 1;
      continue;
    }
    stopped.delete(off.name);
    start.push(off.name);
    load += 1;
  }
  for (const name of free) {
    if (warm.includes(name) || hold.includes(name)) continue;
    if (idleFor(name) >= (isPool(byName.get(name)) ? poolIdleMs : idleMs)) park.push(name);
  }
  return { start, park, room, held, queue };
}

/**
 * What a verified kick does before the next listing, from the last tick's view and the kicks since,
 * in the order the tick's plan uses: the job is taken by a running idle row of its repository that
 * covers it (GitHub hands it the job within seconds), else by a stopped one, which is started, else
 * it is an entry for the pool (`queue`) and a running idle pool row registered for that repository,
 * or minting with no claim yet, takes it, else a stopped pool row is started. An exec start waits at
 * the exec cap; the tick that follows takes it. `take` names the row counted for the job: the host
 * marks it promised (`promised`), so the next kick of the same burst does not count it again.
 *
 * A kick looks at the repository's own rows as well as the pool: in a burst, every kick would
 * otherwise see the same warm idle row of the repository and do nothing, so the burst's other jobs
 * would wait for the next listing, a few per tick. Pure, exported for tests.
 */
export function kickPlan(rows, state, job, { execCap = 0, load = 0 } = {}) {
  const idle = (r) => state[r.name]?.active && !state[r.name]?.busy;
  // As in plan: a held row is never a candidate, and a stopped row whose unit systemd holds failed
  // comes last, still tried when it is the only one.
  const stopped = (cands) => {
    const off = cands.filter((r) => !state[r.name]?.active && !state[r.name]?.held);
    return off.find((r) => state[r.name]?.raw !== 'failed') ?? off[0];
  };
  const capped = (r) => isExec(r) && execCap > 0 && load >= execCap;
  const fits = rows.filter((r) => r.repo === job.repo && covers(r, job));
  const mine = fits.find(idle);
  if (mine) return { queue: false, start: null, take: mine.name };
  const own = stopped(fits);
  if (own) return capped(own) ? { queue: false, start: null, take: null } : { queue: false, start: own.name, take: own.name };
  const pool = poolFor(rows, job);
  if (!pool.length) return { queue: false, start: null, take: null };
  const ready = pool.find((r) => idle(r) && (!state[r.name]?.claimed || state[r.name].claimed === job.repo));
  if (ready) return { queue: true, start: null, take: ready.name };
  const off = stopped(pool);
  if (!off || capped(off)) return { queue: true, start: null, take: null };
  return { queue: true, start: off.name, take: off.name };
}

/**
 * The last tick's view after a kick's plan: the row it took is promised to that job (running, and
 * counted busy until the next tick's view replaces this one), and a pool row carries the repository
 * it was taken for. Pure, exported for tests.
 */
export function promised(state, fast, repo) {
  if (!fast.take) return state;
  return { ...state, [fast.take]: { ...state[fast.take], active: true, busy: true, idleSince: null, ...(fast.queue ? { claimed: repo } : {}) } };
}

/**
 * The pool queue on disk: one entry per job routed to the pool, named by job id, holding
 * "repo:<owner>/<name> <labels>" for the mint step to claim (it renames the entry to .<row>, its
 * claim file, which `claimOf` reads). An entry for a job this tick did not route (taken, done,
 * cancelled, or given to a row of its own) is removed once it is 15 s old: a kick writes an entry
 * before the listing confirms the job, and a listing can lag a delivery by a few seconds.
 * Exported for tests.
 */
export function syncQueue(dir, routed, now = Date.now()) {
  const keep = new Set();
  for (const job of routed) {
    if (!Number.isInteger(job.id) || job.id <= 0) continue;
    keep.add(String(job.id));
    try {
      writeFileSync(join(dir, String(job.id)), `repo:${job.repo} ${job.labels.join(',')}\n`, { flag: 'wx', mode: 0o600 });
    } catch { /* already written, by a kick or an earlier tick */ }
  }
  for (const f of readdirSync(dir)) {
    if (f.startsWith('.') || keep.has(f)) continue;
    try {
      if (now - statSync(join(dir, f)).mtimeMs > 15000) rmSync(join(dir, f), { force: true });
    } catch { /* claimed meanwhile */ }
  }
}

/** The repository a pool row's claim file names, or null (no claim yet, or the row has never run). */
export function claimOf(dir, name) {
  try {
    return /^repo:(\S+)/.exec(readFileSync(join(dir, `.${name}`), 'utf8'))?.[1] ?? null;
  } catch { return null; }
}

/**
 * The park marks a tick clears, before it parks anything (a unit parked now still reads active in
 * this snapshot): a managed repository row's, once its unit runs again (a start of this dispatcher's
 * own clears the mark first, so this is someone else's start). A pool row's mark stays whatever its
 * unit reads: the mint step writes it from inside a start that is ending (the unit reads activating
 * a moment longer), and a pool row past POOL_MAX is not in `rows` at all, parked by apply until the
 * dispatcher is given it. The mark of any other unit not managed here stays for the same reason
 * (the marks of the pool rows past POOL_MAX must not be cleared every tick, or the supervisor
 * counts those rows as down).
 */
export function clearedMarks(marks, rows, state) {
  return marks.filter((f) => {
    const r = rows.find((x) => x.unit === f);
    return Boolean(r) && !r.pool && ['active', 'activating'].includes(state[r.name]?.raw);
  });
}

/** Thrown when the token's hour is near its floor: the tick stops asking every repository, not just one. */
export class RateFloorError extends Error {}

/**
 * Lists every repository's jobs through `fetchRepo`, at most `concurrency` at once, so one tick costs
 * about the slowest few repositories instead of all of them in a row. A repository that throws is
 * returned in `failed` with its message and the rest are still asked; a RateFloorError ends the
 * asking and marks the repositories not yet asked as failed with it. Exported for tests.
 */
export async function collectJobs(repos, fetchRepo, { concurrency = 4 } = {}) {
  const queued = [];
  const taken = new Set();
  const failed = new Map();
  let floor = null;
  let next = 0;
  async function worker() {
    while (next < repos.length) {
      const repo = repos[next++];
      if (floor) {
        failed.set(repo, floor.message);
        continue;
      }
      try {
        const j = await fetchRepo(repo);
        queued.push(...j.queued);
        for (const n of j.taken) taken.add(n);
      } catch (err) {
        failed.set(repo, err?.message ?? String(err));
        if (err instanceof RateFloorError) floor = err;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, repos.length)) }, worker));
  return { queued, taken, failed, floor };
}

// ---- the host side -------------------------------------------------------------------------

const env = process.env;
const MODE = env.MODE === 'on' ? 'on' : 'dry';
const POLL_SEC = Math.max(15, Number(env.POLL_SEC) || 30);
const IDLE_MIN = Math.max(2, Number(env.IDLE_MIN) || 10);
const WARM = String(env.WARM ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const EXEC_CAP = /^\d{1,3}$/.test(String(env.EXEC_CAP ?? '')) ? Number(env.EXEC_CAP) : 0;
const POOL_MAX = /^\d{1,3}$/.test(String(env.POOL_MAX ?? '')) ? Number(env.POOL_MAX) : null;
const HOOK_SECRET = env.HOOK_SECRET || '';
const HOOK_PORT = /^\d{2,5}$/.test(String(env.HOOK_PORT ?? '')) ? Number(env.HOOK_PORT) : 7311;
const MANIFEST = env.GHA_MANIFEST || '/etc/askalf/gha-runners.manifest';
const TOKEN_ENV = env.GHA_TOKEN_ENV || '/root/.askalf/.env';
export const PARK_DIR = env.PARK_DIR || '/run/askalf/gha-ondemand';

const log = (msg) => console.log(`gha-ondemand[${MODE}]: ${msg}`);

const APP_TOKEN = env.GHA_APP_TOKEN || '/opt/askalf/gha-app-token.sh';

// gha-app-token.sh, asked without blocking: a refresh that waits on GitHub (up to a minute and a
// half) must not stall the poll loop or the webhook server while it does.
const execFileText = (cmd, args, opts) => new Promise((resolve) => {
  execFile(cmd, args, opts, (err, stdout) => resolve(err ? '' : String(stdout).trim()));
});
const APP_TOKEN_MEMO_MS = 5 * 60 * 1000;
const appMemo = new Map();

/**
 * The runner App's installation token for `owner`, narrowed to actions=read on every repository (all
 * a tick does with it is list runs and jobs), or '' when it has none (not configured, not installed
 * there, or the mint failed). `ask` replaces that narrowing: a park asks for [<repo name>,
 * 'administration=write'], the one repository whose runner registration it removes. Each ask is kept
 * in memory apart for five minutes, the empty answer too, so a tick spawns nothing: the helper hands
 * out tokens with at least ten minutes left. `run` and `now` are injectable.
 */
export async function appToken(owner, { run = execFileText, now = Date.now, ask = ['-', 'actions=read'] } = {}) {
  const key = [owner, ...ask].join(' ');
  const memo = appMemo.get(key);
  if (memo && now() - memo.at < APP_TOKEN_MEMO_MS) return memo.tok;
  const tok = await run(APP_TOKEN, [owner, ...ask], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 90000 });
  appMemo.set(key, { tok, at: now() });
  return tok;
}

/**
 * The repository a row's runner is registered in: a repository row's own, a pool row's claimed one
 * (its claim file), or null when that is not known or not a repository name. Pure, exported for tests.
 */
export function registeredIn(row, state) {
  const repo = row.repo ?? state[row.name]?.claimed ?? null;
  return typeof repo === 'string' && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo) ? repo : null;
}

/**
 * Take a row's runner registration off GitHub before the row is stopped, so no job is handed to a
 * listener on its way down. A stopped listener is not gone for GitHub at once: a job queued from
 * just before a park to two seconds after it went to the stopping runner and waited out GitHub's
 * hand-back, about 70 s, while a warm listener of the same labels sat idle.
 * A registration GitHub lists busy, or whose removal it refuses with 422, holds a job the cgroup
 * does not show yet: that row is kept. The answer is 'released' (removed), 'gone' (no registration
 * of that name, or removed meanwhile), 'busy', or 'error' with `why` (the caller parks as before).
 * The name is matched whole: pool-e1 is not pool-e10. `http` is injectable.
 */
export async function releaseRegistration(repo, name, tok, { http = fetch } = {}) {
  const headers = { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'askalf-gha-ondemand' };
  const call = (method, path) => http(`https://api.github.com/${path}`, { method, headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
  try {
    const list = await call('GET', `repos/${repo}/actions/runners?name=${encodeURIComponent(name)}&per_page=100`);
    if (!list.ok) return { outcome: 'error', why: `GitHub ${list.status} listing the runners of ${repo}` };
    const reg = ((await list.json())?.runners ?? []).find((r) => r.name === name);
    if (!reg) return { outcome: 'gone' };
    if (reg.busy) return { outcome: 'busy', id: reg.id };
    const del = await call('DELETE', `repos/${repo}/actions/runners/${reg.id}`);
    if (del.status === 204) return { outcome: 'released', id: reg.id };
    if (del.status === 404) return { outcome: 'gone', id: reg.id };
    if (del.status === 422) return { outcome: 'busy', id: reg.id };
    return { outcome: 'error', id: reg.id, why: `GitHub ${del.status} removing runner ${reg.id} from ${repo}` };
  } catch (err) {
    return { outcome: 'error', why: String(err?.message ?? err) };
  }
}

/** Each repository's owner mapped to the token its requests use: the App's when it has one, else `fallback`. */
export async function tokensByOwner(repos, fallback, app = appToken) {
  const owners = [...new Set(repos.map((r) => r.split('/')[0]))];
  return new Map(await Promise.all(owners.map(async (o) => {
    const t = await app(o);
    return [o, t ? { tok: t, source: 'app' } : { tok: fallback, source: 'GITHUB_TOKEN' }];
  })));
}

function token() {
  const line = readFileSync(TOKEN_ENV, 'utf8').split('\n').find((l) => l.startsWith('GITHUB_TOKEN='));
  return line ? line.slice('GITHUB_TOKEN='.length).replace(/^"|"$/g, '').trim() : '';
}

// Below this many requests left on the token's hour, a tick stops asking: the token is shared with
// the host's other GitHub pollers, and a flood of new runs (each a jobs request no ETag can save) must not drain it.
const RATE_FLOOR = /^\d+$/.test(String(env.RATE_FLOOR ?? '')) ? Number(env.RATE_FLOOR) : 1500;
// On the App's token the hour is this process's and the mint step's alone (a small, steady rate), so the
// floor only has to leave the mint step room, not every caller of the account.
const APP_RATE_FLOOR = /^\d+$/.test(String(env.APP_RATE_FLOOR ?? '')) ? Number(env.APP_RATE_FLOOR) : 500;
let rateFloor = RATE_FLOOR;
let rateLeft = Infinity;
let rateReset = 0;   // when the token's hour starts over, epoch ms
const etags = new Map();
const cache = new Map();
/** A GET with If-None-Match: an unchanged answer (304) is served from the cache and costs no rate limit. */
async function gh(path, tok) {
  const headers = { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'askalf-gha-ondemand' };
  if (etags.has(path)) headers['If-None-Match'] = etags.get(path);
  const res = await fetch(`https://api.github.com/${path}`, { headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
  // Read only when present: an error or secondary-limit answer can omit them, and Number(null) is 0.
  const num = (h) => (/^\d{1,12}$/.test(res.headers.get(h) ?? '') ? Number(res.headers.get(h)) : null);
  const left = num('x-ratelimit-remaining');
  const reset = num('x-ratelimit-reset');
  if (left !== null && reset !== null) {
    rateLeft = left;
    rateReset = reset * 1000;
  }
  if (res.status === 304) return cache.get(path);
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${path.split('?')[0]}`);
  const json = await res.json();
  const tag = res.headers.get('etag');
  if (tag) {
    etags.set(path, tag);
    cache.set(path, json);
  }
  return json;
}

/**
 * One repository's self-hosted jobs: the ones waiting for a runner, and the runner names holding one.
 * A listener GitHub has just handed a job reads idle here until its Runner.Worker starts; its name in
 * `taken` keeps it from being parked in that gap.
 */
/** Every page of a list (up to 10), each page a conditional request of its own. */
async function pages(path, key, tok) {
  const all = [];
  for (let page = 1; page <= 10; page += 1) {
    // Once the hour has started over, the next answer brings the new count.
    if (rateLeft < rateFloor && Date.now() >= rateReset) rateLeft = Infinity;
    if (rateLeft < rateFloor) throw new RateFloorError(`GitHub rate limit at ${rateLeft} left (floor ${rateFloor}); this tick stops asking`);
    const got = (await gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, tok))?.[key] ?? [];
    all.push(...got);
    if (got.length < 100) break;
  }
  return all;
}

async function repoJobs(repo, tok) {
  const queued = [];
  const taken = [];
  for (const status of ['queued', 'in_progress']) {
    const runs = await pages(`repos/${repo}/actions/runs?status=${status}`, 'workflow_runs', tok);
    for (const run of runs) {
      const jobs = await pages(`repos/${repo}/actions/runs/${run.id}/jobs?filter=latest`, 'jobs', tok);
      for (const j of jobs) {
        if (!(j.labels ?? []).includes('self-hosted')) continue;
        if (j.status === 'queued') queued.push({ id: j.id, repo, labels: j.labels });
        else if (j.status === 'in_progress' && j.runner_name) taken.push(j.runner_name);
      }
    }
  }
  return { queued, taken };
}

const systemctl = (...a) => execFileSync('systemctl', a, { encoding: 'utf8' });

/** A unit's state: running or not, and whether its cgroup holds a Runner.Worker (a job). */
function unitState(unit) {
  const show = systemctl('show', '-p', 'ActiveState,ControlGroup', unit);
  const raw = /ActiveState=(\w+)/.exec(show)?.[1] ?? 'unknown';
  const active = ['active', 'activating', 'deactivating', 'reloading'].includes(raw);
  const cg = /ControlGroup=(.+)/.exec(show)?.[1]?.trim();
  let busy = false;
  if (active && cg) {
    try {
      for (const pid of readFileSync(`/sys/fs/cgroup${cg}/cgroup.procs`, 'utf8').split('\n').filter(Boolean)) {
        try {
          if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('Runner.Worker')) busy = true;
        } catch { /* the process ended */ }
      }
    } catch { /* the cgroup went with the unit */ }
  }
  return { raw, active, busy };
}

/**
 * When a row's idle stretch began, for the next tick: the time it was first seen running with no
 * job, kept while that holds, null otherwise. A unit still activating (the mint step: claiming,
 * minting, lingering for a queued job) is not idle: it cannot take a job yet, it parks itself when
 * nothing is queued, and a stop sent to it then kills the mint step and leaves the unit failed
 * (a pool row parked 45 s after a start whose mint step ran long under CPU pressure ended
 * failed this way). Exported for tests.
 */
export function idleClock(prev, s, now) {
  if (s.raw !== 'active' || s.busy) return null;
  return prev ?? now;
}

/**
 * The tick's view as one document, for dispatcher.json. `rows` and `state` are the tick's; `marks`
 * is PARK_DIR after the tick's parks; `hold` names the rows whose repository's listing failed (a row's
 * `held` is the supervisor's crash-loop mark, a different thing);
 * `decided` is plan()'s answer; `load` the exec slots in use after the starts. A row's `tick` says
 * what this tick did to it: 'start', 'park' (idle), 'park-room' (parked to make room under the exec
 * cap), or null. An idleSince of Infinity (dry mode's "logged once") serialises as null. `watched`
 * is the org rows (watchedRows) with their unit reading and the supervisor's held mark: listed apart
 * from `rows`, since no decision of this dispatcher touches them. Pure, exported for tests.
 */
export function stateDoc({ now, mode, rows, state, marks, hold = [], queued, decided, knobs, load, github, events, deploy = null, watched = [] }) {
  const started = new Set(decided.start);
  const room = new Set(decided.room);
  const parked = new Set(decided.park);
  const routed = new Set(decided.queue.map((j) => j.id));
  return {
    at: now,
    mode,
    knobs: { ...knobs, poolIdleSec: POOL_IDLE_MS / 1000 },
    rows: rows.map((r) => {
      const s = state[r.name] ?? {};
      return {
        name: r.name, repo: r.repo, pool: r.pool, tier: r.tier, unit: r.unit, labels: r.labels,
        raw: s.raw ?? 'unknown', busy: Boolean(s.busy), idleSince: Number.isFinite(s.idleSince) ? s.idleSince : null, claimed: s.claimed ?? null,
        parked: marks.includes(r.unit), warm: knobs.warm.includes(r.name), hold: hold.includes(r.name), held: Boolean(s.held),
        tick: started.has(r.name) ? 'start' : room.has(r.name) ? 'park-room' : parked.has(r.name) ? 'park' : null,
      };
    }),
    watched: watched.map((r) => ({ name: r.name, org: r.org, tier: r.tier, unit: r.unit, labels: r.labels, raw: r.raw ?? 'unknown', busy: Boolean(r.busy), held: Boolean(r.held) })),
    queued: queued.map((j) => ({ id: j.id, repo: j.repo, labels: j.labels, pool: routed.has(j.id) })),
    held: decided.held,
    load,
    github,
    events,
    deploy,
  };
}

/** The events kept for dispatcher.json: `e` stamped `now` and added, those older than the window dropped, the newest `max` kept. Pure. */
export function recent(events, e, now, { windowMs = 3600000, max = 300 } = {}) {
  const kept = events.filter((x) => now - x.at <= windowMs);
  kept.push({ at: now, ...e });
  return kept.slice(-max);
}

/**
 * What the box runs, for dispatcher.json. `ref` is the pitlane commit the host deploy installed: the
 * deploy copies a PITLANE_REF file beside this file (REF_FILE) in the same run as the
 * files at that commit, so the copy's mtime (installedAt) is when they last changed; null until a
 * deploy has written it, or when it holds no commit. `restart` is true when a module this process
 * loaded is newer on disk than its start: the deploy restarts the dispatcher when one of them
 * changes, so true means a copy reached the disk without that restart and the code running is
 * older than the code on disk. Pure, exported for tests.
 */
export function deployRecord({ ref, installedAt, startedAt, codeAt }) {
  const sha = typeof ref === 'string' ? ref.trim() : '';
  return {
    ref: /^[0-9a-f]{40}$/.test(sha) ? sha : null,
    installedAt: Number.isFinite(installedAt) ? Math.round(installedAt) : null,
    startedAt,
    restart: Number.isFinite(codeAt) && codeAt > startedAt,
  };
}

/** The modules this process loaded: a newer copy of any of them means the code on disk has moved on. */
const MODULES = ['./gha-ondemand.mjs', './pitlane-kick.mjs', './pitlane-waits.mjs', './pitlane-outcomes.mjs'].map((f) => fileURLToPath(new URL(f, import.meta.url)));

/** deployRecord from the files: a missing or unreadable file reads as nothing, never as an error. */
export function readDeploy(startedAt, { refFile = REF_FILE, modules = MODULES } = {}) {
  let ref = null;
  let installedAt = null;
  try { ref = readFileSync(refFile, 'utf8'); installedAt = statSync(refFile).mtimeMs; } catch { /* no deploy has written it */ }
  let codeAt = null;
  for (const f of modules) {
    try { codeAt = Math.max(codeAt ?? 0, statSync(f).mtimeMs); } catch { /* a module that is not there is not newer */ }
  }
  return deployRecord({ ref, installedAt, startedAt, codeAt });
}

/** The document written whole, readable by root and the reader group only (writePrivate): a reader never sees a half-written file. */
export function writeState(path, doc, gid = readerGid()) {
  writePrivate(path, JSON.stringify(doc), gid);
}

/** The pool queue (syncQueue) and the mint step's claim files; root-only, as the mint step is root too. */
const POOL_QUEUE = env.POOL_QUEUE || join(env.PITLANE_DIR || '/run/askalf/pitlane', 'pool-queue');
const RUN_DIR = env.PITLANE_DIR || '/run/askalf/pitlane';
const BEAT = join(RUN_DIR, 'dispatcher.beat');
/** The supervisor's held marks, one file per unit (docs/supervisor.md): a row held after a crash loop is not started. */
const HELD_DIR = join(env.PITLANE_DIR || '/run/askalf/pitlane', 'held');
function heldUnits() {
  try { return new Set(readdirSync(HELD_DIR)); } catch { return new Set(); }
}
/** The tick's view (stateDoc), for a reader of the state files. */
const STATE = join(env.PITLANE_DIR || '/run/askalf/pitlane', 'dispatcher.json');
/** The pitlane commit the host deploy installed (deployRecord): the PITLANE_REF file that deploy copies. */
const REF_FILE = env.PITLANE_REF_FILE || '/opt/askalf/pitlane.ref';
/** The supervisor reads this file's age: a tick that stops arriving shows as a stale beat. */
const WAITS = join(env.PITLANE_DIR || '/run/askalf/pitlane', 'waits.jsonl');
/** Each started job's wait for that job's own completed hook (writeJobRecord, docs/showcase.md). */
const JOBS = join(env.PITLANE_DIR || '/run/askalf/pitlane', 'jobs');
const ROWS_ROOT = env.GHA_ROOT || '/srv/gha';
/** Finished jobs, one file per day: on disk, not in /run, so the record outlives a reboot. */
const OUTCOMES = env.PITLANE_STATE_DIR || '/var/lib/askalf/pitlane';
/** The reader group of the files a state-file reader needs (readerGid); the outcomes and park marks have none. */
const READ_GID = readerGid();
function beat() {
  try { mkdirSync(RUN_DIR, { recursive: true, mode: 0o711 }); writePrivate(BEAT, `${Date.now()}\n`, READ_GID); } catch { /* the supervisor will say so */ }
}

/**
 * Starts a unit. reset-failed first, so a unit that hit its start limit starts again; on a unit systemd
 * has never loaded (an instance never started since boot) that call fails, and the start below is what
 * matters, so the failure is a log line and not the end of the tick (ending the tick would drop
 * every start and park it had planned).
 */
function startUnit(unit) {
  // The plan skips a held row; this covers a mark written between the tick's read and the start.
  if (existsSync(join(HELD_DIR, unit))) { log(`start ${unit}: held by the supervisor after a crash loop, not started`); return; }
  // apply enables a row once its user, isolation and CPU drop-ins are in place. A row that is only in the
  // manifest has none of them: started, it runs as the template's user, and apply then takes its files away
  // mid-job (the first jobs of a new row fail between the deploy and apply).
  try { systemctl('is-enabled', '--quiet', unit); } catch { log(`start ${unit}: not enabled, so gha-runners-apply.sh apply has not run for it; not started`); return; }
  rmSync(join(PARK_DIR, unit), { force: true });
  try { systemctl('reset-failed', unit); } catch (err) { log(`reset-failed ${unit}: ${String(err?.message ?? err).split('\n')[0]}`); }
  systemctl('start', '--no-block', unit);
}

async function main() {
  // What a job may not see (docs/isolation.md, Host state files): the run directory opens to a known
  // name (jobs/<row>, public/) but lists nothing; the park marks and the outcomes are root's alone. The
  // modes are set again on start, so the directories and files from before this change follow.
  privateDir(RUN_DIR, 0o711);
  privateDir(PARK_DIR, 0o700);
  mkdirSync(POOL_QUEUE, { recursive: true, mode: 0o700 });
  makePrivate([STATE, BEAT, WAITS, `${WAITS}.1`], READ_GID);
  // A row's record follows the row's group: one written while the row shared a group with other rows
  // stays readable by them until it is rewritten, and an idle row never rewrites it (docs/isolation.md).
  try {
    const n = ownJobRecords(JOBS, ROWS_ROOT);
    if (n) log(`job records: ${n} given their row's group again`);
  } catch (err) { log(`job records at ${JOBS}: groups not set (${err?.message ?? err}); writeJobRecord sets each at the row's next job`); }
  try {
    privateDir(OUTCOMES, 0o700);
    makePrivate(readdirSync(OUTCOMES).map((f) => join(OUTCOMES, f)), null);
  } catch (err) { log(`outcomes at ${OUTCOMES}: modes not set (${err?.message ?? err}); recordOutcome sets them at its next write`); }
  const idleSince = new Map();
  let lastSources = '';
  log(`managing the repository-scoped ephemeral rows; poll ${POLL_SEC}s, park after ${IDLE_MIN}m idle${EXEC_CAP ? `, exec cap ${EXEC_CAP}` : ''}${POOL_MAX != null ? `, pool rows ${POOL_MAX}` : ''}${WARM.length ? `, warm: ${WARM.join(', ')}` : ''}`);
  const waker = makeWaker();
  // While jobs wait on the exec cap, a finished job is when a slot frees: tick then, not at the poll.
  let held = 0;
  // The last tick's view, for the kick path: rows, their state, and the exec slots in use after its starts.
  let last = { rows: [], state: {}, load: 0 };
  // The last hour's starts, parks, kicks and failures, for dispatcher.json; and the last document
  // written, so a tick that fails still leaves the rows of the one before it, marked with the error.
  let events = [];
  let lastDoc = null;
  const startedAt = Date.now();
  const note = (e) => { events = recent(events, e, Date.now()); };
  const knobs = { pollSec: POLL_SEC, idleMin: IDLE_MIN, execCap: EXEC_CAP, poolMax: POOL_MAX, warm: WARM };
  if (HOOK_SECRET) {
    const onOutcome = (e) => {
      recordOutcome(OUTCOMES, e);
      if (held > 0) waker.kick();
    };
    // A kick names its job: the row that takes it is decided now, from the last tick's view and the
    // kicks since (kickPlan), and a stopped one starts now, so no job of a burst waits the listing.
    // A delivery GitHub sends again counts once until the next tick.
    const onKick = (job) => {
      if (job && !(last.kicked ??= new Set()).has(job.id)) {
        last.kicked.add(job.id);
        note({ kind: 'kick', repo: job.repo, job: job.id });
        const fast = kickPlan(last.rows, last.state, job, { execCap: EXEC_CAP, load: last.load });
        if (fast.queue) {
          (last.pending ??= {})[job.id] = job;
          syncQueue(POOL_QUEUE, Object.values(last.pending));
        }
        const row = fast.take ? last.rows.find((r) => r.name === fast.take) : null;
        if (fast.start) {
          const whose = fast.queue ? 'pool' : 'its own row';
          log(`start ${row.unit}: a queued job in ${job.repo} kicked (${whose}, before the listing)`);
          note({ kind: 'start', row: fast.start, unit: row.unit, repo: job.repo, why: `kicked: a queued job, ${whose}, before the listing` });
          if (MODE === 'on') startUnit(row.unit);
        }
        // An exec row holds a slot once it has a job: a start, or a warm idle row taking one.
        if (row && isExec(row) && (fast.start || WARM.includes(row.name))) last.load += 1;
        last.state = promised(last.state, fast, job.repo);
      }
      waker.kick();
    };
    const onJob = (t) => {
      recordWait(WAITS, t, READ_GID);
      writeJobRecord(JOBS, ROWS_ROOT, t);
    };
    await kickServer({ secret: HOOK_SECRET, port: HOOK_PORT, onKick, onJob, onOutcome, log });
    log(`webhook on 127.0.0.1:${HOOK_PORT}/pitlane`);
  }
  for (;;) {
    waker.markStart();
    beat();
    try {
      const manifest = readFileSync(MANIFEST, 'utf8');
      const rows = limitPool(managedRows(manifest), POOL_MAX);
      const repos = [...new Set(rows.map((r) => r.repo).filter(Boolean))];
      const toks = await tokensByOwner(repos, token());
      rateFloor = [...toks.values()].every((t) => t.source === 'app') ? APP_RATE_FLOOR : RATE_FLOOR;
      const sources = [...toks].map(([o, t]) => `${o}: ${t.source}`).join(', ');
      if (sources !== lastSources) { log(`token per owner: ${sources}`); lastSources = sources; }
      const missing = [...toks].filter(([, t]) => !t.tok).map(([o]) => o);
      if (missing.length) throw new Error(`no App token and no GITHUB_TOKEN in ${TOKEN_ENV} for ${missing.join(', ')}`);
      // Four at once: one repository's answer no longer waits on all the others', and the token's
      // rate floor is still checked before every request.
      const { queued, taken, failed, floor } = await collectJobs(repos, (repo) => repoJobs(repo, toks.get(repo.split('/')[0]).tok), { concurrency: 4 });
      if (floor) {
        log(`${floor.message} (${failed.size} of ${repos.length} repositories not listed)`);
        note({ kind: 'floor', why: floor.message, repos: failed.size });
      }
      for (const [repo, msg] of failed) {
        if (!floor || msg !== floor.message) {
          log(`${repo}: ${msg}; its rows neither start nor park this tick`);
          note({ kind: 'listing-failed', repo, why: msg });
        }
      }
      const hold = rows.filter((r) => failed.has(r.repo)).map((r) => r.name);
      const now = Date.now();
      const state = {};
      const heldNow = heldUnits();
      for (const r of rows) {
        const s = unitState(r.unit);
        if (taken.has(r.name)) s.busy = true;
        const since = idleClock(idleSince.get(r.name) ?? null, s, now);
        if (since === null) idleSince.delete(r.name); else idleSince.set(r.name, since);
        state[r.name] = { ...s, idleSince: since, claimed: r.pool ? claimOf(POOL_QUEUE, r.name) : null, held: heldNow.has(r.unit) };
      }
      for (const f of clearedMarks(readdirSync(PARK_DIR), rows, state)) rmSync(join(PARK_DIR, f), { force: true });
      const decided = plan(rows, state, queued, { now, idleMs: IDLE_MIN * 60000, warm: WARM, hold, execCap: EXEC_CAP });
      const { start, park, room, queue } = decided;
      held = decided.held;
      if (held > 0) {
        log(`exec cap ${EXEC_CAP}: ${held} queued job(s) wait for a slot`);
        note({ kind: 'held', n: held, why: `exec cap ${EXEC_CAP}` });
      }
      const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
      // The pool's entries: the jobs routed to it this tick stay or are written; the rest age out.
      if (rows.some(isPool)) syncQueue(POOL_QUEUE, queue, now);
      for (const name of start) {
        const r = byName[name];
        const why = r.pool ? `${queue.length} queued job(s) of ${r.pool}'s repositories wait for the pool` : `a queued job in ${r.repo} needs it`;
        log(`start ${r.unit}: ${why}`);
        note({ kind: 'start', row: name, unit: r.unit, repo: r.repo ?? r.pool, why });
        if (MODE === 'on') startUnit(r.unit);
      }
      // What the kick path reads until the next tick: the view after this tick's starts.
      for (const name of start) state[name] = { ...state[name], active: true, busy: false, idleSince: null };
      last = { rows, state, load: rows.filter((r) => isExec(r) && state[r.name]?.active && (state[r.name]?.busy || !WARM.includes(r.name))).length, pending: Object.fromEntries(queue.map((j) => [j.id, j])) };
      // The rows a park left running: a job reached them first.
      const kept = new Set();
      for (const name of park) {
        // Read again just before the stop: a job may have reached it since the tick began.
        if (unitState(byName[name].unit).busy) { kept.add(name); continue; }
        const why = room.includes(name) ? 'idle while jobs wait on the exec cap' : `no job for ${isPool(byName[name]) ? `${POOL_IDLE_MS / 1000}s` : `${IDLE_MIN}m`} and none waiting`;
        const where = MODE === 'on' ? registeredIn(byName[name], state) : null;
        if (where) {
          // Off GitHub before the stop (releaseRegistration); under the rate floor the stop goes as before.
          const [owner, repoName] = where.split('/');
          const tok = rateLeft < rateFloor ? '' : (await appToken(owner, { ask: [repoName, 'administration=write'] })) || token();
          const r = tok ? await releaseRegistration(where, name, tok) : { outcome: 'error', why: `rate limit at ${rateLeft} left (floor ${rateFloor})` };
          if (r.outcome === 'busy') {
            log(`keep ${byName[name].unit}: GitHub holds a job for runner ${r.id} in ${where}`);
            note({ kind: 'park-kept', row: name, unit: byName[name].unit, repo: where, why: 'GitHub holds a job for it' });
            kept.add(name);
            continue;
          }
          if (r.outcome === 'error') log(`park ${byName[name].unit}: registration in ${where} not removed (${r.why}); stopping anyway`);
        }
        log(`park ${byName[name].unit}: ${why}`);
        note({ kind: 'park', row: name, unit: byName[name].unit, repo: byName[name].repo ?? byName[name].pool, why });
        if (MODE === 'on') {
          // Marked first, so the host's runner watchdog never sees it stopped and unmarked.
          writeFileSync(join(PARK_DIR, byName[name].unit), `${new Date(now).toISOString()}\n`);
          systemctl('stop', '--no-block', byName[name].unit);
          idleSince.delete(name);
        } else {
          // Dry: logged once per idle stretch; the listener's next job resets it.
          idleSince.set(name, Number.POSITIVE_INFINITY);
        }
      }
      const github = { left: Number.isFinite(rateLeft) ? rateLeft : null, resetAt: rateReset || null, floor: rateFloor, tokens: sources, failed: [...failed.keys()] };
      const done = { ...decided, park: park.filter((n) => !kept.has(n)), room: room.filter((n) => !kept.has(n)) };
      const watched = watchedRows(manifest).map((r) => ({ ...r, ...unitState(r.unit), held: heldNow.has(r.unit) }));
      lastDoc = stateDoc({ now, mode: MODE, rows, state, marks: readdirSync(PARK_DIR), hold, queued, decided: done, knobs, load: last.load, github, events, deploy: readDeploy(startedAt), watched });
      writeState(STATE, lastDoc, READ_GID);
    } catch (err) {
      const why = String(err?.message ?? err);
      log(`tick failed: ${why}`);
      note({ kind: 'tick-failed', why });
      // The rows of the last good tick stay on the wall, with the failure on them.
      try { writeState(STATE, { ...(lastDoc ?? { mode: MODE, knobs, rows: [], queued: [], held: 0, load: 0, github: null, deploy: null }), at: Date.now(), error: why, events }, READ_GID); } catch { /* the beat's age says the rest */ }
    }
    await waker.wait(POLL_SEC * 1000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!existsSync(MANIFEST)) {
    log(`no manifest at ${MANIFEST}`);
    process.exit(1);
  }
  main();
}
