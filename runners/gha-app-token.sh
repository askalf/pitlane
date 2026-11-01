#!/usr/bin/env bash
# gha-app-token.sh <account> [<repo>|-] [<permission>=<read|write>[,...]]
# Print an installation token of the runner GitHub App for <account>, narrowed to one repository
# and to the permissions named, when given.
#
# The runner mint step and gha-ondemand call GitHub on every runner cycle and every job wait. With a
# personal access token those calls share the owner's 5000 an hour with everything else the owner
# runs, and the queue stalls whenever the budget runs low. An installation token of a GitHub App
# is counted against the App's installation instead, a bucket of its own.
#
# Narrow tokens: the App holds Administration write on every repository it is installed on, which
# also reaches repository settings, rulesets and deletion. A caller asks only for what it uses (the
# mint step: administration=write on its one repository; gha-ondemand: actions=read to list, and
# administration=write on the one repository whose idle runner it removes before a park), so a token
# that leaks from a cache or a process can do that and no more. Each distinct ask is cached apart.
#
#   /etc/askalf/gha-app.env  GHA_APP_ID=<id>             root:root 600
#   /etc/askalf/gha-app.pem  the App's private key       root:root 600
#
# An account may have an App of its own: a private App installs only on its owner, so the runner
# App (owned by askalf) can never reach the sprayberry-code org, whose rows need one owned by that
# org. When both of these are present, <account>'s token comes from that App and from no other:
#
#   /etc/askalf/gha-app.<account>.env  GHA_APP_ID=<id>   root:root 600
#   /etc/askalf/gha-app.<account>.pem  its private key   root:root 600
#
# Without them <account> uses the runner App, as every account did before. One of the two without
# the other is a mistake made by hand, so it exits 1 and says which, rather than quietly using the
# runner App. Every caller (the mint step, apply, gha-ondemand, and other host tools) names only the account,
# so none of them knows which App answered.
#
# Exit 3 when the App is not configured (either file missing or unreadable, or no id) and 4 when it
# is not installed on <account>, so a caller falls back to its token file; any other failure exits
# 1 with the reason on stderr. The token goes to stdout, for the caller's environment: never argv.
#
# Cached in $CACHE_DIR (tmpfs, root-only): each token until ten minutes before it expires (they last
# an hour), so a burst of runner cycles makes one token request, not one each; the installation id
# of each account, so a refresh is one request; and "not installed" for 15 minutes, so a row whose
# account the App is not installed on (a private App installs only on its owner) does not ask
# GitHub twice on every cycle. An account's own App caches under <account>.app<id>, apart from the
# runner App's <account> files, so the switch to it reuses no "not installed" answer and no
# installation id of the other App. A flock per account keeps concurrent cycles from minting at once.
set -euo pipefail

ACCOUNT="${1:?account}"
REPO="${2:-}"; [ "$REPO" = - ] && REPO=
PERMS="${3:-}"
APP_ENV="${GHA_APP_ENV:-/etc/askalf/gha-app.env}"
KEY="${GHA_APP_KEY:-/etc/askalf/gha-app.pem}"
OWNER_APP_DIR="${GHA_APP_OWNER_DIR:-/etc/askalf}"
CACHE_DIR="${GHA_APP_CACHE:-/run/askalf-gha-app}"
API="${GHA_API:-https://api.github.com}"
REUSE_MARGIN_SECS="${GHA_APP_REUSE_MARGIN_SECS:-600}"
NOT_INSTALLED_SECS="${GHA_APP_NOT_INSTALLED_SECS:-900}"

# Every argument ends up in a file name or a JSON body below, so each is held to the characters
# GitHub itself allows there.
case "$ACCOUNT" in *[!A-Za-z0-9-]*|'') echo "gha-app-token: bad account name: $ACCOUNT" >&2; exit 1 ;; esac
case "$REPO" in *[!A-Za-z0-9._-]*|.*) echo "gha-app-token: bad repository name: $REPO" >&2; exit 1 ;; esac
[ -z "$PERMS" ] || [[ "$PERMS" =~ ^[a-z_]+=(read|write)(,[a-z_]+=(read|write))*$ ]] \
  || { echo "gha-app-token: bad permissions: $PERMS (want name=read|write,...)" >&2; exit 1; }
# The account's own App, when it has one (the name was checked above, so it is safe in a path).
own_env="$OWNER_APP_DIR/gha-app.$ACCOUNT.env"; own_key="$OWNER_APP_DIR/gha-app.$ACCOUNT.pem"
own_app=0
if [ -e "$own_env" ] || [ -e "$own_key" ]; then
  [ -r "$own_env" ] && [ -r "$own_key" ] \
    || { echo "gha-app-token: $ACCOUNT's App needs both $own_env and $own_key, readable; not using it" >&2; exit 1; }
  APP_ENV=$own_env; KEY=$own_key; own_app=1
fi
[ -r "$APP_ENV" ] && [ -r "$KEY" ] || exit 3
APP_ID=$(grep -m1 '^GHA_APP_ID=' "$APP_ENV" | cut -d= -f2- | tr -d '"[:space:]' || true)
if [ "$own_app" = 1 ]; then
  [[ "$APP_ID" =~ ^[0-9]+$ ]] || { echo "gha-app-token: no numeric GHA_APP_ID in $own_env" >&2; exit 1; }
fi
[ -n "$APP_ID" ] || exit 3
tag=$ACCOUNT; [ "$own_app" = 0 ] || tag="$ACCOUNT.app$APP_ID"

umask 077
mkdir -p "$CACHE_DIR"
[ ! -L "$CACHE_DIR" ] || { echo "gha-app-token: $CACHE_DIR is a symlink; refusing" >&2; exit 1; }
chmod 700 "$CACHE_DIR"
scope="${REPO:-all}.${PERMS:-all}"; scope="${scope//=/-}"; scope="${scope//,/+}"
cache="$CACHE_DIR/$tag.$scope.token"
inst_cache="$CACHE_DIR/$tag.inst"
exec 9>"$CACHE_DIR/$ACCOUNT.lock"
flock -w 60 9 || { echo "gha-app-token: lock on $ACCOUNT busy for 60s" >&2; exit 1; }

now=$(date +%s)
if [ -s "$cache" ]; then
  read -r exp tok < "$cache" || true
  if [ -n "${tok:-}" ] && [ "${exp:-0}" -gt $((now + REUSE_MARGIN_SECS)) ] 2>/dev/null; then
    printf '%s\n' "$tok"
    exit 0
  fi
fi
inst=
if [ -s "$inst_cache" ]; then
  read -r inst inst_until < "$inst_cache" || true
  if [ "$inst" = none ]; then
    [ "${inst_until:-0}" -gt "$now" ] 2>/dev/null && exit 4
    inst=
  fi
  case "$inst" in *[!0-9]*) inst= ;; esac
fi

# The App's JWT: RS256 over {iat, exp, iss}, iat 60 s back for clock skew, exp inside GitHub's 10 min.
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
hdr=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
body=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' $((now - 60)) $((now + 540)) "$APP_ID" | b64url)
sig=$(printf '%s.%s' "$hdr" "$body" | openssl dgst -sha256 -sign "$KEY" -binary | b64url)
jwt="$hdr.$body.$sig"
# The bearer goes to curl as a header file on a pipe, not in argv where ps would show it.
call() {
  curl -fsS --max-time 20 -H @<(printf 'Authorization: Bearer %s\n' "$jwt") \
    -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' "$@"
}

# One top-level field of the JSON on stdin, empty when absent. node, not jq: node is on every host
# that runs this (the box, and the runners its tests run on); jq is not. The JSON, a token included,
# goes in on stdin, never in argv.
jget() { node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{let v;try{v=JSON.parse(s)[process.argv[1]]}catch{}process.stdout.write(v==null?"":String(v))})' "$1"; }

# The installation on <account>: a user's and an organization's are asked for at different paths.
if [ -z "$inst" ]; then
  inst=$(call "$API/users/$ACCOUNT/installation" 2>/dev/null | jget id || true)
  [ -n "$inst" ] || inst=$(call "$API/orgs/$ACCOUNT/installation" 2>/dev/null | jget id || true)
  case "$inst" in *[!0-9]*) inst= ;; esac
  if [ -z "$inst" ]; then
    printf 'none %s\n' $((now + NOT_INSTALLED_SECS)) > "$inst_cache"
    echo "gha-app-token: the App (id $APP_ID) is not installed on $ACCOUNT" >&2
    exit 4
  fi
  printf '%s\n' "$inst" > "$inst_cache"
fi

# The narrowing, as the token request's body. Every value was checked above.
ask='{'
[ -z "$REPO" ] || ask="$ask\"repositories\":[\"$REPO\"]"
if [ -n "$PERMS" ]; then
  [ "$ask" = '{' ] || ask="$ask,"
  ask="$ask\"permissions\":{$(printf '%s' "$PERMS" | sed -E 's/([a-z_]+)=(read|write)/"\1":"\2"/g')}"
fi
ask="$ask}"

if ! resp=$(call -X POST -H 'Content-Type: application/json' --data "$ask" "$API/app/installations/$inst/access_tokens"); then
  # An installation removed or replaced since its id was cached answers 404: ask for the id again
  # next time instead of failing on the cached one until the box restarts.
  rm -f -- "$inst_cache"
  echo "gha-app-token: token request for installation $inst failed ($ask)" >&2
  exit 1
fi
tok=$(jget token <<<"$resp")
exp=$(date -d "$(jget expires_at <<<"$resp")" +%s 2>/dev/null || true)
[ -n "$tok" ] && [ -n "$exp" ] || { echo "gha-app-token: no token in the response for installation $inst" >&2; exit 1; }

tmp="$cache.$$"
printf '%s %s\n' "$exp" "$tok" > "$tmp"
mv -f -- "$tmp" "$cache"
printf '%s\n' "$tok"
