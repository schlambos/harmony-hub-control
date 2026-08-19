#!/bin/sh
# Quarantined footprint measurement for the six setup pages.
# Replicates tools/package_harmony_shell.sh without writing under payload/.
set -eu

REPO=${REPO:-/Users/matt/Documents/Codex/2026-07-26/ro/work/harmony-hub-control}
BUN=${BUN:-/Users/matt/.bun/bin/bun}
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SRC="$HERE/src"
OUT="$HERE/out"
ASSETS="$HERE/assets"
SIM_PUBLIC="$REPO/tools/webui-sim/public"

mkdir -p "$SRC" "$OUT" "$ASSETS"

# Inputs copied from payload into the quarantine only. payload/ is never written.
cp "$REPO/payload/source/codex_webui.c" "$SRC/codex_webui.c"
cp "$REPO/payload/source/activity_ui_assets.h" "$SRC/activity_ui_assets.h"
cp "$REPO/payload/source/remote_skin_jpg.h" "$SRC/remote_skin_jpg.h"

# 1. Bundle/minify all ES modules, including the six setup views.
"$BUN" build "$SIM_PUBLIC/js/app.js" \
  --target=browser --format=iife --minify --sourcemap=none \
  --outfile="$ASSETS/harmony-shell.js" >/dev/null 2>&1

# 2. Bundle/minify the production CSS entry.
: > "$ASSETS/shell-entry.css"
for css in \
  "$SIM_PUBLIC/css/tokens.css" \
  "$SIM_PUBLIC/css/app.css" \
  "$SIM_PUBLIC/css/remote.css" \
  "$SIM_PUBLIC/css/wizard.css" \
  "$SIM_PUBLIC/css/activity-overrides.css"
do
  printf '@import "%s";\n' "$css" >> "$ASSETS/shell-entry.css"
done
"$BUN" build "$ASSETS/shell-entry.css" \
  --minify --sourcemap=none \
  --outfile="$ASSETS/harmony-shell.css" >/dev/null 2>&1

# 3. Same production HTML transform as package_harmony_shell.sh.
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
    print "  <script>globalThis.REMOTE_SKIN_SRC='"'"'data:image/jpeg;base64,"
    next
  }
  /<\/head>/ {
    print "'"'"';</script>"
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
' "$SIM_PUBLIC/index.html" > "$ASSETS/index.html"

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

MARKER="<script>globalThis.REMOTE_SKIN_SRC='data:image/jpeg;base64,"
MARKER_COUNT=$(grep -F -c -- "$MARKER" "$ASSETS/index.html" || true)
if [ "$MARKER_COUNT" != "1" ]; then
  echo "measure.sh: skin seam marker missing or ambiguous (count=$MARKER_COUNT)" >&2
  exit 1
fi
awk -v marker="$MARKER" -v head_file="$ASSETS/index-head.html" -v tail_file="$ASSETS/index-tail.html" '
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
' "$ASSETS/index.html"

{
  printf '/* Quarantined setup-pages measurement — do not edit. */\n'
  printf '#ifndef CODEX_HARMONY_SHELL_ASSETS_H\n'
  printf '#define CODEX_HARMONY_SHELL_ASSETS_H\n\n'
  emit_array harmony_index_head "$ASSETS/index-head.html"
  emit_array harmony_index_tail "$ASSETS/index-tail.html"
  emit_array harmony_shell_js "$ASSETS/harmony-shell.js"
  emit_array harmony_shell_css "$ASSETS/harmony-shell.css"
  printf '#endif\n'
} > "$SRC/harmony_shell_assets.h"

# BEFORE validates the quarantined compile recipe against the deployed header.
cp "$REPO/payload/source/harmony_shell_assets.h" "$SRC/harmony_shell_assets_baseline.h"
cp "$SRC/harmony_shell_assets.h" "$SRC/harmony_shell_assets_after.h"
cp "$SRC/harmony_shell_assets_baseline.h" "$SRC/harmony_shell_assets.h"
zig cc -target mips-linux-musleabi -Os -static -s \
  -I "$SRC" -o "$OUT/codex_webui.BEFORE" "$SRC/codex_webui.c"
cp "$SRC/harmony_shell_assets_after.h" "$SRC/harmony_shell_assets.h"
zig cc -target mips-linux-musleabi -Os -static -s \
  -I "$SRC" -o "$OUT/codex_webui.AFTER" "$SRC/codex_webui.c"

before_raw=$(wc -c < "$OUT/codex_webui.BEFORE" | tr -d ' ')
after_raw=$(wc -c < "$OUT/codex_webui.AFTER" | tr -d ' ')
before_gz=$(gzip -9c "$OUT/codex_webui.BEFORE" | wc -c | tr -d ' ')
after_gz=$(gzip -9c "$OUT/codex_webui.AFTER" | wc -c | tr -d ' ')

printf 'BEFORE raw %s gzip %s\n' "$before_raw" "$before_gz"
printf 'AFTER  raw %s gzip %s\n' "$after_raw" "$after_gz"
printf 'DELTA  raw %s gzip %s\n' "$((after_raw - before_raw))" "$((after_gz - before_gz))"
