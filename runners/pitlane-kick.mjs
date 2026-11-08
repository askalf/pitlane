// The webhook half of gha-ondemand: GitHub says a job queued, the dispatcher ticks now instead of
// at the next poll. The payload is trusted for little: the job it names (kickJob) lets the
// dispatcher queue it for the pool and start one pool row before the listing confirms it, and the
// tick then asks GitHub itself what is queued; so a forged or replayed delivery, signed with the
// secret, can cost one tick and one pool row's start, which parks when no job comes.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { jobOutcome, parseTime, plainText } from './pitlane-outcomes.mjs';

export const MAX_BODY = 256 * 1024;

/** True when `header` (X-Hub-Signature-256) is the HMAC-SHA256 of `body` under `secret`. */
export function verifySignature(secret, body, header) {
  if (!secret || typeof header !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const want = createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(header.slice(7), 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * What a delivery means for the dispatcher: 'kick' (a self-hosted job queued), 'ignore' (a valid
 * delivery that needs nothing), or 'bad' (not JSON). Exported for tests.
 */
export function classify(event, body) {
  if (event === 'ping') return 'ignore';
  if (event !== 'workflow_job') return 'ignore';
  let p;
  try { p = JSON.parse(body); } catch { return 'bad'; }
  if (p?.action !== 'queued') return 'ignore';
  return Array.isArray(p?.workflow_job?.labels) && p.workflow_job.labels.includes('self-hosted') ? 'kick' : 'ignore';
}

/**
 * The queued self-hosted job a delivery announces, as { id, repo, labels }, for the dispatcher to
 * route before its next listing. Null for any other delivery, or for fields that are not the plain
 * shapes GitHub sends (a positive integer id, owner/name, labels of word characters): the dispatcher
 * writes these into a file the mint step reads, so nothing else gets through. Exported for tests.
 */
export function kickJob(event, body) {
  if (event !== 'workflow_job') return null;
  let p;
  try { p = JSON.parse(body); } catch { return null; }
  const j = p?.workflow_job;
  if (p?.action !== 'queued' || !Array.isArray(j?.labels) || !j.labels.includes('self-hosted')) return null;
  const repo = p?.repository?.full_name;
  // owner/name as GitHub spells them: the repository goes into an API path and a queue entry, so a
  // name of dots alone (a path step) is refused with everything else that is not a repository.
  if (!Number.isInteger(j.id) || j.id <= 0 || typeof repo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/.test(repo)) return null;
  if (!j.labels.every((l) => typeof l === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(l))) return null;
  return { id: j.id, repo, labels: j.labels };
}

/**
 * One started self-hosted job's queue wait, from a workflow_job `in_progress` delivery: created_at is
 * when the job queued, started_at when a runner took it. Null for any other delivery, a job that is
 * not self-hosted, or timestamps that do not parse or run backwards. Exported for tests.
 */
export function jobTiming(event, body) {
  if (event !== 'workflow_job') return null;
  let p;
  try { p = JSON.parse(body); } catch { return null; }
  const j = p?.workflow_job;
  if (p?.action !== 'in_progress' || !Array.isArray(j?.labels) || !j.labels.includes('self-hosted')) return null;
  const created = parseTime(j.created_at);
  const started = parseTime(j.started_at);
  const repo = p?.repository?.full_name;
  if (!Number.isFinite(created) || !Number.isFinite(started) || started < created || typeof repo !== 'string') return null;
  // runId and runAttempt let the job's own completed hook find its record (writeJobRecord).
  const runId = Number.isSafeInteger(j.run_id) ? j.run_id : null;
  const runAttempt = Number.isSafeInteger(j.run_attempt) ? j.run_attempt : null;
  return { repo, runner: plainText(j.runner_name), labels: j.labels, startedAt: started, waitMs: started - created, runId, runAttempt };
}

/**
 * A loopback HTTP server for the tunnel to reach. `onKick` is called for each queued self-hosted
 * job with that job (kickJob, or null when the payload names it in an unexpected shape), `onJob`
 * (optional) with the timing of each job a runner starts, `onOutcome` (optional) with the result of
 * each one that finishes; answers are 202 (kicked), 200 (valid, nothing to do), 401 (bad signature), 400, 404, 413, 405.
 */
export function kickServer({ secret, port, path = '/pitlane', onKick, onJob = () => {}, onOutcome = () => {}, log = () => {} }) {
  const server = createServer((req, res) => {
    const end = (code) => { res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(`${code}\n`); };
    if (req.url !== path) return end(404);
    if (req.method !== 'POST') return end(405);
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { end(413); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      const body = Buffer.concat(chunks);
      if (!verifySignature(secret, body, req.headers['x-hub-signature-256'])) return end(401);
      const verdict = classify(String(req.headers['x-github-event'] ?? ''), body.toString('utf8'));
      if (verdict === 'bad') return end(400);
      const timing = jobTiming(String(req.headers['x-github-event'] ?? ''), body.toString('utf8'));
      if (timing) {
        try { onJob(timing); } catch (err) { log(`job handler failed: ${err?.message ?? err}`); }
      }
      const outcome = jobOutcome(String(req.headers['x-github-event'] ?? ''), body.toString('utf8'));
      if (outcome) {
        try { onOutcome(outcome); } catch (err) { log(`outcome handler failed: ${err?.message ?? err}`); }
      }
      if (verdict === 'kick') {
        const id = createHash('sha256').update(body).digest('hex').slice(0, 8);
        log(`kick: a self-hosted job queued (delivery ${id})`);
        try { onKick(kickJob(String(req.headers['x-github-event'] ?? ''), body.toString('utf8'))); } catch (err) { log(`kick handler failed: ${err?.message ?? err}`); }
        return end(202);
      }
      return end(200);
    });
    req.on('error', () => {});
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/**
 * A sleep a kick can cut short. `kick()` wakes the pending `wait`, or marks the next one to return
 * at once; kicks inside `minGapMs` of the last tick start are held until the gap has passed, so a
 * burst of queued jobs is one tick.
 */
export function makeWaker({ minGapMs = 2000, now = Date.now } = {}) {
  let wake = null;
  let pending = false;
  let lastStart = 0;
  return {
    kick() {
      pending = true;
      if (wake) wake();
    },
    markStart() { lastStart = now(); },
    async wait(ms) {
      if (!pending) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, ms);
          wake = () => { clearTimeout(t); resolve(); };
        });
        wake = null;
      }
      if (pending) {
        pending = false;
        const gap = lastStart + minGapMs - now();
        if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      }
    },
  };
}
