"""Unit tests for USB Ethernet traffic-on-wire and cross-subsystem checks."""

from __future__ import annotations

import unittest

from hwreg.config import RunConfig
from hwreg.models import CheckOutcome, SafetyTier
from hwreg.runner import run_suite
from tests.fakes import FakeHubState, FakeHubTransport


class UsbEthernetAndCrossInteractionTests(unittest.TestCase):
    def _run_only(self, check_id: str, st: FakeHubState, cfg: RunConfig | None = None):
        rcfg = cfg or RunConfig(ssh_target="synth-hub")
        rcfg.only_checks = [check_id]
        transport = FakeHubTransport(rcfg, st)
        report, _masker, _caps = run_suite(rcfg, transport=transport)
        by_id = {r.check_id: r for r in report.results}
        return by_id[check_id], transport

    def test_usb_eth_healthy_wired_traffic_and_state_pass(self) -> None:
        st = FakeHubState()
        st.enable_usb_eth_and_integrations()

        r_state, _ = self._run_only("usb_eth.lifeline_and_state", st)
        self.assertEqual(r_state.outcome, CheckOutcome.PASS)

        r_wire, _ = self._run_only("usb_eth.traffic_on_wire", st)
        self.assertEqual(r_wire.outcome, CheckOutcome.PASS)
        self.assertGreaterEqual(r_wire.evidence["wired_counter_deltas"]["tx_packets"], 6)
        self.assertTrue(r_wire.evidence["host_arp_matched_wired_mac"])

    def test_usb_eth_catches_false_validation_wifi_reply_leak(self) -> None:
        """Exact regression from 2026-11-10 health check: HTTP 200 succeeds, but replies leave via Wi-Fi!"""
        st = FakeHubState()
        st.enable_usb_eth_and_integrations()
        st.simulate_wifi_leak_on_wired_http = True
        st.host_arp_table[st.usb_eth_ip] = st.wifi_mac

        res, _ = self._run_only("usb_eth.traffic_on_wire", st)
        self.assertEqual(res.outcome, CheckOutcome.FAIL)
        joined = " ".join(res.details)
        self.assertIn("leaked over Wi-Fi", joined)
        self.assertIn("ARP table maps wired IP to Wi-Fi MAC", joined)

    def test_usb_eth_catches_missing_arp_isolation_sysctls(self) -> None:
        st = FakeHubState()
        st.enable_usb_eth_and_integrations()
        st.arp_sysctls["eth2_arp_ignore"] = "0"

        res, _ = self._run_only("usb_eth.lifeline_and_state", st)
        self.assertEqual(res.outcome, CheckOutcome.FAIL)
        self.assertIn("ARP isolation sysctls missing", res.summary)

    def test_wol_cross_check_safe_and_live_opt_in_dispatch(self) -> None:
        st = FakeHubState()
        st.enable_usb_eth_and_integrations()

        # 1. Safe read-only verification
        res_safe, _ = self._run_only("cross.usb_eth_wol_binding", st)
        self.assertEqual(res_safe.outcome, CheckOutcome.PASS)
        self.assertIn("eth2", res_safe.evidence["eligible_wol_interfaces"])
        self.assertFalse(res_safe.evidence["live_wol_dispatched"])

        # 2. Active --allow-wol live dispatch verifies (eth2) in codex-androidtv.log
        cfg_wol = RunConfig(
            ssh_target="synth-hub",
            tier=SafetyTier.ACTIVE,
            allow_state_change=True,
            allow_wol=True,
        )
        res_live, _ = self._run_only("cross.usb_eth_wol_binding", st, cfg_wol)
        self.assertEqual(res_live.outcome, CheckOutcome.PASS)
        self.assertTrue(res_live.evidence["live_wol_dispatched"])
        self.assertIn("(eth2)", res_live.evidence["live_wol_log_line"])

        # 3. Regression (PR #126): WoL sent only via ath0, missing (eth2) -> FAIL
        st_bad = FakeHubState()
        st_bad.enable_usb_eth_and_integrations()
        st_bad.wol_append_on_power_cmd = "sent Wake-on-LAN to 00:53:00:00:cc:03 via 192.0.2.255 (ath0)"
        cfg_wol2 = RunConfig(
            ssh_target="synth-hub",
            tier=SafetyTier.ACTIVE,
            allow_state_change=True,
            allow_wol=True,
        )
        res_bad, _ = self._run_only("cross.usb_eth_wol_binding", st_bad, cfg_wol2)
        self.assertEqual(res_bad.outcome, CheckOutcome.FAIL)
        self.assertIn("did not bind to wired interface eth2", res_bad.summary)

    def test_lan_peer_reachability_catches_pr128_net_remove_route_bug(self) -> None:
        st = FakeHubState()
        st.enable_usb_eth_and_integrations()

        res_ok, _ = self._run_only("cross.lan_peer_reachability", st)
        self.assertEqual(res_ok.outcome, CheckOutcome.PASS)
        roles = [p["role"] for p in res_ok.evidence["peers"]]
        self.assertIn("ha_webhook", roles)

        # Simulate USB-eth stopped, but net-remove left dead eth2 metric 0 ahead of ath0 metric 20
        st.usb_eth_state = "stopped"
        st.usb_eth_ip = ""

        res, _ = self._run_only("cross.lan_peer_reachability", st)
        self.assertEqual(res.outcome, CheckOutcome.FAIL)
        self.assertIn("net-remove route hand-back regression", res.summary)
