"""Live hub capability and inventory discovery.

Reads the hub's actual runtime state, `*.conf` feature gates, paired RF remotes
(`rf.info`), USB Ethernet helper state, Android TV pairings, Bluetooth keyboard
state, time restrictions, and Home Assistant devices so the suite runs ONLY the
checks that apply to this hub and clearly explains every skipped feature.
"""

from __future__ import annotations

import json
import re
from urllib.parse import urlparse

from .masking import SecretMasker
from .models import HubCapabilities, PairedAndroidTv, PairedRemote
from .transport import HubTransport, remote_quote


REMOTE_KINDS: dict[str, tuple[str, str]] = {
    "16414": ("Harmony Smart Control", "no-screen"),
    "16417": ("Harmony screen remote", "screen"),
    "16420": ("Harmony Smart Keyboard", "keyboard"),
    "16422": ("Harmony Companion", "no-screen"),
    "16423": ("Harmony Companion", "no-screen"),
    "34830": ("Harmony USB dongle", "dongle"),
}


def parse_kv_sections(raw: str) -> dict[str, str]:
    """Parse flat key=value lines into a dictionary."""
    out: dict[str, str] = {}
    for line in raw.splitlines():
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def parse_ifconfig_ipv4_and_mac(ifconfig_text: str) -> tuple[str, str, bool]:
    """Extract (ipv4, mac, is_up_running) from BusyBox ifconfig output."""
    ip_match = re.search(r"inet addr:(\d+\.\d+\.\d+\.\d+)", ifconfig_text)
    mac_match = re.search(r"HWaddr\s+([0-9A-Fa-f:]{17})", ifconfig_text)
    up = bool(re.search(r"\bUP\b", ifconfig_text) and re.search(r"\bRUNNING\b", ifconfig_text))
    ip = ip_match.group(1) if ip_match else ""
    mac = mac_match.group(1).lower() if mac_match else ""
    return ip, mac, up


def parse_rf_info_reply(raw_text: str) -> tuple[bool, str, list[PairedRemote]]:
    """Parse hal's rf.info JSON payload into (ok, hub_rfid, paired_remotes)."""
    idx = raw_text.find("{")
    if idx < 0:
        return False, "", []
    try:
        payload = json.loads(raw_text[idx:])
    except json.JSONDecodeError:
        return False, "", []
    if int(payload.get("code", -1)) != 200:
        return False, "", []
    data = payload.get("data")
    if not isinstance(data, dict):
        return False, "", []

    hub_rfid = str(data.get("RFID", "")).strip()
    devices = data.get("Devices")
    if not isinstance(devices, list):
        devices = []

    remotes: list[PairedRemote] = []
    for entry in devices:
        if not isinstance(entry, dict):
            continue
        try:
            slot = int(entry.get("DeviceIndex", 0) or 0)
        except (TypeError, ValueError):
            slot = 0
        equad_id = str(entry.get("EquadID", "")).strip()
        if slot <= 0 or not equad_id or equad_id == "0":
            continue
        skin_id = str(entry.get("SkinId", "")).strip()
        rfid = str(entry.get("RFID", "")).strip()
        base_name, role = REMOTE_KINDS.get(equad_id, (f"Remote EquadID {equad_id}", "other"))
        if equad_id == "16417" and skin_id == "99":
            base_name = "Harmony Touch"
        remotes.append(
            PairedRemote(
                slot=slot,
                equad_id=equad_id,
                rfid=rfid,
                skin_id=skin_id,
                name=base_name,
                role=role,
            )
        )
    remotes.sort(key=lambda r: r.slot)
    return True, hub_rfid, remotes


def parse_tvs_tsv(tsv_text: str) -> list[PairedAndroidTv]:
    """Parse /data/codex/androidtv/tvs.tsv (id<TAB>host<TAB>mac<TAB>btaddr<TAB>name)."""
    tvs: list[PairedAndroidTv] = []
    for line in tsv_text.splitlines():
        raw = line.strip()
        if not raw or raw.startswith("#"):
            continue
        parts = line.rstrip("\r\n").split("\t")
        if len(parts) < 2:
            continue
        tv_id = parts[0].strip()
        host = parts[1].strip() if len(parts) > 1 else ""
        mac = parts[2].strip().lower() if len(parts) > 2 else ""
        bt_addr = parts[3].strip().lower() if len(parts) > 3 else ""
        name = parts[4].strip() if len(parts) > 4 else tv_id
        if tv_id:
            tvs.append(PairedAndroidTv(tv_id=tv_id, name=name, host=host, mac=mac, bt_addr=bt_addr))
    return tvs


DISCOVERY_PROBE_SCRIPT = """
echo "===META==="
echo "fw=$(sed -n '1p' /etc/version 2>/dev/null)"
echo "kernel=$(uname -r 2>/dev/null)"
echo "uptime=$(sed -n '1p' /proc/uptime 2>/dev/null)"
echo "hub_id=$(sed -n '1p' /data/codex/hub_id 2>/dev/null)"
echo "tde=$(sed -n '1p' /sys/class/input/input0/tde 2>/dev/null)"
if [ -f /etc/melodious-off ]; then echo "melodious_off=1"; else echo "melodious_off=0"; fi
if [ -f /data/resources/ActivityList.json ] && [ -f /data/resources/DeviceList.json ] && [ -f /data/resources/MapList.json ]; then
  echo "resources_present=1"
else
  echo "resources_present=0"
fi
echo "cloud_blocker=$(sed -n '1p' /data/codex/cloud_blocker.conf 2>/dev/null)"
echo "two_screen=$(sed -n '1p' /data/codex/two_screen.conf 2>/dev/null)"
echo "multi_remote=$(sed -n '1p' /data/codex/multi_remote.conf 2>/dev/null)"
echo "hal_gates=$(sed -n '1p' /var/run/codex_hal_gates 2>/dev/null)"
echo "hal_tries=$(sed -n '1p' /data/codex/hal_remotes.tries 2>/dev/null)"
if grep ' /usr/bin/hal ' /proc/mounts >/dev/null 2>&1; then echo "hal_bound=1"; else echo "hal_bound=0"; fi
hal_m=$(md5sum /usr/bin/hal 2>/dev/null)
echo "hal_md5=${hal_m%% *}"
echo "saved_gw=$(sed -n '1p' /var/volatile/codex-default-gateway 2>/dev/null)"
echo "bt_target=$(sed -n '1p' /data/codex/bthid_target 2>/dev/null)"
echo "bt_profile=$(sed -n '1p' /data/codex/bthid_profile 2>/dev/null)"
if [ -s /data/codex/bt-devices.json ]; then echo "bt_devices_file=1"; else echo "bt_devices_file=0"; fi
if [ -s /data/codex/activity-restrictions.json ]; then echo "restrictions_file=1"; else echo "restrictions_file=0"; fi
if [ -s /data/codexmqtt/config.json ]; then echo "mqtt_file=1"; else echo "mqtt_file=0"; fi
if ps | grep '[c]odex_androidtv' >/dev/null 2>&1; then echo "androidtv_proc=1"; else echo "androidtv_proc=0"; fi
if ps | grep '[r]f.pairing' >/dev/null 2>&1; then echo "rf_pairing_proc=1"; else echo "rf_pairing_proc=0"; fi
echo "===ATH0==="
ifconfig ath0 2>/dev/null || true
echo "===USBETH==="
if [ -f /data/codex/usb_eth.conf ]; then
  if grep '^ENABLED=1$' /data/codex/usb_eth.conf >/dev/null 2>&1 || [ "$(sed -n '1p' /data/codex/usb_eth.conf 2>/dev/null)" = "1" ]; then
    echo "conf_enabled=1"
  else
    echo "conf_enabled=0"
  fi
else
  echo "conf_enabled=0"
fi
if [ -x /data/codex/usb_eth_service.sh ]; then
  /data/codex/usb_eth_service.sh status 2>/dev/null || true
elif [ -x /data/codex/bin/codex_usbeth ]; then
  /data/codex/bin/codex_usbeth status 2>/dev/null || true
fi
echo "===TVS==="
if [ -f /data/codex/androidtv/tvs.tsv ]; then
  cat /data/codex/androidtv/tvs.tsv 2>/dev/null || true
fi
echo "===END==="
""".strip()


def _extract_block(text: str, start_marker: str, end_marker: str) -> str:
    s_idx = text.find(start_marker)
    if s_idx < 0:
        return ""
    s_idx += len(start_marker)
    e_idx = text.find(end_marker, s_idx)
    if e_idx < 0:
        return text[s_idx:].strip()
    return text[s_idx:e_idx].strip()


def discover_capabilities(transport: HubTransport, masker: SecretMasker) -> HubCapabilities:
    """Inspect the live hub read-only and populate HubCapabilities + SecretMasker."""
    caps = HubCapabilities()
    cfg = transport.config

    # Register local config secrets with masker upfront before any check runs
    if cfg.ssh_key_path:
        masker.register_literal(cfg.ssh_key_path, "<ssh-key>")
    if cfg.webui_password:
        masker.register_literal(cfg.webui_password, "<redacted>")
    if cfg.webui_username:
        masker.register_literal(cfg.webui_username, "<webui-user>")
    if cfg.hub_host:
        masker.register_ip(cfg.hub_host, "<hub-host>")
    if cfg.wired_ip_hint:
        masker.register_ip(cfg.wired_ip_hint, "<hub-wired-ip>")
    for ssid in cfg.wifi_ssid_redact:
        masker.register_literal(ssid, "<ssid>")
    for lit in cfg.extra_redact_literals:
        masker.register_literal(lit, "<redacted>")
    if cfg.ha_webhook_url:
        masker.register_literal(cfg.ha_webhook_url, "<ha-webhook-url>")

    probe = transport.run_ssh(DISCOVERY_PROBE_SCRIPT)
    if not probe.ok:
        caps.ssh_reachable = False
        caps.notes.append(f"SSH discovery failed (rc={probe.returncode}): {probe.stderr.strip()}")
        return caps

    caps.ssh_reachable = True
    meta = parse_kv_sections(_extract_block(probe.stdout, "===META===", "===ATH0==="))
    ath0_text = _extract_block(probe.stdout, "===ATH0===", "===USBETH===")
    usbeth_kv = parse_kv_sections(_extract_block(probe.stdout, "===USBETH===", "===TVS==="))
    tvs_text = _extract_block(probe.stdout, "===TVS===", "===END===")

    caps.firmware_version = meta.get("fw", "")
    caps.kernel_release = meta.get("kernel", "")
    uptime_parts = meta.get("uptime", "").split()
    if uptime_parts:
        try:
            caps.uptime_seconds = float(uptime_parts[0])
        except ValueError:
            caps.uptime_seconds = 0.0

    hub_id = meta.get("hub_id", "")
    caps.hub_id_raw = hub_id
    caps.hub_id_present = bool(hub_id and hub_id.isdigit())
    if hub_id:
        masker.register_literal(hub_id, "<hub-id>")

    caps.tde_flag = meta.get("tde", "0")[:1] or "0"
    caps.melodious_off = meta.get("melodious_off") == "1"
    caps.provisioned = meta.get("resources_present") == "1" and caps.hub_id_present

    caps.cloud_blocker_conf = meta.get("cloud_blocker", "")
    caps.two_screen_conf = meta.get("two_screen", "")
    caps.multi_remote_conf = meta.get("multi_remote", "")
    caps.hal_gates = meta.get("hal_gates", "")
    caps.hal_bind_mounted = meta.get("hal_bound") == "1"
    caps.hal_running_md5 = meta.get("hal_md5", "")
    try:
        caps.hal_remotes_tries = int(meta.get("hal_tries", "0") or 0)
    except ValueError:
        caps.hal_remotes_tries = 0

    caps.saved_gateway = meta.get("saved_gw", "")
    if caps.saved_gateway:
        masker.register_ip(caps.saved_gateway, "<gateway-ip>")

    wifi_ip, wifi_mac, wifi_up = parse_ifconfig_ipv4_and_mac(ath0_text)
    caps.wifi_ip = wifi_ip
    caps.wifi_mac = wifi_mac
    caps.wifi_up = wifi_up
    if wifi_ip:
        masker.register_ip(wifi_ip, "<hub-wifi-ip>")
    if wifi_mac:
        masker.register_mac(wifi_mac, "<mac-wifi>")

    # USB Ethernet capabilities
    caps.usb_eth_conf_enabled = usbeth_kv.get("conf_enabled") == "1" or usbeth_kv.get("enabled") == "1"
    service_state = usbeth_kv.get("service_state", "")
    helper_state = usbeth_kv.get("state", "")
    caps.usb_eth_state = service_state or helper_state
    caps.usb_eth_reason = usbeth_kv.get("service_reason", "")
    caps.usb_eth_ifname = usbeth_kv.get("ifname", "")
    caps.usb_eth_ip = usbeth_kv.get("ipv4", "")
    caps.usb_eth_driver = usbeth_kv.get("usb_driver", "")
    caps.usb_eth_device = usbeth_kv.get("usb_device", "")
    caps.usb_eth_route_mode = usbeth_kv.get("route_mode", "")
    caps.usb_eth_operational = caps.usb_eth_state == "operational" and bool(caps.usb_eth_ip)

    if caps.usb_eth_ip:
        masker.register_ip(caps.usb_eth_ip, "<hub-wired-ip>")
    if caps.usb_eth_ifname and re.fullmatch(r"[A-Za-z0-9_.-]+", caps.usb_eth_ifname):
        mac_res = transport.run_ssh(
            f"sed -n '1p' {remote_quote('/sys/class/net/' + caps.usb_eth_ifname + '/address')} 2>/dev/null || true"
        )
        wired_mac = mac_res.stdout.strip().lower()
        if wired_mac:
            caps.usb_eth_mac = wired_mac
            masker.register_mac(wired_mac, "<mac-wired>")

    # Pick HTTP target if contributor only configured ssh_target
    if wifi_ip:
        transport.set_discovered_http_host(wifi_ip)
    elif caps.usb_eth_ip:
        transport.set_discovered_http_host(caps.usb_eth_ip)

    # Optional feature files
    caps.bt_target_mac = meta.get("bt_target", "").strip().lower()
    caps.bt_profile = meta.get("bt_profile", "").strip()
    if caps.bt_target_mac:
        masker.register_mac(caps.bt_target_mac, "<mac-bt-target>")
    caps.bt_keyboard_configured = bool(caps.bt_target_mac or meta.get("bt_devices_file") == "1")
    caps.time_restrictions_configured = meta.get("restrictions_file") == "1"
    caps.mqtt_configured = meta.get("mqtt_file") == "1"
    caps.androidtv_running = meta.get("androidtv_proc") == "1"

    tvs = parse_tvs_tsv(tvs_text)
    for idx, tv in enumerate(tvs, start=1):
        if tv.host:
            masker.register_ip(tv.host, f"<tv-{idx}-ip>")
        if tv.mac:
            masker.register_mac(tv.mac, f"<mac-tv-{idx}>")
        if tv.bt_addr:
            masker.register_mac(tv.bt_addr, f"<mac-tv-{idx}-bt>")

    # Probe Web UI and enrich Android TV, RF remotes, and Activity/HA inventory
    sys_http = transport.http_request("GET", "/api/system-status")
    caps.webui_reachable = sys_http.ok

    if caps.webui_reachable:
        act_http = transport.http_request("GET", "/api/activity-config")
        if act_http.ok:
            try:
                act_cfg = json.loads(act_http.body)
            except json.JSONDecodeError:
                act_cfg = {}
            activities = (act_cfg.get("activityList") or {}).get("Activities") or []
            if isinstance(activities, list):
                caps.activity_count = len(activities)
                caps.activity_ids = [
                    str(a.get("Id-") or a.get("Id") or "")
                    for a in activities
                    if isinstance(a, dict) and str(a.get("Id-") or a.get("Id") or "")
                ]
            dwf = (act_cfg.get("deviceList") or {}).get("DevicesWithFeatures") or []
            if isinstance(dwf, list):
                caps.device_count = len(dwf)
                ha_count = 0
                for entry in dwf:
                    if not isinstance(entry, dict):
                        continue
                    dev = entry.get("Device") if isinstance(entry.get("Device"), dict) else entry
                    auto_dev = dev.get("AutoDetectedDevice") if isinstance(dev, dict) else None
                    auto_id = str((auto_dev or {}).get("Id", "")) if isinstance(auto_dev, dict) else ""
                    if auto_id.startswith("melodious-ha-"):
                        ha_count += 1
                caps.ha_devices_count = ha_count

        if caps.androidtv_running:
            atv_http = transport.http_request("GET", "/api/androidtv/status")
            if atv_http.ok:
                try:
                    atv_data = json.loads(atv_http.body)
                except json.JSONDecodeError:
                    atv_data = {}
                live_tvs = atv_data.get("tvs")
                if isinstance(live_tvs, list):
                    enriched: list[PairedAndroidTv] = []
                    by_id = {t.tv_id: t for t in tvs}
                    for idx, item in enumerate(live_tvs, start=1):
                        if not isinstance(item, dict):
                            continue
                        tid = str(item.get("id", "")).strip()
                        prev = by_id.get(tid)
                        host = str(item.get("host", "") or (prev.host if prev else "")).strip()
                        mac = str(item.get("mac", "") or (prev.mac if prev else "")).strip().lower()
                        if host:
                            masker.register_ip(host, f"<tv-{idx}-ip>")
                        if mac:
                            masker.register_mac(mac, f"<mac-tv-{idx}>")
                        enriched.append(
                            PairedAndroidTv(
                                tv_id=tid,
                                name=str(item.get("name", "") or (prev.name if prev else tid)),
                                host=host,
                                mac=mac,
                                bt_addr=prev.bt_addr if prev else "",
                                connected=bool(item.get("connected")),
                                power_on=bool(item.get("on")),
                                error=str(item.get("error", "") or ""),
                            )
                        )
                    tvs = enriched
    caps.paired_tvs = tvs

    # Extract HA webhook host if HA devices exist
    if caps.ha_devices_count > 0:
        if cfg.ha_webhook_url:
            caps.ha_webhook_url = cfg.ha_webhook_url
        else:
            proto_res = transport.run_ssh(
                "cat /data/resources/ProtocolList.json 2>/dev/null || true"
            )
            extracted_url = ""
            if proto_res.stdout.strip():
                try:
                    proto_json = json.loads(proto_res.stdout)
                except json.JSONDecodeError:
                    proto_json = {}
                for proto in (proto_json.get("Protocols") or []):
                    if not isinstance(proto, dict):
                        continue
                    ctrl = proto.get("ControlSection")
                    if isinstance(ctrl, dict):
                        cand = str(ctrl.get("Url") or "").strip()
                        if "/api/webhook/" in cand:
                            extracted_url = cand
                            break
                if not extracted_url:
                    unescaped = proto_res.stdout.replace("\\/", "/")
                    m = re.search(r"https?://[^\s\"'\\]+/api/webhook/[^\s\"'\\]+", unescaped)
                    if m:
                        extracted_url = m.group(0)
            if extracted_url:
                caps.ha_webhook_url = extracted_url
        if caps.ha_webhook_url:
            parsed = urlparse(caps.ha_webhook_url)
            if parsed.hostname:
                caps.ha_webhook_host = parsed.hostname
                masker.register_ip(parsed.hostname, "<ha-host>")

    # Query paired RF remotes safely (never race an open rf.pairing window)
    if meta.get("rf_pairing_proc") == "1":
        caps.rf_pairing_open = True
        caps.notes.append("RF pairing window active during discovery; skipped rf.info to avoid slot contention")
    elif caps.webui_reachable:
        rem_http = transport.http_request("GET", "/api/remotes")
        if rem_http.ok:
            try:
                rem_json = json.loads(rem_http.body)
            except json.JSONDecodeError:
                rem_json = {}
            if rem_json.get("pairing") is True:
                caps.rf_pairing_open = True
            else:
                ok, hub_rfid, remotes = parse_rf_info_reply(str(rem_json.get("reply", "")))
                caps.rf_info_ok = ok
                caps.hub_rfid = hub_rfid
                caps.paired_remotes = remotes
    else:
        rf_ssh = transport.run_ssh("/data/codex/bin/codex_hal_ltcp 'rf.info' '{}' 8 2>/dev/null || true")
        ok, hub_rfid, remotes = parse_rf_info_reply(rf_ssh.stdout)
        caps.rf_info_ok = ok
        caps.hub_rfid = hub_rfid
        caps.paired_remotes = remotes

    if caps.hub_rfid:
        masker.register_rfid(caps.hub_rfid, "<hub-rfid>")
    for idx, rem in enumerate(caps.paired_remotes, start=1):
        if rem.rfid:
            masker.register_rfid(rem.rfid, f"<rfid-slot{rem.slot}>")

    return caps
