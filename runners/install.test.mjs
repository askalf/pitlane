// node --test runners/install.test.mjs
// install.sh run as bash with --root into a temporary directory: the layout it writes, the settings
// it writes once and then keeps, the config it refuses, and its file list held to the tree (every
// unit and slice, every module a service imports, every /opt path a unit runs). No root, no systemd.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'install.sh');
const MINIMAL = join(HERE, 'examples', 'minimal');
const posix = (p) => p.replace(/\\/g, '/');
const POSIX_MODES = process.platform !== 'win32';

function run(args) {
  const r = spawnSync('bash', [posix(SCRIPT), ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const staged = () => mkdtempSync(join(tmpdir(), 'pitlane-install-'));
const at = (root, p) => join(root, ...p.split('/').filter(Boolean));

/** The CODE rows of install.sh: [source, destination, mode]. */
function codeRows() {
  const m = /^CODE='\n([\s\S]*?)\n'$/m.exec(readFileSync(SCRIPT, 'utf8'));
  assert.ok(m, 'the CODE list is in install.sh');
  return m[1].split('\n').filter((l) => l.trim()).map((l) => l.trim().split(/\s+/));
}

test('install --root --config: the code, the units and the config at the paths the units name, and the settings in dry mode', () => {
  const root = staged();
  const r = run(['install', '--root', posix(root), '--config', posix(MINIMAL)]);
  assert.equal(r.code, 0, r.err + r.out);
  for (const [src, dst] of codeRows()) {
    assert.ok(existsSync(at(root, dst)), `${dst} installed`);
    assert.equal(readFileSync(at(root, dst), 'utf8'), readFileSync(join(HERE, src), 'utf8'), `${dst} is ${src}`);
  }
  for (const f of ['runners.manifest', 'runners.cpu', 'runners.isolated', 'runners.retired', 'runners.build-allow']) {
    const dst = f === 'runners.manifest' ? 'etc/askalf/gha-runners.manifest' : `etc/askalf/${f}`;
    assert.equal(readFileSync(at(root, dst), 'utf8'), readFileSync(join(MINIMAL, f), 'utf8'), `${dst} is the config's ${f}`);
  }
  assert.ok(!existsSync(at(root, 'etc/askalf/pitlane-build.env')), 'a config without build rows ships no pitlane-build.env');

  const od = readFileSync(at(root, 'etc/askalf/gha-ondemand.env'), 'utf8');
  assert.match(od, /^MODE=dry$/m, 'the dispatcher starts in dry mode');
  assert.match(od, /^HOOK_SECRET=[0-9a-f]{64}$/m, 'a fresh 32-byte webhook secret');
  assert.match(od, /^HOOK_PORT=7311$/m);
  assert.match(od, /^PITLANE_READ_GID=none$/m, 'no reader group: the unit\'s gid 1001 is this host\'s, not yours');
  const sv = readFileSync(at(root, 'etc/askalf/pitlane-supervisor.env'), 'utf8');
  assert.match(sv, /^PITLANE_MODE=observe$/m);
  assert.match(sv, /^PITLANE_READ_GID=none$/m);
  assert.match(r.out, /Nothing is running yet/);

  if (POSIX_MODES) {
    const mode = (p) => (statSync(at(root, p)).mode & 0o777).toString(8);
    assert.equal(mode('opt/askalf/gha-ephemeral-mint.sh'), '755');
    assert.equal(mode('opt/askalf/gha-ondemand.mjs'), '644');
    assert.equal(mode('etc/systemd/system/gha-ondemand.service'), '644');
    assert.equal(mode('etc/askalf/gha-runners.manifest'), '640');
    assert.equal(mode('etc/askalf/gha-ondemand.env'), '600', 'it holds the webhook secret');
    assert.equal(mode('etc/askalf/pitlane-supervisor.env'), '600');
  }
});

test('a second run changes nothing it already wrote: the same files say nothing, the settings and their secret are kept', () => {
  const root = staged();
  assert.equal(run(['install', '--root', posix(root), '--config', posix(MINIMAL)]).code, 0);
  const before = readFileSync(at(root, 'etc/askalf/gha-ondemand.env'), 'utf8');
  writeFileSync(at(root, 'etc/askalf/pitlane-supervisor.env'), 'PITLANE_MODE=heal\n');
  const r = run(['install', '--root', posix(root), '--config', posix(MINIMAL)]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\(\d+ files, 0 changed\)/);
  assert.doesNotMatch(r.out, /^\s+(new|changed)\s/m, 'nothing new or changed');
  assert.match(r.out, /kept\s+\/etc\/askalf\/gha-ondemand\.env/);
  assert.equal(readFileSync(at(root, 'etc/askalf/gha-ondemand.env'), 'utf8'), before, 'the webhook secret GitHub holds stays valid');
  assert.equal(readFileSync(at(root, 'etc/askalf/pitlane-supervisor.env'), 'utf8'), 'PITLANE_MODE=heal\n', 'an edited settings file is the operator\'s');
});

test('without --config it upgrades code and units only, keeping the config on the host; with no config there it refuses', () => {
  const empty = staged();
  const none = run(['install', '--root', posix(empty)]);
  assert.equal(none.code, 1);
  assert.match(none.err, /give one with --config DIR/);
  assert.deepEqual(readdirSync(empty), [], 'nothing written');

  const root = staged();
  assert.equal(run(['install', '--root', posix(root), '--config', posix(MINIMAL)]).code, 0);
  writeFileSync(at(root, 'etc/askalf/runners.cpu'), '# edited on the host\n');
  writeFileSync(at(root, 'opt/askalf/gha-ondemand.mjs'), '// an older copy\n');
  const r = run(['install', '--root', posix(root)]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /changed\s+\/opt\/askalf\/gha-ondemand\.mjs/);
  assert.equal(readFileSync(at(root, 'opt/askalf/gha-ondemand.mjs'), 'utf8'), readFileSync(join(HERE, 'gha-ondemand.mjs'), 'utf8'));
  assert.equal(readFileSync(at(root, 'etc/askalf/runners.cpu'), 'utf8'), '# edited on the host\n', 'the host\'s config is not touched');
});

test('a config that does not hold together installs nothing', () => {
  const cfg = staged();
  cpSync(MINIMAL, cfg, { recursive: true });
  writeFileSync(join(cfg, 'runners.cpu'), '# no line for app-exec-e1\n');
  const root = staged();
  const r = run(['install', '--root', posix(root), '--config', posix(cfg)]);
  assert.equal(r.code, 1);
  assert.match(r.err, /app-exec-e1 is an exec row with no runners\.cpu line/);
  assert.match(r.err, /nothing was installed/);
  assert.deepEqual(readdirSync(root), []);
  const missing = staged();
  cpSync(MINIMAL, missing, { recursive: true });
  assert.equal(run(['install', '--root', posix(missing), '--config', posix(join(missing, 'nope'))]).code, 1, 'a --config that is not a directory');
});

test('usage: an unknown command or option exits 2; check takes no options', () => {
  assert.equal(run([]).code, 2);
  assert.equal(run(['deploy']).code, 2);
  assert.equal(run(['install', '--force']).code, 2);
  assert.equal(run(['check', '--root', '/tmp/x']).code, 2);
  assert.match(run(['--help']).out, /install --config DIR/);
});

test('the file list is the tree: every unit and slice, every module a service imports, every /opt path a unit runs', () => {
  const rows = codeRows();
  const sources = new Set(rows.map(([s]) => s));
  const dests = new Set(rows.map(([, d]) => d));
  for (const f of readdirSync(HERE)) {
    if (/\.(service|slice)$/.test(f)) assert.ok(sources.has(f), `${f} is installed`);
  }
  // The import closure of the three long-running services.
  const seen = new Set();
  const visit = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const m of readFileSync(join(HERE, f), 'utf8').matchAll(/from '\.\/([\w.-]+\.mjs)'/g)) visit(m[1]);
  };
  for (const f of ['gha-ondemand.mjs', 'pitlane-supervisor.mjs', 'pitlane-public.mjs']) visit(f);
  for (const f of seen) assert.ok(sources.has(f), `${f} (imported by a service) is installed`);
  for (const f of readdirSync(HERE).filter((n) => /\.(service|slice)$/.test(n))) {
    for (const m of readFileSync(join(HERE, f), 'utf8').matchAll(/(\/opt\/askalf\/[\w.-]+\.(?:sh|mjs))/g)) {
      assert.ok(dests.has(m[1]), `${m[1]} (run by ${f}) is installed`);
    }
  }
  for (const [s, d, mode] of rows) {
    assert.ok(existsSync(join(HERE, s)), `${s} exists`);
    assert.match(mode, /^(755|644|640)$/, `${s}: a mode install understands`);
    if (s.endsWith('.sh')) assert.equal(mode, '755', `${s} is run directly`);
    assert.ok(d.startsWith('/opt/askalf/') || d.startsWith('/etc/systemd/system/') || d.startsWith('/etc/askalf/'), `${d}: under a path the units name`);
  }
});
