#!/usr/bin/env python3
"""Exercise codex_hbus response correlation against a local WebSocket mock."""

import json
import socket
import struct
import subprocess
import sys
import tempfile
import threading


HOST = "127.0.0.1"
PORT = 8088


def recv_exact(conn: socket.socket, length: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < length:
        chunk = conn.recv(length - len(chunks))
        if not chunk:
            raise RuntimeError("client disconnected")
        chunks.extend(chunk)
    return bytes(chunks)


def recv_frame(conn: socket.socket) -> tuple[int, bytes]:
    first, second = recv_exact(conn, 2)
    opcode = first & 0x0F
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", recv_exact(conn, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", recv_exact(conn, 8))[0]
    masked = bool(second & 0x80)
    mask = recv_exact(conn, 4) if masked else b""
    payload = bytearray(recv_exact(conn, length))
    if masked:
        for index in range(length):
            payload[index] ^= mask[index & 3]
    return opcode, bytes(payload)


def frame(opcode: int, payload: bytes, *, fin: bool = True) -> bytes:
    first = opcode | (0x80 if fin else 0)
    length = len(payload)
    if length < 126:
        header = bytes((first, length))
    elif length <= 65535:
        header = bytes((first, 126)) + struct.pack("!H", length)
    else:
        header = bytes((first, 127)) + struct.pack("!Q", length)
    return header + payload


def serve(result: dict[str, object]) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind((HOST, PORT))
        server.listen(1)
        result["ready"] = True
        conn, _ = server.accept()
        with conn:
            conn.settimeout(10)
            request = bytearray()
            while b"\r\n\r\n" not in request:
                request.extend(conn.recv(1024))
            notification = json.dumps(
                {
                    "type": "connect.stateDigest?notify",
                    "data": {"activityId": "-1"},
                },
                separators=(",", ":"),
            ).encode()
            handshake = (
                b"HTTP/1.1 101 Switching Protocols\r\n"
                b"Upgrade: websocket\r\n"
                b"Connection: Upgrade\r\n\r\n"
            )
            conn.sendall(handshake + frame(0x1, notification))

            opcode, body = recv_frame(conn)
            if opcode != 0x1:
                raise RuntimeError(f"expected client text frame, got {opcode}")
            command = json.loads(body)
            request_id = command["hbus"]["id"]
            result["request_id"] = request_id

            conn.sendall(frame(0x9, b"probe"))
            pong_opcode, pong_body = recv_frame(conn)
            if pong_opcode != 0xA or pong_body != b"probe":
                raise RuntimeError(
                    f"expected masked pong, got opcode={pong_opcode} body={pong_body!r}"
                )
            conn.sendall(
                frame(
                    0x1,
                    json.dumps(
                        {"cmd": "unrelated", "code": 200, "id": "not-our-id"}
                    ).encode(),
                )
            )
            matching = json.dumps(
                {
                    "cmd": command["hbus"]["cmd"],
                    "code": 200,
                    "id": request_id,
                    "msg": "OK",
                    "data": {"code": "200", "blob": "x" * 350_000},
                }
            ).encode()
            midpoint = len(matching) // 2
            conn.sendall(
                frame(0x1, matching[:midpoint], fin=False)
                + frame(0x0, matching[midpoint:])
            )


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <host-codex-hbus>", file=sys.stderr)
        return 2
    result: dict[str, object] = {}
    thread = threading.Thread(target=serve, args=(result,), daemon=True)
    thread.start()
    while not result.get("ready"):
        thread.join(0.01)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8") as params:
        json.dump({"resource": "y" * 333_000}, params)
        params.flush()
        process = subprocess.run(
            [
                sys.argv[1],
                "12345678",
                "proxy.resource?put",
                f"@{params.name}",
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=40,
            check=False,
        )
    thread.join(2)
    if process.returncode != 0:
        print(process.stderr, file=sys.stderr)
        return process.returncode or 1
    response = json.loads(process.stdout)
    if response.get("id") != result.get("request_id"):
        print(f"wrong response: {response}", file=sys.stderr)
        return 1
    if response.get("cmd") != "proxy.resource?put" or response.get("code") != 200:
        print(f"unexpected response: {response}", file=sys.stderr)
        return 1
    if len(response.get("data", {}).get("blob", "")) != 350_000:
        print("large fragmented response was truncated", file=sys.stderr)
        return 1
    if "notify" in process.stdout or "unrelated" in process.stdout:
        print(f"unsolicited frame leaked to stdout: {process.stdout}", file=sys.stderr)
        return 1
    print(
        "PASS 333KB file-backed request plus notification, ping, unrelated "
        "response, and 350KB fragmented matching response"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
