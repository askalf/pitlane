#!/usr/bin/env node
// pitlane-supervisor: watches the runner rows the dispatcher (gha-ondemand) starts and parks.
// docs/supervisor.md. Every 60 s (TICK_SEC, from one tick's start to the next, whatever the tick
// took) it builds one snapshot (systemd, cgroups, the pin, one conditional GitHub call per
// repository or org, disk), runs the detectors in pitlane-supervisor-detect.mjs, and writes
// /run/askalf/pitlane/status.json (tookMs says how long the tick ran) and metrics.prom. Every ephemeral row in the manifest
// is watched, the org pool's too; the dispatcher's managedRows (repo rows) is narrower on purpose.
// PITLANE_MODE=heal (from /etc/askalf/pitlane-supervisor.env) turns on the allow-listed heals in
// pitlane-supervisor-heal.mjs; without it the supervisor observes and changes nothing on the box.
// Runs as root (it reads other units' cgroups); the GitHub token is the host's, sent as a header only.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileToken, unitFor } from './gha-ondemand.mjs';
import { DISPATCHER_UNIT, HEAL, planHeals } from './pitlane-supervisor-heal.mjs';
import { THRESHOLDS, detect, joinQueue, joinRegistrations, queuedFrom } from './pitlane-supervisor-detect.mjs';
import { readOutcomes, summarizeOutcomes } from './pitlane-outcomes.mjs';
import { SLICES, pushSample, sampleSlice, windowRates } from './pitlane-slices.mjs';
import { hostRowNames, hourly, makePrivate, ofHost, privateDir, publicStats, readWaits, readerGid, summarize, writePrivate, writePublic } from './pitlane-waits.mjs';

const env = process.env;
const TICK_SEC = Math.max(30, Number(env.TICK_SEC) || 60);
const MODE = env.PITLANE_MODE === 'heal' ? 'heal' : 'observe';
const MANIFEST = env.GHA_MANIFEST || '/etc/askalf/gha-runners.manifest';
const VERSION_FILE = env.GHA_VERSION_FILE || '/etc/askalf/gha-runner-version';
const TOKEN_ENV = env.GHA_TOKEN_ENV || '/root/.askalf/.env';
const PARK_DIR = env.PARK_DIR || '/run/askalf/gha-ondemand';
const OUTCOMES_DIR = env.PITLANE_STATE_DIR || '/var/lib/askalf/pitlane';
const OUT_DIR = env.PITLANE_DIR || '/run/askalf/pitlane';
/** The group that reads status.json and metrics.prom besides root: the dashboard (readerGid, docs/isolation.md). */
const READ_GID = readerGid();
const CGROUP_ROOT = env.CGROUP_ROOT || '/sys/fs/cgroup';
const ISOLATED_FILE = env.GHA_ISOLATED || '/etc/askalf/runners.isolated';
const RUNNERS_ROOT = env.GHA_ROOT || '/srv/gha';
const log = (msg) => console.log(`pitlane-supervisor: ${msg}`);

/** The pinned version: first field of the last non-comment line of the version file. */
export function parsePinned(text) {
  const line = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).pop();
  return line ? line.split(/\s+/)[0] : null;
}

/** A row's `.pinned` file ("<version> link") -> the version, or null when absent or odd. */
export function parseRowPinned(text) {
  return /^(\d+\.\d+\.\d+)\b/.exec(String(text ?? '').trim())?.[1] ?? null;
}

/** `systemctl show` key=value output -> the fields the detectors read. */
export function parseShow(text, now = Date.now()) {
  const kv = Object.fromEntries(text.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const since = Date.parse(kv.InactiveEnterTimestamp || '');
  return {
    active: kv.ActiveState || 'unknown',
    sub: kv.SubState || '',
    result: kv.Result || '',
    execStatus: Number(kv.ExecMainStatus) || 0,
    nrestarts: Number(kv.NRestarts) || 0,
    enabled: ['enabled', 'enabled-runtime', 'static', 'alias'].includes(kv.UnitFileState),
    inactiveMs: kv.ActiveState === 'active' || kv.ActiveState === 'activating' || Number.isNaN(since) ? 0 : Math.max(0, now - since),
    cgroup: kv.ControlGroup || '',
    user: kv.User || '',
  };
}

/**
 * The isolated list: row name to the account it runs as, one row per line, `#` starts a comment. The
 * account is gx-<row>, or the row's `account=` word's value (gha-runners-apply.sh, isolated_account).
 */
export function parseIsolated(text) {
  const out = new Map();
  for (const l of String(text ?? '').split('\n')) {
    const [name, ...words] = l.replace(/\s*#.*$/, '').trim().split(/\s+/);
    if (!name) continue;
    const a = words.find((w) => w.startsWith('account='));
    out.set(name, a ? a.slice('account='.length) : `gx-${name}`);
  }
  return out;
}

/**
 * Every ephemeral row in the manifest, repo, org and pool scope alike: the rows the supervisor watches.
 * `repo` is the registration scope's key (`askalf/x`, or `org:sprayberry-code` for the org pool); a
 * pool row (docs/pools.md) has `pool` set to its owner and `repo` `pool:<owner>`, which lists nothing
 * itself: its registration is looked for in every listed repository of that owner.
 */
/**
 * Every number the tick reports and publishes, from the recorded waits and outcomes of the jobs this
 * host's rows took (ofHost against the manifest's row names): a job another self-hosted pool ran for
 * the same repositories carries the self-hosted label too, and is left out here, so the published
 * start, run, queued-to-done and suspect counts are this host's alone. Pure, exported for tests.
 */
export function hostNumbers(waitEntries, outcomeEntries, rowNames, now) {
  const entries = ofHost(waitEntries, rowNames);
  const own = ofHost(outcomeEntries, rowNames);
  const waits = summarize(entries, now, 3600000);
  const waits24 = summarize(entries, now, 24 * 3600000);
  const outcomes = { lastHour: summarizeOutcomes(own, now, 3600000), last24h: summarizeOutcomes(own, now, 24 * 3600000) };
  const published = publicStats(waits24.all, outcomes.last24h, now, { lastHour: waits.all, hours: hourly(entries, now, 24) });
  return { entries, waits, waits24, outcomes, published };
}

export function supervisedRows(manifestText) {
  const rows = [];
  for (const line of manifestText.split('\n')) {
    if (/^\s*(#|$)/.test(line)) continue;
    const f = line.trim().split(/\s+/);
    if (f.length !== 7 || f[6] !== 'ephemeral') continue;
    const [name, scope, , user, , labels] = f;
    // Any owner the manifest names, in the scope shapes runner-config.mjs accepts.
    const m = /^(repo:([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)|org:([A-Za-z0-9-]+)|pool:([A-Za-z0-9-]+))$/.exec(scope);
    if (!m) continue;
    rows.push({ name, repo: m[2] ?? (m[3] ? `org:${m[3]}` : `pool:${m[4]}`), pool: m[4] ?? null, user, unit: unitFor(user, name), labels: labels.split(',').map((l) => l.toLowerCase()) });
  }
  return rows;
}

/**
 * A held mark's text -> { at, why }: the heal writes "<ISO time>\n<why>\n". A mark written by hand
 * (`touch`, or any one line) has no time of its own: `at` is null and the hold never lapses by itself.
 */
export function parseHeldMark(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim());
  const at = /^\d{4}-\d\d-\d\dT/.test(lines[0] ?? '') ? Date.parse(lines[0]) : Number.NaN;
  if (Number.isNaN(at)) return { at: null, why: lines.find(Boolean) ?? '' };
  return { at, why: lines[1] ?? '' };
}

/**
 * The line a held mark and its alert carry, from `journalctl -u <unit> -o cat` text: the last line
 * that is not systemd's own start, stop and exit chatter (the exit status is in the finding
 * already), else the last line. One line, control characters out, anything shaped like a GitHub
 * token or a bearer masked, at most `max` characters: it goes to status.json and the alert channel.
 */
export function journalLine(text, max = 200) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const chatter = /^(Started|Starting|Stopped|Stopping) |: (Scheduled restart job|Failed with result|Main process exited|Deactivated successfully|Consumed |Start request repeated)|^(Scheduled restart job|Failed with result|Main process exited|Deactivated successfully|Consumed )/;
  const line = lines.filter((l) => !chatter.test(l)).pop() ?? lines.pop() ?? '';
  const clean = line.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b(gh[opsu]_|github_pat_)[A-Za-z0-9_]+/g, '$1***')
    .replace(/\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***');
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

function lastJournalLine(unit) {
  try { return journalLine(execFileSync('journalctl', ['-u', unit, '-n', '30', '-o', 'cat', '--no-pager'], { encoding: 'utf8', maxBuffer: 1 << 20 })); } catch { return ''; }
}

/** The directory's group name and permission bits from `stat -c '%G %a'`, or null. */
export function parseStat(text) {
  const m = /^(\S+) ([0-7]{3,4})\s*$/.exec(String(text ?? ''));
  return m ? { group: m[1], mode: parseInt(m[2], 8) } : null;
}

/**
 * Failed exits per unit from `journalctl _PID=1 -o cat` text. systemd logs "<unit>: Failed with result"
 * for an unclean exit and "<unit>: Deactivated successfully." for a clean one. NRestarts rises on both,
 * and an ephemeral row restarts after every job it finishes, so a busy repository looks like a crash
 * loop if restarts are what is counted.
 */
export function failuresByUnit(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^(\S+\.service): Failed with result /.exec(line);
    if (m) out[m[1]] = (out[m[1]] ?? 0) + 1;
  }
  return out;
}

function recentFailures() {
  try {
    return failuresByUnit(execFileSync('journalctl', ['_PID=1', '--since', '-5min', '-o', 'cat', '--no-pager'], { encoding: 'utf8', maxBuffer: 16 << 20 }));
  } catch (e) {
    log(`journal read failed: ${e.message}`);
    return null;
  }
}

const systemctlShow = (unit) => execFileSync('systemctl', ['show', '-p', 'ActiveState,SubState,Result,ExecMainStatus,NRestarts,UnitFileState,InactiveEnterTimestamp,ControlGroup,User', unit], { encoding: 'utf8' });

/** Age in ms of a live Runner.Worker in the unit's cgroup, or null. Process start time comes from /proc. */
function workerAge(cgroup) {
  if (!cgroup) return null;
  let oldest = null;
  try {
    const hz = 100;
    const up = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    for (const pid of readFileSync(`/sys/fs/cgroup${cgroup}/cgroup.procs`, 'utf8').split('\n').filter(Boolean)) {
      try {
        if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('Runner.Worker')) continue;
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
        const age = (up - ticks / hz) * 1000;
        if (oldest === null || age > oldest) oldest = age;
      } catch { /* the process ended */ }
    }
  } catch { /* the cgroup went with the unit */ }
  return oldest === null ? null : Math.max(0, oldest);
}

function diskPercent(path) {
  try {
    const out = execFileSync('df', ['--output=pcent', path], { encoding: 'utf8' }).split('\n')[1];
    return Number.parseInt(out, 10);
  } catch { return null; }
}

// No token file (an App-only host): no token, so the GitHub side of each row is not checked.
const token = () => fileToken(TOKEN_ENV);

const etags = new Map();
const cache = new Map();
let ghCalls = 0;
/** A conditional GET: an unchanged answer (304) comes from the cache and costs no rate limit. */
async function gh(path, tok) {
  const headers = { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'askalf-pitlane-supervisor' };
  if (etags.has(path)) headers['If-None-Match'] = etags.get(path);
  ghCalls += 1;
  const res = await fetch(`https://api.github.com/${path}`, { headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (res.status === 304) return cache.get(path);
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${path.split('?')[0]}`);
  const json = await res.json();
  const tag = res.headers.get('etag');
  if (tag) { etags.set(path, tag); cache.set(path, json); }
  return json;
}

const scopeBase = (repo) => (repo.startsWith('org:') ? `orgs/${repo.slice(4)}` : `repos/${repo}`);

/** A DELETE, never cached: GitHub answers 204 and the next list's etag no longer matches. */
async function ghDelete(path, tok) {
  const headers = { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'askalf-pitlane-supervisor' };
  ghCalls += 1;
  const res = await fetch(`https://api.github.com/${path}`, { method: 'DELETE', headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (res.status !== 204 && res.status !== 404) throw new Error(`GitHub ${res.status} on DELETE ${path}`);
}

/** The registrations of a scope: `askalf/x` lists the repository's runners, `org:name` the org's. */
async function repoRunners(repo, tok) {
  const base = scopeBase(repo);
  const runners = [];
  for (let page = 1; page <= 5; page += 1) {
    const got = (await gh(`${base}/actions/runners?per_page=100&page=${page}`, tok))?.runners ?? [];
    runners.push(...got.map((r) => ({ id: r.id, name: r.name, status: r.status, busy: r.busy, version: null })));
    if (got.length < 100) break;
  }
  return runners;
}

/** Prometheus text for a status document: one line per finding class and a few totals. */
export function metricsText(status) {
  const lines = ['# TYPE pitlane_rows gauge', `pitlane_rows ${status.rows}`, '# TYPE pitlane_findings gauge'];
  const byClass = {};
  for (const f of status.findings) byClass[f.class] = (byClass[f.class] ?? 0) + 1;
  for (const [c, n] of Object.entries(byClass)) lines.push(`pitlane_findings{class="${c}"} ${n}`);
  for (const [win, w] of Object.entries(status.waits ?? {})) {
    for (const [repo, st] of [['all', w.all], ...Object.entries(w.repos)]) {
      for (const k of ['n', 'p50', 'p90', 'max']) if (st[k] !== null) lines.push(`pitlane_queue_wait_${k === 'n' ? 'jobs' : `${k}_ms`}{window="${win}",repo="${repo}"} ${st[k]}`);
    }
  }
  for (const [win, o] of Object.entries(status.outcomes ?? {})) {
    for (const [cls, n] of Object.entries(o.classes)) lines.push(`pitlane_jobs{window="${win}",class="${cls}"} ${n}`);
    lines.push(`pitlane_runner_suspect_jobs{window="${win}"} ${o.suspect.n}`);
    for (const k of ['p50', 'p90']) if (o.runMs[k] !== null) lines.push(`pitlane_job_run_${k}_ms{window="${win}"} ${o.runMs[k]}`);
  }
  for (const [name, w] of Object.entries(status.slices ?? {})) {
    if (!w) continue;
    const lab = `{slice="${name}",window="15m"}`;
    lines.push(`pitlane_slice_cpu_throttled_ratio${lab} ${w.throttledShare.toFixed(4)}`);
    if (w.cpuStallShare !== null) lines.push(`pitlane_slice_cpu_stall_ratio${lab} ${w.cpuStallShare.toFixed(4)}`);
    if (w.memStallShare !== null) lines.push(`pitlane_slice_memory_stall_ratio${lab} ${w.memStallShare.toFixed(4)}`);
    lines.push(`pitlane_slice_memory_cap_hits${lab} ${w.memAtMaxHits}`, `pitlane_slice_oom_kills${lab} ${w.oomKills}`);
    if (w.memUsedShare !== null) lines.push(`pitlane_slice_memory_used_ratio{slice="${name}"} ${w.memUsedShare.toFixed(4)}`);
  }
  lines.push('# TYPE pitlane_github_calls gauge', `pitlane_github_calls ${status.ghCalls}`);
  lines.push('# TYPE pitlane_heals_total counter', `pitlane_heals_total ${status.healsTotal ?? 0}`);
  lines.push('# TYPE pitlane_tick_timestamp_seconds gauge', `pitlane_tick_timestamp_seconds ${Math.floor(status.at / 1000)}`);
  if (Number.isFinite(status.tookMs)) lines.push('# TYPE pitlane_tick_seconds gauge', `pitlane_tick_seconds ${(status.tookMs / 1000).toFixed(1)}`);
  return `${lines.join('\n')}\n`;
}

async function tick(state) {
  const now = Date.now();
  const manifestText = readFileSync(MANIFEST, 'utf8');
  const rows = supervisedRows(manifestText);
  const pinned = existsSync(VERSION_FILE) ? parsePinned(readFileSync(VERSION_FILE, 'utf8')) : null;
  const parked = new Set(existsSync(PARK_DIR) ? readdirSync(PARK_DIR) : []);
  const heldDir = join(OUT_DIR, 'held');
  const held = new Set(existsSync(heldDir) ? readdirSync(heldDir) : []);
  const heldMarks = {};
  for (const u of held) {
    try { heldMarks[u] = parseHeldMark(readFileSync(join(heldDir, u), 'utf8')); } catch { /* removed since the listing */ }
  }
  const failures = recentFailures();
  let isolated = new Map();
  try { isolated = parseIsolated(readFileSync(ISOLATED_FILE, 'utf8')); } catch { /* no list: no row is isolated */ }
  const snapRows = rows.map((r) => {
    const sh = parseShow(systemctlShow(r.unit), now);
    let dirStat = null;
    if (isolated.has(r.name)) {
      try { dirStat = parseStat(execFileSync('stat', ['-c', '%G %a', join(RUNNERS_ROOT, r.name)], { encoding: 'utf8' })); } catch { /* not laid out yet */ }
    }
    let diskVersion = null;
    try { diskVersion = parseRowPinned(readFileSync(join(RUNNERS_ROOT, r.name, '.pinned'), 'utf8')); } catch { /* not laid out yet */ }
    return {
      name: r.name, repo: r.repo, pool: r.pool ?? null, labels: r.labels, unit: r.unit, parked: parked.has(r.unit), held: held.has(r.unit),
      heldAt: heldMarks[r.unit]?.at ?? null, heldWhy: heldMarks[r.unit]?.why ?? null,
      enabled: sh.enabled, active: sh.active, sub: sh.sub, result: sh.result, execStatus: sh.execStatus,
      failures5m: failures ? (failures[r.unit] ?? 0) : 0, inactiveMs: sh.inactiveMs,
      workerMs: workerAge(sh.cgroup), diskVersion, absentMs: null, offlineMs: null, regId: null, regBusy: false,
      isolated: isolated.has(r.name), account: isolated.get(r.name) ?? null, unitUser: sh.user, dirGroup: dirStat?.group ?? null, dirMode: dirStat?.mode ?? null,
    };
  });
  const gh_ = {};
  const tok = token();
  ghCalls = 0;
  if (tok) {
    for (const repo of new Set(rows.map((r) => r.repo))) {
      // A pool scope lists nothing of its own: its rows are joined over the owner's repositories below.
      if (repo.startsWith('pool:') || state.denied.has(repo)) continue;
      try { gh_[repo] = { ok: true, runners: await repoRunners(repo, tok) }; } catch (e) {
        gh_[repo] = { ok: false, runners: [] };
        // A 403 is the token's scope, not a passing fault (an org list needs admin:org): asked once, not every tick.
        if (/GitHub 403 /.test(e.message)) { state.denied.add(repo); log(`${repo}: ${e.message}; its registrations are not checked until the next restart`); }
        else log(`${repo}: ${e.message}`);
      }
    }
  }
  joinRegistrations(snapRows, gh_, state.seen, now);
  // The dispatcher's own view of the queue (its tick's listing), so the unclaimed-queue check costs no call.
  let dispatcherDoc = null;
  try { dispatcherDoc = JSON.parse(readFileSync(join(OUT_DIR, 'dispatcher.json'), 'utf8')); } catch { /* not written yet */ }
  joinQueue(snapRows, queuedFrom(dispatcherDoc, now, THRESHOLDS), state.seen, now);
  let beatAgeMs = null;
  try { beatAgeMs = now - statSync(join(OUT_DIR, 'dispatcher.beat')).mtimeMs; } catch { /* the dispatcher has not written one */ }
  let dispatcherState = { active: 'unknown', result: '' };
  try { const d = parseShow(systemctlShow(DISPATCHER_UNIT), now); dispatcherState = { active: d.active, result: d.result }; } catch { /* no unit */ }
  const dispatcherActive = dispatcherState.active === 'active';
  const { waits, waits24, outcomes, published } = hostNumbers(readWaits(join(OUT_DIR, 'waits.jsonl')), readOutcomes(OUTCOMES_DIR, now - 24 * 3600000, now), hostRowNames(manifestText), now);
  const slices = {};
  for (const name of SLICES) {
    const smp = sampleSlice(CGROUP_ROOT, name, now);
    if (!smp) continue;
    const ring = (state.slices[name] ??= []);
    pushSample(ring, smp);
    slices[name.split('/').pop()] = windowRates(ring);
  }
  const snapshot = { now, waits, outcomes, slices, beatAgeMs, dispatcherActive, dispatcherState, pinned, disk: Object.fromEntries(['/srv', '/'].map((p) => [p, diskPercent(p)]).filter(([, v]) => v !== null)), rows: snapRows };
  const plan = planHeals({ findings: detect(snapshot, THRESHOLDS), rows: snapRows, started: state.started, deregistered: state.deregistered, recycled: state.recycled, restarted: state.restarted, now, mode: MODE }, HEAL);
  for (const u of plan.cleared) log(`serving again: ${u}`);
  for (const u of plan.release) {
    rmSync(join(heldDir, u), { force: true });
    log(`hold lifted: ${u}, held past ${HEAL.holdMs / 60000} min; it may start again, and one still broken is held again`);
  }
  // The heals: a systemctl start or one DELETE, one log line each. A heal that fails is a finding
  // at once. A refused delete is recorded like a done one, so it is asked again in an hour, not
  // every tick (the token's scope does not change between ticks).
  const heals = [];
  for (const h of plan.heals) {
    let ok = true;
    if (h.class === 'stale-registration') {
      try { await ghDelete(`${scopeBase(h.repo)}/actions/runners/${h.id}`, tok); } catch (e) { ok = false; log(`heal ${h.class} ${h.row}: ${e.message}`); }
      state.deregistered[h.key ?? h.row] = { at: now, id: h.id };
      if (ok) { state.healsTotal += 1; log(`heal ${h.class} ${h.row}: deleted registration ${h.id} in ${h.repo} (${h.why})`); }
      else plan.findings.push({ class: 'stale-registration', severity: 'warn', row: h.row, msg: `${h.why}; its registration could not be deleted` });
      heals.push({ class: h.class, row: h.row, unit: h.unit, id: h.id, at: now, ok });
      continue;
    }
    if (h.class === 'crash-loop') {
      // The mark first: once the unit stops, nothing may start it again, the dispatcher included.
      // No mark, no stop: a stopped unit with no mark is down, and the down heal would start it.
      const why = `${h.why}; last journal line: ${lastJournalLine(h.unit) || '(none)'}`;
      const mark = join(heldDir, h.unit);
      try { writePrivate(mark, `${new Date(now).toISOString()}\n${why}\n`, null); } catch (e) { ok = false; log(`heal ${h.class} ${h.row}: the held mark could not be written (${e.message}); ${h.unit} left as it is`); }
      if (ok) {
        try { execFileSync('systemctl', ['stop', h.unit], { stdio: 'ignore' }); } catch { ok = false; rmSync(mark, { force: true }); log(`heal ${h.class} ${h.row}: systemctl stop ${h.unit} failed; the mark is removed so the next tick tries again`); }
      }
      if (ok) {
        try { execFileSync('systemctl', ['reset-failed', h.unit], { stdio: 'ignore' }); } catch { /* nothing to reset */ }
        state.healsTotal += 1;
        log(`heal ${h.class} ${h.row}: stopped and held ${h.unit} for ${HEAL.holdMs / 60000} min (${why})`);
      } else plan.findings.push({ class: 'crash-loop', severity: 'crit', row: h.row, msg: `${h.why}; it could not be stopped and held` });
      heals.push({ class: h.class, row: h.row, unit: h.unit, at: now, ok });
      continue;
    }
    if (h.class === 'dispatcher-stopped') {
      try { execFileSync('systemctl', ['reset-failed', h.unit], { stdio: 'ignore' }); } catch { /* nothing to reset */ }
      try { execFileSync('systemctl', ['restart', h.unit], { stdio: 'ignore' }); } catch { ok = false; }
      state.restarted[h.unit] = now;
      if (ok) { state.healsTotal += 1; log(`heal ${h.class}: restarted ${h.unit} (${h.why})`); }
      else { log(`heal ${h.class}: systemctl restart ${h.unit} failed`); plan.findings.push({ class: 'dispatcher-stopped', severity: 'crit', msg: `${h.why}; systemctl restart failed` }); }
      heals.push({ class: h.class, row: null, unit: h.unit, at: now, ok });
      continue;
    }
    if (h.class === 'unclaimed-queue') {
      try { execFileSync('systemctl', ['restart', h.unit], { stdio: 'ignore' }); } catch { ok = false; }
      state.recycled[h.unit] = now;
      if (ok) { state.healsTotal += 1; log(`heal ${h.class} ${h.row}: restarted ${h.unit} for a fresh registration (${h.why})`); }
      else { log(`heal ${h.class} ${h.row}: systemctl restart ${h.unit} failed`); plan.findings.push({ class: 'unclaimed-queue', severity: 'warn', row: h.row, msg: `${h.why}; systemctl restart failed` }); }
      heals.push({ class: h.class, row: h.row, unit: h.unit, at: now, ok });
      continue;
    }
    try { execFileSync('systemctl', ['reset-failed', h.unit], { stdio: 'ignore' }); } catch { /* nothing to reset */ }
    try { execFileSync('systemctl', ['start', h.unit], { stdio: 'ignore' }); } catch { ok = false; }
    if (ok) { state.started[h.unit] = now; state.healsTotal += 1; log(`heal ${h.class} ${h.row}: started ${h.unit} (${h.why})`); }
    else { log(`heal ${h.class} ${h.row}: systemctl start ${h.unit} failed`); plan.findings.push({ class: 'down', severity: 'warn', row: h.row, msg: `${h.why}; systemctl start failed` }); }
    heals.push({ class: h.class, row: h.row, unit: h.unit, at: now, ok });
  }
  const findings = plan.findings;
  // tookMs: the tick's own running time up to this write. A dashboard shows it beside the row count, so a
  // tick that grows toward the cadence is seen before it stretches the writes apart.
  const status = { at: now, tookMs: Date.now() - now, mode: MODE, rows: snapRows.length, ghCalls, heals, healsTotal: state.healsTotal, started: { ...state.started }, deregistered: { ...state.deregistered }, recycled: { ...state.recycled }, restarted: { ...state.restarted }, held: Object.fromEntries(snapRows.filter((r) => r.held).map((r) => [r.unit, { at: r.heldAt, why: r.heldWhy }])), waits: { lastHour: waits, last24h: waits24 }, outcomes, slices, findings };
  writePrivate(join(OUT_DIR, 'status.json'), `${JSON.stringify(status, null, 1)}\n`, READ_GID);
  writePrivate(join(OUT_DIR, 'metrics.prom'), metricsText(status), READ_GID);
  // The numbers shown outside the box (docs/showcase.md): 24 h, every repository together, none named.
  try { writePublic(join(OUT_DIR, 'public'), published); } catch (err) { log(`public numbers not written: ${err?.message ?? err}`); }
  // One line per finding per change, so the journal stays readable on a steady fault.
  const keys = new Set(findings.map((f) => `${f.class}|${f.row ?? ''}|${f.msg}`));
  for (const f of findings) if (!state.logged.has(`${f.class}|${f.row ?? ''}|${f.msg}`)) log(`${f.severity} ${f.class}${f.row ? ` ${f.row}` : ''}: ${f.msg}`);
  for (const k of state.logged) if (!keys.has(k)) log(`cleared ${k.split('|').slice(0, 2).join(' ')}`);
  state.logged = keys;
}

/**
 * The pause after a tick that took tookMs, so that ticks start tickSec apart whatever each one
 * took. A dashboard reads status.json as a file written every tickSec and turns it stale past a
 * multiple of that; a pause of tickSec after every tick would stretch the writes to tickSec plus the
 * tick's own time, and each slow tick would show as a flip to stale and back.
 * A tick past the cadence is followed by a short breath, never by the next at once.
 */
export function pauseMs(tookMs, tickSec) {
  return Math.max(5000, tickSec * 1000 - tookMs);
}

async function main() {
  // The run directory lists nothing to a job and the held marks are root's (docs/isolation.md, Host
  // state files); set again on start, so what was made before this change follows.
  privateDir(OUT_DIR, 0o711);
  privateDir(join(OUT_DIR, 'held'), 0o700);
  makePrivate([join(OUT_DIR, 'status.json'), join(OUT_DIR, 'metrics.prom')], READ_GID);
  const state = { seen: {}, logged: new Set(), slices: {}, started: {}, deregistered: {}, recycled: {}, restarted: {}, healsTotal: 0, denied: new Set() };
  log(`${MODE === 'heal' ? `heal mode: a down row is started again, a stale registration deleted and a row that will not claim a queued job restarted, once an hour each; a crash-looping row stopped and held for ${HEAL.holdMs / 60000} min; a failed or hung dispatcher restarted once per ${HEAL.dispatcherRenagMs / 60000} min` : 'observe only'}; tick ${TICK_SEC}s, status at ${OUT_DIR}/status.json`);
  for (;;) {
    const started = Date.now();
    try { await tick(state); } catch (err) { log(`tick failed: ${err?.message ?? err}`); }
    const took = Date.now() - started;
    if (took > TICK_SEC * 1000) log(`tick took ${Math.round(took / 1000)} s, past its ${TICK_SEC} s cadence`);
    await new Promise((r) => setTimeout(r, pauseMs(took, TICK_SEC)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!existsSync(MANIFEST)) { log(`no manifest at ${MANIFEST}`); process.exit(1); }
  main();
}
