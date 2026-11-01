// node --test runners/pitlane-build-guard.test.mjs
// The root rows' job-started hook in bash with stub logger, systemctl and sleep on PATH: it kills only a stub parent.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, 'pitlane-build-guard.sh');
const SRC = readFileSync(GUARD, 'utf8');
const LIST = 'askalf/app main web-deploy.yml\naskalf/dario master compat-test-self-hosted.yml\n';
// The bootstrap deploy, as a host's environment file sets it (PITLANE_BUILD_BOOTSTRAP).
const BOOTSTRAP = 'askalf/app main host-deploy.yml';
// LIST with the bootstrap deploy on it, as a host's list has it, so a refusal below is for the reason
// under test and not for a line the list lacks.
const WITH_DEPLOY = `${LIST}${BOOTSTRAP}\n`;
const EXAMPLE = readFileSync(join(HERE, 'examples', 'runners.build-allow'), 'utf8');
const EXAMPLE_ENV = readFileSync(join(HERE, 'examples', 'pitlane-build.env'), 'utf8');
const HINT = 'This runner runs only the workflows on its list, each on the branch the list names: any other job stops here, before its first step.';
const linux = { skip: process.platform !== 'linux' && 'the walk to the worker reads /proc' };

/** The GITHUB_* values the runner gives the hook for a job of `file` in `repo` on `branch`. */
function job({ repo = 'askalf/app', branch = 'main', file = 'web-deploy.yml', event = 'workflow_dispatch' } = {}) {
  return {
    GITHUB_EVENT_NAME: event,
    GITHUB_REPOSITORY: repo,
    GITHUB_REF: `refs/heads/${branch}`,
    GITHUB_WORKFLOW_REF: `${repo}/.github/workflows/${file}@refs/heads/${branch}`,
  };
}

/**
 * Run the guard for a job with `vars` (an undefined value leaves that variable unset). `list` is the allow
 * list (null: no file, 'link': a symlink to LIST), `bootstrap` the bootstrap deploy (null: unset),
 * `cgroup` the line it reads as its own cgroup, and
 * `parent: true` runs it under a stub worker named pl-test-worker (Linux only). Otherwise the worker it looks
 * for is a name no process has, so a refusal never reaches the Runner.Worker of a CI job running this test.
 * Returns the outcome, the output and what the stubs saw, or null when the box cannot make a symlink.
 */
function guard(vars, { list = LIST, bootstrap = BOOTSTRAP, cgroup = '0::/system.slice/ssh.service', parent = false, row = 'app-build-e1' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-')).split(sep).join('/');
  mkdirSync(`${dir}/bin`);
  for (const name of ['logger', 'systemctl', 'sleep']) writeFileSync(`${dir}/bin/${name}`, `#!/bin/sh\necho "$*" >> '${dir}/${name}.calls'\n`, { mode: 0o755 });
  if (list === 'link') {
    writeFileSync(`${dir}/real-allow`, LIST);
    try { symlinkSync(`${dir}/real-allow`, `${dir}/allow`); } catch { rmSync(dir, { recursive: true, force: true }); return null; }   // no symlink right on this box
  } else if (list !== null) {
    writeFileSync(`${dir}/allow`, list);
  }
  writeFileSync(`${dir}/cgroup`, `${cgroup}\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GITHUB_|PITLANE_|RUNNER_)/.test(k)));
  Object.assign(env, {
    PATH: `${dir}/bin:${process.env.PATH}`,
    PITLANE_BUILD_ALLOW: `${dir}/allow`,
    PITLANE_CGROUP: `${dir}/cgroup`,
    PITLANE_RUNNER_WORKER: parent ? 'pl-test-worker' : 'pl-no-such-proc',
    RUNNER_NAME: row,
  });
  if (bootstrap !== null) env.PITLANE_BUILD_BOOTSTRAP = bootstrap;
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete env[k]; else env[k] = v;
  let r;
  if (parent) {
    // A shebang script's process name is the script's file name, as Runner.Worker's is its binary's.
    writeFileSync(`${dir}/pl-test-worker`, '#!/bin/bash\nbash -e "$1"\necho "guard-exit=$?"\n', { mode: 0o755 });
    r = spawnSync(`${dir}/pl-test-worker`, [GUARD], { env, encoding: 'utf8' });
  } else {
    r = spawnSync('bash', ['-e', GUARD], { env, encoding: 'utf8' });
  }
  const calls = (name) => (existsSync(`${dir}/${name}.calls`) ? readFileSync(`${dir}/${name}.calls`, 'utf8') : '');
  const res = { status: r.status, signal: r.signal, text: `${r.stdout}${r.stderr}`, logger: calls('logger'), systemctl: calls('systemctl'), sleep: calls('sleep') };
  rmSync(dir, { recursive: true, force: true });
  return res;
}

/** The job ran: one line on the run page and one in the journal, no wait and nothing killed. */
function assertRan(r, line, what = line) {
  assert.equal(r.status, 0, `${what}: ${r.text}`);
  assert.equal(r.text, `pitlane build guard: ${line}\n`, what);
  assert.equal(r.logger, `-t pitlane-build-guard -- app-build-e1: ran: ${line.replace(/ (is on|runs without) .*$/, '')}\n`, what);
  assert.equal(r.sleep, '', what);
  assert.equal(r.systemctl, '', what);
}

/** The job was refused: `reason` (a string, or a RegExp it matches) as the error annotation, the hint, the journal line and the 5 s wait. */
function assertRefused(r, reason, what = String(reason)) {
  assert.equal(r.status, 1, `${what}: ${r.text}`);
  const [first, second = ''] = r.text.split('\n');
  const said = first.replace(/^::error title=pitlane build guard::/, '');
  assert.notEqual(said, first, `${what}: no error annotation: ${r.text}`);
  if (reason instanceof RegExp) assert.match(said, reason, what); else assert.equal(said, reason, what);
  assert.equal(second, HINT, `${what}: ${r.text}`);
  assert.equal(r.logger, `-t pitlane-build-guard -- app-build-e1: refused: ${said}\n`, what);
  assert.equal(r.sleep, '5\n', what);
}

const notListed = (repo, file, branch) => `${repo} ${file} on ${branch} is not on this runner's list`;
const notEvent = (event) => `a ${event} job never runs on this runner: only push, schedule and workflow_dispatch jobs do`;

test('a listed workflow runs on its branch for a dispatch, a schedule or a push', () => {
  for (const event of ['workflow_dispatch', 'schedule', 'push']) {
    assertRan(guard(job({ event })), `askalf/app web-deploy.yml on main (${event}) is on this runner's list`, event);
  }
  const dario = job({ repo: 'askalf/dario', branch: 'master', file: 'compat-test-self-hosted.yml', event: 'push' });
  assertRan(guard(dario), "askalf/dario compat-test-self-hosted.yml on master (push) is on this runner's list");
});

test('the bootstrap deploy runs with no list, a symlinked list or a list without it', () => {
  const floor = job({ file: 'host-deploy.yml' });
  const line = 'askalf/app host-deploy.yml on main (workflow_dispatch) runs without the list: it is the deploy that installs it';
  assertRan(guard(floor, { list: null }), line, 'no list');
  assertRan(guard(floor), line, 'a list without it');
  const linked = guard(floor, { list: 'link' });
  if (linked !== null) assertRan(linked, line, 'a symlinked list');
  assertRan(guard({ ...floor, GITHUB_EVENT_NAME: 'push' }, { list: null }), line.replace('workflow_dispatch', 'push'), 'a push');
});

test('the bootstrap deploy\'s workflow from another branch or repository, or for another event, is refused like any job', () => {
  assertRefused(guard(job({ file: 'host-deploy.yml', branch: 'fix' }), { list: WITH_DEPLOY }), notListed('askalf/app', 'host-deploy.yml', 'fix'));
  assertRefused(guard(job({ repo: 'askalf/dario', file: 'host-deploy.yml' }), { list: WITH_DEPLOY }), notListed('askalf/dario', 'host-deploy.yml', 'main'));
  assertRefused(guard(job({ file: 'host-deploy.yml', event: 'pull_request' }), { list: null }), notEvent('pull_request'));
});

test('a job for any event but push, schedule and workflow_dispatch is refused before the list is read', () => {
  for (const event of ['pull_request', 'pull_request_target', 'workflow_run', 'repository_dispatch', 'issue_comment', 'merge_group', 'release']) {
    assertRefused(guard(job({ event }), { list: WITH_DEPLOY }), notEvent(event), event);
  }
  // A fork's pull request on the public dario names the base repository and a pull ref.
  const fork = {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_REPOSITORY: 'askalf/dario',
    GITHUB_REF: 'refs/pull/12/merge',
    GITHUB_WORKFLOW_REF: 'askalf/dario/.github/workflows/compat-test-self-hosted.yml@refs/pull/12/merge',
  };
  assertRefused(guard(fork, { list: WITH_DEPLOY }), notEvent('pull_request'), 'a fork pull request');
});

test('a tag, another branch, an unlisted workflow or another repository is refused', () => {
  const tag = { ...job(), GITHUB_REF: 'refs/tags/v1', GITHUB_WORKFLOW_REF: 'askalf/app/.github/workflows/web-deploy.yml@refs/tags/v1' };
  assertRefused(guard(tag), 'GITHUB_REF is not a branch', 'a tag');
  assertRefused(guard(job({ branch: 'feature/x' })), notListed('askalf/app', 'web-deploy.yml', 'feature/x'));
  assertRefused(guard(job({ file: 'evil.yml' })), notListed('askalf/app', 'evil.yml', 'main'));
  assertRefused(guard(job({ repo: 'askalf/cordon' })), notListed('askalf/cordon', 'web-deploy.yml', 'main'));
  assertRefused(guard(job({ repo: 'askalf/dario', file: 'compat-test-self-hosted.yml' })), notListed('askalf/dario', 'compat-test-self-hosted.yml', 'main'));
});

test('a workflow ref that is not a workflow file of the job\'s repository on its ref is refused', () => {
  const other = 'GITHUB_WORKFLOW_REF is not a workflow of askalf/app on main';
  const notFile = 'GITHUB_WORKFLOW_REF does not name a workflow file of askalf/app';
  for (const [what, wref, reason] of [
    ['another repository', 'askalf/cordon/.github/workflows/web-deploy.yml@refs/heads/main', other],
    ['another branch', 'askalf/app/.github/workflows/web-deploy.yml@refs/heads/feature', other],
    ['a pull ref', 'askalf/app/.github/workflows/web-deploy.yml@refs/pull/3/merge', other],
    ['outside .github/workflows', 'askalf/app/ci/web-deploy.yml@refs/heads/main', other],
    ['empty', '', other],
    ['a subdirectory', 'askalf/app/.github/workflows/sub/web-deploy.yml@refs/heads/main', notFile],
    ['a second ref', 'askalf/app/.github/workflows/web-deploy.yml@refs/heads/main@refs/heads/main', notFile],
    ['not a workflow file', 'askalf/app/.github/workflows/web-deploy.sh@refs/heads/main', notFile],
  ]) {
    assertRefused(guard({ ...job(), GITHUB_WORKFLOW_REF: wref }, { list: WITH_DEPLOY }), reason, what);
  }
});

test('a job with any of its four values unset is refused', () => {
  for (const [name, reason] of [
    ['GITHUB_EVENT_NAME', 'GITHUB_EVENT_NAME is not an event name'],
    ['GITHUB_REPOSITORY', 'GITHUB_REPOSITORY is not a repository name'],
    ['GITHUB_REF', 'GITHUB_REF is not a branch'],
    ['GITHUB_WORKFLOW_REF', 'GITHUB_WORKFLOW_REF is not a workflow of askalf/app on main'],
  ]) {
    assertRefused(guard({ ...job(), [name]: undefined }, { list: WITH_DEPLOY }), reason, name);
  }
});

test('the run page names no file, path or account of the host: dario\'s run pages are public', () => {
  for (const r of [guard(job()), guard(job({ file: 'evil.yml' }), { list: null }), guard(job({ event: 'pull_request' }))]) {
    assert.doesNotMatch(r.text, /root|\/etc|\/opt|askalf\/pitlane|build-allow|ops-tier|\/allow\b/, r.text);
  }
});

test('a value of the wrong shape is refused and never printed, so no line of the output is a job\'s workflow command', () => {
  for (const [what, vars, reason] of [
    ['an event in capitals', { GITHUB_EVENT_NAME: 'Push' }, 'GITHUB_EVENT_NAME is not an event name'],
    ['a second line in the event', { GITHUB_EVENT_NAME: 'push\n::notice::injected' }, 'GITHUB_EVENT_NAME is not an event name'],
    ['a second line in the repository', { GITHUB_REPOSITORY: 'askalf/app\n::notice::injected' }, 'GITHUB_REPOSITORY is not a repository name'],
    [
      'a workflow command in the branch',
      { GITHUB_REF: 'refs/heads/::notice::injected', GITHUB_WORKFLOW_REF: 'askalf/app/.github/workflows/web-deploy.yml@refs/heads/::notice::injected' },
      'GITHUB_REF is not a branch',
    ],
    ['a workflow command in the file', { GITHUB_WORKFLOW_REF: 'askalf/app/.github/workflows/::notice::injected.yml@refs/heads/main' }, 'GITHUB_WORKFLOW_REF does not name a workflow file of askalf/app'],
  ]) {
    const r = guard({ ...job(), ...vars }, { list: WITH_DEPLOY });
    assertRefused(r, reason, what);
    assert.doesNotMatch(`${r.text}${r.logger}`, /injected/, what);
  }
  const named = guard(job(), { row: 'row\n::notice::injected' });
  assert.equal(named.status, 0, named.text);
  assert.equal(named.logger, "-t pitlane-build-guard -- ?: ran: askalf/app web-deploy.yml on main (workflow_dispatch)\n", 'a runner name that is not a row name');
});

test('the list skips comments, blank lines and spacing; a line with a CR or a fourth field matches no job', () => {
  const ran = "askalf/app web-deploy.yml on main (workflow_dispatch) is on this runner's list";
  assertRan(guard(job(), { list: '# the list\n\n\taskalf/app \t main  web-deploy.yml   # a trailing comment\n' }), ran, 'spacing and comments');
  assertRan(guard(job(), { list: 'askalf/app main web-deploy.yml' }), ran, 'no final newline');
  for (const [what, list] of [
    ['a CR', 'askalf/app main web-deploy.yml\r\n'],
    ['a fourth field', 'askalf/app main web-deploy.yml extra\n'],
    ['the fields out of order', 'askalf/app web-deploy.yml main\n'],
    ['a commented line', '# askalf/app main web-deploy.yml\n'],
  ]) {
    assertRefused(guard(job(), { list }), notListed('askalf/app', 'web-deploy.yml', 'main'), what);
  }
});

test('with no list, or a symlinked one, only the bootstrap deploy runs', () => {
  for (const list of [null, 'link']) {
    const r = guard(job(), { list });
    if (r === null) continue;
    assertRefused(r, `${notListed('askalf/app', 'web-deploy.yml', 'main')} (the list is missing or not a plain file, so only the bootstrap deploy runs)`, String(list));
  }
});

test('with no bootstrap set the host deploy needs its line like any job, and with no list no job runs', () => {
  const floor = job({ file: 'host-deploy.yml' });
  const none = ' (the list is missing or not a plain file, so no job runs)';
  assertRefused(guard(floor, { bootstrap: null }), notListed('askalf/app', 'host-deploy.yml', 'main'), 'a list without it');
  assertRan(guard(floor, { bootstrap: null, list: WITH_DEPLOY }), "askalf/app host-deploy.yml on main (workflow_dispatch) is on this runner's list", 'a list with it');
  assertRefused(guard(floor, { bootstrap: null, list: null }), `${notListed('askalf/app', 'host-deploy.yml', 'main')}${none}`, 'no list');
  assertRefused(guard(job(), { bootstrap: '', list: null }), `${notListed('askalf/app', 'web-deploy.yml', 'main')}${none}`, 'set empty');
});

test('a bootstrap of any other shape names no job: it counts as unset', () => {
  const floor = job({ file: 'host-deploy.yml' });
  const refused = `${notListed('askalf/app', 'host-deploy.yml', 'main')} (the list is missing or not a plain file, so no job runs)`;
  for (const [what, bootstrap] of [
    ['double spacing', 'askalf/app  main host-deploy.yml'],
    ['a leading space', ` ${BOOTSTRAP}`],
    ['a CR', `${BOOTSTRAP}\r`],
    ['a second line', `${BOOTSTRAP}\naskalf/app main web-deploy.yml`],
    ['a fourth field', `${BOOTSTRAP} extra`],
    ['the fields out of order', 'askalf/app host-deploy.yml main'],
    ['quoted', `"${BOOTSTRAP}"`],
    ['a glob', 'askalf/app main *'],
    ['no repository owner', 'app main host-deploy.yml'],
  ]) {
    assertRefused(guard(floor, { bootstrap, list: null }), refused, what);
  }
});

test('with no worker among its parents a refusal kills its build unit, and never another unit', () => {
  const unit = 'gha-ephemeral-build@app-build-e1.service';
  const r = guard(job({ file: 'evil.yml' }), { cgroup: `0::/gha.slice/gha-build.slice/${unit}` });
  assertRefused(r, notListed('askalf/app', 'evil.yml', 'main'));
  assert.equal(r.systemctl, `kill --signal=SIGKILL -- ${unit}\n`);
  for (const cgroup of [
    '0::/system.slice/ssh.service',
    '0::/gha.slice/gha-exec.slice/gha-ephemeral-first-party@pitlane-exec-e1.service',
    '0::/gha.slice/gha-build.slice/gha-ephemeral-build@x;y.service',
    '',
  ]) {
    const other = guard(job({ file: 'evil.yml' }), { cgroup });
    assert.equal(other.status, 1, cgroup);
    assert.equal(other.systemctl, '', cgroup);
  }
});

test('a refusal kills the worker that started the guard, after the wait, so no step of the job runs', linux, () => {
  const r = guard(job({ file: 'evil.yml' }), { parent: true });
  assert.equal(r.signal, 'SIGKILL', r.text);
  assert.ok(r.text.startsWith(`::error title=pitlane build guard::${notListed('askalf/app', 'evil.yml', 'main')}\n`), r.text);
  assert.doesNotMatch(r.text, /guard-exit=/, 'the worker went on after the guard');
  assert.equal(r.sleep, '5\n');
  assert.equal(r.systemctl, '');
});

test('a listed job leaves the worker running', linux, () => {
  const r = guard(job(), { parent: true });
  assert.equal(r.status, 0, r.text);
  assert.match(r.text, /^guard-exit=0$/m);
});

test('the example list: three fields a line, no CR, no line twice, and each runs', () => {
  assert.ok(!EXAMPLE.includes('\r'));
  const lines = EXAMPLE.split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  assert.ok(lines.length > 1);
  assert.equal(new Set(lines.map((l) => l.split(/\s+/).join(' '))).size, lines.length, 'a line twice');
  for (const line of lines) {
    const [repo, branch, file, ...rest] = line.split(/\s+/);
    assert.equal(rest.length, 0, line);
    assert.match(repo, /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, line);
    assert.match(branch, /^[A-Za-z0-9._/-]+$/, line);
    assert.match(file, /^[A-Za-z0-9._-]+\.ya?ml$/, line);
    const r = guard(job({ repo, branch, file, event: 'push' }), { list: EXAMPLE });
    assert.equal(r.status, 0, `${line}: ${r.text}`);
  }
});

test('the build rows read the bootstrap from an optional settings file, and the example\'s is a deploy of the example list', () => {
  const unit = readFileSync(join(HERE, 'gha-ephemeral-build@.service'), 'utf8');
  assert.match(unit, /^EnvironmentFile=-\/etc\/askalf\/pitlane-build\.env$/m, 'optional: a host without it runs every job by the list');
  assert.ok(!EXAMPLE_ENV.includes('\r'));
  const set = EXAMPLE_ENV.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.equal(set.length, 1, 'one setting');
  const m = /^PITLANE_BUILD_BOOTSTRAP="([^"]*)"$/.exec(set[0]);
  assert.ok(m, set[0]);
  const [repo, branch, file] = m[1].split(' ');
  const deploy = job({ repo, branch, file, event: 'push' });
  assertRan(guard(deploy, { bootstrap: m[1], list: null }), `${repo} ${file} on ${branch} (push) runs without the list: it is the deploy that installs it`);
  assertRan(guard(deploy, { bootstrap: null, list: EXAMPLE }), `${repo} ${file} on ${branch} (push) is on this runner's list`, 'and the example list has it, as a host\'s does');
});

test('the defaults are the host\'s: the deployed list, no bootstrap, the runner\'s worker and the guard\'s own cgroup; it waits before it kills', () => {
  assert.match(SRC, /^allow="\$\{PITLANE_BUILD_ALLOW:-\/etc\/askalf\/runners\.build-allow\}"$/m);
  assert.match(SRC, /^bootstrap="\$\{PITLANE_BUILD_BOOTSTRAP:-\}"$/m);
  assert.doesNotMatch(SRC, /[A-Za-z0-9-]+\/[A-Za-z0-9._-]+ [A-Za-z0-9._/-]+ [A-Za-z0-9._-]+\.ya?ml/, 'the bootstrap deploy is configuration, not code');
  assert.match(SRC, /^worker="\$\{PITLANE_RUNNER_WORKER:-Runner\.Worker\}"$/m);
  assert.ok(SRC.includes('<"${PITLANE_CGROUP:-/proc/self/cgroup}"'));
  assert.ok(SRC.indexOf('sleep 5') < SRC.indexOf('kill -KILL'));
  assert.ok(SRC.indexOf('sleep 5') < SRC.indexOf('systemctl kill'));
});
