// Pure detectors for pitlane-supervisor: a snapshot in, findings out. No I/O, so each class is table-tested.
// Snapshot shape (built by pitlane-supervisor.mjs, hand-built in the tests):
//   now (ms), dispatcherActive, dispatcherState ({ active, result } of gha-ondemand.service), beatAgeMs
//   (dispatcher heartbeat age, null if it writes none), pinned (RUNNER_VERSION),
//   disk { path: percent used }, rows [{ name, repo, unit, parked, held, heldAt, heldWhy, enabled, active, sub, result,
//   execStatus, failures5m, inactiveMs, workerMs (age of a live Runner.Worker or null), diskVersion,
//   absentMs, offlineMs, regOnline, unclaimedMs }], waits (last hour: { all: { n, p50, p90, max } }),
//   outcomes ({ lastHour, last24h }, each from summarizeOutcomes in pitlane-outcomes.mjs)
// A finding is { class, severity: 'warn'|'crit', row?, msg }.

export const THRESHOLDS = {
  downGraceMs: 2 * 60000,
  crashRestarts: 3,
  crashStatuses: [226, 203, 217],
  beatMaxMs: 90 * 1000,
  // A heartbeat this old on a running dispatcher is a hung loop, not a slow tick: the heal restarts it.
  // A tick's longest wait is the App token mint (90 s per owner) and the listings (20 s each, four at once).
  beatRestartMs: 5 * 60000,
  stuckMs: 6 * 3600 * 1000 + 10 * 60000,
  staleRegMs: 30 * 60000,
  lostRegMs: 5 * 60000,
  diskWarn: 80,
  diskCrit: 90,
  // The targets: p50 under 5 s, p90 under 30 s, judged once an hour has at least this many jobs.
  waitP50Ms: 5000,
  waitP90Ms: 30000,
  waitMinJobs: 10,
  // Over the last 15 minutes: the share of CPU periods a slice was throttled, and of wall time its tasks stalled.
  throttleWarn: 0.1,
  stallWarn: 0.1,
  // A row idle and online beside a queued job it could take, this long, has a registration GitHub no longer
  // hands jobs to. The p90 wait is under 30 s, so five minutes is no slow claim.
  unclaimedMs: 5 * 60000,
  // dispatcher.json older than this is not read: its queue is no longer the queue.
  queueFreshMs: 3 * 60000,
};

const f = (cls, severity, row, msg) => ({ class: cls, severity, ...(row ? { row } : {}), msg });

/**
 * A unit that keeps failing. `status` (the exit status, when that alone names it) and `failures`
 * tell the heal whether to hold it. A held row (its mark in /run/askalf/pitlane/held, written by the
 * heal or by hand) is a crash loop until the mark goes, parked or not: the finding names when it was
 * held and why, in words that stay the same tick to tick, so the journal logs it once.
 */
export function crashLoop(s, t = THRESHOLDS) {
  const out = [];
  for (const r of s.rows) {
    if (r.held) {
      const since = Number.isFinite(r.heldAt) ? ` since ${new Date(r.heldAt).toISOString()}` : '';
      out.push({ ...f('crash-loop', 'crit', r.name, `${r.unit}: held${since}${r.heldWhy ? `: ${r.heldWhy}` : ''}; it is not started while /run/askalf/pitlane/held/${r.unit} is there`), held: true });
      continue;
    }
    if (r.parked) continue;
    const byStatus = r.result === 'exit-code' && t.crashStatuses.includes(Number(r.execStatus));
    // Failed exits, not restarts: an ephemeral row restarts after every job it finishes.
    const byCount = r.failures5m >= t.crashRestarts;
    if (byStatus || byCount) {
      out.push({ ...f('crash-loop', 'crit', r.name, `${r.unit}: ${byStatus ? `exit status ${r.execStatus}` : `${r.failures5m} failed exits in 5 min`}`), failures: r.failures5m, status: byStatus ? Number(r.execStatus) : null });
    }
  }
  return out;
}

/**
 * A repository row that is enabled, not parked and not running past the grace is down: something
 * stopped it that was not the dispatcher. A pool row is never down: stopped is its resting state,
 * and the dispatcher starts it for a job it routes there (with reset-failed first), so a start
 * from here would only run a listener nothing asked for (every pool row at once, those past
 * POOL_MAX included, each claiming from the queue during its linger).
 */
export function down(s, t = THRESHOLDS) {
  const crashed = new Set(crashLoop(s, t).map((x) => x.row));
  return s.rows
    .filter((r) => !r.pool && r.enabled && !r.parked && !r.held && !crashed.has(r.name) && r.active !== 'active' && r.active !== 'activating' && r.inactiveMs >= t.downGraceMs)
    .map((r) => f('down', 'warn', r.name, `${r.unit} is ${r.active} for ${Math.round(r.inactiveMs / 1000)}s`));
}

/**
 * The dispatcher not running, or its heartbeat late. `cause` is what the heal may act on: `failed`
 * (systemd stopped restarting it) and `stale-beat` (running, its loop hung past beatRestartMs) are
 * restarted; `paused` (inactive with result success: stopped by hand, as a pause of the
 * dispatcher does, which Restart=always does not undo), `stopped` (between systemd's own
 * restarts, or a state not read) and `late-beat` are reported only.
 */
export function dispatcherStopped(s, t = THRESHOLDS) {
  // The unit not running is the hard signal. The heartbeat only counts once the dispatcher writes one.
  if (s.dispatcherActive === false) {
    const st = s.dispatcherState ?? {};
    if (st.active === 'failed') return [{ ...f('dispatcher-stopped', 'crit', null, `gha-ondemand.service is failed (${st.result || 'result unknown'}); systemd stopped restarting it`), cause: 'failed' }];
    if (st.active === 'inactive' && st.result === 'success') return [{ ...f('dispatcher-stopped', 'crit', null, 'gha-ondemand.service is not running: stopped by hand (pitlane-dispatcher-pause); pitlane-dispatcher-resume starts it'), cause: 'paused' }];
    return [{ ...f('dispatcher-stopped', 'crit', null, 'gha-ondemand.service is not running'), cause: 'stopped' }];
  }
  if (s.beatAgeMs !== null && s.beatAgeMs > t.beatMaxMs) {
    return [{ ...f('dispatcher-stopped', 'crit', null, `dispatcher heartbeat is ${Math.round(s.beatAgeMs / 1000)}s old`), cause: s.beatAgeMs > t.beatRestartMs ? 'stale-beat' : 'late-beat' }];
  }
  return [];
}

export function stuckJob(s, t = THRESHOLDS) {
  return s.rows.filter((r) => r.workerMs !== null && r.workerMs > t.stuckMs)
    .map((r) => f('stuck-job', 'warn', r.name, `${r.unit}: a worker has run ${Math.round(r.workerMs / 60000)} min`));
}

export function staleRegistration(s, t = THRESHOLDS) {
  // A parked row is stopped on purpose and GitHub keeps its offline entry until the next start removes it.
  // A pool row's next start may register elsewhere, so its parked offline entry is stale like any other,
  // and the leftovers of its earlier claims (joinRegistrations' staleRegs) are stale at once; each
  // finding carries the repository and id the delete needs.
  const out = [];
  for (const r of s.rows) {
    if (r.offlineMs !== null && r.offlineMs >= t.staleRegMs && r.active !== 'active' && (!r.parked || r.pool)) {
      out.push({ ...f('stale-registration', 'warn', r.name, `${r.name} offline on GitHub for ${Math.round(r.offlineMs / 60000)} min${r.pool ? ` in ${r.regRepo}` : ''}`), ...(r.pool ? { repo: r.regRepo, id: r.regId } : {}) });
    }
    for (const x of r.staleRegs ?? []) {
      out.push({ ...f('stale-registration', 'warn', r.name, `${r.name} has a registration left in ${x.repo} (id ${x.id}) from an earlier claim`), repo: x.repo, id: x.id });
    }
  }
  return out;
}

export function registrationLost(s, t = THRESHOLDS) {
  return s.rows.filter((r) => r.active === 'active' && r.absentMs !== null && r.absentMs >= t.lostRegMs)
    .map((r) => f('registration-lost', 'warn', r.name, `${r.unit} is active but GitHub has no runner ${r.name}`));
}

export function versionDrift(s) {
  return s.rows.filter((r) => r.diskVersion && s.pinned && r.diskVersion !== s.pinned)
    .map((r) => f('version-drift', 'warn', r.name, `${r.name} has runner ${r.diskVersion}, pin is ${s.pinned}`));
}

export function diskPressure(s, t = THRESHOLDS) {
  return Object.entries(s.disk).filter(([, p]) => p >= t.diskWarn)
    .map(([path, p]) => f('disk-pressure', p >= t.diskCrit ? 'crit' : 'warn', null, `${path} is ${p}% full`));
}

export function queueWait(s, t = THRESHOLDS) {
  const a = s.waits?.all;
  if (!a || a.n < t.waitMinJobs) return [];
  const out = [];
  if (a.p50 > t.waitP50Ms) out.push(f('queue-wait', 'warn', null, `last hour: p50 ${Math.round(a.p50 / 1000)}s over ${t.waitP50Ms / 1000}s (${a.n} jobs)`));
  if (a.p90 > t.waitP90Ms) out.push(f('queue-wait', 'warn', null, `last hour: p90 ${Math.round(a.p90 / 1000)}s over ${t.waitP90Ms / 1000}s (${a.n} jobs)`));
  return out;
}

/** The target is no job lost to the runner: any job in the last hour that ended in a way pointing at it is named. */
export function runnerSuspect(s) {
  const o = s.outcomes?.lastHour;
  if (!o || !o.suspect.n) return [];
  const classes = Object.entries(o.classes).filter(([c]) => c === 'setup-failed' || c === 'runner-lost-suspect').map(([c, n]) => `${c} ${n}`).join(', ');
  const rows = Object.entries(o.suspect.runners).map(([r, n]) => `${r} ${n}`).join(', ');
  return [f('runner-suspect', 'warn', null, `last hour: ${o.suspect.n} of ${o.n} jobs ended in a way that points at the runner (${classes}) on ${rows}`)];
}

/** A slice that is throttled, stalled or out of memory is a reason for queue wait that more rows will not fix. */
export function slicePressure(s, t = THRESHOLDS) {
  const out = [];
  for (const [name, w] of Object.entries(s.slices ?? {})) {
    if (!w) continue;
    const pct = (v) => `${Math.round(v * 100)}%`;
    if (w.oomKills > 0) out.push(f('slice-pressure', 'crit', null, `${name}: ${w.oomKills} OOM kill(s) in the last 15 min`));
    if (w.throttledShare > t.throttleWarn) out.push(f('slice-pressure', 'warn', null, `${name}: CPU throttled in ${pct(w.throttledShare)} of periods over the last 15 min`));
    if (w.cpuStallShare !== null && w.cpuStallShare > t.stallWarn) out.push(f('slice-pressure', 'warn', null, `${name}: tasks waited on CPU ${pct(w.cpuStallShare)} of the last 15 min`));
    if (w.memStallShare !== null && w.memStallShare > t.stallWarn) out.push(f('slice-pressure', 'warn', null, `${name}: tasks stalled on memory ${pct(w.memStallShare)} of the last 15 min`));
  }
  return out;
}

/** A row on the isolated list must run as its own account and keep its directory closed to every other account. */
export function isolationDrift(s) {
  const out = [];
  for (const r of s.rows) {
    if (!r.isolated || !r.enabled || r.parked) continue;
    const acct = r.account ?? `gx-${r.name}`;
    if (r.unitUser !== acct) out.push(f('isolation-drift', 'warn', r.name, `${r.unit}: listed as isolated but runs as ${r.unitUser || '(unknown)'}, not ${acct}`));
    if (r.dirGroup !== null && r.dirGroup !== acct) out.push(f('isolation-drift', 'warn', r.name, `${r.unit}: instance directory belongs to group ${r.dirGroup}, not ${acct}`));
    if (r.dirMode !== null && (r.dirMode & 0o007) !== 0) out.push(f('isolation-drift', 'warn', r.name, `${r.unit}: instance directory mode ${r.dirMode.toString(8)} lets other accounts in`));
  }
  return out;
}

/**
 * A pool unit systemd holds failed. Stopped is a pool row's rest; failed is not: its last start or
 * stop went wrong (a park that reached the mint step is invisible otherwise, because down()
 * leaves pool rows alone). The dispatcher resets it before its next start, so this
 * names it and heals nothing.
 */
export function failedAtRest(s) {
  return s.rows
    .filter((r) => r.pool && r.active === 'failed')
    .map((r) => f('failed-at-rest', 'warn', r.name, `${r.unit} is failed (${r.result || 'result unknown'}), not parked; its next start resets it`));
}

/**
 * A repository row whose unit runs with no job, whose registration GitHub lists online and idle,
 * while a queued job in its repository that its labels cover has waited unclaimedMs beside it
 * (joinQueue tracks how long). GitHub can stop handing such a registration jobs: a queued job then
 * waits behind a registration that is online and idle until the ephemeral unit recycles and a fresh
 * registration takes the job at once. The dispatcher counts such a row as the job's taker, so it starts nothing else and the queue stalls.
 * A pool row is left out: the dispatcher parks an idle one after POOL_IDLE_MS.
 */
export function unclaimedQueue(s, t = THRESHOLDS) {
  return s.rows.filter((r) => !r.pool && r.unclaimedMs !== null && r.unclaimedMs !== undefined && r.unclaimedMs >= t.unclaimedMs)
    .map((r) => ({ ...f('unclaimed-queue', 'warn', r.name, `${r.name} is online and idle on GitHub but has not claimed queued job ${r.waitingJob} in ${r.repo} for ${Math.round(r.unclaimedMs / 60000)} min`), job: r.waitingJob }));
}

export const DETECTORS = [crashLoop, down, failedAtRest, dispatcherStopped, stuckJob, staleRegistration, registrationLost, unclaimedQueue, versionDrift, diskPressure, queueWait, runnerSuspect, slicePressure, isolationDrift];

/** Every finding for a snapshot, most severe first. A detector that throws becomes its own finding rather than hiding the others. */
export function detect(s, t = THRESHOLDS) {
  const out = [];
  for (const d of DETECTORS) {
    try { out.push(...d(s, t)); } catch (e) { out.push(f('detector-error', 'warn', null, `${d.name}: ${e.message}`)); }
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'crit' ? -1 : 1));
}

/**
 * Join GitHub's runner list to each row: how long a registration has been offline or missing, tracked
 * across ticks in `seen`. A pool row (`pool` set) registers in whichever of its owner's repositories
 * its claim named, so its name is looked for in every listed repository of that owner: the online
 * registration, else the first found, is the row's (`regRepo` says where); every other offline, idle
 * one is a leftover of an earlier claim that no job took, listed in `staleRegs` for the heal.
 */
export function joinRegistrations(rows, gh, seen, now) {
  for (const r of rows) {
    const k = r.name;
    seen[k] ??= { offlineSince: null, absentSince: null };
    const scopes = r.pool ? Object.keys(gh).filter((x) => x.startsWith(`${r.pool}/`)) : [r.repo];
    const listed = scopes.filter((x) => gh[x]?.ok);
    if (!listed.length) { r.offlineMs = null; r.absentMs = null; r.regId = null; r.regBusy = false; r.regOnline = false; r.regRepo = null; r.staleRegs = []; continue; }
    const found = listed.flatMap((x) => gh[x].runners.filter((y) => y.name === r.name).map((y) => ({ ...y, repo: x })));
    const reg = found.find((y) => y.status === 'online') ?? found[0];
    // The id names the registration to the delete heal; busy is GitHub's own word that a job holds it.
    r.regId = reg?.id ?? null;
    r.regBusy = reg?.busy === true;
    r.regOnline = reg?.status === 'online';
    r.regRepo = reg?.repo ?? null;
    r.staleRegs = found.filter((y) => y !== reg && y.status !== 'online' && y.busy !== true).map((y) => ({ repo: y.repo, id: y.id }));
    if (!reg) { seen[k].absentSince ??= now; seen[k].offlineSince = null; }
    else if (reg.status !== 'online') { seen[k].offlineSince ??= now; seen[k].absentSince = null; }
    else { seen[k].offlineSince = null; seen[k].absentSince = null; }
    r.offlineMs = seen[k].offlineSince === null ? null : now - seen[k].offlineSince;
    r.absentMs = seen[k].absentSince === null ? null : now - seen[k].absentSince;
  }
  return rows;
}

/**
 * The queued jobs of dispatcher.json (`doc`, its parsed text, or null) that a repository row could
 * take: the jobs the dispatcher routed to the pool are the pool's. A document older than
 * queueFreshMs, or one that does not parse to a queue, gives null: nothing is judged from it.
 */
export function queuedFrom(doc, now, t = THRESHOLDS) {
  if (!doc || !Array.isArray(doc.queued) || !Number.isFinite(doc.at) || now - doc.at > t.queueFreshMs) return null;
  return doc.queued.filter((j) => j && typeof j === 'object' && !j.pool && j.repo && Array.isArray(j.labels) && j.labels.every((l) => typeof l === 'string'));
}

/**
 * How long each repository row has sat online, idle and free beside a queued job its labels cover,
 * tracked across ticks in `seen` (`unclaimedSince`), as `unclaimedMs` and the job's id as
 * `waitingJob`. Run after joinRegistrations, which sets regOnline and regBusy. A tick with no fresh
 * queue (`queued` null) judges nothing and keeps the clock where it was.
 */
export function joinQueue(rows, queued, seen, now) {
  for (const r of rows) {
    const k = r.name;
    seen[k] ??= { offlineSince: null, absentSince: null };
    r.unclaimedMs = null;
    r.waitingJob = null;
    if (queued === null) continue;
    const labels = (r.labels ?? []).map((l) => l.toLowerCase());
    const job = r.pool || !labels.length ? null : queued.find((j) => j.repo === r.repo && j.labels.every((l) => labels.includes(String(l).toLowerCase())));
    const free = r.active === 'active' && r.regOnline === true && !r.regBusy && r.workerMs === null && !r.parked && !r.held;
    if (!job || !free) { seen[k].unclaimedSince = null; continue; }
    seen[k].unclaimedSince ??= now;
    r.unclaimedMs = now - seen[k].unclaimedSince;
    r.waitingJob = job.id;
  }
  return rows;
}
