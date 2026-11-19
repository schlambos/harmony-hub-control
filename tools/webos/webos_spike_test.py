#!/usr/bin/env python3
"""Phase A protocol spike verification: C + BearSSL codex_webos against fake_webos_tv.py.

Proves from hub-side C+BearSSL code over BOTH wss:// (TLS 1.2 self-signed) and
ws:// (including auto fallback when wss is unavailable):
  1. WebSocket handshake (HTTP 101 + Sec-WebSocket-Accept verification)
  2. register pairing DENY path (403 -> state=denied, no key stored)
  3. register pairing ACCEPT path (PROMPT -> registered -> key stored privately)
  4. Reconnect with saved client-key (no prompt)
  5. getExternalInputList + tv/switchInput (stable HDMI_2 port ID)
  6. getVolume + audio/volumeUp + audio/setMute
  7. listApps + com.webos.applicationManager/launch (Netflix)
  8. getPointerInputSocket handoff + pointer WebSocket button press (UP, ENTER, BACK)
  9. Client-key is NEVER printed in daemon logs or returned in HTTP API responses.

Usage:
    python3 tools/webos/webos_spike_test.py --codex-webos build/output/codex_webos-native
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


class FakeRunner:
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

    def snapshot_len(self) -> int:
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
            tail = self.events[since:][-10:]
        raise AssertionError(f"fake webOS TV never logged {event} {match}; tail={tail}")

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
        assert r.status == 200, f"{path} returned HTTP {r.status}"
        return json.loads(r.read().decode("utf-8"))


def wait_pair(port: int, states: tuple[str, ...], timeout: float = 8.0) -> dict:
    end = time.time() + timeout
    last = {}
    while time.time() < end:
        last = call(port, "/pair/status")
        if last.get("state") in states:
            return last
        time.sleep(0.05)
    raise AssertionError(f"pairing did not reach {states}; last={last}")


def wait_connected(port: int, tv_id: str, want_pointer: bool = True, timeout: float = 8.0) -> dict:
    end = time.time() + timeout
    last = {}
    while time.time() < end:
        st = call(port, "/status")
        tvs = [t for t in st.get("tvs", []) if t.get("id") == tv_id]
        if tvs:
            last = tvs[0]
            if last.get("connected") and (not want_pointer or last.get("pointerReady")):
                if last.get("inputs") and last.get("apps"):
                    return last
        time.sleep(0.05)
    raise AssertionError(f"TV {tv_id} did not become ready; last={last}")


def run_protocol_pass(binary: str, mode_label: str, enable_wss: bool, enable_ws: bool, expected_scheme: str) -> None:
    tmp = tempfile.mkdtemp(prefix=f"webos-spike-{mode_label}-")
    state = os.path.join(tmp, "webos")
    mode_file = os.path.join(tmp, "mode")
    log_path = os.path.join(tmp, "codex-webos.log")
    ws_port = free_port()
    wss_port = free_port()
    daemon_port = free_port()

    fake_args = [
        sys.executable,
        "-I",
        os.path.join(HERE, "fake_webos_tv.py"),
        "--host",
        "127.0.0.1",
        "--ws-port",
        str(ws_port if enable_ws else -1),
        "--wss-port",
        str(wss_port if enable_wss else -1),
        "--mode-file",
        mode_file,
        "--prompt-delay",
        "0.05",
    ]
    fake = FakeRunner(fake_args)
    daemon = subprocess.Popen(
        [
            binary,
            "--dir",
            state,
            "--port",
            str(daemon_port),
            "--ws-port",
            str(ws_port),
            "--wss-port",
            str(wss_port),
            "--log",
            log_path,
            "-v",
        ]
    )
    try:
        fake.wait_for("listening", scheme=expected_scheme)
        time.sleep(0.15)

        # 1. Pairing DENY path
        with open(mode_file, "w", encoding="utf-8") as f:
            f.write("deny")
        r = call(daemon_port, "/pair/start", {"host": "127.0.0.1", "name": "Living Room LG", "mac": "AA:BB:CC:11:22:33"})
        assert r["ok"], r
        ps = wait_pair(daemon_port, ("denied", "failed"))
        assert ps["state"] == "denied", f"expected denied, got {ps}"
        assert call(daemon_port, "/status")["tvs"] == [], "denied pairing must not persist TV"

        # 2. Pairing ACCEPT path
        with open(mode_file, "w", encoding="utf-8") as f:
            f.write("accept")
        r = call(daemon_port, "/pair/start", {"host": "127.0.0.1", "name": "Living Room LG", "mac": "AA:BB:CC:11:22:33"})
        assert r["ok"], r
        ps = wait_pair(daemon_port, ("paired", "failed", "denied"))
        assert ps["state"] == "paired" and ps["paired"] is True and ps["tvId"].startswith("webos"), ps
        tv_id = ps["tvId"]

        # Read the stored client-key from tvs.tsv solely to verify it NEVER leaks anywhere.
        tsv_path = os.path.join(state, "tvs.tsv")
        st_mode = os.stat(tsv_path).st_mode & 0o777
        assert st_mode == 0o600, f"tvs.tsv mode must be 0600, got {oct(st_mode)}"
        with open(tsv_path, "r", encoding="utf-8") as f:
            stored_key = f.readline().strip().split("\t")[5]
        assert len(stored_key) >= 16, "expected stored client-key in tvs.tsv"

        # 3. Verify automatic reconnect using saved client-key (no PROMPT) + metadata + pointer socket
        tv = wait_connected(daemon_port, tv_id, want_pointer=True)
        fake.wait_for("registered", reused=True, scheme=expected_scheme)
        fake.wait_for("pointer_connected", scheme=expected_scheme)
        assert [i["id"] for i in tv["inputs"]] == ["HDMI_1", "HDMI_2", "HDMI_3", "HDMI_4"], tv["inputs"]
        assert any(a["id"] == "netflix" and a["command"] == "App Netflix" for a in tv["apps"]), tv["apps"]
        assert not any(a["id"] == "com.webos.app.internal" for a in tv["apps"]), "hidden app must be filtered"

        # 4. Input switch (stable HDMI port ID)
        since = fake.snapshot_len()
        r = call(daemon_port, "/cmd", {"device": tv_id, "command": "Input HDMI 2"})
        assert r["ok"], r
        fake.wait_for("switch_input", since=since, inputId="HDMI_2")

        # 5. Volume change + Mute toggle
        since = fake.snapshot_len()
        assert call(daemon_port, "/cmd", {"device": tv_id, "command": "VolumeUp"})["ok"]
        fake.wait_for("volume", since=since, action="up")
        assert call(daemon_port, "/cmd", {"device": tv_id, "command": "Mute"})["ok"]
        fake.wait_for("mute", since=since, muted=True)

        # 6. App launch
        since = fake.snapshot_len()
        assert call(daemon_port, "/cmd", {"device": tv_id, "command": "App Netflix"})["ok"]
        fake.wait_for("launch_app", since=since, appId="netflix")

        # 7. Pointer-socket remote keys
        since = fake.snapshot_len()
        for cmd, btn in (("DirectionUp", "UP"), ("Select", "ENTER"), ("Back", "BACK")):
            assert call(daemon_port, "/cmd", {"device": tv_id, "command": cmd})["ok"]
            fake.wait_for("pointer_button", since=since, name=btn)

        # 8. Verify client-key NEVER appears in API replies or daemon logs
        api_dump = json.dumps(call(daemon_port, "/status")) + json.dumps(call(daemon_port, "/pair/status"))
        assert stored_key not in api_dump, "SECURITY FAILURE: client-key leaked in HTTP API response"
        with open(log_path, "r", encoding="utf-8") as f:
            log_text = f.read()
        assert stored_key not in log_text, "SECURITY FAILURE: client-key leaked in daemon log"

        print(f"PASS [{mode_label}] scheme={expected_scheme}: handshake, deny, accept, reconnect, input, volume, app, pointer, key-masking")
    finally:
        daemon.terminate()
        try:
            daemon.wait(timeout=3)
        except subprocess.TimeoutExpired:
            daemon.kill()
        fake.stop()
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--codex-webos", required=True)
    args = ap.parse_args()

    # Pass 1: wss:// (TLS 1.2 self-signed via BearSSL) preferred when both are up
    run_protocol_pass(args.codex_webos, "wss-primary", enable_wss=True, enable_ws=True, expected_scheme="wss")
    # Pass 2: auto fallback to ws:// when wss:// port is closed (older webOS TVs)
    run_protocol_pass(args.codex_webos, "ws-fallback", enable_wss=False, enable_ws=True, expected_scheme="ws")
    return 0


if __name__ == "__main__":
    sys.exit(main())
