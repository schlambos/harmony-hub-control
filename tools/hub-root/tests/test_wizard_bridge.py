# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Matthew Gibbons (Melodious — LICENSE section 2)
"""Offline unit tests for tools/hub-root/wizard_bridge.py (Slice 1 + Slice 2)."""

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


def make_test_device() -> usb.DeviceInfo:
    return usb.DeviceInfo(
        backend="hidapi",
        path="IOService:/AppleACPIPlatformExpert/USB",
        vendor_id=0x046D,
        product_id=0xC129,
        product="Harmony Hub",
        manufacturer="Logitech",
        serial="20160903000445-001834",
    )


class WizardBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.prompt_guard = patch("builtins.input", side_effect=AssertionError("wizard_bridge must never prompt"))
        self.prompt_guard.start()
        self.addCleanup(self.prompt_guard.stop)

    def test_rejects_unknown_actions_and_unconfirmed_mutating_actions(self) -> None:
        for bad_action in ("factory-reset", "flash-firmware", "lan-root", "provision-wifi", "enable-xmpp"):
            buf = io.StringIO()
            with self.subTest(action=bad_action), contextlib.redirect_stderr(io.StringIO()):
                rc = wb.run_wizard_bridge(["--action", bad_action], stream=buf)
            self.assertNotEqual(rc, 0)
            events = parse_ndjson(buf.getvalue())
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["type"], "error")
            self.assertEqual(events[0]["code"], "invalid_args")

        for mutating in wb.MUTATING_ACTIONS:
            buf = io.StringIO()
            with self.subTest(unconfirmed=mutating):
                rc = wb.run_wizard_bridge(["--action", mutating], stream=buf)
            self.assertEqual(rc, 2)
            events = parse_ndjson(buf.getvalue())
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["type"], "error")
            self.assertEqual(events[0]["code"], "confirmation_required")

        # post-root requires BOTH --confirm-action post-root AND --allow-unproven-post
        buf = io.StringIO()
        rc = wb.run_wizard_bridge(["--action", "post-root", "--confirm-action", "post-root"], stream=buf)
        self.assertEqual(rc, 2)
        events = parse_ndjson(buf.getvalue())
        self.assertEqual(events[0]["code"], "unproven_post_blocked")

    def test_probe_runs_preflight_sysinfo_provisioninfo_discoveryinfo_without_nested_lock(self) -> None:
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

        device = make_test_device()

        def fake_raw_read_file(bridge, remote_path, packets_per_read, read_timeout_ms=25000):
            call_order.append(f"raw_read:{remote_path}")
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
                if cmd == "connect.sysinfo?get":
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
                if cmd == "setup.account?getProvisionInfo":
                    return {
                        "id": "1235",
                        "code": 200,
                        "data": {
                            "discoveryServer": "https://svcs.myharmony.com/Discovery/Discovery.svc",
                            "se": True,
                        },
                    }
                if cmd == "connect.discoveryinfo?get":
                    return {
                        "id": "1236",
                        "code": 200,
                        "data": {
                            "current_fw_version": "4.15.600",
                            "friendlyName": "Harmony Hub",
                            "productId": "Pimento",
                            "hubId": "106",
                            "mode": "",
                            "remoteId": "",
                            "accountId": "",
                            "email": "unknown",
                            "ip": "",
                            "uuid": "09fa6ff8df543a15ebaa1fe2b36bc345b8a3bada",
                        },
                    }
                raise AssertionError(f"Unexpected hbus cmd: {cmd}")

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
                "lock:enter",
                "hbus:setup.account?getProvisionInfo",
                "lock:exit",
                "lock:enter",
                "hbus:connect.discoveryinfo?get",
                "lock:exit",
            ],
        )

        events = parse_ndjson(buf.getvalue())
        self.assertTrue(any(e["type"] == "step" and e["step"] == "usb-preflight" for e in events))
        self.assertTrue(any(e["type"] == "step" and e["step"] == "usb-sysinfo" for e in events))
        self.assertTrue(any(e["type"] == "step" and e["step"] == "usb-provision-info" for e in events))
        self.assertTrue(any(e["type"] == "step" and e["step"] == "usb-discovery-info" for e in events))
        result = events[-1]
        self.assertEqual(result["type"], "result")
        self.assertTrue(result["ok"])
        self.assertTrue(result["masked"])

        raw_out = buf.getvalue()
        self.assertNotIn("00:04:20:AA:BB:CC", raw_out)
        self.assertNotIn("20160903000445-001834", raw_out)
        self.assertNotIn("3548158187", raw_out)
        self.assertNotIn("09fa6ff8df543a15ebaa1fe2b36bc345b8a3bada", raw_out)

        sysinfo = result["usb"]["sysinfo"]
        self.assertEqual(sysinfo["fwVer"], "4.15.600")
        self.assertTrue(sysinfo["firmwareMatchesGate"])
        self.assertEqual(sysinfo["skinDecimal"], 106)
        self.assertEqual(sysinfo["ramSize"], "64MB")
        self.assertFalse(result["usb"]["provisionInfo"]["provisioned"])
        self.assertFalse(result["usb"]["discoveryInfo"]["provisioned"])

    def test_offline_usb_classification_wifiless_provisioned_vs_fresh(self) -> None:
        device = make_test_device()

        def fake_preflight_no_hub_id(bridge, remote_path, packets_per_read, read_timeout_ms=25000):
            payload = b'Response,{"EquadID": "34827", "RFID": "3548158187", "Devices": [], "DeviceCount": 0}\n'
            return usb.RawFileRead(device.path, remote_path, len(payload), payload, Mock(), [], Mock())

        # Case 1: Wi-Fi-less hub that IS provisioned to an account (detected via USB getProvisionInfo/discoveryinfo)
        class ProvisionedUsbHbus:
            def __init__(self, args):
                self.args = args

            def call(self, cmd, params, timeout=20):
                if cmd == "connect.sysinfo?get":
                    return {"id": "1", "code": 200, "data": {"fw_ver": "4.15.600", "skin": "0x6a", "ram_size": "64MB"}}
                if cmd == "setup.account?getProvisionInfo":
                    return {
                        "id": "2",
                        "code": 200,
                        "data": {
                            "mode": 3,
                            "activeRemoteId": 13386460,
                            "accountId": "11745631",
                            "email": "previous.owner@example.com",
                            "discoveryServer": "https://svcs.myharmony.com/Discovery/Discovery.svc",
                            "se": True,
                        },
                    }
                if cmd == "connect.discoveryinfo?get":
                    return {
                        "id": "3",
                        "code": 200,
                        "data": {
                            "current_fw_version": "4.15.600",
                            "friendlyName": "Living Room Hub",
                            "productId": "Pimento",
                            "hubId": "106",
                            "mode": "3",
                            "remoteId": "13386460",
                            "accountId": "11745631",
                            "email": "previous.owner@example.com",
                            "ip": "",
                            "uuid": "09fa6ff8df543a15ebaa1fe2b36bc345b8a3bada",
                        },
                    }
                raise AssertionError(cmd)

        buf = io.StringIO()
        with (
            patch.object(usb, "usb_process_lock", return_value=contextlib.nullcontext()),
            patch.object(usb.HarmonyUsbBridge, "enumerate_devices", return_value=[device]),
            patch.object(usb, "raw_read_file", side_effect=fake_preflight_no_hub_id),
            patch.object(usb, "UsbHbusTransport", side_effect=ProvisionedUsbHbus),
        ):
            rc = wb.run_wizard_bridge(["--action", "classify"], stream=buf)
        self.assertEqual(rc, 0)
        raw_out = buf.getvalue()
        self.assertNotIn("13386460", raw_out)
        self.assertNotIn("11745631", raw_out)
        self.assertNotIn("previous.owner@example.com", raw_out)
        res = parse_ndjson(raw_out)[-1]
        self.assertEqual(res["classification"]["verdict"], "provisioned-local")
        self.assertTrue(res["classification"]["usbProvisioned"])
        self.assertTrue(res["usb"]["provisionInfo"]["provisioned"])
        self.assertEqual(res["usb"]["provisionInfo"]["remoteIdType"], "number")
        self.assertTrue(res["usb"]["discoveryInfo"]["provisioned"])

        # Case 2: Wi-Fi-less fresh / factory-reset hub over USB
        class FreshUsbHbus:
            def __init__(self, args):
                self.args = args

            def call(self, cmd, params, timeout=20):
                if cmd == "connect.sysinfo?get":
                    return {"id": "1", "code": 200, "data": {"fw_ver": "4.15.600", "skin": "0x6a", "ram_size": "64MB"}}
                if cmd == "setup.account?getProvisionInfo":
                    return {
                        "id": "2",
                        "code": 200,
                        "data": {"discoveryServer": "https://svcs.myharmony.com/Discovery/Discovery.svc", "se": True},
                    }
                if cmd == "connect.discoveryinfo?get":
                    return {
                        "id": "3",
                        "code": 200,
                        "data": {
                            "current_fw_version": "4.15.600",
                            "friendlyName": "Harmony Hub",
                            "productId": "Pimento",
                            "hubId": "106",
                            "mode": "",
                            "remoteId": "",
                            "accountId": "",
                            "email": "unknown",
                            "ip": "",
                        },
                    }
                raise AssertionError(cmd)

        buf = io.StringIO()
        with (
            patch.object(usb, "usb_process_lock", return_value=contextlib.nullcontext()),
            patch.object(usb.HarmonyUsbBridge, "enumerate_devices", return_value=[device]),
            patch.object(usb, "raw_read_file", side_effect=fake_preflight_no_hub_id),
            patch.object(usb, "UsbHbusTransport", side_effect=FreshUsbHbus),
        ):
            rc = wb.run_wizard_bridge(["--action", "classify"], stream=buf)
        self.assertEqual(rc, 0)
        res = parse_ndjson(buf.getvalue())[-1]
        self.assertEqual(res["classification"]["verdict"], "fresh")
        self.assertFalse(res["classification"]["usbProvisioned"])
        self.assertFalse(res["usb"]["provisionInfo"]["provisioned"])
        self.assertFalse(res["usb"]["discoveryInfo"]["provisioned"])

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

    def test_wifi_scan_and_stdin_wifi_connect_never_leak_secret_to_argv_or_ndjson(self) -> None:
        device = make_test_device()

        # 1. CLI must reject --wifi-password on argv
        buf = io.StringIO()
        with contextlib.redirect_stderr(io.StringIO()):
            rc = wb.run_wizard_bridge(
                ["--action", "usb-wifi-connect", "--confirm-action", "usb-wifi-connect", "--wifi-password", "NopeSecret"],
                stream=buf,
            )
        self.assertNotEqual(rc, 0)
        self.assertNotIn("NopeSecret", buf.getvalue())

        # 2. usb-wifi-scan reads /wifi/networks
        scan_data = b"item,1\nencryption,WPA2-PSK\nssid,MyHomeNet\nchannel,2412\nsignal_strength,190\n"
        scan_read = usb.RawFileRead(device.path, usb.RAW_WIFI_NETWORKS_PATH, len(scan_data), scan_data, Mock(), [], Mock())
        buf = io.StringIO()
        with (
            patch.object(usb, "usb_process_lock", return_value=contextlib.nullcontext()),
            patch.object(usb.HarmonyUsbBridge, "enumerate_devices", return_value=[device]),
            patch.object(usb, "raw_read_file", return_value=scan_read),
        ):
            rc = wb.run_wizard_bridge(["--action", "usb-wifi-scan"], stream=buf)
        self.assertEqual(rc, 0)
        scan_res = parse_ndjson(buf.getvalue())[-1]
        self.assertEqual(scan_res["wifiScan"]["networkCount"], 1)
        self.assertEqual(scan_res["wifiScan"]["networks"][0]["ssid"], "MyHomeNet")

        # 3. usb-wifi-connect reads secret from stdin JSON and scrubs it from all events (even on error)
        secret_pw = "SuperSecretWiFiPass!2026#Melodious"
        written_payloads: list[bytes] = []
        fake_handle = Mock()
        ack_resp = usb.RawResponse(
            device.path,
            0x03,
            0,
            True,
            2,
            "",
            usb.hex_string(bytes.fromhex("FF 03 80 01 01 02") + (b"\x00" * 58)),
            usb.hex_string(bytes.fromhex("FF 03 80 01 01 02") + (b"\x00" * 58)),
            [],
            None,
        )

        def capture_wifi_write(handle, dev, handle_id, payload, timeout_ms, **kwargs):
            written_payloads.append(payload)
            return [ack_resp]

        buf = io.StringIO()
        stdin_buf = io.StringIO(json.dumps({"ssid": "MyHomeNet", "password": secret_pw}) + "\n")
        with (
            patch.object(usb, "usb_process_lock", return_value=contextlib.nullcontext()),
            patch.object(usb.HarmonyUsbBridge, "enumerate_devices", return_value=[device]),
            patch.object(usb.HarmonyUsbBridge, "open_handle", return_value=(fake_handle, device)),
            patch.object(usb, "raw_open_write_file_on_handle", return_value=2),
            patch.object(usb.HarmonyUsbBridge, "raw_write_data_on_handle", side_effect=capture_wifi_write),
            patch.object(usb, "raw_close_file_on_handle", return_value=Mock()),
        ):
            rc = wb.run_wizard_bridge(
                ["--action", "usb-wifi-connect", "--confirm-action", "usb-wifi-connect"],
                stream=buf,
                stdin_stream=stdin_buf,
            )
        self.assertEqual(rc, 0)
        self.assertEqual(len(written_payloads), 1)
        self.assertIn(secret_pw.encode("utf-8"), written_payloads[0])
        self.assertNotIn(secret_pw, buf.getvalue())
        wifi_res = parse_ndjson(buf.getvalue())[-1]
        self.assertTrue(wifi_res["ok"])
        self.assertTrue(wifi_res["wifiConnect"]["passwordRedacted"])

        # Verify secret is also scrubbed if an exception echoes the password
        buf_err = io.StringIO()
        stdin_err = io.StringIO(json.dumps({"ssid": "MyHomeNet", "password": secret_pw}) + "\n")
        with (
            patch.object(usb, "usb_process_lock", return_value=contextlib.nullcontext()),
            patch.object(usb.HarmonyUsbBridge, "enumerate_devices", return_value=[device]),
            patch.object(usb.HarmonyUsbBridge, "open_handle", side_effect=usb.UsbBridgeError(f"failed with {secret_pw}")),
        ):
            rc_err = wb.run_wizard_bridge(
                ["--action", "usb-wifi-connect", "--confirm-action", "usb-wifi-connect"],
                stream=buf_err,
                stdin_stream=stdin_err,
            )
        self.assertEqual(rc_err, 1)
        self.assertNotIn(secret_pw, buf_err.getvalue())
        self.assertIn("<redacted>", buf_err.getvalue())

    def test_factory_reset_sends_body_1_only_never_all_and_triggers_devctrl_reboot(self) -> None:
        device = make_test_device()
        fake_handle = Mock()
        writes: list[tuple[str, bytes]] = []
        devctrl_reboots: list[bool] = []
        ack_resp = usb.RawResponse(
            device.path,
            0x03,
            0,
            True,
            1,
            "",
            usb.hex_string(bytes.fromhex("FF 03 80 01 01 01") + (b"\x00" * 58)),
            usb.hex_string(bytes.fromhex("FF 03 80 01 01 01") + (b"\x00" * 58)),
            [],
            None,
        )

        def track_write(handle, dev, handle_id, data, timeout_ms, **kwargs):
            writes.append((kwargs.get("label", ""), data))
            return [ack_resp]

        buf = io.StringIO()
        with (
            patch.object(usb, "usb_process_lock", return_value=contextlib.nullcontext()),
            patch.object(usb.HarmonyUsbBridge, "enumerate_devices", return_value=[device]),
            patch.object(usb.HarmonyUsbBridge, "open_handle", return_value=(fake_handle, device)),
            patch.object(usb, "raw_open_write_file_on_handle", return_value=1),
            patch.object(usb.HarmonyUsbBridge, "raw_write_data_on_handle", side_effect=track_write),
            patch.object(usb, "raw_close_file_on_handle", return_value=Mock()),
            patch.object(usb, "raw_reboot_device_on_handle", side_effect=lambda *a: devctrl_reboots.append(True)),
        ):
            rc = wb.run_wizard_bridge(
                ["--action", "usb-factory-reset", "--confirm-action", "usb-factory-reset"],
                stream=buf,
            )

        self.assertEqual(rc, 0)
        self.assertEqual(writes[0], ("/sys/factoryreset", b"1"))
        for _label, payload in writes:
            self.assertNotEqual(payload, b"all")
        self.assertEqual(len(devctrl_reboots), 1)
        res = parse_ndjson(buf.getvalue())[-1]
        self.assertTrue(res["ok"])
        self.assertEqual(res["factoryReset"]["resetPayload"], "1")
        self.assertTrue(res["factoryReset"]["deviceControlRebootSent"])
        self.assertIn("15 seconds", res["factoryReset"]["powerCycleGuidance"])

    def test_flash_firmware_refuses_skin_mismatch_and_handles_boot_updater_handoff(self) -> None:
        device = make_test_device()
        fake_bundle = usb.FirmwareBundle(
            path=pathlib.Path("/tmp/4.15.600.2987731.hfw2"),
            intended_skins=[97, 106, 109],
            images=[
                usb.FirmwareImage(
                    name="ota-image.bin",
                    remote_path="/fw/otaupdate",
                    operation_type="firmwareupgrade",
                    data=b"fwdata",
                    checksum_type="MD5",
                    checksum_seed=0,
                    checksum_offset=0,
                    checksum_length=6,
                    checksum_expected="0" * 32,
                    reset=True,
                )
            ],
        )
        fake_bundle_summary = {
            "path": "/tmp/4.15.600.2987731.hfw2",
            "size": 6,
            "sha256": "abc",
            "intendedSkins": [97, 106, 109],
            "images": [{"name": "ota-image.bin", "remotePath": "/fw/otaupdate", "operationType": "firmwareupgrade", "bytes": 6}],
        }

        # 1. Skin mismatch (hub reports skin 0x41 = 65, bundle is for [97, 106, 109])
        class WrongSkinHbus:
            def __init__(self, args):
                self.args = args

            def call(self, cmd, params, timeout=20):
                return {"id": "1", "code": 200, "data": {"fw_ver": "4.15.330", "skin": "0x41"}}

        buf = io.StringIO()
        with (
            patch.object(usb, "parse_hfw2_bundle", return_value=fake_bundle),
            patch.object(usb, "firmware_bundle_summary", return_value=fake_bundle_summary),
            patch.object(usb.HarmonyUsbBridge, "enumerate_devices", return_value=[device]),
            patch.object(usb, "UsbHbusTransport", side_effect=WrongSkinHbus),
            patch.object(usb, "run_flash_firmware", side_effect=AssertionError("must not flash on skin mismatch")),
        ):
            rc = wb.run_wizard_bridge(
                [
                    "--action",
                    "usb-flash-firmware",
                    "--confirm-action",
                    "usb-flash-firmware",
                    "--firmware-file",
                    "/tmp/4.15.600.2987731.hfw2",
                ],
                stream=buf,
            )
        self.assertEqual(rc, 1)
        events = parse_ndjson(buf.getvalue())
        self.assertTrue(any(e["type"] == "error" and e["code"] == "skin_mismatch" for e in events))
        self.assertEqual(events[-1]["firmwareFlash"]["code"], "skin_mismatch")
        self.assertEqual(events[-1]["firmwareFlash"]["hubSkinDecimal"], 65)

        # 2. Matching skin (106) + 'u' (0x75 bootUpdaterHandoff) + post-reboot 4.15.600 verification
        sysinfo_calls = 0

        class MatchingSkinHbus:
            def __init__(self, args):
                self.args = args

            def call(self, cmd, params, timeout=20):
                nonlocal sysinfo_calls
                sysinfo_calls += 1
                fw = "4.15.290" if sysinfo_calls == 1 else "4.15.600"
                return {"id": str(sysinfo_calls), "code": 200, "data": {"fw_ver": fw, "skin": "0x6a"}}

        def fake_run_flash(bridge, args):
            self.assertTrue(args.yes)
            print(
                json.dumps(
                    {
                        "ok": True,
                        "action": "flash-firmware",
                        "usbHandoffOk": True,
                        "images": [
                            {
                                "name": "ota-image.bin",
                                "usbUploadOk": True,
                                "firmwareHandoffOk": True,
                                "resultMode": "bootUpdaterHandoff",
                                "checksumOk": False,
                                "checksumResult": "0x75 ('u')",
                                "committed": False,
                                "closed": True,
                            }
                        ],
                        "rebootRequested": True,
                        "reboot": True,
                    }
                ),
                flush=True,
            )

        buf = io.StringIO()
        with (
            patch.object(usb, "usb_process_lock", return_value=contextlib.nullcontext()),
            patch.object(usb, "parse_hfw2_bundle", return_value=fake_bundle),
            patch.object(usb, "firmware_bundle_summary", return_value=fake_bundle_summary),
            patch.object(usb.HarmonyUsbBridge, "enumerate_devices", return_value=[device]),
            patch.object(usb, "UsbHbusTransport", side_effect=MatchingSkinHbus),
            patch.object(usb, "run_flash_firmware", side_effect=fake_run_flash),
        ):
            rc = wb.run_wizard_bridge(
                [
                    "--action",
                    "usb-flash-firmware",
                    "--confirm-action",
                    "usb-flash-firmware",
                    "--firmware-file",
                    "/tmp/4.15.600.2987731.hfw2",
                    "--verify-timeout-s",
                    "5",
                ],
                stream=buf,
            )
        self.assertEqual(rc, 0)
        flash_res = parse_ndjson(buf.getvalue())[-1]["firmwareFlash"]
        self.assertTrue(flash_res["ok"])
        self.assertTrue(flash_res["bootUpdaterHandoff"])
        self.assertTrue(flash_res["postRebootVerified"])
        self.assertEqual(flash_res["postRebootFirmware"], "4.15.600")

    def test_tde_enable_provision_local_numeric_remote_id_seed_automation_and_root_flows(self) -> None:
        device = make_test_device()
        fake_handle = Mock()

        # 1. Numeric remoteId validation rejects strings, zero, negatives, booleans
        for bad_rid in ("0", "-1", "-20261111", "abc", ""):
            buf = io.StringIO()
            rc = wb.run_wizard_bridge(
                [
                    "--action",
                    "usb-provision-local",
                    "--confirm-action",
                    "usb-provision-local",
                    "--remote-id",
                    bad_rid,
                ],
                stream=buf,
            )
            self.assertEqual(rc, 1)
            events = parse_ndjson(buf.getvalue())
            self.assertEqual(events[0]["code"], "invalid_remote_id")

        # Also reject JSON string remoteId on stdin ("20261111")
        buf = io.StringIO()
        rc = wb.run_wizard_bridge(
            ["--action", "usb-provision-local", "--confirm-action", "usb-provision-local"],
            stream=buf,
            stdin_stream=io.StringIO('{"remoteId": "20261111"}\n'),
        )
        self.assertEqual(rc, 1)
        self.assertEqual(parse_ndjson(buf.getvalue())[0]["code"], "invalid_remote_id")

        # 2. usb-tde-enable writes "1" with data_length_mode="length" and handles 598 fallback
        tde_write_kwargs: dict = {}
        ack_resp = usb.RawResponse(
            device.path,
            0x03,
            0,
            True,
            10,
            "",
            usb.hex_string(bytes.fromhex("FF 03 80 01 01 0A") + (b"\x00" * 58)),
            usb.hex_string(bytes.fromhex("FF 03 80 01 01 0A") + (b"\x00" * 58)),
            [],
            None,
        )

        def capture_tde_write(handle, dev, handle_id, data, timeout_ms, **kwargs):
            tde_write_kwargs["data"] = data
            tde_write_kwargs["data_length_mode"] = kwargs.get("data_length_mode")
            return [ack_resp]

        tde_read = usb.RawFileRead(device.path, "/tde/enable", 1, b"1", Mock(), [], Mock())
        jft_calls: list[tuple[str, dict]] = []

        class TdeHbus:
            def __init__(self, args):
                self.args = args

            def call(self, cmd, params, timeout=20):
                jft_calls.append((cmd, params))
                if len(jft_calls) == 1:
                    # First get returns 598 Empty file
                    return {"id": "1", "code": "598", "msg": "Empty file", "data": {"errorCode": "598"}}
                if cmd == "connect.jsonfiletransfer?put":
                    return {"id": "2", "code": 200, "data": {"errorCode": "200"}}
                return {"id": "3", "code": 200, "data": {"1": ""}}

        buf = io.StringIO()
        with (
            patch.object(usb, "usb_process_lock", return_value=contextlib.nullcontext()),
            patch.object(usb.HarmonyUsbBridge, "enumerate_devices", return_value=[device]),
            patch.object(usb.HarmonyUsbBridge, "open_handle", return_value=(fake_handle, device)),
            patch.object(usb, "raw_open_write_file_on_handle", return_value=10),
            patch.object(usb.HarmonyUsbBridge, "raw_write_data_on_handle", side_effect=capture_tde_write),
            patch.object(usb, "raw_close_file_on_handle", return_value=Mock()),
            patch.object(usb, "raw_read_file", return_value=tde_read),
            patch.object(usb, "UsbHbusTransport", side_effect=TdeHbus),
        ):
            rc = wb.run_wizard_bridge(
                ["--action", "usb-tde-enable", "--confirm-action", "usb-tde-enable"],
                stream=buf,
            )
        self.assertEqual(rc, 0)
        self.assertEqual(tde_write_kwargs["data"], b"1")
        self.assertEqual(tde_write_kwargs["data_length_mode"], "length")
        tde_res = parse_ndjson(buf.getvalue())[-1]["tdeEnable"]
        self.assertTrue(tde_res["ok"])
        self.assertTrue(tde_res["fallbackWritten"])
        self.assertEqual(
            jft_calls[1],
            ("connect.jsonfiletransfer?put", {"path": "../../etc", "file": "tdeenable", "content": 1}),
        )

        # 3. usb-provision-local writes mode 3 with strictly integer remoteId + reboots + verifies getProvisionInfo
        written_prefs: dict = {}

        class ProvisionHbus:
            def __init__(self, args):
                self.args = args

            def call(self, cmd, params, timeout=20):
                if cmd == "connect.jsonfiletransfer?put":
                    written_prefs.update(params["content"])
                    return {"id": "1", "code": 200, "data": {"errorCode": "200"}}
                if cmd == "connect.jsonfiletransfer?get":
                    return {"id": "2", "code": 200, "data": written_prefs}
                if cmd == "setup.account?getProvisionInfo":
                    return {
                        "id": "3",
                        "code": 200,
                        "data": {
                            "mode": 3,
                            "activeRemoteId": written_prefs["remoteId"],
                            "accountId": written_prefs["accountId"],
                            "email": written_prefs["email"],
                            "discoveryServer": written_prefs["discoveryServerUri"],
                            "se": True,
                        },
                    }
                raise AssertionError(cmd)

        buf = io.StringIO()
        with (
            patch.object(usb, "usb_process_lock", return_value=contextlib.nullcontext()),
            patch.object(usb.HarmonyUsbBridge, "enumerate_devices", return_value=[device]),
            patch.object(usb.HarmonyUsbBridge, "open_handle", return_value=(fake_handle, device)),
            patch.object(usb, "raw_reboot_device_on_handle", return_value=Mock()),
            patch.object(usb, "UsbHbusTransport", side_effect=ProvisionHbus),
        ):
            rc = wb.run_wizard_bridge(
                ["--action", "usb-provision-local", "--confirm-action", "usb-provision-local"],
                stream=buf,
                stdin_stream=io.StringIO('{"remoteId": 20261111, "accountId": "hub2-local-20261111"}\n'),
            )
        self.assertEqual(rc, 0)
        self.assertIs(type(written_prefs["remoteId"]), int)
        self.assertEqual(written_prefs["remoteId"], 20261111)
        self.assertEqual(written_prefs["mode"], 3)
        prov_res = parse_ndjson(buf.getvalue())[-1]["provisionLocal"]
        self.assertTrue(prov_res["ok"])
        self.assertTrue(prov_res["rebootSent"])
        self.assertEqual(prov_res["remoteIdType"], "number")

        # 4. usb-seed-automation writes AutomationConfig via proxy.resource?put
        seeded_calls: list[tuple[str, dict]] = []

        class SeedHbus:
            def __init__(self, args):
                self.args = args

            def call(self, cmd, params, timeout=20):
                seeded_calls.append((cmd, params))
                if cmd == "proxy.resource?put":
                    return {"id": "1", "code": 200, "data": {"code": "204", "errorCode": "200"}}
                if cmd == "connect.jsonfiletransfer?get":
                    return {"id": "2", "code": 200, "data": {"errorCode": "200", "id": "20261111"}}
                raise AssertionError(cmd)

        buf = io.StringIO()
        with (
            patch.object(usb.HarmonyUsbBridge, "enumerate_devices", return_value=[device]),
            patch.object(usb, "UsbHbusTransport", side_effect=SeedHbus),
        ):
            rc = wb.run_wizard_bridge(
                [
                    "--action",
                    "usb-seed-automation",
                    "--confirm-action",
                    "usb-seed-automation",
                    "--remote-id",
                    "20261111",
                    "--account-id",
                    "hub2-local-20261111",
                ],
                stream=buf,
            )
        self.assertEqual(rc, 0)
        self.assertEqual(seeded_calls[0][0], "proxy.resource?put")
        self.assertEqual(seeded_calls[0][1]["uri"], "dynamite://HomeAutomationService/Config/20261111")
        self.assertEqual(seeded_calls[0][1]["resource"]["enableXMPP"], 1)

        # 5. Root actions: usb-root, lan-root-xmpp, and post-root (with --allow-unproven-post)
        lan_main_calls: list[list[str]] = []
        preflight_read = usb.RawFileRead(device.path, usb.RAW_DEVICE_INFO_PATH, 2, b"{}", Mock(), [], Mock())
        with (
            patch.object(usb, "usb_process_lock", return_value=contextlib.nullcontext()),
            patch.object(usb.HarmonyUsbBridge, "enumerate_devices", return_value=[device]),
            patch.object(usb, "raw_read_file", return_value=preflight_read),
            patch.object(lan, "main", side_effect=lambda argv: lan_main_calls.append(argv)),
            patch.object(lan, "is_port_open", return_value=True),
        ):
            buf_usb_root = io.StringIO()
            rc_usb = wb.run_wizard_bridge(
                [
                    "--action",
                    "usb-root",
                    "--confirm-action",
                    "usb-root",
                    "--hub-host",
                    "192.168.0.235",
                ],
                stream=buf_usb_root,
            )
            self.assertEqual(rc_usb, 0)
            self.assertIn("--no-shell", lan_main_calls[-1])
            self.assertIn("usb", lan_main_calls[-1])
            self.assertIn("--ignore-saved-hub-id", lan_main_calls[-1])
            usb_root_res = parse_ndjson(buf_usb_root.getvalue())[-1]["root"]
            self.assertTrue(usb_root_res["ok"])
            self.assertTrue(usb_root_res["sshPortOpen"])
            self.assertTrue(usb_root_res["noShell"])
            self.assertFalse(usb_root_res["experimental"])

            buf_post_root = io.StringIO()
            rc_post = wb.run_wizard_bridge(
                [
                    "--action",
                    "post-root",
                    "--confirm-action",
                    "post-root",
                    "--allow-unproven-post",
                    "--hub-host",
                    "192.168.0.235",
                ],
                stream=buf_post_root,
            )
            self.assertEqual(rc_post, 0)
            post_root_res = parse_ndjson(buf_post_root.getvalue())[-1]["root"]
            self.assertTrue(post_root_res["ok"])
            self.assertTrue(post_root_res["experimental"])


if __name__ == "__main__":
    unittest.main()
