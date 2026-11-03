// node --test runners/runner-config.test.mjs
// runner-config.mjs against runners/examples/ (a consistent set) and against that set with one mistake at a time.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ACCOUNTS, FILES, configProblems, readConfig, rows } from './runner-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = readConfig(join(HERE, 'examples'));

/** The example set with `file` changed by `edit` (text => text); returns its problems. */
function problemsWith(file, edit) {
  return configProblems({ ...EXAMPLES, [file]: edit(EXAMPLES[file]) });
}
/** Replace `a` in text exactly once. */
const swap = (a, b) => (t) => {
  assert.equal(t.split(a).length, 2, `the example text has ${JSON.stringify(a)} once`);
  return t.replace(a, b);
};
const add = (line) => (t) => `${t}${line}\n`;
/** One problem, at `file:line`, that matches `re`. */
function assertOne(problems, at, re) {
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.ok(problems[0].startsWith(`${at}: `), problems[0]);
  assert.match(problems[0], re);
}

test('the examples are a consistent set, and every file of the set is among them', () => {
  assert.deepEqual(configProblems(EXAMPLES), []);
  for (const f of FILES) assert.ok(rows(EXAMPLES[f]).length, `${f} has rows`);
  const manifest = rows(EXAMPLES['runners.manifest']).map((r) => r.words);
  assert.deepEqual([...new Set(manifest.map((r) => r[3]))].sort(), Object.keys(ACCOUNTS).filter((a) => a !== 'gha-oss-write').sort(), 'each account but the upstream write one has an example row');
});

test('rows() drops comments and blank lines and keeps line numbers', () => {
  assert.deepEqual(rows('# c\n\n  a  b # tail\nc\n').map((r) => [r.n, r.words]), [[3, ['a', 'b']], [4, ['c']]]);
});

test('the CLI checks runners/examples by default and exits 1 with a line per problem', () => {
  const ok = spawnSync(process.execPath, [join(HERE, 'runner-config.mjs')], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /consistent/);
  const dir = mkdtempSync(join(tmpdir(), 'runner-config-'));
  try {
    for (const f of FILES) writeFileSync(join(dir, f), EXAMPLES[f]);
    writeFileSync(join(dir, 'runners.cpu'), `${EXAMPLES['runners.cpu']}ghost cpus=2\n`);
    const bad = spawnSync(process.execPath, [join(HERE, 'runner-config.mjs'), dir], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /^runners\.cpu:\d+: ghost is not a row of runners\.manifest$/m);
    assert.match(bad.stdout, /: 1 problem$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing file reads as empty, and an empty manifest is a problem', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-config-'));
  try {
    const texts = readConfig(dir);
    assert.deepEqual(Object.keys(texts), FILES);
    assert.ok(Object.values(texts).every((t) => t === ''));
    assert.deepEqual(configProblems(texts), ['runners.manifest:0: no rows']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manifest: columns, names, scopes, tiers, accounts, paths, labels and modes', () => {
  const m = 'runners.manifest';
  const row = 'oss-1            org:example-forks   exec   gha-oss      /srv/gha/oss-1            self-hosted,Linux,X64,oss        ephemeral';
  const cases = [
    [row.replace(' ephemeral', ''), /6 columns, not 7/],
    [row.replace('oss-1 ', '-oss-1'), /is not a runner name/],
    [row.replace('org:example-forks', 'user:example'), /scope user:example is not/],
    [row.replace('exec   gha-oss ', 'write  gha-oss '), /tier write is not read, exec or build/],
    [row.replace('gha-oss ', 'gha-ci  '), /no unit template runs as gha-ci/],
    [row.replace('exec   gha-oss ', 'read   gha-oss '), /gha-oss serves the exec tier, not read/],
    [row.replace('/srv/gha/oss-1 ', 'srv/gha/oss-1  '), /is not an absolute path/],
    [row.replace('self-hosted,Linux,X64,oss', 'Linux,X64,oss,self-hosted'), /labels do not start self-hosted,Linux,X64/],
    [row.replace('ephemeral', 'pinned'), /mode pinned is not ephemeral, adopt or managed/],
    [row.replace('ephemeral', 'adopt'), /an org row is ephemeral \(JIT\) only/],
  ];
  const at = rows(EXAMPLES[m]).find((r) => r.words[0] === 'oss-1').n;
  for (const [line, re] of cases) {
    const problems = problemsWith(m, swap(row, line)).filter((p) => p.startsWith(`${m}:`));
    assert.ok(problems.length >= 1, `${line}: no problem`);
    assert.ok(problems.some((p) => p.startsWith(`${m}:${at}: `) && re.test(p)), `${line}:\n${problems.join('\n')}`);
  }
});

test('manifest: a row twice, a build row that is not a repository\'s, an exec row with no cpu line', () => {
  const m = 'runners.manifest';
  const dup = rows(EXAMPLES[m]).find((r) => r.words[0] === 'pool-e1');
  assertOne(problemsWith(m, add(dup.raw)), `${m}:${rows(EXAMPLES[m]).at(-1).n + 1}`, /pool-e1 is listed twice/);
  assert.ok(problemsWith(m, swap('repo:example/app    build', 'pool:example        build')).some((p) => /a build row runs as root, so it serves one repository/.test(p)));
  const noCpu = 'app-exec-e3      repo:example/app    exec   gha-exec     /srv/gha/app-exec-e3      self-hosted,Linux,X64,app-exec   ephemeral';
  const problems = problemsWith(m, add(noCpu));
  assert.ok(problems.some((p) => /app-exec-e3 is retired and still in runners\.manifest/.test(p)), problems.join('\n'));
  assert.ok(problems.some((p) => /app-exec-e3 is an exec row with no runners\.cpu line/.test(p)), problems.join('\n'));
});

test('retired: a day, a reason, once, and not in the manifest', () => {
  const r = 'runners.retired';
  const n = rows(EXAMPLES[r]).at(-1).n + 1;
  assertOne(problemsWith(r, add('old-1 2026-13-40 gone')), `${r}:${n}`, /2026-13-40 is not a YYYY-MM-DD day/);
  assertOne(problemsWith(r, add('old-1 2026-01-02')), `${r}:${n}`, /old-1: no reason/);
  assertOne(problemsWith(r, add('app-exec-e3 2026-02-01 again')), `${r}:${n}`, /app-exec-e3 is retired twice/);
  // A row retired too early is also named where runners.cpu and runners.isolated still list it.
  assert.deepEqual(problemsWith(r, add('pool-e2 2026-02-01 folded')).map((p) => p.replace(/:\d+:/, ':')).sort(), [
    'runners.cpu: pool-e2 is retired',
    'runners.isolated: pool-e2 is retired',
    'runners.retired: pool-e2 is retired and still in runners.manifest',
  ]);
});

test('cpu: a known row once, cpus at least 1, a weight in range, and no retired row', () => {
  const c = 'runners.cpu';
  const n = rows(EXAMPLES[c]).at(-1).n + 1;
  assertOne(problemsWith(c, add('ghost cpus=2')), `${c}:${n}`, /ghost is not a row of runners\.manifest/);
  assertOne(problemsWith(c, add('app-exec-e3 cpus=2')), `${c}:${n}`, /app-exec-e3 is retired/);
  assertOne(problemsWith(c, add('pool-e1 cpus=2')), `${c}:${n}`, /pool-e1 is listed twice/);
  assertOne(problemsWith(c, swap('oss-1        cpus=2 weight=50', 'oss-1        cpus=0 weight=50')), `${c}:${n - 1}`, /cpus=0 is under 1/);
  assertOne(problemsWith(c, swap('oss-1        cpus=2 weight=50', 'oss-1        cpus=2 weight=20000')), `${c}:${n - 1}`, /weight=20000 is outside 1\.\.10000/);
  assertOne(problemsWith(c, swap('oss-1        cpus=2 weight=50', 'oss-1        cpus=2 nice=5')), `${c}:${n - 1}`, /nice=5 is not cpus=N or weight=W/);
});

test('isolated: a known row once, never root, a group name, and an account useradd takes that no other row has', () => {
  const i = 'runners.isolated';
  const n = rows(EXAMPLES[i]).at(-1).n + 1;
  assertOne(problemsWith(i, add('ghost groups=none')), `${i}:${n}`, /ghost is not a row of runners\.manifest/);
  assertOne(problemsWith(i, add('app-build-e1 groups=none')), `${i}:${n}`, /app-build-e1 runs as root and cannot be isolated/);
  assert.ok(problemsWith(i, add('pool-e1 groups=none')).some((p) => /pool-e1 is listed twice/.test(p)));
  assert.ok(problemsWith(i, add('app-exec-e3 groups=none')).some((p) => p.startsWith(`${i}:${n}: app-exec-e3 is retired`)));
  const longName = 'pool-e2          groups=none';
  assert.ok(problemsWith(i, swap(longName, 'pool-e2          groups=none account=gx-a-very-long-account-name-for-pool-e2')).some((p) => /over useradd's 32 characters/.test(p)));
  assert.ok(problemsWith(i, swap(longName, 'pool-e2          groups=none account=pool-e2')).some((p) => /account pool-e2 is not a gx- account name/.test(p)));
  assert.ok(problemsWith(i, swap(longName, 'pool-e2          groups=none account=gx-pool-e1')).some((p) => /account gx-pool-e1 is also pool-e1's/.test(p)));
  assert.ok(problemsWith(i, swap(longName, 'pool-e2          groups=Bad!')).some((p) => /groups=Bad! is not a group name/.test(p)));
  assert.ok(problemsWith(i, swap(longName, 'pool-e2          group=none')).some((p) => /group=none is not groups= or account=/.test(p)));
});

test('isolated: an exec row on the tier account leaves its group, and a lane row keeps exactly its lane\'s', () => {
  const i = 'runners.isolated';
  const at = (name) => rows(EXAMPLES[i]).find((r) => r.words[0] === name).n;
  assertOne(problemsWith(i, swap('pool-e2          groups=none\n', '')), `runners.manifest:${rows(EXAMPLES['runners.manifest']).find((r) => r.words[0] === 'pool-e2').n}`, /pool-e2 runs as gha-exec, whose group opens every unisolated exec row's directory/);
  assertOne(problemsWith(i, swap('pool-e2          groups=none', 'pool-e2          groups=gha-exec')), `${i}:${at('pool-e2')}`, /pool-e2 keeps gha-exec's group/);
  assertOne(problemsWith(i, swap('pool-e2          groups=none', 'pool-e2')), `${i}:${at('pool-e2')}`, /pool-e2 keeps gha-exec's group/);
  assertOne(problemsWith(i, swap('oss-1            groups=gha-oss', 'oss-1            groups=none')), `${i}:${at('oss-1')}`, /oss-1 reads gha-oss's key files: give it groups=gha-oss/);
  assertOne(problemsWith(i, swap('app-redline-e1   groups=gha-redline', 'app-redline-e1   groups=gha-oss')), `${i}:${at('app-redline-e1')}`, /give it groups=gha-redline/);
  assertOne(problemsWith(i, swap('oss-read-1       groups=gha-oss-read\n', '')), `runners.manifest:${rows(EXAMPLES['runners.manifest']).find((r) => r.words[0] === 'oss-read-1').n}`, /oss-read-1 runs as gha-oss-read/);
});

test('isolated: a gha-redline row with no redline label (fleet status) holds no group, and a Redline row keeps its', () => {
  const row = 'app-status-e1    repo:example/app    read   gha-redline  /srv/gha/app-status-e1    self-hosted,Linux,X64,fleet-status ephemeral';
  const withRow = (isolatedLine) => configProblems({
    ...EXAMPLES,
    'runners.manifest': `${EXAMPLES['runners.manifest']}${row}
`,
    'runners.isolated': `${EXAMPLES['runners.isolated']}${isolatedLine}
`,
  });
  assert.deepEqual(withRow('app-status-e1    groups=none'), []);
  const last = rows(`${EXAMPLES['runners.isolated']}x
`).at(-1).n;
  assertOne(withRow('app-status-e1    groups=gha-redline'), `runners.isolated:${last}`, /app-status-e1 takes no redline job, so it reads none of gha-redline's key files: give it groups=none/);
  assertOne(withRow('app-status-e1'), `runners.isolated:${last}`, /give it groups=none/);
  // The Redline row itself still needs its lane's group.
  assertOne(problemsWith('runners.isolated', swap('app-redline-e1   groups=gha-redline', 'app-redline-e1   groups=none')), `runners.isolated:${rows(EXAMPLES['runners.isolated']).find((r) => r.words[0] === 'app-redline-e1').n}`, /app-redline-e1 reads gha-redline's key files: give it groups=gha-redline/);
});

test('build-allow: three fields of the right shapes, no CR, once each', () => {
  const b = 'runners.build-allow';
  const n = rows(EXAMPLES[b]).at(-1).n + 1;
  assertOne(problemsWith(b, add('example/app main')), `${b}:${n}`, /2 fields, not <owner\/repo> <branch> <file>/);
  assertOne(problemsWith(b, add('example/app main deploy.yml extra')), `${b}:${n}`, /4 fields/);
  assertOne(problemsWith(b, add('example/app main release.yml\r')), `${b}:${n}`, /a CR: the guard matches no job on this line/);
  assertOne(problemsWith(b, add('example main release.yml')), `${b}:${n}`, /example is not an owner\/repo/);
  assertOne(problemsWith(b, add('example/app ma!n release.yml')), `${b}:${n}`, /ma!n is not a branch name/);
  assertOne(problemsWith(b, add('example/app main release.sh')), `${b}:${n}`, /release\.sh is not a workflow file name/);
  assertOne(problemsWith(b, add('example/app  main   deploy.yml')), `${b}:${n}`, /example\/app main deploy\.yml is listed twice/);
});
