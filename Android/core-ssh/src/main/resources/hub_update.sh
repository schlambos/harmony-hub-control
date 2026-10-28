#!/bin/sh
# Melodious hub update, run ON THE HUB by the Android or macOS app over SSH.
# The app has already downloaded the hub release from GitHub, checked it
# against the release's SHA256SUMS.txt, and copied the changed files into a
# private RAM staging folder with a plan. This script is the installer's
# transaction (install_webui.py), done on the hub so it finishes even if the
# phone drops off Wi-Fi:
#   verify every staged file -> check RAM -> rollback copies in RAM ->
#   bounded handoff backup on flash -> <dest>.codex-new copies (nothing live
#   changes if flash fills) -> rename into place, codex_webui last -> wiring ->
#   restart services and health-check :8080 (roll back on failure), or reboot
#   when boot scripts or plugins changed.
#
#   sh hub_update.sh status <dest>...  one "file <md5|absent> <dest>" line each,
#                                      then "memfree_kb N" and "hub_id yes|no"
#   sh hub_update.sh apply <stage>     <stage>/plan lines:
#                                      "<md5> <mode> <reboot 0|1> <name> <dest>",
#                                      files in <stage>/files/<name>; progress and
#                                      the final "RESULT ..." line go to <stage>/log
#
# BusyBox 1.13 on the hub: only cat cp mv rm chmod mkdir ln ls md5sum grep sed
# awk cut date dirname sleep ps killall reboot (no stat, mktemp, df, head, tail,
# wc, sort or printf).

set -u
HANDOFF_ROOT=/data/codex-backups
HANDOFF_BUDGET=262144
HANDOFF_KEEP=3
# :8080 in /proc/net/tcp; tests may point the health check elsewhere.
HEALTH_PORT_HEX=${HEALTH_PORT_HEX:-1F90}
HEALTH_WAIT=${HEALTH_WAIT:-60}
HANDOFF_PATHS="/etc/init.d/rcS.local /opt/luaworks/tasks/connectserver/netservicestarter.lua /usr/sbin/dropbear /usr/sbin/dropbearkey /data/codex/hub_id /data/codex/cloud_blocker.conf /data/codex/offline_egress_guard.sh /data/codexmqtt/config.json /pkg/codexactivity/codexactivity.lua /pkg/codexactivity/manifest.json"

md5_of() { md5sum "$1" 2>/dev/null | cut -d' ' -f1; }
size_of() { ls -l "$1" 2>/dev/null | awk '{print $5}'; }

status() {
  for d in "$@"; do
    if [ -f "$d" ]; then echo "file $(md5_of "$d") $d"; else echo "file absent $d"; fi
  done
  echo "memfree_kb $(awk '/^MemFree:|^Cached:/ {s += $2} END {print s + 0}' /proc/meminfo)"
  if [ -f /data/codex/hub_id ]; then echo "hub_id yes"; else echo "hub_id no"; fi
}

apply() {
  S=$1
  LOG=$S/log
  PLAN=$S/plan
  say() { echo "$*" >> "$LOG"; }
  result() { say "RESULT $*"; }

  rollback() {
    say "STEP rolling back"
    ok=1
    # newest first
    for dest in $(sed -n '1!G;h;$p' "$S/done" 2>/dev/null); do
      name=$(grep " $dest\$" "$PLAN" | awk '{print $4}')
      if [ -f "$S/rb/$name" ]; then
        cp -p "$S/rb/$name" "$dest.codex-rb" && mv -f "$dest.codex-rb" "$dest" || ok=0
        [ "$(md5_of "$dest")" = "$(cat "$S/rb/$name.md5")" ] || ok=0
      elif [ -f "$S/rb/$name.absent" ]; then
        rm -f "$dest" || ok=0
      fi
    done
    [ "$ok" = 1 ]
  }

  remove_new_copies() {
    while read md5 mode reboot name dest; do rm -f "$dest.codex-new"; done < "$PLAN"
  }

  start_services() {
    HUB_ID=$(cat /data/codex/hub_id 2>/dev/null)
    killall codex_webui 2>/dev/null
    killall codex_bthid_keyboard 2>/dev/null
    if ! ps | grep '[o]ffline_egress_guard.sh monitor' >/dev/null 2>&1; then
      /data/codex/offline_egress_guard.sh monitor >> /cache/codex-init.log 2>&1 &
    fi
    if ! ps | grep '[d]ropbear' >/dev/null 2>&1; then /usr/sbin/dropbear -R -p 22; fi
    mkdir -p /cache/bin
    ln -sf /data/codex/bin/codex_bthid_keyboard /cache/bin/bthid_keyboard
    /data/codex/bin/codex_webui 8080 >> /cache/codex-init.log 2>&1 &
    /data/codex/bin/codex_bthid_keyboard >> /cache/codex-init.log 2>&1 &
    sleep 1
    if [ -n "$HUB_ID" ]; then
      /data/codex/bin/codex_hbus "$HUB_ID" "harmony.automation?discover" '{"gatewayType":"codexactivity"}' >> /cache/codex-init.log 2>&1
      /data/codex/bin/codex_hbus "$HUB_ID" "harmony.automation?discover" '{"gatewayType":"codexmqtt"}' >> /cache/codex-init.log 2>&1
    fi
  }

  healthy() {
    i=0
    while [ "$i" -lt "$HEALTH_WAIT" ]; do
      if grep ":$HEALTH_PORT_HEX 00000000:0000 0A" /proc/net/tcp >/dev/null 2>&1; then return 0; fi
      sleep 1
      i=$((i + 1))
    done
    return 1
  }

  say "STEP checking"
  if [ ! -f /data/codex/hub_id ]; then
    result refused "This hub has no Melodious setup yet (/data/codex/hub_id). Install it once with the installer."
    return 1
  fi
  while read md5 mode reboot name dest; do
    if [ "$(md5_of "$S/files/$name")" != "$md5" ]; then
      result nothing-changed "The copy of $dest sent to the hub is damaged. Nothing changed."
      return 1
    fi
  done < "$PLAN"

  # Rollback copies live in RAM next to the staged files: keep 4 MiB spare.
  need=0
  while read md5 mode reboot name dest; do
    [ -f "$dest" ] && need=$((need + $(size_of "$dest")))
  done < "$PLAN"
  free=$(awk '/^MemFree:|^Cached:/ {s += $2} END {print s + 0}' /proc/meminfo)
  if [ $((need / 1024 + 4096)) -gt "$free" ]; then
    result nothing-changed "The hub doesn't have enough free memory for a safe update (${free} kB free). Nothing changed."
    return 1
  fi

  say "STEP backing up"
  mkdir -p "$S/rb"
  while read md5 mode reboot name dest; do
    if [ -f "$dest" ]; then
      cp -p "$dest" "$S/rb/$name" && md5_of "$dest" > "$S/rb/$name.md5"
      if [ "$(md5_of "$S/rb/$name")" != "$(cat "$S/rb/$name.md5")" ]; then
        result nothing-changed "Couldn't make a safe copy of $dest. Nothing changed."
        return 1
      fi
    else
      : > "$S/rb/$name.absent"
    fi
  done < "$PLAN"

  # Bounded handoff backup on flash, the installer's format, newest 3 kept.
  stamp=$(date -u +%Y%m%d-%H%M%S)
  inc=$HANDOFF_ROOT/.incomplete-webui-handoff-$stamp
  if mkdir -p "$HANDOFF_ROOT" && mkdir "$inc"; then
    tot=0
    for p in $HANDOFF_PATHS; do
      [ -f "$p" ] || continue
      sz=$(size_of "$p")
      if [ $((tot + sz)) -le "$HANDOFF_BUDGET" ]; then
        cp -p "$p" "$inc/$(echo "$p" | sed 's#/#_#g')" && tot=$((tot + sz))
      fi
    done
    if mv "$inc" "$HANDOFF_ROOT/webui-handoff-$stamp"; then
      say "STEP handoff $HANDOFF_ROOT/webui-handoff-$stamp"
      # The hub's ls doesn't sort and it has no sort: order the stamps in awk
      # (oldest first) and list all but the newest HANDOFF_KEEP.
      old=$(ls -d "$HANDOFF_ROOT"/webui-handoff-* 2>/dev/null | grep '/webui-handoff-[0-9]\{8\}-[0-9]\{6\}$' |
        awk -v keep="$HANDOFF_KEEP" '{ a[NR] = $0 } END {
          for (i = 2; i <= NR; i++) { v = a[i]; j = i - 1; while (j > 0 && a[j] > v) { a[j + 1] = a[j]; j-- } a[j + 1] = v }
          for (i = 1; i <= NR - keep; i++) print a[i] }')
      for d in $old; do rm -rf "$d"; done
    else
      rm -rf "$inc"
    fi
  fi

  say "STEP writing"
  while read md5 mode reboot name dest; do
    mkdir -p "$(dirname "$dest")"
    if ! cp "$S/files/$name" "$dest.codex-new" || ! chmod "$mode" "$dest.codex-new" ||
       [ "$(md5_of "$dest.codex-new")" != "$md5" ]; then
      remove_new_copies
      result nothing-changed "Couldn't write $dest (is the hub's storage full?). Nothing changed."
      return 1
    fi
  done < "$PLAN"

  say "STEP installing"
  : > "$S/done"
  while read md5 mode reboot name dest; do
    if ! mv -f "$dest.codex-new" "$dest"; then
      remove_new_copies
      if rollback; then result rolled-back "Couldn't put $dest in place, so the hub went back to its previous software."
      else result rollback-failed "Couldn't put $dest in place and couldn't restore everything. Staging kept at $S for the installer."
      fi
      return 1
    fi
    echo "$dest" >> "$S/done"
  done < "$PLAN"

  mkdir -p /data/codex/bin /etc/dropbear /home/root/.ssh /data/codexmqtt /pkg/codexactivity /pkg/codexmqtt
  ln -sf dropbearmulti /data/codex/bin/dropbear
  ln -sf dropbearmulti /data/codex/bin/dropbearkey
  chmod 600 /data/codexmqtt/config.json 2>/dev/null
  /bin/busybox sync 2>/dev/null

  if [ -n "$(awk '$3 == 1' "$PLAN")" ]; then
    result ok reboot
    (sleep 3; /sbin/reboot || reboot) >/dev/null 2>&1 &
    return 0
  fi

  say "STEP restarting"
  start_services
  if healthy; then
    rm -rf "$S/files" "$S/rb"
    result ok restarted
    return 0
  fi
  if rollback; then
    start_services
    result rolled-back "The new hub software didn't start, so the hub went back to its previous software."
  else
    result rollback-failed "The new hub software didn't start and the old one couldn't be restored. Staging kept at $S for the installer."
  fi
  return 1
}

case "${1:-}" in
  status) shift; status "$@" ;;
  apply) apply "$2" ;;
  *) echo "usage: $0 status <dest>... | apply <stage>" >&2; exit 2 ;;
esac
