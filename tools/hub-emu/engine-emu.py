#!/usr/bin/env python3
"""hub-emu engine daemon — emulates the Harmony hub services that live on the
OTHER side of the box's own binaries.

The real codex_webui + codex_hbus binaries run unmodified (MIPS, under qemu).
This process fakes only what physical hardware/firmware provided:

  1. HBus WebSocket gateway on 127.0.0.1:8088 (the port the real codex_hbus
     client connects to). Speaks just enough RFC6455 for codex_hbus's framing.
     Replies use the genuine engine envelope:
       {"cmd": ..., "id": ..., "code": 200, "msg": "OK", "data": {...}}
  2. The offline activity writer: consumes /var/volatile/codex-activity-request.json
     ({"id","op":"CommitActivityResources",...}) written by codex_webui's
     offline_activity_commit(), persists the three resource lists, and answers
     via /var/volatile/codex-activity-response.json ({"id","ok":true}).
  3. A control plane on 0.0.0.0:8089 (NOT part of the emulated surface):
     POST /reset, GET /events, GET /status.

stdlib only. Python 3.9+.
"""

import base64
import hashlib
import json
import os
import re
import socket
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RESOURCE_DIR = "/data/resources"
SEED_DIR = "/seed/resources"
SETTINGS_SEED_DIR = "/seed/settings"
BACKUP_DIR = "/data/codex/resource-backups"
REQUEST_FILE = "/var/volatile/codex-activity-request.json"
RESPONSE_FILE = "/var/volatile/codex-activity-response.json"
STATE_FILE = "/var/volatile/engine-state.json"
RELOAD_FLAG = "/data/codex/reload_resources"
REBOOT_LOG = "/var/volatile/reboot-requests.log"
AUTH_CONFIG = "/data/codex/webui_auth.conf"
UPDATE_STATE_CONFIG = "/data/codex/update_state.conf"
UPDATE_STAGE_DIR = "/tmp/codex_update"

# Setup-page settings seeded at the exact paths codex_webui reads, with the
# permissions its save paths apply. Secrets in the seeds are obviously fake.
SETTINGS_TARGETS = {
    "mqtt-config.json": ("/data/codexmqtt/config.json", 0o600),
    "wpa_supplicant.conf": ("/etc/wpa_supplicant.conf", 0o600),
    "bt-devices.json": ("/data/codex/bt-devices.json", 0o644),
    "cloud_blocker.conf": ("/data/codex/cloud_blocker.conf", 0o644),
    "version": ("/etc/version", 0o644),
}

HBUS_HOST, HBUS_PORT = "127.0.0.1", 8088
CTRL_HOST, CTRL_PORT = "0.0.0.0", 8089

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
EVENT_CAP = 500

_lock = threading.Lock()
_events = []
_state = {"currentActivityId": "-1"}


def log(msg):
    print(f"[engine-emu] {msg}", flush=True)


def add_event(kind, **details):
    with _lock:
        _events.append({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "kind": kind, **details})
        del _events[:-EVENT_CAP]


def write_atomic(path, text):
    tmp = f"{path}.new"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        if not text.endswith("\n"):
            f.write("\n")
    os.replace(tmp, path)


def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            loaded = json.load(f)
        if isinstance(loaded, dict) and "currentActivityId" in loaded:
            _state.update(loaded)
    except (OSError, ValueError):
        pass


def save_state():
    write_atomic(STATE_FILE, json.dumps(_state))


def current_activity():
    with _lock:
        return str(_state["currentActivityId"])


def set_current_activity(activity_id):
    with _lock:
        _state["currentActivityId"] = str(activity_id)
        save_state()


def activity_exists(activity_id):
    if activity_id == "-1":
        return True
    try:
        with open(os.path.join(RESOURCE_DIR, "ActivityList.json"), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return False
    for activity in data.get("Activities", []):
        if str(activity.get("Id-")) == activity_id:
            return True
    return False


# ---------------------------------------------------------------- HBus gateway

def hbus_reply(cmd, request_id, code, msg, data):
    return json.dumps({"cmd": cmd, "id": request_id, "code": code, "msg": msg, "data": data})


def handle_hbus_message(text):
    try:
        envelope = json.loads(text)
        hbus = envelope["hbus"]
        cmd = str(hbus["cmd"])
        request_id = str(hbus["id"])
        params = hbus.get("params") or {}
    except (ValueError, KeyError, TypeError):
        log(f"unparseable hbus message: {text[:200]!r}")
        return None

    if cmd == "harmony.engine?getCurrentActivity":
        return hbus_reply(cmd, request_id, 200, "OK", {"result": current_activity()})

    if cmd == "harmony.engine?startactivity":
        activity_id = str(params.get("activityId", "")).strip()
        if not re.fullmatch(r"-?\d+", activity_id) or not activity_exists(activity_id):
            add_event("startactivity-rejected", activityId=activity_id)
            return hbus_reply(cmd, request_id, 500, "Unknown activity", {})
        set_current_activity(activity_id)
        add_event("startactivity", activityId=activity_id)
        return hbus_reply(cmd, request_id, 200, "OK", {})

    if cmd == "harmony.engine?holdaction":
        action_raw = params.get("action", "")
        action = {}
        try:
            action = json.loads(action_raw) if isinstance(action_raw, str) else dict(action_raw)
        except (ValueError, TypeError):
            pass
        add_event(
            "holdaction",
            status=str(params.get("status", "")),
            type=str(action.get("type", "")),
            deviceId=str(action.get("deviceId", "")),
            command=str(action.get("command", "")),
        )
        return hbus_reply(cmd, request_id, 200, "OK", {})

    if cmd == "ir.cap":
        add_event("ir-capture", note="no IR receiver in emulator; empty capture")
        time.sleep(0.5)
        return hbus_reply(cmd, request_id, 200, "OK", {})

    if cmd == "harmony.automation?discover":
        add_event("automation-discover")
        return hbus_reply(cmd, request_id, 200, "OK", {})

    add_event("hbus-unknown", cmd=cmd)
    log(f"unknown hbus cmd: {cmd}")
    return hbus_reply(cmd, request_id, 500, "Unknown command (hub-emu)", {})


def ws_recv_exact(conn, n):
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("peer closed")
        buf += chunk
    return buf


def ws_read_frame(conn):
    hdr = ws_recv_exact(conn, 2)
    fin = bool(hdr[0] & 0x80)
    opcode = hdr[0] & 0x0F
    masked = bool(hdr[1] & 0x80)
    length = hdr[1] & 0x7F
    if length == 126:
        length = struct.unpack(">H", ws_recv_exact(conn, 2))[0]
    elif length == 127:
        length = struct.unpack(">Q", ws_recv_exact(conn, 8))[0]
    if length > 8 * 1024 * 1024:
        raise ConnectionError("frame too large")
    mask = ws_recv_exact(conn, 4) if masked else None
    payload = ws_recv_exact(conn, length) if length else b""
    if mask:
        payload = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
    return fin, opcode, payload


def ws_send_frame(conn, opcode, payload):
    header = bytearray([0x80 | opcode])
    n = len(payload)
    if n < 126:
        header.append(n)
    elif n <= 0xFFFF:
        header.append(126)
        header += struct.pack(">H", n)
    else:
        header.append(127)
        header += struct.pack(">Q", n)
    conn.sendall(bytes(header) + payload)


def hbus_client(conn, peer):
    conn.settimeout(120)
    try:
        request = b""
        while b"\r\n\r\n" not in request:
            chunk = conn.recv(2048)
            if not chunk:
                return
            request += chunk
            if len(request) > 16384:
                return
        match = re.search(rb"Sec-WebSocket-Key:\s*(\S+)", request, re.IGNORECASE)
        key = match.group(1).decode("ascii", "replace") if match else ""
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        conn.sendall(
            (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
            ).encode()
        )
        message = b""
        while True:
            fin, opcode, payload = ws_read_frame(conn)
            if opcode == 0x8:  # close
                ws_send_frame(conn, 0x8, b"")
                return
            if opcode == 0x9:  # ping
                ws_send_frame(conn, 0xA, payload)
                continue
            if opcode == 0x1:
                message = payload
            elif opcode == 0x0:
                message += payload
            else:
                continue
            if not fin:
                continue
            reply = handle_hbus_message(message.decode("utf-8", "replace"))
            if reply is not None:
                ws_send_frame(conn, 0x1, reply.encode("utf-8"))
            message = b""
    except (ConnectionError, socket.timeout, OSError):
        pass
    finally:
        conn.close()


def hbus_server():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((HBUS_HOST, HBUS_PORT))
    server.listen(16)
    log(f"HBus gateway listening on {HBUS_HOST}:{HBUS_PORT}")
    while True:
        conn, peer = server.accept()
        threading.Thread(target=hbus_client, args=(conn, peer), daemon=True).start()


# ------------------------------------------------------- offline activity writer

RESOURCE_KEYS = (
    ("activityList", "ActivityList.json", "Activities"),
    ("mapList", "MapList.json", "ButtonMaps"),
    ("functionList", "FunctionList.json", "FunctionMaps"),
)

_last_commit_id = None


def writer_respond(request_id, ok, error=None):
    payload = {"id": request_id, "ok": ok}
    if error:
        payload["error"] = error
    write_atomic(RESPONSE_FILE, json.dumps(payload))


def process_commit_request():
    global _last_commit_id
    try:
        with open(REQUEST_FILE, encoding="utf-8") as f:
            raw = f.read()
    except OSError:
        return
    try:
        request = json.loads(raw)
        request_id = str(request["id"])
    except (ValueError, KeyError):
        match = re.search(r'"id"\s*:\s*"([^"]+)"', raw)
        if match:
            writer_respond(match.group(1), False, "activity transaction was not valid JSON")
        try:
            os.unlink(REQUEST_FILE)
        except OSError:
            pass
        return
    if request_id == _last_commit_id:
        return
    _last_commit_id = request_id
    if request.get("op") != "CommitActivityResources":
        writer_respond(request_id, False, f"unknown op {request.get('op')!r}")
    else:
        try:
            staged = []
            for key, filename, required in RESOURCE_KEYS:
                value = request[key]
                if not isinstance(value, dict) or not isinstance(value.get(required), list):
                    raise ValueError(f"{key} must contain a {required} array")
                staged.append((filename, json.dumps(value)))
            for filename, text in staged:
                write_atomic(os.path.join(RESOURCE_DIR, filename), text)
            writer_respond(request_id, True)
            add_event(
                "commit",
                activityChanged=bool(request.get("activityChanged")),
                mapChanged=bool(request.get("mapChanged")),
                functionChanged=bool(request.get("functionChanged")),
            )
        except (ValueError, KeyError, OSError) as error:
            writer_respond(request_id, False, str(error))
            add_event("commit-rejected", error=str(error))
    try:
        os.unlink(REQUEST_FILE)
    except OSError:
        pass


def writer_loop():
    log("offline activity writer polling " + REQUEST_FILE)
    while True:
        if os.path.exists(REQUEST_FILE):
            process_commit_request()
        time.sleep(0.1)


# --------------------------------------------------------------- control plane

def reboot_count():
    try:
        with open(REBOOT_LOG, encoding="utf-8") as f:
            return sum(1 for line in f if line.strip())
    except OSError:
        return 0


def do_reset():
    for name in os.listdir(SEED_DIR):
        with open(os.path.join(SEED_DIR, name), encoding="utf-8") as f:
            write_atomic(os.path.join(RESOURCE_DIR, name), f.read().rstrip("\n"))
    for name, (target, mode) in SETTINGS_TARGETS.items():
        with open(os.path.join(SETTINGS_SEED_DIR, name), encoding="utf-8") as f:
            seed = f.read().rstrip("\n")
        os.makedirs(os.path.dirname(target), exist_ok=True)
        write_atomic(target, seed)
        os.chmod(target, mode)
    for stale in (REQUEST_FILE, RESPONSE_FILE, RELOAD_FLAG, AUTH_CONFIG, UPDATE_STATE_CONFIG, REBOOT_LOG):
        try:
            os.unlink(stale)
        except OSError:
            pass
    if os.path.isdir(UPDATE_STAGE_DIR):
        for entry in os.listdir(UPDATE_STAGE_DIR):
            path = os.path.join(UPDATE_STAGE_DIR, entry)
            if not os.path.isdir(path):
                os.unlink(path)
        os.rmdir(UPDATE_STAGE_DIR)
    if os.path.isdir(BACKUP_DIR):
        for entry in os.listdir(BACKUP_DIR):
            path = os.path.join(BACKUP_DIR, entry)
            if os.path.isdir(path):
                for inner in os.listdir(path):
                    os.unlink(os.path.join(path, inner))
                os.rmdir(path)
    set_current_activity("-1")
    with _lock:
        _events.clear()
    add_event("reset")
    log("reset: resources+settings reseeded, auth/update/reboot state cleared, activity=-1, events cleared")


class ControlHandler(BaseHTTPRequestHandler):
    server_version = "hub-emu-control"

    def _json(self, status, payload):
        body = (json.dumps(payload) + "\n").encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/events":
            with _lock:
                events = list(_events)
            self._json(200, {"ok": True, "events": events})
        elif self.path == "/status":
            self._json(200, {
                "ok": True,
                "emulator": "hub-emu",
                "currentActivityId": current_activity(),
                "eventCount": len(_events),
                "rebootCount": reboot_count(),
            })
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path == "/reset":
            try:
                do_reset()
                self._json(200, {"ok": True, "currentActivityId": current_activity()})
            except OSError as error:
                self._json(500, {"ok": False, "error": str(error)})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def log_message(self, *_args):
        pass


def main():
    os.makedirs(RESOURCE_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(REQUEST_FILE), exist_ok=True)
    load_state()
    threading.Thread(target=hbus_server, daemon=True).start()
    threading.Thread(target=writer_loop, daemon=True).start()
    log(f"control plane on {CTRL_HOST}:{CTRL_PORT}")
    ThreadingHTTPServer((CTRL_HOST, CTRL_PORT), ControlHandler).serve_forever()


if __name__ == "__main__":
    main()
