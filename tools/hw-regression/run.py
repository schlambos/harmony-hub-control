#!/usr/bin/env python3
"""CLI entry point for the Melodious portable hardware regression suite.

Usage examples:

  # 1. Default safe read-only pass (writes masked PR-attachable Markdown report):
  python3 tools/hw-regression/run.py

  # 2. Print the hub-tailored physical checklist without running interactive prompts:
  python3 tools/hw-regression/run.py --print-checklist

  # 3. Interactive run (automatable checks + operator physical confirmations + reversible activity toggle):
  python3 tools/hw-regression/run.py --tier active --allow-state-change --allow-activity-toggle --interactive

  # 4. Run the offline unit-test suite (no hub required):
  python3 tools/hw-regression/run.py --self-test
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import time
import unittest

SUITE_DIR = Path(__file__).resolve().parent
if str(SUITE_DIR) not in sys.path:
    sys.path.insert(0, str(SUITE_DIR))

from hwreg.checklist import HITL_CHECKS, format_printable_checklist  # noqa: E402
from hwreg.config import DEFAULT_LOCAL_CONFIG_NAME, load_local_config  # noqa: E402
from hwreg.discovery import discover_capabilities  # noqa: E402
from hwreg.masking import SecretMasker  # noqa: E402
from hwreg.models import SafetyTier  # noqa: E402
from hwreg.report import render_json_report, render_markdown_report, sanitize_report  # noqa: E402
from hwreg.runner import ALL_AUTOMATABLE_CHECKS, run_suite  # noqa: E402
from hwreg.transport import HubTransport  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="tools/hw-regression/run.py",
        description="Portable, hub-agnostic hardware regression suite for Melodious.",
    )
    p.add_argument(
        "--config",
        type=Path,
        default=SUITE_DIR / DEFAULT_LOCAL_CONFIG_NAME,
        help=f"Path to gitignored local hub config JSON (default: tools/hw-regression/{DEFAULT_LOCAL_CONFIG_NAME})",
    )
    p.add_argument(
        "--tier",
        choices=[t.value for t in SafetyTier],
        default=SafetyTier.SAFE.value,
        help="Maximum safety tier to execute (default: safe = strictly read-only).",
    )
    p.add_argument(
        "--allow-state-change",
        action="store_true",
        help="Explicit per-run opt-in required for reversible active-tier checks.",
    )
    p.add_argument(
        "--allow-activity-toggle",
        action="store_true",
        help="Permit remote.engine_activity_roundtrip to start and restore an activity.",
    )
    p.add_argument(
        "--allow-hold-probe",
        action="store_true",
        help="Permit remote.hold_to_repeat_api to send press/hold/release to test_hold in config.",
    )
    p.add_argument(
        "--allow-wol",
        action="store_true",
        help="Permit cross.usb_eth_wol_binding to dispatch a live Wake-on-LAN packet to a disconnected TV.",
    )
    p.add_argument(
        "--allow-disruptive",
        action="store_true",
        help="Explicit per-run opt-in required for disruptive-tier checks (e.g. RJ-45 pull drill).",
    )
    p.add_argument(
        "--allow-reboot",
        action="store_true",
        help="Explicit per-run opt-in required for any future reboot check (never implied).",
    )
    p.add_argument(
        "--interactive",
        action="store_true",
        help="Prompt the operator step-by-step for applicable human-in-the-loop physical checks.",
    )
    p.add_argument(
        "--responses-file",
        type=Path,
        default=None,
        help="Optional JSON file mapping HITL check_id -> {verdict, note} for scripted walkthroughs.",
    )
    p.add_argument(
        "--only",
        action="append",
        default=[],
        metavar="CHECK_ID",
        help="Run only the named check ID (repeatable).",
    )
    p.add_argument(
        "--skip",
        action="append",
        default=[],
        metavar="CHECK_ID",
        help="Skip the named check ID (repeatable).",
    )
    p.add_argument(
        "--list-checks",
        action="store_true",
        help="List all registered automatable and human-in-the-loop checks and exit.",
    )
    p.add_argument(
        "--print-checklist",
        action="store_true",
        help="Discover hub capabilities read-only and print the tailored physical checklist as Markdown.",
    )
    p.add_argument(
        "--self-test",
        action="store_true",
        help="Run the offline unit-test suite (no hub connection required) and exit.",
    )
    p.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Path for masked Markdown report (default: tools/hw-regression/reports/hw-report-<timestamp>.md).",
    )
    p.add_argument(
        "--json-out",
        type=Path,
        default=None,
        help="Optional path for masked JSON report.",
    )
    return p


def _list_checks() -> int:
    print("Automatable checks:")
    for spec in ALL_AUTOMATABLE_CHECKS:
        extra = f" (flag: --{spec.requires_flag.replace('_', '-')})" if spec.requires_flag else ""
        print(f"  {spec.check_id:<34} [{spec.tier.value:<10}] {spec.title}{extra}")
    print("\nHuman-in-the-loop (physical) checks:")
    for hspec in HITL_CHECKS:
        print(f"  {hspec.check_id:<34} [{hspec.tier.value:<10}] {hspec.title}")
    return 0


def _run_self_tests() -> int:
    loader = unittest.TestLoader()
    suite = loader.discover(start_dir=str(SUITE_DIR / "tests"), top_level_dir=str(SUITE_DIR), pattern="test_*.py")
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.list_checks:
        return _list_checks()
    if args.self_test:
        return _run_self_tests()

    try:
        cfg = load_local_config(args.config)
    except (FileNotFoundError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    cfg.tier = SafetyTier(args.tier)
    cfg.allow_state_change = bool(args.allow_state_change)
    cfg.allow_activity_toggle = bool(args.allow_activity_toggle)
    cfg.allow_hold_probe = bool(args.allow_hold_probe)
    cfg.allow_wol = bool(args.allow_wol)
    cfg.allow_disruptive = bool(args.allow_disruptive)
    cfg.allow_reboot = bool(args.allow_reboot)
    cfg.interactive = bool(args.interactive)
    cfg.only_checks = list(args.only or [])
    cfg.skip_checks = list(args.skip or [])

    if args.print_checklist:
        masker = SecretMasker()
        transport = HubTransport(cfg)
        caps = discover_capabilities(transport, masker)
        if not caps.ssh_reachable:
            print("error: could not reach hub over SSH to tailor checklist.", file=sys.stderr)
            return 1
        print(masker.mask_text(format_printable_checklist(caps)))
        return 0

    scripted_responses: dict[str, dict[str, str]] | None = None
    if args.responses_file is not None:
        raw = json.loads(args.responses_file.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            print("error: --responses-file must contain a JSON object", file=sys.stderr)
            return 2
        scripted_responses = raw

    report, masker, _caps = run_suite(
        cfg,
        scripted_hitl_responses=scripted_responses,
    )
    safe_report = sanitize_report(report, masker)
    md_text = render_markdown_report(report, masker)

    out_path: Path = args.out or (
        SUITE_DIR / "reports" / f"hw-report-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}.md"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(md_text, encoding="utf-8")

    if args.json_out is not None:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(render_json_report(report, masker), encoding="utf-8")

    print(f"Verdict: {safe_report.verdict} — {safe_report.verdict_reason}")
    for r in safe_report.results:
        if r.summary.startswith("Does not apply to this hub"):
            continue
        print(f"  [{r.outcome.value:<4}] ({r.evidence_class.value:<10}) {r.check_id}: {r.summary}")
    print(f"\nMasked Markdown report written to: {out_path}")
    if args.json_out is not None:
        print(f"Masked JSON report written to:     {args.json_out}")

    return 1 if safe_report.verdict == "FAIL" else 0


if __name__ == "__main__":
    raise SystemExit(main())
