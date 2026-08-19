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
import ctypes
import hashlib
import json
import os
import resource
import shutil
import stat
import subprocess
import re
import signal
import socket
import struct
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit
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
HANDOFF_BACKUP_DIR = "/data/codex-backups"
UPDATE_BACKUP_DIR = "/data/codex/update-backups"
RETENTION_EXTERNAL_TARGET = "/data/hub-emu-retention-external.bin"
RETENTION_COPY_FAILURE_SEAM = os.path.join(RESOURCE_DIR, "ProtocolList.json")
MIPS_WEBUI = "/opt/hub/bin/codex_webui.mips"
RESOURCE_NAME_RE = re.compile(r"^\d{8}_\d{6}$")
SETTINGS_NAME_RE = re.compile(r"^settings_\d{8}_\d{6}$")
HANDOFF_NAME_RE = re.compile(r"^webui-handoff-\d{8}-\d{6}$")
UPDATE_NAME_RE = re.compile(r"^(?:0|[1-9]\d*)$")
RETENTION_LIMITS = {
    "resources": 768 * 1024,
    "settings": 64 * 1024,
    "handoff": 256 * 1024,
    "updates": 1536 * 1024,
    "combined": 2 * 1024 * 1024,
}

# Step 4A capacity-gated install fixtures. /mnt/data is the authoritative view
# of the emulated writable /data flash: the entrypoint mounts a FIXED-SIZE
# tmpfs at /mnt/data (deterministic f_frsize/f_bavail, no JFFS2 equivalence
# claim) and bind-mounts it over /data, so the C binary's /mnt/data authority
# probe and its O_NOFOLLOW destination walk both succeed. Capacity is driven
# exactly with a single filler file.
MNT_DATA = "/mnt/data"
DATA_ROOT = "/data"
CAPACITY_FILLER = "/mnt/data/.hub-emu-capacity-filler"
HUB_ID_FILE = "/data/codex/hub_id"
STAGE_PREFIX = "/var/volatile/codex-install-"
STAGE_PARENT = "/var/volatile"
HANDOFF_ROOT = "/data/codex-backups"
HANDOFF_BUDGET = 262144
# The only real-binary maintenance modes the control plane may execute. The
# server mode (bare port arg) is deliberately NOT runnable from here.
MAINTENANCE_FLAGS = (
    "--storage-status",
    "--install-plan",
    "--install-file",
    "--file-status",
    "--prune-backups",
)
# Mirror of the real binary's installer destination allowlist (exact
# paths, modes, and ORDER of INSTALL_DESTINATION_ALLOWLIST in
# payload/source/codex_webui.c), used ONLY to seed/inspect/reset fixture
# destinations. Enforcement stays in the C binary; if this table drifts,
# the binary's own refusal tokens prove it.
INSTALL_DESTINATIONS = {
    "/data/codex/bin/codex_webui": 0o755,
    "/data/codex/bin/codex_bthid_keyboard": 0o755,
    "/data/codex/bin/codex_bt_pair_agent": 0o755,
    "/data/codex/bin/codex_hal_ltcp": 0o755,
    "/data/codex/bin/codex_hbus": 0o755,
    "/data/codex/bin/codex_portal": 0o755,
    "/data/codex/bin/codex_dhcpd": 0o755,
    "/data/codex/bin/dropbearmulti": 0o755,
    "/usr/sbin/dropbear": 0o755,
    "/usr/sbin/dropbearkey": 0o755,
    "/data/codex/init.sh": 0o755,
    "/data/codex/offline_egress_guard.sh": 0o755,
    "/data/codex/recovery_ap.sh": 0o755,
    "/etc/init.d/rcS.local": 0o755,
    "/opt/luaworks/tasks/connectserver/netservicestarter.lua": 0o644,
    "/pkg/codexactivity/codexactivity.lua": 0o644,
    "/pkg/codexmqtt/codexmqtt.lua": 0o644,
    "/data/codex/hub_id": 0o644,
    "/data/codex/cloud_blocker.conf": 0o644,
    "/etc/tdeenable": 0o644,
    "/pkg/codexactivity/manifest.json": 0o644,
    "/pkg/codexmqtt/manifest.json": 0o644,
    "/data/codexmqtt/config.json": 0o600,
}

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


def remove_fixture_path(path):
    if os.path.islink(path) or not os.path.isdir(path):
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        return
    shutil.rmtree(path)


def reset_retention_artifacts():
    for root in (BACKUP_DIR, HANDOFF_BACKUP_DIR, UPDATE_BACKUP_DIR):
        remove_fixture_path(root)
    os.makedirs(BACKUP_DIR, exist_ok=True)
    remove_fixture_path(RETENTION_EXTERNAL_TARGET)
    if os.path.islink(RETENTION_COPY_FAILURE_SEAM):
        with open(
                os.path.join(SEED_DIR, "ProtocolList.json"),
                encoding="utf-8") as source:
            write_atomic(
                RETENTION_COPY_FAILURE_SEAM,
                source.read().rstrip("\n"))


def valid_calendar_name(name, prefix, separator):
    if prefix:
        if not name.startswith(prefix):
            return False
        stamp = name[len(prefix):]
    else:
        stamp = name
    try:
        parsed = datetime.strptime(stamp, f"%Y%m%d{separator}%H%M%S")
    except ValueError:
        return False
    return parsed.year >= 1970


def retention_family(root, name):
    if root == BACKUP_DIR:
        if SETTINGS_NAME_RE.fullmatch(name) and valid_calendar_name(name, "settings_", "_"):
            return "settings"
        if RESOURCE_NAME_RE.fullmatch(name) and valid_calendar_name(name, "", "_"):
            return "resources"
    elif root == HANDOFF_BACKUP_DIR:
        if HANDOFF_NAME_RE.fullmatch(name) and valid_calendar_name(name, "webui-handoff-", "-"):
            return "handoff"
    elif root == UPDATE_BACKUP_DIR:
        if UPDATE_NAME_RE.fullmatch(name):
            try:
                if int(name) <= (1 << 63) - 1:
                    return "updates"
            except ValueError:
                pass
    return None


def digest_tree(path):
    digest = hashlib.sha256()
    total = 0
    regular_files = 0

    def visit(current, relative):
        nonlocal total, regular_files
        for entry in sorted(os.scandir(current), key=lambda item: item.name):
            child_relative = f"{relative}/{entry.name}" if relative else entry.name
            child_stat = entry.stat(follow_symlinks=False)
            digest.update(child_relative.encode("utf-8"))
            digest.update(b"\0")
            digest.update(str(stat.S_IFMT(child_stat.st_mode)).encode("ascii"))
            digest.update(b"\0")
            if stat.S_ISDIR(child_stat.st_mode):
                visit(entry.path, child_relative)
                continue
            total += child_stat.st_size
            digest.update(str(child_stat.st_size).encode("ascii"))
            digest.update(b"\0")
            if stat.S_ISREG(child_stat.st_mode):
                regular_files += 1
                with open(entry.path, "rb") as source:
                    while True:
                        chunk = source.read(65536)
                        if not chunk:
                            break
                        digest.update(chunk)
            elif stat.S_ISLNK(child_stat.st_mode):
                digest.update(os.readlink(entry.path).encode("utf-8"))

    visit(path, "")
    return {
        "bytes": total,
        "regularFiles": regular_files,
        "sha256": digest.hexdigest(),
    }


def snapshot_entry(path):
    entry_stat = os.lstat(path)
    if stat.S_ISDIR(entry_stat.st_mode):
        measured = digest_tree(path)
        return {"type": "directory", **measured}
    digest = hashlib.sha256()
    if stat.S_ISREG(entry_stat.st_mode):
        with open(path, "rb") as source:
            for chunk in iter(lambda: source.read(65536), b""):
                digest.update(chunk)
        kind = "file"
    elif stat.S_ISLNK(entry_stat.st_mode):
        digest.update(os.readlink(path).encode("utf-8"))
        kind = "symlink"
    else:
        kind = "other"
    return {
        "type": kind,
        "bytes": entry_stat.st_size,
        "regularFiles": 1 if kind == "file" else 0,
        "sha256": digest.hexdigest(),
    }


def inspect_retention():
    families = {
        name: {"ceiling": RETENTION_LIMITS[name], "bytes": 0, "generations": []}
        for name in ("resources", "settings", "handoff", "updates")
    }
    untouched = []
    for root in (BACKUP_DIR, HANDOFF_BACKUP_DIR, UPDATE_BACKUP_DIR):
        if not os.path.isdir(root):
            continue
        for entry in sorted(os.scandir(root), key=lambda item: item.name):
            family = retention_family(root, entry.name)
            if family and entry.is_dir(follow_symlinks=False):
                measured = digest_tree(entry.path)
                families[family]["bytes"] += measured["bytes"]
                families[family]["generations"].append({
                    "name": entry.name,
                    **measured,
                })
            else:
                untouched.append({
                    "root": root,
                    "name": entry.name,
                    **snapshot_entry(entry.path),
                })
    for value in families.values():
        value["count"] = len(value["generations"])
    external = None
    if os.path.lexists(RETENTION_EXTERNAL_TARGET):
        external = snapshot_entry(RETENTION_EXTERNAL_TARGET)
    recognized_bytes = sum(value["bytes"] for value in families.values())
    return {
        "ok": True,
        "families": families,
        "recognizedBytes": recognized_bytes,
        "combinedCeiling": RETENTION_LIMITS["combined"],
        "untouched": untouched,
        "externalTarget": external,
    }


def sparse_generation(root, name, size, nested=True, external_symlink=False):
    generation = os.path.join(root, name)
    payload_dir = os.path.join(generation, "nested") if nested else generation
    os.makedirs(payload_dir, exist_ok=True)
    payload = os.path.join(payload_dir, "fixture.bin")
    with open(payload, "wb") as output:
        output.truncate(size)
    if external_symlink:
        os.symlink(RETENTION_EXTERNAL_TARGET, os.path.join(generation, "outside-link"))


def calendar_names(start, count, prefix="", separator="_"):
    names = []
    for offset in range(count):
        stamp = start + timedelta(hours=offset)
        names.append(prefix + stamp.strftime(f"%Y%m%d{separator}%H%M%S"))
    return names


def seed_standard_retention():
    with open(RETENTION_EXTERNAL_TARGET, "wb") as output:
        output.write(b"HUB-EMU-FAKE-EXTERNAL-TARGET\n")
    resource_names = [
        "19700101_000000",
        "20260727_174852",
        *calendar_names(datetime(2026, 7, 28, tzinfo=timezone.utc), 67),
        "20260804_220000",
    ]
    for name in resource_names:
        sparse_generation(
            BACKUP_DIR, name, 24 * 1024,
            external_symlink=name == "19700101_000000")
    os.makedirs(os.path.join(BACKUP_DIR, "99991231_235959"), exist_ok=True)
    settings_names = [
        *calendar_names(
            datetime(2026, 6, 1, tzinfo=timezone.utc), 67,
            prefix="settings_"),
        "settings_20260804_220000",
    ]
    for name in settings_names:
        sparse_generation(BACKUP_DIR, name, 8 * 1024)
    handoff_names = calendar_names(
        datetime(2026, 7, 20, tzinfo=timezone.utc), 8,
        prefix="webui-handoff-", separator="-")
    os.makedirs(HANDOFF_BACKUP_DIR, exist_ok=True)
    for name in handoff_names:
        sparse_generation(HANDOFF_BACKUP_DIR, name, 48 * 1024)
    update_start = datetime(2026, 7, 1, tzinfo=timezone.utc)
    update_names = [
        str(int((update_start + timedelta(hours=offset)).timestamp()))
        for offset in range(39)
    ]
    update_names.append(str(int(datetime(2026, 8, 4, 22, tzinfo=timezone.utc).timestamp())))
    os.makedirs(UPDATE_BACKUP_DIR, exist_ok=True)
    for name in update_names:
        sparse_generation(UPDATE_BACKUP_DIR, name, 64 * 1024)
    manual = os.path.join(HANDOFF_BACKUP_DIR, "manual-diagnostics", "nested")
    os.makedirs(manual, exist_ok=True)
    with open(os.path.join(manual, "owner-created.bin"), "wb") as output:
        output.write(b"HUB-EMU-FAKE-MANUAL-ROLLBACK\n")
    with open(os.path.join(HANDOFF_BACKUP_DIR, "owner-note.txt"), "wb") as output:
        output.write(b"HUB-EMU-FAKE-OWNER-NOTE\n")
    with open(
            os.path.join(HANDOFF_BACKUP_DIR, "webui-handoff-20260101-000000"),
            "wb") as output:
        output.write(b"HUB-EMU-FAKE-RECOGNIZED-NAME-NON-DIRECTORY\n")


def seed_creation_retention():
    sparse_generation(BACKUP_DIR, "19700101_000000", 350 * 1024)
    sparse_generation(BACKUP_DIR, "20260804_220000", 350 * 1024)
    os.makedirs(os.path.join(BACKUP_DIR, "99991231_235959"), exist_ok=True)


def seed_copy_failure_retention():
    sparse_generation(BACKUP_DIR, "20260804_220000", 100 * 1024)


def seed_oversized_retention():
    sparse_generation(BACKUP_DIR, "settings_20260727_174852", 8 * 1024)
    sparse_generation(BACKUP_DIR, "settings_20260804_220000", 80 * 1024)


def seed_retention_scenario(scenario):
    reset_retention_artifacts()
    if scenario == "standard":
        seed_standard_retention()
    elif scenario == "creation":
        seed_creation_retention()
    elif scenario == "copy-failure":
        seed_copy_failure_retention()
    elif scenario == "oversized":
        seed_oversized_retention()
    else:
        raise ValueError(f"unknown retention scenario: {scenario}")
    return inspect_retention()


def count_webui_processes():
    count = 0
    for process in os.listdir("/proc"):
        if not process.isdigit():
            continue
        try:
            with open(f"/proc/{process}/cmdline", "rb") as command_file:
                command = command_file.read().replace(b"\0", b" ")
        except OSError:
            continue
        if MIPS_WEBUI.encode() in command:
            count += 1
    return count


def run_real_retention():
    before_processes = count_webui_processes()
    started = time.monotonic()
    completed = subprocess.run(
        ["qemu-mips", MIPS_WEBUI, "--prune-backups"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=20,
        check=False,
    )
    elapsed_ms = round((time.monotonic() - started) * 1000)
    return {
        "ok": completed.returncode == 0,
        "exitCode": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
        "elapsedMs": elapsed_ms,
        "webuiProcessesBefore": before_processes,
        "webuiProcessesAfter": count_webui_processes(),
    }


def arm_copy_failure():
    target = RETENTION_COPY_FAILURE_SEAM
    remove_fixture_path(target)
    os.symlink("/proc/self/mem", target)
    target_stat = os.stat(target)
    return {
        "ok": stat.S_ISREG(target_stat.st_mode),
        "target": target,
        "source": "/proc/self/mem",
        "apparentBytes": target_stat.st_size,
    }


# ------------------------------------------------- Step 4A capacity fixtures

def capacity_filler_bytes():
    try:
        return os.stat(CAPACITY_FILLER).st_size
    except OSError:
        return 0


def set_capacity_filler(target_free_bytes):
    """Drive /mnt/data free capacity to an exact byte target with one filler.

    statvfs free changes in whole fragments (blocks are allocated or freed),
    so the loop allocates/shrinks the filler and re-measures until
    f_bavail * f_frsize equals the target. Blocks are really allocated
    (posix_fallocate), never sparse. target <= 0 removes the filler.

    Truthful reporting: if the exact target is unreachable on this
    filesystem (fragment granularity, memory pressure), the response carries
    ok=False + reason="target_unreachable" + requested/reached numbers.
    Callers MUST check ok instead of inferring the miss themselves.
    """
    if target_free_bytes <= 0:
        try:
            os.unlink(CAPACITY_FILLER)
        except FileNotFoundError:
            pass
        return inspect_capacity()

    def free_bytes():
        measured = os.statvfs(MNT_DATA)
        return measured.f_bavail * (measured.f_frsize or measured.f_bsize)

    fd = os.open(CAPACITY_FILLER, os.O_RDWR | os.O_CREAT, 0o600)
    reached = False
    try:
        size = os.fstat(fd).st_size
        previous_free = None
        for _ in range(32):
            free = free_bytes()
            if free == target_free_bytes:
                reached = True
                break
            if previous_free is not None and free == previous_free:
                break  # no progress: target unreachable on this filesystem
            previous_free = free
            delta = free - target_free_bytes
            if delta > 0:
                try:
                    os.posix_fallocate(fd, size, delta)
                except OSError:
                    os.lseek(fd, size, os.SEEK_SET)
                    payload = b"\0" * delta
                    while payload:
                        payload = payload[os.write(fd, payload):]
            else:
                os.ftruncate(fd, max(0, size + delta))
            size = os.fstat(fd).st_size
    finally:
        os.close(fd)
    result = inspect_capacity()
    if not reached and result.get("bytesAvailable") != target_free_bytes:
        result = {
            **result,
            "ok": False,
            "reason": "target_unreachable",
            "requested": target_free_bytes,
            "reached": result.get("bytesAvailable"),
        }
    return result


def inspect_capacity():
    mounted = False
    try:
        with open("/proc/mounts", encoding="utf-8") as mounts:
            for line in mounts:
                fields = line.split()
                if len(fields) >= 4 and fields[1] == MNT_DATA:
                    mounted = True
                    break
    except OSError:
        pass
    try:
        measured = os.statvfs(MNT_DATA)
    except OSError:
        # Detached fixture (data-authority detach) or unmounted state: report
        # the shape without numbers instead of failing the control plane.
        return {
            "ok": False,
            "storagePath": MNT_DATA,
            "dataRoot": DATA_ROOT,
            "dataIsSymlink": os.path.islink(DATA_ROOT),
            "mntDataMounted": mounted,
            "fragmentBytes": None,
            "blocksAvailable": None,
            "bytesAvailable": None,
            "fillerBytes": capacity_filler_bytes(),
        }
    fragment = measured.f_frsize or measured.f_bsize
    return {
        "ok": True,
        "storagePath": MNT_DATA,
        "dataRoot": DATA_ROOT,
        "dataIsSymlink": os.path.islink(DATA_ROOT),
        "mntDataMounted": mounted,
        "fragmentBytes": fragment,
        "blocksAvailable": measured.f_bavail,
        "bytesAvailable": measured.f_bavail * fragment,
        "fillerBytes": capacity_filler_bytes(),
    }


# Obvious fake "old installed hub" contents for the Step 4A destinations the
# emulator owns. /data/codex/bin/codex_hbus + codex_hal_ltcp are re-seeded as
# the REAL qemu wrapper stubs so the box stays functional after a reset.
STEP4A_SEED_SIZES = {
    "/data/codex/bin/codex_webui": 12 * 1024,
    "/data/codex/bin/codex_bthid_keyboard": 8 * 1024,
    "/data/codex/bin/codex_bt_pair_agent": 8 * 1024,
    "/data/codex/bin/codex_portal": 8 * 1024,
    "/data/codex/bin/codex_dhcpd": 8 * 1024,
    "/data/codex/bin/dropbearmulti": 16 * 1024,
    "/usr/sbin/dropbear": 12 * 1024,
    "/usr/sbin/dropbearkey": 8 * 1024,
    "/data/codex/init.sh": 2 * 1024,
    "/data/codex/offline_egress_guard.sh": 2 * 1024,
    "/data/codex/recovery_ap.sh": 2 * 1024,
    "/etc/init.d/rcS.local": 2 * 1024,
    "/pkg/codexactivity/codexactivity.lua": 4 * 1024,
    "/pkg/codexmqtt/codexmqtt.lua": 4 * 1024,
    "/etc/tdeenable": 64,
    "/pkg/codexactivity/manifest.json": 256,
    "/pkg/codexmqtt/manifest.json": 256,
    "/opt/luaworks/tasks/connectserver/netservicestarter.lua": 4 * 1024,
}
# Wrapper stubs that must keep working after a reset (live emulator seams).
STEP4A_STUB_SEEDS = {
    "/data/codex/bin/codex_hbus": "/opt/hub/stubs/codex_hbus",
    "/data/codex/bin/codex_hal_ltcp": "/opt/hub/stubs/codex_hal_ltcp",
}
# Settings-owned destinations: do_reset/first-boot settings seeding owns their
# canonical content. seed_step4a_destinations makes the semantics explicit:
#   upgrade: re-seeds them from /seed/settings (same bytes as do_reset)
#   fresh:   deletes them, so EVERY allowlisted destination is absent.
STEP4A_SETTINGS_OWNED = {
    "/data/codexmqtt/config.json": ("mqtt-config.json", 0o600),
    "/data/codex/cloud_blocker.conf": ("cloud_blocker.conf", 0o644),
}
STEP4A_MISSING_PARENT = "/pkg/codexmqtt"
# Handoff set mirrored VERBATIM from install_webui.py HANDOFF_REQUIRED_PATHS
# (10 paths, same order): the wrapper's bounded handoff copies exactly these.
HANDOFF_REQUIRED = (
    "/etc/init.d/rcS.local",
    "/opt/luaworks/tasks/connectserver/netservicestarter.lua",
    "/usr/sbin/dropbear",
    "/usr/sbin/dropbearkey",
    "/data/codex/hub_id",
    "/data/codex/cloud_blocker.conf",
    "/data/codex/offline_egress_guard.sh",
    "/data/codexmqtt/config.json",
    "/pkg/codexactivity/codexactivity.lua",
    "/pkg/codexactivity/manifest.json",
)


def fake_old_content(path, size):
    label = f"HUB-EMU-FAKE-OLD-{os.path.basename(path)}\n".encode("ascii")
    repeats = (size // len(label)) + 1
    return (label * repeats)[:size]


def seed_step4a_destinations(scenario="upgrade"):
    """Seed deterministic upgrade, fresh, or missing-parent install state."""
    if scenario not in ("upgrade", "fresh", "missing-parent"):
        raise ValueError(f"unknown Step 4A seed scenario: {scenario}")
    for path, mode in INSTALL_DESTINATIONS.items():
        if scenario == "fresh":
            remove_fixture_path(path)
            continue
        if (path in STEP4A_SETTINGS_OWNED and not os.path.islink(path)
                and os.path.isfile(path)):
            continue
        remove_fixture_path(path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if path in STEP4A_SETTINGS_OWNED:
            seed_name, mode = STEP4A_SETTINGS_OWNED[path]
            shutil.copyfile(os.path.join(SETTINGS_SEED_DIR, seed_name), path)
            os.chmod(path, mode)
            continue
        if path in STEP4A_STUB_SEEDS:
            with open(STEP4A_STUB_SEEDS[path], "rb") as source:
                content = source.read()
        elif path == "/data/codex/hub_id":
            content = b"12345678\n"
        else:
            content = fake_old_content(
                path, STEP4A_SEED_SIZES.get(path, 2 * 1024))
        with open(path, "wb") as output:
            output.write(content)
        os.chmod(path, mode)
    if scenario == "missing-parent":
        remove_fixture_path(STEP4A_MISSING_PARENT)
    return inspect_step4a()


def step4a_remove_destinations():
    for path in INSTALL_DESTINATIONS:
        remove_fixture_path(path)


def seed_step4a_fault(kind, target, detail=""):
    """Deterministic refusal/failure seams, all inside fixture state.

    destination-symlink: allowlisted destination becomes a symlink
      -> destination_type_invalid.
    destination-directory: becomes a directory -> destination_type_invalid.
    destination-fifo: becomes a FIFO -> destination_type_invalid.
    source-symlink: staged leaf becomes a symlink (O_NOFOLLOW final component)
      -> source_open_failed.
    stage-symlink: the WHOLE staging directory is replaced by a symlink to
      detail — the path string still passes the /var/volatile/codex-install-*
      policy, but the component walk fails at the symlinked directory
      -> source_open_failed.
    source-fifo: staged leaf becomes a FIFO -> source_open_failed.
    source-directory: staged leaf becomes a directory -> source_open_failed.
    source-outside: QA passes detail (a path OUTSIDE any staging tree) as
      SOURCE -> source_path_invalid. No state change here.
    source-traversal: QA passes a SOURCE containing ../ -> source_path_invalid.
      No state change here.
    mode-conflict: destination chmodded to a non-canonical mode. The CLI's
      MODE argument decides refusal: canonical MODE arg installs over it;
      wrong MODE arg -> mode_not_allowed.
    """
    if kind == "destination-symlink":
        remove_fixture_path(target)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        os.symlink(detail or "/etc/passwd", target)
    elif kind == "destination-directory":
        remove_fixture_path(target)
        os.makedirs(target, exist_ok=True)
    elif kind == "destination-fifo":
        remove_fixture_path(target)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        os.mkfifo(target)
    elif kind == "source-symlink":
        remove_fixture_path(target)
        os.symlink(detail or "/etc/passwd", target)
    elif kind in ("stage-symlink", "stage-alias"):
        remove_fixture_path(target)
        os.symlink(detail, target)
    elif kind == "source-fifo":
        remove_fixture_path(target)
        os.mkfifo(target)
    elif kind == "source-directory":
        remove_fixture_path(target)
        os.makedirs(target, exist_ok=True)
    elif kind == "mode-conflict":
        os.chmod(target, int(detail, 8) if detail else 0o000)
    elif kind in ("source-outside", "source-traversal"):
        pass  # QA supplies the malformed SOURCE string; nothing to arm
    else:
        raise ValueError(f"unknown step4a fault: {kind}")
    return {"ok": True, "kind": kind, "target": target, "detail": detail}


def copy_with_mode(source, destination):
    """Wrapper-style `cp -p`: bytes + mode + mtime for rollback copies."""
    entry_stat = os.lstat(source)
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    with open(source, "rb") as src, open(destination, "wb") as dst:
        shutil.copyfileobj(src, dst)
    os.chmod(destination, stat.S_IMODE(entry_stat.st_mode))
    os.utime(destination, ns=(entry_stat.st_atime_ns, entry_stat.st_mtime_ns))
    return destination_snapshot(destination)


def run_handoff(stamp, fail_after=None, budget=HANDOFF_BUDGET):
    """Wrapper-shaped bounded handoff into /data/codex-backups.

    Copies the required existing regular non-symlink files into
    .incomplete-webui-handoff-STAMP under a running byte budget, then renames
    atomically to webui-handoff-STAMP. fail_after=N simulates a mid-copy
    failure: the incomplete directory is removed, nothing is renamed.
    """
    root = HANDOFF_ROOT
    os.makedirs(root, exist_ok=True)
    incomplete = os.path.join(root, f".incomplete-webui-handoff-{stamp}")
    final = os.path.join(root, f"webui-handoff-{stamp}")
    remove_fixture_path(incomplete)
    if os.path.lexists(final):
        raise ValueError(f"handoff already exists: {final}")
    os.makedirs(incomplete, exist_ok=True)
    copied = []
    used = 0
    for index, source in enumerate(HANDOFF_REQUIRED):
        if os.path.islink(source) or not os.path.isfile(source):
            continue
        size = os.path.getsize(source)
        if used + size > budget:
            break
        if fail_after is not None and index >= fail_after:
            remove_fixture_path(incomplete)
            return {"ok": False, "reason": "injected_copy_failure",
                    "copied": copied, "final": None}
        leaf = source.rsplit("/", 1)[-1]
        copy_with_mode(source, os.path.join(incomplete, leaf))
        copied.append({"source": source, "leaf": leaf, "bytes": size})
        used += size
    os.rename(incomplete, final)
    return {"ok": True, "copied": copied, "final": final, "bytes": used}


def seed_manual_backups():
    """Owner-created artifacts in the handoff root that must survive
    handoff/prune/rollback untouched."""
    os.makedirs(HANDOFF_ROOT, exist_ok=True)
    generation = os.path.join(HANDOFF_ROOT, "webui-handoff-20260101-000000")
    os.makedirs(generation, exist_ok=True)
    with open(os.path.join(generation, "owner-file.txt"), "wb") as output:
        output.write(b"HUB-EMU-FAKE-MANUAL-HANDOFF-FILE\n")
    with open(os.path.join(HANDOFF_ROOT, "owner-note.txt"), "wb") as output:
        output.write(b"HUB-EMU-FAKE-OWNER-NOTE\n")


def run_busybox_md5(paths):
    """The corrected BusyBox md5sum emulator interface, exactly as the real
    production update verifier invokes it: /bin/busybox md5sum <paths>."""
    completed = subprocess.run(
        ["/bin/busybox", "md5sum", *paths],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=20,
        check=False,
    )
    return {
        "exitCode": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
    }


def _new_stage_dir():
    os.makedirs(STAGE_PARENT, exist_ok=True)
    stage = os.path.join(
        STAGE_PARENT,
        f"codex-install-{os.getpid()}-{int(time.time() * 1000)}")
    os.makedirs(stage, mode=0o700, exist_ok=True)
    os.chmod(stage, 0o700)
    return stage


def stage_with_leaves(leaves):
    """Generic staging-tree builder. Keys are the EXACT stage leaf names
    (wrapper convention: NN-<destleaf>); values are spec entries:
    {"bytes": N} deterministic fake bytes, {"copy": src}, {"link": target},
    {"fifo": True}, {"mode": 0oNNN} (default 0o600)."""
    stage = _new_stage_dir()

    staged = {}
    for index, (leaf, spec) in enumerate(leaves.items()):
        path = os.path.join(stage, leaf)
        mode = spec.get("mode", 0o600)
        if "link" in spec:
            os.symlink(spec["link"], path)
        elif "fifo" in spec:
            os.mkfifo(path)
        elif "copy" in spec:
            shutil.copyfile(spec["copy"], path)
            os.chmod(path, mode)
        else:
            size = int(spec.get("bytes", 0))
            label = f"HUB-EMU-FAKE-CANDIDATE-{leaf}\n".encode("ascii")
            content = (label * ((size // len(label)) + 1))[:size]
            with open(path, "wb") as output:
                output.write(content)
            os.chmod(path, mode)
        staged[leaf] = path
    return stage, staged


def step4a_mount_fault(kind):
    """Filesystem-level flush seam. /mnt/data is the fixture's flash stand-in;
    remounting it ro makes the FIRST persistent mutation of --install-file
    (same-directory O_CREAT|O_EXCL temp creation) fail with EROFS, so the
    binary reports temp_create_failed and refuses with zero mutations.

    The remaining failure stages are covered by harness-only seams inside
    run_maintenance (seccomp-BPF errno injection, RLIMIT_FSIZE partial write,
    source-truncate race, pre-created temp collisions) — production binary
    stays unmodified.
    """
    if kind == "flush-ro":
        subprocess.run(["mount", "-o", "remount,ro", MNT_DATA],
                       check=True, timeout=10)
        return {"ok": True, "kind": kind, "mount": "ro"}
    if kind == "flush-rw":
        subprocess.run(["mount", "-o", "remount,rw", MNT_DATA],
                       check=True, timeout=10)
        return {"ok": True, "kind": kind, "mount": "rw"}
    raise ValueError(f"unknown step4a mount fault: {kind}")


def data_authority(action):
    """Reversible /mnt/data authority seam for the ENOENT-fallback proof.

    detach: umount /mnt/data + rmdir the mountpoint. stat("/mnt/data") then
      fails ENOENT, so the real binary falls back to /data (the bind mount
      stays alive). No other mount or path is touched.
    attach: recreate the mountpoint and bind-mount /data over it, restoring
      /mnt/data as the SAME filesystem view (identical statvfs numbers,
      filler intact).
    status: report the current mount state without changing anything.
    """
    if action == "status":
        mounted = os.path.ismount(MNT_DATA)
        return {"ok": True, "action": action, "mounted": mounted,
                "exists": os.path.lexists(MNT_DATA),
                "eloop": os.path.islink(MNT_DATA),
                "storagePath": MNT_DATA if mounted else None}
    if action == "detach":
        if os.path.ismount(MNT_DATA):
            subprocess.run(["umount", MNT_DATA], check=True, timeout=10)
        if os.path.islink(MNT_DATA):
            os.unlink(MNT_DATA)
        elif os.path.lexists(MNT_DATA):
            remove_fixture_path(MNT_DATA)
        return {"ok": True, "action": action, "mounted": False,
                "exists": False, "eloop": False, "storagePath": None}
    if action in ("attach", "reveal"):
        if os.path.islink(MNT_DATA):
            os.unlink(MNT_DATA)
        elif os.path.lexists(MNT_DATA) and not os.path.isdir(MNT_DATA):
            remove_fixture_path(MNT_DATA)
        os.makedirs(MNT_DATA, exist_ok=True)
        if not os.path.ismount(MNT_DATA):
            subprocess.run(["mount", "--bind", DATA_ROOT, MNT_DATA],
                           check=True, timeout=10)
        return {"ok": True, "action": action, "mounted": True,
                "exists": True, "eloop": False, "storagePath": MNT_DATA}
    if action == "obscure":
        if os.path.ismount(MNT_DATA):
            subprocess.run(["umount", MNT_DATA], check=True, timeout=10)
        if os.path.islink(MNT_DATA):
            os.unlink(MNT_DATA)
        elif os.path.lexists(MNT_DATA):
            remove_fixture_path(MNT_DATA)
        os.symlink(MNT_DATA, MNT_DATA)
        return {"ok": True, "action": action, "mechanism": "symlink-loop",
                "mounted": False, "exists": True, "eloop": True,
                "storagePath": None}
    raise ValueError(f"unknown data-authority action: {action}")


def wrapper_remove(path):
    """Wrapper-side primitive: `rm -f PATH; test ! -e PATH` for originally-
    absent reverse rollback (the C CLI never unlinks destinations)."""
    remove_fixture_path(path)
    return {"ok": True, "path": path, "absent": not os.path.lexists(path)}


# ---------------------------------- harness-only syscall fault injection seams
#
# Everything below observes or perturbs the HOST syscalls qemu-user emits on
# behalf of the unmodified guest binary. The production C code is untouched;
# these are test-harness seams only.

_SECCOMP_ARCHS = {
    # uname machine -> (audit arch, seccomp syscall number, {name: host nr})
    "x86_64": (0xC000003E, 317, {
        "fchmod": 91, "fsync": 74, "fdatasync": 75, "rename": 82,
        "renameat": 264, "renameat2": 316, "statfs": 137, "statfs64": 137,
    }),
    "amd64": (0xC000003E, 317, {
        "fchmod": 91, "fsync": 74, "fdatasync": 75, "rename": 82,
        "renameat": 264, "renameat2": 316, "statfs": 137, "statfs64": 137,
    }),
    "aarch64": (0xC00000B7, 277, {
        "fchmod": 52, "fsync": 82, "fdatasync": 83,
        "renameat": 38, "renameat2": 276, "statfs": 43, "statfs64": 43,
    }),
    "arm64": (0xC00000B7, 277, {
        "fchmod": 52, "fsync": 82, "fdatasync": 83,
        "renameat": 38, "renameat2": 276, "statfs": 43, "statfs64": 43,
    }),
}

_ERRNO_BY_NAME = {
    "EIO": 5, "EBADF": 9, "EACCES": 13, "EFBIG": 27, "ENOSPC": 28,
    "EROFS": 30,
}

class _SockFilter(ctypes.Structure):
    _fields_ = [("code", ctypes.c_ushort),
                ("jt", ctypes.c_ubyte),
                ("jf", ctypes.c_ubyte),
                ("k", ctypes.c_uint32)]


class _SockFprog(ctypes.Structure):
    _fields_ = [("len", ctypes.c_ushort),
                ("filter", ctypes.POINTER(_SockFilter))]


_LIBC = ctypes.CDLL(None, use_errno=True)


def _machine_seccomp():
    machine = os.uname().machine
    if machine not in _SECCOMP_ARCHS:
        raise ValueError(f"seccomp fault injection unsupported on {machine}")
    return _SECCOMP_ARCHS[machine]


def _build_seccomp_instructions(audit, syscall_numbers, errno_value):
    """cBPF program for SECCOMP_RET_ERRNO over seccomp_data (nr at 0, arch at
    4): load arch, mismatch -> ALLOW; load nr; ERRNO(errno) every target
    syscall; ALLOW everything else."""
    seccomp_ret_errno = 0x00050000
    seccomp_allow = 0x7FFF0000
    n = len(syscall_numbers)
    insns = [
        (0x20, 0, 0, 4),          # BPF_LD|BPF_W|BPF_ABS: A = arch
        (0x15, 0, 2 * n + 1, audit),  # JEQ: arch match ? next : skip to ALLOW
        (0x20, 0, 0, 0),          # BPF_LD|BPF_W|BPF_ABS: A = nr
    ]
    for number in syscall_numbers:
        insns.append((0x15, 0, 1, number))   # JEQ nr ? ERRNO : next check
        insns.append((0x06, 0, 0, seccomp_ret_errno | (errno_value & 0xFFFF)))
    insns.append((0x06, 0, 0, seccomp_allow))
    return insns


def _temp_collision_paths(destination, child_pid, time_base):
    """Every O_EXCL temp name the CLI can try for this run:
    <destdir>/.codex-install-<pid>-<unixtime>-<attempt>-<leaf>, attempts 1-8,
    wall clock +/- 3 s."""
    directory = os.path.dirname(destination)
    leaf = os.path.basename(destination)
    paths = []
    for offset in range(-3, 4):
        for attempt in range(1, 9):
            paths.append(os.path.join(
                directory,
                f".codex-install-{child_pid}-{time_base + offset}-{attempt}-{leaf}"))
    return paths


def _make_preexec(fault):
    """Prepare child-only fault operations before the threaded server forks."""
    partial_bytes = fault.get("partialBytes")
    if partial_bytes is not None:
        if isinstance(partial_bytes, bool):
            raise ValueError("partialBytes must be a nonnegative integer")
        partial_bytes = int(partial_bytes)
        if partial_bytes < 0:
            raise ValueError("partialBytes must be a nonnegative integer")

    collision = fault.get("tempCollision")
    collision_destination = None
    if collision is not None:
        if not isinstance(collision, dict):
            raise ValueError("tempCollision must be an object")
        collision_destination = collision.get("destination")
        if collision_destination not in INSTALL_DESTINATIONS:
            raise ValueError("tempCollision destination must be allowlisted")
        if not os.path.isdir(os.path.dirname(collision_destination)):
            raise ValueError("tempCollision destination parent is absent")

    errno_targets = fault.get("errnoOn") or []
    if not isinstance(errno_targets, list) or any(
            not isinstance(name, str) for name in errno_targets):
        raise ValueError("errnoOn must be a list of syscall names")
    seccomp_nr = None
    program = None
    filter_array = None
    if errno_targets:
        audit, seccomp_nr, table = _machine_seccomp()
        unknown = sorted(set(errno_targets) - set(table))
        if unknown:
            raise ValueError(
                "unsupported seccomp syscall name(s): " + ", ".join(unknown))
        errno_name = str(fault.get("errno", "EIO")).upper()
        if errno_name not in _ERRNO_BY_NAME:
            raise ValueError(f"unsupported injected errno: {errno_name}")
        numbers = list(dict.fromkeys(table[name] for name in errno_targets))
        insns = _build_seccomp_instructions(
            audit, numbers, _ERRNO_BY_NAME[errno_name])
        filter_array = (_SockFilter * len(insns))(
            *[_SockFilter(*instruction) for instruction in insns])
        program = _SockFprog(
            len=len(insns), filter=ctypes.cast(
                filter_array, ctypes.POINTER(_SockFilter)))
        _LIBC.prctl.restype = ctypes.c_int
        _LIBC.syscall.restype = ctypes.c_long
    if partial_bytes is None and collision_destination is None and program is None:
        return None

    def preexec():
        if partial_bytes is not None:
            signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
            resource.setrlimit(
                resource.RLIMIT_FSIZE, (partial_bytes, partial_bytes))
        if program is not None:
            ctypes.set_errno(0)
            if _LIBC.prctl(38, 1, 0, 0, 0) != 0:
                error = ctypes.get_errno()
                raise OSError(error, "PR_SET_NO_NEW_PRIVS failed")
            ctypes.set_errno(0)
            if _LIBC.syscall(
                    seccomp_nr, 1, 0, ctypes.byref(program)) != 0:
                error = ctypes.get_errno()
                raise OSError(error, "seccomp filter installation failed")
        if collision_destination:
            created = []
            try:
                time_base = int(time.time())
                for path in _temp_collision_paths(
                        collision_destination, os.getpid(), time_base):
                    try:
                        fd = os.open(
                            path,
                            os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    except FileExistsError:
                        continue
                    os.close(fd)
                    created.append(path)
            except BaseException:
                for path in created:
                    try:
                        os.unlink(path)
                    except OSError:
                        pass
                raise

    return preexec


def _start_source_truncate_race(source, destination, done_event, result):
    directory = os.path.dirname(destination)
    suffix = "-" + os.path.basename(destination)
    try:
        existing = set(os.listdir(directory))
    except OSError:
        existing = set()

    def watch():
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and not done_event.is_set():
            try:
                entries = os.listdir(directory)
            except OSError:
                entries = ()
            for entry in entries:
                if (entry not in existing
                        and entry.startswith(".codex-install-")
                        and entry.endswith(suffix)):
                    try:
                        os.truncate(source, 0)
                    except OSError as error:
                        result["error"] = str(error)
                    else:
                        result["truncatedSource"] = source
                        result["observedTemp"] = os.path.join(directory, entry)
                    return
            time.sleep(0.0001)

    thread = threading.Thread(target=watch, daemon=True)
    thread.start()
    return thread


def run_maintenance(argv, timeout=60, fault=None):
    """Run the real production-identical MIPS maintenance CLI under qemu-mips."""
    fault = {} if fault is None else fault
    if not isinstance(fault, dict):
        raise ValueError("fault must be an object")
    preexec = _make_preexec(fault)
    qemu = shutil.which("qemu-mips")
    if qemu is None:
        raise OSError("qemu-mips executable not found")
    fault_info = {}
    race_thread = None
    race_event = threading.Event()
    race_result = {}
    race = fault.get("truncateRace")
    if race is not None:
        if not isinstance(race, dict):
            raise ValueError("truncateRace must be an object")
        source = race.get("source")
        destination = race.get("destination")
        if destination not in INSTALL_DESTINATIONS:
            raise ValueError("truncateRace destination must be allowlisted")
        if (not isinstance(source, str) or not source.startswith(STAGE_PREFIX)
                or os.path.islink(source) or not os.path.isfile(source)):
            raise ValueError("truncateRace source must be a staged regular file")
        race_thread = _start_source_truncate_race(
            source, destination, race_event, race_result)

    before_processes = count_webui_processes()
    started = time.monotonic()
    process = None
    collision_paths = []
    collision_zero_length = False
    stdout = ""
    stderr = ""
    try:
        process = subprocess.Popen(
            [qemu, MIPS_WEBUI, *argv],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            preexec_fn=preexec,
        )
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            stdout, stderr = process.communicate()
    except (OSError, subprocess.SubprocessError):
        raise
    finally:
        race_event.set()
        if race_thread is not None:
            race_thread.join(timeout=2)
        if process is not None and fault.get("tempCollision"):
            destination = fault["tempCollision"]["destination"]
            directory = os.path.dirname(destination)
            prefix = f".codex-install-{process.pid}-"
            suffix = "-" + os.path.basename(destination)
            try:
                entries = os.listdir(directory)
            except OSError:
                entries = ()
            for entry in sorted(entries):
                if not (entry.startswith(prefix) and entry.endswith(suffix)):
                    continue
                path = os.path.join(directory, entry)
                try:
                    entry_stat = os.lstat(path)
                except OSError:
                    continue
                if stat.S_ISREG(entry_stat.st_mode) and entry_stat.st_size == 0:
                    collision_paths.append(path)
            collision_zero_length = bool(collision_paths)
            for path in collision_paths:
                try:
                    os.unlink(path)
                except FileNotFoundError:
                    pass
    elapsed_ms = round((time.monotonic() - started) * 1000)
    if race is not None:
        fault_info["truncateRace"] = {
            "truncatedSource": race_result.get("truncatedSource"),
            "observedTemp": race_result.get("observedTemp"),
            "error": race_result.get("error"),
        }
    if fault.get("errnoOn"):
        fault_info["errnoOn"] = {
            "syscalls": fault["errnoOn"],
            "errno": str(fault.get("errno", "EIO")).upper(),
            "childPid": process.pid,
        }
    if fault.get("partialBytes") is not None:
        fault_info["partialBytes"] = int(fault["partialBytes"])
    if fault.get("tempCollision"):
        destination = fault["tempCollision"]["destination"]
        fault_info["tempCollision"] = {
            "destination": destination,
            "childPid": process.pid,
            "armed": collision_paths,
            "count": len(collision_paths),
            "zeroLength": collision_zero_length,
        }
    result = {
        "argv": argv,
        "exitCode": process.returncode,
        "stdout": stdout,
        "stderr": stderr,
        "elapsedMs": elapsed_ms,
        "webuiProcessesBefore": before_processes,
        "webuiProcessesAfter": count_webui_processes(),
    }
    if fault_info:
        result["faultInfo"] = fault_info
    return result


def parse_kv(text):
    result = {}
    for line in text.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            result[key.strip()] = value.strip()
    return result


def destination_snapshot(path):
    """Byte-exact pre/post fixture state for one allowlisted destination."""
    if os.path.islink(path):
        return {"type": "symlink", "bytes": 0, "sha256": None, "mode": None}
    if not os.path.exists(path):
        return {"type": "absent", "bytes": 0, "sha256": None, "mode": None}
    entry_stat = os.lstat(path)
    if not stat.S_ISREG(entry_stat.st_mode):
        return {"type": "other", "bytes": 0, "sha256": None, "mode": None}
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(65536), b""):
            digest.update(chunk)
    return {
        "type": "regular",
        "bytes": entry_stat.st_size,
        "sha256": digest.hexdigest(),
        "mode": stat.S_IMODE(entry_stat.st_mode),
    }


def inspect_step4a():
    """Full observable fixture state: capacity, staging, destinations, handoff."""
    destinations = {
        path: destination_snapshot(path) for path in sorted(INSTALL_DESTINATIONS)
    }
    stages = []
    try:
        for entry in sorted(os.listdir(STAGE_PARENT)):
            if not entry.startswith("codex-install-"):
                continue
            stage_path = os.path.join(STAGE_PARENT, entry)
            if not os.path.isdir(stage_path):
                continue
            leaves = {}
            for leaf in sorted(os.listdir(stage_path)):
                leaf_path = os.path.join(stage_path, leaf)
                if os.path.islink(leaf_path):
                    leaves[leaf] = {"type": "symlink"}
                    continue
                leaf_stat = os.lstat(leaf_path)
                leaves[leaf] = {
                    "type": "regular" if stat.S_ISREG(leaf_stat.st_mode) else "other",
                    "bytes": leaf_stat.st_size,
                    "mode": stat.S_IMODE(leaf_stat.st_mode),
                }
            stages.append({"path": stage_path, "mode": stat.S_IMODE(os.stat(stage_path).st_mode), "leaves": leaves})
    except OSError:
        pass
    handoff = []
    if os.path.isdir(HANDOFF_ROOT):
        for entry in sorted(os.listdir(HANDOFF_ROOT)):
            handoff.append(entry)
    # Same-directory install temps the C binary creates as
    # <destdir>/.codex-install-<pid>-<unix>-<attempt>-<leaf>. Zero leftovers
    # after a successful or refused install is the atomic-cleanup proof.
    temp_files = []
    for directory in sorted({os.path.dirname(p) for p in INSTALL_DESTINATIONS}):
        try:
            for entry in sorted(os.listdir(directory)):
                if entry.startswith(".codex-install-"):
                    temp_files.append(os.path.join(directory, entry))
        except OSError:
            pass
    return {
        "ok": True,
        "capacity": inspect_capacity(),
        "destinations": destinations,
        "stages": stages,
        "handoff": handoff,
        "tempFiles": temp_files,
    }


def _restore_mnt_data_view():
    """Undo every data-authority seam (obscure/reveal AND detach/attach) so
    /mnt/data is the entrypoint's bind-mounted fixture view again. Must run
    BEFORE anything touches /mnt/data paths (e.g. the filler unlink)."""
    # obscure seam: mountpoint replaced by a symlink — remove it first.
    try:
        if os.path.islink(MNT_DATA):
            os.unlink(MNT_DATA)
    except OSError:
        pass
    try:
        if not os.path.ismount(MNT_DATA):
            os.makedirs(MNT_DATA, exist_ok=True)
            subprocess.run(["mount", "--bind", DATA_ROOT, MNT_DATA],
                           check=False, timeout=10)
    except OSError:
        pass


def reset_step4a_artifacts():
    """Remove every synthetic Step 4A artifact: filler, staging trees,
    handoff fixtures, and seeded destination content. The /mnt/data tmpfs and
    the /data bind mount stay exactly where the entrypoint put them."""
    # A flush-failure seam may have left the image read-only; restore rw.
    try:
        with open("/proc/mounts", encoding="utf-8") as mounts:
            for line in mounts:
                fields = line.split()
                if len(fields) >= 4 and fields[1] == MNT_DATA and "ro" in fields[3].split(","):
                    subprocess.run(
                        ["mount", "-o", "remount,rw", MNT_DATA],
                        check=False, timeout=10)
    except OSError:
        pass
    # Restore the /mnt/data view FIRST: a data-authority detach removes the
    # mountpoint, so the filler unlink below would otherwise miss the file.
    _restore_mnt_data_view()
    try:
        os.unlink(CAPACITY_FILLER)
    except OSError:
        pass
    try:
        for entry in os.listdir(STAGE_PARENT):
            if entry.startswith("codex-install-"):
                remove_fixture_path(os.path.join(STAGE_PARENT, entry))
    except OSError:
        pass
    if os.path.isdir(HANDOFF_ROOT):
        for entry in os.listdir(HANDOFF_ROOT):
            if entry.startswith("webui-handoff-") or entry.startswith(".incomplete-webui-handoff-") or entry == "owner-note.txt":
                remove_fixture_path(os.path.join(HANDOFF_ROOT, entry))
    step4a_remove_destinations()
    # Sweep harness-created temp-collision entries from every destination
    # parent directory (only .codex-install-* entries are ever swept).
    for directory in sorted({os.path.dirname(p) for p in INSTALL_DESTINATIONS}):
        try:
            for entry in os.listdir(directory):
                if entry.startswith(".codex-install-"):
                    remove_fixture_path(os.path.join(directory, entry))
        except OSError:
            pass
    # Restore the entrypoint's pristine box seams so the live emulator keeps
    # working after a reset: hub identity, the qemu wrapper stubs the real
    # webui shells out to, and the settings-owned destinations (their removal
    # above is deliberate; the box state always carries the seed settings).
    os.makedirs(os.path.dirname(HUB_ID_FILE), exist_ok=True)
    with open(HUB_ID_FILE, "w", encoding="utf-8") as output:
        output.write("12345678\n")
    for destination, stub in STEP4A_STUB_SEEDS.items():
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        shutil.copyfile(stub, destination)
        os.chmod(destination, 0o755)
    for destination, (seed_name, mode) in STEP4A_SETTINGS_OWNED.items():
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        shutil.copyfile(os.path.join(SETTINGS_SEED_DIR, seed_name), destination)
        os.chmod(destination, mode)


# --------------------------------------------------------------- control plane

def reboot_count():
    try:
        with open(REBOOT_LOG, encoding="utf-8") as f:
            return sum(1 for line in f if line.strip())
    except OSError:
        return 0


def do_reset():
    for name in os.listdir(SEED_DIR):
        target = os.path.join(RESOURCE_DIR, name)
        if os.path.isdir(target) and not os.path.islink(target):
            shutil.rmtree(target)
        with open(os.path.join(SEED_DIR, name), encoding="utf-8") as f:
            write_atomic(target, f.read().rstrip("\n"))
    for name, (target, mode) in SETTINGS_TARGETS.items():
        with open(os.path.join(SETTINGS_SEED_DIR, name), encoding="utf-8") as f:
            seed = f.read().rstrip("\n")
        os.makedirs(os.path.dirname(target), exist_ok=True)
        write_atomic(target, seed)
        os.chmod(target, mode)
    for stale in (
            REQUEST_FILE, RESPONSE_FILE, RELOAD_FLAG, AUTH_CONFIG,
            UPDATE_STATE_CONFIG, REBOOT_LOG):
        try:
            os.unlink(stale)
        except OSError:
            pass
    remove_fixture_path(UPDATE_STAGE_DIR)
    reset_step4a_artifacts()
    reset_retention_artifacts()
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

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length))

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/events":
            with _lock:
                events = list(_events)
            self._json(200, {"ok": True, "events": events})
        elif path == "/status":
            self._json(200, {
                "ok": True,
                "emulator": "hub-emu",
                "currentActivityId": current_activity(),
                "eventCount": len(_events),
                "rebootCount": reboot_count(),
            })
        elif path == "/retention/inspect":
            try:
                self._json(200, inspect_retention())
            except OSError as error:
                self._json(500, {"ok": False, "error": str(error)})
        elif path == "/step4a/inspect":
            try:
                self._json(200, inspect_step4a())
            except OSError as error:
                self._json(500, {"ok": False, "error": str(error)})
        elif path == "/step4a/capacity":
            try:
                self._json(200, inspect_capacity())
            except OSError as error:
                self._json(500, {"ok": False, "error": str(error)})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        parsed = urlsplit(self.path)
        try:
            if parsed.path == "/reset":
                do_reset()
                self._json(200, {
                    "ok": True,
                    "currentActivityId": current_activity(),
                })
            elif parsed.path == "/retention/seed":
                scenario = parse_qs(parsed.query).get("scenario", ["standard"])[0]
                self._json(200, seed_retention_scenario(scenario))
            elif parsed.path == "/retention/prune":
                result = run_real_retention()
                result["inventory"] = inspect_retention()
                self._json(200, result)
            elif parsed.path == "/retention/arm-copy-failure":
                self._json(200, arm_copy_failure())
            elif parsed.path == "/step4a/seed":
                body = self._body()
                scenario = body.get("scenario", "upgrade")
                self._json(200, seed_step4a_destinations(scenario))
            elif parsed.path == "/step4a/capacity":
                body = self._body()
                free = int(body.get("free", 0))
                self._json(200, set_capacity_filler(free))
            elif parsed.path == "/step4a/stage":
                body = self._body()
                stage, staged = stage_with_leaves(body.get("leaves", {}))
                self._json(200, {"ok": True, "stage": stage, "staged": staged})
            elif parsed.path == "/step4a/rollback-copy":
                body = self._body()
                snapshot = copy_with_mode(body["source"], body["destination"])
                self._json(200, {"ok": True, **snapshot,
                                 "source": body["source"],
                                 "destination": body["destination"]})
            elif parsed.path == "/step4a/remove":
                body = self._body()
                self._json(200, wrapper_remove(body["path"]))
            elif parsed.path == "/step4a/handoff":
                body = self._body()
                fail_after = body.get("failAfter")
                budget = int(body.get("budget", HANDOFF_BUDGET))
                self._json(200, run_handoff(
                    body["stamp"], fail_after=fail_after, budget=budget))
            elif parsed.path == "/step4a/manual-backups":
                seed_manual_backups()
                self._json(200, {"ok": True})
            elif parsed.path == "/step4a/md5":
                body = self._body()
                self._json(200, run_busybox_md5(body.get("paths", [])))
            elif parsed.path == "/step4a/fault":
                body = self._body()
                kind = body.get("kind", "")
                if kind in ("flush-ro", "flush-rw"):
                    self._json(200, step4a_mount_fault(kind))
                elif kind == "data-authority":
                    self._json(200, data_authority(body.get("action", "status")))
                else:
                    self._json(200, seed_step4a_fault(
                        kind, body.get("target", ""), body.get("detail", "")))
            elif parsed.path == "/step4a/run":
                body = self._body()
                argv = body.get("argv", [])
                if not argv or argv[0] not in MAINTENANCE_FLAGS:
                    raise ValueError(
                        "argv[0] must be one of: " + " ".join(MAINTENANCE_FLAGS))
                fault = body.get("fault")
                result = run_maintenance(
                    argv, timeout=int(body.get("timeout", 60)), fault=fault)
                result["kv"] = parse_kv(result["stdout"])
                self._json(200, result)
            elif parsed.path == "/step4a/data-authority":
                body = self._body()
                self._json(200, data_authority(body.get("action", "status")))
            elif parsed.path == "/step4a/reset":
                reset_step4a_artifacts()
                self._json(200, {"ok": True})
            else:
                self._json(404, {"ok": False, "error": "not found"})
        except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
            self._json(500, {"ok": False, "error": str(error)})

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
