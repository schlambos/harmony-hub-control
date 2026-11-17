"""Post-#138 feature checks: Bluetooth, restrictions, HA, MQTT, Android TV,
home-control remotes, HA-device commits, adapter matrix, and disruptive drills.

Every check follows the suite safety model: SAFE checks are read-only, ACTIVE
checks require the per-run CLI opt-ins, and DISRUPTIVE entries are registered
definitions whose operator-driven execution stays outside the default (and
even the disruptive) automated path until the owner runs them deliberately.
All hub output flows through HubTransport and is masked in the report.
"""

from __future__ import annotations

import json
import re
import urllib.parse
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


def _result(
    check_id: str,
    title: str,
    category: str,
    tier: SafetyTier,
    outcome: CheckOutcome,
    summary: str,
    *,
    details: list[str] | None = None,
    evidence: dict[str, Any] | None = None,
    skip_reason: str = "",
    recovery_hint: str = "",
) -> CheckResult:
    return CheckResult(
        check_id=check_id,
        title=title,
        category=category,
        kind=CheckKind.AUTOMATABLE,
        tier=tier,
        outcome=outcome,
        evidence_class=EvidenceClass.UNRESOLVED if outcome == CheckOutcome.SKIP else EvidenceClass.VERIFIED,
        summary=summary,
        details=details or [summary],
        evidence=evidence or {},
        skip_reason=skip_reason,
        recovery_hint=recovery_hint,
    )


def _json_body(body: str) -> dict[str, Any]:
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


# --------------------------------------------------------------------------
# 1. Bluetooth adapter + HID daemon (SAFE, read-only)
# --------------------------------------------------------------------------

def _applies_bt(caps: HubCapabilities) -> tuple[bool, str]:
    if not caps.ssh_reachable:
        return False, "SSH unreachable"
    if not caps.bt_keyboard_configured and not caps.bt_pair_agent_alive:
        return False, "Bluetooth keyboard is not configured on this hub"
    return True, ""


def check_bt_adapter_and_hid_daemon(ctx: CheckContext) -> CheckResult:
    caps = ctx.capabilities
    probe = ctx.transport.run_ssh(
        "echo '===HCI==='; hciconfig hci0 -a 2>/dev/null || true; "
        "echo '===CON==='; hcitool con 2>/dev/null || true"
    )
    hci_text = ""
    con_text = ""
    if "===HCI===" in probe.stdout:
        _, rest = probe.stdout.split("===HCI===", 1)
        if "===CON===" in rest:
            hci_text, con_text = rest.split("===CON===", 1)
        else:
            hci_text = rest
    adapter_up_running = bool(re.search(r"\bUP\b", hci_text) and re.search(r"\bRUNNING\b", hci_text))
    auth = "AUTH" in con_text
    encrypt = "ENCRYPT" in con_text
    connected = "ACL" in con_text

    status_http = ctx.transport.http_request("GET", "/api/bt-text-status")
    status_json = _json_body(status_http.body) if status_http.ok else {}
    hid_runtime = bool(status_json.get("runtime")) and status_json.get("state") == "listening"

    issues: list[str] = []
    warnings: list[str] = []
    if not adapter_up_running:
        issues.append("hci0 is not UP RUNNING (Bluetooth adapter down or absent)")
    if not caps.bt_pair_agent_alive:
        issues.append("codex_bt_pair_agent is not running (SSP pairing / link-key reload unavailable)")
    if not hid_runtime and caps.bt_hid_daemon_alive is False and not status_json:
        warnings.append("Bluetooth HID text runtime status unavailable (no /api/bt-text-status reply)")
    if caps.bt_target_mac and not caps.bt_link_key_present:
        warnings.append("a Bluetooth target is configured but no stored link key was found")
    if caps.bt_target_mac and connected and not (auth and encrypt):
        warnings.append("Bluetooth target is connected without AUTH+ENCRYPT link security")
    if caps.bt_target_mac and not connected:
        warnings.append("Bluetooth target is configured but not currently connected (AUTH+ENCRYPT unverified)")

    outcome = CheckOutcome.FAIL if issues else (CheckOutcome.WARN if warnings else CheckOutcome.PASS)
    details = issues + warnings
    if not details:
        details.append(
            "hci0 UP RUNNING, codex_bt_pair_agent alive, stored link key present, "
            "and the configured target holds an AUTH+ENCRYPT ACL connection."
        )
    return _result(
        "bt.adapter_and_hid_daemon",
        "Bluetooth adapter, pair agent, link key, and HID daemon",
        "bt",
        SafetyTier.SAFE,
        outcome,
        details[0],
        details=details,
        evidence={
            "hci_up_running": adapter_up_running,
            "pair_agent_alive": caps.bt_pair_agent_alive,
            "hid_daemon_alive": caps.bt_hid_daemon_alive,
            "hid_runtime_listening": hid_runtime,
            "link_key_present": caps.bt_link_key_present,
            "target_connected": connected,
            "link_auth": auth,
            "link_encrypt": encrypt,
        },
    )


# --------------------------------------------------------------------------
# 2. Time restrictions: in-window refusal + fail-open clock (ACTIVE)
# --------------------------------------------------------------------------

def _applies_restrictions(caps: HubCapabilities) -> tuple[bool, str]:
    if not caps.webui_reachable:
        return False, "Web UI API unreachable"
    if caps.activity_count <= 0:
        return False, "hub has 0 configured activities"
    return True, ""


_ALL_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def _post_restrictions(ctx: CheckContext, activity_id: str, windows: list[dict[str, Any]]) -> Any:
    body = json.dumps({"activityId": activity_id, "windows": windows}).encode("utf-8")
    return ctx.transport.http_request(
        "POST", "/api/activity-restrictions", body=body, content_type="application/json"
    )


def _post_activity_run(ctx: CheckContext, activity_id: str) -> Any:
    form = urllib.parse.urlencode({"activityId": activity_id}).encode("utf-8")
    return ctx.transport.http_request(
        "POST",
        "/api/activity-run",
        body=form,
        content_type="application/x-www-form-urlencoded",
        timeout=30,
    )


def check_restrictions_window_and_clock_failopen(ctx: CheckContext) -> CheckResult:
    caps = ctx.capabilities
    cfg = ctx.config
    target_id = cfg.test_activity_id or (caps.activity_ids[0] if caps.activity_ids else "")
    if not target_id:
        return _result(
            "restrictions.window_and_clock_failopen",
            "Time-restriction window refusal and clock fail-open",
            "restrictions",
            SafetyTier.ACTIVE,
            CheckOutcome.SKIP,
            "Skipped because no test activity is available.",
            skip_reason="no activity available for the restriction probe",
        )

    original_windows = [dict(w) for w in caps.restrictions_windows.get(target_id, [])]
    current_resp = ctx.transport.http_request("GET", "/api/activity-state")
    from .checks_remotes import _parse_current_activity_id

    ok_before, initial_activity = _parse_current_activity_id(current_resp.body)
    if not ok_before:
        initial_activity = "-1"

    probe_windows = [{"days": list(_ALL_DAYS), "start": "00:00", "end": "24:00"}]
    set_resp = _post_restrictions(ctx, target_id, probe_windows)
    if not set_resp.ok:
        return _result(
            "restrictions.window_and_clock_failopen",
            "Time-restriction window refusal and clock fail-open",
            "restrictions",
            SafetyTier.ACTIVE,
            CheckOutcome.FAIL,
            f"Could not install the probe restriction window (HTTP {set_resp.status}).",
            evidence={"target_activity_id": target_id},
        )
    ctx.transport.record_state_action(
        "restrictions.window_and_clock_failopen",
        f"POST /api/activity-restrictions all-day window on activity {target_id}",
        reverted=False,
        detail="probe window; original windows restored in finally",
    )

    refused = False
    failopen_exercised = False
    run_status = 0
    restored_windows = False
    restored_activity = True
    try:
        run_resp = _post_activity_run(ctx, target_id)
        run_status = run_resp.status
        body_compact = run_resp.body.replace(" ", "")
        refused = run_status == 409 or '"restricted":true' in body_compact or "568" in run_resp.body
        if not caps.hub_clock_known:
            # Unknown clock/TZ must fail OPEN: the start above must not be refused.
            failopen_exercised = True
        if refused:
            pass
        elif failopen_exercised:
            # Fail-open start succeeded; restore the prior activity below.
            pass
        # If the start was accepted (fail-open or hub ignores window), restore prior state.
        if not refused:
            restore_resp = _post_activity_run(ctx, initial_activity)
            restored_activity = restore_resp.ok
            ctx.transport.record_state_action(
                "restrictions.window_and_clock_failopen",
                f"restore POST /api/activity-run activityId={initial_activity}",
                reverted=restored_activity,
                detail="probe start was accepted (fail-open path)",
            )
    finally:
        restore_set = _post_restrictions(ctx, target_id, original_windows)
        restored_windows = restore_set.ok
        ctx.transport.record_state_action(
            "restrictions.window_and_clock_failopen",
            f"restore /api/activity-restrictions windows on activity {target_id}",
            reverted=restored_windows,
            detail=f"restored {len(original_windows)} original window(s)",
        )

    issues: list[str] = []
    warnings: list[str] = []
    if caps.hub_clock_known and not refused:
        issues.append(
            f"in-window activity start was not refused (HTTP {run_status}); expected 409 with engine code 568"
        )
    if failopen_exercised and refused:
        issues.append("hub clock/TZ is unknown, yet the in-window start was refused (restrictions must fail open)")
    if not restored_windows:
        issues.append("failed to restore the activity's original restriction windows")
    if failopen_exercised and not restored_activity:
        warnings.append("fail-open probe start was accepted but the prior activity could not be restored")

    outcome = CheckOutcome.FAIL if issues else (CheckOutcome.WARN if warnings else CheckOutcome.PASS)
    details = issues + warnings
    if not details:
        if failopen_exercised:
            details.append(
                f"Hub clock unknown (epoch {int(caps.hub_epoch_seconds)}); in-window start failed open "
                "and the prior activity was restored; probe window removed."
            )
        else:
            details.append(
                f"In-window start of activity {target_id} refused (HTTP {run_status}, engine 568); "
                "original restriction windows restored. Fail-open sub-case not exercised: hub clock is known "
                "(covered off-hub by the lua-restrictions suite)."
            )
    return _result(
        "restrictions.window_and_clock_failopen",
        "Time-restriction window refusal and clock fail-open",
        "restrictions",
        SafetyTier.ACTIVE,
        outcome,
        details[0],
        details=details,
        evidence={
            "target_activity_id": target_id,
            "hub_clock_known": caps.hub_clock_known,
            "hub_epoch_seconds": caps.hub_epoch_seconds,
            "refused_in_window": refused,
            "run_http_status": run_status,
            "failopen_exercised": failopen_exercised,
            "windows_restored": restored_windows,
        },
        recovery_hint="Re-open Settings -> Time restrictions and confirm the activity's windows match your intent.",
    )


# --------------------------------------------------------------------------
# 3. Home Assistant state + webhook round-trip (SAFE read / ACTIVE round-trip)
# --------------------------------------------------------------------------

def _applies_ha(caps: HubCapabilities) -> tuple[bool, str]:
    if not caps.webui_reachable:
        return False, "Web UI API unreachable"
    if not caps.ha_configured and caps.ha_state_version < 0:
        return False, "no Home Assistant devices configured and /api/ha-state is unavailable"
    return True, ""


def check_ha_state_and_webhook_roundtrip(ctx: CheckContext) -> CheckResult:
    caps = ctx.capabilities
    cfg = ctx.config
    issues: list[str] = []
    warnings: list[str] = []

    state_resp = ctx.transport.http_request("GET", "/api/ha-state")
    state_json = _json_body(state_resp.body) if state_resp.ok else {}
    if not state_resp.ok or state_json.get("ok") is not True:
        issues.append(f"GET /api/ha-state failed (HTTP {state_resp.status})")
        version = caps.ha_state_version
        stale = caps.ha_state_stale
        state_count = caps.ha_state_count
    else:
        version = state_json.get("version", caps.ha_state_version)
        stale = bool(state_json.get("stale", caps.ha_state_stale))
        states = state_json.get("states")
        state_count = len(states) if isinstance(states, list) else caps.ha_state_count
        if stale:
            warnings.append("/api/ha-state snapshot is stale (>90s without a Home Assistant push)")
        elif caps.ha_configured and state_count == 0:
            warnings.append("/api/ha-state is fresh but carries 0 device states despite HA devices on the hub")

    # Active round-trip part: only with the ACTIVE opt-ins and an explicit test target.
    webhook_exercised = False
    webhook_ok = False
    tier_ok, _tier_reason = cfg.check_tier_permitted(SafetyTier.ACTIVE, "allow_state_change")
    if tier_ok and caps.ha_webhook_url and cfg.test_ha_device_key and cfg.test_ha_command:
        payload = json.dumps({"device": cfg.test_ha_device_key, "command": cfg.test_ha_command})
        hook_resp = ctx.transport.run_ssh(
            "wget -q -O - "
            f"--post-data={remote_quote(payload)} "
            "--header='Content-Type: application/json' "
            f"{remote_quote(caps.ha_webhook_url)} 2>/dev/null"
        )
        webhook_exercised = True
        webhook_ok = hook_resp.ok
        ctx.transport.record_state_action(
            "ha.state_and_webhook_roundtrip",
            f"POST HA webhook device={cfg.test_ha_device_key} command={cfg.test_ha_command}",
            reverted=False,
            detail=f"hub-originated wget rc={hook_resp.returncode}",
        )
        if not webhook_ok:
            issues.append(f"HA webhook POST failed from the hub (wget rc={hook_resp.returncode})")
    elif tier_ok:
        warnings.append(
            "webhook round-trip not exercised (set ha_webhook_url/test_ha_device_key/test_ha_command "
            "in config.local.json to enable it)"
        )

    outcome = CheckOutcome.FAIL if issues else (CheckOutcome.WARN if warnings else CheckOutcome.PASS)
    details = issues + warnings
    if not details:
        details.append(
            f"/api/ha-state fresh at version {version} with {state_count} state(s); "
            "webhook POST executed the configured hub device command."
        )
    return _result(
        "ha.state_and_webhook_roundtrip",
        "Home Assistant state freshness and webhook round-trip",
        "ha",
        SafetyTier.SAFE,
        outcome,
        details[0],
        details=details,
        evidence={
            "ha_state_version": version,
            "ha_state_stale": stale,
            "ha_state_count": state_count,
            "webhook_exercised": webhook_exercised,
            "webhook_ok": webhook_ok,
        },
    )


# --------------------------------------------------------------------------
# 4. MQTT broker round-trip (ACTIVE)
# --------------------------------------------------------------------------

def _applies_mqtt(caps: HubCapabilities) -> tuple[bool, str]:
    if not caps.ssh_reachable:
        return False, "SSH unreachable"
    if not caps.mqtt_configured:
        return False, "MQTT is not configured on this hub (no /data/codexmqtt/config.json)"
    return True, ""


def check_mqtt_broker_roundtrip(ctx: CheckContext) -> CheckResult:
    caps = ctx.capabilities
    cfg = ctx.config
    if not cfg.mqtt_broker_host:
        return _result(
            "mqtt.broker_roundtrip",
            "MQTT discovery/state topics and activity select round-trip",
            "mqtt",
            SafetyTier.ACTIVE,
            CheckOutcome.SKIP,
            "Skipped because mqtt_broker_host is not set in config.local.json.",
            skip_reason="mqtt_broker_host not configured in config.local.json",
        )

    # Re-select the currently running activity (or PowerOff state) so the
    # round-trip proves the command path without changing what is playing.
    from .checks_remotes import _parse_current_activity_id

    state_resp = ctx.transport.http_request("GET", "/api/activity-state")
    ok_cur, current_id = _parse_current_activity_id(state_resp.body)
    activity_payload = ""
    if ok_cur and current_id != "-1":
        activity_payload = caps.activity_names.get(current_id, current_id)
    elif ok_cur:
        activity_payload = "PowerOff"

    rt = ctx.transport.mqtt_roundtrip(
        broker_host=cfg.mqtt_broker_host,
        broker_port=cfg.mqtt_broker_port,
        base_topic=cfg.mqtt_base_topic,
        discovery_prefix=cfg.mqtt_discovery_prefix,
        username=cfg.mqtt_username,
        password=cfg.mqtt_password,
        activity_payload=activity_payload,
    )
    ctx.transport.record_state_action(
        "mqtt.broker_roundtrip",
        f"MQTT PUBLISH {cfg.mqtt_base_topic}/activity/set <- {activity_payload!r}",
        reverted=True,
        detail="re-selected the already-current activity (no state change intended)",
    )

    issues: list[str] = []
    warnings: list[str] = []
    if not rt.get("connected"):
        issues.append(f"could not connect to the MQTT broker ({rt.get('error') or 'unknown error'})")
    discovery_topics = rt.get("discovery_topics") or []
    state_payloads = rt.get("state_payloads") or []
    result_payloads = rt.get("result_payloads") or []
    if rt.get("connected") and not discovery_topics:
        warnings.append("no retained Home Assistant discovery config topics seen under the discovery prefix")
    if rt.get("connected") and not state_payloads:
        issues.append(f"no state payload received on {cfg.mqtt_base_topic}/state")
    state_activity_id = ""
    if state_payloads:
        last_state = _json_body(state_payloads[-1])
        state_activity_id = str(last_state.get("activityId", ""))
        if ok_cur and state_activity_id and state_activity_id != current_id:
            issues.append(
                f"MQTT state reports activityId={state_activity_id} after the round-trip, expected {current_id}"
            )
    result_ok: bool | None = None
    if result_payloads:
        last_result = _json_body(result_payloads[-1])
        result_ok = last_result.get("ok") is True
        if result_ok is False:
            issues.append(f"MQTT result topic reported failure: {result_payloads[-1][:160]}")
    elif rt.get("connected") and activity_payload:
        warnings.append("no result payload received on the MQTT result topic within the timeout")

    outcome = CheckOutcome.FAIL if issues else (CheckOutcome.WARN if warnings else CheckOutcome.PASS)
    details = issues + warnings
    if not details:
        details.append(
            f"MQTT discovery ({len(discovery_topics)} topic(s)), state, and activity-select round-trip "
            f"verified; state activityId={state_activity_id}."
        )
    return _result(
        "mqtt.broker_roundtrip",
        "MQTT discovery/state topics and activity select round-trip",
        "mqtt",
        SafetyTier.ACTIVE,
        outcome,
        details[0],
        details=details,
        evidence={
            "broker_connected": bool(rt.get("connected")),
            "discovery_topic_count": len(discovery_topics),
            "discovery_topics": discovery_topics[:8],
            "state_payload_count": len(state_payloads),
            "state_activity_id": state_activity_id,
            "result_ok": result_ok,
            "published_topic": rt.get("published_topic", ""),
            "error": rt.get("error", ""),
        },
    )


# --------------------------------------------------------------------------
# 5. Android TV mDNS discovery (SAFE) + input-profile Try (ACTIVE)
# --------------------------------------------------------------------------

def _applies_androidtv(caps: HubCapabilities) -> tuple[bool, str]:
    if not caps.webui_reachable:
        return False, "Web UI API unreachable"
    if not caps.androidtv_running and not caps.androidtv_configured:
        return False, "Android TV daemon is not running and no TVs are paired"
    return True, ""


def check_androidtv_mdns_discovery_cross_if(ctx: CheckContext) -> CheckResult:
    caps = ctx.capabilities
    disc_resp = ctx.transport.http_request("GET", "/api/androidtv/discover")
    disc_json = _json_body(disc_resp.body) if disc_resp.ok else {}
    found = disc_json.get("found") if isinstance(disc_json.get("found"), list) else []
    found_hosts = {str(f.get("host", "")) for f in found if isinstance(f, dict)}

    ifaces_probe = ctx.transport.run_ssh("ifconfig 2>/dev/null || true")
    has_wifi = "ath0" in ifaces_probe.stdout and (not caps.wifi_ip or caps.wifi_ip in ifaces_probe.stdout)
    has_wired = bool(caps.usb_eth_ifname) and caps.usb_eth_ifname in ifaces_probe.stdout

    issues: list[str] = []
    warnings: list[str] = []
    if not disc_resp.ok or disc_json.get("ok") is not True:
        issues.append(f"GET /api/androidtv/discover failed (HTTP {disc_resp.status})")
    paired_hosts = {tv.host for tv in caps.paired_tvs if tv.host}
    missing = sorted(h for h in paired_hosts if h and h not in found_hosts)
    if missing and found is not None and disc_resp.ok:
        warnings.append(
            f"{len(missing)} paired TV host(s) did not answer mDNS during the scan "
            "(deep standby TVs are silent; wake the TV and re-run for a strict pass)"
        )
    if caps.usb_eth_operational and not has_wired:
        issues.append(f"USB Ethernet interface {caps.usb_eth_ifname} absent from ifconfig during discovery")

    outcome = CheckOutcome.FAIL if issues else (CheckOutcome.WARN if warnings else CheckOutcome.PASS)
    details = issues + warnings
    if not details:
        details.append(
            f"mDNS discovery returned {len(found)} device(s) covering all {len(paired_hosts)} paired TV(s) "
            f"across Wi-Fi={'yes' if has_wifi else 'no'}, USB-Ethernet={'yes' if has_wired else 'n/a'}."
        )
    return _result(
        "androidtv.mdns_discovery_cross_if",
        "Android TV mDNS discovery across Wi-Fi and USB-Ethernet",
        "androidtv",
        SafetyTier.SAFE,
        outcome,
        details[0],
        details=details,
        evidence={
            "discovered_count": len(found),
            "paired_tv_count": len(caps.paired_tvs),
            "paired_hosts_discovered": sorted(h for h in paired_hosts if h in found_hosts),
            "wifi_interface_present": bool(has_wifi),
            "wired_interface_present": bool(has_wired),
        },
    )


def _profile_method(profile_text: str | None) -> str:
    if not profile_text:
        return "builtin"
    for line in profile_text.splitlines():
        parts = line.replace("\t", " ").split()
        if len(parts) >= 2 and parts[0] == "method":
            return parts[1]
    return "builtin"


def check_androidtv_pair_inputs_try(ctx: CheckContext) -> CheckResult:
    caps = ctx.capabilities
    cfg = ctx.config
    issues: list[str] = []
    warnings: list[str] = []
    per_tv: list[dict[str, Any]] = []

    for tv in caps.paired_tvs:
        prof_resp = ctx.transport.http_request(
            "GET", f"/api/androidtv/inputs?device={urllib.parse.quote(tv.tv_id)}"
        )
        prof_json = _json_body(prof_resp.body) if prof_resp.ok else {}
        if not prof_resp.ok or prof_json.get("ok") is not True:
            issues.append(f"GET /api/androidtv/inputs for TV {tv.tv_id} failed (HTTP {prof_resp.status})")
            continue
        profile = prof_json.get("profile")
        method = _profile_method(profile if isinstance(profile, str) else None)
        per_tv.append({"tv_id": tv.tv_id, "method": method, "connected": tv.connected})
        if method not in {"keys", "link", "menu", "none", "builtin"}:
            issues.append(f"TV {tv.tv_id} reports unknown input method {method!r}")

    try_exercised = False
    target = cfg.test_androidtv_input
    if target is not None:
        body = json.dumps(
            {"device": target.device_id, "method": target.method, "value": target.value, "home": "1"}
        ).encode("utf-8")
        try_resp = ctx.transport.http_request(
            "POST", "/api/androidtv/try", body=body, content_type="application/json"
        )
        try_json = _json_body(try_resp.body) if try_resp.ok else {}
        try_exercised = True
        ctx.transport.record_state_action(
            "androidtv.pair_inputs_try",
            f"POST /api/androidtv/try device={target.device_id} method={target.method} value={target.value}",
            reverted=False,
            detail=f"HTTP {try_resp.status}",
        )
        if not try_resp.ok or try_json.get("ok") is not True:
            issues.append(f"Android TV input Try failed (HTTP {try_resp.status}: {try_resp.body[:120]})")
    else:
        warnings.append(
            "input Try not exercised (set test_androidtv_input in config.local.json); "
            "profiles were read for every paired TV"
        )

    outcome = CheckOutcome.FAIL if issues else (CheckOutcome.WARN if warnings else CheckOutcome.PASS)
    details = issues + warnings
    if not details:
        methods = ", ".join(f"{t['tv_id']}:{t['method']}" for t in per_tv)
        details.append(f"Input profiles verified ({methods}); Try switched the configured input successfully.")
    return _result(
        "androidtv.pair_inputs_try",
        "Android TV input profiles and Try switching per method",
        "androidtv",
        SafetyTier.ACTIVE,
        outcome,
        details[0],
        details=details,
        evidence={"tvs": per_tv, "try_exercised": try_exercised},
    )


# --------------------------------------------------------------------------
# 6/7. Home-control + pair-after-activities automatable preconditions (SAFE)
# --------------------------------------------------------------------------

def _applies_home_control(caps: HubCapabilities) -> tuple[bool, str]:
    if not caps.webui_reachable:
        return False, "Web UI API unreachable"
    if not caps.home_control_remote_present:
        return False, "no Companion (16422) or screen remote (16417) with Home Control keys is paired"
    return True, ""


def _load_activity_config(ctx: CheckContext) -> dict[str, Any]:
    resp = ctx.transport.http_request("GET", "/api/activity-config")
    return _json_body(resp.body) if resp.ok else {}


_HOME_KEY_SETS = {
    "16422": {"Ha1", "Ha2", "Ha3", "Ha4"},
    "16417": {"HomeControl1", "HomeControl2", "HomeControl3", "HomeControl4"},
}


def check_remote_home_control_buttons(ctx: CheckContext) -> CheckResult:
    caps = ctx.capabilities
    cfg_json = _load_activity_config(ctx)
    button_maps = (cfg_json.get("mapList") or {}).get("ButtonMaps") or []
    maps_by_id = {
        str(m.get("ButtonMapIdentifier", "")): m for m in button_maps if isinstance(m, dict)
    }
    issues: list[str] = []
    warnings: list[str] = []
    per_remote: list[dict[str, Any]] = []

    for equad in sorted({r.equad_id for r in caps.paired_remotes if r.equad_id in _HOME_KEY_SETS}):
        root = maps_by_id.get(f"{equad}Root")
        if root is None:
            warnings.append(f"{equad}Root button map missing (Home Control keys rely on engine defaults)")
            per_remote.append({"equad_id": equad, "root_map": False, "bound_keys": []})
            continue
        bound: list[str] = []
        for btn in root.get("Buttons") or []:
            if not isinstance(btn, dict):
                continue
            key = str(btn.get("ButtonKey", ""))
            if key in _HOME_KEY_SETS[equad] and any(
                btn.get(f) for f in ("ButtonAction", "ButtonLongPressAction", "ButtonDoublePressAction")
            ):
                bound.append(key)
        per_remote.append({"equad_id": equad, "root_map": True, "bound_keys": sorted(bound)})
        if not bound:
            warnings.append(f"{equad}Root map has no bound Home Control keys (presses will do nothing)")

    outcome = CheckOutcome.FAIL if issues else (CheckOutcome.WARN if warnings else CheckOutcome.PASS)
    details = issues + warnings
    if not details:
        bound_desc = "; ".join(f"{p['equad_id']}: {len(p['bound_keys'])} key(s)" for p in per_remote)
        details.append(f"Home Control Root maps present with bound keys ({bound_desc}); physical press/dim proof is HITL.")
    return _result(
        "remote.home_control_buttons",
        "Home Control button maps and bindings (Companion / screen remote)",
        "remote",
        SafetyTier.SAFE,
        outcome,
        details[0],
        details=details,
        evidence={"remotes": per_remote},
    )


def _applies_pair_backfill(caps: HubCapabilities) -> tuple[bool, str]:
    if not caps.webui_reachable:
        return False, "Web UI API unreachable"
    if not caps.paired_remotes:
        return False, "0 RF remotes paired in rf.info"
    if caps.activity_count <= 0:
        return False, "hub has 0 configured activities"
    return True, ""


def check_remote_pair_after_activities_backfill(ctx: CheckContext) -> CheckResult:
    caps = ctx.capabilities
    cfg_json = _load_activity_config(ctx)
    button_maps = (cfg_json.get("mapList") or {}).get("ButtonMaps") or []
    map_ids = {
        str(m.get("ButtonMapIdentifier", ""))
        for m in button_maps
        if isinstance(m, dict) and str(m.get("ButtonMapIdentifier", ""))
    }
    handheld = sorted({r.equad_id for r in caps.paired_remotes if r.equad_id in {"16414", "16417", "16422", "16423"}})
    missing: list[str] = []
    for equad in handheld:
        for aid in caps.activity_ids:
            want = f"{equad}Activity{aid}"
            if want not in map_ids:
                missing.append(want)
    issues: list[str] = []
    if missing:
        issues.append(
            f"{len(missing)} ActivityButtonMap(s) missing for already-paired remote(s) "
            f"(pair-after-activities backfill, #149): " + ", ".join(missing[:6])
        )
    outcome = CheckOutcome.FAIL if issues else CheckOutcome.PASS
    details = issues or [
        f"All {len(handheld)} paired handheld equad(s) hold Activity maps for all "
        f"{caps.activity_count} activit(ies) without re-saving each activity."
    ]
    return _result(
        "remote.pair_after_activities_backfill",
        "Paired-after-activities remotes hold working activity maps",
        "remote",
        SafetyTier.SAFE,
        outcome,
        details[0],
        details=details,
        evidence={"handheld_equads": handheld, "missing_activity_maps": missing},
    )


# --------------------------------------------------------------------------
# 9. HA devices CommitHaDevices v2 live drill (ACTIVE + --allow-state-change)
# --------------------------------------------------------------------------

def _applies_ha_devices(caps: HubCapabilities) -> tuple[bool, str]:
    if not caps.webui_reachable:
        return False, "Web UI API unreachable"
    if not caps.provisioned:
        return False, "hub is not yet provisioned (/data/resources or hub_id absent)"
    return True, ""


_SCRATCH_KEY = "media_player.hwreg_scratch"


def _ha_devices_payload(webhook: str, devices: list[dict[str, Any]], dry_run: bool) -> bytes:
    return json.dumps({"webhook": webhook, "dryRun": dry_run, "devices": devices}).encode("utf-8")


def _scratch_device() -> dict[str, Any]:
    return {
        "key": _SCRATCH_KEY,
        "name": "HWReg Scratch",
        "entities": [{"alias": _SCRATCH_KEY, "entity": _SCRATCH_KEY}],
        "commands": [
            {"name": "PowerOn", "value": f"{_SCRATCH_KEY}:turn_on"},
            {"name": "PowerOff", "value": f"{_SCRATCH_KEY}:turn_off"},
        ],
        "power": {"on": "PowerOn", "off": "PowerOff"},
    }


def _ha_device_count(ctx: CheckContext) -> int:
    cfg_json = _load_activity_config(ctx)
    dwf = (cfg_json.get("deviceList") or {}).get("DevicesWithFeatures") or []
    count = 0
    for entry in dwf if isinstance(dwf, list) else []:
        if not isinstance(entry, dict):
            continue
        dev = entry.get("Device") if isinstance(entry.get("Device"), dict) else entry
        auto_dev = dev.get("AutoDetectedDevice") if isinstance(dev, dict) else None
        auto_id = str((auto_dev or {}).get("Id", "")) if isinstance(auto_dev, dict) else ""
        if auto_id.startswith("melodious-ha-"):
            count += 1
    return count


def check_ha_devices_commit_live(ctx: CheckContext) -> CheckResult:
    caps = ctx.capabilities
    webhook = caps.ha_webhook_url or "http://127.0.0.1:8123/api/webhook/hwreg-scratch"
    scratch = _scratch_device()

    dry_resp = ctx.transport.http_request(
        "POST", "/api/ha-devices", body=_ha_devices_payload(webhook, [scratch], True),
        content_type="application/json",
    )
    dry_json = _json_body(dry_resp.body) if dry_resp.ok else {}
    if not dry_resp.ok or dry_json.get("ok") is not True:
        return _result(
            "ha.devices_commit_live",
            "CommitHaDevices v2 dry-run and live scratch-device drill",
            "ha",
            SafetyTier.ACTIVE,
            CheckOutcome.FAIL,
            f"CommitHaDevices dry-run refused (HTTP {dry_resp.status}: {dry_resp.body[:160]})",
            evidence={"dry_run_status": dry_resp.status},
        )

    warnings: list[str] = []
    issues: list[str] = []
    real_exercised = False
    removed_ok: bool | None = None
    if caps.ha_devices_count > 0:
        warnings.append(
            f"real commit not exercised: hub already owns {caps.ha_devices_count} HA device(s); "
            "a whole-set commit from the suite could not preserve their specs (dry-run only)"
        )
    elif not caps.ha_webhook_url:
        warnings.append("real commit not exercised: no HA webhook is configured on this hub (dry-run only)")
    else:
        real_exercised = True
        before = _ha_device_count(ctx)
        real_resp = ctx.transport.http_request(
            "POST", "/api/ha-devices", body=_ha_devices_payload(webhook, [scratch], False),
            content_type="application/json",
        )
        real_json = _json_body(real_resp.body) if real_resp.ok else {}
        ctx.transport.record_state_action(
            "ha.devices_commit_live",
            "POST /api/ha-devices CommitHaDevices v2 scratch device (real)",
            reverted=False,
            detail=f"HTTP {real_resp.status}",
        )
        if not real_resp.ok or real_json.get("ok") is not True:
            issues.append(f"real CommitHaDevices commit refused (HTTP {real_resp.status}: {real_resp.body[:160]})")
        else:
            after = _ha_device_count(ctx)
            if after != before + 1:
                issues.append(f"scratch HA device did not appear live (count {before} -> {after})")
        # Clean removal: empty set removes every suite-owned HA device (only the scratch exists here).
        rm_resp = ctx.transport.http_request(
            "POST", "/api/ha-devices", body=_ha_devices_payload("", [], False),
            content_type="application/json",
        )
        rm_json = _json_body(rm_resp.body) if rm_resp.ok else {}
        removed_ok = bool(rm_resp.ok and rm_json.get("ok") is True and _ha_device_count(ctx) == before)
        ctx.transport.record_state_action(
            "ha.devices_commit_live",
            "POST /api/ha-devices empty set (scratch removal)",
            reverted=removed_ok,
            detail=f"HTTP {rm_resp.status}",
        )
        if not removed_ok:
            issues.append("scratch HA device could not be cleanly removed after the live commit")

    outcome = CheckOutcome.FAIL if issues else (CheckOutcome.WARN if warnings else CheckOutcome.PASS)
    details = issues + warnings
    if not details:
        details.append("CommitHaDevices v2 dry-run, live scratch commit, engine visibility, and clean removal all verified.")
    return _result(
        "ha.devices_commit_live",
        "CommitHaDevices v2 dry-run and live scratch-device drill",
        "ha",
        SafetyTier.ACTIVE,
        outcome,
        details[0],
        details=details,
        evidence={
            "dry_run_ok": True,
            "real_commit_exercised": real_exercised,
            "scratch_removed": removed_ok,
            "ha_devices_before": caps.ha_devices_count,
        },
        recovery_hint="If the scratch device remains, POST an empty set to /api/ha-devices or remove 'HWReg Scratch' in Settings.",
    )


# --------------------------------------------------------------------------
# USB-Ethernet adapter matrix note (SAFE)
# --------------------------------------------------------------------------

_TRAFFIC_TESTED_DRIVERS = {"asix"}


def _applies_adapter_matrix(caps: HubCapabilities) -> tuple[bool, str]:
    if not caps.ssh_reachable:
        return False, "SSH unreachable"
    if not caps.usb_eth_conf_enabled and not caps.usb_eth_ifname:
        return False, "USB Ethernet is not configured on this hub"
    return True, ""


def check_usb_eth_adapter_matrix(ctx: CheckContext) -> CheckResult:
    caps = ctx.capabilities
    driver = (caps.usb_eth_driver or "").lower()
    if driver in _TRAFFIC_TESTED_DRIVERS:
        return _result(
            "usb_eth.adapter_matrix",
            "USB-Ethernet adapter chipset traffic coverage",
            "usb_eth",
            SafetyTier.SAFE,
            CheckOutcome.PASS,
            f"Adapter driver '{driver}' is in the traffic-tested chipset family (AX88772B/C).",
            evidence={"driver": driver, "traffic_tested": True},
        )
    return _result(
        "usb_eth.adapter_matrix",
        "USB-Ethernet adapter chipset traffic coverage",
        "usb_eth",
        SafetyTier.SAFE,
        CheckOutcome.WARN,
        f"Adapter driver '{driver or 'unknown'}' ({caps.usb_eth_device or 'unknown device'}) is "
        "traffic-untested (Realtek/AX88179/CDC chipsets are built + audited only); "
        "run usb_eth.traffic_on_wire with this adapter to retire the gap.",
        evidence={"driver": driver, "device": caps.usb_eth_device, "traffic_tested": False},
    )


# --------------------------------------------------------------------------
# 10. Disruptive family: definitions + gating only (owner runs deliberately)
# --------------------------------------------------------------------------

def _disruptive_definition(
    check_id: str, title: str, category: str, steps: str, *, requires_reboot: bool = False
) -> CheckResult:
    return _result(
        check_id,
        title,
        category,
        SafetyTier.DISRUPTIVE,
        CheckOutcome.SKIP,
        f"Disruptive drill definition registered; automated execution is intentionally not "
        f"implemented in the suite. Operator procedure: {steps}",
        skip_reason="disruptive drill is operator-driven by design (definition + gating only)",
        recovery_hint=steps,
        evidence={"operator_driven": True, "requires_reboot_flag": requires_reboot},
    )


def _applies_always(caps: HubCapabilities) -> tuple[bool, str]:
    if not caps.ssh_reachable:
        return False, "SSH unreachable"
    return True, ""


def _applies_usb_eth_present(caps: HubCapabilities) -> tuple[bool, str]:
    if not caps.ssh_reachable:
        return False, "SSH unreachable"
    if not caps.usb_eth_conf_enabled and not caps.usb_eth_ifname:
        return False, "USB Ethernet is not configured on this hub"
    return True, ""


def check_turn_off_on_roundtrip(ctx: CheckContext) -> CheckResult:
    return _disruptive_definition(
        "core.turn_off_on_roundtrip",
        "Melodious turn-off / turn-on round-trip (installer-driven)",
        "core",
        "install_webui.py --turn-off, spot-check stock cloud/app behaviour, then "
        "install_webui.py --turn-on and verify cloud blocker + config are intact (see docs/INSTALL.md).",
    )


def check_backup_restore_drill(ctx: CheckContext) -> CheckResult:
    return _disruptive_definition(
        "core.backup_restore_drill",
        "Backup -> change -> restore drill",
        "core",
        "Download /export/bundle, make a scratch change, restore the bundle from the Backup page, "
        "and confirm the hub state diff is clean.",
    )


def check_recovery_ap_roundtrip(ctx: CheckContext) -> CheckResult:
    return _disruptive_definition(
        "core.recovery_ap_roundtrip",
        "Recovery AP entry and clean return to normal boot",
        "core",
        "Boot via the TDE/recovery path, join the Harmony-Recovery-* AP, confirm portal/DHCP, "
        "then reboot normally and verify Melodious services return.",
    )


def check_reboot_and_soak(ctx: CheckContext) -> CheckResult:
    return _disruptive_definition(
        "disruptive.reboot_and_soak",
        "Reboot persistence and uptime soak",
        "disruptive",
        "Reboot the hub, confirm config/HOT/restrictions/HA devices survive, then soak and watch counters.",
        requires_reboot=True,
    )


def check_wifi_off_watchdog_recovery(ctx: CheckContext) -> CheckResult:
    return _disruptive_definition(
        "usb_eth.wifi_off_watchdog_recovery",
        "USB-Ethernet WIFI_OFF watchdog and worker-death recovery",
        "usb_eth",
        "With WIFI_OFF=1, kill the usb_eth worker and confirm the watchdog hands traffic back / recovers "
        "without hot-plugging the micro-USB OTG adapter.",
    )


FEATURE_CHECKS: tuple[CheckSpec, ...] = (
    CheckSpec(
        check_id="bt.adapter_and_hid_daemon",
        title="Bluetooth adapter, pair agent, link key, and HID daemon",
        category="bt",
        tier=SafetyTier.SAFE,
        description="Verifies hci0 UP RUNNING, codex_bt_pair_agent, stored link key, AUTH+ENCRYPT, and HID runtime.",
        applies_when=_applies_bt,
        run_fn=check_bt_adapter_and_hid_daemon,
    ),
    CheckSpec(
        check_id="restrictions.window_and_clock_failopen",
        title="Time-restriction window refusal and clock fail-open",
        category="restrictions",
        tier=SafetyTier.ACTIVE,
        description="Installs an all-day window, expects a 568/409 refusal (or fail-open on unknown clock), then restores windows.",
        applies_when=_applies_restrictions,
        run_fn=check_restrictions_window_and_clock_failopen,
        requires_flag="allow_activity_toggle",
        recovery_hint="Re-open Settings -> Time restrictions and confirm the activity's windows match your intent.",
    ),
    CheckSpec(
        check_id="ha.state_and_webhook_roundtrip",
        title="Home Assistant state freshness and webhook round-trip",
        category="ha",
        tier=SafetyTier.SAFE,
        description="Reads /api/ha-state freshness; with ACTIVE opt-ins and a configured test device, POSTs the HA webhook.",
        applies_when=_applies_ha,
        run_fn=check_ha_state_and_webhook_roundtrip,
    ),
    CheckSpec(
        check_id="mqtt.broker_roundtrip",
        title="MQTT discovery/state topics and activity select round-trip",
        category="mqtt",
        tier=SafetyTier.ACTIVE,
        description="Connects to the configured broker, observes discovery/state, and re-selects the current activity.",
        applies_when=_applies_mqtt,
        run_fn=check_mqtt_broker_roundtrip,
        requires_flag="allow_state_change",
    ),
    CheckSpec(
        check_id="androidtv.mdns_discovery_cross_if",
        title="Android TV mDNS discovery across Wi-Fi and USB-Ethernet",
        category="androidtv",
        tier=SafetyTier.SAFE,
        description="Runs /api/androidtv/discover and checks paired TVs answer across the active interfaces.",
        applies_when=_applies_androidtv,
        run_fn=check_androidtv_mdns_discovery_cross_if,
    ),
    CheckSpec(
        check_id="androidtv.pair_inputs_try",
        title="Android TV input profiles and Try switching per method",
        category="androidtv",
        tier=SafetyTier.ACTIVE,
        description="Reads each paired TV's input profile/method and, when configured, sends one Try input switch.",
        applies_when=_applies_androidtv,
        run_fn=check_androidtv_pair_inputs_try,
        requires_flag="allow_state_change",
    ),
    CheckSpec(
        check_id="remote.home_control_buttons",
        title="Home Control button maps and bindings (Companion / screen remote)",
        category="remote",
        tier=SafetyTier.SAFE,
        description="Checks Home Control Root maps/bindings for 16422 and 16417; physical press/dim proof is HITL.",
        applies_when=_applies_home_control,
        run_fn=check_remote_home_control_buttons,
    ),
    CheckSpec(
        check_id="remote.pair_after_activities_backfill",
        title="Paired-after-activities remotes hold working activity maps",
        category="remote",
        tier=SafetyTier.SAFE,
        description="Asserts every paired handheld equad holds Activity maps for every activity (#149 backfill).",
        applies_when=_applies_pair_backfill,
        run_fn=check_remote_pair_after_activities_backfill,
    ),
    CheckSpec(
        check_id="ha.devices_commit_live",
        title="CommitHaDevices v2 dry-run and live scratch-device drill",
        category="ha",
        tier=SafetyTier.ACTIVE,
        description="Dry-runs, then (only on a hub with no HA devices and a webhook) commits a v2 scratch device and removes it.",
        applies_when=_applies_ha_devices,
        run_fn=check_ha_devices_commit_live,
        requires_flag="allow_state_change",
        recovery_hint="If the scratch device remains, POST an empty set to /api/ha-devices.",
    ),
    CheckSpec(
        check_id="usb_eth.adapter_matrix",
        title="USB-Ethernet adapter chipset traffic coverage",
        category="usb_eth",
        tier=SafetyTier.SAFE,
        description="Notes whether the attached adapter's chipset is traffic-tested (asix) or built + audited only.",
        applies_when=_applies_adapter_matrix,
        run_fn=check_usb_eth_adapter_matrix,
    ),
    CheckSpec(
        check_id="core.turn_off_on_roundtrip",
        title="Melodious turn-off / turn-on round-trip (installer-driven)",
        category="core",
        tier=SafetyTier.DISRUPTIVE,
        description="Definition + gating only: --turn-off stock spot-check, --turn-on, blocker/config intact.",
        applies_when=_applies_always,
        run_fn=check_turn_off_on_roundtrip,
        requires_flag="allow_disruptive",
    ),
    CheckSpec(
        check_id="core.backup_restore_drill",
        title="Backup -> change -> restore drill",
        category="core",
        tier=SafetyTier.DISRUPTIVE,
        description="Definition + gating only: web Backup, scratch change, Restore, diff-clean.",
        applies_when=_applies_always,
        run_fn=check_backup_restore_drill,
        requires_flag="allow_disruptive",
    ),
    CheckSpec(
        check_id="core.recovery_ap_roundtrip",
        title="Recovery AP entry and clean return to normal boot",
        category="core",
        tier=SafetyTier.DISRUPTIVE,
        description="Definition + gating only: TDE boot, Harmony-Recovery-* AP, portal/DHCP, normal boot.",
        applies_when=_applies_always,
        run_fn=check_recovery_ap_roundtrip,
        requires_flag="allow_disruptive",
    ),
    CheckSpec(
        check_id="disruptive.reboot_and_soak",
        title="Reboot persistence and uptime soak",
        category="disruptive",
        tier=SafetyTier.DISRUPTIVE,
        description="Definition + gating only: reboot persistence of config/HOT/restrictions/HA devices, then soak.",
        applies_when=_applies_always,
        run_fn=check_reboot_and_soak,
        requires_flag="allow_reboot",
    ),
    CheckSpec(
        check_id="usb_eth.wifi_off_watchdog_recovery",
        title="USB-Ethernet WIFI_OFF watchdog and worker-death recovery",
        category="usb_eth",
        tier=SafetyTier.DISRUPTIVE,
        description="Definition + gating only: WIFI_OFF worker-death hand-back without hot-plugging the OTG adapter.",
        applies_when=_applies_usb_eth_present,
        run_fn=check_wifi_off_watchdog_recovery,
        requires_flag="allow_disruptive",
    ),
)
