// node --test canary/probe-coverage.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coverage } from './probe-coverage.mjs';

const job = (o = {}) => ({ name: 'probe (a)', status: 'completed', conclusion: 'success', runner_name: 'pool-e3', ...o });
const plant = { name: 'plant', status: 'completed', conclusion: 'success', runner_name: 'pool-e7' };

test('a passing probe on a pool row covers the pool', () => {
  const r = coverage([plant, job(), job({ name: 'probe (b)', runner_name: 'pitlane-exec-e1' })]);
  assert.equal(r.pool, true);
  assert.equal(r.settled, true);
  assert.deepEqual(r.probes, [
    { name: 'probe (a)', runner: 'pool-e3', conclusion: 'success' },
    { name: 'probe (b)', runner: 'pitlane-exec-e1', conclusion: 'success' },
  ]);
});

test('the plant on a pool row is not a probe from one', () => {
  assert.equal(coverage([plant, job({ runner_name: 'pitlane-exec-e1' })]).pool, false);
});

test('a failed or unfinished probe on a pool row does not count', () => {
  assert.equal(coverage([job({ conclusion: 'failure' })]).pool, false);
  const open = coverage([job({ status: 'in_progress', conclusion: null })]);
  assert.equal(open.pool, false);
  assert.equal(open.settled, false);
});

test('only pool-e<n> is a pool row; a row whose name merely holds "pool" is not', () => {
  assert.equal(coverage([job({ runner_name: 'pool-e12' })]).pool, true);
  for (const runner_name of ['pool-ex', 'my-pool-e1', 'pool-e1-old', null]) assert.equal(coverage([job({ runner_name })]).pool, false, String(runner_name));
});

test('a single probe job (no matrix) is still a probe; no probes is unsettled', () => {
  assert.equal(coverage([job({ name: 'probe' })]).pool, true);
  assert.deepEqual(coverage(undefined), { probes: [], pool: false, redline: false, settled: false });
  assert.equal(coverage([{ name: 'probe-coverage', status: 'completed', conclusion: 'success', runner_name: 'pool-e1' }]).pool, false);
});

test('the Redline probe covers the Redline rows only when it passed on one; it never counts as the pool probe', () => {
  const red = (o = {}) => job({ name: 'probe-redline', runner_name: 'pitlane-redline-e1', ...o });
  const both = coverage([plant, job(), red()]);
  assert.equal(both.pool, true);
  assert.equal(both.redline, true);
  assert.deepEqual(both.probes.at(-1), { name: 'probe-redline', runner: 'pitlane-redline-e1', conclusion: 'success' });
  assert.equal(coverage([job(), red({ conclusion: 'failure' })]).redline, false);
  assert.equal(coverage([job(), red({ runner_name: 'pool-e2' })]).redline, false, 'a Redline probe that landed off a Redline row');
  assert.equal(coverage([job(), red({ runner_name: 'pool-e2' })]).pool, true, 'the matrix probe still covers the pool');
  assert.equal(coverage([red({ runner_name: 'pool-e2' })]).pool, false, 'the Redline probe is not a pool probe');
  assert.equal(coverage([job({ runner_name: 'pitlane-redline-e1' })]).redline, false, 'a matrix probe is not the Redline probe');
  assert.equal(coverage([job(), red({ status: 'in_progress', conclusion: null })]).settled, false, 'coverage waits for the Redline probe too');
  for (const runner_name of ['redline-e1', 'pitlane-redline-1', 'pitlane-redline-e1-old', null]) assert.equal(coverage([red({ runner_name })]).redline, false, String(runner_name));
});
