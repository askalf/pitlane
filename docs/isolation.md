# Isolation

A fresh workspace per job is already true: an overlay would buy speed, not safety. The real gap is
visibility: without per-row accounts, jobs on different rows run as one account and can see each
other. This document describes the change that closes that gap.

## What is already isolated

Each ephemeral row takes one job per process (`--jitconfig`), then exits. Every cycle the root-side
mint step resets the instance directory to the root-owned runner copy plus `.pinned` and removes
everything else, and the run step removes `_work` and the registration files. The unit adds
`PrivateTmp`, `PrivateDevices`, `ProtectSystem=strict` with the row's directory and tool cache as the
only writable paths, `NoNewPrivileges`, an empty capability set, and no docker socket. Each tier has
its own account (`gha-exec`, `gha-redline`, `gha-oss`, `gha-oss-read`, `gha-oss-write`), and the key files of one tier
are unreadable from another. A job never inherits a previous job's workspace.

## What is shared without per-row accounts

The first three items are read from the unit and directory modes; the canary below confirms them.

1. **One account for every first-party row.** All rows of the exec tier run as `gha-exec`.
   Two jobs in different repos are the same uid on one kernel. Same-uid processes can read each
   other's `/proc/<pid>/environ` (Yama restricts ptrace attach, not that read), and a step's
   environment holds what the workflow passed it, secrets included. They can also signal each other.
2. **Sibling workspaces are readable.** Instance directories are `root:gha-exec`, mode 1770, so a job
   in one repo can list and read another row's `_work`, which holds that repo's checkout and, unless
   `persist-credentials: false`, its git credential.
3. **One tool cache for the tier.** `/var/lib/gha/toolcache-first-party` is owned by `gha-exec` and
   writable by every first-party job. A job in one repo can plant a tool that a job in another repo
   then runs.
4. **One network.** Jobs share the host's loopback and can reach the local services listening there
   (the dispatcher's webhook port among them). Closing this needs a network namespace per job, which
   is a different size of change; see Later.

The target is "0 jobs sharing a workspace". Items 1 to 3 are jobs sharing a machine view, and that is
what this design removes.

## The change: one account per row

Every ephemeral row runs as its own account, `gx-<row>`. useradd takes 32 characters, and
`gx-acme-widgets-frontend-redline-e1` is 35, so a row whose name is too long names its account with an
`account=gx-<name>` word in `runners.isolated` (that row runs as `gx-acme-frontend-redline-e1`). apply holds
a row whose account is over 32 characters, is not a `gx-` name, or is another listed row's. The
directory and the tool cache keep the row's name. Nothing else about the cycle changes.

- Instance directory: `root:gx-<row>`, mode 1770, so the row's own account can write it and nobody
  else can read it.
- Tool cache: `/var/lib/gha/toolcache/<row>`, owned by the row's account. A row serves one repository
  and the cache persists across that row's cycles, so a repo keeps its warm toolchains and cannot
  poison another repo's. Disk: node 22 unpacked is about 200 MB, so the worst case is about 200 MB
  times the number of listed rows; the supervisor's disk class watches it. A seeded read-only base layer
  is the fix if that grows.
- Shared key files stay readable through a supplementary group: the unit adds
  `SupplementaryGroups=gha-exec`, so `/etc/askalf/fix-exec.env` (`root:gha-exec` 640) still works for
  rows that need it. The tier boundary (exec versus Redline versus OSS) is unchanged. A row that
  needs no key file is listed with `groups=none` and drops the group (see Key files).
- Free hardening that only works once uids differ: `ProtectProc=invisible`, so a job's `/proc` lists
  only its own processes. `ProcSubset=pid` is not used: it hides `/proc/cpuinfo` and `/proc/meminfo`,
  which Node's `os.cpus()` and `os.totalmem()` read, and test runners size their workers from them.

Why not mounts. A `TemporaryFileSystem=/srv/gha` plus a bind of the row's directory would hide
siblings without new accounts, but the mint step moves the JIT config from `/srv/gha/.mint` into the
row's directory with `rename(2)`, and across two mounts that is `EXDEV` (the mint script's header
records the failure). Per-row uids use plain permissions and break nothing there.

Why not `DynamicUser`. The mint step must chown the directory to the account before the unit's own
process starts, and a dynamic uid is not known to it at that point. Static accounts are simpler to
reason about and to audit.

## Where it lives

- `gha-runners-apply.sh`: for each row named in `/etc/askalf/runners.isolated` (deployed from
  `runners/runners.isolated`) it creates `gx-<row>` (system account, no shell, no home), the tool cache
  `/var/lib/gha/toolcache/<row>`, and a per-unit drop-in `20-isolated.conf` with `User=`, `Group=`,
  `SupplementaryGroups=<tier account>`, `ProtectProc=invisible`, the row's tool cache environment and
  its own `ReadWritePaths=`. A row taken off the list loses the drop-in. Plan mode shows each change.
- The drop-in also sets `GHA_ROW_ACCOUNT=<account>` in the unit's environment. The mint step reads that
  variable and gives the instance directory, the JIT config and its checks to that account, so the
  account the files go to is always the account the unit runs as. The list itself is read only by
  apply, so editing it cannot make a cycle mint for one account while the unit runs as another.
- The manifest keeps seven columns because the dispatcher and the host's runner watchdog parse it by
  count; the list is a separate file. Rows not listed keep the tier account. The run script needs no
  change.
- Supervisor: `isolation-drift` warns when a listed, enabled row's unit runs as another account, or its
  instance directory belongs to another group or lets other accounts in.

## Proof first, then roll out

A pair of canary jobs in pitlane, run on two different rows at the same time:

- Job A exports a random fake secret into its environment, writes a marker file in its workspace and
  in the tool cache, then sleeps 60 s.
- Job B, on another row, tries to read A's `/proc/*/environ`, list `/srv/gha/*/_work`, and write into
  the shared tool cache and into A's cache path.
- B passes only if every attempt is refused and exits non-zero if it finds the secret or the marker.

Run it before the change to confirm items 1 to 3 on the real host (expected: B finds A's secret), and
after it as the regression test, on a schedule, so a later template edit cannot undo this silently.
The fake secret is made for the run; no real value is involved.

## Rollout

1. Canary workflow in pitlane, run against the unchanged setup. Its result decides whether items 1 to 3
   are real; if B finds nothing, stop and revise this document.
2. Apply support and the drift class, behind an empty `runners.isolated`. Deploy; nothing changes.
3. List one row. Run the canary pair against it and a second row.
4. List the rest repo by repo, quietest first, watching queue wait for any start-time cost (a new
   account adds one `chown` per cycle; expect no measurable change).
5. Make isolated the default and drop the list.

Rollback at any step is removing the row from the list and re-running apply; the old account and
directories are unchanged.

## Later, not in this change

- **Network namespace per job.** Removes the shared loopback. Jobs spin up local servers, so each
  needs its own loopback plus a way out (a veth pair or a user-space stack), and a plain
  `IPAddressDeny` cannot tell a job's own loopback from the host's. Do it for the OSS tier first.
- **OSS exec rows in gVisor.** Upstream candidates and model-chosen commands run there, so it is the
  tier that needs the strongest boundary. Per-row accounts apply to it; the design for the sandbox
  after them is below.
- **Seeded read-only tool cache** as the base under each row's writable one, if disk grows.

## gVisor for the OSS exec rows (design, not built)

Per-row accounts keep one job from another job's files. They do not keep a job from the host kernel:
an upstream candidate's test suite on an OSS exec row (for example `oss-1`) makes its system calls to
the same kernel as every other row. gVisor (`runsc`) puts a user-space kernel between the job and the
host. Scope: the OSS exec rows only. The read, write and Redline tiers run our own scripts, and
per-row accounts suffice there.

- **Platform.** Where the host has no `/dev/kvm` (a typical cloud VM), use `--platform=systrap`,
  runsc's default; `ptrace` is the fallback and is slower. Expect a cost on syscall-heavy steps
  (`npm install`, git, file-heavy test suites); measure it before the second row.
- **What runs inside.** The whole runner, listener and job, one sandbox per row cycle. The mint step
  stays on the host: it needs the root-only staging directory and `rename(2)` into the row's directory.
  The run step starts `runsc run` on a bundle the mint step writes beside `.row`, in place of starting
  the listener directly.
- **Root, once.** A rootful runsc needs root and namespaces at its own start, and the unit templates
  have `RestrictNamespaces=yes` and an empty capability set, which block it (a rootless runsc
  needs user namespaces, which the same setting blocks). So the OSS exec rows get their own template,
  `gha-ephemeral-sandbox@.service`: the unit starts as root with only the capabilities runsc's own
  start uses, and nothing else of the unit hardening is relaxed. The job inside never holds them.
- **The OCI spec.** `process.user` is the row's account (`gx-oss-1`), no additional groups,
  `capabilities` empty in every set, `noNewPrivileges: true`. Root filesystem: the host's `/`
  read-only, with an overlay held in the sandbox's memory so a job's writes outside its mounts vanish
  with the sandbox. Masked with an empty tmpfs: `/etc/askalf`, `/root`, `/srv/gha`, `/var/lib/gha`,
  `/var/lib/askalf*`, `/run` (the docker socket and pitlane's state with it). Mounted read-write: the
  row's own directory and tool cache. Mounted read-only: `oss-exec.env` alone, at its usual path.
- **Network.** `--network=sandbox`: gVisor's own network stack, so each job has its own loopback and
  cannot reach a host listener on 127.0.0.1 (the network namespace item above, for this tier). Its
  interface is a veth into a per-row network namespace on a bridge for the sandboxes, NAT out. The net
  fence must then drop the host, docker's networks (172.16.0.0/12) and the cloud metadata address
  (link-local 169.254.169.254) from that bridge; the fence is a separate change.
- **Install, as a press.** runsc from gVisor's apt repository at a pinned release, then
  `runsc --platform=systrap do true` and a network smoke from inside a sandbox. Nothing is installed
  until that press.
- **Rollout.** A `runners.sandboxed` list read by apply, like `runners.isolated`. One OSS exec row
  first, with the probe copy in a repository of the OSS org run inside the sandbox; its job times against
  the other OSS exec row's for a week; then the second. Rollback is taking the row off the list and
  applying.
- **Not possible there.** Container jobs (no docker socket either) and anything that needs
  `/dev/kvm`.

## Decisions

1. The canary runs against the unchanged setup first: it confirms items 1 to 3 before the change.
2. Per-row toolchain caches persist across a row's cycles. A new cache starts empty, so a row's first
   jobs after isolation download their toolchains once.
3. The OSS tier follows the first-party rows, listed together with the Redline rows.

## Key files

Per-row accounts separate workspaces, processes and caches. They do not separate key files by
themselves: a listed row keeps the tier's group as a supplementary group unless its line in
`runners.isolated` says otherwise, and the tier's group reads the tier's key files under `/etc/askalf`.
It also opens every unisolated row's instance directory (`root:gha-exec 1770`: checkouts and job
records). A row that kept the exec group could therefore read the directories of other repositories'
exec rows and every exec key file.

So each lane's key files have a group of their own, and only that lane's rows are in it:

| Group | Files (`root:<group> 0640`) | Rows | Label |
| --- | --- | --- | --- |
| `gha-fix` | `fix-exec.env`, `fix-prompt.md` | the `<repo>-fix-e1` rows, one per repository that calls the fix workflow | `<repo>-fix` |
| `gha-review` | `review-lane.env` | the review lane's row (`<repo>-review-e1`) | `<repo>-review` |
| `gha-redline` | `redline.env`, `redline-prompt.md`, and the second lens's `redline-second.env`, `redline-second-prompt.md` | the `<repo>-redline-e<n>` rows and `oss-lane-redline-e1` | `redline` |
| `gha-oss` | `oss-exec.env` | the OSS exec rows (`oss-1`, `oss-2`) | `oss` |
| `gha-oss-read` | `oss-read.env` | the OSS read row (`oss-read-1`) | `oss-read` |
| `gha-oss-write` | `oss-write.env` | the OSS write row (`oss-write-1`) | `oss-write` |

The last four groups are the Redline and OSS tiers' own accounts' groups, which the key files already
had. Every row of those tiers is listed with its tier's group, so the group opens no row directory (no
row runs as the tier account), only its tier's key files.

Every other listed exec row, the pool rows included, has `groups=none`: no key file and no other row's
directory. The dispatcher never gives the pool a job whose label ends in `-fix` or `-review`
(`poolFor` in `gha-ondemand.mjs`), so a lane's job waits for its own row. `apply` creates a named
group the host does not have yet and holds a row whose `groups=` value is not a group name.

With every exec row listed with `groups=none`, no exec row runs as `gha-exec` itself. A row that joins
or leaves the list while its unit runs keeps its directory's group until its next start (`moves_now` in
`gha-runners-apply.sh`, the `later` line in apply's log): the mint step gives the directory to the
unit's account at every start, and a job in flight keeps its own directory. Until then the
supervisor's isolation-drift warns for that row. Each new account's tool cache starts empty, so its
first jobs download their toolchains.

What is left:

- The build rows run as root and cannot be listed; apply holds a root row it finds on the list. The
  build guard (`runners.build-allow`) limits which workflows they run.
- The Redline rows share `redline.env` through `gha-redline`. Isolating them separates their
  workspaces, processes and caches, and that group opens no Redline row's directory, but a job on any
  Redline row can still read the key every other Redline row uses. A key per repository is the step
  after.
- The OSS exec rows share `oss-exec.env` the same way, and they run upstream code: see gVisor for the
  OSS exec rows, above.

The canary's section 5 checks this from inside a job. Findings are: a file under `/etc/askalf` that
the probe's account can read and `canary/expected-readable.txt` does not list, the container socket,
`/root`, the seat directory of the dario API router, and another row's writable tool cache. It reports
names and paths, never contents. Loopback listeners are printed for information, since the network is
shared.

Section 6 checks what `docs/showcase.md` adds: `/run/askalf/pitlane/jobs` cannot be listed, no other
row's job record is readable, and no file the public server serves holds a slash (a repository name
or a path). A record takes its row directory's group when it is written, so one written while the
row still shared a group with other rows stays readable by them until the row's next job rewrites
it, and an idle row never rewrites it; on start the dispatcher gives every record its row's current
group again (`ownJobRecords`), and makes a record whose row directory is gone root-only.

Section 7 checks the host state files below: none of those directories can be listed and none of
those files read, today's outcomes file included. The probe takes the rows from the manifest in its
own checkout (the instance directory column) and opens each by name; a run whose own row is not on
that list is inconclusive (exit 2) rather than a pass.

The canary runs two probes at once beside the plant. pitlane has one exec row, so at least one probe
runs on a pool row, and the coverage job (`canary/probe-coverage.mjs`) fails an enforce run in which no
passing probe did. A third probe, `probe-redline`, runs on pitlane's Redline row (pitlane-redline-e1)
and reads its list of expected host files from `canary/expected-readable-redline.txt` (the Redline
key files, the second lens's two among them, named in `EXPECTED_READABLE`); coverage fails an enforce run in which it did not pass on a
Redline row. Its sibling check covers every other row's `_work`, so a Redline row that could still
read another Redline row's directory is a finding. It runs daily in enforce mode. The OSS rows are
registered to the sprayberry-code org, which pitlane's jobs cannot reach; a copy of the probe in a
repository of that org is how those rows get one.

## Host configuration files

A job account reads no configuration file the deploy installs under `/etc/askalf`. The deploy installs
`gha-runners.manifest`, `gha-runner-version`, `runners.isolated` and `runners.cpu` as `root:root` 640,
and its timestamped `.bak` copies as `root:root` 600, so none of them lists the rows, accounts or CPU
shape to a job. Every reader of those files runs as root: the mint step, the apply script, the
supervisor and the on-demand controller.

The run step runs as the job account and needs two fields of its row (the instance directory and the
labels). The root mint step resolves the row and delivers them as `.row` in the instance directory,
owned by the row's account, mode 400, the way it delivers `.jitconfig`: created in the root-only
staging directory and moved in with `rename(2)`, which replaces whatever a job left at that name and
never follows it. The directory is reset every cycle and the run step removes `.row` after reading it.
The run step finds the file at `/srv/gha/<name>/.row`, the unit's `WorkingDirectory=`, and stops the
cycle when it is missing or does not name that directory. Nothing in a job's view of `/etc/askalf`
is needed to start it.

`canary/expected-readable.txt` stays empty: the probe matches every regular file under `/etc/askalf`,
backups included, so a readable `.bak` is a finding like any other.

## Host state files

The dispatcher and the supervisor keep their state on the host, and every one of these files names
repositories or rows, private ones among them. No job account can list these directories, `/srv/gha`
aside (the runner needs it, below), or read these files:

| Path | Owner, mode | Read by |
|---|---|---|
| `/srv/gha` | `root:root` 755 | listable by every job: the runner lists each directory above a job's `_work` before the job starts and fails the job when one refuses. Each `/srv/gha/<row>` is 1770, the row's group, so another row's files stay out of reach; the row names do not |
| `/run/askalf/pitlane` | `root:root` 0711 | a job opens `jobs/<row>` and `public/` by name (`docs/showcase.md`) and lists nothing |
| `status.json`, `metrics.prom` (supervisor); `dispatcher.json`, `dispatcher.beat`, `waits.jsonl`, `waits.jsonl.1` (dispatcher) | `root:<read group>` 0640 | root (the supervisor, the host's runner watchdog, the deploy presses) and the dashboard |
| `/run/askalf/pitlane/held` (the supervisor's hold marks) | `root:root` 0700, marks 0600 | root: the supervisor (and the host's admin, lifting a hold by hand) |
| `/run/askalf/gha-ondemand` (the park marks) | `root:root` 0700 | root: the dispatcher, the mint step, apply, the supervisor, the pool and drain presses |
| `/var/lib/askalf/pitlane` (the outcomes, `docs/outcomes.md`) | `root:root` 0700, files 0600 | root: the dispatcher writes, the supervisor reads |

The read group is `PITLANE_READ_GID`, which both units set: the dashboard runs as that uid and gid
with no capabilities and reads the six files by name through a read-only bind of
`/run/askalf/pitlane`, so it needs the group's read bit on each file and only search on the
directory. On the host, that gid is the dashboard reader's account and has no other member. With the
variable unset or not a number the files are 0600, root's alone, and the dashboard reads none of them.

How they stay private:

- A file written whole (`writePrivate` in `pitlane-waits.mjs`) goes through a temp file created new
  at the private mode, given its group and mode before `rename(2)` gives it the name. No account
  outside the group ever sees the file at 0644, not even for the time between a write and a chmod.
- A file appended to (`appendPrivate`: the waits, the outcomes) has its owner and mode set on the
  open file before each append, since the mode an append gives applies only when it creates the file.
- At start the dispatcher and the supervisor set the directories' modes again and tighten every file
  above that is already there, so state written under looser modes follows without a reboot.
  `RuntimeDirectoryMode=0711` does the same for `/run/askalf/pitlane` at each supervisor start.
- `gha-runners-apply.sh` sets `/srv/gha` to 755 on each apply (711 fails every job at start, the
  runner's check above); it and the mint step make the park directory at 700.

## Status

Per-row accounts are live for the rows listed in `runners/runners.isolated`: the first-party exec rows
(the pool rows and the lane rows included), the Redline rows and the OSS rows, each with its tier's
group where it has one. The root build rows cannot be listed (above). With every exec row on its own
account the canary enforces, daily, from a pool row and from pitlane's Redline row. gVisor for the OSS
exec rows is designed above and not built.
