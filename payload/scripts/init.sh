#!/bin/sh
PATH=/data/codex/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
LOG=/cache/codex-init.log
HUB_ID=$(cat /data/codex/hub_id 2>/dev/null)
case "$HUB_ID" in
  *[!0-9]*|"") HUB_ID="" ;;
esac

echo "$(date) codex init start" >> "$LOG"
if [ -z "$HUB_ID" ]; then
  echo "$(date) missing numeric /data/codex/hub_id; skipping HBus startup actions" >> "$LOG"
fi

if [ -x /data/codex/offline_egress_guard.sh ]; then
  /data/codex/offline_egress_guard.sh monitor >> "$LOG" 2>&1 &
fi

if [ -x /data/codex/bin/dropbear ]; then
  echo '#!/bin/sh' > /usr/sbin/dropbear
  echo 'exec /data/codex/bin/dropbear -K 300 "$@"' >> /usr/sbin/dropbear
  chmod 755 /usr/sbin/dropbear
  if ps | grep '[d]ropbear -s -g' >/dev/null 2>&1; then
    killall dropbear 2>/dev/null || true
    /usr/sbin/dropbear
  elif ! ps | grep '[d]ropbear' >/dev/null 2>&1; then
    /usr/sbin/dropbear
  fi
fi

if [ -x /data/codex/bin/codex_webui ]; then
  if ! ps | grep '[c]odex_webui' >/dev/null 2>&1; then
    /data/codex/bin/codex_webui 8080 >> "$LOG" 2>&1 &
  fi
fi

if [ -x /data/codex/bin/codex_bthid_keyboard ]; then
  mkdir -p /cache/bin
  ln -sf /data/codex/bin/codex_bthid_keyboard /cache/bin/bthid_keyboard
  if ! ps | grep '[c]odex_bthid_keyboard' >/dev/null 2>&1; then
    /data/codex/bin/codex_bthid_keyboard >> "$LOG" 2>&1 &
  fi
fi

if [ -x /data/codex/recovery_ap.sh ]; then
  if [ ! -f /var/run/codex-recovery-monitor.pid ]; then
    /data/codex/recovery_ap.sh monitor >> "$LOG" 2>&1 &
    echo $! > /var/run/codex-recovery-monitor.pid
  fi
fi

(
  sleep 70
  if [ -n "$HUB_ID" ] && [ -x /data/codex/bin/codex_hbus ]; then
    /data/codex/bin/codex_hbus "$HUB_ID" "harmony.automation?discover" '{"gatewayType":"codexactivity"}' >> "$LOG" 2>&1
    /data/codex/bin/codex_hbus "$HUB_ID" "harmony.automation?discover" '{"gatewayType":"codexmqtt"}' >> "$LOG" 2>&1
  fi
) &

echo "$(date) codex init done" >> "$LOG"
