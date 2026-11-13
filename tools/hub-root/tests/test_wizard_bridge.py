# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Matthew Gibbons (Melodious — LICENSE section 2)
"""Offline unit tests for tools/hub-root/wizard_bridge.py."""

from __future__ import annotations

import contextlib
import io
import json
import pathlib
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import harmony_usb_bridge as usb  # noqa: E402
import harmony_xmpp_root_shell as lan  # noqa: E402
import wizard_bridge as wb  # noqa: E402


def parse_ndjson(text: str) -> list[dict]:
    lines = [line for line in text.splitlines() if line.strip()]
    return [json.loads(line) for line in lines]


class WizardBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.prompt_guard = patch("builtins.input", side_effect=AssertionError("wizard_bridge must never prompt"))
        self.prompt_guard.start()
        self.addCleanup(self.prompt_guard.stop)

    def test_rejects_write_or_destructive_actions(self) -> None:
        for bad_action in ("factory-reset", "usb-factory-reset", "flash-firmware", "lan-root", "provision-wifi", "enable-xmpp"):
            buf = io.StringIO()
            with self.subTest(action=bad_action), contextlib.redirect_stderr(io.StringIO()):
                rc = wb.run_wizard_bridge(["--action", bad_action], stream=buf)
            self.assertNotEqual(rc, 0)
            events = parse_ndjson(buf.getvalue())
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["type"], "error")
            self.assertEqual(events[0]["code"], "invalid_args")

    def test_probe_runs_preflight_before_sysinfo_without_nested_lock_and_keeps_stdout_pure_ndjson(self) -> None:
        call_order: list[str] = []
        lock_depth = 0

        @contextlib.contextmanager
        def tracked_lock():
            nonlocal lock_depth
            if lock_depth > 0:
                raise AssertionError("usb_process_lock entered recursively!")
            lock_depth += 1
            call_order.append("lock:enter")
            try:
                yield
            finally:
                lock_depth -= 1
                call_order.append("lock:exit")

        device = usb.DeviceInfo(
            backend="hidapi",
            path="IOService:/AppleACPIPlatformExpert/USB",
            vendor_id=0x046D,
            product_id=0xC129,
            product="Harmony Hub",
            manufacturer="Logitech",
            serial="20160903000445-001834",
        )

        def fake_raw_read_file(bridge, remote_path, packets_per_read, read_timeout_ms=25000):
            call_order.append(f"raw_read:{remote_path}")
            # Simulate raw_close_file_on_handle printing to stdout
            print("Closed /rf/deviceinfo", flush=True)
            payload = (
                'Response,{"EquadID": "34827", "RFID": "3548158187", '
                '"Devices": [{"EquadID": "16414", "SkinId": 99, "DeviceIndex": 1}], "DeviceCount": 1}\n'
            ).encode("utf-8")
            return usb.RawFileRead(device.path, remote_path, len(payload), payload, Mock(), [], Mock())

        class FakeHbusTransport:
            def __init__(self, args):
                self.args = args

            def call(self, cmd, params, timeout=20):
                with tracked_lock():
                    call_order.append(f"hbus:{cmd}")
                return {
                    "id": "1234",
                    "code": 200,
                    "data": {
                        "cmd": cmd,
                        "errorCode": "200",
                        "errorString": "OK",
                        "body": {
                            "fw_ver": "4.15.600",
                            "hw_ver": "01.00",
                            "skin": "0x6a",
                            "ram_size": "64MB",
                            "bt_addr": "00:04:20:AA:BB:CC",
                            "serial_number": "20160903000445-001834",
                        },
                    },
                }

        buf = io.StringIO()
        with (
            patch.object(usb, "usb_process_lock", side_effect=tracked_lock),
            patch.object(usb.HarmonyUsbBridge, "enumerate_devices", return_value=[device]),
            patch.object(usb, "raw_read_file", side_effect=fake_raw_read_file),
            patch.object(usb, "UsbHbusTransport", side_effect=FakeHbusTransport),
        ):
            rc = wb.run_wizard_bridge(["--action", "probe", "--usb-backend", "hidapi"], stream=buf)

        self.assertEqual(rc, 0)
        self.assertEqual(
            call_order,
            [
                "lock:enter",
                "raw_read:/rf/deviceinfo",
                "lock:exit",
                "lock:enter",
                "hbus:connect.sysinfo?get",
                "lock:exit",
            ],
        )

        events = parse_ndjson(buf.getvalue())
        self.assertTrue(any(e["type"] == "step" and e["step"] == "usb-preflight" for e in events))
        self.assertTrue(any(e["type"] == "step" and e["step"] == "usb-sysinfo" for e in events))
        result = events[-1]
        self.assertEqual(result["type"], "result")
        self.assertTrue(result["ok"])
        self.assertTrue(result["masked"])

        # Verify masking of sensitive identifiers while keeping structural info
        raw_out = buf.getvalue()
        self.assertNotIn("00:04:20:AA:BB:CC", raw_out)
        self.assertNotIn("20160903000445-001834", raw_out)
        self.assertNotIn("3548158187", raw_out)

        sysinfo = result["usb"]["sysinfo"]
        self.assertEqual(sysinfo["fwVer"], "4.15.600")
        self.assertTrue(sysinfo["firmwareMatchesGate"])
        self.assertEqual(sysinfo["skinDecimal"], 106)
        self.assertEqual(sysinfo["ramSize"], "64MB")
        self.assertTrue(sysinfo["hasBtAddr"])
        self.assertEqual(sysinfo["btAddr"], "XX:XX:XX:XX:XX:XX")

        preflight = result["usb"]["preflight"]
        self.assertFalse(preflight["hasHubId"])
        self.assertEqual(preflight["pairedDeviceCount"], 1)
        self.assertEqual(preflight["pairedDevices"][0]["skinId"], 99)

    def test_usb_wedge_detection_on_ltcp_error_or_empty_write(self) -> None:
        device = usb.DeviceInfo(backend="hidapi", path="dev0", vendor_id=0x046D, product_id=0xC129)
        for err_msg in ("LTCP hbus error frame: FF 08 FF 01 01", "hidapi write returned no bytes."):
            buf = io.StringIO()
            with (
                self.subTest(err_msg=err_msg),
                patch.object(usb, "usb_process_lock", return_value=contextlib.nullcontext()),
                patch.object(usb.HarmonyUsbBridge, "enumerate_devices", return_value=[device]),
                patch.object(usb, "raw_read_file", side_effect=usb.UsbBridgeError(err_msg)),
            ):
                rc = wb.run_wizard_bridge(["--action", "probe"], stream=buf)
            self.assertEqual(rc, 1)
            events = parse_ndjson(buf.getvalue())
            result = events[-1]
            self.assertTrue(result["usb"]["usbWedge"])

    def test_lan_provision_info_and_classify_verdicts(self) -> None:
        # 1. Fresh hub over LAN (:8088 returns only discoveryServer + se, ports 5222/8080/22 closed)
        buf = io.StringIO()
        with (
            patch.object(
                lan.HttpPostTransport,
                "call",
                return_value={
                    "id": "1",
                    "code": 200,
                    "data": {"discoveryServer": "https://svcs.myharmony.com/Discovery/Discovery.svc", "se": True},
                },
            ),
            patch.object(lan, "is_port_open", return_value=False),
        ):
            rc = wb.run_wizard_bridge(["--action", "classify", "--skip-usb", "--hub-host", "192.168.0.235"], stream=buf)
        self.assertEqual(rc, 0)
        res = parse_ndjson(buf.getvalue())[-1]
        self.assertNotIn("192.168.0.235", buf.getvalue())
        self.assertEqual(res["classification"]["verdict"], "fresh")
        self.assertFalse(res["lan"]["provisionInfo"]["provisioned"])

        # 2. Provisioned local hub (mode 3, numeric activeRemoteId, local account, 5222 closed, 22 open)
        buf = io.StringIO()
        with (
            patch.object(
                lan.HttpPostTransport,
                "call",
                return_value={
                    "id": "2",
                    "code": 200,
                    "data": {
                        "mode": 3,
                        "activeRemoteId": 20261111,
                        "accountId": "hub2-local-20261111",
                        "email": "hub2@local",
                        "se": True,
                    },
                },
            ),
            patch.object(lan, "is_port_open", side_effect=lambda _h, p, timeout=2.5: p in (8088, 22)),
        ):
            rc = wb.run_wizard_bridge(["--action", "classify", "--skip-usb", "--hub-host", "192.168.0.235"], stream=buf)
        self.assertEqual(rc, 0)
        raw = buf.getvalue()
        self.assertNotIn("20261111", raw)
        self.assertNotIn("hub2@local", raw)
        res = parse_ndjson(raw)[-1]
        self.assertEqual(res["classification"]["verdict"], "provisioned-local")
        self.assertTrue(res["classification"]["sshOpen"])
        self.assertEqual(res["lan"]["provisionInfo"]["remoteIdType"], "number")
        self.assertTrue(res["lan"]["provisionInfo"]["isLocalAccountHint"])

        # 3. Provisioned XMPP-on hub (mode 3, 5222 open, 8080 closed)
        buf = io.StringIO()
        with (
            patch.object(
                lan.HttpPostTransport,
                "call",
                return_value={
                    "id": "3",
                    "code": 200,
                    "data": {"mode": 3, "activeRemoteId": 16042906, "accountId": "10365807", "email": "owner@example.com"},
                },
            ),
            patch.object(lan, "is_port_open", side_effect=lambda _h, p, timeout=2.5: p in (8088, 5222)),
        ):
            rc = wb.run_wizard_bridge(["--action", "classify", "--skip-usb", "--hub-host", "192.168.0.100"], stream=buf)
        self.assertEqual(rc, 0)
        res = parse_ndjson(buf.getvalue())[-1]
        self.assertEqual(res["classification"]["verdict"], "provisioned-xmpp-on")

        # 4. Melodious installed (:8080 open)
        buf = io.StringIO()
        with (
            patch.object(
                lan.HttpPostTransport,
                "call",
                return_value={"id": "4", "code": 200, "data": {"mode": 3, "activeRemoteId": 16042906}},
            ),
            patch.object(lan, "is_port_open", side_effect=lambda _h, p, timeout=2.5: p in (8080, 8088, 22)),
        ):
            rc = wb.run_wizard_bridge(["--action", "classify", "--skip-usb", "--hub-host", "192.168.0.100"], stream=buf)
        self.assertEqual(rc, 0)
        res = parse_ndjson(buf.getvalue())[-1]
        self.assertEqual(res["classification"]["verdict"], "melodious-installed")


if __name__ == "__main__":
    unittest.main()
