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
import stat
import subprocess
import sys
import tempfile
import threading
import time

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
    # Power: Sleep 0x032 (KEY_SLEEP), Power 0x030 (KEY_POWER); waking is AC
    # Home, since HAL's system-control report has no System Wake Up.
    "tvwake": ("A10323020000", "A10300000000"),
    "tvsleep": ("A10332000000", "A10300000000"),
    "sleep": ("A10332000000", "A10300000000"),
    "tvpower": ("A10330000000", "A10300000000"),
    "power": ("A10330000000", "A10300000000"),
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


def saved_value(name):
    raw = name.encode("utf-8")
    if len(raw) <= 45:
        return "saved" + raw.hex()
    h = 0xCBF29CE484222325
    for b in raw:
        h ^= b
        h = (h * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return "savedh%016x%04x" % (h, len(raw) & 0xFFFF)


def write_exec(path, content):
    with open(path, "w") as f:
        f.write(content)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def main():
    cc = shlex.split(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CC", "cc"))
    with tempfile.TemporaryDirectory(prefix="codex-bt-harmony.") as work:
        exe = os.path.join(work, "harness")
        auth_conf = os.path.join(work, "webui_auth.conf")
        bt_store = os.path.join(work, "bt-devices.json")
        bt_lock = os.path.join(work, "bt-webhook.lock")
        bt_fifo = os.path.join(work, "bthid_input")
        bt_status = os.path.join(work, "bthid_status")
        bt_target = os.path.join(work, "bthid_target")
        bt_profile = os.path.join(work, "bthid_profile")
        fake_bin = os.path.join(work, "bin")
        os.makedirs(fake_bin, exist_ok=True)
        fake_hal = os.path.join(fake_bin, "codex_hal_ltcp")
        fake_hcitool = os.path.join(fake_bin, "hcitool")
        event_log = os.path.join(work, "events.log")
        with open(auth_conf, "w") as f:
            f.write("enabled=1\nusername=admin\npassword=secret123\n")
        subprocess.run(cc + ["-std=gnu99", "-O1", "-w", "-I", os.path.join(ROOT, "payload/source"),
                             '-DWEBUI_AUTH_CONFIG="%s"' % auth_conf,
                             '-DBT_DEVICE_STORE="%s"' % bt_store,
                             '-DBT_WEBHOOK_LOCK_FILE="%s"' % bt_lock,
                             '-DBT_TEXT_FIFO="%s"' % bt_fifo,
                             '-DBT_TEXT_STATUS="%s"' % bt_status,
                             '-DBT_TARGET_FILE="%s"' % bt_target,
                             '-DBT_PROFILE_FILE="%s"' % bt_profile,
                             '-DCODEX_HAL_LTCP_BIN="%s"' % fake_hal,
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

        # With Web UI sign-in on, the Harmony engine still reaches
        # /api/bt-webhook from 127.0.0.1 without credentials (it stops at
        # "no Harmony device" here: the host has no saved-device store), as
        # it does /api/switch2/cmd and /api/webos/cmd. Nothing else is opened.
        auth = subprocess.run([exe, "auth"], capture_output=True, text=True,
                              check=True).stdout.splitlines()
        check(auth == ["loopback /api/bt-webhook HTTP/1.1 404 Not Found",
                       "loopback /api/bt-harmony-device HTTP/1.1 401 Unauthorized"],
              "sign-in answers: %r" % auth)

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
        check(len(names) == 44 and len(set(n.lower() for n in names)) == 44,
              "34 fixed + 10 publishable saved commands: %d %r" % (len(names), names))
        values = {c["name"]: c["value"] for c in box["commands"]}
        check(values.get("PowerOn") == "tvwake" and values.get("PowerOff") == "tvsleep" and
              values.get("PowerToggle") == "tvpower", "power command values: %r" % values)
        check(box.get("power") == {"on": "PowerOn", "off": "PowerOff"},
              "discrete power: %r" % box.get("power"))
        for required in ["PowerOn", "PowerOff", "PowerToggle",
                         "Home", "Back", "Select", "Menu", "PlayPause", "Stop", "NextTrack",
                         "PreviousTrack", "FastForward", "Rewind", "ChannelUp", "ChannelDown",
                         "Mute", "VolumeUp", "VolumeDown", "DirectionUp", "0", "9"]:
            check(required in names, "missing command " + required)
        overlong1 = "Wake Laptop And Enter Sign In Password On Lock Screen Now"
        overlong2 = "Wake Laptop And Enter Sign In Password On Lock Screen Later"
        expected_saved = {
            "Wake and Sign In": saved_value("Wake and Sign In"),
            "Deverrouiller Cafe": saved_value("Déverrouiller Café"),
            "Detente": saved_value("De\u0301tente"),
            "Strasse Coeur": saved_value("Straße & Cœur"),
            "Home Saved": saved_value("Home"),
            "poweron Saved": saved_value("poweron"),
            "Wake Laptop And Enter Sign In Password On Lock S": saved_value(overlong1),
            "Wake Laptop And Enter Sign In Password On Lock 2": saved_value(overlong2),
            "Cafe": saved_value("Café"),
            "Cafe 2": saved_value("Cafe"),
        }
        for sname, sval in expected_saved.items():
            check(values.get(sname) == sval,
                  "saved command %r expected %r, got %r" % (sname, sval, values.get(sname)))
        # Unpublishable punctuation-only command must not appear.
        check("!!!" not in values, "punctuation-only name must be skipped")
        # codexactivity's rules for names and values (haDeviceSpecFrom).
        for command in box["commands"]:
            check(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 _.+\-]*", command["name"]) and
                  len(command["name"]) <= 48, "name rule: " + command["name"])
            check(re.fullmatch(r'[^\x00-\x1f"\\%{}]{1,96}', command["value"]),
                  "value rule: " + command["value"])
            if command["value"].startswith("saved"):
                check(command["value"].isalnum(), "saved value must be isalnum: " + command["value"])
        fixed_values = sorted(set(c["value"] for c in box["commands"] if not c["value"].startswith("saved")))
        out = subprocess.run([exe] + fixed_values, capture_output=True, text=True,
                             check=True).stdout
        check("error" not in out, "every fixed command value must make a report:\n" + out)
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
            check(result.returncode == 0 and "PASS the writer accepts codex_webui's set" in result.stdout and
                  "PASS codex_webui's set gives the device discrete power" in result.stdout,
                  "codexactivity rejected the set:\n" + result.stdout[-2000:])
        else:
            print("SKIP the codexactivity cross-check: luajit is not installed")

        # Cross-check C bt_harmony_set_json against Web UI bluetooth-model.js
        # on the exact same saved-command names so C and JS can never drift.
        node = shutil.which("node")
        if node:
            js_check = (
                "import { planBtHarmonyCommands } from './tools/webui-sim/public/js/views/bluetooth-model.js';"
                "const names = %s;"
                "const plan = planBtHarmonyCommands({ type: 'btkeyboard', harmony: true, commands: names.map((name) => ({ name, delayMs: 35, script: 'KEY escape' })) });"
                "console.log(JSON.stringify({ published: plan.published.map((p) => [p.harmonyName, p.value]), unpublished: plan.unpublished.map((u) => u.name) }));"
            ) % json.dumps([
                "Wake and Sign In",
                "Déverrouiller Café",
                "De\u0301tente",
                "Straße & Cœur",
                "Home",
                "poweron",
                overlong1,
                overlong2,
                "Café",
                "Cafe",
                "!!!",
            ])
            js_out = subprocess.run([node, "--input-type=module", "-e", js_check],
                                    capture_output=True, text=True, check=True, cwd=ROOT).stdout
            js_plan = json.loads(js_out)
            c_saved = [[c["name"], c["value"]] for c in box["commands"] if c["value"].startswith("saved")]
            check(js_plan["published"] == c_saved and js_plan["unpublished"] == ["!!!"],
                  "C vs JS saved-command plan mismatch: C=%r JS=%r" % (c_saved, js_plan))

        # Webhook execution for saved scripts: must run through run_bt_saved_script
        # (including WAIT + TEXT), return immediately without blocking a second
        # request, and serialize concurrent scripts without interleaving.
        os.mkfifo(bt_fifo, 0o600)
        write_exec(fake_hcitool, """#!/bin/sh
echo "Connections:"
echo "  > ACL AA:BB:CC:DD:EE:FF handle 1 state 1 lm SLAVE AUTH ENCRYPT"
""")
        write_exec(fake_hal, """#!/usr/bin/env python3
import os, sys, time
seq = ""
for arg in sys.argv[1:]:
    if arg.startswith("--seq-file="):
        with open(arg.split("=", 1)[1], "r") as f:
            seq = f.read().strip().replace("\\n", ";")
with open(%r, "a") as log:
    log.write(f"{time.monotonic():.6f} KEY {seq}\\n")
print('{"id":1,"code":200}')
""" % event_log)
        fifo_stop = threading.Event()

        def fifo_reader():
            with open(bt_status, "w") as f:
                json.dump({
                    "ok": True,
                    "runtime": True,
                    "pid": os.getpid(),
                    "state": "listening",
                    "target": "AA:BB:CC:DD:EE:FF",
                    "sent": 0,
                    "skipped": 0,
                    "error": "",
                }, f)
            fd = os.open(bt_fifo, os.O_RDWR | os.O_NONBLOCK)
            try:
                while not fifo_stop.is_set():
                    try:
                        chunk = os.read(fd, 4096)
                        if chunk:
                            with open(event_log, "a") as log:
                                log.write("%.6f TEXT %s\n" % (time.monotonic(), chunk.decode("utf-8", "replace")))
                    except BlockingIOError:
                        time.sleep(0.01)
            finally:
                os.close(fd)

        reader_thread = threading.Thread(target=fifo_reader, daemon=True)
        reader_thread.start()
        try:
            with open(bt_store, "w") as f:
                json.dump({
                    "version": 1,
                    "devices": [{
                        "id": "bt_1730000000_42",
                        "name": "Work Laptop",
                        "type": "btkeyboard",
                        "bdaddr": "AA:BB:CC:DD:EE:FF",
                        "harmony": True,
                        "commands": [
                            {
                                "name": "Wake and Sign In",
                                "delayMs": 20,
                                "script": "KEY escape\nWAIT 400\nTEXT hello\nKEY enter",
                            },
                            {
                                "name": "Quick Tab",
                                "delayMs": 20,
                                "script": "KEY tab\nKEY enter",
                            },
                            {
                                "name": overlong1,
                                "delayMs": 20,
                                "script": "KEY f5",
                            },
                        ],
                    }],
                }, f)
            env = os.environ.copy()
            env["PATH"] = fake_bin + os.pathsep + env.get("PATH", "")
            bodies = [
                json.dumps({"device": "bt_1730000000_42", "command": saved_value("Wake and Sign In")}),
                json.dumps({"device": "bt_1730000000_42", "command": saved_value("Quick Tab")}),
                json.dumps({"device": "bt_1730000000_42", "command": saved_value(overlong1)}),
                json.dumps({"device": "bt_1730000000_42", "command": saved_value("Deleted Cmd")}),
                json.dumps({"device": "bt_1730000000_42", "command": "savedzz"}),
            ]
            res = subprocess.run([exe, "webhook-saved"] + bodies, capture_output=True, text=True,
                                 check=True, env=env).stdout.splitlines()
            statuses = [line for line in res if line.startswith("webhook ")]
            timings = [int(line.split()[1]) for line in res if line.startswith("elapsed_ms ")]
            check(statuses == [
                "webhook HTTP/1.1 200 OK",
                "webhook HTTP/1.1 200 OK",
                "webhook HTTP/1.1 200 OK",
                "webhook HTTP/1.1 404 Not Found",
                "webhook HTTP/1.1 400 Bad Request",
            ], "saved webhook statuses: %r" % statuses)
            check(len(timings) == 5 and all(ms < 250 for ms in timings[:3]),
                  "saved webhook must return asynchronously without waiting for WAIT 400: %r ms" % timings)
            # Wait for the serialized background workers to complete all 5 steps.
            deadline = time.monotonic() + 5.0
            events = []
            while time.monotonic() < deadline:
                if os.path.exists(event_log):
                    with open(event_log) as f:
                        events = [line.strip() for line in f if line.strip()]
                    if len(events) >= 5:
                        break
                time.sleep(0.05)
            check(len(events) == 5, "expected 5 serialized script events, got %d: %r" % (len(events), events))
            parsed = []
            for line in events:
                ts_s, kind, payload = line.split(" ", 2)
                parsed.append((float(ts_s), kind, payload))
            # Script 1: Escape, WAIT 400, TEXT hello, Enter — strictly before Script 2 (Tab+Enter) and Script 3 (F5).
            check(parsed[0][1] == "KEY" and "A1010000290000000000" in parsed[0][2], "step 0 Escape: %r" % (parsed[0],))
            check(parsed[1][1] == "TEXT" and parsed[1][2] == "hello", "step 1 TEXT hello: %r" % (parsed[1],))
            check(parsed[1][0] - parsed[0][0] >= 0.35,
                  "WAIT 400 pause between Escape and TEXT: %.3fs" % (parsed[1][0] - parsed[0][0]))
            check(parsed[2][1] == "KEY" and "A1010000280000000000" in parsed[2][2], "step 2 Enter: %r" % (parsed[2],))
            check(parsed[3][1] == "KEY" and "A10100002B0000000000" in parsed[3][2] and
                  "A1010000280000000000" in parsed[3][2],
                  "step 3 serialized Script 2 Tab+Enter after Script 1 finished: %r" % (parsed[3],))
            check(parsed[4][1] == "KEY" and "A10100003E0000000000" in parsed[4][2],
                  "step 4 serialized Script 3 over-long F5: %r" % (parsed[4],))
        finally:
            fifo_stop.set()
            reader_thread.join(timeout=1.0)
    print("PASS Bluetooth Harmony device: consumer reports, saved scripts, async webhook and CommitBtDevices set")


if __name__ == "__main__":
    main()
