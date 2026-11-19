#!/bin/sh
# Builds and runs tools/webos/wol_test.c: unit tests for codex_webos's
# Wake-on-LAN, MAC validation, SSRF guard, and discrete PowerOn honesty.
# Zero packets are sent on the network.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
bearssl=${BEARSSL:-$root/build/tmp/bearssl-0.6}
if [ ! -f "$bearssl/inc/bearssl.h" ]; then
  echo "wol_test: BearSSL 0.6 not found at $bearssl; set BEARSSL" >&2
  exit 2
fi
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT INT TERM
# shellcheck disable=SC2046,SC2086
${CC:-cc} -std=gnu11 -O1 -g -Wall -Wextra -Wno-unused-function -Wno-unused-parameter -Wno-format-truncation \
  -I"$bearssl/inc" -I"$bearssl/src" -o "$out/wol_test" "$here/wol_test.c" \
  $(find "$bearssl/src" -name '*.c' | LC_ALL=C sort)
"$out/wol_test"
