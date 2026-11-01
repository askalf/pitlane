#!/usr/bin/env bash
# The job-completed hook of every pitlane runner (ACTIONS_RUNNER_HOOK_JOB_COMPLETED, exported by
# gha-ephemeral-run.sh). It adds one line to the job's run page: how long this job waited for a
# runner, and the queue wait of every job over the last 24 hours. docs/showcase.md has the numbers.
#
# The runner fails the job when its hook fails, so this hook always exits 0 and prints nothing: a
# missing, foreign or stale file drops a sentence from the line, never the job.
set +e
trap 'exit 0' EXIT

out="${GITHUB_STEP_SUMMARY:-}"
[ -n "$out" ] || exit 0
dir="${PITLANE_DIR:-/run/askalf/pitlane}"

# The dispatcher writes jobs/<row> when the row's job starts (writeJobRecord in pitlane-waits.mjs):
# "<run id> <attempt> <wait ms> <wait as text>". A record for another run or attempt is the row's
# previous job, so it is not this job's wait.
line='⚡ Ran on **pitlane**'
name="${RUNNER_NAME:-}"
if [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] && [ -f "$dir/jobs/$name" ] && [ ! -L "$dir/jobs/$name" ]; then
  read -r rid att _ wait <"$dir/jobs/$name"
  if [ -n "$rid" ] && [ "$rid" = "${GITHUB_RUN_ID:-}" ] && [ "$att" = "${GITHUB_RUN_ATTEMPT:-}" ] && [ -n "$wait" ]; then
    line="$line: picked up $wait after it queued"
  fi
fi
line="$line."

# The supervisor rewrites summary.txt every tick; one older than 10 minutes is a stopped supervisor's.
sum="$dir/public/summary.txt"
now=$(date +%s 2>/dev/null)
mt=$(stat -c %Y "$sum" 2>/dev/null)
if [ -f "$sum" ] && [ ! -L "$sum" ] && [[ "$now" =~ ^[0-9]+$ && "$mt" =~ ^[0-9]+$ ]] && (( now - mt < 600 )); then
  read -r agg <"$sum"
  [ -n "$agg" ] && line="$line Queued to running over the last 24 h: $agg."
fi

{ printf '%s\n' "$line" >>"$out"; } 2>/dev/null
