"""Report sanitization and PR-attachable Markdown / JSON rendering."""

from __future__ import annotations

from dataclasses import asdict
import json
from typing import Any

from .masking import SecretMasker
from .models import (
    CheckOutcome,
    CheckResult,
    EvidenceClass,
    StateActionRecord,
    SuiteReport,
)


def compute_verdict(results: list[CheckResult], *, ssh_reachable: bool) -> tuple[str, str]:
    """Compute top-line (verdict, reason) across all check outcomes."""
    if not ssh_reachable:
        return "FAIL", "Hub was unreachable over SSH; regression checks could not execute."

    failed = [r for r in results if r.outcome == CheckOutcome.FAIL]
    warned = [r for r in results if r.outcome == CheckOutcome.WARN]
    passed = [r for r in results if r.outcome == CheckOutcome.PASS]
    # Applicable checks left unexercised (e.g. non-interactive HITL or tier-gated opt-in)
    unresolved_applicable = [
        r
        for r in results
        if r.evidence_class == EvidenceClass.UNRESOLVED
        and not r.summary.startswith("Does not apply to this hub")
    ]

    if failed:
        ids = ", ".join(r.check_id for r in failed)
        return "FAIL", f"{len(failed)} check(s) failed: {ids}."
    if not passed:
        return "FAIL", "0 checks executed to PASS."
    if warned or unresolved_applicable:
        parts: list[str] = [f"{len(passed)} check(s) passed"]
        if warned:
            parts.append(f"{len(warned)} warning(s) ({', '.join(r.check_id for r in warned)})")
        if unresolved_applicable:
            parts.append(f"{len(unresolved_applicable)} applicable check(s) unresolved/unexercised")
        return "PASS WITH CAVEATS", "; ".join(parts) + "."
    return "PASS", f"All {len(passed)} applicable check(s) passed with 0 warnings."


def sanitize_report(report: SuiteReport, masker: SecretMasker) -> SuiteReport:
    """Return a deep-masked copy of SuiteReport safe to write to disk or attach to a PR."""
    masked_results: list[CheckResult] = []
    for r in report.results:
        masked_results.append(
            CheckResult(
                check_id=r.check_id,
                title=masker.mask_text(r.title),
                category=r.category,
                kind=r.kind,
                tier=r.tier,
                outcome=r.outcome,
                evidence_class=r.evidence_class,
                summary=masker.mask_text(r.summary),
                details=[masker.mask_text(d) for d in r.details],
                evidence=masker.mask_value(r.evidence),
                operator_note=masker.mask_text(r.operator_note),
                skip_reason=masker.mask_text(r.skip_reason),
                recovery_hint=masker.mask_text(r.recovery_hint),
                duration_ms=r.duration_ms,
            )
        )

    masked_actions = [
        StateActionRecord(
            timestamp_utc=a.timestamp_utc,
            check_id=a.check_id,
            action=masker.mask_text(a.action),
            reverted=a.reverted,
            detail=masker.mask_text(a.detail),
        )
        for a in report.state_actions
    ]

    return SuiteReport(
        suite_version=report.suite_version,
        started_utc=report.started_utc,
        finished_utc=report.finished_utc,
        requested_tier=report.requested_tier,
        interactive=report.interactive,
        verdict=report.verdict,
        verdict_reason=masker.mask_text(report.verdict_reason),
        capabilities_summary=masker.mask_value(report.capabilities_summary),
        results=masked_results,
        state_actions=masked_actions,
    )


def render_json_report(report: SuiteReport, masker: SecretMasker) -> str:
    """Serialize a masked SuiteReport as formatted JSON."""
    safe = sanitize_report(report, masker)
    return json.dumps(asdict(safe), indent=2, sort_keys=False) + "\n"


def render_markdown_report(report: SuiteReport, masker: SecretMasker) -> str:
    """Render a PR-attachable GitHub-Flavored Markdown hardware regression report."""
    safe = sanitize_report(report, masker)
    caps = safe.capabilities_summary

    verified = [r for r in safe.results if r.evidence_class == EvidenceClass.VERIFIED]
    reported = [r for r in safe.results if r.evidence_class == EvidenceClass.REPORTED]
    unresolved = [r for r in safe.results if r.evidence_class == EvidenceClass.UNRESOLVED]

    unresolved_pending = [
        r for r in unresolved if not r.summary.startswith("Does not apply to this hub")
    ]
    unresolved_not_applicable = [
        r for r in unresolved if r.summary.startswith("Does not apply to this hub")
    ]

    lines: list[str] = [
        "# Melodious Hardware Regression Report",
        "",
        f"- **Verdict:** **{safe.verdict}** — {safe.verdict_reason}",
        f"- **Suite version:** `{safe.suite_version}` | **Tier:** `{safe.requested_tier.value}` | "
        f"**Interactive HITL:** `{'yes' if safe.interactive else 'no'}`",
        f"- **Window (UTC):** `{safe.started_utc}` -> `{safe.finished_utc}`",
        f"- **Evidence split:** `{len(verified)}` Verified (measured) · "
        f"`{len(reported)}` Reported (operator-confirmed) · "
        f"`{len(unresolved_pending)}` Unresolved (pending) · "
        f"`{len(unresolved_not_applicable)}` Skipped (feature off on hub)",
        "",
        "## Detected Hub Profile (Masked)",
        "",
        "| Field | Detected Value |",
        "| --- | --- |",
        f"| Firmware / Kernel | `{caps.get('firmware_version') or '?'}` / `{caps.get('kernel_release') or '?'}` |",
        f"| Provisioned inventory | `{caps.get('activity_count', 0)}` activities, `{caps.get('device_count', 0)}` devices |",
        f"| HAL state | bound=`{caps.get('hal_bind_mounted')}`, md5=`{caps.get('hal_running_md5') or '?'}`, gates=`{caps.get('hal_gates') or 'none'}` |",
        f"| Conf gates | cloud_blocker=`{caps.get('cloud_blocker_conf') or 'unset'}`, two_screen=`{caps.get('two_screen_conf') or 'off'}`, multi_remote=`{caps.get('multi_remote_conf') or 'off'}` |",
        f"| Paired RF remotes | {caps.get('paired_remotes_desc') or 'none'} |",
        f"| USB Ethernet | enabled=`{caps.get('usb_eth_conf_enabled')}`, state=`{caps.get('usb_eth_state') or 'off'}`, if=`{caps.get('usb_eth_ifname') or '-'}`, driver=`{caps.get('usb_eth_driver') or '-'}` |",
        f"| Optional integrations | Android TV=`{caps.get('androidtv_count', 0)}`, HA devices=`{caps.get('ha_devices_count', 0)}`, BT keyboard=`{caps.get('bt_keyboard_configured')}`, Time restrictions=`{caps.get('time_restrictions_configured')}` |",
        "",
        "## 1. Verified (Suite-Measured over SSH / HTTP / Counters)",
        "",
    ]

    if not verified:
        lines.append("_No automated checks completed._")
        lines.append("")
    else:
        lines.extend(
            [
                "| Check | Outcome | Tier | Summary |",
                "| --- | --- | --- | --- |",
            ]
        )
        for r in verified:
            lines.append(
                f"| `{r.check_id}` | **{r.outcome.value}** | `{r.tier.value}` | {r.summary} |"
            )
        lines.append("")

    lines.extend(
        [
            "## 2. Reported (Operator-Confirmed Physical / Human-in-the-Loop)",
            "",
        ]
    )
    if not reported:
        lines.append(
            "_No operator-confirmed physical checks recorded in this run "
            "(re-run with `--interactive` to capture human-in-the-loop confirmations)._"
        )
        lines.append("")
    else:
        lines.extend(
            [
                "| Check | Outcome | Tag | Operator Confirmation & Counter Notes |",
                "| --- | --- | --- | --- |",
            ]
        )
        for r in reported:
            joined = " ".join(r.details) if r.details else r.summary
            lines.append(
                f"| `{r.check_id}` | **{r.outcome.value}** | `[Operator-Reported]` | {joined} |"
            )
        lines.append("")

    lines.extend(
        [
            "## 3. Unresolved & Clearly Skipped Checks",
            "",
        ]
    )
    if not unresolved_pending and not unresolved_not_applicable:
        lines.append("_None — every registered check ran._")
        lines.append("")
    else:
        if unresolved_pending:
            lines.append("### Applicable to This Hub, Not Exercised in This Run")
            lines.append("")
            for r in unresolved_pending:
                lines.append(f"- **`{r.check_id}`** ({r.title}) — _{r.skip_reason or r.summary}_")
            lines.append("")
        if unresolved_not_applicable:
            lines.append("### Skipped Because Feature Is Not Enabled / Configured on This Hub")
            lines.append("")
            for r in unresolved_not_applicable:
                lines.append(f"- `{r.check_id}` ({r.title}) — _{r.skip_reason}_")
            lines.append("")

    lines.extend(
        [
            "## 4. Hub State-Change Audit Log",
            "",
        ]
    )
    if not safe.state_actions:
        lines.append("- `None` — strictly read-only execution (zero hub writes or state changes).")
    else:
        for act in safe.state_actions:
            rev_str = "reverted=yes" if act.reverted else "reverted=no"
            extra = f" ({act.detail})" if act.detail else ""
            lines.append(f"- `{act.timestamp_utc}` [`{act.check_id}`] {act.action} — **{rev_str}**{extra}")
    lines.append("")

    # Collapsible masked evidence blocks
    with_ev = [r for r in (verified + reported) if r.evidence]
    if with_ev:
        lines.extend(
            [
                "## 5. Captured Evidence (Masked)",
                "",
            ]
        )
        for r in with_ev:
            ev_tag = "[Operator-Reported + Counters]" if r.evidence_class == EvidenceClass.REPORTED else "[Verified]"
            lines.append(f"<details><summary><code>{r.check_id}</code> ({r.outcome.value}) {ev_tag}</summary>")
            lines.append("")
            lines.append("```json")
            lines.append(json.dumps(r.evidence, indent=2, sort_keys=False))
            lines.append("```")
            lines.append("</details>")
            lines.append("")

    return "\n".join(lines)
