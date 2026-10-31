#!/usr/bin/env python3
"""Host-side test for codex_bt_pair_agent's SDP battery-report removal.

Builds the agent natively with its SDP socket pointed at a fake BlueZ 4
sdpd, then checks:

* the offline --sdp-hid-filter mode on synthetic HID records (strip, clean,
  idempotent, unsafe global state, Push/Pop, str8/str16 descriptors);
* --sdp-hid-check reads records over continuation states without changing
  them;
* --sdp-hid-strip-battery sends SDP_SVC_UPDATE_REQ with the patched record,
  each request arrives in one recv() as bluetoothd requires, a second run
  changes nothing, and other profiles are refused.

Usage: python3 tools/bt_sdp_battery_smoke.py [CC]

CC may carry flags, and AGENT_RUNNER runs the result, so the MIPS build can
be exercised under qemu user mode:

  AGENT_RUNNER=qemu-mips-static python3 tools/bt_sdp_battery_smoke.py \
    "zig cc -target mips-linux-musleabi -static"
"""

import os
import shlex
import socket
import struct
import subprocess
import sys
import tempfile
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "payload", "source", "codex_bt_pair_agent.c")

KEYBOARD = bytes.fromhex(
    "05010906A10185010507" "19E029E7150025017501950881029501750881019505"
    "7501050819012905910295017503910195067508150025FF0507190029FF8100C0")
MOUSE = bytes.fromhex(
    "05010902A10185020901A100050919012903150025019503750181029501750581"
    "0105010930093109381581257F750895038106C0C0")
CONSUMER = bytes.fromhex(
    "050C0901A101850375109502150126FF0219012AFF028160C0")
BATTERY = bytes.fromhex(
    "050C0901A10185AC05010906A10205060920150025FF750895018102C0C0")
SYSTEM = bytes.fromhex(
    "05010980A1018504150025017501950109828102950175078103C0")
# Same as SYSTEM but never sets Report Size: it would inherit the battery
# block's 8-bit size, so the battery block must not be cut before it.
SYSTEM_NO_SIZE = bytes.fromhex(
    "05010980A10185041500250195010982810295018103C0")
VENDOR = bytes.fromhex(
    "0600FF0901A1018510150026FF00750895060901810209019106C0")


def de(type_, payload, size_index=None):
    """Encode one SDP data element."""
    if type_ in (1, 2, 3, 5):
        fixed = {1: 0, 2: 1, 4: 2, 8: 3, 16: 4}[len(payload)]
        return bytes([(type_ << 3) | fixed]) + payload
    n = len(payload)
    if size_index is None:
        size_index = 5 if n < 0x100 else (6 if n < 0x10000 else 7)
    if size_index == 5:
        return bytes([(type_ << 3) | 5, n]) + payload
    if size_index == 6:
        return bytes([(type_ << 3) | 6]) + struct.pack(">H", n) + payload
    return bytes([(type_ << 3) | 7]) + struct.pack(">I", n) + payload


def u8(v):
    return de(1, struct.pack(">B", v))


def u16(v):
    return de(1, struct.pack(">H", v))


def u32(v):
    return de(1, struct.pack(">I", v))


def uuid16(v):
    return de(3, struct.pack(">H", v))


def boolean(v):
    return de(5, bytes([1 if v else 0]))


def seq(*items, size_index=None):
    return de(6, b"".join(items), size_index)


def text(s, size_index=None):
    return de(4, s if isinstance(s, bytes) else s.encode(), size_index)


def hid_record(handle, descriptor, desc_size_index=None):
    attrs = [
        (0x0000, u32(handle)),
        (0x0001, seq(uuid16(0x1124))),
        (0x0004, seq(seq(uuid16(0x0100), u16(0x0011)), seq(uuid16(0x0011)))),
        (0x0005, seq(uuid16(0x1002))),
        (0x0006, seq(u16(0x656E), u16(0x006A), u16(0x0100))),
        (0x0009, seq(seq(uuid16(0x1124), u16(0x0100)))),
        (0x000D, seq(seq(seq(uuid16(0x0100), u16(0x0013)),
                         seq(uuid16(0x0011))))),
        (0x0100, text("Logitech Bluetooth Keyboard")),
        (0x0201, u16(0x0111)),
        (0x0202, u8(0x40)),
        (0x0203, u8(0x00)),
        (0x0204, boolean(False)),
        (0x0205, boolean(True)),
        (0x0206, seq(seq(u8(0x22), text(descriptor, desc_size_index)))),
        (0x0207, seq(seq(u16(0x0409), u16(0x0100)))),
        (0x020E, boolean(True)),
    ]
    return seq(*(u16(a) + v for a, v in attrs))


def decode(buf, pos=0, end=None):
    """Decode a run of data elements into comparable tuples, strictly."""
    end = len(buf) if end is None else end
    out = []
    while pos < end:
        b = buf[pos]
        t, s = b >> 3, b & 7
        if t == 0:
            h, n = 1, 0
        elif t in (1, 2, 3, 5):
            h, n = 1, [1, 2, 4, 8, 16][s]
        else:
            h = {5: 2, 6: 3, 7: 5}[s]
            n = int.from_bytes(buf[pos + 1:pos + h], "big")
        body = pos + h
        assert body + n <= end, "element overruns its container"
        if t in (6, 7):
            out.append((t, tuple(decode(buf, body, body + n))))
        else:
            out.append((t, bytes(buf[body:body + n])))
        pos = body + n
    assert pos == end, "container length mismatch"
    return out


RUNNER = shlex.split(os.environ.get("AGENT_RUNNER", ""))


def build_agent(cc, workdir, sock_path):
    exe = os.path.join(workdir, "codex_bt_pair_agent")
    subprocess.run(shlex.split(cc) + ["-std=gnu99", "-Wall", "-Wextra", "-O2",
                    '-DSDP_LOCAL_SOCKET_PATH="%s"' % sock_path,
                    "-o", exe, SOURCE], check=True)
    return RUNNER + [exe]


def run_filter(exe, record):
    p = subprocess.run(exe + ["btkeyboard", "10", "--sdp-hid-filter"],
                       input=record.hex(":").encode(), capture_output=True,
                       check=True)
    lines = p.stdout.decode().strip().splitlines()
    patched = bytes.fromhex(lines[1].replace(" ", "")) if len(lines) > 1 else None
    return lines[0], patched


class FakeSdpd:
    """Enough of BlueZ 4 sdpd: search-attr with continuation, update."""

    def __init__(self, path, records, chunk=48):
        self.path = path
        self.records = dict(records)  # handle -> record bytes
        self.chunk = chunk
        self.updates = []
        self.errors = []
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(path)
        self.server.listen(4)
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def lists(self):
        return seq(*(self.records[h] for h in sorted(self.records)))

    def serve(self):
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            with conn:
                self.session(conn)

    def session(self, conn):
        while True:
            # bluetoothd: peek the header, then one recv() of the whole PDU.
            hdr = conn.recv(5, socket.MSG_PEEK)
            if len(hdr) != 5:
                return
            pdu, tid, plen = struct.unpack(">BHH", hdr)
            want = 5 + plen
            data = conn.recv(want)
            if len(data) != want:
                self.errors.append("request split across recv() calls")
                return
            params = data[5:]
            if pdu == 0x06:
                rsp_pdu, body = 0x07, self.search_attr(params)
            elif pdu == 0x77:
                rsp_pdu, body = 0x78, self.update(params)
            else:
                self.errors.append("unexpected pdu 0x%02x" % pdu)
                rsp_pdu, body = 0x01, struct.pack(">H", 0x0003)
            conn.sendall(struct.pack(">BHH", rsp_pdu, tid, len(body)) + body)

    def search_attr(self, params):
        assert params[:5] == bytes.fromhex("3503191124"), params.hex()
        assert params[7:14] == bytes.fromhex("35050a0000ffff"), params.hex()
        cont = params[14:]
        offset = 0 if cont[0] == 0 else struct.unpack(">H", cont[1:3])[0]
        full = self.lists()
        part = full[offset:offset + self.chunk]
        nxt = offset + len(part)
        cstate = b"\x00" if nxt >= len(full) else b"\x02" + struct.pack(">H", nxt)
        return struct.pack(">H", len(part)) + part + cstate

    def update(self, params):
        handle = struct.unpack(">I", params[:4])[0]
        record = params[4:]
        if handle not in self.records:
            return struct.pack(">H", 0x0002)
        decode(record)
        self.records[handle] = record
        self.updates.append(handle)
        return struct.pack(">H", 0)

    def close(self):
        self.server.close()


def check(condition, message):
    if not condition:
        raise SystemExit("FAIL " + message)


def main():
    cc = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CC", "cc")
    with tempfile.TemporaryDirectory(prefix="codex-sdp-smoke.") as workdir:
        sock_path = os.path.join(workdir, "sdp")
        exe = build_agent(cc, workdir, sock_path)

        full = KEYBOARD + MOUSE + CONSUMER + BATTERY + SYSTEM
        clean = KEYBOARD + MOUSE + CONSUMER + SYSTEM

        # Offline filter: strip, then idempotent.
        status, patched = run_filter(exe, hid_record(0x10001, full))
        check(status == "removed handle=0x00010001 report=0xac bytes=%d"
              % len(BATTERY), "strip status: " + status)
        check(decode(patched) == decode(hid_record(0x10001, clean)),
              "patched record differs from the expected record")
        status, _ = run_filter(exe, patched)
        check(status == "clean", "second pass not clean: " + status)

        # 16-bit string and sequence lengths; battery as the last block.
        big = full + VENDOR * 8 + BATTERY.replace(b"\x85\xac", b"\x85\xad")
        big = big.replace(BATTERY, b"", 1)
        record = hid_record(0x10002, big, desc_size_index=6)
        check(len(big) > 255, "test descriptor should need a 16-bit length")
        status, patched = run_filter(exe, record)
        check(status.startswith("removed handle=0x00010002 report=0xad"),
              "str16 strip status: " + status)
        check(decode(patched) == decode(hid_record(
            0x10002, big[:-len(BATTERY)], desc_size_index=6)),
            "str16 patched record differs")

        # Not safe to cut: the next block relies on inherited Report Size.
        status, _ = run_filter(exe, hid_record(
            0x10003, KEYBOARD + CONSUMER + BATTERY + SYSTEM_NO_SIZE))
        check(status == "clean", "inherited-global case was cut: " + status)

        # Push/Pop is not modelled: leave the descriptor alone.
        status, _ = run_filter(exe, hid_record(
            0x10004, KEYBOARD + bytes.fromhex("A4B4") + BATTERY + SYSTEM))
        check(status == "descriptor-unparsed", "push/pop status: " + status)

        # No battery collection at all.
        status, _ = run_filter(exe, hid_record(0x10005, clean))
        check(status == "clean", "clean descriptor status: " + status)

        # A truncated record is reported, not patched.
        status = subprocess.run(
            exe + ["btkeyboard", "10", "--sdp-hid-filter"],
            input=hid_record(0x10006, full)[:-7].hex().encode(),
            capture_output=True).stdout.decode().strip()
        check(status == "malformed", "truncated record status: " + status)

        # Against the fake sdpd, with small chunks to force continuations.
        battery_rec = hid_record(0x10001, full)
        other_rec = hid_record(0x10007, clean)
        sdpd = FakeSdpd(sock_path, {0x10001: battery_rec, 0x10007: other_rec})
        try:
            out = subprocess.run(exe + ["btkeyboard", "10", "--sdp-hid-check"],
                                 capture_output=True, check=True).stdout.decode()
            check("records-with-battery-collection=1" in out,
                  "check mode output: " + out)
            check(not sdpd.updates, "check mode must not update")

            p = subprocess.run(exe + ["fire", "10", "--sdp-hid-strip-battery"],
                               capture_output=True)
            check(p.returncode == 2 and not sdpd.updates,
                  "non-btkeyboard profile must be refused")

            out = subprocess.run(
                exe + ["btkeyboard", "10", "--sdp-hid-strip-battery"],
                capture_output=True, check=True).stdout.decode()
            check("battery-report-removed handle=0x00010001 report=0xac" in out,
                  "strip mode output: " + out)
            check(sdpd.updates == [0x10001], "updates: %r" % sdpd.updates)
            check(decode(sdpd.records[0x10001]) ==
                  decode(hid_record(0x10001, clean)),
                  "sdpd holds an unexpected record")
            check(sdpd.records[0x10007] == other_rec,
                  "clean record must be left untouched")

            out = subprocess.run(
                exe + ["btkeyboard", "10", "--sdp-hid-strip-battery"],
                capture_output=True, check=True).stdout.decode()
            check("records-with-battery-collection=0" in out and
                  sdpd.updates == [0x10001], "second run must be a no-op")
            check(not sdpd.errors, "sdpd errors: %r" % sdpd.errors)
        finally:
            sdpd.close()

        # No SDP server at all: a clear error, not a hang.
        os.unlink(sock_path)
        p = subprocess.run(exe + ["btkeyboard", "10", "--sdp-hid-check"],
                           capture_output=True, timeout=10)
        check(p.returncode == 1 and b"connect" in p.stderr,
              "missing socket: %r" % p.stderr)

    print("PASS SDP HID battery-collection removal")


if __name__ == "__main__":
    main()
