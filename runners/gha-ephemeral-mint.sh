#!/usr/bin/env bash
# gha-ephemeral-mint.sh <name> — the ROOT half of an ephemeral org-pool runner cycle.
#
# Runs from the unit's `ExecCondition=+` line, before the sandbox and the user switch, and does
# everything that must not be done by the account that executes repository code:
#   1. resets the instance directory: root-owned, sticky, group-writable, holding a root-owned
#      bin/ and externals/ of the pinned runner, laid out once per pin. A real directory, not
#      symlinks: the runner resolves its root from the real path of bin/, and a symlink into
#      /opt made it try to create _diag there (read-only) and abort. This
#      step lays a plain COPY, and only when the instance holds no runner of the pinned
#      version: it runs inside the unit's mount namespace, where ReadWritePaths= bind-mounts
#      the instance directory, and link(2) across two mounts of one filesystem is EXDEV (a hard
#      link made here fails every start and leaves the instance emptied).
#      `gha-runners-apply.sh layout` (run by bootstrap and upgrade, on the host) replaces the
#      copies with hard links to /opt/actions-runner/<ver> and marks .pinned "<ver> link"; a
#      layout of the pinned version is kept here whichever word it carries. Either way every
#      file is root's and the exec user cannot write it, and the sticky directory means it
#      cannot swap the runner for the next cycle either. EVERYTHING ELSE in the
#      directory is removed each cycle: the runner loads <root>/.env and <root>/.path on every
#      start, so a job that wrote NODE_OPTIONS or LD_PRELOAD there would ride into every later
#      job on this runner. Only the runner copy and .pinned survive.
#   2. removes a stale registration of the same name, only when step 3 is refused with "Already
#      exists" (HTTP 409). An ephemeral runner that exits before taking a job (crash, restart,
#      deploy) leaves its registration behind; one that took a job deregisters itself, so most
#      cycles have nothing to remove and make one API call, the mint. A busy registration is
#      waited on, then left alone.
#   3. mints one just-in-time config (the runner App's installation token for the row's owner,
#      else the token in /etc/askalf/gha-org.env or gha-repo.env, root:root 600; either is
#      exported into gh's environment, never argv) and delivers it into the instance directory
#      WITHOUT ever writing through a path a job controls: the file is created in a root-only
#      staging directory on the same filesystem, owned by the exec user, and moved in with
#      rename(2), which replaces whatever entry sits at .jitconfig (a planted symlink included)
#      and never follows it. Writing straight into the job-writable directory would follow a
#      symlink the previous job left at that name and chown its target to the job's account
#      (the directory is not world-writable, so protected_symlinks does not apply).
#   4. delivers the row's own fields (directory and labels) the same way, as .row, owned by the
#      exec user. The run step reads that file and never the manifest, so
#      /etc/askalf/gha-runners.manifest stays root-only (640 root:root) and a job account cannot
#      list the fleet's rows from it.
#   5. for a pool row (scope pool:<owner>, docs/pools.md), decides the repository first: the
#      dispatcher (gha-ondemand) writes one entry per job it routes to the pool, and this step
#      claims the oldest, registers for that job's repository with that job's labels, and goes on
#      as a repository row of it. With nothing to claim it lingers for the next entry, then parks
#      the unit itself (the functions below).
# The unit templates run this step as their ExecCondition=, so its exit decides the start: 1 to 254
# ends it with the unit inactive, not failed, and Restart= does not apply (a pool row with nothing
# queued, PARK_EXIT); 255, or a signal, fails the unit and Restart=always starts it again, so every
# failure here exits 255: fail() by name, anything else through the ERR trap (set -E carries it
# into functions and substitutions). A stop of its own unit from here leaves the unit failed on every
# park (killed by the stop's SIGINT, or exit 1 when the stop has not reached it after a wait), and
# the supervisor then starts it again.
set -Eeuo pipefail
trap 'exit 255' ERR
PARK_EXIT=75   # EX_TEMPFAIL: nothing to do now; the dispatcher starts this row for the next job

NAME="${1:?runner name}"
MANIFEST="${GHA_MANIFEST:-/etc/askalf/gha-runners.manifest}"
VERSION_FILE="${GHA_VERSION_FILE:-/etc/askalf/gha-runner-version}"
INSTALL_ROOT="${GHA_INSTALL_ROOT:-/opt/actions-runner}"
POOL_ROOT="${GHA_POOL_ROOT:-/srv/gha}"
STAGE="$POOL_ROOT/.mint"   # root-only, same filesystem as the instance dirs, so mv is rename(2)
export HOME=/root   # gh keeps its state under HOME; never inside the instance dir

log() { printf 'gha-ephemeral-mint[%s]: %s\n' "$NAME" "$*"; }
fail() { log "$*"; sleep 30; exit 255; }   # the unit fails and restarts; the sleep keeps a bad token from spinning
# How long to wait for GitHub to release a busy registration of this name (see step 2).
BUSY_WAIT_SECS="${BUSY_WAIT_SECS:-360}"

row=$(awk -v n="$NAME" '!/^[[:space:]]*(#|$)/ && $1==n && $7=="ephemeral" { print; exit }' "$MANIFEST")
[ -n "$row" ] || fail "no ephemeral row named $NAME in $MANIFEST"
read -r _ scope _ user dir labels _ <<<"$row"

# ── pool rows (scope pool:<owner>; docs/pools.md) ─────────────────────────
# The dispatcher writes one entry per job it routes to the pool into QUEUE, named by job id and
# holding "repo:<owner>/<name> <labels>". A pool row claims the oldest by renaming it to .<name>,
# its claim file, which the dispatcher reads to know which repository the row serves; rename(2)
# within one directory is atomic, so two rows cannot claim one entry (the loser's mv fails and it
# takes the next). With nothing to claim the row lingers POOL_LINGER_SECS for the next entry (a
# burst's jobs queue seconds apart) and then parks itself: it writes the park mark, which keeps
# the host's runner watchdog and the supervisor from starting it again, and exits PARK_EXIT, which under
# ExecCondition= leaves the unit inactive with no restart (the header). The entry's repository
# must be the pool owner's: the file is root's, written by the dispatcher from a verified delivery,
# and this is the check that says so.
QUEUE="${GHA_POOL_QUEUE:-/run/askalf/pitlane/pool-queue}"
PARK_DIR="${GHA_PARK_DIR:-/run/askalf/gha-ondemand}"
POOL_LINGER_SECS="${POOL_LINGER_SECS:-20}"
pool_claim_one() {  # sets target and labels from the oldest entry (GitHub's job ids increase); 1 when there is none
  local f t l
  for f in $(ls "$QUEUE" 2>/dev/null | grep -E '^[0-9]+$' | sort -n); do
    rm -f -- "$QUEUE/.$NAME"
    mv -n -- "$QUEUE/$f" "$QUEUE/.$NAME" 2>/dev/null || continue   # gone: another row took it
    [ -f "$QUEUE/.$NAME" ] || continue
    read -r t l _ < "$QUEUE/.$NAME" || true
    t="${t#repo:}"
    # owner/name as GitHub spells them; the name goes into an API path, so dots alone are refused too
    if ! [[ "$t" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$ ]] || [ "${t#*/}" = . ] || [ "${t#*/}" = .. ] || ! [[ "${l:-}" =~ ^[A-Za-z0-9._,-]+$ ]]; then
      log "pool: entry $f is malformed; dropped"; rm -f -- "$QUEUE/.$NAME"; continue
    fi
    case "$t" in "$owner"/*) ;; *) log "pool: entry $f names $t, not a repository of $owner; dropped"; rm -f -- "$QUEUE/.$NAME"; continue ;; esac
    target=$t; labels=$l
    log "pool: claimed job $f for $target (labels $labels)"
    return 0
  done
  return 1
}
pool_claim() {  # claim now, or within the linger; 1 when nothing came
  local waited=0
  until pool_claim_one; do
    [ "$waited" -lt "$POOL_LINGER_SECS" ] || return 1
    sleep 1; waited=$((waited + 1))
  done
}
pool_park() {  # nothing to claim: mark this unit parked and end this start; never returns
  local unit
  unit=$(systemctl list-units --all --plain --no-legend "gha-ephemeral-*@$NAME.service" 2>/dev/null | awk 'NR==1 { print $1 }' || true)
  log "pool: nothing queued for ${POOL_LINGER_SECS}s; parking ${unit:-$NAME (no unit of this name is listed: no park mark)}"
  if [ -n "${pool_prev:-}" ] && [ "$pool_prev_had_job" = 0 ]; then pool_release "$pool_prev"; fi
  rm -f -- "$QUEUE/.$NAME"
  # 700: a park mark names its row, and only root reads them (docs/isolation.md, Host state files).
  if [ -n "$unit" ]; then mkdir -p -m 700 "$PARK_DIR"; date -u +%Y-%m-%dT%H:%M:%SZ > "$PARK_DIR/$unit"; fi
  # No stop: under ExecCondition= this exit ends the unit, inactive and not restarted. A stop from
  # here kills this step with the stop's SIGINT and leaves the unit failed.
  exit "$PARK_EXIT"
}
pool_release() {  # delete this row's registration left in <repo> by a cycle that took no job there
  local prev=$1 app tok reg
  # The same token the mint uses, narrowed to that repository; in gh's environment, never argv.
  app="${GHA_APP_TOKEN:-/opt/askalf/gha-app-token.sh}"; tok=""
  if [ -x "$app" ]; then tok=$("$app" "${prev%%/*}" "${prev#*/}" administration=write 2>/dev/null) || tok=""; fi
  [ -n "$tok" ] || tok=$(grep -m1 "^$token_key=" "$ENV_FILE" | cut -d= -f2- | tr -d '"' || true)
  [ -n "$tok" ] || { log "pool: no token for $prev; the registration left there waits for the supervisor"; return 0; }
  reg=$(GH_TOKEN="$tok" gh api "repos/$prev/actions/runners" --paginate -q ".runners[] | select(.name==\"$NAME\" and .busy==false) | .id" 2>/dev/null | head -1 || true)
  [ -n "$reg" ] || return 0
  if GH_TOKEN="$tok" gh api -X DELETE "repos/$prev/actions/runners/$reg" >/dev/null 2>&1; then
    log "pool: removed the registration left in $prev (id $reg)"
  else
    log "pool: could not remove the registration left in $prev (id $reg); the supervisor will"
  fi
}

# Scope decides the API prefix and the token file. An org pool registers through the org with
# a token holding "Self-hosted runners: write" on the org; a User account's repositories have
# no org pool, so each registers through its repo with a token holding "Administration: read
# and write" on those repositories. Both files are root:root 600, read only here. A pool row
# becomes a repository row of the job it claims.
kind="${scope%%:*}"; target="${scope#*:}"
scope_word=$kind
case "$kind" in
  org)  api="orgs/$target"; ENV_FILE="${GHA_ORG_ENV:-/etc/askalf/gha-org.env}"; token_key=GH_ORG_RUNNER_TOKEN ;;
  repo) api="repos/$target"; ENV_FILE="${GHA_REPO_ENV:-/etc/askalf/gha-repo.env}"; token_key=GH_REPO_RUNNER_TOKEN ;;
  pool)
    owner=$target
    ENV_FILE="${GHA_REPO_ENV:-/etc/askalf/gha-repo.env}"; token_key=GH_REPO_RUNNER_TOKEN
    # The repository this row served last, and whether a job ran there (its _work directory is the
    # sign; step 1 removes it below): a cycle that ran a job deregistered itself, one that did not
    # left its registration, released when this cycle parks or serves another repository (the same
    # repository gets the 409 path of step 2).
    pool_prev=$(sed -n 's/^repo:\([^ ]*\).*/\1/p' "$QUEUE/.$NAME" 2>/dev/null | head -1 || true)
    pool_prev_had_job=0; [ ! -d "$dir/_work" ] || pool_prev_had_job=1
    pool_claim || pool_park
    kind=repo; api="repos/$target" ;;
  *) fail "row $NAME has scope $scope; expected org:<org>, repo:<owner>/<repo> or pool:<owner>" ;;
esac
# A row on its own account (gha-runners-apply.sh, docs/isolation.md) carries that account in the
# unit's environment; the directory, the JIT config and the tool cache go to it, not to the tier's.
tier_user=$user   # the manifest's account, which decides the runner group below
user="${GHA_ROW_ACCOUNT:-$user}"
case "$dir" in "$POOL_ROOT"/*) ;; *) fail "instance dir $dir is not under $POOL_ROOT" ;; esac
# The run step finds .row by name, at $POOL_ROOT/<name>, which is the unit's WorkingDirectory.
[ "$dir" = "$POOL_ROOT/$NAME" ] || fail "instance dir $dir is not $POOL_ROOT/$NAME"
id "$user" >/dev/null 2>&1 || fail "user $user does not exist (run gha-runners-apply.sh bootstrap)"
ver=$(awk '!/^[[:space:]]*(#|$)/ { print $1; exit }' "$VERSION_FILE")
[ -x "$INSTALL_ROOT/$ver/bin/Runner.Listener" ] || fail "pinned runner $ver not installed (run gha-runners-apply.sh bootstrap)"

# The previous job's runner timing, kept before the reset below removes _diag with everything else.
# The runner's worker log is the only record of where a job's time went between its last step and
# the moment the runner reported it done: that wait is a median 5 s here against 2 s on GitHub-hosted
# runners, and up to 95 s, and the row holds its slot for all of it (docs/run-time.md). What is kept
# is a digest: the last PITLANE_TIMING_LINES timestamped lines of the newest Worker_*.log, each cut
# to 240 bytes, read from at most PITLANE_TIMING_BYTES of its tail, into PITLANE_TIMING_ROOT/<row>/
# (root-only, 700), the newest PITLANE_TIMING_KEEP per row. _diag is the job's to write, so only a
# regular file is read, never a symlink, and the digest is named here, not after the job's file. The
# previous cycle's processes are gone by now (the unit stopped, so systemd emptied its cgroup), so
# nothing writes the file while it is read. PITLANE_TIMING=off turns it off. It never stops a start:
# the call below runs it in a subshell with the ERR trap and errexit off.
keep_worker_timing() {
  [ "${PITLANE_TIMING:-on}" = on ] || return 0
  local diag="$dir/_diag" root="${PITLANE_TIMING_ROOT:-$POOL_ROOT/.timing}" keep="${PITLANE_TIMING_KEEP:-12}"
  local src out
  [ -d "$diag" ] && [ ! -L "$diag" ] || return 0
  src=$(find "$diag" -maxdepth 1 -type f -name 'Worker_*.log' -printf '%T@ %f\n' 2>/dev/null | sort -n | tail -n 1 | cut -d' ' -f2-)
  [ -n "$src" ] && [ -f "$diag/$src" ] && [ ! -L "$diag/$src" ] || return 0
  mkdir -p -- "$root/$NAME" || return 0
  [ ! -L "$root" ] && [ ! -L "$root/$NAME" ] || { log "timing: $root or its $NAME directory is a symlink; not kept"; return 0; }
  [ "$(id -u)" != 0 ] || chown root:root -- "$root" "$root/$NAME"
  chmod 700 -- "$root" "$root/$NAME"
  out="$root/$NAME/$(date -u +%Y%m%dT%H%M%SZ).log"
  tail -c "${PITLANE_TIMING_BYTES:-4194304}" -- "$diag/$src" 2>/dev/null \
    | grep -a -E '^\[[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}Z ' \
    | tail -n "${PITLANE_TIMING_LINES:-400}" | cut -c1-240 >"$out.part"
  if [ -s "$out.part" ]; then mv -f -- "$out.part" "$out"; else rm -f -- "$out.part"; return 0; fi
  ls -1 -- "$root/$NAME" | grep -E '^[0-9]{8}T[0-9]{6}Z\.log$' | sort -r | tail -n +"$((keep + 1))" \
    | while read -r old; do rm -f -- "$root/$NAME/$old"; done
}

# ── 1. instance directory ─────────────────────────────────────────────────
mkdir -p "$dir"
[ ! -L "$dir" ] || fail "$dir is a symlink; refusing"
chown "root:$user" "$dir"
chmod 1770 "$dir"
( trap - ERR; set +e; keep_worker_timing ) || true
# Reset: everything except the root-owned runner copy and its pin marker goes. `rm -rf` on a
# symlink removes the link, not what it points at, so a planted link is harmless here.
find "$dir" -mindepth 1 -maxdepth 1 \
  ! -name bin ! -name externals ! -name '*.sh' ! -name '*.template' ! -name .pinned \
  -exec rm -rf -- {} +
# run-helper.sh is the one *.sh that is not root's: run.sh writes it from the template as the row's
# account at every start. A copy left by another account cannot be replaced by this one in a sticky
# directory, and the runner would execute the stale file, so it goes every cycle.
rm -f -- "$dir/run-helper.sh"
# .pinned is "<version> <layout>": "copy" written here, "link" by gha-runners-apply.sh layout.
# Only the version decides whether to lay out again: this step cannot make the links (see the
# header), so replacing a link layout with a copy would undo the host-side one every cycle.
pinned_ver=$(awk '{ print $1; exit }' "$dir/.pinned" 2>/dev/null || true)   # no file: empty, not an exit under set -e
if [ "$pinned_ver" != "$ver" ] || [ ! -d "$dir/bin" ] || [ -L "$dir/bin" ] || [ -L "$dir/externals" ]; then
  rm -rf -- "$dir/bin" "$dir/externals" "$dir/.pinned"
  rm -f -- "$dir"/*.sh "$dir"/*.template
  # A real copy, owned by root so the exec user cannot alter what it runs. Not hard links: see
  # the header; `gha-runners-apply.sh layout` turns this copy into links from the host.
  cp -a "$INSTALL_ROOT/$ver/bin" "$dir/bin"
  cp -a "$INSTALL_ROOT/$ver/externals" "$dir/externals"
  for f in "$INSTALL_ROOT/$ver"/*.sh "$INSTALL_ROOT/$ver"/*.template; do
    case "$(basename "$f")" in run-helper.sh) continue ;; esac   # run.sh generates it per start, as the exec user
    cp -a "$f" "$dir/"
  done
  chown -R root:root "$dir/bin" "$dir/externals" "$dir"/*.sh "$dir"/*.template
  printf '%s copy\n' "$ver" > "$dir/.pinned"
  log "instance dir laid out from runner $ver (copy; gha-runners-apply.sh layout links it)"
fi
# The copy must still be root's: a job cannot chown, but this is the check that says so.
[ "$(stat -c %U "$dir/bin")" = root ] && [ ! -L "$dir/bin" ] || fail "$dir/bin is not a root-owned directory; refusing to run"

# ── token (read here, root only) ──────────────────────────────────────────
[ -r "$ENV_FILE" ] || fail "$ENV_FILE not readable"
# A missing key must fall through to the checks below, not kill the script: under `set -e` a
# grep that matches nothing fails the assignment, and the repo token file carries no
# GH_RUNNER_GROUP_ID (only an org registration has a group), so every repo-scope row died
# here without a word.
RUNNER_TOKEN=$(grep -m1 "^$token_key=" "$ENV_FILE" | cut -d= -f2- | tr -d '"' || true)
GH_RUNNER_GROUP_ID=$(grep -m1 '^GH_RUNNER_GROUP_ID=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' || true)
: "${GH_RUNNER_GROUP_ID:=1}"
# A row may name its own runner group, GH_RUNNER_GROUP_ID_<NAME> (upper case, `-` as `_`): a group
# GitHub limits to one repository and one workflow. The upstream write tier's rows (gha-oss-write)
# must: they hold the token that writes upstream, and the Default group admits any
# workflow of any repository it allows, so without their own group they are not registered at all.
row_group_key="GH_RUNNER_GROUP_ID_$(printf '%s' "$NAME" | tr 'a-z-' 'A-Z_')"
row_group=$(grep -m1 "^$row_group_key=" "$ENV_FILE" | cut -d= -f2- | tr -d '"' || true)
if [ -n "$row_group" ]; then
  [[ "$row_group" =~ ^[0-9]+$ ]] || fail "$row_group_key in $ENV_FILE is not a runner group id"
  GH_RUNNER_GROUP_ID=$row_group
elif [ "$tier_user" = gha-oss-write ]; then
  fail "$NAME is an upstream write row and $row_group_key is not set in $ENV_FILE; refusing the Default group"
fi
# The runner GitHub App's installation token for the target's owner, when the App is configured
# and installed there (gha-app-token.sh): its calls count against the App's installation, not the
# owner's own budget, which every other caller of that account shares. The token file stays the
# fallback, so a box without the App, or an App that cannot mint right now, mints as before.
# The token is narrowed to what this step does with it: runner administration on the one repository
# (or the org's self-hosted runners), not the App's Administration write on every repository.
APP_TOKEN_CMD="${GHA_APP_TOKEN:-/opt/askalf/gha-app-token.sh}"
token_source=$token_key
if [ -x "$APP_TOKEN_CMD" ]; then
  case "$kind" in
    repo) app_ask=("${target%%/*}" "${target#*/}" administration=write) ;;
    *)    app_ask=("$target" - organization_self_hosted_runners=write) ;;
  esac
  app_rc=0
  app_token=$("$APP_TOKEN_CMD" "${app_ask[@]}" 2>/dev/null) || app_rc=$?
  if [ "$app_rc" -eq 0 ] && [ -n "$app_token" ]; then
    RUNNER_TOKEN="$app_token"; token_source=app
  elif [ "$app_rc" -ne 3 ] && [ "$app_rc" -ne 4 ]; then
    # 3 is "App not configured" and 4 "not installed on this account" (the sprayberry-code rows land
    # here every cycle until that org's own App is on the box, and mint with GH_ORG_RUNNER_TOKEN);
    # anything else is an App that should have answered and did not.
    log "no App token for ${target%%/*} (gha-app-token.sh exit $app_rc); using $token_key"
  fi
  unset app_token
fi
if [ -z "$RUNNER_TOKEN" ]; then
  # Once the token line is retired (README, "The sprayberry-code rows and their own App"), an App
  # missing from the owner is the whole cause; say so rather than only that the file is empty.
  [ "${app_rc:-}" != 4 ] || fail "$token_key empty in $ENV_FILE and no runner App is installed on ${target%%/*} (gha-app-token.sh: the owner's own App, else the shared one); install one there or put the token back"
  fail "$token_key empty in $ENV_FILE and no App token for ${target%%/*}"
fi
export GH_TOKEN="$RUNNER_TOKEN"

# ── 2. stale registration of this name (only when the mint below reports one) ──
remove_stale() {
  stale=$(gh api "$api/actions/runners" --paginate -q ".runners[] | select(.name==\"$NAME\") | \"\(.id) \(.status) \(.busy)\"" 2>/dev/null | head -1 || true)
  if [ -n "$stale" ]; then
    read -r sid sstatus sbusy <<<"$stale"
    # A busy registration of this name while this unit is between jobs is GitHub's view lagging:
    # the runner process is gone (the instance directory is this unit's alone), and a job that was
    # cancelled or lost keeps the registration busy for about five minutes before GitHub releases
    # it (each failed start retries every 30 s until then).
    # Wait for the release instead of exiting 1: every failed exit here counts toward the
    # supervisor's crash-loop finding, and the unit's TimeoutStartSec covers the wait.
    waited=0
    while [ "$sbusy" = "true" ] && [ "$waited" -lt "$BUSY_WAIT_SECS" ]; do
      [ "$waited" -eq 0 ] && log "a runner named $NAME is registered and BUSY (id $sid); waiting up to ${BUSY_WAIT_SECS}s for GitHub to release it"
      sleep 15; waited=$((waited + 15))
      stale=$(gh api "$api/actions/runners" --paginate -q ".runners[] | select(.name==\"$NAME\") | \"\(.id) \(.status) \(.busy)\"" 2>/dev/null | head -1 || true)
      [ -n "$stale" ] || break
      read -r sid sstatus sbusy <<<"$stale"
    done
    if [ "$sbusy" = "true" ]; then
      fail "a runner named $NAME is still registered and BUSY (id $sid) after ${waited}s; refusing to replace it while it runs a job"
    fi
    [ "$waited" -gt 0 ] && log "registration $NAME released after ${waited}s"
  fi
  if [ -n "$stale" ]; then
    gh api -X DELETE "$api/actions/runners/$sid" >/dev/null 2>&1 \
      && log "removed stale registration $NAME (id $sid, was $sstatus)" \
      || fail "could not remove stale registration $NAME (id $sid)"
  fi
}

# ── 3. JIT config ─────────────────────────────────────────────────────────
label_args=()
IFS=, read -r -a label_list <<<"$labels"
for l in "${label_list[@]}"; do label_args+=(-f "labels[]=$l"); done
mint() {
  # Both endpoints require runner_group_id; for a repository it is the Default group, id 1
  # ("object is missing required key: runner_group_id").
  gh api -X POST "$api/actions/runners/generate-jitconfig" \
    -f "name=$NAME" -F "runner_group_id=$GH_RUNNER_GROUP_ID" -f "work_folder=_work" "${label_args[@]}" \
    -q .encoded_jit_config 2>&1
}
# Mint first, look for a stale registration only when GitHub refuses the name. An ephemeral runner
# that took a job deregisters itself, so most cycles have nothing to remove, and listing the
# registrations first spent a call on every cycle from the same token budget as every other caller
# (most of them would find nothing to remove). A name that is
# still registered gets HTTP 409 "Already exists"; that is the one case that lists, waits out a busy
# registration, removes it and mints again.
if ! jit=$(mint); then
  case "$jit" in
    *"Already exists"*|*"HTTP 409"*)
      log "the name $NAME is still registered; removing the stale registration and minting again"
      remove_stale
      jit=$(mint) || fail "JIT config request failed after removing the stale registration: ${jit:0:200}"
      ;;
    *) fail "JIT config request failed: ${jit:0:200}" ;;
  esac
fi
[ -n "$jit" ] || fail "empty JIT config"
# A pool row that served another repository last and took no job there left an offline registration
# behind (see the pool functions); one listing of that repository removes it. A repository switch
# after an empty cycle is the only time this costs a call.
if [ "${scope_word:-}" = pool ] && [ -n "${pool_prev:-}" ] && [ "$pool_prev" != "$target" ] && [ "$pool_prev_had_job" = 0 ]; then
  pool_release "$pool_prev"
fi
unset GH_TOKEN RUNNER_TOKEN

# Staging is root-only and never job-visible; the final step is a rename into the sticky dir.
mkdir -p "$STAGE"; chown root:root "$STAGE"; chmod 700 "$STAGE"
[ ! -L "$STAGE" ] || fail "$STAGE is a symlink; refusing"
# The row file goes in first: a .jitconfig in the directory implies a .row beside it.
rowtmp="$STAGE/$NAME.row"
rm -f -- "$rowtmp"
printf '%s %s\n' "$dir" "$labels" | install -m 400 -o "$user" -g "$user" /dev/stdin "$rowtmp"
mv -f -- "$rowtmp" "$dir/.row"
tmp="$STAGE/$NAME.jitconfig"
rm -f -- "$tmp"
printf '%s' "$jit" | install -m 600 -o "$user" -g "$user" /dev/stdin "$tmp"
mv -f -- "$tmp" "$dir/.jitconfig"
log "JIT config minted for $target ($scope_word, group $GH_RUNNER_GROUP_ID, labels $labels, token $token_source)"
