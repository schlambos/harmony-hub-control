"""Unit tests for HITL checklist confirmations, report rendering, secret hygiene, and CLI."""

from __future__ import annotations

import json
from pathlib import Path
import unittest

from hwreg.checklist import format_printable_checklist
from hwreg.config import RunConfig, load_local_config
from hwreg.models import CheckOutcome, EvidenceClass, SafetyTier
from hwreg.report import render_json_report, render_markdown_report
from hwreg.runner import run_suite
import run as cli_run
from tests.fakes import FakeHubState, FakeHubTransport


SUITE_ROOT = Path(__file__).resolve().parent.parent


class HitlReportAndCliTests(unittest.TestCase):
    def test_hitl_operator_confirmations_are_marked_reported_never_verified(self) -> None:
        st = FakeHubState()
        st.enable_two_screen(setting="1")
        st.enable_usb_eth_and_integrations()

        cfg = RunConfig(
            ssh_target="synth-hub",
            ssh_key_path="/Users/contributor/.ssh/private_hub_ed25519",
            webui_username="adminuser",
            webui_password="TopSecretPassword!",
            wifi_ssid_redact=["ContributorPrivateSSID"],
            tier=SafetyTier.DISRUPTIVE,
            allow_state_change=True,
            allow_activity_toggle=True,
            allow_disruptive=True,
            interactive=True,
        )
        scripted = {
            "hitl.remote_physical_button_activity": {"verdict": "pass", "note": "Touch started Synth Activity"},
            "hitl.two_screen_simultaneous_and_follow": {"verdict": "pass", "note": "Both followed at 192.0.2.10"},
            "hitl.two_screen_sleep_wake": {"verdict": "pass", "note": "950 slept and woke cleanly"},
            "hitl.patched_hal_remote_ir_emitter": {"verdict": "skip", "note": "All devices on hub blaster"},
            "hitl.patched_hal_remote_sync": {"verdict": "pass", "note": "Synced to 100%"},
            "hitl.usb_eth_wol_physical_tv_wake": {"verdict": "pass", "note": "TV woke from deep standby"},
            "hitl.usb_eth_rj45_handback": {"verdict": "pass", "note": "RJ-45 pull handed back in 6s"},
        }

        transport = FakeHubTransport(cfg, st)
        report, masker, caps = run_suite(cfg, transport=transport, scripted_hitl_responses=scripted)

        by_id = {r.check_id: r for r in report.results}
        self.assertEqual(by_id["hitl.two_screen_simultaneous_and_follow"].outcome, CheckOutcome.PASS)
        self.assertEqual(
            by_id["hitl.two_screen_simultaneous_and_follow"].evidence_class,
            EvidenceClass.REPORTED,
        )
        self.assertEqual(
            by_id["hitl.patched_hal_remote_ir_emitter"].evidence_class,
            EvidenceClass.UNRESOLVED,
        )

        md = render_markdown_report(report, masker)
        js = render_json_report(report, masker)
        checklist_md = masker.mask_text(format_printable_checklist(caps))

        self.assertIn("[Operator-Reported]", md)
        self.assertIn("## 1. Verified", md)
        self.assertIn("## 2. Reported", md)
        self.assertIn("## 3. Unresolved", md)
        self.assertIn("NEVER hot-unplug or hot-plug the micro-USB OTG adapter", checklist_md)

        # End-to-end secret-free assertion across BOTH Markdown and JSON reports
        for secret in (
            "192.0.2.10",
            "192.0.2.20",
            "192.0.2.1",
            "192.0.2.40",
            "192.0.2.50",
            "00:53:00:00:aa:01",
            "00:53:00:00:bb:02",
            "00:53:00:00:cc:03",
            "99001122",
            "rf-serial-touch-02",
            "rf-serial-950-03",
            "private_hub_ed25519",
            "TopSecretPassword!",
            "ContributorPrivateSSID",
            "secret-hook-token-999",
        ):
            self.assertNotIn(secret, md, f"raw secret {secret!r} leaked into Markdown report")
            self.assertNotIn(secret, js, f"raw secret {secret!r} leaked into JSON report")

    def test_hitl_pass_is_downgraded_to_warn_when_hot_io_error_climbs(self) -> None:
        st = FakeHubState()
        st.enable_two_screen(setting="1")
        cfg = RunConfig(
            ssh_target="synth-hub",
            tier=SafetyTier.ACTIVE,
            allow_state_change=True,
            interactive=True,
            only_checks=["hitl.two_screen_simultaneous_and_follow"],
        )
        transport = FakeHubTransport(cfg, st)

        def _prompt(_spec):
            # Simulate HOT IO ERROR occurring during the operator's physical test
            st.hot_stats["IO ERROR"] = 3
            return "pass", "Looked fine on screen"

        report, _masker, _caps = run_suite(cfg, transport=transport, prompt_handler=_prompt)
        hitl_res = [r for r in report.results if r.check_id == "hitl.two_screen_simultaneous_and_follow"][0]
        self.assertEqual(hitl_res.outcome, CheckOutcome.WARN)
        self.assertEqual(hitl_res.evidence_class, EvidenceClass.REPORTED)
        self.assertIn("IO ERROR increased", " ".join(hitl_res.details))

    def test_example_config_is_valid_and_cli_list_checks_succeeds(self) -> None:
        example_path = SUITE_ROOT / "config.example.json"
        self.assertTrue(example_path.is_file(), "config.example.json must exist")
        cfg = load_local_config(example_path)
        self.assertTrue(cfg.effective_ssh_destination())
        self.assertEqual(cli_run.main(["--list-checks"]), 0)

    def test_suite_tree_has_no_hardcoded_private_lan_hosts_or_fixture_tokens(self) -> None:
        import re
        import subprocess

        private_host_ip_re = re.compile(
            r"\b(?:192\.168\.\d{1,3}\.(?!0\b)\d{1,3}|10\.(?!0\.0\.0\b)\d{1,3}\.\d{1,3}\.\d{1,3})\b"
        )
        repo_root = SUITE_ROOT.parent.parent

        # Also pull the repo's derived household inventory tokens from shipped_copy_hygiene.mjs
        tok_proc = subprocess.run(
            ["node", "tools/shipped_copy_hygiene.mjs", "--list-tokens"],
            cwd=repo_root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        hygiene_tokens = json.loads(tok_proc.stdout.decode("utf-8"))

        for path in SUITE_ROOT.rglob("*"):
            if not path.is_file() or "__pycache__" in path.parts:
                continue
            text = path.read_text(encoding="utf-8")
            rel = path.relative_to(SUITE_ROOT)
            m = private_host_ip_re.search(text)
            self.assertIsNone(m, f"Private LAN host IP {m.group(0) if m else ''} hardcoded in {rel}")
            for fid in hygiene_tokens.get("ids", []):
                self.assertNotIn(fid, text, f"Fixture inventory ID {fid!r} leaked in {rel}")
            for fname in hygiene_tokens.get("names", []):
                self.assertNotIn(fname.lower(), text.lower(), f"Fixture inventory name {fname!r} leaked in {rel}")

        for ignored_probe in (
            "tools/hw-regression/config.local.json",
            "tools/hw-regression/reports/sample.md",
        ):
            proc = subprocess.run(
                ["git", "check-ignore", "-q", ignored_probe],
                cwd=repo_root,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, f"{ignored_probe} must be gitignored")

