#!/bin/sh
PATH=/data/codex/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
LOG=/cache/codex-recovery.log
SSID_PREFIX=Harmony-Recovery
AP_IF=ath1
AP_IP=192.168.76.1

log() {
  echo "$(date) $*" >> "$LOG"
}

ssid() {
  mac=$(cat /sys/class/net/wifi0/address 2>/dev/null | tr -d ':' | cut -c7-12)
  [ -n "$mac" ] || mac=hub
  echo "${SSID_PREFIX}-${mac}"
}

stop_station() {
  killall netmonitor 2>/dev/null
  killall wpa_supplicant 2>/dev/null
  killall udhcpc 2>/dev/null
  ifconfig ath0 down 2>/dev/null
  wlanconfig ath0 destroy 2>/dev/null
}

start_ap() {
  if [ -f /var/run/codex-recovery-ap.pid ]; then
    old=$(cat /var/run/codex-recovery-ap.pid 2>/dev/null)
    if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
      log "recovery ap already running"
      return 0
    fi
  fi

  log "starting recovery ap"
  stop_station
  wlanconfig "$AP_IF" destroy 2>/dev/null
  wlanconfig "$AP_IF" create wlandev wifi0 wlanmode ap >> "$LOG" 2>&1
  iwpriv "$AP_IF" mode 11ng >> "$LOG" 2>&1
  iwconfig "$AP_IF" essid "$(ssid)" channel 6 >> "$LOG" 2>&1
  ifconfig "$AP_IF" "$AP_IP" netmask 255.255.255.0 up >> "$LOG" 2>&1

  killall codex_dhcpd 2>/dev/null
  killall codex_portal 2>/dev/null
  /data/codex/bin/codex_dhcpd "$AP_IF" "$AP_IP" 192.168.76.100 192.168.76.150 >> "$LOG" 2>&1 &
  /data/codex/bin/codex_portal 80 "$AP_IP" >> "$LOG" 2>&1 &
  echo $! > /var/run/codex-recovery-ap.pid
  echo 3 > /sys/class/input/input0/led 2>/dev/null
}

monitor() {
  count=0
  while [ ! -f /etc/melodious-off ]; do
    val=$(cat /sys/class/input/input0/tde 2>/dev/null)
    case "$val" in
      1*) count=$(expr "$count" + 1) ;;
      *) count=0 ;;
    esac
    if [ "$count" -ge 5 ]; then
      start_ap
      count=0
      sleep 20
    fi
    sleep 1
  done
}

case "$1" in
  monitor) [ -f /etc/melodious-off ] && exit 0; monitor ;;
  boot-tde) [ -f /etc/melodious-off ] && exit 0; start_ap ;;
  start|"") start_ap ;;
  *) echo "usage: $0 [start|boot-tde|monitor]" ;;
esac
