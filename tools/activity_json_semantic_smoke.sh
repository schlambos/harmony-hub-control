#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/harmony-json-semantic.XXXXXX")
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM

CC=${CC:-cc}
"$CC" -O2 -DCODEX_WEBUI_SEMANTIC_TEST \
    -I"$REPO_ROOT/payload/source" \
    "$REPO_ROOT/payload/source/codex_webui.c" \
    -o "$TEST_DIR/activity-json-semantic-smoke"
"$TEST_DIR/activity-json-semantic-smoke"
