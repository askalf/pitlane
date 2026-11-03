# Supervisor

The dispatcher (`gha-ondemand`) starts and parks rows. Nothing in it watches whether the rows it
starts are healthy. A per-row shell watchdog that checks each unit has three gaps:

- It asks GitHub about every row one at a time (`gh api .../actions/runners` per row), so about one
  request per row per tick on a token shared with everything else; the dispatcher already runs with a
  1,500 floor on that same token.
- It knows a unit is down, not why. A new row with a missing directory crash-loops about once a second
  (status 226/NAMESPACE) and a watchdog that only knows the unit is down keeps restarting it.
- It cannot see a job that never ends, a runner left behind at an old version, a stale
  registration, or the host running out of disk or memory.

The supervisor is one process with one snapshot per tick, a table of failure classes, and a short
allow-list of heals. It starts observe-only.

## Where it runs

A separate unit, `pitlane-supervisor.service`, root, not a thread of the dispatcher.

- A bug in the supervisor must not stop scaling, and the supervisor must be able to notice that
  the dispatcher stopped. The dispatcher writes `/run/askalf/pitlane/dispatcher.beat` every tick; a
  stale beat is a failure class.
- The dispatcher also writes `/run/askalf/pitlane/dispatcher.json` every tick (`stateDoc` in
  `gha-ondemand.mjs`): every managed row with what its unit read and what the tick did to it
  (`tick`: start, park, park-room), the org rows it watches but never starts or parks (`watched`, with
  their unit reading and held mark), every queued job and whether it went to the pool, the knobs,
  the token budget, the last hour of starts, parks, kicks and failures (`events`), and what the host
  runs (`deploy`: the pitlane commit the host deploy installed, read from `/opt/askalf/pitlane.ref`,
  a copy of the host repository's `PITLANE_REF` that the deploy writes; when it was installed; when the
  dispatcher started; `restart` when a module it loaded is newer on disk than that start). A tick
  that fails rewrites the last good document with `error` set. A dashboard draws its grid from
  this file; the supervisor does not read it.
- It shares the dispatcher's contracts, not its code: the manifest, `PARK_DIR` marks, `unit_for`.
  Those move to a small `lib/` both import.
- Output: `/run/askalf/pitlane/status.json` (the snapshot and every finding) and Prometheus text on
  `127.0.0.1` for the metrics step. The alert path is the one that exists: the host's runner watchdog
  reads `status.json` and turns open findings into its one anomaly line. No new channel.
- `status.json`, `metrics.prom` and the dispatcher's files are 0640 to the dashboard reader's group, the
  directory 0711 and the held marks root's alone, so no job reads the runner map (`docs/isolation.md`,
  Host state files).
- The public numbers: `/run/askalf/pitlane/public`, the last 24 h for every repository together and none
  named, which `pitlane-public.mjs` serves for the badge and the run-page line reads (`docs/showcase.md`).

## The snapshot

Once a tick (60 s from one tick's start to the next, whatever the tick took; `tookMs` in `status.json` and `pitlane_tick_seconds` in the metrics say how long it ran), no per-row GitHub calls:

| Source | What it gives |
| --- | --- |
| systemd (`show` for every row unit) | active state, result, restart count, time in state |
| cgroup procs | whether a `Runner.Worker` is alive in the unit, and since when |
| `/srv/gha/<row>/.pinned` and `RUNNER_VERSION` | runner version on disk vs pinned |
| GitHub `repos/<r>/actions/runners`, one per repository, conditional (ETag) | each registration: status, busy, version |
| GitHub `repos/<r>/actions/runs?status=in_progress`, shared with the dispatcher's cache | the job a worker holds and its age |
| `df` | disk use |
| `cpu.stat`, `cpu.pressure`, `memory.pressure`, `memory.events`, `memory.current` of `gha.slice` and its three tiers | per 15-minute window: share of CPU periods throttled, share of time tasks stalled on CPU and on memory, memory cap hits, OOM kills, memory used against its limit |

The slice figures answer whether queue wait came from the host or from too few rows. A tier throttled in more than 10% of periods, or stalled more than 10% of the time, raises `slice-pressure`; adding rows to a throttled tier will not shorten the wait. Memory cap hits are recorded but do not alert: a tier full of page cache hits its cap without harm, and an OOM kill does alert. Metrics: `pitlane_slice_*`.

Budget: at most 300 GitHub requests an hour, and a tick that would pass the floor reads from cache.

## Failure classes

Each has a detector (a pure function of the snapshot, table-tested), a severity, and the heal, if any.

| Class | Detected when | Heal |
| --- | --- | --- |
| **crash loop** | the unit's journal shows 3 failed exits in 5 min (a clean exit after a finished job is not counted), or result is `exit-code` with status 226, 203 or 217 | an exit status of 226, 203 or 217, or 10 failed exits in 5 min: the held mark written first (`/run/askalf/pitlane/held/<unit>`: the time, the finding and the unit's last journal line that is not systemd's own chatter, GitHub tokens masked), then `systemctl stop` and `reset-failed`. `systemctl disable --now` is not allowed. The hold lapses after 60 min: the mark goes and the row may start again, and one still broken is held again. 3 to 9 failed exits are reported and left running. A held row is a standing `crash-loop` finding naming when and why; a mark written by hand with no time is never lifted by the supervisor. Never a row with a worker. |
| **down** | enabled, not parked, inactive past the grace | `reset-failed` and `start`, once per 60 min per row |
| **dispatcher stopped** | the unit not active, or its beat older than 90 s | alert always; `reset-failed` and `systemctl restart gha-ondemand` once per 30 min (`restarted` in `status.json`) when systemd holds it failed or a running dispatcher's beat is 5 min old. Never after a pause by hand (inactive, result success: the host's admin's dispatcher-pause press is a plain stop), and never between systemd's own restarts (`RestartSec=30`) |
| **stuck job** | a `Runner.Worker` alive longer than the job's `timeout-minutes` plus 10 min, or older than the 6 h GitHub ceiling when unknown | alert at the limit; kill the worker only past a hard ceiling set in the env (default off) |
| **ghost job** | GitHub says a job is in progress on a runner that is offline or absent, for 15 min | alert; GitHub's own timeout ends it |
| **stale registration** | an offline registration of a manifest-ephemeral name for 30 min, on a row that is not parked (the dispatcher removes a row's registration when it parks it; one a failed removal left stays until the next start removes it) | delete that registration (the mint step already does this for one name at start; this covers rows that never start again) |
| **version drift** | disk or GitHub-reported runner version differs from the pin | alert; `upgrade --restart-idle` is a manual step until the pin discipline is proven |
| **disk pressure** | `/srv` or `/` above 80% (alert), 90% (heal) | prune `_work` and tool caches of rows with no worker; never a busy row |
| **memory pressure** | `memory.pressure` some avg60 above a threshold, or an OOM kill in a gha slice | stop cold-started parked-eligible rows first, tell the dispatcher to refuse starts (a `hold-starts` mark it honors) for 5 min |
| **registration lost** | the row's unit is active, GitHub shows it absent for 5 min | restart that unit once |
| **unclaimed queue** | a repository row's unit runs with no job, GitHub lists its registration online and idle, and a queued job in its repository that its labels cover (from `dispatcher.json`, no GitHub call of its own) has waited beside it for 5 min. The dispatcher counts that row as the taker and starts nothing else, so the job waits until the registration is replaced | `systemctl restart` that unit, so its mint step registers it afresh, once per row per hour (`recycled` in `status.json`); never a row with a worker or a registration GitHub counts busy, a parked, held or pool row |
| **runner suspect** | a job in the last hour ended in a way that points at the runner (`setup-failed`, `runner-lost-suspect`; see outcomes.md) | alert, naming the rows; no heal, the record is read by a person |

Rules for every heal: allow-listed in one table; at most one heal per row per 15 min and 5 per tick;
a busy row (a `Runner.Worker` in its cgroup) is never touched; every action is one log line with the
class, row and reason; `MODE=dry` (the default) logs the line and does nothing.

## Contracts it must keep

- **PARK_DIR marks.** A parked unit is not down. The supervisor reads the marks and never writes
  them; only the dispatcher parks.
- **Held rows.** A crash-looped row gets `/run/askalf/pitlane/held/<unit>`; the dispatcher skips a
  held row when choosing what to start (`plan`, `kickPlan`, and `startUnit` itself), so the two
  cannot fight; `dispatcher.json` says `held` per row. Removing the mark by hand lifts the hold at
  once. `status.json` lists the marks under `held`.
- **Heal scope.** Heals are `systemctl` calls and one `gh api -X DELETE` on a runner registration. No
  file writes outside `/run/askalf/pitlane`, no unit edits, no new timers.

## Phases

1. **Observe.** Snapshot, the detectors, `status.json`, metrics text. Tests per detector from fixtures,
   including the 226 crash loop (built from real journal lines). No actions.
2. **Heal.** The allow-list behind `PITLANE_MODE=heal` (`/etc/askalf/pitlane-supervisor.env`), one class at
   a time, in order: down (`runners/pitlane-supervisor-heal.mjs`, the start once per row per hour that the
   old watchdog did, with `heals`, `healsTotal` and `started` in `status.json` and `pitlane_heals_total`
   in the metrics), then stale registration (the offline registration is deleted on GitHub the way the
   mint step clears one name at start, once per row and registration id per hour, never an entry GitHub
   counts busy or whose unit is active; `deregistered` in `status.json`), then unclaimed queue (the
   restart above), then crash loop (the hold) and dispatcher stopped (the restart above). The rows
   watched are every ephemeral row in the manifest, the org pool's included (`supervisedRows`), so
   nothing is left to the old watchdog.
3. **Replace the old watchdog's runner half.** It drops its per-row loop and reads `status.json`
   instead: each finding becomes one entry of its runner anomaly with the same `gha_runner:<row>@<scope>`
   alert key, and a `status.json` missing or older than five minutes is itself the anomaly. The adopted
   rows, which the supervisor does not watch, keep their one GitHub check there. Deployed with the
   staged fix that writes `PITLANE_MODE=heal` and restarts the supervisor, pressed right after the
   deploy so the host is never without the restart.
4. **Pressure and stuck jobs.** The classes that need thresholds from real data, set after a week of phase 1
   logs.

## Open decisions

1. Kill a worker past the hard ceiling, or alert only. Default alert only.
2. Version drift stays manual until the pin and `upgrade` have run clean twice.
3. Whether `status.json` also feeds a dashboard directly or through the metrics endpoint only.
