#!/bin/sh

PATH=/usr/sbin:/usr/bin:/sbin:/bin
BLOCKER=/data/codex/cloud_blocker.conf
GATEWAY_STATE=/var/volatile/codex-default-gateway
PID_FILE=/var/run/codex-offline-egress.pid
LOG=/cache/codex-init.log

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
    return
  fi

  if [ -z "$CURRENT_GATEWAY" ] && [ -s "$GATEWAY_STATE" ]; then
    SAVED_GATEWAY=$(sed -n '1p' "$GATEWAY_STATE")
    case "$SAVED_GATEWAY" in
      *[!0-9.]*|"") return ;;
    esac
    if route add default gw "$SAVED_GATEWAY" dev ath0 >/dev/null 2>&1; then
      echo "$(date) codex offline egress guard restored default route via $SAVED_GATEWAY" >> "$LOG"
    fi
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
