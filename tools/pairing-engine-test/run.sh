#!/bin/sh
# Builds and runs test_pairing_engine.c: POST /api/pairing/start|finish|cancel
# against a fake Sony TV (in the test, on 127.0.0.1) and a fake codex_hbus
# that answers the engine's Bluetooth pairing calls. Every file the routes
# touch lives in a fresh directory. Run from the repository root
# (tools/ci/run_suites.sh does).
set -e
dir=$(mktemp -d "${TMPDIR:-/tmp}/codex-pairing-engine.XXXXXX")
trap 'rm -rf "$dir"' EXIT
cat >"$dir/codex_hbus" <<EOF
#!/bin/sh
# fake codex_hbus <hub> <cmd> <params>: logs the call, answers like the engine
echo "\$2 \$3" >>"$dir/hbus.log"
case "\$2" in
  harmony.engine?bluetoothunpairing) echo '{"cmd":"harmony.engine?bluetoothunpairing","code":200,"msg":"OK"}' ;;
  harmony.engine?bluetoothpairing)
    if [ -f "$dir/bt-fail" ]; then echo '{"cmd":"harmony.engine?bluetoothpairing","code":"506","msg":"Bluetooth connection timeout"}'
    elif [ -f "$dir/bt-selected" ]; then echo '{"cmd":"harmony.engine?bluetoothpairing","code":200,"msg":"OK","data":{"bdaddr":"AA:BB:CC:DD:EE:01","deviceId":"201"}}'
    else echo '{"cmd":"harmony.engine?bluetoothpairing","code":401,"msg":"Failed"}'; fi ;;
  *) echo '{"code":200}' ;;
esac
EOF
chmod +x "$dir/codex_hbus"
echo 12345678 >"$dir/hub_id"
echo 00:04:20:12:34:56 >"$dir/ath0"
${CC:-cc} -std=gnu99 -O1 -w -I payload/source \
  -DTEST_DIR="\"$dir\"" \
  -DPAIRING_ALLOW_LOOPBACK \
  -DDEVICE_LIST="\"$dir/DeviceList.json\"" \
  -DENGINE_COOKIES="\"$dir/cookies\"" \
  -DPAIRING_MARKER_DIR="\"$dir/markers\"" \
  -DRESOURCE_RELOAD_FLAG="\"$dir/reload_resources\"" \
  -DRESOURCE_BACKUP_DIR="\"$dir/backups\"" \
  -DHUB_ID_FILE="\"$dir/hub_id\"" \
  -DHUB_CLIENT_ID_FILE="\"$dir/ath0\"" \
  -DCODEX_HBUS_BIN="\"$dir/codex_hbus\"" \
  -DBT_DISCOVERABLE_OFF_CMD="\"echo off >>$dir/discoverable.log\"" \
  -DBT_PAIRING_SESSION="\"$dir/bt-session\"" \
  -DBT_PAIRING_LIMIT_S=1 \
  -o "$dir/test" tools/pairing-engine-test/test_pairing_engine.c
timeout 60 "$dir/test"
