#!/bin/sh
# hub-emu container entrypoint: lay down the box's filesystem contract, start
# the engine emulator, then hand the process over to the REAL codex_webui.
set -eu

mkdir -p /var/volatile /cache /mnt/data /data

# Step 4A capacity fixture: Docker provisions /mnt/data as the authoritative
# small FIXED-SIZE stand-in for the box's writable /data flash (a tmpfs,
# deliberately NOT JFFS2-equivalent — it only gives deterministic statvfs
# numbers for the real MIPS capacity gate). /data is bind-mounted over it so
# every existing /data path resolves to the same measured filesystem without
# any symlink in the destination component walk. The bind mount requires
# --cap-add SYS_ADMIN (run.sh).
if ! grep -qs ' /data ' /proc/mounts; then
    mount --bind /mnt/data /data
fi

# The box's /data directory layout — recreated AFTER the bind mount so it
# lives inside the measured fixture filesystem.
mkdir -p /data/resources /data/codex/bin /data/codex/resource-backups \
    /data/codexmqtt /data/codex-backups

# Seed resources on first boot only (persisted for the container's lifetime;
# POST /reset on the control plane reseeds without a restart).
if [ ! -f /data/resources/ActivityList.json ]; then
    cp /seed/resources/*.json /data/resources/
fi

# Seed setup-page settings on first boot only, at the exact paths the real
# binary reads. Every secret is obviously fake; the cloud blocker stays 1.
# POST /reset restores these from /seed/settings without a restart.
if [ ! -f /data/codexmqtt/config.json ]; then
    install -m 0600 /seed/settings/mqtt-config.json /data/codexmqtt/config.json
fi
if [ ! -f /etc/wpa_supplicant.conf ]; then
    install -m 0600 /seed/settings/wpa_supplicant.conf /etc/wpa_supplicant.conf
fi
if [ ! -f /data/codex/bt-devices.json ]; then
    install -m 0644 /seed/settings/bt-devices.json /data/codex/bt-devices.json
fi
if [ ! -f /data/codex/cloud_blocker.conf ]; then
    install -m 0644 /seed/settings/cloud_blocker.conf /data/codex/cloud_blocker.conf
fi
if [ ! -f /etc/version ]; then
    install -m 0644 /seed/settings/version /etc/version
fi

# Identity file the binary expects on the box.
printf '15390924\n' > /data/codex/hub_id

# CLI seams: BT tooling stubs on PATH, real codex_hbus (wrapped in qemu) at
# the exact path codex_webui shells out to. /sbin/reboot is a record-only
# stub — the real one would signal PID 1 and kill the container.
install -m 0755 /opt/hub/stubs/hcitool /usr/local/bin/hcitool
install -m 0755 /opt/hub/stubs/hciconfig /usr/local/bin/hciconfig
install -m 0755 /opt/hub/stubs/logread /usr/local/bin/logread
install -m 0755 /opt/hub/stubs/ps /usr/local/bin/ps
install -m 0755 /opt/hub/stubs/reboot /sbin/reboot
# The production update verifier invokes the physical hub's BusyBox by its
# absolute path. Mirror only the md5sum applet needed by QEMU update QA.
cat > /bin/busybox <<'EOF'
#!/bin/sh
if [ "$1" = "md5sum" ]; then
    shift
    exec md5sum "$@"
fi
exit 127
EOF
chmod 0755 /bin/busybox
install -m 0755 /opt/hub/stubs/codex_hal_ltcp /data/codex/bin/codex_hal_ltcp
install -m 0755 /opt/hub/stubs/codex_hbus /data/codex/bin/codex_hbus

python3 /opt/hub/engine-emu.py &

# Wait for the HBus gateway before the webui starts taking requests.
i=0
while [ "$i" -lt 50 ]; do
    if python3 -c 'import socket;s=socket.socket();s.settimeout(0.2);s.connect(("127.0.0.1",8088));s.close()' 2>/dev/null; then
        break
    fi
    i=$((i + 1))
    sleep 0.2
done

echo "hub-emu: starting real codex_webui (MIPS32 BE under qemu-user) on :8080"
exec qemu-mips /opt/hub/bin/codex_webui.mips 8080
