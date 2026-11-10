#!/bin/sh
# USB Ethernet service (docs/USB_ETHERNET.md).
# Gated by /data/codex/usb_eth.conf (ENABLED=0|1, default off).
# Started from rcS.local at boot when enabled, or on demand from codex_webui.
PATH=/data/codex/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
CONF=/data/codex/usb_eth.conf
HELPER=/data/codex/bin/codex_usbeth
MOD_DIR=/data/codex/modules/usb-net
LOG=/cache/codex-init.log

log() {
  echo "$(date) codex usb-eth: $*" >> "$LOG"
}

is_enabled() {
  [ -f "$CONF" ] || return 1
  grep '^ENABLED=1$' "$CONF" >/dev/null 2>&1 && return 0
  [ "$(cat "$CONF" 2>/dev/null)" = "1" ] && return 0
  return 1
}

find_usb_iface() {
  if [ -x "$HELPER" ]; then
    "$HELPER" status 2>/dev/null | sed -n 's/^ifname=//p'
  fi
}

stop_udhcpc_for() {
  _if="$1"
  [ -n "$_if" ] || return 0
  _pidf="/var/run/udhcpc.${_if}.pid"
  if [ -f "$_pidf" ]; then
    _pid=$(cat "$_pidf" 2>/dev/null)
    if [ -n "$_pid" ]; then
      kill "$_pid" 2>/dev/null || true
    fi
    rm -f "$_pidf"
  fi
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
  if ! "$HELPER" register-ehci --check >/dev/null 2>&1; then
    log "start refused: kernel or syscall slot check failed"
    return 1
  fi

  log "starting USB Ethernet"

  # Unload stock gadget side if present (inert on 4.15.600, safe on other builds).
  killall usbgadget 2>/dev/null || true
  killall usbhid 2>/dev/null || true
  grep '^gadgetfs ' /proc/modules >/dev/null 2>&1 && rmmod gadgetfs 2>/dev/null || true
  grep '^ath_udc ' /proc/modules >/dev/null 2>&1 && rmmod ath_udc 2>/dev/null || true

  # Switch AR9344 USB PHY to host mode and bind the dormant ar7240-ehci device.
  "$HELPER" phy-host >> "$LOG" 2>&1 || {
    log "phy-host failed"
    return 1
  }
  grep '^ehci_hcd ' /proc/modules >/dev/null 2>&1 ||
    insmod /lib/modules/2.6.31-g89d565c/kernel/drivers/usb/host/ehci-hcd.ko >> "$LOG" 2>&1 || true

  "$HELPER" register-ehci >> "$LOG" 2>&1 || {
    log "register-ehci failed"
    return 1
  }

  # Wait up to ~10 s for an attached USB device under bus 1.
  _tries=0
  while [ "$_tries" -lt 20 ]; do
    _dev=$("$HELPER" status 2>/dev/null | sed -n 's/^usb_device=//p')
    if [ -n "$_dev" ]; then
      break
    fi
    _tries=$(expr "$_tries" + 1)
    sleep 1
  done

  # Load the Realtek r8152 driver if not already loaded.
  if ! grep '^r8152 ' /proc/modules >/dev/null 2>&1; then
    if [ -f "$MOD_DIR/r8152.ko" ]; then
      insmod "$MOD_DIR/r8152.ko" >> "$LOG" 2>&1 || {
        log "insmod r8152.ko failed"
        return 1
      }
    else
      log "missing $MOD_DIR/r8152.ko"
      return 1
    fi
  fi

  # Wait up to ~6 s for the network interface to appear.
  _if=""
  _tries=0
  while [ "$_tries" -lt 12 ]; do
    _if=$(find_usb_iface)
    if [ -n "$_if" ]; then
      break
    fi
    _tries=$(expr "$_tries" + 1)
    sleep 1
  done

  if [ -z "$_if" ]; then
    log "no USB Ethernet interface bound yet (adapter unplugged or unsupported)"
    return 0
  fi

  ifconfig "$_if" up >> "$LOG" 2>&1 || true
  "$HELPER" eth-fix "$_if" >> "$LOG" 2>&1 || true

  stop_udhcpc_for "$_if"
  udhcpc -R -p "/var/run/udhcpc.${_if}.pid" -i "$_if" -H HarmonyHub -bS -t5 -T2 -A20 >> "$LOG" 2>&1 &
  log "started udhcpc on $_if"
  return 0
}

stop_usb_eth() {
  log "stopping USB Ethernet"
  _if=$(find_usb_iface)
  if [ -n "$_if" ]; then
    stop_udhcpc_for "$_if"
    ifconfig "$_if" 0.0.0.0 down >> "$LOG" 2>&1 || true
  fi
  for _pidf in /var/run/udhcpc.eth*.pid /var/run/udhcpc.usb*.pid; do
    [ -f "$_pidf" ] || continue
    _ifname=${_pidf#/var/run/udhcpc.}
    _ifname=${_ifname%.pid}
    [ "$_ifname" = "eth1" ] && continue
    stop_udhcpc_for "$_ifname"
    ifconfig "$_ifname" 0.0.0.0 down 2>/dev/null || true
  done
  # Leave ar7240-ehci registered to avoid platform re-registration crashes.
  return 0
}

status_usb_eth() {
  if [ -x "$HELPER" ]; then
    exec "$HELPER" status
  fi
  echo "enabled=0"
  return 1
}

case "$1" in
  start) start_usb_eth "$2" ;;
  stop) stop_usb_eth ;;
  status) status_usb_eth ;;
  *)
    echo "usage: $0 {start [--force]|stop|status}" >&2
    exit 2
    ;;
esac
