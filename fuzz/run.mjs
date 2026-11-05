// `node fuzz/run.mjs` runs every Jazzer.js target in ./fuzz. This is the fuzzer CI runs
// (.github/workflows/fuzz.yml) and the local repro loop. The targets import the modules under runners/,
// box-ci/ and canary/ directly, so no build is needed. Environment:
//   FUZZ_SECONDS       per-target budget in seconds (default 30)
//   FUZZ_ONLY          run only the target with this name (default: all)
//   FUZZ_CORPUS_DIR    root of per-target corpus dirs, created on demand; libFuzzer reads its
//                      seeds from <dir>/<target> and saves every interesting input there, so a
//                      corpus that persists between runs keeps getting deeper. Unset: a
//                      temporary directory, so a local run never writes into the repository.
//   FUZZ_ARTIFACT_DIR  where a crashing input is written, created on demand. Unset: the cwd.
// Hand-written starting inputs live in fuzz/seeds/<target>/ and are read, never written; an
// optional fuzz/dicts/<target>.dict lists the tokens of the input format.
// Jazzer comes from .clusterfuzzlite/package.json (`npm ci --prefix .clusterfuzzlite`): pitlane itself
// has no package.json and no dependencies.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const only = process.env.FUZZ_ONLY || '';
const targets = readdirSync(dir).filter((f) => f.endsWith('.fuzz.js') && (!only || f === `${only}.fuzz.js`)).sort();
if (!targets.length) {
  console.error(`no fuzz target matches ${only || '*.fuzz.js'}`);
  process.exit(1);
}
const secs = process.env.FUZZ_SECONDS || '30';
const corpusRoot = process.env.FUZZ_CORPUS_DIR || mkdtempSync(path.join(tmpdir(), 'pitlane-corpus-'));
const artifactDir = process.env.FUZZ_ARTIFACT_DIR || '';
// Run Jazzer's JS CLI directly under `node`: no .cmd wrapper, no shell, so a space in the repo
// path cannot break the invocation.
const jazzerCli = createRequire(new URL('../.clusterfuzzlite/package.json', import.meta.url)).resolve('@jazzer.js/core/dist/cli.js');
if (artifactDir) mkdirSync(artifactDir, { recursive: true });

// Jazzer's instrumenter cannot take a module that starts with `#!`; shebang-register.mjs, preloaded below,
// turns that line into a comment so the CLI entry points under test are instrumented too.
const preload = pathToFileURL(path.join(dir, 'shebang-register.mjs')).href;

for (const t of targets) {
  const name = t.replace(/\.fuzz\.js$/, '');
  // Every target is synchronous, so Jazzer runs in its faster sync mode.
  const args = [jazzerCli, path.join(dir, `${name}.fuzz`), '--sync'];
  // libFuzzer saves new inputs into the FIRST directory it is given, so the corpus comes first
  // and the read-only seeds after it.
  const corpus = path.join(corpusRoot, name);
  mkdirSync(corpus, { recursive: true });
  args.push(corpus);
  const seeds = path.join(dir, 'seeds', name);
  if (existsSync(seeds)) args.push(seeds);
  // -timeout turns a hang (a super-linear regex on hostile input) into a failing input in seconds
  // rather than libFuzzer's 20 minute default.
  args.push('--', `-max_total_time=${secs}`, '-timeout=10', '-print_final_stats=1');
  // fuzz/dicts/<target>.dict: the tokens of the input format, which byte-level mutation rarely finds.
  const dict = path.join(dir, 'dicts', `${name}.dict`);
  if (existsSync(dict)) args.push(`-dict=${dict}`);
  if (artifactDir) args.push(`-artifact_prefix=${artifactDir}${path.sep}`);
  console.log(`\n=== fuzzing ${name} (${secs}s) ===`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${preload}`.trim() } });
  if (r.status !== 0) {
    console.error(`\n${name}: jazzer exited with ${r.status ?? r.signal}; a reproducing input is in ${artifactDir || 'the working directory'}`);
    process.exit(r.status || 1);
  }
}
