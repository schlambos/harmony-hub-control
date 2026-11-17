"""Offline tests for the post-#138 (Phase 3) feature checks."""

from __future__ import annotations

import unittest

from hwreg.config import AndroidTvInputTarget, RunConfig
from hwreg.models import CheckOutcome, EvidenceClass, SafetyTier
from hwreg.report import render_json_report, render_markdown_report
from hwreg.runner import run_suite
from hwreg.transport import (
    mqtt_build_connect,
    mqtt_build_publish,
    mqtt_encode_remaining_length,
    mqtt_parse_publish,
    mqtt_read_packet,
)
from tests.fakes import FakeHubState, FakeHubTransport


def _cfg(**kwargs) -> RunConfig:
    base = {"ssh_target": "synth-hub"}
    base.update(kwargs)
    return RunConfig(**base)


def _active_cfg(**kwargs) -> RunConfig:
    base = {
        "tier": SafetyTier.ACTIVE,
        "allow_state_change": True,
        "allow_activity_toggle": True,
    }
    base.update(kwargs)
    return _cfg(**base)


class FeatureCheckTests(unittest.TestCase):
    def _run_only(self, check_id: str, st: FakeHubState, cfg: RunConfig | None = None):
        rcfg = cfg or _cfg()
        rcfg.only_checks = [check_id]
        transport = FakeHubTransport(rcfg, st)
        report, masker, caps = run_suite(rcfg, transport=transport)
        by_id = {r.check_id: r for r in report.results}
        return by_id[check_id], transport, report, masker, caps

    # --- discovery / capability gating -----------------------------------

    def test_discovery_populates_phase3_capabilities(self) -> None:
        st = FakeHubState()
        st.enable_bt()
        st.enable_usb_eth_and_integrations()
        _res, _t, _r, _m, caps = self._run_only("core.boot_and_ssh", st)
        self.assertTrue(caps.bt_pair_agent_alive)
        self.assertTrue(caps.bt_hid_daemon_alive)
        self.assertTrue(caps.bt_link_key_present)
        self.assertTrue(caps.hub_clock_known)
        self.assertEqual(caps.activity_names.get("1001"), "Synth Activity One")
        self.assertEqual(caps.ha_state_version, 7)
        self.assertFalse(caps.ha_state_stale)

    def test_bt_skips_cleanly_when_not_configured(self) -> None:
        res, *_ = self._run_only("bt.adapter_and_hid_daemon", FakeHubState())
        self.assertEqual(res.outcome, CheckOutcome.SKIP)
        self.assertTrue(res.skip_reason)

    def test_bt_passes_and_fails_on_adapter_state(self) -> None:
        st = FakeHubState()
        st.enable_bt()
        res, *_ = self._run_only("bt.adapter_and_hid_daemon", st)
        self.assertEqual(res.outcome, CheckOutcome.PASS)
        self.assertTrue(res.evidence["link_auth"])
        self.assertTrue(res.evidence["link_encrypt"])

        st2 = FakeHubState()
        st2.enable_bt()
        st2.bt_hci_up_running = False
        st2.bt_agent_alive = False
        # discovery reads procs; agent flag comes from discovery probe, so
        # also drop the proc line to keep the fake consistent.
        st2.procs = [p for p in st2.procs if "codex_bt_pair_agent" not in p]
        res2, *_ = self._run_only("bt.adapter_and_hid_daemon", st2)
        self.assertEqual(res2.outcome, CheckOutcome.FAIL)

    def test_mqtt_and_androidtv_and_adapter_skip_without_feature(self) -> None:
        st = FakeHubState()
        for check_id in (
            "mqtt.broker_roundtrip",
            "androidtv.mdns_discovery_cross_if",
            "androidtv.pair_inputs_try",
            "usb_eth.adapter_matrix",
            "remote.home_control_buttons",
        ):
            res, *_ = self._run_only(check_id, st)
            self.assertEqual(res.outcome, CheckOutcome.SKIP, check_id)
            self.assertTrue(res.skip_reason, check_id)

    # --- tier / flag gating ----------------------------------------------

    def test_nothing_state_changing_runs_at_safe_tier(self) -> None:
        st = FakeHubState()
        st.enable_bt()
        st.enable_mqtt()
        st.enable_usb_eth_and_integrations()
        for check_id in (
            "restrictions.window_and_clock_failopen",
            "mqtt.broker_roundtrip",
            "androidtv.pair_inputs_try",
            "ha.devices_commit_live",
            "core.turn_off_on_roundtrip",
            "disruptive.reboot_and_soak",
        ):
            res, *_ = self._run_only(check_id, st)
            self.assertEqual(res.outcome, CheckOutcome.SKIP, check_id)
            self.assertIn("tier", res.skip_reason, check_id)

    def test_active_checks_still_require_their_flags(self) -> None:
        st = FakeHubState()
        # Tier ACTIVE but no --allow-state-change: runner must skip.
        cfg = _cfg(tier=SafetyTier.ACTIVE)
        res, *_ = self._run_only("ha.devices_commit_live", st, cfg)
        self.assertEqual(res.outcome, CheckOutcome.SKIP)
        self.assertIn("--allow-state-change", res.skip_reason)
        # Restrictions additionally requires --allow-activity-toggle.
        cfg2 = _cfg(tier=SafetyTier.ACTIVE, allow_state_change=True)
        res2, *_ = self._run_only("restrictions.window_and_clock_failopen", st, cfg2)
        self.assertEqual(res2.outcome, CheckOutcome.SKIP)
        self.assertIn("--allow-activity-toggle", res2.skip_reason)

    def test_disruptive_definitions_are_gated_and_operator_driven(self) -> None:
        st = FakeHubState()
        st.enable_usb_eth_and_integrations()
        cfg = _cfg(
            tier=SafetyTier.DISRUPTIVE,
            allow_state_change=True,
            allow_disruptive=True,
            allow_reboot=True,
        )
        for check_id in (
            "core.turn_off_on_roundtrip",
            "core.backup_restore_drill",
            "core.recovery_ap_roundtrip",
            "disruptive.reboot_and_soak",
            "usb_eth.wifi_off_watchdog_recovery",
        ):
            res, *_ = self._run_only(check_id, st, cfg)
            self.assertEqual(res.outcome, CheckOutcome.SKIP, check_id)
            self.assertTrue(res.evidence.get("operator_driven"), check_id)
        # Without --allow-reboot the soak definition stays runner-gated.
        cfg2 = _cfg(tier=SafetyTier.DISRUPTIVE, allow_state_change=True, allow_disruptive=True)
        res2, *_ = self._run_only("disruptive.reboot_and_soak", st, cfg2)
        self.assertEqual(res2.outcome, CheckOutcome.SKIP)
        self.assertIn("--allow-reboot", res2.skip_reason)

    # --- restrictions ------------------------------------------------------

    def test_restrictions_in_window_refused_and_restored(self) -> None:
        st = FakeHubState()
        res, transport, *_ = self._run_only(
            "restrictions.window_and_clock_failopen", st, _active_cfg()
        )
        self.assertEqual(res.outcome, CheckOutcome.PASS)
        self.assertTrue(res.evidence["refused_in_window"])
        self.assertTrue(res.evidence["windows_restored"])
        self.assertEqual(st.restrictions, {})
        self.assertEqual(st.current_activity_id, "-1")

    def test_restrictions_fail_open_when_clock_unknown(self) -> None:
        st = FakeHubState()
        st.hub_epoch = 0.0
        res, *_ = self._run_only("restrictions.window_and_clock_failopen", st, _active_cfg())
        self.assertEqual(res.outcome, CheckOutcome.PASS)
        self.assertTrue(res.evidence["failopen_exercised"])
        self.assertFalse(res.evidence["refused_in_window"])
        self.assertEqual(st.current_activity_id, "-1")
        self.assertEqual(st.restrictions, {})

    # --- HA state + webhook -------------------------------------------------

    def test_ha_state_fresh_passes_stale_warns(self) -> None:
        st = FakeHubState()
        res, *_ = self._run_only("ha.state_and_webhook_roundtrip", st)
        self.assertEqual(res.outcome, CheckOutcome.PASS)
        st.ha_state_stale = True
        res2, *_ = self._run_only("ha.state_and_webhook_roundtrip", st)
        self.assertEqual(res2.outcome, CheckOutcome.WARN)

    def test_ha_webhook_roundtrip_posts_from_hub(self) -> None:
        st = FakeHubState()
        st.enable_usb_eth_and_integrations()  # HA device + webhook in ProtocolList
        st.ha_state_states = [{"key": "media_player.synth", "available": True}]
        cfg = _active_cfg(
            test_ha_device_key="media_player.synth",
            test_ha_command="turn_on",
        )
        res, transport, *_ = self._run_only("ha.state_and_webhook_roundtrip", st, cfg)
        self.assertEqual(res.outcome, CheckOutcome.PASS)
        self.assertTrue(res.evidence["webhook_exercised"])
        self.assertEqual(len(st.webhook_posts), 1)

        st.webhook_ok = False
        res2, *_ = self._run_only("ha.state_and_webhook_roundtrip", st, cfg)
        self.assertEqual(res2.outcome, CheckOutcome.FAIL)

    def test_ha_devices_commit_live_dry_run_only_with_existing_devices(self) -> None:
        st = FakeHubState()
        st.enable_usb_eth_and_integrations()  # 1 existing HA device
        res, *_ = self._run_only("ha.devices_commit_live", st, _active_cfg())
        self.assertEqual(res.outcome, CheckOutcome.WARN)
        self.assertTrue(res.evidence["dry_run_ok"])
        self.assertFalse(res.evidence["real_commit_exercised"])
        self.assertEqual(len(st.ha_device_posts), 1)
        self.assertTrue(st.ha_device_posts[0]["dryRun"])

    def test_ha_devices_commit_live_full_drill_on_scratch_hub(self) -> None:
        st = FakeHubState()
        cfg = _active_cfg(ha_webhook_url="http://192.0.2.50:8123/api/webhook/hwreg-test-hook")
        res, *_ = self._run_only("ha.devices_commit_live", st, cfg)
        self.assertEqual(res.outcome, CheckOutcome.PASS)
        self.assertTrue(res.evidence["real_commit_exercised"])
        self.assertTrue(res.evidence["scratch_removed"])
        self.assertEqual(len(st.ha_device_posts), 3)
        ha_left = [
            e for e in st.devices_with_features
            if str(((e.get("Device") or {}).get("AutoDetectedDevice") or {}).get("Id", "")).startswith("melodious-ha-")
        ]
        self.assertEqual(ha_left, [])

    # --- MQTT ---------------------------------------------------------------

    def test_mqtt_roundtrip_and_broker_down(self) -> None:
        st = FakeHubState()
        st.enable_mqtt()
        cfg = _active_cfg(mqtt_broker_host="192.0.2.60", mqtt_broker_port=1883)
        res, *_ = self._run_only("mqtt.broker_roundtrip", st, cfg)
        self.assertEqual(res.outcome, CheckOutcome.PASS)
        self.assertEqual(res.evidence["discovery_topic_count"], 1)
        self.assertEqual(len(st.mqtt_roundtrip_calls), 1)

        st.mqtt_broker_down = True
        res2, *_ = self._run_only("mqtt.broker_roundtrip", st, cfg)
        self.assertEqual(res2.outcome, CheckOutcome.FAIL)

        res3, *_ = self._run_only("mqtt.broker_roundtrip", st, _active_cfg())
        self.assertEqual(res3.outcome, CheckOutcome.SKIP)

    def test_mqtt_wire_helpers(self) -> None:
        self.assertEqual(mqtt_encode_remaining_length(0), b"\x00")
        self.assertEqual(mqtt_encode_remaining_length(300), b"\xac\x02")
        connect = mqtt_build_connect("harmony-hwreg-test", username="u", password="p")
        self.assertEqual(connect[0], 0x10)
        self.assertIn(b"harmony-hwreg-test", connect)

        packet = mqtt_build_publish("harmony/hub/state", '{"activityId":"1001"}')

        class _Sock:
            def __init__(self, data: bytes) -> None:
                self._data = data

            def recv(self, count: int) -> bytes:
                chunk, self._data = self._data[:count], self._data[count:]
                return chunk

        ptype, body = mqtt_read_packet(_Sock(packet))
        self.assertEqual(ptype, 3)
        topic, payload = mqtt_parse_publish(body)
        self.assertEqual(topic, "harmony/hub/state")
        self.assertEqual(payload, '{"activityId":"1001"}')

    # --- Android TV -----------------------------------------------------------

    def test_androidtv_discovery_and_inputs_try(self) -> None:
        st = FakeHubState()
        st.enable_usb_eth_and_integrations()
        st.androidtv_input_profiles["androidtv01"] = "method\tkeys\nslot\t1\tKEYCODE_HDMI1\tworks\t2026-01-01\n"
        res, *_ = self._run_only("androidtv.mdns_discovery_cross_if", st)
        self.assertEqual(res.outcome, CheckOutcome.PASS)
        self.assertEqual(res.evidence["discovered_count"], 1)

        res2, *_ = self._run_only("androidtv.pair_inputs_try", st, _active_cfg())
        self.assertEqual(res2.outcome, CheckOutcome.WARN)  # profiles read, Try not configured
        self.assertEqual(res2.evidence["tvs"][0]["method"], "keys")

        cfg = _active_cfg(
            test_androidtv_input=AndroidTvInputTarget(device_id="androidtv01", method="keys", value="KEYCODE_HDMI1")
        )
        res3, *_ = self._run_only("androidtv.pair_inputs_try", st, cfg)
        self.assertEqual(res3.outcome, CheckOutcome.PASS)
        self.assertTrue(res3.evidence["try_exercised"])
        self.assertEqual(len(st.androidtv_try_calls), 1)

    # --- Home control / pair-after-activities --------------------------------

    def _home_control_state(self, *, bound: bool = True) -> FakeHubState:
        st = FakeHubState()
        st.rf_devices.append(
            {"DeviceIndex": "2", "EquadID": "16422", "SkinId": "", "RFID": "rf-serial-companion-02"}
        )
        buttons = (
            [{"ButtonKey": "Ha1", "ButtonAction": {"Id": 1}}, {"ButtonKey": "Ha2", "ButtonAction": {"Id": 2}}]
            if bound
            else [{"ButtonKey": "Ha1"}]
        )
        st.button_maps.extend(
            [
                {"__type": "RootButtonMap", "ButtonMapIdentifier": "16422Root", "Buttons": buttons},
                {
                    "__type": "ActivityButtonMap",
                    "ButtonMapIdentifier": "16422Activity1001",
                    "Buttons": [{"ButtonKey": "VolumeUp", "ButtonAction": {"Id": 0}}],
                },
                {
                    "__type": "ActivityButtonMap",
                    "ButtonMapIdentifier": "16422Activity1002",
                    "Buttons": [{"ButtonKey": "VolumeUp", "ButtonAction": {"Id": 0}}],
                },
            ]
        )
        return st

    def test_home_control_preconditions_pass_and_warn(self) -> None:
        res, *_ = self._run_only("remote.home_control_buttons", self._home_control_state())
        self.assertEqual(res.outcome, CheckOutcome.PASS)
        res2, *_ = self._run_only("remote.home_control_buttons", self._home_control_state(bound=False))
        self.assertEqual(res2.outcome, CheckOutcome.WARN)

    def test_pair_after_activities_backfill(self) -> None:
        res, *_ = self._run_only(
            "remote.pair_after_activities_backfill", self._home_control_state()
        )
        self.assertEqual(res.outcome, CheckOutcome.PASS)

        st = FakeHubState()
        st.rf_devices.append(
            {"DeviceIndex": "2", "EquadID": "16422", "SkinId": "", "RFID": "rf-serial-companion-02"}
        )
        res2, *_ = self._run_only("remote.pair_after_activities_backfill", st)
        self.assertEqual(res2.outcome, CheckOutcome.FAIL)
        self.assertIn("16422Activity1001", res2.evidence["missing_activity_maps"])

    # --- Adapter matrix ------------------------------------------------------

    def test_adapter_matrix_notes_untested_chipset(self) -> None:
        st = FakeHubState()
        st.enable_usb_eth_and_integrations()  # r8152 (Realtek)
        res, *_ = self._run_only("usb_eth.adapter_matrix", st)
        self.assertEqual(res.outcome, CheckOutcome.WARN)
        self.assertFalse(res.evidence["traffic_tested"])
        st.usb_eth_driver = "asix"
        res2, *_ = self._run_only("usb_eth.adapter_matrix", st)
        self.assertEqual(res2.outcome, CheckOutcome.PASS)

    # --- Masking / report rendering for new fields -----------------------------

    def test_new_check_output_is_masked_in_reports(self) -> None:
        st = FakeHubState()
        st.enable_bt()
        st.enable_mqtt()
        st.enable_usb_eth_and_integrations()
        cfg = _active_cfg(
            mqtt_broker_host="192.0.2.60",
            mqtt_username="mqtt-secret-user",
            mqtt_password="mqtt-secret-password",
            test_ha_device_key="media_player.synth",
            test_ha_command="turn_on",
        )
        cfg.only_checks = [
            "ha.state_and_webhook_roundtrip",
            "mqtt.broker_roundtrip",
            "bt.adapter_and_hid_daemon",
        ]
        transport = FakeHubTransport(cfg, st)
        report, masker, _caps = run_suite(cfg, transport=transport)
        md = render_markdown_report(report, masker)
        js = render_json_report(report, masker)
        for secret in (
            "mqtt-secret-password",
            "mqtt-secret-user",
            "secret-hook-token-999",
            "192.0.2.50",
            "00:53:00:00:dd:10",
        ):
            self.assertNotIn(secret, md, secret)
            self.assertNotIn(secret, js, secret)
        self.assertIn("ha.state_and_webhook_roundtrip", md)
        self.assertIn("mqtt.broker_roundtrip", md)

    def test_new_hitl_checks_are_hitl_and_reported(self) -> None:
        from hwreg.checklist import HITL_CHECKS, format_printable_checklist

        ids = {h.check_id for h in HITL_CHECKS}
        for hitl_id in (
            "hitl.androidtv_pairing",
            "hitl.remote_home_control_buttons",
            "hitl.remote_pair_after_activities_backfill",
            "hitl.remote_learn_and_gesture",
            "hitl.usb_eth_adapter_matrix",
        ):
            self.assertIn(hitl_id, ids)

        st = self._home_control_state()
        st.enable_usb_eth_and_integrations()
        cfg = _cfg(
            tier=SafetyTier.DISRUPTIVE,
            allow_state_change=True,
            allow_disruptive=True,
            interactive=True,
        )
        scripted = {
            "hitl.remote_home_control_buttons": {"verdict": "pass", "note": "dimmed smoothly"},
            "hitl.remote_pair_after_activities_backfill": {"verdict": "pass", "note": "Off worked at once"},
            "hitl.remote_learn_and_gesture": {"verdict": "pass", "note": "learned Info and sent it"},
        }
        transport = FakeHubTransport(cfg, st)
        report, masker, caps = run_suite(cfg, transport=transport, scripted_hitl_responses=scripted)
        by_id = {r.check_id: r for r in report.results}
        for hitl_id, _note in scripted.items():
            self.assertEqual(by_id[hitl_id].outcome, CheckOutcome.PASS, hitl_id)
            self.assertEqual(by_id[hitl_id].evidence_class, EvidenceClass.REPORTED, hitl_id)
        checklist = format_printable_checklist(caps)
        self.assertIn("hitl.remote_home_control_buttons", checklist)
        self.assertIn("hitl.usb_eth_adapter_matrix", checklist)


if __name__ == "__main__":
    unittest.main()
