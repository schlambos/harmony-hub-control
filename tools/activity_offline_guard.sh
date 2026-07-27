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
  'http://' \
  'https://'
do
  if rg -F "$forbidden" "$PLUGIN" >/dev/null; then
    echo "offline activity plugin contains forbidden path: $forbidden" >&2
    exit 1
  fi
done

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
  'acknowledged resource put without cloud or mutation' \
  'served local resource'
do
  rg -F "$required" "$NETSTART" >/dev/null
done

for required in \
  'cloud_blocker.conf' \
  'route del default' \
  '224.0.0.0' \
  '240.0.0.0'
do
  rg -F "$required" "$EGRESS" >/dev/null
done

rg -F 'PAYLOAD / "activity" / "codexactivity.lua"' "$REPO_ROOT/install_webui.py" >/dev/null
rg -F 'activity\codexactivity.lua' "$REPO_ROOT/install_webui.ps1" >/dev/null
rg -F 'offline_egress_guard.sh monitor' "$INIT" >/dev/null
rg -F '"gatewayType":"codexactivity"' "$INIT" >/dev/null
rg -F 'offline_egress_guard.sh' "$REPO_ROOT/install_webui.py" >/dev/null
rg -F 'offline_egress_guard.sh' "$REPO_ROOT/install_webui.ps1" >/dev/null

echo "offline activity guard passed"
