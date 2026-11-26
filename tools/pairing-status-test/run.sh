#!/bin/sh
# Builds and runs test_pairing_status.c with codex_webui's DeviceList, the
# engine's cookies and the pairing markers in a fresh directory, with the
# pairing-kinds fixture the web app's tests share. Run from the repository
# root (tools/ci/run_suites.sh does).
set -e
dir=$(mktemp -d "${TMPDIR:-/tmp}/codex-pairing-status.XXXXXX")
trap 'rm -rf "$dir"' EXIT
${CC:-cc} -std=gnu99 -O1 -w -I payload/source \
  -DTEST_DIR="\"$dir\"" \
  -DDEVICE_LIST="\"$dir/DeviceList.json\"" \
  -DENGINE_COOKIES="\"$dir/cookies\"" \
  -DENGINE_SETTINGS="\"$dir/settings\"" \
  -DPAIRING_MARKER_DIR="\"$dir/markers\"" \
  -o "$dir/test" tools/pairing-status-test/test_pairing_status.c
cp tools/webui-sim/fixtures/pairing-kinds.json "$dir/kinds.json"
"$dir/test"
