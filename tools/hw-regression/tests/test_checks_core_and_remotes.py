"""Unit tests for core health and remote->engine checks."""

from __future__ import annotations

import unittest

from hwreg.checks_core import HAL_MULTI_REMOTE_MD5
from hwreg.config import HoldProbeTarget, RunConfig
from hwreg.models import CheckOutcome, SafetyTier
from hwreg.runner import run_suite
from tests.fakes import FakeHubState, FakeHubTransport


class CoreAndRemoteCheckTests(unittest.TestCase):
    def _run_only(self, check_id: str, st: FakeHubState, cfg: RunConfig | None = None):
        rcfg = cfg or RunConfig(ssh_target="synth-hub")
        rcfg.only_checks = [check_id]
        transport = FakeHubTransport(rcfg, st)
        report, _masker, _caps = run_suite(rcfg, transport=transport)
        by_id = {r.check_id: r for r in report.results}
        return by_id[check_id], transport

    def test_boot_and_ssh_catches_melodious_off_and_dmesg_watchdog(self) -> None:
        st = FakeHubState()
        st.melodious_off = True
        st.dmesg_lines.append("NETDEV WATCHDOG: eth2 (r8152): transmit queue 0 timed out")
        res, _ = self._run_only("core.boot_and_ssh", st)
        self.assertEqual(res.outcome, CheckOutcome.FAIL)
        self.assertIn("melodious-off", " ".join(res.details))
        self.assertIn("dmesg", " ".join(res.details))

    def test_services_catches_proc_exe_md5_mismatch(self) -> None:
        st = FakeHubState()
        # Real-hub ps line uses lowercase `/usr/bin/lua main.lua ... tasks/` (truncated before harmonyengine)
        st.procs = [
            p if "luaworks" not in p else "332 root /usr/bin/lua main.lua --syslog --datadir=/data tasks/"
            for p in st.procs
        ]
        res_ok, _ = self._run_only("core.services_and_webui", st)
        self.assertEqual(res_ok.outcome, CheckOutcome.PASS)

        st.webui_exe_md5 = "ffffffffffffffffffffffffffffffff"
        res, _ = self._run_only("core.services_and_webui", st)
        self.assertEqual(res.outcome, CheckOutcome.FAIL)
        self.assertIn("/proc/<pid>/exe", res.summary)

    def test_hal_identity_passes_persistent_and_once_two_screen_and_multi_remote(self) -> None:
        # 1. Persistent two-screen
        st1 = FakeHubState()
        st1.enable_two_screen(setting="1", once_spent=False)
        res1, _ = self._run_only("core.hal_identity", st1)
        self.assertEqual(res1.outcome, CheckOutcome.PASS)

        # 2. One-boot `once` two-screen (two_screen.conf already spent to 0 by rcS.local)
        st2 = FakeHubState()
        st2.enable_two_screen(setting="once", once_spent=True)
        res2, _ = self._run_only("core.hal_identity", st2)
        self.assertEqual(res2.outcome, CheckOutcome.PASS)
        self.assertIn("once", res2.summary)

        # 3. Multi-remote alone
        st3 = FakeHubState()
        st3.multi_remote = "1"
        st3.hal_bound = True
        st3.hal_md5 = HAL_MULTI_REMOTE_MD5
        res3, _ = self._run_only("core.hal_identity", st3)
        self.assertEqual(res3.outcome, CheckOutcome.PASS)

        # 4. Watchdog trip (hal_remotes.tries >= 3) fails
        st4 = FakeHubState()
        st4.enable_two_screen(setting="1")
        st4.hal_tries = 3
        res4, _ = self._run_only("core.hal_identity", st4)
        self.assertEqual(res4.outcome, CheckOutcome.FAIL)
        self.assertIn("hal_remotes.tries", res4.summary)

    def test_cloud_blocker_catches_default_route_leak_and_flapping(self) -> None:
        st = FakeHubState()
        st.flap_routes_on_second_read = True
        res, _ = self._run_only("core.cloud_blocker_and_routes", st)
        self.assertEqual(res.outcome, CheckOutcome.FAIL)
        self.assertIn("flapping", " ".join(res.details))

    def test_rf_maps_catches_duplicate_model_without_patch_and_actionless_buttons(self) -> None:
        # Two Smart Controls on stock hal -> circular subscriber hang hazard -> FAIL
        st = FakeHubState()
        st.rf_devices.append(
            {"DeviceIndex": "2", "EquadID": "16414", "SkinId": "", "RFID": "rf-serial-alpha-02"}
        )
        res, _ = self._run_only("remote.rf_inventory_and_maps", st)
        self.assertEqual(res.outcome, CheckOutcome.FAIL)
        self.assertIn("multi-remote hal is NOT active", res.summary)

        # Action-less button in ActivityButtonMap -> freezes handset -> FAIL
        st2 = FakeHubState()
        st2.button_maps[1]["Buttons"].append({"ButtonKey": "DeadButton", "ButtonAction": None})
        res2, _ = self._run_only("remote.rf_inventory_and_maps", st2)
        self.assertEqual(res2.outcome, CheckOutcome.FAIL)
        self.assertIn("action-less", res2.summary)

        # Screen remote (16417) without a 16417Root map -> PASS (only 16414/16422/16423 use *Root)
        st3 = FakeHubState()
        st3.enable_two_screen(setting="1")
        res3, _ = self._run_only("remote.rf_inventory_and_maps", st3)
        self.assertEqual(res3.outcome, CheckOutcome.PASS)

    def test_hot_radio_counters_pass_and_io_error_fail(self) -> None:
        st = FakeHubState()
        st.enable_two_screen(setting="1")
        res_ok, _ = self._run_only("remote.hot_radio_counters", st)
        self.assertEqual(res_ok.outcome, CheckOutcome.PASS)

        st.hot_stats["S3 IO ERROR"] = 2
        res_bad, _ = self._run_only("remote.hot_radio_counters", st)
        self.assertEqual(res_bad.outcome, CheckOutcome.FAIL)
        self.assertIn("S3 IO ERROR", res_bad.summary)

    def test_activity_roundtrip_starts_and_restores_prior_state(self) -> None:
        st = FakeHubState()
        st.current_activity_id = "-1"
        cfg = RunConfig(
            ssh_target="synth-hub",
            tier=SafetyTier.ACTIVE,
            allow_state_change=True,
            allow_activity_toggle=True,
        )
        res, transport = self._run_only("remote.engine_activity_roundtrip", st, cfg)
        self.assertEqual(res.outcome, CheckOutcome.PASS)
        self.assertEqual(st.current_activity_id, "-1")
        self.assertEqual(len(transport.state_actions), 2)
        self.assertTrue(transport.state_actions[-1].reverted)

    def test_hold_to_repeat_always_releases_even_when_hold_fails(self) -> None:
        st = FakeHubState()
        st.fail_hold_stage = "hold"
        cfg = RunConfig(
            ssh_target="synth-hub",
            tier=SafetyTier.ACTIVE,
            allow_state_change=True,
            allow_hold_probe=True,
            test_hold=HoldProbeTarget(device_id="2001", command="VolumeUp"),
        )
        res, _ = self._run_only("remote.hold_to_repeat_api", st, cfg)
        self.assertEqual(res.outcome, CheckOutcome.FAIL)
        # Verify press -> hold -> release were all called so a hold never stays stuck
        stages = [c.get("status") for c in st.hold_calls]
        self.assertEqual(stages, ["press", "hold", "release"])
