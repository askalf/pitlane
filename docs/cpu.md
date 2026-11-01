# CPU shape per row

Two layers put work on the host at once. Across jobs, one push starts several self-hosted jobs side by
side (dario's `ci.yml` runs five at once), plus the review and status workflows. Inside a job, test
runners, `tsc`, `esbuild` and `make` each start workers sized from the CPU count they can see. This page is
about the second layer; `docs/pools.md` covers the first.

## What a job sees

Node sizes `node --test` (7 workers on 8 CPUs) from `os.availableParallelism()`. That call follows the
process's CPU affinity and ignores the slice's `CPUQuota=`, which sits on a parent cgroup. So on a host
with more CPUs than the slice's quota, every job starts a worker pool for the whole host while many jobs
share the slice. Measured on an 8-CPU machine with a 391-test suite, `node --test --test-concurrency=N`:

| workers | wall time |
|---|---|
| 1 | 11.4 s |
| 2 | 6.2 s |
| 4 | 4.9 s |
| 7 | 4.6 s |

Total CPU work is about the same at every setting; more workers only compress it into fewer seconds.
Four workers finish within 0.3 s of seven and take fewer than two thirds of the CPUs.

## The option file

`runners.cpu` lists rows and their options (see the file header). `gha-runners-apply.sh` writes
`30-cpu.conf` into each listed row's unit drop-in directory:

```
[Service]
CPUAffinity=2 3 4 5
CPUWeight=200
```

- `cpus=N` pins the row to N CPUs. Every child of the runner inherits it, so one setting caps every tool
  that asks how many CPUs there are, with no change to any repository. Windows rotate by the row's
  position among the `cpus=` lines (`row i` gets CPUs `i .. i+N-1`, wrapping), so a repository's rows
  spread across the host.
- `weight=W` sets `CPUWeight=`. It only matters while the slice is contended: a row with a higher weight
  gets a proportionally larger share of the slice's CPU.
- A row not listed has no drop-in. Taking a row off the list and running `apply` removes it and restarts
  the row when it is idle.
- A value outside its range holds the row (not enabled, nothing written), as for the isolation options.

## What it does not cover

- Containers a job starts with docker run in the CPUs of dockerd, not the row's. The gha slices
  have no docker socket, so no first-party row does this.
- A job that pins its own worker count (`--test-concurrency`, `--maxWorkers`) already ignores it.
- Affinity is a ceiling, not a reservation: a lone job cannot use CPUs outside its window even when the
  host is idle. Choose N so that costs little (the table above) and revisit it per repository.

## Rollout and measurement

Every exec-tier row (first-party, fix and OSS rows, all in `gha-exec.slice`) is listed at `cpus=4`.
Rows are sorted by name, so a repository's rows sit together and its windows spread across the host.
Adding a row at the end of a group moves no other row's window.

Without a CPU shape, the same job takes several times longer when many more exec jobs than CPUs run at
once. The CPU shape trims each job's worker pool; the exec cap (`EXEC_CAP`, docs/pools.md) limits how
many jobs share the slice. Read job duration (`pitlane-outcomes`) against both. Change one setting at a
time: turn `weight=` on in a later change, after the affinity result is read.

A row can be wider. A repository whose CI runs many lanes side by side (a test lane per package, for
example) can saturate a 4-CPU window, so its row is listed at `cpus=7`: one such job can use the whole
exec slice when the host is quiet, and when it is not the slice's quota still bounds it. Keep the row's
line where it was, so no other row's window moves. A job of that repository that lands on a pool row
still runs on 4 CPUs.
