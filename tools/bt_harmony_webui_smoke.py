#!/usr/bin/env python3
"""Host-side test for codex_webui's Bluetooth Harmony device support.

Compiles tools/bt_harmony_webui_harness.c (which includes the real
payload/source/codex_webui.c) and checks:

* consumer-page (0x0C) key names, ac* and tv* alike and whatever their usage
  number, become report 0x03 presses, keyboard keys
  are unchanged, and modifiers or out-of-range usages are refused;
* every command of the fixed Harmony command set resolves to a report;
* the CommitBtDevices set lists only published btkeyboard devices, is valid
  JSON, escapes what it copies, and meets codexactivity's rules.

Usage: python3 tools/bt_harmony_webui_smoke.py [CC]
"""

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

EXPECTED = {
    # name: (press, release)
    "tvhome": ("A10323020000", "A10300000000"),
    "TV Home": ("A10323020000", "A10300000000"),
    "tvback": ("A10324020000", "A10300000000"),
    "select": ("A10341000000", "A10300000000"),
    "tvmenu": ("A10340000000", "A10300000000"),
    "playpause": ("A103CD000000", "A10300000000"),
    "stop": ("A103B7000000", "A10300000000"),
    "nexttrack": ("A103B5000000", "A10300000000"),
    "previoustrack": ("A103B6000000", "A10300000000"),
    "fastforward": ("A103B3000000", "A10300000000"),
    "rewind": ("A103B4000000", "A10300000000"),
    "channelup": ("A1039C000000", "A10300000000"),
    "channeldown": ("A1039D000000", "A10300000000"),
    "mute": ("A103E2000000", "A10300000000"),
    "volumeup": ("A103E9000000", "A10300000000"),
    "volumedown": ("A103EA000000", "A10300000000"),
    "consumer:0x2FF": ("A103FF020000", "A10300000000"),
    # Upstream's ac* names. Those below 0x200 (acmenu, acguide, acsettings,
    # acvoice, acinfo) once went out as keyboard keys.
    "achome": ("A10323020000", "A10300000000"),
    "acback": ("A10324020000", "A10300000000"),
    "acmenu": ("A10340000000", "A10300000000"),
    "acsearch": ("A10321020000", "A10300000000"),
    "acguide": ("A1038D000000", "A10300000000"),
    "acinfo": ("A103BD010000", "A10300000000"),
    "acsettings": ("A10396000000", "A10300000000"),
    "acexit": ("A10304020000", "A10300000000"),
    "acvoice": ("A103CF000000", "A10300000000"),
    "acpanel": ("A103A2020000", "A10300000000"),
    "consumer221": ("A10321020000", "A10300000000"),
    # keyboard keys keep their meaning
    "home": ("A10100004A0000000000", "A1010000000000000000"),
    "back": ("A1010000290000000000", "A1010000000000000000"),
    "directionup": ("A1010000520000000000", "A1010000000000000000"),
    "number0": ("A1010000270000000000", "A1010000000000000000"),
}
REFUSED = ["consumer300", "consumer0", "consumerzz", "ctrlmute", "shifttvhome"]


def check(condition, message):
    if not condition:
        raise SystemExit("FAIL " + message)


def main():
    cc = shlex.split(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CC", "cc"))
    with tempfile.TemporaryDirectory(prefix="codex-bt-harmony.") as work:
        exe = os.path.join(work, "harness")
        subprocess.run(cc + ["-std=gnu99", "-O1", "-w", "-I", os.path.join(ROOT, "payload/source"),
                             "-o", exe, os.path.join(ROOT, "tools/bt_harmony_webui_harness.c")],
                       check=True)
        out = subprocess.run([exe] + list(EXPECTED) + REFUSED, capture_output=True,
                             text=True, check=True).stdout.splitlines()
        got = {}
        for line in out:
            parts = line.split(" ")
            key = " ".join(parts[1:-2]) if parts[-1] != "error" else " ".join(parts[1:-1])
            got[key] = "error" if parts[-1] == "error" else (parts[-2], parts[-1])
        # "TV Home" has a space; the harness prints the argument as given.
        for key, value in EXPECTED.items():
            check(got.get(key) == value, "%s: %r" % (key, got.get(key)))
        for key in REFUSED:
            check(got.get(key) == "error", "%s should be refused: %r" % (key, got.get(key)))

        hooks = subprocess.run([exe, "webhook"], capture_output=True, text=True,
                               check=True).stdout.splitlines()
        check(hooks == ["webhook HTTP/1.1 400 Bad Request"] * 3 +
              ["webhook HTTP/1.1 404 Not Found"],
              "webhook answers: %r" % hooks)

        text = subprocess.run([exe, "set"], capture_output=True, text=True,
                              check=True).stdout
        data = json.loads(text)
        devices = data["devices"]
        check([d["name"] for d in devices] == ["Homatics Box R 4k", 'Odd "id"'],
              "only published btkeyboard devices: %r" % [d["name"] for d in devices])
        check(devices[1]["entity"] == 'bt_1730000003_9"x', "id is escaped, not injected")
        box = devices[0]
        check(box["entity"] == "bt_1730000000_42" and box["model"] == "Android TV keyboard",
              "box fields: %r" % box)
        names = [c["name"] for c in box["commands"]]
        check(len(names) == 31 and len(set(n.lower() for n in names)) == 31,
              "31 distinct commands: %r" % names)
        for required in ["Home", "Back", "Select", "Menu", "PlayPause", "Stop", "NextTrack",
                         "PreviousTrack", "FastForward", "Rewind", "ChannelUp", "ChannelDown",
                         "Mute", "VolumeUp", "VolumeDown", "DirectionUp", "0", "9"]:
            check(required in names, "missing command " + required)
        # codexactivity's rules for names and values (haDeviceSpecFrom).
        for command in box["commands"]:
            check(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 _.+\-]*", command["name"]) and
                  len(command["name"]) <= 48, "name rule: " + command["name"])
            check(re.fullmatch(r'[^\x00-\x1f"\\%{}]{1,96}', command["value"]),
                  "value rule: " + command["value"])
        values = sorted(set(c["value"] for c in box["commands"]))
        out = subprocess.run([exe] + values, capture_output=True, text=True,
                             check=True).stdout
        check("error" not in out, "every command value must make a report:\n" + out)
        # The real writer accepts what codex_webui sends (valid devices only;
        # the odd id above is for the escaping check and the writer refuses it).
        luajit = shutil.which("luajit")
        if luajit:
            set_file = os.path.join(work, "set.json")
            with open(set_file, "w") as handle:
                json.dump({"devices": [box]}, handle)
            result = subprocess.run(
                [luajit, os.path.join(ROOT, "tools/touch-validator/codexactivity-bt-devices-test.lua"),
                 set_file], capture_output=True, text=True, cwd=ROOT)
            check(result.returncode == 0 and "PASS the writer accepts codex_webui's set" in result.stdout,
                  "codexactivity rejected the set:\n" + result.stdout[-2000:])
        else:
            print("SKIP the codexactivity cross-check: luajit is not installed")
    print("PASS Bluetooth Harmony device: consumer reports and CommitBtDevices set")


if __name__ == "__main__":
    main()
