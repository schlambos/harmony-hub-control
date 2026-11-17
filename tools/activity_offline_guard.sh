#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
PLUGIN="$REPO_ROOT/payload/activity/codexactivity.lua"
WEBUI="$REPO_ROOT/payload/source/codex_webui.c"
NETSTART="$REPO_ROOT/payload/scripts/netservicestarter.lua"
EGRESS="$REPO_ROOT/payload/scripts/offline_egress_guard.sh"
INIT="$REPO_ROOT/payload/scripts/init.sh"

test -f "$PLUGIN"
test -f "$NETSTART"
test -f "$EGRESS"

for required in \
  'cloud_blocker.conf' \
  'core.resourcemanager' \
  'saveResource' \
  'config_new' \
  'FunctionList' \
  'configVersion' \
  'connect.stateDigest?notify'
do
  rg -F "$required" "$PLUGIN" >/dev/null
done

for forbidden in \
  'require("socket")' \
  'core.session' \
  'makeRequest' \
  'offlinequeue' \
  'proxy.resource' \
  'syncremotechanges' \
  'myharmony' \
  'logitech.com' \
  'https://'
do
  if rg -F "$forbidden" "$PLUGIN" >/dev/null; then
    echo "offline activity plugin contains forbidden path: $forbidden" >&2
    exit 1
  fi
done

# Allow only loopback http://127.0.0.1 URLs (local daemon webhook) and
# haWebhook's scheme validator / error text; reject every non-loopback http://.
has_non_loopback_http() {
  sed \
    -e 's|http://127[.]0[.]0[.]1\([:/"'"'"'[:space:]]\)|\1|g' \
    -e 's|http://127[.]0[.]0[.]1$||g' \
    -e 's|"^http://(\[\^/\][+])(/[.][*])[$]"|""|g' \
    -e 's|plain http:// URL|plain URL|g' \
    "$1" | rg -F 'http://' >/dev/null
}

if has_non_loopback_http "$PLUGIN"; then
  echo "offline activity plugin contains non-loopback http:// URL" >&2
  exit 1
fi

for forbidden in \
  'proxy.resource?put' \
  'setup.syncremotechanges' \
  '"forceUpdate"'
do
  if rg -F "$forbidden" "$WEBUI" >/dev/null; then
    echo "activity web API contains forbidden firmware sync path: $forbidden" >&2
    exit 1
  fi
done

for required in \
  'codex offline HBus guards registered' \
  '"proxy.resource?get"' \
  '"proxy.resource?put"' \
  '"setup.sync"' \
  '"setup.syncremotechanges"' \
  'acknowledged resource put without cloud' \
  'served local resource'
do
  rg -F "$required" "$NETSTART" >/dev/null
done

for required in \
  'cloud_blocker.conf' \
  'route del default' \
  '224.0.0.0' \
  '240.0.0.0' \
  '10.0.0.0/255.0.0.0 172.16.0.0/255.240.0.0 192.168.0.0/255.255.0.0' \
  'ensure_private_routes "$SAVED_GATEWAY"' \
  'clear_private_routes "$SAVED_GATEWAY"'
do
  rg -F "$required" "$EGRESS" >/dev/null
done

rg -F 'PAYLOAD / "activity" / "codexactivity.lua"' "$REPO_ROOT/install_webui.py" >/dev/null

# Installer-path assertion (stale-guard repair): the RECOVERY installer must
# reference the exact `activity/codexactivity.lua` candidate. Accept either the
# Windows backslash separator or the portable forward-slash separator for that
# same candidate; still require the exact activity Lua basename/path. A narrow
# two-alternative fixed-string check is used (no broad regex), so a wrong or
# missing path cannot satisfy it.
if ! rg -F -e 'activity\codexactivity.lua' -e 'activity/codexactivity.lua' \
    "$REPO_ROOT/install_webui.ps1" >/dev/null; then
  echo "install_webui.ps1 does not reference the activity/codexactivity.lua candidate" >&2
  exit 1
fi

# Regression self-check: the same two-alternative pattern must accept the
# forward-slash candidate and must reject a wrong activity path. This proves
# the assertion is not a vacuous pass.
_guard_tmp=$(mktemp -d)
trap 'rm -rf "$_guard_tmp"' EXIT
printf 'activity/codexactivity.lua\n' > "$_guard_tmp/fwd"
printf 'activity\\codexactivity.lua\n' > "$_guard_tmp/back"
printf 'activity/codexmqtt.lua\n' > "$_guard_tmp/wrong"
rg -F -e 'activity\codexactivity.lua' -e 'activity/codexactivity.lua' "$_guard_tmp/fwd" >/dev/null
rg -F -e 'activity\codexactivity.lua' -e 'activity/codexactivity.lua' "$_guard_tmp/back" >/dev/null
if rg -F -e 'activity\codexactivity.lua' -e 'activity/codexactivity.lua' "$_guard_tmp/wrong" >/dev/null; then
  echo "offline activity guard: wrong-path regression failed" >&2
  exit 1
fi

# Regression self-check for the narrowed http:// rule: loopback 127.0.0.1 must
# be accepted while non-loopback http:// URLs (including lookalike prefixes)
# must be rejected.
printf 'webhook = "http://127.0.0.1:8095/cmd"\n' > "$_guard_tmp/http_loopback"
printf 'webhook = "http://example.com/hook"\n' > "$_guard_tmp/http_external"
printf 'webhook = "http://127.0.0.1.example.com/hook"\n' > "$_guard_tmp/http_lookalike"
if has_non_loopback_http "$_guard_tmp/http_loopback"; then
  echo "offline activity guard: loopback http:// regression failed" >&2
  exit 1
fi
if ! has_non_loopback_http "$_guard_tmp/http_external"; then
  echo "offline activity guard: non-loopback http:// regression failed" >&2
  exit 1
fi
if ! has_non_loopback_http "$_guard_tmp/http_lookalike"; then
  echo "offline activity guard: lookalike http:// regression failed" >&2
  exit 1
fi

rg -F 'offline_egress_guard.sh monitor' "$INIT" >/dev/null
rg -F '"gatewayType":"codexactivity"' "$INIT" >/dev/null
rg -F 'offline_egress_guard.sh' "$REPO_ROOT/install_webui.py" >/dev/null
rg -F 'offline_egress_guard.sh' "$REPO_ROOT/install_webui.ps1" >/dev/null

echo "offline activity guard passed"
