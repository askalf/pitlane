# Changelog

## Unreleased

### Published numbers

- The public page and badge now carry run time beside the start: the badge reads
  **CI measured | start 2 s · run 18 s** (the 24 h medians), and `stats.json` gains `ran`, `runMs`
  and `feltMs` (queued to done). Every earlier field is kept. The page is reorganised into Start,
  Run, Stable, how it is measured, and the method.
- [docs/method.md](docs/method.md) says where every published number comes from and how to check it.

### Install

- `runners/install.sh`: `check` reports the prerequisites; `install --config DIR` checks the
  config as one set, lays out the code, the units and the config at the paths the units name, and
  writes the dispatcher's and the supervisor's settings once (dry mode, a fresh webhook secret,
  observe-only), starting nothing. Without `--config` it upgrades the code and units in place.

### Runners

- The dispatcher and the supervisor manage the rows of any owner the manifest names
  (`repo:<owner>/<repo>`, `pool:<owner>`); before, only the `askalf` owner's rows were managed and
  any other was skipped without a word. `gha-runners-apply.sh status` reads the token file
  `GHA_TOKEN_ENV` names, as the dispatcher and the supervisor do.
- The mint step keeps a digest of the previous job's worker log before each cycle's reset, so the
  time between a job's last step and the runner reporting it done can be attributed
  ([docs/run-time.md](docs/run-time.md)).
- Rows whose labels are listed in `PITLANE_SUMMARY_SKIP_LABELS` (default `fleet-status`) run no
  job-completed hook: two fewer uploaded files on short status jobs.
- Rows for status-check jobs run on the read tier, off the exec tier's cap, with a second such row per
  repository so a burst of them does not queue behind one.

### Docs

- The README states exactly what is isolated and what is not, which modes keep state between jobs,
  that build rows run as root, and that exec rows have no docker socket.
- A minimal one-repository example ([docs/example-minimal.md](docs/example-minimal.md)), a docs
  index with a glossary ([docs/README.md](docs/README.md)), and a comparison with other self-hosted
  runner designs.
- Issue forms, a pull request template and CODEOWNERS.

## 1.0.0

The first public release: the runner core (manifest, apply script, JIT mint and run scripts, the
scale-to-zero dispatcher, the supervisor, CPU windows, per-row accounts and the isolation canary),
box-ci, and the public page and badge with the 24 h queue wait. The source tarball is attested
through GitHub OIDC; `gh attestation verify pitlane-1.0.0.tar.gz --owner askalf`.
