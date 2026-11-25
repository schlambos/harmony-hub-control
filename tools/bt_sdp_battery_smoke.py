#!/usr/bin/env python3
"""Host-side test for codex_bt_pair_agent's SDP edits for btkeyboard hosts.

Builds the agent natively with its SDP socket and its saved-target files
pointed at a temporary directory and a fake BlueZ 4 sdpd, then checks:

* the offline --sdp-hid-filter mode on synthetic HID records and on the
  real record a Homatics Box R 4K Plus read from a hub (strip, clean,
  idempotent, unsafe global state, Push/Pop, str8/str16 descriptors);
* --sdp-hid-check / --sdp-hid-strip-battery over continuation states, with
  SDP_SVC_UPDATE_REQ arriving in one recv() as bluetoothd requires;
* --sdp-att-check / --sdp-att-hide remove only bluetoothd's GAP, GATT and
  Harmony BLE records on PSM 0x1F (SDP_SVC_REMOVE_REQ), never the HID record
  or any other ATT record;
* the daemon's watch (--sdp-watch-test, HCI events on stdin): no SDP traffic
  at all without a btkeyboard target, nothing redone without an event, a
  strip on HAL's 0x0C24, and a hide once per bluetoothd start (its SDP
  socket closing, then 0x2008).

Usage: python3 tools/bt_sdp_battery_smoke.py [CC]

CC may carry flags, and AGENT_RUNNER runs the result, so the MIPS build can
be exercised under qemu user mode:

  AGENT_RUNNER=qemu-mips-static python3 tools/bt_sdp_battery_smoke.py \
    "zig cc -target mips-linux-musleabi -static"
"""

import os
import random
import shlex
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time

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


# The HID record a Homatics Box R 4K Plus read from a Harmony Hub after the
# battery strip, from its btsnoop log: Logitech's btkeyboard record, handle
# 0x00010000.  Its descriptor, split by hand into top-level collections:
HUB_RECORD = bytes.fromhex(
    "3602100900000a000100000900013503191124090004350d350619010009001135031900"
    "110900053503191002090006350909656e09006a09010009000935083506191124090100"
    "09000d350f350d3506190100090013350319001109010025244c6f67697465636820426c"
    "7565746f6f746820436f72646c657373204b6579626f61726409010125084b6579626f61"
    "726409010225084c6f676974656368090200090100090201090111090202084009020308"
    "210902042801090205280109020636012236011f082226011a05010902a10185020901a1"
    "00050919012908150025017501950881020501093009311601f826ff07750c9502810609"
    "381581257f750895018106050c0a3802810605091909291015002501950875018102c0c0"
    "05010906a101850175019508050719e029e7150025018102950175088103950175089103"
    "95067508150026ff000507190029ff8100c0050c0901a101850375109502150126ff0219"
    "012aff028160c005010980a1018504150025017501950109828102950175078103c0050c"
    "0901a10185ad05010906a1020600ff2501750195020a03fe0a04fe810295068103c0c005"
    "0c0901a10185ff0506150025029501750219242926814075068101c00600ff0901a10185"
    "1075089506150026ff000901810009019100c00902073508350609040909010009020828"
    "00090209280009020a280109020b09010009020d280009020e2801")
HUB_MOUSE = bytes.fromhex(
    "05010902a10185020901a100050919012908150025017501950881020501093009311601"
    "f826ff07750c9502810609381581257f750895018106050c0a3802810605091909291015"
    "002501950875018102c0c0")
HUB_KEYBOARD = bytes.fromhex(
    "05010906a101850175019508050719e029e715002501810295017508810395017508910395"
    "067508150026ff000507190029ff8100c0")
HUB_CONSUMER = CONSUMER
HUB_SYSTEM = SYSTEM
HUB_AD = bytes.fromhex(
    "050c0901a10185ad05010906a1020600ff2501750195020a03fe0a04fe810295068103c0c0")
HUB_FF = bytes.fromhex(
    "050c0901a10185ff0506150025029501750219242926814075068101c0")
HUB_VENDOR = bytes.fromhex(
    "0600ff0901a101851075089506150026ff000901810009019100c0")


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


def gatt_record(handle, service, start, end, name):
    """An SDP record for a GATT service over BR/EDR, as bluetoothd makes it."""
    service_uuid = uuid16(service) if isinstance(service, int) else \
        de(3, bytes.fromhex(service))
    return seq(
        u16(0x0000) + u32(handle),
        u16(0x0001) + seq(service_uuid),
        u16(0x0004) + seq(seq(uuid16(0x0100), u16(0x001F)),
                          seq(uuid16(0x0007), u16(start), u16(end))),
        u16(0x0005) + seq(uuid16(0x1002)),
        u16(0x0100) + text(name))


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


def encode(tree):
    """Re-encode decode() output with minimal length fields, as BlueZ does."""
    out = b""
    for t, v in tree:
        out += de(t, encode(v) if t in (6, 7) else v) if t else b"\x00"
    return out


def replace_descriptor(tree, descriptor):
    """Copy of a decoded record with its HID descriptor string replaced."""
    out = []
    for t, v in tree:
        if t in (6, 7):
            v = tuple(replace_descriptor(v, descriptor))
        elif t == 4 and v[:2] in (b"\x05\x01", b"\x05\x0c"):
            v = descriptor
        out.append((t, v))
    return out


def build_agent(cc, workdir, sock_path):
    exe = os.path.join(workdir, "codex_bt_pair_agent")
    subprocess.run(shlex.split(cc) + ["-std=gnu99", "-Wall", "-Wextra", "-O2",
                    '-DSDP_LOCAL_SOCKET_PATH="%s"' % sock_path,
                    '-DBT_DEVICE_STORE_PATH="%s"' % os.path.join(workdir, "bt-devices.json"),
                    '-DBT_TARGET_PATH="%s"' % os.path.join(workdir, "bthid_target"),
                    "-o", exe, SOURCE], check=True)
    return RUNNER + [exe]


def run_filter(exe, record):
    p = subprocess.run(exe + ["btkeyboard", "10", "--sdp-hid-filter"],
                       input=record.hex(":").encode(), capture_output=True,
                       check=True)
    lines = p.stdout.decode().strip().splitlines()
    patched = bytes.fromhex(lines[1].replace(" ", "")) if len(lines) > 1 else None
    return lines[0], patched


def stop_listening(server, path):
    """Stop accepting before any session drops, as a real bluetoothd exit
    does. On Linux close() alone leaves a listener that another thread is
    blocked in accept() on still accepting, so the agent's instant
    reconnect on EOF could reach the old server; shutdown() wakes it."""
    if os.path.exists(path):
        os.unlink(path)
    try:
        server.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    server.close()


class FakeSdpd:
    """Enough of BlueZ 4 sdpd: search-attr with continuation, update."""

    def __init__(self, path, records, chunk=48, search=None):
        self.path = path
        self.records = dict(records)  # handle -> record bytes
        # uuid16 -> handles a search returns; by default every record is HID
        self.search = search or {0x1124: sorted(self.records)}
        self.removed = []
        self.conns = []
        self.accepted = 0
        self.chunk = chunk
        self.updates = []
        self.errors = []
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(path)
        self.server.listen(4)
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def lists(self, uuid):
        return seq(*(self.records[h] for h in self.search.get(uuid, [])
                     if h in self.records))

    def serve(self):
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            self.conns.append(conn)
            self.accepted += 1
            threading.Thread(target=self.session_thread, args=(conn,),
                             daemon=True).start()

    def session_thread(self, conn):
        try:
            self.session(conn)
        except OSError:
            pass
        finally:
            conn.close()

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
            elif pdu == 0x79:
                rsp_pdu, body = 0x80, self.remove(params)
            else:
                self.errors.append("unexpected pdu 0x%02x" % pdu)
                rsp_pdu, body = 0x01, struct.pack(">H", 0x0003)
            conn.sendall(struct.pack(">BHH", rsp_pdu, tid, len(body)) + body)

    def search_attr(self, params):
        assert params[:3] == bytes.fromhex("350319"), params.hex()
        assert params[7:14] == bytes.fromhex("35050a0000ffff"), params.hex()
        uuid = struct.unpack(">H", params[3:5])[0]
        cont = params[14:]
        offset = 0 if cont[0] == 0 else struct.unpack(">H", cont[1:3])[0]
        full = self.lists(uuid)
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

    def remove(self, params):
        handle = struct.unpack(">I", params[:4])[0]
        if handle not in self.records:
            return struct.pack(">H", 0x0002)
        del self.records[handle]
        self.removed.append(handle)
        return struct.pack(">H", 0)

    def close(self):
        """Like bluetoothd exiting: the listener and every session close."""
        stop_listening(self.server, self.path)
        for conn in self.conns:
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


class ScriptedSdpd:
    """An sdpd that answers each request with whatever reply(pdu, tid,
    params) returns: raw bytes, or None to accept and never answer."""

    def __init__(self, path, reply):
        self.path = path
        self.reply = reply
        self.conns = []
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(path)
        self.server.listen(4)
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            self.conns.append(conn)
            threading.Thread(target=self.session, args=(conn,),
                             daemon=True).start()

    def session(self, conn):
        try:
            while True:
                hdr = conn.recv(5, socket.MSG_PEEK)
                if len(hdr) != 5:
                    return
                pdu, tid, plen = struct.unpack(">BHH", hdr)
                data = conn.recv(5 + plen)
                out = self.reply(pdu, tid, data[5:])
                if out is None:
                    conn.recv(1)  # until the agent gives up and closes
                    return
                conn.sendall(out)
        except OSError:
            pass
        finally:
            conn.close()

    def close(self):
        stop_listening(self.server, self.path)
        for conn in self.conns:
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def search_reply(tid, chunk, cstate=b"\x00", plen=None):
    body = struct.pack(">H", len(chunk)) + chunk + cstate
    return struct.pack(">BHH", 0x07, tid, len(body) if plen is None else plen) + body


def build_sanitized(cc, workdir, sock_path):
    """The agent with ASan and UBSan, or None if the compiler can't."""
    if RUNNER:
        return None
    exe = os.path.join(workdir, "codex_bt_pair_agent_asan")
    p = subprocess.run(shlex.split(cc) + ["-std=gnu99", "-O1", "-g",
                       "-fsanitize=address,undefined",
                       "-fno-sanitize-recover=all",
                       '-DSDP_LOCAL_SOCKET_PATH="%s"' % sock_path,
                       '-DBT_DEVICE_STORE_PATH="%s"' % os.path.join(workdir, "bt-devices.json"),
                       '-DBT_TARGET_PATH="%s"' % os.path.join(workdir, "bthid_target"),
                       "-o", exe, SOURCE], capture_output=True)
    if p.returncode != 0:
        return None
    # LeakSanitizer's exit scan costs ~0.5 s a run in a container and finds
    # nothing that matters for these short runs.
    os.environ.setdefault("ASAN_OPTIONS", "detect_leaks=0")
    try:
        subprocess.run([exe, "btkeyboard", "10", "--sdp-hid-filter"],
                       input=b"", capture_output=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return [exe]


def mutate(rng, data):
    """One random edit: flip, overwrite, insert, delete or truncate."""
    data = bytearray(data)
    for _ in range(rng.randint(1, 4)):
        op = rng.randrange(5)
        pos = rng.randrange(len(data)) if data else 0
        if op == 0 and data:
            data[pos] ^= 1 << rng.randrange(8)
        elif op == 1 and data:
            data[pos] = rng.choice((0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff,
                                    0x35, 0x36, 0x37, 0x25, 0x26, 0x27,
                                    0xa1, 0xc0, 0x85, rng.randrange(256)))
        elif op == 2:
            data[pos:pos] = bytes([rng.randrange(256)])
        elif op == 3 and data:
            del data[pos]
        else:
            del data[rng.randrange(len(data) + 1):]
    return bytes(data)


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

        # A descriptor whose last item is cut short is left alone, even
        # though the bytes after it in the record would complete it.
        status, _ = run_filter(exe, hid_record(
            0x10008, KEYBOARD + BATTERY + SYSTEM + b"\x26"))
        check(status == "descriptor-unparsed",
              "truncated descriptor item status: " + status)

        # No battery collection at all.
        status, _ = run_filter(exe, hid_record(0x10005, clean))
        check(status == "clean", "clean descriptor status: " + status)

        # A truncated record is reported, not patched.
        status = subprocess.run(
            exe + ["btkeyboard", "10", "--sdp-hid-filter"],
            input=hid_record(0x10006, full)[:-7].hex().encode(),
            capture_output=True).stdout.decode().strip()
        check(status == "malformed", "truncated record status: " + status)

        # The real hub record.  Restoring the battery collection where HAL
        # puts it (before system control) and stripping it again must give
        # back exactly the bytes the box read.
        hub_desc = (HUB_MOUSE + HUB_KEYBOARD + HUB_CONSUMER + HUB_SYSTEM +
                    HUB_AD + HUB_FF + HUB_VENDOR)
        hub_tree = decode(HUB_RECORD)
        check(encode(hub_tree) == HUB_RECORD, "fixture re-encoding differs")
        check(replace_descriptor(hub_tree, hub_desc) == hub_tree,
              "hand split of the hub descriptor is wrong")
        status, _ = run_filter(exe, HUB_RECORD)
        check(status == "clean", "hub record after strip: " + status)
        hub_prefix = encode(replace_descriptor(hub_tree, hub_desc.replace(
            HUB_SYSTEM, BATTERY + HUB_SYSTEM)))
        status, patched = run_filter(exe, hub_prefix)
        check(status == "removed handle=0x00010000 report=0xac bytes=30",
              "hub record strip status: " + status)
        check(patched == HUB_RECORD, "hub record strip is not byte-exact")

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

        sdpd = FakeSdpd(sock_path, {0x10000: hub_prefix})
        try:
            out = subprocess.run(exe + ["btkeyboard", "10", "--sdp-hid-check"],
                                 capture_output=True, check=True).stdout.decode()
            check("report=0x02 battery-only=keep" in out
                  and "report=0xac battery-only=remove" in out
                  and "report=0x01 battery-only=keep" in out,
                  "check mode collection table: " + out)
            check(not sdpd.updates, "check mode must not update")
            check(not sdpd.errors, "sdpd errors: %r" % sdpd.errors)
        finally:
            sdpd.close()

        # GATT over BR/EDR, as the hub answers an ATT (0x0007) search: its
        # HID record (no ATT element), bluetoothd's GAP, GATT and Harmony BLE
        # records, and two that only look alike and must stay: another
        # service over ATT, and ATT on a PSM other than 0x1F.
        gatt = gatt_record(0x10001, 0x1801, 0x0010, 0x0010,
                           "Generic Attribute Profile")
        vendor = gatt_record(0x10002, "830a55485c6623bd0949c0040000227e",
                             0xFFF4, 0xFFFE, "Harmony")
        gap = gatt_record(0x10003, 0x1800, 0x0001, 0x0005, "Generic Access Profile")
        battery_svc = gatt_record(0x10004, 0x180F, 0x0020, 0x0024, "Battery")
        other_psm = gatt_record(0x10005, 0x1801, 0x0030, 0x0030, "Other").replace(
            u16(0x001F), u16(0x1001), 1)
        att_records = {0x10000: HUB_RECORD, 0x10001: gatt, 0x10002: vendor,
                       0x10003: gap, 0x10004: battery_svc, 0x10005: other_psm}
        sdpd = FakeSdpd(sock_path, att_records,
                        search={0x1124: [0x10000], 0x0007: sorted(att_records)})
        try:
            out = subprocess.run(exe + ["btkeyboard", "10", "--sdp-att-check"],
                                 capture_output=True, check=True).stdout.decode()
            check("handle=0x00010000 service=1124 att=none keep" in out and
                  "handle=0x00010001 service=1801 psm=0x001f att=0x0010-0x0010 "
                  "would-remove" in out and
                  "handle=0x00010002 service=830a55485c6623bd0949c0040000227e "
                  "psm=0x001f att=0xfff4-0xfffe would-remove" in out and
                  "handle=0x00010003 service=1800 psm=0x001f att=0x0001-0x0005 "
                  "would-remove" in out and
                  "handle=0x00010004 service=180f psm=0x001f att=0x0020-0x0024 "
                  "keep" in out and
                  "handle=0x00010005 service=1801 psm=0x1001 att=0x0030-0x0030 "
                  "keep" in out and
                  "records=6 gatt-records=3" in out,
                  "att check output: " + out)
            check(not sdpd.removed, "att check must not remove")
            p = subprocess.run(exe + ["fire", "10", "--sdp-att-hide"],
                               capture_output=True)
            check(p.returncode == 2 and not sdpd.removed,
                  "att hide must refuse other profiles")
            out = subprocess.run(exe + ["btkeyboard", "10", "--sdp-att-hide"],
                                 capture_output=True, check=True).stdout.decode()
            check(sdpd.removed == [0x10001, 0x10002, 0x10003] and
                  "att=0x0010-0x0010 removed" in out,
                  "att hide: %r %s" % (sdpd.removed, out))
            check(set(sdpd.records) == {0x10000, 0x10004, 0x10005},
                  "the HID record and the other ATT records must stay")
            out = subprocess.run(exe + ["btkeyboard", "10", "--sdp-att-hide"],
                                 capture_output=True, check=True).stdout.decode()
            check("records=3 gatt-records=0" in out and
                  sdpd.removed == [0x10001, 0x10002, 0x10003],
                  "second att hide must be a no-op: " + out)
            check(not sdpd.errors, "sdpd errors: %r" % sdpd.errors)
        finally:
            sdpd.close()

        # The daemon's watch, HCI events fed on stdin.
        store = os.path.join(workdir, "bt-devices.json")
        target = os.path.join(workdir, "bthid_target")

        def hub_sdpd():
            records = {0x10000: hub_prefix, 0x10001: gatt, 0x10002: vendor,
                       0x10003: gap, 0x10004: battery_svc}
            return FakeSdpd(sock_path, records,
                            search={0x1124: [0x10000], 0x0007: sorted(records)})

        def wait_for(condition, seconds):
            deadline = time.time() + seconds
            while time.time() < deadline:
                if condition():
                    return True
                time.sleep(0.05)
            return False

        def start_watch():
            return subprocess.Popen(exe + ["btkeyboard", "30", "--sdp-watch-test"],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT)

        def send(watch, line):
            watch.stdin.write((line + "\n").encode())
            watch.stdin.flush()

        def stop(watch):
            watch.terminate()
            return watch.communicate(timeout=10)[0].decode()

        clean_state = lambda d: (set(d.records) == {0x10000, 0x10004} and
                                 d.records[0x10000] == HUB_RECORD)

        # 1. No btkeyboard target: the SDP socket is never opened, whatever
        # happens on HCI.
        for path in (store, target):
            if os.path.exists(path):
                os.unlink(path)
        with open(store, "w") as handle:
            handle.write('{"version":1,"devices":[{"id":"bt_1_2","name":"PS3",'
                         '"type":"ps3","bdaddr":"AA:BB:CC:DD:EE:FF","commands":[{'
                         '"name":"x","script":"TEXT \\"type\\":\\"btkeyboard\\""}]}]}')
        sdpd = hub_sdpd()
        watch = start_watch()
        try:
            for line in ("cmd 0c24", "cmd 0c3a", "conn", "cmd 2008"):
                send(watch, line)
            time.sleep(1.5)
            check(sdpd.accepted == 0 and not sdpd.updates and not sdpd.removed,
                  "without a btkeyboard target the watch must not touch SDP "
                  "(%d connections)" % sdpd.accepted)
        finally:
            out = stop(watch)
            sdpd.close()
        check("idle: no btkeyboard target" in out, "idle log: " + out)

        # 2. A saved btkeyboard device: strip and hide at start.
        with open(store, "w") as handle:
            handle.write('{"version":1,"devices":[{"id":"bt_1_2","name":"Box",'
                         '"type":"btkeyboard","bdaddr":"AA:BB:CC:DD:EE:FF",'
                         '"harmony":true,"commands":[]}]}')
        sdpd = hub_sdpd()
        watch = start_watch()
        try:
            check(wait_for(lambda: clean_state(sdpd), 3),
                  "watch did not clean up at start: %r %r" %
                  (sorted(sdpd.records), sdpd.updates))
            check(sdpd.removed == [0x10001, 0x10002, 0x10003],
                  "removed: %r" % sdpd.removed)

            # 3. HAL registers its HID record again: nothing happens until
            # its class-of-device write, then the battery goes again.
            sdpd.records[0x10000] = hub_prefix
            connections = sdpd.accepted
            time.sleep(1.5)
            check(sdpd.records[0x10000] == hub_prefix and
                  sdpd.accepted == connections,
                  "the watch must not poll: it touched SDP with no event")
            send(watch, "cmd 0c24")
            check(wait_for(lambda: sdpd.records[0x10000] == HUB_RECORD, 2),
                  "0x0C24 did not trigger the strip")
            sdpd.records[0x10000] = hub_prefix
            send(watch, "cmd 0c3a")
            check(wait_for(lambda: sdpd.records[0x10000] == HUB_RECORD, 2),
                  "0x0C3A did not trigger the strip")
            sdpd.records[0x10000] = hub_prefix
            send(watch, "conn")
            check(wait_for(lambda: sdpd.records[0x10000] == HUB_RECORD, 2),
                  "a connection did not trigger the strip")

            # 4. bluetoothd restarts: its SDP socket closes, and once it runs
            # again (0x2008) the GATT records go once more. Without 0x2008
            # nothing polls for the new socket.
            sdpd.close()
            time.sleep(0.3)
            sdpd = hub_sdpd()
            sdpd.records[0x10000] = HUB_RECORD
            time.sleep(1.5)
            check(0x10001 in sdpd.records and sdpd.accepted == 0,
                  "the watch must wait for bluetoothd's own HCI activity")
            send(watch, "cmd 2008")
            check(wait_for(lambda: clean_state(sdpd), 3),
                  "0x2008 after a restart did not hide the records: %r" %
                  sorted(sdpd.records))
            # 0x2008 again on the same bluetoothd does nothing.
            connections = sdpd.accepted
            send(watch, "cmd 2008")
            time.sleep(1.0)
            check(sdpd.accepted == connections,
                  "a second 0x2008 on the same bluetoothd touched SDP again")
            check(not sdpd.errors, "sdpd errors: %r" % sdpd.errors)
        finally:
            out = stop(watch)
            sdpd.close()
        check("active: btkeyboard target" in out and
              "bluetoothd-sdp-closed" in out and
              out.count("battery-report-removed") == 4 and
              out.count("sdp-att record") == 6, "watch log: " + out)

        # 5. The target file alone also counts.
        os.unlink(store)
        with open(target, "w") as handle:
            handle.write("type=btkeyboard\nbdaddr=AA:BB:CC:DD:EE:FF\n")
        sdpd = hub_sdpd()
        watch = start_watch()
        try:
            check(wait_for(lambda: clean_state(sdpd), 3),
                  "bthid_target=btkeyboard did not activate the watch")
        finally:
            stop(watch)
            sdpd.close()

        def set_gate(store_text, target_text):
            for path, text_ in ((store, store_text), (target, target_text)):
                if os.path.exists(path):
                    os.unlink(path)
                if text_ is not None:
                    with open(path, "w") as handle:
                        handle.write(text_)

        # 6. Other profiles never open the gate.
        nexus = ('{"version":1,"devices":[{"id":"bt_1_2","name":"Nexus",'
                 '"type":"btkeyboard-nexus","bdaddr":"AA:BB:CC:DD:EE:FF",'
                 '"commands":[]}]}')
        for store_text, target_text in (
                (None, None),
                (nexus, None),
                (None, "type=ps3\nbdaddr=AA:BB:CC:DD:EE:FF\n"),
                (None, "type=btkeyboard-nexus\nbdaddr=AA:BB:CC:DD:EE:FF\n"),
                (None, "type=fire\nbdaddr=AA:BB:CC:DD:EE:FF\n")):
            set_gate(store_text, target_text)
            sdpd = hub_sdpd()
            watch = start_watch()
            try:
                for line in ("cmd 0c24", "cmd 0c3a", "conn", "cmd 2008"):
                    send(watch, line)
                time.sleep(0.8)
                check(sdpd.accepted == 0,
                      "gate opened for store=%r target=%r" %
                      (store_text, target_text))
            finally:
                stop(watch)
                sdpd.close()

        # 7. A btkeyboard target saved while the daemon runs: the next event
        # strips the HID record and hides this bluetoothd's GATT records,
        # with no 0x2008 and no bluetoothd restart.
        set_gate(None, None)
        sdpd = hub_sdpd()
        watch = start_watch()
        try:
            send(watch, "conn")
            time.sleep(0.5)
            check(sdpd.accepted == 0, "the watch touched SDP before a target")
            set_gate('{"version":1,"devices":[{"id":"bt_1_2","name":"Box",'
                     '"type":"btkeyboard","bdaddr":"AA:BB:CC:DD:EE:FF",'
                     '"commands":[]}]}', None)
            send(watch, "conn")
            check(wait_for(lambda: clean_state(sdpd), 3),
                  "a target saved mid-run did not hide the GATT records: %r" %
                  sorted(sdpd.records))
        finally:
            stop(watch)
            sdpd.close()
        set_gate(None, None)

        # 8. A broken or stuck sdpd: every check fails cleanly and quickly.
        asan = build_sanitized(cc, workdir, sock_path)
        agents = [exe] + ([asan] if asan else [])
        good = seq(hid_record(0x10001, KEYBOARD + BATTERY + SYSTEM))
        broken = [
            ("wrong transaction id",
             lambda pdu, tid, p: search_reply(tid ^ 1, good)),
            ("length beyond the buffer",
             lambda pdu, tid, p: struct.pack(">BHH", 7, tid, 0xffff) + b"\0" * 64),
            ("chunk past the PDU",
             lambda pdu, tid, p: struct.pack(">BHH", 7, tid, 5) + b"\xff\x00\x35\x00\x00"),
            ("continuation over 16 bytes",
             lambda pdu, tid, p: search_reply(tid, b"", b"\x11" + b"\0" * 17)),
            ("endless continuation",
             lambda pdu, tid, p: search_reply(tid, b"", b"\x02\x00\x00")),
            ("records over 8 KiB",
             lambda pdu, tid, p: search_reply(tid, b"\x00" * 8000, b"\x02\x00\x00")),
            ("error response",
             lambda pdu, tid, p: struct.pack(">BHHH", 1, tid, 2, 3)),
            ("empty error response",
             lambda pdu, tid, p: struct.pack(">BHH", 1, tid, 0)),
            ("wrong response PDU",
             lambda pdu, tid, p: struct.pack(">BHH", 0x05, tid, 3) + b"\0\0\0"),
            ("not a sequence",
             lambda pdu, tid, p: search_reply(tid, b"\x09\x00\x01")),
            ("record overruns the list",
             lambda pdu, tid, p: search_reply(tid, b"\x35\x05\x35\x10\x09\x00\x00")),
            ("record of the wrong type",
             lambda pdu, tid, p: search_reply(tid, b"\x35\x03\x09\x00\x00")),
            ("half an answer",
             lambda pdu, tid, p: search_reply(tid, good)[:9]),
            ("no answer", lambda pdu, tid, p: None),
        ]
        for name, reply in broken:
            for agent in agents:
                for mode in ("--sdp-hid-check", "--sdp-att-check"):
                    server = ScriptedSdpd(sock_path, reply)
                    try:
                        started = time.time()
                        p = subprocess.run(agent + ["btkeyboard", "10", mode],
                                           capture_output=True, timeout=15)
                        took = time.time() - started
                    finally:
                        server.close()
                    check(p.returncode == 1 and took < 5,
                          "%s %s: rc=%d in %.1fs %r" % (name, mode,
                          p.returncode, took, p.stderr[-300:]))

        # A stuck sdpd does not wedge the daemon: it stays alive, answers
        # events, and stops on SIGTERM.
        set_gate('{"version":1,"devices":[{"id":"bt_1_2","name":"Box",'
                 '"type":"btkeyboard","bdaddr":"AA:BB:CC:DD:EE:FF",'
                 '"commands":[]}]}', None)
        server = ScriptedSdpd(sock_path, lambda pdu, tid, p: None)
        watch = start_watch()
        try:
            for line in ("conn", "cmd 0c24", "cmd 2008", "conn"):
                send(watch, line)
            time.sleep(2.0)
            check(watch.poll() is None, "the watch exited on a stuck sdpd")
            started = time.time()
            out = stop(watch)
            check(time.time() - started < 3 and watch.returncode == 0,
                  "the watch did not stop promptly: rc=%r" % watch.returncode)
            check("check failed" in out, "stuck sdpd not logged: " + out)
        finally:
            if watch.poll() is None:
                watch.kill()
            server.close()
        set_gate(None, None)

        # 9. Seeded fuzz: mutated records through the offline filter, and
        # through both checks over the socket.  Nothing may crash (the
        # sanitizer build, when the compiler has one, also catches overruns),
        # and a well-formed record must come out well-formed.
        rng = random.Random(264)
        fuzz_agent = asan or exe
        seeds = [hid_record(0x10001, full), HUB_RECORD, hub_prefix,
                 hid_record(0x10002, big, desc_size_index=6),
                 hid_record(0x10003, KEYBOARD + CONSUMER + BATTERY + SYSTEM_NO_SIZE)]
        for i in range(300):
            record = mutate(rng, rng.choice(seeds))
            p = subprocess.run(fuzz_agent + ["btkeyboard", "10", "--sdp-hid-filter"],
                               input=record.hex().encode(), capture_output=True,
                               timeout=20)
            check(p.returncode in (0, 1),
                  "filter crashed (rc=%d) on %s: %r" %
                  (p.returncode, record.hex(), p.stderr[-600:]))
            lines = p.stdout.decode().strip().splitlines()
            if lines and lines[0].startswith("removed"):
                try:
                    decode(record)
                    well_formed = True
                except (AssertionError, IndexError, KeyError):
                    well_formed = False
                if well_formed:
                    try:
                        decode(bytes.fromhex(lines[1].replace(" ", "")))
                    except (AssertionError, IndexError, KeyError):
                        check(False, "strip broke a well-formed record: " +
                              record.hex())

        att_seeds = [gatt, vendor, gap, battery_svc, other_psm, hub_prefix]
        sdpd = FakeSdpd(sock_path, {}, chunk=40)
        try:
            for i in range(150):
                records = {0x10000 + n: mutate(rng, rec) if rng.random() < 0.7
                           else rec for n, rec in enumerate(att_seeds)}
                sdpd.records = records
                sdpd.search = {0x1124: sorted(records), 0x0007: sorted(records)}
                for mode in ("--sdp-att-check", "--sdp-hid-check"):
                    p = subprocess.run(fuzz_agent + ["btkeyboard", "10", mode],
                                       capture_output=True, timeout=20)
                    check(p.returncode in (0, 1),
                          "%s crashed (rc=%d): %r" % (mode, p.returncode,
                                                      p.stderr[-600:]))
            check(not sdpd.updates and not sdpd.removed,
                  "a check mode changed the database")
        finally:
            sdpd.close()
        if not asan:
            print("note: no sanitizer build here; fuzz ran on the plain build")

        # No SDP server at all: a clear error, not a hang.
        p = subprocess.run(exe + ["btkeyboard", "10", "--sdp-hid-check"],
                           capture_output=True, timeout=10)
        check(p.returncode == 1 and b"connect" in p.stderr,
              "missing socket: %r" % p.stderr)

    print("PASS SDP HID battery strip, GATT record hide and event-driven watch")


if __name__ == "__main__":
    main()
