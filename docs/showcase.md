# Showcase

What pitlane shows outside the host: a line on every job's run page, a live badge any README can
carry, and the page the badge links to. pitlane is the lab where the [ci-wizard](https://github.com/askalf/ci-wizard)
method runs on our own runners first, so what it shows are measured receipts: the start (queue wait)
the targets in the README are about, and the run time beside it. None of it names a repository, a
row or a runner.

## The run-page line

Every pitlane row runs `runners/pitlane-job-summary.sh` as its job-completed hook, except a row whose
labels include one in `PITLANE_SUMMARY_SKIP_LABELS` (default `fleet-status`, see Cost below):
`gha-ephemeral-run.sh` exports `ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/opt/askalf/pitlane-job-summary.sh`
when that file is executable, and the runner runs it as the job's last step ("Complete runner"). It
appends one line to the job's step summary:

> ⚡ Ran on **pitlane**: picked up 2 s after it queued. Queued to running over the last 24 h: p50 2 s, p90 16 s across 1,240 jobs.

- **This job's wait.** The dispatcher's `workflow_job` `in_progress` delivery gives the job's queue wait
  (`started_at` minus `created_at`; GitHub gives both in whole seconds, so the line does too).
  `writeJobRecord` in `pitlane-waits.mjs` writes it to `/run/askalf/pitlane/jobs/<row>` as
  `<run id> <attempt> <wait ms> <wait as text>`: owned by root and the row's group, mode 0640, in a
  directory of mode 0711, so a job reads its own row's record and cannot list or read any other. The
  hook uses the record only when its run id and attempt are the job's own. A late or lost delivery
  leaves the clause out; the record left by the row's previous job is never shown as this one's.
- **The last 24 h.** `public/summary.txt`, which the supervisor rewrites every tick. One older than
  10 minutes is a stopped supervisor's, and the hook leaves it out.
- **Never fails the job.** The runner fails a job whose hook fails, so the hook always exits 0 and
  prints nothing. A missing, foreign or stale file drops a clause; with nothing to read the line is
  "⚡ Ran on **pitlane**."

Jobs on GitHub-hosted runners (fork and Dependabot pull requests) never reach a pitlane row and get no line.


**Cost.** The hook is a step of its own, and its log and the summary file are uploaded one after
another before the runner reports the job done, each a round trip to GitHub (`docs/run-time.md`).
On a fleet status job that is two of its five uploads, on the fleet's most frequent job, whose run
page nobody reads, so those rows run no hook. Set `PITLANE_SUMMARY_SKIP_LABELS` empty to give every
row the line again.

## The badge

Each tick the supervisor writes the 24 h numbers for every repository together to
`/run/askalf/pitlane/public` (`writePublic`): `stats.json`, `badge.json` and `summary.txt`.
`runners/pitlane-public.mjs` (unit `pitlane-public.service`) serves them on `127.0.0.1:7312`, and the
host's tunnel (cloudflared) publishes that as `https://pitlane.askalf.org`.

| Path | Answer |
| --- | --- |
| `/` | a page for people: the same numbers rendered, the verdict against the targets, the time they were written; its own HTML loads no script and makes no outside request; a notice once they are stale or before the first tick |
| `/stats.json` | the 24 h numbers as JSON, with `stale: true` once they are older than 15 minutes; 503 before the first tick |
| `/badge.json` | a shields.io endpoint badge; always a 200, grey "stats stale" when the numbers are stale or missing |
| anything else | 404; a method other than GET or HEAD is a 405 |

```json
{"at":"<ISO 8601 time>","window":"24h","jobs":1240,"queueWaitMs":{"p50":2049,"p90":16000},"targets":{"p50Ms":5000,"p90Ms":30000},"finished":1300,"runnerSuspect":0,
 "ran":1290,"runMs":{"p50":18200,"p90":74000},"feltMs":{"p50":28000,"p90":102000},
 "lastHour":{"jobs":62,"p50":2000,"p90":37000},"hours":[{"from":"<ISO 8601 time>","jobs":62,"p50":2000,"p90":37000}],"stale":false}
```

`finished` counts the jobs that finished in the window and `runnerSuspect` the ones the outcome record
(`docs/outcomes.md`) suspects the runner of. `runMs` is the run time of the `ran` jobs among them (a runner
started it, whatever its result), from a runner starting the job to GitHub recording it complete, so it
includes the runner's wrap-up after the last step; `feltMs` is one job's queue wait and run added
together, for the jobs with both, the time a developer waits from queued to done. The queue wait counts
the jobs that started in the window and the run time the jobs that finished in it. Every key a reader
had before keeps its name and shape. `lastHour` is the same median and p90 over the trailing hour (a
record may be stamped up to a minute ahead of now, the same clock-skew allowance the totals take), and
`hours` the window as 24 hour buckets, oldest first (`hourly`), the newest ending where the totals end: a
day's p90 is often one hour's burst, and the page draws the buckets as bars so a reader sees which hour,
and whether the tail is still here. In a README:

```md
[![CI measured](https://img.shields.io/endpoint?url=https%3A%2F%2Fpitlane.askalf.org%2Fbadge.json)](https://pitlane.askalf.org/)
```

The badge reads **CI measured** with two receipts, the median start and the median run over the day:
"start 2 s · run 18 s", or the start alone before any job has finished. Its colour reads the start
only, against its targets: the run time is the workload's, so it has none.

| Color | When |
| --- | --- |
| brightgreen | p50 under 5 s and p90 under 30 s: both targets met |
| green | p50 under 5 s |
| yellow | p50 under 15 s |
| orange | p50 15 s or more |
| lightgrey | no jobs in 24 h, or the numbers are stale |

The badge is fetched live and never committed: shields.io keeps it 300 s (`cacheSeconds`) and the
server's answers say `max-age=60`.

## The page

`/` is the proof page, the lab's receipts in sections: Start (queue wait median and p90 against their
targets, the jobs started, the last hour, and the day by hour), Run (run time and queued-to-done
median and p90), Stable (runner-suspected failures, and per 10,000 finished jobs), then how each is
measured, the method, and the badge snippet. A verdict pill from the badge's thresholds (both targets
met, median target met, behind target, well behind target, no jobs, stale) and the time the
supervisor wrote the numbers sit at the top. The wrap-up time after a job's last step is measured on
the host per job (`docs/run-time.md`) but lives in a root-only directory this service cannot read, so
the page does not break it out yet; the supervisor can publish a summary of it in a later change. It is built from the same allowlisted fields as
`/stats.json`, so a field the JSON does not publish cannot reach the page either, and every value from
the files is HTML-escaped. The page's own HTML carries no script and makes no request to anything: its
one style block is allowed by hash, and its favicon is an inline SVG, under `Content-Security-Policy:
default-src 'none'; style-src 'sha256-...'; img-src data:; base-uri 'none'; form-action 'none';
frame-ancestors 'none'`. The service sends `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and
no CORS header (the JSON keeps `access-control-allow-origin: *`). The head carries a canonical link and
Open Graph tags for link previews, the hourly bars have a table screen readers read in their place,
and the pill and notice colours meet a 4.5:1 contrast in both palettes (a test computes it).

**What the edge in front of it changes.** The public host sits behind Cloudflare, and two of its zone
settings change what a browser receives: its response rules currently send
`Referrer-Policy: same-origin` and `X-Frame-Options: SAMEORIGIN` in place of the service's stricter
values, and its JavaScript detections insert a script into the page, which the page's own policy then
blocks. Both are settings of the zone, not of this service: turn off JavaScript detections for the
host, and stop the header rule from overriding these two headers, to serve exactly what the service
sends.
It refreshes itself every 60 s with a `meta refresh`, matching `max-age=60`. Stale numbers get a
notice and the grey verdict; before the first tick the page still answers 200 and says so.

## What is public

The server answers with the fields it lists and nothing else, so a field the supervisor adds to its
files stays on the host until it is added to `pitlane-public.mjs` as well. The page is rendered from
those same fields. No answer carries a
repository, row or runner name or a number for one repository. The unit runs as a throwaway account
(`DynamicUser=yes`) that sees `/run/askalf/pitlane/public` and nothing else under `/run/askalf`,
accepts connections from loopback only and makes none, and holds no capabilities. It imports no
sibling module, so a deploy restarts it only when its own file changes.

The isolation canary checks this from inside a job (section 6, `docs/isolation.md`): the job records
cannot be listed, no other row's record is readable, and no public file holds a slash.

## Deploy

The host deploy ships `pitlane-job-summary.sh` and `pitlane-public.mjs` to
`/opt/askalf` and `pitlane-public.service` to `/etc/systemd/system`. Each row picks the hook up at its
next cycle; nothing restarts. The deploy does not enable a new unit, so `pitlane-public.service` is
enabled once by hand, and the tunnel needs a public hostname `pitlane.askalf.org` pointing at
`http://127.0.0.1:7312`.
