#!/bin/sh
# The merge gate's test suites: every suite that needs no hub and no network.
# CI runs this (.github/workflows/ci.yml); run it yourself the same way:
#
#   sh tools/ci/run_suites.sh            # all suites
#   sh tools/ci/run_suites.sh sim lua-*  # only the named ones (sh patterns)
#
# Every suite runs even after one fails, so one run shows every failure.
# tools/ci/quarantine.txt lists the suites that already fail on main: those
# are reported, not counted. A quarantined suite that passes fails the run,
# so its line gets deleted in the change that fixed it.
#
# Needs node, python3, luajit, a host C compiler, ripgrep and bun (the pinned
# version: docs/CI.md). A missing tool fails the suites that use it.
#
# The suites are written on macOS. On Linux (CI) a few tests can't pass for
# reasons of the host, so they are left out there and only there; the note
# this prints and docs/CI.md say which.
set -u

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$HERE/../.." && pwd)
QUARANTINE="$HERE/quarantine.txt"
LOGS=$(mktemp -d "${TMPDIR:-/tmp}/melodious-suites.XXXXXX")
trap 'rm -rf "$LOGS"' EXIT HUP INT TERM
cd "$REPO_ROOT"

LUA=tools/touch-validator

# Tests that need a macOS host. Linux leaves them out:
# - installer-contract's turn-off tests boot the hub's rcS.local with the
#   host's tools. Its stock lines use ${TDE:0:1} and a sed script that dash
#   and GNU sed reject (the hub's BusyBox and macOS accept both).
# - sim's ha-state harness compiles codex_webui.c with -std=c99, which hides
#   strdup, O_CLOEXEC and useconds_t under glibc.
SIM_SKIP="" INSTALLER_SKIP=""
if [ "$(uname -s)" = Linux ]; then
  SIM_SKIP="--test-skip-pattern=persists.in.volatile.tmpfs"
  INSTALLER_SKIP="SingleStateTurnOffOnFlow SingleStateBootAndDefenseInDepth.test_real_rcs_local_with_melodious_off_invokes_zero_codex_and_zero_bind_mounts"
  echo "note: on Linux, left out: installer-contract's rcS.local boot tests and sim's ha-state C harness test (they need a macOS host; docs/CI.md)"
fi

# Suites whose tests wait on real time and fail now and then on a busy
# machine. One failed run is tried once more and reported as flaky.
FLAKY="usb-eth"

# name|command, run from the repository root
SUITES="
sim|node --test $SIM_SKIP tools/webui-sim/test/
desktop|node --test desktop/test/*.test.mjs
hygiene|node tools/shipped_copy_hygiene.mjs
shell-smoke|node tools/harmony_shell_smoke.mjs
payload-inventory|node tools/payload_bin_inventory.mjs --check
repin-absorb|python3 -m unittest tools/ci/test_repin_absorb.py
activity-ui-model|node tools/activity_ui_model_smoke.mjs
installer-contract|python3 tools/ci/unittest_except.py tools/installer_contract_smoke.py $INSTALLER_SKIP
busybox-links|python3 tools/busybox_links_smoke.py
release|python3 -m unittest discover -s tools/releases -p 'test_*.py'
docker-manager|python3 -m unittest discover -s docker/tests
ha-inventory|python3 tools/test_ha_device_inventory.py
usb-eth|sh tools/usb-eth-test/run_tests.sh
activity-json-semantic|sh tools/activity_json_semantic_smoke.sh
activity-offline-guard|sh tools/activity_offline_guard.sh
hbus-notification|cc -std=c99 -O2 -o $LOGS/codex_hbus_host payload/source/codex_hbus.c && python3 tools/hbus_notification_smoke.py $LOGS/codex_hbus_host
lua-barrier|luajit $LUA/codexactivity-barrier-test.lua
lua-device-screens|luajit $LUA/codexactivity-device-screens-test.lua
lua-ha-devices|luajit $LUA/codexactivity-ha-devices-test.lua
lua-androidtv-devices|luajit $LUA/codexactivity-androidtv-devices-test.lua
lua-home-buttons|luajit $LUA/codexactivity-home-buttons-test.lua
lua-touch-controls|luajit $LUA/codexactivity-touch-controls-test.lua
lua-validate|luajit $LUA/codexactivity-validate-test.lua tools/webui-sim/fixtures/touch-maplist.json
lua-guards|luajit $LUA/netservicestarter-guards-test.lua
lua-restrictions|luajit $LUA/netservicestarter-restrictions-test.lua
lua-lan-advertise|luajit $LUA/netservicestarter-lan-advertise-test.lua
"

quarantined() {
  grep -q "^$1[[:space:]]" "$QUARANTINE" 2>/dev/null
}

selected() {
  [ "$#" -eq 1 ] && return 0
  _name=$1
  shift
  for _pattern in "$@"; do
    # shellcheck disable=SC2254
    case $_name in $_pattern) return 0 ;; esac
  done
  return 1
}

group() { [ -n "${GITHUB_ACTIONS:-}" ] && echo "::group::$1"; return 0; }
endgroup() { [ -n "${GITHUB_ACTIONS:-}" ] && echo "::endgroup::"; return 0; }

passed="" failed="" known="" fixed="" ran=0
while IFS='|' read -r name command; do
  [ -n "$name" ] || continue
  selected "$name" "$@" || continue
  ran=$((ran + 1))
  log="$LOGS/$name.log"
  start=$(date +%s)
  if sh -c "$command" > "$log" 2>&1 < /dev/null; then rc=0; else rc=$?; fi
  case " $FLAKY " in
    *" $name "*)
      _try=1
      while [ "$rc" -ne 0 ] && [ "$_try" -le 3 ]; do
        echo "FLAKY  $name: failed (attempt $_try), trying again; failures:"
        grep -E '^(FAIL|ERROR): ' "$log" || tail -n 20 "$log"
        pkill -f usb_eth_service.sh 2>/dev/null || true
        if sh -c "$command" > "$log" 2>&1 < /dev/null; then rc=0; else rc=$?; fi
        _try=$((_try + 1))
      done
      pkill -f usb_eth_service.sh 2>/dev/null || true
      ;;
  esac
  took=$(($(date +%s) - start))
  if [ "$rc" -eq 0 ]; then
    if quarantined "$name"; then
      fixed="$fixed $name"
      echo "FIXED  $name (${took}s): quarantined but passes; delete its line from tools/ci/quarantine.txt"
    else
      passed="$passed $name"
      echo "ok     $name (${took}s)"
    fi
    continue
  fi
  if quarantined "$name"; then
    known="$known $name"
    echo "KNOWN  $name (${took}s): fails as on main, see tools/ci/quarantine.txt"
  else
    failed="$failed $name"
    echo "FAIL   $name (${took}s, exit $rc)"
  fi
  group "$name output (last 80 lines)"
  tail -n 80 "$log"
  endgroup
done <<EOF
$SUITES
EOF

count() { echo "$1" | wc -w | tr -d ' '; }
echo
echo "suites: $(count "$passed") passed, $(count "$failed") failed, $(count "$known") known failures (quarantined), $(count "$fixed") quarantined but passing"
if [ "$ran" -eq 0 ]; then
  echo "no suite matched: $*" >&2
  exit 2
fi
[ -z "$failed" ] || echo "failed:$failed"
[ -z "$fixed" ] || echo "quarantined but passing:$fixed"
[ -z "$failed" ] && [ -z "$fixed" ]
