#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
OUT="$REPO_ROOT/payload/source/activity_ui_assets.h"
TMP="$OUT.tmp"

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
  printf '};\nstatic const unsigned int %s_len = %s;\n\n' "$name" "$length"
}

{
  printf '#ifndef CODEX_ACTIVITY_UI_ASSETS_H\n'
  printf '#define CODEX_ACTIVITY_UI_ASSETS_H\n\n'
  emit_array activity_ui_css "$REPO_ROOT/payload/web/activity-ui.css"
  emit_array activity_ui_js "$REPO_ROOT/payload/web/activity-ui.js"
  printf '#endif\n'
} > "$TMP"

mv "$TMP" "$OUT"
