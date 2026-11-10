#!/bin/sh
# Builds and runs tools/androidtv/wol_test.c: codex_androidtv's Wake-on-LAN with
# fake interfaces, nothing sent on the network. It needs BearSSL 0.6 unpacked as
# for the codex_androidtv build (docs/BUILD.md); set BEARSSL to use another copy,
# and CC for another compiler (default cc; "zig cc" works too).
#
#   sh tools/androidtv/wol_test.sh
#
# MIT License, Copyright (c) 2026 Josh Lukens.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
bearssl=${BEARSSL:-$root/build/tmp/bearssl-0.6}
if [ ! -f "$bearssl/inc/bearssl.h" ]; then
  echo "wol_test: BearSSL 0.6 not found at $bearssl (see docs/BUILD.md, codex_androidtv); set BEARSSL" >&2
  exit 2
fi
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT INT TERM
# shellcheck disable=SC2046,SC2086
${CC:-cc} -std=gnu11 -O1 -g -Wall -Wextra -Wno-unused-function -Wno-unused-parameter -Wno-format-truncation \
  -I"$bearssl/inc" -I"$bearssl/src" -o "$out/wol_test" "$here/wol_test.c" \
  $(find "$bearssl/src" -name '*.c' | LC_ALL=C sort)
"$out/wol_test"
