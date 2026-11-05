// Fuzz the runner config path: the text of the host's config files (runners.manifest, runners.cpu,
// runners.isolated, runners.retired, runners.build-allow) and of the small state files the
// supervisor reads beside them. These are files an operator edits by hand, so a typo, a stray
// byte or a hostile column count is the expected input, and the dispatcher, the supervisor and
// the pre-deploy check all parse the same manifest text with their own readers.
// Contracts: no reader throws for any text; configProblems returns only strings; the three row
// readers agree on which manifest rows exist (the supervisor's rows are the dispatcher's managed
// rows plus its watched rows, and no row is in both); and a manifest row whose account has no unit
// template is reported as such, never taken for a known account.
import { ACCOUNTS, FILES, configProblems, rows } from '../runners/runner-config.mjs';
import { managedRows, unitFor, watchedRows } from '../runners/gha-ondemand.mjs';
import { parseHeldMark, parseIsolated, parsePinned, parseRowPinned, supervisedRows } from '../runners/pitlane-supervisor.mjs';
import { hostRowNames } from '../runners/pitlane-waits.mjs';
import { Cursor, WORDS } from './gen.mjs';

function fail(msg) {
  throw new Error(msg);
}

const TIERS = ['read', 'exec', 'build', 'exec'];
const USERS = ['gha-exec', 'gha-oss', 'gha-oss-read', 'gha-oss-write', 'gha-redline', 'root', 'constructor', 'toString', '__proto__', 'nobody'];
const SCOPES = ['repo:askalf/pitlane', 'org:sprayberry-code', 'pool:askalf', 'repo:a/..', 'org:', 'pool:a/b', 'x'];
const LABELS = ['self-hosted,Linux,X64,exec', 'self-hosted,Linux,X64', 'self-hosted', 'SELF-HOSTED,linux'];
const MODES = ['ephemeral', 'ephemeral', 'adopt', 'managed', 'x'];

/** Manifest text built from the bytes: rows of seven columns, each column mostly valid, sometimes a hostile word. */
function manifestFrom(c) {
  const lines = [];
  for (let n = c.byte() % 8; n >= 0; n--) {
    const pick = (list) => (c.byte() < 40 ? WORDS[c.byte() % WORDS.length] : list[c.byte() % list.length]);
    const cols = [`row-${c.byte() % 6}`, pick(SCOPES), pick(TIERS), pick(USERS), '/srv/gha/x', pick(LABELS), pick(MODES)];
    if (c.byte() < 16) cols.length = c.byte() % 9;
    lines.push(c.byte() < 20 ? `# ${cols.join(' ')}` : cols.join(c.byte() < 30 ? '\t' : ' '));
  }
  return lines.join('\n');
}

export function fuzz(data) {
  let texts;
  let manifest;
  if (data.length > 1 && data[0] >= 128) {
    // A manifest built to be mostly well formed, so the readers get past the column checks.
    const c = new Cursor(data.subarray(1));
    manifest = manifestFrom(c);
    texts = Object.fromEntries(FILES.map((f) => [f, f === 'runners.manifest' ? manifest : c.text(80)]));
  } else {
    // Raw text: the five files separated by the record separator byte.
    const parts = data.toString('utf8').split('\u001e');
    texts = Object.fromEntries(FILES.map((f, i) => [f, parts[i] ?? '']));
    manifest = texts['runners.manifest'];
  }

  const problems = configProblems(texts);
  if (!Array.isArray(problems) || problems.some((p) => typeof p !== 'string')) fail('configProblems returned a non-string problem');
  for (const f of FILES) for (const r of rows(texts[f])) if (!r.words.length || r.words.some((w) => /\s/.test(w))) fail('rows() returned a word with whitespace or an empty row');

  // Every 7-column row with a known tier and an account that is not an own key of ACCOUNTS must be
  // reported as having no unit template. An inherited name such as constructor is not an account.
  for (const { n, words } of rows(manifest)) {
    if (words.length !== 7 || !['read', 'exec', 'build'].includes(words[2])) continue;
    const user = words[3];
    if (!Object.hasOwn(ACCOUNTS, user) && !problems.some((p) => p.startsWith(`runners.manifest:${n}: `) && p.includes(`no unit template runs as ${user}`))) {
      fail(`runners.manifest:${n}: account ${user} is not an account, and no problem says so`);
    }
  }

  const managed = managedRows(manifest);
  const watched = watchedRows(manifest);
  const supervised = supervisedRows(manifest);
  for (const list of [managed, watched, supervised]) {
    if (!Array.isArray(list)) fail('a row reader returned a non-list');
    for (const r of list) {
      if (typeof r.name !== 'string' || !r.name || /\s/.test(r.name)) fail('a row has a name that is empty or has whitespace');
      if (typeof r.unit !== 'string' || !r.unit.endsWith('.service') || /\s/.test(r.unit)) fail(`a row has the unit ${r.unit}`);
      if (!Array.isArray(r.labels) || r.labels.some((l) => typeof l !== 'string' || l !== l.toLowerCase())) fail('a row has labels that are not lower case strings');
      if (r.unit !== unitFor(r.user, r.name)) fail('a row unit is not the unit unitFor names');
    }
  }
  // A line is repo or pool scoped (managed), org scoped (watched), or neither; the supervisor takes
  // all three kinds, so its list is the other two end to end, and the same rows by name.
  if (supervised.length !== managed.length + watched.length) fail(`the supervisor watches ${supervised.length} rows, not ${managed.length} managed plus ${watched.length} watched`);
  const byName = (list) => list.map((r) => `${r.name}|${r.user}`).sort().join(',');
  if (byName(supervised) !== byName([...managed, ...watched])) fail('the supervisor watches different rows than managed plus watched');
  for (const r of managed) if ((r.repo === null) === (r.pool === null)) fail('a managed row has both or neither of repo and pool');
  const names = hostRowNames(manifest);
  for (const r of supervised) if (!names.has(r.name)) fail('hostRowNames misses a row the supervisor watches');

  const text = texts['runners.isolated'];
  const iso = parseIsolated(text);
  if (!(iso instanceof Map) || [...iso].some(([k, v]) => typeof k !== 'string' || typeof v !== 'string')) fail('parseIsolated returned a non-string entry');
  const held = parseHeldMark(text);
  if (held.at !== null && !Number.isFinite(held.at)) fail('parseHeldMark returned a time that is not finite');
  if (typeof held.why !== 'string') fail('parseHeldMark returned a reason that is not a string');
  const pinned = parsePinned(text);
  if (pinned !== null && typeof pinned !== 'string') fail('parsePinned returned a non-string');
  const rowPinned = parseRowPinned(text);
  if (rowPinned !== null && !/^\d+\.\d+\.\d+$/.test(rowPinned)) fail(`parseRowPinned returned ${rowPinned}`);
}
