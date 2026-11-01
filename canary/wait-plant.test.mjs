// node --test canary/wait-plant.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plantState } from './wait-plant.mjs';

const job = (o = {}) => ({ name: 'plant', status: 'in_progress', runner_name: 'pitlane-exec-e1', steps: [{ name: 'Plant', status: 'in_progress' }], ...o });

test('ready: the plant is mid-step on another runner', () => {
  assert.deepEqual(plantState([job()], 'pitlane-exec-e2'), { state: 'ready', runner: 'pitlane-exec-e1' });
});

test('same runner is not a result: one runner takes one job, so this means the data is wrong', () => {
  assert.equal(plantState([job()], 'pitlane-exec-e1').state, 'same-runner');
});

test('waiting until the Plant step starts, or before a runner is assigned', () => {
  assert.equal(plantState([job({ steps: [{ name: 'Plant', status: 'queued' }] })], 'x').state, 'waiting');
  assert.equal(plantState([job({ runner_name: null })], 'x').state, 'waiting');
});

test('finished and missing plants are reported as such', () => {
  assert.equal(plantState([job({ status: 'completed', steps: [{ name: 'Plant', status: 'completed' }] })], 'x').state, 'finished');
  assert.equal(plantState([], 'x').state, 'missing');
  assert.equal(plantState(undefined, 'x').state, 'missing');
});
