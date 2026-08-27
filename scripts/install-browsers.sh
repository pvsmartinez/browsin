#!/bin/bash
# Installs the two Chromium builds browsin drives, straight from Google's
# Chrome-for-Testing CDN. No Playwright, no npm, no Homebrew.
#
#   headless-shell/  the default: no UI layer, cannot appear on screen (~196 MB)
#   chromium/        only for `browsin login`, which needs a real window (~356 MB)
#
# Usage: scripts/install-browsers.sh [--force] [--shell-only]
set -euo pipefail

DST="${BROWSIN_BROWSERS:-$HOME/Library/Caches/browsin}"
META="https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json"
FORCE=0; SHELL_ONLY=0
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    --shell-only) SHELL_ONLY=1 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

case "$(uname -sm)" in
  "Darwin arm64") PLAT=mac-arm64 ;;
  "Darwin x86_64") PLAT=mac-x64 ;;
  *)
    cat >&2 <<MSG
este instalador cobre só macOS (arm64 ou x86_64); achei: $(uname -sm)

Em outro sistema, aponte o browsin para um Chromium que você já tenha:
  export BROWSIN_CHROME=/usr/bin/google-chrome
ou instale o chrome-headless-shell na mão e aponte a pasta:
  export BROWSIN_BROWSERS=/caminho/com/headless-shell
MSG
    exit 1 ;;
esac

say() { printf '  %s\n' "$*"; }

json=$(curl -fsSL "$META")
version=$(printf '%s' "$json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["channels"]["Stable"]["version"])')
url_for() {
  printf '%s' "$json" | python3 -c '
import json,sys
d=json.load(sys.stdin)["channels"]["Stable"]["downloads"][sys.argv[1]]
print(next(x["url"] for x in d if x["platform"]==sys.argv[2]))' "$1" "$PLAT"
}

echo "Chrome for Testing $version ($PLAT) -> $DST"
mkdir -p "$DST"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

install_one() { # <download-key> <dest-subdir> <probe-relative-path>
  local key="$1" sub="$2" probe="$3"
  if [ -e "$DST/$sub/$probe" ] && [ "$FORCE" -eq 0 ]; then
    say "$sub already installed (--force to replace)"
    return
  fi
  say "downloading ${key} ..."
  curl -fsSL -o "$tmp/$sub.zip" "$(url_for "$key")"
  say "extracting ..."
  rm -rf "$DST/$sub"
  # ditto, not unzip: it is the only copy that keeps an .app bundle's signature.
  ditto -x -k "$tmp/$sub.zip" "$tmp/$sub-raw"
  ditto "$tmp/$sub-raw/$(ls "$tmp/$sub-raw" | head -1)" "$DST/$sub"
  [ -e "$DST/$sub/$probe" ] || { echo "install failed: $DST/$sub/$probe missing" >&2; exit 1; }
  say "$sub ok ($(du -sh "$DST/$sub" | cut -f1))"
}

install_one chrome-headless-shell headless-shell chrome-headless-shell
if [ "$SHELL_ONLY" -eq 0 ]; then
  install_one chrome chromium "Google Chrome for Testing.app"
else
  say "skipping full chromium (--shell-only): browsin login will not work"
fi

printf '%s\n' "$version" > "$DST/VERSION"

# Compatibility shim (optional): a project that uses Playwright *as a library*
# resolves its
# browser by Playwright's own directory layout and pinned revision. Pointing
# PLAYWRIGHT_BROWSERS_PATH here lets it drive the browsers browsin already owns,
# instead of downloading a second ~1 GB copy. Revisions are just directory names
# to Playwright, so one symlink per name it might ask for is enough.
COMPAT="$DST/playwright-compat"
if [ "$SHELL_ONLY" -eq 0 ]; then
  say "playwright-compat shim ..."
  rm -rf "$COMPAT"
  for rev in 1228 1234 1240; do
    mkdir -p "$COMPAT/chromium_headless_shell-$rev" "$COMPAT/chromium-$rev"
    ln -sfn "$DST/headless-shell" "$COMPAT/chromium_headless_shell-$rev/chrome-headless-shell-$PLAT"
    ln -sfn "$DST/chromium" "$COMPAT/chromium-$rev/chrome-$PLAT"
  done
  say "  export PLAYWRIGHT_BROWSERS_PATH=$COMPAT"
fi

echo
"$DST/headless-shell/chrome-headless-shell" --version
echo "Done. browsin will find these automatically."
