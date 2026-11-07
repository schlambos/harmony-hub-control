"""Tests for tools/ha_device_inventory.py (the Phase 0 read-only dumper).

Run from the repo root:

    python3 tools/test_ha_device_inventory.py
"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "ha_device_inventory", ROOT / "tools" / "ha_device_inventory.py"
)
inventory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory)


def sample() -> dict:
    return {
        "ha_version": "2026.11.0",
        "devices": [
            {
                "id": "dev1",
                "name": "Living Room TV",
                "manufacturer": "LG",
                "model": "OLED55C9",
                "identifiers": [["webostv", "secret"]],
                "connections": [["mac", "aa:bb:cc:dd:ee:ff"]],
                "serial_number": "SER123",
            },
            {
                "id": "dev2",
                "name": "Google TV",
                "manufacturer": "Google",
                "model": "Chromecast",
            },
        ],
        "entities": [
            {
                "entity_id": "media_player.living_room_tv",
                "device_id": "dev1",
                "platform": "webostv",
                "entity_category": None,
                "original_name": "TV",
            },
            {
                "entity_id": "remote.living_room_tv",
                "device_id": "dev1",
                "platform": "webostv",
                "entity_category": None,
                "original_name": "Remote",
            },
            {
                "entity_id": "media_player.google_tv",
                "device_id": "dev2",
                "platform": "androidtv_remote",
                "entity_category": None,
                "original_name": "Google TV",
            },
            {
                "entity_id": "sensor.living_room_tv_signal",
                "device_id": "dev1",
                "platform": "webostv",
                "entity_category": "diagnostic",
                "original_name": "Signal",
            },
            {
                "entity_id": "light.desk",
                "device_id": None,
                "platform": "hue",
                "entity_category": None,
                "original_name": "Desk",
            },
        ],
        "states": [
            {
                "entity_id": "media_player.living_room_tv",
                "state": "on",
                "attributes": {
                    "supported_features": 123,
                    "source_list": ["HDMI 1", "Netflix"],
                    "volume_level": 0.3,
                    "is_volume_muted": False,
                    "friendly_name": "Living Room TV",
                    "ip_address": "192.168.0.5",
                },
            },
            {
                "entity_id": "remote.living_room_tv",
                "state": "on",
                "attributes": {
                    "current_activity": "Netflix",
                    "activity_list": ["Netflix", "YouTube"],
                },
            },
            {
                "entity_id": "media_player.google_tv",
                "state": "playing",
                "attributes": {"app_name": "YouTube", "supported_features": 456},
            },
            {
                "entity_id": "sensor.living_room_tv_signal",
                "state": "good",
                "attributes": {"friendly_name": "Signal"},
            },
            {
                "entity_id": "light.desk",
                "state": "on",
                "attributes": {"friendly_name": "Desk"},
            },
        ],
    }


class InventoryTests(unittest.TestCase):
    def test_redacts_mac_ip_and_secrets(self):
        self.assertEqual(
            inventory.redact_text("aa:bb:cc:dd:ee:ff at 192.168.0.5"),
            "<mac> at <ip>",
        )
        self.assertEqual(
            inventory.redact_text("password=hunter2"), "password=<redacted>"
        )
        self.assertEqual(inventory.redact("secret", "serial_number"), "<redacted>")

    def test_groups_entities_by_device(self):
        result = inventory.build_inventory(sample(), [], False)
        self.assertEqual([d["name"] for d in result["devices"]], ["Living Room TV", "Google TV"])
        lg = result["devices"][0]
        self.assertEqual(
            [e["entity_id"] for e in lg["entities"]],
            ["media_player.living_room_tv", "remote.living_room_tv", "sensor.living_room_tv_signal"],
        )
        self.assertEqual(lg["identifiers"], "<redacted>")
        self.assertEqual(lg["connections"], "<redacted>")
        self.assertNotIn("serial_number", lg)
        self.assertEqual(result["unassigned_entities"][0]["entity_id"], "light.desk")

    def test_anonymise_keeps_domain_and_platform(self):
        result = inventory.build_inventory(sample(), [], True)
        lg = result["devices"][0]
        self.assertEqual(lg["name"], "Device 1")
        self.assertEqual(lg["entities"][0]["entity_id"], "media_player.entity_1")
        self.assertEqual(lg["entities"][0]["platform"], "webostv")
        self.assertEqual(lg["entities"][1]["entity_id"], "remote.entity_1")
        self.assertEqual(lg["entities"][0]["attributes"]["source_list"], ["HDMI 1", "Netflix"])

    def test_device_filter(self):
        result = inventory.build_inventory(sample(), ["google"], False)
        self.assertEqual([d["name"] for d in result["devices"]], ["Google TV"])
        self.assertEqual(result["unassigned_entities"], [])


if __name__ == "__main__":
    unittest.main()
