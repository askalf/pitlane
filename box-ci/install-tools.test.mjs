// node --test box-ci/install-tools.test.mjs
// The playwright-core install of install-tools.sh, run as bash against a temporary BOX_CI_DIR with
// stubs on PATH: `id` answers root, `sha256sum` answers the act pin (so the act half has nothing to
// do), `npm` records how it was called, and the playwright-core it installs records the browser
// install. No network, no root, nothing outside the temporary directory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, 'install-tools.sh');
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf8');
const pin = (name) => {
  const m = new RegExp(`^${name}=(\\S+)$`, 'm').exec(SCRIPT);
  assert.ok(m, `${name} not found in install-tools.sh`);
  return m[1];
};
const PW_VERSION = pin('PW_VERSION');
const PW_INTEGRITY = pin('PW_INTEGRITY');
const ACT_BIN_SHA256 = pin('ACT_BIN_SHA256');
const posix = (p) => p.replace(/\\/g, '/');

function stub(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
}

/** Runs `install-tools.sh apply` with the stubs; npmExit is what the stub npm exits with. */
function apply({ npmExit = 0 } = {}) {
  const t = mkdtempSync(join(tmpdir(), 'install-tools-'));
  const box = join(t, 'box-ci');
  const bin = join(t, 'stubs');
  mkdirSync(box, { recursive: true });
  mkdirSync(bin, { recursive: true });
  // act is present, and the stub sha256sum says it matches its pin: only the browser half runs.
  writeFileSync(join(box, 'act'), '#!/bin/sh\n');
  chmodSync(join(box, 'act'), 0o755);
  stub(bin, 'id', 'echo 0');
  stub(bin, 'sha256sum', `echo "${ACT_BIN_SHA256}  $1"`);
  const log = posix(join(t, 'calls.log'));
  // The stub npm records its arguments and the directory it ran in, then lays out a playwright-core
  // whose cli records the browser install.
  stub(bin, 'npm', [
    `echo "npm $* | $(pwd)" >> '${log}'`,
    `[ "${npmExit}" = 0 ] || exit ${npmExit}`,
    'mkdir -p node_modules/.bin',
    `printf '#!/usr/bin/env bash\\necho "playwright-core $* | $PLAYWRIGHT_BROWSERS_PATH" >> "${log}"\\n' > node_modules/.bin/playwright-core`,
    'chmod 755 node_modules/.bin/playwright-core',
  ].join('\n'));
  const r = spawnSync('bash', [posix(SCRIPT_PATH), 'apply'], {
    env: { ...process.env, PATH: `${posix(bin)}:${process.env.PATH}`, BOX_CI_DIR: posix(box) },
    encoding: 'utf8',
  });
  const calls = existsSync(join(t, 'calls.log')) ? readFileSync(join(t, 'calls.log'), 'utf8').trim().split('\n') : [];
  return { r, box, calls, pwDir: join(box, 'pw-install') };
}

test('apply writes a package.json and a lockfile carrying the pinned version and integrity, then runs npm ci', () => {
  const { r, calls, pwDir, box } = apply();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const pkg = JSON.parse(readFileSync(join(pwDir, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, { 'playwright-core': PW_VERSION });
  const lock = JSON.parse(readFileSync(join(pwDir, 'package-lock.json'), 'utf8'));
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[''].dependencies, { 'playwright-core': PW_VERSION });
  const entry = lock.packages['node_modules/playwright-core'];
  assert.equal(entry.version, PW_VERSION);
  assert.equal(entry.integrity, PW_INTEGRITY);
  assert.match(PW_INTEGRITY, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(entry.resolved, `https://registry.npmjs.org/playwright-core/-/playwright-core-${PW_VERSION}.tgz`);
  // npm ci, which refuses a tarball whose hash differs from the lockfile's, is the only npm call.
  const npm = calls.filter((c) => c.startsWith('npm '));
  assert.equal(npm.length, 1, calls.join('\n'));
  assert.match(npm[0], /^npm ci --no-audit --no-fund \| /);
  assert.ok(npm[0].endsWith(posix(pwDir)) || npm[0].includes('pw-install'), npm[0]);
  // Then the browser, into the pinned browsers directory.
  const pw = calls.filter((c) => c.startsWith('playwright-core '));
  assert.equal(pw.length, 1, calls.join('\n'));
  assert.match(pw[0], /^playwright-core install chromium \| /);
  assert.ok(pw[0].endsWith(`${posix(box)}/pw-browsers`), pw[0]);
  assert.match(r.stdout, new RegExp(`chromium: installed for playwright-core ${PW_VERSION.replace(/\./g, '\\.')}`));
});

test('a failing npm ci stops the run before the browser install', () => {
  const { r, calls } = apply({ npmExit: 3 });
  assert.notEqual(r.status, 0, 'the run fails');
  assert.ok(calls.some((c) => c.startsWith('npm ci ')), calls.join('\n'));
  assert.ok(!calls.some((c) => c.startsWith('playwright-core ')), 'no browser install after a failed npm ci');
  assert.ok(!/chromium: installed/.test(r.stdout));
});
