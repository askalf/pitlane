#!/usr/bin/env bash
# The job-started hook of the root rows (ACTIONS_RUNNER_HOOK_JOB_STARTED, exported by
# gha-ephemeral-run.sh only on a row that runs as root).
# Their jobs run as root on the host, so a job runs there only when runners.build-allow lists its
# repository, branch and workflow file (docs/ops-tier.md, Build guard).
#
# The runner starts this hook with its own environment and the job's GITHUB_* values from GitHub; the
# workflow's env: never reaches it, so a job cannot name another branch or workflow here.
# The runner runs the hook as a step with condition always(): a failed hook fails the job, and the
# job's `if: always()` steps still run. So a refused job is stopped here, by SIGKILL to the job's
# Runner.Worker once the reason is on the run page. SIGTERM would let the worker cancel the job, and a
# cancel runs always() steps too.
# The bootstrap deploy runs without the list: PITLANE_BUILD_BOOTSTRAP, `<owner/repo> <branch> <file>`
# from the build rows' environment file, names the host deploy that installs this list, so it can run
# before the list exists or when it is wrong. Unset, or of any other shape, it names no job, and every
# job needs its line on the list.
set +e
LC_ALL=C

allow="${PITLANE_BUILD_ALLOW:-/etc/askalf/runners.build-allow}"
bootstrap="${PITLANE_BUILD_BOOTSTRAP:-}"
shape='^[A-Za-z0-9-]+/[A-Za-z0-9._-]+ [A-Za-z0-9._/-]+ [A-Za-z0-9._-]+\.ya?ml$'
[[ "$bootstrap" =~ $shape ]] || bootstrap=''
worker="${PITLANE_RUNNER_WORKER:-Runner.Worker}"
row="${RUNNER_NAME:-}"
[[ "$row" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || row='?'

# A value is printed only once it has matched its shape, so no line of this output is a workflow
# command a job wrote. dario's run pages are public, so the output names no file, path or account of
# the host.
stop() {
  printf '::error title=pitlane build guard::%s\n' "$1"
  echo "This runner runs only the workflows on its list, each on the branch the list names: any other job stops here, before its first step."
  logger -t pitlane-build-guard -- "$row: refused: $1" 2>/dev/null
  # The worker sends the step's log and annotations to GitHub about every half second.
  sleep 5
  local pid=$PPID n=0 k v name ppid line unit=
  while (( n++ < 8 )) && [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 )) && [ -r "/proc/$pid/status" ]; do
    name='' ppid=''
    while IFS=$'\t' read -r k v; do
      case "$k" in Name:) name="$v" ;; PPid:) ppid="$v" ;; esac
    done <"/proc/$pid/status"
    if [ "$name" = "$worker" ]; then kill -KILL "$pid" 2>/dev/null && exit 1; break; fi
    pid="$ppid"
  done
  # No worker among this hook's parents: kill the row's unit, listener and all. GitHub then fails the
  # job as a lost runner, and Restart=always brings the row's next cycle up.
  { while IFS= read -r line; do
      case "$line" in 0::/*) unit="${line##*/}" ;; esac
    done <"${PITLANE_CGROUP:-/proc/self/cgroup}"; } 2>/dev/null
  [[ "$unit" =~ ^gha-ephemeral-build@[A-Za-z0-9._-]+\.service$ ]] && systemctl kill --signal=SIGKILL -- "$unit" 2>/dev/null
  exit 1
}

event="${GITHUB_EVENT_NAME:-}"
repo="${GITHUB_REPOSITORY:-}"
ref="${GITHUB_REF:-}"
wref="${GITHUB_WORKFLOW_REF:-}"

[[ "$event" =~ ^[a-z_]+$ ]] || stop "GITHUB_EVENT_NAME is not an event name"
case "$event" in
  push | schedule | workflow_dispatch) ;;
  *) stop "a $event job never runs on this runner: only push, schedule and workflow_dispatch jobs do" ;;
esac
[[ "$repo" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || stop "GITHUB_REPOSITORY is not a repository name"
[[ "$ref" =~ ^refs/heads/([A-Za-z0-9._/-]+)$ ]] || stop "GITHUB_REF is not a branch"
branch="${BASH_REMATCH[1]}"
# GITHUB_WORKFLOW_REF is <owner/repo>/.github/workflows/<file>@<ref>, the file the job came from.
[[ "$wref" == "$repo/.github/workflows/"*"@$ref" ]] || stop "GITHUB_WORKFLOW_REF is not a workflow of $repo on $branch"
file="${wref#"$repo/.github/workflows/"}"
file="${file%"@$ref"}"
[[ "$file" =~ ^[A-Za-z0-9._-]+\.ya?ml$ ]] || stop "GITHUB_WORKFLOW_REF does not name a workflow file of $repo"
job="$repo $file on $branch ($event)"

if [ -n "$bootstrap" ] && [ "$repo $branch $file" = "$bootstrap" ]; then
  echo "pitlane build guard: $job runs without the list: it is the deploy that installs it"
  logger -t pitlane-build-guard -- "$row: ran: $job" 2>/dev/null
  exit 0
fi

# A line is `<owner/repo> <branch> <file>`; # starts a comment. A line with a CR or a fourth field
# matches no job, so a damaged list refuses jobs, never lets one through.
listed='' missing=''
if [ -f "$allow" ] && [ ! -L "$allow" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    [[ "$line" =~ ^[[:blank:]]*([^[:space:]]+)[[:blank:]]+([^[:space:]]+)[[:blank:]]+([^[:space:]]+)[[:blank:]]*$ ]] || continue
    if [ "${BASH_REMATCH[1]} ${BASH_REMATCH[2]} ${BASH_REMATCH[3]}" = "$repo $branch $file" ]; then listed=1; break; fi
  done <"$allow"
else
  missing=" (the list is missing or not a plain file, so no job runs)"
  [ -z "$bootstrap" ] || missing=" (the list is missing or not a plain file, so only the bootstrap deploy runs)"
fi
[ -n "$listed" ] || stop "$repo $file on $branch is not on this runner's list$missing"
echo "pitlane build guard: $job is on this runner's list"
logger -t pitlane-build-guard -- "$row: ran: $job" 2>/dev/null
exit 0
