// Tests for box-ci/box-ci.mjs. Run: node box-ci/box-ci.test.mjs
// GitHub, git and act are all stubbed; nothing leaves the machine and no account is switched.

import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  parseConfig, planRuns, runKey, buildEvent, actArgs, workflowPaths, getsSecrets, parseActLog, statusesFor, recordRun,
  validateSecretFile, makeGitHub, runOne, githubJobName, pickNext, supersede, createScheduler, scopeArgs, scopeUnit, run,
  clip, finishRun, launchFailure,
} from './box-ci.mjs';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}`); fail++; }
}
function throws(fn, re) {
  try { fn(); return false; } catch (e) { return re.test(e.message); }
}

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const base = { repos: [{ repo: 'askalf/sample', labels: ['sample'], vars: { SAMPLE_RUNNER: 'self' } }] };
const cfg = parseConfig(base);
const repoCfg = cfg.repos[0];
const ownPr = (sha = SHA, n = 7) => ({ number: n, head: { sha, ref: 'feature', repo: { full_name: 'askalf/sample' } }, base: { ref: 'main' }, user: { login: 'askalf' } });
const forkPr = { number: 8, head: { sha: SHA2, ref: 'x', repo: { full_name: 'someone/sample' } }, base: { ref: 'main' }, user: { login: 'someone' } };

console.log('\n=== config ===');
check('defaults fill in', cfg.concurrency === 2 && cfg.pollSeconds === 30 && cfg.contextPrefix === 'box/' && cfg.act === '/opt/box-ci/act');
check('a repo defaults to both events on main', repoCfg.events.join() === 'pull_request,push' && repoCfg.branches.join() === 'main' && repoCfg.workflows === null);
check('no repos is refused', throws(() => parseConfig({ repos: [] }), /non-empty/));
check('a malformed repo name is refused', throws(() => parseConfig({ repos: [{ repo: 'sample' }] }), /bad repo/));
check('an event box-ci cannot run is refused', throws(() => parseConfig({ repos: [{ repo: 'a/b', events: ['schedule'] }] }), /unsupported event/));
check('a workflow path outside the directory is refused', throws(() => parseConfig({ repos: [{ repo: 'a/b', workflows: ['../x.yml'] }] }), /file names/));
check('a poll faster than 10 s falls back to the default', parseConfig({ ...base, pollSeconds: 2 }).pollSeconds === 30);
{
  const example = parseConfig(readFileSync(new URL('./box-ci.example.json', import.meta.url), 'utf8'));
  check('the example config parses as gha-exec and enrols one repository',
    example.runAs === 'gha-exec' && example.repos.length === 1);
  check('the example config runs shop one job at a time, its two box workflows only',
    example.repos[0].repo === 'askalf/shop' && example.repos[0].serial === true && example.repos[0].workflows.join() === 'box-unit.yml,box-e2e.yml');
}
check('serial is off when not set', repoCfg.serial === false && parseConfig({ repos: [{ repo: 'a/b', serial: false }] }).repos[0].serial === false);
check('a serial that is not true or false is refused, not read as off', throws(() => parseConfig({ repos: [{ repo: 'a/b', serial: 'yes' }] }), /a\/b: serial must be true or false/)
  && throws(() => parseConfig({ repos: [{ repo: 'a/b', serial: 1 }] }), /serial must be true or false/));
check('act runs in a scope in gha-exec.slice unless the config says otherwise', cfg.scope === true && cfg.slice === 'gha-exec.slice'
  && parseConfig({ ...base, scope: false }).scope === false && parseConfig({ ...base, slice: 'x' }).slice === 'gha-exec.slice' && parseConfig({ ...base, slice: 'ci.slice' }).slice === 'ci.slice');
{
  const serialCfg = { repo: 'a/b', serial: true };
  const plainCfg = { repo: 'c/d', serial: false };
  const q = [{ repoCfg: serialCfg }, { repoCfg: plainCfg }, { repoCfg: serialCfg }];
  check('a serial repository with a run in flight waits, and a job behind it from another repository goes first',
    pickNext(q, new Map([['a/b', 1]])) === 1 && pickNext(q, new Map()) === 0 && pickNext([{ repoCfg: serialCfg }], new Map([['a/b', 1]])) === -1);
  check('a serial repository with nothing in flight goes, and a count back at zero frees it', pickNext(q, new Map([['a/b', 0]])) === 0);
}

console.log('\n=== planning ===');
const plan = planRuns(repoCfg, [ownPr(), forkPr], [{ branch: 'main', sha: SHA2, previous: SHA }], {}, new Set());
check('a same-repository pull request is planned', plan.some((r) => r.event === 'pull_request' && r.sha === SHA));
check("a fork's pull request is never planned", !plan.some((r) => r.event === 'pull_request' && r.sha === SHA2));
check('a branch head is planned as a push with the previous head', plan.some((r) => r.event === 'push' && r.sha === SHA2 && r.previous === SHA));
check('a finished run is not planned again', planRuns(repoCfg, [ownPr()], [], { [runKey('askalf/sample', 'pull_request', SHA)]: { outcome: 'success', at: 1 } }, new Set()).length === 0);
check('a running run is not planned again', planRuns(repoCfg, [ownPr()], [], {}, new Set([runKey('askalf/sample', 'pull_request', SHA)])).length === 0);
check('an event the repo does not take is not planned', planRuns({ ...repoCfg, events: ['pull_request'] }, [], [{ branch: 'main', sha: SHA2 }], {}, new Set()).length === 0);
check('a pull request without a head is skipped', planRuns(repoCfg, [{ number: 1 }], [], {}, new Set()).length === 0);

console.log('\n=== event and act arguments ===');
const prRun = { event: 'pull_request', sha: SHA, pr: ownPr() };
const pushRun = { event: 'push', sha: SHA2, branch: 'main', previous: null };
const prEvent = buildEvent(repoCfg, prRun);
check('a pull_request event carries the pull request and its number', prEvent.number === 7 && prEvent.pull_request.head.sha === SHA && prEvent.repository.full_name === 'askalf/sample');
const pushEvent = buildEvent(repoCfg, pushRun);
check('a push event names the branch ref and the commit', pushEvent.ref === 'refs/heads/main' && pushEvent.after === SHA2 && pushEvent.before === '0'.repeat(40));
const args = actArgs(cfg, repoCfg, prRun, { cachePath: '/c', secretFile: null });
check('act runs the event over the workflow directory with the event file', args.slice(0, 5).join(' ') === 'pull_request -W .github/workflows/ -e ../event.json');
check('every label runs on the host, each once', args.filter((a) => a === 'sample=-self-hosted').length === 1 && args.includes('ubuntu-latest=-self-hosted'));
check('repository variables are passed', args.join(' ').includes('--var SAMPLE_RUNNER=self'));
check('no secret file without one', !args.includes('--secret-file'));
check('a secret file is passed when given', actArgs(cfg, repoCfg, pushRun, { cachePath: '/c', secretFile: '../secrets.env' }).join(' ').includes('--secret-file ../secrets.env'));
check('listed workflows become one path each', workflowPaths({ workflows: ['ci.yml', 'lint.yml'] }).join() === '.github/workflows/ci.yml,.github/workflows/lint.yml');
check('without a list, the whole directory', workflowPaths({ workflows: null }).join() === '.github/workflows/');
check('a pull request never gets secrets', !getsSecrets({ ...repoCfg, secretsFile: '/s' }, prRun));
check('a push gets secrets only when a file is configured', getsSecrets({ ...repoCfg, secretsFile: '/s' }, pushRun) && !getsSecrets(repoCfg, pushRun));

console.log('\n=== act log ===');
const line = (o) => JSON.stringify({ level: 'info', time: '2026-10-07T17:58:39Z', ...o });
const LOG = [
  'not json',
  line({ job: 'CI/test', stage: 'Main', step: 'npm ci', stepResult: 'success' }),
  line({ job: 'CI/test', stage: 'Main', step: 'npm test', stepResult: 'success', time: '2026-10-07T17:58:59Z' }),
  line({ job: 'CI/test', jobResult: 'success', time: '2026-10-07T17:59:04Z' }),
  line({ job: 'Lint/lint', stage: 'Main', step: 'eslint', stepResult: 'failure' }),
  line({ job: 'Lint/lint', jobResult: 'failure' }),
  line({ job: 'Other/never-finished', stage: 'Main', step: 'x', stepResult: 'success' }),
].join('\n');
const jobs = parseActLog(LOG);
const byName = Object.fromEntries(jobs.map((j) => [j.name, j]));
check('the job name drops the workflow name', !!byName.test && !!byName.lint);
check('a passing job and its duration', byName.test.result === 'success' && byName.test.seconds === 25);
check('a failing job names its step', byName.lint.result === 'failure' && byName.lint.failedStep === 'eslint');
check('a job with no result is a failure', byName['never-finished'].result === 'failure');

check('a matrix job without a name is named as GitHub names it', githubJobName('test-2', 'test', { node: '22' }) === 'test (22)');
check('a job with its own name keeps it', githubJobName('test (ubuntu-latest, 20)', 'test', { os: 'ubuntu-latest', node: '20' }) === 'test (ubuntu-latest, 20)');
check('a job without a matrix keeps its name', githubJobName('build-1', 'build', {}) === 'build-1' && githubJobName('test', 'test', null) === 'test');
const matrixLog = parseActLog([
  line({ job: 'ci/test-1', jobID: 'test', matrix: { node: '20' }, jobResult: 'success' }),
  line({ job: 'ci/test-2', jobID: 'test', matrix: { node: '22' }, jobResult: 'failure' }),
].join('\n'));
check('act matrix jobs come out under GitHub names', matrixLog.map((j) => `${j.name}=${j.result}`).join() === 'test (20)=success,test (22)=failure');

console.log('\n=== statuses ===');
const ok = statusesFor(cfg, [byName.test], { exitCode: 0, timedOut: false, error: null });
check('a passing job and the run both succeed', ok.length === 2 && ok[0].context === 'box/test' && ok[0].state === 'success' && ok[1].context === 'box/ci' && ok[1].state === 'success');
const bad = statusesFor(cfg, jobs, { exitCode: 1, timedOut: false, error: null });
check('a failed job fails the run and is named', bad.find((s) => s.context === 'box/lint').state === 'failure' && bad.at(-1).state === 'failure' && bad.at(-1).description.includes('lint'));
check('a skipped job posts nothing', statusesFor(cfg, [{ name: 'win', result: 'skipped' }], { exitCode: 0 }).length === 1);
check('no job is a success that says so', statusesFor(cfg, [], { exitCode: 0 }).at(-1).description.includes('no job'));
check('act failing with no job is a failure', statusesFor(cfg, [], { exitCode: 2 }).at(-1).state === 'failure');
check('a time-out is an error', statusesFor(cfg, [], { exitCode: -1, timedOut: true }).at(-1).state === 'error');
check('every description fits GitHub', statusesFor(cfg, [], { error: 'x'.repeat(300) }).every((s) => s.description.length <= 140));

console.log('\n=== state ===');
let st = {};
for (let i = 0; i < 2005; i++) st = recordRun(st, `k${i}`, 'success', i);
check('the state keeps the newest runs only', Object.keys(st).length === 2000 && !st.k0 && !!st.k2004);
check('a secrets file of KEY=VALUE lines passes', validateSecretFile('A=1\n# note\n\nB_2=two=parts\n'));
check('anything else is refused', throws(() => validateSecretFile('export A=1\n'), /KEY=VALUE/));

console.log('\n=== GitHub client ===');
{
  const calls = [];
  const responses = [
    { status: 200, headers: { etag: 'W/"1"' }, body: [{ n: 1 }] },
    { status: 304, headers: {}, body: null },
    { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000' }, body: {} },
  ];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    return { status: r.status, ok: r.status >= 200 && r.status < 300, headers: { get: (k) => r.headers[k] ?? null }, json: async () => r.body };
  };
  const gh = makeGitHub('t0k', fakeFetch, () => 1_000_000);
  const first = await gh.call('GET', '/repos/a/b/pulls');
  const second = await gh.call('GET', '/repos/a/b/pulls');
  check('a 304 returns the cached answer', JSON.stringify(first) === JSON.stringify(second) && calls[1].init.headers['if-none-match'] === 'W/"1"');
  check('the token is in the header', calls[0].init.headers.authorization === 'Bearer t0k');
  let threw = false;
  try { await gh.call('GET', '/repos/a/b/branches/main'); } catch { threw = true; }
  let blocked = false;
  try { await gh.call('GET', '/repos/a/b/branches/main'); } catch (e) { blocked = /rate limit/.test(e.message); }
  check('a spent rate limit stops calls until it resets', threw && blocked && calls.length === 3);
}

console.log('\n=== one run end to end ===');
{
  const home = mkdtempSync(join(tmpdir(), 'box-ci-test-'));
  const posted = [];
  const gh = { call: async (method, path, body) => { posted.push({ method, path, body }); return {}; } };
  const fetcher = async (_repo, _sha, _branch, dir) => { mkdirSync(join(dir, 'repo', '.github', 'workflows'), { recursive: true }); };
  let seen;
  const actRunner = async (cmd, a, opts) => {
    seen = { cmd, a, opts, files: readdirSync(join(opts.cwd, '..')) };
    return { code: 0, out: LOG.split('\n').slice(0, 4).join('\n'), err: '', timedOut: false };
  };
  const outcome = await runOne({ cfg, repoCfg, run: prRun, gh, token: 't', home, account: null, actRunner, fetcher });
  check('the run succeeds', outcome === 'success');
  check('a pending status goes first, then the job, then the run',
    posted[0].body.state === 'pending' && posted[1].body.context === 'box/test' && posted.at(-1).body.context === 'box/ci' && posted.at(-1).body.state === 'success');
  check('statuses go to the commit', posted.every((p) => p.method === 'POST' && p.path === `/repos/askalf/sample/statuses/${SHA}`));
  check('act runs from the checkout with the event file beside it', seen.opts.cwd.endsWith('repo') && seen.files.includes('event.json'));
  check('a pull request run gets no secrets', !seen.a.includes('--secret-file') && !seen.files.includes('secrets.env'));
  check('the work directory is removed', readdirSync(join(home, 'work')).length === 0);
  check('the log is kept', existsSync(join(home, 'logs', 'askalf_sample', `pull_request-${SHA}.jsonl`)));

  const secrets = join(home, 'sample.env');
  writeFileSync(secrets, 'TOKEN=x\n');
  const pushCfg = { ...repoCfg, secretsFile: secrets, workflows: ['ci.yml', 'deploy.yml'] };
  const runs = [];
  const actRunner2 = async (cmd, a, opts) => { runs.push({ a, opts, files: readdirSync(join(opts.cwd, '..')) }); return { code: 0, out: '', err: '', timedOut: false }; };
  const withFiles = (names) => async (_repo, _sha, _branch, dir) => {
    mkdirSync(join(dir, 'repo', '.github', 'workflows'), { recursive: true });
    for (const n of names) writeFileSync(join(dir, 'repo', '.github', 'workflows', n), 'on: push\n');
  };
  await runOne({ cfg, repoCfg: pushCfg, run: pushRun, gh, token: 't', home, account: null, actRunner: actRunner2, fetcher: withFiles(['ci.yml', 'deploy.yml']) });
  check('a push run with a secrets file gets a copy for the run', runs[0].a.includes('--secret-file') && runs[0].files.includes('secrets.env'));
  check('listed workflows run one at a time', runs.length === 2 && runs[1].a.includes('.github/workflows/deploy.yml'));
  check('the copy goes with the work directory', readdirSync(join(home, 'work')).length === 0);
  check('each act process gets a scope of its own in the configured slice, as the run account',
    runs[0].opts.scope.slice === 'gha-exec.slice' && runs[0].opts.scope.unit !== runs[1].opts.scope.unit && /^box-ci-askalf_sample-push-bbbbbbbb-.+-0$/.test(runs[0].opts.scope.unit));
  check("each scope may live no longer than the job's limit plus a minute, with or without box-ci", runs[0].opts.scope.runtimeMaxSec === cfg.jobTimeoutMinutes * 60 + 60);
  check("act's HOME is the run's own, never the run account's", runs[0].opts.env.HOME.endsWith(join('home')) && runs[0].opts.env.HOME.includes('work'));

  // A scope that never started is box-ci's error, not the commit's failure.
  posted.length = 0;
  const notStarted = async () => ({ code: 1, out: '', err: 'Failed to start transient scope unit: Unit box-ci-x.scope already exists.\n', timedOut: false, launchError: 'Failed to start transient scope unit: Unit box-ci-x.scope already exists.' });
  const out6 = await runOne({ cfg, repoCfg: pushCfg, run: pushRun, gh, token: 't', home, account: null, actRunner: notStarted, fetcher: withFiles(['ci.yml', 'deploy.yml']) });
  check('a scope that could not start posts an error naming why, not "act exited 1"',
    out6 === 'error' && posted.at(-1).body.state === 'error' && posted.at(-1).body.description.includes('Failed to start transient scope unit') && !posted.some((p) => /act exited/.test(p.body.description)));

  // A listed workflow the commit lacks fails the run: no skip, and GitHub is asked nothing.
  const W = (n) => `.github/workflows/${n}`;
  const asks = () => posted.filter((p) => p.method !== 'POST').length;
  runs.length = 0;
  posted.length = 0;
  const out4 = await runOne({ cfg, repoCfg: pushCfg, run: pushRun, gh, token: 't', home, account: null, actRunner: actRunner2, fetcher: withFiles(['ci.yml']) });
  check('one listed workflow missing from the commit fails the run, and nothing runs, not even the present one',
    out4 === 'failure' && runs.length === 0 && posted.at(-1).body.context === 'box/ci' && posted.at(-1).body.state === 'failure'
    && posted.at(-1).body.description === 'workflow deploy.yml missing from this commit; rebase onto the default branch');
  check('the verdict comes from the commit alone: nothing is read from GitHub', asks() === 0 && posted.every((p) => p.path === `/repos/askalf/sample/statuses/${SHA2}`));
  runs.length = 0;
  posted.length = 0;
  const out5 = await runOne({ cfg, repoCfg: pushCfg, run: pushRun, gh, token: 't', home, account: null, actRunner: actRunner2, fetcher: withFiles([]) });
  check('every listed workflow missing fails the run: deleting CI does not pass CI',
    out5 === 'failure' && runs.length === 0 && posted.at(-1).body.state === 'failure'
    && posted.at(-1).body.description === 'workflow ci.yml, deploy.yml missing from this commit; rebase onto the default branch' && !posted.some((p) => p.body.state === 'success'));
  const prOut = await runOne({ cfg, repoCfg: pushCfg, run: prRun, gh, token: 't', home, account: null, actRunner: actRunner2, fetcher: withFiles(['deploy.yml']) });
  check('a pull request is judged the same way', prOut === 'failure' && runs.length === 0 && posted.at(-1).body.description.startsWith('workflow ci.yml missing from this commit'));
  const many = Array.from({ length: 12 }, (_, i) => `workflow-number-${i}-of-many.yml`);
  posted.length = 0;
  await runOne({ cfg, repoCfg: { ...pushCfg, workflows: many }, run: pushRun, gh, token: 't', home, account: null, actRunner: actRunner2, fetcher: withFiles([]) });
  check('a long list of missing workflows is clipped to the 140 characters a status description may have',
    posted.at(-1).body.state === 'failure' && posted.at(-1).body.description.length === 140 && posted.at(-1).body.description.endsWith('...'));
  runs.length = 0;
  posted.length = 0;
  const out7 = await runOne({ cfg, repoCfg: pushCfg, run: pushRun, gh, token: 't', home, account: null, actRunner: actRunner2, fetcher: withFiles(['ci.yml', 'deploy.yml']) });
  check('with none missing, every listed workflow runs', out7 === 'success' && runs.length === 2 && runs[0].a.includes(W('ci.yml')) && runs[1].a.includes(W('deploy.yml')));
  runs.length = 0;
  await runOne({ cfg, repoCfg: { ...pushCfg, workflows: null }, run: pushRun, gh, token: 't', home, account: null, actRunner: actRunner2, fetcher: withFiles([]) });
  check('without a list nothing can be missing: act takes the whole directory', runs.length === 1 && runs[0].a.includes('.github/workflows/'));
  runs.length = 0;
  await runOne({ cfg: { ...cfg, scope: false }, repoCfg: pushCfg, run: pushRun, gh, token: 't', home, account: null, actRunner: actRunner2, fetcher: withFiles(['ci.yml', 'deploy.yml']) });
  check('scope: false runs act directly', runs.length === 2 && runs[0].opts.scope === undefined);

  posted.length = 0;
  const broken = async () => { throw new Error('git fetch failed: not found'); };
  const out3 = await runOne({ cfg, repoCfg, run: prRun, gh, token: 't', home, account: null, actRunner, fetcher: broken });
  check('a fetch that fails posts an error for the run', out3 === 'error' && posted.at(-1).body.state === 'error' && posted.at(-1).body.description.includes('not found'));
  rmSync(home, { recursive: true, force: true });
}

console.log('\n=== what happens when a run ends ===');
{
  const job = { key: 'a/b@push@x' };
  const steps = [];
  const ok = finishRun({ state: {}, job, outcome: 'success', error: null, record: true, save: (next) => steps.push(`save ${Object.keys(next).join()}`), settle: () => steps.push('settle'), logger: () => {} });
  check('the next state is saved, then taken, then the run is settled', steps.join('|') === 'save a/b@push@x|settle' && ok.saved && ok.state['a/b@push@x'].outcome === 'success');
  const before = { old: { outcome: 'success', at: 1 } };
  const said = [];
  let settled = 0;
  const bad = finishRun({ state: before, job, outcome: 'success', error: null, record: true, save: () => { throw new Error('ENOSPC'); }, settle: () => { settled++; }, logger: (m) => said.push(m) });
  check('a save that fails leaves the state in memory as it was, so the run is planned again, and says so',
    bad.state === before && bad.saved === false && said[0] === 'state not saved after a/b@push@x: ENOSPC');
  check('the run is still settled when the save fails', settled === 1);
  let saves = 0;
  const threw = finishRun({ state: before, job, outcome: 'error', error: new Error('boom'), record: true, save: () => { saves++; }, settle: () => { settled++; }, logger: () => {} });
  check('a run that threw is not recorded, and is settled', saves === 0 && threw.state === before && threw.saved && settled === 2);
  check('a dry run records nothing', finishRun({ state: before, job, outcome: 'success', error: null, record: false, save: () => { saves++; }, settle: () => {}, logger: () => {} }).state === before && saves === 0);
  check('a description is clipped to 140 characters', clip('x'.repeat(200)).length === 140 && clip('short') === 'short');
}

console.log('\n=== the scope around act ===');
{
  const a = scopeArgs({ unit: 'box-ci-x-0', slice: 'gha-exec.slice', account: { uid: 990, gid: 982 }, runtimeMaxSec: 1860 }, '/opt/box-ci/act', ['push', '-W', 'w.yml']);
  check('systemd-run gets the scope, its description, slice and time limit, then setpriv switches to the account and runs act unchanged',
    JSON.stringify(a) === JSON.stringify(['--scope', '--quiet', '--collect', '--unit=box-ci-x-0', '--description=box-ci workflow', '--slice=gha-exec.slice',
      '-p', 'RuntimeMaxSec=1860', '--', '/usr/bin/setpriv', '--reuid=990', '--regid=982', '--clear-groups', '--', '/opt/box-ci/act', 'push', '-W', 'w.yml']));
  check("systemd-run is never asked to switch user, so it never sets HOME from the account's passwd entry", !a.some((x) => /^--(uid|gid)=/.test(x)));
  check('the scope description is fixed, so act arguments such as --var values never become the unit description in the journal',
    scopeArgs({ unit: 'u', slice: 's.slice', account: null }, 'act', ['--var', 'K=secretish']).filter((x) => x.startsWith('--description')).join() === '--description=box-ci workflow');
  check('without an account no user switch is asked for', !scopeArgs({ unit: 'u', slice: 's.slice', account: null }, 'act', []).some((x) => x.startsWith('--uid')));
  check('a unit name keeps only characters systemd allows', scopeUnit('/var/lib/box-ci/work/askalf_shop-push-1234abcd-Zq9', 2) === 'box-ci-askalf_shop-push-1234abcd-Zq9-2');

  const fakeChild = () => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.killed = [];
    c.kill = (sig) => { c.killed.push(sig); };
    return c;
  };
  let spawned;
  let child = fakeChild();
  const killed = [];
  const spawnImpl = (cmd, args, opts) => { spawned = { cmd, args, opts }; return child; };
  const p = run('/opt/box-ci/act', ['push'], { cwd: '/w', uid: 990, gid: 982, spawnImpl, killScope: (u) => killed.push(u), scope: { unit: 'box-ci-r-0', slice: 'gha-exec.slice', account: { uid: 990, gid: 982 } } });
  child.stdout.emit('data', 'out');
  child.emit('exit', 0);
  child.emit('close', 0);
  const done = await p;
  check('a scoped run spawns systemd-run as root, the account switched by setpriv inside the scope',
    spawned.cmd === 'systemd-run' && spawned.args.includes('--reuid=990') && spawned.opts.uid === undefined && spawned.opts.gid === undefined && spawned.opts.cwd === '/w');
  check('when act exits, its whole scope is killed, taking whatever it left running', killed.join() === 'box-ci-r-0' && done.code === 0 && done.out === 'out');

  child = fakeChild();
  killed.length = 0;
  const p2 = run('/opt/box-ci/act', ['push'], { spawnImpl, killScope: (u) => killed.push(u), timeoutMs: 20, scope: { unit: 'box-ci-r-1', slice: 'gha-exec.slice', account: null } });
  await new Promise((r) => setTimeout(r, 60));
  check('at the time limit the scope is killed, not only act', killed[0] === 'box-ci-r-1' && child.killed.includes('SIGKILL'));
  child.emit('exit', null);
  child.emit('close', null);
  const done2 = await p2;
  check('and the run reports that it timed out', done2.timedOut === true);

  child = fakeChild();
  killed.length = 0;
  const p3 = run('act', ['push'], { uid: 990, gid: 982, spawnImpl, killScope: (u) => killed.push(u) });
  child.emit('exit', 0);
  child.emit('close', 0);
  await p3;
  check('without a scope act is spawned directly as the account, and no scope is killed', spawned.cmd === 'act' && spawned.opts.uid === 990 && killed.length === 0);
  check('done.launchError is null for a scoped run that reached act', done.launchError === null);

  child = fakeChild();
  const p4 = run('/opt/box-ci/act', ['push'], { spawnImpl, killScope: () => {}, scope: { unit: 'u', slice: 's.slice', account: null } });
  child.emit('error', Object.assign(new Error('spawn systemd-run ENOENT'), { code: 'ENOENT' }));
  const done4 = await p4;
  check('a host without systemd-run on scope: true is a launch error', /could not start systemd-run: spawn systemd-run ENOENT/.test(done4.launchError));
  child = fakeChild();
  const p5 = run('/opt/box-ci/act', ['push'], { spawnImpl, killScope: () => {}, scope: { unit: 'u', slice: 's.slice', account: null } });
  child.stderr.emit('data', 'Failed to start transient scope unit: Access denied\n');
  child.emit('exit', 1);
  child.emit('close', 1);
  const done5 = await p5;
  check('systemd-run refusing the scope is a launch error with its own words', done5.launchError === 'Failed to start transient scope unit: Access denied');

  check('a run that reached act and failed is not a launch failure',
    launchFailure({ code: 1, out: '{"job":"ci/test","jobResult":"failure"}\n', err: 'Error: Job failed\n' }) === null
    && launchFailure({ code: 0, out: '', err: '' }) === null
    && launchFailure({ code: 1, out: '', err: 'Error: workflow is not valid\n' }) === null);
  check('setpriv failing to switch is a launch failure', launchFailure({ code: 127, out: '', err: 'setpriv: failed to execute /opt/box-ci/act: No such file or directory\n' }).startsWith('setpriv:'));
}

{
  const unit = readFileSync(new URL('./box-ci.service', import.meta.url), 'utf8');
  check('the unit kills every box-ci scope before box-ci starts and after it stops, a sweep that finds none passing',
    /^ExecStartPre=-\/usr\/bin\/systemctl kill --signal=SIGKILL box-ci-\*\.scope$/m.test(unit) && /^ExecStopPost=-\/usr\/bin\/systemctl kill --signal=SIGKILL box-ci-\*\.scope$/m.test(unit));
}

console.log('\n=== the run queue ===');
{
  const serial = { repo: 'askalf/shop', serial: true };
  const plain = { repo: 'askalf/sample', serial: false };
  const prJob = (repoCfg, n, sha) => ({ key: `${repoCfg.repo}@pull_request@${sha}`, repoCfg, run: { event: 'pull_request', sha, pr: { number: n } } });
  const pushJob = (repoCfg, sha) => ({ key: `${repoCfg.repo}@push@${sha}`, repoCfg, run: { event: 'push', sha, branch: 'main' } });

  const { queue: kept, dropped } = supersede([prJob(serial, 4, 'old'), prJob(serial, 5, 'x'), prJob(plain, 4, 'y'), pushJob(serial, 'old')], prJob(serial, 4, 'new'));
  check("a newer head drops only the same pull request's waiting runs, in the same repository",
    dropped.map((j) => j.run.sha).join() === 'old' && dropped[0].run.event === 'pull_request' && kept.length === 3);
  check('a push run supersedes nothing', supersede([prJob(serial, 4, 'a')], pushJob(serial, 'b')).dropped.length === 0);

  const tick = () => new Promise((r) => setImmediate(r));
  const pending = new Map();
  const started = [];
  const finished = [];
  const sched = createScheduler({
    concurrency: 2,
    start: (job) => new Promise((resolve) => { started.push(job.key); pending.set(job.key, resolve); }),
    onFinish: (job, outcome) => finished.push(`${job.key}=${outcome}`),
  });
  // The same commit as a pull request and as a push on a serial repository: never both at once.
  sched.enqueue(prJob(serial, 7, 'abc'));
  sched.enqueue(pushJob(serial, 'abc'));
  sched.pump();
  await tick();
  check('a serial repository runs one of its jobs at a time, even the same commit as pull request and push',
    started.length === 1 && sched.inFlight('askalf/shop') === 1 && sched.queued === 1);
  sched.enqueue(pushJob(plain, 'p1'));
  sched.pump();
  await tick();
  check("another repository's job behind it starts in the free slot", started.length === 2 && started[1] === 'askalf/sample@push@p1');
  pending.get(started[0])('success');
  await tick();
  await tick();
  check('when the serial job finishes, the queue moves on by itself and starts the next one',
    finished[0] === 'askalf/shop@pull_request@abc=success' && started.length === 3 && started[2] === 'askalf/shop@push@abc' && sched.inFlight('askalf/shop') === 1);
  // A newer head of a pull request replaces its waiting run, not one already running.
  sched.enqueue(prJob(serial, 8, 'h1'));
  const gone = sched.enqueue(prJob(serial, 8, 'h2'));
  check('a newer pull request head drops the waiting older one and keeps the running jobs', gone.length === 1 && gone[0].run.sha === 'h1' && sched.queued === 1 && sched.running === 2);
  pending.get('askalf/shop@push@abc')('failure');
  pending.get('askalf/sample@push@p1')('success');
  await tick();
  await tick();
  check('the newer head runs next', started.at(-1) === 'askalf/shop@pull_request@h2' && sched.inFlight('askalf/shop') === 1);
  sched.stop();
  sched.enqueue(pushJob(plain, 'p2'));
  sched.pump();
  await tick();
  check('a stopped queue starts nothing new', !started.includes('askalf/sample@push@p2'));
  const logged = [];
  const errors = [];
  const crashing = createScheduler({ concurrency: 1, start: async () => { throw new Error('boom'); }, onFinish: (job, outcome, error) => { finished.push(`crash=${outcome}`); errors.push(error); }, logger: (m) => logged.push(m) });
  crashing.enqueue(pushJob(plain, 'c'));
  crashing.pump();
  await tick();
  await tick();
  check('a job that throws counts as an error, frees its slot, and is logged by its key',
    finished.includes('crash=error') && crashing.running === 0 && logged.includes('run askalf/sample@push@c: boom'));
  check('onFinish is told it threw, so the run is not recorded and the next poll plans it again', errors[0]?.message === 'boom');

  const order = [];
  const fragile = createScheduler({
    concurrency: 1,
    start: async (job) => { order.push(job.key); return 'success'; },
    onFinish: (job) => { if (job.key.endsWith('@1')) throw new Error('disk full'); },
    logger: (m) => logged.push(m),
  });
  fragile.enqueue(pushJob(plain, '1'));
  fragile.enqueue(pushJob(plain, '2'));
  fragile.pump();
  for (let i = 0; i < 6; i++) await tick();
  check('an onFinish that throws is logged and the queue still moves on',
    order.join() === 'askalf/sample@push@1,askalf/sample@push@2' && logged.includes('after run askalf/sample@push@1: disk full') && fragile.running === 0);
}

// Values from a workflow author or GitHub that are objects with a toString key which is not a function:
// String(), a template literal and Date.parse() throw on them, so none may reach those.
{
  const evil = { toString: 1 };
  const actEvil = parseActLog([
    JSON.stringify({ job: 'CI/test', jobID: 'test', matrix: { os: evil, list: [evil, null, 1], n: 2 }, step: evil, stepResult: 'failure', time: evil }),
    JSON.stringify({ job: 'CI/test', jobID: 'test', jobResult: 'failure', time: '2026-11-03T10:00:09Z' }),
  ].join('\n'));
  check('an act log with object-valued step, time and matrix fields is read without throwing', actEvil.length === 1 && actEvil[0].failedStep === null && actEvil[0].seconds === 0);
  check('a matrix job name keeps String() text for a list and an object', githubJobName('test-1', 'test', { a: ['x', null, 1], b: { c: 1 } }) === 'test (x,,1, [object Object])');
  check('a matrix job name with values that cannot be strings does not throw', githubJobName('test-1', 'test', { a: { toString: 1 }, b: [evil] }) === 'test ([object Object], [object Object])');
  check('a config label that is not text is an Error naming it', throws(() => parseConfig({ repos: [{ repo: 'a/b', labels: [evil] }] }), /^config: a\/b: labels must be text/));
  check('a config var that is not text is an Error naming it', throws(() => parseConfig({ repos: [{ repo: 'a/b', vars: { K: evil } }] }), /vars\.K must be text/));
  check('a config event that is an object is an Error, not a TypeError', throws(() => parseConfig({ repos: [{ repo: 'a/b', events: [evil] }] }), /^config: a\/b: unsupported event \{"toString":1\}/));
  const polled = planRuns(repoCfg, [{ head: { sha: evil, repo: { full_name: 'askalf/sample' } } }, { head: { sha: SHA, repo: { full_name: 'askalf/sample' } } }],
    [{ branch: 'main', sha: [evil] }, { branch: evil, sha: SHA }, { branch: 'main', sha: SHA2 }], {}, new Set());
  check('a pull request or branch head whose sha or branch is not text is not planned', polled.length === 2 && polled[0].sha === SHA && polled[1].sha === SHA2);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
