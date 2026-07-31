#!/bin/sh
# package_harmony_shell.sh — deterministic production packaging for the
# flash-safe harmony shell embed (docs/FOOTPRINT_AUDIT.md, DEDUP_MIN class).
#
# Inputs   tools/webui-sim/public/  (validated sim UI — single source of truth)
# Outputs  payload/source/harmony_shell_assets.h   (embedded C arrays)
#          tools/webui-sim/build/                  (inspectable intermediates)
#
# What it does, in order:
#   1. bun build js/app.js  -> one minified IIFE  -> harmony-shell.js
#   2. bun bundling of an @import entry over tokens/app/remote/wizard/
#      activity-overrides CSS -> one minified     -> harmony-shell.css
#   3. awk transform of index.html -> production HTML:
#        - Google Fonts preconnect/stylesheet stripped (hub is offline)
#        - one stylesheet (/assets/harmony-shell.css) + one classic script
#          (/assets/harmony-shell.js), no ES-module loading
#        - simulated-hub wording replaced with local/offline wording
#        - HARMONY_SIM flag rewritten to false + HARMONY_PRODUCTION=true
#        - head split at the REMOTE_SKIN_SRC base64 seam; codex_webui.c
#          injects the pre-existing REMOTE_SKIN_JPG_B64 there at request
#          time (the JPEG is never embedded or served a second time)
#   4. od/awk byte arrays (NUL-terminated text) into harmony_shell_assets.h
#
# Vendor dedup: payload/web/activity-ui.* arrays live in activity_ui_assets.h
# (tools/embed_activity_ui.sh) and are NOT regenerated or copied here; the
# shell lazy-loads /assets/activity-ui.js|css at editor open.
#
# Determinism: no timestamps, stable inputs, bun --sourcemap=none.
# Same bun version + same inputs => byte-identical outputs (asserted by
# tools/harmony_shell_smoke.mjs).
#
# Run:  sh tools/package_harmony_shell.sh
# Bun:  defaults to /Users/matt/.bun/bin/bun, override with BUN=/path/to/bun
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

BUN=${BUN:-/Users/matt/.bun/bin/bun}
if [ ! -x "$BUN" ]; then
  echo "package_harmony_shell: bun not found at $BUN (set BUN=/path/to/bun)" >&2
  exit 1
fi

SIM_PUBLIC="$REPO_ROOT/tools/webui-sim/public"
BUILD_DIR="$REPO_ROOT/tools/webui-sim/build"
OUT="$REPO_ROOT/payload/source/harmony_shell_assets.h"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

mkdir -p "$BUILD_DIR"

# -- 1. shell JS: bundle all ES modules into one minified IIFE --------------
"$BUN" build "$SIM_PUBLIC/js/app.js" \
  --target=browser --format=iife --minify --sourcemap=none \
  --outfile="$TMP/harmony-shell.js" >/dev/null 2>&1

# -- 2. shell CSS: concatenate via @import, minify --------------------------
: > "$TMP/shell-entry.css"
for css in \
  "$SIM_PUBLIC/css/tokens.css" \
  "$SIM_PUBLIC/css/app.css" \
  "$SIM_PUBLIC/css/remote.css" \
  "$SIM_PUBLIC/css/wizard.css" \
  "$SIM_PUBLIC/css/activity-overrides.css"
do
  printf '@import "%s";\n' "$css" >> "$TMP/shell-entry.css"
done
"$BUN" build "$TMP/shell-entry.css" \
  --minify --sourcemap=none \
  --outfile="$TMP/harmony-shell.css" >/dev/null 2>&1

# -- 3. production HTML transform --------------------------------------------
# The awk rules are the whole transform; each pattern matches one literal
# line of tools/webui-sim/public/index.html. Anything unrecognized passes
# through untouched so the validated markup is preserved byte-for-byte.
awk '
  /fonts\.googleapis\.com|fonts\.gstatic\.com/ { next }
  /css\/app\.css|css\/remote\.css|css\/wizard\.css/ { next }
  /css\/tokens\.css/ {
    print "  <link rel=\"stylesheet\" href=\"/assets/harmony-shell.css\">"
    next
  }
  /window\.HARMONY_SIM = true;/ {
    print "  <script>window.HARMONY_SIM=false;window.HARMONY_PRODUCTION=true;</script>"
    next
  }
  /Runtime flag: this page is the simulation/ {
    print "  <!-- Runtime flag: production shell served by codex_webui, fully offline. -->"
    next
  }
  /<script type="module" src="js\/app\.js"><\/script>/ {
    # Seam: codex_webui.c appends REMOTE_SKIN_JPG_B64 after this prefix,
    # then harmony_index_tail, so REMOTE_SKIN_SRC exists before shell JS.
    # Must be a globalThis property: a top-level const stays in the global
    # lexical scope, invisible to the globalThis.REMOTE_SKIN_SRC lookup
    # inside the separate shell script.
    print "  <script>globalThis.REMOTE_SKIN_SRC='"'"'data:image/jpeg;base64,"
    next
  }
  /<\/head>/ {
    print "'"'"';</script>"
    # defer: the shell is a classic (non-module) script in <head> and must
    # run after the body is parsed, exactly like the module it replaces.
    print "  <script src=\"/assets/harmony-shell.js\" defer></script>"
    print
    next
  }
  /<title>Harmony Hub Control/ {
    print "  <title>Harmony Hub Control</title>"
    next
  }
  /Local control surface for a simulated Harmony hub/ {
    print "  <meta name=\"description\" content=\"Local control surface for the Harmony hub: activities, virtual remote, and device IR. Fully offline.\">"
    next
  }
  /Simulated hub<\/span>/ {
    print "        <span class=\"pill pill-sim\">Local hub · offline</span>"
    next
  }
  { print }
' "$SIM_PUBLIC/index.html" > "$TMP/index.html"

# -- 4. emit embedded C arrays ------------------------------------------------
# Text arrays are NUL-terminated so codex_webui.c can fputs() them; *_len is
# the payload byte count excluding the terminator (Content-Length exact).
emit_array() {
  name=$1
  file=$2
  length=$(wc -c < "$file" | tr -d ' ')
  printf 'static const unsigned char %s[] = {\n' "$name"
  od -An -v -t u1 "$file" | awk '
    {
      for (i = 1; i <= NF; i++) {
        printf "0x%02x,", $i
        column++
        if (column == 16) {
          printf "\n"
          column = 0
        }
      }
    }
    END {
      if (column != 0) printf "\n"
    }
  '
  printf '0x00,\n'
  printf '};\nstatic const unsigned int %s_len = %s;\n\n' "$name" "$length"
}

# Split at the seam marker: head ends exactly at the marker (printf, NO
# trailing newline — a newline inside the single-quoted REMOTE_SKIN_SRC
# literal would be a JS syntax error once codex_webui.c injects the B64),
# tail starts at the closing quote of the base64 string.
MARKER="<script>globalThis.REMOTE_SKIN_SRC='data:image/jpeg;base64,"
MARKER_COUNT=$(grep -F -c -- "$MARKER" "$TMP/index.html" || true)
if [ "$MARKER_COUNT" != "1" ]; then
  echo "package_harmony_shell: skin seam marker missing or ambiguous in production HTML (count=$MARKER_COUNT)" >&2
  exit 1
fi
awk -v marker="$MARKER" -v head_file="$TMP/index-head.html" -v tail_file="$TMP/index-tail.html" '
  {
    idx = index($0, marker)
    if (idx > 0) {
      printf "%s", substr($0, 1, idx + length(marker) - 1) > head_file
      rest = substr($0, idx + length(marker))
      if (rest != "") print rest > tail_file
      seen = 1
    } else if (seen) {
      print > tail_file
    } else {
      print > head_file
    }
  }
' "$TMP/index.html"

{
  printf '/* Generated by tools/package_harmony_shell.sh — do not edit. */\n'
  printf '#ifndef CODEX_HARMONY_SHELL_ASSETS_H\n'
  printf '#define CODEX_HARMONY_SHELL_ASSETS_H\n\n'
  emit_array harmony_index_head "$TMP/index-head.html"
  emit_array harmony_index_tail "$TMP/index-tail.html"
  emit_array harmony_shell_js "$TMP/harmony-shell.js"
  emit_array harmony_shell_css "$TMP/harmony-shell.css"
  printf '#endif\n'
} > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"

cp "$TMP/harmony-shell.js" "$BUILD_DIR/harmony-shell.js"
cp "$TMP/harmony-shell.css" "$BUILD_DIR/harmony-shell.css"
cp "$TMP/index.html" "$BUILD_DIR/index.html"

echo "package_harmony_shell: wrote $OUT"
wc -c "$TMP/harmony-shell.js" "$TMP/harmony-shell.css" "$TMP/index.html" | awk '{print "  " $1 " B  " $2}'
