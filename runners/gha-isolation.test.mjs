// node --test runners/gha-isolation.test.mjs
// The per-row account functions of gha-runners-apply.sh and the mint step's use of the row's account,
// run in bash with stub useradd/install/id on PATH: no account is created and nothing needs root.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APPLY = readFileSync(join(HERE, 'gha-runners-apply.sh'), 'utf8');
const MINT = readFileSync(join(HERE, 'gha-ephemeral-mint.sh'), 'utf8');
const fn = (re) => {
  const m = re.exec(APPLY);
  assert.ok(m, `not found: ${re}`);
  return m[0];
};
const PIECES = [
  fn(/^is_isolated\(\) \{[\s\S]*?^\}$/m),
  fn(/^isolated_groups\(\) \{[\s\S]*?^\}$/m),
  fn(/^isolated_account\(\) \{[\s\S]*?^\}$/m),
  fn(/^isolated_account_rows\(\) \{[\s\S]*?^\}$/m),
  fn(/^isolated_dropin\(\) \{[\s\S]*?^\}$/m),
  fn(/^running_uid\(\) \{[\s\S]*?^\}$/m),
  fn(/^moves_now\(\) \{[\s\S]*?^\}$/m),
  fn(/^isolate_row\(\) \{[\s\S]*?^\}$/m),
].join('\n');

/**
 * Run isolate_row in `mode` for `row`; `existing` accounts are known to id, `groups` to getent. With
 * `instDir` the instance directory is a real one in the temp dir, whose group stat reports as `dirGroup`;
 * `runningUid` is the uid the unit's main process runs as (null: the unit is not running). gha-exec is
 * uid 990 and each existing account 2001 on. Returns its log, the files it wrote and the commands stubs saw.
 */
function run({ mode, list, row = 'pitlane-exec-e1', existing = [], groups = [], groupaddFails = false, priorDropin = null, reuse = null, instDir = false, dirGroup = 'gha-exec', runningUid = null }) {
  const dir = reuse ?? mkdtempSync(join(tmpdir(), 'iso-'));
  const unitDir = join(dir, 'units'); mkdirSync(unitDir, { recursive: true });
  const bin = join(dir, 'bin'); mkdirSync(bin, { recursive: true });
  const seen = join(dir, 'seen.txt'); rmSync(seen, { force: true });
  const sh = (p) => p.split('\\').join('/');
  const stub = (name, body) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  stub('useradd', `echo "useradd $*" >> '${sh(seen)}'`);
  stub('install', `echo "install $*" >> '${sh(seen)}'; mkdir -p "$\{@: -1}"`);
  const uids = [['gha-exec', 990], ...existing.map((a, i) => [a, 2001 + i])];
  stub('id', `if [ "$1" = -u ]; then case "$2" in ${uids.map(([a, u]) => `${a}) echo ${u}; exit 0 ;;`).join(' ')} esac; exit 1; fi
case " ${existing.join(' ')} " in *" $1 "*) exit 0 ;; *) exit 1 ;; esac`);
  // The unit and its directory as systemd and the file system would report them; chown only records.
  stub('systemctl', `[ "$*" = "show -p MainPID --value $5" ] && echo ${runningUid === null ? 0 : 4242}`);
  stub('ps', `[ "$*" = "-o uid= -p 4242" ] && echo " ${runningUid}"`);
  stub('stat', `echo ${dirGroup}`);
  stub('chown', `echo "chown $*" >> '${sh(seen)}'`);
  stub('getent', `[ "$1" = group ] || exit 2; case " ${groups.join(' ')} " in *" $2 "*) exit 0 ;; *) exit 2 ;; esac`);
  stub('groupadd', `echo "groupadd $*" >> '${sh(seen)}'; exit ${groupaddFails ? 1 : 0}`);
  const iso = join(dir, 'runners.isolated');
  if (list !== null) writeFileSync(iso, list);
  const unit = `gha-ephemeral-first-party@${row}.service`;
  if (priorDropin !== null) { mkdirSync(join(unitDir, `${unit}.d`)); writeFileSync(join(unitDir, `${unit}.d`, '20-isolated.conf'), priorDropin); }
  const driver = [
    `UNIT_DIR='${sh(unitDir)}'; ISOLATED_FILE='${sh(iso)}'; ISO_DROPIN=20-isolated.conf; TOOLCACHE='${sh(dir)}/toolcache'`,
    'log() { printf "%s\n" "$*"; }',
    PIECES,
    'changed=0; to_restart=()',
    `isolate_row ${mode} '${row}' '${unit}' gha-exec '${instDir ? sh(join(dir, 'inst')) : `/srv/gha/${row}`}'`,
    'echo "changed=$changed restart=${to_restart[*]:-}"',
  ].join('\n');
  if (instDir) mkdirSync(join(dir, 'inst'), { recursive: true });
  const r = spawnSync('bash', ['-c', driver], { env: { ...process.env, PATH: `${sh(bin)}:${process.env.PATH}` }, encoding: 'utf8' });
  const dropin = join(unitDir, `${unit}.d`, '20-isolated.conf');
  return { dir, out: r.stdout.trim().split('\n'), err: r.stderr, dropin: existsSync(dropin) ? readFileSync(dropin, 'utf8') : null, seen: existsSync(seen) ? readFileSync(seen, 'utf8') : '' };
}

test('a row is isolated only when the list names it exactly; comments and blanks are ignored', () => {
  const list = '# header\n\npitlane-exec-e1   # first\n  other-row\n';
  assert.match(run({ mode: 'plan', list }).out.join('\n'), /ISOLATE .* as gx-pitlane-exec-e1/);
  assert.doesNotMatch(run({ mode: 'plan', list: list.replace('pitlane-exec-e1', 'pitlane-exec-e11') }).out.join('\n'), /ISOLATE/);
  assert.doesNotMatch(run({ mode: 'plan', list: '# pitlane-exec-e1\n' }).out.join('\n'), /ISOLATE/);
  assert.doesNotMatch(run({ mode: 'plan', list: null }).out.join('\n'), /ISOLATE/);
});

test('plan creates nothing; apply writes the drop-in, creates the account and cache, and queues the unit', () => {
  const p = run({ mode: 'plan', list: 'pitlane-exec-e1\n' });
  assert.equal(p.dropin, null);
  assert.equal(p.seen, '');
  assert.match(p.out.at(-1), /changed=1 restart=gha-ephemeral-first-party@pitlane-exec-e1.service\|\/srv\/gha\/pitlane-exec-e1/);
  const a = run({ mode: 'apply', list: 'pitlane-exec-e1\n' });
  assert.match(a.seen, /useradd --system --home-dir \/srv\/gha\/pitlane-exec-e1 --no-create-home --shell \/usr\/sbin\/nologin gx-pitlane-exec-e1/);
  assert.match(a.seen, /install -d -m 0755 -o gx-pitlane-exec-e1 -g gx-pitlane-exec-e1 .*toolcache\/pitlane-exec-e1/);
  for (const line of ['User=gx-pitlane-exec-e1', 'Group=gx-pitlane-exec-e1', 'SupplementaryGroups=gha-exec', 'Environment=GHA_ROW_ACCOUNT=gx-pitlane-exec-e1', 'ProtectProc=invisible']) {
    assert.ok(a.dropin.split('\n').includes(line), `drop-in lacks ${line}`);
  }
  assert.match(a.dropin, /^ReadWritePaths=$/m);
  assert.match(a.dropin, /^ReadWritePaths=\/srv\/gha\/pitlane-exec-e1 .*\/toolcache\/pitlane-exec-e1$/m);
  assert.doesNotMatch(a.dropin, /ProcSubset/);
});

test('an unchanged drop-in and an existing account change nothing', () => {
  const first = run({ mode: 'apply', list: 'pitlane-exec-e1\n' });
  const again = run({ mode: 'apply', list: 'pitlane-exec-e1\n', existing: ['gx-pitlane-exec-e1'], reuse: first.dir });
  assert.match(again.out.join('\n'), /ok .* isolated as gx-pitlane-exec-e1/);
  assert.match(again.out.at(-1), /changed=0/);
  assert.doesNotMatch(again.seen, /useradd/);
});

test('taking a row off the list removes its drop-in and queues a restart', () => {
  const r = run({ mode: 'apply', list: '# none\n', priorDropin: '[Service]\nUser=gx-pitlane-exec-e1\n' });
  assert.match(r.out.join('\n'), /UNISOLATE .* \(back to gha-exec\)/);
  assert.equal(r.dropin, null);
  assert.match(r.out.at(-1), /changed=1/);
  assert.match(run({ mode: 'plan', list: '# none\n' }).out.at(-1), /changed=0/);
});

test('a row joining the list keeps its directory while its unit still runs as the tier account; it moves once the unit is stopped', () => {
  const list = 'pitlane-exec-e1 groups=none\n';
  const busy = run({ mode: 'apply', list, existing: ['gx-pitlane-exec-e1'], instDir: true, runningUid: 990 });
  assert.match(busy.out.join('\n'), /later .*inst: gha-ephemeral-first-party@pitlane-exec-e1\.service still runs as uid 990; its mint step gives the directory to gx-pitlane-exec-e1/);
  assert.doesNotMatch(busy.seen, /chown/, 'a running job would lose its own directory');
  assert.ok(busy.dropin, 'the drop-in is still written, for the next start');
  const stopped = run({ mode: 'apply', list, existing: ['gx-pitlane-exec-e1'], instDir: true, runningUid: null });
  assert.match(stopped.seen, /^chown root:gx-pitlane-exec-e1 .*inst$/m);
  assert.match(stopped.out.join('\n'), /GROUP .*inst to gx-pitlane-exec-e1 \(was gha-exec\)/);
});

test('a row already running as its own account gets its directory back at once (a bootstrap reset it)', () => {
  const list = 'pitlane-exec-e1 groups=none\n';
  const r = run({ mode: 'apply', list, existing: ['gx-pitlane-exec-e1'], instDir: true, runningUid: 2001 });
  assert.match(r.seen, /^chown root:gx-pitlane-exec-e1 .*inst$/m);
  assert.doesNotMatch(r.out.join('\n'), /later/);
  const p = run({ mode: 'plan', list, existing: ['gx-pitlane-exec-e1'], instDir: true, runningUid: 2001 });
  assert.match(p.out.join('\n'), /GROUP /);
  assert.equal(p.seen, '', 'plan changes nothing');
});

test('a row leaving the list keeps its directory while its unit still runs as the row account', () => {
  const prior = '[Service]\nUser=gx-pitlane-exec-e1\n';
  const busy = run({ mode: 'apply', list: '# none\n', existing: ['gx-pitlane-exec-e1'], priorDropin: prior, instDir: true, dirGroup: 'gx-pitlane-exec-e1', runningUid: 2001 });
  assert.match(busy.out.join('\n'), /later .*still runs as uid 2001; its mint step gives the directory to gha-exec/);
  assert.doesNotMatch(busy.seen, /chown/);
  assert.equal(busy.dropin, null, 'the drop-in still goes, for the next start');
  const stopped = run({ mode: 'apply', list: '# none\n', existing: ['gx-pitlane-exec-e1'], priorDropin: prior, instDir: true, dirGroup: 'gx-pitlane-exec-e1', runningUid: null });
  assert.match(stopped.seen, /^chown root:gha-exec .*inst$/m);
});

test('an account name over 32 characters holds the row', () => {
  const row = 'a'.repeat(30);
  const r = run({ mode: 'apply', list: `${row}\n`, row });
  assert.match(r.out.join('\n'), /hold .*over 32 characters/);
  assert.equal(r.dropin, null);
});

test('an account= word names the row\'s account in place of gx-<row>, for a name over 32 characters', () => {
  const row = 'acme-marketing-site-redline-e1';
  assert.match(run({ mode: 'plan', list: `${row} groups=gha-redline\n`, row }).out.join('\n'), /hold .*gx-acme-marketing-site-redline-e1 is over 32 characters; give the row an account= word/);
  const r = run({ mode: 'apply', list: `${row} account=gx-acme-site-redline-e1 groups=gha-redline  # 33 characters as gx-<row>\n`, row, groups: ['gha-redline'] });
  assert.match(r.seen, /^useradd --system --home-dir \/srv\/gha\/acme-marketing-site-redline-e1 --no-create-home --shell \/usr\/sbin\/nologin gx-acme-site-redline-e1$/m);
  assert.match(r.dropin, /^User=gx-acme-site-redline-e1\nGroup=gx-acme-site-redline-e1\nSupplementaryGroups=gha-redline\nEnvironment=GHA_ROW_ACCOUNT=gx-acme-site-redline-e1$/m);
  assert.match(r.dropin, /^ReadWritePaths=\/srv\/gha\/acme-marketing-site-redline-e1 \S+\/toolcache\/acme-marketing-site-redline-e1$/m, 'the tool cache and directory keep the row\'s name');
  assert.match(r.out.join('\n'), /ISOLATE .* as gx-acme-site-redline-e1/);
});

test('an account= value that is not a gx- name, or is another listed row\'s account, holds the row', () => {
  for (const [list, why] of [
    ['pitlane-exec-e1 account=root\n', /account=root is not a gx- account name/],
    ['pitlane-exec-e1 account=\n', /account= is not a gx- account name/],
    ['pitlane-exec-e1 account=gx-Pool\n', /account=gx-Pool is not a gx- account name/],
    ['pitlane-exec-e1 account=gx-pool-e1\npool-e1 groups=none\n', /account gx-pool-e1 is also another listed row's/],
    ['pitlane-exec-e1 account=gx-x\npool-e1 account=gx-x\n', /account gx-x is also another listed row's/],
  ]) {
    const r = run({ mode: 'apply', list });
    assert.match(r.out.join('\n'), why, list);
    assert.equal(r.dropin, null, list);
    assert.doesNotMatch(r.seen, /useradd/, list);
  }
  assert.match(run({ mode: 'apply', list: 'pitlane-exec-e1 account=gx-pitlane-exec-e1\n' }).dropin, /^User=gx-pitlane-exec-e1$/m, 'naming the default account is allowed');
});

test('the mint step gives the directory and the JIT config to the unit\'s account, not the tier\'s', () => {
  const sub = MINT.indexOf('user="${GHA_ROW_ACCOUNT:-$user}"');
  assert.ok(sub > 0, 'mint does not read GHA_ROW_ACCOUNT');
  assert.ok(sub < MINT.indexOf('id "$user"'), 'the account is substituted after it is checked');
  assert.ok(sub < MINT.indexOf('chown "root:$user" "$dir"'));
  assert.ok(sub < MINT.indexOf('install -m 600 -o "$user" -g "$user"'));
});

test('the mint step waits for a busy registration of its own name to be released before it fails', () => {
  const wait = MINT.indexOf('while [ "$sbusy" = "true" ] && [ "$waited" -lt "$BUSY_WAIT_SECS" ]');
  assert.ok(wait > 0, 'mint does not wait on a busy registration');
  assert.ok(wait < MINT.indexOf('still registered and BUSY'), 'the wait comes before the refusal');
  assert.ok(MINT.indexOf('BUSY_WAIT_SECS="${BUSY_WAIT_SECS:-360}"') > 0, 'the wait is bounded');
  for (const unit of ['gha-ephemeral@.service', 'gha-ephemeral-read@.service', 'gha-ephemeral-write@.service', 'gha-ephemeral-redline@.service', 'gha-ephemeral-first-party@.service']) {
    assert.match(readFileSync(join(HERE, unit), 'utf8'), /^TimeoutStartSec=8min$/m, `${unit} gives the mint step time to wait`);
  }
});

test('the mint step removes a run-helper.sh another account left, every cycle, before the runner starts', () => {
  const rm = MINT.indexOf('rm -f -- "$dir/run-helper.sh"');
  assert.ok(rm > MINT.indexOf('-exec rm -rf -- {} +'), 'removed after the directory reset');
  assert.ok(rm < MINT.indexOf('pinned_ver='), 'removed whether or not the runner is laid out again');
});

test('the drop-in text is stable, so a row already applied is not restarted by a code change', () => {
  const a = run({ mode: 'apply', list: 'pitlane-exec-e1\n' });
  const cache = a.dropin.split('\n').find((l) => l.startsWith('Environment=RUNNER_TOOL_CACHE=')).split('=').slice(2).join('=');
  const iso = a.dropin.split('\n')[0].replace('# Managed by gha-runners-apply.sh from ', '').replace('. Do not edit here.', '');
  assert.equal(a.dropin, [
    `# Managed by gha-runners-apply.sh from ${iso}. Do not edit here.`,
    '[Service]', 'User=gx-pitlane-exec-e1', 'Group=gx-pitlane-exec-e1', 'SupplementaryGroups=gha-exec',
    'Environment=GHA_ROW_ACCOUNT=gx-pitlane-exec-e1', `Environment=RUNNER_TOOL_CACHE=${cache}`, `Environment=AGENT_TOOLSDIRECTORY=${cache}`,
    'ProtectProc=invisible', 'ReadWritePaths=', `ReadWritePaths=/srv/gha/pitlane-exec-e1 ${cache}`, '',
  ].join('\n'));
});

test('groups=none drops the tier group; any other row on the list keeps it', () => {
  const none = run({ mode: 'apply', list: 'pitlane-exec-e1 groups=none  # reads no key file\n' });
  assert.doesNotMatch(none.dropin, /SupplementaryGroups/);
  assert.match(none.dropin, /^User=gx-pitlane-exec-e1$/m);
  assert.match(run({ mode: 'apply', list: 'pitlane-exec-e1\n' }).dropin, /^SupplementaryGroups=gha-exec$/m);
  assert.match(run({ mode: 'apply', list: 'pitlane-exec-e1 \nother groups=none\n' }).dropin, /^SupplementaryGroups=gha-exec$/m);
  const after = run({ mode: 'apply', list: 'pitlane-exec-e1 groups=none\n', existing: ['gx-pitlane-exec-e1'], priorDropin: run({ mode: 'apply', list: 'pitlane-exec-e1\n' }).dropin });
  assert.match(after.out.at(-1), /changed=1/, 'a row that gains groups=none is rewritten');
});

test('groups=<group> puts that group in place of the tier group; apply creates it when the host has none', () => {
  const list = 'pitlane-exec-e1 groups=gha-fix  # reads the fix lane key file only\n';
  const p = run({ mode: 'plan', list });
  assert.match(p.out.join('\n'), /^\s*GROUP\+  gha-fix for pitlane-exec-e1$/m);
  assert.doesNotMatch(p.seen, /groupadd/, 'plan creates no group');
  const a = run({ mode: 'apply', list });
  assert.match(a.seen, /^groupadd --system gha-fix$/m);
  assert.match(a.dropin, /^SupplementaryGroups=gha-fix$/m);
  assert.doesNotMatch(a.dropin, /gha-exec/, 'the tier group is gone, not added to');
  const have = run({ mode: 'apply', list, groups: ['gha-fix'] });
  assert.doesNotMatch(have.seen, /groupadd/);
  assert.ok(!have.out.some((l) => l.includes('GROUP+')));
  assert.match(have.dropin, /^SupplementaryGroups=gha-fix$/m);
  const moved = run({ mode: 'apply', list, existing: ['gx-pitlane-exec-e1'], groups: ['gha-fix'], priorDropin: run({ mode: 'apply', list: 'pitlane-exec-e1\n' }).dropin });
  assert.match(moved.out.at(-1), /changed=1/, 'a row that moves from the tier group to its own is rewritten');
});

test('a groups= value that is not a group name, or a group apply cannot create, holds the row', () => {
  for (const bad of ['groups=', 'groups=Gha-fix', 'groups=gha;fix', 'groups=-x', `groups=g${'x'.repeat(32)}`]) {
    const r = run({ mode: 'apply', list: `pitlane-exec-e1 ${bad}\n` });
    assert.match(r.out.join('\n'), /^\s*hold    gha-ephemeral-first-party@pitlane-exec-e1\.service: groups=.* is not a group name$/m, bad);
    assert.equal(r.dropin, null, bad);
    assert.equal(r.seen, '', `${bad}: no account, group or cache is made`);
    assert.match(r.out.at(-1), /changed=0 restart=$/, bad);
  }
  const failed = run({ mode: 'apply', list: 'pitlane-exec-e1 groups=gha-fix\n', groupaddFails: true });
  assert.match(failed.out.join('\n'), /^\s*hold    gha-ephemeral-first-party@pitlane-exec-e1\.service: could not create group gha-fix$/m);
  assert.equal(failed.dropin, null);
  assert.match(failed.out.at(-1), /changed=0 restart=$/);
});

test('the mint step delivers the row file by rename from the root-only staging directory, before the JIT config', () => {
  const stage = MINT.indexOf('rowtmp="$STAGE/$NAME.row"');
  assert.ok(stage > 0, 'mint does not stage a row file');
  assert.ok(stage > MINT.indexOf('chmod 700 "$STAGE"'), 'staged only after the directory is root-only');
  const install = MINT.indexOf('install -m 400 -o "$user" -g "$user" /dev/stdin "$rowtmp"');
  assert.ok(install > stage && install > MINT.indexOf('user="${GHA_ROW_ACCOUNT:-$user}"'));
  const mv = MINT.indexOf('mv -f -- "$rowtmp" "$dir/.row"');
  assert.ok(mv > install, 'moved in with rename(2)');
  assert.ok(mv < MINT.indexOf('mv -f -- "$tmp" "$dir/.jitconfig"'), 'a .jitconfig implies a .row');
  assert.ok(mv > MINT.indexOf('-exec rm -rf -- {} +'), 'delivered after the directory reset');
  assert.ok(MINT.includes('[ "$dir" = "$POOL_ROOT/$NAME" ]'), 'the row directory is the unit\'s WorkingDirectory');
});

/**
 * Run the run step in a temp pool with a stub sleep and id. `rowFor(dir)` is the .row content (null: no file, 'link': a symlink to one).
 * `hook: 'exec'` points it at an executable job-completed hook; by default the hook path does not exist.
 * `guard` is the build guard ('exec', 'plain': not executable, 'link': a symlink to an executable one,
 * 'none': no file) and `uid` what the stub id prints: 0 is a root row.
 */
function runStep(rowFor, { hook = 'none', guard = 'none', uid = 1000 } = {}) {
  const pool = mkdtempSync(join(tmpdir(), 'run-')).split(sep).join('/');
  const dir = `${pool}/r1`;
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin', 'Runner.Listener'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\necho "RUNNER $*"\necho "HOOK=${ACTIONS_RUNNER_HOOK_JOB_COMPLETED-unset}"\necho "STARTED=${ACTIONS_RUNNER_HOOK_JOB_STARTED-unset}"\n', { mode: 0o755 });
  const hookPath = `${pool}/hook.sh`;
  if (hook === 'exec') writeFileSync(hookPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const guardPath = `${pool}/guard.sh`;
  if (guard === 'exec') writeFileSync(guardPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (guard === 'plain') writeFileSync(guardPath, 'exit 0\n', { mode: 0o644 });
  if (guard === 'link') {
    writeFileSync(`${pool}/real-guard.sh`, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    try { symlinkSync(`${pool}/real-guard.sh`, guardPath); } catch { rmSync(pool, { recursive: true, force: true }); return null; }   // no symlink right on this box
  }
  writeFileSync(join(dir, '.jitconfig'), 'jit-value');
  const row = rowFor(dir);
  if (row === 'link') {
    writeFileSync(join(pool, 'elsewhere'), `${dir} lbl\n`);
    try { symlinkSync(join(pool, 'elsewhere'), join(dir, '.row')); } catch { rmSync(pool, { recursive: true, force: true }); return null; }   // no symlink right on this box
  } else if (row !== null) {
    writeFileSync(join(dir, '.row'), row);
  }
  const stubs = join(pool, 'stubs');
  mkdirSync(stubs);
  writeFileSync(join(stubs, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(stubs, 'id'), `#!/bin/sh\necho ${uid}\n`, { mode: 0o755 });
  const r = spawnSync('bash', [join(HERE, 'gha-ephemeral-run.sh'), 'r1'], {
    env: {
      ...process.env, PATH: `${pool}/stubs:${process.env.PATH}`, GHA_POOL_ROOT: pool, GHA_MANIFEST: join(pool, 'no-such-manifest'),
      PITLANE_JOB_SUMMARY: hookPath, ACTIONS_RUNNER_HOOK_JOB_COMPLETED: '/inherited/hook', PITLANE_BUILD_GUARD: guardPath, ACTIONS_RUNNER_HOOK_JOB_STARTED: '/inherited/started',
    },
    encoding: 'utf8',
  });
  const res = { hookPath, guardPath, status: r.status, text: `${r.stdout}${r.stderr}`, rowLeft: existsSync(join(dir, '.row')), jitLeft: existsSync(join(dir, '.jitconfig')) };
  rmSync(pool, { recursive: true, force: true });
  return res;
}

test('the run step starts the runner from .row with no manifest on the host, and removes .row and .jitconfig', () => {
  const r = runStep((dir) => `${dir} lbl-a,lbl-b\n`);
  assert.equal(r.status, 0, r.text);
  assert.match(r.text, /RUNNER --jitconfig jit-value/);
  assert.match(r.text, /labels lbl-a,lbl-b/);
  assert.equal(r.rowLeft, false);
  assert.equal(r.jitLeft, false);
});

test('the run step fails closed when .row is missing, a symlink, or names another directory', () => {
  for (const [what, rowFor] of [
    ['missing', () => null],
    ['a symlink', () => 'link'],
    ['another directory', () => '/srv/gha/other lbl\n'],
    ['no labels', (dir) => `${dir}\n`],
    ['empty', () => ''],
  ]) {
    const r = runStep(rowFor);
    if (r === null) continue;
    assert.equal(r.status, 1, `${what}: ${r.text}`);
    assert.doesNotMatch(r.text, /RUNNER/, `${what}: the runner started`);
    assert.equal(r.jitLeft, true, `${what}: the JIT config was consumed`);
  }
});

test('the run step points the runner at the job-completed hook only when the hook is executable', () => {
  const on = runStep((dir) => `${dir} lbl\n`, { hook: 'exec' });
  assert.equal(on.status, 0, on.text);
  assert.ok(on.text.includes(`HOOK=${on.hookPath}\n`), on.text);
  const off = runStep((dir) => `${dir} lbl\n`);
  assert.equal(off.status, 0, off.text);
  assert.ok(off.text.includes('HOOK=unset\n'), off.text);
});

test('a root row points the runner at the build guard as its job-started hook; a job account\'s row never does', () => {
  const root = runStep((dir) => `${dir} lbl\n`, { guard: 'exec', uid: 0 });
  assert.equal(root.status, 0, root.text);
  assert.ok(root.text.includes(`STARTED=${root.guardPath}\n`), root.text);
  assert.doesNotMatch(root.text, /unchecked/);
  const user = runStep((dir) => `${dir} lbl\n`, { guard: 'exec' });
  assert.equal(user.status, 0, user.text);
  assert.ok(user.text.includes('STARTED=unset\n'), user.text);
  assert.doesNotMatch(user.text, /unchecked/);
});

test('a root row with no executable guard, or a symlinked one, runs its job unchecked and says so', () => {
  for (const guard of ['none', 'plain', 'link']) {
    const r = runStep((dir) => `${dir} lbl\n`, { guard, uid: 0 });
    if (r === null) continue;
    assert.equal(r.status, 0, `${guard}: ${r.text}`);
    assert.ok(r.text.includes('STARTED=unset\n'), `${guard}: ${r.text}`);
    assert.ok(r.text.includes(`no build guard at ${r.guardPath}: this root row runs its job unchecked`), `${guard}: ${r.text}`);
  }
});

test('the run step reads no file under /etc', () => {
  const code = readFileSync(join(HERE, 'gha-ephemeral-run.sh'), 'utf8').replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(code, /MANIFEST|\/etc\//);
});

/**
 * Run the mint step's steps 2 and 3 (remove_stale, mint and the 409 retry) with a stub gh on PATH.
 * `registered` is the stale registration GitHub holds for the name ('' for none, else "<status> <busy>");
 * `refuse` makes every mint fail with that message. Returns the gh calls, the outcome and the log.
 */
function mintSection({ registered = '', refuse = null }) {
  const dir = mkdtempSync(join(tmpdir(), 'mint-'));
  const bin = join(dir, 'bin'); mkdirSync(bin, { recursive: true });
  const sh = (p) => p.split('\\').join('/');
  const calls = join(dir, 'calls.txt');
  const reg = join(dir, 'registered');
  if (registered) writeFileSync(reg, registered);
  writeFileSync(join(bin, 'gh'), [
    '#!/usr/bin/env bash',
    `echo "$*" >> '${sh(calls)}'`,
    'case "$*" in',
    `  *generate-jitconfig*)`,
    refuse ? `    echo '${refuse}' >&2; exit 1 ;;` : `    if [ -f '${sh(reg)}' ]; then echo 'gh: Already exists - A runner with the name n1 already exists. (HTTP 409)' >&2; exit 1; fi; echo JITCONFIG ;;`,
    `  *"-X DELETE"*) rm -f '${sh(reg)}' ;;`,
    `  *actions/runners*) if [ -f '${sh(reg)}' ]; then echo "77 $(cat '${sh(reg)}')"; fi ;;`,
    'esac',
  ].join('\n') + '\n', { mode: 0o755 });
  const start = MINT.indexOf('# ── 2. stale registration');
  const end = MINT.indexOf('unset GH_TOKEN RUNNER_TOKEN');
  assert.ok(start > 0 && end > start, 'steps 2 and 3 not found in the mint script');
  const driver = [
    'set -euo pipefail',
    'log() { printf "log: %s\\n" "$*"; }',
    'fail() { printf "fail: %s\\n" "$*"; exit 1; }',
    'api=repos/o/r; NAME=n1; labels=a,b; GH_RUNNER_GROUP_ID=1; BUSY_WAIT_SECS=0',
    MINT.slice(start, end),
    'echo "jit=$jit"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', driver], { env: { ...process.env, PATH: `${sh(bin)}:${process.env.PATH}` }, encoding: 'utf8' });
  const seen = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out: r.stdout, calls: seen.map((c) => (c.includes('generate-jitconfig') ? 'mint' : c.includes('-X DELETE') ? 'delete' : 'list')) };
}

test('the mint step mints first: with no stale registration it makes one API call', () => {
  const r = mintSection({});
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.calls, ['mint']);
  assert.match(r.out, /^jit=JITCONFIG$/m);
});

test('a name GitHub still holds is listed, removed and minted again, only after the 409', () => {
  const r = mintSection({ registered: 'offline false' });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.calls, ['mint', 'list', 'delete', 'mint']);
  assert.match(r.out, /removed stale registration n1 \(id 77, was offline\)/);
  assert.match(r.out, /^jit=JITCONFIG$/m);
});

test('a busy registration of the name is still refused after the wait, and nothing is deleted', () => {
  const r = mintSection({ registered: 'online true' });
  assert.equal(r.status, 1, r.out);
  assert.ok(!r.calls.includes('delete'), r.calls.join(','));
  assert.match(r.out, /still registered and BUSY/);
});

test('a mint refused for any other reason fails without listing the registrations', () => {
  const r = mintSection({ refuse: 'gh: Resource not accessible by personal access token (HTTP 403)' });
  assert.equal(r.status, 1, r.out);
  assert.deepEqual(r.calls, ['mint']);
  assert.match(r.out, /fail: JIT config request failed: gh: Resource not accessible/);
});

/**
 * Run the mint step's token section with a stub App token command answering `appExit` (and `appOut`).
 * `org` runs it for an org row of sprayberry-code (oss-write-1) with `lines` beside the token line.
 */
function tokenSection({ appExit, appOut = 'ghs_app', pat = 'pat_token', org = false, lines = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'mint-tok-'));
  const sh = (p) => p.split(String.fromCharCode(92)).join('/');
  const envf = join(dir, 'repo.env');
  const key = org ? 'GH_ORG_RUNNER_TOKEN' : 'GH_REPO_RUNNER_TOKEN';
  writeFileSync(envf, [...(pat ? [`${key}=${pat}`] : []), ...lines].map((l) => `${l}\n`).join(''));
  const ask = org ? 'sprayberry-code - organization_self_hosted_runners=write' : 'askalf dario administration=write';
  const app = join(dir, 'app-token');
  writeFileSync(app, `#!/usr/bin/env bash\n[ "$1 $2 $3" = "${ask}" ] || exit 9\necho ${appOut}\nexit ${appExit}\n`, { mode: 0o755 });
  const start = MINT.indexOf('# ── token (read here, root only)');
  const end = MINT.indexOf('export GH_TOKEN="$RUNNER_TOKEN"');
  assert.ok(start > 0 && end > start, 'token section not found in the mint script');
  const driver = [
    'set -euo pipefail',
    'log() { printf "log: %s\n" "$*"; }',
    'fail() { printf "fail: %s\n" "$*"; exit 1; }',
    org
      ? `ENV_FILE='${sh(envf)}'; token_key=GH_ORG_RUNNER_TOKEN; kind=org; target=sprayberry-code; GHA_APP_TOKEN='${sh(app)}'; NAME=oss-write-1; tier_user=gha-oss-write`
      : `ENV_FILE='${sh(envf)}'; token_key=GH_REPO_RUNNER_TOKEN; kind=repo; target=askalf/dario; GHA_APP_TOKEN='${sh(app)}'; NAME=dario-exec-e1; tier_user=gha-exec`,
    MINT.slice(start, end),
    'echo "token=$RUNNER_TOKEN source=$token_source"',
    'echo "group=$GH_RUNNER_GROUP_ID"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', driver], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out: r.stdout };
}

test('the mint step uses the App token for the target owner when it has one', () => {
  const r = tokenSection({ appExit: 0 });
  assert.match(r.out, /^token=ghs_app source=app$/m, r.out);
  assert.doesNotMatch(r.out, /^log:/m);
});

test('with no App configured (exit 3) the mint step uses the token file, silently', () => {
  const r = tokenSection({ appExit: 3, appOut: '' });
  assert.match(r.out, /^token=pat_token source=GH_REPO_RUNNER_TOKEN$/m, r.out);
  assert.doesNotMatch(r.out, /^log:/m);
});

test('an App not installed on the account (exit 4) falls back to the token file, silently', () => {
  const r = tokenSection({ appExit: 4, appOut: '' });
  assert.match(r.out, /^token=pat_token source=GH_REPO_RUNNER_TOKEN$/m, r.out);
  assert.doesNotMatch(r.out, /^log:/m);
});

test('an App that fails to mint falls back to the token file and says so', () => {
  const r = tokenSection({ appExit: 1, appOut: '' });
  assert.match(r.out, /^token=pat_token source=GH_REPO_RUNNER_TOKEN$/m, r.out);
  assert.match(r.out, /no App token for askalf \(gha-app-token\.sh exit 1\)/);
});

test('neither an App token nor a token file: the mint step fails', () => {
  const r = tokenSection({ appExit: 3, appOut: '', pat: '' });
  assert.equal(r.status, 1);
  assert.match(r.out, /fail: GH_REPO_RUNNER_TOKEN empty/);
});

test('an org row asks the App for the org\'s self-hosted runners alone and uses its token', () => {
  const r = tokenSection({ appExit: 0, org: true, lines: ['GH_RUNNER_GROUP_ID_OSS_WRITE_1=7'] });
  assert.match(r.out, /^token=ghs_app source=app$/m, r.out);
  assert.match(r.out, /^group=7$/m);
  assert.doesNotMatch(r.out, /^(log|fail):/m);
});

test('an org row with the token line retired mints with the App and keeps its runner group', () => {
  const r = tokenSection({ appExit: 0, org: true, pat: '', lines: ['GH_RUNNER_GROUP_ID=3', 'GH_RUNNER_GROUP_ID_OSS_WRITE_1=7'] });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^token=ghs_app source=app$/m, r.out);
  assert.match(r.out, /^group=7$/m);
});

test('an org row with no App on the org mints with GH_ORG_RUNNER_TOKEN, silently', () => {
  const r = tokenSection({ appExit: 4, appOut: '', org: true, lines: ['GH_RUNNER_GROUP_ID_OSS_WRITE_1=7'] });
  assert.match(r.out, /^token=pat_token source=GH_ORG_RUNNER_TOKEN$/m, r.out);
  assert.match(r.out, /^group=7$/m);
  assert.doesNotMatch(r.out, /^log:/m);
});

test('the token line retired and the App not installed on the org: the mint step names the install', () => {
  const r = tokenSection({ appExit: 4, appOut: '', org: true, pat: '', lines: ['GH_RUNNER_GROUP_ID_OSS_WRITE_1=7'] });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /fail: GH_ORG_RUNNER_TOKEN empty in .* and no runner App is installed on sprayberry-code .*; install one there/);
});

/** The runner group the mint step picks for row `name` on account `tierUser`, from a token file holding `lines`. */
function groupSection({ name, tierUser, lines }) {
  const dir = mkdtempSync(join(tmpdir(), 'mint-grp-'));
  const sh = (p) => p.split(String.fromCharCode(92)).join('/');
  const envf = join(dir, 'org.env');
  writeFileSync(envf, ['GH_ORG_RUNNER_TOKEN=t', ...lines].join('\n') + '\n');
  const start = MINT.indexOf('RUNNER_TOKEN=$(grep -m1');
  const end = MINT.indexOf("# The runner GitHub App's installation token");
  assert.ok(start > 0 && end > start, 'group section not found in the mint script');
  const driver = [
    'set -euo pipefail',
    'fail() { printf "fail: %s\\n" "$*"; exit 1; }',
    `ENV_FILE='${sh(envf)}'; token_key=GH_ORG_RUNNER_TOKEN; NAME=${name}; tier_user=${tierUser}`,
    MINT.slice(start, end),
    'echo "group=$GH_RUNNER_GROUP_ID"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', driver], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out: r.stdout };
}

test('an upstream write row registers only in the runner group its own key names', () => {
  const r = groupSection({ name: 'oss-write-1', tierUser: 'gha-oss-write', lines: ['GH_RUNNER_GROUP_ID=3', 'GH_RUNNER_GROUP_ID_OSS_WRITE_1=7'] });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^group=7$/m);
});

test('an upstream write row with no group of its own is refused, never put in the Default or shared group', () => {
  for (const lines of [[], ['GH_RUNNER_GROUP_ID=3']]) {
    const r = groupSection({ name: 'oss-write-1', tierUser: 'gha-oss-write', lines });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /fail: oss-write-1 is an upstream write row and GH_RUNNER_GROUP_ID_OSS_WRITE_1 is not set/);
    assert.doesNotMatch(r.out, /^group=/m);
  }
});

test('a row group that is not a number is refused', () => {
  const r = groupSection({ name: 'oss-write-1', tierUser: 'gha-oss-write', lines: ['GH_RUNNER_GROUP_ID_OSS_WRITE_1=7;x'] });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /is not a runner group id/);
});

test('other rows keep the shared group, or the Default one, unless they name their own', () => {
  assert.match(groupSection({ name: 'oss-read-1', tierUser: 'gha-oss-read', lines: ['GH_RUNNER_GROUP_ID=3'] }).out, /^group=3$/m);
  assert.match(groupSection({ name: 'oss-read-1', tierUser: 'gha-oss-read', lines: [] }).out, /^group=1$/m);
  assert.match(groupSection({ name: 'oss-read-1', tierUser: 'gha-oss-read', lines: ['GH_RUNNER_GROUP_ID_OSS_READ_1=9'] }).out, /^group=9$/m);
});

test('the box state no job may list or read (docs/isolation.md, Host state files): park marks 700, the run directory 0711, the files to the dashboard\'s group', () => {
  // The runner lists each directory above a job's _work before the job starts and fails it when one
  // refuses, so /srv/gha stays listable (755); at 711 every job on every row failed at start.
  assert.match(APPLY, /chmod 755 "\$POOL_ROOT"/, 'the runner can list each directory above _work');
  assert.doesNotMatch(APPLY, /chmod 711 "\$POOL_ROOT"/);
  for (const [name, text] of [['apply', APPLY], ['mint', MINT]]) {
    assert.match(text, /mkdir -p -m 700 "\$PARK_DIR"/, `${name} makes the park directory root's alone`);
    assert.doesNotMatch(text, /mkdir -p "\$PARK_DIR"/, `${name} makes the park directory at the umask's mode`);
  }
  const unit = (f) => readFileSync(join(HERE, f), 'utf8');
  assert.match(unit('pitlane-supervisor.service'), /^RuntimeDirectory=askalf\/pitlane$[\s\S]*^RuntimeDirectoryMode=0711$/m, 'systemd sets the mode at every start, even on a directory already there');
  for (const f of ['pitlane-supervisor.service', 'gha-ondemand.service']) {
    assert.match(unit(f), /^Environment=PITLANE_READ_GID=1001$/m, `${f} gives the dashboard's group read`);
  }
});
