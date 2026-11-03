#!/usr/bin/env bash
# box-ci's two tools on the host, pinned: act (the workflow runner) and the Chromium that
# playwright-core drives in an end-to-end workflow. Installed by hand they sit in no manifest and
# have no pin, so a rebuilt host has no way to get them back and nothing notices if they change.
#
#   bash install-tools.sh          check: prints what is installed against the pins, exit 1 on any gap
#   bash install-tools.sh apply    installs or replaces whatever does not match
#
# Runs as root on the box. Every command takes </dev/null so the script also works fed to bash on
# stdin. Needs curl, tar, sha256sum, node and npm, all present on the host.
#
# PW_VERSION must equal the PW_VERSION the e2e workflow (.github/workflows/box-e2e.yml) exports: that
# job installs playwright-core at that version and expects the Chromium of the same release under
# PW_BROWSERS. Move the two together.
set -euo pipefail

ACT_VERSION=0.2.89
# sha256 of act_Linux_x86_64.tar.gz from the release's checksums.txt, then of the act binary inside it.
ACT_TARBALL_SHA256=0191d6f1f3b716b5c55820032605d05fc3c1cdbf581ebeff655019e5dd1524c0
ACT_BIN_SHA256=6be37b104430efc210d5130495bedcff2dc7cd6780a38d88f3d205e7f1185cc1
# Where both tools live; BOX_CI_DIR moves them (the installer test points it at a temporary directory).
BOX_CI_DIR="${BOX_CI_DIR:-/opt/box-ci}"
ACT_BIN="$BOX_CI_DIR/act"

PW_VERSION=1.63.0
# The registry's sha512 for that version's tarball (`npm view playwright-core@<version> dist.integrity`).
# npm ci checks it, so the install is pinned by hash, not only by version. Move it with PW_VERSION.
PW_INTEGRITY=sha512-rYCsBF/M5HjUch52bbtVONEFjv6Xu8sm8h72dNlR5bzIE1fvC/bxgspzkjSfU+MweEMmPM8KJebG6nnyxo5mCg==
PW_BROWSERS="$BOX_CI_DIR/pw-browsers"

MODE="${1:-check}"
case "$MODE" in check|apply) ;; *) echo "usage: $0 [check|apply]"; exit 2 ;; esac
[ "$(id -u </dev/null)" = 0 ] || { echo "run as root"; exit 1; }

gaps=0
sha_of() { sha256sum "$1" </dev/null | cut -c1-64; }

# --- act ---
act_ok=0
if [ -x "$ACT_BIN" ] && [ "$(sha_of "$ACT_BIN")" = "$ACT_BIN_SHA256" ]; then
  echo "act: $ACT_VERSION at $ACT_BIN (sha256 matches)"; act_ok=1
elif [ -e "$ACT_BIN" ]; then
  echo "act: $ACT_BIN is not the pinned $ACT_VERSION build ($("$ACT_BIN" --version </dev/null 2>/dev/null || echo unreadable))"
else
  echo "act: missing at $ACT_BIN"
fi
if [ "$act_ok" = 0 ]; then
  gaps=$((gaps + 1))
  if [ "$MODE" = apply ]; then
    tmp="$(mktemp -d </dev/null)"
    trap 'rm -rf "$tmp"' EXIT
    curl -sSLo "$tmp/act.tgz" "https://github.com/nektos/act/releases/download/v${ACT_VERSION}/act_Linux_x86_64.tar.gz" </dev/null
    [ "$(sha_of "$tmp/act.tgz")" = "$ACT_TARBALL_SHA256" ] || { echo "act: tarball sha256 does not match the pin; nothing installed"; exit 1; }
    tar -xzf "$tmp/act.tgz" -C "$tmp" act </dev/null
    [ "$(sha_of "$tmp/act")" = "$ACT_BIN_SHA256" ] || { echo "act: binary sha256 does not match the pin; nothing installed"; exit 1; }
    install -d -m 755 "$(dirname "$ACT_BIN")" </dev/null
    # install writes a new inode and renames nothing, so a running act keeps its old mapping.
    install -m 755 "$tmp/act" "$ACT_BIN" </dev/null
    echo "act: installed $ACT_VERSION at $ACT_BIN"
  fi
fi

# --- Chromium for playwright-core ---
# The browser directory names carry Playwright's build number, not the package version, so the
# check asks the pinned playwright-core which build it wants and looks for that one.
pw_dir="$BOX_CI_DIR/pw-install"
pw_ok=0
if [ -d "$PW_BROWSERS" ] && find "$PW_BROWSERS" -maxdepth 3 -type f -name chrome </dev/null 2>/dev/null | grep -q .; then
  if [ -f "$pw_dir/node_modules/playwright-core/package.json" ] && [ "$(node -p "require('$pw_dir/node_modules/playwright-core/package.json').version" </dev/null)" = "$PW_VERSION" ]; then
    want="$(node -p "require('$pw_dir/node_modules/playwright-core/browsers.json').browsers.find(b => b.name === 'chromium').revision" </dev/null)"
    if [ -d "$PW_BROWSERS/chromium-$want" ]; then echo "chromium: build $want for playwright-core $PW_VERSION under $PW_BROWSERS"; pw_ok=1
    else echo "chromium: $PW_BROWSERS has no chromium-$want (playwright-core $PW_VERSION wants it)"; fi
  else
    echo "chromium: present under $PW_BROWSERS but $pw_dir does not hold playwright-core $PW_VERSION, so the build cannot be checked"
  fi
else
  echo "chromium: missing under $PW_BROWSERS"
fi
if [ "$pw_ok" = 0 ]; then
  gaps=$((gaps + 1))
  if [ "$MODE" = apply ]; then
    install -d -m 755 "$pw_dir" "$PW_BROWSERS" </dev/null
    # A package.json and a lockfile written here, then npm ci: the tarball must match PW_INTEGRITY, and
    # playwright-core has no dependencies, so the lockfile has one entry.
    printf '{"name":"box-ci-pw-install","private":true,"dependencies":{"playwright-core":"%s"}}\n' "$PW_VERSION" > "$pw_dir/package.json"
    printf '{"name":"box-ci-pw-install","lockfileVersion":3,"requires":true,"packages":{"":{"name":"box-ci-pw-install","dependencies":{"playwright-core":"%s"}},"node_modules/playwright-core":{"version":"%s","resolved":"https://registry.npmjs.org/playwright-core/-/playwright-core-%s.tgz","integrity":"%s","license":"Apache-2.0","bin":{"playwright-core":"cli.js"}}}}\n' \
      "$PW_VERSION" "$PW_VERSION" "$PW_VERSION" "$PW_INTEGRITY" > "$pw_dir/package-lock.json"
    (cd "$pw_dir" && npm ci --no-audit --no-fund </dev/null >/dev/null)
    # chromium alone: the e2e uses no other browser, and the headless shell comes with it.
    PLAYWRIGHT_BROWSERS_PATH="$PW_BROWSERS" "$pw_dir/node_modules/.bin/playwright-core" install chromium </dev/null
    # The run account only reads the browser; the directory stays root's.
    chmod -R a+rX "$PW_BROWSERS" </dev/null
    echo "chromium: installed for playwright-core $PW_VERSION under $PW_BROWSERS"
  fi
fi

if [ "$MODE" = check ]; then
  [ "$gaps" = 0 ] && echo "ok: both tools match their pins" || { echo "$gaps gap(s): run with apply"; exit 1; }
fi
