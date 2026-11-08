// node --test runners/pitlane-supervisor.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostNumbers, journalLine, metricsText, parseHeldMark, parseIsolated, parsePinned, parseRowPinned, parseShow, parseStat, pauseMs, failuresByUnit, supervisedRows } from './pitlane-supervisor.mjs';
import { hostRowNames, ofHost } from './pitlane-waits.mjs';

test('ticks start a cadence apart whatever the tick took; a tick past the cadence gets a short breath, not the next tick at once', () => {
  assert.equal(pauseMs(0, 60), 60000);
  assert.equal(pauseMs(2500, 60), 57500);
  assert.equal(pauseMs(60000, 60), 5000);
  assert.equal(pauseMs(95000, 60), 5000);
});

test('the pin is the first field of the last non-comment line', () => {
  assert.equal(parsePinned('# c\n# more\n2.337.0 70920811a4f8\n'), '2.337.0');
  assert.equal(parsePinned('# only comments\n'), null);
});

test('a row .pinned file reads as its version', () => {
  assert.equal(parseRowPinned('2.337.0 link\n'), '2.337.0');
  assert.equal(parseRowPinned(''), null);
  assert.equal(parseRowPinned('garbage'), null);
});

test('systemctl show of a crash loop reads as 226 exit-code, activating', () => {
  const out = 'ActiveState=activating\nSubState=auto-restart\nResult=exit-code\nExecMainStatus=226\nNRestarts=41\nUnitFileState=enabled\nInactiveEnterTimestamp=Thu 2026-10-15 15:10:00 UTC\nControlGroup=\n';
  const p = parseShow(out, Date.parse('2026-10-15T15:12:00Z'));
  assert.deepEqual([p.active, p.result, p.execStatus, p.nrestarts, p.enabled], ['activating', 'exit-code', 226, 41, true]);
  assert.equal(p.inactiveMs, 0);
});

test('an inactive unit carries how long it has been inactive; a disabled one is not enabled', () => {
  const out = 'ActiveState=inactive\nSubState=dead\nResult=success\nExecMainStatus=0\nNRestarts=0\nUnitFileState=disabled\nInactiveEnterTimestamp=Thu 2026-10-15 15:10:00 UTC\n';
  const p = parseShow(out, Date.parse('2026-10-15T15:15:00Z'));
  assert.equal(p.inactiveMs, 5 * 60000);
  assert.equal(p.enabled, false);
});

test('only failed exits are counted: a row that finishes a job and restarts is not a crash loop', () => {
  const text = [
    'gha-ephemeral-first-party@dario-exec-e1.service: Deactivated successfully.',
    'gha-ephemeral-first-party@dario-exec-e1.service: Scheduled restart job, restart counter is at 29.',
    'gha-ephemeral-first-party@dario-exec-e2.service: Failed with result \'exit-code\'.',
    'gha-ephemeral-first-party@dario-exec-e2.service: Failed with result \'exit-code\'.',
    'dario-health-watch.service: Deactivated successfully.',
  ].join('\n');
  assert.deepEqual(failuresByUnit(text), { 'gha-ephemeral-first-party@dario-exec-e2.service': 2 });
  assert.deepEqual(failuresByUnit(''), {});
});

test('metrics text counts findings by class', () => {
  const t = metricsText({ at: 5000, rows: 54, ghCalls: 14, findings: [{ class: 'down' }, { class: 'down' }, { class: 'crash-loop' }] });
  assert.match(t, /pitlane_rows 54\n/);
  assert.match(t, /pitlane_findings\{class="down"\} 2\n/);
  assert.match(t, /pitlane_findings\{class="crash-loop"\} 1\n/);
  assert.match(t, /pitlane_tick_timestamp_seconds 5\n/);
  assert.doesNotMatch(t, /pitlane_tick_seconds/, 'a status without a tick time reports none, not zero');
  assert.match(metricsText({ at: 5000, tookMs: 2340, rows: 1, ghCalls: 0, findings: [] }), /pitlane_tick_seconds 2\.3\n/);
});

test('metrics text carries the queue-wait summary per window and repo', () => {
  const st = { n: 4, p50: 2000, p90: 9000, max: 12000 };
  const t = metricsText({ at: 5000, rows: 1, ghCalls: 0, findings: [], waits: { lastHour: { all: st, repos: { 'askalf/ci': st } }, last24h: { all: { n: 0, p50: null, p90: null, max: null }, repos: {} } } });
  assert.match(t, /pitlane_queue_wait_p90_ms\{window="lastHour",repo="all"\} 9000\n/);
  assert.match(t, /pitlane_queue_wait_jobs\{window="lastHour",repo="askalf\/ci"\} 4\n/);
  assert.match(t, /pitlane_queue_wait_jobs{window="last24h",repo="all"} 0/);
  assert.doesNotMatch(t, /p50_ms{window="last24h"/);
});

test('metrics text carries the job outcomes per window', () => {
  const o = { n: 5, classes: { success: 4, 'setup-failed': 1 }, suspect: { n: 1, rate: 0.2, runners: { r: 1 } }, runMs: { n: 5, p50: 20000, p90: 90000 }, waitMs: { n: 5, p50: 1000, p90: 4000 } };
  const t = metricsText({ at: 5000, rows: 1, ghCalls: 0, findings: [], outcomes: { lastHour: o } });
  assert.match(t, /pitlane_jobs\{window="lastHour",class="success"\} 4\n/);
  assert.match(t, /pitlane_runner_suspect_jobs\{window="lastHour"\} 1\n/);
  assert.match(t, /pitlane_job_run_p90_ms\{window="lastHour"\} 90000\n/);
});

test('the isolated list ignores comments and blanks; stat output reads as group and mode', () => {
  assert.deepEqual([...parseIsolated('# header\n\npitlane-exec-e1  # first\n  other\n').keys()], ['pitlane-exec-e1', 'other']);
  assert.deepEqual([...parseIsolated('a groups=none  # no key file\nb\n').keys()], ['a', 'b']);
  assert.deepEqual([...parseIsolated(undefined)], []);
  assert.deepEqual([...parseIsolated('a groups=none\nacme-marketing-site-redline-e1 account=gx-acme-site-redline-e1 groups=gha-redline  # 33 as gx-<row>\n')],
    [['a', 'gx-a'], ['acme-marketing-site-redline-e1', 'gx-acme-site-redline-e1']]);
  assert.deepEqual(parseStat('gx-a 1770\n'), { group: 'gx-a', mode: 0o1770 });
  assert.equal(parseStat('garbage'), null);
  assert.equal(parseShow('User=gx-a\nActiveState=active\n').user, 'gx-a');
});

test('the supervisor watches the rows of any owner the manifest names: no owner is built in', () => {
  const m = [
    'app-exec-e1 repo:example/app exec gha-exec /srv/gha/app-exec-e1 app-exec ephemeral',
    'pool-e1     pool:example     exec gha-exec /srv/gha/pool-e1     pool     ephemeral',
    'minimal-e1  repo:your-org/your-repo exec gha-exec /srv/gha/minimal-e1 app-exec ephemeral',
  ].join('\n');
  assert.deepEqual(supervisedRows(m).map((r) => [r.name, r.repo, r.pool]), [
    ['app-exec-e1', 'example/app', null],
    ['pool-e1', 'pool:example', 'example'],
    ['minimal-e1', 'your-org/your-repo', null],
  ]);
});

test('the supervised rows are every ephemeral row, org pool included, never an adopt row', () => {
  const m = [
    '# name scope tier user dir labels mode',
    'dario-exec-e2  repo:askalf/dario   exec gha-exec     /srv/gha/dario-exec-e2 dario-exec ephemeral',
    'oss-read-1     org:sprayberry-code read gha-oss-read /srv/gha/oss-read-1    oss-read   ephemeral',
    'legacy-runner-1 repo:askalf/legacy exec gha-exec /opt/actions-runner-legacy legacy adopt',
  ].join('\n');
  assert.deepEqual(supervisedRows(m).map((r) => [r.name, r.repo, r.unit]), [
    ['dario-exec-e2', 'askalf/dario', 'gha-ephemeral-first-party@dario-exec-e2.service'],
    ['oss-read-1', 'org:sprayberry-code', 'gha-ephemeral-read@oss-read-1.service'],
  ]);
});

test('the metrics carry the heal counter', () => {
  const t = metricsText({ at: 5000, rows: 1, ghCalls: 0, findings: [], healsTotal: 3 });
  assert.match(t, /^pitlane_heals_total 3$/m);
});

test('a held mark: the heal\'s gives its time and why; one written by hand has no time, so it never lapses by itself', () => {
  assert.deepEqual(parseHeldMark('2026-10-29T20:00:00.000Z\nexit status 226; last journal line: x\n'), { at: Date.parse('2026-10-29T20:00:00Z'), why: 'exit status 226; last journal line: x' });
  assert.deepEqual(parseHeldMark(''), { at: null, why: '' });
  assert.deepEqual(parseHeldMark('waiting on a disk fix\n'), { at: null, why: 'waiting on a disk fix' });
  assert.deepEqual(parseHeldMark('2026-13-99T00:00:00Z\nx\n'), { at: null, why: '2026-13-99T00:00:00Z' });
});

test('the journal line a hold carries: the unit\'s own last word over systemd\'s chatter, one line, tokens masked, bounded', () => {
  const u = 'gha-ephemeral-first-party@pool-e1.service';
  const text = [
    `Starting ${u} - GitHub runner...`,
    'mint: registration token refused: 422 Unprocessable Entity',
    `${u}: Main process exited, code=exited, status=1/FAILURE`,
    `${u}: Failed with result 'exit-code'.`,
    `${u}: Scheduled restart job, restart counter is at 61.`,
    `Stopped ${u} - GitHub runner.`,
    `${u}: Start request repeated too quickly.`,
  ].join('\n');
  assert.equal(journalLine(text), 'mint: registration token refused: 422 Unprocessable Entity');
  assert.equal(journalLine(`${u}: Main process exited, code=exited, status=226/NAMESPACE\n`), `${u}: Main process exited, code=exited, status=226/NAMESPACE`, 'only chatter: the last line');
  assert.equal(journalLine(''), '');
  assert.equal(journalLine('auth with ghs_abcDEF123456789 failed'), 'auth with ghs_*** failed');
  assert.equal(journalLine('Authorization: Bearer abcdefgh.ijkl-mnop'), 'Authorization: Bearer ***');
  assert.equal(journalLine('tab\there\u001b[31m'), 'tab here [31m');
  const long = journalLine('x'.repeat(500));
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('...'));
});

// ---- the published numbers count this host's rows only (docs/method.md) -------------------------

const HOST_MANIFEST = [
  '# rows of this host',
  'app-exec-e1  repo:example/app  exec  gha-exec  /srv/gha/app-exec-e1  self-hosted,Linux,X64,app-exec  ephemeral',
  'pool-e1      pool:example      exec  gha-exec  /srv/gha/pool-e1      self-hosted,Linux,X64,pool      ephemeral',
  'old-root     repo:example/app  build root      /srv/gha/old-root     self-hosted,Linux,X64,app-build adopt',
  '',
].join('\n');

test('hostRowNames: every row the manifest lists, pool and persistent rows included; comments and blanks skipped', () => {
  assert.deepEqual([...hostRowNames(HOST_MANIFEST)].sort(), ['app-exec-e1', 'old-root', 'pool-e1']);
  assert.deepEqual([...hostRowNames('')], []);
  assert.deepEqual([...hostRowNames(undefined)], []);
});

test('ofHost: keeps entries a host row took; drops another pool runner and a job no runner took', () => {
  const rows = hostRowNames(HOST_MANIFEST);
  const kept = ofHost([{ runner: 'pool-e1' }, { runner: 'GitHub Actions 1000' }, { runner: '' }, {}, { runner: 'app-exec-e1' }], rows);
  assert.deepEqual(kept.map((e) => e.runner), ['pool-e1', 'app-exec-e1']);
});

test('ofHost: a runner field that is not text names no host row, and does not throw', () => {
  const rows = hostRowNames(HOST_MANIFEST);
  const kept = ofHost([{ runner: { toString: 1 } }, { runner: ['pool-e1'] }, { runner: null }, null, { runner: 'pool-e1' }], rows);
  assert.deepEqual(kept.map((e) => e.runner), ['pool-e1']);
});

test('hostNumbers: a job another self-hosted pool took is in none of the published start, run, queued-to-done or suspect numbers', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  const rows = hostRowNames(HOST_MANIFEST);
  const at = now - 10 * 60000;
  const waits = [
    { at, repo: 'example/app', runner: 'app-exec-e1', waitMs: 2000 },
    { at, repo: 'example/app', runner: 'pool-e1', waitMs: 4000 },
    // Another self-hosted pool serving the same repository: a long wait and a suspect failure.
    { at, repo: 'example/app', runner: 'elsewhere-runner-7', waitMs: 600000 },
  ];
  const outcomes = [
    { id: 1, at, repo: 'example/app', runner: 'app-exec-e1', conclusion: 'success', class: 'success', waitMs: 2000, runMs: 10000 },
    { id: 2, at, repo: 'example/app', runner: 'pool-e1', conclusion: 'success', class: 'success', waitMs: 4000, runMs: 20000 },
    { id: 3, at, repo: 'example/app', runner: 'elsewhere-runner-7', conclusion: 'failure', class: 'runner-lost-suspect', waitMs: 600000, runMs: 900000 },
    { id: 4, at, repo: 'example/app', runner: '', conclusion: 'cancelled', class: 'cancelled-queued', waitMs: null, runMs: null },
  ];
  const { published, waits24, outcomes: o } = hostNumbers(waits, outcomes, rows, now);
  assert.equal(published.jobs, 2, 'started: the two host rows only');
  assert.deepEqual(published.queueWaitMs, { p50: 2000, p90: 4000 });
  assert.equal(published.finished, 2, 'finished: the two host rows only');
  assert.equal(published.ran, 2);
  assert.deepEqual(published.runMs, { p50: 10000, p90: 20000 });
  assert.deepEqual(published.feltMs, { p50: 12000, p90: 24000 });
  assert.equal(published.runnerSuspect, 0, "the other pool's runner-lost job is not this host's");
  assert.equal(published.lastHour.jobs, 2);
  assert.equal(published.hours.reduce((n, h) => n + h.jobs, 0), 2);
  assert.equal(waits24.all.n, 2);
  assert.equal(o.last24h.n, 2);
  // Every field the page, the badge and the profile board read is still there.
  for (const k of ['at', 'window', 'jobs', 'queueWaitMs', 'targets', 'finished', 'runnerSuspect', 'ran', 'runMs', 'feltMs', 'lastHour', 'hours']) assert.ok(k in published, k);
  // The same job on a host row counts.
  const mine = hostNumbers(waits, [...outcomes, { id: 5, at, repo: 'example/app', runner: 'pool-e1', conclusion: 'failure', class: 'runner-lost-suspect', waitMs: 3000, runMs: 5000 }], rows, now);
  assert.equal(mine.published.runnerSuspect, 1);
  assert.equal(mine.published.finished, 3);
});
