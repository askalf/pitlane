// node --test runners/pitlane-kick.test.mjs
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { classify, jobTiming, kickJob, kickServer, makeWaker, verifySignature } from './pitlane-kick.mjs';
import { jobOutcome } from './pitlane-outcomes.mjs';

const SECRET = 'test-secret';
const sign = (body, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const queued = JSON.stringify({ action: 'queued', workflow_job: { labels: ['self-hosted', 'Linux', 'ci-exec'] } });

test('a signature verifies only for the same body and secret, in the sha256= form', () => {
  assert.equal(verifySignature(SECRET, queued, sign(queued)), true);
  assert.equal(verifySignature(SECRET, queued, sign(queued, 'other')), false);
  assert.equal(verifySignature(SECRET, queued + ' ', sign(queued)), false);
  assert.equal(verifySignature(SECRET, queued, undefined), false);
  assert.equal(verifySignature(SECRET, queued, 'sha256=zz'), false);
  assert.equal(verifySignature('', queued, sign(queued, '')), false);
});

test('only a queued self-hosted workflow_job kicks', () => {
  assert.equal(classify('workflow_job', queued), 'kick');
  assert.equal(classify('workflow_job', JSON.stringify({ action: 'completed', workflow_job: { labels: ['self-hosted'] } })), 'ignore');
  assert.equal(classify('workflow_job', JSON.stringify({ action: 'queued', workflow_job: { labels: ['ubuntu-latest'] } })), 'ignore');
  assert.equal(classify('workflow_job', 'not json'), 'bad');
  assert.equal(classify('push', queued), 'ignore');
  assert.equal(classify('ping', '{}'), 'ignore');
});

async function post(server, { body = queued, event = 'workflow_job', sig = sign(body), path = '/pitlane', method = 'POST' } = {}) {
  const { port } = server.address();
  const headers = { 'X-GitHub-Event': event };
  if (sig) headers['X-Hub-Signature-256'] = sig;
  return (await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: method === 'POST' ? body : undefined })).status;
}

test('the server answers by signature, event and path, and kicks only for a real queued job', async () => {
  let kicks = 0;
  const server = await kickServer({ secret: SECRET, port: 0, onKick: () => { kicks += 1; } });
  try {
    assert.equal(await post(server), 202);
    assert.equal(kicks, 1);
    assert.equal(await post(server, { sig: sign(queued, 'wrong') }), 401);
    assert.equal(await post(server, { sig: null }), 401);
    assert.equal(await post(server, { event: 'ping', body: '{}' }), 200);
    assert.equal(await post(server, { body: 'not json', event: 'workflow_job' }), 400);
    assert.equal(await post(server, { path: '/other' }), 404);
    assert.equal(await post(server, { method: 'GET' }), 405);
    assert.equal(await post(server, { body: 'x'.repeat(300 * 1024), event: 'workflow_job' }).catch(() => 413), 413);
    assert.equal(kicks, 1);
  } finally {
    server.close();
  }
});

const full = JSON.stringify({ action: 'queued', repository: { full_name: 'askalf/ci' }, workflow_job: { id: 42, labels: ['self-hosted', 'Linux', 'X64', 'ci-exec'] } });
const shaped = (over) => JSON.stringify({ action: 'queued', repository: { full_name: 'askalf/ci' }, workflow_job: { id: 42, labels: ['self-hosted'] }, ...over });

test('kickJob names the queued job for the dispatcher, and only in the shapes GitHub sends', () => {
  assert.deepEqual(kickJob('workflow_job', full), { id: 42, repo: 'askalf/ci', labels: ['self-hosted', 'Linux', 'X64', 'ci-exec'] });
  assert.equal(kickJob('workflow_job', queued), null, 'no repository');
  assert.equal(kickJob('workflow_job', shaped({ workflow_job: { id: '42', labels: ['self-hosted'] } })), null, 'an id that is not an integer');
  assert.equal(kickJob('workflow_job', shaped({ repository: { full_name: '../x' } })), null, 'a repository that is not owner/name');
  assert.equal(kickJob('workflow_job', shaped({ repository: { full_name: 'askalf/..' } })), null, 'a name of dots alone');
  assert.equal(kickJob('workflow_job', shaped({ repository: { full_name: 'askalf/.well-known' } }))?.repo, 'askalf/.well-known', 'a name GitHub allows');
  assert.equal(kickJob('workflow_job', shaped({ workflow_job: { id: 42, labels: ['self-hosted', 'a b'] } })), null, 'a label with a space');
  assert.equal(kickJob('workflow_job', shaped({ action: 'completed' })), null);
  assert.equal(kickJob('push', full), null);
  assert.equal(kickJob('workflow_job', 'not json'), null);
});

test('onKick receives the job a delivery names, or null when the payload lacks the fields', async () => {
  const got = [];
  const server = await kickServer({ secret: SECRET, port: 0, onKick: (j) => got.push(j) });
  try {
    assert.equal(await post(server, { body: full }), 202);
    assert.equal(await post(server), 202);
    assert.deepEqual(got, [{ id: 42, repo: 'askalf/ci', labels: ['self-hosted', 'Linux', 'X64', 'ci-exec'] }, null]);
  } finally {
    server.close();
  }
});

test('a signed completed delivery reaches onOutcome, and a failing handler does not fail the delivery', async () => {
  const done = JSON.stringify({ action: 'completed', repository: { full_name: 'askalf/dario' }, workflow_job: { id: 5, labels: ['self-hosted'], runner_name: 'dario-exec-e1', conclusion: 'failure', created_at: '2026-10-15T19:00:00Z', started_at: '2026-10-15T19:00:02Z', completed_at: '2026-10-15T19:00:10Z', steps: [] } });
  const seen = [];
  const server = await kickServer({ secret: SECRET, port: 0, onKick: () => {}, onOutcome: (e) => seen.push(e) });
  try {
    assert.equal(await post(server, { body: done }), 200);
    assert.equal(await post(server, { body: done, sig: sign(done, 'wrong') }), 401);
    assert.equal(await post(server), 202);
    assert.deepEqual(seen.map((e) => [e.id, e.class, e.runner]), [[5, 'runner-lost-suspect', 'dario-exec-e1']]);
  } finally {
    server.close();
  }
  const broken = await kickServer({ secret: SECRET, port: 0, onKick: () => {}, onOutcome: () => { throw new Error('disk full'); } });
  try {
    assert.equal(await post(broken, { body: done }), 200);
  } finally {
    broken.close();
  }
});

test('a kick ends the wait early; kicks within the gap of a tick start are held, not dropped', async () => {
  let t = 0;
  const w = makeWaker({ minGapMs: 50, now: () => t });
  w.markStart();
  const t0 = Date.now();
  const waiting = w.wait(5000);
  setTimeout(() => w.kick(), 10);
  await waiting;
  assert.ok(Date.now() - t0 < 1000, 'woke well before the 5 s poll');
  // A kick before wait is called returns at once.
  w.kick();
  const t1 = Date.now();
  await w.wait(5000);
  assert.ok(Date.now() - t1 < 1000);
});

// A delivery is JSON from the network. A field that is an object whose toString key is not a function
// makes String(), a template literal and Date.parse() throw, and the server runs these readers inline
// in its request handler, so a throw there is an uncaught exception in the dispatcher.
test('a delivery with object-valued fields is read as plain data, never thrown on', () => {
  const evil = { toString: 1 };
  const job = {
    id: 9, labels: ['self-hosted'], runner_name: evil, conclusion: evil, created_at: [evil], started_at: evil, completed_at: '2026-10-15T19:01:03Z',
    steps: [{ name: evil, conclusion: evil }, { name: evil, conclusion: 'failure' }, { name: 'run', conclusion: evil }],
  };
  const text = (action) => JSON.stringify({ action, repository: { full_name: 'askalf/pitlane' }, workflow_job: job });
  assert.equal(jobTiming('workflow_job', text('in_progress')), null, 'timestamps that are not strings do not parse');
  const e = jobOutcome('workflow_job', text('completed'));
  assert.equal(e.runner, '');
  assert.equal(e.conclusion, '');
  assert.equal(e.class, 'other');
  const failed = jobOutcome('workflow_job', text('completed').replace('"conclusion":{"toString":1},"created_at"', '"conclusion":"failure","created_at"'));
  assert.equal(failed.class, 'job-failed');
  const lost = JSON.parse(text('completed'));
  lost.workflow_job.conclusion = 'failure';
  lost.workflow_job.steps = [{ name: evil, conclusion: evil }];
  const l = jobOutcome('workflow_job', JSON.stringify(lost));
  assert.equal(l.class, 'runner-lost-suspect');
  assert.deepEqual(l.bad, [], 'a step conclusion that is not text names no failed step');
  const timing = jobTiming('workflow_job', JSON.stringify({ action: 'in_progress', repository: { full_name: 'askalf/pitlane' }, workflow_job: { labels: ['self-hosted'], runner_name: evil, created_at: '2026-10-15T19:00:00Z', started_at: '2026-10-15T19:00:03Z' } }));
  assert.equal(timing.runner, '');
  assert.equal(timing.waitMs, 3000);
});
