#!/bin/sh
# bundle-shell.sh — package the Melodious web shell and copy the five bundle
# files into desktop/build/shell/. Fails closed if packaging changes
# payload/source/harmony_shell_assets.h so the desktop app always carries
# the exact bundle embedded in codex_webui.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DESKTOP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$DESKTOP_DIR/.." && pwd)

HEADER="$REPO_ROOT/payload/source/harmony_shell_assets.h"
SIM_BUILD="$REPO_ROOT/tools/webui-sim/build"
VENDOR_DIR="$REPO_ROOT/tools/webui-sim/public/vendor"
OUT_DIR="$DESKTOP_DIR/build/shell"

if [ ! -f "$HEADER" ]; then
  echo "bundle-shell: missing $HEADER" >&2
  exit 1
fi

if ! git -C "$REPO_ROOT" diff --quiet -- payload/source/harmony_shell_assets.h; then
  echo "bundle-shell: payload/source/harmony_shell_assets.h already has uncommitted changes" >&2
  exit 1
fi

# Git Bash on Windows has sha256sum but not always shasum.
sha256() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

BEFORE_SHA=$(sha256 "$HEADER")

sh "$REPO_ROOT/tools/package_harmony_shell.sh"

AFTER_SHA=$(sha256 "$HEADER")

if [ "$BEFORE_SHA" != "$AFTER_SHA" ] || ! git -C "$REPO_ROOT" diff --quiet -- payload/source/harmony_shell_assets.h; then
  echo "bundle-shell: payload/source/harmony_shell_assets.h changed after packaging ($BEFORE_SHA -> $AFTER_SHA)" >&2
  exit 1
fi

if grep -q "REMOTE_SKIN_SRC" "$SIM_BUILD/index.html"; then
  echo "bundle-shell: unexpected REMOTE_SKIN_SRC in $SIM_BUILD/index.html" >&2
  exit 1
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

cp "$SIM_BUILD/index.html" "$OUT_DIR/index.html"
cp "$SIM_BUILD/harmony-shell.js" "$OUT_DIR/harmony-shell.js"
cp "$SIM_BUILD/harmony-shell.css" "$OUT_DIR/harmony-shell.css"
cp "$VENDOR_DIR/activity-ui.js" "$OUT_DIR/activity-ui.js"
cp "$VENDOR_DIR/activity-ui.css" "$OUT_DIR/activity-ui.css"

for f in index.html harmony-shell.js harmony-shell.css activity-ui.js activity-ui.css; do
  if [ ! -s "$OUT_DIR/$f" ]; then
    echo "bundle-shell: missing or empty output $OUT_DIR/$f" >&2
    exit 1
  fi
done

echo "bundle-shell: staged 5 files in $OUT_DIR"
