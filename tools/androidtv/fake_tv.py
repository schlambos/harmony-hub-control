#!/usr/bin/env python3
"""A fake Android TV for testing codex_androidtv without a real TV.

Speaks the Android TV Remote v2 pairing ("polo", port 6467) and remote (port 6466)
protocols over TLS, enough for codex_androidtv: it shows a pairing code (printed, and written
to --code-file), checks the client's secret, then accepts keys and answers power keys
by flipping its on/standby state. Every event is printed as one JSON line, so a test can
follow along.

Standard library only. The client certificate is self-signed, so Python's TLS server
can only see it when it is trusted: pass --trust with the client certificate (DER or
PEM), e.g. the hub's /data/codex/androidtv/client.crt.der copied out, or start without it and
the fake TV re-reads it once the file exists (--trust-wait).

    python3 tools/androidtv/fake_tv.py --host 127.0.0.1 --trust /tmp/androidtv/client.crt.der

MIT License, Copyright (c) 2026 Josh Lukens.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time

FEATURES = 0x26F


def log(event: str, **kw) -> None:
    print(json.dumps({"t": round(time.time(), 3), "event": event, **kw}), flush=True)


# ---------------------------------------------------------------- protobuf


def varint(v: int) -> bytes:
    out = bytearray()
    while v >= 0x80:
        out.append((v & 0x7F) | 0x80)
        v >>= 7
    out.append(v)
    return bytes(out)


def field_uint(num: int, v: int) -> bytes:
    return varint(num << 3) + varint(v)


def field_bytes(num: int, b: bytes) -> bytes:
    return varint((num << 3) | 2) + varint(len(b)) + b


def read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    v = shift = 0
    while True:
        c = buf[pos]
        pos += 1
        v |= (c & 0x7F) << shift
        if not c & 0x80:
            return v, pos
        shift += 7


def fields(msg: bytes) -> list[tuple[int, int, object]]:
    out, pos = [], 0
    while pos < len(msg):
        key, pos = read_varint(msg, pos)
        num, wt = key >> 3, key & 7
        if wt == 0:
            v, pos = read_varint(msg, pos)
        elif wt == 2:
            n, pos = read_varint(msg, pos)
            v, pos = msg[pos : pos + n], pos + n
        elif wt == 5:
            v, pos = msg[pos : pos + 4], pos + 4
        elif wt == 1:
            v, pos = msg[pos : pos + 8], pos + 8
        else:
            raise ValueError("bad wire type")
        out.append((num, wt, v))
    return out


def get(msg: bytes, num: int, default=None):
    for n, _wt, v in fields(msg):
        if n == num:
            return v
    return default


class Framed:
    """Varint-length-delimited messages over a TLS socket."""

    def __init__(self, sock: ssl.SSLSocket):
        self.sock = sock
        self.buf = b""

    def send(self, msg: bytes) -> None:
        self.sock.sendall(varint(len(msg)) + msg)

    def recv(self, timeout: float | None = None) -> bytes | None:
        self.sock.settimeout(timeout)
        while True:
            try:
                n, pos = read_varint(self.buf, 0)
                if len(self.buf) - pos >= n:
                    msg, self.buf = self.buf[pos : pos + n], self.buf[pos + n :]
                    return msg
            except IndexError:
                pass
            try:
                chunk = self.sock.recv(4096)
            except socket.timeout:
                return None
            if not chunk:
                raise ConnectionError("closed")
            self.buf += chunk


# ---------------------------------------------------------------- certificates


def make_server_cert(directory: str, bt: str) -> tuple[str, str]:
    key, crt = os.path.join(directory, "tv.key"), os.path.join(directory, "tv.crt")
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650",
         "-subj", f"/CN=atvremote\\/{bt}", "-keyout", key, "-out", crt],
        check=True, capture_output=True,
    )
    return crt, key


def to_pem(path: str) -> str:
    data = open(path, "rb").read()
    if data.startswith(b"-----BEGIN"):
        return path
    pem = ssl.DER_cert_to_PEM_cert(data)
    out = tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False)
    out.write(pem)
    out.close()
    return out.name


def rsa_numbers(cert_der: bytes) -> tuple[bytes, bytes]:
    """Modulus and exponent of a certificate's RSA key, via openssl (big-endian, no padding)."""
    with tempfile.NamedTemporaryFile(suffix=".der", delete=False) as f:
        f.write(cert_der)
    text = subprocess.run(["openssl", "x509", "-inform", "DER", "-in", f.name, "-noout", "-modulus"],
                          check=True, capture_output=True, text=True).stdout
    os.unlink(f.name)
    n = bytes.fromhex(text.strip().split("=", 1)[1])
    return n.lstrip(b"\x00"), (65537).to_bytes(3, "big")


# ---------------------------------------------------------------- the fake TV


class FakeTV:
    def __init__(self, args):
        self.args = args
        self.on = True
        self.volume = 10
        self.keys: list[int] = []
        self.tmp = tempfile.mkdtemp(prefix="fake-tv-")
        self.crt, self.key = make_server_cert(self.tmp, args.bt)
        self.server_der = ssl.PEM_cert_to_DER_cert(open(self.crt).read())
        self.paired_clients: set[bytes] = set()
        self.lock = threading.Lock()
        self.remote_conns: list[Framed] = []
        self.awake_at = 0.0       # wake-delay: "on" is reported from then on
        self.power_dropped = False
        self.power_quieted = False
        self.refuse_until = 0.0   # power-drop-once: off the network until then

    def mode(self) -> str:
        """Test behaviour, read from --mode-file at each step: space-separated
        options (see opt()); empty for a well-behaved TV."""
        path = self.args.mode_file
        try:
            return open(path).read().strip() if path else ""
        except OSError:
            return ""

    def opt(self, name: str):
        """One mode option: early-ack, no-ack, start-delay=<s>, vendor=<name>,
        wake-delay=<s> (report "on" that long after the power key),
        power-drop-once (ignore the next power-on key and drop off the network
        for 1.5 s, like a TV that is still shutting down), quiet-once (ignore
        the next power-on key and go silent on that connection, no pings) or
        offline (close the remote connection and refuse new ones);
        wake-on-return makes a power-drop-once TV come back on by itself;
        boot-on=<s>: a TV that is off when a connection starts reports standby,
        then turns on by itself <s> later (as when Wake-on-LAN powers it on).
        True for a flag, the value for name=value, None if absent."""
        for tok in self.mode().split():
            key, _, value = tok.partition("=")
            if key == name:
                return value if value else True
        return None

    def context(self) -> ssl.SSLContext:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(self.crt, self.key)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        trust = self.args.trust
        if trust and os.path.exists(trust):
            ctx.load_verify_locations(to_pem(trust))
            ctx.verify_mode = ssl.CERT_REQUIRED
        return ctx

    # -- pairing (polo) --
    def pairing(self, sock: ssl.SSLSocket) -> None:
        f = Framed(sock)
        client_der = sock.getpeercert(binary_form=True)
        code = None
        ok = field_uint(1, 2) + field_uint(2, 200)
        while True:
            msg = f.recv(120)
            if msg is None:
                log("pair_timeout")
                return
            if get(msg, 10) is not None:
                req = get(msg, 10)
                log("pair_request", client=get(req, 2, b"").decode(), service=get(req, 1, b"").decode())
                f.send(ok + field_bytes(11, field_bytes(1, b"fake-tv")))
            elif get(msg, 20) is not None:
                f.send(ok + field_bytes(20, field_bytes(1, field_uint(1, 3) + field_uint(2, 6)) + field_uint(3, 1)))
            elif get(msg, 30) is not None:
                # Make a code whose first byte matches the hash, like a real TV.
                cn, ce = rsa_numbers(client_der)
                sn, se = rsa_numbers(self.server_der)
                while True:
                    tail = secrets.token_bytes(2)
                    h = hashlib.sha256(cn + ce + sn + se + tail).digest()
                    code = (bytes([h[0]]) + tail).hex().upper()
                    break
                self.expected = h
                log("pair_code", code=code)
                if self.args.code_file:
                    with open(self.args.code_file, "w") as cf:
                        cf.write(code + "\n")
                f.send(ok + field_bytes(31, b""))
                if self.opt("early-ack"):
                    # A peer acknowledging a secret it never got.
                    log("early_ack")
                    f.send(ok + field_bytes(41, field_bytes(1, b"\0" * 32)))
            elif get(msg, 40) is not None:
                secret = get(get(msg, 40), 1, b"")
                if self.opt("no-ack"):
                    # Keep the connection open and never confirm the code.
                    log("secret_ignored")
                    while f.recv(120) is not None:
                        pass
                    return
                if secret == self.expected:
                    self.paired_clients.add(hashlib.sha256(client_der).digest())
                    log("paired")
                    f.send(ok + field_bytes(41, field_bytes(1, secret)))
                else:
                    log("bad_secret")
                    f.send(field_uint(1, 2) + field_uint(2, 402))
                return

    # -- remote --
    def start_message(self) -> bytes:
        return field_bytes(40, field_uint(1, 1 if self.on else 0))

    def remote(self, sock: ssl.SSLSocket) -> None:
        client_der = sock.getpeercert(binary_form=True)
        if hashlib.sha256(client_der).digest() not in self.paired_clients and not self.args.accept_unpaired:
            log("remote_rejected_unpaired")
            sock.close()
            return
        f = Framed(sock)
        vendor = str(self.opt("vendor") or "FakeCo").encode()
        f.send(field_bytes(1, field_uint(1, FEATURES) + field_bytes(2, field_bytes(1, b"Fake") + field_bytes(2, vendor))))
        configured = False
        with self.lock:
            self.remote_conns.append(f)
        log("remote_connected")
        last_ping = time.time()
        start_at = None  # a delayed remote_start (mode start-delay=<s>)
        quiet = False    # quiet-once: this connection says nothing more
        boot_at = None   # boot-on=<s>: when this TV, woken off, turns on by itself
        try:
            while True:
                msg = f.recv(0.2 if start_at or boot_at else 1.0)
                if self.opt("offline"):
                    raise ConnectionError("offline")
                if quiet:
                    continue
                if boot_at and time.time() >= boot_at:
                    boot_at = None
                    self.on = True
                    self.awake_at = time.time()
                    log("power", on=True, by="boot")
                    f.send(self.start_message())
                if start_at and time.time() >= start_at:
                    start_at = None
                    log("remote_start_sent")
                    f.send(self.start_message())
                if time.time() - last_ping > 5:
                    f.send(field_bytes(8, field_uint(1, int(time.time()) & 0xFFFF)))
                    last_ping = time.time()
                if msg is None:
                    continue
                if get(msg, 1) is not None and not configured:
                    configured = True
                    log("remote_configured", features=get(get(msg, 1), 1, 0))
                    f.send(field_bytes(2, field_uint(1, FEATURES)))
                elif get(msg, 2) is not None:
                    boot = self.opt("boot-on")
                    if boot and not self.on:
                        # Woken by Wake-on-LAN, it powers fully on, but
                        # reports standby until it has booted.
                        boot_at = time.time() + float(boot)
                    delay = self.opt("start-delay")
                    if delay:
                        start_at = time.time() + float(delay)
                    else:
                        f.send(self.start_message())
                    f.send(field_bytes(50, field_uint(6, 100) + field_uint(7, self.volume) + field_uint(8, 0)))
                elif get(msg, 9) is not None:
                    pass  # ping response
                elif get(msg, 10) is not None:
                    k = get(msg, 10)
                    code, direction = get(k, 1, 0), get(k, 2, 0)
                    # the once-only modes re-arm when they are taken out of the mode file
                    if not self.opt("power-drop-once"):
                        self.power_dropped = False
                    if not self.opt("quiet-once"):
                        self.power_quieted = False
                    if code == 26 and not self.on and self.opt("quiet-once") and not self.power_quieted:
                        self.power_quieted = True
                        quiet = True
                        log("power_quiet")
                        continue
                    if code == 26 and not self.on and self.opt("power-drop-once") and not self.power_dropped:
                        self.power_dropped = True
                        self.refuse_until = time.time() + 1.5
                        if self.opt("wake-on-return"):
                            self.on = True   # comes back on by itself (Wake-on-LAN did it)
                        log("power_dropped")
                        raise ConnectionError("dropped off while shutting down")
                    self.keys.append(code)
                    log("key", code=code, direction=direction, awake=self.awake())
                    if code == 26 and boot_at:
                        # Keyed while booting: it finishes, then turns off.
                        boot_at = None
                        log("power", on=False, by="keyed while booting")
                        f.send(self.start_message())
                    elif code == 26:
                        self.on = not self.on
                        log("power", on=self.on)
                        wake = self.opt("wake-delay")
                        if self.on and wake:
                            self.awake_at = time.time() + float(wake)
                            start_at = self.awake_at
                        else:
                            f.send(self.start_message())
                    elif code in (24, 25):
                        self.volume = max(0, min(100, self.volume + (1 if code == 24 else -1)))
                        f.send(field_bytes(50, field_uint(6, 100) + field_uint(7, self.volume) + field_uint(8, 0)))
                elif get(msg, 90) is not None:
                    log("app_link", link=get(get(msg, 90), 1, b"").decode(), awake=self.awake())
        except (ConnectionError, OSError, ssl.SSLError) as exc:
            log("remote_closed", why=str(exc))
        finally:
            with self.lock:
                if f in self.remote_conns:
                    self.remote_conns.remove(f)

    def awake(self) -> bool:
        """On, and done waking (wake-delay)."""
        return self.on and time.time() >= self.awake_at

    def serve(self, port: int, handler) -> None:
        srv = socket.create_server((self.args.host, port), reuse_port=False)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        log("listening", port=port)
        while True:
            raw, addr = srv.accept()
            def run(raw=raw):
                try:
                    if self.args.trust_wait and self.args.trust and not os.path.exists(self.args.trust):
                        raw.close()
                        return
                    if time.time() < self.refuse_until or (port == self.args.remote_port and self.opt("offline")):
                        raw.close()
                        return
                    sock = self.context().wrap_socket(raw, server_side=True)
                    handler(sock)
                except (ssl.SSLError, OSError, ConnectionError) as exc:
                    log("tls_error", port=port, why=str(exc))
                finally:
                    try:
                        raw.close()
                    except OSError:
                        pass
            threading.Thread(target=run, daemon=True).start()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--pair-port", type=int, default=6467)
    ap.add_argument("--remote-port", type=int, default=6466)
    ap.add_argument("--trust", help="client certificate to accept (DER or PEM)")
    ap.add_argument("--trust-wait", action="store_true", help="refuse connections until --trust exists")
    ap.add_argument("--code-file", help="write the pairing code here")
    ap.add_argument("--bt", default="AA:BB:CC:00:11:22", help="Bluetooth address in the certificate CN")
    ap.add_argument("--accept-unpaired", action="store_true")
    ap.add_argument("--mode-file", help="behave as this file says: early-ack, no-ack, start-delay=<s>, vendor=<name>, "
                                        "wake-delay=<s>, power-drop-once, wake-on-return, boot-on=<s>, quiet-once, offline (space-separated)")
    args = ap.parse_args()
    tv = FakeTV(args)
    threading.Thread(target=tv.serve, args=(args.pair_port, tv.pairing), daemon=True).start()
    tv.serve(args.remote_port, tv.remote)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
