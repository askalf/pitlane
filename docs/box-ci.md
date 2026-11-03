# box-ci

The second way a job runs on the host. The runner rows take jobs from GitHub's Actions scheduler;
box-ci takes them from the repository itself. It polls a repository's open pull requests and its
default branch, runs the listed workflow files on the host with [act](https://github.com/nektos/act)
at the commit it found, and posts each job as a commit status (`box/unit`, `box/e2e`, and `box/ci`
for the run as a whole). Nothing in it waits on GitHub's scheduler, so a repository whose hosted
minutes are off, or whose e2e needs a browser on the host, still gets a verdict on every commit.

It lives in this repository because it runs as the same account (`gha-exec`), in the same slice
(`gha-exec.slice`) and under the same CPU decisions as the runner rows, so every piece of CI that
runs on the host is described in one place. The host deploy ships it the way it ships `runners/`.

## Files

| File | On the host | Role |
| --- | --- | --- |
| `box-ci/box-ci.mjs` | `/opt/askalf/box-ci.mjs` | the service: poll, plan, run act in a transient scope as the run account, post statuses |
| `box-ci/box-ci.service` | `/etc/systemd/system/box-ci.service` | root unit, `gha-exec.slice`; deployed, not self-enabled |
| `box-ci/box-ci.example.json` | (the host's admin writes `/etc/askalf/box-ci.json` from it) | the enrolled repositories, concurrency, timeouts |
| `box-ci/install-tools.sh` | run on the host as root | installs act and the Chromium playwright-core drives, both pinned by version and sha256 |
| `box-ci/box-ci.test.mjs` | | the unit test, in `node --test` with the rest |

The admin-only files, never in a repository: `/etc/askalf/box-ci.json` (root 600) and
`/etc/askalf/box-ci.token` (root 600, a fine-grained token with contents read and commit statuses
write on the enrolled repositories).

## What the host carries

act and the browsers live under `/opt/box-ci/`. They are not in the host-scripts manifest (binaries,
not files from a repository), so `install-tools.sh` is their manifest: `check` says whether what is
installed matches the pins, `apply` installs what does not. The pins are at the top of the script.
`PW_VERSION` is coupled to the enrolled repository's e2e workflow, which exports the same version for
its `playwright-core`: move them together.

## Running it

- Enrol a repository: add it to `/etc/askalf/box-ci.json` (shape in the example), `systemctl
  restart box-ci`. The repository's listed workflow files must gate on `github.actor ==
  'nektos/act'`, or GitHub's hosted runners run them too.
- Concurrency: `concurrency` in the config, 1 by default. Two e2e runs beside a review wave
  saturate the host and time out UI checks. A `serial` repository never runs two of its own jobs at
  once whatever the number.
- Logs: `journalctl -u box-ci`; per run, `/var/lib/box-ci/logs/<owner_repo>/<event>-<sha>.jsonl`.
- GitHub requests: conditional (ETag), so an unchanged poll costs nothing against the shared limit.
  When the limit is reached it logs the reset time and waits, without posting a status.

## Tests

`node --test box-ci/*.test.mjs` runs with the rest of the repository's tests; GitHub, git and act
are stubbed.
