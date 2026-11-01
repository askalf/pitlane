# Job outcomes

The target is no job lost to the runner. That needs a record of how every job ended, kept long enough to
read as weeks. This is that record.

## What is recorded

One line per finished self-hosted job, from the `workflow_job` `completed` delivery the dispatcher already
receives for the queue-wait record. It costs no GitHub requests. Lines go to
`/var/lib/askalf/pitlane/outcomes-YYYY-MM-DD.jsonl` (override with `PITLANE_STATE_DIR`), one file per UTC
day, files older than 45 days dropped. The queue-wait record in `/run` is gone at reboot; this one is not.
The lines name repositories and rows, so the directory is 0700 and each file 0600, root's alone
(`docs/isolation.md`, Host state files).

```json
{"id":123,"at":1792101000000,"repo":"askalf/dario","runner":"dario-exec-e1","conclusion":"failure","class":"job-failed","waitMs":2000,"runMs":61000}
```

A job delivered twice counts once (by `id`). A suspect line also carries `bad`: up to four non-success
step names with their conclusions, so the classes can be checked against real jobs.

## Classes

The class is read from the delivery alone. It is a suspicion, not proof.

| Class | Meaning |
| --- | --- |
| `success`, `skipped` | as reported |
| `cancelled-queued` | cancelled before any runner took it |
| `cancelled`, `timed-out` | the job's own cancellation or time limit |
| `job-failed` | a step of the job failed |
| `setup-failed` | the "Set up job" step failed, so the runner could not start the job; an action that will not download lands here too, so this is an upper bound |
| `runner-lost-suspect` | the job failed and no step reports a failure: the runner went away |
| `other` | any other conclusion |

`setup-failed` and `runner-lost-suspect` are the suspect classes. The number to watch is their share of
all jobs.

## Where it shows

The supervisor reads the files each tick and puts `outcomes` (last hour and last 24 hours: counts by
class, the suspect share by runner, run and wait percentiles) in `status.json`, and in `metrics.prom` as
`pitlane_jobs{window,class}`, `pitlane_runner_suspect_jobs{window}` and `pitlane_job_run_p50_ms` and
`_p90_ms`. A `runner-suspect` warning names the rows when any job in the last hour is suspect.

## Limits

- It sees jobs only while the dispatcher's webhook is up and the repository has the hook. A job whose
  delivery is lost is missing, not wrong. The GitHub-side count of runs is the check on that.
- A job that dies with the runner may never produce a `completed` delivery that reflects it. If a
  job-level class turns out to miss this, the supervisor's journal check (failed exits per unit) is the
  second source; the two are compared before a claim rests on either.
- The classes are refined from the `bad` lines of real suspect jobs. Until a few exist, treat the share
  as a list of jobs to read, not a rate to quote.
