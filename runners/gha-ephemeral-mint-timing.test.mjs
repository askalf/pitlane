// node --test runners/gha-ephemeral-mint-timing.test.mjs
// keep_worker_timing of gha-ephemeral-mint.sh: before the cycle's reset removes _diag, the newest
// worker log's timestamped lines are kept as a root-only digest per row. Run as bash against
// directories on disk, the way the pool tests run the claim: no systemd, no runner.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(join(HERE, 'gha-ephemeral-mint.sh'), 'utf8');
const m = /^keep_worker_timing\(\) \{[\s\S]*?^\}$/m.exec(SCRIPT);
assert.ok(m, 'keep_worker_timing not found');
const FN = m[0];
const posix = (p) => p.replace(/\\/g, '/');
const CALL = '( trap - ERR; set +e; keep_worker_timing ) || true';

/** A pool root with row `name` whose _diag holds `logs` ({ file: text }), mtimes a minute apart in the order given. */
function row(name, logs = {}) {
  const pool = mkdtempSync(join(tmpdir(), 'mint-timing-'));
  const diag = join(pool, name, '_diag');
  mkdirSync(diag, { recursive: true });
  let t = Math.floor(Date.now() / 1000) - 3600;
  for (const [file, text] of Object.entries(logs)) {
    writeFileSync(join(diag, file), text);
    utimesSync(join(diag, file), t, t);
    t += 60;
  }
  return { pool, dir: join(pool, name), diag, root: join(pool, '.timing'), kept: join(pool, '.timing', name) };
}

/** Runs the call as the mint step does: set -Eeuo pipefail and an ERR trap that exits 255. */
function run(r, name, env = {}, extra = '') {
  const vars = Object.entries(env).map(([k, v]) => `export ${k}='${v}'`).join('\n');
  const driver = [
    'set -Eeuo pipefail', "trap 'exit 255' ERR",
    `log() { printf 'gha-ephemeral-mint[%s]: %s\\n' "$NAME" "$*"; }`,
    FN, extra, vars,
    `NAME='${name}'; POOL_ROOT='${posix(r.pool)}'; dir='${posix(r.dir)}'`,
    CALL, 'echo after',
  ].join('\n');
  return spawnSync('bash', ['-c', driver], { encoding: 'utf8' });
}
const digests = (r) => (existsSync(r.kept) ? readdirSync(r.kept).filter((f) => /^\d{8}T\d{6}Z\.log$/.test(f)).sort() : []);

const LINE = (t, msg) => `[2026-11-02 ${t}Z INFO JobRunner] ${msg}`;

test('the newest worker log is kept as its timestamped lines only, each cut to 240 bytes, in a 700 directory', () => {
  const r = row('dario-build-e1', {
    'Worker_20261102-201000-utc.log': `${LINE('20:10:00', 'older job')}\n`,
    'Worker_20261102-203029-utc.log': [LINE('20:30:29', 'Job starts'), '  a continuation line', LINE('20:30:57', 'Step done'), LINE('20:32:32', `Job completed ${'x'.repeat(400)}`)].join('\n') + '\n',
    'Runner_20261102-203000-utc.log': `${LINE('20:30:00', 'listener')}\n`,
  });
  const p = run(r, 'dario-build-e1');
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stdout.trim(), 'after');
  const d = digests(r);
  assert.equal(d.length, 1);
  const lines = readFileSync(join(r.kept, d[0]), 'utf8').trimEnd().split('\n');
  assert.deepEqual(lines.slice(0, 2), [LINE('20:30:29', 'Job starts'), LINE('20:30:57', 'Step done')]);
  assert.equal(lines.length, 3);
  assert.equal(lines[2].length, 240);
  assert.ok(!lines.join('\n').includes('older job') && !lines.join('\n').includes('listener'));
  if (process.platform !== 'win32') {
    assert.equal(statSync(r.root).mode & 0o777, 0o700);
    assert.equal(statSync(r.kept).mode & 0o777, 0o700);
  }
});

test('only the last PITLANE_TIMING_LINES lines, read from the last PITLANE_TIMING_BYTES of the file', () => {
  const body = Array.from({ length: 50 }, (_, i) => LINE(`20:${String(i).padStart(2, '0')}:00`, `line ${i}`)).join('\n') + '\n';
  const r = row('ci-exec-e1', { 'Worker_20261102-200000-utc.log': body });
  run(r, 'ci-exec-e1', { PITLANE_TIMING_LINES: '5' });
  let lines = readFileSync(join(r.kept, digests(r)[0]), 'utf8').trimEnd().split('\n');
  assert.deepEqual(lines.map((l) => l.split('] ')[1]), ['line 45', 'line 46', 'line 47', 'line 48', 'line 49']);
  const r2 = row('ci-exec-e1', { 'Worker_20261102-200000-utc.log': body });
  run(r2, 'ci-exec-e1', { PITLANE_TIMING_BYTES: String(Buffer.byteLength(LINE('20:49:00', 'line 49')) + 1) });
  lines = readFileSync(join(r2.kept, digests(r2)[0]), 'utf8').trimEnd().split('\n');
  assert.deepEqual(lines, [LINE('20:49:00', 'line 49')]);
});

test('the newest PITLANE_TIMING_KEEP digests stay; anything else in the directory is left alone', () => {
  const r = row('pool-e1', { 'Worker_20261102-200000-utc.log': `${LINE('20:00:00', 'job')}\n` });
  mkdirSync(r.kept, { recursive: true });
  for (let i = 0; i < 4; i++) writeFileSync(join(r.kept, `2026110${1}T00000${i}Z.log`), 'old\n');
  writeFileSync(join(r.kept, 'notes.txt'), 'mine\n');
  run(r, 'pool-e1', { PITLANE_TIMING_KEEP: '3' });
  const d = digests(r);
  assert.equal(d.length, 3);
  assert.ok(!d.includes('20261101T000000Z.log') && !d.includes('20261101T000001Z.log'));
  assert.ok(d.includes('20261101T000003Z.log'));
  assert.ok(existsSync(join(r.kept, 'notes.txt')));
});

test('nothing is kept with no _diag, no worker log, an empty worker log, or PITLANE_TIMING=off', () => {
  const none = row('a-e1');
  run(none, 'a-e1');
  assert.ok(!existsSync(none.root));
  const runnerOnly = row('b-e1', { 'Runner_20261102-200000-utc.log': `${LINE('20:00:00', 'listener')}\n` });
  run(runnerOnly, 'b-e1');
  assert.ok(!existsSync(runnerOnly.root));
  const empty = row('c-e1', { 'Worker_20261102-200000-utc.log': 'no timestamped line\n' });
  run(empty, 'c-e1');
  assert.deepEqual(digests(empty), []);
  assert.deepEqual(readdirSync(empty.kept), [], 'no digest and no .part left behind');
  const off = row('d-e1', { 'Worker_20261102-200000-utc.log': `${LINE('20:00:00', 'job')}\n` });
  run(off, 'd-e1', { PITLANE_TIMING: 'off' });
  assert.ok(!existsSync(off.root));
});

test('a worker log the job made a symlink, or a _diag that is a symlink, is never read', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, () => {
  const r = row('e-e1');
  const secret = join(r.pool, 'secret.log');
  writeFileSync(secret, `${LINE('20:00:00', 'SECRET from outside the row')}\n`);
  symlinkSync(secret, join(r.diag, 'Worker_20261102-200000-utc.log'));
  run(r, 'e-e1');
  assert.deepEqual(digests(r), []);
  const r2 = row('f-e1');
  const elsewhere = join(r2.pool, 'elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'Worker_20261102-200000-utc.log'), `${LINE('20:00:00', 'SECRET')}\n`);
  spawnSync('bash', ['-c', `rm -rf '${posix(r2.diag)}' && ln -s '${posix(elsewhere)}' '${posix(r2.diag)}'`]);
  run(r2, 'f-e1');
  assert.ok(!existsSync(r2.root));
});

test('a failure inside it never stops the start: the mint step goes on under its ERR trap', () => {
  const r = row('g-e1', { 'Worker_20261102-200000-utc.log': `${LINE('20:00:00', 'job')}\n` });
  const p = run(r, 'g-e1', {}, 'chmod() { return 1; }');
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stdout.trim(), 'after');
});

test('the call sits right before the reset, in a subshell with the ERR trap and errexit off', () => {
  const at = SCRIPT.indexOf(`${CALL}\n# Reset: everything except the root-owned runner copy`);
  assert.ok(at > 0, 'call missing or not right before the reset');
  assert.ok(at < SCRIPT.indexOf('find "$dir" -mindepth 1 -maxdepth 1'), 'call must run before the find that removes _diag');
});
