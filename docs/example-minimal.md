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

## Before you rely on it

The scale-to-zero dispatcher (`runners/gha-ondemand.mjs`) currently manages only rows whose scope is
under the `askalf` owner. With another owner, start the row's unit yourself
(`systemctl start gha-ephemeral-first-party@app-exec-e1`): it then stays up, registering again after
each job, instead of scaling to zero. Making the owner a setting is the next change.

The rest of the install, the accounts, the App and the webhook, is in the README's Install section.
