// node --test runners/gha-runners-apply.test.mjs
// token_sees from gha-runners-apply.sh, run against a stub `gh` on PATH: no network, no real token.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(join(HERE, 'gha-runners-apply.sh'), 'utf8');
const fn = (re) => {
  const m = re.exec(SCRIPT);
  assert.ok(m, `not found: ${re}`);
  return m[0];
};
const PIECES = [
  fn(/^scope_kind\(\).*$/m),
  fn(/^scope_target\(\).*$/m),
  fn(/^declare -A TOKEN_SEES=\(\)$/m),
  fn(/^token_sees\(\) \{[\s\S]*?^\}$/m),
].join('\n');

const SECRET = 'ghp_TESTSECRETVALUE0123456789';

/** Run token_sees for `scopes` in order with a gh stub that answers `ghOut` and exit `ghCode`; returns the codes and what gh saw. */
function run({ scopes, envText, ghOut, ghCode, app }) {
  const dir = mkdtempSync(join(tmpdir(), 'tokcheck-'));
  const env = join(dir, 'gha-repo.env');
  writeFileSync(env, envText);
  const calls = join(dir, 'calls.txt');
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/usr/bin/env bash\nprintf 'ARGS:%s\\nTOKENENV:%s\\n' "$*" "\${GH_TOKEN:+set}" >> '${calls.replace(/\\/g, '/')}'\nprintf '%s\\n' '${ghOut}'\nexit ${ghCode}\n`, { mode: 0o755 });
  // The runner App's token helper: a stub that prints `app.token` and exits `app.code`, or none at all.
  const appCmd = join(dir, app ? 'gha-app-token.sh' : 'no-app').replace(/\\/g, '/');
  if (app) writeFileSync(appCmd, `#!/usr/bin/env bash\nprintf 'APP:%s\\n' "$*" >> '${calls.replace(/\\/g, '/')}'\nprintf '%s' '${app.token}'\nexit ${app.code}\n`, { mode: 0o755 });
  const driver = `${PIECES}\nfor s in ${scopes.map((s) => `'${s}'`).join(' ')}; do rc=0; token_sees "$s" '${env.replace(/\\/g, '/')}' || rc=$?; echo "$s=$rc"; done\n`;
  const r = spawnSync('bash', ['-c', driver], { env: { ...process.env, PATH: `${dir.replace(/\\/g, '/')}:${process.env.PATH}`, GHA_APP_TOKEN: appCmd }, encoding: 'utf8' });
  let called = '';
  try { called = readFileSync(calls, 'utf8'); } catch { /* gh never ran */ }
  return { out: r.stdout.trim().split('\n'), err: r.stderr, called };
}

const ENV = `GH_REPO_RUNNER_TOKEN="${SECRET}"\n`;

test('a token that can list the repository\'s runners sees it', () => {
  const r = run({ scopes: ['repo:askalf/pitlane'], envText: ENV, ghOut: '3', ghCode: 0 });
  assert.deepEqual(r.out, ['repo:askalf/pitlane=0']);
  assert.match(r.called, /ARGS:api repos\/askalf\/pitlane\/actions\/runners/);
});

test('a 404 or 403 means the token does not cover the repository', () => {
  assert.deepEqual(run({ scopes: ['repo:askalf/pitlane'], envText: ENV, ghOut: 'gh: Not Found (HTTP 404)', ghCode: 1 }).out, ['repo:askalf/pitlane=1']);
  assert.deepEqual(run({ scopes: ['repo:askalf/pitlane'], envText: ENV, ghOut: 'gh: Resource not accessible by personal access token (HTTP 403)', ghCode: 1 }).out, ['repo:askalf/pitlane=1']);
});

test('a rate limit or an unreadable error is not a reason to hold a row', () => {
  assert.deepEqual(run({ scopes: ['repo:askalf/pitlane'], envText: ENV, ghOut: 'gh: API rate limit exceeded (HTTP 403)', ghCode: 1 }).out, ['repo:askalf/pitlane=2']);
  assert.deepEqual(run({ scopes: ['repo:askalf/pitlane'], envText: ENV, ghOut: 'dial tcp: i/o timeout', ghCode: 1 }).out, ['repo:askalf/pitlane=2']);
});

test('a missing token key holds the row without calling GitHub; an unknown scope is not checked', () => {
  const r = run({ scopes: ['repo:askalf/pitlane'], envText: 'OTHER=1\n', ghOut: '3', ghCode: 0 });
  assert.deepEqual(r.out, ['repo:askalf/pitlane=1']);
  assert.equal(r.called, '');
  assert.deepEqual(run({ scopes: ['host:x'], envText: ENV, ghOut: '3', ghCode: 0 }).out, ['host:x=2']);
});

test('one GitHub call per scope per run, and the token is in the environment, never an argument', () => {
  const r = run({ scopes: ['repo:askalf/pitlane', 'repo:askalf/pitlane', 'repo:askalf/dario'], envText: ENV, ghOut: '3', ghCode: 0 });
  assert.deepEqual(r.out, ['repo:askalf/pitlane=0', 'repo:askalf/pitlane=0', 'repo:askalf/dario=0']);
  assert.equal((r.called.match(/^ARGS:/gm) ?? []).length, 2);
  assert.equal(r.called.includes(SECRET), false, 'the token appeared in gh\'s arguments');
  assert.equal((r.called.match(/TOKENENV:set/g) ?? []).length, 2);
});

test('the runner App is asked first, narrowed like the mint step, so a repository missing from the token file is seen', () => {
  const r = run({ scopes: ['repo:askalf/shop'], envText: 'OTHER=1\n', ghOut: '0', ghCode: 0, app: { token: 'ghs_APPTOKEN', code: 0 } });
  assert.deepEqual(r.out, ['repo:askalf/shop=0']);
  assert.match(r.called, /APP:askalf shop administration=write/);
  assert.equal(r.called.includes('ghs_APPTOKEN'), false, 'the App token appeared in gh\'s arguments');
});

test('an App that is not configured or not installed falls back to the token file', () => {
  for (const code of [3, 4]) {
    const r = run({ scopes: ['repo:askalf/pitlane'], envText: ENV, ghOut: '3', ghCode: 0, app: { token: '', code } });
    assert.deepEqual(r.out, ['repo:askalf/pitlane=0']);
    assert.match(r.called, /TOKENENV:set/);
  }
  const none = run({ scopes: ['repo:askalf/pitlane'], envText: 'OTHER=1\n', ghOut: '3', ghCode: 0, app: { token: '', code: 4 } });
  assert.deepEqual(none.out, ['repo:askalf/pitlane=1']);
});

test('a pool scope is seen without asking GitHub: it registers in the owner\'s repositories, each checked through its own rows', () => {
  const r = run({ scopes: ['pool:askalf'], envText: ENV, ghOut: '3', ghCode: 0 });
  assert.deepEqual(r.out, ['pool:askalf=0']);
  assert.equal(r.called, '');
});

test('an org row asks the App for the org\'s self-hosted runners', () => {
  const r = run({ scopes: ['org:sprayberry-code'], envText: '', ghOut: '1', ghCode: 0, app: { token: 'ghs_APPTOKEN', code: 0 } });
  assert.deepEqual(r.out, ['org:sprayberry-code=0']);
  assert.match(r.called, /APP:sprayberry-code - organization_self_hosted_runners=write/);
});

// ── pool_of / template_for / unit_for: which template a row's account picks ──
const TEMPLATE_PIECES = [
  fn(/^die\(\).*$/m),
  fn(/^scope_kind\(\).*$/m),
  fn(/^scope_target\(\).*$/m),
  fn(/^pool_of\(\) \{[\s\S]*?^\}$/m),
  fn(/^EPHEMERAL_TEMPLATES=.*$/m),
  fn(/^template_for\(\) \{[\s\S]*?^\}$/m),
  fn(/^unit_for\(\) \{[\s\S]*?^\}$/m),
].join('\n');

/** Run one of the pure mapping functions and return stdout, stderr and the exit code. */
function map(call) {
  const r = spawnSync('bash', ['-c', `${TEMPLATE_PIECES}\n${call}\n`], { encoding: 'utf8' });
  return { out: r.stdout.trim(), err: r.stderr.trim(), code: r.status };
}

test('each account picks its template; root is the build tier', () => {
  assert.equal(map('pool_of gha-oss').out, 'exec');
  assert.equal(map('pool_of gha-oss-read').out, 'read');
  assert.equal(map('pool_of gha-redline').out, 'redline');
  assert.equal(map('pool_of gha-exec').out, 'first-party');
  assert.equal(map('pool_of root').out, 'build');
  assert.equal(map('template_for gha-exec').out, 'gha-ephemeral-first-party@');
  assert.equal(map('template_for root').out, 'gha-ephemeral-build@');
});

test('an account with no template stops apply instead of guessing one', () => {
  const r = map('pool_of gha-nobody');
  assert.equal(r.code, 1);
  assert.match(r.err, /no ephemeral template for account gha-nobody/);
});

test('a root ephemeral row is a build-template instance; an adopted root row keeps its own unit name', () => {
  assert.equal(map('unit_for app-build-e1 repo:askalf/app ephemeral root').out, 'gha-ephemeral-build@app-build-e1.service');
  assert.equal(map('unit_for host-ops repo:askalf/shop adopt root').out, 'actions.runner.askalf-shop.host-ops.service');
});

test('the build template is in the retire list, so a row that leaves root loses its old unit', () => {
  assert.match(map('printf %s "$EPHEMERAL_TEMPLATES"').out, /(^| )gha-ephemeral-build@( |$)/);
});

test('the upstream write account has its own template, in the retire list, and is no other tier', () => {
  assert.equal(map('pool_of gha-oss-write').out, 'write');
  assert.equal(map('template_for gha-oss-write').out, 'gha-ephemeral-write@');
  assert.equal(map('unit_for oss-write-1 org:sprayberry-code ephemeral gha-oss-write').out, 'gha-ephemeral-write@oss-write-1.service');
  assert.match(map('printf %s "$EPHEMERAL_TEMPLATES"').out, /(^| )gha-ephemeral-write@( |$)/);
  const unit = readFileSync(join(HERE, 'gha-ephemeral-write@.service'), 'utf8');
  assert.match(unit, /^User=gha-oss-write$/m);
  assert.match(unit, /^Group=gha-oss-write$/m);
  assert.match(unit, /^Slice=gha-read\.slice$/m);
  assert.doesNotMatch(unit, /toolcache-(read|exec)/, 'a tool cache of its own');
});

test('apply holds a root row that runners.isolated names instead of isolating it', () => {
  assert.match(SCRIPT, /\[ "\$user" = root \] && is_isolated "\$name"[\s\S]{0,200}cannot be isolated/);
});

// ── the instance directory's group: the row's own account where the row is isolated ──
test('instance_dir_group is the isolated account when the row is listed and the account exists, else the tier account; bootstrap and apply set it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'isodir-'));
  const listed = join(dir, 'runners.isolated').replace(/\\/g, '/');
  writeFileSync(listed, '# isolated rows\nci-exec-e1\npool-e12 groups=none\n');
  const pieces = [fn(/^is_isolated\(\) \{[\s\S]*?^\}$/m), fn(/^isolated_account\(\) \{[\s\S]*?^\}$/m), fn(/^instance_dir_group\(\) \{[\s\S]*?^\}$/m)].join('\n');
  const driver = `${pieces}\nISOLATED_FILE='${listed}'\nid() { [ "$1" = gx-ci-exec-e1 ]; }\nfor r in ci-exec-e1 pool-e12 dario-exec-e1; do printf '%s=%s\\n' "$r" "$(instance_dir_group "$r" gha-exec)"; done\n`;
  const r = spawnSync('bash', ['-c', driver], { encoding: 'utf8' });
  assert.deepEqual(r.stdout.trim().split('\n'), ['ci-exec-e1=gx-ci-exec-e1', 'pool-e12=gha-exec', 'dario-exec-e1=gha-exec'], r.stderr);
  assert.match(SCRIPT, /grp=\$\(instance_dir_group "\$name" "\$user"\)\n\s*if \[ "\$\(stat -c %G "\$dir" 2>\/dev\/null\)" = "\$grp" \] \|\| moves_now "\$\(unit_for "\$name" "\$scope" "\$rmode" "\$user"\)" "\$grp" "\$dir"; then\n\s*chown "root:\$grp" "\$dir"\n\s*fi\n\s*chmod 1770 "\$dir"/, 'bootstrap gives a new or reset directory the row\'s group, and waits while the unit still runs as the other account');
  assert.match(SCRIPT, /\[ "\$\(stat -c %G "\$dir" 2>\/dev\/null\)" != "\$acct" \][\s\S]{0,240}chown "root:\$acct" "\$dir"/, 'apply moves an existing directory to the isolated account');
  assert.match(SCRIPT, /UNISOLATE[\s\S]{0,200}chown "root:\$tier_user" "\$dir"/, 'a row leaving the list goes back to the tier account');
});
