#!/usr/bin/env python3
"""Comprehensive Phase B integration tests for codex_webos against fake_webos_tv.py.

Tests:
  - Strict input validation (host IPv4, MAC, proto, TV id)
  - Pairing deny, cancel, and accept paths
  - Private client-key storage (0600 tvs.tsv) and complete masking across API & logs
  - Full baseline command set: PowerOn (WoL), PowerOff, PowerToggle, VolumeUp/Down,
    Mute (toggle), Input HDMI 1-4 by stable port ID, App <name> launch, Play, Pause,
    PlayPause, Stop, DirectionUp/Down/Left/Right, Select, Back, Home, Exit
  - Discrete power honesty: PowerOn fails clearly without MAC; succeeds via WoL with MAC
  - Unreachable TV error discipline: non-PowerOn commands return ok=false (no silent success)
  - Sleep/off/drop + automatic reconnect with saved client-key
  - Daemon restart persistence (saved key reconnects without re-prompting)
  - Pointer socket unavailable graceful failure (no fake success)
  - Forget removes TV and erases key

Usage:
    python3 tools/webos/webos_smoke.py --codex-webos build/output/codex_webos-native
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


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeTV:
    def __init__(self, cmd: list[str]) -> None:
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.events: list[dict] = []
        self._lock = threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            try:
                ev = json.loads(line)
            except ValueError:
                ev = {"event": "raw", "line": line.rstrip()}
            with self._lock:
                self.events.append(ev)

    def mark(self) -> int:
        with self._lock:
            return len(self.events)

    def wait_for(self, event: str, timeout: float = 8.0, since: int = 0, **match) -> dict:
        end = time.time() + timeout
        while time.time() < end:
            with self._lock:
                items = list(self.events[since:])
            for e in items:
                if e.get("event") == event and all(e.get(k) == v for k, v in match.items()):
                    return e
            time.sleep(0.05)
        with self._lock:
            tail = self.events[since:][-12:]
        raise AssertionError(f"fake TV never logged {event} {match}; tail={tail}")

    def stop(self) -> None:
        self.proc.terminate()
        try:
            self.proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def call(port: int, path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=data,
        method="POST" if data is not None else "GET",
        headers={"Content-Type": "application/json"} if data is not None else {},
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        assert r.status == 200, f"{path} returned {r.status}"
        return json.loads(r.read().decode("utf-8"))


def wait_pair(port: int, states: tuple[str, ...], timeout: float = 8.0) -> dict:
    end = time.time() + timeout
    last = {}
    while time.time() < end:
        last = call(port, "/pair/status")
        if last.get("state") in states:
            return last
        time.sleep(0.05)
    raise AssertionError(f"pair did not reach {states}; last={last}")


def wait_tv(port: int, tv_id: str, connected: bool, pointer: bool = False, timeout: float = 10.0) -> dict:
    end = time.time() + timeout
    last = {}
    while time.time() < end:
        try:
            st = call(port, "/status")
        except OSError:
            time.sleep(0.05)
            continue
        found = [t for t in st.get("tvs", []) if t.get("id") == tv_id]
        if found:
            last = found[0]
            if last.get("connected") is connected and (not pointer or last.get("pointerReady")):
                if not connected or (last.get("inputs") and last.get("apps")):
                    return last
        time.sleep(0.05)
    raise AssertionError(f"TV {tv_id} did not reach connected={connected} pointer={pointer}; last={last}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--codex-webos", required=True)
    args = ap.parse_args()

    tmp = tempfile.mkdtemp(prefix="webos-smoke-")
    state = os.path.join(tmp, "webos")
    mode_file = os.path.join(tmp, "mode")
    log_path = os.path.join(tmp, "codex-webos.log")
    ws_port = free_port()
    wss_port = free_port()
    daemon_port = free_port()

    def set_mode(m: str) -> None:
        with open(mode_file, "w", encoding="utf-8") as f:
            f.write(m)

    set_mode("accept")
    fake = FakeTV([
        sys.executable, "-I", os.path.join(HERE, "fake_webos_tv.py"),
        "--host", "127.0.0.1",
        "--ws-port", str(ws_port),
        "--wss-port", str(wss_port),
        "--mode-file", mode_file,
        "--prompt-delay", "0.05",
    ])

    def start_daemon() -> subprocess.Popen:
        return subprocess.Popen([
            args.codex_webos,
            "--dir", state,
            "--port", str(daemon_port),
            "--ws-port", str(ws_port),
            "--wss-port", str(wss_port),
            "--log", log_path,
            "-v",
        ])

    daemon = start_daemon()
    try:
        fake.wait_for("listening", scheme="wss")
        time.sleep(0.2)

        # 1. Strict input validation
        assert not call(daemon_port, "/save", {"host": "not-an-ip", "name": "Bad"})["ok"]
        assert not call(daemon_port, "/save", {"host": "127.0.0.1;id", "name": "Bad"})["ok"]
        assert not call(daemon_port, "/save", {"host": "127.0.0.1", "mac": "00:00:00:00:00:00"})["ok"]
        assert not call(daemon_port, "/save", {"host": "127.0.0.1", "mac": "FF:FF:FF:FF:FF:FF"})["ok"]
        assert not call(daemon_port, "/save", {"host": "127.0.0.1", "mac": "ZZ:BB:CC:11:22:33"})["ok"]
        assert not call(daemon_port, "/save", {"host": "127.0.0.1", "proto": "http"})["ok"]
        assert not call(daemon_port, "/save", {"id": "../evil", "host": "127.0.0.1"})["ok"]

        # 2. Save unpaired TV (without MAC first), verify commands fail clearly before pairing
        saved = call(daemon_port, "/save", {"host": "127.0.0.1", "name": "Theater LG"})
        assert saved["ok"] and saved["tv"]["paired"] is False, saved
        tv_id = saved["tv"]["id"]
        unpaired_cmd = call(daemon_port, "/cmd", {"device": tv_id, "command": "VolumeUp"})
        assert not unpaired_cmd["ok"] and "not paired" in unpaired_cmd["error"].lower(), unpaired_cmd
        no_mac_on = call(daemon_port, "/cmd", {"device": tv_id, "command": "PowerOn"})
        assert not no_mac_on["ok"] and "mac" in no_mac_on["error"].lower(), no_mac_on

        # 3. Pairing DENY path
        set_mode("deny")
        assert call(daemon_port, "/pair/start", {"id": tv_id})["ok"]
        ps = wait_pair(daemon_port, ("denied", "failed"))
        assert ps["state"] == "denied", ps
        assert call(daemon_port, "/status")["tvs"][0]["paired"] is False

        # 4. Pairing CANCEL path
        set_mode("accept")
        assert call(daemon_port, "/pair/start", {"id": tv_id})["ok"]
        c = call(daemon_port, "/pair/cancel", {})
        assert c["ok"] and c["state"] == "idle", c

        # 5. Pairing ACCEPT path + MAC configured
        assert call(daemon_port, "/save", {"id": tv_id, "host": "127.0.0.1", "mac": "aa-bb-cc-11-22-33", "name": "Theater LG"})["ok"]
        assert call(daemon_port, "/pair/start", {"id": tv_id})["ok"]
        ps = wait_pair(daemon_port, ("paired", "denied", "failed"))
        assert ps["state"] == "paired" and ps["paired"] is True and ps["tvId"] == tv_id, ps

        tsv_path = os.path.join(state, "tvs.tsv")
        assert (os.stat(tsv_path).st_mode & 0o777) == 0o600
        with open(tsv_path, "r", encoding="utf-8") as f:
            cols = f.readline().strip().split("\t")
        assert cols[2] == "AA:BB:CC:11:22:33", cols
        stored_key = cols[5]
        assert len(stored_key) >= 16

        tv = wait_tv(daemon_port, tv_id, connected=True, pointer=True)
        assert tv["paired"] is True and tv["mac"] == "AA:BB:CC:11:22:33"

        # 6. Full baseline command set
        m = fake.mark()
        assert call(daemon_port, "/cmd", {"device": tv_id, "command": "VolumeUp"})["ok"]
        fake.wait_for("volume", since=m, action="up")
        assert call(daemon_port, "/cmd", {"device": tv_id, "command": "VolumeDown"})["ok"]
        fake.wait_for("volume", since=m, action="down")
        assert call(daemon_port, "/cmd", {"device": tv_id, "command": "Mute"})["ok"]
        fake.wait_for("mute", since=m, muted=True)
        assert call(daemon_port, "/cmd", {"device": tv_id, "command": "Mute"})["ok"]
        fake.wait_for("mute", since=m, muted=False)

        for n in (1, 2, 3, 4):
            m = fake.mark()
            assert call(daemon_port, "/cmd", {"device": tv_id, "command": f"Input HDMI {n}"})["ok"]
            fake.wait_for("switch_input", since=m, inputId=f"HDMI_{n}")

        for app_cmd, app_id in (("App Netflix", "netflix"), ("App Plex", "cdp-30")):
            m = fake.mark()
            assert call(daemon_port, "/cmd", {"device": tv_id, "command": app_cmd})["ok"]
            fake.wait_for("launch_app", since=m, appId=app_id)

        m = fake.mark()
        assert call(daemon_port, "/cmd", {"device": tv_id, "command": "Play"})["ok"]
        fake.wait_for("media", since=m, action="play")
        assert call(daemon_port, "/cmd", {"device": tv_id, "command": "Pause"})["ok"]
        fake.wait_for("media", since=m, action="pause")
        assert call(daemon_port, "/cmd", {"device": tv_id, "command": "PlayPause"})["ok"]
        fake.wait_for("media", since=m, action="play")
        assert call(daemon_port, "/cmd", {"device": tv_id, "command": "PlayPause"})["ok"]
        fake.wait_for("media", since=m, action="pause")
        assert call(daemon_port, "/cmd", {"device": tv_id, "command": "Stop"})["ok"]
        fake.wait_for("media", since=m, action="stop")

        for cmd, btn in (
            ("DirectionUp", "UP"), ("DirectionDown", "DOWN"),
            ("DirectionLeft", "LEFT"), ("DirectionRight", "RIGHT"),
            ("Select", "ENTER"), ("Back", "BACK"), ("Home", "HOME"), ("Exit", "EXIT"),
            ("PowerToggle", "POWER"),
        ):
            m = fake.mark()
            assert call(daemon_port, "/cmd", {"device": tv_id, "command": cmd})["ok"]
            fake.wait_for("pointer_button", since=m, name=btn)

        # 7. Refresh metadata
        ref = call(daemon_port, "/refresh", {"id": tv_id})
        assert ref["ok"] and len(ref["tv"]["inputs"]) == 4 and len(ref["tv"]["apps"]) >= 5, ref

        # 8. PowerOff -> TV turns off and goes offline -> unreachable errors -> PowerOn (WoL) -> reconnect
        m = fake.mark()
        assert call(daemon_port, "/cmd", {"device": tv_id, "command": "PowerOff"})["ok"]
        fake.wait_for("turn_off", since=m)
        set_mode("offline")
        wait_tv(daemon_port, tv_id, connected=False)

        # Unreachable TV MUST fail non-PowerOn commands (no silent success!)
        for cmd in ("VolumeUp", "Input HDMI 1", "App Netflix", "DirectionUp", "PowerOff"):
            r = call(daemon_port, "/cmd", {"device": tv_id, "command": cmd})
            assert not r["ok"] and "not connected" in r["error"].lower(), f"{cmd} unexpectedly succeeded: {r}"

        # PowerOn with MAC succeeds via WoL and reconnects once TV comes back
        assert call(daemon_port, "/cmd", {"device": tv_id, "command": "PowerOn"})["ok"]
        m = fake.mark()
        set_mode("accept")
        wait_tv(daemon_port, tv_id, connected=True, pointer=True)
        fake.wait_for("registered", since=m, reused=True)

        # 9. Daemon restart persistence: saved client-key reconnects without prompt
        daemon.terminate()
        daemon.wait(timeout=3)
        m = fake.mark()
        daemon = start_daemon()
        wait_tv(daemon_port, tv_id, connected=True, pointer=True)
        fake.wait_for("registered", since=m, reused=True)

        # 10. Pointer socket unavailable: SSAP works, pointer key fails clearly (not faked)
        set_mode("no-pointer")
        daemon.terminate()
        daemon.wait(timeout=3)
        daemon = start_daemon()
        tv_np = wait_tv(daemon_port, tv_id, connected=True, pointer=False)
        time.sleep(0.25)
        assert call(daemon_port, "/cmd", {"device": tv_id, "command": "VolumeUp"})["ok"]
        ptr_err = call(daemon_port, "/cmd", {"device": tv_id, "command": "DirectionUp"})
        assert not ptr_err["ok"] and "pointer" in ptr_err["error"].lower(), ptr_err

        # 11. Security check: client-key NEVER in any API response or log
        api_text = (
            json.dumps(call(daemon_port, "/status"))
            + json.dumps(call(daemon_port, "/pair/status"))
            + json.dumps(call(daemon_port, "/refresh", {"id": tv_id}))
        )
        assert stored_key not in api_text, "SECURITY: client-key leaked in API!"
        with open(log_path, "r", encoding="utf-8") as f:
            log_text = f.read()
        assert stored_key not in log_text, "SECURITY: client-key leaked in log!"

        # 12. Forget removes TV
        assert call(daemon_port, "/forget", {"id": tv_id})["ok"]
        assert call(daemon_port, "/status")["tvs"] == []
        with open(tsv_path, "r", encoding="utf-8") as f:
            assert f.read().strip() == ""

        print("webos_smoke: ALL CHECKS PASSED")
        return 0
    finally:
        daemon.terminate()
        try:
            daemon.wait(timeout=3)
        except subprocess.TimeoutExpired:
            daemon.kill()
        fake.stop()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
