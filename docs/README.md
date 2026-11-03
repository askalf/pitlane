# pitlane docs

## Start here

- [example-minimal.md](example-minimal.md): the smallest working set, one repository and one row.
- [method.md](method.md): how every published number is measured, and how to check it.
- [isolation.md](isolation.md): what each row can and cannot see, and what is still shared.

## How it runs

- [pools.md](pools.md): shared pools of rows, caps, warm and cold rows, retiring a row.
- [cpu.md](cpu.md): pinning a row to a window of CPUs.
- [ops-tier.md](ops-tier.md): the build tier, root rows and the build guard.
- [supervisor.md](supervisor.md): the watcher for stuck jobs, drift and pressure, and what it heals.
- [outcomes.md](outcomes.md): the record of how every job ended, and the failure classes.
- [box-ci.md](box-ci.md): running a repository's workflows on the host with act.

## What it publishes

- [showcase.md](showcase.md): the public page, the badge, the run-page line and their headers.
- [run-time.md](run-time.md): the runner's wrap-up after a job's last step, and where that time goes.

The runner files themselves are described in [../runners/README.md](../runners/README.md).

## Glossary

| Word | Meaning |
| --- | --- |
| row | One runner registration in `runners.manifest`: a name, a scope, a tier, an account, a directory, labels and a mode. Each row is a systemd unit instance. |
| scope | What a row registers for: one repository (`repo:`), an organization (`org:`), or a shared pool (`pool:`). |
| tier | What a row may do: *read* reads code and posts reviews, *exec* runs repository code, *build* runs your own deploys as root. Each tier has its own systemd slice. |
| lane | A set of rows that share one purpose and one key file, such as the review rows or the rows that run code you did not write. Only a lane's rows can read its key. |
| pool | Rows that pick their repository at each start, from the job routed to them, so a burst in any repository draws on all of them. |
| ephemeral | A row's normal mode: one job per registration, then a fresh just-in-time registration. |
| adopt, managed | Persistent modes: an existing runner apply only places in its slice, or a persistent runner apply builds. They keep state between jobs. |
| warm | A row kept up between jobs with an idle listener, so its next job starts in about 2 s. |
| cold | A row that is stopped until a job needs it, and registers first (about 15 s). |
| park | Stopping an idle row so it costs nothing until the next job (scale to zero). |
| dispatcher | `gha-ondemand`: watches queued jobs, starts the row that covers one, parks idle rows. |
| supervisor | The watcher that records outcomes, writes the public numbers and heals what its allow list permits. |
| canary | A job that probes, from inside, what a row can read, and fails on anything it should not. |
| host's admin | Whoever runs the host: writes its config files, presses its deploys and lifts a hold by hand. |
