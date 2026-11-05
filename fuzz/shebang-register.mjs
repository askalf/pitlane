// Preloaded into every fuzz run (run.mjs, NODE_OPTIONS=--import). Jazzer's instrumenter puts its
// preamble ahead of a `#!` line, so a CLI entry point such as runners/runner-config.mjs would no
// longer compile. This hook sits below Jazzer's in the loader chain and turns the line into a
// comment first, so those files are instrumented like the rest and keep their line numbers.
import { register } from 'node:module';

register('./shebang-hooks.mjs', import.meta.url);
