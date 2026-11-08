#!/usr/bin/env python3
"""End-to-end smoke test: codex_androidtv against tools/androidtv/fake_tv.py, on this computer.

Builds nothing: pass a native codex_androidtv binary (see docs/BUILD.md, "codex_androidtv").

    python3 tools/androidtv/androidtv_smoke.py --codex-androidtv build/output/codex_androidtv-native

It checks: the hub identity is made on first use; a TV that acknowledges a secret it
never got, or never confirms the code, fails the pairing; pairing (a mistyped code is
caught before anything is sent, the right one pairs); the TV connects; PowerOff/PowerOn
send the power key only when the state differs, and wait for the TV to report its state
on a new connection; keys arrive; an unknown command still gets HTTP 200; and
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
