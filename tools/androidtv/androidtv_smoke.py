#!/usr/bin/env python3
"""End-to-end smoke test: codex_androidtv against tools/androidtv/fake_tv.py, on this computer.

Builds nothing: pass a native codex_androidtv binary (see docs/BUILD.md, "codex_androidtv").

    python3 tools/androidtv/androidtv_smoke.py --codex-androidtv build/output/codex_androidtv-native

It checks: the hub identity is made on first use; a TV that acknowledges a secret it
never got, or never confirms the code, fails the pairing; pairing (a mistyped code is
caught before anything is sent, the right one pairs); the TV connects; PowerOff/PowerOn
send the power key only when the state differs, and wait for the TV to report its state
on a new connection; keys arrive; an unknown command still gets HTTP 200; on a
Hisense TV InputHdmi1-4 open the input by its TV-input URI; after the power key,
inputs wait until the TV reports it is on; a command queued behind PowerOn waits as
long as it does; a TV that drops off while turning on gets the power key again; and
forgetting the TV removes it.

MIT License, Copyright (c) 2026 Josh Lukens.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
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
        cmd("InputHdmi2")
        fake.wait_for("key", since=mark, code=244)
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

        r = call(args.port, "/forget", {"id": tv})
        assert r["ok"], r
        st = call(args.port, "/status")
        assert st["tvs"] == [], st
        assert not os.path.exists(os.path.join(state, f"tv-{tv}.crt.der"))
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
