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
OFF_MARKER=${USBETH_OFF_MARKER:-/etc/melodious-off}
CONF=${USBETH_CONF:-/data/codex/usb_eth.conf}
HELPER=${USBETH_HELPER:-/data/codex/bin/codex_usbeth}
MOD_DIR=${USBETH_MOD_DIR:-/data/codex/modules/usb-net}
LOG=${USBETH_LOG:-/cache/codex-init.log}
RUN_DIR=${USBETH_RUN_DIR:-/var/run}
STATE_FILE=${USBETH_STATE_FILE:-$RUN_DIR/codex-usb-eth.state}
NET_STATE=${USBETH_NET_STATE:-$RUN_DIR/codex-usb-eth-net.state}
WORKER_PIDFILE=${USBETH_WORKER_PIDFILE:-$RUN_DIR/codex-usb-eth-worker.pid}
# Not codex_webui's flock file (/var/run/codex-usb-eth.lock, which it
# creates and keeps): with the same path, mkdir always failed once the web
# app had changed a setting, and every start/stop waited out lock_acquire.
LOCK_DIR=${USBETH_LOCK_DIR:-$RUN_DIR/codex-usb-eth-service.lock}
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
# --- while the cable works (docs/USB_ETHERNET.md, "Using the cable") ---
UPTIME=${USBETH_UPTIME:-/proc/uptime}
BLOCKER=${USBETH_BLOCKER:-/data/codex/cloud_blocker.conf}
GATEWAY_STATE=${USBETH_GATEWAY_STATE:-/var/volatile/codex-default-gateway}
GUARD_PID=${USBETH_GUARD_PID:-/var/run/codex-offline-egress.pid}
GUARD_CAPS=${USBETH_GUARD_CAPS:-/var/run/codex-offline-egress.caps}
HAL_LTCP=${USBETH_HAL_LTCP:-/data/codex/bin/codex_hal_ltcp}
RESOLV=${USBETH_RESOLV:-/etc/resolv.conf}
SYS_NET=${USBETH_SYS_NET:-/sys/class/net}
# The interface carrying local traffic, while it's the cable: the egress
# guard's private and multicast routes and the clock sync's NTP route
# follow it.
LAN_DEV_FILE=${USBETH_LAN_DEV_FILE:-$RUN_DIR/codex-lan-dev}
# Exists while this service has Wi-Fi disconnected; the egress guard
# reconnects Wi-Fi if it finds it without a live worker.
WIFI_OFF_STATE=$RUN_DIR/codex-usb-eth-wifi-off
# Uptime until which local traffic stays on Wi-Fi: the gateway didn't
# answer through the cable.
DEMOTED_FILE=$RUN_DIR/codex-usb-eth-gateway-lost
# Uptime when the cable began carrying local traffic.
WIRED_SINCE_FILE=$RUN_DIR/codex-usb-eth-wired-since
# What hal last accepted for the front LED (1: extender mode).
LED_STATE=$RUN_DIR/codex-usb-eth-led
# The static settings applied to the wired interface.
STATIC_STATE=$RUN_DIR/codex-usb-eth-static
WIFI_OFF_AFTER=${USBETH_WIFI_OFF_AFTER:-60}
GATEWAY_CHECK_EVERY=${USBETH_GATEWAY_CHECK_EVERY:-30}
GATEWAY_RETRY_AFTER=${USBETH_GATEWAY_RETRY_AFTER:-600}
WIFI_METRIC=20

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

# KEY=value from usb_eth.conf (ENABLED, WIFI_OFF, IP_MODE, IP_ADDRESS,
# IP_NETMASK, IP_GATEWAY, IP_DNS; codex_webui validates what it writes).
conf_value() {
  [ -f "$CONF" ] || return 0
  sed -n "s/^$1=//p" "$CONF" 2>/dev/null | sed -n '1p'
}

is_enabled() {
  [ ! -f "$OFF_MARKER" ] || return 1
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

# One try at the lock; a lock whose owner has died is cleared and taken.
lock_try() {
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    _owner=$(cat "$LOCK_DIR/pid" 2>/dev/null)
    case "$_owner" in
      *[!0-9]*|"") return 1 ;;
    esac
    kill -0 "$_owner" 2>/dev/null && return 1
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null || return 1
  fi
  # The worker's own pid ($$ is its parent's, long gone, in a subshell).
  echo "${WORKER_SELF:-$$}" > "$LOCK_DIR/pid"
  return 0
}

lock_acquire() {
  _tries=0
  while [ "$_tries" -lt 50 ]; do
    lock_try && return 0
    _tries=$(expr "$_tries" + 1)
    sleep 1
  done
  return 1
}

lock_release() {
  rm -rf "$LOCK_DIR"
}

# udhcpc -R releases the lease and runs its deconfig event (clearing the
# address) as it exits: wait for that (bounded), so it can't land after
# what the caller does next, such as setting a static address.
stop_udhcpc_for() {
  _if="$1"
  [ -n "$_if" ] || return 0
  _pidf="$RUN_DIR/udhcpc.${_if}.pid"
  if [ -f "$_pidf" ]; then
    _pid=$(cat "$_pidf" 2>/dev/null)
    case "$_pid" in
      *[!0-9]*|"") ;;
      *)
        kill "$_pid" 2>/dev/null || true
        _ticks=0
        while kill -0 "$_pid" 2>/dev/null && [ "$_ticks" -lt 5 ]; do
          _ticks=$(expr "$_ticks" + 1)
          sleep 1
        done
        kill -9 "$_pid" 2>/dev/null || true
        ;;
    esac
    rm -f "$_pidf"
  fi
  DHCP_STARTED_AT=""
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

# Does the main table still carry a connected route for this interface?
# After a cable pull this kernel can drop it without dropping the
# address, and only re-running DHCP (which re-configures the address)
# brings it back.
wired_route_present() {
  # The connected subnet route itself, not the multicast or a host route
  # the egress guard or the gateway check put on the same interface.
  route -n 2>/dev/null | awk -v d="$1" '$8 == d && $2 == "0.0.0.0" && $1 != "224.0.0.0" && $3 != "255.255.255.255" { f = 1 } END { exit !f }'
}

start_udhcpc() {
  stop_udhcpc_for "$1"
  # Discover every 2 s for 40 s before a 10 s pause: a switch port running
  # spanning tree without treating the adapter as an edge port forwards
  # only ~30 s after link-up, and the lease should follow within a retry.
  udhcpc -R -p "$RUN_DIR/udhcpc.$1.pid" -i "$1" -H HarmonyHub -bS -t20 -T2 -A10 >> "$LOG" 2>&1 &
  log "started udhcpc on $1"
  DHCP_STARTED_AT=$(uptime_s)
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

# NET_STATE for wired iface $1 at address $2, and the ARP settings: each
# interface answers ARP only for its own address and announces only its
# own. Before the gateway check too, so its reply can't come back through
# Wi-Fi. Restored verbatim by cleanup_net. A new interface or address
# starts over.
net_prepare() {
  _if="$1"
  _ip="$2"
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
  for _i in "$_if" "$WIFI_IF"; do
    save_sysctl "$_i" arp_ignore
    save_sysctl "$_i" arp_announce
    set_sysctl "$_i" arp_ignore 1
    set_sysctl "$_i" arp_announce 2
  done
}

apply_net() {
  # $1 = wired iface. Exactly the settings recorded in NET_STATE change.
  # A failed apply is never cached as success: without a net_applied=1
  # marker the helper is retried on every monitor pass.
  _if="$1"
  _ip=$(helper_field ipv4)
  net_prepare "$_if" "$_ip"
  grep '^net_applied=1$' "$NET_STATE" >/dev/null 2>&1 && return 0
  _out=$("$HELPER" net-apply "$_if" "$WIFI_IF" 2>>"$LOG")
  _rc=$?
  echo "$_out" >> "$LOG"
  _mode=$(echo "$_out" | sed -n 's/^route_mode=\([a-z]*\).*/\1/p' | sed -n '1p')
  grep -v '^route_mode=' "$NET_STATE" > "$NET_STATE.tmp" 2>/dev/null || true
  mv "$NET_STATE.tmp" "$NET_STATE" 2>/dev/null || true
  echo "route_mode=$_mode" >> "$NET_STATE"
  if [ "$_rc" = "0" ]; then
    echo "net_applied=1" >> "$NET_STATE"
  fi
  [ "$_rc" = "0" ]
}

# The cable stops carrying local traffic (or the wired path goes): Wi-Fi
# back on, the egress guard and clock sync back on Wi-Fi, routes and ARP as
# they were.
cleanup_net() {
  wifi_resume "the cable isn't carrying local traffic any more"
  rm -f "$LAN_DEV_FILE" "$WIRED_SINCE_FILE"
  [ -f "$NET_STATE" ] || return 0
  restore_wifi_default
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

# --- using the cable: gateway check, Wi-Fi off, static address, LED ---

uptime_s() {
  awk '{ print int($1) }' "$UPTIME" 2>/dev/null
}

iface_ip() {
  ifconfig "$1" 2>/dev/null | sed -n 's/.*inet addr:\([0-9.]*\).*/\1/p'
}

iface_mask() {
  ifconfig "$1" 2>/dev/null | sed -n 's/.*Mask:\([0-9.]*\).*/\1/p'
}

network_of() {
  echo "$1 $2" | awk '{
    split($1, a, "."); split($2, m, ".")
    for (i = 1; i <= 4; i++) {
      x = a[i]; y = m[i]; r = 0; bit = 128
      while (bit >= 1) { if (x >= bit && y >= bit) r += bit; if (x >= bit) x -= bit; if (y >= bit) y -= bit; bit /= 2 }
      o[i] = r
    }
    print o[1] "." o[2] "." o[3] "." o[4] }'
}

# The egress guard's rule: on unless cloud_blocker.conf says otherwise.
blocker_on() {
  [ "$(sed -n '1p' "$BLOCKER" 2>/dev/null)" = "1" ]
}

# The gateway the hub uses for the rest of the LAN: with the cloud blocker
# on, the one the egress guard saved (it removes the default route); with
# it off, a default route's (the saved one can be stale by then). Like the
# guard, only a default route through Wi-Fi or through the cable already
# carrying local traffic counts: the adapter's own DHCP adds one for
# whatever network it's on. Any only while Wi-Fi has no address.
hub_gateway() {
  if blocker_on; then
    _gw=$(sed -n '1p' "$GATEWAY_STATE" 2>/dev/null)
    case "$_gw" in
      *[!0-9.]*|"") ;;
      *) echo "$_gw"; return ;;
    esac
  fi
  route -n 2>/dev/null | awk -v w="$WIFI_IF" -v lan="$(cat "$LAN_DEV_FILE" 2>/dev/null)" \
      -v alone="$([ -z "$(iface_ip "$WIFI_IF")" ] && echo 1)" '
    $1 == "0.0.0.0" && $4 ~ /G/ {
      if ($8 == w || ($8 == lan && lan != "")) { print $2; found = 1; exit }
      if (alone == "1" && any == "") any = $2
    }
    END { if (!found && any != "") print any }'
}

# True if the wired address $1/$2 is on the hub gateway's network: only
# then does the cable carry local traffic (otherwise it's an extra address
# on another network). With no gateway known, only if Wi-Fi has no address.
lan_role() {
  _gw=$(hub_gateway)
  if [ -n "$_gw" ]; then
    [ "$(network_of "$_gw" "$2")" = "$(network_of "$1" "$2")" ]
  else
    [ -z "$(iface_ip "$WIFI_IF")" ]
  fi
}

# True if Wi-Fi has an address on a network that overlaps the wired address
# $1/$2 but with another mask (say Wi-Fi 192.168.1.50/24, cable
# 192.168.1.20/16). net-apply moves only a shared subnet with one prefix, so
# Wi-Fi's more specific route would keep the local traffic: the cable must
# not take it over (nor turn Wi-Fi off) then.
prefix_mismatch() {
  _fip=$(iface_ip "$WIFI_IF")
  _fmask=$(iface_mask "$WIFI_IF")
  [ -n "$_fip" ] && [ -n "$_fmask" ] && [ "$_fmask" != "$2" ] || return 1
  _short=$(echo "$2 $_fmask" | awk '{
    split($1, a, "."); split($2, b, ".")
    x = ((a[1] * 256 + a[2]) * 256 + a[3]) * 256 + a[4]
    y = ((b[1] * 256 + b[2]) * 256 + b[3]) * 256 + b[4]
    print (x < y ? $1 : $2) }')
  [ "$(network_of "$1" "$_short")" = "$(network_of "$_fip" "$_short")" ]
}

gateway_lost() {
  _until=$(cat "$DEMOTED_FILE" 2>/dev/null)
  case "$_until" in ""|*[!0-9]*) rm -f "$DEMOTED_FILE"; return 1 ;; esac
  _now=$(uptime_s)
  [ -n "$_now" ] && [ "$_now" -lt "$_until" ] && return 0
  rm -f "$DEMOTED_FILE"
  return 1
}

# Before the cable takes local traffic from Wi-Fi, the gateway must answer
# a ping sent through it: a host route for the ping's few seconds, with ARP
# already strict on both interfaces (net_prepare), so the reply can't come
# back through Wi-Fi. An adapter that sends but hardly receives would
# otherwise take the LAN away from a working Wi-Fi. (BusyBox's ping takes
# any echo reply, so another ping running at that moment could pass it; the
# 30-second checks after the hand-over catch a cable that doesn't work.)
cable_reaches_gateway() {
  _pgw=$(hub_gateway)
  [ -n "$_pgw" ] || return 0
  route add -host "$_pgw" dev "$1" >/dev/null 2>&1
  ping "$_pgw" >/dev/null 2>&1
  _pok=$?
  route del -host "$_pgw" dev "$1" >/dev/null 2>&1
  return $_pok
}

gateway_answers() {
  _gw=$(hub_gateway)
  [ -n "$_gw" ] && ping "$_gw" >/dev/null 2>&1
}

wpa_ok() {
  _out=$(wpa_cli -i "$WIFI_IF" "$1" 2>/dev/null) || return 1
  case "$_out" in *FAIL*) return 1 ;; esac
}

wifi_suspended() {
  [ -f "$WIFI_OFF_STATE" ]
}

# Disconnect Wi-Fi (wpa_supplicant keeps running and keeps its settings,
# so any restart brings it back).
# Recorded first: a stop landing in between must still find Wi-Fi to
# reconnect (wifi_resume and the guard's watchdog go by this file).
wifi_suspend() {
  touch "$WIFI_OFF_STATE"
  if ! wpa_ok disconnect; then
    rm -f "$WIFI_OFF_STATE"
    return 1
  fi
  log "Wi-Fi off: the cable works"
}

# The state file goes only once the reconnect was taken; otherwise the next
# pass (or the egress guard's watchdog) tries again. A failure is logged once.
wifi_resume() {
  wifi_suspended || return 0
  if ! wpa_ok reconnect; then
    [ -f "$WIFI_OFF_STATE.failed" ] || { touch "$WIFI_OFF_STATE.failed"; log "Wi-Fi reconnect failed; trying again"; }
    return 1
  fi
  rm -f "$WIFI_OFF_STATE" "$WIFI_OFF_STATE.failed"
  log "Wi-Fi back on${1:+: $1}"
}

# A running egress guard with its Wi-Fi watchdog (announced in GUARD_CAPS):
# Wi-Fi goes off only with that safety net for a worker that dies.
wifi_safety_net() {
  grep '^wifi-watchdog$' "$GUARD_CAPS" >/dev/null 2>&1 || return 1
  _gp=$(sed -n '1p' "$GUARD_PID" 2>/dev/null)
  case "$_gp" in *[!0-9]*|"") return 1 ;; esac
  kill -0 "$_gp" 2>/dev/null
}

# Static settings from usb_eth.conf as ip=/mask=/router=/dns= lines, or
# nothing (exit 1) if they aren't valid.
static_settings() {
  # One read of the file: codex_webui may rename a new one in between.
  _sc=$(cat "$CONF" 2>/dev/null)
  echo | awk -v address="$(echo "$_sc" | sed -n 's/^IP_ADDRESS=//p' | sed -n '1p')" \
      -v netmask="$(echo "$_sc" | sed -n 's/^IP_NETMASK=//p' | sed -n '1p')" \
      -v gateway="$(echo "$_sc" | sed -n 's/^IP_GATEWAY=//p' | sed -n '1p')" \
      -v servers="$(echo "$_sc" | sed -n 's/^IP_DNS=//p' | sed -n '1p')" '
    function quad(s,   p, n, i) {
      if (s !~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) return -1
      n = split(s, p, "."); v = 0
      for (i = 1; i <= 4; i++) { if (p[i] > 255 || (length(p[i]) > 1 && substr(p[i], 1, 1) == "0")) return -1; v = v * 256 + p[i] }
      return v
    }
    function masked(a, m,   r, bit) {
      r = 0
      for (bit = 2147483648; bit >= 1; bit /= 2) { if (a >= bit && m >= bit) r += bit; if (a >= bit) a -= bit; if (m >= bit) m -= bit }
      return r
    }
    {
      if (address ~ /[ \t]/ || netmask ~ /[ \t]/ || gateway ~ /[ \t]/) exit 1
      nd = split(servers, d, " ")
      if (nd > 2) exit 1
      a = quad(address); m = quad(netmask)
      if (a < 0 || m < 0) exit 1
      host = 4294967295 - m; bits = 0; x = host + 1
      while (x > 1 && x % 2 == 0) { x /= 2; bits++ }
      if (x != 1 || bits < 2 || bits > 24) exit 1
      net = masked(a, m); first = int(a / 16777216)
      if (a == net || a == net + host || first == 0 || first == 127 || first >= 224) exit 1
      gw = ""
      if (gateway != "") { g = quad(gateway); if (g < 0 || masked(g, m) != net || g == a || g == net || g == net + host) exit 1; gw = gateway }
      dns = ""
      for (i = 1; i <= nd; i++) { if (quad(d[i]) <= 0) exit 1; dns = dns (dns == "" ? "" : " ") d[i] }
      print "ip=" address; print "mask=" netmask; print "router=" gw; print "dns=" dns
    }'
}

static_mode() {
  [ "$(conf_value IP_MODE)" = "static" ]
}

# Static mode: the settings on the interface, no DHCP client. Re-applied
# from scratch when they change. Returns 1 if they aren't valid (the
# interface is then left without an address).
apply_static() {
  _sif=$1
  _want=$(static_settings) || _want=""
  if [ -z "$_want" ]; then
    if [ -f "$STATIC_STATE" ] || [ -n "$(iface_ip "$_sif")" ]; then
      cleanup_net
      ifconfig "$_sif" 0.0.0.0 >> "$LOG" 2>&1 || true
      rm -f "$STATIC_STATE"
    fi
    return 1
  fi
  if [ -f "$STATIC_STATE" ] && [ "$(cat "$STATIC_STATE")" = "$_want" ] && [ -n "$(iface_ip "$_sif")" ]; then
    return 0
  fi
  cleanup_net
  _sip=$(echo "$_want" | sed -n 's/^ip=//p')
  _smask=$(echo "$_want" | sed -n 's/^mask=//p')
  _sdns=$(echo "$_want" | sed -n 's/^dns=//p')
  ifconfig "$_sif" 0.0.0.0 >> "$LOG" 2>&1 || true
  ifconfig "$_sif" "$_sip" netmask "$_smask" up >> "$LOG" 2>&1 || return 1
  # Wi-Fi's DHCP owns resolv.conf; fill it only if it's empty.
  if [ -n "$_sdns" ] && ! grep '^nameserver' "$RESOLV" >/dev/null 2>&1; then
    for _d in $_sdns; do echo "nameserver $_d"; done > "$RESOLV"
  fi
  echo "$_want" > "$STATIC_STATE"
  log "$_sif: address $_sip/$_smask (static)"
}

# With the cloud blocker off there is a default route; while the cable
# carries local traffic, the internet goes through it too. Wi-Fi's default
# route moves to metric $WIFI_METRIC (put back by cleanup_net); in static
# mode the wired one is added from the settings' gateway. (With the blocker
# on, the egress guard removes every default route itself.)
prefer_wired_default() {
  blocker_on && return 0
  # Back from demote_wired_default.
  route -n 2>/dev/null | awk -v d="$1" '$1 == "0.0.0.0" && $8 == d && $5 == "30" { print $2 }' |
    while read _dgw; do
      route del default gw "$_dgw" dev "$1" metric 30 >/dev/null 2>&1 &&
        route add default gw "$_dgw" dev "$1" metric 0 >/dev/null 2>&1
    done
  if static_mode && [ -f "$STATIC_STATE" ]; then
    _sgw=$(sed -n 's/^router=//p' "$STATIC_STATE")
    if [ -n "$_sgw" ] && ! route -n 2>/dev/null | awk -v d="$1" '$1 == "0.0.0.0" && $8 == d { f = 1 } END { exit !f }'; then
      route add default gw "$_sgw" dev "$1" metric 0 >/dev/null 2>&1 &&
        { grep '^static_default=' "$NET_STATE" >/dev/null 2>&1 || echo "static_default=$_sgw" >> "$NET_STATE"; }
    fi
  fi
  # Only once the cable has a default route of its own.
  route -n 2>/dev/null | awk -v d="$1" '$1 == "0.0.0.0" && $8 == d { f = 1 } END { exit !f }' || return 0
  route -n 2>/dev/null | awk -v d="$WIFI_IF" '$1 == "0.0.0.0" && $8 == d && $5 == "0" { print $2 }' |
    while read _wgw; do
      route del default gw "$_wgw" dev "$WIFI_IF" metric 0 >/dev/null 2>&1 || continue
      route add default gw "$_wgw" dev "$WIFI_IF" metric "$WIFI_METRIC" >/dev/null 2>&1
      grep "^wifi_default=$_wgw\$" "$NET_STATE" >/dev/null 2>&1 || echo "wifi_default=$_wgw" >> "$NET_STATE"
    done
}

# With the cloud blocker off, the cable's own DHCP adds a default route
# for whatever network it's on. While the cable doesn't carry local traffic
# (another network, or its gateway not answering), that route mustn't take
# the internet from Wi-Fi: it moves to metric 30, behind Wi-Fi's. Once the
# cable carries local traffic, prefer_wired_default puts it back at 0.
demote_wired_default() {
  blocker_on && return 0
  route -n 2>/dev/null | awk -v d="$1" '$1 == "0.0.0.0" && $8 == d && $5 == "0" { print $2 }' |
    while read _dgw; do
      route del default gw "$_dgw" dev "$1" metric 0 >/dev/null 2>&1 &&
        route add default gw "$_dgw" dev "$1" metric 30 >/dev/null 2>&1
    done
  return 0
}

restore_wifi_default() {
  for _wgw in $(sed -n 's/^wifi_default=//p' "$NET_STATE" 2>/dev/null); do
    route del default gw "$_wgw" dev "$WIFI_IF" metric "$WIFI_METRIC" >/dev/null 2>&1
    route -n 2>/dev/null | awk -v d="$WIFI_IF" '$1 == "0.0.0.0" && $8 == d && $5 == "0" { f = 1 } END { exit !f }' ||
      route add default gw "$_wgw" dev "$WIFI_IF" metric 0 >/dev/null 2>&1
  done
  _sgw=$(sed -n 's/^static_default=//p' "$NET_STATE" 2>/dev/null)
  _sif=$(sed -n 's/^wired_if=//p' "$NET_STATE" 2>/dev/null)
  [ -n "$_sgw" ] && [ -n "$_sif" ] && route del default gw "$_sgw" dev "$_sif" metric 0 >/dev/null 2>&1
  return 0
}

# The gateway doesn't answer through the cable although it has a link:
# local traffic back to Wi-Fi until GATEWAY_RETRY_AFTER has passed, then the
# cable gets another chance. $2: what happened, for the log.
lose_gateway() {
  echo "$(($1 + GATEWAY_RETRY_AFTER))" > "$DEMOTED_FILE"
  NOT_BEFORE=$(($1 + GATEWAY_RETRY_AFTER))
  GATEWAY_MISSES=0
  PROBE_MISSES=0
  cleanup_net
  log "${2:-the gateway stopped answering through the cable}; local traffic on $WIFI_IF for $((GATEWAY_RETRY_AFTER / 60)) min"
}

# A new link or address: a fresh try.
fresh_link() {
  rm -f "$DEMOTED_FILE"
  PROBE_MISSES=0
  GATEWAY_MISSES=0
  NOT_BEFORE=0
}

# While the cable carries local traffic: the gateway is pinged (through the
# cable, which has the preferred routes) every GATEWAY_CHECK_EVERY seconds,
# Wi-Fi on or off. Two misses in a row hand local traffic back to Wi-Fi.
# False when it just did.
watch_gateway() {
  [ -f "$LAN_DEV_FILE" ] || return 0
  [ -n "$(hub_gateway)" ] || return 0
  _wnow=$(uptime_s)
  [ -n "$_wnow" ] && [ "$_wnow" -ge "$NEXT_GATEWAY_CHECK" ] || return 0
  NEXT_GATEWAY_CHECK=$((_wnow + GATEWAY_CHECK_EVERY))
  if gateway_answers; then
    GATEWAY_MISSES=0
    return 0
  fi
  GATEWAY_MISSES=$((GATEWAY_MISSES + 1))
  [ "$GATEWAY_MISSES" -ge 2 ] || return 0
  lose_gateway "$_wnow"
  return 1
}

# "Wi-Fi off while the cable works" (WIFI_OFF=1): the cable must carry local
# traffic, have done so for WIFI_OFF_AFTER seconds, and its last gateway
# check must have passed; with the cloud blocker off it also needs a default
# route of its own. Anything that ends the cable's turn goes through
# cleanup_net, which reconnects Wi-Fi.
manage_wifi() {
  watch_gateway || return 0
  if [ "$(conf_value WIFI_OFF)" != "1" ] || [ ! -f "$LAN_DEV_FILE" ]; then
    wifi_resume "Wi-Fi off while the cable works is off"
    return 0
  fi
  if ! blocker_on && ! route -n 2>/dev/null | awk -v d="$(cat "$LAN_DEV_FILE")" '$1 == "0.0.0.0" && $8 == d { f = 1 } END { exit !f }'; then
    wifi_resume "the cable has no router for the internet"
    return 0
  fi
  _mnow=$(uptime_s)
  [ -n "$_mnow" ] || return 0
  _since=$(cat "$WIRED_SINCE_FILE" 2>/dev/null)
  case "$_since" in ""|*[!0-9]*) _since=$_mnow; echo "$_mnow" > "$WIRED_SINCE_FILE" ;; esac
  wifi_suspended && return 0
  [ -n "$(hub_gateway)" ] && [ "$GATEWAY_MISSES" = 0 ] || return 0
  if [ "$_mnow" -ge "$NOT_BEFORE" ] && [ $((_mnow - _since)) -ge "$WIFI_OFF_AFTER" ] && wifi_safety_net; then
    # hal's Wi-Fi-down handler turns the LED red: say extender mode again after it.
    wifi_suspend && LED_FORCE_AT=$((_mnow + 2))
  fi
  return 0
}

# The front LED. hal drives it: green while its own Wi-Fi is connected, or
# while it's in "extender mode" (a stock state for a hub that reaches the
# network another way, read only for the LED), red otherwise. hal re-reads
# the flag only when the LED changes state (fire_command, a short "IR
# fired" blink, makes it), and its Wi-Fi-down handler writes red without
# looking at it. So after each pass (and on stop): extender mode exactly
# while the cable carries local traffic. Sent when that differs from what
# hal last accepted (LED_STATE), with a blink; a refusal is tried again
# 30 s later. LED_STATE says "pending" while a change is being sent, so a
# worker that dies halfway (hal told extender mode, no blink yet) leaves a
# state that matches neither, and recover or stop sends it again.
# LED_FORCE_AT sends it again from that uptime on (worker start, and 2 s
# after Wi-Fi goes off). In extender mode it's repeated every 5 minutes
# without a blink, in case hal restarted.
LED_FORCE_AT=0
LED_RETRY_AT=0
LED_NEXT_ASSERT=0

hal_led() {
  _lo=$("$HAL_LTCP" sys.led "{\"action\":\"$1\"}" 3 2>/dev/null)
  case "$_lo" in *'"code":200'*) return 0 ;; esac
  return 1
}

led_sync() {
  [ -x "$HAL_LTCP" ] || return 0
  _want=0
  [ -f "$LAN_DEV_FILE" ] && _want=1
  _have=$(cat "$LED_STATE" 2>/dev/null)
  case "$_have" in 0|1) ;; '') _have=0 ;; *) _have=pending ;; esac
  _lnow=$(uptime_s)
  _lnow=${_lnow:-0}
  _force=0
  [ "$LED_FORCE_AT" -gt 0 ] && [ "$_lnow" -ge "$LED_FORCE_AT" ] && _force=1
  if [ "$_want" = "$_have" ] && { [ "$_force" = 0 ] || [ "$_want" = 0 ]; }; then
    [ "$_force" = 1 ] && LED_FORCE_AT=0
    if [ "$_want" = 1 ] && [ "$_lnow" -ge "$LED_NEXT_ASSERT" ] && [ "$_lnow" -ge "$LED_RETRY_AT" ]; then
      if hal_led extender_mode; then LED_NEXT_ASSERT=$((_lnow + 300)); else LED_RETRY_AT=$((_lnow + 30)); fi
    fi
    return 0
  fi
  [ "$_lnow" -ge "$LED_RETRY_AT" ] || return 0
  if [ "$_want" = 1 ]; then _mode=extender_mode; else _mode=non_extender_mode; fi
  echo pending > "$LED_STATE"
  if hal_led "$_mode" && hal_led fire_command; then
    echo "$_want" > "$LED_STATE"
    LED_FORCE_AT=0
    LED_RETRY_AT=0
    LED_NEXT_ASSERT=$((_lnow + 300))
  else
    LED_RETRY_AT=$((_lnow + 30))
  fi
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
  # This worker's own pid ($$ is the parent's in a subshell; read is a
  # builtin, so /proc/self is this shell). On exit the pid file goes only
  # while it still names this worker: restart puts its own pid there first.
  read WORKER_SELF _rest < /proc/self/stat 2>/dev/null || WORKER_SELF=""
  trap '[ "$(cat "$WORKER_PIDFILE" 2>/dev/null)" = "$WORKER_SELF" ] && rm -f "$WORKER_PIDFILE"' 0
  # A hangup (the end of the SSH session an installer ran restart from)
  # must not end it.
  trap '' 1
  PROBE_MISSES=0
  GATEWAY_MISSES=0
  NEXT_GATEWAY_CHECK=0
  NOT_BEFORE=0
  DHCP_STARTED_AT=""
  PREFIX_LOGGED=""
  write_state starting phy_wait

  # Phase 1: dependencies + PHY readiness, bounded. phy-host writes
  # nothing when the register reads back as a sentinel, so retrying it
  # is a pure readiness probe. usbcore must be loaded before ehci-hcd
  # can resolve its symbols; stock loads both late in boot (usbmgr), so
  # load them here, in dependency order, if they are not present yet.
  _ticks=0
  _phy_ok=0
  # A controller already bound this boot (restart, or start after stop)
  # means host mode is on: nothing to probe. The probe would mislead then:
  # usbctrlr1 reads 0xdeadbeef while Wi-Fi is disconnected (seen on a hub
  # with "Wi-Fi off" on), although the bus keeps working.
  if [ "$(helper_field ehci_bound)" = "1" ]; then
    _phy_ok=1
    write_state starting controller_wait
  fi
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

  write_state awaiting_carrier_dhcp dhcp_or_carrier
  # Tell hal the LED state again, in case it restarted too.
  LED_FORCE_AT=1

  # Phase 4: monitor carrier and address, give the cable local traffic
  # once the gateway answers through it, keep checking, and hand the
  # Wi-Fi path back the moment the cable stops working.
  while true; do
    if ! is_enabled; then
      # Re-checked under the lock start takes: switched off and straight
      # back on, start either sees this worker gone or finds it carrying on.
      if lock_acquire; then
        if ! is_enabled; then
          rm -f "$WORKER_PIDFILE"
          lock_release
          log "disabled while running; worker exiting (stop does cleanup)"
          exit 0
        fi
        lock_release
      fi
    fi
    _cur=$(find_usb_iface)
    if [ -z "$_cur" ]; then
      cleanup_net
      led_sync
      write_state adapter_absent interface_gone
      log "USB Ethernet interface gone; worker exiting"
      exit 0
    fi
    _if="$_cur"
    _carrier=$(helper_field carrier)
    if [ "$_carrier" != "1" ]; then
      if [ -f "$NET_STATE" ] || [ -f "$LAN_DEV_FILE" ] || wifi_suspended; then
        cleanup_net
      fi
      fresh_link
      _route_fixes=0
      write_state awaiting_carrier_dhcp no_carrier
    elif wired_address "$_if"; then
      _ip=$(helper_field ipv4)
      if [ -z "$_ip" ]; then
        [ -f "$LAN_DEV_FILE" ] && cleanup_net
        PROBE_MISSES=0
        write_state awaiting_carrier_dhcp no_ipv4_lease
      else
        if ! wired_route_present "$_if"; then
          # Link returned without its connected route: re-configuring the
          # address recreates it (DHCP re-run, or the static settings
          # re-applied). Bounded: three attempts per link episode.
          if [ "${_route_fixes:-0}" -lt 3 ]; then
            _route_fixes=$(expr "${_route_fixes:-0}" + 1)
            log "wired route missing on $_if; re-configuring its address (attempt $_route_fixes)"
            if static_mode; then
              rm -f "$STATIC_STATE"
              apply_static "$_if" || true
            else
              start_udhcpc "$_if"
            fi
            sleep "$POLL"
            _ip=$(helper_field ipv4)
          fi
        else
          _route_fixes=0
        fi
        [ -n "$_ip" ] && use_cable "$_if" "$_ip"
      fi
    fi
    manage_wifi
    led_sync
    sleep "$MONITOR_POLL"
  done
}

# The wired address: the static settings (no DHCP client), or one DHCP
# client's lease. False (state written) when the static settings aren't
# valid.
wired_address() {
  if static_mode; then
    if udhcpc_running "$1"; then
      stop_udhcpc_for "$1"
      cleanup_net
      ifconfig "$1" 0.0.0.0 >> "$LOG" 2>&1 || true
    fi
    if ! apply_static "$1"; then
      write_state failed static_invalid
      return 1
    fi
    return 0
  fi
  if [ -f "$STATIC_STATE" ]; then
    # Switched from static to DHCP: drop the static address first.
    cleanup_net
    ifconfig "$1" 0.0.0.0 >> "$LOG" 2>&1 || true
    rm -f "$STATIC_STATE"
  fi
  # One client: a new one only if none runs and the last one either died
  # (its pid file names a dead process) or never wrote its pid file within
  # 10 s. Until a client has written its pid file, it doesn't show as running.
  if ! udhcpc_running "$1"; then
    _dnow=$(uptime_s)
    if [ -f "$RUN_DIR/udhcpc.$1.pid" ] || [ -z "$DHCP_STARTED_AT" ] ||
       [ "${_dnow:-0}" -ge $((DHCP_STARTED_AT + 10)) ]; then
      start_udhcpc "$1"
    fi
  fi
  return 0
}

# The wired interface $1 has address $2. On the gateway's network it takes
# local traffic, but only once the gateway answers a ping through it (two
# misses a pass apart keep it on Wi-Fi for GATEWAY_RETRY_AFTER). On another
# network it's only an extra address.
use_cable() {
  _uif=$1
  _uip=$2
  _umask=$(iface_mask "$_uif")
  if [ -z "$_umask" ] || ! lan_role "$_uip" "$_umask"; then
    [ -f "$LAN_DEV_FILE" ] && cleanup_net
    demote_wired_default "$_uif"
    if apply_net "$_uif"; then
      write_state operational ""
    else
      write_state degraded_routing route_apply_failed
    fi
    return
  fi
  if prefix_mismatch "$_uip" "$_umask"; then
    if [ -f "$NET_STATE" ] || [ -f "$LAN_DEV_FILE" ]; then
      cleanup_net
    fi
    demote_wired_default "$_uif"
    [ "$PREFIX_LOGGED" = "$_uip/$_umask" ] ||
      log "$_uif ($_uip, mask $_umask) is on Wi-Fi's network with another mask ($(iface_mask "$WIFI_IF")): local traffic stays on $WIFI_IF"
    PREFIX_LOGGED="$_uip/$_umask"
    write_state degraded_routing prefix_mismatch
    return
  fi
  PREFIX_LOGGED=""
  if gateway_lost; then
    if [ -f "$NET_STATE" ] || [ -f "$LAN_DEV_FILE" ]; then
      cleanup_net
    fi
    demote_wired_default "$_uif"
    write_state gateway_unreachable gateway_lost
    return
  fi
  if [ "$(cat "$LAN_DEV_FILE" 2>/dev/null)" != "$_uif" ] ||
     [ "$(sed -n 's/^wired_ip=//p' "$NET_STATE" 2>/dev/null)" != "$_uip" ]; then
    net_prepare "$_uif" "$_uip"
    if ! cable_reaches_gateway "$_uif"; then
      PROBE_MISSES=$((PROBE_MISSES + 1))
      if [ "$PROBE_MISSES" -ge 2 ]; then
        _pnow=$(uptime_s)
        lose_gateway "${_pnow:-0}" "the gateway doesn't answer through $_uif"
        write_state gateway_unreachable gateway_lost
      else
        write_state awaiting_carrier_dhcp gateway_check
      fi
      return
    fi
    PROBE_MISSES=0
    GATEWAY_MISSES=0
    _pnow=$(uptime_s)
    NEXT_GATEWAY_CHECK=$((${_pnow:-0} + GATEWAY_CHECK_EVERY))
  fi
  if apply_net "$_uif"; then
    if [ "$(cat "$LAN_DEV_FILE" 2>/dev/null)" != "$_uif" ]; then
      echo "$_uif" > "$LAN_DEV_FILE"
      uptime_s > "$WIRED_SINCE_FILE"
      log "LAN traffic now through $_uif ($_uip)"
    fi
    prefer_wired_default "$_uif"
    write_state operational ""
  else
    write_state degraded_routing route_apply_failed
  fi
}

# Called by the egress guard when the worker has gone while the cable carried
# local traffic or Wi-Fi was off: undo what the worker had set up, as a
# hand-back to Wi-Fi does (cleanup_net: Wi-Fi reconnected, codex-lan-dev
# gone, routes and ARP as they were), so the hub can be reached over Wi-Fi
# even if the adapter still has its link. Without waiting for the lock: a
# start, stop or restart holding it sorts things out itself, and the guard
# asks again 2 s later. Prints "recovered" when it did something; false while
# something is left to do (a refused reconnect, the lock busy).
recover_usb_eth() {
  lock_try || return 1
  if worker_running; then
    lock_release
    return 0
  fi
  if [ -f "$LAN_DEV_FILE" ] || [ -f "$NET_STATE" ] || wifi_suspended; then
    log "the USB Ethernet worker has stopped: local traffic back on $WIFI_IF"
    cleanup_net
    led_sync
    write_state failed worker_stopped
    echo recovered
  fi
  lock_release
  ! wifi_suspended && [ ! -f "$LAN_DEV_FILE" ]
}

start_usb_eth() {
  if [ -f "$OFF_MARKER" ]; then
    log "start skipped ($OFF_MARKER present)"
    return 0
  fi
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

# After an upgrade (the installers): replace a running worker with the new
# script's, leaving the wired path as it is (address, DHCP client, routes,
# Wi-Fi off). The new worker finds the controller bound, the driver loaded
# and the interface up, keeps the running DHCP client, and carries on from
# the state files. A stop and start would drop the wired address, and with
# Wi-Fi off the installer's own SSH session along with it.
restart_usb_eth() {
  is_enabled || return 0
  [ -x "$HELPER" ] || return 1
  trap '' 1  # run over SSH by the installers: finish even if that session ends
  lock_acquire || {
    log "restart failed: cannot take $LOCK_DIR"
    return 1
  }
  if [ -f "$WORKER_PIDFILE" ]; then
    _pid=$(cat "$WORKER_PIDFILE" 2>/dev/null)
    # This shell holds the pid file during the swap, so the egress guard's
    # Wi-Fi watchdog never sees "no worker" and reconnects Wi-Fi.
    echo $$ > "$WORKER_PIDFILE"
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
  fi
  log "restarting the USB Ethernet worker (the wired path stays as it is)"
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
  # codex_webui stops a couple of seconds after switching off (it answers
  # first): if the switch is back on by then, keep it on, with a worker.
  if [ "$1" = "if-disabled" ] && is_enabled; then
    log "stop skipped: switched back on"
    lock_release
    worker_running || start_usb_eth
    return 0
  fi
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
  rm -f "$STATIC_STATE" "$DEMOTED_FILE"
  led_sync
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
  # Using the cable (docs/USB_ETHERNET.md): where local traffic goes, the
  # Wi-Fi-off option and state, the address settings and what's on the
  # interface now.
  _sif=$(find_usb_iface)
  echo "lan_dev=$(cat "$LAN_DEV_FILE" 2>/dev/null || echo "$WIFI_IF")"
  echo "wifi_ip=$(iface_ip "$WIFI_IF")"
  echo "wifi_off=$([ "$(conf_value WIFI_OFF)" = "1" ] && echo 1 || echo 0)"
  echo "wifi_suspended=$(wifi_suspended && echo 1 || echo 0)"
  # Wi-Fi off needs the egress guard's watchdog (a guard from before an
  # upgrade runs until the hub restarts).
  echo "wifi_watchdog=$(wifi_safety_net && echo 1 || echo 0)"
  # Why Wi-Fi stays on although wanted, when it can't go off by waiting:
  # with the cloud blocker off the cable needs a default route of its own.
  _ld=$(cat "$LAN_DEV_FILE" 2>/dev/null)
  if [ -n "$_ld" ] && ! blocker_on &&
     ! route -n 2>/dev/null | awk -v d="$_ld" '$1 == "0.0.0.0" && $8 == d { f = 1 } END { exit !f }'; then
    echo "wifi_off_blocked=no_router"
  fi
  gateway_lost && echo "gateway_lost=1"
  echo "ip_mode=$(static_mode && echo static || echo dhcp)"
  _srouter=""
  if static_mode && [ -f "$STATIC_STATE" ]; then
    _srouter=$(sed -n 's/^router=//p' "$STATIC_STATE")
  elif [ -n "$_sif" ]; then
    _srouter=$(route -n 2>/dev/null | awk -v d="$_sif" '$1 == "0.0.0.0" && $8 == d { print $2; exit }')
  fi
  [ -n "$_sif" ] && echo "netmask=$(iface_mask "$_sif")"
  echo "router=$_srouter"
  echo "dns=$(sed -n 's/^nameserver[ \t]*\([0-9.]*\).*/\1/p' "$RESOLV" 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
  return 0
}

# One interface for overview: "iface=name|kind|ip|mask|mac|up|rx_bytes|
# tx_bytes|rx_errors|tx_errors". Addresses from ifconfig, counters from sysfs.
iface_line() {
  _info=$(ifconfig "$1" 2>/dev/null)
  _iip=$(echo "$_info" | sed -n 's/.*inet addr:\([0-9.]*\).*/\1/p')
  _imask=$(echo "$_info" | sed -n 's/.*Mask:\([0-9.]*\).*/\1/p')
  _up=0
  echo "$_info" | grep ' UP ' >/dev/null 2>&1 && _up=1
  _st=$SYS_NET/$1/statistics
  printf 'iface=%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' "$1" "$2" "$_iip" "$_imask" \
    "$(cat "$SYS_NET/$1/address" 2>/dev/null)" "$_up" \
    "$(cat "$_st/rx_bytes" 2>/dev/null)" "$(cat "$_st/tx_bytes" 2>/dev/null)" \
    "$(cat "$_st/rx_errors" 2>/dev/null)" "$(cat "$_st/tx_errors" 2>/dev/null)"
}

# The network overview (GET /api/network-overview): Wi-Fi, the wired
# interface, the routing table and DNS, as key=value lines. Read-only.
overview_usb_eth() {
  wpa_cli -i "$WIFI_IF" status 2>/dev/null | sed -n \
    -e 's/^wpa_state=/wifi_state=/p' -e 's/^ssid=/wifi_ssid=/p' -e 's/^bssid=/wifi_bssid=/p' \
    -e 's/^key_mgmt=/wifi_security=/p' -e 's/^pairwise_cipher=/wifi_cipher=/p'
  iwconfig "$WIFI_IF" 2>/dev/null | awk '
    { line = line " " $0 }
    END {
      if (match(line, /IEEE [^ ]+/)) print "wifi_standard=" substr(line, RSTART + 5, RLENGTH - 5)
      if (match(line, /Frequency:[0-9.]+ GHz/)) print "wifi_frequency=" substr(line, RSTART + 10, RLENGTH - 14)
      if (match(line, /Bit Rate[:=][0-9.]+ [kMG]b\/s/)) print "wifi_bit_rate=" substr(line, RSTART + 9, RLENGTH - 9)
      if (match(line, /Tx-Power[:=]-?[0-9]+ dBm/)) print "wifi_tx_power=" substr(line, RSTART + 9, RLENGTH - 13)
      if (match(line, /Link Quality[:=][0-9]+\/[0-9]+/)) print "wifi_quality=" substr(line, RSTART + 13, RLENGTH - 13)
      if (match(line, /Signal level[:=]-?[0-9]+ dBm/)) print "wifi_signal=" substr(line, RSTART + 13, RLENGTH - 17)
      if (match(line, /Noise level[:=]-?[0-9]+ dBm/)) print "wifi_noise=" substr(line, RSTART + 12, RLENGTH - 16)
    }'
  echo "wifi_suspended=$(wifi_suspended && echo 1 || echo 0)"
  iface_line "$WIFI_IF" wifi
  _oif=$(find_usb_iface)
  [ -n "$_oif" ] && iface_line "$_oif" wired
  route -n 2>/dev/null | awk 'NR > 2 { print "route=" $1 "|" $2 "|" $3 "|" $4 "|" $5 "|" $8 }'
  sed -n 's/^nameserver[ \t]*\([0-9.]*\).*/dns=\1/p' "$RESOLV" 2>/dev/null
  echo "lan_dev=$(cat "$LAN_DEV_FILE" 2>/dev/null || echo "$WIFI_IF")"
  echo "gateway=$(hub_gateway)"
  echo "cloud_blocker=$(blocker_on && echo 1 || echo 0)"
  echo "wired_mode=$(static_mode && echo static || echo dhcp)"
}

case "$1" in
  start) start_usb_eth "$2" ;;
  stop) stop_usb_eth ;;
  stop-if-disabled) stop_usb_eth if-disabled ;;
  restart) restart_usb_eth ;;
  status) status_usb_eth ;;
  recover) recover_usb_eth ;;
  overview) overview_usb_eth ;;
  worker) echo $$ > "$WORKER_PIDFILE"; worker_main ;;  # tests drive the worker in the foreground
  *)
    echo "usage: $0 {start [--force]|stop|stop-if-disabled|restart|recover|status|overview}" >&2
    exit 2
    ;;
esac
