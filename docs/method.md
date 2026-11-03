# How the published numbers are measured

Every number on [pitlane.askalf.org](https://pitlane.askalf.org/), in its
[stats.json](https://pitlane.askalf.org/stats.json) and on the badge comes from GitHub's own
timestamps for the jobs the runners took. Nothing is sampled and nothing is estimated. This page says
where each number comes from, what is left out, and how to check it.

## The sources

- **Start (queue wait).** When a runner starts a job, GitHub sends a `workflow_job` webhook with
  `action: in_progress`. Its `started_at` minus its `created_at` is the job's queue wait: from GitHub
  creating the job to a runner starting it. The dispatcher records one entry per job
  (`writeJobRecord` in [runners/pitlane-waits.mjs](../runners/pitlane-waits.mjs)). GitHub gives both
  times in whole seconds, so every wait is a whole number of seconds.
- **Run.** When the job finishes, the `workflow_job` webhook with `action: completed` gives its
  `completed_at`; run time is that minus `started_at`. It includes the runner's wrap-up after the last
  step ([docs/run-time.md](run-time.md)). The supervisor keeps one line per finished job
  ([docs/outcomes.md](outcomes.md)), and a job delivered twice counts once.
- **Queued to done.** One job's wait plus its run, for the jobs where both are known.
- **Runner-suspected failures.** Each finished job is classed from its delivery alone: a job that
  failed with no failing step (`runner-lost-suspect`) or whose setup failed (`setup-failed`) is
  counted against the runner. It is a suspicion, not proof; [docs/outcomes.md](outcomes.md) lists
  every class.

## The window and the percentiles

- **Window.** The last 24 hours, rolling: an entry counts when its time is after now minus 24 h. The
  page and stats.json are rewritten every minute. `lastHour` uses the last 60 minutes and `hours`
  splits the 24 h into 24 one-hour buckets.
- **Percentiles.** Nearest rank: sort the values, and the p-th percentile is the value at position
  `ceil(p / 100 * n)`, counting from 1 (`percentile` in
  [runners/pitlane-waits.mjs](../runners/pitlane-waits.mjs)). The median is p50, the slow tail p90.
  No interpolation, so every published value is a real job's value.
- **Counts.** `jobs` counts the jobs that started in the window and `finished` (and `ran`) the jobs
  that finished in it, so the two differ by the jobs still running at either edge.

## What is left out

- Jobs that ran anywhere else, on GitHub-hosted runners or another self-hosted pool, are not in the
  numbers: only jobs one of these runners took. Membership is decided by name. Each row registers
  under its own name, so a job counts only when the runner GitHub names for it (`runner_name` in the
  webhook) is one of the rows in this host's manifest, pool and persistent rows included
  (`hostRowNames` and `ofHost` in [runners/pitlane-waits.mjs](../runners/pitlane-waits.mjs), applied
  by `hostNumbers` in [runners/pitlane-supervisor.mjs](../runners/pitlane-supervisor.mjs)). The
  self-hosted label alone is not enough: another self-hosted pool serving the same repositories
  carries it too.
- A job no runner took, such as one cancelled while it waited, has no runner name, so it is not
  counted either.
- Nothing published names a repository, a runner or a single job; the totals are all there is.

## Warm and cold

A *warm* row keeps an idle listener between jobs, so its next job starts in about 2 s. A *cold* row
registers first, about 15 s ([docs/pools.md](pools.md)). The median start reflects the warm rows; a
burst that needs cold rows, or more rows than are free, is what moves the p90. The hourly buckets show
which hours did.

## Checking it

`stats.json` holds the same numbers the page shows:

```
curl -s https://pitlane.askalf.org/stats.json
```

| Field | Meaning |
| --- | --- |
| `at` | when the numbers were written (UTC) |
| `window` | `24h` |
| `jobs` | jobs started in the window |
| `queueWaitMs.p50`, `.p90` | start, in milliseconds (whole seconds) |
| `targets.p50Ms`, `.p90Ms` | the start targets |
| `finished` | jobs finished in the window |
| `ran` | finished jobs with a run time |
| `runMs.p50`, `.p90` | run, in milliseconds |
| `feltMs.p50`, `.p90` | queued to done, in milliseconds |
| `runnerSuspect` | runner-suspected failures among the finished jobs |
| `lastHour` | `jobs`, `p50`, `p90` of the start over the last 60 minutes |
| `hours` | 24 buckets of `from`, `jobs`, `p50`, `p90` |

On your own host, the same numbers come from the files the supervisor reads: the job records under
`/run/askalf/pitlane` and the outcome files described in [docs/outcomes.md](outcomes.md).
