# Contributing to pitlane

Thanks for your interest in improving **pitlane**, a self-hosted GitHub Actions runner stack built for
start latency: ephemeral rows, scale to zero, isolation per row.

## Ground rules

- Be respectful. This project follows our [Code of Conduct](CODE_OF_CONDUCT.md).
- Found a security issue? **Do not open a public issue**: follow [SECURITY.md](SECURITY.md) to report
  it privately.

## Development setup

pitlane is bash and plain Node.js modules with no dependencies to install. You need Node.js **22** (the
version CI uses) and bash.

```bash
git clone https://github.com/askalf/pitlane.git
cd pitlane
node --test runners/*.test.mjs canary/*.test.mjs box-ci/*.test.mjs
for f in runners/*.sh canary/*.sh box-ci/*.sh; do bash -n "$f" || exit 1; done
node runners/runner-config.mjs   # the example config is consistent
```

The tests run the shell scripts against stub commands on `PATH` (`gh`, `systemctl`, `logger` and so
on): no network, no root, no runner. A few tests read `/proc` and skip on systems without it.

## Making a change

1. Branch off `main`.
2. Keep the change focused: one concern per pull request.
3. Add or update tests for any behavior change. Changes to the build guard, the isolation of a row,
   the mint step or the dispatcher's start and park decisions must be covered by tests.
4. A new config file format or field goes into `runners/runner-config.mjs` and `runners/examples/`.
5. Run the tests and the parse check above before pushing.
6. Open a pull request against `main`.

## What CI requires

Every pull request must pass these checks to merge:

- `test` (ubuntu-latest, Node **22**): the unit tests, the shell parse check and the example config check
- **CodeQL** static analysis

OpenSSF Scorecard also runs on the repository.

CI runs on GitHub-hosted runners only: a pull request from a fork never reaches a self-hosted row.

## Conventions

- GitHub Actions are **pinned to a commit SHA**, never a mutable tag. New or updated workflow steps
  must keep this.
- A comment states the constraint the code keeps, not the history of how it got there.
- Commit messages: a short imperative subject, with a wrapped body explaining the *why* when it isn't
  obvious.
- Pull requests are squash-merged, so the title becomes the commit subject on `main`.
