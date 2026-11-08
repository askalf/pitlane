#!/usr/bin/env node
// box-ci: runs a repository's pull_request and push workflows on this host with act, as the
// non-root account the self-hosted runners use, and reports every job to GitHub as a commit
// status. Nothing in it waits on GitHub's Actions scheduler, which stops starting jobs for the
// whole account during an outage or once the Actions budget is spent.
//
// It finds work by polling: each repository's open pull requests and its configured branches,
// with ETag requests, which GitHub does not count against the rate limit when nothing changed.
// A head it has not run is fetched into a fresh directory, act runs every workflow the event
// triggers in host mode (no containers), and each job's result is posted to that commit.
//
// What runs is what the self-hosted runners already run: same-repository pull requests and
// pushes, as the same account. A fork's pull request is never fetched. Secrets reach push
// workflows only, from a root-only file per repository, copied into the run for its length.
//
// Flags: --once polls once, runs what it found, and exits non-zero if any run did not pass.
// --dry-run prints the statuses instead of posting them and keeps no state; without a token file
// it reads public repositories anonymously. Together they check a repository without touching it.
//
// Each act process runs in a transient systemd scope of its own (systemd-run --scope, in `slice`),
// and the whole scope is killed when act exits or times out: a job can leave a process behind (a
// dev server started with setsid holding a port), and killing act alone would leave it running for
// the next run to find. A scope sits in the slice beside box-ci, not in box-ci's own cgroup, so a stop
// or crash of box-ci does not end it: each scope has a RuntimeMaxSec of its job's limit plus a
// minute, and the unit file kills every box-ci-*.scope before box-ci starts and after it stops.
// `scope: false` runs act directly, for a host without systemd.
//
// Config: BOX_CI_CONFIG (default /etc/askalf/box-ci.json). Token: BOX_CI_TOKEN_FILE (default
// /etc/askalf/box-ci.token), a GitHub token that can read the repositories and write commit
// statuses. Both root-only. State, logs and work directories: BOX_CI_HOME (default /var/lib/box-ci).

import { spawn, spawnSync } from 'node:child_process';
import { chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, renameSync, copyFileSync, chmodSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'https://api.github.com';
const ZERO_SHA = '0'.repeat(40);
const STATE_LIMIT = 2000;
const LOGS_KEPT = 200;

// ---------------------------------------------------------------------------------------------
// Pure decisions. Everything below the next divider does I/O.
// ---------------------------------------------------------------------------------------------

/** A config value as text; an object or list is an Error here, since String() of one can throw. */
const configText = (v, what) => {
  if (v !== null && typeof v === 'object') throw new Error(`config: ${what} must be text`);
  return String(v);
};

/** The config with defaults filled in, or a thrown Error naming what is wrong. Pure. */
export function parseConfig(raw) {
  const c = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const repos = Array.isArray(c?.repos) ? c.repos : null;
  if (!repos || repos.length === 0) throw new Error('config: repos must be a non-empty list');
  const out = {
    act: c.act ?? '/opt/box-ci/act',
    runAs: c.runAs ?? null,
    concurrency: Number.isInteger(c.concurrency) && c.concurrency > 0 ? c.concurrency : 2,
    pollSeconds: Number.isInteger(c.pollSeconds) && c.pollSeconds >= 10 ? c.pollSeconds : 30,
    jobTimeoutMinutes: Number.isInteger(c.jobTimeoutMinutes) && c.jobTimeoutMinutes > 0 ? c.jobTimeoutMinutes : 30,
    contextPrefix: typeof c.contextPrefix === 'string' ? c.contextPrefix : 'box/',
    labels: Array.isArray(c.labels) ? c.labels.map((l) => configText(l, 'labels')) : ['ubuntu-latest', 'ubuntu-24.04', 'self-hosted'],
    scope: c.scope !== false,
    slice: typeof c.slice === 'string' && /^[\w.-]+\.slice$/.test(c.slice) ? c.slice : 'gha-exec.slice',
    repos: [],
  };
  for (const r of repos) {
    if (typeof r?.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(r.repo)) throw new Error(`config: bad repo ${JSON.stringify(r?.repo)}`);
    // A typo such as "serial": "yes" must not quietly mean parallel runs of a suite that cannot overlap.
    if (r.serial !== undefined && typeof r.serial !== 'boolean') throw new Error(`config: ${r.repo}: serial must be true or false`);
    const events = Array.isArray(r.events) ? r.events : ['pull_request', 'push'];
    for (const e of events) if (e !== 'pull_request' && e !== 'push') throw new Error(`config: ${r.repo}: unsupported event ${JSON.stringify(e)}`);
    out.repos.push({
      repo: r.repo,
      events,
      branches: Array.isArray(r.branches) ? r.branches.map((b) => configText(b, `${r.repo}: branches`)) : ['main'],
      labels: Array.isArray(r.labels) ? r.labels.map((l) => configText(l, `${r.repo}: labels`)) : [],
      vars: r.vars && typeof r.vars === 'object' ? Object.fromEntries(Object.entries(r.vars).map(([k, v]) => [k, configText(v, `${r.repo}: vars.${k}`)])) : {},
      secretsFile: typeof r.secretsFile === 'string' ? r.secretsFile : null,
      workflows: Array.isArray(r.workflows) ? r.workflows.map((f) => configText(f, `${r.repo}: workflows`)) : null,
      // One run at a time for a repository whose suite binds fixed ports or shared paths on the host.
      serial: r.serial === true,
    });
    const w = out.repos[out.repos.length - 1].workflows;
    if (w && w.some((f) => !/^[\w.-]+\.ya?ml$/.test(f))) throw new Error(`config: ${r.repo}: workflows are file names in .github/workflows`);
  }
  return out;
}

/** The state key for one run. Pure. */
export const runKey = (repo, event, sha) => `${repo}@${event}@${sha}`;

/**
 * The index in `queue` of the next job that may start, or -1: the first one whose repository is
 * not serial, or is serial with none of its runs in flight (`running` maps repo to its count).
 * A serial repository's jobs wait in place, so a job behind them from another repository can go
 * first. Pure.
 */
export function pickNext(queue, running) {
  return queue.findIndex((job) => !job.repoCfg.serial || !(running.get(job.repoCfg.repo) > 0));
}

/**
 * The queue without the runs `job` supersedes: for a pull request run, the same pull request's
 * runs still waiting at another head, which no one will look at once the pull request has moved
 * on. Returns { queue, dropped }. Pure.
 */
export function supersede(queue, job) {
  const pr = job.run.event === 'pull_request' ? job.run.pr?.number : undefined;
  if (pr === undefined) return { queue, dropped: [] };
  const stale = (q) => q.repoCfg.repo === job.repoCfg.repo && q.run.event === 'pull_request' && q.run.pr?.number === pr && q.run.sha !== job.run.sha;
  return { queue: queue.filter((q) => !stale(q)), dropped: queue.filter(stale) };
}

/**
 * What main does when a run ends. The next state is built and saved before it replaces the one in
 * memory, so a failed save leaves memory and disk agreeing and the run is planned again; the
 * in-flight mark comes off and `settle` runs whatever happened. Returns { state, saved }: `saved`
 * is false only when a save was due and failed. Pure but for `save` and `settle`.
 */
export function finishRun({ state, job, outcome, error, record, save, settle, logger = log }) {
  let saved = true;
  try {
    // A run that threw (not one that posted an error status) is not recorded: the next poll plans
    // it again.
    if (record && !error) {
      const next = recordRun(state, job.key, outcome, Date.now());
      save(next);
      state = next;
    }
  } catch (e) {
    saved = false;
    logger(`state not saved after ${job.key}: ${e?.message ?? e}`);
  } finally {
    settle();
  }
  return { state, saved };
}

/**
 * The run queue: at most `concurrency` runs at once, one at a time for a serial repository, and
 * the next one started whenever one finishes. `start(job)` runs a job and resolves to its
 * outcome; `onFinish(job, outcome, error)` hears each one end before the queue moves on, with the
 * error when `start` threw (the outcome is then 'error'). Whatever onFinish does, the queue moves on.
 */
export function createScheduler({ concurrency, start, onFinish = () => {}, logger = log }) {
  let queue = [];
  const runningByRepo = new Map();
  let running = 0;
  let stopped = false;
  const pump = () => {
    while (!stopped && running < concurrency && queue.length) {
      const at = pickNext(queue, runningByRepo);
      if (at < 0) break;
      const [job] = queue.splice(at, 1);
      running++;
      runningByRepo.set(job.repoCfg.repo, (runningByRepo.get(job.repoCfg.repo) ?? 0) + 1);
      Promise.resolve()
        .then(() => start(job))
        .then((outcome) => ({ outcome, error: null }), (error) => {
          logger(`run ${job.key}: ${error?.message ?? error}`);
          return { outcome: 'error', error };
        })
        .then(({ outcome, error }) => {
          running--;
          runningByRepo.set(job.repoCfg.repo, runningByRepo.get(job.repoCfg.repo) - 1);
          try {
            onFinish(job, outcome, error);
          } catch (e) {
            logger(`after run ${job.key}: ${e?.message ?? e}`);
          } finally {
            pump();
          }
        });
    }
  };
  return {
    /** Queue a job, dropping the waiting runs it supersedes; returns those. */
    enqueue(job) {
      const next = supersede(queue, job);
      queue = [...next.queue, job];
      return next.dropped;
    },
    pump,
    stop() { stopped = true; },
    get running() { return running; },
    get queued() { return queue.length; },
    inFlight: (repo) => runningByRepo.get(repo) ?? 0,
  };
}

/**
 * systemd-run's arguments to run `cmd args` in a scope of its own, as `account` when given.
 * - The description is fixed: without one systemd derives it from the command line, and act's
 *   arguments can carry `--var` values into the journal.
 * - RuntimeMaxSec ends the scope even when box-ci is gone: a scope is not in box-ci's cgroup.
 * - The account is taken inside the scope with setpriv, not with systemd-run's --uid/--gid:
 *   those also set HOME, USER and SHELL from the passwd entry, over the HOME box-ci gives each
 *   run (the run account's real home is shared between runs), and setpriv drops root's
 *   supplementary groups, which a uid switch alone would keep.
 * Pure.
 */
export function scopeArgs({ unit, slice, account, runtimeMaxSec }, cmd, args) {
  const out = ['--scope', '--quiet', '--collect', `--unit=${unit}`, '--description=box-ci workflow', `--slice=${slice}`];
  if (runtimeMaxSec) out.push('-p', `RuntimeMaxSec=${runtimeMaxSec}`);
  out.push('--');
  if (account) out.push('/usr/bin/setpriv', `--reuid=${account.uid}`, `--regid=${account.gid}`, '--clear-groups', '--');
  return [...out, cmd, ...args];
}

/**
 * Why a scoped run never reached act, or null: systemd-run could not create the scope, setpriv
 * could not switch, or systemd-run is not there. Each leaves no act output; a run that reached act
 * and failed is a job's failure, not this. Pure.
 */
export function launchFailure({ code, out, err, spawnError }) {
  if (spawnError) return spawnError;
  if (code === 0 || /^\{/m.test(out)) return null;
  const line = String(err).split('\n').find((l) => /^(Failed to start transient scope unit|Failed to (create|connect)|setpriv: )/.test(l));
  return line ? line.trim() : null;
}
/** A status description within GitHub's 140 characters. Pure. */
export const clip = (s) => (s.length > 140 ? `${s.slice(0, 137)}...` : s);

/** A transient unit name for one act process: the run directory's name and the workflow's place. Pure. */
export const scopeUnit = (runDir, index) => `box-ci-${basename(runDir).replace(/[^A-Za-z0-9_.-]/g, '_')}-${index}`;

/**
 * The runs a poll found that have neither finished (`state`) nor are running (`inflight`).
 * A pull request counts only when its head is in the repository itself: a fork's code is never
 * fetched here. Pure.
 */
export function planRuns(repoCfg, pulls, branchHeads, state, inflight) {
  const out = [];
  const want = (event, sha) => {
    const key = runKey(repoCfg.repo, event, sha);
    return repoCfg.events.includes(event) && !state[key] && !inflight.has(key);
  };
  for (const pr of pulls ?? []) {
    const sha = pr?.head?.sha;
    if (typeof sha !== 'string' || !sha || pr?.head?.repo?.full_name !== repoCfg.repo) continue;
    if (want('pull_request', sha)) out.push({ event: 'pull_request', sha, pr });
  }
  for (const { branch, sha, previous } of branchHeads ?? []) {
    if (typeof sha === 'string' && sha && typeof branch === 'string' && want('push', sha)) out.push({ event: 'push', sha, branch, previous: previous ?? null });
  }
  return out;
}

/** The event payload act reads with -e, shaped like GitHub's webhook payload. Pure. */
export function buildEvent(repoCfg, run, repoInfo) {
  const repository = repoInfo ?? { full_name: repoCfg.repo, name: repoCfg.repo.split('/')[1], owner: { login: repoCfg.repo.split('/')[0] } };
  if (run.event === 'pull_request') {
    return { action: 'synchronize', number: run.pr.number, pull_request: run.pr, repository, sender: run.pr.user ?? null };
  }
  return {
    ref: `refs/heads/${run.branch}`,
    before: run.previous ?? ZERO_SHA,
    after: run.sha,
    created: false,
    deleted: false,
    forced: false,
    repository,
    head_commit: { id: run.sha },
  };
}

/**
 * The workflow paths act runs for a repository: the listed files, or the whole directory, in
 * which case act picks every workflow the event triggers. Pure.
 */
export const workflowPaths = (repoCfg) => (repoCfg.workflows ? repoCfg.workflows.map((f) => `.github/workflows/${f}`) : ['.github/workflows/']);

/** act's arguments for one workflow path, from inside the checkout. Pure. */
export function actArgs(cfg, repoCfg, run, { cachePath, secretFile, workflowPath = '.github/workflows/' }) {
  const labels = [...new Set([...cfg.labels, ...repoCfg.labels])];
  const args = [run.event, '-W', workflowPath, '-e', '../event.json', '--json', '--action-cache-path', cachePath];
  for (const l of labels) args.push('-P', `${l}=-self-hosted`);
  for (const [k, v] of Object.entries(repoCfg.vars)) args.push('--var', `${k}=${v}`);
  if (secretFile) args.push('--secret-file', secretFile);
  return args;
}

/** Whether a run gets the repository's secrets: push only, and only when a file is configured. Pure. */
export const getsSecrets = (repoCfg, run) => run.event === 'push' && !!repoCfg.secretsFile;

/** A matrix value as the text String() gives it, without calling String() on an object: a key named toString makes that throw. */
const matrixText = (v) => (Array.isArray(v) ? v.map((x) => (x === null ? '' : matrixText(x))).join(',') : v !== null && typeof v === 'object' ? '[object Object]' : String(v));

/**
 * A job's name as GitHub shows it. act names a matrix job without a `name:` `<id>-<n>`, where
 * GitHub shows `<id> (<values>)`; act's log carries the values, in its own key order, which is
 * alphabetical. Any other name is act's evaluation of the job's `name:`, the same text GitHub
 * shows. Pure.
 */
export function githubJobName(actName, jobID, matrix) {
  const values = matrix && typeof matrix === 'object' ? Object.values(matrix).map(matrixText) : [];
  if (jobID && values.length && new RegExp(`^${jobID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`).test(actName)) {
    return `${jobID} (${values.join(', ')})`;
  }
  return actName;
}

/**
 * Each job's outcome from act's --json log: its name as GitHub shows it (githubJobName of the
 * text after the workflow name), its result, the step that failed, and how long it took. Lines
 * that are not JSON are ignored. Pure.
 */
export function parseActLog(text) {
  const jobs = new Map();
  for (const line of String(text).split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e.job !== 'string') continue;
    const actName = e.job.includes('/') ? e.job.slice(e.job.indexOf('/') + 1) : e.job;
    const name = githubJobName(actName, typeof e.jobID === 'string' ? e.jobID : null, e.matrix);
    const j = jobs.get(e.job) ?? { name, result: null, failedStep: null, start: null, end: null };
    const t = typeof e.time === 'string' ? Date.parse(e.time) : Number.NaN;
    if (Number.isFinite(t)) { j.start = j.start ?? t; j.end = t; }
    if (e.stepResult === 'failure' && !j.failedStep) j.failedStep = typeof e.step === 'string' ? e.step : null;
    if (typeof e.jobResult === 'string') j.result = e.jobResult;
    jobs.set(e.job, j);
  }
  return [...jobs.values()].map((j) => ({
    name: j.name,
    result: j.result ?? 'failure',
    failedStep: j.failedStep,
    seconds: j.start != null && j.end != null ? Math.round((j.end - j.start) / 1000) : null,
  }));
}

/** The commit statuses for a finished run: one per job, then the run as a whole. Pure. */
export function statusesFor(cfg, jobs, { exitCode, timedOut, error }) {
  const out = [];
  for (const j of jobs) {
    if (j.result === 'skipped') continue;
    const ok = j.result === 'success';
    const took = j.seconds != null ? ` in ${j.seconds}s` : '';
    out.push({
      context: `${cfg.contextPrefix}${j.name}`,
      state: ok ? 'success' : 'failure',
      description: clip(ok ? `passed on box-ci${took}` : `failed on box-ci${j.failedStep ? ` at "${j.failedStep}"` : ''}${took}`),
    });
  }
  let state;
  let description;
  if (error || timedOut) {
    state = 'error';
    description = timedOut ? 'box-ci: the run hit its time limit' : `box-ci could not run it: ${error}`;
  } else if (out.some((s) => s.state !== 'success') || exitCode !== 0) {
    state = 'failure';
    const failed = out.filter((s) => s.state !== 'success').map((s) => s.context.slice(cfg.contextPrefix.length));
    description = failed.length ? `failed: ${failed.join(', ')}` : `act exited ${exitCode}`;
  } else {
    state = 'success';
    description = out.length ? `${out.length} job${out.length === 1 ? '' : 's'} passed` : 'no job runs on box-ci for this event';
  }
  out.push({ context: `${cfg.contextPrefix}ci`, state, description: clip(description) });
  return out;
}

/** The state with this run's outcome recorded, keeping the newest STATE_LIMIT entries. Pure. */
export function recordRun(state, key, outcome, at) {
  const next = { ...state, [key]: { outcome, at } };
  const keys = Object.keys(next);
  if (keys.length <= STATE_LIMIT) return next;
  keys.sort((a, b) => next[a].at - next[b].at);
  for (const k of keys.slice(0, keys.length - STATE_LIMIT)) delete next[k];
  return next;
}

/** Secret-file lines KEY=VALUE kept as they are; anything else is refused. Pure. */
export function validateSecretFile(text) {
  for (const line of String(text).split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) throw new Error('secrets file: every line must be KEY=VALUE');
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------------------------

/** A GitHub client that sends ETags and backs off when GitHub says to. */
export function makeGitHub(token, fetchImpl = fetch, now = () => Date.now()) {
  const etags = new Map();
  let blockedUntil = 0;
  async function call(method, path, body) {
    if (now() < blockedUntil) throw new Error(`GitHub rate limit: waiting until ${new Date(blockedUntil).toISOString()}`);
    const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'askalf-box-ci' };
    if (token) headers.authorization = `Bearer ${token}`;
    const cached = method === 'GET' ? etags.get(path) : null;
    if (cached) headers['if-none-match'] = cached.etag;
    if (body) headers['content-type'] = 'application/json';
    const res = await fetchImpl(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 304 && cached) return cached.data;
    if (res.status === 403 || res.status === 429) {
      const retry = Number(res.headers.get('retry-after'));
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      if (Number.isFinite(retry) && retry > 0) blockedUntil = now() + retry * 1000;
      else if (res.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset)) blockedUntil = reset * 1000;
    }
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${res.status}`);
    const data = res.status === 204 ? null : await res.json();
    const etag = res.headers.get('etag');
    if (method === 'GET' && etag) etags.set(path, { etag, data });
    return data;
  }
  return { call };
}

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

function idOf(user) {
  const u = spawnSync('id', ['-u', user], { encoding: 'utf8' });
  const g = spawnSync('id', ['-g', user], { encoding: 'utf8' });
  if (u.status !== 0 || g.status !== 0) throw new Error(`no account ${user}`);
  return { uid: Number(u.stdout.trim()), gid: Number(g.stdout.trim()) };
}

/** chown a tree to the run account. A symlink is never followed: a checkout can point one anywhere. */
function chownTree(path, uid, gid) {
  const s = lstatSync(path, { throwIfNoEntry: false });
  if (!s || s.isSymbolicLink()) return;
  chownSync(path, uid, gid);
  if (!s.isDirectory()) return;
  for (const name of readdirSync(path)) chownTree(join(path, name), uid, gid);
}

function killScopeUnit(unit) {
  spawnSync('systemctl', ['kill', '--signal=SIGKILL', `${unit}.scope`], { stdio: 'ignore' });
}

/**
 * Runs `cmd args`, collecting its output, killed at `timeoutMs`. With `opts.scope` ({ unit, slice,
 * account, runtimeMaxSec }) the command runs in that systemd scope (setpriv inside it switches to
 * the account, so the spawn itself stays root's), and the whole scope is killed when the command
 * exits or times out, taking along anything it left running. A scoped run that never reached the
 * command carries `launchError`. `opts.spawnImpl` and `opts.killScope` replace the real
 * ones in tests.
 */
export function run(cmd, args, opts = {}) {
  const { scope, spawnImpl = spawn, killScope = killScopeUnit, timeoutMs, ...spawnOpts } = opts;
  const argv = scope ? ['systemd-run', scopeArgs(scope, cmd, args)] : [cmd, args];
  if (scope) { delete spawnOpts.uid; delete spawnOpts.gid; }
  return new Promise((resolve) => {
    const child = spawnImpl(argv[0], argv[1], { ...spawnOpts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; if (scope) killScope(scope.unit); child.kill('SIGKILL'); }, timeoutMs) : null;
    // A leftover holding the job's stdout would keep 'close' from firing: the scope goes on 'exit'.
    child.on('exit', () => { if (scope) killScope(scope.unit); });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const done = (r) => resolve(scope ? { ...r, launchError: launchFailure(r) } : r);
    child.on('error', (e) => { if (timer) clearTimeout(timer); done({ code: -1, out, err: `${err}${e.message}`, timedOut, spawnError: `could not start ${argv[0]}: ${e.message}` }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); done({ code: code ?? -1, out, err, timedOut }); });
  });
}

/** Fetch one commit into `dir` with the token in the environment, never in argv or the repo config. */
async function fetchCommit(repo, sha, branch, dir, token) {
  const env = { PATH: process.env.PATH, HOME: dir, GIT_TERMINAL_PROMPT: '0' };
  if (token) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  const git = (args) => run('git', args, { cwd: dir, env, timeoutMs: 5 * 60_000 });
  for (const args of [
    ['init', '-q', 'repo'],
    ['-C', 'repo', 'remote', 'add', 'origin', `https://github.com/${repo}.git`],
    ['-C', 'repo', 'fetch', '-q', '--depth', '50', 'origin', sha],
    ['-C', 'repo', 'checkout', '-q', '-B', branch, 'FETCH_HEAD'],
  ]) {
    const r = await git(args);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.err.trim().split('\n').pop()}`);
  }
}

async function postStatuses(gh, repo, sha, statuses, targetUrl) {
  for (const s of statuses) {
    try {
      await gh.call('POST', `/repos/${repo}/statuses/${sha}`, { ...s, ...(targetUrl ? { target_url: targetUrl } : {}) });
    } catch (e) {
      log(`status ${repo}@${sha.slice(0, 8)} ${s.context}: ${e.message}`);
    }
  }
}

function pruneLogs(dir) {
  const files = readdirSync(dir).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(LOGS_KEPT)) rmSync(join(dir, f), { force: true });
}

/** Run one planned head end to end and return its outcome. */
export async function runOne({ cfg, repoCfg, run: r, gh, token, home, account, repoInfo, actRunner = run, fetcher = fetchCommit }) {
  const short = r.sha.slice(0, 8);
  // The run account enters work/ to reach its own run directory, but cannot list it; logs/ and
  // state stay root's.
  const workRoot = join(home, 'work');
  mkdirSync(workRoot, { recursive: true });
  chmodSync(workRoot, 0o711);
  const dir = mkdtempSync(join(workRoot, `${repoCfg.repo.replace('/', '_')}-${r.event}-${short}-`));
  mkdirSync(join(home, 'logs'), { recursive: true });
  chmodSync(join(home, 'logs'), 0o700);
  const logDir = join(home, 'logs', repoCfg.repo.replace('/', '_'));
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${r.event}-${r.sha}.jsonl`);
  let outcome = 'error';
  try {
    await postStatuses(gh, repoCfg.repo, r.sha, [{ context: `${cfg.contextPrefix}ci`, state: 'pending', description: 'running on box-ci' }]);
    const branch = r.event === 'push' ? r.branch : (r.pr.head.ref || 'pr-head');
    await fetcher(repoCfg.repo, r.sha, branch, dir, token);
    writeFileSync(join(dir, 'event.json'), JSON.stringify(buildEvent(repoCfg, r, repoInfo)));
    let secretFile = null;
    if (getsSecrets(repoCfg, r)) {
      const text = readFileSync(repoCfg.secretsFile, 'utf8');
      validateSecretFile(text);
      secretFile = join(dir, 'secrets.env');
      copyFileSync(repoCfg.secretsFile, secretFile);
      chmodSync(secretFile, 0o400);
    }
    const cachePath = join(home, 'act-cache');
    mkdirSync(cachePath, { recursive: true });
    mkdirSync(join(dir, 'home'), { recursive: true });
    if (account) {
      chownTree(dir, account.uid, account.gid);
      chownSync(cachePath, account.uid, account.gid);
    }
    const res = { code: 0, out: '', err: '', timedOut: false };
    const paths = workflowPaths(repoCfg);
    // A listed workflow the commit lacks fails the run, and nothing runs: skipping it would let a
    // change pass CI by deleting its CI, and no reading of where the change started (the default
    // branch, a base sha, a previous head) is reliable enough to tell a deletion from a branch cut
    // before the workflow existed. Such a branch needs a rebase onto the default branch. Only a
    // listed file can be missing: without a list act takes the whole directory.
    const missing = repoCfg.workflows ? paths.filter((p) => !existsSync(join(dir, 'repo', p))) : [];
    if (missing.length) {
      const names = missing.map((p) => p.split('/').pop()).join(', ');
      const statuses = [{ context: `${cfg.contextPrefix}ci`, state: 'failure', description: clip(`workflow ${names} missing from this commit; rebase onto the default branch`) }];
      await postStatuses(gh, repoCfg.repo, r.sha, statuses);
      log(`${repoCfg.repo} ${r.event} ${short}: failure (missing from this commit: ${names})`);
      return 'failure';
    }
    const present = paths;
    for (const [i, workflowPath] of present.entries()) {
      const one = await actRunner(cfg.act, actArgs(cfg, repoCfg, r, { cachePath, secretFile: secretFile ? '../secrets.env' : null, workflowPath }), {
        cwd: join(dir, 'repo'),
        env: { PATH: process.env.PATH, HOME: join(dir, 'home'), LANG: 'C.UTF-8' },
        timeoutMs: cfg.jobTimeoutMinutes * 60_000,
        ...(account ? { uid: account.uid, gid: account.gid } : {}),
        ...(cfg.scope ? { scope: { unit: scopeUnit(dir, i), slice: cfg.slice, account, runtimeMaxSec: cfg.jobTimeoutMinutes * 60 + 60 } } : {}),
      });
      // The scope or the account switch failed before act ran: box-ci's fault, not the commit's.
      if (one.launchError) throw new Error(one.launchError);
      res.out += one.out;
      res.err += one.err;
      if (one.code !== 0) res.code = one.code;
      if (one.timedOut) { res.timedOut = true; break; }
    }
    writeFileSync(logFile, res.out + (res.err ? `\n${JSON.stringify({ stderr: res.err.slice(-20000) })}\n` : ''));
    const jobs = parseActLog(res.out);
    const statuses = statusesFor(cfg, jobs, { exitCode: res.code, timedOut: res.timedOut, error: null });
    await postStatuses(gh, repoCfg.repo, r.sha, statuses);
    outcome = statuses[statuses.length - 1].state;
    log(`${repoCfg.repo} ${r.event} ${short}: ${outcome} (${jobs.map((j) => `${j.name}=${j.result}`).join(', ') || 'no jobs'})`);
  } catch (e) {
    log(`${repoCfg.repo} ${r.event} ${short}: error: ${e.message}`);
    await postStatuses(gh, repoCfg.repo, r.sha, statusesFor(cfg, [], { exitCode: -1, timedOut: false, error: e.message }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    try { pruneLogs(logDir); } catch { /* logs are best effort */ }
  }
  return outcome;
}

async function pollRepo(gh, repoCfg, state, inflight, lastHeads) {
  const pulls = repoCfg.events.includes('pull_request') ? await gh.call('GET', `/repos/${repoCfg.repo}/pulls?state=open&per_page=100`) : [];
  const heads = [];
  if (repoCfg.events.includes('push')) {
    for (const branch of repoCfg.branches) {
      const b = await gh.call('GET', `/repos/${repoCfg.repo}/branches/${encodeURIComponent(branch)}`);
      const sha = b?.commit?.sha;
      const key = `${repoCfg.repo}#${branch}`;
      heads.push({ branch, sha, previous: lastHeads.get(key) ?? null });
      if (sha) lastHeads.set(key, sha);
    }
  }
  return planRuns(repoCfg, pulls, heads, state, inflight);
}

function loadState(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

function saveState(file, state) {
  writeFileSync(`${file}.tmp`, JSON.stringify(state));
  renameSync(`${file}.tmp`, file);
}

/** A client that prints what it would post. Reads still go to GitHub. */
function dryRunClient(gh) {
  return {
    call: async (method, path, body) => {
      if (method === 'GET') return gh.call(method, path, body);
      log(`dry run: ${method} ${path} ${JSON.stringify(body)}`);
      return {};
    },
  };
}

function readToken(dryRun) {
  const file = process.env.BOX_CI_TOKEN_FILE || '/etc/askalf/box-ci.token';
  let token = '';
  try { token = readFileSync(file, 'utf8').trim(); } catch (e) { if (!dryRun) throw e; }
  if (!token && !dryRun) throw new Error('empty token file');
  return token;
}

async function main(argv) {
  const onceOnly = argv.includes('--once');
  const dryRun = argv.includes('--dry-run');
  const cfg = parseConfig(readFileSync(process.env.BOX_CI_CONFIG || '/etc/askalf/box-ci.json', 'utf8'));
  const token = readToken(dryRun);
  const home = process.env.BOX_CI_HOME || '/var/lib/box-ci';
  mkdirSync(home, { recursive: true });
  chmodSync(home, 0o711);
  const account = cfg.runAs ? idOf(cfg.runAs) : null;
  const gh = dryRun ? dryRunClient(makeGitHub(token)) : makeGitHub(token);
  const stateFile = join(home, 'state.json');
  let state = dryRun ? {} : loadState(stateFile);
  const outcomes = [];
  const inflight = new Set();
  const lastHeads = new Map();
  let stopping = false;
  const sched = createScheduler({
    concurrency: cfg.concurrency,
    start: (job) => runOne({ cfg, repoCfg: job.repoCfg, run: job.run, gh, token, home, account }),
    onFinish: (job, outcome, error) => {
      const done = finishRun({
        state, job, outcome, error, record: !dryRun,
        save: (next) => saveState(stateFile, next),
        settle: () => inflight.delete(job.key),
      });
      state = done.state;
      // A state that could not be saved counts against a --once run: its outcome would be lost.
      outcomes.push(done.saved ? outcome : 'error');
      if (stopping && sched.running === 0) process.exit(0);
      if (onceOnly && sched.running === 0 && sched.queued === 0) process.exit(outcomes.every((o) => o === 'success') ? 0 : 1);
    },
  });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true; sched.stop(); log(`${sig}: no new runs`); if (sched.running === 0) process.exit(0); });

  log(`box-ci: ${cfg.repos.map((r) => r.repo).join(', ')}; ${cfg.concurrency} at a time as ${cfg.runAs ?? 'this account'}`);
  while (!stopping) {
    for (const repoCfg of cfg.repos) {
      try {
        for (const r of await pollRepo(gh, repoCfg, state, inflight, lastHeads)) {
          const key = runKey(repoCfg.repo, r.event, r.sha);
          inflight.add(key);
          for (const old of sched.enqueue({ key, repoCfg, run: r })) {
            inflight.delete(old.key);
            log(`${repoCfg.repo} pull_request ${old.run.sha.slice(0, 8)}: superseded by ${r.sha.slice(0, 8)} before it started`);
          }
        }
      } catch (e) {
        log(`poll ${repoCfg.repo}: ${e.message}`);
      }
    }
    sched.pump();
    if (onceOnly) {
      if (sched.running === 0 && sched.queued === 0) { log('nothing to run'); process.exit(0); }
      return;
    }
    await new Promise((res) => setTimeout(res, cfg.pollSeconds * 1000));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((e) => { console.error(`box-ci: ${e.message}`); process.exit(1); });
}

