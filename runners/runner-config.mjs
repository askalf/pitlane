#!/usr/bin/env node
// Checks a host's runner config as one set: runners.manifest, runners.cpu, runners.isolated,
// runners.retired and runners.build-allow (formats in runners/examples/). gha-runners-apply.sh holds
// a bad row at apply time, on the host; this finds the same mistakes, and the ones only visible across
// files, before a deploy: a retired row still listed, an exec row with no CPU window, an exec row
// left on its tier account (whose group opens every such row's directory), a lane row that would read
// another lane's keys, an account useradd refuses, a build-allow line the guard would never match.
//
//   node runners/runner-config.mjs [dir]   check the five files in dir (default: runners/examples)
//
// Exit 0 when the set is consistent, 1 with one line per problem.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FILES = ['runners.manifest', 'runners.cpu', 'runners.isolated', 'runners.retired', 'runners.build-allow'];

/** The account each row may run as, with the tier it serves (pool_of in gha-runners-apply.sh). */
export const ACCOUNTS = {
  'gha-exec': 'exec',
  'gha-oss': 'exec',
  'gha-oss-read': 'read',
  'gha-oss-write': 'read',
  'gha-redline': 'read',
  root: 'build',
};
/** Accounts whose rows read a lane's key files (root:<account> 0640), so an isolated row keeps that group. */
const LANES = new Set(['gha-oss', 'gha-oss-read', 'gha-oss-write', 'gha-redline']);

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const SCOPE = /^(repo:[A-Za-z0-9-]+\/[A-Za-z0-9._-]+|org:[A-Za-z0-9-]+|pool:[A-Za-z0-9-]+)$/;
const LABELS = /^self-hosted,Linux,X64(,[A-Za-z0-9._-]+)*$/;
const GROUP = /^[a-z_][a-z0-9_-]{0,31}$/;
const ACCOUNT = /^gx-[a-z0-9][a-z0-9-]*$/;

/** The lines of a config file that carry data: { n, words } with comments and blank lines removed. */
export function rows(text) {
  return text.split('\n').map((l, i) => ({ n: i + 1, raw: l, words: l.replace(/#.*$/, '').trim().split(/\s+/).filter(Boolean) })).filter((r) => r.words.length);
}

/** The five files of dir as text; a missing file reads as empty (apply treats it the same way). */
export function readConfig(dir) {
  return Object.fromEntries(FILES.map((f) => [f, existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '']));
}

/** Every problem of the set, as `<file>:<line>: <what>` (line 0 for a problem of the file as a whole). */
export function configProblems(texts) {
  const out = [];
  const at = (f, n, what) => out.push(`${f}:${n}: ${what}`);

  const manifest = new Map();
  for (const { n, words } of rows(texts['runners.manifest'] ?? '')) {
    const f = 'runners.manifest';
    if (words.length !== 7) { at(f, n, `${words.length} columns, not 7`); continue; }
    const [name, scope, tier, user, dir, labels, mode] = words;
    if (!NAME.test(name)) at(f, n, `${name} is not a runner name`);
    if (manifest.has(name)) at(f, n, `${name} is listed twice`);
    if (!SCOPE.test(scope)) at(f, n, `${name}: scope ${scope} is not repo:<owner>/<repo>, org:<org> or pool:<owner>`);
    if (!['read', 'exec', 'build'].includes(tier)) at(f, n, `${name}: tier ${tier} is not read, exec or build`);
    else if (!(user in ACCOUNTS)) at(f, n, `${name}: no unit template runs as ${user}`);
    else if (ACCOUNTS[user] !== tier) at(f, n, `${name}: ${user} serves the ${ACCOUNTS[user]} tier, not ${tier}`);
    if (!dir.startsWith('/')) at(f, n, `${name}: dir ${dir} is not an absolute path`);
    if (!LABELS.test(labels)) at(f, n, `${name}: labels do not start self-hosted,Linux,X64`);
    if (!['ephemeral', 'adopt', 'managed'].includes(mode)) at(f, n, `${name}: mode ${mode} is not ephemeral, adopt or managed`);
    if (mode !== 'ephemeral' && !scope.startsWith('repo:')) at(f, n, `${name}: an ${scope.split(':')[0]} row is ephemeral (JIT) only`);
    if (tier === 'build' && !scope.startsWith('repo:')) at(f, n, `${name}: a build row runs as root, so it serves one repository`);
    manifest.set(name, { n, scope, tier, user, labels, mode });
  }
  if (!manifest.size) at('runners.manifest', 0, 'no rows');

  const retired = new Map();
  for (const { n, words } of rows(texts['runners.retired'] ?? '')) {
    const f = 'runners.retired';
    const [name, day, ...why] = words;
    if (!NAME.test(name)) at(f, n, `${name} is not a runner name`);
    if (retired.has(name)) at(f, n, `${name} is retired twice`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') || Number.isNaN(Date.parse(day))) at(f, n, `${name}: ${day ?? '(none)'} is not a YYYY-MM-DD day`);
    if (!why.length) at(f, n, `${name}: no reason`);
    if (manifest.has(name)) at(f, n, `${name} is retired and still in runners.manifest`);
    retired.set(name, n);
  }

  const cpu = new Map();
  for (const { n, words } of rows(texts['runners.cpu'] ?? '')) {
    const f = 'runners.cpu';
    const [name, ...opts] = words;
    if (cpu.has(name)) at(f, n, `${name} is listed twice`);
    if (retired.has(name)) at(f, n, `${name} is retired`);
    else if (!manifest.has(name)) at(f, n, `${name} is not a row of runners.manifest`);
    for (const o of opts) {
      const m = /^(cpus|weight)=(\d+)$/.exec(o);
      if (!m) at(f, n, `${name}: ${o} is not cpus=N or weight=W`);
      else if (m[1] === 'cpus' && Number(m[2]) < 1) at(f, n, `${name}: cpus=${m[2]} is under 1`);
      else if (m[1] === 'weight' && (Number(m[2]) < 1 || Number(m[2]) > 10000)) at(f, n, `${name}: weight=${m[2]} is outside 1..10000`);
    }
    cpu.set(name, n);
  }
  for (const [name, r] of manifest) if (r.tier === 'exec' && !cpu.has(name)) at('runners.manifest', r.n, `${name} is an exec row with no runners.cpu line`);

  const isolated = new Map();
  const accounts = new Map();
  for (const { n, words } of rows(texts['runners.isolated'] ?? '')) {
    const f = 'runners.isolated';
    const [name, ...opts] = words;
    if (isolated.has(name)) at(f, n, `${name} is listed twice`);
    if (retired.has(name)) at(f, n, `${name} is retired`);
    else if (!manifest.has(name)) at(f, n, `${name} is not a row of runners.manifest`);
    else if (manifest.get(name).user === 'root') at(f, n, `${name} runs as root and cannot be isolated`);
    let groups = null;
    let account = `gx-${name}`;
    for (const o of opts) {
      const m = /^(groups|account)=(.*)$/.exec(o);
      if (!m) at(f, n, `${name}: ${o} is not groups= or account=`);
      else if (m[1] === 'groups') {
        groups = m[2];
        if (groups !== 'none' && !GROUP.test(groups)) at(f, n, `${name}: groups=${groups} is not a group name`);
      } else account = m[2];
    }
    if (account.length > 32) at(f, n, `${name}: account ${account} is over useradd's 32 characters; give the row an account= word`);
    if (!ACCOUNT.test(account)) at(f, n, `${name}: account ${account} is not a gx- account name`);
    if (accounts.has(account)) at(f, n, `${name}: account ${account} is also ${accounts.get(account)}'s`);
    accounts.set(account, name);
    isolated.set(name, { n, groups });
  }
  for (const [name, r] of manifest) {
    const iso = isolated.get(name);
    if (r.user === 'gha-exec') {
      if (!iso) at('runners.manifest', r.n, `${name} runs as gha-exec, whose group opens every unisolated exec row's directory: list it in runners.isolated`);
      else if (iso.groups === 'gha-exec' || iso.groups === null) at('runners.isolated', iso.n, `${name} keeps gha-exec's group: give it groups=none or its lane's group`);
    } else if (LANES.has(r.user)) {
      if (!iso) at('runners.manifest', r.n, `${name} runs as ${r.user}, whose group opens every unisolated ${r.user} row's directory: list it in runners.isolated`);
      else if (iso.groups !== r.user) at('runners.isolated', iso.n, `${name} reads ${r.user}'s key files: give it groups=${r.user}`);
    }
  }

  const allowed = new Set();
  for (const { n, raw, words } of rows(texts['runners.build-allow'] ?? '')) {
    const f = 'runners.build-allow';
    // The guard matches a line only when it is exactly three fields with no CR, so anything else is a
    // line that allows nothing.
    if (raw.includes('\r')) { at(f, n, 'a CR: the guard matches no job on this line'); continue; }
    if (words.length !== 3) { at(f, n, `${words.length} fields, not <owner/repo> <branch> <file>`); continue; }
    const [repo, branch, file] = words;
    if (!REPO.test(repo)) at(f, n, `${repo} is not an owner/repo`);
    if (!/^[A-Za-z0-9._/-]+$/.test(branch)) at(f, n, `${branch} is not a branch name`);
    if (!/^[A-Za-z0-9._-]+\.ya?ml$/.test(file)) at(f, n, `${file} is not a workflow file name`);
    if (allowed.has(words.join(' '))) at(f, n, `${words.join(' ')} is listed twice`);
    allowed.add(words.join(' '));
  }
  return out;
}

function main(argv) {
  const dir = resolve(argv[0] ?? join(dirname(fileURLToPath(import.meta.url)), 'examples'));
  const problems = configProblems(readConfig(dir));
  for (const p of problems) console.error(p);
  const n = problems.length;
  console.log(`${dir}: ${n ? `${n} problem${n === 1 ? '' : 's'}` : 'consistent'}`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
