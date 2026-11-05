#!/bin/bash -eu
# Build the Jazzer.js fuzz targets for ClusterFuzzLite / OSS-Fuzz.
#
# pitlane reads input it does not control in four places: the webhook deliveries GitHub sends to
# the dispatcher, the runner config files an operator edits, the act log and config box-ci reads
# for a repository's workflows, and the host text and records the supervisor reads back. Each
# target feeds hostile input into one of those paths and asserts its contract; see the header of
# each fuzz/*.fuzz.js.

cd "$SRC/pitlane"

# pitlane has no package.json and no dependencies of its own. Jazzer.js comes from its own
# lockfile (.clusterfuzzlite/package-lock.json), and npm ci verifies every integrity hash in it.
# It is merged into a node_modules where compile_javascript_fuzzer expects to resolve it.
npm ci --prefix .clusterfuzzlite --no-audit --no-fund
mkdir -p node_modules
cp -r .clusterfuzzlite/node_modules/. node_modules/

# Jazzer's instrumenter cannot take a module that starts with a `#!` line (its coverage preamble goes
# ahead of it), and the CLI entry points under test do. This is the image's own copy of the source, so the
# line becomes a comment here, as fuzz/shebang-register.mjs does for a local or Actions run.
sed -i '1s|^#!|//|' runners/*.mjs box-ci/*.mjs canary/*.mjs

# The targets import the modules under runners/, box-ci/ and canary/ directly, so there is no build step.
for target in webhook_delivery runner_config box_ci host_state; do
  compile_javascript_fuzzer pitlane "fuzz/${target}.fuzz.js"
done
