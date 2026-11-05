// Fuzz the webhook path: the body and headers of a delivery that the dispatcher's loopback server
// reads (pitlane-kick.mjs) and hands to the queue, wait and outcome records. The body is JSON
// from the network, signed but not otherwise trusted, and the server calls these functions inline
// in its request handler, so a throw here is an uncaught exception in the dispatcher process.
// Contracts: classify, kickJob, jobTiming, jobOutcome and verifySignature never throw, for any
// event name and any body; each returns only its documented shape; kickJob is non-null only for a
// delivery classify calls a kick, and only with the plain id, owner/name and labels the mint
// step may read; the outcome is a record JSON.stringify can write to its day file.
import { createHmac } from 'node:crypto';
import { classify, jobTiming, kickJob, verifySignature } from '../runners/pitlane-kick.mjs';
import { classifyJob, jobOutcome } from '../runners/pitlane-outcomes.mjs';
import { Cursor, perturb } from './gen.mjs';

const EVENTS = ['workflow_job', 'workflow_job', 'workflow_job', 'ping', 'push'];
const CLASSES = ['success', 'skipped', 'cancelled', 'cancelled-queued', 'timed-out', 'job-failed', 'setup-failed', 'runner-lost-suspect', 'other'];

function fail(msg) {
  throw new Error(msg);
}

// The shape of a delivery GitHub sends for a job, which perturb() damages field by field.
const TEMPLATE = {
  action: 'completed',
  workflow_job: {
    id: 101,
    run_id: 5,
    run_attempt: 1,
    labels: ['self-hosted', 'Linux', 'X64', 'exec'],
    runner_name: 'row-1',
    created_at: '2026-11-03T10:00:00Z',
    started_at: '2026-11-03T10:00:03Z',
    completed_at: '2026-11-03T10:01:00Z',
    conclusion: 'failure',
    steps: [{ name: 'Set up job', conclusion: 'failure' }, { name: 'build', conclusion: 'skipped' }],
  },
  repository: { full_name: 'askalf/pitlane' },
};
const ACTIONS = ['queued', 'in_progress', 'completed'];

export function fuzz(data) {
  // The first byte picks the event header and how the body is made: the other bytes as the body
  // text itself, or (first byte 128 and up) a damaged copy of a valid delivery built from them.
  const event = EVENTS[data.length ? data[0] % EVENTS.length : 0];
  let body;
  if (data.length > 1 && data[0] >= 128) {
    const c = new Cursor(data.subarray(1));
    const doc = perturb(TEMPLATE, c);
    if (doc && typeof doc === 'object' && !Array.isArray(doc) && c.byte() < 200) doc.action = ACTIONS[c.byte() % ACTIONS.length];
    body = JSON.stringify(doc);
  } else {
    body = data.subarray(Math.min(1, data.length)).toString('utf8');
  }

  const verdict = classify(event, body);
  if (verdict !== 'kick' && verdict !== 'ignore' && verdict !== 'bad') fail(`classify returned ${String(verdict)}`);

  const kick = kickJob(event, body);
  if (kick !== null) {
    if (verdict !== 'kick') fail(`kickJob accepted a delivery classify called ${verdict}`);
    if (!Number.isInteger(kick.id) || kick.id <= 0) fail('kickJob returned a job id that is not a positive integer');
    if (typeof kick.repo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/.test(kick.repo)) fail(`kickJob returned the repository ${kick.repo}`);
    if (!Array.isArray(kick.labels) || kick.labels.some((l) => typeof l !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(l))) fail('kickJob returned a label that is not plain');
  }

  const timing = jobTiming(event, body);
  if (timing !== null) {
    if (typeof timing.repo !== 'string' || typeof timing.runner !== 'string') fail('jobTiming returned a repo or runner that is not a string');
    if (!Number.isFinite(timing.startedAt) || !Number.isFinite(timing.waitMs) || timing.waitMs < 0) fail('jobTiming returned a time that is not a finite, forward interval');
    if (!Array.isArray(timing.labels)) fail('jobTiming returned labels that are not a list');
    for (const k of ['runId', 'runAttempt']) if (timing[k] !== null && !Number.isSafeInteger(timing[k])) fail(`jobTiming.${k} is neither null nor a safe integer`);
  }

  const outcome = jobOutcome(event, body);
  if (outcome !== null) {
    if (!CLASSES.includes(outcome.class)) fail(`jobOutcome returned the class ${outcome.class}`);
    if (!Number.isFinite(outcome.id) || !Number.isFinite(outcome.at)) fail('jobOutcome returned an id or time that is not finite');
    if (typeof outcome.repo !== 'string' || typeof outcome.runner !== 'string' || typeof outcome.conclusion !== 'string') fail('jobOutcome returned a field that is not a string');
    for (const k of ['waitMs', 'runMs']) if (outcome[k] !== null && !(Number.isFinite(outcome[k]) && outcome[k] >= 0)) fail(`jobOutcome.${k} is neither null nor a forward interval`);
    if (outcome.bad !== undefined && (!Array.isArray(outcome.bad) || outcome.bad.some((s) => typeof s !== 'string'))) fail('jobOutcome.bad is not a list of strings');
    // recordOutcome appends JSON.stringify(e); a line that does not read back would be dropped.
    if (JSON.parse(JSON.stringify(outcome)).id !== outcome.id) fail('jobOutcome record does not round-trip through JSON');
  }

  // classifyJob over the parsed job object itself, whatever shape the body had.
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = undefined; }
  const cls = classifyJob(parsed?.workflow_job ?? parsed);
  if (!CLASSES.includes(cls)) fail(`classifyJob returned the class ${cls}`);

  // Signature: arbitrary secret and header never throw; the header computed from the secret and
  // the body always verifies, and a flipped body never does.
  const secret = body.slice(0, 16) || 'k';
  const bytes = Buffer.from(body, 'utf8');
  if (verifySignature(secret, bytes, body) !== false) fail('verifySignature accepted a header that is not a signature');
  if (verifySignature('', bytes, 'sha256=' + '0'.repeat(64)) !== false) fail('verifySignature accepted an empty secret');
  const header = `sha256=${createHmac('sha256', secret).update(bytes).digest('hex')}`;
  if (verifySignature(secret, bytes, header) !== true) fail('verifySignature rejected the right signature');
  if (verifySignature(secret, Buffer.concat([bytes, Buffer.from([0])]), header) !== false) fail('verifySignature accepted a changed body');
}
