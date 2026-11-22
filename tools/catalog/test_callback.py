"""Strict pasted callbacks and protocol-record bundling. No network, token files, or real sign-in."""
import json
import unittest

from tools.catalog.harmony_catalog import (
    CatalogError,
    DISCOVERY_URL,
    HARMONY_SIGNIN_URL,
    HarmonySession,
    LipTokens,
    fetch_package,
    is_valid_protocol_record,
    parse_callback,
    redact,
    select_needed_protocols,
)

FIXTURE_PROTOCOL_686 = {
    "__type": "IrProtocol",
    "Id-": 686,
    "Name": "Samsung 16 and 20 Bit",
    "CarrierFrequency": 38000,
    "IRSegments": [
        {
            "Header": [{"Value": 4500, "Type": 1}, {"Value": 4480, "Type": 0}],
            "Payload": {"NumberOfBits": 16, "Encodings": []},
            "Trailer": [{"Value": 495, "Type": 1}, {"Value": 4495, "Type": 0}],
            "TotalLength": 0,
            "Name": "Samsung 16 and 20 Bit",
        }
    ],
    "CodeSegments": [],
    "KeyCode": {"Start": None, "Repeat": [{"SegmentType": 1, "SegmentName": "Samsung 16 and 20 Bit"}], "Finish": None},
}

FIXTURE_PROTOCOL_OTHER = {
    "__type": "IrProtocol",
    "Id-": 17,
    "Name": "Sony 15 Bit",
    "CarrierFrequency": 40000,
    "IRSegments": [{"Header": [{"Value": 2400, "Type": 1}], "Payload": {"NumberOfBits": 15, "Encodings": []}, "Trailer": [], "TotalLength": 45000, "Name": "Sony 15 Bit"}],
    "CodeSegments": [],
    "KeyCode": {"Start": None, "Repeat": [{"SegmentType": 1, "SegmentName": "Sony 15 Bit"}], "Finish": None},
}


class CallbackTests(unittest.TestCase):
    def test_url_and_query(self):
        for prefix in ("com.logitech.harmony://lidsoauth?", "?", ""):
            self.assertEqual(parse_callback(prefix + "code=fixture&state=expected", expected_state="expected"), "fixture")

    def test_refusals(self):
        for value in (
            "", "bare-nonce", "code=fixture", "state=expected", "code=&state=expected",
            "code=fixture&state=wrong", "code=fixture&state=", "code=fixture&state=expected&error=",
            "code=fixture&state=expected&error=access_denied", "code=a&code=b&state=expected",
            "code=fixture&state=expected&state=wrong",
            "https://id.logi.com/launch.html?nonce=fixture",
            "https://accounts.logi.com/?code=fixture&state=expected",
            "https://example.com/?code=fixture&state=expected",
            "com.logitech.harmony://other?code=fixture&state=expected",
        ):
            with self.subTest(value=value), self.assertRaises(CatalogError):
                parse_callback(value, expected_state="expected")
        with self.assertRaises(CatalogError):
            parse_callback("code=fixture&state=", expected_state="")


class ProtocolFetchTests(unittest.TestCase):
    def _fake_client(self, *, protocol_status=200, protocol_payload=None, include_op=True):
        calls = []
        ops = [
            {"Identifier": "DeviceManager/SearchGlobalDevices", "Address": "https://svcs.myharmony.com/HarmonyPlatform/DeviceManager.svc/json/", "Name": "SearchGlobalDevices"},
            {"Identifier": "DeviceManager/GetGlobalDevices", "Address": "https://svcs.myharmony.com/HarmonyPlatform/DeviceManager.svc/json/", "Name": "GetGlobalDevices"},
            {"Identifier": "DeviceManager/GetCommands", "Address": "https://svcs.myharmony.com/HarmonyPlatform/DeviceManager.svc/json/", "Name": "GetCommands"},
        ]
        if include_op:
            ops.append({
                "Identifier": "UserAccountDirector/ProtocolList",
                "Address": "https://svcs.myharmony.com/UserAccountDirectorPlatform/UserAccountDirector.svc/json/Account/{accountId}/",
                "Name": "ProtocolList",
            })

        class FakeClient:
            def post(self, url, payload, *, token=None, headers=None):
                calls.append(("POST", url, token, headers))
                if url == HARMONY_SIGNIN_URL:
                    return 200, {"AccountId": "acct-secret-123"}
                if url == DISCOVERY_URL:
                    return 200, {"GetJsonOperationsResult": ops}
                if url.endswith("/json2/SearchGlobalDevices"):
                    return 200, {"SearchGlobalDevicesResult": {"Matches": [{"Id-": 523365, "Manufacturer": "Samsung", "DeviceModel": "HW-Q990D"}]}}
                if url.endswith("/json2/GetGlobalDevices"):
                    return 200, {"GetGlobalDevicesResult": [{"Id": 523365, "DefaultGlobalLanguageVersionId": 251247}]}
                if url.endswith("/json/GetGlobalLanguageCommands"):
                    return 200, {"GetGlobalLanguageCommandsResult": [
                        {"Name": "PowerToggle", "KeyCode": "G:Samsung 16 and 20 Bit:()(0x0CF0_1x00EF1)():3", "ProtocolId": 686, "Raw": None},
                        {"Name": "VolumeUp", "KeyCode": "G:Samsung 16 and 20 Bit:()(0x0CF0_1x0EE11)():3", "ProtocolId": 686, "Raw": None},
                    ]}
                raise AssertionError(f"Unexpected POST {url}")

            def get(self, url, *, token=None, headers=None):
                calls.append(("GET", url, token, headers))
                return protocol_status, protocol_payload

        return FakeClient(), calls

    def test_fetch_package_fetches_and_filters_needed_protocols(self):
        payload = {
            "Protocols": [
                FIXTURE_PROTOCOL_OTHER,
                FIXTURE_PROTOCOL_686,
                {"__type": "HidProtocol", "Id-": 999997, "Name": "HID 16 Bit"},
            ]
        }
        client, calls = self._fake_client(protocol_payload=payload)
        session = HarmonySession("acct-secret-123", LipTokens("tok-secret", "id-secret"))
        pkg = fetch_package(client, session, "Samsung", "HW-Q990D")
        gets = [c for c in calls if c[0] == "GET"]
        self.assertEqual(len(gets), 1)
        self.assertEqual(
            gets[0][1],
            "https://lb-svcs.myharmony.com/UserAccountDirectorPlatform/UserAccountDirector.svc/json2/Account/acct-secret-123/ProtocolList",
        )
        self.assertEqual(gets[0][2], "tok-secret")
        self.assertEqual(gets[0][3], {"x-logitech-api-version": "1"})
        self.assertEqual(pkg["resources"]["protocols"], [FIXTURE_PROTOCOL_686])
        raw_text = json.dumps(pkg)
        self.assertNotIn("acct-secret-123", raw_text)
        self.assertNotIn("tok-secret", raw_text)

    def test_fetch_package_degrades_gracefully_when_protocol_list_unavailable(self):
        client, _ = self._fake_client(protocol_status=500, protocol_payload={"Message": "boom"})
        session = HarmonySession("acct-1", LipTokens("tok", "id"))
        pkg = fetch_package(client, session, "Samsung", "HW-Q990D")
        self.assertEqual(pkg["resources"]["protocols"], [])
        self.assertEqual(len(pkg["resources"]["global_language_commands"]), 2)

    def test_fetch_package_propagates_access_denied_on_protocol_list(self):
        client, _ = self._fake_client(protocol_status=400, protocol_payload={"Message": "Access is denied."})
        session = HarmonySession("acct-1", LipTokens("tok", "id"))
        with self.assertRaisesRegex(CatalogError, "refused the catalog session"):
            fetch_package(client, session, "Samsung", "HW-Q990D")

    def test_protocol_validation_and_redaction(self):
        self.assertTrue(is_valid_protocol_record(FIXTURE_PROTOCOL_686))
        self.assertFalse(is_valid_protocol_record({"__type": "HidProtocol", "Id-": 999997, "Name": "HID 16 Bit"}))
        self.assertFalse(is_valid_protocol_record({**FIXTURE_PROTOCOL_686, "Name": "Bad:Name"}))
        self.assertEqual(
            select_needed_protocols(
                {"Protocols": [FIXTURE_PROTOCOL_OTHER, FIXTURE_PROTOCOL_686]},
                [{"Name": "Power", "KeyCode": "G:Samsung 16 and 20 Bit:()(0x0CF0_1x00EF1)():3", "ProtocolId": 686}],
            ),
            [FIXTURE_PROTOCOL_686],
        )
        self.assertEqual(redact({"AccountId": "secret", "Name": "ok"}), {"AccountId": "[REDACTED]", "Name": "ok"})


if __name__ == "__main__":
    unittest.main()
