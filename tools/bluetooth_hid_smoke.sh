#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/codex-bthid-smoke.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM

CC_BIN=${CC:-cc}
"$CC_BIN" -std=gnu99 -Wall -Wextra -o "$TMP_DIR/codex_bthid_keyboard" \
  "$ROOT/payload/source/codex_bthid_keyboard.c"
"$TMP_DIR/codex_bthid_keyboard" --self-test

"$CC_BIN" -std=gnu99 -Wall -Wextra -fsyntax-only \
  "$ROOT/payload/source/codex_hal_ltcp.c"
"$CC_BIN" -std=gnu99 -Wall -Wextra -fsyntax-only \
  "$ROOT/payload/source/codex_webui.c"
"$CC_BIN" -std=gnu99 -Wall -Wextra -fsyntax-only \
  "$ROOT/payload/source/codex_bt_pair_agent.c"

grep -q 'no live Bluetooth HID connection' \
  "$ROOT/payload/source/codex_bthid_keyboard.c"
grep -q 'last_native_code != 200' \
  "$ROOT/payload/source/codex_bthid_keyboard.c"
grep -q 'native_hid_ready' \
  "$ROOT/payload/source/codex_bthid_keyboard.c"
grep -q 'ensure_bthid_report_ready' \
  "$ROOT/payload/source/codex_hal_ltcp.c"
grep -q 'refusing bthid.report while native HID state is not connected' \
  "$ROOT/payload/source/codex_hal_ltcp.c"
grep -q 'O_WRONLY | O_CREAT | O_EXCL' \
  "$ROOT/payload/source/codex_bthid_keyboard.c"
grep -q 'profileRegistered' \
  "$ROOT/payload/source/codex_webui.c"
grep -q 'start_bt_pair_agent' \
  "$ROOT/payload/source/codex_webui.c"
grep -q 'ensure_bt_hid_control_runtime' \
  "$ROOT/payload/source/codex_webui.c"
grep -q 'bt_connection_authenticated' \
  "$ROOT/payload/source/codex_webui.c"
grep -q 'ensure_ir_bluetooth_connection' \
  "$ROOT/payload/source/codex_webui.c"
grep -q 'find_ir_bluetooth_target' \
  "$ROOT/payload/source/codex_webui.c"
grep -q 'bt_preconnect' \
  "$ROOT/payload/source/codex_webui.c"
grep -q 'btConnectionBadge' \
  "$ROOT/payload/source/codex_webui.c"
grep -q 'btRefreshStatus' \
  "$ROOT/payload/source/codex_webui.c"
grep -q -- '--hid-control-daemon' \
  "$ROOT/payload/source/codex_bt_pair_agent.c"
grep -q 'HID_TRANS_GET_REPORT' \
  "$ROOT/payload/source/codex_bt_pair_agent.c"
grep -q 'send_hid_input_report_reply' \
  "$ROOT/payload/source/codex_bt_pair_agent.c"
grep -q 'load_all_link_keys' \
  "$ROOT/payload/source/codex_bt_pair_agent.c"
grep -q 'close_inherited_fds' \
  "$ROOT/payload/source/codex_bt_pair_agent.c"
! grep -q 'link-key peer=%s key=' \
  "$ROOT/payload/source/codex_bt_pair_agent.c"
grep -q 'codex-bt-hid-control.pid' \
  "$ROOT/payload/source/codex_webui.c"
grep -q -- '--hid-control-daemon' \
  "$ROOT/payload/scripts/init.sh"
grep -q 'codex-bt-hid-control.pid' \
  "$ROOT/payload/scripts/init.sh"
grep -q 'codex_bt_pair_agent.c' \
  "$ROOT/build/build_harmony_tools_kali.sh"

echo "PASS Bluetooth HID authenticated-link, local pairing, and GET_REPORT guards"
