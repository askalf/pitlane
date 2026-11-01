// node --test runners/pitlane-job-summary.test.mjs
// The job-completed hook in bash against a temp pitlane directory and step summary file.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGG = 'p50 2 s, p90 16 s across 1,240 jobs';
const RECORD = '18000000001 1 2049 2 s\n';

/**
 * Run the hook as row r1's job, run 18000000001 attempt 1. `record` is jobs/r1 (null: none), `summary`
 * is public/summary.txt (null: none) and `ageMin` its age. Returns the exit status, stdout and the step summary.
 */
function hook({ record = RECORD, summary = `${AGG}\n`, ageMin = 1, env = {}, before = '' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'hook-')).split(sep).join('/');
  mkdirSync(`${base}/pl/jobs`, { recursive: true });
  mkdirSync(`${base}/pl/public`);
  if (record !== null) writeFileSync(`${base}/pl/jobs/r1`, record);
  if (summary !== null) {
    writeFileSync(`${base}/pl/public/summary.txt`, summary);
    const t = Date.now() / 1000 - ageMin * 60;
    utimesSync(`${base}/pl/public/summary.txt`, t, t);
  }
  const out = `${base}/step-summary.md`;
  writeFileSync(out, before);
  const r = spawnSync('bash', [join(HERE, 'pitlane-job-summary.sh')], {
    env: { ...process.env, PITLANE_DIR: `${base}/pl`, GITHUB_STEP_SUMMARY: out, RUNNER_NAME: 'r1', GITHUB_RUN_ID: '18000000001', GITHUB_RUN_ATTEMPT: '1', ...env },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, summary: existsSync(out) ? readFileSync(out, 'utf8') : null };
}

test('this job\'s wait and the last 24 h, on one line', () => {
  const r = hook();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.summary, `⚡ Ran on **pitlane**: picked up 2 s after it queued. Queued to running over the last 24 h: ${AGG}.\n`);
});

test('a record for another run or attempt is the row\'s previous job: the line leaves its wait out', () => {
  for (const env of [{ GITHUB_RUN_ID: '18000000002' }, { GITHUB_RUN_ATTEMPT: '2' }]) {
    const r = hook({ env });
    assert.equal(r.summary, `⚡ Ran on **pitlane**. Queued to running over the last 24 h: ${AGG}.\n`, JSON.stringify(env));
  }
});

test('a stale, empty or missing summary leaves the 24 h out; missing files leave the bare line', () => {
  assert.equal(hook({ ageMin: 20 }).summary, '⚡ Ran on **pitlane**: picked up 2 s after it queued.\n');
  assert.equal(hook({ summary: '\n' }).summary, '⚡ Ran on **pitlane**: picked up 2 s after it queued.\n');
  const r = hook({ record: null, summary: null });
  assert.equal(r.status, 0);
  assert.equal(r.summary, '⚡ Ran on **pitlane**.\n');
});

test('a runner name that is not a row name reads no record', () => {
  for (const name of ['../pl/jobs/r1', '', '.r1']) {
    const r = hook({ env: { RUNNER_NAME: name } });
    assert.equal(r.status, 0);
    assert.match(r.summary, /^⚡ Ran on \*\*pitlane\*\*\. /, JSON.stringify(name));
  }
});

test('it appends to what the job wrote', () => {
  assert.equal(hook({ before: '## Tests\nall green\n' }).summary, `## Tests\nall green\n⚡ Ran on **pitlane**: picked up 2 s after it queued. Queued to running over the last 24 h: ${AGG}.\n`);
});

test('it always exits 0 and prints nothing, even with no summary file or one it cannot write', () => {
  for (const env of [{ GITHUB_STEP_SUMMARY: '' }, { GITHUB_STEP_SUMMARY: `${tmpdir().split(sep).join('/')}/no-such-dir-${process.pid}/x.md` }]) {
    const r = hook({ env });
    assert.equal(r.status, 0, JSON.stringify(env));
    assert.equal(`${r.stdout}${r.stderr}`, '');
  }
});
