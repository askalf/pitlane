// node --test runners/pitlane-supervisor-detect.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { THRESHOLDS as T, crashLoop, detect, diskPressure, dispatcherStopped, down, failedAtRest, isolationDrift, joinRegistrations, queueWait, registrationLost, runnerSuspect, staleRegistration, stuckJob, versionDrift } from './pitlane-supervisor-detect.mjs';

const row = (o = {}) => ({ name: 'dario-exec-e3', repo: 'askalf/dario', unit: 'gha-ephemeral-first-party@dario-exec-e3.service', parked: false, held: false, enabled: true, active: 'active', sub: 'running', result: 'success', execStatus: 0, failures5m: 0, inactiveMs: 0, workerMs: null, diskVersion: '2.330.0', absentMs: null, offlineMs: null, ...o });
const snap = (rows, o = {}) => ({ now: 1e9, dispatcherActive: true, beatAgeMs: 10000, pinned: '2.330.0', disk: { '/srv': 40, '/': 30 }, rows, ...o });

test('a healthy snapshot has no findings', () => assert.deepEqual(detect(snap([row()])), []));

test('crash loop: the 226/NAMESPACE rows (missing /srv/gha dir) are caught by status, not by waiting for the count', () => {
  // journal: "gha-ephemeral-first-party@dario-exec-e3.service: Main process exited, code=exited, status=226/NAMESPACE"
  const s = snap([row({ active: 'activating', sub: 'auto-restart', result: 'exit-code', execStatus: 226 })]);
  const [x] = crashLoop(s);
  assert.equal(x.class, 'crash-loop');
  assert.equal(x.severity, 'crit');
  assert.match(x.msg, /226/);
});

test('crash loop: three restarts in five minutes, any status', () => {
  assert.equal(crashLoop(snap([row({ failures5m: 3 })])).length, 1);
  assert.equal(crashLoop(snap([row({ failures5m: 2 })])).length, 0);
});

test('crash loop: the finding carries the failure count, and the status when that alone named it', () => {
  const [byCount] = crashLoop(snap([row({ failures5m: 12 })]));
  assert.deepEqual([byCount.failures, byCount.status], [12, null]);
  const [byStatus] = crashLoop(snap([row({ result: 'exit-code', execStatus: 226, failures5m: 1 })]));
  assert.deepEqual([byStatus.failures, byStatus.status], [1, 226]);
});

test('a held row is a crash loop while its mark is there, parked or not, in words that do not change tick to tick', () => {
  const at = Date.parse('2026-10-29T20:00:00Z');
  const held = row({ held: true, heldAt: at, heldWhy: 'exit status 226; last journal line: x', active: 'inactive', inactiveMs: 9e6 });
  const [x] = crashLoop(snap([held]));
  assert.equal(x.held, true);
  assert.equal(x.severity, 'crit');
  assert.match(x.msg, /held since 2026-10-29T20:00:00\.000Z: exit status 226; last journal line: x/);
  assert.deepEqual(crashLoop(snap([{ ...held, inactiveMs: 9e7 }]))[0].msg, x.msg);
  assert.equal(crashLoop(snap([{ ...held, parked: true }])).length, 1);
  assert.equal(down(snap([held])).length, 0, 'a held row is not down');
  assert.match(crashLoop(snap([row({ held: true, heldAt: null, heldWhy: '' })]))[0].msg, /: held; it is not started/);
});

test('a parked row is never a crash loop or down', () => {
  const s = snap([row({ parked: true, active: 'inactive', inactiveMs: 9e6, result: 'exit-code', execStatus: 226 })]);
  assert.deepEqual(detect(s), []);
});

test('down: inactive past the grace, not parked, not held, not already a crash loop', () => {
  assert.equal(down(snap([row({ active: 'inactive', inactiveMs: T.downGraceMs })])).length, 1);
  assert.equal(down(snap([row({ active: 'inactive', inactiveMs: T.downGraceMs - 1 })])).length, 0);
  assert.equal(down(snap([row({ active: 'inactive', inactiveMs: 9e6, held: true })])).length, 0);
  assert.equal(down(snap([row({ enabled: false, active: 'inactive', inactiveMs: 9e6 })])).length, 0);
  const loop = snap([row({ active: 'failed', inactiveMs: 9e6, result: 'exit-code', execStatus: 226 })]);
  assert.deepEqual(down(loop), []);
  assert.equal(crashLoop(loop).length, 1);
});

test('a pool row is never down: stopped is its rest, and the dispatcher starts it for a job', () => {
  const pool = (o = {}) => row({ name: 'pool-e6', repo: 'pool:askalf', pool: 'askalf', unit: 'gha-ephemeral-first-party@pool-e6.service', ...o });
  assert.deepEqual(down(snap([pool({ active: 'inactive', inactiveMs: 9e6 })])), []);
  assert.deepEqual(down(snap([pool({ active: 'failed', inactiveMs: 9e6, result: 'exit-code', execStatus: 1 })])), []);
  // The same state on a repository row is down, so the exemption is the pool's alone.
  assert.equal(down(snap([row({ active: 'inactive', inactiveMs: 9e6 })])).length, 1);
  // A pool row that crash-loops is still a crash loop.
  assert.equal(crashLoop(snap([pool({ active: 'failed', result: 'exit-code', execStatus: 226 })])).length, 1);
});

test('failed-at-rest: a pool unit held failed is named (a park that reached the mint step is otherwise unseen); stopped or running it is not, and a repository row is down() territory', () => {
  const pool = (o = {}) => row({ name: 'pool-e3', repo: 'pool:askalf', pool: 'askalf', unit: 'gha-ephemeral-first-party@pool-e3.service', ...o });
  const [x] = failedAtRest(snap([pool({ active: 'failed', inactiveMs: 60000, result: 'signal', execStatus: 0 })]));
  assert.equal(x.class, 'failed-at-rest');
  assert.equal(x.severity, 'warn');
  assert.equal(x.row, 'pool-e3');
  assert.match(x.msg, /pool-e3\.service is failed \(signal\), not parked/);
  assert.deepEqual(failedAtRest(snap([pool({ active: 'inactive', inactiveMs: 9e6 })])), []);
  assert.deepEqual(failedAtRest(snap([pool()])), []);
  assert.deepEqual(failedAtRest(snap([row({ active: 'failed', inactiveMs: 9e6, result: 'signal' })])), [], 'a repository row failed is down or a crash loop, not this');
  assert.ok(detect(snap([pool({ active: 'failed', inactiveMs: 60000, result: 'signal', execStatus: 0 })])).some((f) => f.class === 'failed-at-rest'), 'detect() runs it');
});

test('dispatcher stopped: the unit down, or a stale heartbeat once it writes one', () => {
  assert.equal(dispatcherStopped(snap([], { beatAgeMs: T.beatMaxMs })).length, 0);
  assert.equal(dispatcherStopped(snap([], { beatAgeMs: T.beatMaxMs + 1 })).length, 1);
  assert.equal(dispatcherStopped(snap([], { beatAgeMs: null })).length, 0);
  assert.match(dispatcherStopped(snap([], { dispatcherActive: false, beatAgeMs: null }))[0].msg, /not running/);
});

test('dispatcher stopped: the cause says what the heal may do', () => {
  const cause = (o) => dispatcherStopped(snap([], o))[0]?.cause;
  assert.equal(cause({ dispatcherActive: false, dispatcherState: { active: 'failed', result: 'start-limit-hit' } }), 'failed');
  assert.match(dispatcherStopped(snap([], { dispatcherActive: false, dispatcherState: { active: 'failed', result: 'start-limit-hit' } }))[0].msg, /failed \(start-limit-hit\)/);
  // A pause is a plain stop: inactive, result success. Never restarted by the heal.
  assert.equal(cause({ dispatcherActive: false, dispatcherState: { active: 'inactive', result: 'success' } }), 'paused');
  assert.match(dispatcherStopped(snap([], { dispatcherActive: false, dispatcherState: { active: 'inactive', result: 'success' } }))[0].msg, /not running: stopped by hand/);
  // Between systemd's own restarts (RestartSec=30), or a state not read: systemd's to handle.
  assert.equal(cause({ dispatcherActive: false, dispatcherState: { active: 'activating', result: 'exit-code' } }), 'stopped');
  assert.equal(cause({ dispatcherActive: false }), 'stopped');
  assert.equal(cause({ beatAgeMs: T.beatRestartMs }), 'late-beat');
  assert.equal(cause({ beatAgeMs: T.beatRestartMs + 1 }), 'stale-beat');
  assert.equal(dispatcherStopped(snap([], { beatAgeMs: T.beatMaxMs + 1 }))[0].cause, 'late-beat');
});

test('stuck job: a worker older than the ceiling only', () => {
  assert.equal(stuckJob(snap([row({ workerMs: T.stuckMs + 1 })])).length, 1);
  assert.equal(stuckJob(snap([row({ workerMs: 60000 })])).length, 0);
  assert.equal(stuckJob(snap([row()])).length, 0);
});

test('version drift against the pin; unknown disk version is not drift', () => {
  assert.equal(versionDrift(snap([row({ diskVersion: '2.329.0' })])).length, 1);
  assert.equal(versionDrift(snap([row({ diskVersion: null })])).length, 0);
});

test('disk pressure: warn at 80, crit at 90', () => {
  assert.equal(diskPressure(snap([], { disk: { '/srv': 85 } }))[0].severity, 'warn');
  assert.equal(diskPressure(snap([], { disk: { '/srv': 90 } }))[0].severity, 'crit');
  assert.equal(diskPressure(snap([], { disk: { '/srv': 79 } })).length, 0);
});

test('queue wait: judged against the targets only once the hour has enough jobs', () => {
  const w = (n, p50, p90) => snap([], { waits: { all: { n, p50, p90, max: p90 } } });
  assert.equal(queueWait(w(9, 60000, 90000)).length, 0);
  assert.equal(queueWait(w(10, 4000, 30000)).length, 0);
  assert.equal(queueWait(w(10, 6000, 30000)).length, 1);
  assert.equal(queueWait(w(10, 4000, 31000)).length, 1);
  assert.equal(queueWait(w(10, 6000, 31000)).length, 2);
  assert.equal(queueWait(snap([])).length, 0);
});

test('registrations: offline and absent are timed across ticks and reset when the row recovers', () => {
  const seen = {};
  const gh = { 'askalf/dario': { ok: true, runners: [{ name: 'dario-exec-e3', status: 'offline', busy: false }] } };
  let rows = joinRegistrations([row({ active: 'inactive' })], gh, seen, 0);
  assert.equal(rows[0].offlineMs, 0);
  rows = joinRegistrations([row({ active: 'inactive' })], gh, seen, T.staleRegMs);
  assert.equal(staleRegistration(snap(rows)).length, 1);
  const online = { 'askalf/dario': { ok: true, runners: [{ name: 'dario-exec-e3', status: 'online', busy: false }] } };
  rows = joinRegistrations([row()], online, seen, T.staleRegMs + 1);
  assert.equal(rows[0].offlineMs, null);

  const none = { 'askalf/dario': { ok: true, runners: [] } };
  const seen2 = {};
  joinRegistrations([row()], none, seen2, 0);
  rows = joinRegistrations([row()], none, seen2, T.lostRegMs);
  assert.equal(registrationLost(snap(rows)).length, 1);
});

test('a pool row is joined over every listed repository of its owner: the online registration is its own, offline leftovers are stale at once', () => {
  const pool = row({ name: 'pool-e1', repo: 'pool:askalf', pool: 'askalf', unit: 'gha-ephemeral-first-party@pool-e1.service' });
  const gh = {
    'askalf/dario': { ok: true, runners: [{ id: 1, name: 'pool-e1', status: 'offline', busy: false }, { id: 3, name: 'dario-exec-e3', status: 'online', busy: false }] },
    'askalf/ci': { ok: true, runners: [{ id: 2, name: 'pool-e1', status: 'online', busy: true }] },
    'askalf/x': { ok: false, runners: [] },
  };
  const [r] = joinRegistrations([pool], gh, {}, 0);
  assert.equal(r.regId, 2);
  assert.equal(r.regRepo, 'askalf/ci');
  assert.equal(r.regBusy, true);
  assert.equal(r.offlineMs, null);
  assert.deepEqual(r.staleRegs, [{ repo: 'askalf/dario', id: 1 }]);
  const out = staleRegistration(snap([r]));
  assert.deepEqual(out.map((x) => [x.class, x.row, x.repo, x.id]), [['stale-registration', 'pool-e1', 'askalf/dario', 1]]);
});

test('a parked pool row offline past staleRegMs is stale, named with its repository; a parked repository row is not', () => {
  const seen = {};
  const gh = { 'askalf/dario': { ok: true, runners: [{ id: 5, name: 'pool-e1', status: 'offline', busy: false }, { id: 6, name: 'dario-exec-e3', status: 'offline', busy: false }] } };
  const rows = () => [row({ name: 'pool-e1', repo: 'pool:askalf', pool: 'askalf', parked: true, active: 'inactive' }), row({ parked: true, active: 'inactive' })];
  joinRegistrations(rows(), gh, seen, 0);
  const out = staleRegistration(snap(joinRegistrations(rows(), gh, seen, T.staleRegMs)));
  assert.deepEqual(out.map((x) => [x.row, x.repo, x.id]), [['pool-e1', 'askalf/dario', 5]]);
  assert.match(out[0].msg, /in askalf\/dario$/);
});

test('a pool row with no listed repository of its owner produces no registration findings', () => {
  const pool = row({ name: 'pool-e1', repo: 'pool:askalf', pool: 'askalf', active: 'inactive' });
  const [r] = joinRegistrations([pool], { 'askalf/dario': { ok: false, runners: [] } }, {}, 1e9);
  assert.equal(r.regId, null);
  assert.deepEqual(r.staleRegs, []);
  assert.deepEqual(staleRegistration(snap([r])), []);
});

test('a repo whose GitHub listing failed produces no registration findings', () => {
  const rows = joinRegistrations([row()], { 'askalf/dario': { ok: false, runners: [] } }, {}, 1e9);
  assert.deepEqual(detect(snap(rows)), []);
});

test('findings sort crit first, and a throwing detector does not hide the rest', () => {
  const s = snap([row({ workerMs: T.stuckMs + 1 })], { disk: { '/srv': 95 } });
  assert.equal(detect(s)[0].class, 'disk-pressure');
  const out = detect({ ...snap([]), rows: null, disk: { '/srv': 95 } });
  assert.ok(out.some((x) => x.class === 'detector-error'));
  assert.ok(out.some((x) => x.class === 'disk-pressure'));
});

test('a parked row keeps its offline entry on GitHub on purpose and is not a stale registration', () => {
  const rows = [row({ parked: true, active: 'inactive', offlineMs: T.staleRegMs * 10 }), row({ name: 'dario-exec-e4', parked: false, active: 'inactive', offlineMs: T.staleRegMs * 10 })];
  const found = staleRegistration(snap(rows));
  assert.equal(found.length, 1);
  assert.equal(found[0].row, 'dario-exec-e4');
});

test('finished jobs are not failures: a busy repository does not trip the crash loop', () => {
  assert.equal(crashLoop(snap([row({ failures5m: 0 })])).length, 0);
});

test('runner-suspect: names the jobs the runner may have lost, and says nothing for a clean hour', () => {
  const ok = { n: 40, classes: { success: 38, 'job-failed': 2 }, suspect: { n: 0, rate: 0, runners: {} } };
  assert.equal(runnerSuspect(snap([], { outcomes: { lastHour: ok } })).length, 0);
  assert.equal(runnerSuspect(snap([])).length, 0);
  const bad = { n: 40, classes: { success: 36, 'setup-failed': 1, 'runner-lost-suspect': 2, 'job-failed': 1 }, suspect: { n: 3, rate: 0.075, runners: { 'dario-exec-e2': 2, 'ci-exec-e1': 1 } } };
  const found = runnerSuspect(snap([], { outcomes: { lastHour: bad } }));
  assert.equal(found.length, 1);
  assert.match(found[0].msg, /3 of 40 jobs/);
  assert.match(found[0].msg, /setup-failed 1, runner-lost-suspect 2/);
  assert.match(found[0].msg, /dario-exec-e2 2, ci-exec-e1 1/);
  assert.equal(detect(snap([], { outcomes: { lastHour: bad } })).some((x) => x.class === 'runner-suspect'), true);
});

test('isolation-drift: a listed row must run as its own account behind a closed directory', () => {
  const iso = (o = {}) => row({ name: 'a', isolated: true, enabled: true, unitUser: 'gx-a', dirGroup: 'gx-a', dirMode: 0o1770, ...o });
  assert.equal(isolationDrift(snap([iso()])).length, 0);
  assert.equal(isolationDrift(snap([row({ name: 'b', unitUser: 'gha-exec' })])).length, 0);
  assert.equal(isolationDrift(snap([iso({ parked: true, unitUser: 'gha-exec' })])).length, 0);
  assert.match(isolationDrift(snap([iso({ unitUser: 'gha-exec' })]))[0].msg, /runs as gha-exec, not gx-a/);
  assert.match(isolationDrift(snap([iso({ dirGroup: 'gha-exec' })]))[0].msg, /group gha-exec, not gx-a/);
  assert.match(isolationDrift(snap([iso({ dirMode: 0o1775 })]))[0].msg, /mode 1775 lets other accounts in/);
  assert.equal(isolationDrift(snap([iso({ dirGroup: null, dirMode: null })])).length, 0);
  const own = iso({ name: 'acme-marketing-site-redline-e1', account: 'gx-acme-site-redline-e1', unitUser: 'gx-acme-site-redline-e1', dirGroup: 'gx-acme-site-redline-e1' });
  assert.equal(isolationDrift(snap([own])).length, 0, 'an account= row is checked against its own account');
  assert.match(isolationDrift(snap([{ ...own, unitUser: 'gx-acme-marketing-site-redline-e1' }]))[0].msg, /not gx-acme-site-redline-e1/);
});

test('unclaimed queue: a build row online and idle beside the host-scripts deploy it never claimed', async () => {
  const { joinQueue, queuedFrom, unclaimedQueue } = await import('./pitlane-supervisor-detect.mjs');
  const build = (o = {}) => row({ name: 'app-build-e1', repo: 'askalf/app', unit: 'gha-ephemeral-build@app-build-e1.service', labels: ['self-hosted', 'linux', 'x64', 'app-build'], regOnline: true, regBusy: false, ...o });
  const doc = (at, queued) => ({ at, queued });
  const deploy = { id: 121947757224, repo: 'askalf/app', labels: ['self-hosted', 'app-build'], pool: false };
  const seen = {};
  const tickAt = (now, r, q = [deploy], at = now) => { const rows = [r]; joinQueue(rows, queuedFrom(doc(at, q), now), seen, now); return rows; };
  const t0 = 1e9;
  let [r] = tickAt(t0, build());
  assert.equal(r.unclaimedMs, 0);
  assert.deepEqual(unclaimedQueue(snap([r])), [], 'the first sighting is no finding');
  [r] = tickAt(t0 + T.unclaimedMs - 1, build());
  assert.deepEqual(unclaimedQueue(snap([r])), []);
  [r] = tickAt(t0 + T.unclaimedMs, build());
  const [x] = unclaimedQueue(snap([r]));
  assert.equal(x.class, 'unclaimed-queue');
  assert.equal(x.row, 'app-build-e1');
  assert.equal(x.job, deploy.id);
  assert.match(x.msg, /online and idle on GitHub but has not claimed queued job 121947757224 in askalf\/app for 5 min/);
  assert.ok(detect(snap([r])).some((y) => y.class === 'unclaimed-queue'), 'detect() runs it');
  // The job taken (a worker, or GitHub busy) or gone resets the clock.
  [r] = tickAt(t0 + T.unclaimedMs + 1, build({ workerMs: 1000 }));
  assert.equal(r.unclaimedMs, null);
  assert.equal(seen['app-build-e1'].unclaimedSince, null);
  tickAt(t0 + 2, build());
  tickAt(t0 + 3, build(), []);
  assert.equal(seen['app-build-e1'].unclaimedSince, null, 'an empty queue resets it');
});

test('unclaimed queue: only a free repository row beside a job its labels cover, from a fresh dispatcher.json', async () => {
  const { joinQueue, queuedFrom } = await import('./pitlane-supervisor-detect.mjs');
  const now = 1e9;
  const build = (o = {}) => row({ name: 'b', repo: 'askalf/app', labels: ['self-hosted', 'app-build'], regOnline: true, regBusy: false, ...o });
  const job = (o = {}) => ({ id: 7, repo: 'askalf/app', labels: ['self-hosted', 'app-build'], pool: false, ...o });
  const judged = (r, q = [job()], at = now) => { const rows = [r]; joinQueue(rows, queuedFrom({ at, queued: q }, now), {}, now); return rows[0].unclaimedMs; };
  assert.equal(judged(build()), 0);
  for (const o of [{ regOnline: false }, { regBusy: true }, { workerMs: 5 }, { parked: true }, { held: true }, { active: 'activating' }, { pool: 'askalf' }, { labels: [] }]) {
    assert.equal(judged(build(o)), null, JSON.stringify(o));
  }
  assert.equal(judged(build(), [job({ repo: 'askalf/dario' })]), null, 'another repository');
  assert.equal(judged(build(), [job({ labels: ['self-hosted', 'App-Deploy'] })]), null, 'a label it lacks');
  assert.equal(judged(build(), [job({ labels: ['Self-Hosted', 'APP-BUILD'] })]), 0, 'labels compare without case');
  assert.equal(judged(build(), [job({ pool: true })]), null, 'a job routed to the pool');
  assert.equal(judged(build(), [job()], now - T.queueFreshMs - 1), null, 'a stale dispatcher.json');
  assert.equal(queuedFrom(null, now), null);
  assert.equal(queuedFrom({ at: now }, now), null);
  // A damaged dispatcher.json: entries that are not jobs, or labels that are not text, are not queued jobs.
  const damaged = queuedFrom({ at: now, queued: [null, 7, 'x', { repo: 'a/b', labels: [{ toString: 1 }] }, { repo: 'a/b', labels: ['self-hosted'] }] }, now);
  assert.deepEqual(damaged, [{ repo: 'a/b', labels: ['self-hosted'] }]);
  // No fresh queue keeps the clock where it was rather than resetting it.
  const seen = { b: { unclaimedSince: now - 60000 } };
  joinQueue([build()], null, seen, now);
  assert.equal(seen.b.unclaimedSince, now - 60000);
});

test('not enabled: a manifest row whose unit apply has not enabled, beside a queued job its labels cover', async () => {
  const { joinQueue, queuedFrom, notEnabled } = await import('./pitlane-supervisor-detect.mjs');
  const read = (o = {}) => row({ name: 'app-read-e1', repo: 'askalf/app', unit: 'gha-ephemeral-redline@app-read-e1.service', labels: ['self-hosted', 'linux', 'x64', 'app-read'], enabled: false, active: 'inactive', sub: 'dead', inactiveMs: 9e6, regOnline: false, regBusy: false, ...o });
  const audit = { id: 42483156065, repo: 'askalf/app', labels: ['self-hosted', 'app-read'], pool: false };
  const seen = {};
  const tickAt = (now, r, q = [audit]) => { const rows = [r]; joinQueue(rows, queuedFrom({ at: now, queued: q }, now), seen, now); return rows; };
  const t0 = 1e9;
  let [r] = tickAt(t0, read());
  assert.equal(r.notEnabledMs, 0);
  assert.equal(r.notEnabledJob, audit.id);
  assert.deepEqual(notEnabled(snap([r])), [], 'the first sighting is no finding: the press may follow the deploy within the grace');
  [r] = tickAt(t0 + T.notEnabledMs - 1, read());
  assert.deepEqual(notEnabled(snap([r])), []);
  [r] = tickAt(t0 + T.notEnabledMs, read());
  const [x] = notEnabled(snap([r]));
  assert.equal(x.class, 'not-enabled');
  assert.equal(x.severity, 'crit');
  assert.equal(x.row, 'app-read-e1');
  assert.equal(x.job, audit.id);
  assert.match(x.msg, /is in the manifest but not enabled.*queued job 42483156065 in askalf\/app has waited 2 min; run gha-runners-apply\.sh bootstrap, then apply/);
  assert.ok(detect(snap([r])).some((y) => y.class === 'not-enabled'), 'detect() runs it');
  assert.deepEqual(down(snap([r])), [], 'a row that is not enabled is not down: nothing is meant to start it yet');
  assert.deepEqual(r.unclaimedMs, null, 'an inactive row is never unclaimed');
  // apply ran (enabled), or the job is gone: no finding, and the clock resets.
  [r] = tickAt(t0 + T.notEnabledMs + 1, read({ enabled: true }));
  assert.equal(r.notEnabledMs, null);
  [r] = tickAt(t0 + T.notEnabledMs + 2, read(), []);
  assert.equal(r.notEnabledMs, null);
  [r] = tickAt(t0 + T.notEnabledMs + 3, read());
  assert.equal(r.notEnabledMs, 0, 'a fresh spell starts at zero');
  // A different matching job in the first one's place, with no empty-queue tick between: the clock is
  // the new job's, so a job just queued is never credited with the wait of one that finished.
  const t1 = t0 + T.notEnabledMs + 3;
  [r] = tickAt(t1 + T.notEnabledMs - 1, read());
  assert.equal(r.notEnabledMs, T.notEnabledMs - 1);
  const later = { ...audit, id: audit.id + 1 };
  [r] = tickAt(t1 + T.notEnabledMs, read(), [later]);
  assert.deepEqual([r.notEnabledMs, r.notEnabledJob], [0, later.id]);
  assert.deepEqual(notEnabled(snap([r])), [], 'the replacement starts a new spell');
  [r] = tickAt(t1 + 2 * T.notEnabledMs, read(), [later]);
  assert.equal(notEnabled(snap([r]))[0].job, later.id);
  // A queued record without an id (queuedFrom accepts one) still gets a clock from its first sighting,
  // and the finding says so instead of naming a job.
  const seen2 = {};
  const noId = { repo: 'askalf/app', labels: ['self-hosted', 'app-read'], pool: false };
  const tick2 = (now) => { const rows = [read()]; joinQueue(rows, queuedFrom({ at: now, queued: [noId] }, now), seen2, now); return rows[0]; };
  assert.deepEqual([tick2(t0).notEnabledMs, tick2(t0).notEnabledJob], [0, null]);
  const [y] = notEnabled(snap([tick2(t0 + T.notEnabledMs)]));
  assert.equal(y.job, null);
  assert.match(y.msg, /queued job \(no id\) in askalf\/app has waited 2 min/);
  // A pool row is never judged here: the dispatcher starts it for a job, and apply enables pool rows parked.
  const pool = read({ name: 'pool-e1', pool: 'askalf', repo: null, labels: ['self-hosted', 'app-read'] });
  const rows = [pool]; joinQueue(rows, queuedFrom({ at: t0, queued: [audit] }, t0), {}, t0);
  assert.equal(rows[0].notEnabledMs, null);
});
