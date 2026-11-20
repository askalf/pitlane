// node --test runners/pitlane-outcomes.test.mjs
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { KEEP_DAYS, SUSPECT_CLASSES, classifyJob, jobOutcome, oomRowsFromKernel, oomWindow, readOutcomes, recordOutcome, summarizeOutcomes, withOomKill } from './pitlane-outcomes.mjs';

const step = (name, conclusion) => ({ name, conclusion });
const job = (o = {}) => ({
  id: 7, labels: ['self-hosted', 'Linux'], runner_name: 'dario-exec-e1', conclusion: 'success',
  created_at: '2026-10-15T19:00:00Z', started_at: '2026-10-15T19:00:03Z', completed_at: '2026-10-15T19:01:03Z',
  steps: [step('Set up job', 'success'), step('Run tests', 'success')], ...o,
});
const body = (j = job(), action = 'completed') => JSON.stringify({ action, repository: { full_name: 'askalf/dario' }, workflow_job: j });

test('each conclusion lands in its class', () => {
  assert.equal(classifyJob(job()), 'success');
  assert.equal(classifyJob(job({ conclusion: 'skipped' })), 'skipped');
  assert.equal(classifyJob(job({ conclusion: 'cancelled' })), 'cancelled');
  assert.equal(classifyJob(job({ conclusion: 'cancelled', runner_name: null })), 'cancelled-queued');
  assert.equal(classifyJob(job({ conclusion: 'timed_out' })), 'timed-out');
  assert.equal(classifyJob(job({ conclusion: 'neutral' })), 'other');
});

test('a failed job is the workflow\'s unless the runner could not start it or no step failed', () => {
  assert.equal(classifyJob(job({ conclusion: 'failure', steps: [step('Set up job', 'success'), step('Run tests', 'failure')] })), 'job-failed');
  assert.equal(classifyJob(job({ conclusion: 'failure', steps: [step('Set up job', 'failure')] })), 'setup-failed');
  assert.equal(classifyJob(job({ conclusion: 'failure', steps: [step('Set up job', 'success'), step('Run tests', 'cancelled')] })), 'runner-lost-suspect');
  assert.equal(classifyJob(job({ conclusion: 'failure', steps: [] })), 'runner-lost-suspect');
  assert.equal(classifyJob(job({ conclusion: 'failure', steps: undefined })), 'runner-lost-suspect');
});

test('jobOutcome: a finished self-hosted job gives its class, wait and run time', () => {
  const e = jobOutcome('workflow_job', body());
  assert.deepEqual([e.id, e.repo, e.runner, e.class, e.waitMs, e.runMs], [7, 'askalf/dario', 'dario-exec-e1', 'success', 3000, 60000]);
  assert.equal(e.at, Date.parse('2026-10-15T19:01:03Z'));
  assert.equal('bad' in e, false);
});

test('jobOutcome: a suspect job keeps the names of its non-success steps, capped', () => {
  const steps = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => step(n, 'cancelled'));
  const e = jobOutcome('workflow_job', body(job({ conclusion: 'failure', steps })));
  assert.equal(e.class, 'runner-lost-suspect');
  assert.deepEqual(e.bad, ['a:cancelled', 'b:cancelled', 'c:cancelled', 'd:cancelled']);
  assert.equal('bad' in jobOutcome('workflow_job', body(job({ conclusion: 'failure', steps: [step('Run tests', 'failure')] }))), false);
});

test('jobOutcome: a job nobody took has no wait or run time', () => {
  const e = jobOutcome('workflow_job', body(job({ conclusion: 'cancelled', runner_name: '', started_at: '2026-10-15T19:00:00Z' })));
  assert.deepEqual([e.class, e.waitMs, e.runMs], ['cancelled-queued', null, null]);
});

test('jobOutcome: other deliveries, hosted jobs and bad data give nothing', () => {
  assert.equal(jobOutcome('workflow_job', body(job(), 'in_progress')), null);
  assert.equal(jobOutcome('workflow_job', body(job({ labels: ['ubuntu-latest'] }))), null);
  assert.equal(jobOutcome('push', body()), null);
  assert.equal(jobOutcome('workflow_job', 'not json'), null);
  assert.equal(jobOutcome('workflow_job', body(job({ completed_at: null }))), null);
  assert.equal(jobOutcome('workflow_job', body(job({ id: undefined }))), null);
});

test('records land in a file per UTC day and read back inside the window, once per job', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pitlane-outcomes-'));
  const now = Date.parse('2026-10-16T01:00:00Z');
  const mk = (id, iso, o = {}) => ({ id, at: Date.parse(iso), repo: 'askalf/dario', runner: 'r', conclusion: 'success', class: 'success', waitMs: 1000, runMs: 5000, ...o });
  recordOutcome(dir, mk(1, '2026-10-15T23:30:00Z'), now);
  recordOutcome(dir, mk(2, '2026-10-16T00:30:00Z'), now);
  recordOutcome(dir, mk(2, '2026-10-16T00:30:00Z'), now);
  appendFileSync(join(dir, 'outcomes-2026-10-16.jsonl'), '{"half');
  assert.ok(existsSync(join(dir, 'outcomes-2026-10-15.jsonl')) && existsSync(join(dir, 'outcomes-2026-10-16.jsonl')));
  const all = readOutcomes(dir, Date.parse('2026-10-15T00:00:00Z'), now);
  assert.deepEqual(all.map((e) => e.id), [1, 2]);
  assert.deepEqual(readOutcomes(dir, Date.parse('2026-10-16T00:00:00Z'), now).map((e) => e.id), [2]);
  assert.deepEqual(readOutcomes(join(dir, 'missing'), 0, now), []);
});

test('files older than the retention are dropped on the first write of a day', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pitlane-outcomes-'));
  writeFileSync(join(dir, 'outcomes-2026-08-01.jsonl'), '');
  writeFileSync(join(dir, 'outcomes-2026-10-01.jsonl'), '');
  writeFileSync(join(dir, 'notes.txt'), '');
  const now = Date.parse('2026-12-31T00:00:00Z');
  recordOutcome(dir, { id: 9, at: now, repo: 'askalf/dario', runner: 'r', conclusion: 'success', class: 'success', waitMs: null, runMs: null }, now);
  assert.equal(existsSync(join(dir, 'outcomes-2026-08-01.jsonl')), false);
  assert.equal(existsSync(join(dir, 'outcomes-2026-10-01.jsonl')), false, `older than ${KEEP_DAYS} days`);
  assert.equal(existsSync(join(dir, 'notes.txt')), true);
});

test('summary: classes, the runner-suspect share by runner, and percentiles', () => {
  const now = 1e12;
  const e = (id, cls, runner, o = {}) => ({ id, at: now - 1000 * id, repo: 'askalf/dario', runner, class: cls, waitMs: 1000 * id, runMs: 10000 * id, ...o });
  const entries = [e(1, 'success', 'a'), e(2, 'success', 'a'), e(3, 'job-failed', 'b'), e(4, 'setup-failed', 'b'), e(5, 'runner-lost-suspect', 'c'), e(6, 'success', 'a', { at: now - 7200000 })];
  const hour = summarizeOutcomes(entries, now, 3600000);
  assert.equal(hour.n, 5);
  assert.deepEqual(hour.classes, { success: 2, 'job-failed': 1, 'setup-failed': 1, 'runner-lost-suspect': 1 });
  assert.deepEqual(hour.suspect, { n: 2, rate: 0.4, runners: { b: 1, c: 1 } });
  assert.deepEqual([hour.waitMs.p50, hour.waitMs.p90, hour.runMs.p50], [3000, 5000, 30000]);
  assert.equal(summarizeOutcomes(entries, now, 86400000).n, 6);
  assert.deepEqual(summarizeOutcomes([], now, 3600000).suspect, { n: 0, rate: null, runners: {} });
});

test('summary: felt time is each job\'s wait plus its run, only for jobs with both, inside the window', () => {
  const now = 1e12;
  const e = (id, waitMs, runMs, at = now - 1000 * id) => ({ id, at, repo: 'askalf/dario', runner: 'r', class: 'success', waitMs, runMs });
  // waits 1, 2, 3 s and runs 10, 20, 30 s: felt 11, 22, 33 s. A job without a wait, one without a run, and one
  // outside the hour do not count.
  const entries = [e(1, 1000, 10000), e(2, 2000, 20000), e(3, 3000, 30000), e(4, null, 40000), e(5, 5000, null), e(6, 6000, 60000, now - 7200000)];
  const hour = summarizeOutcomes(entries, now, 3600000);
  assert.deepEqual(hour.feltMs, { n: 3, p50: 22000, p90: 33000 });
  assert.equal(hour.runMs.n, 4, 'run counts every job with a run, wait or not');
  assert.deepEqual(summarizeOutcomes([], now, 3600000).feltMs, { n: 0, p50: null, p90: null });
});

test('the outcomes are root\'s alone: the directory 0700, each file 0600, a file from before the change tightened at its next line', { skip: process.platform === 'win32' }, () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'pitlane-outcomes-')), 'pitlane');
  const now = Date.parse('2026-10-16T01:00:00Z');
  const e = (id, iso) => ({ id, at: Date.parse(iso), repo: 'askalf/dario', runner: 'r', conclusion: 'success', class: 'success', waitMs: 1, runMs: 1 });
  recordOutcome(dir, e(1, '2026-10-16T00:30:00Z'), now);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'outcomes-2026-10-16.jsonl')).mode & 0o777, 0o600);
  const old = join(dir, 'outcomes-2026-10-15.jsonl');
  writeFileSync(old, '');
  chmodSync(old, 0o644);
  recordOutcome(dir, e(2, '2026-10-15T23:30:00Z'), now);
  assert.equal(statSync(old).mode & 0o777, 0o600);
  assert.deepEqual(readOutcomes(dir, 0, now).map((x) => x.id), [2, 1]);
});

test('oomRowsFromKernel: the rows of the units the kernel OOM-killed, from journalctl -k -o cat', () => {
  const log = [
    '.NET TP Worker invoked oom-killer: gfp_mask=0x100cca(GFP_HIGHUSER_MOVABLE), order=0, oom_score_adj=0',
    'oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=gha.slice,mems_allowed=0,oom_memcg=/gha.slice/gha-exec.slice,task_memcg=/gha.slice/gha-exec.slice/gha-ephemeral-first-party@pool-e2.service,task=MainThread,pid=49701,uid=944',
    'Memory cgroup out of memory: Killed process 49701 (MainThread) total-vm:53195928kB, anon-rss:860680kB',
    'oom-kill:constraint=CONSTRAINT_MEMCG,task_memcg=/gha.slice/gha-exec.slice/gha-ephemeral-first-party@platform-exec-e1.service,task=MainThread',
    'some other kernel line naming oom_memcg=/gha.slice only',
  ].join('\n');
  assert.deepEqual([...oomRowsFromKernel(log)].sort(), ['platform-exec-e1', 'pool-e2']);
  assert.equal(oomRowsFromKernel('').size, 0);
  assert.equal(oomRowsFromKernel(undefined).size, 0);
  assert.equal(oomRowsFromKernel('task_memcg=/system.slice/docker.service,task=x').size, 0, 'a unit with no row name is not a row');
});

test('withOomKill: a lost-runner job whose row the kernel OOM-killed is oom-killed, which is not a suspect class', () => {
  const lost = { id: 1, at: 2, repo: 'o/r', runner: 'pool-e2', class: 'runner-lost-suspect', bad: ['Build:cancelled'] };
  const killed = new Set(['pool-e2']);
  assert.deepEqual(withOomKill(lost, killed), { ...lost, class: 'oom-killed' });
  assert.equal(withOomKill(lost, new Set(['pool-e3'])), lost, 'another row killed: unchanged');
  assert.equal(withOomKill(lost, new Set()), lost);
  assert.equal(withOomKill(lost, null), lost, 'no kernel read: unchanged');
  assert.equal(withOomKill({ ...lost, class: 'job-failed' }, killed).class, 'job-failed', 'only a lost-runner job is reclassed');
  assert.equal(withOomKill({ ...lost, runner: '' }, killed).class, 'runner-lost-suspect');
  assert.equal(SUSPECT_CLASSES.includes('oom-killed'), false);
  const sum = summarizeOutcomes([{ ...lost, class: 'oom-killed' }, { ...lost, id: 3 }], 10, 3600000);
  assert.equal(sum.classes['oom-killed'], 1);
  assert.equal(sum.suspect.n, 1, 'the oom-killed job is not counted against the runners');
});

test('oomWindow: the span the job was certainly running, one second after its whole-second start to its completion', () => {
  const at = Date.parse('2026-11-20T17:08:27Z');
  assert.deepEqual(oomWindow({ at, runMs: 122000 }), [at - 122000 + 1000, at]);
  assert.equal(new Date(oomWindow({ at, runMs: 122000 })[0]).toISOString(), '2026-11-20T17:06:26.000Z', 'the start second itself is not counted');
  assert.equal(oomWindow({ at, runMs: 500 }), null, 'a run under a second has no span');
  assert.deepEqual(oomWindow({ at, runMs: 1000 }), [at, at]);
  assert.equal(oomWindow({ at, runMs: null }), null, 'no start: no read, so an earlier job\'s kill on the row cannot match');
  assert.equal(oomWindow({ at, runMs: undefined }), null);
  assert.equal(oomWindow({ at, runMs: -5 }), null);
  assert.equal(oomWindow({ at: Number.NaN, runMs: 1000 }), null);
  assert.equal(oomWindow(null), null);
});

test('oomRowsFromKernel with a window: a kill counts only by its own timestamp inside the span', () => {
  // A job GitHub reports as started 17:06:25 and completed 17:08:27 (UTC): the span is 17:06:26 to 17:08:27.
  const at = Date.parse('2026-11-20T17:08:27Z');
  const w = oomWindow({ at, runMs: 122000 });
  const kill = (iso) => `${(Date.parse(iso) / 1000).toFixed(6)} host kernel: oom-kill:constraint=CONSTRAINT_MEMCG,task_memcg=/gha.slice/gha-exec.slice/gha-ephemeral-first-party@pool-e2.service,task=MainThread`;
  const rows = (iso) => oomRowsFromKernel(kill(iso), w);
  assert.equal(rows('2026-11-20T17:06:25.100Z').size, 0, 'inside the start second: maybe before the job started, not counted');
  assert.equal(rows('2026-11-20T17:06:25.999Z').size, 0);
  assert.deepEqual([...rows('2026-11-20T17:06:26.000Z')], ['pool-e2'], 'from one second after the start');
  assert.deepEqual([...rows('2026-11-20T17:08:03.978Z')], ['pool-e2'], 'the kill of 2026-11-20, inside the run');
  assert.deepEqual([...rows('2026-11-20T17:08:27.000Z')], ['pool-e2'], 'at the completion second');
  assert.equal(rows('2026-11-20T17:08:27.001Z').size, 0, 'after the completion: not counted');
  assert.equal(rows('2026-11-20T17:08:29.000Z').size, 0);
  assert.equal(oomRowsFromKernel('oom-kill:task_memcg=/gha.slice/gha-exec.slice/gha-ephemeral-first-party@pool-e2.service', w).size, 0, 'a line without a timestamp does not count');
  // The host's own line shape for the 17:08:03Z kill (short-unix).
  assert.deepEqual([...oomRowsFromKernel('1795194483.978635 host kernel: oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=gha.slice,mems_allowed=0,oom_memcg=/gha.slice/gha-exec.slice,task_memcg=/gha.slice/gha-exec.slice/gha-ephemeral-first-party@pool-e2.service,task=MainThread', [1795194480000, 1795194507000])], ['pool-e2']);
});
