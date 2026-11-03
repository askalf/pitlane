// node --test deploy/gha-runners/gha-ondemand.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POOL_IDLE_MS, RateFloorError, appToken, claimOf, fileToken, tokensByOwner, clearedMarks, collectJobs, deployRecord, idleClock, kickPlan, limitPool, managedRows, plan, promised, readDeploy, recent, registeredIn, releaseRegistration, stateDoc, syncQueue, unitFor, watchedRows, writeState } from './gha-ondemand.mjs';

test('the state document: every row with its unit reading and what the tick did to it, each queued job and where it went, the knobs, the budget, the events; and it serialises', () => {
  const state = {
    'ci-exec-e1': { raw: 'inactive', active: false, busy: false, idleSince: null, claimed: null },
    'dario-exec-e1': { raw: 'active', active: true, busy: true, idleSince: null, claimed: null },
    'pool-e1': { raw: 'active', active: true, busy: false, idleSince: 500, claimed: 'askalf/ci' },
  };
  const queued = [{ id: 1, repo: 'askalf/ci', labels: ['self-hosted', 'ci-exec'] }, { id: 2, repo: 'askalf/dario', labels: ['self-hosted', 'dario-exec'] }];
  const decided = { start: ['ci-exec-e1'], park: ['pool-e1'], room: [], held: 0, queue: [queued[1]] };
  const knobs = { pollSec: 30, idleMin: 10, execCap: 12, poolMax: 12, warm: ['dario-exec-e1'] };
  const github = { left: 4000, resetAt: 9000, floor: 500, tokens: 'askalf: app', failed: [] };
  const doc = stateDoc({ now: 1000, mode: 'on', rows: POOLED, state, marks: ['gha-ephemeral-first-party@pool-e1.service'], hold: ['dario-exec-e1'], queued, decided, knobs, load: 2, github, events: [{ at: 900, kind: 'kick', repo: 'askalf/ci', job: 1 }] });
  assert.equal(doc.at, 1000);
  assert.equal(doc.mode, 'on');
  assert.deepEqual(doc.knobs, { ...knobs, poolIdleSec: 45 });
  const by = Object.fromEntries(doc.rows.map((r) => [r.name, r]));
  assert.equal(doc.rows.length, POOLED.length, 'one entry per managed row, a row never read included');
  assert.equal(doc.rows.filter((r) => r.raw === 'unknown').length, POOLED.length - 3, 'a row the tick did not read is unknown, never a guess');
  assert.equal(by['ci-exec-e1'].tick, 'start', 'a started row says so, its reading still the one before the start');
  assert.equal(by['ci-exec-e1'].raw, 'inactive');
  assert.equal(by['ci-exec-e1'].repo, 'askalf/ci');
  assert.equal(by['ci-exec-e1'].unit, 'gha-ephemeral-first-party@ci-exec-e1.service');
  assert.deepEqual([by['dario-exec-e1'].busy, by['dario-exec-e1'].warm, by['dario-exec-e1'].hold, by['dario-exec-e1'].tick], [true, true, true, null]);
  assert.deepEqual([by['pool-e1'].pool, by['pool-e1'].tick, by['pool-e1'].parked, by['pool-e1'].claimed, by['pool-e1'].idleSince], ['askalf', 'park', true, 'askalf/ci', 500]);
  assert.deepEqual(doc.queued.map((j) => [j.id, j.repo, j.pool]), [[1, 'askalf/ci', false], [2, 'askalf/dario', true]], 'the job routed to the pool is flagged');
  assert.deepEqual([doc.held, doc.load], [0, 2]);
  assert.deepEqual(doc.github, github);
  assert.equal(doc.events.length, 1);
  assert.equal(doc.deploy, null, 'no deploy record given: null, not a guess');
  const deploy = { ref: 'a'.repeat(40), installedAt: 800, startedAt: 900, restart: false };
  assert.deepEqual(stateDoc({ now: 1000, mode: 'on', rows: POOLED, state, marks: [], queued: [], decided, knobs, load: 2, github, events: [], deploy }).deploy, deploy);
  const back = JSON.parse(JSON.stringify(doc));
  assert.equal(back.rows.length, POOLED.length);
  // Dry mode marks a parked row's clock Infinity; the document carries null, not a string.
  const dry = stateDoc({ now: 1000, mode: 'dry', rows: POOLED, state: { ...state, 'pool-e1': { ...state['pool-e1'], idleSince: Number.POSITIVE_INFINITY } }, marks: [], queued: [], decided: { start: [], park: [], room: [], held: 0, queue: [] }, knobs, load: 0, github, events: [] });
  assert.equal(dry.rows.find((r) => r.name === 'pool-e1').idleSince, null);
  // A park that makes room under the cap is told apart from an idle park.
  const roomDoc = stateDoc({ now: 1000, mode: 'on', rows: POOLED, state, marks: [], queued: [], decided: { start: [], park: ['pool-e1'], room: ['pool-e1'], held: 2, queue: [] }, knobs, load: 12, github, events: [] });
  assert.equal(roomDoc.rows.find((r) => r.name === 'pool-e1').tick, 'park-room');
  assert.equal(roomDoc.held, 2);
});

test('deployRecord: the installed commit when the file holds one, this start, and restart only when a module on disk is newer than it', () => {
  const sha = '4515cdb1327289f7968971763e5a1b7a7e264cf7';
  assert.deepEqual(deployRecord({ ref: `${sha}\n`, installedAt: 1000.6, startedAt: 2000, codeAt: 1000.6 }), { ref: sha, installedAt: 1001, startedAt: 2000, restart: false });
  assert.deepEqual(deployRecord({ ref: null, installedAt: null, startedAt: 2000, codeAt: null }), { ref: null, installedAt: null, startedAt: 2000, restart: false }, 'before any deploy writes the file');
  assert.equal(deployRecord({ ref: 'main', installedAt: 1000, startedAt: 2000, codeAt: null }).ref, null, 'a file that is not a commit is no commit');
  assert.equal(deployRecord({ ref: sha, installedAt: 3000, startedAt: 2000, codeAt: 3000 }).restart, true, 'a module copied after the start: the code running is older than the code on disk');
  assert.equal(deployRecord({ ref: sha, installedAt: 3000, startedAt: 2000, codeAt: 1500 }).restart, false, 'the ref file alone being newer is not a restart: the modules did not change');
});

test('readDeploy: the ref file and the modules from disk; a missing file reads as nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pitlane-deploy-'));
  const refFile = join(dir, 'pitlane.ref');
  const mod = join(dir, 'gha-ondemand.mjs');
  assert.deepEqual(readDeploy(5000, { refFile, modules: [mod] }), { ref: null, installedAt: null, startedAt: 5000, restart: false });
  const sha = 'b'.repeat(40);
  writeFileSync(refFile, `${sha}\n`);
  writeFileSync(mod, '// code\n');
  const later = readDeploy(Date.now() + 60_000, { refFile, modules: [mod] });
  assert.equal(later.ref, sha);
  assert.ok(Math.abs(later.installedAt - Date.now()) < 60_000, 'installedAt is the ref file mtime');
  assert.equal(later.restart, false, 'started after the copy');
  const earlier = readDeploy(Date.now() - 60_000, { refFile, modules: [mod] });
  assert.equal(earlier.restart, true, 'started before the copy: a restart is pending');
});

test('recent: the event is stamped and kept with the last hour, newest last, at most max', () => {
  const now = 10 * 3600000;
  let events = [];
  events = recent(events, { kind: 'kick', repo: 'askalf/ci' }, now - 3600001);
  events = recent(events, { kind: 'start', row: 'pool-e1' }, now - 10);
  events = recent(events, { kind: 'park', row: 'pool-e1' }, now);
  assert.deepEqual(events.map((e) => e.kind), ['start', 'park'], 'the kick from over an hour before the last event is gone');
  assert.deepEqual(events.map((e) => e.at), [now - 10, now]);
  let many = [];
  for (let i = 0; i < 310; i += 1) many = recent(many, { kind: 'kick', job: i }, now + i, { max: 300 });
  assert.equal(many.length, 300);
  assert.equal(many[0].job, 10, 'the oldest go first');
});

test('writeState writes the document whole, by rename, and leaves no .tmp behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pitlane-state-'));
  const path = join(dir, 'dispatcher.json');
  writeState(path, { at: 1, rows: [] });
  writeState(path, { at: 2, rows: [{ name: 'pool-e1' }] });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { at: 2, rows: [{ name: 'pool-e1' }] });
  assert.deepEqual(readdirSync(dir), ['dispatcher.json']);
});

test('writeState: the document names repositories and rows, so it is 0640 to the reader group it is given and 0600 with none', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pitlane-state-')), 'dispatcher.json');
  const gid = process.getgid?.() ?? 0;
  writeState(path, { at: 1 }, gid);
  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o640);
    assert.equal(statSync(path).gid, gid);
  }
  writeState(path, { at: 2 }, null);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { at: 2 });
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('the idle clock runs only for a unit that is active with no job: an activating unit (its mint step) is never idle, so it is never parked mid-mint', () => {
  const now = 1000;
  assert.equal(idleClock(null, { raw: 'active', active: true, busy: false }, now), now, 'first seen idle: the clock starts now');
  assert.equal(idleClock(400, { raw: 'active', active: true, busy: false }, now), 400, 'still idle: the clock keeps its start');
  assert.equal(idleClock(400, { raw: 'active', active: true, busy: true }, now), null, 'a job ends the stretch');
  assert.equal(idleClock(400, { raw: 'activating', active: true, busy: false }, now), null, 'a pool row parked 45 s after a start has its mint step killed by the stop');
  assert.equal(idleClock(null, { raw: 'deactivating', active: true, busy: false }, now), null, 'a stop under way is not idle either');
  assert.equal(idleClock(400, { raw: 'inactive', active: false, busy: false }, now), null);
  // The plan reads the clock: an activating pool row with no idle start is not parked, however long it has been that way.
  const state = { 'pool-e1': { raw: 'activating', active: true, busy: false, idleSince: null, claimed: null } };
  assert.deepEqual(plan(POOLED, state, [], { now: now + 10 * POOL_IDLE_MS, idleMs: 600000 }).park, []);
  const settled = { 'pool-e1': { raw: 'active', active: true, busy: false, idleSince: now, claimed: null } };
  assert.deepEqual(plan(POOLED, settled, [], { now: now + POOL_IDLE_MS, idleMs: 600000 }).park, ['pool-e1']);
});

const MANIFEST = `
# comment
host-ops repo:askalf/shop 1 root /root/actions-runner-host-ops ops adopt
oss-1 org:sprayberry-code 1 gha-oss /srv/gha/oss-1 self-hosted,Linux,X64,oss,breaker ephemeral
app-exec-e1 repo:askalf/app 1 gha-exec /srv/gha/app-exec-e1 self-hosted,Linux,X64,app-exec ephemeral
app-exec-e2 repo:askalf/app 1 gha-exec /srv/gha/app-exec-e2 self-hosted,Linux,X64,app-exec ephemeral
dario-redline-e1 repo:askalf/dario 1 gha-redline /srv/gha/dario-redline-e1 self-hosted,Linux,X64,redline ephemeral
`;
const rows = managedRows(MANIFEST);
const MIN = 60000;
const job = (repo, ...labels) => ({ repo, labels: ['self-hosted', ...labels] });

test('only repository-scoped ephemeral rows are managed', () => {
  assert.deepEqual(rows.map((r) => r.name), ['app-exec-e1', 'app-exec-e2', 'dario-redline-e1']);
  assert.equal(rows[0].unit, 'gha-ephemeral-first-party@app-exec-e1.service');
  assert.equal(rows[2].unit, unitFor('gha-redline', 'dario-redline-e1'));
});

test('an org row is watched, never managed: listed with its unit, read-only, in the state document', () => {
  const watched = watchedRows(MANIFEST);
  assert.deepEqual(watched.map((r) => [r.name, r.org, r.unit]), [['oss-1', 'sprayberry-code', unitFor('gha-oss', 'oss-1')]]);
  assert.ok(!rows.some((r) => r.name === 'oss-1'), 'the same row is not managed');
  const decided = { start: [], park: [], room: [], held: 0, queue: [] };
  const doc = stateDoc({ now: 0, mode: 'on', rows, state: {}, marks: [], queued: [], decided, knobs: { warm: [] }, load: 0, github: null, events: [], watched: watched.map((r) => ({ ...r, raw: 'active', active: true, busy: true, held: false })) });
  assert.deepEqual(doc.watched, [{ name: 'oss-1', org: 'sprayberry-code', tier: '1', unit: unitFor('gha-oss', 'oss-1'), labels: ['self-hosted', 'linux', 'x64', 'oss', 'breaker'], raw: 'active', busy: true, held: false }]);
  assert.deepEqual(stateDoc({ now: 0, mode: 'on', rows, state: {}, marks: [], queued: [], decided, knobs: { warm: [] }, load: 0, github: null, events: [] }).watched, [], 'no org rows read: an empty list, not a guess');
  assert.equal(stateDoc({ now: 0, mode: 'on', rows, state: {}, marks: [], queued: [], decided, knobs: { warm: [] }, load: 0, github: null, events: [], watched: [{ name: 'oss-2', org: 'sprayberry-code', tier: '1', unit: 'u', labels: [] }] }).watched[0].raw, 'unknown', 'a unit not read is unknown');
});

test('a build row (root) runs under the build template and is managed like any other ephemeral row', () => {
  assert.equal(unitFor('root', 'app-build-e1'), 'gha-ephemeral-build@app-build-e1.service');
  const withBuild = managedRows(`${MANIFEST}
app-build-e1 repo:askalf/app build root /srv/gha/app-build-e1 self-hosted,Linux,X64,app-build ephemeral
`);
  const row = withBuild.find((r) => r.name === 'app-build-e1');
  assert.ok(row, 'the build row is managed');
  assert.equal(row.unit, 'gha-ephemeral-build@app-build-e1.service');
  const r = plan(withBuild, {}, [job('askalf/app', 'app-build')], { now: 0, idleMs: 10 * MIN });
  assert.deepEqual(r, { start: ['app-build-e1'], park: [], room: [], held: 0, queue: [] });
});

test('a queued job starts one stopped row of its repository whose labels cover it', () => {
  const state = {};
  const r = plan(rows, state, [job('askalf/app', 'app-exec')], { now: 0, idleMs: 10 * MIN });
  assert.deepEqual(r, { start: ['app-exec-e1'], park: [], room: [], held: 0, queue: [] });
});

test('a queued job an idle running listener can take starts nothing', () => {
  const state = { 'app-exec-e2': { active: true, busy: false, idleSince: 0 } };
  const r = plan(rows, state, [job('askalf/app', 'app-exec')], { now: 60 * MIN, idleMs: 10 * MIN });
  assert.deepEqual(r, { start: [], park: [], room: [], held: 0, queue: [] });
});

test('two queued jobs with one idle listener start one more row', () => {
  const state = { 'app-exec-e1': { active: true, busy: false, idleSince: 0 } };
  const r = plan(rows, state, [job('askalf/app', 'app-exec'), job('askalf/app', 'app-exec')], { now: 0, idleMs: 10 * MIN });
  assert.deepEqual(r.start, ['app-exec-e2']);
});

test('a job for labels no row covers, or for another repository, starts nothing', () => {
  const r = plan(rows, {}, [job('askalf/app', 'dario-exec'), job('askalf/cordon', 'app-exec'), job('askalf/app', 'Linux', 'app-exec', 'gpu')], { now: 0, idleMs: 10 * MIN });
  assert.deepEqual(r.start, []);
});

test('labels match without regard to case', () => {
  const r = plan(rows, {}, [job('askalf/app', 'linux', 'x64', 'App-Exec')], { now: 0, idleMs: 10 * MIN });
  assert.deepEqual(r.start, ['app-exec-e1']);
});

test('an idle listener parks after idleMs, not before; busy and warm ones never', () => {
  const state = {
    'app-exec-e1': { active: true, busy: false, idleSince: 0 },
    'app-exec-e2': { active: true, busy: true, idleSince: null },
    'dario-redline-e1': { active: true, busy: false, idleSince: 0 },
  };
  assert.deepEqual(plan(rows, state, [], { now: 9 * MIN, idleMs: 10 * MIN }).park, []);
  assert.deepEqual(plan(rows, state, [], { now: 10 * MIN, idleMs: 10 * MIN }).park, ['app-exec-e1', 'dario-redline-e1']);
  assert.deepEqual(plan(rows, state, [], { now: 10 * MIN, idleMs: 10 * MIN, warm: ['dario-redline-e1'] }).park, ['app-exec-e1']);
});

test('an idle listener a queued job will take is not parked', () => {
  const state = { 'app-exec-e1': { active: true, busy: false, idleSince: 0 } };
  const r = plan(rows, state, [job('askalf/app', 'app-exec')], { now: 60 * MIN, idleMs: 10 * MIN });
  assert.deepEqual(r, { start: [], park: [], room: [], held: 0, queue: [] });
});

test('a warm row found stopped is started, once, and not also given to a queued job', () => {
  const r = plan(rows, {}, [job('askalf/app', 'app-exec')], { now: 0, idleMs: 10 * MIN, warm: ['app-exec-e1'] });
  assert.deepEqual(r.start, ['app-exec-e1', 'app-exec-e2']);
});

test('a row whose repository could not be listed this tick is held, not parked', () => {
  const state = { 'app-exec-e1': { active: true, busy: false, idleSince: 0 }, 'dario-redline-e1': { active: true, busy: false, idleSince: 0 } };
  const r = plan(rows, state, [], { now: 60 * MIN, idleMs: 10 * MIN, hold: ['app-exec-e1'] });
  assert.deepEqual(r.park, ['dario-redline-e1']);
});

// The exec cap counts exec-tier rows across repositories; the redline row is read tier and never counts.
const CAPPED = managedRows(`
dario-exec-e1 repo:askalf/dario exec gha-exec /srv/gha/dario-exec-e1 self-hosted,Linux,X64,dario-exec ephemeral
dario-exec-e2 repo:askalf/dario exec gha-exec /srv/gha/dario-exec-e2 self-hosted,Linux,X64,dario-exec ephemeral
dario-exec-e3 repo:askalf/dario exec gha-exec /srv/gha/dario-exec-e3 self-hosted,Linux,X64,dario-exec ephemeral
cordon-exec-e1 repo:askalf/cordon exec gha-exec /srv/gha/cordon-exec-e1 self-hosted,Linux,X64,cordon-exec ephemeral
cordon-exec-e2 repo:askalf/cordon exec gha-exec /srv/gha/cordon-exec-e2 self-hosted,Linux,X64,cordon-exec ephemeral
dario-redline-e1 repo:askalf/dario read gha-redline /srv/gha/dario-redline-e1 self-hosted,Linux,X64,redline ephemeral
`);
const busy = { active: true, busy: true, idleSince: null };

test('no exec cap (0) starts a row for every queued job, as before', () => {
  const r = plan(CAPPED, {}, [job('askalf/dario', 'dario-exec'), job('askalf/dario', 'dario-exec'), job('askalf/cordon', 'cordon-exec')], { now: 0, idleMs: 10 * MIN });
  assert.deepEqual(r.start, ['dario-exec-e1', 'dario-exec-e2', 'cordon-exec-e1']);
  assert.equal(r.held, 0);
});

test('the exec cap stops starts at the cap, across repositories, and counts the jobs it holds', () => {
  const state = { 'dario-exec-e1': busy };
  const queued = [job('askalf/dario', 'dario-exec'), job('askalf/cordon', 'cordon-exec'), job('askalf/cordon', 'cordon-exec')];
  const r = plan(CAPPED, state, queued, { now: 0, idleMs: 10 * MIN, execCap: 2 });
  assert.deepEqual(r.start, ['dario-exec-e2']);
  assert.equal(r.held, 2);
});

test('read-tier rows neither count toward the exec cap nor wait on it', () => {
  const state = { 'dario-exec-e1': busy, 'dario-exec-e2': busy };
  const r = plan(CAPPED, state, [job('askalf/dario', 'redline')], { now: 0, idleMs: 10 * MIN, execCap: 2 });
  assert.deepEqual(r.start, ['dario-redline-e1']);
  assert.equal(r.held, 0);
});

test('an idle warm listener holds no slot until it takes a job', () => {
  const state = { 'dario-exec-e1': { active: true, busy: false, idleSince: 0 }, 'cordon-exec-e1': busy };
  // dario-exec-e1 is warm and idle: one slot is used of two, so cordon's second job starts a row.
  let r = plan(CAPPED, state, [job('askalf/cordon', 'cordon-exec')], { now: 0, idleMs: 10 * MIN, warm: ['dario-exec-e1'], execCap: 2 });
  assert.deepEqual(r.start, ['cordon-exec-e2']);
  // Once the warm listener takes dario's job, the slot is spent and cordon's job waits.
  r = plan(CAPPED, state, [job('askalf/dario', 'dario-exec'), job('askalf/cordon', 'cordon-exec')], { now: 0, idleMs: 10 * MIN, warm: ['dario-exec-e1'], execCap: 2 });
  assert.deepEqual(r.start, []);
  assert.equal(r.held, 1);
});

test('while jobs wait on the cap, a cold idle exec listener is parked to make room, longest idle first', () => {
  const state = {
    'dario-exec-e1': busy,
    'dario-exec-e2': { active: true, busy: false, idleSince: 3 * MIN },
    'dario-exec-e3': { active: true, busy: false, idleSince: 1 * MIN },
  };
  const r = plan(CAPPED, state, [job('askalf/cordon', 'cordon-exec')], { now: 5 * MIN, idleMs: 10 * MIN, execCap: 3 });
  assert.deepEqual(r.room, ['dario-exec-e3']);
  assert.deepEqual(r.park, ['dario-exec-e3']);
  assert.deepEqual(r.start, ['cordon-exec-e1']);
  assert.equal(r.held, 0);
});

test('a listener idle under pressureIdleMs, warm, or held is not parked for room, and the job waits', () => {
  const state = {
    'dario-exec-e1': { active: true, busy: false, idleSince: 0 },
    'dario-exec-e2': { active: true, busy: false, idleSince: 0 },
    'dario-exec-e3': { active: true, busy: false, idleSince: 4.75 * MIN },
  };
  const r = plan(CAPPED, state, [job('askalf/cordon', 'cordon-exec')], { now: 5 * MIN, idleMs: 10 * MIN, warm: ['dario-exec-e1'], hold: ['dario-exec-e2'], execCap: 2 });
  assert.deepEqual(r.room, []);
  assert.deepEqual(r.start, []);
  assert.equal(r.held, 1);
});

test('nothing is parked for room when the cap has room', () => {
  const state = { 'dario-exec-e2': { active: true, busy: false, idleSince: 0 } };
  const r = plan(CAPPED, state, [job('askalf/cordon', 'cordon-exec')], { now: 5 * MIN, idleMs: 10 * MIN, execCap: 3 });
  assert.deepEqual(r.room, []);
  assert.deepEqual(r.park, []);
  assert.deepEqual(r.start, ['cordon-exec-e1']);
});

// ── the pool: rows of no repository, registered at each start for the job they claim (docs/pools.md) ──
const POOLED = managedRows(`
ci-exec-e1 repo:askalf/ci exec gha-exec /srv/gha/ci-exec-e1 self-hosted,Linux,X64,ci-exec ephemeral
dario-exec-e1 repo:askalf/dario exec gha-exec /srv/gha/dario-exec-e1 self-hosted,Linux,X64,dario-exec ephemeral
pool-e1 pool:askalf exec gha-exec /srv/gha/pool-e1 self-hosted,Linux,X64,pool ephemeral
pool-e2 pool:askalf exec gha-exec /srv/gha/pool-e2 self-hosted,Linux,X64,pool ephemeral
`);
const ciJob = { id: 101, repo: 'askalf/ci', labels: ['self-hosted', 'Linux', 'X64', 'ci-exec'] };
const idlePool = (claimed) => ({ active: true, busy: false, idleSince: 0, claimed });

test('a pool row is managed with no repository, under the first-party template, and is never a fit by labels', () => {
  const p = POOLED.find((r) => r.name === 'pool-e1');
  assert.equal(p.repo, null);
  assert.equal(p.pool, 'askalf');
  assert.equal(p.unit, 'gha-ephemeral-first-party@pool-e1.service');
  const r = plan(POOLED, {}, [ciJob], { now: 0, idleMs: 10 * MIN });
  assert.deepEqual(r.start, ['ci-exec-e1']);
  assert.deepEqual(r.queue, []);
});

test('a job whose repository rows are all busy goes to the pool: an entry, and one stopped pool row started', () => {
  const r = plan(POOLED, { 'ci-exec-e1': busy }, [ciJob], { now: 0, idleMs: 10 * MIN });
  assert.deepEqual(r.start, ['pool-e1']);
  assert.deepEqual(r.queue, [ciJob]);
});

test('a stopped pool row whose unit systemd holds failed is the last pick, so one that will not start does not take every pool start', () => {
  const failed = { active: false, busy: false, idleSince: null, raw: 'failed' };
  let r = plan(POOLED, { 'ci-exec-e1': busy, 'pool-e1': failed }, [ciJob], { now: 0, idleMs: 10 * MIN });
  assert.deepEqual(r.start, ['pool-e2']);
  // With no other stopped pool row it is still tried: startUnit resets it, and a start that works ends the state.
  r = plan(POOLED, { 'ci-exec-e1': busy, 'pool-e1': failed, 'pool-e2': idlePool('askalf/dario') }, [ciJob], { now: 0, idleMs: 10 * MIN });
  assert.deepEqual(r.start, ['pool-e1']);
  assert.deepEqual(kickPlan(POOLED, { 'ci-exec-e1': busy, 'pool-e1': failed }, ciJob), { queue: true, start: 'pool-e2', take: 'pool-e2' });
  assert.deepEqual(kickPlan(POOLED, { 'ci-exec-e1': busy, 'pool-e1': failed, 'pool-e2': idlePool('askalf/dario') }, ciJob), { queue: true, start: 'pool-e1', take: 'pool-e1' });
});

test('a row the supervisor holds after a crash loop is never started: plan and kickPlan take the next one, warm or not', () => {
  const held = { active: false, busy: false, idleSince: null, raw: 'inactive', held: true };
  let r = plan(POOLED, { 'ci-exec-e1': busy, 'pool-e1': held }, [ciJob], { now: 0, idleMs: 10 * MIN });
  assert.deepEqual(r.start, ['pool-e2']);
  assert.deepEqual(kickPlan(POOLED, { 'ci-exec-e1': busy, 'pool-e1': held }, ciJob), { queue: true, start: 'pool-e2', take: 'pool-e2' });
  // Its repository's only row held: the job goes to the pool.
  r = plan(POOLED, { 'ci-exec-e1': held }, [ciJob], { now: 0, idleMs: 10 * MIN });
  assert.deepEqual([r.start, r.queue], [['pool-e1'], [ciJob]]);
  assert.deepEqual(kickPlan(POOLED, { 'ci-exec-e1': held }, ciJob), { queue: true, start: 'pool-e1', take: 'pool-e1' });
  // Every pool row held too: nothing starts.
  const all = Object.fromEntries(POOLED.map((x) => [x.name, held]));
  assert.deepEqual(plan(POOLED, all, [ciJob], { now: 0, idleMs: 10 * MIN }).start, []);
  assert.deepEqual(kickPlan(POOLED, all, ciJob), { queue: true, start: null, take: null });
  // A warm row held is not started.
  assert.deepEqual(plan(POOLED, { 'dario-exec-e1': held }, [], { now: 0, idleMs: 10 * MIN, warm: ['dario-exec-e1'] }).start, []);
  // stateDoc says so per row, apart from `hold` (a failed listing).
  const doc = stateDoc({ now: 0, mode: 'on', rows: POOLED, state: { 'pool-e1': held }, marks: [], queued: [], decided: { start: [], park: [], room: [], held: 0, queue: [] }, knobs: { warm: [] }, load: 0, github: null, events: [] });
  assert.deepEqual(doc.rows.filter((x) => x.held).map((x) => [x.name, x.hold]), [['pool-e1', false]]);
});

test('park marks: a repository row\'s goes once its unit runs again; a pool row\'s, and one of a unit not managed here, stay', () => {
  const u = (name) => `gha-ephemeral-first-party@${name}.service`;
  const marks = [u('ci-exec-e1'), u('dario-exec-e1'), u('pool-e1'), u('pool-e2'), u('pool-e9'), 'gha-ephemeral-redline@dario-redline-e1.service'];
  const state = {
    'ci-exec-e1': { active: true, busy: false, idleSince: 0, raw: 'active' },
    'dario-exec-e1': { active: false, busy: false, idleSince: null, raw: 'inactive' },
    'pool-e1': { active: true, busy: true, idleSince: null, raw: 'active' },
    'pool-e2': { active: true, busy: false, idleSince: null, raw: 'activating' },
  };
  assert.deepEqual(clearedMarks(marks, POOLED, state), [u('ci-exec-e1')]);
  assert.deepEqual(clearedMarks(marks, POOLED, { ...state, 'dario-exec-e1': { ...state['dario-exec-e1'], raw: 'activating' } }), [u('ci-exec-e1'), u('dario-exec-e1')]);
});

test('a burst takes the repository row first, then one pool row per job left over', () => {
  const jobs = [ciJob, { ...ciJob, id: 102 }, { ...ciJob, id: 103 }, { ...ciJob, id: 104 }];
  const r = plan(POOLED, {}, jobs, { now: 0, idleMs: 10 * MIN });
  assert.deepEqual(r.start, ['ci-exec-e1', 'pool-e1', 'pool-e2']);
  assert.deepEqual(r.queue.map((j) => j.id), [102, 103, 104]);
});

test('a running idle pool row claimed for the repository, or minting with no claim yet, takes the job; one claimed elsewhere does not', () => {
  let r = plan(POOLED, { 'ci-exec-e1': busy, 'pool-e1': idlePool('askalf/ci') }, [ciJob], { now: 0, idleMs: 10 * MIN });
  assert.deepEqual(r.start, []);
  assert.deepEqual(r.queue, [ciJob]);
  r = plan(POOLED, { 'ci-exec-e1': busy, 'pool-e1': idlePool(null) }, [ciJob], { now: 0, idleMs: 10 * MIN });
  assert.deepEqual(r.start, []);
  r = plan(POOLED, { 'ci-exec-e1': busy, 'pool-e1': idlePool('askalf/dario') }, [ciJob], { now: 0, idleMs: 10 * MIN });
  assert.deepEqual(r.start, ['pool-e2']);
});

test('no owner is built in: rows of any owner the manifest names are managed, and a pool serves its own owner\'s repositories only', () => {
  const two = managedRows(`
app-exec-e1 repo:example/app exec gha-exec /srv/gha/app-exec-e1 self-hosted,Linux,X64,app-exec ephemeral
ex-pool-e1 pool:example exec gha-exec /srv/gha/ex-pool-e1 self-hosted,Linux,X64,pool ephemeral
ci-exec-e1 repo:askalf/ci exec gha-exec /srv/gha/ci-exec-e1 self-hosted,Linux,X64,ci-exec ephemeral
al-pool-e1 pool:askalf exec gha-exec /srv/gha/al-pool-e1 self-hosted,Linux,X64,pool ephemeral
bad-1 repo:example exec gha-exec /srv/gha/bad-1 self-hosted,x ephemeral
bad-2 pool:example/app exec gha-exec /srv/gha/bad-2 self-hosted,x ephemeral
`);
  assert.deepEqual(two.map((r) => [r.name, r.repo, r.pool]), [
    ['app-exec-e1', 'example/app', null],
    ['ex-pool-e1', null, 'example'],
    ['ci-exec-e1', 'askalf/ci', null],
    ['al-pool-e1', null, 'askalf'],
  ], 'a scope of neither shape (repo: with no repository, pool: with one) is still skipped');
  const appJob = { id: 201, repo: 'example/app', labels: ['self-hosted', 'Linux', 'X64', 'app-exec'] };
  assert.deepEqual(plan(two, {}, [appJob], { now: 0, idleMs: 10 * MIN }).start, ['app-exec-e1']);
  // Its repository's row busy: the job goes to its own owner's pool, never to another owner's.
  let r = plan(two, { 'app-exec-e1': busy }, [appJob], { now: 0, idleMs: 10 * MIN });
  assert.deepEqual([r.start, r.queue], [['ex-pool-e1'], [appJob]]);
  r = plan(two, { 'ci-exec-e1': busy }, [ciJob], { now: 0, idleMs: 10 * MIN });
  assert.deepEqual([r.start, r.queue], [['al-pool-e1'], [ciJob]]);
  r = plan(two, { 'app-exec-e1': busy, 'ex-pool-e1': busy }, [appJob], { now: 0, idleMs: 10 * MIN });
  assert.deepEqual(r.start, [], 'its own pool busy: the other owner\'s idle pool row is not started for it');
  // An owner whose name another owner's starts with is not that owner.
  const near = { id: 202, repo: 'example-two/app', labels: ['self-hosted', 'Linux', 'X64', 'app-exec'] };
  assert.deepEqual(plan(two, {}, [near], { now: 0, idleMs: 10 * MIN }), { start: [], park: [], room: [], held: 0, queue: [] });
});

test('an App-only host: no token file is no token, and the App\'s token serves every owner it is installed on', async () => {
  const d = mkdtempSync(join(tmpdir(), 'token-file-'));
  assert.equal(fileToken(join(d, 'absent.env')), '', 'a missing file is no token, not a failed tick');
  writeFileSync(join(d, 'a.env'), 'OTHER=1\nGITHUB_TOKEN="ghp_fake"\n');
  assert.equal(fileToken(join(d, 'a.env')), 'ghp_fake');
  writeFileSync(join(d, 'b.env'), '# empty\n');
  assert.equal(fileToken(join(d, 'b.env')), '');
  assert.throws(() => fileToken(d), 'a path that is there but not readable as a file is still an error');
  const app = async (owner) => (owner === 'your-org' ? 'ghs_app' : '');
  const toks = await tokensByOwner(['your-org/your-repo', 'other/x'], fileToken(join(d, 'absent.env')), app);
  assert.deepEqual(toks.get('your-org'), { tok: 'ghs_app', source: 'app' });
  assert.deepEqual(toks.get('other'), { tok: '', source: 'GITHUB_TOKEN' }, 'an owner with neither has an empty token, which the tick names');
});

test('the shipped examples are managed as they stand: their owners are stand-ins, and nothing in them needs editing for the dispatcher', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.deepEqual(managedRows(read('./examples/minimal/runners.manifest')).map((r) => [r.name, r.repo]), [['app-exec-e1', 'your-org/your-repo']]);
  const full = read('./examples/runners.manifest');
  assert.deepEqual(managedRows(full).map((r) => [r.name, r.repo ?? `pool:${r.pool}`]), [
    ['app-exec-e1', 'example/app'],
    ['app-exec-e2', 'example/app'],
    ['pool-e1', 'pool:example'],
    ['pool-e2', 'pool:example'],
    ['app-redline-e1', 'example/app'],
    ['app-build-e1', 'example/app'],
  ]);
  assert.deepEqual(watchedRows(full).map((r) => r.name), ['oss-1', 'oss-read-1']);
});

test('a job of a repository the pool does not serve is not queued for it', () => {
  const r = plan(POOLED, {}, [{ id: 7, repo: 'other/x', labels: ['self-hosted', 'x'] }], { now: 0, idleMs: 10 * MIN });
  assert.deepEqual(r, { start: [], park: [], room: [], held: 0, queue: [] });
});

test('the pool takes only what a plain exec row of the repository covers: not a label no row has, not the fix lane\'s jobs, not a build row\'s', () => {
  const rows = managedRows(`
ci-exec-e1 repo:askalf/ci exec gha-exec /srv/gha/ci-exec-e1 self-hosted,Linux,X64,ci-exec ephemeral
ci-fix-e1 repo:askalf/ci exec gha-exec /srv/gha/ci-fix-e1 self-hosted,Linux,X64,ci-fix ephemeral
ci-build-e1 repo:askalf/ci build root /srv/gha/ci-build-e1 self-hosted,Linux,X64,ci-build ephemeral
pool-e1 pool:askalf exec gha-exec /srv/gha/pool-e1 self-hosted,Linux,X64,pool ephemeral
`);
  const allBusy = { 'ci-exec-e1': busy, 'ci-fix-e1': busy, 'ci-build-e1': busy };
  const one = (labels) => plan(rows, allBusy, [{ id: 9, repo: 'askalf/ci', labels }], { now: 0, idleMs: 10 * MIN });
  assert.deepEqual(one(['self-hosted', 'ci-exec']).start, ['pool-e1']);
  assert.deepEqual(one(['self-hosted', 'gpu']), { start: [], park: [], room: [], held: 0, queue: [] });
  assert.deepEqual(one(['self-hosted', 'ci-fix']), { start: [], park: [], room: [], held: 0, queue: [] });
  assert.deepEqual(one(['self-hosted', 'ci-build']), { start: [], park: [], room: [], held: 0, queue: [] });
  assert.deepEqual(kickPlan(rows, allBusy, { id: 9, repo: 'askalf/ci', labels: ['self-hosted', 'ci-fix'] }), { queue: false, start: null, take: null });
});

test('the review lane stays on its own rows: its job waits for the review row, never the pool', () => {
  const rows = managedRows(`
app-exec-e1 repo:askalf/app exec gha-exec /srv/gha/app-exec-e1 self-hosted,Linux,X64,app-exec ephemeral
app-review-e1 repo:askalf/app exec gha-exec /srv/gha/app-review-e1 self-hosted,Linux,X64,app-review ephemeral
pool-e1 pool:askalf exec gha-exec /srv/gha/pool-e1 self-hosted,Linux,X64,pool ephemeral
`);
  const allBusy = { 'app-exec-e1': busy, 'app-review-e1': busy };
  const one = (labels) => plan(rows, allBusy, [{ id: 9, repo: 'askalf/app', labels }], { now: 0, idleMs: 10 * MIN });
  assert.deepEqual(one(['self-hosted', 'app-exec']).start, ['pool-e1'], 'the repository\'s plain jobs still reach the pool');
  assert.deepEqual(one(['self-hosted', 'app-review']), { start: [], park: [], room: [], held: 0, queue: [] });
  assert.deepEqual(kickPlan(rows, allBusy, { id: 9, repo: 'askalf/app', labels: ['self-hosted', 'app-review'] }), { queue: false, start: null, take: null });
  assert.deepEqual(plan(rows, {}, [{ id: 9, repo: 'askalf/app', labels: ['self-hosted', 'app-review'] }], { now: 0, idleMs: 10 * MIN }).start, ['app-review-e1']);
});

test('pool starts count against the exec cap and are held like any other; held jobs keep their entries', () => {
  const r = plan(POOLED, { 'ci-exec-e1': busy, 'dario-exec-e1': busy }, [ciJob, { ...ciJob, id: 102 }], { now: 0, idleMs: 10 * MIN, execCap: 3 });
  assert.deepEqual(r.start, ['pool-e1']);
  assert.equal(r.held, 1);
  assert.equal(r.queue.length, 2);
});

test('an idle pool row parks after poolIdleMs, long before idleMs, and is never warm', () => {
  const state = { 'pool-e1': idlePool('askalf/ci'), 'ci-exec-e1': { active: true, busy: false, idleSince: 0 } };
  assert.deepEqual(plan(POOLED, state, [], { now: 44000, idleMs: 10 * MIN }).park, []);
  assert.deepEqual(plan(POOLED, state, [], { now: 45000, idleMs: 10 * MIN }).park, ['pool-e1']);
});

test('kickPlan: an idle row of the repository takes the job; else the job is queued and one pool row starts, under the cap', () => {
  assert.deepEqual(kickPlan(POOLED, { 'ci-exec-e1': { active: true, busy: false } }, ciJob), { queue: false, start: null, take: 'ci-exec-e1' });
  assert.deepEqual(kickPlan(POOLED, { 'ci-exec-e1': busy }, ciJob), { queue: true, start: 'pool-e1', take: 'pool-e1' });
  assert.deepEqual(kickPlan(POOLED, { 'ci-exec-e1': busy, 'pool-e1': idlePool('askalf/ci') }, ciJob), { queue: true, start: null, take: 'pool-e1' });
  assert.deepEqual(kickPlan(POOLED, { 'ci-exec-e1': busy, 'pool-e1': idlePool(null) }, ciJob), { queue: true, start: null, take: 'pool-e1' });
  assert.deepEqual(kickPlan(POOLED, { 'ci-exec-e1': busy, 'pool-e1': idlePool('askalf/dario') }, ciJob), { queue: true, start: 'pool-e2', take: 'pool-e2' });
  assert.deepEqual(kickPlan(POOLED, { 'ci-exec-e1': busy }, ciJob, { execCap: 1, load: 1 }), { queue: true, start: null, take: null });
  assert.deepEqual(kickPlan(POOLED, {}, { id: 7, repo: 'other/x', labels: ['self-hosted'] }), { queue: false, start: null, take: null });
});

test('kickPlan: a stopped row of the repository is started at the kick, before the pool, and held at the exec cap', () => {
  assert.deepEqual(kickPlan(CAPPED, { 'dario-exec-e1': busy }, job('askalf/dario', 'dario-exec')), { queue: false, start: 'dario-exec-e2', take: 'dario-exec-e2' });
  assert.deepEqual(kickPlan(CAPPED, { 'dario-exec-e1': busy }, job('askalf/dario', 'dario-exec'), { execCap: 2, load: 2 }), { queue: false, start: null, take: null });
  // The cap is the exec tier's: a read-tier row starts at the cap.
  assert.deepEqual(kickPlan(CAPPED, {}, job('askalf/dario', 'redline'), { execCap: 1, load: 1 }), { queue: false, start: 'dario-redline-e1', take: 'dario-redline-e1' });
  // A stopped row whose unit is held failed is the last pick, and still tried when it is the only one.
  const failed = { active: false, busy: false, idleSince: null, raw: 'failed' };
  assert.equal(kickPlan(CAPPED, { 'dario-exec-e1': busy, 'dario-exec-e2': failed }, job('askalf/dario', 'dario-exec')).start, 'dario-exec-e3');
  assert.equal(kickPlan(CAPPED, { 'dario-exec-e1': busy, 'dario-exec-e2': failed, 'dario-exec-e3': busy }, job('askalf/dario', 'dario-exec')).start, 'dario-exec-e2');
});

test('a burst of kicks: each job takes its own row, so none waits the listing (eight jobs of one repository, two started per tick otherwise)', () => {
  const rows = managedRows(`
dario-exec-e1 repo:askalf/dario exec gha-exec /srv/gha/dario-exec-e1 self-hosted,Linux,X64,dario-exec ephemeral
dario-exec-e2 repo:askalf/dario exec gha-exec /srv/gha/dario-exec-e2 self-hosted,Linux,X64,dario-exec ephemeral
dario-exec-e3 repo:askalf/dario exec gha-exec /srv/gha/dario-exec-e3 self-hosted,Linux,X64,dario-exec ephemeral
pool-e1 pool:askalf exec gha-exec /srv/gha/pool-e1 self-hosted,Linux,X64,pool ephemeral
pool-e2 pool:askalf exec gha-exec /srv/gha/pool-e2 self-hosted,Linux,X64,pool ephemeral
`);
  // The last tick's view: e1 warm and idle, e2 idle, the rest stopped.
  let state = { 'dario-exec-e1': { active: true, busy: false, idleSince: 0 }, 'dario-exec-e2': { active: true, busy: false, idleSince: 0 } };
  const taken = [];
  const started = [];
  for (let id = 1; id <= 6; id += 1) {
    const j = { id, repo: 'askalf/dario', labels: ['self-hosted', 'dario-exec'] };
    const fast = kickPlan(rows, state, j);
    taken.push(fast.take);
    if (fast.start) started.push(fast.start);
    state = promised(state, fast, j.repo);
  }
  assert.deepEqual(taken, ['dario-exec-e1', 'dario-exec-e2', 'dario-exec-e3', 'pool-e1', 'pool-e2', null]);
  assert.deepEqual(started, ['dario-exec-e3', 'pool-e1', 'pool-e2']);
  assert.equal(state['pool-e1'].claimed, 'askalf/dario');
  assert.equal(state['dario-exec-e3'].claimed, undefined);
});

test('promised: the row a kick took reads running and busy until the next view; no take leaves the view as it was', () => {
  const state = { 'ci-exec-e1': { active: true, busy: false, idleSince: 5 } };
  assert.deepEqual(promised(state, { queue: false, start: null, take: 'ci-exec-e1' }, 'askalf/ci'), { 'ci-exec-e1': { active: true, busy: true, idleSince: null } });
  assert.deepEqual(promised(state, { queue: true, start: 'pool-e1', take: 'pool-e1' }, 'askalf/ci')['pool-e1'], { active: true, busy: true, idleSince: null, claimed: 'askalf/ci' });
  assert.equal(promised(state, { queue: true, start: null, take: null }, 'askalf/ci'), state);
  assert.equal(state['ci-exec-e1'].busy, false);
});

test('POOL_MAX: limitPool keeps the first pool rows in manifest order; 0 turns the pool off, null keeps them all', () => {
  assert.deepEqual(limitPool(POOLED, 1).map((r) => r.name), ['ci-exec-e1', 'dario-exec-e1', 'pool-e1']);
  assert.deepEqual(limitPool(POOLED, null).map((r) => r.name), POOLED.map((r) => r.name));
  const off = limitPool(POOLED, 0);
  assert.deepEqual(plan(off, { 'ci-exec-e1': busy }, [ciJob], { now: 0, idleMs: 10 * MIN }), { start: [], park: [], room: [], held: 0, queue: [] });
  assert.deepEqual(kickPlan(off, { 'ci-exec-e1': busy }, ciJob), { queue: false, start: null, take: null });
});

test('syncQueue writes one entry per routed job by id, keeps them while routed, leaves claim files alone, and ages the rest out after 15 s', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pool-queue-'));
  syncQueue(dir, [ciJob, { ...ciJob, id: 102 }, { id: 0, repo: 'askalf/ci', labels: [] }], Date.now());
  assert.deepEqual(readdirSync(dir).sort(), ['101', '102']);
  assert.equal(readFileSync(join(dir, '101'), 'utf8'), 'repo:askalf/ci self-hosted,Linux,X64,ci-exec\n');
  writeFileSync(join(dir, '.pool-e1'), 'repo:askalf/ci self-hosted,Linux,X64,ci-exec\n');
  syncQueue(dir, [ciJob], Date.now());
  assert.deepEqual(readdirSync(dir).sort(), ['.pool-e1', '101', '102']);
  syncQueue(dir, [ciJob], Date.now() + 16000);
  assert.deepEqual(readdirSync(dir).sort(), ['.pool-e1', '101']);
  assert.equal(claimOf(dir, 'pool-e1'), 'askalf/ci');
  assert.equal(claimOf(dir, 'pool-e2'), null);
});

const found = (repo) => ({ queued: [job(repo, 'x')], taken: [`${repo}-busy`] });

test('one repository failing leaves the others listed', async () => {
  const r = await collectJobs(['askalf/a', 'askalf/b', 'askalf/c'], async (repo) => {
    if (repo === 'askalf/b') throw new Error('GitHub 404 on repos/askalf/b/actions/runs');
    return found(repo);
  }, { concurrency: 2 });
  assert.deepEqual(r.queued.map((j) => j.repo).sort(), ['askalf/a', 'askalf/c']);
  assert.deepEqual([...r.taken].sort(), ['askalf/a-busy', 'askalf/c-busy']);
  assert.deepEqual([...r.failed.keys()], ['askalf/b']);
  assert.equal(r.floor, null);
});

test('the rate floor stops asking the repositories not yet asked', async () => {
  const asked = [];
  const r = await collectJobs(['askalf/a', 'askalf/b', 'askalf/c', 'askalf/d'], async (repo) => {
    asked.push(repo);
    if (repo === 'askalf/a') throw new RateFloorError('GitHub rate limit at 10 left (floor 1500); this tick stops asking');
    return found(repo);
  }, { concurrency: 1 });
  assert.deepEqual(asked, ['askalf/a']);
  assert.deepEqual([...r.failed.keys()], ['askalf/a', 'askalf/b', 'askalf/c', 'askalf/d']);
  assert.ok(r.floor instanceof RateFloorError);
});

test('no more than `concurrency` repositories are listed at once', async () => {
  let open = 0;
  let peak = 0;
  await collectJobs(['a', 'b', 'c', 'd', 'e', 'f'].map((x) => `askalf/${x}`), async (repo) => {
    open += 1;
    peak = Math.max(peak, open);
    await new Promise((r) => setTimeout(r, 5));
    open -= 1;
    return found(repo);
  }, { concurrency: 4 });
  assert.equal(peak, 4);
});

/** A fake fetch: answers by method and path, and records each call. */
function fakeGitHub(answers) {
  const calls = [];
  const http = async (url, opts) => {
    const path = url.replace('https://api.github.com/', '');
    calls.push({ method: opts.method, path, auth: opts.headers.Authorization });
    const a = answers[`${opts.method} ${path.split('?')[0]}`];
    if (a instanceof Error) throw a;
    if (!a) throw new Error(`unexpected ${opts.method} ${path}`);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
  };
  return { http, calls };
}
const LIST = 'GET repos/askalf/ci/actions/runners';

test('an idle registration is removed before the stop', async () => {
  const gh = fakeGitHub({ [LIST]: { status: 200, body: { runners: [{ id: 7, name: 'pool-e1', busy: false }] } }, 'DELETE repos/askalf/ci/actions/runners/7': { status: 204 } });
  assert.deepEqual(await releaseRegistration('askalf/ci', 'pool-e1', 'tk', { http: gh.http }), { outcome: 'released', id: 7 });
  assert.deepEqual(gh.calls.map((c) => c.method), ['GET', 'DELETE']);
  assert.equal(gh.calls[0].path, 'repos/askalf/ci/actions/runners?name=pool-e1&per_page=100');
  assert.equal(gh.calls[1].path, 'repos/askalf/ci/actions/runners/7');
  assert.ok(gh.calls.every((c) => c.auth === 'Bearer tk'));
});

test('a registration GitHub lists busy is kept, and nothing is removed', async () => {
  const gh = fakeGitHub({ [LIST]: { status: 200, body: { runners: [{ id: 7, name: 'pool-e1', busy: true }] } } });
  assert.deepEqual(await releaseRegistration('askalf/ci', 'pool-e1', 'tk', { http: gh.http }), { outcome: 'busy', id: 7 });
  assert.deepEqual(gh.calls.map((c) => c.method), ['GET']);
});

test('a job assigned between the listing and the removal (HTTP 422) keeps the row', async () => {
  const gh = fakeGitHub({ [LIST]: { status: 200, body: { runners: [{ id: 7, name: 'pool-e1', busy: false }] } }, 'DELETE repos/askalf/ci/actions/runners/7': { status: 422 } });
  assert.deepEqual(await releaseRegistration('askalf/ci', 'pool-e1', 'tk', { http: gh.http }), { outcome: 'busy', id: 7 });
});

test('a registration already gone is gone: not listed, or removed by the runner first (HTTP 404)', async () => {
  const none = fakeGitHub({ [LIST]: { status: 200, body: { runners: [] } } });
  assert.deepEqual(await releaseRegistration('askalf/ci', 'pool-e1', 'tk', { http: none.http }), { outcome: 'gone' });
  const raced = fakeGitHub({ [LIST]: { status: 200, body: { runners: [{ id: 7, name: 'pool-e1', busy: false }] } }, 'DELETE repos/askalf/ci/actions/runners/7': { status: 404 } });
  assert.deepEqual(await releaseRegistration('askalf/ci', 'pool-e1', 'tk', { http: raced.http }), { outcome: 'gone', id: 7 });
});

test('only the exact name is removed: pool-e1 is never pool-e10', async () => {
  const gh = fakeGitHub({ [LIST]: { status: 200, body: { runners: [{ id: 10, name: 'pool-e10', busy: false }] } } });
  assert.deepEqual(await releaseRegistration('askalf/ci', 'pool-e1', 'tk', { http: gh.http }), { outcome: 'gone' });
  assert.deepEqual(gh.calls.map((c) => c.method), ['GET']);
});

test('a failed listing, a refused removal or a network error is an error, never a removal claimed', async () => {
  const list = fakeGitHub({ [LIST]: { status: 403, body: {} } });
  const a = await releaseRegistration('askalf/ci', 'pool-e1', 'tk', { http: list.http });
  assert.equal(a.outcome, 'error');
  assert.match(a.why, /GitHub 403 listing the runners of askalf\/ci/);
  const del = fakeGitHub({ [LIST]: { status: 200, body: { runners: [{ id: 7, name: 'pool-e1', busy: false }] } }, 'DELETE repos/askalf/ci/actions/runners/7': { status: 403 } });
  assert.deepEqual(await releaseRegistration('askalf/ci', 'pool-e1', 'tk', { http: del.http }), { outcome: 'error', id: 7, why: 'GitHub 403 removing runner 7 from askalf/ci' });
  const net = fakeGitHub({ [LIST]: new Error('fetch failed') });
  assert.deepEqual(await releaseRegistration('askalf/ci', 'pool-e1', 'tk', { http: net.http }), { outcome: 'error', why: 'fetch failed' });
});

test('where a row is registered: its repository, or a pool row the repository it claimed; else none', () => {
  assert.equal(registeredIn({ name: 'ci-exec-e1', repo: 'askalf/ci' }, {}), 'askalf/ci');
  assert.equal(registeredIn({ name: 'pool-e1', pool: 'first-party' }, { 'pool-e1': { claimed: 'askalf/dario' } }), 'askalf/dario');
  assert.equal(registeredIn({ name: 'pool-e2', pool: 'first-party' }, { 'pool-e2': { claimed: null } }), null);
  assert.equal(registeredIn({ name: 'pool-e3', pool: 'first-party' }, {}), null);
  assert.equal(registeredIn({ name: 'pool-e4', pool: 'first-party' }, { 'pool-e4': { claimed: '../etc/passwd' } }), null);
  assert.equal(registeredIn({ name: 'pool-e5', pool: 'first-party' }, { 'pool-e5': { claimed: 'askalf/ci/actions' } }), null);
});

test('an App token is minted per permission set: the release token never stands in for the listing one', async () => {
  const asked = [];
  const run = async (_bin, args) => { asked.push(args.join(' ')); return `tok:${args.slice(1).join(',')}`; };
  const owner = `memo-test-${Date.now()}`;
  assert.equal(await appToken(owner, { run }), 'tok:-,actions=read');
  assert.equal(await appToken(owner, { run, ask: ['ci', 'administration=write'] }), 'tok:ci,administration=write');
  assert.equal(await appToken(owner, { run }), 'tok:-,actions=read', 'the listing token from the memo');
  assert.equal(await appToken(owner, { run, ask: ['ci', 'administration=write'] }), 'tok:ci,administration=write', 'the release token from the memo');
  assert.deepEqual(asked, [`${owner} - actions=read`, `${owner} ci administration=write`]);
});
