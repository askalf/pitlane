// node --test runners/pitlane-supervisor-heal.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DISPATCHER_UNIT, HEAL, planHeals } from './pitlane-supervisor-heal.mjs';
import { joinRegistrations } from './pitlane-supervisor-detect.mjs';

const row = (name, over = {}) => ({ name, unit: `gha-ephemeral-first-party@${name}.service`, active: 'inactive', parked: false, held: false, workerMs: null, ...over });
const down = (name) => ({ class: 'down', severity: 'warn', row: name, msg: `gha-ephemeral-first-party@${name}.service is inactive for 300s` });
const NOW = Date.parse('2026-10-19T20:00:00Z');
const stale = (name) => ({ class: 'stale-registration', severity: 'warn', row: name, msg: `${name} offline on GitHub for 45 min` });
const offline = (name, over = {}) => row(name, { repo: 'askalf/x', regId: 100, regBusy: false, offlineMs: 45 * 60000, ...over });

test('observe mode plans nothing and every finding stands', () => {
  const started = {};
  const r = planHeals({ findings: [down('a')], rows: [row('a')], started, now: NOW, mode: 'observe' });
  assert.deepEqual(r.heals, []);
  assert.equal(r.findings.length, 1);
  assert.deepEqual(started, {});
});

test('heal mode: the first sighting of a down row is a start, not a finding', () => {
  const started = {};
  const r = planHeals({ findings: [down('a')], rows: [row('a')], started, now: NOW, mode: 'heal' });
  assert.deepEqual(r.heals, [{ class: 'down', row: 'a', unit: 'gha-ephemeral-first-party@a.service', why: down('a').msg }]);
  assert.deepEqual(r.findings, []);
});

test('still down inside the hour after a start: the finding stands, annotated, and nothing is started again', () => {
  const started = { 'gha-ephemeral-first-party@a.service': NOW - 10 * 60000 };
  const r = planHeals({ findings: [down('a')], rows: [row('a')], started, now: NOW, mode: 'heal' });
  assert.deepEqual(r.heals, []);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].msg, /started again 10m ago and still not serving$/);
});

test('past the hour it is started again rather than reported forever', () => {
  const started = { 'gha-ephemeral-first-party@a.service': NOW - HEAL.renagMs - 1 };
  const r = planHeals({ findings: [down('a')], rows: [row('a')], started, now: NOW, mode: 'heal' });
  assert.equal(r.heals.length, 1);
  assert.deepEqual(r.findings, []);
});

test('a row serving again leaves the start record and is named as cleared, in any mode', () => {
  const started = { 'gha-ephemeral-first-party@a.service': NOW - 60000 };
  const r = planHeals({ findings: [], rows: [row('a', { active: 'active' })], started, now: NOW, mode: 'observe' });
  assert.deepEqual(r.cleared, ['gha-ephemeral-first-party@a.service']);
  assert.deepEqual(started, {});
});

test('a start record for a row no longer in the manifest is dropped too', () => {
  const started = { 'gha-ephemeral-first-party@gone.service': NOW - 60000 };
  const r = planHeals({ findings: [], rows: [row('a')], started, now: NOW, mode: 'heal' });
  assert.deepEqual(r.cleared, ['gha-ephemeral-first-party@gone.service']);
});

test('other classes, and a down row that is busy, parked or held, are never healed', () => {
  const other = { class: 'version-drift', severity: 'warn', row: 'b', msg: 'b has runner 2.329.0, pin is 2.330.0' };
  const rows = [row('b'), row('c', { workerMs: 5000 }), row('d', { parked: true }), row('e', { held: true })];
  const r = planHeals({ findings: [other, down('c'), down('d'), down('e')], rows, started: {}, now: NOW, mode: 'heal' });
  assert.deepEqual(r.heals, []);
  assert.equal(r.findings.length, 4);
});

test('at most maxPerTick starts in one tick; the rest stand as findings for the next', () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const r = planHeals({ findings: names.map(down), rows: names.map((n) => row(n)), started: {}, now: NOW, mode: 'heal' });
  assert.equal(r.heals.length, HEAL.maxPerTick);
  assert.equal(r.findings.length, names.length - HEAL.maxPerTick);
});

test('heal mode: a stale registration that nothing holds is deleted, named by its id and scope', () => {
  const r = planHeals({ findings: [stale('a')], rows: [offline('a')], started: {}, deregistered: {}, now: NOW, mode: 'heal' });
  assert.deepEqual(r.heals, [{ class: 'stale-registration', row: 'a', unit: 'gha-ephemeral-first-party@a.service', repo: 'askalf/x', id: 100, why: stale('a').msg }]);
  assert.deepEqual(r.findings, []);
});

test('observe mode deletes nothing', () => {
  const r = planHeals({ findings: [stale('a')], rows: [offline('a')], started: {}, deregistered: {}, now: NOW, mode: 'observe' });
  assert.deepEqual(r.heals, []);
  assert.equal(r.findings.length, 1);
});

test('a registration GitHub counts busy, with no id, on an active unit, or on a parked, held or working row stands', () => {
  const rows = [offline('b', { regBusy: true }), offline('c', { regId: null }), offline('d', { active: 'active' }), offline('e', { parked: true }), offline('f', { held: true }), offline('g', { workerMs: 1000 })];
  const r = planHeals({ findings: rows.map((x) => stale(x.name)), rows, started: {}, deregistered: {}, now: NOW, mode: 'heal' });
  assert.deepEqual(r.heals, []);
  assert.equal(r.findings.length, 6);
});

test('inside the hour after a delete the same registration stands, annotated; past the hour it is deleted again', () => {
  const deregistered = { a: { at: NOW - 10 * 60000, id: 100 } };
  let r = planHeals({ findings: [stale('a')], rows: [offline('a')], started: {}, deregistered, now: NOW, mode: 'heal' });
  assert.deepEqual(r.heals, []);
  assert.match(r.findings[0].msg, /deleted 10m ago and is still listed$/);
  r = planHeals({ findings: [stale('a')], rows: [offline('a')], started: {}, deregistered: { a: { at: NOW - HEAL.renagMs - 1, id: 100 } }, now: NOW, mode: 'heal' });
  assert.equal(r.heals.length, 1);
});

test('a new registration id of the same name starts clean: the old delete record is dropped', () => {
  const deregistered = { a: { at: NOW - 60000, id: 100 }, gone: { at: NOW - 60000, id: 7 } };
  const r = planHeals({ findings: [stale('a')], rows: [offline('a', { regId: 101 })], started: {}, deregistered, now: NOW, mode: 'heal' });
  assert.deepEqual(deregistered, {});
  assert.equal(r.heals.length, 1);
  assert.equal(r.heals[0].id, 101);
});

test('a pool row\'s leftover in another repository is deleted there whatever the row does now; its own registration waits like any row\'s', () => {
  const pool = row('pool-e1', { repo: 'pool:askalf', pool: 'askalf', active: 'active', regId: 9, regRepo: 'askalf/ci', regBusy: true, staleRegs: [{ repo: 'askalf/dario', id: 4 }] });
  const left = { class: 'stale-registration', severity: 'warn', row: 'pool-e1', repo: 'askalf/dario', id: 4, msg: 'pool-e1 has a registration left in askalf/dario (id 4) from an earlier claim' };
  const own = { class: 'stale-registration', severity: 'warn', row: 'pool-e1', repo: 'askalf/ci', id: 9, msg: 'pool-e1 offline on GitHub for 45 min in askalf/ci' };
  const deregistered = {};
  let r = planHeals({ findings: [left, own], rows: [pool], started: {}, deregistered, now: NOW, mode: 'heal' });
  assert.deepEqual(r.heals, [{ class: 'stale-registration', row: 'pool-e1', unit: pool.unit, repo: 'askalf/dario', id: 4, key: 'pool-e1@askalf/dario', why: left.msg }]);
  assert.equal(r.findings.length, 1);
  // Recorded under row@repository: inside the hour it stands, annotated; the record goes once the id is no longer listed.
  deregistered['pool-e1@askalf/dario'] = { at: NOW, id: 4 };
  r = planHeals({ findings: [left], rows: [pool], started: {}, deregistered, now: NOW + 60000, mode: 'heal' });
  assert.deepEqual(r.heals, []);
  assert.match(r.findings[0].msg, /deleted 1m ago and is still listed$/);
  planHeals({ findings: [], rows: [{ ...pool, staleRegs: [] }], started: {}, deregistered, now: NOW + 120000, mode: 'heal' });
  assert.deepEqual(deregistered, {});
});

test('a parked pool row\'s own offline registration is deleted (its next start may register elsewhere), where a parked repository row\'s stands', () => {
  const own = { class: 'stale-registration', severity: 'warn', row: 'pool-e1', repo: 'askalf/ci', id: 9, msg: 'pool-e1 offline on GitHub for 45 min in askalf/ci' };
  const parked = row('pool-e1', { repo: 'pool:askalf', pool: 'askalf', parked: true, regId: 9, regRepo: 'askalf/ci', regBusy: false, offlineMs: 45 * 60000, staleRegs: [] });
  const r = planHeals({ findings: [own, stale('e')], rows: [parked, offline('e', { parked: true })], started: {}, deregistered: {}, now: NOW, mode: 'heal' });
  assert.deepEqual(r.heals, [{ class: 'stale-registration', row: 'pool-e1', unit: parked.unit, repo: 'askalf/ci', id: 9, why: own.msg }]);
  assert.equal(r.findings.length, 1);
});

test('the shared cap counts starts and deletes together', () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  const rows = [...names.slice(0, 3).map((n) => row(n)), ...names.slice(3).map((n) => offline(n))];
  const findings = [...names.slice(0, 3).map(down), ...names.slice(3).map(stale)];
  const r = planHeals({ findings, rows, started: {}, deregistered: {}, now: NOW, mode: 'heal' });
  assert.equal(r.heals.length, HEAL.maxPerTick);
  assert.equal(r.findings.length, 1);
});

test('joinRegistrations puts the registration id and busy flag on the row, and clears them when the scope was not read', () => {
  const rows = [{ name: 'a', repo: 'askalf/x' }, { name: 'b', repo: 'askalf/x' }, { name: 'c', repo: 'askalf/y' }];
  const gh = { 'askalf/x': { ok: true, runners: [{ id: 5, name: 'a', status: 'offline', busy: false }, { id: 6, name: 'b', status: 'online', busy: true }] }, 'askalf/y': { ok: false, runners: [] } };
  joinRegistrations(rows, gh, {}, NOW);
  assert.deepEqual(rows.map((r) => [r.regId, r.regBusy]), [[5, false], [6, true], [null, false]]);
});

const unclaimed = (name) => ({ class: 'unclaimed-queue', severity: 'warn', row: name, msg: `${name} is online and idle on GitHub but has not claimed queued job 9 in askalf/x for 5 min`, job: 9 });
const idle = (name, over = {}) => row(name, { repo: 'askalf/x', active: 'active', regOnline: true, regBusy: false, ...over });

test('unclaimed queue: heal mode restarts the row once, and inside the hour the finding stands, annotated', () => {
  const recycled = {};
  let r = planHeals({ findings: [unclaimed('a')], rows: [idle('a')], started: {}, recycled, now: NOW, mode: 'heal' });
  assert.deepEqual(r.heals, [{ class: 'unclaimed-queue', row: 'a', unit: 'gha-ephemeral-first-party@a.service', why: unclaimed('a').msg }]);
  assert.deepEqual(r.findings, []);
  recycled['gha-ephemeral-first-party@a.service'] = NOW;
  r = planHeals({ findings: [unclaimed('a')], rows: [idle('a')], started: {}, recycled, now: NOW + 7 * 60000, mode: 'heal' });
  assert.deepEqual(r.heals, []);
  assert.match(r.findings[0].msg, /restarted 7m ago and still not claiming$/);
  // Past the hour the record goes and the row is restarted again.
  r = planHeals({ findings: [unclaimed('a')], rows: [idle('a')], started: {}, recycled, now: NOW + HEAL.renagMs, mode: 'heal' });
  assert.equal(r.heals.length, 1);
  assert.deepEqual(recycled, {});
});

test('unclaimed queue: never a row with a job, a busy registration, a parked, held or pool row, or one not running; observe plans nothing', () => {
  for (const o of [{ workerMs: 1000 }, { regBusy: true }, { parked: true }, { held: true }, { pool: 'askalf' }, { active: 'activating' }]) {
    const r = planHeals({ findings: [unclaimed('a')], rows: [idle('a', o)], started: {}, recycled: {}, now: NOW, mode: 'heal' });
    assert.deepEqual(r.heals, [], JSON.stringify(o));
    assert.equal(r.findings.length, 1);
  }
  const r = planHeals({ findings: [unclaimed('a')], rows: [idle('a')], started: {}, recycled: {}, now: NOW, mode: 'observe' });
  assert.deepEqual(r.heals, []);
  assert.equal(r.findings.length, 1);
});

const crash = (name, over = {}) => ({ class: 'crash-loop', severity: 'crit', row: name, msg: `gha-ephemeral-first-party@${name}.service: exit status 226`, failures: 1, status: 226, ...over });

test('crash loop: a status that names the fault, or holdFailures failed exits, is held; the finding stands either way', () => {
  const rows = [row('a', { active: 'activating' }), row('b', { active: 'activating' }), row('c', { active: 'activating' })];
  const findings = [crash('a'), crash('b', { msg: 'x: 10 failed exits in 5 min', failures: HEAL.holdFailures, status: null }), crash('c', { msg: 'x: 9 failed exits in 5 min', failures: HEAL.holdFailures - 1, status: null })];
  const r = planHeals({ findings, rows, started: {}, now: NOW, mode: 'heal' });
  assert.deepEqual(r.heals.map((h) => [h.class, h.row, h.unit]), [['crash-loop', 'a', 'gha-ephemeral-first-party@a.service'], ['crash-loop', 'b', 'gha-ephemeral-first-party@b.service']]);
  assert.deepEqual(r.findings, findings, 'every crash loop is reported, held or not');
});

test('crash loop: never a row with a worker, or one already held; observe mode plans nothing', () => {
  const rows = [row('a', { workerMs: 5000 }), row('b', { held: true, heldAt: NOW - 60000 })];
  assert.deepEqual(planHeals({ findings: [crash('a'), crash('b')], rows, started: {}, now: NOW, mode: 'heal' }).heals, []);
  const o = planHeals({ findings: [crash('c')], rows: [row('c')], started: {}, now: NOW, mode: 'observe' });
  assert.deepEqual([o.heals, o.release, o.findings.length], [[], [], 1]);
});

test('a held row is released once holdMs has passed, heal mode only; a mark with no time is never released here', () => {
  const at = NOW - HEAL.holdMs + 60000;
  const held = (heldAt) => [row('a', { held: true, heldAt })];
  let r = planHeals({ findings: [crash('a')], rows: held(at), started: {}, now: NOW, mode: 'heal' });
  assert.deepEqual(r.release, []);
  assert.match(r.findings[0].msg, /the hold lapses at 20:01Z$/);
  r = planHeals({ findings: [crash('a')], rows: held(at), started: {}, now: NOW + 60000, mode: 'heal' });
  assert.deepEqual(r.release, ['gha-ephemeral-first-party@a.service']);
  assert.match(r.findings[0].msg, /the hold lapsed and is lifted$/);
  assert.deepEqual(planHeals({ findings: [crash('a')], rows: held(at), started: {}, now: NOW + 60000, mode: 'observe' }).release, []);
  r = planHeals({ findings: [crash('a')], rows: held(null), started: {}, now: NOW + 9e9, mode: 'heal' });
  assert.deepEqual([r.release, r.findings[0].msg], [[], crash('a').msg]);
});

const stopped = (cause) => ({ class: 'dispatcher-stopped', severity: 'crit', msg: 'gha-ondemand.service is not running', cause });

test('dispatcher stopped: restarted when systemd holds it failed or its beat is stale, never after a pause or between systemd\'s own restarts', () => {
  for (const cause of ['failed', 'stale-beat']) {
    const r = planHeals({ findings: [stopped(cause)], rows: [], started: {}, now: NOW, mode: 'heal' });
    assert.deepEqual(r.heals.map((h) => [h.class, h.unit]), [['dispatcher-stopped', DISPATCHER_UNIT]], cause);
    assert.equal(r.findings.length, 1, 'the finding stands beside the heal');
  }
  for (const cause of ['paused', 'stopped', 'late-beat', undefined]) {
    assert.deepEqual(planHeals({ findings: [stopped(cause)], rows: [], started: {}, now: NOW, mode: 'heal' }).heals, [], String(cause));
  }
  assert.deepEqual(planHeals({ findings: [stopped('failed')], rows: [], started: {}, now: NOW, mode: 'observe' }).heals, []);
});

test('dispatcher stopped: once per dispatcherRenagMs; inside it the finding stands, annotated', () => {
  const restarted = { [DISPATCHER_UNIT]: NOW - 10 * 60000 };
  let r = planHeals({ findings: [stopped('failed')], rows: [], started: {}, restarted, now: NOW, mode: 'heal' });
  assert.deepEqual(r.heals, []);
  assert.match(r.findings[0].msg, /restarted at 19:50Z and not back$/);
  r = planHeals({ findings: [stopped('failed')], rows: [], started: {}, restarted, now: NOW - 10 * 60000 + HEAL.dispatcherRenagMs, mode: 'heal' });
  assert.equal(r.heals.length, 1);
  assert.deepEqual(restarted, {}, 'the record is dropped once it is that old');
});
