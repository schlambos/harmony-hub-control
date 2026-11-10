#!/bin/sh
# USB Ethernet service (docs/USB_ETHERNET.md).
# Gated by /data/codex/usb_eth.conf (ENABLED=0|1, default off).
# Started from rcS.local at boot when enabled, or on demand from codex_webui.
#
# Start is deliberately asynchronous and bounded: `start` only spawns one
# worker (serialized by a lock directory) and returns at once, so boot and
# the web UI never wait on USB. The worker waits for real readiness --
# usbcore present, a valid PHY register, a bound EHCI controller -- with
# bounded retries and records state=<state> reason=<reason> in the state
# file; `stop` kills the worker, so pending startup can never revive a
# feature that was turned off. Platform registration is never repeated
# for a device that is already registered (see codex_usbeth).
#
# The USBETH_* environment overrides exist for the off-hub tests in
# tools/usb-eth-test/; the defaults are the hub paths.
PATH=${USBETH_PATH:-/data/codex/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}
CONF=${USBETH_CONF:-/data/codex/usb_eth.conf}
HELPER=${USBETH_HELPER:-/data/codex/bin/codex_usbeth}
MOD_DIR=${USBETH_MOD_DIR:-/data/codex/modules/usb-net}
LOG=${USBETH_LOG:-/cache/codex-init.log}
RUN_DIR=${USBETH_RUN_DIR:-/var/run}
STATE_FILE=${USBETH_STATE_FILE:-$RUN_DIR/codex-usb-eth.state}
NET_STATE=${USBETH_NET_STATE:-$RUN_DIR/codex-usb-eth-net.state}
WORKER_PIDFILE=${USBETH_WORKER_PIDFILE:-$RUN_DIR/codex-usb-eth-worker.pid}
LOCK_DIR=${USBETH_LOCK_DIR:-$RUN_DIR/codex-usb-eth.lock}
PROC_MODULES=${USBETH_PROC_MODULES:-/proc/modules}
IPV4_CONF=${USBETH_IPV4_CONF:-/proc/sys/net/ipv4/conf}
WIFI_IF=${USBETH_WIFI_IF:-ath0}
USBCORE_KO=${USBETH_USBCORE_KO:-/lib/modules/2.6.31-g89d565c/kernel/drivers/usb/core/usbcore.ko}
EHCI_KO=${USBETH_EHCI_KO:-/lib/modules/2.6.31-g89d565c/kernel/drivers/usb/host/ehci-hcd.ko}
PLATFORM_DRIVER_DIR=${USBETH_PLATFORM_DRIVER_DIR:-/sys/bus/platform/drivers/ar7240-ehci}
PLATFORM_DEVICE=${USBETH_PLATFORM_DEVICE:-ar7240-ehci.0}
# Bounded waits, in poll ticks (one tick ~= POLL seconds).
POLL=${USBETH_POLL:-1}
DEP_TIMEOUT=${USBETH_DEP_TIMEOUT:-90}
CTRL_WAIT=${USBETH_CTRL_WAIT:-15}
ADAPTER_WAIT=${USBETH_ADAPTER_WAIT:-60}
IFACE_WAIT=${USBETH_IFACE_WAIT:-15}
MONITOR_POLL=${USBETH_MONITOR_POLL:-5}

log() {
  echo "$(date) codex usb-eth: $*" >> "$LOG"
}

write_state() {
  # $1 = state, $2 = reason (may be empty)
  _tmp="$STATE_FILE.tmp.$$"
  {
    echo "state=$1"
    echo "reason=$2"
    echo "worker_pid=$(cat "$WORKER_PIDFILE" 2>/dev/null)"
  } > "$_tmp" 2>/dev/null && mv "$_tmp" "$STATE_FILE" 2>/dev/null || rm -f "$_tmp"
}

state_field() {
  [ -f "$STATE_FILE" ] || return 0
  sed -n "s/^$1=//p" "$STATE_FILE" 2>/dev/null | sed -n '1p'
}

is_enabled() {
  [ -f "$CONF" ] || return 1
  grep '^ENABLED=1$' "$CONF" >/dev/null 2>&1 && return 0
  [ "$(cat "$CONF" 2>/dev/null)" = "1" ] && return 0
  return 1
}

helper_field() {
  [ -x "$HELPER" ] || return 0
  "$HELPER" status 2>/dev/null | sed -n "s/^$1=//p" | sed -n '1p'
}

find_usb_iface() {
  helper_field ifname
}

worker_running() {
  [ -f "$WORKER_PIDFILE" ] || return 1
  _pid=$(cat "$WORKER_PIDFILE" 2>/dev/null)
  case "$_pid" in *[!0-9]*|"") return 1 ;; esac
  kill -0 "$_pid" 2>/dev/null
}

lock_acquire() {
  _tries=0
  while [ "$_tries" -lt 50 ]; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      echo $$ > "$LOCK_DIR/pid"
      return 0
    fi
    _owner=$(cat "$LOCK_DIR/pid" 2>/dev/null)
    case "$_owner" in
      *[!0-9]*|"") ;;
      *) kill -0 "$_owner" 2>/dev/null || rm -rf "$LOCK_DIR" ;;
    esac
    _tries=$(expr "$_tries" + 1)
    sleep 1
  done
  return 1
}

lock_release() {
  rm -rf "$LOCK_DIR"
}

stop_udhcpc_for() {
  _if="$1"
  [ -n "$_if" ] || return 0
  _pidf="$RUN_DIR/udhcpc.${_if}.pid"
  if [ -f "$_pidf" ]; then
    _pid=$(cat "$_pidf" 2>/dev/null)
    if [ -n "$_pid" ]; then
      kill "$_pid" 2>/dev/null || true
    fi
    rm -f "$_pidf"
  fi
}

udhcpc_running() {
  _pidf="$RUN_DIR/udhcpc.$1.pid"
  [ -f "$_pidf" ] || return 1
  _pid=$(cat "$_pidf" 2>/dev/null)
  case "$_pid" in *[!0-9]*|"") return 1 ;; esac
  kill -0 "$_pid" 2>/dev/null
}

# insmod one module file unless its module is already loaded.
load_module_file() {
  # $1 = file in $MOD_DIR, $2 = module name in /proc/modules
  if grep "^$2 " "$PROC_MODULES" >/dev/null 2>&1; then
    return 0
  fi
  if [ -f "$MOD_DIR/$1" ]; then
    insmod "$MOD_DIR/$1" >> "$LOG" 2>&1 || {
      log "insmod $1 failed"
      return 1
    }
  else
    log "missing $MOD_DIR/$1"
    return 1
  fi
  return 0
}

# Load the driver stack for one detected adapter driver.
load_driver() {
  case "$1" in
    r8152)
      load_module_file r8152.ko r8152 || return 1
      ;;
    asix|cdc_ether|cdc_ncm|ax88179_178a)
      load_module_file usbnet.ko usbnet || return 1
      load_module_file "$1.ko" "$1" || return 1
      ;;
    *)
      log "unknown USB Ethernet driver '$1'; no driver loaded"
      return 1
      ;;
  esac
  return 0
}

module_loaded() {
  grep "^$1 " "$PROC_MODULES" >/dev/null 2>&1
}

# --- wired-path networking (owned by NET_STATE, removed by cleanup_net) ---

save_sysctl() {
  # $1 = iface, $2 = knob; records <iface>_<knob>_old=<value> once.
  _f="$IPV4_CONF/$1/$2"
  [ -f "$_f" ] || return 0
  grep "^$1_$2_old=" "$NET_STATE" >/dev/null 2>&1 && return 0
  echo "$1_$2_old=$(cat "$_f" 2>/dev/null)" >> "$NET_STATE"
}

set_sysctl() {
  _f="$IPV4_CONF/$1/$2"
  [ -f "$_f" ] || return 0
  echo "$3" > "$_f" 2>/dev/null || log "warning: cannot write $_f"
}

apply_net() {
  # $1 = wired iface. Exactly the settings recorded in NET_STATE change.
  _if="$1"
  _ip=$(helper_field ipv4)
  if [ -f "$NET_STATE" ]; then
    _old_if=$(sed -n 's/^wired_if=//p' "$NET_STATE")
    _old_ip=$(sed -n 's/^wired_ip=//p' "$NET_STATE")
    if [ "$_old_if" = "$_if" ] && [ "$_old_ip" = "$_ip" ] && [ -n "$_ip" ]; then
      return 0
    fi
    cleanup_net
  fi
  : > "$NET_STATE"
  echo "wired_if=$_if" >> "$NET_STATE"
  echo "wifi_if=$WIFI_IF" >> "$NET_STATE"
  echo "wired_ip=$_ip" >> "$NET_STATE"
  _out=$("$HELPER" net-apply "$_if" "$WIFI_IF" 2>>"$LOG")
  _rc=$?
  echo "$_out" >> "$LOG"
  _mode=$(echo "$_out" | sed -n 's/^route_mode=//p' | sed -n '1p')
  echo "route_mode=$_mode" >> "$NET_STATE"
  # ARP hygiene on just these two interfaces: answer ARP only for the
  # address the receiving interface owns, and announce only addresses
  # that interface owns. Restored verbatim by cleanup_net.
  for _i in "$_if" "$WIFI_IF"; do
    save_sysctl "$_i" arp_ignore
    save_sysctl "$_i" arp_announce
    set_sysctl "$_i" arp_ignore 1
    set_sysctl "$_i" arp_announce 2
  done
  [ "$_rc" = "0" ]
}

cleanup_net() {
  [ -f "$NET_STATE" ] || return 0
  _if=$(sed -n 's/^wired_if=//p' "$NET_STATE")
  _wifi=$(sed -n 's/^wifi_if=//p' "$NET_STATE")
  [ -n "$_wifi" ] || _wifi="$WIFI_IF"
  if [ -n "$_if" ]; then
    "$HELPER" net-remove "$_if" "$_wifi" >> "$LOG" 2>&1 || true
  fi
  for _i in "$_if" "$_wifi"; do
    [ -n "$_i" ] || continue
    for _k in arp_ignore arp_announce; do
      _old=$(sed -n "s/^${_i}_${_k}_old=//p" "$NET_STATE")
      [ -n "$_old" ] && set_sysctl "$_i" "$_k" "$_old"
    done
  done
  rm -f "$NET_STATE"
}

# --- the startup worker (single instance; pid in WORKER_PIDFILE) ---

wait_bound() {
  _ticks=0
  while [ "$_ticks" -lt "$CTRL_WAIT" ]; do
    [ "$(helper_field ehci_bound)" = "1" ] && return 0
    _ticks=$(expr "$_ticks" + 1)
    sleep "$POLL"
  done
  [ "$(helper_field ehci_bound)" = "1" ]
}

worker_fail() {
  write_state failed "$1"
  log "startup failed: $1"
  rm -f "$WORKER_PIDFILE"
  exit 1
}

worker_main() {
  trap 'rm -f "$WORKER_PIDFILE"' 0
  write_state starting phy_wait

  # Phase 1: dependencies + PHY readiness, bounded. phy-host writes
  # nothing when the register reads back as a sentinel, so retrying it
  # is a pure readiness probe. usbcore must be loaded before ehci-hcd
  # can resolve its symbols; stock loads both late in boot (usbmgr), so
  # load them here, in dependency order, if they are not present yet.
  _ticks=0
  _phy_ok=0
  while [ "$_ticks" -lt "$DEP_TIMEOUT" ]; do
    if ! module_loaded usbcore; then
      [ -f "$USBCORE_KO" ] && insmod "$USBCORE_KO" >> "$LOG" 2>&1 || true
    fi
    if [ "$_phy_ok" = "0" ]; then
      if "$HELPER" phy-host >> "$LOG" 2>&1; then
        _phy_ok=1
        write_state starting controller_wait
      fi
    fi
    if [ "$_phy_ok" = "1" ] && module_loaded usbcore; then
      break
    fi
    _ticks=$(expr "$_ticks" + 1)
    sleep "$POLL"
  done
  [ "$_phy_ok" = "1" ] || worker_fail phy_not_ready
  module_loaded usbcore || worker_fail deps_timeout

  # Phase 2: a bound EHCI controller, bounded. Registration and binding
  # are different events; an already-registered device is never
  # re-registered (that was the duplicate-registration warning).
  if [ "$(helper_field ehci_bound)" != "1" ]; then
    if ! module_loaded ehci_hcd; then
      [ -f "$EHCI_KO" ] && insmod "$EHCI_KO" >> "$LOG" 2>&1 || true
    fi
    wait_bound || true
  fi
  if [ "$(helper_field ehci_bound)" != "1" ]; then
    if [ "$(helper_field platform_registered)" != "1" ]; then
      # The one case the syscall-slot registration exists for.
      "$HELPER" register-ehci >> "$LOG" 2>&1 || true
      wait_bound || true
    fi
  fi
  if [ "$(helper_field ehci_bound)" != "1" ]; then
    # Registered but unbound. This kernel has no sysfs driver bind file
    # (checked on the hub: the driver directory holds only uevent); when
    # one exists elsewhere, use it. Otherwise exactly one guarded
    # ehci_hcd reload -- after the PHY fix above, with an empty USB bus
    # (an unbound controller enumerates nothing) -- and then stop. No
    # reload loops, no re-registration.
    if [ -w "$PLATFORM_DRIVER_DIR/bind" ]; then
      log "re-probing $PLATFORM_DEVICE via driver bind"
      echo "$PLATFORM_DEVICE" > "$PLATFORM_DRIVER_DIR/bind" 2>>"$LOG" || true
    elif module_loaded ehci_hcd; then
      log "re-probing $PLATFORM_DEVICE via one ehci_hcd reload (bus empty, PHY validated)"
      rmmod ehci_hcd >> "$LOG" 2>&1 || true
      [ -f "$EHCI_KO" ] && insmod "$EHCI_KO" >> "$LOG" 2>&1 || true
    fi
    wait_bound || worker_fail controller_registered_unbound
  fi
  write_state starting adapter_wait

  # Phase 3: adapter present and supported, bounded.
  _ticks=0
  _drv=""
  while [ "$_ticks" -lt "$ADAPTER_WAIT" ]; do
    _dev=$(helper_field usb_device)
    if [ -n "$_dev" ]; then
      _drv=$(helper_field usb_driver)
      if [ -z "$_drv" ]; then
        write_state adapter_unsupported unsupported_chipset
        log "unsupported USB Ethernet chipset $_dev; no driver loaded"
        rm -f "$WORKER_PIDFILE"
        exit 0
      fi
      break
    fi
    _ticks=$(expr "$_ticks" + 1)
    sleep "$POLL"
  done
  if [ -z "$_drv" ]; then
    write_state adapter_absent no_usb_device
    log "no USB Ethernet adapter found"
    rm -f "$WORKER_PIDFILE"
    exit 0
  fi
  load_driver "$_drv" || worker_fail driver_load_failed

  _if=""
  _ticks=0
  while [ "$_ticks" -lt "$IFACE_WAIT" ]; do
    _if=$(find_usb_iface)
    [ -n "$_if" ] && break
    _ticks=$(expr "$_ticks" + 1)
    sleep "$POLL"
  done
  [ -n "$_if" ] || worker_fail no_network_interface

  ifconfig "$_if" up >> "$LOG" 2>&1 || true
  "$HELPER" eth-fix "$_if" >> "$LOG" 2>&1 || true

  # Exactly one DHCP client for the wired interface.
  if ! udhcpc_running "$_if"; then
    stop_udhcpc_for "$_if"
    udhcpc -R -p "$RUN_DIR/udhcpc.${_if}.pid" -i "$_if" -H HarmonyHub -bS -t5 -T2 -A20 >> "$LOG" 2>&1 &
    log "started udhcpc on $_if"
  else
    log "udhcpc already running on $_if"
  fi
  write_state awaiting_carrier_dhcp dhcp_or_carrier

  # Phase 4: monitor carrier/lease, (re)apply owned networking on
  # change, and hand the Wi-Fi path back the moment the cable drops.
  while true; do
    if ! is_enabled; then
      log "disabled while running; worker exiting (stop does cleanup)"
      exit 0
    fi
    _cur=$(find_usb_iface)
    if [ -z "$_cur" ]; then
      cleanup_net
      write_state adapter_absent interface_gone
      log "USB Ethernet interface gone; worker exiting"
      exit 0
    fi
    _if="$_cur"
    _carrier=$(helper_field carrier)
    _ip=$(helper_field ipv4)
    if [ "$_carrier" != "1" ]; then
      [ -f "$NET_STATE" ] && cleanup_net
      write_state awaiting_carrier_dhcp no_carrier
    elif [ -z "$_ip" ]; then
      write_state awaiting_carrier_dhcp no_ipv4_lease
    else
      if apply_net "$_if"; then
        write_state operational ""
      else
        write_state degraded_routing route_apply_failed
      fi
    fi
    sleep "$MONITOR_POLL"
  done
}

start_usb_eth() {
  if [ "$1" != "--force" ] && ! is_enabled; then
    log "start skipped (disabled in $CONF)"
    return 0
  fi
  if [ ! -x "$HELPER" ]; then
    log "start failed: $HELPER missing"
    return 1
  fi
  lock_acquire || {
    log "start failed: cannot take $LOCK_DIR"
    return 1
  }
  if worker_running; then
    log "start skipped (worker already running)"
    lock_release
    return 0
  fi
  if ! "$HELPER" register-ehci --check >/dev/null 2>&1; then
    write_state failed kernel_or_slot_check_failed
    log "start refused: kernel or syscall slot check failed"
    lock_release
    return 1
  fi
  log "starting USB Ethernet (worker)"
  write_state starting queued
  ( worker_main ) >> "$LOG" 2>&1 &
  echo $! > "$WORKER_PIDFILE"
  lock_release
  return 0
}

stop_usb_eth() {
  lock_acquire || {
    log "stop failed: cannot take $LOCK_DIR"
    return 1
  }
  log "stopping USB Ethernet"
  # Cancel pending/running startup first, so it cannot revive anything
  # after cleanup.
  if [ -f "$WORKER_PIDFILE" ]; then
    _pid=$(cat "$WORKER_PIDFILE" 2>/dev/null)
    case "$_pid" in
      *[!0-9]*|"") ;;
      *)
        kill "$_pid" 2>/dev/null || true
        _ticks=0
        while kill -0 "$_pid" 2>/dev/null && [ "$_ticks" -lt 10 ]; do
          _ticks=$(expr "$_ticks" + 1)
          sleep 1
        done
        kill -9 "$_pid" 2>/dev/null || true
        ;;
    esac
    rm -f "$WORKER_PIDFILE"
  fi
  _if=$(sed -n 's/^wired_if=//p' "$NET_STATE" 2>/dev/null)
  [ -n "$_if" ] || _if=$(find_usb_iface)
  cleanup_net
  if [ -n "$_if" ]; then
    stop_udhcpc_for "$_if"
    ifconfig "$_if" 0.0.0.0 down >> "$LOG" 2>&1 || true
  fi
  for _pidf in "$RUN_DIR"/udhcpc.eth*.pid "$RUN_DIR"/udhcpc.usb*.pid; do
    [ -f "$_pidf" ] || continue
    _ifname=${_pidf#$RUN_DIR/udhcpc.}
    _ifname=${_ifname%.pid}
    [ "$_ifname" = "eth1" ] && continue
    [ "$_ifname" = "$WIFI_IF" ] && continue
    stop_udhcpc_for "$_ifname"
    ifconfig "$_ifname" 0.0.0.0 down 2>/dev/null || true
  done
  write_state stopped stopped_by_request
  lock_release
  # Leave ar7240-ehci registered to avoid platform re-registration crashes.
  return 0
}

status_usb_eth() {
  if [ -x "$HELPER" ]; then
    "$HELPER" status
  else
    echo "enabled=0"
  fi
  if worker_running; then
    echo "worker_running=1"
  else
    echo "worker_running=0"
  fi
  if [ -f "$STATE_FILE" ]; then
    echo "service_state=$(state_field state)"
    echo "service_reason=$(state_field reason)"
  fi
  if [ -f "$NET_STATE" ]; then
    echo "route_mode=$(sed -n 's/^route_mode=//p' "$NET_STATE")"
  fi
  return 0
}

case "$1" in
  start) start_usb_eth "$2" ;;
  stop) stop_usb_eth ;;
  status) status_usb_eth ;;
  worker) echo $$ > "$WORKER_PIDFILE"; worker_main ;;  # tests drive the worker in the foreground
  *)
    echo "usage: $0 {start [--force]|stop|status}" >&2
    exit 2
    ;;
esac
