<#
.SYNOPSIS
  Install or upgrade Harmony Hub Control on a rooted Harmony Hub over SSH.
.DESCRIPTION
  Default mode is upgrade and preserves existing configuration.
  -CleanInstall is an explicit clean install that regenerates configuration.
  -PreflightOnly performs volatile staging only under private
  /var/volatile/codex-install-*: it verifies nonsensitive MD5 hashes,
  compares them with the hub's current files, checks RAM for rollback
  copies, and prints inventory plus a terminal verdict (ALLOWED or
  BLOCKED_*). It performs no persistent writes, pruning, handoff, installs,
  restarts, or other service actions.

  Normal install stages every candidate in that private 0700 volatile tree
  and verifies BusyBox md5sum before any persistent mutation. The hub's
  BusyBox has no mktemp, stat, df, or sync. Free flash is measured by
  payload/helpers/codex_flash_free, run from the RAM staging tree and never
  installed; the preflight blocks (BLOCKED_CAPACITY) before writing anything
  when the changed files won't fit on the hub's compressing jffs2.
  Changed files install as a two-phase commit: each is first written and
  verified beside its destination as <dest>.codex-new (if flash fills up
  anyway, every copy is removed and nothing live changed), then renamed into
  place, codex_webui last. Unchanged files are left alone. Originals are
  copied into RAM first so any later failure restores them with their
  observed modes. The dropbearmulti harmony-hub-root leaves (the same build
  as ours, or the .pdr-stripped one) is hard-linked instead of copied.
.PARAMETER PreflightOnly
  Volatile preflight only: stage/verify/compare/report under
  /var/volatile/codex-install-*. No persistent writes, pruning, handoff,
  installs, restarts, or other service actions.
.PARAMETER CleanInstall
  Explicit clean install: regenerate configuration candidates. Omit for the
  default upgrade, which preserves existing configuration unless a candidate
  explicitly replaces it.
.PARAMETER RemoveRootToolLeftovers
  Delete harmony-hub-root's leftover /data/codexssh_*_stage folders, and its
  spare /data/rootssh/bin/dropbearmulti once SSH runs the installed Dropbear,
  before installing.
.PARAMETER SkipFlashCheck
  Install even when the measured free flash looks too small; the install
  still stops with no live changes if flash fills up.
.PARAMETER MqttPassword
  MQTT password (never printed in preflight or logs).
.PARAMETER TurnOff
  Turn Melodious off via /etc/melodious-off and restart the hub so Logitech's
  cloud and the Harmony app can manage it again. Keeps Melodious's files,
  configs, and root SSH intact; supports -PreflightOnly.
.PARAMETER TurnOn
  Turn Melodious back on by removing /etc/melodious-off and restarting the hub,
  restoring the cloud blocker and saved settings; supports -PreflightOnly.
.PARAMETER Force
  With -TurnOff, bypass preflight refusals for duplicate remotes, missing Wi-Fi
  config, or a local-account hub.
.PARAMETER SkipCloudSuppression
  Do not replace netservicestarter.lua (with -CleanInstall, also write the
  cloud blocker as off). This does not undo an existing install; use -TurnOff
  for that.
#>
param(
    [Alias("Host")]
    [string]$HubHost,
    [string]$KeyPath,
    [int]$Port = 22,
    [string]$SshUser = "root",
    [string]$HubId,
    [string]$MqttBroker = "",
    [int]$MqttPort = 1883,
    [string]$MqttUser = "",
    [string]$MqttPassword = "",
    [string]$MqttBaseTopic = "harmony/hub",
    [string]$MqttDiscoveryPrefix = "homeassistant",
    [string]$MqttClientId = "harmony-local-mqtt",
    [switch]$MqttDisabled,
    [switch]$SkipCloudSuppression,
    [switch]$NoApplyCloudRestart,
    [switch]$NoPrompt,
    # -PreflightOnly: volatile stage/verify/compare/report only under /var/volatile/codex-install-*; no persistent mutation or service actions
    [switch]$PreflightOnly,
    # -CleanInstall: explicit clean install regenerating configuration; default without this switch is upgrade preserving existing configuration
    [switch]$CleanInstall,
    # -RemoveRootToolLeftovers: delete harmony-hub-root's leftover staging folders (and its spare Dropbear once SSH runs ours) before installing
    [switch]$RemoveRootToolLeftovers,
    # -SkipFlashCheck: install even when the measured free flash looks too small; phase 1 still stops safely if flash fills up
    [switch]$SkipFlashCheck,
    # -MultiRemote on|off|force-off: let the hub keep several remotes without a screen of the same model (they share one button setup); off restores the stock rule; force-off does that without asking the radio first (for a radio that stopped answering); omitted leaves it unchanged (docs/MULTI_REMOTE.md)
    [ValidateSet("on", "off", "force-off")]
    [string]$MultiRemote,
    # -TurnOff: turn Melodious off via /etc/melodious-off and give the hub back to Logitech's cloud
    [switch]$TurnOff,
    # -TurnOn: remove /etc/melodious-off and turn Melodious back on
    [switch]$TurnOn,
    # -Force: with -TurnOff, bypass preflight refusals for duplicate remotes, missing Wi-Fi config, or a local-account hub
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$StagePrefix = "/var/volatile/codex-install-"
$HandoffRoot = "/data/codex-backups"
$HandoffBudgetBytes = 256 * 1024
$HandoffKeep = 3
$WebuiDest = "/data/codex/bin/codex_webui"
$NewSuffix = ".codex-new"
$RestoreSuffix = ".codex-rb"
# RAM that must stay free after staging and rollback copies (tmpfs is RAM).
$RamMarginBytes = 4 * 1048576

# Free-space probe, run from the RAM staging tree only.
$FlashHelperName = "codex_flash_free"
$FlashPath = "/data"
# jffs2 stores a file as zlib-compressed nodes of at most one 4 KiB page, each
# with a 68-byte header; its directory entry adds 40 bytes plus the name.
$Jffs2Page = 4096
$Jffs2NodeHeader = 68
$Jffs2DirentHeader = 40
# Flash kept spare on top of the estimate: one 64 KiB erase block plus 5%.
$FlashMarginBytes = 64 * 1024
$FlashMarginPercent = 5

# What harmony-hub-root leaves behind. Its dropbearmulti is our Dropbear
# ($DropbearBuilds), and its staging folders hold about 0.5 MB of base64
# chunks each.
$DropbearDest = "/data/codex/bin/dropbearmulti"
$RootToolDropbear = "/data/rootssh/bin/dropbearmulti"
$RootToolStagePattern = '^/data/codexssh_[A-Za-z0-9_]+_stage$'
# Known builds of Dropbear, by MD5: their version. Same as DROPBEAR_BUILDS in
# install_webui.py: builds of one version load the same image, so either
# counts as the installed Dropbear and the root tool's copy is reused
# whichever it is (2025.89 as built, and .pdr-stripped as harmony-hub-root
# ships it). A new Dropbear release gets its own version, so it still
# replaces the old one.
$DropbearBuilds = @{
    "3733327fd04bca282dbf06f33da0bf6c" = "2025.89"  # as built, 577296 bytes
    "ceabc15471be6f67f1e13fccd20a9508" = "2025.89"  # .pdr stripped, 535652 bytes
}

function Test-HubCopyCurrent([string]$Dest, [string]$Have, [string]$Want) {
    # True when a file with MD5 $Have on the hub can stand for ours ($Want) at
    # $Dest: the same bytes, or at the Dropbear destination another build of
    # the same Dropbear version. -ccontains: a hashtable's ContainsKey
    # ignores case; MD5s here are exact.
    if ($Have -ceq $Want) { return $true }
    if ($Dest -cne $DropbearDest) { return $false }
    if (-not (($DropbearBuilds.Keys -ccontains $Have) -and ($DropbearBuilds.Keys -ccontains $Want))) { return $false }
    return $DropbearBuilds[$Have] -ceq $DropbearBuilds[$Want]
}
# The hub's ls has no -R; a root-tool stage holds files and a chunks/ folder.
# Same command as ROOT_TOOL_SCAN in install_webui.py.
$RootToolScan = @'
for d in /data/codexssh_*_stage; do [ -d "$d" ] || continue; set -- $(ls -l "$d" "$d/chunks" 2>/dev/null | awk '/^-/ {s += $5; n++} END {print s + 0, n + 0}'); echo "root_tool_stage bytes=$1 files=$2 path=$d"; done; for f in /data/rootssh/bin/dropbearmulti /data/codex/bin/dropbearmulti; do [ -f "$f" ] && [ ! -L "$f" ] || continue; set -- $(ls -il "$f"); echo "dropbear_copy inode=$1 links=$3 path=$f"; done
'@
# Removes the root tool's Dropbear only while SSH runs ours.
$RootToolDropbearRemove = @'
if [ -x /data/codex/bin/dropbear ] && grep /data/codex/bin/dropbear /usr/sbin/dropbear >/dev/null; then rm -f /data/rootssh/bin/dropbearmulti /data/rootssh/bin/dropbear /data/rootssh/bin/dropbearkey && echo removed; fi
'@

# Phase 1 could not write a new copy; every copy was removed, nothing live changed.
class CapacityAbort : System.Exception { CapacityAbort([string]$m) : base($m) {} }
# Failure after persistent changes began; requires rollback.
class InstallFailure : System.Exception { InstallFailure([string]$m) : base($m) {} }

# Multiple remotes of one model (docs/MULTI_REMOTE.md). Stock hal keeps one
# remote per model: it unpairs an older one after every pair, and its key
# threads keep per-model state, so two remotes of one model hang its radio
# dispatcher. -MultiRemote on makes a copy of the hub's own /usr/bin/hal with
# those made per slot and the same-model unpair kept only for remotes with a
# screen and the keyboard; rcS.local bind-mounts it over /usr/bin/hal at boot. The copy is built
# here from the hub's file with the edits in
# payload/helpers/hal_multiremote_patch.json; hal itself is never shipped.
$HalPath = "/usr/bin/hal"
$HalMultiDest = "/data/codex/bin/hal_multiremote"
$MultiRemoteConf = "/data/codex/multi_remote.conf"
$HalPatchFile = "helpers/hal_multiremote_patch.json"
# Turning it off reboots into the stock hal, which hangs its radio on two
# remotes of one model. So -MultiRemote off first checks the slot table on the
# hub, while the multi-remote hal runs: it writes the pending-restart guard
# (codex_webui's /api/remote-pair refuses while it's there; it lives in RAM and
# lapses after 10 minutes), refuses during an open pairing window, then reads
# rf.info. The copy itself is left to rcS.local, which deletes it at the next
# boot when the setting isn't 1.
$MultiRemotePending = "/var/run/codex-multi-remote-pending"
# force-off is off without the radio check (Test-MultiRemoteOff).
$MultiRemoteForce = $MultiRemote -eq "force-off"
if ($MultiRemoteForce) { $MultiRemote = "off" }
# Whether the multi-remote hal runs now; $null until checked (-MultiRemote only).
$script:HalBound = $null
$NoScreenEquads = @("16414", "16422", "16423")

$HandoffRequiredPaths = @(
    "/etc/init.d/rcS.local",
    "/opt/luaworks/tasks/connectserver/netservicestarter.lua",
    "/usr/sbin/dropbear",
    "/usr/sbin/dropbearkey",
    "/data/codex/hub_id",
    "/data/codex/cloud_blocker.conf",
    "/data/codex/offline_egress_guard.sh",
    "/data/codexmqtt/config.json",
    "/pkg/codexactivity/codexactivity.lua",
    "/pkg/codexactivity/manifest.json"
)

# Artifacts an upgrade must never replace unless explicitly supplied.
$UpgradeProtectedPaths = @(
    "/data/codex/hub_id",
    "/data/codex/cloud_blocker.conf",
    "/data/codex/multi_remote.conf",
    "/data/codex/two_screen.conf",
    "/data/codexmqtt/config.json",
    "/data/codex/resource-backups",
    "/data/codex-backups",
    "/data/codex/update-backups"
)

$VerdictAllowed = "ALLOWED"
$VerdictCapacity = "BLOCKED_CAPACITY"
$VerdictRollbackCapacity = "BLOCKED_ROLLBACK_CAPACITY"
$VerdictConfigUncertain = "BLOCKED_CONFIGURATION_UNCERTAINTY"
$VerdictValidation = "BLOCKED_VALIDATION_FAILURE"

$TurnOffScriptPath = "/var/volatile/codex-turn-off.sh"
$MelodiousOffMarker = "/etc/melodious-off"
$LegacyMelodiousOffMarker = "/data/codex/melodious-off"
$MelodiousOffRefusal = "Melodious is turned off on this hub. Run with -TurnOn to turn it back on first."
$MelodiousOffCheckCmd = @'
if [ -f /etc/melodious-off ] || [ -f /data/codex/melodious-off ]; then echo off; fi
'@

$GateScriptSpecs = @(
    @("/etc/init.d/rcS.local", "755", "runtime", "scripts/rcS.local"),
    @("/opt/luaworks/tasks/connectserver/netservicestarter.lua", "644", "runtime", "scripts/netservicestarter.lua"),
    @("/data/codex/init.sh", "755", "runtime", "scripts/init.sh"),
    @("/data/codex/offline_egress_guard.sh", "755", "runtime", "scripts/offline_egress_guard.sh"),
    @("/data/codex/usb_eth_service.sh", "755", "runtime", "scripts/usb_eth_service.sh"),
    @("/data/codex/androidtv_service.sh", "755", "runtime", "scripts/androidtv_service.sh"),
    @("/data/codex/recovery_ap.sh", "755", "runtime", "scripts/recovery_ap.sh"),
    @("/pkg/codexactivity/codexactivity.lua", "644", "plugin", "activity/codexactivity.lua"),
    @("/pkg/codexmqtt/codexmqtt.lua", "644", "plugin", "mqtt/codexmqtt.lua")
)

# Runs on the hub. Identical to TURN_OFF_SCRIPT in install_webui.py
# (tools/installer_contract_smoke.py checks byte-for-byte parity).
$TurnOffScript = @'
#!/bin/sh
# Single-state Melodious off/on helper, run ON THE HUB by install_webui.py
# (--turn-off / --turn-on) and install_webui.ps1 (-TurnOff / -TurnOn).
#
# One marker file, /etc/melodious-off, gates rcS.local, netservicestarter.lua,
# init.sh, the *_service.sh wrappers, and the /pkg Lua plugins. No Melodious
# configs, plugins, or patched hal copies are moved or edited.
#
#   sh turn_off.sh check [--force]         preflight + current state for --turn-off
#   sh turn_off.sh apply [--force]         write /etc/melodious-off, restore WAN
#                                          route, reconnect Wi-Fi if suspended
#   sh turn_off.sh verify-off              post-reboot verification for --turn-off
#   sh turn_off.sh check-on                preflight + hal load-check for --turn-on
#   sh turn_off.sh apply-on                unlink /etc/melodious-off (+ legacy)
#   sh turn_off.sh verify-on <hal-kind>    post-reboot verification for --turn-on
#
# BusyBox 1.13 on the hub: no stat, mktemp, rmdir, head, tail, sort, df or grep -E.

set -u
R=${CODEX_OFF_ROOT:-}
PATH=${CODEX_OFF_PATH:-/data/codex/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}
export PATH

MARKER=/etc/melodious-off
LEGACY_MARKER=/data/codex/melodious-off
HOSTS=/etc/hosts
PROBE_MARK="# codex: Harmony Touch sync probe"
WPA_CONF=/etc/wpa_supplicant.conf
PREFS=/data/luaworks/provision/preferences
WIFI_OFF_STATE=/var/run/codex-usb-eth-wifi-off
MULTI_PENDING=/var/run/codex-multi-remote-pending
HAL_PATH=/usr/bin/hal
HAL_REMOTES=/data/codex/bin/hal_remotes
HAL_MULTI=/data/codex/bin/hal_multiremote
HAL_GATES=/var/run/codex_hal_gates
TWO_SCREEN_CONF=/data/codex/two_screen.conf
MULTI_REMOTE_CONF=/data/codex/multi_remote.conf
USB_ETH_CONF=/data/codex/usb_eth.conf
WIFI_WAIT=${CODEX_WIFI_WAIT:-15}

BOOTSTRAP_ALWAYS="/etc/init.d/rcS.local /opt/luaworks/tasks/connectserver/netservicestarter.lua"
BOOTSTRAP_IF_PRESENT="/data/codex/init.sh /data/codex/offline_egress_guard.sh /data/codex/usb_eth_service.sh /data/codex/androidtv_service.sh /data/codex/recovery_ap.sh /pkg/codexactivity/codexactivity.lua /pkg/codexmqtt/codexmqtt.lua"

die() { echo "error=$*"; exit 1; }

ps_out() {
  if [ -n "${CODEX_OFF_PS_FILE:-}" ]; then
    cat "$CODEX_OFF_PS_FILE" 2>/dev/null || true
  elif [ -n "$R" ]; then
    cat "$R/proc/codex_ps" 2>/dev/null || true
  else
    ps 2>/dev/null || true
  fi
}

pid_alive() {
  [ -f "$1" ] || return 1
  _p=$(sed -n '1p' "$1" 2>/dev/null)
  case "$_p" in *[!0-9]*|"") return 1 ;; esac
  if [ -n "$R" ]; then
    ps_out | awk -v p="$_p" '$1 == p { f = 1 } END { exit !f }'
  else
    kill -0 "$_p" 2>/dev/null
  fi
}

route_out() {
  if [ -n "$R" ] && [ -f "$R/proc/codex_route" ]; then
    cat "$R/proc/codex_route" 2>/dev/null || true
  else
    route -n 2>/dev/null || true
  fi
}

emit_boot_stamp() {
  _bid=$(sed -n '1p' "$R/proc/sys/kernel/random/boot_id" 2>/dev/null || true)
  _bt=$(awk '$1 == "btime" { print $2; exit }' "$R/proc/stat" 2>/dev/null || true)
  _up=$(awk '{ print int($1); exit }' "$R/proc/uptime" 2>/dev/null || true)
  echo "boot_id=$_bid"
  echo "btime=$_bt"
  echo "uptime_s=$_up"
}

wifi_ipv4() {
  ifconfig ath0 2>/dev/null | sed -n 's/.*inet addr:\([0-9.]*\).*/\1/p' | sed -n '1p'
}

wired_ipv4s() {
  {
    if [ -x "$R/data/codex/bin/codex_usbeth" ]; then
      "$R/data/codex/bin/codex_usbeth" status 2>/dev/null | sed -n 's/^ipv4=\([0-9.]*\)$/\1/p'
    fi
    ifconfig 2>/dev/null | awk '
      /^[A-Za-z0-9]/ { iface = $1 }
      iface != "" && iface != "lo" && iface != "ath0" && iface != "ath1" && /inet addr:/ {
        s = $0; sub(/^.*inet addr:/, "", s); sub(/[^0-9.].*$/, "", s)
        if (s != "") print s
      }'
  } | awk '!seen[$0]++'
}

wifi_off_active() {
  [ -f "$R$WIFI_OFF_STATE" ] && return 0
  if grep '^WIFI_OFF=1$' "$R$USB_ETH_CONF" >/dev/null 2>&1; then
    if wpa_cli -i ath0 status 2>/dev/null | grep '^wpa_state=DISCONNECTED$' >/dev/null 2>&1; then
      return 0
    fi
  fi
  return 1
}

emit_network_state() {
  if route_out | awk '$1 == "0.0.0.0" && $4 ~ /G/ { f = 1 } END { exit !f }'; then
    echo "internet_route=yes"
  else
    echo "internet_route=no"
  fi
  if wifi_off_active; then
    echo "wifi_off_active=yes"
  else
    echo "wifi_off_active=no"
  fi
  echo "wifi_ip=$(wifi_ipv4)"
  for _wip in $(wired_ipv4s); do
    echo "wired_ip=$_wip"
  done
}

check_bootstrap_targets() {
  _need=no
  for _p in $BOOTSTRAP_ALWAYS; do
    if [ ! -f "$R$_p" ] || ! grep -F "$MARKER" "$R$_p" >/dev/null 2>&1; then
      _need=yes
      echo "bootstrap_target=$_p"
    fi
  done
  for _p in $BOOTSTRAP_IF_PRESENT; do
    if [ -f "$R$_p" ] && ! grep -F "$MARKER" "$R$_p" >/dev/null 2>&1; then
      _need=yes
      echo "bootstrap_target=$_p"
    fi
  done
  echo "bootstrap_needed=$_need"
}

report_off() {
  emit_boot_stamp
  _reasons=""
  add_reason() { _reasons="${_reasons:+$_reasons, }$1"; }

  if [ -f "$R$MARKER" ]; then
    echo "marker=present"
  else
    echo "marker=absent"
    add_reason "marker=absent"
  fi
  if [ -f "$R$LEGACY_MARKER" ]; then
    echo "legacy_marker=present"
    add_reason "legacy_marker=present"
  else
    echo "legacy_marker=absent"
  fi

  _boot_out=$(check_bootstrap_targets)
  echo "$_boot_out"
  if echo "$_boot_out" | grep '^bootstrap_needed=yes$' >/dev/null 2>&1; then
    add_reason "bootstrap_needed=yes"
  fi

  _ps=$(ps_out)
  if echo "$_ps" | grep '[c]odex_webui' >/dev/null 2>&1; then
    echo "webui=running"
    add_reason "webui=running"
  else
    echo "webui=stopped"
  fi
  if echo "$_ps" | grep '[o]ffline_egress_guard.sh' >/dev/null 2>&1 ||
     pid_alive "$R/var/run/codex-offline-egress.pid"; then
    echo "egress_guard=running"
    add_reason "egress_guard=running"
  else
    echo "egress_guard=stopped"
  fi
  if echo "$_ps" | grep '[u]sb_eth_service.sh' >/dev/null 2>&1 ||
     pid_alive "$R/var/run/codex-usb-eth-worker.pid"; then
    echo "usb_eth_worker=running"
    add_reason "usb_eth_worker=running"
  else
    echo "usb_eth_worker=stopped"
  fi
  if echo "$_ps" | grep '[c]odex_androidtv' >/dev/null 2>&1 ||
     echo "$_ps" | grep '[a]ndroidtv_service.sh' >/dev/null 2>&1; then
    echo "androidtv=running"
    add_reason "androidtv=running"
  else
    echo "androidtv=stopped"
  fi
  if echo "$_ps" | grep '[c]odex_bt_pair_agent' >/dev/null 2>&1 ||
     echo "$_ps" | grep '[c]odex_bthid_keyboard' >/dev/null 2>&1 ||
     echo "$_ps" | grep '[r]ecovery_ap.sh' >/dev/null 2>&1 ||
     echo "$_ps" | grep '[c]odex_portal' >/dev/null 2>&1 ||
     echo "$_ps" | grep '[c]odex_dhcpd' >/dev/null 2>&1; then
    echo "other_codex_daemons=running"
    add_reason "other_codex_daemons=running"
  else
    echo "other_codex_daemons=stopped"
  fi

  if grep " $HAL_PATH " "$R/proc/mounts" >/dev/null 2>&1; then
    echo "hal_mount=bound"
    add_reason "hal_mount=bound"
  else
    echo "hal_mount=stock"
  fi
  if grep -F "$PROBE_MARK" "$R$HOSTS" >/dev/null 2>&1; then
    echo "touch_probe=present"
    add_reason "touch_probe=present"
  else
    echo "touch_probe=absent"
  fi

  emit_network_state
  if [ -z "$_reasons" ]; then
    echo "active_off=yes"
  else
    echo "active_off=no"
    echo "still_active=$_reasons"
  fi
}

inspect_ssh() {
  [ -f "$R/etc/init.d/rcS" ] &&
    grep -F tdeenable "$R/etc/init.d/rcS" >/dev/null 2>&1 &&
    grep -F /usr/sbin/dropbear "$R/etc/init.d/rcS" >/dev/null 2>&1 ||
    die "The hub's boot script (/etc/init.d/rcS) doesn't start Dropbear, so SSH wouldn't come back after the reboot."
  [ -r "$R/etc/tdeenable" ] ||
    die "/etc/tdeenable is missing or unreadable, so SSH wouldn't start after the reboot."
  [ -x "$R/usr/sbin/dropbear" ] ||
    die "/usr/sbin/dropbear is missing or not executable, so SSH wouldn't start after the reboot."
  if [ "$(sed -n 1p "$R/usr/sbin/dropbear" 2>/dev/null)" = "#!/bin/sh" ]; then
    target=$(sed -n 's/^exec \([^ ]*\).*/\1/p' "$R/usr/sbin/dropbear")
    if [ -z "$target" ] || [ ! -x "$R$target" ]; then
      die "/usr/sbin/dropbear runs ${target:-nothing}, which is missing or not executable, so SSH wouldn't start after the reboot."
    fi
  fi
  if [ ! -r "$R/home/root/.ssh/authorized_keys" ] ||
     ! grep '[^ 	]' "$R/home/root/.ssh/authorized_keys" >/dev/null 2>&1; then
    die "/home/root/.ssh/authorized_keys is missing or empty, so SSH key login wouldn't work after the reboot."
  fi
  if [ -r "$R/etc/dropbear/dropbear_rsa_host_key" ] && [ -s "$R/etc/dropbear/dropbear_rsa_host_key" ]; then
    :
  elif [ ! -e "$R/etc/dropbear/dropbear_rsa_host_key" ] && [ -x "$R/usr/sbin/dropbearkey" ]; then
    if [ "$(sed -n 1p "$R/usr/sbin/dropbearkey" 2>/dev/null)" = "#!/bin/sh" ]; then
      key_target=$(sed -n 's/^exec \([^ ]*\).*/\1/p' "$R/usr/sbin/dropbearkey")
      if [ -z "$key_target" ] || [ ! -x "$R$key_target" ]; then
        die "/etc/dropbear/dropbear_rsa_host_key is missing and /usr/sbin/dropbearkey runs ${key_target:-nothing}, which is missing, so SSH wouldn't start after the reboot."
      fi
    fi
  else
    die "/etc/dropbear/dropbear_rsa_host_key is missing or empty and /usr/sbin/dropbearkey isn't executable, so SSH wouldn't start after the reboot."
  fi
}

inspect_remotes() {
  _force=$1
  if ps_out | grep '[r]f.pairing' >/dev/null 2>&1; then
    if [ "$_force" = "1" ]; then
      echo "warning=A remote pairing window is open on the hub (--force)."
      echo "rf_check=forced"
      return 0
    fi
    die "A remote pairing window is open on the hub; close it and try again (or pass --force)."
  fi
  if [ ! -x "$R/data/codex/bin/codex_hal_ltcp" ]; then
    if grep " $HAL_PATH " "$R/proc/mounts" >/dev/null 2>&1; then
      if [ "$_force" = "1" ]; then
        echo "warning=Patched hal is mounted and codex_hal_ltcp is missing (--force)."
        echo "rf_check=forced"
        return 0
      fi
      die "A patched hal is running and /data/codex/bin/codex_hal_ltcp is missing, so paired remotes couldn't be checked."
    fi
    echo "rf_check=skipped"
    return 0
  fi
  _rf=$("$R/data/codex/bin/codex_hal_ltcp" rf.info '{}' 8 2>&1) || true
  _parsed=$(echo "$_rf" | awk '
    { line = line " " $0 }
    END {
      if (line !~ /"code"[ \t]*:[ \t]*200/) { print "INVALID"; exit }
      n = split(line, parts, "{")
      for (i = 1; i <= n; i++) {
        obj = parts[i]
        sub(/\}.*$/, "", obj)
        if (obj ~ /"DeviceIndex"/) {
          eq = ""; idx = "?"
          if (match(obj, /"EquadID"[ \t]*:[ \t]*"?[0-9]+"?/)) {
            s = substr(obj, RSTART, RLENGTH)
            sub(/^.*:[ \t]*"?/, "", s); sub(/"?$/, "", s); eq = s
          }
          if (match(obj, /"DeviceIndex"[ \t]*:[ \t]*"?[0-9]+"?/)) {
            s = substr(obj, RSTART, RLENGTH)
            sub(/^.*:[ \t]*"?/, "", s); sub(/"?$/, "", s); idx = s
          }
          if (eq != "") {
            cnt[eq]++
            slots[eq] = (cnt[eq] > 1 ? slots[eq] ", " idx : idx)
          }
        }
      }
      dups = ""
      split("16414 16422 16423", noscr, " ")
      for (k = 1; k <= 3; k++) {
        m = noscr[k]
        if (cnt[m] > 1) dups = (dups != "" ? dups "; " : "") m " (slots " slots[m] ")"
      }
      print "DUPS=" dups
      if (cnt["16417"] > 1) print "SCREEN=" slots["16417"]
    }')
  if [ "$_parsed" = "INVALID" ]; then
    if [ "$_force" = "1" ]; then
      echo "warning=The hub radio didn't list its paired remotes (--force); if duplicate remotes without a screen are paired, the stock hal will hang."
      echo "rf_check=forced"
      return 0
    fi
    die "The hub's radio didn't list its paired remotes (rf.info failed); pass --force to turn off without checking."
  fi
  _dups=$(echo "$_parsed" | sed -n 's/^DUPS=//p')
  _scr=$(echo "$_parsed" | sed -n 's/^SCREEN=//p')
  if [ -n "$_scr" ]; then
    echo "warning=Two remotes with a screen (EquadID 16417, slots $_scr) are paired; the stock hal serves one of them at a time."
  fi
  if [ -n "$_dups" ]; then
    if [ "$_force" = "1" ]; then
      echo "warning=Duplicate remotes without a screen are paired (EquadID $_dups); the stock hal hangs on them (--force)."
      echo "rf_check=forced"
      return 0
    fi
    die "More than one remote without a screen of the same model is paired (EquadID $_dups). The stock hal hangs on duplicate remotes; unpair the extra ones in Settings -> Remotes first (or pass --force)."
  fi
  echo "rf_check=ok"
}

inspect_wifi() {
  _force=$1
  if [ ! -r "$R$WPA_CONF" ] || ! grep '^[ 	]*network[ 	]*=[ 	]*{' "$R$WPA_CONF" >/dev/null 2>&1; then
    if [ "$_force" = "1" ]; then
      echo "warning=/etc/wpa_supplicant.conf has no network={ block (--force); USB Ethernet won't start when Melodious is off, so the hub may be unreachable."
      echo "wifi_check=forced"
      return 0
    fi
    die "/etc/wpa_supplicant.conf has no network={ block. USB Ethernet doesn't run when Melodious is off, so the hub wouldn't join Wi-Fi after the reboot (configure Wi-Fi first, or pass --force)."
  fi
  echo "wifi_check=ok"
}

inspect_provision() {
  _force=$1
  _state=unprovisioned
  if [ -r "$R$PREFS" ] && [ -s "$R$PREFS" ]; then
    _state=$(awk '
      { line = line " " $0 }
      END {
        if (line !~ /"mode"[ \t]*:[ \t]*[23]/ || line !~ /"accountId"[ \t]*:[ \t]*"[^"]+"/ || line !~ /"authToken"[ \t]*:[ \t]*"[^"]+"/) {
          print "unprovisioned"
        } else if (line ~ /"authToken"[ \t]*:[ \t]*"local"/) {
          print "local_account"
        } else {
          print "cloud"
        }
      }' "$R$PREFS")
  fi
  echo "provision_state=$_state"
  if [ "$_state" = "local_account" ] || [ "$_state" = "unprovisioned" ]; then
    _msg="This hub is $_state (/data/luaworks/provision/preferences); re-provisioning it in the Harmony app runs cleanDataFolder(\"/data\") and wipes root SSH and /data/codex."
    if [ "$_force" = "1" ]; then
      echo "warning=$_msg (--force)"
      return 0
    fi
    die "$_msg Pass --force only if you intend to wipe /data/codex and root SSH."
  fi
}

check_off() {
  _force=$1
  [ -d "$R/data/codex" ] || die "Melodious isn't installed on this hub: /data/codex is missing."
  inspect_ssh
  _rep=$(report_off)
  if echo "$_rep" | grep '^active_off=yes$' >/dev/null 2>&1; then
    echo "$_rep"
    return 0
  fi
  inspect_remotes "$_force"
  inspect_wifi "$_force"
  inspect_provision "$_force"
  echo "$_rep"
}

apply_off() {
  _force=$1
  [ -d "$R/data/codex" ] || die "Melodious isn't installed on this hub: /data/codex is missing."
  inspect_ssh
  inspect_remotes "$_force"
  inspect_wifi "$_force"
  inspect_provision "$_force"
  for _p in $BOOTSTRAP_ALWAYS; do
    if [ ! -f "$R$_p" ] || ! grep -F "$MARKER" "$R$_p" >/dev/null 2>&1; then
      die "$_p does not yet support $MARKER; bootstrap gate scripts first."
    fi
  done

  trap '' HUP PIPE
  stamp=$(date -u +%Y%m%d-%H%M%S)
  mkdir -p "$R/etc" || die "Couldn't access /etc."
  if ! { echo "off $stamp" > "$R$MARKER.codex-new" &&
         chmod 644 "$R$MARKER.codex-new" &&
         mv -f "$R$MARKER.codex-new" "$R$MARKER"; }; then
    rm -f "$R$MARKER.codex-new"
    die "Couldn't write $MARKER; nothing changed."
  fi
  rm -f "$R$LEGACY_MARKER"

  if grep " $HAL_PATH " "$R/proc/mounts" >/dev/null 2>&1; then
    mkdir -p "$R/var/run" 2>/dev/null || true
    touch "$R$MULTI_PENDING" 2>/dev/null || true
  fi

  if [ -x "$R/data/codex/offline_egress_guard.sh" ]; then
    "$R/data/codex/offline_egress_guard.sh" >/dev/null 2>&1 || true
  fi

  if wifi_off_active; then
    wpa_cli -i ath0 reconnect >/dev/null 2>&1 || true
    rm -f "$R$WIFI_OFF_STATE" "$R$WIFI_OFF_STATE.failed"
    echo "wifi_reconnected=yes"
    _w=0
    while [ "$_w" -lt "$WIFI_WAIT" ] && [ -z "$(wifi_ipv4)" ]; do
      sleep 1
      _w=$((_w + 1))
    done
  fi

  emit_boot_stamp
  emit_network_state
  echo "result=off"
}

expected_hal_kind() {
  _two=$(cat "$R$TWO_SCREEN_CONF" 2>/dev/null || true)
  case "$_two" in
    1|once|serial|serial-once)
      if [ -f "$R$HAL_REMOTES" ]; then
        echo "two-screen"
        return 0
      fi
      ;;
  esac
  if [ "$(cat "$R$MULTI_REMOTE_CONF" 2>/dev/null || true)" = "1" ] && [ -f "$R$HAL_MULTI" ]; then
    echo "multi-remote"
    return 0
  fi
  echo "stock"
}

hal_matches_expected() {
  _want=$1
  _want_md5=${2:-}
  _bound=no
  grep " $HAL_PATH " "$R/proc/mounts" >/dev/null 2>&1 && _bound=yes
  _md5=$(md5sum "$R$HAL_PATH" 2>/dev/null | awk '{ print $1 }')
  case "$_want" in
    two-screen)
      _exp=${_want_md5:-$(md5sum "$R$HAL_REMOTES" 2>/dev/null | awk '{ print $1 }')}
      [ "$_bound" = "yes" ] && [ -n "$_exp" ] && [ "$_md5" = "$_exp" ]
      ;;
    multi-remote)
      _exp=${_want_md5:-$(md5sum "$R$HAL_MULTI" 2>/dev/null | awk '{ print $1 }')}
      [ "$_bound" = "yes" ] && [ -n "$_exp" ] && [ "$_md5" = "$_exp" ]
      ;;
    *) [ "$_bound" = "no" ] ;;
  esac
}

check_two_screen_load() {
  _out=$("$R$HAL_REMOTES" -h 2>&1; rc=$?; echo; echo "rc=$rc")
  if echo "$_out" | grep 'Usage:' >/dev/null 2>&1 &&
     echo "$_out" | grep '^rc=1$' >/dev/null 2>&1; then
    echo "two_screen_load_check=ok"
    return 0
  fi
  echo "two_screen_load_check=failed"
  die "The hub could not start $HAL_REMOTES; Melodious was left off and the hub was not restarted."
}

check_on() {
  [ -d "$R/data/codex" ] || die "Melodious isn't installed on this hub: /data/codex is missing."
  emit_boot_stamp
  _want=$(expected_hal_kind)
  echo "expected_hal=$_want"
  if [ "$_want" = "two-screen" ]; then
    check_two_screen_load
  fi
  _marker=absent
  [ -f "$R$MARKER" ] && _marker=present
  _legacy=absent
  [ -f "$R$LEGACY_MARKER" ] && _legacy=present
  echo "marker=$_marker"
  echo "legacy_marker=$_legacy"
  _webui=stopped
  ps_out | grep '[c]odex_webui' >/dev/null 2>&1 && _webui=running
  echo "webui=$_webui"
  if [ "$_marker" = "absent" ] && [ "$_legacy" = "absent" ] &&
     [ "$_webui" = "running" ] && hal_matches_expected "$_want"; then
    echo "already_on=yes"
  else
    echo "already_on=no"
  fi
}

apply_on() {
  [ -d "$R/data/codex" ] || die "Melodious isn't installed on this hub: /data/codex is missing."
  _want=$(expected_hal_kind)
  if [ "$_want" = "two-screen" ]; then
    check_two_screen_load
  fi
  trap '' HUP PIPE
  emit_boot_stamp
  rm -f "$R$MARKER" "$R$LEGACY_MARKER" || die "Couldn't remove $MARKER."
  if [ -e "$R$MARKER" ] || [ -e "$R$LEGACY_MARKER" ]; then
    die "Couldn't remove $MARKER."
  fi
  echo "expected_hal=$_want"
  echo "result=on"
}

verify_on() {
  _want=${1:-stock}
  emit_boot_stamp
  _missing=""
  add_missing() { _missing="${_missing:+$_missing, }$1"; }
  if [ -f "$R$MARKER" ]; then
    echo "marker=present"
    add_missing "marker=present"
  else
    echo "marker=absent"
  fi
  if [ -f "$R$LEGACY_MARKER" ]; then
    echo "legacy_marker=present"
    add_missing "legacy_marker=present"
  else
    echo "legacy_marker=absent"
  fi
  if ps_out | grep '[c]odex_webui' >/dev/null 2>&1; then
    echo "webui=running"
  else
    echo "webui=stopped"
    add_missing "webui=stopped"
  fi
  if grep " $HAL_PATH " "$R/proc/mounts" >/dev/null 2>&1; then
    echo "hal_mount=bound"
  else
    echo "hal_mount=stock"
  fi
  _md5=$(md5sum "$R$HAL_PATH" 2>/dev/null | awk '{ print $1 }')
  echo "hal_md5=$_md5"
  echo "hal_gates=$(cat "$R$HAL_GATES" 2>/dev/null || true)"
  if ! hal_matches_expected "$_want" "${2:-}"; then
    add_missing "hal!=$_want"
  fi
  if [ -z "$_missing" ]; then
    echo "active_on=yes"
  else
    echo "active_on=no"
    echo "missing_on=$_missing"
  fi
}

MODE=${1:-}
FORCE=0
[ "${2:-}" = "--force" ] && FORCE=1

case "$MODE" in
  check) check_off "$FORCE" ;;
  apply) apply_off "$FORCE" ;;
  verify-off) report_off ;;
  check-on) check_on ;;
  apply-on) apply_on ;;
  verify-on) verify_on "${2:-stock}" "${3:-}" ;;
  *) echo "usage: $0 {check|apply} [--force] | verify-off | check-on | apply-on | verify-on <hal>" >&2; exit 2 ;;
esac
'@

function Step($Text) {
    Write-Host ""
    Write-Host "== $Text ==" -ForegroundColor Cyan
}

function Info($Text) {
    Write-Host "  $Text"
}

function KV($Text) {
    Write-Host $Text
}

function Prompt-IfMissing([string]$Value, [string]$Label, [switch]$Required) {
    if ($Value) { return $Value }
    if ($NoPrompt) {
        if ($Required) { throw "$Label is required" }
        return ""
    }
    $v = Read-Host $Label
    $v = $v.Trim()
    if ($Required -and -not $v) { throw "$Label is required" }
    return $v
}

function Resolve-DefaultKeyPath() {
    $userHome = $env:USERPROFILE
    $sshDir = Join-Path $userHome ".ssh"
    if (-not (Test-Path -LiteralPath $sshDir)) { return $null }
    $keys = Get-ChildItem -LiteralPath $sshDir -Filter "harmony_owner_*" -File |
        Where-Object { $_.Name -notlike "*.pub" } |
        Sort-Object LastWriteTime -Descending
    if (-not $keys) { return $null }
    return $keys[0].FullName
}

function Test-HubId([string]$Value) {
    return [bool]($Value -match '^[0-9]{4,}$')
}

function Resolve-SavedHubId([string]$HubHost) {
    $userRoot = $env:USERPROFILE
    $candidatePaths = @(
        (Join-Path $userRoot ".harmony-hub\known_hubs.json"),
        (Join-Path $userRoot ".harmony-hub\last_root.json"),
        (Join-Path $userRoot ".harmony-hub\hub_id.txt"),
        (Join-Path $ScriptRoot "harmony_hub_id.txt")
    )
    foreach ($path in $candidatePaths) {
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $name = Split-Path -Leaf $path
        if ($name -eq "known_hubs.json") {
            try {
                $known = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
            } catch { continue }
            $entry = $known.PSObject.Properties[$HubHost]
            if ($entry) {
                $hubId = [string]$entry.Value.hub_id
                if (Test-HubId $hubId) { return @{ HubId = $hubId; Source = $path } }
            }
            continue
        }
        if ($name -eq "last_root.json") {
            try {
                $last = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
            } catch { continue }
            if ([string]$last.host -eq $HubHost) {
                $hubId = [string]$last.hub_id
                if (Test-HubId $hubId) { return @{ HubId = $hubId; Source = $path } }
            }
            continue
        }
        try {
            $hubId = (Get-Content -LiteralPath $path -Raw).Trim()
        } catch { continue }
        if (Test-HubId $hubId) { return @{ HubId = $hubId; Source = $path } }
    }
    return $null
}

function Quote-ProcessArg([string]$Arg) {
    if ($null -eq $Arg) { return '""' }
    if ($Arg -match '^[A-Za-z0-9_./:@=,%+-]+$') { return $Arg }
    # Windows CRT / .NET ParseArgumentsIntoList rule: backslashes are literal
    # UNLESS they immediately precede a double quote, where each is doubled.
    # Accumulate backslash runs and emit them doubled only before a quote or
    # the closing quote; otherwise pass them through unchanged.
    $out = '"'
    $pending = 0
    foreach ($ch in $Arg.ToCharArray()) {
        if ($ch -eq '\') { $pending++; continue }
        if ($ch -eq '"') {
            $out += ('\' * ($pending * 2)) + '\"'
        } else {
            $out += ('\' * $pending) + $ch
        }
        $pending = 0
    }
    return $out + ('\' * ($pending * 2)) + '"'
}

function Remote-Quote([string]$Value) {
    return "'" + ($Value -replace "'", "'`"`"'`"'") + "'"
}

function Get-SshArgs() {
    $args = @(
        "-p", [string]$Port,
        "-i", $KeyPath,
        "-o", "IdentitiesOnly=yes",
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "$SshUser@$HubHost"
    )
    return $args
}

function Invoke-RemoteRc([string]$Command, [byte[]]$InputBytes = $null, [int]$TimeoutMs = 90000) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = "ssh"
    $allArgs = @((Get-SshArgs)) + @($Command)
    $psi.Arguments = (($allArgs | ForEach-Object { Quote-ProcessArg ([string]$_) }) -join " ")
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $proc = [System.Diagnostics.Process]::new()
    $proc.StartInfo = $psi
    $proc.Start() | Out-Null
    if ($null -ne $InputBytes) {
        $stdin = $proc.StandardInput.BaseStream
        $stdin.Write($InputBytes, 0, $InputBytes.Length)
    }
    $proc.StandardInput.Close()
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit($TimeoutMs)) {
        try { $proc.Kill() } catch {}
        throw "ssh timed out after $TimeoutMs ms running: $Command"
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    return @{ Code = $proc.ExitCode; Out = $stdout; Err = $stderr }
}

function Invoke-Remote([string]$Command, [byte[]]$InputBytes = $null, [int]$TimeoutMs = 90000) {
    $r = Invoke-RemoteRc $Command $InputBytes $TimeoutMs
    if ($r.Code -ne 0) {
        throw "ssh failed with exit $($r.Code)`ncommand=$Command`nstdout=$($r.Out)`nstderr=$($r.Err)"
    }
    return $r.Out
}

# Like Invoke-RemoteRc, with stdout kept as bytes (for reading a binary).
function Get-RemoteBytes([string]$Path, [int]$TimeoutMs = 120000) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = "ssh"
    $allArgs = @((Get-SshArgs)) + @("cat $(Remote-Quote $Path)")
    $psi.Arguments = (($allArgs | ForEach-Object { Quote-ProcessArg ([string]$_) }) -join " ")
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $proc = [System.Diagnostics.Process]::new()
    $proc.StartInfo = $psi
    $proc.Start() | Out-Null
    $proc.StandardInput.Close()
    $buffer = [IO.MemoryStream]::new()
    $copyTask = $proc.StandardOutput.BaseStream.CopyToAsync($buffer)
    $stderrTask = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit($TimeoutMs)) {
        try { $proc.Kill() } catch {}
        throw "ssh timed out after $TimeoutMs ms reading $Path"
    }
    $copyTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if ($proc.ExitCode -ne 0) { throw "could not read $Path from the hub (exit $($proc.ExitCode)): $($stderr.Trim())" }
    return ,$buffer.ToArray()
}

function Get-BytesMd5([byte[]]$Data) {
    $md5 = [Security.Cryptography.MD5]::Create()
    return ([BitConverter]::ToString($md5.ComputeHash($Data)) -replace "-", "").ToLowerInvariant()
}

# Hex to bytes by hand: Windows PowerShell 5.1 (.NET Framework) has no built-in for it.
function ConvertFrom-Hex([string]$Hex) {
    $bytes = New-Object byte[] ($Hex.Length / 2)
    for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($Hex.Substring(2 * $i, 2), 16) }
    return ,$bytes
}

# The multi-remote hal from the hub's own /usr/bin/hal; fails closed.
function Get-PatchedHal([byte[]]$Data) {
    $patch = Get-Content -Raw -Encoding UTF8 (Join-Path $Payload $HalPatchFile) | ConvertFrom-Json
    $digest = Get-BytesMd5 $Data
    if ($digest -eq $patch.patched_md5) { return ,$Data }  # already the patched build (read while bind-mounted)
    if ($digest -ne $patch.stock_md5) {
        throw "$HalPath on this hub is not the hal build multi-remote supports (md5 $digest, expected $($patch.stock_md5) from firmware 4.15.600)"
    }
    $out = [byte[]]$Data.Clone()
    foreach ($edit in $patch.edits) {
        $offset = [Convert]::ToInt32($edit.offset.Substring(2), 16)
        $old = ConvertFrom-Hex $edit.stock
        $new = ConvertFrom-Hex $edit.patched
        for ($i = 0; $i -lt $old.Length; $i++) {
            if ($out[$offset + $i] -ne $old[$i]) { throw ("{0}: unexpected bytes at 0x{1:x}" -f $HalPath, $offset) }
        }
        [Array]::Copy($new, 0, $out, $offset, $new.Length)
    }
    if ((Get-BytesMd5 $out) -ne $patch.patched_md5) { throw "the patched hal does not match its expected md5" }
    return ,$out
}

function Test-TcpPort([string]$TargetHost, [int]$TargetPort, [int]$TimeoutMs = 1200) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $task = $client.ConnectAsync($TargetHost, $TargetPort)
        return $task.Wait($TimeoutMs) -and $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Wait-TcpPort([string]$TargetHost, [int]$TargetPort, [int]$Seconds, [string]$Label) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-TcpPort $TargetHost $TargetPort) {
            Info "$Label is reachable on port $TargetPort"
            return
        }
        Start-Sleep -Seconds 2
    }
    throw "$Label did not become reachable on port $TargetPort within $Seconds seconds"
}

function Get-LocalMd5([string]$Path) {
    return (Get-FileHash -Algorithm MD5 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-BinManifestNames() {
    # Canonical install list: payload/bin/MANIFEST.txt (same source as tools/payload_bin_inventory.mjs).
    $manifestPath = Join-Path $Payload "bin/MANIFEST.txt"
    $names = @()
    Get-Content -LiteralPath $manifestPath | ForEach-Object {
        if ($_ -match '^([0-9a-fA-F]{32})\s+(\S+)\s*$') { $names += $Matches[2] }
    }
    if ($names.Count -eq 0) { throw "no binaries listed in $manifestPath" }
    foreach ($name in $names) {
        $local = Join-Path $Payload "bin/$name"
        if (-not (Test-Path -LiteralPath $local)) { throw "MANIFEST lists $name but $local is missing" }
    }
    return $names
}

function Build-MqttConfig() {
    $enabled = (-not $MqttDisabled) -and [bool]$MqttBroker
    $cfg = [ordered]@{
        enabled = $enabled
        name = "Harmony Hub"
        clientId = $MqttClientId
        baseTopic = $MqttBaseTopic.Trim('/')
        discoveryPrefix = $MqttDiscoveryPrefix.Trim('/')
        haDiscovery = $true
        pollSeconds = 10
        keepAlive = 60
        broker = [ordered]@{
            host = [string]$MqttBroker
            port = [int]$MqttPort
            username = [string]$MqttUser
            password = [string]$MqttPassword
        }
    }
    return ($cfg | ConvertTo-Json -Compress -Depth 8) + "`n"
}

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Payload = Join-Path $ScriptRoot "payload"

# ------------------------------------------------------------- shared state
$Stage = ""
$Candidates = [System.Collections.ArrayList]::new()
$Probe = @{}
$HandoffEstimate = 0
$ForwardTotal = 0
$RollbackTotal = 0
$StagedTotal = 0
$RamFreeBytes = 0
$RamRequiredBytes = 0
$Verdict = $VerdictValidation
$VerdictReasons = [System.Collections.ArrayList]::new()
$Generations = @{ handoff = 0; resource = 0; settings = 0; update = 0 }
$HandoffDirs = [System.Collections.ArrayList]::new()
$Changed = [System.Collections.ArrayList]::new()
$NewCopies = [System.Collections.ArrayList]::new()
$ResolvedHubId = ""
$FirstInstall = $false
$PreserveStage = $false
# Flash, from codex_flash_free; $FlashAvail stays $null when it couldn't be measured.
$FlashHelperRemote = ""
$FlashAvail = $null
$FlashTotal = 0
$FlashWritten = 0
$FlashRequired = 0
$FlashReleased = 0
$FlashNote = ""
# "preflight" when the measured check blocked, "phase1" when a copy failed.
$CapacityStage = ""
$RootToolStages = [System.Collections.ArrayList]::new()
# Inode of each Dropbear copy, by path.
$DropbearCopies = @{}
# Hard-link count of each, by path.
$DropbearLinks = @{}
$MqttExplicitSupplied = ($PSBoundParameters.ContainsKey("MqttBroker") -or
    $PSBoundParameters.ContainsKey("MqttPort") -or
    $PSBoundParameters.ContainsKey("MqttUser") -or
    $PSBoundParameters.ContainsKey("MqttPassword") -or
    $PSBoundParameters.ContainsKey("MqttBaseTopic") -or
    $PSBoundParameters.ContainsKey("MqttDiscoveryPrefix") -or
    $PSBoundParameters.ContainsKey("MqttClientId") -or
    $PSBoundParameters.ContainsKey("MqttDisabled"))

# ------------------------------------------------------------- candidates

function New-Candidate([string]$Dest, [string]$Mode, [string]$Kind,
    [string]$Local = $null, [string]$Text = $null,
    [switch]$Sensitive, [string]$Condition = "always", [byte[]]$Blob = $null) {
    return [PSCustomObject]@{
        Dest = $Dest
        Mode = $Mode
        Kind = $Kind
        Local = $Local
        Text = $Text
        # bytes built at install time (the multi-remote hal)
        Blob = $Blob
        Sensitive = [bool]$Sensitive
        Condition = $Condition
        Bytes = 0
        Md5 = ""
        FlashBytes = 0
        Action = "replace"
        StagedName = ""
        # An identical (or, for Dropbear, equivalent) file already on the hub
        # that phase 1 hard-links, and the MD5 and size it has.
        LinkSource = ""
        LinkMd5 = ""
        LinkBytes = 0
        # phase 1 linked it rather than copying the payload
        Linked = $false
    }
}

function Get-CandidateData($Cand) {
    if ($null -ne $Cand.Blob) { return ,$Cand.Blob }
    if ($Cand.Local) { return [IO.File]::ReadAllBytes($Cand.Local) }
    return [Text.Encoding]::UTF8.GetBytes([string]$Cand.Text)
}

function Get-FlashEstimate([byte[]]$Data, [string]$Name) {
    # Bytes a new file takes on the hub's jffs2: one zlib node per 4 KiB page,
    # stored raw when that is smaller, plus the directory entry; nodes are
    # 4-byte aligned (flash_estimate in install_webui.py). jffs2 uses zlib
    # level 3. .NET's Optimal (level 6) lands within about 3% of it; Fastest
    # is zlib-ng's quick mode on PowerShell 7 and overshoots by about 25%.
    $total = [long](($Jffs2DirentHeader + [Text.Encoding]::UTF8.GetByteCount($Name) + 3) -band -bnot 3)
    for ($start = 0; $start -lt $Data.Length; $start += $Jffs2Page) {
        $len = [Math]::Min($Jffs2Page, $Data.Length - $start)
        $ms = [IO.MemoryStream]::new()
        $ds = [IO.Compression.DeflateStream]::new($ms, [IO.Compression.CompressionLevel]::Optimal, $true)
        $ds.Write($Data, $start, $len)
        $ds.Dispose()
        # zlib wraps raw deflate in a 2-byte header and a 4-byte checksum.
        $stored = [Math]::Min([long]$ms.Length + 6, [long]$len)
        $total += ($Jffs2NodeHeader + $stored + 3) -band -bnot 3
    }
    return $total
}

function Get-FlashMargin([long]$Estimate) {
    return [long]($FlashMarginBytes + [Math]::Floor($Estimate * $FlashMarginPercent / 100))
}

function Format-KB([long]$Value) {
    return "$([long][Math]::Floor(($Value + 1023) / 1024)) KB"
}

function Add-Candidate($Cand) {
    $data = Get-CandidateData $Cand
    $Cand.Bytes = $data.Length
    $md5 = [System.Security.Cryptography.MD5]::Create()
    $Cand.Md5 = [BitConverter]::ToString($md5.ComputeHash($data)).Replace("-", "").ToLowerInvariant()
    $Cand.FlashBytes = Get-FlashEstimate $data (($Cand.Dest.Split('/')[-1]) + $NewSuffix)
    $Candidates.Add($Cand) | Out-Null
}

function Test-MqttExplicit() {
    return $script:MqttExplicitSupplied
}

# A guard that can't be written stops the check (guard-failed): without it,
# nothing blocks a pair between the check and the reboot.
function Get-MultiRemoteOffCheckCommand([bool]$Guard) {
    $touch = if ($Guard) { "elif ! touch $MultiRemotePending; then echo guard-failed; " } else { "" }
    return "if ! grep ' $HalPath ' /proc/mounts >/dev/null 2>&1; then echo inactive; " +
        "${touch}elif ps | grep '[r]f.pairing' >/dev/null 2>&1; then echo pairing; " +
        "else /data/codex/bin/codex_hal_ltcp rf.info '{}' 8 2>&1; fi"
}

# Models without a screen paired more than once in hal's rf.info answer, as
# "16414 (slots 1, 2)"; "" when none; $null when it isn't a valid answer.
function Get-RfDuplicateModels([string]$Reply) {
    $start = $Reply.IndexOf("{")
    if ($start -lt 0) { return $null }
    try { $doc = $Reply.Substring($start) | ConvertFrom-Json } catch { return $null }
    if ($null -eq $doc -or $doc.code -ne 200 -or $null -eq $doc.data) { return $null }
    $slots = [ordered]@{}
    foreach ($dev in @($doc.data.Devices)) {
        if ($null -eq $dev) { continue }
        $id = [string]$dev.EquadID
        if ($NoScreenEquads -contains $id) {
            if (-not $slots.Contains($id)) { $slots[$id] = New-Object System.Collections.ArrayList }
            [void]$slots[$id].Add([string]$dev.DeviceIndex)
        }
    }
    $dups = @($slots.Keys | Where-Object { $slots[$_].Count -gt 1 } | ForEach-Object { "$_ (slots $($slots[$_] -join ', '))" })
    return ($dups -join "; ")
}

function Get-HalBoundCommand() {
    return "if grep ' $HalPath ' /proc/mounts >/dev/null 2>&1; then echo bound; else echo stock; fi"
}

function Test-HalBound() {
    $out = (Invoke-Remote (Get-HalBoundCommand) $null 30000).Trim()
    if ($out -ne "bound" -and $out -ne "stock") { throw "couldn't tell whether the multi-remote hal runs: $out" }
    return ($out -eq "bound")
}

# -MultiRemote off while the multi-remote hal runs: refuse unless the slot
# table holds no two remotes of one model. Also records whether the copy runs
# now ($script:HalBound), which decides the reboot as much as the files do.
function Test-MultiRemoteOff() {
    if ($MultiRemote -eq "on") {
        $script:HalBound = Test-HalBound
        KV ("multi_remote_active=" + $(if ($script:HalBound) { "yes" } else { "no" }))
    }
    if ($MultiRemote -ne "off") { return }
    if ($MultiRemoteForce) {
        # force-off: for a radio that stopped answering, check nothing that
        # needs hal. The guard is best effort; the reboot follows at once.
        $script:HalBound = Test-HalBound
        KV ("multi_remote_active=" + $(if ($script:HalBound) { "yes" } else { "no" }))
        if ($script:HalBound -and $NoApplyCloudRestart) {
            throw "-MultiRemote force-off refused: the multi-remote hal is running, and -NoApplyCloudRestart would keep it running; leave out -NoApplyCloudRestart"
        }
        if ($script:HalBound -and -not $PreflightOnly) {
            Invoke-Remote "touch $MultiRemotePending 2>/dev/null; true" $null 30000 | Out-Null
        }
        KV "multi_remote_off_check=forced"
        Info "WARNING: force-off skips the radio check: if two remotes of one model are still paired, the stock hal hangs on them too. Turn it back on (-MultiRemote on), unpair the extra remote, then turn it off."
        return
    }
    # Without the reboot the multi-remote hal keeps running on setting 0, and
    # once the guard lapses a pair could add a duplicate that the stock hal
    # hangs on at the next boot: refuse that before writing anything.
    $guard = (-not $PreflightOnly) -and (-not $NoApplyCloudRestart)
    $out = (Invoke-Remote (Get-MultiRemoteOffCheckCommand $guard) $null 60000).Trim()
    $script:HalBound = ($out -ne "inactive")
    if ($out -eq "inactive") { KV "multi_remote_off_check=inactive"; return }
    $problem = ""
    if ($NoApplyCloudRestart) {
        $problem = "the multi-remote hal is running, and -NoApplyCloudRestart would keep it running after the setting is saved, with nothing to stop a second remote of one model being paired before the stock hal starts; leave out -NoApplyCloudRestart so the hub restarts"
    } elseif ($out -eq "guard-failed") {
        $problem = "the hub couldn't write $MultiRemotePending, which blocks new pairings until it restarts"
    } elseif ($out -eq "pairing") {
        $problem = "a pairing window is open on the hub; try again when it closes"
    } else {
        $dups = Get-RfDuplicateModels $out
        if ($null -eq $dups) {
            $problem = "the hub's radio didn't list its paired remotes"
        } elseif ($dups) {
            $problem = "more than one remote of the same model is paired (EquadID $dups); the stock hal can't run two of one model, so unpair the extra ones first (Settings -> Remotes)"
        }
    }
    if ($problem) {
        if ($guard) { Invoke-Remote "rm -f $MultiRemotePending" $null 30000 | Out-Null }
        throw "-MultiRemote off refused: $problem"
    }
    KV "multi_remote_off_check=ok"
}

function Build-Inventory() {
    $binNames = Get-BinManifestNames
    foreach ($name in $binNames) {
        if ($name -eq "codex_webui") { continue }  # installed last
        Add-Candidate (New-Candidate "/data/codex/bin/$name" "755" "binary" -Local (Join-Path $Payload "bin/$name"))
    }
    Add-Candidate (New-Candidate "/usr/sbin/dropbear" "755" "binary" -Local (Join-Path $Payload "scripts/dropbear"))
    Add-Candidate (New-Candidate "/usr/sbin/dropbearkey" "755" "binary" -Local (Join-Path $Payload "scripts/dropbearkey"))

    Add-Candidate (New-Candidate "/data/codex/init.sh" "755" "runtime" -Local (Join-Path $Payload "scripts/init.sh"))
    Add-Candidate (New-Candidate "/data/codex/offline_egress_guard.sh" "755" "runtime" -Local (Join-Path $Payload "scripts/offline_egress_guard.sh"))
    Add-Candidate (New-Candidate "/data/codex/recovery_ap.sh" "755" "runtime" -Local (Join-Path $Payload "scripts/recovery_ap.sh"))
    Add-Candidate (New-Candidate "/data/codex/androidtv_service.sh" "755" "runtime" -Local (Join-Path $Payload "scripts/androidtv_service.sh"))
    Add-Candidate (New-Candidate "/data/codex/usb_eth_service.sh" "755" "runtime" -Local (Join-Path $Payload "scripts/usb_eth_service.sh"))
    Add-Candidate (New-Candidate "/data/codex/modules/usb-net/r8152.ko" "644" "runtime" -Local (Join-Path $Payload "modules/usb-net/r8152.ko"))
    Add-Candidate (New-Candidate "/data/codex/modules/usb-net/usbnet.ko" "644" "runtime" -Local (Join-Path $Payload "modules/usb-net/usbnet.ko"))
    Add-Candidate (New-Candidate "/data/codex/modules/usb-net/asix.ko" "644" "runtime" -Local (Join-Path $Payload "modules/usb-net/asix.ko"))
    Add-Candidate (New-Candidate "/data/codex/modules/usb-net/cdc_ether.ko" "644" "runtime" -Local (Join-Path $Payload "modules/usb-net/cdc_ether.ko"))
    Add-Candidate (New-Candidate "/data/codex/modules/usb-net/cdc_ncm.ko" "644" "runtime" -Local (Join-Path $Payload "modules/usb-net/cdc_ncm.ko"))
    Add-Candidate (New-Candidate "/data/codex/modules/usb-net/ax88179_178a.ko" "644" "runtime" -Local (Join-Path $Payload "modules/usb-net/ax88179_178a.ko"))
    Add-Candidate (New-Candidate "/data/codex/modules/usb-net/README.md" "644" "runtime" -Local (Join-Path $Payload "modules/usb-net/README.md"))
    Add-Candidate (New-Candidate "/etc/init.d/rcS.local" "755" "runtime" -Local (Join-Path $Payload "scripts/rcS.local"))
    if (-not $SkipCloudSuppression) {
        Add-Candidate (New-Candidate "/opt/luaworks/tasks/connectserver/netservicestarter.lua" "644" "runtime" -Local (Join-Path $Payload "scripts/netservicestarter.lua"))
    }
    Add-Candidate (New-Candidate "/pkg/codexactivity/codexactivity.lua" "644" "plugin" -Local (Join-Path $Payload "activity/codexactivity.lua"))
    Add-Candidate (New-Candidate "/pkg/codexmqtt/codexmqtt.lua" "644" "plugin" -Local (Join-Path $Payload "mqtt/codexmqtt.lua"))

    # Configuration: generated only in clean mode or when explicitly supplied.
    if ($CleanInstall -or $HubId) {
        Add-Candidate (New-Candidate "/data/codex/hub_id" "644" "config" -Text "$ResolvedHubId`n")
    }
    if ($CleanInstall) {
        $blocker = "1`n"
        if ($SkipCloudSuppression) { $blocker = "0`n" }
        Add-Candidate (New-Candidate "/data/codex/cloud_blocker.conf" "644" "config" -Text $blocker)
    } elseif (-not $SkipCloudSuppression) {
        # Without the file, codex_webui and netservicestarter.lua treat the
        # cloud as blocked but the egress guard and the activity writer
        # don't: create it, and keep whatever value is already there.
        Add-Candidate (New-Candidate "/data/codex/cloud_blocker.conf" "644" "config" -Text "1`n" -Condition "if-missing")
    }
    Add-Candidate (New-Candidate "/etc/tdeenable" "644" "config" -Text "1`n" -Condition "if-missing")
    Add-Candidate (New-Candidate "/pkg/codexactivity/manifest.json" "644" "config" -Text ('{"plugin":"codexactivity"}' + "`n") -Condition "if-missing")
    Add-Candidate (New-Candidate "/pkg/codexmqtt/manifest.json" "644" "config" -Text ('{"plugin":"codexmqtt"}' + "`n") -Condition "if-missing")
    # Multiple remotes of one model: only when asked, either way.
    if ($MultiRemote -eq "on") {
        $hal = Get-PatchedHal (Get-RemoteBytes $HalPath)
        Add-Candidate (New-Candidate $HalMultiDest "755" "binary" -Blob $hal)
        Add-Candidate (New-Candidate $MultiRemoteConf "644" "config" -Text "1`n")
    } elseif ($MultiRemote -eq "off") {
        # The copy itself goes after a successful install (Invoke-PostWiring).
        Add-Candidate (New-Candidate $MultiRemoteConf "644" "config" -Text "0`n")
    }
    if ($CleanInstall -or (Test-MqttExplicit)) {
        Add-Candidate (New-Candidate "/data/codexmqtt/config.json" "600" "config" -Text (Build-MqttConfig) -Sensitive)
    }

    # codex_webui is always the final replacement.
    Add-Candidate (New-Candidate $WebuiDest "755" "binary" -Local (Join-Path $Payload "bin/codex_webui"))
}

# --------------------------------------------------------------- staging

function New-StageSuffix() {
    # Random staging-dir suffix (the hub has no mktemp).
    $bytes = New-Object byte[] 6
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return ([BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
}

function New-StagingTree() {
    Step "Creating private staging tree"
    $stage = $StagePrefix + (New-StageSuffix)
    if ($stage -cnotmatch '^/var/volatile/codex-install-[0-9a-z]+$') { throw "unsafe staging path: $stage" }
    # mkdir fails if the path already exists, so the tree is ours alone.
    $q = Remote-Quote $stage
    $out = (Invoke-Remote "mkdir $q && chmod 700 $q && echo $q" $null 30000).Trim()
    if ($out -cne $stage) { throw "staging tree creation echoed '$out', expected '$stage'" }
    $script:Stage = $stage
    KV "staging_dir=$stage"
    Info "mode=0700 owner-only volatile staging; deleted before exit unless rollback needs it"
}

function Send-CandidatesToStage() {
    Step "Uploading candidates to staging"
    for ($i = 0; $i -lt $Candidates.Count; $i++) {
        $cand = $Candidates[$i]
        $name = "{0:D2}-{1}" -f $i, ($cand.Dest.Split('/')[-1])
        $cand.StagedName = $name
        $remote = "$Stage/$name"
        $command = "cat > $(Remote-Quote $remote) && chmod 600 $(Remote-Quote $remote)"
        $timeout = [Math]::Max(90000, 45000 + [int]($cand.Bytes / 12) )
        Invoke-Remote $command (Get-CandidateData $cand) $timeout | Out-Null
        $shown = $cand.Md5
        if ($cand.Sensitive) { $shown = "<hidden>" }
        KV "staged index=$i dest=$($cand.Dest) bytes=$($cand.Bytes) md5=$shown"
    }
}

function Send-FlashHelper() {
    $local = Join-Path $Payload "helpers/$FlashHelperName"
    if (-not (Test-Path -LiteralPath $local)) {
        $script:FlashNote = "payload/helpers/$FlashHelperName is missing"
        return
    }
    $remote = "$Stage/$FlashHelperName"
    Invoke-Remote "cat > $(Remote-Quote $remote) && chmod 700 $(Remote-Quote $remote)" ([IO.File]::ReadAllBytes($local)) 90000 | Out-Null
    $script:FlashHelperRemote = $remote
    Info "staged flash probe $remote (RAM only, never installed)"
}

function Measure-Flash() {
    # Free flash from codex_flash_free; leaves $FlashAvail $null on any doubt.
    $script:FlashAvail = $null
    if (-not $FlashHelperRemote) { return }
    $r = Invoke-RemoteRc "$(Remote-Quote $FlashHelperRemote) $FlashPath" $null 30000
    $re = '(?m)^flash type=(0x[0-9a-f]+) total_bytes=(\d+) free_bytes=(\d+) avail_bytes=(\d+) path=(\S+)\s*$'
    if ($r.Code -ne 0 -or $r.Out -cnotmatch $re -or $Matches[5] -cne $FlashPath) {
        $why = ($r.Err + $r.Out).Trim()
        if ($why.Length -gt 120) { $why = $why.Substring(0, 120) }
        if (-not $why) { $why = "exit $($r.Code)" }
        $script:FlashNote = "the flash probe didn't answer ($why)"
        return
    }
    $total = [long]$Matches[2]
    $avail = [long]$Matches[4]
    if ($total -lt 1048576 -or $total -gt 64 * 1048576 -or $avail -gt $total) {
        $script:FlashNote = "the flash probe reported an unlikely size (total $total, available $avail)"
        return
    }
    $script:FlashTotal = $total
    $script:FlashAvail = $avail
    $script:FlashNote = ""
}

function Test-StagedMd5() {
    Step "Verifying staged candidate MD5 (strict BusyBox format)"
    $md5Re = '^[0-9a-f]{32}  .+$'
    $entries = @{}
    $paths = @()
    foreach ($cand in $Candidates) {
        if ($cand.Sensitive) { continue }
        $entries["$Stage/$($cand.StagedName)"] = $cand.Md5
        $paths += Remote-Quote "$Stage/$($cand.StagedName)"
    }
    $out = Invoke-Remote ("md5sum " + ($paths -join " ")) $null 120000
    $seen = @{}
    foreach ($line in ($out -split "`n")) {
        $line = $line.Trim()
        if (-not $line) { continue }
        if ($line -cnotmatch $md5Re) { throw "unexpected md5sum output line: $line" }
        $parts = $line -split "  ", 2
        $digest = $parts[0]
        $path = $parts[1]
        if (-not $entries.Contains($path)) { throw "md5sum reported unexpected path: $path" }
        if ($digest -cne $entries[$path]) { throw "staged md5 mismatch for ${path}: expected $($entries[$path]) got $digest" }
        $seen[$path] = $true
    }
    foreach ($path in $entries.Keys) {
        if (-not $seen.Contains($path)) { throw "md5sum output missing entry: $path" }
    }
    # Sensitive candidates: verify but never print the digest. Require
    # exactly one matched line per expected path; a short response fails.
    foreach ($cand in $Candidates) {
        if (-not $cand.Sensitive) { continue }
        $remote = "$Stage/$($cand.StagedName)"
        $r = Invoke-RemoteRc ("md5sum " + (Remote-Quote $remote)) $null 60000
        if ($r.Code -ne 0) { throw "staged sensitive candidate failed md5 verification: $($cand.Dest)" }
        $matched = 0
        foreach ($line in ($r.Out -split "`n")) {
            $line = $line.Trim()
            if (-not $line) { continue }
            if ($line -cnotmatch $md5Re) { throw "unexpected md5sum output for $($cand.Dest)" }
            $parts = $line -split "  ", 2
            if ($parts[1] -cne $remote -or $parts[0] -cne $cand.Md5) {
                throw "staged sensitive candidate failed md5 verification: $($cand.Dest)"
            }
            $matched++
        }
        if ($matched -ne 1) { throw "staged sensitive candidate failed md5 verification: $($cand.Dest)" }
    }
    Info "all staged candidates verified"
}

function Get-RemoteMd5([string]$Path) {
    $r = Invoke-RemoteRc ("md5sum " + (Remote-Quote $Path)) $null 90000
    $first = ($r.Out.Trim() -split "`n")[0].Trim()
    if ($r.Code -ne 0 -or $first -cnotmatch '^[0-9a-f]{32}  .+$') { return "" }
    $parts = $first -split "  ", 2
    if ($parts[1] -cne $Path) { return "" }
    return $parts[0]
}

# ------------------------------------------------------------- discovery

function ConvertTo-OctalMode([string]$Perm) {
    # Octal mode from an `ls -l` permission string, e.g. -rwxr-xr-x -> 755.
    if ($Perm -cnotmatch '^-[r-][w-][xsS-][r-][w-][xsS-][r-][w-][xtT-]$') { throw "bad permissions $Perm" }
    $special = 0
    $digits = ""
    $flags = @(4, 2, 1)
    for ($g = 0; $g -lt 3; $g++) {
        $r = $Perm[1 + 3 * $g]; $w = $Perm[2 + 3 * $g]; $x = $Perm[3 + 3 * $g]
        $value = 0
        if ($r -ceq 'r') { $value += 4 }
        if ($w -ceq 'w') { $value += 2 }
        if ('xst'.Contains([string]$x)) { $value += 1 }
        if ('sStT'.Contains([string]$x)) { $special = $special -bor $flags[$g] }
        $digits += [string]$value
    }
    if ($special) { return "$special$digits" }
    return $digits
}

function Get-FileStatus([string[]]$Paths) {
    # One BusyBox-only probe for many paths: just test, ls -l, and md5sum.
    $quoted = ($Paths | ForEach-Object { Remote-Quote $_ }) -join " "
    $cmd = "for p in $quoted; do " +
        'if [ -L "$p" ]; then echo "file_status type=symlink path=$p"; ' +
        'elif [ -f "$p" ]; then set -- $(ls -l "$p"); m=$(md5sum "$p"); ' +
        'echo "file_status type=regular perm=$1 bytes=$5 md5=${m%% *} path=$p"; ' +
        'elif [ -e "$p" ]; then echo "file_status type=other path=$p"; ' +
        'else echo "file_status type=absent path=$p"; fi; done'
    $r = Invoke-RemoteRc $cmd $null 180000
    if ($r.Code -ne 0) { Stop-WithValidation "file-status probe failed (exit $($r.Code)): $($r.Err.Trim())" }
    # Strict: every requested path exactly once with a known type; regular
    # files need valid permissions, a decimal size, and a 32-hex md5.
    $lineRe = '^file_status type=(\S+)(?: perm=(\S*) bytes=(\S*) md5=(\S*))? path=(.+)$'
    $states = @{}
    foreach ($line in ($r.Out -split "`n")) {
        $line = $line.Trim()
        if (-not $line) { continue }
        if ($line -cnotmatch $lineRe) { Stop-WithValidation "file-status: unexpected probe line: $line" }
        $kind = $Matches[1]; $perm = $Matches[2]; $size = $Matches[3]; $md5 = $Matches[4]; $path = $Matches[5]
        if ($Paths -cnotcontains $path) { Stop-WithValidation "file-status: probe reported unexpected path: $path" }
        if ($states.Contains($path)) { Stop-WithValidation "file-status: probe reported $path twice" }
        if ($kind -cnotin @("absent", "regular", "symlink", "other")) { Stop-WithValidation "file-status for $path reported invalid type $kind" }
        if ($kind -cne "regular") {
            if ($null -ne $perm) { Stop-WithValidation "file-status for ${path}: $kind with file fields: $line" }
            $states[$path] = @{ kind = $kind; size = "0"; mode = ""; md5 = "" }
            continue
        }
        $mode = ""
        try { $mode = ConvertTo-OctalMode $perm } catch { Stop-WithValidation "file-status for $path reported invalid permissions $perm" }
        if ($size -cnotmatch '^\d+$') { Stop-WithValidation "file-status for $path reported invalid size $size" }
        if ($md5 -cnotmatch '^[0-9a-f]{32}$') { Stop-WithValidation "file-status for ${path}: regular file without a computed md5" }
        $states[$path] = @{ kind = "regular"; size = $size; mode = $mode; md5 = $md5 }
    }
    foreach ($path in $Paths) {
        if (-not $states.Contains($path)) { Stop-WithValidation "file-status: probe output missing $path" }
    }
    return $states
}

function Invoke-DestinationProbe() {
    Step "Probing destination state (BusyBox ls -l / md5sum)"
    $dests = @($Candidates | ForEach-Object { $_.Dest })
    foreach ($p in ($HandoffRequiredPaths + @($RootToolDropbear, $HalMultiDest))) { if ($dests -notcontains $p) { $dests += $p } }
    $script:Probe = Get-FileStatus $dests
    foreach ($cand in $Candidates) {
        $kind = $Probe[$cand.Dest]["kind"]
        if ($kind -in @("symlink", "other")) {
            Stop-WithValidation "destination $($cand.Dest) is a $kind, not a regular file"
        }
    }
}

function Stop-WithValidation([string]$Reason) {
    $script:Verdict = $VerdictValidation
    $VerdictReasons.Add($Reason) | Out-Null
    throw $Reason
}

function Resolve-HubIdentity() {
    $hubId = $HubId
    $existing = (Invoke-Remote "cat /data/codex/hub_id 2>/dev/null || true" $null 30000).Trim()
    if (-not $existing -and -not $CleanInstall) {
        # A hub without /data/codex/hub_id has no configuration of ours to
        # preserve, so the first install writes it, as -CleanInstall does.
        $script:CleanInstall = $true
        $script:FirstInstall = $true
        Info "first install: the hub has no /data/codex/hub_id yet, so this run writes the configuration (as -CleanInstall)"
    }
    if (-not $hubId) {
        if ($existing) {
            $hubId = $existing
            Info "hub id from existing /data/codex/hub_id: $hubId"
        } else {
            $saved = Resolve-SavedHubId $HubHost
            if ($saved) {
                $hubId = $saved.HubId
                Info "hub id from root-tool handoff: $hubId ($($saved.Source))"
            }
        }
    }
    if (-not (Test-HubId $hubId)) {
        if ($hubId) {
            throw "Invalid Hub ID '$hubId'. Re-run the root tool or pass the numeric Hub ID with -HubId."
        }
        throw "Hub ID is required. Re-run the root tool so it writes the handoff file, or pass -HubId with the numeric value printed as hub_id=..."
    }
    $script:ResolvedHubId = $hubId
    Info "using hub id $hubId"
}

function Set-UpgradeGates() {
    foreach ($cand in $Candidates) {
        $state = $null
        if ($Probe.Contains($cand.Dest)) { $state = $Probe[$cand.Dest] }
        $exists = ($null -ne $state) -and ($state["kind"] -eq "regular")
        if ($cand.Condition -eq "if-missing" -and $exists -and -not $CleanInstall) {
            $cand.Action = "preserve"
        } elseif ($exists -and ($state["mode"] -ceq $cand.Mode) -and (Test-HubCopyCurrent $cand.Dest ([string]$state["md5"]) $cand.Md5)) {
            $cand.Action = "unchanged"
        } elseif ($exists) {
            $cand.Action = "replace"
        } else {
            $cand.Action = "create"
        }
    }
    # Upgrade mode: hub_id must exist or be explicitly supplied.
    $hubState = $null
    if ($Probe.Contains("/data/codex/hub_id")) { $hubState = $Probe["/data/codex/hub_id"] }
    $hasHubCandidate = [bool]($Candidates | Where-Object { $_.Dest -eq "/data/codex/hub_id" })
    if (-not $CleanInstall -and (($null -eq $hubState) -or ($hubState["kind"] -ne "regular")) -and -not $hasHubCandidate) {
        $script:Verdict = $VerdictConfigUncertain
        $VerdictReasons.Add("upgrade mode: /data/codex/hub_id missing and no explicit -HubId supplied") | Out-Null
    }
}

function Set-DropbearLink() {
    # Reuse harmony-hub-root's dropbearmulti when it is the same build as
    # ours, or another build of the same Dropbear ($DropbearBuilds).
    $source = $null
    if ($Probe.Contains($RootToolDropbear)) { $source = $Probe[$RootToolDropbear] }
    if ($null -eq $source -or $source["kind"] -ne "regular") { return }
    $md5 = [string]$source["md5"]
    foreach ($cand in $Candidates) {
        if ($cand.Dest -eq $DropbearDest -and $cand.Action -in @("replace", "create") -and
            (Test-HubCopyCurrent $cand.Dest $md5 $cand.Md5)) {
            $cand.LinkSource = $RootToolDropbear
            $cand.LinkMd5 = $md5
            $cand.LinkBytes = [long]$source["size"]
        }
    }
}

function Get-RootToolLeftovers() {
    $out = Invoke-Remote $RootToolScan $null 60000
    $RootToolStages.Clear()
    $DropbearCopies.Clear()
    $DropbearLinks.Clear()
    foreach ($line in ($out -split "`n")) {
        $line = $line.Trim()
        if ($line -cmatch '^root_tool_stage bytes=(\d+) files=(\d+) path=(\S+)$') {
            # Copy the groups first: the next -cmatch replaces $Matches.
            $stage = @{ Path = $Matches[3]; Bytes = [long]$Matches[1]; Files = [long]$Matches[2] }
            if ($stage.Path -cmatch $RootToolStagePattern) { $RootToolStages.Add($stage) | Out-Null }
            continue
        }
        if ($line -cmatch '^dropbear_copy inode=(\d+) links=(\d+) path=(\S+)$') {
            $inode = $Matches[1]
            $links = [int]$Matches[2]
            $path = $Matches[3]
            if ($path -in @($RootToolDropbear, $DropbearDest)) {
                $DropbearCopies[$path] = $inode
                $DropbearLinks[$path] = $links
            }
        }
    }
}

function Test-RootToolDropbearRemovable() {
    # True when the root tool's Dropbear is a separate copy that SSH no longer
    # uses and phase 1 won't link.
    # Separate means its only name: with a second link (ours, or anything
    # else), removing it frees nothing. Inode numbers can't tell: the hub's
    # unionfs numbers each path afresh after a reboot.
    if (-not ($DropbearCopies.Contains($DropbearDest) -and $DropbearLinks.Contains($RootToolDropbear))) { return $false }
    if ($DropbearLinks[$RootToolDropbear] -ne 1) { return $false }
    # And only while ours is a working Dropbear: never trade the root tool's
    # copy for a damaged one.
    if (-not ($Probe.Contains($DropbearDest) -and ($DropbearBuilds.Keys -ccontains [string]$Probe[$DropbearDest]["md5"]))) { return $false }
    $wrapper = $Candidates | Where-Object { $_.Dest -eq "/usr/sbin/dropbear" } | Select-Object -First 1
    if ($null -eq $wrapper -or -not $Probe.Contains("/usr/sbin/dropbear")) { return $false }
    if ($Probe["/usr/sbin/dropbear"]["md5"] -cne $wrapper.Md5) { return $false }
    return -not [bool]($Candidates | Where-Object { $_.LinkSource -eq $RootToolDropbear })
}

function Get-LeftoverCredit() {
    # Flash the removable root-tool leftovers are estimated to free. Base64
    # chunks compress to about two thirds; count three fifths.
    $credit = [long]0
    foreach ($s in $RootToolStages) { $credit += [long][Math]::Floor($s.Bytes * 3 / 5) }
    if (Test-RootToolDropbearRemovable) {
        $dropbear = $Candidates | Where-Object { $_.Dest -eq $DropbearDest } | Select-Object -First 1
        if ($null -ne $dropbear -and $dropbear.Bytes -gt 0) {
            # Scaled to the root tool's copy, which may be the smaller build.
            # (Its stripped .pdr compressed well, so this errs low: safe.)
            $size = [long]$dropbear.Bytes
            if ($Probe.Contains($RootToolDropbear) -and $Probe[$RootToolDropbear]["size"]) { $size = [long]$Probe[$RootToolDropbear]["size"] }
            $credit += [long][Math]::Floor($dropbear.FlashBytes * $size / $dropbear.Bytes)
        }
    }
    return $credit
}

function Get-ActiveCandidates() {
    return @($Candidates | Where-Object { $_.Action -in @("replace", "create") })
}

function Get-RamStatus() {
    # Usable RAM from /proc/meminfo; staging and rollback copies live in tmpfs.
    # The hub kernel has no MemAvailable, so credit what the kernel reclaims for
    # tmpfs on demand: inactive file cache and reclaimable slab (see install_webui.py).
    $out = Invoke-Remote "cat /proc/meminfo" $null 30000
    if ($out -cnotmatch '(?m)^MemFree:\s+(\d+) kB\s*$') { Stop-WithValidation "could not read MemFree from /proc/meminfo" }
    $kb = [long]$Matches[1]
    foreach ($field in 'Inactive\(file\)', 'SReclaimable') {
        if ($out -cmatch "(?m)^${field}:\s+(\d+) kB\s*$") { $kb += [long]$Matches[1] }
    }
    $script:RamFreeBytes = $kb * 1024
}

function Build-Plans() {
    Step "Planning changed destinations"
    $script:ForwardTotal = 0
    $script:RollbackTotal = 0
    $script:StagedTotal = 0
    $script:FlashReleased = 0
    $copies = [long]0
    foreach ($cand in $Candidates) {
        $script:StagedTotal += $cand.Bytes
        $state = $Probe[$cand.Dest]
        if ($cand.Action -in @("replace", "create")) {
            $script:ForwardTotal += $cand.Bytes
            if (-not $cand.LinkSource) { $copies += $cand.FlashBytes }
        }
        if ($cand.Action -eq "replace") {
            $old = [long]$state["size"]
            $script:RollbackTotal += $old
            # The replaced original's flash comes back after the rename;
            # assume it compressed like its replacement.
            $script:FlashReleased += [long][Math]::Floor($cand.FlashBytes * $old / [Math]::Max($cand.Bytes, 1))
        }
        $existsFlag = 0
        if ($state["kind"] -eq "regular") { $existsFlag = 1 }
        $link = ""
        if ($cand.LinkSource) { $link = " link=$($cand.LinkSource)" }
        KV "destination dest=$($cand.Dest) exists=$existsFlag action=$($cand.Action) bytes=$($cand.Bytes) mode=$($cand.Mode)$link"
    }
    # Staged candidates already occupy RAM; rollback copies are added next.
    $script:RamRequiredBytes = $RollbackTotal + $RamMarginBytes
    # Phase 1 writes every new copy before any original goes, after the
    # handoff backup: text the installer hasn't read, assumed to halve.
    $handoff = [long]0
    if ((Get-ActiveCandidates).Count -gt 0) { $handoff = [long][Math]::Floor($HandoffEstimate / 2) + 1024 }
    $script:FlashWritten = $copies + $handoff
    $margin = [long]0
    if ($copies -gt 0) { $margin = Get-FlashMargin $copies }
    $script:FlashRequired = $FlashWritten + $margin
}

function Get-FlashAfter() {
    # Estimated free flash once the install (and any opted-in cleanup) is done.
    $credit = [long]0
    if ($RemoveRootToolLeftovers) { $credit = Get-LeftoverCredit }
    $avail = [long]0
    if ($null -ne $FlashAvail) { $avail = $FlashAvail }
    return [long][Math]::Max(0, $avail + $credit - $FlashWritten + $FlashReleased)
}

function Get-FlashShortfall([long]$Credit = 0) {
    # Bytes of flash missing for phase 1; 0 when enough or not measured.
    if ($null -eq $FlashAvail) { return [long]0 }
    return [long][Math]::Max(0, $FlashRequired - $FlashAvail - $Credit)
}

function Get-UpdateFlashNeed() {
    # Flash a later codex_webui update needs while both copies exist.
    $webui = $Candidates | Where-Object { $_.Dest -eq $WebuiDest } | Select-Object -First 1
    return [long]($webui.FlashBytes + (Get-FlashMargin $webui.FlashBytes))
}

function Count-BackupGenerations() {
    $cmd = 'for d in /data/codex-backups /data/codex/resource-backups /data/codex/update-backups; do [ -d "$d" ] || continue; for n in "$d"/*; do [ -e "$n" ] && echo "$n"; done; done'
    $out = Invoke-Remote $cmd $null 30000
    foreach ($line in ($out -split "`n")) {
        $path = $line.Trim()
        $name = $path.Split('/')[-1]
        if (-not $name) { continue }
        if ($name -match '^webui-handoff-\d{8}-\d{6}$') {
            $Generations["handoff"]++
            if ($path -ceq "$HandoffRoot/$name") { $HandoffDirs.Add($path) | Out-Null }
        }
        elseif ($name -match '^settings_\d{8}_\d{6}$') { $Generations["settings"]++ }
        elseif ($name -match '^\d{8}_\d{6}$') { $Generations["resource"]++ }
        elseif ($name -match '^\d+$') { $Generations["update"]++ }
    }
}

function Get-HandoffEstimate() {
    $total = 0
    foreach ($path in $HandoffRequiredPaths) {
        if ($Probe.Contains($path) -and $Probe[$path]["kind"] -eq "regular") {
            $total += [long]$Probe[$path]["size"]
        }
    }
    $script:HandoffEstimate = $total
}

function Set-Verdict() {
    if ($Verdict -eq $VerdictConfigUncertain) { return }
    $credit = [long]0
    if ($RemoveRootToolLeftovers) { $credit = Get-LeftoverCredit }
    if ($RamFreeBytes -lt $RamRequiredBytes) {
        $script:Verdict = $VerdictRollbackCapacity
        $VerdictReasons.Add("free RAM $RamFreeBytes < rollback copies + margin $RamRequiredBytes") | Out-Null
    } elseif ((Get-FlashShortfall $credit) -gt 0 -and -not $SkipFlashCheck) {
        $script:Verdict = $VerdictCapacity
        $script:CapacityStage = "preflight"
        $reason = "free flash $FlashAvail < estimated need $FlashRequired"
        if ($credit -gt 0) { $reason += " (after about $credit freed from root-tool leftovers)" }
        $VerdictReasons.Add($reason) | Out-Null
    } else {
        $script:Verdict = $VerdictAllowed
    }
}

# ---------------------------------------------------------------- report

function Show-PreflightReport() {
    # NOTE(InstallerCliUX): human-facing Step/Info strings in this function are
    # owned by InstallerCliUX; the KV key=value lines are the stable contract.
    Step "Preflight report"
    Info "Status so far uses private volatile staging under /var/volatile/codex-install-* only."
    Info "No persistent hub paths have been written, pruned, handed off, installed, or restarted yet."
    if ($PreflightOnly) {
        Info "Mode: -PreflightOnly — stages, verifies, compares, and prints a terminal verdict; performs no persistent writes and no service actions."
    }
    if ($FirstInstall) {
        Info "Install mode: first install — the hub has no configuration of ours yet, so configuration candidates are written."
    } elseif ($CleanInstall) {
        Info "Install mode: explicit clean install — configuration candidates are regenerated."
    } else {
        Info "Install mode: default upgrade — existing configuration is preserved unless a candidate explicitly replaces it."
    }
    $mode = "upgrade"
    if ($CleanInstall) { $mode = "clean" }
    KV "preflight_mode=$mode"
    if ($MultiRemoteForce) { KV "multi_remote=force-off" } elseif ($MultiRemote) { KV "multi_remote=$MultiRemote" } else { KV "multi_remote=unchanged" }
    if ($MultiRemote -eq "on") {
        Info "Multiple remotes of one model: $HalMultiDest is the hub's own hal with per-slot remote threads and the one-remote-per-model rule lifted for remotes without a screen; rcS.local runs it from the next boot."
    }
    KV "candidate_count=$($Candidates.Count)"
    KV "changed_count=$((Get-ActiveCandidates).Count)"
    Info "Candidate destinations and nonsensitive expected MD5 hashes (sensitive values redacted):"
    for ($i = 0; $i -lt $Candidates.Count; $i++) {
        $cand = $Candidates[$i]
        $shown = $cand.Md5
        if ($cand.Sensitive) { $shown = "<hidden>" }
        KV "candidate index=$i dest=$($cand.Dest) bytes=$($cand.Bytes) md5=$shown mode=$($cand.Mode) kind=$($cand.Kind) action=$($cand.Action) flash=$($cand.FlashBytes)"
        Info "candidate[$i] path=$($cand.Dest) expected_md5=$shown bytes=$($cand.Bytes) mode=$($cand.Mode) action=$($cand.Action)"
    }
    if (-not $CleanInstall) {
        KV "protected_upgrade_paths=$($UpgradeProtectedPaths -join ',')"
        Info "Upgrade protects existing configuration at: $($UpgradeProtectedPaths -join ', ')"
    }
    KV "backup_generations handoff=$($Generations['handoff']) resource=$($Generations['resource']) settings=$($Generations['settings']) update=$($Generations['update'])"
    KV "handoff_estimate_bytes=$HandoffEstimate"
    if ($null -eq $FlashAvail) { KV "flash_capacity_check=two-phase-commit" } else { KV "flash_capacity_check=measured" }
    KV "forward_total_bytes=$ForwardTotal"
    KV "rollback_total_bytes=$RollbackTotal"
    KV "staged_total_bytes=$StagedTotal"
    KV "ram_free_bytes=$RamFreeBytes"
    KV "ram_required_bytes=$RamRequiredBytes"
    KV "flash_required_bytes=$FlashRequired"
    if ($null -ne $FlashAvail) {
        KV "flash_total_bytes=$FlashTotal"
        KV "flash_free_bytes=$FlashAvail"
        KV "flash_after_bytes=$(Get-FlashAfter)"
    }
    Show-FlashReport
    Info "RAM: free=$RamFreeBytes required=$RamRequiredBytes (rollback copies $RollbackTotal + margin $RamMarginBytes)"
    foreach ($reason in $VerdictReasons) {
        KV "verdict_reason=$reason"
        Info "verdict_reason: $reason"
    }
    Show-Verdict
}

function Show-FlashReport() {
    # NOTE(InstallerCliUX): human-facing prose; the KV key=value lines are the
    # stable contract.
    if ($null -eq $FlashAvail) {
        Info "Free flash couldn't be measured ($FlashNote): changed files (about $(Format-KB $FlashWritten) on flash) are written as $NewSuffix copies first, and the install stops with no live changes if flash fills up."
    } else {
        Info "Flash: $(Format-KB $FlashAvail) free of $(Format-KB $FlashTotal). The changed files need about $(Format-KB $FlashRequired) while old and new copies both exist (an estimate with a safety margin)."
        if ((Get-FlashShortfall) -gt 0 -and $SkipFlashCheck) {
            Info "-SkipFlashCheck: installing anyway; the install stops with no live changes if flash fills up."
        }
        $after = Get-FlashAfter
        Info "About $(Format-KB $after) will be free afterwards."
        $updateNeed = Get-UpdateFlashNeed
        if ($after -lt $updateNeed) {
            Info "That is less than the $(Format-KB $updateNeed) a later web UI update needs. Free some space before updating (see the README)."
        }
    }
    foreach ($cand in (Get-ActiveCandidates)) {
        if ($cand.LinkSource) {
            KV "flash_link dest=$($cand.Dest) source=$($cand.LinkSource)"
            Info "$($cand.Dest): harmony-hub-root's copy of the same Dropbear at $($cand.LinkSource) is reused as a hard link, so it takes no extra flash."
        }
    }
    $leftovers = @()
    foreach ($s in $RootToolStages) { $leftovers += ,@($s.Path, [long]$s.Bytes, [long]$s.Files) }
    if (Test-RootToolDropbearRemovable) { $leftovers += ,@($RootToolDropbear, [long]$Probe[$RootToolDropbear]["size"], [long]1) }
    foreach ($l in $leftovers) {
        KV "root_tool_leftover bytes=$($l[1]) files=$($l[2]) path=$($l[0])"
        $what = "staging files"
        if ($l[0] -eq $RootToolDropbear) { $what = "a second copy of Dropbear that SSH no longer uses" }
        Info "harmony-hub-root left $($l[0]) behind: $what, $(Format-KB $l[1]) in $($l[2]) file(s)."
    }
    if ($leftovers.Count -gt 0) {
        if ($RemoveRootToolLeftovers -and -not $PreflightOnly) {
            Info "They are removed before the install (-RemoveRootToolLeftovers)."
        } else {
            Info "Run the installer with -RemoveRootToolLeftovers to remove them and free that flash."
        }
    }
}

function Show-Verdict() {
    # NOTE(InstallerCliUX): human-facing verdict prose is owned by
    # InstallerCliUX; the verdict= KV line is the stable contract.
    KV "verdict=$Verdict"
    Info "Terminal verdict: $Verdict"
    if ($Verdict -eq $VerdictAllowed) {
        Info "ALLOWED — validation and RAM headroom are sufficient for the selected mode."
        if ($PreflightOnly) {
            Info "Preflight-only complete: volatile staging will be removed; no persistent changes or service actions were performed."
        } else {
            Info "Persistent install may proceed after this report ($NewSuffix copies, then same-directory renames)."
        }
    } elseif ($Verdict -eq $VerdictCapacity -and $CapacityStage -eq "preflight") {
        $free = [long]0
        if ($null -ne $FlashAvail) { $free = $FlashAvail }
        Info "BLOCKED_CAPACITY — not enough free flash: about $(Format-KB $FlashRequired) needed, $(Format-KB $free) free. Nothing was installed."
        if (($RootToolStages.Count -gt 0 -or (Test-RootToolDropbearRemovable)) -and -not $RemoveRootToolLeftovers) {
            Info "Removing harmony-hub-root's leftovers (-RemoveRootToolLeftovers) frees about $(Format-KB (Get-LeftoverCredit))."
        }
        Info "Otherwise free space on the hub, or pass -SkipFlashCheck to try anyway: the install still stops with no live changes if flash fills up."
    } elseif ($Verdict -eq $VerdictCapacity) {
        Info "BLOCKED_CAPACITY — flash filled up while writing the new copies; they were removed and no live file changed."
    } elseif ($Verdict -eq $VerdictRollbackCapacity) {
        Info "BLOCKED_ROLLBACK_CAPACITY — not enough free RAM to hold rollback copies of the files being replaced. No persistent changes."
    } elseif ($Verdict -eq $VerdictConfigUncertain) {
        Info "BLOCKED_CONFIGURATION_UNCERTAINTY — required configuration state is missing or ambiguous for default upgrade; pass -HubId or use -CleanInstall. No persistent changes."
    } else {
        Info "BLOCKED_VALIDATION_FAILURE — staging, path, hash, or probe validation failed; see verdict_reason lines above. No persistent changes."
    }
}

# ---------------------------------------------------------------- mutate

function Add-RollbackCopies() {
    Step "Preparing volatile rollback copies"
    $md5Re = '^[0-9a-f]{32}  .+$'
    # Build rollback records in candidate install order (replaces and creates
    # interleaved) so reverse-order rollback is true reverse install order.
    for ($i = 0; $i -lt $Candidates.Count; $i++) {
        $cand = $Candidates[$i]
        if ($cand.Action -eq "replace") {
            $state = $Probe[$cand.Dest]
            $rb = "$Stage/rb-{0:D2}-{1}" -f $i, ($cand.Dest.Split('/')[-1])
            $cmd = "cp -p $(Remote-Quote $cand.Dest) $(Remote-Quote $rb) && chmod 600 $(Remote-Quote $rb) && md5sum $(Remote-Quote $rb)"
            $out = Invoke-Remote $cmd $null 90000
            $last = ($out.Trim() -split "`n")[-1].Trim()
            if ($last -cnotmatch $md5Re) { throw "rollback copy verification failed for $($cand.Dest)" }
            $digest = ($last -split "  ", 2)[0]
            if ($digest -cne $state["md5"]) { throw "rollback copy verification failed for $($cand.Dest)" }
            $Changed.Add(@{
                Dest = $cand.Dest
                Mode = $state["mode"]
                Md5 = $state["md5"]
                Rb = $rb
                WasAbsent = $false
                Done = $false
            }) | Out-Null
            $shown = $state['md5']
            if ($cand.Sensitive) { $shown = "<hidden>" }
            Info "rollback copy ready dest=$($cand.Dest) mode=$($state['mode']) md5=$shown"
        } elseif ($cand.Action -eq "create") {
            $Changed.Add(@{
                Dest = $cand.Dest
                Mode = $cand.Mode
                Md5 = ""
                Rb = ""
                WasAbsent = $true
                Done = $false
            }) | Out-Null
        }
    }
}

function Invoke-HandoffPrune() {
    # Keep only the newest $HandoffKeep installer handoff generations. Only
    # installer-owned webui-handoff-<stamp> directories directly under
    # $HandoffRoot are ever removed; other backups are never touched.
    Step "Pruning installer handoff backups (keeping newest $HandoffKeep)"
    $sorted = @($HandoffDirs | Sort-Object)
    $count = [Math]::Max(0, $sorted.Count - $HandoffKeep)
    $pattern = '^' + [regex]::Escape($HandoffRoot) + '/webui-handoff-\d{8}-\d{6}$'
    for ($i = 0; $i -lt $count; $i++) {
        $path = $sorted[$i]
        if ($path -cnotmatch $pattern) { throw "refusing to prune unexpected path '$path'" }
        $r = Invoke-RemoteRc ("rm -rf " + (Remote-Quote $path)) $null 60000
        if ($r.Code -ne 0) { Info "warning: could not prune ${path}: $($r.Err.Trim())" } else { KV "pruned=$path" }
    }
    if ($count -eq 0) { Info "nothing to prune" }
}

function New-HandoffBackup() {
    Step "Creating bounded handoff backup"
    # Sizes come from the BusyBox probe; the budget guard runs on the hub.
    $cmd = "S=`$(date -u +%Y%m%d-%H%M%S); B=$HandoffRoot; " +
        'I="$B/.incomplete-webui-handoff-$S"; ' +
        'mkdir -p "$B" || exit 1; mkdir "$I" || exit 1; tot=0; '
    foreach ($path in $HandoffRequiredPaths) {
        if (-not ($Probe.Contains($path) -and $Probe[$path]["kind"] -eq "regular")) { continue }
        $size = [long]$Probe[$path]["size"]
        $cmd += "sz=$size; " +
            "if [ `$((tot + sz)) -le $HandoffBudgetBytes ]; then " +
            "n=`$(echo $(Remote-Quote $path) | sed 's#/#_#g'); " +
            "cp -p $(Remote-Quote $path) `"`$I/`$n`" || { rm -rf `"`$I`"; exit 1; }; " +
            'tot=$((tot + sz)); ' +
            "else echo `"handoff_skipped=$path`"; fi; "
    }
    $cmd += 'mv "$I" "$B/webui-handoff-$S" || { rm -rf "$I"; exit 1; }; ' +
        'echo "handoff=$B/webui-handoff-$S"'
    $out = Invoke-Remote $cmd $null 120000
    $created = $null
    foreach ($line in ($out.Trim() -split "`n")) {
        Info $line
        if ($line.StartsWith("handoff=")) { $created = $line.Substring(8).Trim() }
    }
    if (-not $created) { throw "handoff directory rename did not complete" }
    $HandoffDirs.Add($created) | Out-Null
}

function Remove-RootToolLeftovers() {
    # Delete harmony-hub-root's staging folders and, while SSH runs ours, its
    # spare Dropbear. Opted in with -RemoveRootToolLeftovers; not rolled back,
    # since nothing reads them.
    Step "Removing harmony-hub-root leftovers"
    foreach ($s in @($RootToolStages)) {
        $path = [string]$s.Path
        if ($path -cnotmatch $RootToolStagePattern) { throw "refusing to remove unexpected path '$path'" }
        $r = Invoke-RemoteRc ("rm -rf " + (Remote-Quote $path)) $null 120000
        if ($r.Code -ne 0) { Info "warning: could not remove ${path}: $($r.Err.Trim())" } else { KV "removed_leftover=$path" }
    }
    if (Test-RootToolDropbearRemovable) {
        $r = Invoke-RemoteRc $RootToolDropbearRemove $null 30000
        if ($r.Code -eq 0 -and $r.Out.Trim() -eq "removed") {
            KV "removed_leftover=$RootToolDropbear"
        } else {
            Info "kept ${RootToolDropbear}: SSH doesn't run the installed Dropbear yet"
        }
    }
    Get-RootToolLeftovers
    Measure-Flash
    if ($null -ne $FlashAvail) {
        KV "flash_free_after_cleanup_bytes=$FlashAvail"
        Info "Flash free after removing them: $(Format-KB $FlashAvail)."
    }
}

function Show-FlashAfterInstall() {
    Measure-Flash
    if ($null -eq $FlashAvail) { return }
    KV "flash_free_after_bytes=$FlashAvail"
    Info "Flash free after the install: $(Format-KB $FlashAvail)."
    $updateNeed = Get-UpdateFlashNeed
    if ($FlashAvail -lt $updateNeed) {
        Info "A later web UI update needs about $(Format-KB $updateNeed). Free some space before updating (see the README)."
    }
}

function Remove-NewCopies() {
    # Remove every <dest>.codex-new this run wrote; return those that failed.
    $failed = @()
    foreach ($path in @($NewCopies)) {
        $r = Invoke-RemoteRc ("rm -f " + (Remote-Quote $path)) $null 30000
        if ($r.Code -ne 0) { $failed += $path }
    }
    $NewCopies.Clear()
    return $failed
}

function Add-NewCopyLink($Cand, [string]$New) {
    # Hard-link an identical (or equivalent) file already on the hub as <dest>.codex-new.
    $cmd = "ln $(Remote-Quote $Cand.LinkSource) $(Remote-Quote $New) && " +
        "chmod $(Remote-Quote $Cand.Mode) $(Remote-Quote $New) && md5sum $(Remote-Quote $New)"
    $r = Invoke-RemoteRc $cmd $null 60000
    $last = ($r.Out.Trim() -split "`n")[-1].Trim()
    if (($r.Code -eq 0) -and ($last -cmatch '^[0-9a-f]{32}  .+$') -and (($last -split "  ", 2)[0] -ceq $Cand.LinkMd5)) {
        Info "linked dest=$New to $($Cand.LinkSource) (no extra flash)"
        $Cand.Linked = $true
        return $true
    }
    Invoke-RemoteRc ("rm -f " + (Remote-Quote $New)) $null 30000 | Out-Null
    $why = $r.Err.Trim()
    if (-not $why) { $why = "verification failed" }
    Info "could not link $($Cand.LinkSource) ($why); copying instead"
    return $false
}

function Write-NewCopies() {
    # Phase 1: write and verify <dest>.codex-new next to every changed dest.
    Step "Phase 1: writing verified $NewSuffix copies (no live file changes)"
    foreach ($cand in (Get-ActiveCandidates)) {
        $new = $cand.Dest + $NewSuffix
        $NewCopies.Add($new) | Out-Null
        if ($cand.LinkSource -and (Add-NewCopyLink $cand $new)) { continue }
        $cmd = "cp $(Remote-Quote "$Stage/$($cand.StagedName)") $(Remote-Quote $new) && " +
            "chmod $(Remote-Quote $cand.Mode) $(Remote-Quote $new) && md5sum $(Remote-Quote $new)"
        $r = Invoke-RemoteRc $cmd $null 180000
        $last = ($r.Out.Trim() -split "`n")[-1].Trim()
        $ok = ($r.Code -eq 0) -and ($last -cmatch '^[0-9a-f]{32}  .+$') -and (($last -split "  ", 2)[0] -ceq $cand.Md5)
        if (-not $ok) {
            $left = @(Remove-NewCopies)
            $reason = $r.Err.Trim()
            if (-not $reason) { $reason = "copy verification failed" }
            if ($left.Count -gt 0) {
                throw (New-Object InstallFailure "could not write $new ($reason) and could not remove $($left -join ', ')")
            }
            throw (New-Object CapacityAbort "could not write ${new}: $reason")
        }
        Info "staged dest=$new bytes=$($cand.Bytes)"
    }
}

function Install-Sequence() {
    # Phase 2: rename each verified copy over its destination, codex_webui last.
    Step "Phase 2: renaming new copies into place (codex_webui last)"
    foreach ($cand in (Get-ActiveCandidates)) {
        $new = $cand.Dest + $NewSuffix
        $r = Invoke-RemoteRc ("mv -f " + (Remote-Quote $new) + " " + (Remote-Quote $cand.Dest)) $null 60000
        if ($r.Code -ne 0) { throw "rename failed for $($cand.Dest): $($r.Err.Trim())" }
        $NewCopies.Remove($new)
        foreach ($item in $Changed) { if ($item.Dest -eq $cand.Dest) { $item.Done = $true } }
        $shown = $cand.Bytes
        if ($cand.Linked) { $shown = $cand.LinkBytes }
        Info "installed dest=$($cand.Dest) mode=$($cand.Mode) bytes=$shown"
    }
}

function Test-Installed() {
    Step "Verifying installed bytes, hashes, and modes"
    $active = Get-ActiveCandidates
    $states = Get-FileStatus @($active | ForEach-Object { $_.Dest })
    foreach ($cand in $active) {
        $state = $states[$cand.Dest]
        # A linked Dropbear is the root tool's copy, which may be the other build.
        $wantBytes = $cand.Bytes; $wantMd5 = $cand.Md5
        if ($cand.Linked) { $wantBytes = $cand.LinkBytes; $wantMd5 = $cand.LinkMd5 }
        if ($state["kind"] -cne "regular") {
            throw "post-install verification failed for $($cand.Dest): kind=$($state['kind'])"
        }
        if ([long]$state["size"] -ne [long]$wantBytes) {
            throw "post-install byte mismatch for $($cand.Dest): expected $wantBytes got $($state['size'])"
        }
        if ($state["md5"] -cne $wantMd5) {
            throw "post-install checksum mismatch for $($cand.Dest)"
        }
        if ($state["mode"] -cne $cand.Mode) {
            throw "post-install mode mismatch for $($cand.Dest): expected $($cand.Mode) got $($state['mode'])"
        }
    }
    Info "installed candidates verified"
}

function Invoke-Rollback([string]$Trigger) {
    Step "Rolling back changed paths"
    Info "trigger: $Trigger"
    $incomplete = $false
    foreach ($path in @(Remove-NewCopies)) {
        $incomplete = $true
        Info "ROLLBACK FAILED could not remove leftover $path"
    }
    $doneItems = @($Changed | Where-Object { $_.Done })
    $pending = @($doneItems)
    [Array]::Reverse($pending)
    foreach ($item in $pending) {
        $dest = $item.Dest
        if ($item.WasAbsent) {
            $r = Invoke-RemoteRc ("rm -f " + (Remote-Quote $dest)) $null 30000
            if ($r.Code -ne 0) {
                $incomplete = $true
                Info "ROLLBACK FAILED remove new path ${dest}: $($r.Out.Trim())"
                continue
            }
            Info "removed new path $dest (original absence recorded)"
            continue
        }
        # Restore the RAM copy beside the destination with its observed mode,
        # then rename over it.
        $tmp = $dest + $RestoreSuffix
        $cmd = "cp $(Remote-Quote ([string]$item.Rb)) $(Remote-Quote $tmp) && " +
            "chmod $(Remote-Quote ([string]$item.Mode)) $(Remote-Quote $tmp) && " +
            "mv -f $(Remote-Quote $tmp) $(Remote-Quote $dest)"
        $r = Invoke-RemoteRc $cmd $null 180000
        if ($r.Code -ne 0) {
            $incomplete = $true
            Invoke-RemoteRc ("rm -f " + (Remote-Quote $tmp)) $null 30000 | Out-Null
            Info "ROLLBACK FAILED restore ${dest}: $(($r.Err + $r.Out).Trim())"
            continue
        }
        Info "restored $dest mode=$($item.Mode)"
    }
    # verify rollback
    foreach ($item in $doneItems) {
        $dest = $item.Dest
        if ($item.WasAbsent) {
            $r = Invoke-RemoteRc ("test ! -e " + (Remote-Quote $dest)) $null 30000
            if ($r.Code -ne 0) {
                $incomplete = $true
                Info "ROLLBACK VERIFY FAILED path still present: $dest"
            }
            continue
        }
        if ((Get-RemoteMd5 $dest) -cne $item.Md5) {
            $incomplete = $true
            Info "ROLLBACK VERIFY FAILED md5 for $dest"
        }
    }
    if ($incomplete) {
        $script:PreserveStage = $true
        throw "rollback incomplete; staged tree preserved for manual recovery at $Stage. Do NOT reboot (it is in RAM); inspect the staged rollback copies and restore manually."
    }
    Info "rollback verified: all changed paths restored"
    Remove-StagingTree
}

function Remove-StagingTree() {
    if (-not $Stage -or $script:PreserveStage) { return }
    Step "Cleaning owned staging tree"
    $r = Invoke-RemoteRc ("rm -rf " + (Remote-Quote $Stage)) $null 60000
    if ($r.Code -ne 0) {
        Info "warning: could not remove staging tree ${Stage}: $($r.Out.Trim())"
    } else {
        KV "staging_removed=$Stage"
        $script:Stage = ""
    }
}

# ---------------------------------------------------------------- finish

function Invoke-PostWiring() {
    Step "Post-install wiring"
    $binNames = Get-BinManifestNames
    $binChmod = ($binNames | ForEach-Object { "/data/codex/bin/$_" }) -join " "
    $post = "mkdir -p /data/codex/bin /data/codex/modules/usb-net /etc/dropbear /home/root/.ssh /data/codexmqtt /pkg/codexactivity /pkg/codexmqtt; " +
        "ln -sf dropbearmulti /data/codex/bin/dropbear; " +
        "ln -sf dropbearmulti /data/codex/bin/dropbearkey; " +
        "chmod 755 $binChmod /data/codex/init.sh /data/codex/offline_egress_guard.sh " +
        "/data/codex/recovery_ap.sh /data/codex/androidtv_service.sh /data/codex/usb_eth_service.sh /usr/sbin/dropbear " +
        "/usr/sbin/dropbearkey /etc/init.d/rcS.local; " +
        "chmod 644 /data/codex/modules/usb-net/r8152.ko /data/codex/modules/usb-net/usbnet.ko /data/codex/modules/usb-net/asix.ko /data/codex/modules/usb-net/cdc_ether.ko /data/codex/modules/usb-net/cdc_ncm.ko /data/codex/modules/usb-net/ax88179_178a.ko /data/codex/modules/usb-net/README.md 2>/dev/null || true; " +
        "chmod 600 /data/codexmqtt/config.json 2>/dev/null || true; " +
        "/bin/busybox sync 2>/dev/null || true"
    Invoke-Remote $post $null 60000 | Out-Null
}

function Start-Services() {
    $start = "killall codex_webui 2>/dev/null || true; killall codex_bthid_keyboard 2>/dev/null || true; " +
        "if ! ps | grep '[o]ffline_egress_guard.sh monitor' >/dev/null 2>&1; then " +
        "/data/codex/offline_egress_guard.sh monitor >> /cache/codex-init.log 2>&1 & fi; " +
        "if ! ps | grep '[d]ropbear' >/dev/null 2>&1; then /usr/sbin/dropbear -R -p 22; fi; " +
        "mkdir -p /cache/bin; ln -sf /data/codex/bin/codex_bthid_keyboard /cache/bin/bthid_keyboard; " +
        "/data/codex/bin/codex_webui 8080 >> /cache/codex-init.log 2>&1 & " +
        "/data/codex/bin/codex_bthid_keyboard >> /cache/codex-init.log 2>&1 & " +
        "killall codex_androidtv 2>/dev/null || true; " +
        "if [ -x /data/codex/androidtv_service.sh ]; then /data/codex/androidtv_service.sh >/dev/null 2>&1 & fi; " +
        "sleep 1; " +
        "/data/codex/bin/codex_hbus $(Remote-Quote $ResolvedHubId) harmony.automation?discover '{""gatewayType"":""codexactivity""}' >> /cache/codex-init.log 2>&1 || true; " +
        "/data/codex/bin/codex_hbus $(Remote-Quote $ResolvedHubId) harmony.automation?discover '{""gatewayType"":""codexmqtt""}' >> /cache/codex-init.log 2>&1 || true; " +
        "ps | grep '[c]odex_webui' || true; ps | grep '[c]odex_bthid_keyboard' || true; ps | grep '[d]ropbear' || true; " +
        "ps | grep '[a]tv_service.sh' || true"
    Write-Host (Invoke-Remote $start $null 90000).Trim()
}

function Ensure-ParentDirs() {
    $dirs = @(Get-ActiveCandidates | ForEach-Object {
        $i = $_.Dest.LastIndexOf("/")
        if ($i -le 0) { "/" } else { $_.Dest.Substring(0, $i) }
    } | Sort-Object -Unique)
    $cmd = "mkdir -p " + (($dirs | ForEach-Object { Remote-Quote $_ }) -join " ")
    Invoke-Remote $cmd $null 30000 | Out-Null
}

function Test-CloudBlockerChanged() {
    $cloud = @("/opt/luaworks/tasks/connectserver/netservicestarter.lua", "/data/codex/cloud_blocker.conf")
    return [bool](Get-ActiveCandidates | Where-Object { $cloud -contains $_.Dest })
}

# hal starts once at boot (rcS), so only a reboot swaps it.
# hal starts once at boot (rcS), so only a reboot swaps it: needed when the
# files change, or when the running hal isn't the one asked for.
function Test-MultiRemoteChanged() {
    $files = [bool](Get-ActiveCandidates | Where-Object { @($HalMultiDest, $MultiRemoteConf) -contains $_.Dest })
    if (($MultiRemote -ne "on" -and $MultiRemote -ne "off") -or $null -eq $script:HalBound) { return $files }
    return ($files -or ($script:HalBound -ne ($MultiRemote -eq "on")))
}

function Get-WantedHal() {
    if ($MultiRemote -eq "on") { return "multi-remote" } else { return "stock" }
}

function Restart-HubAndWait() {
    Invoke-Remote "(/bin/sleep 2; /sbin/reboot || reboot) >/dev/null 2>&1 & echo rebooting" $null 30000 | Out-Null
    Start-Sleep -Seconds 8
    Wait-TcpPort $HubHost $Port 180 "SSH"
    Wait-TcpPort $HubHost 8080 180 "Web UI"
    if ($MultiRemote -eq "on" -or $MultiRemote -eq "off") {
        $bound = Test-HalBound
        KV ("multi_remote_active=" + $(if ($bound) { "yes" } else { "no" }))
        if ($bound -ne ($MultiRemote -eq "on")) {
            $other = if ($MultiRemote -eq "on") { "stock" } else { "multi-remote" }
            Info "WARNING: the hub restarted but still runs the $other hal; see /cache/codex-init.log on the hub"
        }
    }
}

# The engine loads /pkg plugins once at start; only a reboot restarts it.
function Test-PluginsChanged() {
    return [bool](Get-ActiveCandidates | Where-Object { $_.Kind -eq "plugin" })
}

# ---------------------------------------------------------- turn off / on

function Test-NotTurnedOff() {
    $out = (Invoke-Remote $MelodiousOffCheckCmd $null 30000).Trim()
    if ($out -eq "off") { throw $MelodiousOffRefusal }
}

function Get-FirstValue($Values, [string]$Key, [string]$Default = "") {
    if ($Values.ContainsKey($Key) -and $Values[$Key].Count -gt 0) { return [string]$Values[$Key][0] }
    return $Default
}

function Test-BootChanged($Before, $After) {
    $bId = (Get-FirstValue $Before "boot_id").Trim()
    $aId = (Get-FirstValue $After "boot_id").Trim()
    if ($bId -and $aId) { return ($aId -cne $bId) }
    $bBt = (Get-FirstValue $Before "btime").Trim()
    $aBt = (Get-FirstValue $After "btime").Trim()
    if ($bBt -match '^\d+$' -and $aBt -match '^\d+$' -and $aBt -ne $bBt) { return $true }
    $bUp = (Get-FirstValue $Before "uptime_s").Trim()
    $aUp = (Get-FirstValue $After "uptime_s").Trim()
    if ($bUp -match '^\d+$' -and $aUp -match '^\d+$' -and ([long]$aUp -lt [long]$bUp)) { return $true }
    return $false
}

function Invoke-TurnOffScript([string]$Mode, [string[]]$Extra = @()) {
    $body = [System.Text.Encoding]::UTF8.GetBytes(($TurnOffScript -replace "`r", "") + "`n")
    Invoke-Remote "cat > $TurnOffScriptPath" $body 30000 | Out-Null
    $argParts = @((Remote-Quote $Mode)) + @($Extra | ForEach-Object { Remote-Quote $_ })
    $argStr = $argParts -join " "
    try {
        $r = Invoke-RemoteRc "sh $TurnOffScriptPath $argStr" $null 120000
    } finally {
        Invoke-RemoteRc "rm -f $TurnOffScriptPath" $null 30000 | Out-Null
    }
    $values = @{}
    foreach ($line in ($r.Out -split "`n")) {
        $stripped = $line.Trim()
        $eq = $stripped.IndexOf("=")
        if ($eq -lt 1) { continue }
        $key = $stripped.Substring(0, $eq)
        $val = $stripped.Substring($eq + 1)
        if (-not $values.ContainsKey($key)) { $values[$key] = [System.Collections.ArrayList]::new() }
        $values[$key].Add($val) | Out-Null
        KV $stripped
        if ($key -eq "warning") { Info "WARNING: $val" }
    }
    if ($values.ContainsKey("error")) { throw $values["error"][0] }
    if ($r.Code -ne 0) { throw "the turn-off helper exited with $($r.Code): $($r.Err.Trim())" }
    return $values
}

function Invoke-TurnOffBootstrap([string[]]$Targets) {
    Step "Bootstrapping gate-aware scripts for /etc/melodious-off"
    $Candidates.Clear()
    foreach ($spec in $GateScriptSpecs) {
        if ($Targets -ccontains $spec[0]) {
            Add-Candidate (New-Candidate $spec[0] $spec[1] $spec[2] -Local (Join-Path $Payload $spec[3]))
        }
    }
    New-StagingTree
    Send-CandidatesToStage
    Test-StagedMd5
    Invoke-DestinationProbe
    foreach ($cand in $Candidates) {
        $state = $Probe[$cand.Dest]
        $exists = ($null -ne $state) -and ($state["kind"] -eq "regular")
        if ($exists -and ($state["mode"] -ceq $cand.Mode) -and ($state["md5"] -ceq $cand.Md5)) {
            $cand.Action = "unchanged"
        } elseif ($exists) {
            $cand.Action = "replace"
        } else {
            $cand.Action = "create"
        }
    }
    Get-RamStatus
    $rbBytes = [long]0
    foreach ($cand in $Candidates) {
        if ($cand.Action -eq "replace") { $rbBytes += [long]$Probe[$cand.Dest]["size"] }
    }
    if ($RamFreeBytes -lt ($rbBytes + $RamMarginBytes)) {
        Remove-StagingTree
        throw "free RAM $RamFreeBytes < rollback copies + margin $($rbBytes + $RamMarginBytes)"
    }
    Count-BackupGenerations
    if ((Get-ActiveCandidates).Count -eq 0) {
        Remove-StagingTree
        return
    }
    try {
        Add-RollbackCopies
        New-HandoffBackup
        Invoke-HandoffPrune
        Ensure-ParentDirs
        Write-NewCopies
        Install-Sequence
        Test-Installed
    } catch [CapacityAbort] {
        Remove-StagingTree
        throw "not enough free flash to bootstrap gate scripts: $($_.Exception.Message)"
    } catch {
        $err = $_.Exception.Message
        $anyDone = [bool]($Changed | Where-Object { $_.Done })
        if ($anyDone -or $NewCopies.Count -gt 0) {
            Invoke-Rollback $err
            throw "gate-script bootstrap failed and was rolled back: $err"
        }
        Remove-StagingTree
        throw
    }
    Remove-StagingTree
}

function Wait-PostRebootVerify($Before, [string]$VerifyMode, [string[]]$VerifyArgs = @(), [switch]$WaitWebui) {
    Start-Sleep -Seconds 8
    Wait-TcpPort $script:HubHost $Port 180 "SSH"
    $after = @{}
    $confirmed = $false
    for ($attempt = 0; $attempt -lt 15; $attempt++) {
        try {
            $after = Invoke-TurnOffScript $VerifyMode $VerifyArgs
        } catch {
            if ($attempt -eq 14) { throw }
            Start-Sleep -Seconds 2
            continue
        }
        if (Test-BootChanged $Before $after) {
            $confirmed = $true
            break
        }
        Start-Sleep -Seconds 2
    }
    KV ("reboot_confirmed=" + $(if ($confirmed) { "yes" } else { "no" }))
    if (-not $confirmed) {
        throw "the hub did not restart (boot_id, btime, and uptime did not reset); refusing to report success"
    }
    if ($WaitWebui) {
        Wait-TcpPort $script:HubHost 8080 180 "Web UI"
        if ((Get-FirstValue $after "active_on") -ne "yes") {
            $after = Invoke-TurnOffScript $VerifyMode $VerifyArgs
        }
    }
    return $after
}

function Invoke-TurnOff() {
    Step "Checking preflight gates for turning Melodious off"
    $extra = if ($Force) { @("--force") } else { @() }
    $before = Invoke-TurnOffScript "check" $extra
    if ((Get-FirstValue $before "active_off") -eq "yes") {
        Step "Done"
        Info "Melodious is already off on this hub."
        return 0
    }
    if ($PreflightOnly) {
        Step "Done"
        Info "Preflight only: nothing was changed."
        return 0
    }
    if (-not $NoPrompt) {
        Info "The hub goes back to Logitech's cloud and the Harmony app. Melodious stops running."
        $answer = ([string](Read-Host "Turn Melodious off and restart the hub? [y/N]")).Trim().ToLowerInvariant()
        if ($answer -ne "y" -and $answer -ne "yes") {
            Info "Nothing was changed."
            return 1
        }
    }

    if ((Get-FirstValue $before "bootstrap_needed") -eq "yes") {
        $targets = @()
        if ($before.ContainsKey("bootstrap_target")) { $targets = @($before["bootstrap_target"]) }
        Invoke-TurnOffBootstrap $targets
    }

    Step "Turning Melodious off"
    $applied = Invoke-TurnOffScript "apply" $extra
    if ((Get-FirstValue $applied "result") -ne "off") {
        throw "the turn-off helper did not confirm /etc/melodious-off"
    }

    $wifiIp = (Get-FirstValue $applied "wifi_ip").Trim()
    $wiredIps = @()
    if ($applied.ContainsKey("wired_ip")) {
        $wiredIps = @($applied["wired_ip"] | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
    }
    $switchedToWifi = $false
    Step "Restarting the hub"
    Invoke-Remote "(/bin/sleep 2; /sbin/reboot || reboot) >/dev/null 2>&1 & echo rebooting" $null 30000 | Out-Null
    if (($wiredIps -contains $script:HubHost) -and $wifiIp -and ($wifiIp -ne $script:HubHost)) {
        KV "post_reboot_host=$wifiIp"
        Info "Connected over USB Ethernet ($($script:HubHost)); USB Ethernet stays off after the restart, so waiting for SSH on Wi-Fi IP $wifiIp."
        $script:HubHost = $wifiIp
        $switchedToWifi = $true
    }

    Step "Checking the hub after the restart"
    $after = Wait-PostRebootVerify $applied "verify-off"
    if ((Get-FirstValue $after "active_off") -ne "yes") {
        $reasons = Get-FirstValue $after "still_active" "unknown"
        throw "after the restart some of Melodious is still active ($reasons)"
    }

    Step "Done"
    Info "Melodious is off (/etc/melodious-off): stock hal and Logitech's cloud tasks run; Melodious services, plugins, and restrictions are off."
    if ($switchedToWifi) { Info "Hub Wi-Fi IP: $wifiIp" }
    Info "Next, open the Harmony app on the same Wi-Fi network and Sync the hub to 100%."
    Info "The Harmony app's cloud setup replaces local-only devices and activities."
    if ((Get-FirstValue $after "internet_route") -eq "no") {
        Info "The hub has no internet route yet; it gets one as soon as Wi-Fi DHCP finishes."
    }
    Info "To turn Melodious back on later, run this installer with -TurnOn."
    return 0
}

function Invoke-TurnOn() {
    Step "Checking preflight gates for turning Melodious on"
    $before = Invoke-TurnOffScript "check-on"
    $expectedHal = Get-FirstValue $before "expected_hal" "stock"
    if ((Get-FirstValue $before "already_on") -eq "yes") {
        Step "Done"
        Info "Melodious is already on."
        return 0
    }
    if ($PreflightOnly) {
        Step "Done"
        Info "Preflight only: nothing was changed."
        return 0
    }
    if (-not $NoPrompt) {
        Info "Melodious will start again at boot, with the cloud blocker and your saved settings restored."
        $answer = ([string](Read-Host "Turn Melodious back on and restart the hub? [y/N]")).Trim().ToLowerInvariant()
        if ($answer -ne "y" -and $answer -ne "yes") {
            Info "Nothing was changed."
            return 1
        }
    }

    Step "Turning Melodious on"
    $applied = Invoke-TurnOffScript "apply-on"
    if ((Get-FirstValue $applied "result") -ne "on") {
        throw "the turn-on helper did not confirm removing /etc/melodious-off"
    }
    $expectedHal = Get-FirstValue $applied "expected_hal" $expectedHal

    Step "Restarting the hub"
    Invoke-Remote "(/bin/sleep 2; /sbin/reboot || reboot) >/dev/null 2>&1 & echo rebooting" $null 30000 | Out-Null

    Step "Checking the hub after the restart"
    $verifyArgs = @($expectedHal)
    if ($expectedHal -eq "two-screen") {
        $remotesPatch = Get-Content -Raw -Encoding UTF8 (Join-Path $Payload "helpers/hal_remotes_patch.json") | ConvertFrom-Json
        $verifyArgs += [string]$remotesPatch.patched_md5
    } elseif ($expectedHal -eq "multi-remote") {
        $multiPatch = Get-Content -Raw -Encoding UTF8 (Join-Path $Payload $HalPatchFile) | ConvertFrom-Json
        $verifyArgs += [string]$multiPatch.patched_md5
    }
    $after = Wait-PostRebootVerify $applied "verify-on" $verifyArgs -WaitWebui
    if ((Get-FirstValue $after "active_on") -ne "yes") {
        $reasons = Get-FirstValue $after "missing_on" "unknown"
        throw "after the restart Melodious did not come back cleanly ($reasons)"
    }

    Step "Done"
    Info "Melodious is back on (hal: $expectedHal)."
    Info "Web UI: http://$($script:HubHost)`:8080/"
    return 0
}

# ------------------------------------------------------------------ main

if ($TurnOff -and $TurnOn) { throw "-TurnOff and -TurnOn cannot be used together" }
if ($Force -and -not $TurnOff) { throw "-Force can only be used with -TurnOff" }
if ($TurnOff -or $TurnOn) {
    $modeFlag = if ($TurnOff) { "-TurnOff" } else { "-TurnOn" }
    if ($CleanInstall) { throw "$modeFlag cannot be combined with -CleanInstall" }
    if ($NoApplyCloudRestart) { throw "$modeFlag cannot be combined with -NoApplyCloudRestart" }
}

$HubHost = Prompt-IfMissing $HubHost "Harmony Hub IP address" -Required
$defaultKeyPath = Resolve-DefaultKeyPath
if (-not $KeyPath -and $defaultKeyPath -and (Test-Path -LiteralPath $defaultKeyPath)) {
    $KeyPath = $defaultKeyPath
    Info "using SSH key $KeyPath"
}
$KeyPath = Prompt-IfMissing $KeyPath "SSH private key path for root login" -Required
$KeyPath = (Resolve-Path -LiteralPath $KeyPath).Path
if (-not (Test-Path -LiteralPath $KeyPath)) { throw "SSH key not found: $KeyPath" }

if (-not ($TurnOff -or $TurnOn)) {
    if (-not $NoPrompt -and -not $MqttExplicitSupplied -and -not $MqttDisabled) {
        if ($CleanInstall) {
            $MqttBroker = Read-Host "MQTT broker host/IP (blank to disable MQTT for now)"
            if (-not $MqttBroker) { $MqttDisabled = $true }
            # Only a nonblank broker counts as an explicit MQTT choice; a blank
            # answer must never mark MQTT as explicitly supplied.
            $script:MqttExplicitSupplied = [bool]$MqttBroker
        } else {
            # Default upgrade: never prompt into the MQTT configuration and never
            # regenerate it; the existing /data/codexmqtt/config.json is
            # preserved unless explicit MQTT arguments are supplied.
            $MqttDisabled = $true
        }
    }
    if (-not $NoPrompt -and $MqttBroker) {
        if (-not $MqttUser) { $MqttUser = Read-Host "MQTT username (blank if none)" }
        if (-not $MqttPassword) { $MqttPassword = Read-Host "MQTT password (blank if none)" }
    }
}

Step "Checking SSH"
$identity = Invoke-Remote "id; uname -a" $null 30000
Write-Host $identity.Trim()

if ($TurnOff) { exit (Invoke-TurnOff) }
if ($TurnOn) { exit (Invoke-TurnOn) }
Test-NotTurnedOff

Step "Resolving hub id"
Resolve-HubIdentity
Test-MultiRemoteOff

Step "Building candidate inventory"
Build-Inventory
Info "candidates=$($Candidates.Count) (codex_webui installed last)"

# Guaranteed cleanup: any unhandled terminating error removes the owned
# volatile staging tree unless an incomplete rollback preserved it.
trap {
    Remove-StagingTree
    throw $_
}

New-StagingTree
Send-CandidatesToStage
Send-FlashHelper
Test-StagedMd5

Invoke-DestinationProbe
Set-UpgradeGates
Set-DropbearLink
Get-RamStatus
Measure-Flash
Get-RootToolLeftovers

Count-BackupGenerations
Get-HandoffEstimate
if ($Verdict -eq $VerdictConfigUncertain) {
    Show-PreflightReport
    Remove-StagingTree
    exit 2
}

Build-Plans
Set-Verdict
Show-PreflightReport

if ($PreflightOnly) {
    Remove-StagingTree
    if ($Verdict -eq $VerdictAllowed) { exit 0 } else { exit 2 }
}

if ($Verdict -ne $VerdictAllowed) {
    Remove-StagingTree
    Info "normal mode aborted before any persistent mutation"
    exit 2
}

if ($RemoveRootToolLeftovers -and ($RootToolStages.Count -gt 0 -or (Test-RootToolDropbearRemovable))) {
    Remove-RootToolLeftovers
    if ((Get-ActiveCandidates).Count -gt 0 -and (Get-FlashShortfall) -gt 0 -and -not $SkipFlashCheck) {
        $script:Verdict = $VerdictCapacity
        $script:CapacityStage = "preflight"
        $reason = "free flash $FlashAvail < estimated need $FlashRequired after removing the leftovers"
        $VerdictReasons.Add($reason) | Out-Null
        KV "verdict_reason=$reason"
        Show-Verdict
        Remove-StagingTree
        exit 2
    }
}

if ((Get-ActiveCandidates).Count -eq 0) {
    Remove-StagingTree
    if ((Test-MultiRemoteChanged) -and -not $NoApplyCloudRestart) {
        # The files match, but the running hal isn't the one asked for.
        Step "Restarting the hub"
        Info "The files already match; rebooting the hub so it starts the $(Get-WantedHal) hal."
        Restart-HubAndWait
        Step "Done"
        Info "The hub already matched this payload; it was restarted to apply the multi-remote setting."
        exit 0
    }
    Step "Done"
    Info "The hub already matches this payload; nothing was installed or restarted."
    exit 0
}

try {
    Add-RollbackCopies
    New-HandoffBackup
    Invoke-HandoffPrune
    Ensure-ParentDirs
    Write-NewCopies
    Install-Sequence
    Test-Installed
} catch [CapacityAbort] {
    $script:Verdict = $VerdictCapacity
    $script:CapacityStage = "phase1"
    $VerdictReasons.Add($_.Exception.Message) | Out-Null
    KV "verdict_reason=$($_.Exception.Message)"
    Show-Verdict
    Remove-StagingTree
    exit 2
} catch {
    $err = $_.Exception.Message
    $anyDone = [bool]($Changed | Where-Object { $_.Done })
    if ($anyDone -or $NewCopies.Count -gt 0) {
        try {
            Invoke-Rollback $err
        } catch {
            throw $_.Exception.Message
        }
        throw "install failed and was rolled back: $err"
    }
    Remove-StagingTree
    throw
}

try {
    Invoke-PostWiring
    Step "Restarting services"
    Start-Services
} catch {
    # Wiring/start failures after destinations were replaced must
    # reverse-roll back; the rollback material stays intact.
    $err = $_.Exception.Message
    try {
        Invoke-Rollback "post-install wiring/start failed: $err"
        Start-Services
    } catch {
        throw $_.Exception.Message
    }
    throw "post-install wiring/start failed and changes were rolled back: $err"
}
try {
    Wait-TcpPort $HubHost 8080 60 "Web UI"
} catch {
    $err = $_.Exception.Message
    try {
        Invoke-Rollback "smoke test failed: $err"
        Start-Services
    } catch {
        throw $_.Exception.Message
    }
    throw "smoke test failed and changes were rolled back: $err"
}

Show-FlashAfterInstall
Remove-StagingTree

$cloudChanged = Test-CloudBlockerChanged
$pluginsChanged = Test-PluginsChanged
$multiRemoteChanged = Test-MultiRemoteChanged
if (($cloudChanged -or $pluginsChanged -or $multiRemoteChanged) -and -not $NoApplyCloudRestart) {
    Step "Restarting the hub"
    if ($cloudChanged) {
        Info "Rebooting the hub so Logitech cloud services restart in blocked mode."
    } elseif ($pluginsChanged) {
        Info "Rebooting the hub so its engine loads the updated plugins."
    } else {
        Info "Rebooting the hub so it starts the $(Get-WantedHal) hal."
    }
    Restart-HubAndWait
}

Step "Done"
if ($FirstInstall) {
    Info "Install finished as a first install (configuration written)."
} elseif ($CleanInstall) {
    Info "Install finished in explicit clean-install mode (configuration regenerated)."
} else {
    Info "Install finished in default upgrade mode (existing configuration preserved where applicable)."
}
Info "Persistent paths were mutated only after preflight ALLOWED; staging was volatile until then."
Info "Web UI: http://$HubHost`:8080/"
Info "Web UI authentication: disabled"
if (-not $SkipCloudSuppression) {
    if ($cloudChanged) { Info "Cloud blocker: enabled and applied" } else { Info "Cloud blocker: enabled (unchanged)" }
}
if ($MultiRemote) {
    $state = if ($MultiRemote -eq "on") { "on (remotes without a screen)" } else { "off" }
    if ($multiRemoteChanged) { Info "Multiple remotes of one model: $state and applied" } else { Info "Multiple remotes of one model: $state (unchanged)" }
}
Info "If IR commands do not work, update /data/codex/hub_id with the correct hub id and restart codex_webui."
