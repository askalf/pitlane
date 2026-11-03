# pitlane

[![ci](https://github.com/askalf/pitlane/actions/workflows/ci.yml/badge.svg)](https://github.com/askalf/pitlane/actions/workflows/ci.yml)
[![CI measured](https://img.shields.io/endpoint?url=https%3A%2F%2Fpitlane.askalf.org%2Fbadge.json)](https://pitlane.askalf.org/)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/askalf/pitlane/badge)](https://scorecard.dev/viewer/?uri=github.com/askalf/pitlane)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/16169/badge)](https://www.bestpractices.dev/projects/16169)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The lab where the [ci-wizard](https://github.com/askalf/ci-wizard) method is proven: self-hosted
GitHub Actions runners on one Linux host that measure every job they take and publish the receipts
live. No job should be lost or slowed by the runner itself, and the numbers that say whether that
holds are public.

It is the runner stack behind the askalf projects' CI. The second badge above is live: the median
start and the median run of the jobs it ran over the last 24 hours.
[pitlane.askalf.org](https://pitlane.askalf.org/) shows them in full, with their p90s and the
runner-suspected failures beside them, and [docs/method.md](docs/method.md) says how each number is
measured and how to check it.

## What it aims at

The first target is start latency and the queue tail: the time a job waits for a runner is what
users feel. The run time is measured too, down to the runner's wrap-up after the last step
([docs/run-time.md](docs/run-time.md)).

| Target | Value |
| --- | --- |
| Queue wait p50 | under 5 s |
| Queue wait p90 | under 30 s |
| Failures caused by the runner | 0 |
| Jobs sharing a workspace | 0 |

These are targets, not results. The median start is usually 2 s because warm rows hold an idle
listener; a cold row registers first, which takes about 15 s ([docs/pools.md](docs/pools.md)). The
p90 runs over target during bursts, when more jobs queue than rows are free, and the live page shows
which hours did. Failures the runner is *suspected* of causing are counted from how each job ended
([docs/outcomes.md](docs/outcomes.md)); a suspicion, not proof.

## How it works

- **A manifest, not hand-registered runners.** `runners.manifest` lists every row: its scope (one
  repository, an organization, or a shared pool), its tier, the account it runs as and its mode.
  `gha-runners-apply.sh` reconciles the host against it: systemd slices, template units, per-row
  drop-ins, directories and the pinned runner release. See [runners/README.md](runners/README.md).
- **Modes.** An *ephemeral* row takes one job, then registers again with a fresh just-in-time
  configuration; that is the normal mode and the one the targets are measured on. An *adopt* row is
  an existing persistent runner that apply only places in its slice, and a *managed* row is a
  persistent runner apply builds; both keep their state between jobs
  ([runners/README.md](runners/README.md), Modes).
- **Three tiers.** *read* rows read code and post reviews, *exec* rows run repository code, and
  *build* rows run your own deploys **as root**, with the docker socket, behind a guard that refuses
  any job its allow list does not name ([docs/ops-tier.md](docs/ops-tier.md)).
- **Scale to zero.** `gha-ondemand` watches each repository's queued self-hosted jobs, starts a
  stopped row whose labels cover one, and parks a row that sat idle. A verified `workflow_job`
  webhook starts it at once; a poll is the backstop.
- **Pools and caps.** A shared pool of rows registers, at each start, for the repository of the job
  routed to it, so a burst in any repository draws on the whole pool ([docs/pools.md](docs/pools.md)).
- **Isolation.** Each read and exec row listed in `runners.isolated` runs as its own account with its
  own tool cache, and only a lane's rows can read that lane's keys ([docs/isolation.md](docs/isolation.md)).
  Build rows run as root and cannot be isolated that way. A canary probes what a job can actually
  read ([canary/](canary/)).
- **CPU shape.** A row is pinned to a window of CPUs, so test runners and compilers size their
  worker pools to that window instead of the whole host ([docs/cpu.md](docs/cpu.md)).
- **A supervisor.** It watches for stuck jobs, version drift and disk or memory pressure, and records
  how every job ended ([docs/supervisor.md](docs/supervisor.md), [docs/outcomes.md](docs/outcomes.md)).
- **box-ci.** A second way to run a repository's workflows on the host, with act, at each commit,
  posting the verdict as commit statuses ([docs/box-ci.md](docs/box-ci.md)).
- **Showcase.** A line on a job's run page with its own queue wait, and the live badge above
  ([docs/showcase.md](docs/showcase.md)).

## What is not isolated

The rows share one kernel; there is no virtual machine between a job and the host. On top of that,
[docs/isolation.md](docs/isolation.md) lists what is still shared:

- **The network.** Jobs share the host's loopback and can reach the local services listening on it.
  A network namespace per job is planned, not built.
- **Key files within a lane.** The rows of one lane share that lane's key file through a group, so a
  job on any row of the lane can read the key every other row of it uses.
- **Build rows.** They run as root with the docker socket; the build guard limits which workflows
  they run, not what those workflows can do.
- **Untrusted code.** Running rows that take code you did not write in gVisor is designed, not built.

## What changes in a workflow

`runs-on` names a row's labels. Beyond that, a job behaves as it would on any self-hosted runner, with
one difference to plan for: exec rows have no docker socket, so container jobs (`container:`) and
service containers (`services:`) do not run there. Jobs that need docker belong on a build row, if
they are your own deploys, or on a hosted runner.

## Install

Installation is manual today; an installer is planned. You need:

- a Linux host with systemd and cgroup v2 (Ubuntu 24.04 is the tested system), root, bash, Node.js 22
  and the GitHub CLI (`gh`);
- a GitHub App (or a fine-grained token) for each repository or organization it serves;
- for the fast start, GitHub's `workflow_job` webhook delivered to the dispatcher's loopback port
  (7311 by default) through a tunnel or reverse proxy, with its secret in the dispatcher's environment.

Then:

1. Start from [docs/example-minimal.md](docs/example-minimal.md) (one repository, one row) or the
   fuller set in [runners/examples/](runners/examples/), and check it as one set:

   ```
   node runners/runner-config.mjs path/to/your/config
   ```

2. Copy the files to the paths [runners/README.md](runners/README.md) lists, then:

   ```
   gha-runners-apply.sh plan                  # what would change
   gha-runners-apply.sh bootstrap             # accounts, directories, the pinned runner
   gha-runners-apply.sh apply --restart-idle
   systemctl enable --now gha-ondemand.service
   ```

One limit to know before you start: the scale-to-zero dispatcher (`runners/gha-ondemand.mjs`)
currently manages only rows whose scope is under the `askalf` owner. Making the owner a setting is
the next change; until then a fork changes that one check.

## How it compares

Facts from each project's own documentation:

| | pitlane | [actions-runner-controller](https://github.com/actions/actions-runner-controller) | [terraform-aws-github-runner](https://github.com/github-aws-runners/terraform-aws-github-runner) | Hosted fast-runner services |
| --- | --- | --- | --- | --- |
| Runs on | one Linux host, systemd | Kubernetes | AWS (EC2, Lambda) | the vendor's machines |
| Job boundary | a Unix account per row, slices, a shared kernel | a pod per runner | an instance per runner (per job in its ephemeral mode) | usually a VM per job |
| Scale to zero | yes | yes | yes | not applicable |
| Public live numbers | aggregate numbers on a public page, measured from every job; each job's own run page carries its wait (except rows that skip the summary line, fleet status rows by default) | not part of the project | not part of the project | varies by vendor |
| Cost | the host | the cluster | the AWS bill | per minute |

pitlane trades the stronger VM boundary of the instance and VM designs for one host you already run,
with no cluster and no cloud bill, and publishes its own numbers so the trade can be judged.

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

What changed between releases: [CHANGELOG.md](CHANGELOG.md).

## Documentation

[docs/README.md](docs/README.md) is the index, with a glossary of the words these docs use (row,
lane, tier, pool, warm, park).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report a vulnerability privately, as
[SECURITY.md](SECURITY.md) describes, never in a public issue.

## License

[MIT](LICENSE)
