// Fuzz the host-state path: the text the supervisor reads from the box (systemctl show, journalctl,
// stat, cgroup files) and the records it reads back from its own files and from GitHub's runner
// list (queue-wait and outcome lines, dispatcher.json, runner registrations). Some of this is
// written by other programs and some is damaged by a crash mid-write, and the supervisor's tick
// runs every reader on every pass, so a throw here costs a tick of every row's status.
// Contracts: no reader throws for any text or any record the reader's own admission check lets
// through; each returns its documented shape; the journal line is one line, within its limit, with
// control characters removed and tokens masked (it goes to status.json and the alert channel); and
// the published numbers are JSON.
import { queuedFrom, joinQueue, joinRegistrations } from '../runners/pitlane-supervisor-detect.mjs';
import { failuresByUnit, hostNumbers, journalLine, parseShow, parseStat } from '../runners/pitlane-supervisor.mjs';
import { parseFlat, parsePsiSome } from '../runners/pitlane-slices.mjs';
import { Cursor, perturb } from './gen.mjs';

function fail(msg) {
  throw new Error(msg);
}

const NOW = 1793700000000;
const WAIT = { at: NOW - 1000, repo: 'askalf/pitlane', runner: 'row-1', waitMs: 3000 };
const OUTCOME = { id: 7, at: NOW - 2000, repo: 'askalf/pitlane', runner: 'row-1', conclusion: 'failure', class: 'job-failed', waitMs: 2000, runMs: 9000, bad: ['build:failure'] };
const DISPATCH = { at: NOW - 5000, queued: [{ id: 1, repo: 'askalf/pitlane', labels: ['self-hosted', 'exec'], pool: false }] };
const RUNNERS = { 'askalf/pitlane': { ok: true, runners: [{ id: 3, name: 'row-1', status: 'online', busy: false, version: null }] }, 'askalf/other': { ok: true, runners: [] } };
const ROWS = () => [
  { name: 'row-1', repo: 'askalf/pitlane', pool: null, labels: ['self-hosted', 'exec'], active: 'active', workerMs: null, parked: false, held: false },
  { name: 'pool-1', repo: 'pool:askalf', pool: 'askalf', labels: ['self-hosted', 'exec'], active: 'active', workerMs: null, parked: false, held: false },
];

// What readWaits and readOutcomes let through; the rest of a line is whatever the file held.
const waitAdmitted = (e) => e && typeof e === 'object' && Number.isFinite(e.at) && Number.isFinite(e.waitMs) && typeof e.repo === 'string';
const outcomeAdmitted = (e) => e && typeof e === 'object' && Number.isFinite(e.at) && Number.isFinite(e.id) && typeof e.repo === 'string' && typeof e.class === 'string';

function finiteOrNull(v, what) {
  if (v !== null && !Number.isFinite(v)) fail(`${what} is ${v}`);
}

export function fuzz(data) {
  const text = data.toString('utf8');

  // Text readers.
  const show = parseShow(text, NOW);
  for (const k of ['active', 'sub', 'result', 'cgroup', 'user']) if (typeof show[k] !== 'string') fail(`parseShow.${k} is not a string`);
  for (const k of ['execStatus', 'nrestarts', 'inactiveMs']) if (!Number.isFinite(show[k]) || (k === 'inactiveMs' && show[k] < 0)) fail(`parseShow.${k} is ${show[k]}`);
  if (typeof show.enabled !== 'boolean') fail('parseShow.enabled is not a boolean');

  const stat = parseStat(text);
  if (stat !== null && (typeof stat.group !== 'string' || !Number.isInteger(stat.mode))) fail('parseStat returned a malformed record');

  const flat = parseFlat(text);
  if (Object.values(flat).some((v) => !Number.isFinite(v))) fail('parseFlat returned a value that is not finite');
  finiteOrNull(parsePsiSome(text), 'parsePsiSome');

  const failures = failuresByUnit(text);
  if (Object.values(failures).some((n) => !Number.isInteger(n) || n < 1)) fail('failuresByUnit returned a count that is not a positive integer');

  for (const max of [200, 20, 3]) {
    const line = journalLine(text, max);
    if (typeof line !== 'string') fail('journalLine returned a non-string');
    if (/[\u0000-\u001f\u007f]/.test(line)) fail('journalLine kept a control character');
    if (line.length > max) fail(`journalLine returned ${line.length} characters, over ${max}`);
    if (/\b(gh[opsu]_|github_pat_)[A-Za-z0-9_]+/.test(line)) fail('journalLine kept a token');
    // The cut-off marker is dots, which the bearer pattern's own character class also accepts.
    if (/\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{8,}/i.test(line.replace(/\.\.\.$/, ''))) fail('journalLine kept a bearer value');
  }

  // Record readers, over damaged copies of valid records.
  const c = new Cursor(data);
  const waits = [perturb(WAIT, c), perturb(WAIT, c), WAIT].filter(waitAdmitted);
  const outcomes = [perturb(OUTCOME, c), perturb(OUTCOME, c), OUTCOME].filter(outcomeAdmitted);
  const names = new Set(['row-1', 'pool-1', text.slice(0, 12)]);
  const numbers = hostNumbers(waits, outcomes, names, NOW);
  if (JSON.stringify(numbers.published) === undefined) fail('the published numbers are not JSON');

  const doc = perturb(DISPATCH, c);
  const queued = queuedFrom(doc, NOW);
  if (queued !== null && !Array.isArray(queued)) fail('queuedFrom returned neither null nor a list');

  const gh = perturb(RUNNERS, c);
  const seen = {};
  // Two passes, so the clocks kept in `seen` start and then advance.
  for (const now of [NOW, NOW + 60000]) {
    const rows = ROWS();
    joinRegistrations(rows, gh && typeof gh === 'object' ? Object.fromEntries(Object.entries(gh).map(([k, v]) => [k, shapeOf(v)])) : {}, seen, now);
    joinQueue(rows, queued, seen, now);
    for (const r of rows) {
      finiteOrNull(r.offlineMs, 'offlineMs');
      finiteOrNull(r.absentMs, 'absentMs');
      finiteOrNull(r.unclaimedMs, 'unclaimedMs');
    }
  }
}

/** A repository's registration list as the supervisor builds it from GitHub's reply: { ok, runners: [{ id, name, status, busy, version }] } with the reply's own values in the fields. */
function shapeOf(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, runners: [] };
  const list = Array.isArray(v.runners) ? v.runners : [];
  return {
    ok: v.ok === true,
    runners: list.filter((r) => r && typeof r === 'object').map((r) => ({ id: r.id, name: r.name, status: r.status, busy: r.busy, version: null })),
  };
}
