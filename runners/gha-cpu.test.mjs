// node --test runners/gha-cpu.test.mjs
// The per-row CPU shape functions of gha-runners-apply.sh, run in bash against a temp unit directory:
// nothing is written outside it and nothing needs root.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APPLY = readFileSync(join(HERE, 'gha-runners-apply.sh'), 'utf8');
const fn = (re) => {
  const m = re.exec(APPLY);
  assert.ok(m, `not found: ${re}`);
  return m[0];
};
const PIECES = [
  fn(/^cpu_line\(\) \{[\s\S]*?^\}$/m),
  fn(/^cpu_opt\(\) \{[\s\S]*?^\}$/m),
  fn(/^cpu_total\(\).*$/m),
  fn(/^cpu_window\(\) \{[\s\S]*?^\}$/m),
  fn(/^cpu_dropin\(\) \{[\s\S]*?^\}$/m),
  fn(/^cpu_row\(\) \{[\s\S]*?^\}$/m),
].join('\n');

/** Run cpu_row in `mode` for `row` against `list` on a host of `total` CPUs; `prior` is an existing drop-in, `queued` a unit already queued for restart. */
function run({ mode = 'apply', list, row = 'dario-exec-e1', total = 8, prior = null, queued = false, reuse = null }) {
  const dir = reuse ?? mkdtempSync(join(tmpdir(), 'cpu-'));
  const unitDir = join(dir, 'units'); mkdirSync(unitDir, { recursive: true });
  const sh = (p) => p.split('\\').join('/');
  const file = join(dir, 'runners.cpu');
  if (list !== null) writeFileSync(file, list);
  const unit = `gha-ephemeral-first-party@${row}.service`;
  const dropin = join(unitDir, `${unit}.d`, '30-cpu.conf');
  if (prior !== null) { mkdirSync(join(unitDir, `${unit}.d`), { recursive: true }); writeFileSync(dropin, prior); }
  const driver = [
    `UNIT_DIR='${sh(unitDir)}'; CPU_FILE='${sh(file)}'; CPU_DROPIN=30-cpu.conf; GHA_CPU_TOTAL=${total}`,
    'log() { printf "%s\n" "$*"; }',
    PIECES,
    `changed=0; to_restart=(${queued ? `'${unit}|/srv/gha/${row}'` : ''})`,
    `cpu_row ${mode} '${row}' '${unit}' '/srv/gha/${row}'; echo "rc=$?"`,
    'echo "changed=$changed restart=${to_restart[*]:-}"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', driver], { encoding: 'utf8' });
  return { dir, out: r.stdout.trim().split('\n'), err: r.stderr, dropin: existsSync(dropin) ? readFileSync(dropin, 'utf8') : null };
}
const body = (d) => d.split('\n').filter((l) => !l.startsWith('#'));

test('a row not on the list has no drop-in and nothing changes', () => {
  const r = run({ list: '# none\nother-row cpus=4\n' });
  assert.equal(r.dropin, null);
  assert.match(r.out.at(-1), /changed=0/);
  assert.equal(run({ list: null }).dropin, null);
});

test('plan writes nothing; apply writes CPUAffinity and CPUWeight and queues the unit once', () => {
  const p = run({ mode: 'plan', list: 'dario-exec-e1 cpus=4 weight=200\n' });
  assert.equal(p.dropin, null);
  assert.match(p.out.at(-1), /changed=1 restart=gha-ephemeral-first-party@dario-exec-e1.service\|\/srv\/gha\/dario-exec-e1/);
  const a = run({ list: 'dario-exec-e1 cpus=4 weight=200\n' });
  assert.deepEqual(body(a.dropin).filter(Boolean), ['[Service]', 'CPUAffinity=0 1 2 3', 'CPUWeight=200']);
  const once = run({ list: 'dario-exec-e1 cpus=4\n', queued: true });
  assert.match(once.out.at(-1), /restart=gha-ephemeral-first-party@dario-exec-e1.service\|\/srv\/gha\/dario-exec-e1$/, 'a unit already queued is not queued twice');
});

test('windows rotate by position among the cpus= lines and wrap around the host', () => {
  const list = 'dario-exec-e1 cpus=4\nnoise weight=50\ndario-exec-e2 cpus=4\ndario-exec-e6 cpus=4\n';
  assert.match(run({ list, row: 'dario-exec-e1' }).dropin, /^CPUAffinity=0 1 2 3$/m);
  assert.match(run({ list, row: 'dario-exec-e2' }).dropin, /^CPUAffinity=1 2 3 4$/m, 'a weight-only line does not take a window');
  assert.match(run({ list, row: 'dario-exec-e6' }).dropin, /^CPUAffinity=2 3 4 5$/m);
  const wrap = Array.from({ length: 8 }, (_, i) => `r${i} cpus=3`).join('\n');
  assert.match(run({ list: wrap, row: 'r7' }).dropin, /^CPUAffinity=7 0 1$/m);
  assert.match(run({ list: wrap, row: 'r7', total: 4 }).dropin, /^CPUAffinity=3 0 1$/m, 'the host size bounds the window');
});

test('a weight alone writes no affinity', () => {
  const r = run({ list: 'dario-exec-e1 weight=50\n' });
  assert.deepEqual(body(r.dropin).filter(Boolean), ['[Service]', 'CPUWeight=50']);
});

test('an unchanged drop-in changes nothing; an edited option rewrites it', () => {
  const first = run({ list: 'dario-exec-e1 cpus=4\n' });
  const again = run({ list: 'dario-exec-e1 cpus=4\n', prior: first.dropin.replace(/\n$/, ''), reuse: first.dir });
  assert.match(again.out.join('\n'), /ok .* cpu shape/);
  assert.match(again.out.at(-1), /changed=0/);
  const edited = run({ list: 'dario-exec-e1 cpus=2\n', prior: first.dropin.replace(/\n$/, ''), reuse: first.dir });
  assert.match(edited.out.at(-1), /changed=1/);
  assert.match(edited.dropin, /^CPUAffinity=0 1$/m);
});

test('taking a row off the list removes the drop-in and queues a restart', () => {
  const r = run({ list: '# none\n', prior: '[Service]\nCPUAffinity=0 1 2 3\n' });
  assert.match(r.out.join('\n'), /UNCPU/);
  assert.equal(r.dropin, null);
  assert.match(r.out.at(-1), /changed=1/);
  assert.match(run({ mode: 'plan', list: '# none\n' }).out.at(-1), /changed=0/);
});

test('a bad option holds the row and writes nothing', () => {
  for (const bad of ['cpus=0', 'cpus=9', 'cpus=x', 'weight=0', 'weight=10001', 'weight=x']) {
    const r = run({ list: `dario-exec-e1 ${bad}\n` });
    assert.match(r.out.join('\n'), /hold .*(outside|not a number)/, bad);
    assert.match(r.out.join('\n'), /rc=1/, bad);
    assert.equal(r.dropin, null, bad);
  }
});

test('the apply loop runs cpu_row for ephemeral rows right after the isolation step', () => {
  const iso = APPLY.indexOf('isolate_row "$mode" "$name" "$unit" "$user" "$dir" || continue');
  const cpu = APPLY.indexOf('cpu_row "$mode" "$name" "$unit" "$dir" || continue');
  assert.ok(iso > 0 && cpu > iso, 'cpu_row is called after isolate_row');
});
