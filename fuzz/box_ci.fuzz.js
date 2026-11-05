// Fuzz box-ci's inputs: its JSON config, the --json log act writes while it runs a repository's
// workflows (job and step names and matrix values come from the repository's workflow files), the
// pull request and branch lists GitHub returns, and the secrets file. box-ci runs pull requests
// from the repository itself on the host, so a workflow author controls the act log, and a throw
// in these pure functions ends a poll cycle's handling of every run it was about to report.
// Contracts: parseConfig returns a config of the documented shape or throws an Error whose message
// starts with "config:" (a JSON syntax error is the one other thing it may throw); parseActLog,
// githubJobName, statusesFor, planRuns, buildEvent, scopeUnit and validateSecretFile never throw
// anything but their documented error, and return their documented shapes for any input.
import {
  buildEvent,
  githubJobName,
  parseActLog,
  parseConfig,
  planRuns,
  scopeUnit,
  statusesFor,
  validateSecretFile,
} from '../box-ci/box-ci.mjs';
import { Cursor, perturb } from './gen.mjs';

function fail(msg) {
  throw new Error(msg);
}

const CONFIG = {
  runAs: 'gha-exec',
  concurrency: 1,
  pollSeconds: 30,
  jobTimeoutMinutes: 30,
  contextPrefix: 'box/',
  labels: ['ubuntu-latest'],
  scope: true,
  slice: 'gha-exec.slice',
  repos: [{
    repo: 'askalf/shop',
    events: ['pull_request', 'push'],
    branches: ['main'],
    labels: ['x'],
    vars: { A: 'b' },
    secretsFile: '/etc/box-ci/shop.env',
    workflows: ['box-unit.yml'],
    serial: true,
  }],
};
const ACT_LINES = [
  { job: 'CI/test (ubuntu)', jobID: 'test', matrix: { os: 'ubuntu', node: 22 }, step: 'build', stepResult: 'failure', time: '2026-11-03T10:00:03Z' },
  { job: 'CI/test (ubuntu)', jobID: 'test', matrix: { os: 'ubuntu', node: 22 }, jobResult: 'failure', time: '2026-11-03T10:00:09Z' },
  { job: 'CI/lint', jobID: 'lint', step: 'run', stepResult: 'success', jobResult: 'success', time: '2026-11-03T10:00:10Z' },
];
const PULL = { number: 7, user: { login: 'a' }, head: { sha: 'abc123', repo: { full_name: 'askalf/shop' } } };
const BRANCH = { branch: 'main', sha: 'def456', previous: 'abc123' };
const EXIT = [0, 1, 124, null];

export function fuzz(data) {
  const text = data.toString('utf8');
  let cfg;
  let configText;
  let logText;
  let pulls;
  let heads;
  let exit;
  if (data.length > 1 && data[0] >= 128) {
    const c = new Cursor(data.subarray(1));
    configText = JSON.stringify(perturb(CONFIG, c));
    logText = ACT_LINES.map((l) => JSON.stringify(perturb(l, c))).join('\n');
    pulls = [perturb(PULL, c), perturb(PULL, c)];
    // Branch heads are built by box-ci from its own branch list, so each is an object; its fields are GitHub's.
    heads = [perturb(BRANCH, c)].filter((h) => h && typeof h === 'object');
    exit = EXIT[c.byte() % EXIT.length];
  } else {
    configText = text;
    logText = text;
    pulls = [];
    heads = [];
    exit = 1;
    try { pulls = JSON.parse(text); } catch { /* not JSON */ }
  }

  // The config: documented error or documented shape.
  try {
    cfg = parseConfig(configText);
  } catch (err) {
    if (!(err instanceof SyntaxError) && !(err instanceof Error && err.name === 'Error' && err.message.startsWith('config:'))) {
      fail(`parseConfig threw ${err?.name}: ${err?.message}`);
    }
  }
  if (cfg) {
    for (const k of ['concurrency', 'pollSeconds', 'jobTimeoutMinutes']) if (!Number.isInteger(cfg[k]) || cfg[k] < 1) fail(`config.${k} is ${cfg[k]}`);
    if (typeof cfg.contextPrefix !== 'string' || !/^[\w.-]+\.slice$/.test(cfg.slice)) fail('config.contextPrefix or config.slice is not valid');
    if (!Array.isArray(cfg.labels) || cfg.labels.some((l) => typeof l !== 'string')) fail('config.labels holds a non-string');
    if (!cfg.repos.length) fail('config has no repos');
    for (const r of cfg.repos) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(r.repo)) fail(`config repo ${r.repo}`);
      if (r.events.some((e) => e !== 'pull_request' && e !== 'push')) fail('config repo has an unsupported event');
      if (r.branches.some((b) => typeof b !== 'string') || r.labels.some((l) => typeof l !== 'string')) fail('config repo has a non-string branch or label');
      if (Object.values(r.vars).some((v) => typeof v !== 'string')) fail('config repo has a non-string var');
      if (r.workflows && r.workflows.some((f) => !/^[\w.-]+\.ya?ml$/.test(f))) fail('config repo has a workflow that is not a file name');
      if (typeof r.serial !== 'boolean') fail('config repo serial is not a boolean');
    }
  }

  // The act log, and the statuses reported from it.
  const jobs = parseActLog(logText);
  if (!Array.isArray(jobs)) fail('parseActLog returned a non-list');
  for (const j of jobs) {
    if (typeof j.name !== 'string' || typeof j.result !== 'string') fail('parseActLog returned a job name or result that is not a string');
    if (j.failedStep !== null && typeof j.failedStep !== 'string') fail(`parseActLog returned a failedStep that is a ${typeof j.failedStep}`);
    if (j.seconds !== null && !Number.isFinite(j.seconds)) fail('parseActLog returned seconds that are not finite');
  }
  const base = cfg ?? parseConfig(JSON.stringify(CONFIG));
  const statuses = statusesFor(base, jobs, { exitCode: exit, timedOut: exit === 124, error: exit === null ? 'spawn failed' : '' });
  if (!Array.isArray(statuses) || statuses.length === 0) fail('statusesFor returned no statuses');
  for (const s of statuses) {
    if (typeof s.context !== 'string' || !s.context.startsWith(base.contextPrefix)) fail('a status context lost the prefix');
    if (!['success', 'failure', 'error'].includes(s.state)) fail(`a status has the state ${s.state}`);
    if (typeof s.description !== 'string' || s.description.length > 140) fail('a status description is missing or over 140 characters');
  }
  if (statuses[statuses.length - 1].context !== `${base.contextPrefix}ci`) fail('the run status is not last');

  // A matrix job's name, from act's name for it.
  const name = githubJobName(text.slice(0, 40), text.slice(40, 60) || null, perturb({ os: 'x', n: 1 }, new Cursor(data)));
  if (typeof name !== 'string') fail('githubJobName returned a non-string');

  // The polls and the event payload built from them.
  const repoCfg = base.repos[0];
  const planned = planRuns(repoCfg, Array.isArray(pulls) ? pulls : [], heads, {}, new Set());
  if (!Array.isArray(planned)) fail('planRuns returned a non-list');
  for (const run of planned) {
    if (typeof run.sha !== 'string' || !run.sha) fail('planRuns returned a run with no sha');
    const ev = buildEvent(repoCfg, run, null);
    if (!ev || typeof ev !== 'object') fail('buildEvent returned a non-object');
    JSON.stringify(ev);
  }

  if (typeof scopeUnit(text, data.length) !== 'string' || /[^A-Za-z0-9_.-]/.test(scopeUnit(text, data.length))) fail('scopeUnit returned a unit name with an unsafe character');

  try {
    if (validateSecretFile(text) !== true) fail('validateSecretFile returned something other than true');
  } catch (err) {
    if (!(err instanceof Error) || err.message !== 'secrets file: every line must be KEY=VALUE') fail(`validateSecretFile threw ${err?.message}`);
  }
}
