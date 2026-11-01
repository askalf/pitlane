# Ops tier: replacing the persistent root runners

A host that deploys its own stack usually starts with persistent, self-updating listeners that run as
root with the docker socket. These are `adopt` rows: apply places them in `gha-build.slice` and never
re-registers them. They are the only rows outside the ephemeral cycle, so they are the only rows the
supervisor cannot reason about from the manifest, the only rows whose runner version is not the pinned
one, and the only registrations that outlive a job. This document describes the ephemeral build tier
that replaces them.

Root is not the part to change. Every deploy on the host runs `docker compose` against
`/root/.askalf`, writes `/opt/askalf` and `/etc/systemd/system`, and calls `systemctl`; a non-root
account in the docker group is root-equivalent, so moving these jobs to a user would be a drop in
name only. What an ephemeral build row changes is everything around the job:

| Adopted root runner | Ephemeral build row |
| --- | --- |
| one registration for months, long-lived runner token | one JIT registration per job, minted by root with the runner App's token or a root-only token file |
| the work directory carries over between jobs | the instance directory is reset every cycle; only the pinned runner copy survives |
| self-updating runner binary | the version in `RUNNER_VERSION`, upgraded by `gha-runners-apply.sh upgrade` |
| no start limit, no restart policy of ours | `StartLimitBurst`, `Restart=always`, the 30 s back-off on a failed mint |
| invisible to the supervisor's drift and crash-loop classes | a row like any other in `status.json` |

## What the root label carries

The workflows that targeted the persistent root label fall into three groups:

1. **Host deploys**: the stack's services, the dashboard, the host scripts. These need root, the
   docker socket and `/root/.askalf`.
2. **Host reads**: drift and deployment watches, status checks that reach the database through its
   container. Root today; the database reads could move behind a read-only role later.
3. **API only**: audits and deploys that talk to a third-party API (an edge provider's audits, worker
   deploys, token revocation), version bumps and stale-issue sweeps. Nothing on the host; they ran on
   the root label because that is where the repository secrets were wired first.

Group 3 has no reason to be root at all. A workflow in groups 1 or 2 that turns out to read host
secrets (`/root/.askalf/.env`, a service's docker log) stays on a build row.

## Design

1. **Template.** `gha-ephemeral-build@.service`: the first-party template's cycle (`ExecCondition=+`
   mint, `ExecStart` run, `Restart=always`, `KillSignal=SIGINT`, `TimeoutStopSec=` long enough for
   a compose build) with `User=root`, `Slice=gha-build.slice`, its own tool cache
   `/var/lib/gha/toolcache-build`, and only the hardening root deploys tolerate: `PrivateTmp`,
   `ProtectKernelTunables`, `ProtectKernelLogs`, `ProtectClock`, `ProtectHostname`,
   `RestrictRealtime`, `LockPersonality`. No `ProtectSystem`, no `NoNewPrivileges`, no capability
   bound, no `PrivateDevices`: the job writes `/opt/askalf` and `/etc/systemd`, reloads units and
   talks to the docker socket. `gha-runners-apply.sh` maps `tier=build mode=ephemeral` to it.
   `runners.isolated` does not apply to the build tier (root has no per-row account).
   `RUNNER_ALLOW_RUNASROOT=1` is set on the template: the runner's own `run-helper.sh` refuses root
   without it. HOME stays `/root` so the deploys find `/root/.askalf` and root's docker and gh
   configuration as they did on the adopted runners. In code: `pool_of root -> build`,
   `template_for build -> gha-ephemeral-build@`, the build template in the retire list, and the
   dispatcher's unit map for root.
2. **Rows.** One build row per deploying repository, `<repo>-build-e1` with label `<repo>-build`
   (`dario-build-e1` is the example in the manifest). New labels, so nothing moves until a workflow
   is retargeted, the same way the fix lane moved to `<repo>-fix`.
3. **Canary.** Retarget one read-only workflow first and run it by dispatch. Then the host-scripts
   deploy with `dry_run: true`, which exercises root, the checkout of pitlane and the gate without a
   write.
4. **Move the deploys one at a time**, each with a dry run or a no-change deploy first, then the host
   reads. Each workflow keeps its `concurrency` group; one build row serializes deploys exactly as the
   single root runner did, and a second row is one manifest line.
5. **Group 3 leaves root.** Those workflows move to an exec-tier first-party row
   (`<repo>-ops-e1`, label `<repo>-ops`, account `gx-<repo>-ops-e1`, `groups=none`): no docker
   socket, no host files, repository secrets only.
6. **Recurring host jobs get rows of their own.** A pass that runs every few minutes as a one-shot
   job (`docker compose run --rm --no-deps <service>` against `/root/.askalf`) is root for the same
   reason as a deploy. It gets a build row of its own (`<repo>-jobs-e<n>`, label `<repo>-jobs`) so
   ticks and deploys never queue behind each other. Two such workflows that must not queue behind
   each other get two rows with the same label; each workflow is still one run at a time by its own
   concurrency group.
7. **Retire** the adopted rows: stop and uninstall the service, delete the registration, remove the
   directory, drop the manifest row. The old labels end with them. A retire fix refuses while the
   manifest still lists a row or a job runs.

On the host, after the deploy that carries a new row: `gha-runners-apply.sh bootstrap` (creates the
instance directories and the build tool cache; root already exists), then `gha-runners-apply.sh apply`,
then `systemctl restart gha-ondemand.service` so the dispatcher's unit map for root is the deployed
one. Each row registers once, takes no job until a workflow names its label, and is parked by
gha-ondemand.

## Constraints

- A deploy interrupted mid-compose is the hazard with any runner. The ephemeral cycle ends a unit
  only when its job ends; `apply --restart-idle` never restarts a busy row; `TimeoutStopSec` on the
  build template must exceed the longest deploy (an image build can take minutes).
- The mint step runs on every cycle as root already (it does for every ephemeral row). For a root
  row the run step is root too, so the sticky-directory and rename protections in the mint script
  protect nothing extra; they stay because the script is shared.
- The host's runner watchdog and the supervisor read the same manifest. A build row with
  `mode=ephemeral` is covered by both from the first apply; nothing new to deploy for that.
- Nothing here assumes one host: a second CI host gets its own build rows.

## Build guard

A root row takes any job of its repository that names its label: a workflow on any branch, a
dispatch of a branch's copy of a workflow, a pull request from a branch or, for a public repository, a
fork. That job runs as root on the host. So the root rows run only the workflows
`runners/runners.build-allow` lists, by repository, branch and workflow file, deployed to
`/etc/askalf/runners.build-allow` (root, 0640).

- **The hook.** On a row that runs as root, `gha-ephemeral-run.sh` exports
  `ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/askalf/pitlane-build-guard.sh`; a job account's row never
  gets it. The runner runs the hook after "Set up job", which only downloads the job's actions, and
  before the job's containers, its actions' pre steps and its first step.
- **What it trusts.** The runner starts the hook with its own environment and the job's `GITHUB_*`
  values from GitHub; the workflow's `env:` never reaches it. The guard reads the event, the
  repository, the branch from `GITHUB_REF` and the workflow file from `GITHUB_WORKFLOW_REF`
  (`<owner/repo>/.github/workflows/<file>@<ref>`, which must name the same repository and ref).
- **Events.** push, schedule and workflow_dispatch, the only ones the listed workflows use. A pull
  request, `pull_request_target`, `workflow_run`, `repository_dispatch` or any other event is
  refused before the list is read, and so is a tag.
- **Why it kills the job.** The runner runs the hook as a step with condition `always()`: a failed
  hook fails the job, but the job's `if: always()` steps still run. On a refusal the guard prints
  the reason as an error annotation, logs it (`journalctl -t pitlane-build-guard`, which has a line
  for every job that ran too), waits 5 s so the run page has it, and sends SIGKILL to the job's
  `Runner.Worker`. The listener reports the job failed and the row cycles. SIGTERM would let the
  worker cancel the job, and a cancel runs `always()` steps too. With no worker among its parents
  the guard kills the row's unit, and GitHub fails the job as a lost runner.
- **The bootstrap deploy.** `PITLANE_BUILD_BOOTSTRAP` names one job, `<owner/repo> <branch> <file>`,
  that runs without the list: the host deploy that installs it, so the deploy that installs a fixed
  list can always run. The build rows read it from `/etc/askalf/pitlane-build.env`
  (`runners/examples/pitlane-build.env`); a missing or symlinked list then allows only it. Unset, or
  of any other shape, it names no job: every job needs its line, and a missing list allows none. A
  host with no guard runs root jobs unchecked and the run step logs that; the host deploy installs the
  list and the settings before the guard.
- **Adding a workflow.** Its line in `runners.build-allow`, then the host-scripts deploy (a
  `PITLANE_REF` bump), before the workflow's first job on a root label. Each row reads the guard
  and the list at its next job; nothing restarts.
- **What it does not check.** Which workflow runs, not what it does: a listed workflow changed on
  main runs as listed, and a listed workflow that builds whatever ref its dispatch names builds
  that ref.
