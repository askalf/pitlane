#!/usr/bin/env bash
# install.sh: put pitlane on a host. Checks the prerequisites, then lays out the code, the systemd
# units and your runner config at the paths the units name (runners/README.md, Files), and writes
# the dispatcher's settings once, in dry mode with a fresh webhook secret.
#
#   sudo runners/install.sh check                   the prerequisites only; changes nothing
#   sudo runners/install.sh install --config DIR    check, validate DIR, lay out code, units and DIR's config
#   sudo runners/install.sh install                 the same for code and units, keeping the config
#                                                   already in /etc/askalf (an upgrade)
#   runners/install.sh install --root DIR ...       lay everything out under DIR instead of /, to look at
#                                                   it or package it: no prerequisite gate, no chown,
#                                                   no systemctl
#
# DIR holds the five files of docs/example-minimal.md (runners.manifest, runners.cpu,
# runners.isolated, runners.retired, runners.build-allow) and, if it has build rows,
# pitlane-build.env. runner-config.mjs checks it as one set first; a set with a problem installs
# nothing. Tokens and keys are never written here: the next steps it prints say where they go.
#
# What it never does: start, stop or enable a unit, register a runner, or overwrite a settings file
# (gha-ondemand.env, pitlane-supervisor.env) or a token file that already exists. Those stay
# gha-runners-apply.sh's and yours. Run it again after a git pull to upgrade the code in place.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/.." && pwd)"

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

CMD="${1:-}"
[ -n "$CMD" ] || usage
shift
CONFIG="" ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --config) [ $# -ge 2 ] || usage; CONFIG="$2"; shift 2 ;;
    --root) [ $# -ge 2 ] || usage; ROOT="${2%/}"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "install.sh: unknown argument $1" >&2; usage ;;
  esac
done
case "$CMD" in check|install) ;; -h|--help|help) usage ;; *) echo "install.sh: unknown command $CMD" >&2; usage ;; esac
[ "$CMD" = install ] || [ -z "$CONFIG$ROOT" ] || { echo "install.sh: check takes no options" >&2; exit 2; }

# ── prerequisites ───────────────────────────────────────────────────────────
# The units run /usr/bin/node by that path, so that node is the one checked; Node.js 22 or later.
NODE_MIN=22
# Every command a runner script, the dispatcher or apply calls on the host (jq, openssl and flock:
# gha-app-token.sh, which mints the runner App's tokens).
TOOLS=(gh curl jq openssl flock tar sha256sum base64 runuser useradd install awk systemctl systemd-analyze)

PROBLEMS=0
ok()   { printf '  ok    %s\n' "$*"; }
warn() { printf '  warn  %s\n' "$*"; }
bad()  { printf '  MISSING  %s\n' "$*"; PROBLEMS=$((PROBLEMS + 1)); }

prerequisites() {
  echo "prerequisites:"
  local os arch distro v ctl
  os="$(uname -s)"; arch="$(uname -m)"
  if [ "$os" = Linux ]; then ok "Linux"; else bad "Linux (this is $os)"; fi
  # RUNNER_VERSION pins the linux-x64 runner tarball; no other build is pinned.
  if [ "$arch" = x86_64 ]; then ok "x86_64"; else bad "x86_64 (this is $arch; the pinned runner is linux-x64)"; fi
  distro="unknown"
  if [ -r /etc/os-release ]; then distro="$(. /etc/os-release && printf '%s %s' "${ID:-?}" "${VERSION_ID:-?}")"; fi
  if [ "$distro" = "ubuntu 24.04" ]; then ok "Ubuntu 24.04 (the tested system)"
  else warn "$distro: untested; any systemd distribution with cgroup v2 should work, Ubuntu 24.04 is the one tested"; fi
  if [ "$(id -u)" = 0 ]; then ok "root"; else bad "root (run it with sudo)"; fi
  if [ -d /run/systemd/system ]; then ok "systemd"; else bad "systemd as the init system"; fi
  if [ -r /sys/fs/cgroup/cgroup.controllers ]; then
    ctl=" $(cat /sys/fs/cgroup/cgroup.controllers) "
    case "$ctl" in *" cpu "*) ;; *) bad "the cgroup v2 cpu controller (the slices weigh CI below the services)" ;; esac
    case "$ctl" in *" memory "*) ;; *) bad "the cgroup v2 memory controller (the slices cap CI's memory)" ;; esac
    case "$ctl" in *" cpu "*" memory "*|*" memory "*" cpu "*) ok "cgroup v2 with the cpu and memory controllers" ;; esac
  else
    bad "cgroup v2 (the unified hierarchy at /sys/fs/cgroup)"
  fi
  if [ "${BASH_VERSINFO[0]}" -ge 4 ]; then ok "bash ${BASH_VERSION%%(*}"; else bad "bash 4 or later"; fi
  if [ -x /usr/bin/node ]; then
    v="$(/usr/bin/node -p 'process.versions.node' 2>/dev/null || echo 0)"
    if [ "${v%%.*}" -ge "$NODE_MIN" ] 2>/dev/null; then ok "node $v at /usr/bin/node"
    else bad "Node.js $NODE_MIN or later at /usr/bin/node (found $v)"; fi
  else
    bad "Node.js $NODE_MIN or later at /usr/bin/node (the units run that path)"
  fi
  local t missing=()
  for t in "${TOOLS[@]}"; do command -v "$t" >/dev/null 2>&1 || missing+=("$t"); done
  if [ ${#missing[@]} -eq 0 ]; then ok "${TOOLS[*]}"; else bad "commands: ${missing[*]}"; fi
}

# ── the layout ──────────────────────────────────────────────────────────────
# <source under runners/> <destination> <mode>: the same rows the host deploy installs. The tests
# hold it to the tree: every unit and slice, every module a service imports, every /opt path a unit runs.
CODE='
gha-runners-apply.sh                 /opt/askalf/gha-runners-apply.sh                 755
gha-app-token.sh                     /opt/askalf/gha-app-token.sh                     755
gha-ephemeral-mint.sh                /opt/askalf/gha-ephemeral-mint.sh                755
gha-ephemeral-run.sh                 /opt/askalf/gha-ephemeral-run.sh                 755
pitlane-job-summary.sh               /opt/askalf/pitlane-job-summary.sh               755
pitlane-build-guard.sh               /opt/askalf/pitlane-build-guard.sh               755
runner-config.mjs                    /opt/askalf/runner-config.mjs                    644
gha-ondemand.mjs                     /opt/askalf/gha-ondemand.mjs                     644
pitlane-kick.mjs                     /opt/askalf/pitlane-kick.mjs                     644
pitlane-waits.mjs                    /opt/askalf/pitlane-waits.mjs                    644
pitlane-outcomes.mjs                 /opt/askalf/pitlane-outcomes.mjs                 644
pitlane-supervisor.mjs               /opt/askalf/pitlane-supervisor.mjs               644
pitlane-supervisor-detect.mjs        /opt/askalf/pitlane-supervisor-detect.mjs        644
pitlane-supervisor-heal.mjs          /opt/askalf/pitlane-supervisor-heal.mjs          644
pitlane-slices.mjs                   /opt/askalf/pitlane-slices.mjs                   644
pitlane-public.mjs                   /opt/askalf/pitlane-public.mjs                   644
RUNNER_VERSION                       /etc/askalf/gha-runner-version                   640
gha.slice                            /etc/systemd/system/gha.slice                    644
gha-read.slice                       /etc/systemd/system/gha-read.slice               644
gha-exec.slice                       /etc/systemd/system/gha-exec.slice               644
gha-build.slice                      /etc/systemd/system/gha-build.slice              644
gha-ephemeral@.service               /etc/systemd/system/gha-ephemeral@.service       644
gha-ephemeral-read@.service          /etc/systemd/system/gha-ephemeral-read@.service  644
gha-ephemeral-write@.service         /etc/systemd/system/gha-ephemeral-write@.service 644
gha-ephemeral-redline@.service       /etc/systemd/system/gha-ephemeral-redline@.service 644
gha-ephemeral-first-party@.service   /etc/systemd/system/gha-ephemeral-first-party@.service 644
gha-ephemeral-build@.service         /etc/systemd/system/gha-ephemeral-build@.service 644
gha-ondemand.service                 /etc/systemd/system/gha-ondemand.service         644
pitlane-supervisor.service           /etc/systemd/system/pitlane-supervisor.service   644
pitlane-public.service               /etc/systemd/system/pitlane-public.service       644
'
# <file in --config DIR> <destination>; all root:root 640 (they name repositories and accounts).
CONFIG_FILES='
runners.manifest     /etc/askalf/gha-runners.manifest
runners.cpu          /etc/askalf/runners.cpu
runners.isolated     /etc/askalf/runners.isolated
runners.retired      /etc/askalf/runners.retired
runners.build-allow  /etc/askalf/runners.build-allow
pitlane-build.env    /etc/askalf/pitlane-build.env
'

CHANGED=0
# put <source> <destination> <mode>: install it when it differs; say which of new, changed, same.
put() {
  local src="$1" dst="$ROOT$2" mode="$3" what
  if [ ! -e "$dst" ]; then what=new
  elif cmp -s "$src" "$dst"; then what=same
  else what=changed; fi
  if [ "$what" != same ]; then
    install -d -m 755 "$(dirname "$dst")"
    if [ -n "$ROOT" ]; then install -m "$mode" "$src" "$dst"
    else install -m "$mode" -o root -g root "$src" "$dst"; fi
    CHANGED=$((CHANGED + 1))
  fi
  [ "$what" = same ] || printf '  %-8s %s\n' "$what" "$2"
}

# settings <destination> <body>: write a settings file once, root:root 600; an existing one is kept.
settings() {
  local dst="$ROOT$1"
  if [ -e "$dst" ]; then printf '  %-8s %s\n' kept "$1"; return 0; fi
  install -d -m 755 "$(dirname "$dst")"
  (umask 077 && printf '%s\n' "$2" > "$dst")
  [ -n "$ROOT" ] || chown root:root "$dst"
  chmod 600 "$dst"
  printf '  %-8s %s\n' new "$1"
}

install_all() {
  local src dst mode n=0
  if [ -n "$CONFIG" ]; then
    [ -d "$CONFIG" ] || { echo "install.sh: --config $CONFIG is not a directory" >&2; exit 1; }
    CONFIG="$(cd "$CONFIG" && pwd)"
    echo "config: $CONFIG"
    # One set or nothing: a manifest whose rows the other files do not cover installs nothing.
    node "$HERE/runner-config.mjs" "$CONFIG" || { echo "install.sh: fix the config above; nothing was installed" >&2; exit 1; }
  elif [ ! -e "$ROOT/etc/askalf/gha-runners.manifest" ]; then
    echo "install.sh: no runner config on this host yet; give one with --config DIR (start from runners/examples/minimal, docs/example-minimal.md)" >&2
    exit 1
  fi

  echo "code and units:"
  while read -r src dst mode; do
    [ -n "$src" ] || continue
    [ -f "$HERE/$src" ] || { echo "install.sh: $HERE/$src is missing: an incomplete checkout?" >&2; exit 1; }
    put "$HERE/$src" "$dst" "$mode"; n=$((n + 1))
  done <<< "$CODE"
  echo "  ($n files, $CHANGED changed)"
  # What the dispatcher reports as the installed commit (dispatcher.json, deploy.ref).
  if git -C "$SRC" rev-parse --verify -q HEAD >/dev/null 2>&1; then
    local ref; ref="$(git -C "$SRC" rev-parse HEAD)"
    install -d -m 755 "$ROOT/opt/askalf"
    printf '%s\n' "$ref" > "$ROOT/opt/askalf/pitlane.ref"
    echo "  commit $ref"
  fi

  if [ -n "$CONFIG" ]; then
    echo "config:"
    CHANGED=0
    while read -r src dst; do
      [ -n "$src" ] || continue
      if [ -f "$CONFIG/$src" ]; then put "$CONFIG/$src" "$dst" 640
      elif [ "$src" != pitlane-build.env ]; then echo "install.sh: $CONFIG/$src is missing" >&2; exit 1; fi
    done <<< "$CONFIG_FILES"
    echo "  ($CHANGED changed)"
  fi

  echo "settings:"
  local secret
  secret="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  [ ${#secret} -eq 64 ] || { echo "install.sh: could not read 32 random bytes for the webhook secret" >&2; exit 1; }
  settings /etc/askalf/gha-ondemand.env "# gha-ondemand, the scale-to-zero dispatcher (runners/README.md, On demand).
# Written once by install.sh, which never overwrites it: edit it freely.
#
# dry logs every start and park it would make and changes nothing. Set MODE=on once
# journalctl -u gha-ondemand shows the starts you expect.
MODE=dry
# The workflow_job webhook: GitHub posts each queued job to your tunnel or reverse proxy,
# which forwards it to http://127.0.0.1:\$HOOK_PORT/pitlane. Give GitHub this same secret.
HOOK_SECRET=$secret
HOOK_PORT=7311
# A gid number lets that group read the dispatcher's state files (0640); none keeps them root's (0600).
PITLANE_READ_GID=none"
  settings /etc/askalf/pitlane-supervisor.env "# pitlane-supervisor (docs/supervisor.md). Written once by install.sh, which never overwrites it.
# observe reports what is wrong and changes nothing; heal also does what docs/supervisor.md permits.
PITLANE_MODE=observe
# A gid number lets that group read the supervisor's state files (0640); none keeps them root's (0600).
PITLANE_READ_GID=none"
}

# ── run ─────────────────────────────────────────────────────────────────────
if [ -z "$ROOT" ]; then
  prerequisites
  if [ "$PROBLEMS" -gt 0 ]; then
    if [ "$CMD" = install ]; then echo "install.sh: $PROBLEMS prerequisite(s) missing; nothing was installed" >&2
    else echo "install.sh: $PROBLEMS prerequisite(s) missing" >&2; fi
    exit 1
  fi
  [ "$CMD" = install ] || { echo "every prerequisite is met"; exit 0; }
fi

install_all

if [ -z "$ROOT" ]; then
  systemctl daemon-reload
  # The non-template units and the slices; a template is read when apply starts an instance of it.
  if ! systemd-analyze verify /etc/systemd/system/gha.slice /etc/systemd/system/gha-read.slice \
      /etc/systemd/system/gha-exec.slice /etc/systemd/system/gha-build.slice \
      /etc/systemd/system/gha-ondemand.service /etc/systemd/system/pitlane-supervisor.service \
      /etc/systemd/system/pitlane-public.service; then
    echo "install.sh: the files are in place, but systemd-analyze verify found the problem above; fix it before enabling a unit" >&2
    exit 1
  fi
fi

cat <<EOF

Installed. Nothing is running yet. Next, as root:

  1. GitHub access for each owner the manifest names (runners/README.md, Modes), each file
     root:root 600: the runner GitHub App, /etc/askalf/gha-app.env (GHA_APP_ID=<id>) and its key
     /etc/askalf/gha-app.pem; or, without the App, a fine-grained token as GH_REPO_RUNNER_TOKEN in
     /etc/askalf/gha-repo.env (Administration: read and write on those repositories) and one as
     GITHUB_TOKEN in /root/.askalf/.env for the dispatcher's job listing (Actions: read; set
     GHA_TOKEN_ENV in both settings files to keep it elsewhere).
  2. gha-runners-apply.sh bootstrap           accounts, /srv/gha, the pinned runner
     gha-runners-apply.sh apply --restart-idle
  3. systemctl enable --now gha-ondemand.service pitlane-supervisor.service
     journalctl -u gha-ondemand -f            dry mode: it says what it would start and park
  4. The webhook, for starts without the poll wait: in the repository or organization settings,
     Webhooks, payload URL https://<your tunnel>/pitlane, content type application/json, the
     secret HOOK_SECRET in /etc/askalf/gha-ondemand.env, the event "Workflow jobs".
  5. MODE=on in /etc/askalf/gha-ondemand.env, then systemctl restart gha-ondemand.
EOF
