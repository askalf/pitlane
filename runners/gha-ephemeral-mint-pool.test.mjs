// node --test runners/gha-ephemeral-mint-pool.test.mjs
// The pool claim of gha-ephemeral-mint.sh (pool_claim_one, pool_claim), run against a queue directory
// on disk: no systemd, no GitHub. The claim is what two rows race on, so it is tested as bash. Then
// the park (pool_park) against a stub systemctl, and the script's exit contract under ExecCondition=.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(join(HERE, 'gha-ephemeral-mint.sh'), 'utf8');
const fn = (re) => {
  const m = re.exec(SCRIPT);
  assert.ok(m, `not found: ${re}`);
  return m[0];
};
const PIECES = [
  'log() { printf \'%s\\n\' "$*"; }',
  fn(/^pool_claim_one\(\) \{[\s\S]*?^\}$/m),
  fn(/^pool_claim\(\) \{[\s\S]*?^\}$/m),
].join('\n');

/** Runs `call` with the pool functions, QUEUE at `dir`, as row `name`; returns stdout lines, the exit code, and the queue directory's files. */
function claim(dir, name, call = 'pool_claim_one', { linger = 0, owner = 'askalf' } = {}) {
  const posix = dir.replace(/\\/g, '/');
  const driver = `${PIECES}\nQUEUE='${posix}'; NAME='${name}'; owner=${owner}; POOL_LINGER_SECS=${linger}; target=; labels=\nrc=0; ${call} || rc=$?\necho "rc=$rc target=$target labels=$labels"\n`;
  const r = spawnSync('bash', ['-c', driver], { encoding: 'utf8' });
  return { out: r.stdout.trim().split('\n'), code: r.status, files: readdirSync(dir).sort(), err: r.stderr };
}

/** A queue directory holding `entries` ({ id: content }), written in the order given with mtimes a second apart. */
function queue(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'pool-claim-'));
  let t = Math.floor(Date.now() / 1000) - 600;
  for (const [id, text] of Object.entries(entries).sort(([a], [b]) => Number(a) - Number(b)).reverse()) {
    writeFileSync(join(dir, id), text);
    utimesSync(join(dir, id), t, t);
    t += 1;
  }
  return dir;
}

test('an empty queue is 1 and nothing is claimed', () => {
  const r = claim(queue({}), 'pool-e1');
  assert.deepEqual(r.out.at(-1), 'rc=1 target= labels=');
  assert.deepEqual(r.files, []);
});

test('the oldest entry (the lowest job id, whatever the mtimes) is claimed: renamed to the row\'s claim file, its repository and labels taken', () => {
  const dir = queue({ 1000: 'repo:askalf/ci self-hosted,Linux,X64,ci-exec\n', 999: 'repo:askalf/dario self-hosted,Linux,X64,dario-exec\n' });
  const r = claim(dir, 'pool-e1');
  assert.deepEqual(r.out, ['pool: claimed job 999 for askalf/dario (labels self-hosted,Linux,X64,dario-exec)', 'rc=0 target=askalf/dario labels=self-hosted,Linux,X64,dario-exec']);
  assert.deepEqual(r.files, ['.pool-e1', '1000']);
  assert.equal(readFileSync(join(dir, '.pool-e1'), 'utf8'), 'repo:askalf/dario self-hosted,Linux,X64,dario-exec\n');
});

test('a second row claims the next entry, not the first row\'s; a row claiming again replaces its own claim file', () => {
  const dir = queue({ 100: 'repo:askalf/ci self-hosted,ci-exec\n', 101: 'repo:askalf/ci self-hosted,ci-exec\n', 102: 'repo:askalf/dario self-hosted,dario-exec\n' });
  claim(dir, 'pool-e1');
  const r2 = claim(dir, 'pool-e2');
  assert.match(r2.out[0], /claimed job 101 /);
  const again = claim(dir, 'pool-e1');
  assert.match(again.out[0], /claimed job 102 for askalf\/dario/);
  assert.deepEqual(again.files, ['.pool-e1', '.pool-e2']);
  assert.equal(readFileSync(join(dir, '.pool-e1'), 'utf8'), 'repo:askalf/dario self-hosted,dario-exec\n');
});

test('a malformed entry of this owner is dropped and the next is taken; another owner\'s entry is left in place; names that are not job ids are not entries', () => {
  const dir = queue({ 100: 'repo:askalf/ci\n', 101: 'repo:evil/x self-hosted\n', 102: 'repo:askalf/../x self-hosted\n', 103: 'repo:askalf/.. self-hosted\n', 104: 'repo:askalf/ci self-hosted,ci-exec\n' });
  writeFileSync(join(dir, 'README'), 'not an entry\n');
  const r = claim(dir, 'pool-e1');
  assert.deepEqual(r.out, [
    'pool: entry 100 is malformed; dropped',
    'pool: entry 102 is malformed; dropped',
    'pool: entry 103 is malformed; dropped',
    'pool: claimed job 104 for askalf/ci (labels self-hosted,ci-exec)',
    'rc=0 target=askalf/ci labels=self-hosted,ci-exec',
  ]);
  assert.deepEqual(r.files, ['.pool-e1', '101', 'README'], 'evil/x stays queued for a pool of its own owner');
});

test('two owners\' pools on one queue: neither takes nor drops the other\'s job, and each takes its own', () => {
  // The oldest entry is the other owner's: before, the example pool claimed it, saw the owner and deleted it.
  const dir = queue({ 200: 'repo:askalf/ci self-hosted,ci-exec\n', 201: 'repo:example/app self-hosted,app-exec\n' });
  const ex = claim(dir, 'ex-pool-e1', 'pool_claim_one', { owner: 'example' });
  assert.deepEqual(ex.out, ['pool: claimed job 201 for example/app (labels self-hosted,app-exec)', 'rc=0 target=example/app labels=self-hosted,app-exec']);
  assert.deepEqual(ex.files, ['.ex-pool-e1', '200'], 'askalf\'s job is still queued');
  const al = claim(dir, 'pool-e1');
  assert.deepEqual(al.out, ['pool: claimed job 200 for askalf/ci (labels self-hosted,ci-exec)', 'rc=0 target=askalf/ci labels=self-hosted,ci-exec']);
  assert.deepEqual(al.files, ['.ex-pool-e1', '.pool-e1']);
  // A pool with only the other owner's entries queued claims nothing and leaves them.
  const only = queue({ 300: 'repo:askalf/ci self-hosted,ci-exec\n' });
  const none = claim(only, 'ex-pool-e1', 'pool_claim_one', { owner: 'example' });
  assert.deepEqual([none.out, none.files], [['rc=1 target= labels='], ['300']]);
  // An owner whose name another's starts with is not that owner.
  const near = queue({ 400: 'repo:example-two/app self-hosted,app-exec\n' });
  assert.deepEqual(claim(near, 'ex-pool-e1', 'pool_claim_one', { owner: 'example' }).files, ['400']);
});

/** Run pool_release against a stub gh (listing answers `listed` ids for the name) and no App; returns the log and what gh saw. */
function release(prev, { listed = '', deleteCode = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pool-release-'));
  const posix = (p) => p.replace(/\\/g, '/');
  const calls = join(dir, 'calls.txt');
  const env = join(dir, 'gha-repo.env');
  writeFileSync(env, 'GH_REPO_RUNNER_TOKEN="ghp_POOLTESTTOKEN0123456789"\n');
  writeFileSync(join(dir, 'gh'), [
    '#!/usr/bin/env bash',
    `printf 'ARGS:%s TOKENENV:%s\\n' "$*" "\${GH_TOKEN:+set}" >> '${posix(calls)}'`,
    `case "$*" in *"-X DELETE"*) exit ${deleteCode} ;; *actions/runners*) printf '%s\\n' '${listed}' ;; esac`,
  ].join('\n') + '\n', { mode: 0o755 });
  const driver = `${PIECES}\n${fn(/^pool_release\(\) \{[\s\S]*?^\}$/m)}\nNAME=pool-e1; token_key=GH_REPO_RUNNER_TOKEN; ENV_FILE='${posix(env)}'\npool_release '${prev}'; echo "rc=$?"\n`;
  const r = spawnSync('bash', ['-c', driver], { env: { ...process.env, PATH: `${posix(dir)}:${process.env.PATH}`, GHA_APP_TOKEN: posix(join(dir, 'no-app')) }, encoding: 'utf8' });
  let seen = '';
  try { seen = readFileSync(calls, 'utf8'); } catch { /* gh never ran */ }
  return { out: r.stdout.trim().split('\n'), seen };
}

test('pool_release lists the repository served last for this row\'s registration and deletes it, token in the environment only', () => {
  const r = release('askalf/dario', { listed: '41' });
  assert.deepEqual(r.out, ['pool: removed the registration left in askalf/dario (id 41)', 'rc=0']);
  assert.match(r.seen, /^ARGS:api repos\/askalf\/dario\/actions\/runners --paginate -q .* TOKENENV:set$/m);
  assert.match(r.seen, /^ARGS:api -X DELETE repos\/askalf\/dario\/actions\/runners\/41 .*TOKENENV:set$/m);
  assert.equal(r.seen.includes('ghp_POOLTESTTOKEN'), false, 'the token appeared in gh\'s arguments');
});

test('pool_release with nothing registered deletes nothing, and a refused delete is logged, never fatal', () => {
  const none = release('askalf/dario');
  assert.deepEqual(none.out, ['rc=0']);
  assert.doesNotMatch(none.seen, /DELETE/);
  const refused = release('askalf/dario', { listed: '41', deleteCode: 1 });
  assert.deepEqual(refused.out, ['pool: could not remove the registration left in askalf/dario (id 41); the supervisor will', 'rc=0']);
});

test('pool_claim lingers for an entry and gives up after POOL_LINGER_SECS', () => {
  const dir = queue({});
  const t0 = Date.now();
  const r = claim(dir, 'pool-e1', 'pool_claim', { linger: 1 });
  assert.equal(r.out.at(-1), 'rc=1 target= labels=');
  assert.ok(Date.now() - t0 >= 900, 'waited about a second');
  const have = queue({ 100: 'repo:askalf/ci self-hosted\n' });
  assert.equal(claim(have, 'pool-e1', 'pool_claim', { linger: 1 }).out.at(-1), 'rc=0 target=askalf/ci labels=self-hosted');
});

// ── the park, and the exit contract the unit templates' ExecCondition= reads ──
const PARK_PIECES = [fn(/^PARK_EXIT=\d+.*$/m), fn(/^pool_park\(\) \{[\s\S]*?^\}$/m)].join('\n');
const PARK_EXIT = Number(/^PARK_EXIT=(\d+)/m.exec(SCRIPT)[1]);

/** Runs pool_park as row `name` with a stub systemctl (listing `unit`, recording every call) and a stub pool_release; returns the exit code, stdout, the calls seen, the marks written, and the queue directory's files. */
function park(dir, name, { unit = `gha-ephemeral-first-party@${name}.service`, prev = '', hadJob = 0 } = {}) {
  const posix = (p) => p.replace(/\\/g, '/');
  const parkDir = mkdtempSync(join(tmpdir(), 'pool-park-'));
  const calls = join(parkDir, 'calls.txt');
  const driver = [
    PIECES, PARK_PIECES,
    `systemctl() { echo "systemctl $*" >> '${posix(calls)}'; case "$1" in list-units) ${unit ? `echo '${unit} loaded activating condition GitHub Actions ephemeral runner ${name}'` : ':'} ;; esac; }`,
    `pool_release() { echo "pool_release $*" >> '${posix(calls)}'; }`,
    'sleep() { :; }',
    `QUEUE='${posix(dir)}'; NAME='${name}'; PARK_DIR='${posix(parkDir)}/marks'; POOL_LINGER_SECS=20; pool_prev='${prev}'; pool_prev_had_job=${hadJob}`,
    'pool_park',
    'echo "pool_park returned"',
  ].join('\n') + '\n';
  const r = spawnSync('bash', ['-c', driver], { encoding: 'utf8' });
  let seen = '';
  try { seen = readFileSync(calls, 'utf8'); } catch { /* nothing was called */ }
  let marks = [];
  try { marks = readdirSync(join(parkDir, 'marks')).sort(); } catch { /* no mark was written */ }
  return { code: r.status, out: r.stdout.trim().split('\n'), seen, marks, files: readdirSync(dir).sort(), err: r.stderr };
}

test('pool_park writes the park mark for its unit, drops the claim, releases a registration left by an empty cycle, and ends the start with PARK_EXIT: no stop, nothing after it', () => {
  assert.ok(PARK_EXIT >= 1 && PARK_EXIT <= 254, 'an ExecCondition= exit that ends the start without failing the unit');
  const dir = queue({});
  writeFileSync(join(dir, '.pool-e1'), 'repo:askalf/ci self-hosted\n');
  const r = park(dir, 'pool-e1', { prev: 'askalf/ci' });
  assert.equal(r.code, PARK_EXIT, r.err);
  assert.deepEqual(r.out, ['pool: nothing queued for 20s; parking gha-ephemeral-first-party@pool-e1.service']);
  assert.deepEqual(r.marks, ['gha-ephemeral-first-party@pool-e1.service']);
  assert.deepEqual(r.files, []);
  assert.doesNotMatch(r.seen, /systemctl stop/);
  assert.match(r.seen, /^pool_release askalf\/ci$/m);
  const served = park(queue({}), 'pool-e2', { prev: 'askalf/ci', hadJob: 1 });
  assert.equal(served.code, PARK_EXIT);
  assert.doesNotMatch(served.seen, /pool_release/, 'a cycle that ran a job there deregistered itself');
});

test('pool_park with no unit of its name listed still ends the start with PARK_EXIT, without a mark', () => {
  const r = park(queue({}), 'pool-e3', { unit: '' });
  assert.equal(r.code, PARK_EXIT, r.err);
  assert.deepEqual(r.marks, []);
  assert.match(r.out[0], /^pool: nothing queued for 20s; parking pool-e3 \(no unit of this name is listed/);
});

test('every other exit of the mint step is 255, the ExecCondition= exit that fails the unit: fail() and the ERR trap alike', () => {
  const head = [fn(/^set -Eeuo pipefail$/m), fn(/^trap 'exit 255' ERR$/m), 'log() { printf \'%s\\n\' "$*"; }', 'sleep() { :; }', fn(/^fail\(\) \{.*$/m)].join('\n');
  const run = (body) => spawnSync('bash', ['-c', `${head}\n${body}\n`], { encoding: 'utf8' });
  assert.equal(run('fail "no token"').status, 255);
  assert.equal(run('inner() { false; echo unreachable; }\ninner\necho unreachable').status, 255, 'a failing command inside a function');
  assert.equal(run('x=$(false)\necho unreachable').status, 255, 'a failing command substitution');
  assert.equal(run('ok() { return 1; }\nif ok; then :; fi\nok || true\nexit 0').status, 0, 'a tested status is no failure');
});

test('every ephemeral unit template runs the mint step as its ExecCondition=, never as ExecStartPre=, and restarts the unit otherwise', () => {
  const templates = readdirSync(HERE).filter((f) => /^gha-ephemeral.*@\.service$/.test(f));
  assert.ok(templates.length >= 6, `templates: ${templates.join(', ')}`);
  for (const t of templates) {
    const unit = readFileSync(join(HERE, t), 'utf8');
    assert.match(unit, /^ExecCondition=\+\/opt\/askalf\/gha-ephemeral-mint\.sh %i$/m, t);
    assert.doesNotMatch(unit, /^ExecStartPre=.*gha-ephemeral-mint/m, t);
    assert.match(unit, /^Restart=always$/m, t);
    // A stop that reaches the mint step kills it with the unit's SIGINT; listed as a success, the unit ends inactive, not failed.
    assert.match(unit, /^KillSignal=SIGINT$/m, t);
    assert.match(unit, /^SuccessExitStatus=SIGINT$/m, t);
  }
});
