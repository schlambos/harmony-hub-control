"""Tests for custom_components/melodious/devices.py (the integration's pure rules).

devices.py imports nothing from Home Assistant, so it loads straight from
its file here. Run from the repo root:

    python3 -m unittest discover -s tools/ha-integration -p 'test_*.py'
"""

import importlib.util
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("melodious_devices", ROOT / "custom_components/melodious/devices.py")
devices = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(devices)
Entity = devices.Entity

WEBHOOK = "http://ha.example:8123/api/webhook/abc"
TV_FEATURES = (
    devices.MP_TURN_ON | devices.MP_TURN_OFF | devices.MP_VOLUME_STEP | devices.MP_VOLUME_MUTE
    | devices.MP_PLAY | devices.MP_PAUSE | devices.MP_SELECT_SOURCE
)


def tv(**attributes):
    return Entity("media_player.living_room", "Living Room TV", True, TV_FEATURES,
                  {"source_list": ["HDMI 1", "HDMI 2", "Netflix"], **attributes})


def assert_hub_accepts(test, device_set):
    """The limits codexactivity's CommitHaDevices checks (haSetFrom), in Python."""
    test.assertRegex(device_set["webhook"], r"^http://[\w.\-]+(:\d+)?/[\w\-._~/]*$")
    test.assertLessEqual(len(device_set["devices"]), 64)
    entities, names = set(), set()
    for d in device_set["devices"]:
        test.assertRegex(d["entity"], r"^[a-z0-9_]+\.[a-z0-9_]+$")
        test.assertTrue(0 < len(d["name"]) <= 64 and not re.search(r'[\x00-\x1f\x7f"\\]', d["name"]), d["name"])
        test.assertNotIn(d["entity"], entities)
        test.assertNotIn(d["name"].lower(), names)
        entities.add(d["entity"])
        names.add(d["name"].lower())
        commands = {}
        test.assertTrue(0 < len(d["commands"]) <= 128)
        for c in d["commands"]:
            test.assertRegex(c["name"], r"^[A-Za-z0-9][A-Za-z0-9 _.+\-]*$")
            test.assertLessEqual(len(c["name"]), 48)
            test.assertTrue(0 < len(c["value"]) <= 96 and not re.search(r'[\x00-\x1f\x7f"\\%{}]', c["value"]), c)
            test.assertNotIn(c["name"].lower(), commands)
            commands[c["name"].lower()] = c
        if "power" in d:
            test.assertIn(d["power"]["on"].lower(), commands)
            test.assertIn(d["power"]["off"].lower(), commands)
        test.assertLessEqual(len(d.get("inputs", [])), 32)
        for i in d.get("inputs", []):
            test.assertIn(i["command"].lower(), commands)


class DeviceSetTests(unittest.TestCase):
    def test_media_player(self):
        spec = devices.build_device_set(WEBHOOK, [tv()])["devices"][0]
        values = {c["name"]: c["value"] for c in spec["commands"]}
        self.assertEqual(values["PowerOn"], "turn_on")
        self.assertEqual(values["VolumeUp"], "volume_up")
        self.assertEqual(values["Mute"], "mute")
        self.assertEqual(values["PlayPause"], "media_play_pause")
        self.assertNotIn("Stop", values, "no STOP feature")
        self.assertEqual(spec["power"], {"on": "PowerOn", "off": "PowerOff"})
        self.assertEqual(spec["inputs"][0], {"name": "HDMI 1", "command": "Input HDMI 1"})
        self.assertEqual(values["Input Netflix"], "select_source:Netflix")

    def test_sources_the_hub_cant_carry_are_skipped(self):
        sources = ['Say "hi"', "100%", "{x}", "hdmi 1", "HDMI 1", "Pi: Kodi", "X" * 120]
        spec = devices.build_device_set(WEBHOOK, [tv(source_list=sources)])["devices"][0]
        self.assertEqual([i["name"] for i in spec["inputs"]], ["hdmi 1", "Pi: Kodi"])
        self.assertIn("Input Pi Kodi", {c["name"] for c in spec["commands"]})

    def test_input_names_come_from_the_label_and_stay_unique(self):
        spec = devices.build_device_set(WEBHOOK, [tv(source_list=["A/V", "A V", "AV"])])["devices"][0]
        self.assertEqual([i["command"] for i in spec["inputs"]], ["Input AV", "Input A V", "Input AV 2"])

    def test_other_domains(self):
        entities = [
            Entity("light.desk", "Desk", True, 0, {"supported_color_modes": ["brightness"]}),
            Entity("light.strip", "Strip", True, 0, {"supported_color_modes": ["onoff"]}),
            Entity("cover.blind", "Blind", True, devices.COVER_OPEN | devices.COVER_CLOSE, {}),
            Entity("script.movie", "Movie time", True, 0, {}),
            Entity("button.doorbell", "Doorbell", True, 0, {}),
            Entity("climate.hall", "Hall", True, 0, {}),
        ]
        by_entity = {d["entity"]: d for d in devices.build_device_set(WEBHOOK, entities)["devices"]}
        names = lambda e: [c["name"] for c in by_entity[e]["commands"]]  # noqa: E731
        self.assertEqual(names("light.desk"), ["PowerOn", "PowerOff", "PowerToggle", "BrightnessUp", "BrightnessDown"])
        self.assertEqual(names("light.strip"), ["PowerOn", "PowerOff", "PowerToggle"])
        self.assertEqual(names("cover.blind"), ["Open", "Close"])
        self.assertNotIn("power", by_entity["cover.blind"])
        self.assertEqual(names("script.movie"), ["Run"])
        self.assertEqual(names("button.doorbell"), ["Press"])
        self.assertNotIn("climate.hall", by_entity, "unsupported domain")

    def test_names_stay_unique_and_clear_of_other_hub_devices(self):
        entities = [
            Entity("switch.a", "Lamp", True), Entity("switch.b", "lamp", True),
            Entity("switch.c", "LG TV", True), Entity("switch.d", 'Bad "name"\\', True),
        ]
        names = [d["name"] for d in devices.build_device_set(WEBHOOK, entities, taken_names={"LG TV"})["devices"]]
        self.assertEqual(names, ["Lamp", "lamp 2", "LG TV (HA)", "Bad name"])

    def test_an_unavailable_entity_keeps_its_device(self):
        first = devices.build_device_set(WEBHOOK, [tv()])
        previous = {d["entity"]: d for d in first["devices"]}
        down = Entity("media_player.living_room", "Living Room TV", False)
        self.assertEqual(devices.build_device_set(WEBHOOK, [down], previous), first)
        self.assertEqual(devices.build_device_set(WEBHOOK, [down])["devices"], [], "nothing to keep yet")

    def test_a_player_switched_off_keeps_its_inputs(self):
        first = devices.build_device_set(WEBHOOK, [tv()])
        previous = {d["entity"]: d for d in first["devices"]}
        off = tv(source_list=None)
        self.assertEqual(devices.build_device_set(WEBHOOK, [off], previous), first)
        more = devices.build_device_set(WEBHOOK, [tv(source_list=["HDMI 3"])], previous)["devices"][0]
        self.assertEqual([i["name"] for i in more["inputs"]], ["HDMI 3", "HDMI 1", "HDMI 2", "Netflix"])

    def test_every_set_passes_the_hub_rules(self):
        entities = [tv(source_list=[f"Source {n}" for n in range(40)])] + [
            Entity(f"switch.s{n}", f"Switch {n % 3}", True) for n in range(70)
        ]
        device_set = devices.build_device_set(WEBHOOK, entities, taken_names={"Switch 1"})
        self.assertEqual(len(device_set["devices"]), 64)
        self.assertEqual(len(device_set["devices"][0]["inputs"]), 32)
        assert_hub_accepts(self, device_set)

    def test_allowed_values(self):
        allowed = devices.allowed_values(devices.build_device_set(WEBHOOK, [tv()]))
        self.assertIn("select_source:HDMI 2", allowed["media_player.living_room"])


class ServiceCallTests(unittest.TestCase):
    def test_calls(self):
        call = devices.service_call
        self.assertEqual(call("media_player.tv", "volume_up"), ("media_player", "volume_up", {"entity_id": "media_player.tv"}))
        self.assertEqual(call("media_player.tv", "select_source:Pi: Kodi"),
                         ("media_player", "select_source", {"entity_id": "media_player.tv", "source": "Pi: Kodi"}))
        self.assertEqual(call("media_player.tv", "mute", {"is_volume_muted": True})[2]["is_volume_muted"], False)
        self.assertEqual(call("media_player.tv", "mute", {})[2]["is_volume_muted"], True)
        self.assertEqual(call("light.desk", "brightness_down"),
                         ("light", "turn_on", {"entity_id": "light.desk", "brightness_step_pct": -10}))
        self.assertEqual(call("script.movie", "turn_on")[1], "turn_on")

    def test_anything_else_is_refused(self):
        call = devices.service_call
        self.assertIsNone(call("media_player.tv", "volume_up:5"))
        self.assertIsNone(call("light.desk", "select_source:HDMI 1"))
        self.assertIsNone(call("lock.front", "unlock"))
        self.assertIsNone(call("switch.a", "turn_off_everything"))

    def test_every_command_built_has_a_service(self):
        entities = [
            tv(), Entity("light.desk", "Desk", True, 0, {"supported_color_modes": ["brightness"]}),
            Entity("fan.f", "Fan", True, devices.FAN_SET_SPEED), Entity("scene.s", "S", True),
            Entity("cover.c", "C", True, devices.COVER_OPEN | devices.COVER_CLOSE | devices.COVER_STOP),
            Entity("input_button.b", "B", True), Entity("input_boolean.i", "I", True),
        ]
        for entity, values in devices.allowed_values(devices.build_device_set(WEBHOOK, entities)).items():
            for value in values:
                self.assertIsNotNone(devices.service_call(entity, value), f"{entity} {value}")


if __name__ == "__main__":
    unittest.main()
