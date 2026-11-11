"""Human-in-the-loop (HITL) physical & cross-interaction checklist scaffold.

Physical button presses, screen-remote visual sync, sleep/wake transitions, IR
emission from a handset's emitter, TV panel wake-up, and RJ-45 cable pulls
cannot be proven by SSH counters alone. Each HITL check:
1. Auto-detects whether it applies to this hub's real configuration.
2. Optionally snapshots SSH/HTTP state before and after the operator's action.
3. Prompts the operator with safety rules, exact physical steps, expected
   result, and recovery instructions.
4. Marks every operator-confirmed pass/fail explicitly as `EvidenceClass.REPORTED`
   (never `Verified`), or `EvidenceClass.UNRESOLVED` when not exercised.
"""

from __future__ import annotations

import json
from typing import Any, Callable, TYPE_CHECKING

from .checks_core import HAL_TWO_SCREEN_MD5
from .models import (
    CheckKind,
    CheckOutcome,
    CheckResult,
    EvidenceClass,
    HitlCheckSpec,
    HubCapabilities,
    SafetyTier,
)

if TYPE_CHECKING:
    from .runner import CheckContext


def _snap_hot_stats(ctx: CheckContext) -> dict[str, Any]:
    res = ctx.transport.run_ssh("/data/codex/bin/codex_hal_ltcp 'hot.stats' '{}' 8 2>/dev/null || true")
    idx = res.stdout.find("{")
    if idx < 0:
        return {}
    try:
        payload = json.loads(res.stdout[idx:])
        data = payload.get("data")
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def _diff_hot_stats(ctx: CheckContext, before: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    after = _snap_hot_stats(ctx)
    if not before or not after:
        return {"hot_stats_after": after}, []
    keys = ("RX OBJECTS", "TX OBJECTS", "MSG SEQ ERROR", "TIMEOUT", "IO ERROR", "TS DROPS")
    deltas: dict[str, int] = {}
    for k in keys:
        if k in after or k in before:
            deltas[k] = int(after.get(k, 0) or 0) - int(before.get(k, 0) or 0)
    slot_deltas: dict[str, dict[str, int]] = {}
    for s in range(1, 7):
        if f"S{s} RX OBJECTS" in after:
            slot_deltas[f"S{s}"] = {
                "link_after": int(after.get(f"S{s} LINK", 0) or 0),
                "rx_delta": int(after.get(f"S{s} RX OBJECTS", 0) or 0) - int(before.get(f"S{s} RX OBJECTS", 0) or 0),
                "tx_delta": int(after.get(f"S{s} TX OBJECTS", 0) or 0) - int(before.get(f"S{s} TX OBJECTS", 0) or 0),
                "io_err_delta": int(after.get(f"S{s} IO ERROR", 0) or 0) - int(before.get(f"S{s} IO ERROR", 0) or 0),
            }
    notes: list[str] = []
    if deltas.get("IO ERROR", 0) > 0:
        notes.append(f"Counter warning: HOT IO ERROR increased by {deltas['IO ERROR']} during physical test.")
    return {"hot_counter_deltas": deltas, "per_slot_deltas": slot_deltas}, notes


def _snap_wol_log(ctx: CheckContext) -> dict[str, Any]:
    res = ctx.transport.run_ssh("grep 'Wake-on-LAN' /var/volatile/codex-androidtv.log 2>/dev/null || true")
    lines = [ln.strip() for ln in res.stdout.splitlines() if ln.strip()]
    return {"wol_lines_before": lines}


def _diff_wol_log(ctx: CheckContext, before: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    res = ctx.transport.run_ssh("grep 'Wake-on-LAN' /var/volatile/codex-androidtv.log 2>/dev/null || true")
    after_lines = [ln.strip() for ln in res.stdout.splitlines() if ln.strip()]
    prev_len = len(before.get("wol_lines_before") or [])
    new_lines = after_lines[prev_len:]
    notes: list[str] = []
    if new_lines:
        notes.append(f"Captured {len(new_lines)} new Wake-on-LAN log line(s): {new_lines[-1]}")
    return {"new_wol_log_lines": new_lines}, notes


def _applies_physical_remote(caps: HubCapabilities) -> tuple[bool, str]:
    if not caps.paired_remotes:
        return False, "0 RF remotes paired in rf.info"
    if caps.activity_count <= 0:
        return False, "0 activities configured on hub"
    return True, ""


def _applies_two_screen(caps: HubCapabilities) -> tuple[bool, str]:
    two_live = caps.two_screen_enabled or (
        caps.hal_running_md5 == HAL_TWO_SCREEN_MD5 and caps.hal_gates.startswith("1")
    )
    if not two_live:
        return False, "two-screen mode is not enabled on this hub"
    if len(caps.screen_remote_slots) < 2:
        return False, f"fewer than 2 screen remotes paired (found {len(caps.screen_remote_slots)})"
    return True, ""


def _applies_screen_sleep_wake(caps: HubCapabilities) -> tuple[bool, str]:
    if not caps.screen_remote_slots:
        return False, "no screen remote (EquadID 16417) paired on this hub"
    return True, ""


def _applies_patched_hal_screen(caps: HubCapabilities) -> tuple[bool, str]:
    if not caps.hal_bind_mounted:
        return False, "stock hal is running (no patched hal bind-mounted)"
    if not caps.screen_remote_slots:
        return False, "no screen remote (EquadID 16417) paired on this hub"
    return True, ""


def _applies_usb_wol_physical(caps: HubCapabilities) -> tuple[bool, str]:
    if not caps.usb_eth_operational:
        return False, "USB Ethernet is not operational on this hub"
    if not caps.androidtv_configured:
        return False, "no paired Android/Google TVs configured on this hub"
    return True, ""


def _applies_usb_handback(caps: HubCapabilities) -> tuple[bool, str]:
    if not caps.usb_eth_operational:
        return False, "USB Ethernet is not operational on this hub"
    if not caps.wifi_up:
        return False, "Wi-Fi lifeline (ath0) is not currently associated; refusing cable-pull check"
    return True, ""


HITL_CHECKS: tuple[HitlCheckSpec, ...] = (
    HitlCheckSpec(
        check_id="hitl.remote_physical_button_activity",
        title="Physical remote button press -> activity start, hold-to-repeat, and Off",
        category="remote",
        tier=SafetyTier.ACTIVE,
        applies_when=_applies_physical_remote,
        safety_notice="This exercises real IR/BT/IP equipment assigned to the chosen activity.",
        setup_steps=[
            "Pick one paired physical remote and ensure living-room devices may turn on safely.",
        ],
        operator_prompt=(
            "1) Start an activity from the physical remote.\n"
            "2) Hold Volume Up or Volume Down for ~1.5s to confirm smooth hold-to-repeat, then release.\n"
            "3) Press Off on the remote to power the activity off (or return to your preferred activity)."
        ),
        expected_result=(
            "Activity starts promptly, held key repeats smoothly and stops immediately on release, "
            "and Off cleanly ends the activity."
        ),
        recovery_steps="If an activity or hold sticks, open the Melodious Web UI and tap PowerOff.",
        pre_capture=_snap_hot_stats,
        post_capture=_diff_hot_stats,
    ),
    HitlCheckSpec(
        check_id="hitl.two_screen_simultaneous_and_follow",
        title="Two-screen simultaneous presses and cross-remote activity follow",
        category="two_screen",
        tier=SafetyTier.ACTIVE,
        applies_when=_applies_two_screen,
        safety_notice="Keep USB Ethernet untouched while testing; SSH survives any hal issue.",
        setup_steps=[
            "Wake both paired screen remotes (e.g. Touch and 950/Elite) so both screens are lit.",
        ],
        operator_prompt=(
            "1) Alternate button presses back and forth between Screen Remote 1 and Screen Remote 2 (~10 presses total).\n"
            "2) Start an activity on Screen Remote 1 and watch Screen Remote 2's screen.\n"
            "3) Switch or stop the activity on Screen Remote 2 and watch Screen Remote 1's screen."
        ),
        expected_result=(
            "Both remotes respond immediately without 2s collision stalls or ~60s batching; "
            "each remote's screen follows activity state changes initiated on the other; HOT IO ERROR stays 0."
        ),
        recovery_steps=(
            "If HOT radio wedges or IO ERROR climbs: "
            "ssh <hub> 'echo 0 > /data/codex/two_screen.conf; reboot' (or test --two-screen serial-once)."
        ),
        pre_capture=_snap_hot_stats,
        post_capture=_diff_hot_stats,
    ),
    HitlCheckSpec(
        check_id="hitl.two_screen_sleep_wake",
        title="Screen remote sleep/wake link transition without stalling active remote",
        category="two_screen",
        tier=SafetyTier.ACTIVE,
        applies_when=_applies_screen_sleep_wake,
        safety_notice="Read-mostly observation of radio link drop and wake resync.",
        setup_steps=[
            "Set one screen remote down untouched until its backlight turns off and it enters radio sleep (~1-2 min).",
        ],
        operator_prompt=(
            "1) While the sleeping screen remote stays untouched, trigger an activity change from the second remote "
            "(or from the Melodious Web UI if single-remote).\n"
            "2) Confirm there is no 5-second notify freeze.\n"
            "3) Pick up / wake the sleeping remote and verify its screen updates to the current activity."
        ),
        expected_result=(
            "Sleeping remote does not block notifications to awake remotes, and upon waking it "
            "cleanly displays the current activity and sends button presses."
        ),
        recovery_steps="If the waking remote stays out of sync, place it on its cradle or tap Sync in Settings.",
        pre_capture=_snap_hot_stats,
        post_capture=_diff_hot_stats,
    ),
    HitlCheckSpec(
        check_id="hitl.patched_hal_remote_ir_emitter",
        title="Patched hal <-> IR emission through a screen remote's built-in emitter",
        category="cross",
        tier=SafetyTier.ACTIVE,
        applies_when=_applies_patched_hal_screen,
        safety_notice="Applies to setups where at least one device routes IR via the screen remote emitter (hot.1).",
        setup_steps=[
            "Point the screen remote at a device configured to receive IR from the remote's emitter "
            "(if all devices use Hub/Mini-blaster only, enter 's' to skip as N/A on this setup).",
        ],
        operator_prompt=(
            "Press a safe command (e.g. Mute or Info) from the screen remote while shielding the hub's IR blaster "
            "(or in another room) so only the handset's emitter has line of sight."
        ),
        expected_result="The handset's IR emitter fires and the target device responds cleanly via ts_pick_target.",
        recovery_steps="If handset IR routing fails, reassign device IR port to Hub in Settings or disable patched hal.",
        pre_capture=_snap_hot_stats,
        post_capture=_diff_hot_stats,
    ),
    HitlCheckSpec(
        check_id="hitl.patched_hal_remote_sync",
        title="Patched hal <-> local configuration sync / file-session to screen remote",
        category="cross",
        tier=SafetyTier.ACTIVE,
        applies_when=_applies_patched_hal_screen,
        safety_notice="Exercises local HOT file session (open..close) without contacting Logitech cloud.",
        setup_steps=[
            "Wake the paired screen remote and keep it within radio range of the hub.",
        ],
        operator_prompt=(
            "Trigger a local sync on the screen remote (Settings -> Sync on the remote, or trigger Sync in "
            "the Melodious Web UI) and wait for the progress bar to reach 100%."
        ),
        expected_result=(
            "Sync completes to 100% without stalling mid-session, and buttons on the screen remote "
            "work immediately afterward."
        ),
        recovery_steps="If the remote hangs mid-sync, hold Off/Power on the handset for ~15s to reboot the handset.",
        pre_capture=_snap_hot_stats,
        post_capture=_diff_hot_stats,
    ),
    HitlCheckSpec(
        check_id="hitl.usb_eth_wol_physical_tv_wake",
        title="USB Ethernet active <-> physical Android TV Wake-on-LAN wake from deep standby",
        category="cross",
        tier=SafetyTier.ACTIVE,
        applies_when=_applies_usb_wol_physical,
        safety_notice="Turns on the paired Android/Google TV over LAN Wake-on-LAN.",
        setup_steps=[
            "Turn the paired Android/Google TV off and wait until it enters deep standby "
            "(Device page shows 'Not connected').",
        ],
        operator_prompt=(
            "Start the TV's activity (from a remote or Web UI) or tap PowerOn on the TV's device page "
            "while USB Ethernet is active."
        ),
        expected_result=(
            "codex_androidtv sends Wake-on-LAN bound to the wired interface, the TV physically powers on "
            "within ~5-20s, and reconnects over TLS."
        ),
        recovery_steps="Wake the TV with its OEM remote if WoL is disabled in the TV's network standby settings.",
        pre_capture=_snap_wol_log,
        post_capture=_diff_wol_log,
    ),
    HitlCheckSpec(
        check_id="hitl.usb_eth_rj45_handback",
        title="USB Ethernet RJ-45 unplug Wi-Fi hand-back and replug recovery",
        category="cross",
        tier=SafetyTier.DISRUPTIVE,
        applies_when=_applies_usb_handback,
        safety_notice=(
            "CRITICAL HARDWARE RULE: Unplug ONLY the RJ-45 Ethernet cable from the adapter/switch. "
            "NEVER hot-unplug or hot-plug the micro-USB OTG adapter on a powered hub (causes brownout reboot)."
        ),
        setup_steps=[
            "Confirm Wi-Fi (ath0) IP is reachable in a browser tab before touching the RJ-45 latch.",
        ],
        operator_prompt=(
            "1) Unplug ONLY the RJ-45 Ethernet patch cable (leave micro-USB OTG + power untouched).\n"
            "2) Wait ~10s and load the Melodious Web UI on the Wi-Fi address; confirm an activity/command works.\n"
            "3) Plug the RJ-45 cable back in, wait ~15s, and confirm Settings -> Ethernet reports Operational again."
        ),
        expected_result=(
            "On RJ-45 pull, usb_eth_service restores ath0's connected route (PR #128) so Wi-Fi stays reachable; "
            "on RJ-45 replug, DHCP/routing re-applies cleanly and wired traffic resumes."
        ),
        recovery_steps=(
            "If both paths stop answering for >2 minutes, power the hub off, wait 30s, ensure cables are seated, "
            "and power back on."
        ),
    ),
)


PromptHandler = Callable[[HitlCheckSpec], tuple[str, str]]


def default_cli_prompt(spec: HitlCheckSpec) -> tuple[str, str]:
    """Interactive terminal prompt returning (verdict, operator_note)."""
    print("\n" + "=" * 72)
    print(f"[HUMAN-IN-THE-LOOP] {spec.check_id}: {spec.title}")
    print(f"Safety: {spec.safety_notice}")
    for idx, step in enumerate(spec.setup_steps, start=1):
        print(f"  Prep {idx}: {step}")
    print("\nAction:")
    for ln in spec.operator_prompt.splitlines():
        print(f"  {ln}")
    print(f"\nExpected: {spec.expected_result}")
    print(f"Recovery: {spec.recovery_steps}")
    print("-" * 72)

    while True:
        try:
            raw = input("Result? [p]ass / [f]ail / [s]kip: ").strip().lower()
        except EOFError:
            return "skip", "stdin closed during prompt"
        if raw in {"p", "pass", "y", "yes"}:
            verdict = "pass"
            break
        if raw in {"f", "fail", "n", "no"}:
            verdict = "fail"
            break
        if raw in {"s", "skip", ""}:
            verdict = "skip"
            break
        print("Please enter 'p' (pass), 'f' (fail), or 's' (skip).")

    try:
        note = input("Optional operator observation/note (press Enter for none): ").strip()
    except EOFError:
        note = ""
    return verdict, note


def run_hitl_check(
    spec: HitlCheckSpec,
    ctx: CheckContext,
    *,
    prompt_handler: PromptHandler | None = None,
    scripted_responses: dict[str, dict[str, str]] | None = None,
) -> CheckResult:
    """Execute or record a single HITL check according to hub capabilities, tier, and interactivity."""
    applies, reason = spec.applies_when(ctx.capabilities)
    if not applies:
        return CheckResult(
            check_id=spec.check_id,
            title=spec.title,
            category=spec.category,
            kind=CheckKind.HITL,
            tier=spec.tier,
            outcome=CheckOutcome.SKIP,
            evidence_class=EvidenceClass.UNRESOLVED,
            summary=f"Does not apply to this hub ({reason}).",
            skip_reason=reason,
            recovery_hint=spec.recovery_steps,
        )

    # Check scripted responses (for automated harness tests or recorded operator walkthroughs)
    scripted = (scripted_responses or {}).get(spec.check_id)
    if scripted is None and not ctx.config.interactive:
        return CheckResult(
            check_id=spec.check_id,
            title=spec.title,
            category=spec.category,
            kind=CheckKind.HITL,
            tier=spec.tier,
            outcome=CheckOutcome.SKIP,
            evidence_class=EvidenceClass.UNRESOLVED,
            summary="Human-in-the-loop physical check not exercised (run with --interactive).",
            skip_reason="non-interactive run (--interactive not set)",
            recovery_hint=spec.recovery_steps,
        )

    tier_ok, tier_reason = ctx.config.check_tier_permitted(spec.tier)
    if not tier_ok:
        return CheckResult(
            check_id=spec.check_id,
            title=spec.title,
            category=spec.category,
            kind=CheckKind.HITL,
            tier=spec.tier,
            outcome=CheckOutcome.SKIP,
            evidence_class=EvidenceClass.UNRESOLVED,
            summary=f"Skipped by safety tier ({tier_reason}).",
            skip_reason=tier_reason,
            recovery_hint=spec.recovery_steps,
        )

    pre_data: dict[str, Any] = {}
    if spec.pre_capture is not None and ctx.capabilities.ssh_reachable:
        pre_data = spec.pre_capture(ctx)

    if scripted is not None:
        verdict = str(scripted.get("verdict", "skip")).strip().lower()
        op_note = str(scripted.get("note", "")).strip()
    else:
        handler = prompt_handler or default_cli_prompt
        verdict, op_note = handler(spec)

    post_data: dict[str, Any] = {}
    post_notes: list[str] = []
    if verdict in {"pass", "fail"} and spec.post_capture is not None and ctx.capabilities.ssh_reachable:
        post_data, post_notes = spec.post_capture(ctx, pre_data)

    if verdict == "pass":
        # Even if the operator saw it work, if post_capture saw a hard counter error (e.g. IO ERROR > 0),
        # surface WARN so nothing is smoothed over!
        outcome = CheckOutcome.WARN if post_notes and any("warning:" in n.lower() for n in post_notes) else CheckOutcome.PASS
        summary = f"Operator confirmed PASS.{(' ' + op_note) if op_note else ''}"
        details = [summary] + post_notes
        return CheckResult(
            check_id=spec.check_id,
            title=spec.title,
            category=spec.category,
            kind=CheckKind.HITL,
            tier=spec.tier,
            outcome=outcome,
            evidence_class=EvidenceClass.REPORTED,
            summary=summary,
            details=details,
            evidence=post_data,
            operator_note=op_note,
            recovery_hint=spec.recovery_steps,
        )

    if verdict == "fail":
        summary = f"Operator reported FAIL.{(' ' + op_note) if op_note else ''}"
        details = [summary] + post_notes
        return CheckResult(
            check_id=spec.check_id,
            title=spec.title,
            category=spec.category,
            kind=CheckKind.HITL,
            tier=spec.tier,
            outcome=CheckOutcome.FAIL,
            evidence_class=EvidenceClass.REPORTED,
            summary=summary,
            details=details,
            evidence=post_data,
            operator_note=op_note,
            recovery_hint=spec.recovery_steps,
        )

    return CheckResult(
        check_id=spec.check_id,
        title=spec.title,
        category=spec.category,
        kind=CheckKind.HITL,
        tier=spec.tier,
        outcome=CheckOutcome.SKIP,
        evidence_class=EvidenceClass.UNRESOLVED,
        summary=f"Skipped by operator{(': ' + op_note) if op_note else '.'}",
        skip_reason=op_note or "operator skipped check",
        operator_note=op_note,
        recovery_hint=spec.recovery_steps,
    )


def format_printable_checklist(caps: HubCapabilities) -> str:
    """Render a hub-tailored Markdown checklist of physical steps for an operator."""
    lines: list[str] = [
        "# Melodious Physical / Human-in-the-Loop Checklist",
        "",
        "Tailored to the detected hub configuration. Applicable items are listed first;",
        "items for features disabled on this hub are listed at the bottom as skipped.",
        "",
    ]
    applicable: list[HitlCheckSpec] = []
    skipped: list[tuple[HitlCheckSpec, str]] = []
    for spec in HITL_CHECKS:
        ok, why = spec.applies_when(caps)
        if ok:
            applicable.append(spec)
        else:
            skipped.append((spec, why))

    lines.append(f"## Applicable Physical Checks ({len(applicable)})")
    lines.append("")
    if not applicable:
        lines.append("_No physical checks apply to the detected hub state._")
        lines.append("")
    for spec in applicable:
        lines.append(f"### [ ] `{spec.check_id}` — {spec.title} _(tier: `{spec.tier.value}`)_")
        lines.append(f"- **Safety:** {spec.safety_notice}")
        for s in spec.setup_steps:
            lines.append(f"- **Setup:** {s}")
        lines.append("- **Steps:**")
        for ln in spec.operator_prompt.splitlines():
            lines.append(f"  {ln}")
        lines.append(f"- **Expected:** {spec.expected_result}")
        lines.append(f"- **Recovery:** {spec.recovery_steps}")
        lines.append("")

    lines.append(f"## Auto-Skipped for This Hub ({len(skipped)})")
    lines.append("")
    for spec, why in skipped:
        lines.append(f"- `{spec.check_id}` ({spec.title}): _{why}_")
    lines.append("")
    return "\n".join(lines)
