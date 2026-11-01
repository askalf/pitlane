# pitlane

[![ci](https://github.com/askalf/pitlane/actions/workflows/ci.yml/badge.svg)](https://github.com/askalf/pitlane/actions/workflows/ci.yml)
[![CI on pitlane](https://img.shields.io/endpoint?url=https%3A%2F%2Fpitlane.askalf.org%2Fbadge.json)](https://pitlane.askalf.org/)
[![OpenSSF Scorecard](https://api.scorecards.dev/projects/github.com/askalf/pitlane/badge)](https://scorecard.dev/viewer/?uri=github.com/askalf/pitlane)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Self-hosted GitHub Actions runners on one Linux host, built for start latency: a job should start
about as fast on your own machine as it does on a hosted runner, and no job should be lost or slowed
by the runner itself. Every row is ephemeral (one job, then a fresh registration), scaled to zero
when idle, and isolated from the rows beside it.

It is the runner stack behind the askalf projects' CI. The second badge above is live: the queue
wait of the jobs it ran over the last 24 hours, and [pitlane.askalf.org](https://pitlane.askalf.org/)
shows the same numbers in full.

## What it aims at

The target is start latency and the queue tail, not step speed. Checkout, toolchain and install steps
take a second or two each on a warm host; the time a job waits for a runner is what users feel.

| Target | Value |
| --- | --- |
| Queue wait p50 | under 5 s |
| Queue wait p90 | under 30 s |
| Failures caused by the runner | 0 |
| Jobs sharing a workspace | 0 |

## How it works

- **A manifest, not hand-registered runners.** `runners.manifest` lists every row: its scope (one
  repository, an organization, or a shared pool), its tier and the account it runs as.
  `gha-runners-apply.sh` reconciles the host against it: systemd slices, template units, per-row
  drop-ins, directories and the pinned runner release. See [runners/README.md](runners/README.md).
- **Three tiers.** *read* rows read code and post reviews, *exec* rows run repository code, and
  *build* rows run your own deploys as root behind a guard that refuses any job its allow list does
  not name ([docs/ops-tier.md](docs/ops-tier.md)).
- **Scale to zero.** `gha-ondemand` watches each repository's queued self-hosted jobs, starts a
  stopped row whose labels cover one (just-in-time configuration, so a row registers for exactly one
  job), and parks a row that sat idle.
- **Pools and caps.** A shared pool of rows registers, at each start, for the repository of the job
  routed to it, so a burst in any repository draws on the whole pool ([docs/pools.md](docs/pools.md)).
- **Isolation.** Each row runs as its own account with its own tool cache, and only a lane's rows
  can read that lane's keys ([docs/isolation.md](docs/isolation.md)). A canary probes what a job
  can actually read ([canary/](canary/)).
- **CPU shape.** A row is pinned to a window of CPUs, so test runners and compilers size their
  worker pools to that window instead of the whole host ([docs/cpu.md](docs/cpu.md)).
- **A supervisor.** It watches for stuck jobs, version drift and disk or memory pressure, and records
  how every job ended ([docs/supervisor.md](docs/supervisor.md), [docs/outcomes.md](docs/outcomes.md)).
- **box-ci.** A second way to run a repository's workflows on the host, with act, at each commit,
  posting the verdict as commit statuses ([docs/box-ci.md](docs/box-ci.md)).
- **Showcase.** A line on every job's run page with its own queue wait, and the live badge above
  ([docs/showcase.md](docs/showcase.md)).

## Getting started

pitlane needs a Linux host with systemd, bash and Node.js 22, and a GitHub App (or a fine-grained
token) for each repository or organization it serves.

1. Copy the example config from [runners/examples/](runners/examples/) and make it yours: the rows,
   their CPU windows, their isolation, and the deploys your build rows may run.
2. Check it as one set before it reaches the host:

   ```
   node runners/runner-config.mjs path/to/your/config
   ```

3. Install the files where [runners/README.md](runners/README.md) says they go, then:

   ```
   gha-runners-apply.sh plan                  # what would change
   gha-runners-apply.sh bootstrap             # accounts, directories, the pinned runner
   gha-runners-apply.sh apply --restart-idle
   systemctl enable --now gha-ondemand.service
   ```

Nothing in a workflow changes except `runs-on`, which names a row's labels.

## Tests

```
node --test runners/*.test.mjs canary/*.test.mjs box-ci/*.test.mjs
```

The tests run the shell scripts against stubs, with no network and no root. CI runs them on
GitHub-hosted runners, so a pull request from a fork never reaches a self-hosted row.

## Releases

Each release carries the source tarball of its tagged commit, attested keyless through GitHub OIDC
(Sigstore) by [release.yml](.github/workflows/release.yml). Check a download before you install it:

```
gh attestation verify pitlane-<version>.tar.gz --owner askalf
```

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report a vulnerability privately, as
[SECURITY.md](SECURITY.md) describes, never in a public issue.

## License

[MIT](LICENSE)
