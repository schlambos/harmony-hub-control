"""Unit tests for live capability detection and feature-based check skipping."""

from __future__ import annotations

import unittest

from hwreg.config import RunConfig
from hwreg.discovery import discover_capabilities
from hwreg.masking import SecretMasker
from hwreg.models import CheckOutcome, EvidenceClass
from hwreg.runner import run_suite
from tests.fakes import FakeHubState, FakeHubTransport


class DiscoveryAndGatingTests(unittest.TestCase):
    def test_stock_hub_skips_usb_eth_twoscreen_and_wol_explicitly(self) -> None:
        cfg = RunConfig(ssh_target="synth-hub")
        st = FakeHubState()
        transport = FakeHubTransport(cfg, st)
        report, _masker, caps = run_suite(cfg, transport=transport)

        self.assertTrue(caps.ssh_reachable)
        self.assertFalse(caps.usb_eth_conf_enabled)
        self.assertFalse(caps.two_screen_enabled)
        self.assertEqual(len(caps.paired_remotes), 1)
        self.assertEqual(caps.paired_remotes[0].equad_id, "16414")

        by_id = {r.check_id: r for r in report.results}
        for core_id in (
            "core.boot_and_ssh",
            "core.services_and_webui",
            "core.hal_identity",
            "core.cloud_blocker_and_routes",
            "remote.rf_inventory_and_maps",
        ):
            self.assertEqual(by_id[core_id].outcome, CheckOutcome.PASS, core_id)
            self.assertEqual(by_id[core_id].evidence_class, EvidenceClass.VERIFIED)

        # Disabled features are skipped with explicit skip_reason, never silently omitted
        for skipped_id in (
            "remote.hot_radio_counters",
            "usb_eth.lifeline_and_state",
            "usb_eth.traffic_on_wire",
            "cross.usb_eth_wol_binding",
            "cross.lan_peer_reachability",
            "hitl.two_screen_simultaneous_and_follow",
            "hitl.usb_eth_wol_physical_tv_wake",
        ):
            self.assertEqual(by_id[skipped_id].outcome, CheckOutcome.SKIP, skipped_id)
            self.assertEqual(by_id[skipped_id].evidence_class, EvidenceClass.UNRESOLVED)
            self.assertTrue(by_id[skipped_id].skip_reason, f"missing skip_reason on {skipped_id}")

    def test_open_rf_pairing_window_does_not_contend_on_rf_info(self) -> None:
        cfg = RunConfig(ssh_target="synth-hub")
        st = FakeHubState()
        st.rf_pairing_open = True
        transport = FakeHubTransport(cfg, st)
        masker = SecretMasker()
        caps = discover_capabilities(transport, masker)

        self.assertTrue(caps.rf_pairing_open)
        self.assertEqual(caps.paired_remotes, [])
        # Confirm we never ran codex_hal_ltcp rf.info while pairing window was open
        for cmd in transport.ssh_commands:
            self.assertNotIn("rf.info", cmd)

    def test_ssh_unreachable_produces_clear_fail_verdict(self) -> None:
        cfg = RunConfig(ssh_target="unreachable-hub")
        st = FakeHubState()
        st.ssh_reachable = False
        transport = FakeHubTransport(cfg, st)
        report, _masker, _caps = run_suite(cfg, transport=transport)

        self.assertEqual(report.verdict, "FAIL")
        self.assertIn("unreachable", report.verdict_reason.lower())
