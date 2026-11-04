#!/bin/sh

PATH=/usr/sbin:/usr/bin:/sbin:/bin
BLOCKER=/data/codex/cloud_blocker.conf
GATEWAY_STATE=/var/volatile/codex-default-gateway
PID_FILE=/var/run/codex-offline-egress.pid
LOG=/cache/codex-init.log

# While the default route is removed, the private (RFC 1918) ranges stay
# routed through the saved gateway, so hosts on other private subnets (for
# example another VLAN behind the same router) can still reach the hub and get
# replies. The internet stays unreachable.
PRIVATE_ROUTES="10.0.0.0/255.0.0.0 172.16.0.0/255.240.0.0 192.168.0.0/255.255.0.0"

blocker_enabled() {
  [ -f "$BLOCKER" ] && [ "$(sed -n '1p' "$BLOCKER")" = "1" ]
}

default_gateway() {
  route -n 2>/dev/null |
    awk '$1 == "0.0.0.0" && $4 ~ /G/ { print $2; exit }'
}

ensure_multicast_route() {
  if ! route -n 2>/dev/null |
      awk '$1 == "224.0.0.0" && $3 == "240.0.0.0" { found = 1 } END { exit !found }'
  then
    route add -net 224.0.0.0 netmask 240.0.0.0 dev ath0 >/dev/null 2>&1
  fi
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
# gateway $2 ($1 = via), or that is routed neither through it nor on the hub's
# own link ($1 = missing).
private_routes() {
  route -n 2>/dev/null | awk -v want="$1" -v g="$2" -v list="$PRIVATE_ROUTES" '
    BEGIN {
      cnt = split(list, ent, " ")
      for (i = 1; i <= cnt; i++) { split(ent[i], p, "/"); n[i] = p[1]; m[i] = p[2] }
    }
    { for (i = 1; i <= cnt; i++)
        if ($1 == n[i] && $3 == m[i]) {
          if ($2 == g) via[i] = 1
          if ($2 == "0.0.0.0") onlink[i] = 1
        } }
    END {
      for (i = 1; i <= cnt; i++)
        if ((want == "via" && via[i]) || (want == "missing" && !via[i] && !onlink[i]))
          print n[i], m[i]
    }'
}

ensure_private_routes() {
  private_routes missing "$1" | while read NET MASK; do
    # drop a route left behind through an earlier gateway
    route del -net "$NET" netmask "$MASK" >/dev/null 2>&1
    if route add -net "$NET" netmask "$MASK" gw "$1" dev ath0 >/dev/null 2>&1; then
      echo "$(date) codex offline egress guard routed $NET/$MASK via $1" >> "$LOG"
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

enforce_once() {
  ensure_multicast_route
  CURRENT_GATEWAY=$(default_gateway)
  if blocker_enabled; then
    if [ -n "$CURRENT_GATEWAY" ]; then
      echo "$CURRENT_GATEWAY" > "$GATEWAY_STATE"
      if route del default >/dev/null 2>&1; then
        echo "$(date) codex offline egress guard removed default route via $CURRENT_GATEWAY" >> "$LOG"
      fi
    fi
    if load_saved_gateway; then
      ensure_private_routes "$SAVED_GATEWAY"
    fi
    return
  fi

  load_saved_gateway || return
  if [ -z "$CURRENT_GATEWAY" ]; then
    if route add default gw "$SAVED_GATEWAY" dev ath0 >/dev/null 2>&1; then
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
trap 'rm -f "$PID_FILE"' 0 1 2 15
while true; do
  enforce_once
  sleep 2
done
