#!/usr/bin/env bash
# gha-ephemeral-run.sh <name> — the USER half of an ephemeral org-pool runner cycle.
#
# Started by gha-ephemeral@<name>.service as the exec-tier user, after
# gha-ephemeral-mint.sh (root, ExecStartPre=+) has laid out the instance directory
# and left a single-use JIT config and a row file (.row: the instance directory and the
# labels, owned by this account) in it. This half only:
#   1. wipes the previous job's work dir and registration files (a new registration
#      must start clean);
#   2. reads the JIT config and unlinks it, so nothing usable is left for the job;
#   3. execs the runner with it. It takes exactly ONE job, then exits, and systemd's
#      Restart=always brings the next cycle up.
#
# The org token never reaches this account. The JIT config is single-use and expires
# quickly. The runner only accepts it as an argument (`run.sh --jitconfig`), so for
# the seconds until the listener has consumed it, it is visible in that process's
# argv. That is the runner's interface, not ours; it is documented here so the
# host's argv audits are not extended to this process by mistake.
# It never reads /etc/askalf/gha-runners.manifest: that file is root-only, so no job account can
# list the fleet's rows. The row file comes from the mint step, and a missing one stops the cycle.
set -euo pipefail

NAME="${1:?runner name}"
POOL_ROOT="${GHA_POOL_ROOT:-/srv/gha}"

log() { printf 'gha-ephemeral[%s]: %s\n' "$NAME" "$*"; }
fail() { log "$*"; sleep 30; exit 1; }

# The path is fixed by name, not taken from the file: the unit's WorkingDirectory is the same path.
ROWFILE="$POOL_ROOT/$NAME/.row"
[ -f "$ROWFILE" ] && [ ! -L "$ROWFILE" ] && [ -r "$ROWFILE" ] || fail "no row file $ROWFILE (mint step did not run?)"
read -r dir labels _ <"$ROWFILE" || true
[ "$dir" = "$POOL_ROOT/$NAME" ] && [ -n "$labels" ] || fail "row file $ROWFILE is malformed"
cd "$dir" 2>/dev/null || fail "cannot enter $dir (mint step did not run?)"
[ -x bin/Runner.Listener ] && [ ! -L bin ] || fail "no runner laid out in $dir (mint step did not run?)"

# Only files this account owns are removed here; the runner copy is root's.
rm -rf _work .runner .credentials .credentials_rsaparams 2>/dev/null || true
rm -f .row

[ -r .jitconfig ] || fail "no .jitconfig in $dir (mint step did not run?)"
jit=$(cat .jitconfig)
rm -f .jitconfig
[ -n "$jit" ] || fail "empty .jitconfig"

# The runner runs its job-completed hook as the job's last step and fails the job if the hook fails;
# pitlane-job-summary.sh always exits 0. An absent or non-executable hook leaves the variable unset.
hook="${PITLANE_JOB_SUMMARY:-/opt/askalf/pitlane-job-summary.sh}"
if [ -x "$hook" ] && [ ! -L "$hook" ]; then export ACTIONS_RUNNER_HOOK_JOB_COMPLETED="$hook"; else unset ACTIONS_RUNNER_HOOK_JOB_COMPLETED; fi

# A root row's job runs as root on the host, so its runner first runs pitlane-build-guard.sh as the
# job-started hook, which stops the job unless runners.build-allow lists its workflow on that branch.
# A job account's row never gets it. With no guard on the host a root row's job runs unchecked, so
# the host-scripts deploy that installs the guard can always run.
guard="${PITLANE_BUILD_GUARD:-/opt/askalf/pitlane-build-guard.sh}"
if [ "$(id -u)" != 0 ]; then unset ACTIONS_RUNNER_HOOK_JOB_STARTED
elif [ -x "$guard" ] && [ ! -L "$guard" ]; then export ACTIONS_RUNNER_HOOK_JOB_STARTED="$guard"
else unset ACTIONS_RUNNER_HOOK_JOB_STARTED; log "no build guard at $guard: this root row runs its job unchecked"; fi

log "registered for one job (labels $labels)"
exec ./run.sh --jitconfig "$jit"
