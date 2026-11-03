# Run time

Queue wait is how long a job waits for a runner. Run time is how long it takes once it has one, and the
time a developer feels is the two together. This page is about the part of run time that belongs to the
runner, not to the job's own steps.

## The tail after the last step

GitHub reports a job done when its runner says so, not when its last step ends. Measured over a sample of
recent jobs on this host and on GitHub-hosted runners, with the step timings the jobs API returns:

| Where a job's time goes | pitlane rows | GitHub-hosted |
| --- | --- | --- |
| The job's own steps | about 66% | about 86% |
| After the last step, before the runner reports done | about 27% (median 5 s) | about 13% (median 2 s) |
| Before the first step | about 7% (median 2 s) | about 2% (median 1 s) |

Dependency installs and toolchain setup were under 5% of job time together, so a local package cache is
not the lever here. The tail is: a row holds its slot until the runner reports, so every second of it is
also a second some queued job waits. Single jobs show tails over a minute. The runner's own log says the
same as the API (its "completed with result" line lands at the API's `completed_at`), so the time is spent
inside the runner, after the job's last step, not in GitHub's reporting. It does not follow load: the
median tail is the same in quiet hours and busy ones.

## Where the record comes from

The runner writes a worker log for each job under `_diag/` in its instance directory. The mint step
resets that directory at the start of every cycle (`runners/gha-ephemeral-mint.sh`, step 1), so the log
used to be gone before anyone could read it. `keep_worker_timing` now keeps a digest of it first:

- the newest `_diag/Worker_*.log` that is a regular file (a symlink the job left is never read);
- only its timestamped lines (`[YYYY-MM-DD HH:MM:SSZ LEVEL Component] ...`), the last 400, each cut to
  240 bytes, read from at most the last 4 MiB of the file;
- written to `/srv/gha/.timing/<row>/<UTC time>.log`, a root-only directory (0700) beside the mint step's
  staging directory, never inside a directory a job can write;
- the newest 12 per row kept, older ones removed.

The runner masks the job's secrets in its logs, and the digest only keeps lines it already wrote, cut
short. The directory is root's alone because the lines still name repositories, workflows and steps.

A failure while keeping it never stops the cycle: the call runs in a subshell with the mint step's ERR
trap and errexit off.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PITLANE_TIMING` | `on` | `off` keeps nothing |
| `PITLANE_TIMING_ROOT` | `/srv/gha/.timing` | where digests go |
| `PITLANE_TIMING_KEEP` | `12` | digests kept per row |
| `PITLANE_TIMING_LINES` | `400` | lines kept per digest |
| `PITLANE_TIMING_BYTES` | `4194304` | bytes read from the end of the log |

## Reading a digest

The longest silences in a digest are where the time went. This prints the five biggest gaps between
consecutive lines, with the line that ended each gap:

```sh
awk -F'[][]' '{ split($2, a, /[ :Z]/); t = a[2] * 3600 + a[3] * 60 + a[4];
  if (NR > 1 && t - p > 1) print t - p "s before: " substr($0, 1, 160); p = t }' \
  /srv/gha/.timing/<row>/<digest>.log | sort -rn | head -5
```

## What the digests showed

Over a few hundred digests from every row, the time between the last step and the runner reporting
the job done split like this:

| Phase | Share of the tail | Typical |
| --- | --- | --- |
| Uploading the step logs, summaries and job log to GitHub's results service | about 85% | median 4 s, p90 12 s |
| Reporting the job completed | about 13% | under 1 s, with rare stalls of 40 to 50 s |
| Checking for processes the job left behind | about 1% | 0 s |
| Cleaning the runner's temp folder | under 1% | 0 s |

The uploads go one after another, a typical job sends five or six files, and each costs about half a
second to a second from this host: a new connection to the results service takes about 90 ms to
connect and 190 ms to finish TLS, because the service sits far from the host. GitHub-hosted runners
sit next to it, which is most of why their tail is shorter. About one job in sixty also hits a request
the service does not answer, and the runner waits about 37 s before it retries.

So the levers are fewer uploaded files per job (fewer steps, and no hook step where nobody reads its
line, see `docs/showcase.md`) and a shorter path to the service. Clean-up is not one.
