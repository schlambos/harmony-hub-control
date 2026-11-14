"""Suite orchestrator: capability discovery, gating, check execution, and reporting."""

from __future__ import annotations

from dataclasses import dataclass
import time
from typing import Any

from . import __version__
from .checklist import HITL_CHECKS, PromptHandler, run_hitl_check
from .checks_core import CORE_CHECKS
from .checks_remotes import REMOTE_CHECKS
from .checks_usb_network import USB_AND_CROSS_CHECKS
from .config import RunConfig
from .discovery import discover_capabilities
from .masking import SecretMasker
from .models import (
    CheckKind,
    CheckOutcome,
    CheckResult,
    CheckSpec,
    EvidenceClass,
    HubCapabilities,
    SuiteReport,
)
from .report import compute_verdict
from .transport import HubTransport


ALL_AUTOMATABLE_CHECKS: tuple[CheckSpec, ...] = (
    *CORE_CHECKS,
    *REMOTE_CHECKS,
    *USB_AND_CROSS_CHECKS,
)


@dataclass
class CheckContext:
    config: RunConfig
    transport: HubTransport
    capabilities: HubCapabilities
    masker: SecretMasker


def summarize_capabilities(caps: HubCapabilities) -> dict[str, Any]:
    """Create a concise capability dictionary for the report header."""
    if caps.paired_remotes:
        rem_desc = ", ".join(
            f"slot {r.slot}: {r.name} ({r.equad_id})" for r in caps.paired_remotes
        )
    elif caps.rf_pairing_open:
        rem_desc = "pairing window open (rf.info skipped)"
    else:
        rem_desc = "0 paired"

    return {
        "ssh_reachable": caps.ssh_reachable,
        "webui_reachable": caps.webui_reachable,
        "firmware_version": caps.firmware_version,
        "kernel_release": caps.kernel_release,
        "uptime_seconds": round(caps.uptime_seconds, 1),
        "provisioned": caps.provisioned,
        "activity_count": caps.activity_count,
        "device_count": caps.device_count,
        "cloud_blocker_conf": caps.cloud_blocker_conf,
        "two_screen_conf": caps.two_screen_conf,
        "multi_remote_conf": caps.multi_remote_conf,
        "hal_bind_mounted": caps.hal_bind_mounted,
        "hal_running_md5": caps.hal_running_md5,
        "hal_gates": caps.hal_gates,
        "paired_remotes_desc": rem_desc,
        "usb_eth_conf_enabled": caps.usb_eth_conf_enabled,
        "usb_eth_state": caps.usb_eth_state,
        "usb_eth_operational": caps.usb_eth_operational,
        "usb_eth_ifname": caps.usb_eth_ifname,
        "usb_eth_driver": caps.usb_eth_driver,
        "androidtv_count": len(caps.paired_tvs),
        "ha_devices_count": caps.ha_devices_count,
        "bt_keyboard_configured": caps.bt_keyboard_configured,
        "time_restrictions_configured": caps.time_restrictions_configured,
        "mqtt_configured": caps.mqtt_configured,
    }


def _check_selected(check_id: str, config: RunConfig) -> tuple[bool, str]:
    if config.only_checks and check_id not in config.only_checks:
        return False, "filtered out by --only"
    if check_id in config.skip_checks:
        return False, "explicitly skipped via --skip"
    return True, ""


def run_suite(
    config: RunConfig,
    *,
    transport: HubTransport | None = None,
    masker: SecretMasker | None = None,
    prompt_handler: PromptHandler | None = None,
    scripted_hitl_responses: dict[str, dict[str, str]] | None = None,
) -> tuple[SuiteReport, SecretMasker, HubCapabilities]:
    """Run live capability discovery, execute applicable checks, and assemble SuiteReport."""
    started_utc = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    active_transport = transport or HubTransport(config)
    active_masker = masker or SecretMasker()

    caps = discover_capabilities(active_transport, active_masker)
    ctx = CheckContext(
        config=config,
        transport=active_transport,
        capabilities=caps,
        masker=active_masker,
    )

    results: list[CheckResult] = []

    # 1. Automatable checks
    for spec in ALL_AUTOMATABLE_CHECKS:
        selected, sel_reason = _check_selected(spec.check_id, config)
        if not selected:
            results.append(
                CheckResult(
                    check_id=spec.check_id,
                    title=spec.title,
                    category=spec.category,
                    kind=CheckKind.AUTOMATABLE,
                    tier=spec.tier,
                    outcome=CheckOutcome.SKIP,
                    evidence_class=EvidenceClass.UNRESOLVED,
                    summary=f"Skipped ({sel_reason}).",
                    skip_reason=sel_reason,
                    recovery_hint=spec.recovery_hint,
                )
            )
            continue

        applies, app_reason = spec.applies_when(caps)
        if not applies:
            results.append(
                CheckResult(
                    check_id=spec.check_id,
                    title=spec.title,
                    category=spec.category,
                    kind=CheckKind.AUTOMATABLE,
                    tier=spec.tier,
                    outcome=CheckOutcome.SKIP,
                    evidence_class=EvidenceClass.UNRESOLVED,
                    summary=f"Does not apply to this hub ({app_reason}).",
                    skip_reason=app_reason,
                    recovery_hint=spec.recovery_hint,
                )
            )
            continue

        tier_ok, tier_reason = config.check_tier_permitted(spec.tier, spec.requires_flag)
        if not tier_ok:
            results.append(
                CheckResult(
                    check_id=spec.check_id,
                    title=spec.title,
                    category=spec.category,
                    kind=CheckKind.AUTOMATABLE,
                    tier=spec.tier,
                    outcome=CheckOutcome.SKIP,
                    evidence_class=EvidenceClass.UNRESOLVED,
                    summary=f"Skipped by safety tier ({tier_reason}).",
                    skip_reason=tier_reason,
                    recovery_hint=spec.recovery_hint,
                )
            )
            continue

        t0 = time.monotonic()
        try:
            res = spec.run_fn(ctx)
        except Exception as exc:
            res = CheckResult(
                check_id=spec.check_id,
                title=spec.title,
                category=spec.category,
                kind=CheckKind.AUTOMATABLE,
                tier=spec.tier,
                outcome=CheckOutcome.FAIL,
                evidence_class=EvidenceClass.VERIFIED,
                summary=f"Unhandled exception in check: {exc}",
                recovery_hint=spec.recovery_hint,
            )
        res.duration_ms = max(0, int((time.monotonic() - t0) * 1000))
        results.append(res)

    # 2. Human-in-the-loop physical & cross-interaction checks
    for hspec in HITL_CHECKS:
        selected, sel_reason = _check_selected(hspec.check_id, config)
        if not selected:
            results.append(
                CheckResult(
                    check_id=hspec.check_id,
                    title=hspec.title,
                    category=hspec.category,
                    kind=CheckKind.HITL,
                    tier=hspec.tier,
                    outcome=CheckOutcome.SKIP,
                    evidence_class=EvidenceClass.UNRESOLVED,
                    summary=f"Skipped ({sel_reason}).",
                    skip_reason=sel_reason,
                    recovery_hint=hspec.recovery_steps,
                )
            )
            continue
        t0 = time.monotonic()
        hres = run_hitl_check(
            hspec,
            ctx,
            prompt_handler=prompt_handler,
            scripted_responses=scripted_hitl_responses,
        )
        hres.duration_ms = max(0, int((time.monotonic() - t0) * 1000))
        results.append(hres)

    finished_utc = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    verdict, verdict_reason = compute_verdict(results, ssh_reachable=caps.ssh_reachable)

    report = SuiteReport(
        suite_version=__version__,
        started_utc=started_utc,
        finished_utc=finished_utc,
        requested_tier=config.tier,
        interactive=config.interactive or bool(scripted_hitl_responses),
        verdict=verdict,
        verdict_reason=verdict_reason,
        capabilities_summary=summarize_capabilities(caps),
        results=results,
        state_actions=list(active_transport.state_actions),
    )
    return report, active_masker, caps
