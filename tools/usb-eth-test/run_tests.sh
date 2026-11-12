#!/bin/sh
# Direct USB Ethernet tests: helper pure logic (host-compiled C) and the
# real service script against a scripted sandbox, and the egress guard's USB
# Ethernet parts. No hub required.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
cc -Wall -Wextra -Wno-deprecated-declarations \
  -o "$TMP/test_usbeth_logic" "$HERE/test_usbeth_logic.c"
"$TMP/test_usbeth_logic"
python3 "$HERE/test_service.py"
python3 "$HERE/test_guard.py"
