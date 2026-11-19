#!/usr/bin/env python3
"""Mock LG webOS TV server for testing codex_webos without a real TV.

Implements the LG webOS SSAP WebSocket protocol over both ws:// (port 3000-style)
and wss:// with a self-signed TLS certificate (port 3001-style), plus the
pointer-input WebSocket handoff (com.webos.service.networkinput/getPointerInputSocket).

Standard library only (plus openssl to generate an ephemeral self-signed cert
when wss is enabled). Every event is printed as one JSON line; client-keys are
generated ephemerally per run and NEVER printed or logged.

MIT License, Copyright (c) 2026 Melodious contributors.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import secrets
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import time

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

DEFAULT_INPUTS = [
    {
        "id": "HDMI_1",
        "label": "HDMI 1",
        "port": 1,
        "appId": "com.webos.app.hdmi1",
        "connected": True,
        "hdmiSignalExist": True,
        "subList": [{"id": "SIMPLINK", "osdName": "Apple TV", "cecpDevType": 4}],
    },
    {
        "id": "HDMI_2",
        "label": "HDMI 2",
        "port": 2,
        "appId": "com.webos.app.hdmi2",
        "connected": True,
        "hdmiSignalExist": False,
        "subList": [{"id": "SIMPLINK", "osdName": "PlayStation 5", "cecpDevType": 4}],
    },
    {
        "id": "HDMI_3",
        "label": "HDMI 3",
        "port": 3,
        "appId": "com.webos.app.hdmi3",
        "connected": False,
        "hdmiSignalExist": False,
        "subList": [],
    },
    {
        "id": "HDMI_4",
        "label": "HDMI 4",
        "port": 4,
        "appId": "com.webos.app.hdmi4",
        "connected": True,
        "hdmiSignalExist": True,
        "subList": [{"id": "SIMPLINK", "osdName": "AVR", "cecpDevType": 5}],
    },
]

DEFAULT_APPS = [
    {"id": "netflix", "title": "Netflix", "visible": True, "systemApp": False},
    {"id": "youtube.leanback.v4", "title": "YouTube", "visible": True, "systemApp": False},
    {"id": "cdp-30", "title": "Plex", "visible": True, "systemApp": False},
    {"id": "amazon", "title": "Prime Video", "visible": True, "systemApp": False},
    {"id": "com.disney.disneyplus-prod", "title": "Disney+", "visible": True, "systemApp": False},
    {"id": "com.webos.app.hdmi1", "title": "HDMI 1", "visible": True, "systemApp": True},
    {"id": "com.webos.app.internal", "title": "Internal Service", "visible": False, "systemApp": True},
]


def log(event: str, **kw) -> None:
    # Never allow a client-key to appear in logs.
    kw.pop("client_key", None)
    kw.pop("client-key", None)
    print(json.dumps({"t": round(time.time(), 3), "event": event, **kw}), flush=True)


def make_self_signed_cert(cert_dir: str) -> tuple[str, str]:
    cert_path = os.path.join(cert_dir, "tv.crt")
    key_path = os.path.join(cert_dir, "tv.key")
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-keyout",
            key_path,
            "-out",
            cert_path,
            "-days",
            "1",
            "-nodes",
            "-subj",
            "/CN=LGwebOSTV",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return cert_path, key_path


def recv_exact(sock: socket.socket, n: int) -> bytes | None:
    chunks = bytearray()
    while len(chunks) < n:
        try:
            data = sock.recv(n - len(chunks))
        except OSError:
            return None
        if not data:
            return None
        chunks.extend(data)
    return bytes(chunks)


def ws_handshake(sock: socket.socket) -> str | None:
    """Perform server-side RFC 6455 handshake; return request path or None."""
    sock.settimeout(5.0)
    buf = bytearray()
    while b"\r\n\r\n" not in buf and len(buf) < 8192:
        try:
            chunk = sock.recv(1024)
        except OSError:
            return None
        if not chunk:
            return None
        buf.extend(chunk)
    head_end = buf.find(b"\r\n\r\n")
    if head_end < 0:
        return None
    head = buf[:head_end].decode("utf-8", errors="replace")
    lines = head.split("\r\n")
    if not lines:
        return None
    parts = lines[0].split(" ")
    if len(parts) < 2 or parts[0] != "GET":
        return None
    req_path = parts[1]
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    ws_key = headers.get("sec-websocket-key")
    if not ws_key or headers.get("upgrade", "").lower() != "websocket":
        try:
            sock.sendall(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
        except OSError:
            pass
        return None
    accept = base64.b64encode(hashlib.sha1((ws_key + WS_GUID).encode("ascii")).digest()).decode("ascii")
    reply = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
    )
    try:
        sock.sendall(reply.encode("ascii"))
    except OSError:
        return None
    sock.settimeout(1.0)
    return req_path


def ws_send_frame(sock: socket.socket, opcode: int, payload: bytes) -> bool:
    n = len(payload)
    hdr = bytearray([0x80 | (opcode & 0x0F)])
    if n < 126:
        hdr.append(n)
    elif n < 65536:
        hdr.append(126)
        hdr.extend(struct.pack("!H", n))
    else:
        hdr.append(127)
        hdr.extend(struct.pack("!Q", n))
    try:
        sock.sendall(bytes(hdr) + payload)
        return True
    except OSError:
        return False


def ws_send_text(sock: socket.socket, text: str) -> bool:
    return ws_send_frame(sock, 0x1, text.encode("utf-8"))


def ws_recv_frame(sock: socket.socket) -> tuple[int, bytes] | None:
    """Receive one RFC 6455 frame; returns (opcode, payload), (0, b'') on timeout, or None on EOF/error."""
    try:
        hdr = sock.recv(2)
    except socket.timeout:
        return (0, b"")
    except OSError:
        return None
    if not hdr:
        return None
    if len(hdr) < 2:
        rest = recv_exact(sock, 2 - len(hdr))
        if rest is None:
            return None
        hdr += rest
    b0, b1 = hdr[0], hdr[1]
    opcode = b0 & 0x0F
    masked = bool(b1 & 0x80)
    length = b1 & 0x7F
    if length == 126:
        ext = recv_exact(sock, 2)
        if ext is None:
            return None
        length = struct.unpack("!H", ext)[0]
    elif length == 127:
        ext = recv_exact(sock, 8)
        if ext is None:
            return None
        length = struct.unpack("!Q", ext)[0]
    if length > 256 * 1024:
        return None
    mask_key = b""
    if masked:
        mask_key = recv_exact(sock, 4)
        if mask_key is None:
            return None
    payload = recv_exact(sock, length) if length else b""
    if payload is None:
        return None
    if masked and payload:
        payload = bytes(payload[i] ^ mask_key[i & 3] for i in range(len(payload)))
    return (opcode, payload)


class FakeWebOSTV:
    def __init__(
        self,
        host: str,
        ws_port: int,
        wss_port: int,
        mode_file: str | None,
        prompt_delay: float,
    ) -> None:
        self.host = host
        self.ws_port = ws_port
        self.wss_port = wss_port
        self.mode_file = mode_file
        self.prompt_delay = prompt_delay
        # Ephemeral pairing credential for this mock run only.
        self._client_key = secrets.token_hex(16)
        self._pointer_token = secrets.token_hex(12)
        self._lock = threading.Lock()
        self.volume = 25
        self.muted = False
        self.active_input = "HDMI_1"
        self.foreground_app = "com.webos.app.hdmi1"
        self.power_on = True
        self._active_socks: set[socket.socket] = set()
        self._stop = threading.Event()
        self._cert_dir: str | None = None
        self._ssl_ctx: ssl.SSLContext | None = None
        self.bound_ws_port = 0
        self.bound_wss_port = 0

    def current_mode(self) -> str:
        if not self.mode_file:
            return "accept"
        try:
            with open(self.mode_file, "r", encoding="utf-8") as f:
                return f.read().strip() or "accept"
        except OSError:
            return "accept"

    def set_mode(self, mode: str) -> None:
        if not self.mode_file:
            return
        try:
            with open(self.mode_file, "w", encoding="utf-8") as f:
                f.write(mode)
        except OSError:
            pass

    def _track(self, sock: socket.socket) -> None:
        with self._lock:
            self._active_socks.add(sock)

    def _untrack(self, sock: socket.socket) -> None:
        with self._lock:
            self._active_socks.discard(sock)

    def drop_all_clients(self) -> None:
        with self._lock:
            socks = list(self._active_socks)
        for s in socks:
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                s.close()
            except OSError:
                pass

    def _send_json(self, sock: socket.socket, obj: dict) -> bool:
        return ws_send_text(sock, json.dumps(obj, separators=(",", ":")))

    def _handle_pointer(self, sock: socket.socket, scheme: str) -> None:
        log("pointer_connected", scheme=scheme)
        try:
            while not self._stop.is_set():
                if self.current_mode() == "offline":
                    break
                frame = ws_recv_frame(sock)
                if frame is None:
                    break
                opcode, payload = frame
                if opcode == 0:
                    continue
                if opcode == 0x8:
                    ws_send_frame(sock, 0x8, b"")
                    break
                if opcode == 0x9:
                    ws_send_frame(sock, 0xA, payload)
                    continue
                if opcode == 0x1:
                    text = payload.decode("utf-8", errors="replace")
                    msg_type = ""
                    btn_name = ""
                    for line in text.split("\n"):
                        if line.startswith("type:"):
                            msg_type = line[5:].strip()
                        elif line.startswith("name:"):
                            btn_name = line[5:].strip()
                    if msg_type == "button" and btn_name:
                        log("pointer_button", name=btn_name)
                    else:
                        log("pointer_frame", raw=text[:64])
        finally:
            log("pointer_disconnected", scheme=scheme)

    def _handle_ssap_request(self, sock: socket.socket, msg: dict, scheme: str, local_port: int) -> bool:
        """Handle one SSAP request. Returns False if the connection should close."""
        req_id = msg.get("id", "0")
        uri = str(msg.get("uri", ""))
        payload = msg.get("payload") if isinstance(msg.get("payload"), dict) else {}

        def ok(data: dict | None = None) -> None:
            body = {"returnValue": True}
            if data:
                body.update(data)
            self._send_json(sock, {"type": "response", "id": req_id, "payload": body})

        def err(msg_text: str) -> None:
            self._send_json(
                sock,
                {
                    "type": "error",
                    "id": req_id,
                    "error": msg_text,
                    "payload": {"returnValue": False, "errorText": msg_text},
                },
            )

        if uri == "ssap://system/turnOff":
            self.power_on = False
            log("turn_off")
            ok()
            time.sleep(0.03)
            return False
        if uri == "ssap://audio/getVolume":
            with self._lock:
                vol, muted = self.volume, self.muted
            log("get_volume", volume=vol, muted=muted)
            ok(
                {
                    "volume": vol,
                    "muted": muted,
                    "volumeStatus": {
                        "volume": vol,
                        "muteStatus": muted,
                        "soundOutput": "tv_speaker",
                        "externalDeviceControl": False,
                    },
                }
            )
            return True
        if uri == "ssap://audio/volumeUp":
            with self._lock:
                self.volume = min(100, self.volume + 1)
                vol = self.volume
            log("volume", action="up", volume=vol)
            ok({"volume": vol})
            return True
        if uri == "ssap://audio/volumeDown":
            with self._lock:
                self.volume = max(0, self.volume - 1)
                vol = self.volume
            log("volume", action="down", volume=vol)
            ok({"volume": vol})
            return True
        if uri == "ssap://audio/setMute":
            if not isinstance(payload.get("mute"), bool):
                err("400 missing boolean mute")
                return True
            with self._lock:
                self.muted = payload["mute"]
                muted = self.muted
            log("mute", muted=muted)
            ok({"muted": muted})
            return True
        if uri == "ssap://tv/getExternalInputList":
            log("get_inputs", count=len(DEFAULT_INPUTS))
            ok({"devices": DEFAULT_INPUTS})
            return True
        if uri == "ssap://tv/switchInput":
            input_id = payload.get("inputId")
            valid_ids = {d["id"] for d in DEFAULT_INPUTS}
            if not isinstance(input_id, str) or input_id not in valid_ids:
                err(f"400 unknown inputId: {input_id}")
                return True
            with self._lock:
                self.active_input = input_id
                self.foreground_app = f"com.webos.app.hdmi{input_id.split('_')[1]}"
            log("switch_input", inputId=input_id)
            ok({"inputId": input_id})
            return True
        if uri in (
            "ssap://com.webos.applicationManager/listApps",
            "ssap://com.webos.applicationManager/listLaunchPoints",
        ):
            log("list_apps", count=len(DEFAULT_APPS))
            if uri.endswith("listLaunchPoints"):
                ok({"launchPoints": DEFAULT_APPS})
            else:
                ok({"apps": DEFAULT_APPS})
            return True
        if uri in (
            "ssap://com.webos.applicationManager/launch",
            "ssap://system.launcher/launch",
        ):
            app_id = payload.get("id")
            known = {a["id"] for a in DEFAULT_APPS if a.get("visible")}
            if not isinstance(app_id, str) or app_id not in known:
                err(f"404 unknown app id: {app_id}")
                return True
            with self._lock:
                self.foreground_app = app_id
            log("launch_app", appId=app_id)
            ok({"id": app_id, "sessionId": "mock-session-1"})
            return True
        if uri in (
            "ssap://media.controls/play",
            "ssap://media.controls/pause",
            "ssap://media.controls/stop",
        ):
            action = uri.rsplit("/", 1)[1]
            log("media", action=action)
            ok()
            return True
        if uri == "ssap://com.webos.service.networkinput/getPointerInputSocket":
            if self.current_mode() == "no-pointer":
                err("500 pointer input unavailable")
                return True
            socket_path = f"{scheme}://{self.host}:{local_port}/resources/{self._pointer_token}/netinput.pointer.sock"
            log("pointer_socket_issued", scheme=scheme)
            ok({"socketPath": socket_path})
            return True

        log("unknown_uri", uri=uri)
        err("404 no such service or method")
        return True

    def _handle_client(self, raw_sock: socket.socket, scheme: str, local_port: int) -> None:
        sock: socket.socket = raw_sock
        try:
            if self.current_mode() == "offline":
                return
            if scheme == "wss":
                assert self._ssl_ctx is not None
                raw_sock.settimeout(5.0)
                sock = self._ssl_ctx.wrap_socket(raw_sock, server_side=True)
            req_path = ws_handshake(sock)
            if req_path is None:
                return
            self._track(sock)
            if req_path == f"/resources/{self._pointer_token}/netinput.pointer.sock":
                self._handle_pointer(sock, scheme)
                return

            log("ws_connected", scheme=scheme, path=req_path)
            registered = False
            while not self._stop.is_set():
                mode = self.current_mode()
                if mode == "offline":
                    break
                if mode == "drop":
                    self.set_mode("accept")
                    log("simulated_drop")
                    break
                frame = ws_recv_frame(sock)
                if frame is None:
                    break
                opcode, payload = frame
                if opcode == 0:
                    continue
                if opcode == 0x8:
                    ws_send_frame(sock, 0x8, b"")
                    break
                if opcode == 0x9:
                    ws_send_frame(sock, 0xA, payload)
                    continue
                if opcode != 0x1:
                    continue
                try:
                    msg = json.loads(payload.decode("utf-8"))
                except (UnicodeDecodeError, ValueError):
                    continue
                if not isinstance(msg, dict):
                    continue
                mtype = msg.get("type")
                req_id = msg.get("id", "0")
                if mtype == "register":
                    reg_payload = msg.get("payload") if isinstance(msg.get("payload"), dict) else {}
                    sent_key = reg_payload.get("client-key")
                    if isinstance(sent_key, str) and sent_key == self._client_key:
                        registered = True
                        log("registered", reused=True, scheme=scheme)
                        self._send_json(
                            sock,
                            {
                                "type": "registered",
                                "id": req_id,
                                "payload": {"client-key": self._client_key},
                            },
                        )
                        continue
                    # Unpaired (or mismatched key): show TV prompt.
                    log("prompt", scheme=scheme)
                    self._send_json(
                        sock,
                        {
                            "type": "response",
                            "id": req_id,
                            "payload": {"pairingType": "PROMPT", "returnValue": True},
                        },
                    )
                    if self.prompt_delay > 0:
                        time.sleep(self.prompt_delay)
                    if self.current_mode() == "deny":
                        log("register_denied", scheme=scheme)
                        self._send_json(
                            sock,
                            {
                                "type": "error",
                                "id": req_id,
                                "error": "403 Error",
                                "payload": {"returnValue": False, "errorText": "rejected pairing"},
                            },
                        )
                    else:
                        registered = True
                        log("registered", reused=False, scheme=scheme)
                        self._send_json(
                            sock,
                            {
                                "type": "registered",
                                "id": req_id,
                                "payload": {"client-key": self._client_key},
                            },
                        )
                elif mtype == "request":
                    if not registered:
                        self._send_json(
                            sock,
                            {
                                "type": "error",
                                "id": req_id,
                                "error": "401 Unauthorized",
                                "payload": {"returnValue": False, "errorText": "not registered"},
                            },
                        )
                        continue
                    if not self._handle_ssap_request(sock, msg, scheme, local_port):
                        break
        except (ssl.SSLError, OSError):
            pass
        finally:
            self._untrack(sock)
            try:
                sock.close()
            except OSError:
                pass
            log("ws_disconnected", scheme=scheme)

    def _serve_loop(self, srv: socket.socket, scheme: str, local_port: int) -> None:
        srv.settimeout(0.5)
        log("listening", scheme=scheme, port=local_port)
        while not self._stop.is_set():
            if self.current_mode() == "offline":
                self.drop_all_clients()
            try:
                conn, _addr = srv.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            if self.current_mode() == "offline":
                try:
                    conn.close()
                except OSError:
                    pass
                continue
            threading.Thread(
                target=self._handle_client,
                args=(conn, scheme, local_port),
                daemon=True,
            ).start()

    def run(self) -> None:
        servers: list[tuple[socket.socket, str, int]] = []
        try:
            if self.wss_port >= 0:
                self._cert_dir = tempfile.mkdtemp(prefix="fake-webos-cert-")
                cert_path, key_path = make_self_signed_cert(self._cert_dir)
                ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                ctx.minimum_version = ssl.TLSVersion.TLSv1_2
                ctx.maximum_version = ssl.TLSVersion.TLSv1_2
                ctx.load_cert_chain(certfile=cert_path, keyfile=key_path)
                self._ssl_ctx = ctx
                s_wss = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s_wss.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s_wss.bind((self.host, self.wss_port))
                s_wss.listen(16)
                self.bound_wss_port = s_wss.getsockname()[1]
                servers.append((s_wss, "wss", self.bound_wss_port))

            if self.ws_port >= 0:
                s_ws = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s_ws.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s_ws.bind((self.host, self.ws_port))
                s_ws.listen(16)
                self.bound_ws_port = s_ws.getsockname()[1]
                servers.append((s_ws, "ws", self.bound_ws_port))

            threads = []
            for srv, scheme, port in servers:
                t = threading.Thread(target=self._serve_loop, args=(srv, scheme, port), daemon=True)
                t.start()
                threads.append(t)

            while not self._stop.is_set():
                time.sleep(0.2)
        except KeyboardInterrupt:
            pass
        finally:
            self._stop.set()
            self.drop_all_clients()
            for srv, _, _ in servers:
                try:
                    srv.close()
                except OSError:
                    pass
            if self._cert_dir:
                shutil.rmtree(self._cert_dir, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser(description="Mock LG webOS TV SSAP WebSocket server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--ws-port", type=int, default=3000, help="ws port (0=ephemeral, -1=disabled)")
    ap.add_argument("--wss-port", type=int, default=3001, help="wss port (0=ephemeral, -1=disabled)")
    ap.add_argument("--mode-file", default=None, help="file containing mode: accept|deny|offline|drop|no-pointer")
    ap.add_argument("--prompt-delay", type=float, default=0.05)
    args = ap.parse_args()

    tv = FakeWebOSTV(args.host, args.ws_port, args.wss_port, args.mode_file, args.prompt_delay)
    tv.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
