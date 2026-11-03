# GitHub Actions runners on the host

The host is the CI and build plane: the owner's own CI and deploys, Redline reviews on per-repository
runners, and the OSS lane's jobs all run here. Cloudflare stays the edge: hook hostnames through the
tunnel, Access in front of anything human-facing, Pages and R2 where they already serve.

This directory is the single description of every runner on the host and the tooling
that keeps the host matching it. It replaces copying a runner directory and registering it by hand
as the way runners come to exist.

## Files

| File | Deployed to | Role |
| --- | --- | --- |
| `runners.manifest` | `/etc/askalf/gha-runners.manifest` | one row per runner: scope (`repo:`, `org:`, or `pool:` for the shared pool, `docs/pools.md`), tier, user, dir, labels, mode |
| `RUNNER_VERSION` | `/etc/askalf/gha-runner-version` | pinned actions/runner release and tarball sha256 for the managed pools |
| `gha.slice`, `gha-read.slice`, `gha-exec.slice`, `gha-build.slice` | `/etc/systemd/system/` | the CI budget and its three tiers |
| `gha-ephemeral@.service` | `/etc/systemd/system/` | template unit for the ephemeral org-pool runners, exec tier (`gha-oss`) |
| `gha-ephemeral-read@.service` | `/etc/systemd/system/` | the same cycle for the read tier (`gha-oss-read`, `gha-read.slice`) |
| `gha-ephemeral-write@.service` | `/etc/systemd/system/` | the same cycle for the OSS lane's upstream write tier (`gha-oss-write`, `gha-read.slice`, its own runner group) |
| `gha-ephemeral-redline@.service` | `/etc/systemd/system/` | the same cycle for the Redline runners (`gha-redline`, `gha-read.slice`, one per repository) |
| `gha-ephemeral-first-party@.service` | `/etc/systemd/system/` | the same cycle for our own repositories' exec rows (`gha-exec`, `gha-exec.slice`, one per repository) |
| `gha-ephemeral-build@.service` | `/etc/systemd/system/` | the same cycle as root for the build tier (`gha-build.slice`): the deploys of our own stack, replacing the adopted root runners (`docs/ops-tier.md`) |
| `gha-app-token.sh` | `/opt/askalf/` | prints an installation token of the runner GitHub App for an account (cached in `/run`, root-only); the mint step and gha-ondemand use it and fall back to their token files without it |
| `gha-ephemeral-mint.sh` | `/opt/askalf/` | root step of an ephemeral cycle: reads the token, mints one JIT config into the instance dir; for a pool row, first claims the job the dispatcher queued and registers for its repository |
| `gha-ephemeral-run.sh` | `/opt/askalf/` | user step of an ephemeral cycle: wipe, read the row file the mint step left, consume the JIT config, take one job, exit |
| `pitlane-job-summary.sh` | `/opt/askalf/` | the job-completed hook `gha-ephemeral-run.sh` points the runner at: one line on the job's run page with its queue wait and the last 24 h (`docs/showcase.md`) |
| `pitlane-build-guard.sh` | `/opt/askalf/` | the job-started hook `gha-ephemeral-run.sh` points a root row's runner at: stops the job before its first step unless `runners.build-allow` lists its workflow on that branch (`docs/ops-tier.md`, Build guard) |
| `runners.build-allow` | `/etc/askalf/` | the workflows the root rows run, one `<owner/repo> <branch> <file>` per line (root, 0640) |
| `pitlane-build.env` | `/etc/askalf/` | the build guard's settings, which `gha-ephemeral-build@.service` reads: `PITLANE_BUILD_BOOTSTRAP`, the host deploy that runs without the list (`examples/pitlane-build.env`; root, 0640) |
| `pitlane-public.mjs`, `pitlane-public.service` | `/opt/askalf/`, `/etc/systemd/system/` | serves the supervisor's 24 h numbers as a page, as JSON and as the badge on `127.0.0.1:7312` for the tunnel (`docs/showcase.md`) |
| `gha-runners-apply.sh` | `/opt/askalf/` | `plan`, `apply`, `bootstrap`, `upgrade`, `register`, `status` |

All of them ship through the host deploy (the host-scripts manifest), and a drift check files a ticket
when the host stops matching.

## Tiers

Every runner unit is placed in a slice under `gha.slice`, which caps CI as a whole (7 cores and 10G in
the committed slice) and weights it below the services (CPUWeight=50), so a test suite or a
build can never starve the host's services or the database while CI still gets the idle cores.

| Tier | Slice | Who | Runs as | Executes repo code |
| --- | --- | --- | --- | --- |
| read | `gha-read.slice` (3 cores, 3G) | Redline seats and deploy jobs that hold credentials; the OSS lane's verdict and reply jobs (`oss-read` pool) | `gha-runner`; `gha-oss-read`, ephemeral, hardened | no |
| exec | `gha-exec.slice` (7 cores, 8G) | our own repos' CI; OSS pool: fork-candidate test suites, Breaker repro runs | `gha-exec`; `gha-oss`, ephemeral, hardened | yes |
| build | `gha-build.slice` (5 cores, 6G) | the owner's builder and ops runners | root (adopted rows, or ephemeral build rows per `docs/ops-tier.md`) | our own stack |

Build-tier runners stay root: they need the docker socket to build and deploy the
stack, and a non-root user in the docker group is root-equivalent, so moving them
would be a privilege drop in name only. The exec tier is where
untrusted-shaped work lands, and it gets the real controls: its own account, no
docker socket, `ProtectSystem=strict` with only its work dir and the tool cache
writable, and one job per registration so nothing survives from a previous job.

Toolchains for the exec tier come from the setup actions (`actions/setup-node`,
`setup-python`, `setup-go`, `dtolnay/rust-toolchain`, `setup-java`) into that tier's own tool
cache, `/var/lib/gha/toolcache-exec`; the read tier has `/var/lib/gha/toolcache-read`. They are
separate on purpose: whatever an exec-tier job drops into its cache never reaches the tier that
holds credentials. Nothing new is installed on the host per language.

Each cycle, the root mint step resets the instance directory to the runner copy and its pin
marker before registering: the runner loads `<root>/.env` and `<root>/.path` on every start, so
anything a job left there would otherwise ride into the next job. The JIT config is created in a
root-only staging directory and moved in with a rename, never written through a path the
previous job could have replaced with a symlink. The row's directory and labels reach the run
step the same way, as `.row`, so the manifest and the other host files the deploy installs are
`root:root` 640 and not readable by a job account.

## Modes

- **adopt**: runners that existed before this directory. They keep their own
  install and self-update on GitHub's schedule. `apply` puts each in its tier's slice
  through a drop-in and never re-registers it.
- **managed**: a new persistent runner built from `/opt/actions-runner/current`
  (bin and externals shared, identity per runner). `register <name>` configures it with
  a registration token read on stdin.
- **ephemeral**: an org-pool runner that registers itself for exactly one job with a
  just-in-time config minted from the org, then exits and is restarted by systemd.
  Needs `/etc/askalf/gha-org.env` (**root:root 600**), which holds `GH_RUNNER_GROUP_ID`
  (default 1) and any row's `GH_RUNNER_GROUP_ID_<NAME>`, and a registration token: the runner
  GitHub App's installation token for the org when the App is installed there (`gha-app-token.sh`,
  narrowed to **Self-hosted runners: write** on the org), else `GH_ORG_RUNNER_TOKEN` in that file,
  a fine-grained token whose resource owner is the sprayberry-code org with the organization
  permission **Self-hosted runners: read and write**. The token is read only by the root mint step
  (`ExecCondition=+`); the exec-tier account receives a single-use JIT config and
  unlinks it before the runner starts, so a job that reads the directory afterwards
  finds nothing usable. That is why the same token can carry other permissions the
  host already relies on without widening what a test suite could reach.

  An ephemeral row's `user` picks the template, and the account is the credential
  boundary: `gha-oss` runs under `gha-ephemeral@.service` (exec tier, holds nothing),
  `gha-oss-read` under `gha-ephemeral-read@.service` (the one account that can read
  `/etc/askalf/oss-read.env`, the fork-writing token and the OSS dario key), and
  `gha-oss-write` under `gha-ephemeral-write@.service` (the one account that can read
  `/etc/askalf/oss-write.env`, the token that writes to upstream repositories; its rows register
  only in the runner group `GH_RUNNER_GROUP_ID_<NAME>` names in the org token file, a group limited
  to the OSS lane's `upstream-write.yml` and `redline-candidate.yml` on main, and the mint step
  refuses them without one), and
  `gha-redline` under `gha-ephemeral-redline@.service` (the one account that can read
  `/etc/askalf/redline.env`, which holds only Redline's own dario key and model, no GitHub token:
  the verdict is posted by a trusted process outside the runner from a verified artifact), and
  `gha-exec` under `gha-ephemeral-first-party@.service` (our own repositories' PR code and the
  first-party fix lane, whose rows alone are in `gha-fix` and read `/etc/askalf/fix-exec.env`), and `root`
  under `gha-ephemeral-build@.service` (the build tier's deploys; root because they drive the
  docker socket and the host's own files, see `docs/ops-tier.md`). gha-oss and
  gha-exec both execute code, but never each other's: gha-oss runs strangers' test suites.
  Each account has its own tool cache. `bootstrap` creates every account the manifest names.
  A row whose account changes is moved by `apply`: it retires the old template's unit for that
  name (once no job is running) before it enables the new one.

  Scope decides how a row registers. Every row asks the runner App for its owner's token first
  and falls back to its token file. `org:` rows use the org's just-in-time endpoint with that
  token or the one in `/etc/askalf/gha-org.env` (Self-hosted runners: write on the org). A User
  account has no pool, so its repositories register per repository: `repo:` rows use
  `repos/{owner}/{repo}/actions/runners/generate-jitconfig` with the token in
  `/etc/askalf/gha-repo.env` (Administration: read and write on exactly those repositories,
  short expiry). Both files are root:root 600 and read only by the root mint step.

  **An org's own App.** `gha-app-token.sh` picks the App per owner:
  `/etc/askalf/gha-app.<owner>.env` (`GHA_APP_ID=<id>`) and `/etc/askalf/gha-app.<owner>.pem`
  (its private key), both root:root 600, when both are present; else the runner App in
  `/etc/askalf/gha-app.env` and `gha-app.pem`, which belongs to the User account. The mint step,
  `apply`'s access check and gha-ondemand name only the owner, so none of them changes. A private
  App installs only on its owner, so an org gets a private App owned by the org. Until its two
  files are on the host every org row mints with `GH_ORG_RUNNER_TOKEN` (journal:
  `token GH_ORG_RUNNER_TOKEN`). To set one up:
  1. The host's admin, in the org's settings (Developer settings, GitHub Apps, New GitHub App), create a
     private App ("Only on this account"), webhook off, with one permission: Organization,
     **Self-hosted runners: Read and write**. Install it on the org (the repository choice does not
     matter: the App holds no repository permission) and generate a private key.
  2. The host's admin, on the host as root: `/etc/askalf/gha-app.<org>.env` holding
     `GHA_APP_ID=<the App's id>`, and the downloaded key as `/etc/askalf/gha-app.<org>.pem`,
     each root:root 600 (`install -m 600 -o root -g root <file> <path>`). One without the other
     fails loudly, and the rows keep the token file meanwhile.
  3. As root, `/opt/askalf/gha-app-token.sh <org> - organization_self_hosted_runners=write >/dev/null && echo ok`
     checks the App (exit 4: not installed on the org). The org App's caches are kept apart from
     the runner App's, so the next mint of each org row logs `token app`; wait for one from every
     org row.
  4. Retire the token from the host: remove only the `GH_ORG_RUNNER_TOKEN=` line from
     `/etc/askalf/gha-org.env`. Keep the file and its group ids: `apply` holds an org row whose
     file is missing, and the write row is refused without its own group. A mint that then finds
     neither token fails with "no runner App is installed on <org>": fix the org's App, do not put
     the token back. Revoke the token in GitHub only after checking that nothing else on the host
     holds its value.

  Root runners must not execute PR code. Jobs that only need a repository secret run on non-root
  exec-tier rows (`dario-exec-e1` is the example); jobs that need a shared OAuth credential cannot run
  PR code at all and are push, schedule or dispatch only. The root runners then serve only
  trusted-event jobs: pushes to the default branch, schedules, dispatches, deploys.

  Why Redline moved to ephemeral rows: a same-repo pull request runs its own workflow files,
  so any same-repo PR could add a job on the `redline` label and read whatever the persistent
  runner's account could read, then leave something in the runner directory for every later
  run. One job per registration and the reset between jobs close the second half; taking the
  approver token off the runner closes the first.

  The instance directory is root-owned, sticky and group-writable. It holds the pinned
  runner's `bin/` and `externals/`, root-owned, as hard links to
  `/opt/actions-runner/<version>` laid by `gha-runners-apply.sh layout` (bootstrap and
  upgrade run it; `/srv` and `/opt` are one filesystem on the host, and a full copy per row
  wastes disk). The mint step cannot make those links: it
  runs inside the unit's mount namespace, where the instance directory is its own bind
  mount and link(2) across mounts is EXDEV. So the mint step lays a plain copy only when
  an instance has no runner of the pinned version (a new row, a pin bump before `upgrade`
  ran), and `layout` turns copies into links; `.pinned` records the version and which
  layout is there. It has to be a real directory: the runner resolves its root from
  the real path of `bin/`, so a symlink into `/opt` makes it try to write `_diag` there
  and abort. Root-owned plus sticky
  means a job running as the exec user can only write its own files (`_work`,
  `_diag`, `.runner`, `.credentials`, `run-helper.sh`) and can neither modify nor swap
  the runner it executes under. The mint step also deletes a stale registration of
  the same name (an ephemeral runner that exits before a job leaves one behind, and
  the next mint would fail with "Already exists"); a busy one is left alone.

A User account's runners are per-repo. An Organization's pool registers at org level; the runner
group should be limited to the OSS control repo, because the forks themselves carry no workflows.

## Operating it

```
gha-runners-apply.sh plan                  # what would change; safe any time
gha-runners-apply.sh apply --restart-idle  # write drop-ins, daemon-reload, restart idle changed units
gha-runners-apply.sh bootstrap             # gha-oss user, /srv/gha, tool cache, pinned runner install
gha-runners-apply.sh status                # unit state, busy, GitHub-side status per row
gha-runners-apply.sh upgrade --restart-idle   # after bumping RUNNER_VERSION and deploying it
```

A unit with a job running is never restarted by these commands; they say which ones
were deferred. Slices take effect at a unit's next restart.

The host's runner watchdog checks every non-ephemeral row for being online on GitHub's side, because
a listener that lost its session still reads `active (running)` locally while jobs
queue forever.

### On demand (gha-ondemand)

Idle listeners hold RAM around the clock for repositories that run a few jobs an hour.
`gha-ondemand.service` (`gha-ondemand.mjs`, root) keeps the
repository-scoped ephemeral rows stopped while nothing waits for them:

- every 30s it lists each repository's queued self-hosted jobs (conditional requests, so an
  unchanged answer costs no rate limit) and starts a stopped row whose labels cover a job that
  no idle listener can take; registration takes about 15s, then the job starts;
- a listener with no job for 10 minutes and none queued that it could take is parked: a mark
  in `/run/askalf/gha-ondemand/<unit>`, then `systemctl stop`. The watchdog leaves a stopped unit
  with a mark alone. A unit that is started again by anything clears its mark.

Org-scoped rows (the OSS pools) are not managed: their jobs come from many repositories. The
dispatcher only reads their units and lists them in dispatcher.json as `watched`, for a dashboard's grid.
`/etc/askalf/gha-ondemand.env` (optional) sets `MODE=on` (the default, `dry`, only logs what it
would start and park), `POLL_SEC`, `IDLE_MIN`, `WARM=<row>,<row>` for rows kept running,
`EXEC_CAP` (exec-tier job slots across every repository, off when unset; see docs/pools.md),
`POOL_MAX` (how many of the shared pool's rows the dispatcher uses, in manifest order; unset is all
of them, `0` turns the pool off; docs/pools.md), and
`RATE_FLOOR` (1500: below that many requests left on the token's hour, a tick stops asking).

```
systemctl enable --now gha-ondemand.service    # once, after the deploy
journalctl -u gha-ondemand -f                  # its decisions
node --test runners/gha-ondemand.test.mjs
```

## Rolling out on a host

1. Merge, let the host deploy ship the files. The deploy runs `systemd-analyze verify` on the units
   and `daemon-reload`.
2. `gha-runners-apply.sh plan`, then `apply --restart-idle`. Adopted runners move into their slices as
   each becomes idle. No re-registration.
3. `gha-runners-apply.sh bootstrap` to create the exec tier. Nothing starts until the
   org token file exists.
4. The host's admin: give the org its own App (see "An org's own App" above), or give an org-scoped
   fine-grained token the org permission above; write `/etc/askalf/gha-org.env` root:root 600 (the
   group ids, and the token if there is no App), then `apply` again; the OSS exec rows come up and show
   in the org's runner list while waiting for a job.
