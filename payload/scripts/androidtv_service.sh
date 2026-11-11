#!/bin/sh
# Keep codex_androidtv running: network control for Android and Google TVs
# (docs/ANDROID_TV.md). Started by init.sh at boot and by the installer.
# One copy only; the daemon is restarted 5 s after it exits, so an update
# only has to kill it.
[ -f /etc/melodious-off ] && exit 0
PATH=/data/codex/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
PID_FILE=/var/run/codex-androidtv-service.pid

if [ -f "$PID_FILE" ]; then
  OLD=$(cat "$PID_FILE" 2>/dev/null)
  case "$OLD" in
    *[!0-9]*|"") ;;
    *) if kill -0 "$OLD" 2>/dev/null; then exit 0; fi ;;
  esac
fi
echo $$ > "$PID_FILE"
trap 'rm -f "$PID_FILE"' 0 1 2 15

while [ ! -f /etc/melodious-off ]; do
  if [ -x /data/codex/bin/codex_androidtv ]; then
    # Its log lives in RAM and keeps itself under 64 KB.
    /data/codex/bin/codex_androidtv --dir /data/codex/androidtv --log /var/volatile/codex-androidtv.log
    [ -f /etc/melodious-off ] && break
    sleep 5
  else
    sleep 60
  fi
done
