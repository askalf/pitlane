#!/usr/bin/env bash
# gha-runners-apply.sh: reconcile the host's GitHub Actions runners against
# /etc/askalf/gha-runners.manifest (installed by the host deploy from runners.manifest).
#
#   plan                    print what apply would change; touches nothing (default)
#   apply [--restart-idle]  write the per-unit slice drop-ins and daemon-reload; with
#                           --restart-idle also restart changed units that have no job running
#   bootstrap               create the gha-oss account, /srv/gha, the tool cache, and install
#                           the pinned runner release under /opt/actions-runner/<version>
#   upgrade [--restart-idle] install the version now pinned in /etc/askalf/gha-runner-version,
#                           repoint /opt/actions-runner/current, lay the instances out, restart
#                           idle ephemeral units
#   layout                  lay every ephemeral instance's bin/ and externals/ out as hard links
#                           to the pinned install (bootstrap and upgrade run it too)
#   register <name>         configure a NEW `managed` row; reads the registration token on STDIN
#   status                  every row: unit state, busy, and GitHub-side status
#
# Runs as root. Never takes a token in argv. Never re-registers an `adopt` row: those
# runners predate this script and keep their own self-updating install; apply only
# puts them in their slice. The slice units themselves are deployed by
# the host deploy (docs/ops-tier.md), so apply checks they exist rather than
# writing them.
set -euo pipefail

MANIFEST="${GHA_MANIFEST:-/etc/askalf/gha-runners.manifest}"
VERSION_FILE="${GHA_VERSION_FILE:-/etc/askalf/gha-runner-version}"
INSTALL_ROOT="${GHA_INSTALL_ROOT:-/opt/actions-runner}"
POOL_ROOT="${GHA_POOL_ROOT:-/srv/gha}"
TOOLCACHE="${GHA_TOOLCACHE:-/var/lib/gha/toolcache}"
EXEC_USER="${GHA_EXEC_USER:-gha-oss}"
UNIT_DIR=/etc/systemd/system
DROPIN=10-gha-managed.conf
ISOLATED_FILE="${GHA_ISOLATED:-/etc/askalf/runners.isolated}"
ISO_DROPIN=20-isolated.conf
CPU_FILE="${GHA_CPU:-/etc/askalf/runners.cpu}"
CPU_DROPIN=30-cpu.conf
PARK_DIR="${GHA_PARK_DIR:-/run/askalf/gha-ondemand}"   # the dispatcher's park marks (gha-ondemand.mjs)

log() { printf '%s\n' "$*"; }
die() { printf 'gha-runners: %s\n' "$*" >&2; exit 1; }

# ── manifest ────────────────────────────────────────────────────────────────
# rows: one line per runner: name scope tier user dir labels mode
rows() {
  [ -r "$MANIFEST" ] || die "manifest not readable: $MANIFEST"
  awk '!/^[[:space:]]*(#|$)/ { if (NF != 7) { print "gha-runners: bad manifest row (" NF " fields): " $0 > "/dev/stderr"; exit 2 } print }' "$MANIFEST"
}

scope_kind() { printf '%s' "${1%%:*}"; }          # repo | org | pool
scope_target() { printf '%s' "${1#*:}"; }         # owner/repo | org | owner (a pool: docs/pools.md)

# token_sees <scope> <env file>: can the token the mint step will use list the scope's runners?
# 0 yes, 1 no (the token cannot see it), 2 could not tell (network, rate limit). A repository the
# token does not cover makes the row's unit fail at start with "could not remove stale
# registration", so apply holds the row instead. The mint step asks the runner App first
# (gha-ephemeral-mint.sh, the same narrow ask) and falls back to the token file, so this check does
# too: a repository the App is installed on is seen even when the file's token does not list it.
# Exit 3 (App not configured) and 4 (not installed on the owner) fall back to the file. The token
# reaches gh in its environment, never in an argument. One answer per scope per run.
declare -A TOKEN_SEES=()
token_sees() {
  local scope=$1 envf=$2 kind target api key tok out
  [ -z "${TOKEN_SEES[$scope]:-}" ] || return "${TOKEN_SEES[$scope]}"
  kind=$(scope_kind "$scope"); target=$(scope_target "$scope")
  case "$kind" in
    repo) api="repos/$target"; key=GH_REPO_RUNNER_TOKEN ;;
    org)  api="orgs/$target"; key=GH_ORG_RUNNER_TOKEN ;;
    # A pool row registers in the repository of the job it claims, one of the owner's, each of which
    # has rows of its own that this check covers; there is no one scope to ask for the pool.
    pool) TOKEN_SEES[$scope]=0; return 0 ;;
    *) return 2 ;;
  esac
  local app_cmd="${GHA_APP_TOKEN:-/opt/askalf/gha-app-token.sh}" app_rc
  tok=""
  if [ -x "$app_cmd" ]; then
    app_rc=0
    case "$kind" in
      repo) tok=$("$app_cmd" "${target%%/*}" "${target#*/}" administration=write 2>/dev/null) || app_rc=$? ;;
      *)    tok=$("$app_cmd" "$target" - organization_self_hosted_runners=write 2>/dev/null) || app_rc=$? ;;
    esac
    [ "$app_rc" -eq 0 ] || tok=""
  fi
  [ -n "$tok" ] || tok=$(grep -m1 "^$key=" "$envf" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  if [ -z "$tok" ]; then TOKEN_SEES[$scope]=1; return 1; fi
  local rc=2
  if out=$(GH_TOKEN="$tok" gh api "$api/actions/runners?per_page=1" -q .total_count 2>&1); then
    rc=0
  else
    case "$out" in
      *[Rr]ate\ limit*) rc=2 ;;
      *"HTTP 404"*|*"HTTP 403"*|*"HTTP 401"*) rc=1 ;;
    esac
  fi
  TOKEN_SEES[$scope]=$rc
  return "$rc"
}

# Ephemeral rows run under one template per ACCOUNT (the account is what a job can read; the
# slice comes from the tier). The pool name is also the tool cache suffix. root is the build
# tier's account (docs/ops-tier.md): the deploys need the docker socket and the host's files.
pool_of() {  # pool_of <user> -> exec | read | write | redline | first-party | build
  case "$1" in
    gha-oss) printf 'exec' ;;
    gha-oss-read) printf 'read' ;;
    gha-oss-write) printf 'write' ;;
    gha-redline) printf 'redline' ;;
    gha-exec) printf 'first-party' ;;
    root) printf 'build' ;;
    *) die "no ephemeral template for account $1 (known: gha-oss, gha-oss-read, gha-oss-write, gha-redline, gha-exec, root)" ;;
  esac
}
# Every ephemeral template, so a row that moved to another account can retire its old unit.
EPHEMERAL_TEMPLATES="gha-ephemeral@ gha-ephemeral-read@ gha-ephemeral-write@ gha-ephemeral-redline@ gha-ephemeral-first-party@ gha-ephemeral-build@"
template_for() {  # template_for <user> -> unit template name without the instance
  case "$(pool_of "$1")" in
    exec) printf 'gha-ephemeral@' ;;
    read) printf 'gha-ephemeral-read@' ;;
    write) printf 'gha-ephemeral-write@' ;;
    redline) printf 'gha-ephemeral-redline@' ;;
    first-party) printf 'gha-ephemeral-first-party@' ;;
    build) printf 'gha-ephemeral-build@' ;;
  esac
}

unit_for() {  # unit_for <name> <scope> <mode> [user]
  local name=$1 scope=$2 mode=$3 user=${4:-gha-oss}
  case "$mode" in
    ephemeral) printf '%s%s.service' "$(template_for "$user")" "$name" ;;
    *) case "$(scope_kind "$scope")" in
         repo) printf 'actions.runner.%s.%s.service' "$(scope_target "$scope" | tr '/' '-')" "$name" ;;
         org)  printf 'actions.runner.%s.%s.service' "$(scope_target "$scope")" "$name" ;;
         *) die "unknown scope kind in $scope" ;;
       esac ;;
  esac
}

slice_for() {  # slice_for <tier>
  case "$1" in
    read|exec|build) printf 'gha-%s.slice' "$1" ;;
    *) die "unknown tier: $1" ;;
  esac
}

dropin_for() {  # dropin_for <tier> -> the drop-in body for an adopt/managed unit
  printf '# Managed by gha-runners-apply.sh from %s. Do not edit here.\n[Service]\nSlice=%s\n' "$MANIFEST" "$(slice_for "$1")"
}

# ── one account per row (docs/isolation.md) ───────────────────────────────
# A row named in $ISOLATED_FILE (one name per line, # comments) runs as its own account gx-<row>,
# with its own tool cache, through a drop-in on its unit. The drop-in also sets GHA_ROW_ACCOUNT,
# which the mint step reads, so the account the files are given to is always the account the unit
# runs as; the list is only read here. A row taken off the list loses the drop-in and goes back to
# the tier account.
is_isolated() {  # is_isolated <row>
  [ -r "$ISOLATED_FILE" ] || return 1
  sed 's/[[:space:]]*#.*$//' "$ISOLATED_FILE" | awk -v n="$1" '$1 == n { f = 1 } END { exit !f }'
}
# A listed row keeps the tier's group as a supplementary group, which is what lets it read the tier's
# key files (root:<tier account> 0640). `groups=none` after the name drops it, for a row whose
# repository reads none of them. `groups=<group>` puts that group in its place, for a row that reads
# one lane's key file (root:<group> 0640) and must read nothing else of the tier's: the tier's group
# also opens every unisolated row's directory (root:<tier account> 1770).
isolated_groups() {  # isolated_groups <row> -> its whole groups= word, or empty (the tier's group)
  [ -r "$ISOLATED_FILE" ] || return 0
  sed 's/[[:space:]]*#.*$//' "$ISOLATED_FILE" | awk -v n="$1" '$1 == n { for (i = 2; i <= NF; i++) if ($i ~ /^groups=/) { print $i; exit } }'
}
# A row's account is gx-<row>, or the `account=` word's value where the name would be over useradd's 32
# characters (gx-acme-marketing-site-redline-e1 is 33). isolate_row holds a row whose value is not a
# gx- name or is also another listed row's account.
isolated_account() {  # isolated_account <row> -> its account= value, else gx-<row>
  local a=""
  [ -r "$ISOLATED_FILE" ] && a=$(sed 's/[[:space:]]*#.*$//' "$ISOLATED_FILE" | awk -v n="$1" '$1 == n { for (i = 2; i <= NF; i++) if ($i ~ /^account=/) { print $i; exit } }')
  if [ -n "$a" ]; then printf '%s' "${a#account=}"; else printf 'gx-%s' "$1"; fi
}
# How many listed rows run as <account>: two rows on one account would read each other's directories.
isolated_account_rows() {  # isolated_account_rows <account> -> a count
  [ -r "$ISOLATED_FILE" ] || { echo 0; return 0; }
  sed 's/[[:space:]]*#.*$//' "$ISOLATED_FILE" | awk -v a="$1" 'NF { x = "gx-" $1; for (i = 2; i <= NF; i++) if ($i ~ /^account=/) x = substr($i, 9); if (x == a) c++ } END { print c + 0 }'
}
# The group an instance directory carries: the row's own account where the row is isolated and the
# account exists (bootstrap runs before apply creates one), else the tier's. The mint step sets the
# same at every start; bootstrap and apply set it too, so a row that does not start for a while (a
# warm listener between jobs, a parked pool row) is not left on the tier's group by a bootstrap that
# reset it, which would show as isolation drift.
instance_dir_group() {  # instance_dir_group <row> <tier account>
  local acct
  if is_isolated "$1"; then
    acct=$(isolated_account "$1")
    if id "$acct" >/dev/null 2>&1; then printf '%s' "$acct"; return 0; fi
  fi
  printf '%s' "$2"
}

isolated_dropin() {  # isolated_dropin <row> <supplementary group or empty> <tool cache dir> <instance dir>
  local acct; acct=$(isolated_account "$1")
  printf '# Managed by gha-runners-apply.sh from %s. Do not edit here.\n[Service]\nUser=%s\nGroup=%s\n' "$ISOLATED_FILE" "$acct" "$acct"
  [ -z "$2" ] || printf 'SupplementaryGroups=%s\n' "$2"
  printf 'Environment=GHA_ROW_ACCOUNT=%s\nEnvironment=RUNNER_TOOL_CACHE=%s\nEnvironment=AGENT_TOOLSDIRECTORY=%s\nProtectProc=invisible\nReadWritePaths=\nReadWritePaths=%s %s\n' "$acct" "$3" "$3" "$4" "$3"
}

# The uid a unit's main process runs as, or nothing when the unit is not running.
running_uid() {  # running_uid <unit>
  local pid
  pid=$(systemctl show -p MainPID --value "$1" 2>/dev/null)
  case "$pid" in ''|0) return 0 ;; esac
  ps -o uid= -p "$pid" 2>/dev/null | tr -d ' '
}
# Whether a row's instance directory may change group now. Not while its unit runs as another account:
# a row moving onto or off the list still runs as its old account until its next start, and its job
# (or a warm listener's next job) would lose its own directory. The mint step gives the directory to
# the unit's account at every start (GHA_ROW_ACCOUNT), so the move is only deferred, never skipped.
moves_now() {  # moves_now <unit> <account> <dir>; logs when it defers
  local now
  now=$(running_uid "$1")
  if [ -z "$now" ] || [ "$now" = "$(id -u "$2" 2>/dev/null)" ]; then return 0; fi
  log "  later   $3: $1 still runs as uid $now; its mint step gives the directory to $2 at the next start"
  return 1
}

isolate_row() {  # isolate_row <mode> <row> <unit> <tier account> <dir>; adds to reconcile's changed and to_restart
  local mode=$1 name=$2 unit=$3 tier_user=$4 dir=$5 path acct cache want have grp
  path="$UNIT_DIR/$unit.d/$ISO_DROPIN"
  if is_isolated "$name"; then
    acct=$(isolated_account "$name")
    [ "${#acct}" -le 32 ] || { log "  hold    $unit: account name $acct is over 32 characters; give the row an account= word"; return 1; }
    printf '%s' "$acct" | grep -Eqx 'gx-[a-z0-9][a-z0-9-]*' || { log "  hold    $unit: account=$acct is not a gx- account name"; return 1; }
    [ "$(isolated_account_rows "$acct")" = 1 ] || { log "  hold    $unit: account $acct is also another listed row's"; return 1; }
    cache="$TOOLCACHE/$name"
    grp=$(isolated_groups "$name")
    case "$grp" in
      '') grp=$tier_user ;;
      groups=none) grp="" ;;
      *)
        # A value that is not a group name (an empty `groups=`, a stray character) holds the row:
        # it must reach neither groupadd nor the drop-in.
        grp=${grp#groups=}
        printf '%s' "$grp" | grep -Eqx '[a-z_][a-z0-9_-]{0,31}' || { log "  hold    $unit: groups=$grp is not a group name"; return 1; }
        if ! getent group "$grp" >/dev/null 2>&1; then
          log "  GROUP+  $grp for $name"
          # errexit is off inside `isolate_row || continue`, and a unit whose group does not exist
          # fails at every start, so a failed groupadd holds the row.
          if [ "$mode" = apply ] && ! groupadd --system "$grp"; then log "  hold    $unit: could not create group $grp"; return 1; fi
        fi
        ;;
    esac
    want=$(isolated_dropin "$name" "$grp" "$cache" "$dir")
    have=$(cat "$path" 2>/dev/null || true)
    if ! id "$acct" >/dev/null 2>&1; then
      log "  USER    $acct for $name"
      [ "$mode" = apply ] && useradd --system --home-dir "$dir" --no-create-home --shell /usr/sbin/nologin "$acct"
    fi
    if [ "$mode" = apply ] && [ ! -d "$cache" ]; then
      install -d -m 0755 -o root -g root "$TOOLCACHE"
      install -d -m 0755 -o "$acct" -g "$acct" "$cache"
      log "  CACHE   $cache"
    fi
    # The directory goes to the row's account here, not only at the row's next mint: a warm listener
    # between jobs or a parked pool row may not start for hours after a bootstrap reset it.
    if [ -d "$dir" ] && [ "$(stat -c %G "$dir" 2>/dev/null)" != "$acct" ] && moves_now "$unit" "$acct" "$dir"; then
      log "  GROUP   $dir to $acct (was $(stat -c %G "$dir" 2>/dev/null || echo '?'))"
      [ "$mode" = apply ] && chown "root:$acct" "$dir"
    fi
    if [ "$want" = "$have" ]; then
      log "  ok      $unit isolated as $acct"
    else
      log "  ISOLATE $unit as $acct (drop-in $path)"
      if [ "$mode" = apply ]; then
        mkdir -p "$(dirname "$path")"
        printf '%s\n' "$want" > "$path"
        chmod 644 "$path"
      fi
      changed=$((changed + 1)); to_restart+=("$unit|$dir")
    fi
  elif [ -f "$path" ]; then
    log "  UNISOLATE $unit (back to $tier_user)"
    [ "$mode" = apply ] && rm -f "$path"
    if [ "$mode" = apply ] && [ -d "$dir" ] && moves_now "$unit" "$tier_user" "$dir"; then chown "root:$tier_user" "$dir"; fi
    changed=$((changed + 1)); to_restart+=("$unit|$dir")
  fi
  return 0
}

# ── CPU shape per row (docs/cpu.md) ──────────────────────────────────────────
# A row named in $CPU_FILE gets a drop-in with CPUAffinity= (cpus=N) and/or CPUWeight= (weight=W).
# Test runners, tsc, esbuild and make size their worker pools from the CPU count the process can
# run on (Node: os.availableParallelism(), which follows affinity and ignores the slice quota), so
# a job on a row pinned to 4 of the 8 CPUs starts 3 test workers, not 7. Windows rotate by the
# row's position among the cpus= lines, so rows spread over every CPU instead of piling on the first
# few. A row not listed has no drop-in; taking a row off the list removes it.
cpu_line() {  # cpu_line <row> -> that row's options, or nothing
  [ -r "$CPU_FILE" ] || return 0
  sed 's/[[:space:]]*#.*$//' "$CPU_FILE" | awk -v n="$1" '$1 == n { $1 = ""; print; exit }'
}
cpu_opt() {  # cpu_opt <row> <key> -> the value of key=value, or nothing
  cpu_line "$1" | tr ' ' '\n' | awk -F= -v k="$2" '$1 == k { print $2; exit }'
}
cpu_total() { printf '%s' "${GHA_CPU_TOTAL:-$(nproc --all)}"; }
cpu_window() {  # cpu_window <row> <count> -> CPU numbers, space separated, wrapping around the host
  local n=$2 total idx i out=""
  total=$(cpu_total)
  idx=$(sed 's/[[:space:]]*#.*$//' "$CPU_FILE" | awk -v n="$1" '/(^|[[:space:]])cpus=/ { if ($1 == n) { print c; exit } c++ }')
  for ((i = 0; i < n; i++)); do out="$out $(( (idx + i) % total ))"; done
  printf '%s' "${out# }"
}
cpu_dropin() {  # cpu_dropin <row> <count or empty> <weight or empty>
  printf '# Managed by gha-runners-apply.sh from %s. Do not edit here.\n[Service]\n' "$CPU_FILE"
  [ -z "$2" ] || printf 'CPUAffinity=%s\n' "$(cpu_window "$1" "$2")"
  [ -z "$3" ] || printf 'CPUWeight=%s\n' "$3"
}

cpu_row() {  # cpu_row <mode> <row> <unit> <dir>; adds to reconcile's changed and to_restart
  local mode=$1 name=$2 unit=$3 dir=$4 path want have cpus weight total q queued=0
  path="$UNIT_DIR/$unit.d/$CPU_DROPIN"
  cpus=$(cpu_opt "$name" cpus); weight=$(cpu_opt "$name" weight)
  if [ -n "$cpus$weight" ]; then
    total=$(cpu_total)
    case "$cpus" in ''|*[!0-9]*) [ -z "$cpus" ] || { log "  hold    $unit: cpus=$cpus is not a number"; return 1; } ;; esac
    if [ -n "$cpus" ] && { [ "$cpus" -lt 1 ] || [ "$cpus" -gt "$total" ]; }; then
      log "  hold    $unit: cpus=$cpus is outside 1..$total"; return 1
    fi
    case "$weight" in ''|*[!0-9]*) [ -z "$weight" ] || { log "  hold    $unit: weight=$weight is not a number"; return 1; } ;; esac
    if [ -n "$weight" ] && { [ "$weight" -lt 1 ] || [ "$weight" -gt 10000 ]; }; then
      log "  hold    $unit: weight=$weight is outside 1..10000"; return 1
    fi
    want=$(cpu_dropin "$name" "$cpus" "$weight")
    have=$(cat "$path" 2>/dev/null || true)
    if [ "$want" = "$have" ]; then
      log "  ok      $unit cpu shape ($(cpu_line "$name" | xargs))"
    else
      log "  CPU     $unit $(cpu_line "$name" | xargs) (drop-in $path)"
      if [ "$mode" = apply ]; then
        mkdir -p "$(dirname "$path")"
        printf '%s\n' "$want" > "$path"
        chmod 644 "$path"
      fi
      changed=$((changed + 1))
      for q in "${to_restart[@]}"; do [ "${q%%|*}" != "$unit" ] || queued=1; done
      [ "$queued" = 1 ] || to_restart+=("$unit|$dir")
    fi
  elif [ -f "$path" ]; then
    log "  UNCPU   $unit (back to the whole host)"
    [ "$mode" = apply ] && rm -f "$path"
    changed=$((changed + 1))
    for q in "${to_restart[@]}"; do [ "${q%%|*}" != "$unit" ] || queued=1; done
    [ "$queued" = 1 ] || to_restart+=("$unit|$dir")
  fi
  return 0
}

busy() {  # busy <dir> -> 0 when a job is running out of that runner directory
  pgrep -f "^${1%/}/bin/Runner.Worker" >/dev/null 2>&1
}

require_slices() {
  local s missing=""
  for s in gha.slice gha-read.slice gha-exec.slice gha-build.slice; do
    [ -f "$UNIT_DIR/$s" ] || missing="$missing $s"
  done
  [ -z "$missing" ] || die "slice unit(s) not deployed:$missing (run the host deploy first)"
}

# ── plan / apply ────────────────────────────────────────────────────────────
reconcile() {  # reconcile <plan|apply> [--restart-idle]
  local mode=$1 restart=${2:-} changed=0 unit dir path want have
  local -a to_restart=()
  require_slices
  while read -r name scope tier user dir labels rmode; do
    unit=$(unit_for "$name" "$scope" "$rmode" "$user")
    case "$rmode" in
      ephemeral)
        # The template unit carries its slice and hardening; nothing to drop in.
        # apply enables the instance once the org token file exists.
        local tmpl="${unit%@*}@.service"
        if [ ! -f "$UNIT_DIR/$tmpl" ]; then
          log "  MISSING template $tmpl for $unit (deploy it first)"; continue
        fi
        if ! id "$user" >/dev/null 2>&1; then
          log "  hold    $unit: user $user missing (run bootstrap)"; continue
        fi
        # A build row runs as root; there is no per-row account to move it into, and a drop-in
        # that set one would take the docker socket and the host's files away from its deploys.
        if [ "$user" = root ] && is_isolated "$name"; then
          log "  hold    $unit: a build row runs as root and cannot be isolated; take $name out of $ISOLATED_FILE"; continue
        fi
        isolate_row "$mode" "$name" "$unit" "$user" "$dir" || continue
        cpu_row "$mode" "$name" "$unit" "$dir" || continue
        # A row whose account changed runs under another template now. The old template's
        # instance of this name would keep minting the same registration into the same
        # directory, so it is retired first; with a job running it waits for the next apply,
        # and the new unit is not enabled beside it.
        local other old retire_wait=0
        for other in $EPHEMERAL_TEMPLATES; do
          old="${other}${name}.service"
          [ "$old" = "$unit" ] && continue
          systemctl is-enabled --quiet "$old" 2>/dev/null || systemctl is-active --quiet "$old" 2>/dev/null || continue
          if busy "$dir"; then
            log "  defer   $old: a job is running; it is retired, and $unit enabled, on the next apply"
            retire_wait=1; continue
          fi
          log "  RETIRE  $old (this row now runs as $user under $unit)"
          [ "$mode" = apply ] && systemctl disable --now "$old"
        done
        [ "$retire_wait" = 0 ] || continue
        # The registration token file depends on the scope (see gha-ephemeral-mint.sh).
        local envf
        case "$(scope_kind "$scope")" in repo|pool) envf=/etc/askalf/gha-repo.env ;; *) envf=/etc/askalf/gha-org.env ;; esac
        if [ ! -r "$envf" ]; then
          log "  hold    $unit: $envf not present, not enabling"; continue
        fi
        # A new row's directory comes from bootstrap; enabling the unit first only makes it
        # crash-loop on the missing bind mount (status 226/NAMESPACE).
        if [ ! -d "$dir" ]; then
          log "  hold    $unit: $dir does not exist yet; run bootstrap, then apply"; continue
        fi
        if systemctl is-enabled --quiet "$unit" 2>/dev/null; then
          log "  ok      $unit enabled"
        else
          local sees=0
          token_sees "$scope" "$envf" || sees=$?
          if [ "$sees" = 1 ]; then
            log "  hold    $unit: neither the runner App nor the token in $envf can see $(scope_target "$scope"); install the App there or add it to that token (repository: Administration read and write; org: Self-hosted runners write), then run apply again"
            continue
          fi
          [ "$sees" = 0 ] || log "  note    $unit: could not check the token's access to $(scope_target "$scope"); enabling anyway"
          if [ "$(scope_kind "$scope")" = pool ]; then
            # A pool row starts when the dispatcher hands it a job and at no other time: enabled
            # so that boot and the supervisor know it, parked so that nothing starts it meanwhile.
            # `enable --now` here would start every pool row at once, those past POOL_MAX
            # included, and each would claim from the queue during its linger.
            log "  ENABLE  $unit (parked: a pool row starts for a job the dispatcher routes to it)"
            if [ "$mode" = apply ]; then
              systemctl enable "$unit"
              mkdir -p -m 700 "$PARK_DIR"   # root's alone: a mark names its row (docs/isolation.md)
              date -u +%Y-%m-%dT%H:%M:%SZ > "$PARK_DIR/$unit"
            fi
          else
            log "  ENABLE  $unit"
            [ "$mode" = apply ] && systemctl enable --now "$unit"
          fi
        fi
        continue ;;
      adopt|managed) ;;
      *) die "unknown mode '$rmode' for $name" ;;
    esac
    if [ ! -f "$UNIT_DIR/$unit" ]; then
      log "  MISSING $unit (dir $dir): unit not installed; for a managed row run: register $name"; continue
    fi
    path="$UNIT_DIR/$unit.d/$DROPIN"
    want=$(dropin_for "$tier")
    have=$(cat "$path" 2>/dev/null || true)
    if [ "$want" = "$have" ]; then
      log "  ok      $unit -> $(slice_for "$tier")"
    else
      log "  SLICE   $unit -> $(slice_for "$tier") (drop-in $path)"
      if [ "$mode" = apply ]; then
        mkdir -p "$(dirname "$path")"
        printf '%s' "$want" > "$path"
        chmod 644 "$path"
      fi
      changed=$((changed + 1))
      to_restart+=("$unit|$dir")
    fi
  done < <(rows)

  if [ "$changed" -gt 0 ] && [ "$mode" = apply ]; then
    systemd-analyze verify "$UNIT_DIR"/gha*.slice >/dev/null
    systemctl daemon-reload
    log "  daemon-reload ($changed drop-in(s) written)"
    if [ "$restart" = "--restart-idle" ]; then
      local e u d
      for e in "${to_restart[@]}"; do
        u=${e%%|*}; d=${e#*|}
        # A stopped unit (parked by gha-ondemand) reads the drop-in at its next start; restart would start it.
        if ! systemctl is-active --quiet "$u"; then
          log "  later   $u: not running, takes the drop-in at its next start"
        elif busy "$d"; then
          log "  defer   $u: job running, restart later with: systemctl restart $u"
        else
          systemctl restart "$u" && log "  restart $u"
        fi
      done
    else
      log "  note: slices take effect at each unit's next restart (apply --restart-idle, or the runner's own self-update restart)"
    fi
  elif [ "$changed" -gt 0 ]; then
    log "  plan: $changed drop-in(s) would be written; run: apply [--restart-idle]"
  fi
}

# ── bootstrap / upgrade ─────────────────────────────────────────────────────
pinned() {  # -> "<version> <sha256>"
  [ -r "$VERSION_FILE" ] || die "version file not readable: $VERSION_FILE"
  awk '!/^[[:space:]]*(#|$)/ { print $1, $2; exit }' "$VERSION_FILE"
}

install_pinned() {  # installs $INSTALL_ROOT/<version> if absent, repoints current
  local ver sha tmp tarball
  read -r ver sha < <(pinned)
  [ -n "$ver" ] && [ -n "$sha" ] || die "version file has no '<version> <sha256>' row"
  if [ -x "$INSTALL_ROOT/$ver/bin/Runner.Listener" ]; then
    log "  ok      runner $ver installed"
  else
    log "  INSTALL runner $ver"
    tmp=$(mktemp -d); tarball="$tmp/actions-runner-linux-x64-$ver.tar.gz"
    curl -fsSL -o "$tarball" "https://github.com/actions/runner/releases/download/v$ver/actions-runner-linux-x64-$ver.tar.gz"
    printf '%s  %s\n' "$sha" "$tarball" | sha256sum -c --quiet - || die "sha256 mismatch for runner $ver"
    mkdir -p "$INSTALL_ROOT/$ver"
    tar -xzf "$tarball" -C "$INSTALL_ROOT/$ver"
    rm -rf "$tmp"
    chown -R root:root "$INSTALL_ROOT/$ver"
  fi
  if [ "$(readlink -f "$INSTALL_ROOT/current" 2>/dev/null)" != "$INSTALL_ROOT/$ver" ]; then
    ln -sfn "$INSTALL_ROOT/$ver" "$INSTALL_ROOT/current"
    log "  LINK    $INSTALL_ROOT/current -> $ver"
  fi
}

layout_pool() {  # every ephemeral instance: bin/ and externals/ as hard links to the pinned install
  # This runs here, on the host, and not in gha-ephemeral-mint.sh, because the mint step runs
  # inside the unit's mount namespace: ProtectSystem=strict with ReadWritePaths= bind-mounts the
  # instance directory, and link(2) across two mounts of one filesystem is EXDEV. The mint step
  # tried it and every ephemeral unit start-limited with an emptied instance. So the mint step
  # lays a plain copy when an instance has no runner of the pinned version, and this lays links
  # over copies whenever it runs: once per pin, a full copy per instance becomes directory entries. A busy instance is skipped (its worker runs out of bin/);
  # an idle listener keeps the inodes it has open and finds the same content at the same paths.
  local ver src n=0
  read -r ver _ < <(pinned)
  src="$INSTALL_ROOT/$ver"
  [ -x "$src/bin/Runner.Listener" ] || die "pinned runner $ver not installed; run bootstrap first"
  while read -r name scope tier user dir labels rmode; do
    [ "$rmode" = ephemeral ] || continue
    [ -d "$dir" ] || continue
    if [ "$(cat "$dir/.pinned" 2>/dev/null)" = "$ver link" ] && [ "$dir/bin/Runner.Listener" -ef "$src/bin/Runner.Listener" ]; then
      continue
    fi
    if busy "$dir"; then log "  defer   $dir: job running, laid out on the next layout/upgrade"; continue; fi
    rm -rf -- "$dir/bin" "$dir/externals" "$dir/.pinned"
    rm -f -- "$dir"/*.sh "$dir"/*.template
    cp -al "$src/bin" "$dir/bin"
    cp -al "$src/externals" "$dir/externals"
    local f
    for f in "$src"/*.sh "$src"/*.template; do
      case "$(basename "$f")" in run-helper.sh) continue ;; esac   # run.sh generates it per start, as the exec user
      cp -a "$f" "$dir/"
    done
    chown -h root:root "$dir/bin" "$dir/externals" "$dir"/*.sh "$dir"/*.template
    printf '%s link\n' "$ver" > "$dir/.pinned"
    log "  LINK    $dir <- $src"
    n=$((n+1))
  done < <(rows)
  log "  ok      $n instance(s) laid out as hard links to runner $ver; the rest already were"
}

bootstrap() {
  # One system account per ephemeral row's user (the manifest names them; today gha-oss
  # for the exec tier and gha-oss-read for the read tier). The pool root is root-owned and
  # world-traversable; each instance dir below it is what an account can enter.
  local u
  while read -r u; do
    if ! id "$u" >/dev/null 2>&1; then
      useradd --system --home-dir "$POOL_ROOT" --no-create-home --shell /usr/sbin/nologin "$u"
      log "  USER    $u created"
    else
      log "  ok      user $u"
    fi
  done < <(rows | awk '$7=="ephemeral" { print $4 }' | sort -u)
  mkdir -p "$POOL_ROOT" "$POOL_ROOT/.mint"
  # 755, not 711: before each job the runner lists every directory above its _work and fails the job
  # at start when one refuses ("Permission to read the directory contents is required for ... and
  # each directory up the hierarchy"), so a job's account must be able to list /srv/gha.
  chown root:root "$POOL_ROOT" "$POOL_ROOT/.mint"; chmod 755 "$POOL_ROOT"; chmod 700 "$POOL_ROOT/.mint"
  # One tool cache per tier, owned by that tier's account and writable by it alone: a shared
  # world-writable cache was a path from an untrusted exec job into the credentialed tier.
  local pool_user pool grp
  while read -r pool_user; do
    pool=$(pool_of "$pool_user")
    mkdir -p "$TOOLCACHE-$pool"; chown "$pool_user:$pool_user" "$TOOLCACHE-$pool"; chmod 755 "$TOOLCACHE-$pool"
  done < <(rows | awk '$7=="ephemeral" { print $4 }' | sort -u)
  if [ -d "$TOOLCACHE" ] && [ -z "$(ls -A "$TOOLCACHE" 2>/dev/null)" ]; then rmdir "$TOOLCACHE" && log "  removed the empty shared tool cache $TOOLCACHE"; fi
  install_pinned
  while read -r name scope tier user dir labels rmode; do
    [ "$rmode" = ephemeral ] || continue
    # Root-owned and sticky, group-writable: the row's account (its own where the row is isolated,
    # the tier's otherwise) writes its own files here but cannot rename or remove the root-owned
    # runner copy the mint step lays out. A group change waits while the row's unit still runs as the
    # other account (moves_now): a row apply has just isolated keeps the tier's group until its next start.
    if [ ! -d "$dir" ]; then
      mkdir -p "$dir"
      log "  DIR     $dir for $name"
    fi
    grp=$(instance_dir_group "$name" "$user")
    if [ "$(stat -c %G "$dir" 2>/dev/null)" = "$grp" ] || moves_now "$(unit_for "$name" "$scope" "$rmode" "$user")" "$grp" "$dir"; then
      chown "root:$grp" "$dir"
    fi
    chmod 1770 "$dir"
  done < <(rows)
  layout_pool
  log "  note: tool caches are per account under $TOOLCACHE-<pool>; the mint step resets each instance dir every cycle"
  log "  note: the runner's OS deps (libicu etc.) are already present for the adopted runners; if a fresh host, run $INSTALL_ROOT/current/bin/installdependencies.sh"
}

upgrade() {
  local restart=${1:-} unit
  install_pinned
  layout_pool
  if [ "$restart" = "--restart-idle" ]; then
    while read -r name scope tier user dir labels rmode; do
      [ "$rmode" = ephemeral ] || continue
      unit=$(unit_for "$name" "$scope" "$rmode" "$user")
      systemctl is-active --quiet "$unit" || continue
      if busy "$dir"; then log "  defer   $unit: job running"; else systemctl restart "$unit" && log "  restart $unit (picks up current)"; fi
    done < <(rows)
  else
    log "  note: ephemeral units pick up $INSTALL_ROOT/current on their next cycle; adopted runners self-update on GitHub's schedule"
  fi
}

# ── register (managed rows only) ────────────────────────────────────────────
register() {
  local want=$1 found=0 token
  while read -r name scope tier user dir labels rmode; do
    [ "$name" = "$want" ] || continue
    found=1
    [ "$rmode" = managed ] || die "$name is mode '$rmode'; register only configures 'managed' rows"
    [ "$(scope_kind "$scope")" = repo ] || die "$name: register handles repo scope; org pools are ephemeral (JIT) rows"
    [ -e "$dir/.runner" ] && die "$name: $dir is already configured"
    [ -x "$INSTALL_ROOT/current/bin/Runner.Listener" ] || die "pinned runner not installed; run bootstrap first"
    id "$user" >/dev/null 2>&1 || die "user $user does not exist"
    log "  registration token for $scope on stdin (single use, 1h): "
    IFS= read -r token
    [ -n "$token" ] || die "empty token"
    mkdir -p "$dir"
    # bin/ and externals/ are shared from the pinned install; the rest is per-runner.
    ln -sfn "$INSTALL_ROOT/current/bin" "$dir/bin"
    ln -sfn "$INSTALL_ROOT/current/externals" "$dir/externals"
    cp -n "$INSTALL_ROOT"/current/*.sh "$INSTALL_ROOT"/current/*.template "$dir/" 2>/dev/null || true
    chown -R "$user:$user" "$dir"
    # config.sh takes the token as its own argument; the token is single-use and expires
    # in an hour, and it never touches this script's argv or the shell history.
    (cd "$dir" && runuser -u "$user" -- ./config.sh --unattended --replace --disableupdate \
        --url "https://github.com/$(scope_target "$scope")" --token "$token" \
        --name "$name" --labels "$labels" --work _work)
    (cd "$dir" && ./svc.sh install "$user" && ./svc.sh start)
    log "  REGISTERED $name ($scope) as $user in $dir; now run: apply --restart-idle"
  done < <(rows)
  [ "$found" = 1 ] || die "no manifest row named $want"
}

# ── status ──────────────────────────────────────────────────────────────────
status() {
  local tok="${GH_TOKEN:-}" unit ustate b gstate target
  # GHA_TOKEN_ENV: the token file the dispatcher and the supervisor read (their default too).
  [ -n "$tok" ] || tok="$(grep -m1 '^GITHUB_TOKEN=' "${GHA_TOKEN_ENV:-/root/.askalf/.env}" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
  printf '%-32s %-32s %-9s %-5s %s\n' NAME SCOPE UNIT BUSY GITHUB
  while read -r name scope tier user dir labels rmode; do
    unit=$(unit_for "$name" "$scope" "$rmode" "$user")
    ustate=$(systemctl is-active "$unit" 2>/dev/null || true)
    if busy "$dir"; then b=yes; else b=no; fi
    gstate="-"
    if [ -n "$tok" ] && command -v gh >/dev/null 2>&1; then
      case "$(scope_kind "$scope")" in
        repo) target="repos/$(scope_target "$scope")/actions/runners" ;;
        org)  target="orgs/$(scope_target "$scope")/actions/runners" ;;
      esac
      gstate=$(GH_TOKEN="$tok" gh api "$target" --paginate -q ".runners[] | select(.name==\"$name\") | .status" 2>/dev/null | head -1)
      [ -n "$gstate" ] || gstate="unregistered"
    fi
    printf '%-32s %-32s %-9s %-5s %s\n' "$name" "$scope" "${ustate:-absent}" "$b" "$gstate"
  done < <(rows)
}

# ── main ────────────────────────────────────────────────────────────────────
[ "$(id -u)" = 0 ] || die "run as root"
cmd=${1:-plan}; shift || true
case "$cmd" in
  plan)      reconcile plan ;;
  apply)     reconcile apply "${1:-}" ;;
  bootstrap) bootstrap ;;
  upgrade)   upgrade "${1:-}" ;;
  layout)    layout_pool ;;
  register)  register "${1:?register <name>}" ;;
  status)    status ;;
  *) die "usage: $0 {plan|apply [--restart-idle]|bootstrap|upgrade [--restart-idle]|layout|register <name>|status}" ;;
esac
