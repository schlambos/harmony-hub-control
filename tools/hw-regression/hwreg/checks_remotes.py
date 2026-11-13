"""Automatable remote-to-engine, map-resolution, and radio-counter checks."""

from __future__ import annotations

import json
import time
import urllib.parse
from typing import Any, TYPE_CHECKING

from .checks_core import HAL_MULTI_REMOTE_MD5, HAL_TWO_SCREEN_MD5
from .models import (
    CheckKind,
    CheckOutcome,
    CheckResult,
    CheckSpec,
    EvidenceClass,
    HubCapabilities,
    SafetyTier,
)

if TYPE_CHECKING:
    from .runner import CheckContext


HANDHELD_MAP_EQUADS = frozenset({"16414", "16417", "16422", "16423"})
NO_SCREEN_MAP_EQUADS = frozenset({"16414", "16422", "16423"})
ACTION_FIELDS = ("ButtonAction", "ButtonLongPressAction", "ButtonDoublePressAction")


def _applies_when_provisioned(caps: HubCapabilities) -> tuple[bool, str]:
    if not caps.ssh_reachable:
        return False, "SSH unreachable"
    if not caps.provisioned:
        return False, "hub is not yet provisioned (/data/resources or hub_id absent)"
    return True, ""


def _applies_for_hot_stats(caps: HubCapabilities) -> tuple[bool, str]:
    if not caps.ssh_reachable:
        return False, "SSH unreachable"
    has_screen = any(r.equad_id == "16417" for r in caps.paired_remotes)
    two_screen_hal = caps.hal_running_md5 == HAL_TWO_SCREEN_MD5 and caps.hal_gates.startswith("1")
    if not has_screen and not two_screen_hal:
        return False, "no screen remote (EquadID 16417) paired and two-screen hal is not active"
    return True, ""


def _applies_when_has_activities(caps: HubCapabilities) -> tuple[bool, str]:
    if not caps.webui_reachable:
        return False, "Web UI API unreachable"
    if caps.activity_count <= 0:
        return False, "hub has 0 configured activities"
    return True, ""


def _parse_current_activity_id(body_text: str) -> tuple[bool, str]:
    """Extract the active activityId (e.g. '-1' or '32923238') from GET /api/activity-state."""
    try:
        outer = json.loads(body_text)
    except json.JSONDecodeError:
        return False, ""
    if outer.get("ok") is not True:
        return False, ""
    reply = outer.get("reply", "")
    if isinstance(reply, str):
        idx = reply.find("{")
        if idx >= 0:
            try:
                reply = json.loads(reply[idx:])
            except json.JSONDecodeError:
                return False, ""
    if isinstance(reply, dict):
        data = reply.get("data")
        if isinstance(data, dict) and "result" in data:
            return True, str(data["result"])
    return False, ""


def check_rf_inventory_and_maps(ctx: CheckContext) -> CheckResult:
    """Verify rf.info slot policy, RootButtonMap & ActivityButtonMap resolution, and zero action-less buttons."""
    caps = ctx.capabilities
    issues: list[str] = []
    warnings: list[str] = []

    if caps.rf_pairing_open:
        return CheckResult(
            check_id="remote.rf_inventory_and_maps",
            title="Paired RF remotes, pairing policy, and button-map integrity",
            category="remote",
            kind=CheckKind.AUTOMATABLE,
            tier=SafetyTier.SAFE,
            outcome=CheckOutcome.SKIP,
            evidence_class=EvidenceClass.UNRESOLVED,
            summary="Skipped because an RF pairing window is currently open on the hub.",
            skip_reason="open RF pairing window (avoiding slot-register contention)",
        )

    if not caps.rf_info_ok:
        issues.append("hal rf.info did not return code 200")

    # 1. Check per-model pairing policy against active hal capabilities
    by_equad: dict[str, list[int]] = {}
    for rem in caps.paired_remotes:
        by_equad.setdefault(rem.equad_id, []).append(rem.slot)

    two_screen_hal_live = (
        caps.hal_running_md5 == HAL_TWO_SCREEN_MD5
        and len(caps.hal_gates) == 3
        and caps.hal_gates[0] == "1"
    )
    multi_remote_hal_live = (
        (caps.hal_running_md5 == HAL_MULTI_REMOTE_MD5 and caps.hal_bind_mounted)
        or (
            caps.hal_running_md5 == HAL_TWO_SCREEN_MD5
            and len(caps.hal_gates) == 3
            and caps.hal_gates[1] == "1"
        )
    )

    for equad_id, slots in sorted(by_equad.items()):
        if len(slots) <= 1:
            continue
        if equad_id == "34830":
            continue  # USB dongles may always share a hub
        if equad_id == "16420":
            issues.append(
                f"{len(slots)} Harmony keyboards (EquadID 16420) paired in slots {slots}; "
                "hal has one static keyboard subscriber and can hang its radio"
            )
        elif equad_id == "16417" and not two_screen_hal_live:
            issues.append(
                f"{len(slots)} screen remotes (EquadID 16417) paired in slots {slots} while "
                "two-screen hal is NOT active (HOT contexts will collide / batch presses)"
            )
        elif equad_id not in {"16417", "16420", "34830"} and not multi_remote_hal_live:
            issues.append(
                f"{len(slots)} remotes of EquadID {equad_id} paired in slots {slots} while "
                "multi-remote hal is NOT active (stock hal circular subscriber hang hazard)"
            )

    # 2. Load activity-config and validate Root + Activity maps + FunctionMaps + action-less button rule
    act_resp = ctx.transport.http_request("GET", "/api/activity-config")
    missing_roots: list[str] = []
    missing_act_maps: list[str] = []
    missing_fn_maps: list[str] = []
    actionless_hits: list[str] = []

    if not act_resp.ok:
        issues.append(f"GET /api/activity-config failed (HTTP {act_resp.status}: {act_resp.error})")
    else:
        try:
            cfg_json = json.loads(act_resp.body)
        except json.JSONDecodeError:
            cfg_json = {}
            issues.append("GET /api/activity-config returned invalid JSON")

        activities = (cfg_json.get("activityList") or {}).get("Activities") or []
        button_maps = (cfg_json.get("mapList") or {}).get("ButtonMaps") or []
        fn_maps = (cfg_json.get("functionList") or {}).get("FunctionMaps") or []

        map_ids: set[str] = set()
        for bmap in button_maps:
            if not isinstance(bmap, dict):
                continue
            ident = str(bmap.get("ButtonMapIdentifier", "")).strip()
            if ident:
                map_ids.add(ident)
            # Check action-less buttons on ActivityButtonMap (freezes physical remotes on start!)
            if bmap.get("__type") == "ActivityButtonMap":
                buttons = bmap.get("Buttons") or []
                if isinstance(buttons, list):
                    for btn in buttons:
                        if not isinstance(btn, dict):
                            continue
                        if not any(btn.get(f) for f in ACTION_FIELDS):
                            bkey = str(btn.get("ButtonKey", "?"))
                            actionless_hits.append(f"{ident}:{bkey}")

        fn_act_ids: set[str] = set()
        for fmap in fn_maps:
            if isinstance(fmap, dict) and fmap.get("__type") == "ActivityFunctionMap":
                aid = str(fmap.get("ActivityId-") or fmap.get("ActivityId") or "").strip()
                if aid:
                    fn_act_ids.add(aid)

        act_ids = [
            str(a.get("Id-") or a.get("Id") or "").strip()
            for a in activities
            if isinstance(a, dict) and str(a.get("Id-") or a.get("Id") or "").strip()
        ]

        for aid in act_ids:
            if aid not in fn_act_ids:
                missing_fn_maps.append(aid)

        paired_handheld_equads = sorted(
            {r.equad_id for r in caps.paired_remotes if r.equad_id in HANDHELD_MAP_EQUADS}
        )
        for equad in paired_handheld_equads:
            if equad in NO_SCREEN_MAP_EQUADS:
                root_id = f"{equad}Root"
                if root_id not in map_ids:
                    missing_roots.append(root_id)
            for aid in act_ids:
                want_map = f"{equad}Activity{aid}"
                if want_map not in map_ids:
                    missing_act_maps.append(want_map)

        if missing_roots:
            issues.append(f"paired remote RootButtonMap missing in MapList: {', '.join(missing_roots)}")
        if missing_act_maps:
            issues.append(
                f"paired remote ActivityButtonMap missing for {len(missing_act_maps)} surface/activity pair(s): "
                + ", ".join(missing_act_maps[:6])
            )
        if missing_fn_maps:
            issues.append(f"ActivityFunctionMap missing for activity ID(s): {', '.join(missing_fn_maps)}")
        if actionless_hits:
            issues.append(
                f"ActivityButtonMap contains {len(actionless_hits)} action-less button(s) "
                f"(freezes physical remotes): {', '.join(actionless_hits[:6])}"
            )

    if not caps.paired_remotes and not issues:
        warnings.append("0 RF remotes paired in rf.info (app-only hub; activity FunctionMaps still verified)")

    outcome = CheckOutcome.FAIL if issues else (CheckOutcome.WARN if warnings else CheckOutcome.PASS)
    details = issues + warnings
    if not details:
        slot_desc = ", ".join(f"slot {r.slot}: {r.name} ({r.equad_id})" for r in caps.paired_remotes)
        details.append(
            f"{len(caps.paired_remotes)} paired remote(s) ({slot_desc}); pairing policy satisfied, "
            f"all Root and {caps.activity_count} Activity maps present, 0 action-less buttons."
        )

    return CheckResult(
        check_id="remote.rf_inventory_and_maps",
        title="Paired RF remotes, pairing policy, and button-map integrity",
        category="remote",
        kind=CheckKind.AUTOMATABLE,
        tier=SafetyTier.SAFE,
        outcome=outcome,
        evidence_class=EvidenceClass.VERIFIED,
        summary=details[0],
        details=details,
        evidence={
            "paired_remotes": [
                {"slot": r.slot, "equad_id": r.equad_id, "skin_id": r.skin_id, "name": r.name}
                for r in caps.paired_remotes
            ],
            "two_screen_hal_live": two_screen_hal_live,
            "multi_remote_hal_live": multi_remote_hal_live,
            "activity_count": caps.activity_count,
            "missing_root_maps": missing_roots,
            "missing_activity_maps": missing_act_maps,
            "missing_function_maps": missing_fn_maps,
            "actionless_activity_buttons": actionless_hits,
        },
    )


def check_hot_radio_counters(ctx: CheckContext) -> CheckResult:
    """Capture Gate-C-style hot.stats radio error counters and validate per-slot health."""
    caps = ctx.capabilities
    res = ctx.transport.run_ssh("/data/codex/bin/codex_hal_ltcp 'hot.stats' '{}' 8 2>/dev/null || true")
    idx = res.stdout.find("{")
    if idx < 0:
        return CheckResult(
            check_id="remote.hot_radio_counters",
            title="HOT 2.4 GHz radio transport & per-slot error counters",
            category="remote",
            kind=CheckKind.AUTOMATABLE,
            tier=SafetyTier.SAFE,
            outcome=CheckOutcome.FAIL,
            evidence_class=EvidenceClass.VERIFIED,
            summary="codex_hal_ltcp hot.stats returned no JSON response.",
            details=[res.stdout.strip() or res.stderr.strip() or "empty response"],
        )

    try:
        payload = json.loads(res.stdout[idx:])
    except json.JSONDecodeError as exc:
        return CheckResult(
            check_id="remote.hot_radio_counters",
            title="HOT 2.4 GHz radio transport & per-slot error counters",
            category="remote",
            kind=CheckKind.AUTOMATABLE,
            tier=SafetyTier.SAFE,
            outcome=CheckOutcome.FAIL,
            evidence_class=EvidenceClass.VERIFIED,
            summary=f"Invalid JSON from hot.stats: {exc}",
        )

    code = int(payload.get("code", -1))
    stats: dict[str, Any] = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    if code != 200:
        return CheckResult(
            check_id="remote.hot_radio_counters",
            title="HOT 2.4 GHz radio transport & per-slot error counters",
            category="remote",
            kind=CheckKind.AUTOMATABLE,
            tier=SafetyTier.SAFE,
            outcome=CheckOutcome.FAIL,
            evidence_class=EvidenceClass.VERIFIED,
            summary=f"hot.stats failed with code {code}.",
            evidence={"raw_code": code},
        )

    io_err = int(stats.get("IO ERROR", 0) or 0)
    timeout_cnt = int(stats.get("TIMEOUT", 0) or 0)
    seq_err = int(stats.get("MSG SEQ ERROR", 0) or 0)
    rx_obj = int(stats.get("RX OBJECTS", 0) or 0)
    tx_obj = int(stats.get("TX OBJECTS", 0) or 0)
    total_obj = rx_obj + tx_obj
    seq_rate = (seq_err / total_obj) if total_obj > 0 else 0.0

    issues: list[str] = []
    warnings: list[str] = []

    if io_err > 0:
        issues.append(f"HOT radio IO ERROR is {io_err} (expected 0)")

    # Check per-slot IO ERROR and TS SLOTS mask when two-screen counters are present
    two_screen_hal_live = caps.hal_running_md5 == HAL_TWO_SCREEN_MD5 and caps.hal_gates.startswith("1")
    if two_screen_hal_live:
        if "TS MODE" not in stats:
            issues.append("two-screen hal is active, but hot.stats lacks 'TS MODE' / 'TS SLOTS' fields")
        else:
            expected_mask = 0
            for slot in caps.screen_remote_slots:
                expected_mask |= 1 << slot
            actual_mask = int(stats.get("TS SLOTS", 0) or 0)
            if expected_mask and actual_mask != expected_mask:
                issues.append(
                    f"TS SLOTS bitmask is {actual_mask} (0b{actual_mask:b}), expected {expected_mask} "
                    f"(0b{expected_mask:b}) for screen remote slots {caps.screen_remote_slots}"
                )
        for slot in range(1, 7):
            s_io = int(stats.get(f"S{slot} IO ERROR", 0) or 0)
            if s_io > 0:
                issues.append(f"slot {slot} S{slot} IO ERROR is {s_io} (expected 0)")

    if total_obj >= 20 and seq_rate > 0.20:
        issues.append(
            f"MSG SEQ ERROR rate is high: {seq_err}/{total_obj} ({seq_rate * 100:.1f}% > 20%)"
        )
    elif total_obj >= 20 and seq_rate > 0.05:
        warnings.append(
            f"MSG SEQ ERROR rate elevated: {seq_err}/{total_obj} ({seq_rate * 100:.1f}% > 5% baseline)"
        )

    outcome = CheckOutcome.FAIL if issues else (CheckOutcome.WARN if warnings else CheckOutcome.PASS)
    details = issues + warnings
    if not details:
        ts_note = ""
        if "TS MODE" in stats:
            mode_str = "interleaved" if int(stats.get("TS MODE", 1)) == 1 else "serial"
            ts_note = f", two-screen={mode_str} (contexts={stats.get('TS CONTEXTS', 0)}, mask={stats.get('TS SLOTS', 0)})"
        details.append(
            f"HOT counters healthy: RX={rx_obj}, TX={tx_obj}, IO ERROR={io_err}, "
            f"TIMEOUT={timeout_cnt}, MSG SEQ ERROR={seq_err} ({seq_rate * 100:.1f}%){ts_note}."
        )

    return CheckResult(
        check_id="remote.hot_radio_counters",
        title="HOT 2.4 GHz radio transport & per-slot error counters",
        category="remote",
        kind=CheckKind.AUTOMATABLE,
        tier=SafetyTier.SAFE,
        outcome=outcome,
        evidence_class=EvidenceClass.VERIFIED,
        summary=details[0],
        details=details,
        evidence={
            "rx_objects": rx_obj,
            "tx_objects": tx_obj,
            "msg_seq_error": seq_err,
            "msg_seq_error_pct": round(seq_rate * 100.0, 2),
            "timeout": timeout_cnt,
            "io_error": io_err,
            "hot_stats": stats,
        },
    )


def check_engine_activity_roundtrip(ctx: CheckContext) -> CheckResult:
    """Opt-in reversible check: start an activity via /api/activity-run and restore prior state."""
    caps = ctx.capabilities
    cfg = ctx.config

    before_resp = ctx.transport.http_request("GET", "/api/activity-state")
    ok_before, initial_id = _parse_current_activity_id(before_resp.body)
    if not before_resp.ok or not ok_before:
        return CheckResult(
            check_id="remote.engine_activity_roundtrip",
            title="Reversible HBus activity start and state restore",
            category="remote",
            kind=CheckKind.AUTOMATABLE,
            tier=SafetyTier.ACTIVE,
            outcome=CheckOutcome.FAIL,
            evidence_class=EvidenceClass.VERIFIED,
            summary="Could not read initial activity state before round-trip.",
        )

    # Pick target activity
    target_id = cfg.test_activity_id
    if not target_id:
        candidates = [aid for aid in caps.activity_ids if aid != initial_id]
        target_id = candidates[0] if candidates else "-1"

    reverted_ok = False
    mid_id = ""
    run_status = 0
    restricted_hit = False
    error_detail = ""

    try:
        form = urllib.parse.urlencode({"activityId": target_id}).encode("utf-8")
        run_resp = ctx.transport.http_request(
            "POST",
            "/api/activity-run",
            body=form,
            content_type="application/x-www-form-urlencoded",
            timeout=30,
        )
        run_status = run_resp.status
        ctx.transport.record_state_action(
            "remote.engine_activity_roundtrip",
            f"POST /api/activity-run activityId={target_id}",
            reverted=False,
            detail=f"prior activityId={initial_id}, HTTP {run_status}",
        )
        if run_status == 409 and '"restricted":true' in run_resp.body.replace(" ", ""):
            restricted_hit = True
            reverted_ok = True
        elif not run_resp.ok:
            error_detail = f"POST /api/activity-run returned HTTP {run_status}: {run_resp.body[:160]}"
        else:
            ctx.transport.sleep(1.0)
            mid_resp = ctx.transport.http_request("GET", "/api/activity-state")
            ok_mid, mid_id = _parse_current_activity_id(mid_resp.body)
            if not ok_mid or mid_id != target_id:
                error_detail = f"expected active activityId={target_id}, got {mid_id!r}"
    finally:
        if not restricted_hit:
            restore_form = urllib.parse.urlencode({"activityId": initial_id}).encode("utf-8")
            rest_resp = ctx.transport.http_request(
                "POST",
                "/api/activity-run",
                body=restore_form,
                content_type="application/x-www-form-urlencoded",
                timeout=30,
            )
            ctx.transport.sleep(1.0)
            after_resp = ctx.transport.http_request("GET", "/api/activity-state")
            ok_after, after_id = _parse_current_activity_id(after_resp.body)
            reverted_ok = rest_resp.ok and ok_after and after_id == initial_id
            ctx.transport.record_state_action(
                "remote.engine_activity_roundtrip",
                f"restore POST /api/activity-run activityId={initial_id}",
                reverted=reverted_ok,
                detail=f"after activityId={after_id}",
            )

    if restricted_hit:
        return CheckResult(
            check_id="remote.engine_activity_roundtrip",
            title="Reversible HBus activity start and state restore",
            category="remote",
            kind=CheckKind.AUTOMATABLE,
            tier=SafetyTier.ACTIVE,
            outcome=CheckOutcome.WARN,
            evidence_class=EvidenceClass.VERIFIED,
            summary=(
                f"Target activity {target_id} is currently inside an active time-restriction window "
                "(engine returned 568 / HTTP 409; state unchanged)."
            ),
            evidence={"initial_activity_id": initial_id, "target_activity_id": target_id, "restricted": True},
        )

    if error_detail or not reverted_ok:
        msg = error_detail or f"failed to restore initial activityId={initial_id}"
        return CheckResult(
            check_id="remote.engine_activity_roundtrip",
            title="Reversible HBus activity start and state restore",
            category="remote",
            kind=CheckKind.AUTOMATABLE,
            tier=SafetyTier.ACTIVE,
            outcome=CheckOutcome.FAIL,
            evidence_class=EvidenceClass.VERIFIED,
            summary=msg,
            evidence={
                "initial_activity_id": initial_id,
                "target_activity_id": target_id,
                "observed_mid_id": mid_id,
                "reverted": reverted_ok,
            },
            recovery_hint="Run PowerOff or re-select your desired activity in the Melodious Web UI.",
        )

    return CheckResult(
        check_id="remote.engine_activity_roundtrip",
        title="Reversible HBus activity start and state restore",
        category="remote",
        kind=CheckKind.AUTOMATABLE,
        tier=SafetyTier.ACTIVE,
        outcome=CheckOutcome.PASS,
        evidence_class=EvidenceClass.VERIFIED,
        summary=f"Transitioned {initial_id} -> {target_id} -> {initial_id} cleanly via HBus.",
        evidence={
            "initial_activity_id": initial_id,
            "target_activity_id": target_id,
            "reverted": True,
        },
    )


def _applies_for_hold_probe(caps: HubCapabilities) -> tuple[bool, str]:
    if not caps.webui_reachable:
        return False, "Web UI API unreachable"
    if caps.device_count <= 0:
        return False, "hub has 0 configured devices"
    return True, ""


def check_hold_to_repeat_api(ctx: CheckContext) -> CheckResult:
    """Opt-in hold-to-repeat lifecycle check (`press` -> `hold` -> `release` on /api/ir-send)."""
    hold_cfg = ctx.config.test_hold
    if hold_cfg is None:
        return CheckResult(
            check_id="remote.hold_to_repeat_api",
            title="Hold-to-repeat command lifecycle (/api/ir-send press/hold/release)",
            category="remote",
            kind=CheckKind.AUTOMATABLE,
            tier=SafetyTier.ACTIVE,
            outcome=CheckOutcome.SKIP,
            evidence_class=EvidenceClass.UNRESOLVED,
            summary="Skipped because test_hold (device_id + command) is not configured in config.local.json.",
            skip_reason="no safe test_hold device/command specified in config.local.json",
        )

    hold_id = f"hwreg{int(time.time() * 1000) % 100000000:08d}"
    steps_status: dict[str, int] = {}
    released = False
    err_msg = ""

    def _post_stage(stage: str) -> tuple[bool, int, str]:
        body = urllib.parse.urlencode(
            {
                "deviceId": hold_cfg.device_id,
                "command": hold_cfg.command,
                "status": stage,
                "holdId": hold_id,
            }
        ).encode("utf-8")
        resp = ctx.transport.http_request(
            "POST",
            "/api/ir-send",
            body=body,
            content_type="application/x-www-form-urlencoded",
        )
        ok_json = False
        if resp.ok:
            try:
                ok_json = json.loads(resp.body).get("ok") is True
            except json.JSONDecodeError:
                ok_json = False
        return resp.ok and ok_json, resp.status, resp.body[:160]

    try:
        ok_p, st_p, body_p = _post_stage("press")
        steps_status["press"] = st_p
        if not ok_p:
            err_msg = f"press failed (HTTP {st_p}: {body_p})"
        else:
            ctx.transport.sleep(0.22)
            ok_h, st_h, body_h = _post_stage("hold")
            steps_status["hold"] = st_h
            if not ok_h:
                err_msg = f"hold failed (HTTP {st_h}: {body_h})"
    finally:
        ok_r, st_r, _ = _post_stage("release")
        steps_status["release"] = st_r
        released = ok_r
        ctx.transport.record_state_action(
            "remote.hold_to_repeat_api",
            f"POST /api/ir-send press/hold/release on device {hold_cfg.device_id} ({hold_cfg.command})",
            reverted=released,
            detail=f"statuses={steps_status}",
        )

    if err_msg or not released:
        return CheckResult(
            check_id="remote.hold_to_repeat_api",
            title="Hold-to-repeat command lifecycle (/api/ir-send press/hold/release)",
            category="remote",
            kind=CheckKind.AUTOMATABLE,
            tier=SafetyTier.ACTIVE,
            outcome=CheckOutcome.FAIL,
            evidence_class=EvidenceClass.VERIFIED,
            summary=err_msg or f"release failed (HTTP {steps_status.get('release')})",
            evidence={"device_id": hold_cfg.device_id, "command": hold_cfg.command, "statuses": steps_status},
        )

    return CheckResult(
        check_id="remote.hold_to_repeat_api",
        title="Hold-to-repeat command lifecycle (/api/ir-send press/hold/release)",
        category="remote",
        kind=CheckKind.AUTOMATABLE,
        tier=SafetyTier.ACTIVE,
        outcome=CheckOutcome.PASS,
        evidence_class=EvidenceClass.VERIFIED,
        summary=f"press -> hold (220 ms) -> release succeeded cleanly on {hold_cfg.command}.",
        evidence={"device_id": hold_cfg.device_id, "command": hold_cfg.command, "statuses": steps_status},
    )


REMOTE_CHECKS: tuple[CheckSpec, ...] = (
    CheckSpec(
        check_id="remote.rf_inventory_and_maps",
        title="Paired RF remotes, pairing policy, and button-map integrity",
        category="remote",
        tier=SafetyTier.SAFE,
        description="Checks rf.info slot policy, RootButtonMap + ActivityButtonMap resolution, and action-less buttons.",
        applies_when=_applies_when_provisioned,
        run_fn=check_rf_inventory_and_maps,
    ),
    CheckSpec(
        check_id="remote.hot_radio_counters",
        title="HOT 2.4 GHz radio transport & per-slot error counters",
        category="remote",
        tier=SafetyTier.SAFE,
        description="Captures hot.stats counters and checks IO ERROR, MSG SEQ ERROR rates, and TS SLOTS bitmask.",
        applies_when=_applies_for_hot_stats,
        run_fn=check_hot_radio_counters,
    ),
    CheckSpec(
        check_id="remote.engine_activity_roundtrip",
        title="Reversible HBus activity start and state restore",
        category="remote",
        tier=SafetyTier.ACTIVE,
        description="Starts an activity via /api/activity-run and restores the prior state.",
        applies_when=_applies_when_has_activities,
        run_fn=check_engine_activity_roundtrip,
        requires_flag="allow_activity_toggle",
        recovery_hint="Re-select your previous activity or PowerOff in the Melodious Web UI.",
    ),
    CheckSpec(
        check_id="remote.hold_to_repeat_api",
        title="Hold-to-repeat command lifecycle (/api/ir-send press/hold/release)",
        category="remote",
        tier=SafetyTier.ACTIVE,
        description="Exercises press -> hold -> release on a user-designated safe command in config.local.json.",
        applies_when=_applies_for_hold_probe,
        run_fn=check_hold_to_repeat_api,
        requires_flag="allow_hold_probe",
    ),
)
