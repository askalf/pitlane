# The smallest working set

One repository, one ephemeral exec row. The five files are in
[runners/examples/minimal/](../runners/examples/minimal/), and the checker reads them as one set:

```
node runners/runner-config.mjs runners/examples/minimal
```

## The row

`runners.manifest` holds one line:

```
app-exec-e1  repo:your-org/your-repo  exec  gha-exec  /srv/gha/app-exec-e1  self-hosted,Linux,X64,app-exec  ephemeral
```

- `app-exec-e1` is the runner's name on GitHub and the instance of its systemd unit.
- `repo:your-org/your-repo` registers it for that one repository.
- `exec` runs repository code; `gha-exec` picks the unit template for your own repositories.
- `ephemeral` takes one job, then registers again with a fresh just-in-time configuration.

`runners.cpu` pins it to 4 CPUs, and `runners.isolated` gives it its own account (`gx-app-exec-e1`)
and tool cache. `runners.retired` and `runners.build-allow` are empty: no retired rows, and no build
rows, so nothing runs as root.

## The workflow

A job picks the row by its labels:

```yaml
jobs:
  test:
    runs-on: [self-hosted, app-exec]
    steps:
      - uses: actions/checkout@<full commit sha> # pin it
      - run: npm test
```

Exec rows have no docker socket, so a job with `container:` or `services:` does not run there.

## Scale to zero

The dispatcher (`runners/gha-ondemand.mjs`) manages every ephemeral `repo:` and `pool:` row the
manifest names, whatever the owner, so this row needs nothing more: it stays stopped until a job asks
for `app-exec`, and parks again after `IDLE_MIN` minutes (10 by default) with nothing to take. The
dispatcher lists `your-org/your-repo`'s queued jobs with the runner App's token for `your-org`, or,
without the App, with `GITHUB_TOKEN` from the token file `GHA_TOKEN_ENV` names.

## Install it

Copy this directory to one of your own, put your repository in `runners.manifest`, and run
`sudo runners/install.sh install --config <that directory>`. The rest (GitHub access, the accounts,
the webhook) is printed when it finishes, and in the README's Install section.
