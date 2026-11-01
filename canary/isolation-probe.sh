#!/usr/bin/env bash
# isolation-probe.sh <report|enforce>: the PROBE half of the isolation canary (docs/isolation.md).
#
# Runs while the plant job sits on a different row. It tries, as an ordinary job, to see what the
# plant left: its environment variable, its marker file, its tool cache entry and its process.
# Nothing it prints contains a value: only the variable's NAME, paths and pids.
#   report   print every finding and exit 0 (the baseline run against today's setup)
#   enforce  exit 1 on any finding (the regression test once rows are isolated)
# A scan that cannot prove it works is not a pass: the positive control below must find its own
# marker, or the run exits 2 (inconclusive) in either mode.
set -uo pipefail

MODE="${1:-report}"
RUN="${PLANT_RUN_ID:?PLANT_RUN_ID}"
leaks=0
leak() { printf 'LEAK  %s\n' "$*"; leaks=$((leaks + 1)); }
ok() { printf 'ok    %s\n' "$*"; }

# Pids whose environment carries the plant's variable name. Unreadable processes are skipped: that
# is exactly the isolated outcome.
scan_environ() {
  local p
  for p in /proc/[0-9]*; do
    [ -r "$p/environ" ] || continue
    if tr '\0' '\n' <"$p/environ" 2>/dev/null | grep -q '^PITLANE_CANARY_SECRET='; then
      printf '%s\n' "${p#/proc/}"
    fi
  done
}

# Positive control: a process of our own that carries the name. If the scan cannot see it, the scan
# proves nothing about the plant.
PITLANE_CANARY_SECRET=control sleep 20 &
control=$!
sleep 1
if ! scan_environ | grep -qx "$control"; then
  echo "INCONCLUSIVE: the environ scan cannot see its own control process"
  kill "$control" 2>/dev/null
  exit 2
fi
ok "scanner sees its own control process"

# The rows, from the manifest this run checked out, so the probe opens each row's directory by name.
# Its own row must be on the list, or the list proves nothing.
manifest="${GITHUB_WORKSPACE:-.}/runners/runners.manifest"
own_row="${GITHUB_WORKSPACE%%/_work/*}"
mapfile -t row_dirs < <(awk '!/^[[:space:]]*#/ && NF >= 7 { print $5 }' "$manifest" 2>/dev/null)
if ! printf '%s\n' "${row_dirs[@]}" | grep -qxF -- "$own_row"; then
  echo "INCONCLUSIVE: this job's row $own_row is not in $manifest, so the row list is not the box's"
  kill "$control" 2>/dev/null
  exit 2
fi
ok "row list: ${#row_dirs[@]} rows from the manifest, this job's own among them"

# 1. Another job's environment (where a workflow's secrets live).
others=$(scan_environ | grep -vx "$control" || true)
if [ -n "$others" ]; then
  leak "environ: the plant's variable is readable in pid(s) $(echo "$others" | tr '\n' ' ')"
else
  ok "environ: no other job's environment is readable"
fi
kill "$control" 2>/dev/null

# 2. Other rows' workspaces: the plant's marker file, and any other row's _work directory.
found=""
for d in "${row_dirs[@]}"; do
  [ "$d" = "$own_row" ] && continue
  found=$(find "$d" -maxdepth 5 -name pitlane-canary-marker 2>/dev/null | head -1)
  [ -n "$found" ] && break
done
if [ -n "$found" ]; then
  leak "workspace: the plant's marker file is readable at $found"
else
  ok "workspace: the plant's marker file is not reachable"
fi
shopt -s nullglob
sib=0
for d in "${row_dirs[@]}"; do
  [ "$d" = "$own_row" ] && continue
  [ -r "$d/_work" ] && [ -x "$d/_work" ] && sib=$((sib + 1))
done
if [ "$sib" -gt 0 ]; then
  leak "workspace: $sib other row(s) have a readable _work directory"
else
  ok "workspace: no other row's _work directory is readable"
fi

# 3. The tool cache: an entry the plant wrote must not appear in this job's cache.
if [ -e "${RUNNER_TOOL_CACHE:?}/pitlane-canary-$RUN" ]; then
  leak "toolcache: the plant's entry is visible in this job's cache ($RUNNER_TOOL_CACHE)"
else
  ok "toolcache: the plant's entry is not in this job's cache"
fi

# 4. The plant's process: visible in /proc and signalable by this account.
pids=$(pgrep -f pitlane-canary-sleep || true)
if [ -n "$pids" ]; then
  leak "process: the plant's process is visible (pid $(echo "$pids" | head -1))"
else
  ok "process: the plant's process is not visible"
fi

# 5. Host material: key files, the container socket, the seat directory and other rows' tool caches.
# The probe tests readability and writability by name and never opens a key file. The files this
# row may read are listed in canary/expected-readable.txt (empty: pitlane's own rows run no fix lane
# and no review lane), or in the canary/ file EXPECTED_READABLE names (the Redline probe's own list).
want="${EXPECTED_READABLE:-expected-readable.txt}"
case "$want" in
  */*|.*) echo "INCONCLUSIVE: EXPECTED_READABLE=$want is not a file name in canary/"; exit 2 ;;
esac
expected="${GITHUB_WORKSPACE:-.}/canary/$want"
if [ ! -r "$expected" ]; then echo "INCONCLUSIVE: $expected is not readable, so every host file would pass or fail blind"; exit 2; fi
for f in /etc/askalf/*; do
  [ -f "$f" ] && [ -r "$f" ] || continue
  if ! grep -qxF -- "$f" "$expected" 2>/dev/null; then leak "hostfile: $f is readable by this job's account"; fi
done
for s in /var/run/docker.sock /run/docker.sock; do
  if [ -r "$s" ] || [ -w "$s" ]; then leak "hostfile: the container socket $s is reachable"; fi
done
for d in /root /var/lib/askalf-dario; do
  if [ -r "$d" ] && [ -x "$d" ]; then leak "hostfile: $d is listable by this job's account"; fi
done
shared=0
for d in /var/lib/gha/toolcache/*; do
  [ "$d" = "${RUNNER_TOOL_CACHE:-}" ] && continue
  [ -d "$d" ] && [ -w "$d" ] && shared=$((shared + 1))
done
if [ "$shared" -gt 0 ]; then leak "toolcache: $shared other row tool cache(s) are writable by this job's account"; else ok "toolcache: no other row's tool cache is writable"; fi
# 6. The job records and the public numbers (docs/showcase.md). A row's record is readable by that
# row's group only, in a directory no job can list. The public files carry 24 h totals across every
# repository, so a slash in one (a repository name or a path) is a finding.
pl=/run/askalf/pitlane
if [ -d "$pl/jobs" ]; then
  if ls "$pl/jobs" >/dev/null 2>&1; then leak "jobs: $pl/jobs is listable by this job's account"; else ok "jobs: the job records cannot be listed"; fi
  others=0
  for d in "${row_dirs[@]}"; do
    r=$(basename "$d")
    [ "$r" = "${RUNNER_NAME:-}" ] && continue
    [ -r "$pl/jobs/$r" ] && others=$((others + 1))
  done
  if [ "$others" -gt 0 ]; then leak "jobs: $others other row record(s) are readable by this job's account"; else ok "jobs: no other row's record is readable"; fi
fi
for f in "$pl"/public/*; do
  [ -f "$f" ] || continue
  if grep -q / "$f"; then leak "public: $f holds a slash (a repository name or a path)"; else ok "public: $(basename "$f") holds no repository name"; fi
done
# 7. The box's own state (docs/isolation.md, Host state files): the park and held marks, the
# dispatcher's and the supervisor's files, the waits and the outcomes all name repositories and rows.
# None of these directories may be listed and none of these files read. Today's outcomes file is the one
# the probe can name. /srv/gha is not here: the runner must list it before each job (docs/isolation.md).
for d in "$pl" "$pl/held" /run/askalf/gha-ondemand /var/lib/askalf/pitlane; do
  [ -d "$d" ] || continue
  if ls "$d" >/dev/null 2>&1; then leak "state: $d is listable by this job's account"; else ok "state: $d cannot be listed"; fi
done
readable=""
for f in "$pl"/status.json "$pl"/metrics.prom "$pl"/dispatcher.json "$pl"/dispatcher.beat "$pl"/waits.jsonl "$pl"/waits.jsonl.1 \
  "/var/lib/askalf/pitlane/outcomes-$(date -u +%Y-%m-%d).jsonl"; do
  [ -f "$f" ] && [ -r "$f" ] && readable="$readable $f"
done
if [ -n "$readable" ]; then leak "state: readable by this job's account:$readable"; else ok "state: no dispatcher, supervisor, waits or outcomes file is readable"; fi

# Informational: loopback listeners any job can reach (the network is shared, docs/isolation.md).
# Read from /proc/net/tcp (state 0A on 127.0.0.1); nothing is connected to.
ports=""
while read -r _ local _ state _; do
  [ "$state" = 0A ] && [ "${local%%:*}" = 0100007F ] && ports="$ports $((16#${local##*:}))"
done < <(tail -n +2 /proc/net/tcp 2>/dev/null)
echo "info  loopback listeners reachable from a job:${ports:- none}"

printf '\n%s: %s finding(s)\n' "$MODE" "$leaks"
{
  echo "### Isolation canary ($MODE)"
  echo "$leaks finding(s). The plant ran on a different row from this probe."
} >>"${GITHUB_STEP_SUMMARY:-/dev/null}" 2>/dev/null || true
if [ "$MODE" = enforce ] && [ "$leaks" -gt 0 ]; then exit 1; fi
exit 0
