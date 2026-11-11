#!/bin/sh

# The GUARD_* variables move paths for tools/usb-eth-test/test_guard.py only.
PATH=${GUARD_PATH:-/usr/sbin:/usr/bin:/sbin:/bin}
BLOCKER=${GUARD_BLOCKER:-/data/codex/cloud_blocker.conf}
GATEWAY_STATE=${GUARD_GATEWAY_STATE:-/var/volatile/codex-default-gateway}
PID_FILE=${GUARD_PID_FILE:-/var/run/codex-offline-egress.pid}
LAN_DEV_FILE=${GUARD_LAN_DEV_FILE:-/var/run/codex-lan-dev}
SYS=${GUARD_SYS:-/sys}
# usb_eth_service.sh's "Wi-Fi off while the cable works": its state file and
# its monitor's pid file (see wifi_watchdog).
USBETH_WIFI_OFF=${GUARD_USBETH_WIFI_OFF:-/var/run/codex-usb-eth-wifi-off}
USBETH_PID=${GUARD_USBETH_PID:-/var/run/codex-usb-eth-worker.pid}
# Tells usb_eth_service.sh this running guard has wifi_watchdog. A guard from
# before it keeps running its old code after an upgrade until the hub
# restarts, and usb_eth_service.sh won't turn Wi-Fi off without the watchdog.
CAPS_FILE=${GUARD_CAPS_FILE:-/var/run/codex-offline-egress.caps}
LOG=${GUARD_LOG:-/cache/codex-init.log}

# While the default route is removed, the private (RFC 1918) ranges stay
# routed through the saved gateway, so hosts on other private subnets (for
# example another VLAN behind the same router) can still reach the hub and get
# replies. The internet stays unreachable.
PRIVATE_ROUTES="10.0.0.0/255.0.0.0 172.16.0.0/255.240.0.0 192.168.0.0/255.255.0.0"

# The interface LAN traffic goes through: Wi-Fi (ath0), or a USB Ethernet
# adapter (usb_eth_service.sh writes LAN_DEV_FILE). The adapter only while it
# has an address and the saved gateway is on its subnet, so a route through
# it can actually be added; otherwise Wi-Fi.
lan_dev() {
  dev=$(sed -n '1p' "$LAN_DEV_FILE" 2>/dev/null)
  case "$dev" in
    eth[0-9]|eth[0-9][0-9]|usb[0-9]|usb[0-9][0-9]) ;;
    *) echo ath0; return ;;
  esac
  # The hub's gateway, as usb_eth_service.sh's hub_gateway() sees it: the one
  # saved while the blocker is on; with it off the default route's (the saved
  # file can be stale from when it was on), else the saved one.
  gw=""
  blocker_enabled || gw=$(default_gateway "$dev")
  [ -n "$gw" ] || gw=$(sed -n '1p' "$GATEWAY_STATE" 2>/dev/null)
  case "$gw" in *[!0-9.]*) gw="" ;; esac
  if [ -d "$SYS/class/net/$dev" ] && route -n 2>/dev/null | awk -v d="$dev" -v g="$gw" '
      function ip(s,   p) { split(s, p, "."); return ((p[1] * 256 + p[2]) * 256 + p[3]) * 256 + p[4] }
      function masked(a, m,   r, bit) {  # a AND m, without bitwise operators
        r = 0
        for (bit = 2147483648; bit >= 1; bit /= 2) {
          if (a >= bit && m >= bit) r += bit
          if (a >= bit) a -= bit
          if (m >= bit) m -= bit
        }
        return r
      }
      $8 == d && $2 == "0.0.0.0" && $1 != "224.0.0.0" {
        if (g == "" || masked(ip(g), ip($3)) == ip($1)) ok = 1
      }
      END { exit !ok }'
  then
    echo "$dev"
  else
    echo ath0
  fi
}

blocker_enabled() {
  [ ! -f /etc/melodious-off ] && [ -f "$BLOCKER" ] && [ "$(sed -n '1p' "$BLOCKER")" = "1" ]
}

# The gateway of a default route through Wi-Fi, or through the interface
# carrying local traffic ($1, usb_eth_service.sh's cable once it passed its
# gateway check). A USB Ethernet adapter on another network gets a default
# route from its own DHCP, and that router must never become the hub's
# gateway. Any default route only while Wi-Fi has no address (a hub on the
# cable alone).
default_gateway() {
  _wifi_ip=$(ifconfig ath0 2>/dev/null | sed -n 's/.*inet addr:\([0-9.]*\).*/\1/p')
  route -n 2>/dev/null |
    awk -v lan="$1" -v alone="$([ -z "$_wifi_ip" ] && echo 1)" '
      $1 == "0.0.0.0" && $4 ~ /G/ {
        if ($8 == "ath0" || ($8 == lan && lan != "")) { print $2; found = 1; exit }
        if (alone == "1" && any == "") any = $2
      }
      END { if (!found && any != "") print any }'
}

any_default_route() {
  route -n 2>/dev/null | awk '$1 == "0.0.0.0" && $4 ~ /G/ { f = 1 } END { exit !f }'
}

# The multicast route on the LAN interface. When that changes, the new one
# is added first and the old one removed only after, so there's always one.
ensure_multicast_route() {
  # One read of the table per tick: the devices that have the route now.
  MCAST_DEVS=$(route -n 2>/dev/null | awk '$1 == "224.0.0.0" && $3 == "240.0.0.0" { printf "%s ", $8 }')
  case " $MCAST_DEVS" in
    *" $LAN "*) ;;
    *) route add -net 224.0.0.0 netmask 240.0.0.0 dev "$LAN" >/dev/null 2>&1 || return ;;
  esac
  for OLD in $MCAST_DEVS; do
    [ "$OLD" = "$LAN" ] || route del -net 224.0.0.0 netmask 240.0.0.0 dev "$OLD" >/dev/null 2>&1
  done
}

# Sets SAVED_GATEWAY to the gateway saved before the default route was
# removed. Fails if there is none.
load_saved_gateway() {
  [ -s "$GATEWAY_STATE" ] || return 1
  SAVED_GATEWAY=$(sed -n '1p' "$GATEWAY_STATE")
  case "$SAVED_GATEWAY" in
    *[!0-9.]*|"") return 1 ;;
  esac
}

# Prints "net mask" for each PRIVATE_ROUTES range that is routed through
# gateway $2 ($1 = via), or that is routed neither through it on the LAN
# interface nor on the hub's own link ($1 = missing).
private_routes() {
  route -n 2>/dev/null | awk -v want="$1" -v g="$2" -v d="$LAN" -v list="$PRIVATE_ROUTES" '
    BEGIN {
      cnt = split(list, ent, " ")
      for (i = 1; i <= cnt; i++) { split(ent[i], p, "/"); n[i] = p[1]; m[i] = p[2] }
    }
    { for (i = 1; i <= cnt; i++)
        if ($1 == n[i] && $3 == m[i]) {
          if ($2 == g && (want == "via" || $8 == d)) via[i] = 1
          if ($2 == "0.0.0.0") onlink[i] = 1
        } }
    END {
      for (i = 1; i <= cnt; i++)
        if ((want == "via" && via[i]) || (want == "missing" && !via[i] && !onlink[i]))
          print n[i], m[i]
    }'
}

# Each missing range is routed through gateway $1 on the LAN interface. Only
# once that worked are routes left behind through an earlier gateway or
# interface removed, so a range is never left without a route.
ensure_private_routes() {
  private_routes missing "$1" | while read NET MASK; do
    if route add -net "$NET" netmask "$MASK" gw "$1" dev "$LAN" >/dev/null 2>&1; then
      echo "$(date) codex offline egress guard routed $NET/$MASK via $1 on $LAN" >> "$LOG"
      route -n 2>/dev/null |
        awk -v n="$NET" -v m="$MASK" -v g="$1" -v d="$LAN" \
          '$1 == n && $3 == m && $2 != "0.0.0.0" && !($2 == g && $8 == d) { print $2, $8 }' |
        while read OLDGW OLDDEV; do
          route del -net "$NET" netmask "$MASK" gw "$OLDGW" dev "$OLDDEV" >/dev/null 2>&1
        done
    fi
  done
}

# Once the default route is back it covers the private ranges. Left in place,
# they would keep pointing at the old gateway if it changes.
clear_private_routes() {
  private_routes via "$1" | while read NET MASK; do
    if route del -net "$NET" netmask "$MASK" gw "$1" >/dev/null 2>&1; then
      echo "$(date) codex offline egress guard removed route to $NET/$MASK via $1" >> "$LOG"
    fi
  done
}

# usb_eth_service.sh can disconnect Wi-Fi while its cable works, and reconnects
# it when the cable stops. If its monitor has gone (crashed, killed), nothing
# would: reconnect Wi-Fi here. This guard is always running (init.sh respawns it).
wifi_watchdog() {
  [ -f "$USBETH_WIFI_OFF" ] || return 0
  pid=$(sed -n '1p' "$USBETH_PID" 2>/dev/null)
  case "$pid" in
    *[!0-9]*|"") ;;
    *) kill -0 "$pid" 2>/dev/null && return 0 ;;
  esac
  # Only once wpa_supplicant took it (exit 0 and no FAIL reply): otherwise
  # the state file stays and the next tick tries again.
  out=$(wpa_cli -i ath0 reconnect 2>/dev/null) || return 0
  case "$out" in *FAIL*) return 0 ;; esac
  rm -f "$USBETH_WIFI_OFF"
  echo "$(date) codex offline egress guard reconnected Wi-Fi (the USB Ethernet monitor had stopped)" >> "$LOG"
}

enforce_once() {
  wifi_watchdog
  LAN=$(lan_dev)
  ensure_multicast_route
  CURRENT_GATEWAY=$(default_gateway "$LAN")
  if blocker_enabled; then
    [ -n "$CURRENT_GATEWAY" ] && echo "$CURRENT_GATEWAY" > "$GATEWAY_STATE"
    # Every default route goes, trusted or not (an adapter's own DHCP adds one).
    if any_default_route && route del default >/dev/null 2>&1; then
      echo "$(date) codex offline egress guard removed a default route${CURRENT_GATEWAY:+ (gateway $CURRENT_GATEWAY)}" >> "$LOG"
    fi
    if load_saved_gateway; then
      ensure_private_routes "$SAVED_GATEWAY"
    fi
    return
  fi

  load_saved_gateway || return
  if [ -z "$CURRENT_GATEWAY" ]; then
    if route add default gw "$SAVED_GATEWAY" dev "$LAN" >/dev/null 2>&1; then
      echo "$(date) codex offline egress guard restored default route via $SAVED_GATEWAY" >> "$LOG"
      CURRENT_GATEWAY=$SAVED_GATEWAY
    fi
  fi
  if [ -n "$CURRENT_GATEWAY" ]; then
    clear_private_routes "$SAVED_GATEWAY"
  fi
}

if [ "$1" != "monitor" ]; then
  enforce_once
  exit 0
fi

if [ -f "$PID_FILE" ]; then
  EXISTING_PID=$(sed -n '1p' "$PID_FILE")
  case "$EXISTING_PID" in
    *[!0-9]*|"") ;;
    *)
      if kill -0 "$EXISTING_PID" 2>/dev/null; then
        exit 0
      fi
      ;;
  esac
fi

echo $$ > "$PID_FILE"
echo wifi-watchdog > "$CAPS_FILE"
# On INT or TERM, clean up and exit (init.sh's loop starts a new guard):
# before, the trap only removed the pid file and the guard kept running
# without it. HUP is ignored: a guard an installer started over SSH has no
# respawn loop until the next boot, and must outlive that session.
trap 'rm -f "$PID_FILE" "$CAPS_FILE"' 0
trap '' 1
trap 'rm -f "$PID_FILE" "$CAPS_FILE"; exit 0' 2 15
while true; do
  # The pid file names this guard: put it back if something removed it
  # (usb_eth_service.sh turns Wi-Fi off only while this guard's pid is there).
  _owner=$(sed -n '1p' "$PID_FILE" 2>/dev/null)
  if [ "$_owner" != "$$" ] && ! { [ -n "$_owner" ] && kill -0 "$_owner" 2>/dev/null; }; then
    echo $$ > "$PID_FILE"
  fi
  enforce_once
  sleep 2
done
