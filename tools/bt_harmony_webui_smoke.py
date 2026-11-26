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
        # Saving a device backs up the resources and settings first; without
        # this the harness writes (and rotates) the build machine's real
        # /data/codex/resource-backups.
        backup_dir = os.path.join(work, "resource-backups")
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
                             '-DRESOURCE_BACKUP_DIR="%s"' % backup_dir,
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

            # Reviewer finding 1: stable script identity (savedid<id>) survives rename
            # and routes webhook execution to the renamed script.
            with open(bt_store, "w") as f:
                json.dump({
                    "version": 1,
                    "devices": [{
                        "id": "bt_1730000000_42",
                        "name": "Work Laptop",
                        "type": "btkeyboard",
                        "bdaddr": "AA:BB:CC:DD:EE:FF",
                        "harmony": True,
                        "commands": [],
                    }],
                }, f)
            sr_out = subprocess.run([exe, "save-rename-check"], capture_output=True, text=True,
                                    check=True, env=env).stdout.splitlines()
            add_line = next((l for l in sr_out if l.startswith("add ")), "")
            ren_line = next((l for l in sr_out if l.startswith("rename ")), "")
            id_add = add_line.split("id=", 1)[1].strip() if "id=" in add_line else ""
            id_ren = ren_line.split("id=", 1)[1].split()[0].strip() if "id=" in ren_line else ""
            check(bool(id_add) and id_add == id_ren and "name=Espresso" in ren_line,
                  "stable script id must be assigned on add and preserved on rename: %r" % sr_out)
            # Execute via stable savedid<id> token after rename!
            if os.path.exists(event_log):
                os.unlink(event_log)
            id_body = json.dumps({"device": "bt_1730000000_42", "command": "savedid" + id_add})
            id_res = subprocess.run([exe, "webhook-saved", id_body], capture_output=True, text=True,
                                    check=True, env=env).stdout.splitlines()
            check("webhook HTTP/1.1 200 OK" in id_res, "savedid webhook must succeed: %r" % id_res)
            deadline = time.monotonic() + 3.0
            id_events = []
            while time.monotonic() < deadline:
                if os.path.exists(event_log):
                    with open(event_log) as f:
                        id_events = [line.strip() for line in f if line.strip()]
                    if id_events:
                        break
                time.sleep(0.05)
            check(len(id_events) == 1 and "A10100003E0000000000" in id_events[0],
                  "savedid webhook must run renamed script F5: %r" % id_events)

            # Reviewer finding 2: fork failure (outer OR inner) must NOT report 200 queued!
            for stage in ("outer", "inner"):
                fail_env = env.copy()
                fail_env["BT_WEBHOOK_FAIL_FORK"] = stage
                fail_res = subprocess.run([exe, "webhook-saved", id_body], capture_output=True, text=True,
                                          check=True, env=fail_env).stdout.splitlines()
                check("webhook HTTP/1.1 503 Service Unavailable" in fail_res,
                      "%s fork failure must return 503, not 200 queued: %r" % (stage, fail_res))

            # Reviewer finding 2: lock open failure must fail closed and send 0 keystrokes!
            bad_lock_exe = os.path.join(work, "harness_bad_lock")
            subprocess.run(cc + ["-std=gnu99", "-O1", "-w", "-I", os.path.join(ROOT, "payload/source"),
                                 '-DWEBUI_AUTH_CONFIG="%s"' % auth_conf,
                                 '-DBT_DEVICE_STORE="%s"' % bt_store,
                                 '-DBT_WEBHOOK_LOCK_FILE="%s/no_such_dir/lock"' % work,
                                 '-DBT_TEXT_FIFO="%s"' % bt_fifo,
                                 '-DBT_TEXT_STATUS="%s"' % bt_status,
                                 '-DBT_TARGET_FILE="%s"' % bt_target,
                                 '-DBT_PROFILE_FILE="%s"' % bt_profile,
                                 '-DRESOURCE_BACKUP_DIR="%s"' % backup_dir,
                                 '-DCODEX_HAL_LTCP_BIN="%s"' % fake_hal,
                                 "-o", bad_lock_exe, os.path.join(ROOT, "tools/bt_harmony_webui_harness.c")],
                           check=True)
            if os.path.exists(event_log):
                os.unlink(event_log)
            lock_out = subprocess.run([bad_lock_exe, "run-saved", "bt_1730000000_42", "Espresso"],
                                      capture_output=True, text=True, check=True, env=env).stdout.strip()
            check(lock_out.startswith("rc -1 ") and "lock" in lock_out.lower() and not os.path.exists(event_log),
                  "run_saved_bt_command must fail closed without sending keystrokes on lock error: %r" % lock_out)

            # Upgrade regression: a pre-stable-ID command's original Harmony
            # token must still execute after rename. A referenced delete keeps
            # a hidden script record until the writer says the token is unused.
            with open(bt_store, "w") as f:
                json.dump({
                    "version": 1,
                    "devices": [{
                        "id": "bt_1730000000_42",
                        "name": "Work Laptop",
                        "type": "btkeyboard",
                        "bdaddr": "AA:BB:CC:DD:EE:FF",
                        "harmony": True,
                        "commands": [{
                            "name": "Cafe",
                            "delayMs": 20,
                            "script": "KEY f6",
                        }],
                    }],
                }, f)
            legacy_out = subprocess.run([exe, "legacy-rename-check"], capture_output=True,
                                        text=True, check=True, env=env).stdout.strip()
            check("id=c" in legacy_out and "name=Espresso" in legacy_out and "count=1" in legacy_out,
                  "legacy rename must retain one script and assign a stable ID: %r" % legacy_out)
            legacy_token = saved_value("Cafe")
            if os.path.exists(event_log):
                os.unlink(event_log)
            legacy_body = json.dumps({"device": "bt_1730000000_42", "command": legacy_token})
            legacy_res = subprocess.run([exe, "webhook-saved", legacy_body], capture_output=True,
                                        text=True, check=True, env=env).stdout.splitlines()
            check("webhook HTTP/1.1 200 OK" in legacy_res,
                  "legacy token must survive rename instead of returning 404: %r" % legacy_res)
            deadline = time.monotonic() + 3.0
            legacy_events = []
            while time.monotonic() < deadline:
                if os.path.exists(event_log):
                    with open(event_log) as f:
                        legacy_events = [line.strip() for line in f if line.strip()]
                    if legacy_events:
                        break
                time.sleep(0.05)
            check(len(legacy_events) == 1 and "A10100003F0000000000" in legacy_events[0],
                  "legacy token must execute the renamed F6 script: %r" % legacy_events)

            retained_env = env.copy()
            retained_env["BT_HARMONY_TEST_REPLY"] = json.dumps({
                "ok": True,
                "retainedCommands": [{
                    "entity": "bt_1730000000_42",
                    "device": "Work Laptop",
                    "command": "Cafe",
                    "value": legacy_token,
                }],
            })
            delete_out = subprocess.run([exe, "delete-command-check"], capture_output=True,
                                        text=True, check=True, env=retained_env).stdout.strip()
            with open(bt_store) as f:
                retained_store = json.load(f)
            retained_commands = retained_store["devices"][0]["commands"]
            check(len(retained_commands) == 1 and retained_commands[0].get("retained") is True,
                  "referenced delete must retain a runnable script record: %r / %r" %
                  (delete_out, retained_commands))
            current_set = json.loads(subprocess.run([exe, "current-set"], capture_output=True,
                                                    text=True, check=True, env=env).stdout)
            check(all(not c["value"].startswith("saved") for c in current_set["devices"][0]["commands"]),
                  "a deleted script must not be republished as an active command")
            if os.path.exists(event_log):
                os.unlink(event_log)
            deleted_res = subprocess.run([exe, "webhook-saved", legacy_body], capture_output=True,
                                         text=True, check=True, env=env).stdout.splitlines()
            check("webhook HTTP/1.1 200 OK" in deleted_res,
                  "referenced deleted token must execute instead of returning 404: %r" % deleted_res)
            deadline = time.monotonic() + 3.0
            deleted_events = []
            while time.monotonic() < deadline:
                if os.path.exists(event_log):
                    with open(event_log) as f:
                        deleted_events = [line.strip() for line in f if line.strip()]
                    if deleted_events:
                        break
                time.sleep(0.05)
            check(len(deleted_events) == 1 and "A10100003F0000000000" in deleted_events[0],
                  "referenced deleted token must run the retained F6 script: %r" % deleted_events)

            cleanup_env = env.copy()
            cleanup_env["BT_HARMONY_TEST_REPLY"] = json.dumps({"ok": True, "changed": True})
            cleanup_out = subprocess.run([exe, "sync-device-check"], capture_output=True,
                                         text=True, check=True, env=cleanup_env).stdout.strip()
            with open(bt_store) as f:
                cleaned_store = json.load(f)
            check(cleaned_store["devices"][0]["commands"] == [],
                  "last-reference cleanup must remove the hidden script record: %r / %r" %
                  (cleanup_out, cleaned_store))
            cleaned_res = subprocess.run([exe, "webhook-saved", legacy_body], capture_output=True,
                                         text=True, check=True, env=env).stdout.splitlines()
            check("webhook HTTP/1.1 404 Not Found" in cleaned_res,
                  "fully cleaned token should no longer resolve: %r" % cleaned_res)
            # The device saves above took their backups in the temp dir.
            check(os.path.isdir(backup_dir) and
                  any(name.startswith("settings_") for name in os.listdir(backup_dir)),
                  "device saves must back up into the harness's own RESOURCE_BACKUP_DIR: %r" %
                  (os.listdir(backup_dir) if os.path.isdir(backup_dir) else None))
        finally:
            fifo_stop.set()
            reader_thread.join(timeout=1.0)
    print("PASS Bluetooth Harmony device: consumer reports, saved scripts, async webhook and CommitBtDevices set")


if __name__ == "__main__":
    main()
