# Pools and caps

A repository's cap is the number of rows it has in `runners.manifest`. Each row is one
ephemeral runner slot: it takes one job, exits and registers again (about 15 s). The
dispatcher starts one stopped row per queued job that no idle listener can take, so a
burst of N jobs starts min(N, rows) listeners at once and the rest wait for a slot to
come back. The cap is the burst size a repository can absorb without queueing.

## What sets a cap

1. **The repository's own fan-out.** Count the self-hosted jobs a single push or pull
   request runs in parallel, from the workflow files. For example, dario's `ci.yml` runs
   one `validate-package-json` job, then five side by side (`build` for Node 18, 20 and
   22, `test`, `docker-inputs`), then `docker-cap-drop-smoke`. With two rows, two jobs
   run and three wait, each wait stretched by a 15 s re-registration. That is the queue tail
   a cap below the fan-out produces.
2. **The tier's budget.** `gha-exec.slice` has 700% CPU and 8 GB (`gha.slice` 10 GB). A cap is only useful
   while the repositories that burst together fit it. Rows that are not running cost
   nothing; a running Node test job is about 0.5 to 1 GB.
3. **Warm vs cold.** Warm rows (`WARM=` in the dispatcher's env) stay up between jobs and hold an
   idle listener's memory. A cap above the warm count is the cold, scale-to-zero part of the pool.

## Rule

`cap = max parallel self-hosted jobs of one push`, rounded up, then reduced until the
caps that burst together fit the tier's CPU and memory. Warm = 1 per repository that
queued 15 s or more at least once a day; add a second warm row only where the first job
of every burst is followed by a second at once.

## The exec cap, across repositories

Per-repository caps add up: one change pushed to several repositories at once can run many more exec
jobs than the slice has CPUs, and a job that takes 10 s alone takes several times longer. `EXEC_CAP`
in the dispatcher's env limits how many exec-tier rows hold a job slot at once, across
every repository it manages:

- a row holds a slot while it runs a job, or while it runs idle and is not warm (it was
  started for a job and has not parked yet);
- a start that would pass the cap does not happen; the job stays queued and the next tick
  tries again. While jobs wait, a finished job ticks the dispatcher at once (webhook);
- while jobs wait, an idle exec listener that no queued job can use, not warm and idle for
  half a minute, is parked at once to make room instead of after `IDLE_MIN`;
- an idle warm listener holds no slot until it takes a job. GitHub hands a job straight to
  a warm listener, so the warm exec rows can carry the count past the cap by at most their
  number;
- org-scoped rows (OSS) and read and build tier rows are not counted. The fleet status job
  (label `fleet-status`) runs on a read-tier row of its repository for that reason: it takes a few
  seconds and reads only the API, and on an exec row each one held a slot a test job was waiting for.
  Each such repository has two status rows, since a PR burst fires status jobs faster than one
  ephemeral row takes them (a job plus its re-mint is about 18 s).

Start at about one job per CPU of the slice. The queue-wait alert will fire during a
burst that waits on the cap; read job duration next to it (`pitlane-outcomes`). `0` or
unset turns the cap off.

## Adding rows

Add the rows to `runners.manifest`, deploy, then on the host run `gha-runners-apply.sh bootstrap`
(creates each new row's `/srv/gha/<name>` directory; safe to rerun) and then
`gha-runners-apply.sh apply --restart-idle`. `apply` holds a row whose directory is missing
instead of enabling it: an enabled unit without its directory crash-loops (status 226).

For a row in a repository the registration token does not cover yet, `apply` also holds the row and
says which token file and repository: add the repository to the fine-grained token (Administration read
and write; for an org row, Self-hosted runners write) and run `apply` again. An enabled unit without that
access fails at start with "could not remove stale registration". The check is one GitHub call per
repository per run, made only for a row about to be enabled; a rate limit or network error does not hold
a row.

## Where rows are spent

| Kind of repository | Exec rows | Why |
| --- | --- | --- |
| wide fan-out (a push runs a dozen jobs across workflows) | several of its own, up to its burst | the burst would otherwise go to the pool and compete with every other repository |
| every other repository with traffic | 1 and the pool | the own row is the warm, 2 s path for the first job; the burst goes to the pool |
| a repository that calls the Redline fix workflow | 1 extra `<repo>-fix-e1` | the fix workflow reads the fix lane's key file, so it runs on rows of its own (label `<repo>-fix`) that the dispatcher parks when idle; see isolation.md, Key files |

A repository folds into the pool by dropping its cold rows beyond the first (see Retiring a row).
Demand is checked before a repository's rows change (below).

## Measuring it again

Do not walk the GitHub API run by run for every repository: one pass over a dozen repositories
costs most of the 5,000 requests an hour. Read demand where it is cheap:

- the dispatcher's journal (`start ...` lines give the repository and time of every
  burst and how many rows it needed), and
- the workflow files, for the fan-out of one push.

## The shared pool

The queue tail is not the runner cycle (job done to the next job running on the same row takes seconds;
GitHub hands an already-queued job to a fresh listener in about 2 s) but the rows. A User account has no
runner group a warm listener could serve every repository from, and every repository row is bound to one
repository, so a repository with two rows queues while another repository's rows idle.

Pool rows (`pool-e1` .. `pool-e<n>`, scope `pool:<owner>`, tier exec, account `gha-exec`, their own
accounts through `runners.isolated`) belong to no repository. The repository is decided at each
start:

1. The dispatcher routes a queued job to the pool when no row of its repository can take it now
   (none idle, none stopped) and a plain exec row of the repository covers it: a job no row runs
   is not the pool's to guess at, and the fix lane's jobs (label `<repo>-fix`) stay on the fix
   rows, the rows meant to hold that lane's key (isolation.md, Key files). It writes one entry per such job into
   `/run/askalf/pitlane/pool-queue/<job id>` (`repo:<owner>/<name> <labels>`) and starts one
   stopped pool row per job, under `EXEC_CAP` like any exec row. A verified webhook kick names
   its job, so every job of a burst is given its row before the next listing (`kickPlan`, in the
   tick's order: an idle row of the repository, a stopped one, the pool), and the row is marked
   promised, so the next kick does not count it again. A kick that looked only at the pool would see
   the same warm idle row on every kick of a burst and do nothing, and the burst's other jobs would wait
   for the listing, two starts per tick.
2. The mint step of a pool row claims the oldest entry (the lowest job id) by renaming it to `.<row>` (its claim
   file, which the dispatcher reads to know which repository the row serves; one rename, so two
   rows never take one entry), mints a JIT config for that repository with the job's labels, and
   the row takes the job as a repository row would. After the job the unit restarts and claims
   again, so a burst is served at the plain cycle (seconds between jobs).
3. With nothing to claim the mint step lingers 20 s for the next entry, then parks the unit
   itself: it writes the park mark and exits 75, which under the templates' `ExecCondition=`
   leaves the unit inactive, not failed, and unrestarted (a `systemctl stop` from inside the mint
   step leaves the unit failed). A pool row that registered and found no job (its
   entry's job was taken by the repository's own row meanwhile) is parked by the dispatcher after
   45 s idle, not `IDLE_MIN`: its registration serves one repository, and the pool's worth is
   being free for the next. The 45 s count from the first tick that sees the unit `active` with no
   job, never from the start: a unit still activating (the mint step: claiming, minting, lingering)
   is not idle and is not parked, because a stop then kills the mint step with the unit's SIGINT
   (a mint that runs long under CPU pressure would be killed that way). `SuccessExitStatus=SIGINT` in
   the templates makes such a stop end inactive anyway, and the supervisor names a pool unit left
   failed (`failed-at-rest`). Pool rows are never warm.

   Every dispatcher park (a pool row's or a repository row's) removes the row's GitHub
   registration first, then marks and stops the unit. A stopped listener stays online to GitHub
   for about a minute, and a job queued in that minute is handed to it and waits for GitHub to
   take it back (a wait of over a minute for a job queued within seconds of a park). A registration
   GitHub lists busy, or whose removal it refuses with HTTP 422, already holds a job: the row is kept
   (`keep` in the journal, `park-kept` in the events) and takes it. A removal that fails any other way
   is logged and the stop goes ahead. The removal also spares the next start its 409 and the
   stale-registration listing.
4. Leftovers: a registration a pool row left in a repository where it took no job is removed by
   the mint step at its next start (one listing, only on a repository switch after an empty
   cycle) and by the supervisor's stale-registration heal (it joins a pool row's name over every
   repository of its owner).

A pool row starts for a job the dispatcher routes to it and at no other time. `apply` enables a
new pool row without starting it and parks it (a repository row is enabled with `--now` and parks
itself after `IDLE_MIN`), and the supervisor never counts a stopped pool row as down. At boot the
park marks are gone with `/run`, so the enabled pool rows start, find nothing queued, and park
themselves after the linger.

`POOL_MAX` in the dispatcher's env is the roll-in knob: how many pool rows it uses, in manifest
order (unset: all of them; `0`: the pool is off and jobs wait for their repository's rows as before).
Pool rows past the limit are enabled units like any other, parked by `apply`; one that starts
anyway (boot, a hand start) lingers 20 s, finds nothing to claim and parks itself, and the
dispatcher leaves the mark of a unit it does not manage alone.

With the pool, the cap is the pool: a repository bursts into as many pool rows as the cap leaves free,
and its own rows are the warm, 2 s path for the first job. The static cold exec rows beyond a
repository's first are folded into the pool, and `runners/runners.retired` names them. The fix rows
stay: the pool never carries the fix label, because the fix lane's key is readable only on the fix
rows (isolation.md, Key files).

## Retiring a row

1. Take the row out of `runners.manifest`, `runners.cpu` and `runners.isolated`, and add it to
   `runners.retired` (name, the day, why). `gha-runners-apply.test.mjs` and the host repository's
   manifest check fail when a retired row is still in one of the three.
2. Merge, bump `PITLANE_REF` in the host repository, run the host deploy. The dispatcher and the
   supervisor read the manifest every tick, so the row leaves the grid at the next tick. `apply`
   never removes a unit (a manifest typo must not delete runners), so the unit stays enabled and
   parked; at the next boot it would start, fail its mint step (no row) and restart to the start
   limit. So:
3. Run the retire-rows press (`pitlane-retire-rows`, a host deploy fix). For every row of
   `/etc/askalf/runners.retired` that the manifest no longer lists, it disables and stops the unit
   (every ephemeral template's instance of that name), removes the drop-ins, the runner directory,
   the tool cache, the park mark and the `gx-` account, then reloads systemd once. A row with a job
   running is left for the next press; a row still in the manifest is refused. A JIT registration
   lives one job, so nothing on GitHub is left behind.

Rollback: take the row off `runners.retired`, put it back in the three files, deploy, run
`gha-runners-apply.sh bootstrap` (directory, account) and `apply --restart-idle` (drop-ins, unit).

## Later

A `pool` line in the manifest (`pool askalf exec max=12`) that expands to rows, so the pool's size
is one number instead of one line per row.
