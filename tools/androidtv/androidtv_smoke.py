#!/usr/bin/env python3
"""End-to-end smoke test: codex_androidtv against tools/androidtv/fake_tv.py, on this computer.

Builds nothing: pass a native codex_androidtv binary (see docs/BUILD.md, "codex_androidtv").

    python3 tools/androidtv/androidtv_smoke.py --codex-androidtv build/output/codex_androidtv-native

It checks: the hub identity is made on first use; a TV that acknowledges a secret it
never got, or never confirms the code, fails the pairing; pairing (a mistyped code is
caught before anything is sent, the right one pairs); the TV connects; PowerOff/PowerOn
send the power key only when the state differs, and wait for the TV to report its state
on a new connection; keys arrive; an unknown command still gets HTTP 200; other
TVs get the HDMI keys for InputHdmi1-4, while a Hisense TV gets the input's TV-input
URI (the keys again if it offers no app links); after the power key,
inputs wait until the TV reports it is on; a command queued behind PowerOn waits as
long as it does; a TV that drops off while turning on gets the power key again; and
forgetting the TV removes it. Input profiles: a bad one is refused whole; links from a
pattern or whole links, keys as they are (no vendor link), the input menu key by key with
its gap, and "don't switch" each work through the engine's input commands, including
Input5 and up; InputHdmi1-4 left out of a profile keep the built-in behaviour; a menu cut
off by a disconnect is dropped; a body shorter than its Content-Length is refused; the
profile survives a restart; Try sends Home, then the input 1.5 s later,
and refuses targets that don't hold, a TV that is off, and links to a TV without app links;
an empty profile goes back to built-in; forgetting the TV removes its profile.

MIT License, Copyright (c) 2026 Josh Lukens.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


class Fake:
    def __init__(self, cmd: list[str]):
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.events: list[dict] = []
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        for line in self.proc.stdout:
            try:
                self.events.append(json.loads(line))
            except ValueError:
                self.events.append({"event": "raw", "line": line.rstrip()})

    def wait_for(self, event: str, timeout: float = 10, since: int = 0, **match) -> dict:
        end = time.time() + timeout
        while time.time() < end:
            for e in self.events[since:]:
                if e.get("event") == event and all(e.get(k) == v for k, v in match.items()):
                    return e
            time.sleep(0.05)
        raise AssertionError(f"fake TV never logged {event} {match}; saw {self.events[since:][-8:]}")

    def count(self, event: str, since: int = 0, **match) -> int:
        return sum(1 for e in self.events[since:] if e.get("event") == event and all(e.get(k) == v for k, v in match.items()))


def call(port: int, path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method="POST" if data else "GET")
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=5) as r:
        assert r.status == 200, f"{path} answered {r.status}"
        out = json.loads(r.read())
    out["_ms"] = round((time.time() - t0) * 1000)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--codex-androidtv", required=True)
    ap.add_argument("--port", type=int, default=18095)
    ap.add_argument("--keep", action="store_true", help="keep the temp directory")
    args = ap.parse_args()

    tmp = tempfile.mkdtemp(prefix="androidtv-smoke-")
    state = os.path.join(tmp, "androidtv")
    code_file = os.path.join(tmp, "code")
    mode_file = os.path.join(tmp, "mode")

    def set_mode(mode: str) -> None:
        with open(mode_file, "w") as mf:
            mf.write(mode)

    fake = Fake([sys.executable, "-I", os.path.join(HERE, "fake_tv.py"), "--host", "127.0.0.1",
                 "--trust", os.path.join(state, "client.crt.der"), "--trust-wait", "--code-file", code_file,
                 "--mode-file", mode_file])
    daemon = subprocess.Popen([args.codex_androidtv, "--dir", state, "--port", str(args.port), "-v",
                               "--log", os.path.join(tmp, "codex-androidtv.log")])
    ok = False
    try:
        fake.wait_for("listening", port=6466)
        time.sleep(0.3)
        st = call(args.port, "/status")
        # The daemon starts making its identity at startup; on a fast computer
        # it can already be ready here.
        assert st["tvs"] == [] and st["identity"] in ("none", "preparing", "ready"), st

        def pair_until(states: tuple, timeout: float = 120) -> dict:
            end = time.time() + timeout
            while time.time() < end:
                r = call(args.port, "/pair/status")
                if r["state"] in states:
                    return r
                time.sleep(0.2)
            return r

        # The identity is made first ("preparing"). A peer that acknowledges a secret
        # it never got must not pair.
        set_mode("early-ack")
        r = call(args.port, "/pair/start", {"host": "127.0.0.1", "name": "Test TV"})
        assert r["state"] in ("preparing", "connecting"), r
        r = pair_until(("failed", "paired", "code"))
        assert r["state"] == "failed" and "out of order" in r["error"], r
        fake.wait_for("early_ack")
        assert call(args.port, "/status")["tvs"] == []

        # A TV that never confirms the code: pairing gives up instead of "checking" forever.
        set_mode("no-ack")
        call(args.port, "/pair/start", {"host": "127.0.0.1", "name": "Test TV"})
        r = pair_until(("code", "failed"))
        assert r["state"] == "code", r
        r = call(args.port, "/pair/finish", {"code": open(code_file).read().strip()})
        assert r["ok"] is True, r
        fake.wait_for("secret_ignored")
        r = pair_until(("failed", "paired"), timeout=25)
        assert r["state"] == "failed" and "confirm" in r["error"], r
        assert call(args.port, "/status")["tvs"] == []

        # Pairing: the TV shows a code.
        set_mode("")
        call(args.port, "/pair/start", {"host": "127.0.0.1", "name": "Test TV"})
        r = pair_until(("code", "failed"))
        assert r["state"] == "code", r
        assert call(args.port, "/status")["identity"] == "ready"
        code = open(code_file).read().strip()
        wrong = format((int(code[:2], 16) + 1) % 256, "02X") + code[2:]
        r = call(args.port, "/pair/finish", {"code": wrong})
        assert r["ok"] is False and "match" in r["error"], r
        assert fake.count("bad_secret") == 0, "a mistyped code reached the TV"
        r = call(args.port, "/pair/finish", {"code": code.lower()})
        assert r["ok"] is True, r
        fake.wait_for("paired")
        end = time.time() + 5
        while call(args.port, "/pair/status")["state"] != "paired" and time.time() < end:
            time.sleep(0.1)
        r = call(args.port, "/pair/status")
        assert r["state"] == "paired" and r["tvId"].startswith("androidtv"), r
        tv = r["tvId"]
        # Cancelling after it finished names the TV, so the web app can tidy up.
        assert call(args.port, "/pair/cancel", {})["tvId"] == tv

        # The remote session comes up by itself.
        fake.wait_for("remote_configured")
        end = time.time() + 5
        while time.time() < end:
            st = call(args.port, "/status")
            if st["tvs"] and st["tvs"][0]["connected"]:
                break
            time.sleep(0.1)
        assert st["tvs"][0]["connected"] and st["tvs"][0]["on"] and st["tvs"][0]["name"] == "Test TV", st

        def cmd(name: str) -> dict:
            r = call(args.port, "/cmd", {"device": tv, "command": name})
            assert r["_ms"] < 300, f"/cmd took {r['_ms']} ms"
            return r

        mark = len(fake.events)
        assert cmd("PowerOff")["ok"]
        fake.wait_for("power", since=mark, on=False)
        time.sleep(0.5)
        mark = len(fake.events)
        cmd("PowerOff")
        time.sleep(0.8)
        assert fake.count("key", since=mark) == 0, "PowerOff sent a key while already off"
        cmd("PowerOn")
        fake.wait_for("power", since=mark, on=True)
        mark = len(fake.events)
        cmd("VolumeUp")
        fake.wait_for("key", since=mark, code=24)
        # A TV without an input URI (this one says it is a FakeCo) gets the HDMI
        # keys, KEYCODE_TV_INPUT_HDMI_1..4, for all four inputs, never an app link.
        assert call(args.port, "/status")["tvs"][0]["vendor"] == "FakeCo"
        for n in range(1, 5):
            cmd(f"InputHdmi{n}")
            fake.wait_for("key", since=mark, code=242 + n)
        assert fake.count("app_link", since=mark) == 0, "a non-Hisense TV got an input by app link"
        mark = len(fake.events)
        cmd("app:https://www.netflix.com/title")
        fake.wait_for("app_link", since=mark, link="https://www.netflix.com/title")
        r = cmd("NoSuchCommand")
        assert r["ok"] is False, r
        r = call(args.port, "/cmd", {"device": "androidtvdeadbeef", "command": "PowerOn"})
        assert r["ok"] is False, r

        # Restart: the paired TV comes back from disk and reconnects.
        daemon.terminate()
        daemon.wait(5)
        mark = len(fake.events)
        daemon = subprocess.Popen([args.codex_androidtv, "--dir", state, "--port", str(args.port)])
        fake.wait_for("remote_configured", since=mark)

        # A new connection reports the power state late (the TV is on; the new
        # daemon starts not knowing). PowerOn must wait for remote_start rather
        # than toggle the TV off.
        daemon.terminate()
        daemon.wait(5)
        set_mode("start-delay=2")
        mark = len(fake.events)
        daemon = subprocess.Popen([args.codex_androidtv, "--dir", state, "--port", str(args.port)])
        fake.wait_for("remote_configured", since=mark)
        end = time.time() + 5
        while not (call(args.port, "/status")["tvs"] or [{}])[0].get("connected") and time.time() < end:
            time.sleep(0.05)
        cmd("PowerOn")
        fake.wait_for("remote_start_sent", since=mark)
        time.sleep(0.8)
        assert fake.count("key", since=mark) == 0, "PowerOn toggled a TV that was already on"
        set_mode("")

        def restart_connected() -> int:
            nonlocal daemon
            daemon.terminate()
            daemon.wait(5)
            mark = len(fake.events)
            daemon = subprocess.Popen([args.codex_androidtv, "--dir", state, "--port", str(args.port), "-v",
                                       "--log", os.path.join(tmp, "codex-androidtv.log")])
            fake.wait_for("remote_configured", since=mark)
            end = time.time() + 5
            while not (call(args.port, "/status")["tvs"] or [{}])[0].get("connected") and time.time() < end:
                time.sleep(0.05)
            return mark

        hisense = "content://android.media.tv/passthrough/com.hisense.tv.hitvinput%2F.hdmi.HdmiTvInputService%2FHW"

        # A Hisense TV ignores the HDMI key codes: InputHdmi<n> opens HW<n+1>'s
        # passthrough URI. Other keys are unchanged.
        # Give the TV a MAC (a locally administered one), so the Wake-on-LAN
        # paths run: the daemon learns it by ARP on a real network.
        tsv = os.path.join(state, "tvs.tsv")
        rows = open(tsv).read().split("\n")
        rows = ["\t".join(r.split("\t")[:2] + ["02:00:5e:00:00:01"] + r.split("\t")[3:]) if r.startswith(tv) else r for r in rows]
        open(tsv, "w").write("\n".join(rows))
        set_mode("vendor=Hisense")
        restart_connected()
        st = call(args.port, "/status")["tvs"][0]
        assert st["mac"] == "02:00:5e:00:00:01", st
        assert st["vendor"] == "Hisense" and st["model"] == "Fake", st
        mark = len(fake.events)
        cmd("InputHdmi1")
        fake.wait_for("app_link", since=mark, link=hisense + "2")
        cmd("InputHdmi4")
        fake.wait_for("app_link", since=mark, link=hisense + "5")
        cmd("InputNext")
        fake.wait_for("key", since=mark, code=178)
        assert fake.count("key", since=mark, code=243) == 0 and fake.count("key", since=mark, code=246) == 0

        # A Hisense TV that doesn't offer app links gets the HDMI keys instead.
        set_mode("vendor=Hisense no-applink")
        mark = restart_connected()
        e = fake.wait_for("remote_configured", since=mark)
        assert not e["features"] & 0x200, e   # the daemon took up no app links (F_APPLINK)
        assert call(args.port, "/status")["tvs"][0]["vendor"] == "Hisense"
        mark = len(fake.events)
        for n in range(1, 5):
            cmd(f"InputHdmi{n}")
            fake.wait_for("key", since=mark, code=242 + n)
        assert fake.count("app_link", since=mark) == 0, "an input went by app link to a TV without app links"
        set_mode("vendor=Hisense")
        restart_connected()

        # After the power key, an input waits until the TV reports that it is on.
        mark = len(fake.events)
        cmd("PowerOff")
        fake.wait_for("power", since=mark, on=False)
        set_mode("vendor=Hisense wake-delay=2")
        mark = len(fake.events)
        cmd("PowerOn")
        cmd("InputHdmi2")
        e = fake.wait_for("app_link", since=mark, timeout=10, link=hisense + "3")
        assert e["awake"] is True, f"the input reached a TV still waking up: {e}"

        # Behind a PowerOn, a command waits as long as it does: here the TV takes
        # 10 s to report its state, longer than a lone command may wait (8 s).
        set_mode("vendor=Hisense start-delay=10")
        mark = restart_connected()
        cmd("PowerOn")
        cmd("InputHdmi3")
        fake.wait_for("app_link", since=mark, timeout=16, link=hisense + "4")
        assert fake.count("key", since=mark, code=26) == 0, "PowerOn toggled a TV that was already on"

        # A TV that ignores the power key and drops off the network (still shutting
        # down) gets the power key again once it is back, then the input.
        set_mode("vendor=Hisense")
        mark = len(fake.events)
        cmd("PowerOff")
        fake.wait_for("power", since=mark, on=False)
        set_mode("vendor=Hisense power-drop-once")
        mark = len(fake.events)
        cmd("PowerOn")
        cmd("InputHdmi1")
        fake.wait_for("power_dropped", since=mark)
        fake.wait_for("power", since=mark, timeout=15, on=True)
        e = fake.wait_for("app_link", since=mark, timeout=15, link=hisense + "2")
        assert e["awake"] is True, e
        log_text = open(os.path.join(tmp, "codex-androidtv.log")).read()
        assert "trying again" in log_text and "sent Wake-on-LAN to 02:00:5e:00:00:01" in log_text

        # A retry that finds the TV back on by itself (Wake-on-LAN woke it)
        # sends just the input...
        set_mode("vendor=Hisense")
        mark = len(fake.events)
        cmd("PowerOff")
        fake.wait_for("power", since=mark, on=False)
        set_mode("vendor=Hisense power-drop-once wake-on-return")
        mark = len(fake.events)
        cmd("PowerOn")
        cmd("InputHdmi1")
        fake.wait_for("power_dropped", since=mark)
        fake.wait_for("app_link", since=mark, timeout=15, link=hisense + "2")
        assert fake.count("key", since=mark, code=26) == 0, "keyed a TV that came back on"

        # ...and the next PowerOn gets its own retry: the count from the last
        # one doesn't carry over.
        set_mode("vendor=Hisense")
        mark = len(fake.events)
        cmd("PowerOff")
        fake.wait_for("power", since=mark, on=False)
        set_mode("vendor=Hisense power-drop-once")
        mark = len(fake.events)
        cmd("PowerOn")
        cmd("InputHdmi2")
        fake.wait_for("power_dropped", since=mark)
        fake.wait_for("power", since=mark, timeout=15, on=True)
        fake.wait_for("app_link", since=mark, timeout=15, link=hisense + "3")

        # A TV that ignores the power key and goes silent (no pings) on the open
        # connection is dropped when the wait for "on" ends, then tried again.
        set_mode("vendor=Hisense")
        mark = len(fake.events)
        cmd("PowerOff")
        fake.wait_for("power", since=mark, on=False)
        set_mode("vendor=Hisense quiet-once")
        mark = len(fake.events)
        cmd("PowerOn")
        cmd("InputHdmi3")
        fake.wait_for("power_quiet", since=mark)
        fake.wait_for("power", since=mark, timeout=20, on=True)
        e = fake.wait_for("app_link", since=mark, timeout=10, link=hisense + "4")
        assert e["awake"] is True, e
        assert "went quiet while turning on" in open(os.path.join(tmp, "codex-androidtv.log")).read()

        # A TV that never reports "on" after the power key, but keeps talking,
        # doesn't hold the queue for ever: after 8 s the rest goes anyway.
        set_mode("vendor=Hisense")
        mark = len(fake.events)
        cmd("PowerOff")
        fake.wait_for("power", since=mark, on=False)
        set_mode("vendor=Hisense wake-delay=30")
        mark = len(fake.events)
        t0 = time.time()
        cmd("PowerOn")
        cmd("InputHdmi2")
        fake.wait_for("app_link", since=mark, timeout=14, link=hisense + "3")
        assert time.time() - t0 > 7, "the input didn't wait for the TV to report it was on"
        assert "sending the rest anyway" in open(os.path.join(tmp, "codex-androidtv.log")).read()

        # ...and with nothing queued behind it the wait still ends (a timer, not
        # the queue): a lone PowerOn to a TV that never confirms.
        set_mode("vendor=Hisense")
        mark = len(fake.events)
        cmd("PowerOff")
        fake.wait_for("power", since=mark, on=False)
        set_mode("vendor=Hisense wake-delay=30")
        before = open(os.path.join(tmp, "codex-androidtv.log")).read().count("sending the rest anyway")
        cmd("PowerOn")
        end = time.time() + 12
        while time.time() < end and open(os.path.join(tmp, "codex-androidtv.log")).read().count("sending the rest anyway") == before:
            time.sleep(0.2)
        assert open(os.path.join(tmp, "codex-androidtv.log")).read().count("sending the rest anyway") > before

        # A PowerOn that expires (the TV never came back) takes what was queued
        # behind it along: the input isn't sent when the TV turns up later.
        set_mode("vendor=Hisense offline")
        end = time.time() + 6
        while (call(args.port, "/status")["tvs"] or [{}])[0].get("connected") and time.time() < end:
            time.sleep(0.1)
        cmd("PowerOn")
        cmd("InputHdmi2")
        end = time.time() + 26
        while time.time() < end and "didn't come on; dropped 1 queued command" not in open(os.path.join(tmp, "codex-androidtv.log")).read():
            time.sleep(0.5)
        assert "didn't come on; dropped 1 queued command" in open(os.path.join(tmp, "codex-androidtv.log")).read()
        mark = len(fake.events)
        set_mode("vendor=Hisense")
        fake.wait_for("remote_configured", since=mark, timeout=40)
        time.sleep(2)
        assert fake.count("app_link", since=mark) == 0 and fake.count("key", since=mark) == 0, fake.events[mark:]

        # The activity started again while the TV is unreachable: the second
        # PowerOn joins the first and renews its wait, so the TV that comes
        # back after 24 s still turns on and ends on the newer input.
        mark = len(fake.events)
        cmd("PowerOff")
        fake.wait_for("power", since=mark, on=False)
        set_mode("vendor=Hisense offline")
        end = time.time() + 6
        while (call(args.port, "/status")["tvs"] or [{}])[0].get("connected") and time.time() < end:
            time.sleep(0.1)
        cmd("PowerOn")
        cmd("InputHdmi1")
        time.sleep(12)
        cmd("PowerOn")
        cmd("InputHdmi2")
        time.sleep(12)
        mark = len(fake.events)
        set_mode("vendor=Hisense")
        fake.wait_for("power", since=mark, timeout=20, on=True)
        e = fake.wait_for("app_link", since=mark, timeout=10, link=hisense + "3")
        assert e["awake"] is True, e
        assert fake.count("key", since=mark, code=26) == 1, "PowerOn was pressed twice"

        # A PowerOff queued behind a waking TV wins over the retry: the TV that
        # ignored the key and dropped off isn't keyed on again.
        mark = len(fake.events)
        cmd("PowerOff")
        fake.wait_for("power", since=mark, on=False)
        set_mode("vendor=Hisense power-drop-once")
        mark = len(fake.events)
        cmd("PowerOn")
        fake.wait_for("power_dropped", since=mark)
        cmd("PowerOff")
        time.sleep(6)
        assert fake.count("power", since=mark, on=True) == 0, "the retry turned on a TV the user had turned off"

        # ...and so does one that arrives after the retry is queued: the retry
        # and the input behind it are cancelled, not sent first.
        set_mode("vendor=Hisense")
        end = time.time() + 10
        while not (call(args.port, "/status")["tvs"] or [{}])[0].get("connected") and time.time() < end:
            time.sleep(0.1)
        mark = len(fake.events)
        cmd("Mute")   # a key re-arms the fake TV's once-only modes
        fake.wait_for("key", since=mark, code=164)
        log_path = os.path.join(tmp, "codex-androidtv.log")
        retries = open(log_path).read().count("trying again")
        set_mode("vendor=Hisense power-drop-once")
        mark = len(fake.events)
        cmd("PowerOn")
        cmd("InputHdmi2")
        fake.wait_for("power_dropped", since=mark)
        end = time.time() + 5
        while open(log_path).read().count("trying again") == retries and time.time() < end:
            time.sleep(0.05)
        assert open(log_path).read().count("trying again") > retries, "the PowerOn wasn't queued again"
        cmd("PowerOff")
        time.sleep(8)
        assert fake.count("power", since=mark, on=True) == 0, "the retry went ahead of a later PowerOff"
        assert fake.count("app_link", since=mark) == 0, fake.events[mark:]
        assert "PowerOff cancels a PowerOn not sent yet; dropped 2 queued command(s)" in open(log_path).read()

        # A TV that Wake-on-LAN powers fully on reports standby while it boots:
        # the PowerOn waits for that to settle instead of keying it off again.
        set_mode("vendor=Hisense")
        end = time.time() + 10
        while not (call(args.port, "/status")["tvs"] or [{}])[0].get("connected") and time.time() < end:
            time.sleep(0.1)
        cmd("PowerOff")
        time.sleep(1)
        set_mode("vendor=Hisense offline")
        end = time.time() + 6
        while (call(args.port, "/status")["tvs"] or [{}])[0].get("connected") and time.time() < end:
            time.sleep(0.1)
        mark = len(fake.events)
        cmd("PowerOn")
        cmd("InputHdmi2")
        time.sleep(1)
        set_mode("vendor=Hisense boot-on=2")
        fake.wait_for("power", since=mark, timeout=20, on=True, by="boot")
        e = fake.wait_for("app_link", since=mark, timeout=10, link=hisense + "3")
        assert e["awake"] is True, e
        assert fake.count("key", since=mark, code=26) == 0, "keyed a TV that was booting on from Wake-on-LAN"
        set_mode("vendor=Hisense")
        mark = len(fake.events)
        cmd("PowerOff")
        fake.wait_for("power", since=mark, on=False)

        # A burst of keys to an unreachable TV doesn't push its PowerOn out of
        # the queue.
        set_mode("vendor=Hisense offline")
        end = time.time() + 6
        while (call(args.port, "/status")["tvs"] or [{}])[0].get("connected") and time.time() < end:
            time.sleep(0.1)
        cmd("PowerOn")
        for _ in range(14):
            cmd("Mute")
        mark = len(fake.events)
        set_mode("vendor=Hisense")
        fake.wait_for("power", since=mark, timeout=20, on=True)
        set_mode("")

        # Input profiles (POST /inputs, inputs-<id>.tsv): how the web app says
        # the TV switches inputs, overriding the built-in behaviour above.
        def post_text(path: str, text: str) -> dict:
            req = urllib.request.Request(f"http://127.0.0.1:{args.port}{path}", data=text.encode(),
                                         method="POST", headers={"Content-Type": "text/plain"})
            with urllib.request.urlopen(req, timeout=5) as r:
                return json.loads(r.read())

        def wait_on() -> dict:
            end = time.time() + 10
            while time.time() < end:
                st = (call(args.port, "/status")["tvs"] or [{}])[0]
                if st.get("connected") and st.get("on"):
                    return st
                time.sleep(0.1)
            raise AssertionError("the TV didn't come back on")

        profile_path = os.path.join(state, f"inputs-{tv}.tsv")
        st = wait_on()
        assert st["inputs"] == "builtin" and st["appLinks"] is True, st
        assert call(args.port, f"/inputs?device={tv}")["profile"] is None
        # A profile that doesn't hold is refused whole, and nothing changes.
        for bad, why in [
            ("method\tlaser\n", "unknown method"),
            ("slot\t1\t243\tuntested\t-\n", "no method"),
            ("method\tkeys\nslot\t1\tabc\tuntested\t-\n", "key code"),
            ("method\tkeys\nslot\t40\t243\tuntested\t-\n", "slot is"),
            ("method\tkeys\nslot\t1\t243\tmaybe\t-\n", "status"),
            ("method\tkeys\nslot\t1\t243\tworks\tyesterday\n", "date"),
            ("method\tkeys\nslot\t1\t243\tworks\t-\nslot\t1\t244\tworks\t-\n", "twice"),
            ("method\tlink\npattern\tcontent://x/HW\nslot\t1\t2\tuntested\t-\n", "{n}"),
            ("method\tlink\nslot\t1\tnot a link\tuntested\t-\n", "link"),
            ("method\tkeys\npattern\tcontent://x/{n}\n", "only the link method"),
            ("method\tmenu\ngap\t5\n", "gap"),
        ]:
            r = post_text(f"/inputs?device={tv}", bad)
            assert r["ok"] is False and why in r["error"], (bad, r)
        assert not os.path.exists(profile_path)
        assert call(args.port, "/status")["tvs"][0]["inputs"] == "builtin"

        # Links from a pattern; slot 7 is Input7.
        fake_pattern = "content://android.media.tv/passthrough/fake%2FHW{n}"
        prof = (f"method\tlink\npattern\t{fake_pattern}\n"
                "slot\t1\t2\tworks\t2026-11-12\nslot\t7\t9\tuntested\t-\n")
        assert post_text(f"/inputs?device={tv}", prof)["ok"]
        assert call(args.port, f"/inputs?device={tv}")["profile"] == prof
        assert call(args.port, "/status")["tvs"][0]["inputs"] == "link"
        mark = len(fake.events)
        cmd("InputHdmi1")
        fake.wait_for("app_link", since=mark, link=fake_pattern.replace("{n}", "2"))
        cmd("Input7")
        fake.wait_for("app_link", since=mark, link=fake_pattern.replace("{n}", "9"))
        assert cmd("Input8")["ok"] is False, "a slot the profile doesn't set was sent"
        assert cmd("Input33")["ok"] is False
        # InputHdmi2 isn't in the profile: the built-in behaviour (the fake
        # TV says it's a Hisense here: HDMI 2's input link).
        assert cmd("InputHdmi2")["ok"] is True
        fake.wait_for("app_link", since=mark, link=hisense + "3")
        # A long press opens the link once, on the press.
        mark = len(fake.events)
        cmd("InputHdmi1:start")
        cmd("InputHdmi1:end")
        time.sleep(0.8)
        assert fake.count("app_link", since=mark) == 1, "a long press opened the link twice"
        # The profile survives a restart.
        restart_connected()
        assert call(args.port, "/status")["tvs"][0]["inputs"] == "link"
        mark = len(fake.events)
        cmd("Input7")
        fake.wait_for("app_link", since=mark, link=fake_pattern.replace("{n}", "9"))

        # A whole link per input.
        prof = "method\tlink\nslot\t1\tcontent://x/one\tuntested\t-\nslot\t2\thttps://example.com/two\tfailed\t2026-11-12\n"
        assert post_text(f"/inputs?device={tv}", prof)["ok"]
        mark = len(fake.events)
        cmd("InputHdmi2")
        fake.wait_for("app_link", since=mark, link="https://example.com/two")

        # Keys from the profile go as they are, even on a Hisense (which
        # otherwise gets its input links for the HDMI keys).
        set_mode("vendor=Hisense")
        restart_connected()
        wait_on()
        prof = "method\tkeys\nslot\t1\t243\tuntested\t-\nslot\t5\t170\tuntested\t-\n"
        assert post_text(f"/inputs?device={tv}", prof)["ok"]
        mark = len(fake.events)
        cmd("InputHdmi1")
        fake.wait_for("key", since=mark, code=243)
        cmd("Input5")
        fake.wait_for("key", since=mark, code=170)
        assert fake.count("app_link", since=mark) == 0, "a profile key became a vendor input link"
        # InputHdmi1-4 left out of a profile keep the built-in behaviour (a
        # button may still be bound to one); Input5 and up have nothing.
        mark = len(fake.events)
        assert cmd("InputHdmi2")["ok"] is True
        fake.wait_for("app_link", since=mark, link=hisense + "3")
        assert cmd("Input6")["ok"] is False

        # A body shorter than its Content-Length is refused, not parsed.
        with socket.create_connection(("127.0.0.1", args.port), timeout=5) as so:
            so.sendall(f"POST /inputs?device={tv} HTTP/1.0\r\nContent-Length: 200\r\n\r\nmethod\tnone\n".encode())
            reply = b""
            while chunk := so.recv(4096):   # the daemon closes after its reply
                reply += chunk
            reply = reply.decode()
        assert "incomplete" in reply, reply
        assert call(args.port, f"/inputs?device={tv}")["profile"] == prof

        # The input menu: InputNext, Down to the position, Select, a gap apart.
        prof = "method\tmenu\ngap\t300\nslot\t1\t1\tuntested\t-\nslot\t2\t3\tuntested\t-\n"
        assert post_text(f"/inputs?device={tv}", prof)["ok"]
        mark = len(fake.events)
        cmd("InputHdmi2")
        fake.wait_for("key", since=mark, timeout=10, code=23)
        keys = [e for e in fake.events[mark:] if e.get("event") == "key"]
        assert [e["code"] for e in keys] == [178, 20, 20, 23], keys
        gaps = [b["t"] - a["t"] for a, b in zip(keys, keys[1:])]
        assert all(g >= 0.25 for g in gaps), gaps
        mark = len(fake.events)
        cmd("InputHdmi1")
        fake.wait_for("key", since=mark, timeout=10, code=23)
        assert [e["code"] for e in fake.events[mark:] if e.get("event") == "key"] == [178, 23]

        # An input menu cut off by the TV dropping is dropped, not finished
        # after the reconnect (Down/Select with no menu open would act on
        # whatever has focus).
        assert post_text(f"/inputs?device={tv}", "method\tmenu\ngap\t1500\nslot\t2\t3\tuntested\t-\n")["ok"]
        mark = len(fake.events)
        cmd("InputHdmi2")
        fake.wait_for("key", since=mark, code=178)
        set_mode("vendor=Hisense offline")
        end = time.time() + 5
        while call(args.port, "/status")["tvs"][0]["connected"] and time.time() < end:
            time.sleep(0.05)
        set_mode("vendor=Hisense")
        wait_on()
        time.sleep(2)
        assert [e["code"] for e in fake.events[mark:] if e.get("event") == "key"] == [178], fake.events[mark:]

        # "Don't switch inputs": an input command is taken and sends nothing.
        assert post_text(f"/inputs?device={tv}", "method\tnone\n")["ok"]
        mark = len(fake.events)
        assert cmd("InputHdmi1")["ok"] is True
        time.sleep(0.8)
        assert fake.count("key", since=mark) == 0 and fake.count("app_link", since=mark) == 0

        # Try (POST /try): one target now, unsaved, Home first and the input
        # 1.5 s later.
        mark = len(fake.events)
        r = call(args.port, "/try", {"device": tv, "method": "link", "pattern": fake_pattern, "value": "4"})
        assert r["ok"], r
        e = fake.wait_for("app_link", since=mark, link=fake_pattern.replace("{n}", "4"))
        home = [x for x in fake.events[mark:] if x.get("event") == "key" and x.get("code") == 3]
        assert home and e["t"] - home[0]["t"] >= 1.4, (home, e)
        mark = len(fake.events)
        assert call(args.port, "/try", {"device": tv, "method": "keys", "value": "244", "home": "0"})["ok"]
        fake.wait_for("key", since=mark, code=244)
        assert fake.count("key", since=mark, code=3) == 0, "home 0 still pressed Home"
        for body, why in [
            ({"device": tv, "method": "keys", "value": "x"}, "key code"),
            ({"device": tv, "method": "link", "value": "nolink"}, "link"),
            ({"device": tv, "method": "link", "pattern": "content://x/HW", "value": "2"}, "{n}"),
            ({"device": tv, "method": "menu", "value": "99"}, "position"),
            ({"device": tv, "method": "beam", "value": "1"}, "Choose"),
            ({"device": "androidtvdeadbeef", "method": "keys", "value": "243"}, "No such TV"),
        ]:
            r = call(args.port, "/try", body)
            assert r["ok"] is False and why in r["error"], (body, r)
        mark = len(fake.events)
        cmd("PowerOff")
        fake.wait_for("power", since=mark, on=False)
        time.sleep(0.5)
        r = call(args.port, "/try", {"device": tv, "method": "keys", "value": "243"})
        assert r["ok"] is False and "off" in r["error"], r
        mark = len(fake.events)
        assert call(args.port, "/try", {"device": tv, "method": "power", "value": "on"})["ok"]
        fake.wait_for("power", since=mark, on=True)
        wait_on()
        set_mode("vendor=Hisense no-applink")
        restart_connected()
        st = wait_on()
        assert st["appLinks"] is False, st
        r = call(args.port, "/try", {"device": tv, "method": "link", "value": "content://x/one"})
        assert r["ok"] is False and "links" in r["error"], r
        set_mode("")

        # An empty profile goes back to the built-in behaviour.
        assert post_text(f"/inputs?device={tv}", "")["ok"]
        assert not os.path.exists(profile_path)
        assert call(args.port, "/status")["tvs"][0]["inputs"] == "builtin"
        # Forgetting the TV (below) removes its profile too.
        assert post_text(f"/inputs?device={tv}", "method\tkeys\n")["ok"]
        assert os.path.exists(profile_path)

        r = call(args.port, "/forget", {"id": tv})
        assert r["ok"], r
        st = call(args.port, "/status")
        assert st["tvs"] == [], st
        assert not os.path.exists(os.path.join(state, f"tv-{tv}.crt.der"))
        assert not os.path.exists(profile_path), "forgetting the TV left its input profile"
        ok = True
        print("androidtv smoke: OK")
    finally:
        daemon.terminate()
        fake.proc.terminate()
        if not ok:
            print("--- codex_androidtv log ---")
            try:
                print(open(os.path.join(tmp, "codex-androidtv.log")).read()[-4000:])
            except OSError:
                pass
            print("--- fake TV events ---")
            for e in fake.events[-30:]:
                print(e)
        if not args.keep:
            shutil.rmtree(tmp, ignore_errors=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
