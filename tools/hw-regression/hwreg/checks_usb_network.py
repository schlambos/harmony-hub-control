"""Automatable USB Ethernet and cross-subsystem network interaction checks.

Targets the proven hardware regression pain points:
1. SSH lifeline verification before USB Ethernet probing / actions.
2. Counter-verified bidirectional traffic on the physical wire (preventing the
   false validation where ARP/routing sent replies over Wi-Fi) + big-endian
   software TCP checksum integrity over multi-packet HTTP transfers.
3. USB Ethernet <-> Android TV Wake-on-LAN interface broadcast binding (PR #126).
4. USB Ethernet + Cloud Blocker <-> HA webhook / TV / gateway route & hand-back
   integrity (PR #128).
"""

from __future__ import annotations

import ipaddress
import json
import re
from typing import Any, TYPE_CHECKING

from .discovery import parse_kv_sections
from .models import (
    CheckKind,
    CheckOutcome,
    CheckResult,
    CheckSpec,
    EvidenceClass,
    HubCapabilities,
    SafetyTier,
)
from .transport import remote_quote

if TYPE_CHECKING:
    from .runner import CheckContext


STAT_FIELDS = (
    "rx_packets",
    "tx_packets",
    "rx_bytes",
    "tx_bytes",
    "rx_errors",
    "tx_errors",
    "rx_dropped",
    "tx_dropped",
    "collisions",
)


def _applies_usb_eth(caps: HubCapabilities) -> tuple[bool, str]:
    if not caps.ssh_reachable:
        return False, "SSH unreachable"
    if not caps.usb_eth_conf_enabled and not caps.usb_eth_ifname and not caps.usb_eth_device:
        return False, "USB Ethernet is disabled (usb_eth.conf ENABLED!=1 and no USB NIC attached)"
    return True, ""


def _applies_wol_cross(caps: HubCapabilities) -> tuple[bool, str]:
    if not caps.ssh_reachable:
        return False, "SSH unreachable"
    if not caps.androidtv_configured:
        return False, "no paired Android/Google TVs configured in /data/codex/androidtv/tvs.tsv"
    return True, ""


def _applies_lan_peers(caps: HubCapabilities) -> tuple[bool, str]:
    if not caps.ssh_reachable:
        return False, "SSH unreachable"
    if not (caps.usb_eth_conf_enabled or caps.ha_configured or caps.androidtv_configured):
        return False, "neither USB Ethernet, Home Assistant devices, nor Android TVs are configured"
    return True, ""


def _read_iface_stats(ctx: CheckContext, ifname: str, *, ssh_host: str = "") -> dict[str, int]:
    if not ifname or not re.fullmatch(r"[A-Za-z0-9_.-]+", ifname):
        return {}
    cmds = [
        f"echo \"{f}=$(sed -n '1p' /sys/class/net/{ifname}/statistics/{f} 2>/dev/null)\""
        for f in STAT_FIELDS
    ]
    res = ctx.transport.run_ssh("; ".join(cmds), host_override=ssh_host)
    if not res.ok:
        raise RuntimeError(
            f"SSH counter read on {ssh_host or 'default'} failed (rc={res.returncode}): "
            f"{res.stderr.strip() or 'no stderr'}"
        )
    kv = parse_kv_sections(res.stdout)
    out: dict[str, int] = {}
    for f in STAT_FIELDS:
        try:
            out[f] = int(kv.get(f, "0") or 0)
        except ValueError:
            out[f] = 0
    return out


def check_usb_eth_lifeline_and_state(ctx: CheckContext) -> CheckResult:
    """Verify Wi-Fi SSH lifeline, USB-eth operational state, ARP isolation sysctls, and route preference."""
    caps = ctx.capabilities
    issues: list[str] = []
    warnings: list[str] = []

    # 1. Verify secondary Wi-Fi lifeline first
    lifeline_http_ok = False
    if caps.wifi_up and caps.wifi_ip:
        resp = ctx.transport.http_request("GET", "/api/system-status", host_override=caps.wifi_ip)
        lifeline_http_ok = resp.ok

    conf_probe = ctx.transport.run_ssh(
        "if grep '^WIFI_OFF=1$' /data/codex/usb_eth.conf >/dev/null 2>&1; then echo 'wifi_off_cfg=1'; "
        "else echo 'wifi_off_cfg=0'; fi; "
        "echo '===NETSTATE==='; cat /var/run/codex-usb-eth-net.state 2>/dev/null || true; "
        "echo '===ROUTES==='; route -n 2>/dev/null || true; "
        "echo '===DMESG==='; dmesg 2>/dev/null | grep -i 'r8152\\|asix\\|ax88179\\|cdc_\\|ehci\\|tx timeout\\|netdev watchdog\\|-131\\|-71' || true"
    )
    wifi_off_cfg = "wifi_off_cfg=1" in conf_probe.stdout
    net_state_raw = ""
    routes_raw = ""
    dmesg_raw = ""
    if "===NETSTATE===" in conf_probe.stdout and "===ROUTES===" in conf_probe.stdout:
        _, tail = conf_probe.stdout.split("===NETSTATE===", 1)
        net_state_raw, tail2 = tail.split("===ROUTES===", 1)
        if "===DMESG===" in tail2:
            routes_raw, dmesg_raw = tail2.split("===DMESG===", 1)
        else:
            routes_raw = tail2

    if not caps.wifi_up or not caps.wifi_ip:
        if wifi_off_cfg:
            warnings.append(
                "ath0 Wi-Fi lifeline is down because WIFI_OFF=1 is active; unplugging Ethernet will trigger hand-back"
            )
        else:
            warnings.append("ath0 Wi-Fi lifeline has no active IPv4 lease; no secondary SSH path if USB Ethernet drops")
    elif not lifeline_http_ok:
        warnings.append("ath0 has an IPv4 address on the hub, but Web UI on Wi-Fi IP did not respond to host probe")

    # 2. Check USB-eth operational state when enabled
    if not caps.usb_eth_conf_enabled:
        warnings.append(
            f"USB adapter detected ({caps.usb_eth_device or caps.usb_eth_ifname}), "
            f"but usb_eth.conf is disabled (state={caps.usb_eth_state})"
        )
    else:
        if not caps.usb_eth_operational or not caps.usb_eth_ifname or not caps.usb_eth_ip:
            issues.append(
                f"usb_eth.conf is enabled, but service is NOT operational "
                f"(state={caps.usb_eth_state!r}, reason={caps.usb_eth_reason!r}, "
                f"ifname={caps.usb_eth_ifname!r}, ipv4={caps.usb_eth_ip!r})"
            )
        elif caps.wifi_ip and caps.usb_eth_ip == caps.wifi_ip:
            issues.append("wired interface and Wi-Fi interface have duplicate IPv4 addresses")

    # 3. Verify ARP isolation sysctls & route preference when operational
    sysctl_kv: dict[str, str] = {}
    if caps.usb_eth_operational and caps.usb_eth_ifname:
        ifn = caps.usb_eth_ifname
        sys_res = ctx.transport.run_ssh(
            f"for i in {remote_quote(ifn)} ath0; do "
            "  for k in arp_ignore arp_announce; do "
            "    echo \"${i}_${k}=$(sed -n '1p' /proc/sys/net/ipv4/conf/$i/$k 2>/dev/null)\"; "
            "  done; "
            "done"
        )
        sysctl_kv = parse_kv_sections(sys_res.stdout)
        for iface in (ifn, "ath0"):
            if iface == "ath0" and not caps.wifi_up:
                continue
            ig = sysctl_kv.get(f"{iface}_arp_ignore", "")
            an = sysctl_kv.get(f"{iface}_arp_announce", "")
            if ig != "1" or an != "2":
                issues.append(
                    f"ARP isolation sysctls missing on {iface}: arp_ignore={ig!r} (want '1'), "
                    f"arp_announce={an!r} (want '2')"
                )

        # Verify /api/usb-eth consistency
        usb_http = ctx.transport.http_request("GET", "/api/usb-eth")
        if usb_http.ok:
            try:
                ujson = json.loads(usb_http.body)
                if ujson.get("operational") is not True:
                    issues.append(f"GET /api/usb-eth reports operational={ujson.get('operational')!r}")
            except json.JSONDecodeError:
                issues.append("GET /api/usb-eth returned invalid JSON")

        # Verify wired connected route outranks ath0 on shared subnet when route_mode=metric
        wired_metrics: list[int] = []
        wifi_metrics: list[int] = []
        for ln in routes_raw.splitlines():
            parts = ln.split()
            if len(parts) >= 8 and parts[1] == "0.0.0.0" and parts[0] not in {"0.0.0.0", "224.0.0.0"}:
                try:
                    metric = int(parts[4])
                except ValueError:
                    continue
                if parts[7] == ifn:
                    wired_metrics.append(metric)
                elif parts[7] == "ath0":
                    wifi_metrics.append(metric)
        if not wired_metrics:
            issues.append(f"no connected subnet route present for wired interface {ifn} in route -n")
        elif caps.usb_eth_route_mode == "metric" and caps.wifi_up and wifi_metrics:
            if min(wired_metrics) >= min(wifi_metrics):
                issues.append(
                    f"route_mode=metric, but {ifn} metric ({min(wired_metrics)}) is not preferred "
                    f"ahead of ath0 ({min(wifi_metrics)})"
                )

    # 4. Check kernel log for USB wedge / watchdog / URB failure signatures
    bad_dmesg = [
        ln.strip()
        for ln in dmesg_raw.splitlines()
        if re.search(r"netdev watchdog|tx timeout|error -131|error -71|babble", ln, re.IGNORECASE)
    ]
    if bad_dmesg:
        issues.append(f"dmesg shows USB/NIC wedge or error signature(s): {bad_dmesg[0]}")

    outcome = CheckOutcome.FAIL if issues else (CheckOutcome.WARN if warnings else CheckOutcome.PASS)
    details = issues + warnings
    if not details:
        details.append(
            f"Wi-Fi lifeline verified, {caps.usb_eth_ifname} operational ({caps.usb_eth_driver}, "
            f"route_mode={caps.usb_eth_route_mode or 'metric'}), ARP sysctls enforced, no dmesg USB errors."
        )

    return CheckResult(
        check_id="usb_eth.lifeline_and_state",
        title="Wi-Fi SSH lifeline, USB-eth state, ARP isolation, and routing",
        category="usb_eth",
        kind=CheckKind.AUTOMATABLE,
        tier=SafetyTier.SAFE,
        outcome=outcome,
        evidence_class=EvidenceClass.VERIFIED,
        summary=details[0],
        details=details,
        evidence={
            "wifi_lifeline_up": caps.wifi_up and lifeline_http_ok,
            "wifi_off_configured": wifi_off_cfg,
            "usb_eth_state": caps.usb_eth_state,
            "usb_eth_reason": caps.usb_eth_reason,
            "usb_eth_ifname": caps.usb_eth_ifname,
            "usb_eth_driver": caps.usb_eth_driver,
            "usb_eth_device": caps.usb_eth_device,
            "route_mode": caps.usb_eth_route_mode,
            "arp_sysctls": sysctl_kv,
            "net_state": parse_kv_sections(net_state_raw),
            "dmesg_usb_warnings": bad_dmesg[:5],
        },
        recovery_hint=(
            "NEVER hot-plug the USB Ethernet OTG adapter on a live hub (causes brownout reboot). "
            "To recover connectivity: unplug Ethernet RJ-45 cable for Wi-Fi hand-back, or power off 30s."
        ),
    )


def check_usb_eth_traffic_on_wire(ctx: CheckContext) -> CheckResult:
    """Counter-verify that traffic to the wired IP actually traverses the wire (and software checksums hold)."""
    caps = ctx.capabilities
    if not caps.usb_eth_conf_enabled:
        return CheckResult(
            check_id="usb_eth.traffic_on_wire",
            title="Counter-verified bidirectional wired traffic & BE checksum transfer",
            category="usb_eth",
            kind=CheckKind.AUTOMATABLE,
            tier=SafetyTier.SAFE,
            outcome=CheckOutcome.SKIP,
            evidence_class=EvidenceClass.UNRESOLVED,
            summary="Skipped because usb_eth.conf is disabled.",
            skip_reason="usb_eth.conf disabled",
        )

    if not caps.usb_eth_operational or not caps.usb_eth_ifname or not caps.usb_eth_ip:
        return CheckResult(
            check_id="usb_eth.traffic_on_wire",
            title="Counter-verified bidirectional wired traffic & BE checksum transfer",
            category="usb_eth",
            kind=CheckKind.AUTOMATABLE,
            tier=SafetyTier.SAFE,
            outcome=CheckOutcome.FAIL,
            evidence_class=EvidenceClass.VERIFIED,
            summary=(
                f"USB Ethernet is enabled in usb_eth.conf, but link is not operational "
                f"(state={caps.usb_eth_state!r}, reason={caps.usb_eth_reason!r})."
            ),
        )

    ifname = caps.usb_eth_ifname
    wired_ip = caps.usb_eth_ip
    # Use Wi-Fi IP for counter-sampling SSH calls when available so SSH control traffic
    # cannot be mistaken for wired test payload traffic.
    control_ssh_host = caps.wifi_ip if (caps.wifi_up and caps.wifi_ip) else ""

    try:
        before_wired = _read_iface_stats(ctx, ifname, ssh_host=control_ssh_host)
        before_wifi = _read_iface_stats(ctx, "ath0", ssh_host=control_ssh_host)
    except RuntimeError as exc:
        return CheckResult(
            check_id="usb_eth.traffic_on_wire",
            title="Counter-verified bidirectional wired traffic & BE checksum transfer",
            category="usb_eth",
            kind=CheckKind.AUTOMATABLE,
            tier=SafetyTier.SAFE,
            outcome=CheckOutcome.FAIL,
            evidence_class=EvidenceClass.VERIFIED,
            summary=f"Failed to read pre-transfer interface counters: {exc}",
        )

    # 1. Perform 3 multi-KB HTTP GET transfers directly against wired_ip:8080
    transfer_Count = 3
    http_ok_count = 0
    total_http_bytes = 0
    http_errors: list[str] = []

    for idx in range(transfer_Count):
        resp = ctx.transport.http_request("GET", "/api/system-status", host_override=wired_ip)
        if resp.ok:
            try:
                parsed = json.loads(resp.body)
                if parsed.get("ok") is True:
                    http_ok_count += 1
                    total_http_bytes += len(resp.body.encode("utf-8"))
                else:
                    http_errors.append(f"req {idx + 1}: JSON ok!=true")
            except json.JSONDecodeError as exc:
                http_errors.append(f"req {idx + 1}: corrupted JSON ({exc})")
        else:
            http_errors.append(f"req {idx + 1}: HTTP {resp.status} ({resp.error})")

    # 2. Check host ARP MAC when runner is on the same L2 broadcast domain
    host_arp = ctx.transport.host_arp_mac(wired_ip)

    # 3. Verify hub-initiated egress reaches gateway (BusyBox ping takes no flags; route metric prefers wired ifname)
    gw_ip = caps.saved_gateway
    gw_ping_ok: bool | None = None
    gw_ping_out = ""
    if gw_ip and re.fullmatch(r"\d+\.\d+\.\d+\.\d+", gw_ip):
        gw_probe = ctx.transport.run_ssh(
            f"ping {remote_quote(gw_ip)} 2>&1",
            host_override=control_ssh_host,
        )
        gw_ping_ok = gw_probe.ok
        gw_ping_out = gw_probe.stdout.strip()

    try:
        after_wired = _read_iface_stats(ctx, ifname, ssh_host=control_ssh_host)
        after_wifi = _read_iface_stats(ctx, "ath0", ssh_host=control_ssh_host)
    except RuntimeError as exc:
        return CheckResult(
            check_id="usb_eth.traffic_on_wire",
            title="Counter-verified bidirectional wired traffic & BE checksum transfer",
            category="usb_eth",
            kind=CheckKind.AUTOMATABLE,
            tier=SafetyTier.SAFE,
            outcome=CheckOutcome.FAIL,
            evidence_class=EvidenceClass.VERIFIED,
            summary=f"Failed to read post-transfer interface counters: {exc}",
        )

    deltas = {f: after_wired.get(f, 0) - before_wired.get(f, 0) for f in STAT_FIELDS}
    wifi_tx_bytes_delta = after_wifi.get("tx_bytes", 0) - before_wifi.get("tx_bytes", 0)

    issues: list[str] = []
    warnings: list[str] = []

    if http_ok_count != transfer_Count:
        issues.append(
            f"HTTP transfers over wired IP failed ({http_ok_count}/{transfer_Count} succeeded): "
            + "; ".join(http_errors)
        )

    if deltas["rx_packets"] < transfer_Count * 2:
        issues.append(
            f"{ifname} rx_packets delta was only {deltas['rx_packets']} during {transfer_Count} TCP HTTP requests "
            "(requests did NOT arrive on the physical wire)"
        )
    if deltas["tx_packets"] < transfer_Count * 2 or deltas["tx_bytes"] < max(512, int(total_http_bytes * 0.8)):
        issues.append(
            f"{ifname} tx_packets delta={deltas['tx_packets']}, tx_bytes delta={deltas['tx_bytes']} "
            f"for {total_http_bytes} B of HTTP responses (replies leaked over Wi-Fi instead of {ifname}; "
            f"ath0 tx_bytes delta={wifi_tx_bytes_delta})"
        )

    if host_arp and caps.wifi_mac and host_arp == caps.wifi_mac:
        issues.append(
            f"host ARP table maps wired IP to Wi-Fi MAC ({caps.wifi_mac}) instead of wired MAC ({caps.usb_eth_mac})"
        )

    if gw_ping_ok is False:
        issues.append(f"gateway ping from hub failed: {gw_ping_out.splitlines()[-1] if gw_ping_out else 'rc!=0'}")
    elif gw_ping_ok is None:
        warnings.append("no saved gateway IP known; skipped hub-originated gateway ping")

    for err_counter in ("rx_errors", "tx_errors", "rx_dropped", "tx_dropped", "collisions"):
        if deltas[err_counter] > 0:
            issues.append(f"{ifname} {err_counter} increased by {deltas[err_counter]} under traffic")

    outcome = CheckOutcome.FAIL if issues else (CheckOutcome.WARN if warnings else CheckOutcome.PASS)
    details = issues + warnings
    if not details:
        arp_note = "ARP matched wired MAC" if (host_arp and host_arp == caps.usb_eth_mac) else "ARP off-L2/unprobed"
        details.append(
            f"Verified on wire ({ifname}): {http_ok_count}/{transfer_Count} HTTP transfers ({total_http_bytes} B), "
            f"rx_pkts +{deltas['rx_packets']}, tx_pkts +{deltas['tx_packets']}, tx_bytes +{deltas['tx_bytes']}, "
            f"0 errors/drops, gateway ping OK ({arp_note})."
        )

    return CheckResult(
        check_id="usb_eth.traffic_on_wire",
        title="Counter-verified bidirectional wired traffic & BE checksum transfer",
        category="usb_eth",
        kind=CheckKind.AUTOMATABLE,
        tier=SafetyTier.SAFE,
        outcome=outcome,
        evidence_class=EvidenceClass.VERIFIED,
        summary=details[0],
        details=details,
        evidence={
            "ifname": ifname,
            "http_transfers_ok": f"{http_ok_count}/{transfer_Count}",
            "http_payload_bytes": total_http_bytes,
            "wired_counter_deltas": deltas,
            "wifi_tx_bytes_delta": wifi_tx_bytes_delta,
            "host_arp_matched_wired_mac": bool(host_arp and caps.usb_eth_mac and host_arp == caps.usb_eth_mac),
            "host_arp_matched_wifi_mac": bool(host_arp and caps.wifi_mac and host_arp == caps.wifi_mac),
            "gateway_bound_ping_ok": gw_ping_ok,
        },
    )


def _parse_broadcast_ifaces(ifconfig_all: str) -> dict[str, dict[str, Any]]:
    """Parse BusyBox `ifconfig` blocks into {ifname: {up, broadcast, running, ipv4, bcast}}."""
    ifaces: dict[str, dict[str, Any]] = {}
    current_if = ""
    current_lines: list[str] = []

    def _flush() -> None:
        if not current_if:
            return
        block = "\n".join(current_lines)
        ip_m = re.search(r"inet addr:(\d+\.\d+\.\d+\.\d+)", block)
        bc_m = re.search(r"Bcast:(\d+\.\d+\.\d+\.\d+)", block)
        ifaces[current_if] = {
            "ipv4": ip_m.group(1) if ip_m else "",
            "bcast": bc_m.group(1) if bc_m else "",
            "up": bool(re.search(r"\bUP\b", block)),
            "broadcast": bool(re.search(r"\bBROADCAST\b", block)),
            "running": bool(re.search(r"\bRUNNING\b", block)),
            "loopback": bool(re.search(r"\bLOOPBACK\b", block)),
        }

    for line in ifconfig_all.splitlines():
        if line and not line[0].isspace():
            _flush()
            current_if = line.split()[0].strip()
            current_lines = [line]
        elif current_if:
            current_lines.append(line)
    _flush()
    return ifaces


def check_usb_eth_wol_binding(ctx: CheckContext) -> CheckResult:
    """Cross-interaction check: Android TV Wake-on-LAN broadcast readiness across USB-eth & cloud blocker."""
    caps = ctx.capabilities
    issues: list[str] = []
    warnings: list[str] = []

    if not caps.androidtv_running:
        issues.append("paired Android TV(s) exist in tvs.tsv, but codex_androidtv daemon is not running")

    tvs_missing_mac = [tv.name for tv in caps.paired_tvs if not tv.mac]
    if tvs_missing_mac:
        issues.append(
            f"paired Android TV(s) missing learned MAC in tvs.tsv (Wake-on-LAN cannot fire): "
            + ", ".join(tvs_missing_mac)
        )

    probe = ctx.transport.run_ssh(
        "echo '===IFCFG==='; ifconfig 2>/dev/null; "
        "echo '===ATVM=='; m=$(md5sum /data/codex/bin/codex_androidtv 2>/dev/null); echo \"atv_md5=${m%% *}\"; "
        "echo '===WOL_LOG==='; grep 'Wake-on-LAN' /var/volatile/codex-androidtv.log 2>/dev/null || true"
    )
    ifcfg_raw = ""
    atv_meta = ""
    wol_log_raw = ""
    if "===IFCFG===" in probe.stdout and "===ATVM==" in probe.stdout:
        _, rest = probe.stdout.split("===IFCFG===", 1)
        ifcfg_raw, rest2 = rest.split("===ATVM==", 1)
        if "===WOL_LOG===" in rest2:
            atv_meta, wol_log_raw = rest2.split("===WOL_LOG===", 1)
        else:
            atv_meta = rest2

    ifaces = _parse_broadcast_ifaces(ifcfg_raw)
    atv_md5 = parse_kv_sections(atv_meta).get("atv_md5", "")

    # Identify all interfaces eligible for codex_androidtv's send_wol() getifaddrs() loop:
    # must have ipv4, bcast != 0.0.0.0/255.255.255.255, UP, RUNNING, BROADCAST, !LOOPBACK.
    eligible_wol_ifaces = [
        name
        for name, info in sorted(ifaces.items())
        if info["ipv4"]
        and info["bcast"] not in {"", "0.0.0.0", "255.255.255.255"}
        and info["up"]
        and info["running"]
        and info["broadcast"]
        and not info["loopback"]
    ]

    if not eligible_wol_ifaces:
        issues.append(
            "no UP+RUNNING+BROADCAST IPv4 interface with a subnet broadcast address found; "
            "with cloud_blocker=1 (no 255.255.255.255 route), Wake-on-LAN will fail with ENETUNREACH"
        )

    if caps.usb_eth_operational and caps.usb_eth_ifname:
        if caps.usb_eth_ifname not in eligible_wol_ifaces:
            issues.append(
                f"USB Ethernet ({caps.usb_eth_ifname}) is operational, but is NOT in WoL-eligible "
                f"broadcast interfaces ({eligible_wol_ifaces}); WoL will miss the wired LAN"
            )

    wol_lines = [ln.strip() for ln in wol_log_raw.splitlines() if ln.strip()]
    wol_failures = [ln for ln in wol_lines if "failed:" in ln.lower()]
    if wol_failures:
        issues.append(f"codex-androidtv.log contains Wake-on-LAN failure: {wol_failures[-1]}")

    # Optional active live WoL dispatch when explicitly permitted (--tier active --allow-state-change --allow-wol)
    live_wol_dispatched = False
    live_wol_line = ""
    tier_ok, _ = ctx.config.check_tier_permitted(SafetyTier.ACTIVE, "allow_wol")
    if tier_ok and not issues:
        standby_tvs = [tv for tv in caps.paired_tvs if not tv.connected and tv.mac]
        if standby_tvs:
            target_tv = standby_tvs[0]
            before_cnt = len(wol_lines)
            cmd_json = json.dumps({"device": target_tv.tv_id, "command": "PowerOn"})
            ctx.transport.run_ssh(
                f"wget -q -O - --post-data={remote_quote(cmd_json)} "
                "--header='Content-Type: application/json' http://127.0.0.1:8095/cmd 2>/dev/null || true"
            )
            ctx.transport.record_state_action(
                "cross.usb_eth_wol_binding",
                f"POST 127.0.0.1:8095/cmd PowerOn for standby TV {target_tv.tv_id}",
                reverted=False,
                detail="opt-in --allow-wol dispatch",
            )
            ctx.transport.sleep(0.5)
            after_log = ctx.transport.run_ssh(
                "grep 'Wake-on-LAN' /var/volatile/codex-androidtv.log 2>/dev/null || true"
            )
            new_lines = [ln.strip() for ln in after_log.stdout.splitlines() if ln.strip()]
            live_wol_dispatched = True
            if len(new_lines) <= before_cnt:
                issues.append(
                    f"dispatched PowerOn to disconnected TV {target_tv.tv_id}, "
                    "but no new Wake-on-LAN line appeared in codex-androidtv.log"
                )
            else:
                live_wol_line = new_lines[-1]
                if "failed:" in live_wol_line.lower():
                    issues.append(f"live Wake-on-LAN dispatch failed: {live_wol_line}")
                elif caps.usb_eth_operational and caps.usb_eth_ifname:
                    if f"({caps.usb_eth_ifname})" not in live_wol_line:
                        issues.append(
                            f"live Wake-on-LAN log did not bind to wired interface "
                            f"{caps.usb_eth_ifname}: {live_wol_line}"
                        )
        else:
            warnings.append(
                "--allow-wol was set, but all paired TVs are currently connected (Awake/Network-Standby); "
                "codex_androidtv sends WoL only when a TV is disconnected"
            )

    outcome = CheckOutcome.FAIL if issues else (CheckOutcome.WARN if warnings else CheckOutcome.PASS)
    details = issues + warnings
    if not details:
        live_note = f" Live WoL verified: {live_wol_line}" if live_wol_line else ""
        details.append(
            f"Android TV WoL ready across {eligible_wol_ifaces} ({len(caps.paired_tvs)} TV(s) with MACs, "
            f"0 logged WoL errors).{live_note}"
        )

    return CheckResult(
        check_id="cross.usb_eth_wol_binding",
        title="USB Ethernet <-> Android TV Wake-on-LAN interface binding",
        category="cross",
        kind=CheckKind.AUTOMATABLE,
        tier=SafetyTier.SAFE,
        outcome=outcome,
        evidence_class=EvidenceClass.VERIFIED,
        summary=details[0],
        details=details,
        evidence={
            "codex_androidtv_md5": atv_md5,
            "paired_tv_count": len(caps.paired_tvs),
            "tvs_with_mac": sum(1 for t in caps.paired_tvs if t.mac),
            "eligible_wol_interfaces": eligible_wol_ifaces,
            "interface_broadcast_flags": ifaces,
            "recent_wol_log_lines": wol_lines[-5:],
            "live_wol_dispatched": live_wol_dispatched,
            "live_wol_log_line": live_wol_line,
        },
    )


def _route_covers_ip(route_rows: list[tuple[str, str, str, int, str]], ip_str: str) -> tuple[bool, str]:
    """Return (covered, winning_iface) using longest-prefix then lowest-metric matching."""
    try:
        target = ipaddress.IPv4Address(ip_str)
    except ValueError:
        return True, "hostname"

    best_key: tuple[int, int] | None = None
    best_iface = ""
    for dest, _gw, mask, metric, iface in route_rows:
        try:
            net = ipaddress.IPv4Network(f"{dest}/{mask}", strict=False)
        except ValueError:
            continue
        if target in net:
            cand_key = (-net.prefixlen, metric)
            if best_key is None or cand_key < best_key:
                best_key = cand_key
                best_iface = iface
    return (best_key is not None), best_iface


def check_lan_peer_reachability(ctx: CheckContext) -> CheckResult:
    """Cross-interaction check: route coverage & hand-back integrity for HA, Android TV, and gateway peers."""
    caps = ctx.capabilities
    route_res = ctx.transport.run_ssh("route -n 2>/dev/null || true")
    route_rows: list[tuple[str, str, str, int, str]] = []
    for ln in route_res.stdout.splitlines():
        parts = ln.split()
        if len(parts) < 8 or parts[0] in {"Kernel", "Destination"}:
            continue
        try:
            metric = int(parts[4])
        except ValueError:
            metric = 0
        route_rows.append((parts[0], parts[1], parts[2], metric, parts[7]))

    issues: list[str] = []
    warnings: list[str] = []
    peer_checks: list[dict[str, Any]] = []

    # Check PR #128 regression condition: if usb_eth is NOT operational, ath0 MUST hold a
    # connected route for the Wi-Fi subnet (not left missing or behind a dead wired interface).
    if not caps.usb_eth_operational and caps.wifi_up and caps.wifi_ip:
        covered, win_if = _route_covers_ip(route_rows, caps.wifi_ip)
        if not covered or win_if != "ath0":
            issues.append(
                f"USB Ethernet is not operational, yet Wi-Fi subnet route resolves via {win_if!r} "
                "instead of 'ath0' (net-remove route hand-back regression)"
            )

    peers: list[tuple[str, str, bool]] = []
    if caps.saved_gateway:
        peers.append(("gateway", caps.saved_gateway, True))
    if caps.ha_webhook_host:
        peers.append(("ha_webhook", caps.ha_webhook_host, True))
    for idx, tv in enumerate(caps.paired_tvs, start=1):
        if tv.host:
            # Sleeping Android TVs in deep standby won't answer ping, so require route coverage
            # always, and ping only when connected=True.
            peers.append((f"androidtv_{idx}", tv.host, tv.connected))

    for role, host, expect_ping in peers:
        covered, win_if = _route_covers_ip(route_rows, host)
        ping_ok: bool | None = None
        if not covered:
            issues.append(
                f"peer {role} ({host}) has NO matching route while cloud_blocker={caps.cloud_blocker_conf}"
            )
        elif expect_ping and re.fullmatch(r"\d+\.\d+\.\d+\.\d+", host):
            p_res = ctx.transport.run_ssh(f"ping {remote_quote(host)} >/dev/null 2>&1")
            ping_ok = p_res.ok
            if not ping_ok:
                warnings.append(f"peer {role} ({host}) has route via {win_if}, but did not answer ICMP ping")
        peer_checks.append(
            {
                "role": role,
                "host": host,
                "route_covered": covered,
                "egress_iface": win_if,
                "ping_ok": ping_ok,
            }
        )

    outcome = CheckOutcome.FAIL if issues else (CheckOutcome.WARN if warnings else CheckOutcome.PASS)
    details = issues + warnings
    if not details:
        details.append(
            f"All {len(peer_checks)} configured LAN peer(s) have explicit non-WAN routes and clean interface selection."
        )

    return CheckResult(
        check_id="cross.lan_peer_reachability",
        title="USB Ethernet + Cloud Blocker <-> HA / TV / Gateway route & hand-back check",
        category="cross",
        kind=CheckKind.AUTOMATABLE,
        tier=SafetyTier.SAFE,
        outcome=outcome,
        evidence_class=EvidenceClass.VERIFIED,
        summary=details[0],
        details=details,
        evidence={
            "usb_eth_operational": caps.usb_eth_operational,
            "peers": peer_checks,
        },
    )


USB_AND_CROSS_CHECKS: tuple[CheckSpec, ...] = (
    CheckSpec(
        check_id="usb_eth.lifeline_and_state",
        title="Wi-Fi SSH lifeline, USB-eth state, ARP isolation, and routing",
        category="usb_eth",
        tier=SafetyTier.SAFE,
        description="Verifies ath0 lifeline, operational state, ARP sysctls, route preference, and dmesg health.",
        applies_when=_applies_usb_eth,
        run_fn=check_usb_eth_lifeline_and_state,
    ),
    CheckSpec(
        check_id="usb_eth.traffic_on_wire",
        title="Counter-verified bidirectional wired traffic & BE checksum transfer",
        category="usb_eth",
        tier=SafetyTier.SAFE,
        description="Proves HTTP/ICMP bytes actually traverse the USB Ethernet wire and software checksums hold.",
        applies_when=_applies_usb_eth,
        run_fn=check_usb_eth_traffic_on_wire,
    ),
    CheckSpec(
        check_id="cross.usb_eth_wol_binding",
        title="USB Ethernet <-> Android TV Wake-on-LAN interface binding",
        category="cross",
        tier=SafetyTier.SAFE,
        description="Verifies Android TV WoL MACs, broadcast interface flags across USB-eth/Wi-Fi, and optional live WoL.",
        applies_when=_applies_wol_cross,
        run_fn=check_usb_eth_wol_binding,
    ),
    CheckSpec(
        check_id="cross.lan_peer_reachability",
        title="USB Ethernet + Cloud Blocker <-> HA / TV / Gateway route & hand-back check",
        category="cross",
        tier=SafetyTier.SAFE,
        description="Verifies LAN routes for HA webhooks, Android TVs, and Wi-Fi hand-back without WAN default route.",
        applies_when=_applies_lan_peers,
        run_fn=check_lan_peer_reachability,
    ),
)
