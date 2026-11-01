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
                    "-o", exe, SOURCE], check=True)
    return RUNNER + [exe]


def run_filter(exe, record, policy=None):
    p = subprocess.run(exe + ["btkeyboard", "10", "--sdp-hid-filter"] +
                       ([policy] if policy else []),
                       input=record.hex(":").encode(), capture_output=True,
                       check=True)
    lines = p.stdout.decode().strip().splitlines()
    patched = bytes.fromhex(lines[1].replace(" ", "")) if len(lines) > 1 else None
    return lines[0], patched


class FakeSdpd:
    """Enough of BlueZ 4 sdpd: search-attr with continuation, update."""

    def __init__(self, path, records, chunk=48, search=None):
        self.path = path
        self.records = dict(records)  # handle -> record bytes
        # uuid16 -> handles a search returns; by default every record is HID
        self.search = search or {0x1124: sorted(self.records)}
        self.removed = []
        self.conns = []
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
        self.server.close()
        for conn in self.conns:
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        if os.path.exists(self.path):
            os.unlink(self.path)


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

        # Keyboard-only diagnostic: keyboard, consumer and system control stay.
        hub_kbd = encode(replace_descriptor(
            hub_tree, HUB_KEYBOARD + HUB_CONSUMER + HUB_SYSTEM))
        status, patched = run_filter(exe, HUB_RECORD, "keyboard-only")
        check(status == "removed handle=0x00010000 report=0x02,0xad,0xff,0x10"
              " bytes=176", "keyboard-only status: " + status)
        check(decode(patched) == decode(hub_kbd), "keyboard-only record differs")
        status, patched = run_filter(exe, hub_prefix, "keyboard-only")
        check(status.startswith("removed handle=0x00010000 "
                                "report=0x02,0xac,0xad,0xff,0x10 "),
              "keyboard-only from pre-fix: " + status)
        check(decode(patched) == decode(hub_kbd),
              "keyboard-only from pre-fix differs")
        status, _ = run_filter(exe, patched, "keyboard-only")
        check(status == "clean", "keyboard-only second pass: " + status)
        # A keyboard collection is never removed, even with nothing else left.
        status, _ = run_filter(exe, hid_record(0x10008, HUB_FF + HUB_AD),
                               "keyboard-only")
        check(status == "clean", "no keyboard collection: " + status)

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
            check("report=0x02 battery-policy=keep keyboard-only=remove" in out
                  and "report=0xac battery-policy=remove" in out
                  and "report=0x01 battery-policy=keep keyboard-only=keep" in out,
                  "check mode collection table: " + out)
            p = subprocess.run(exe + ["fire", "10", "--sdp-hid-keyboard-only"],
                               capture_output=True)
            check(p.returncode == 2 and not sdpd.updates,
                  "keyboard-only must refuse other profiles")
            out = subprocess.run(
                exe + ["btkeyboard", "10", "--sdp-hid-keyboard-only"],
                capture_output=True, check=True).stdout.decode()
            check("collections-removed handle=0x00010000 "
                  "report=0x02,0xac,0xad,0xff,0x10" in out and
                  "records-trimmed-to-keyboard=1" in out,
                  "keyboard-only mode output: " + out)
            check(decode(sdpd.records[0x10000]) == decode(hub_kbd),
                  "sdpd holds an unexpected keyboard-only record")
            check(not sdpd.errors, "sdpd errors: %r" % sdpd.errors)
        finally:
            sdpd.close()

        # GATT over BR/EDR, as the hub answers an ATT (0x0007) search: its
        # HID record (no ATT element) plus two GATT service records.
        gatt = gatt_record(0x10001, 0x1801, 0x0010, 0x0010,
                           "Generic Attribute Profile")
        vendor = gatt_record(0x10002, "830a55485c6623bd0949c0040000227e",
                             0xFFF4, 0xFFFE, "Harmony")
        sdpd = FakeSdpd(sock_path,
                        {0x10000: HUB_RECORD, 0x10001: gatt, 0x10002: vendor},
                        search={0x1124: [0x10000],
                                0x0007: [0x10000, 0x10001, 0x10002]})
        try:
            out = subprocess.run(exe + ["btkeyboard", "10", "--sdp-att-check"],
                                 capture_output=True, check=True).stdout.decode()
            check("handle=0x00010000 service=1124 att=none keep" in out and
                  "handle=0x00010001 service=1801 att=0x0010-0x0010 "
                  "would-remove" in out and
                  "handle=0x00010002 service=830a55485c6623bd0949c0040000227e "
                  "att=0xfff4-0xfffe would-remove" in out and
                  "records=3 gatt-records=2" in out,
                  "att check output: " + out)
            check(not sdpd.removed, "att check must not remove")
            p = subprocess.run(exe + ["fire", "10", "--sdp-att-hide"],
                               capture_output=True)
            check(p.returncode == 2 and not sdpd.removed,
                  "att hide must refuse other profiles")
            out = subprocess.run(exe + ["btkeyboard", "10", "--sdp-att-hide"],
                                 capture_output=True, check=True).stdout.decode()
            check(sdpd.removed == [0x10001, 0x10002] and
                  "att=0x0010-0x0010 removed" in out,
                  "att hide: %r %s" % (sdpd.removed, out))
            check(set(sdpd.records) == {0x10000},
                  "HID record must survive att hide")
            out = subprocess.run(exe + ["btkeyboard", "10", "--sdp-att-hide"],
                                 capture_output=True, check=True).stdout.decode()
            check("records=1 gatt-records=0" in out and
                  sdpd.removed == [0x10001, 0x10002],
                  "second att hide must be a no-op: " + out)
            check(not sdpd.errors, "sdpd errors: %r" % sdpd.errors)
        finally:
            sdpd.close()

        # The daemon's watch: it strips the battery collection and hides the
        # GATT records at start, and again right after bluetoothd restarts
        # and registers them again.
        def hub_sdpd():
            return FakeSdpd(sock_path,
                            {0x10000: hub_prefix, 0x10001: gatt,
                             0x10002: vendor},
                            search={0x1124: [0x10000],
                                    0x0007: [0x10000, 0x10001, 0x10002]})

        def wait_for(condition, seconds):
            deadline = time.time() + seconds
            while time.time() < deadline:
                if condition():
                    return True
                time.sleep(0.05)
            return False

        sdpd = hub_sdpd()
        watch = subprocess.Popen(exe + ["btkeyboard", "12", "--sdp-watch-test"],
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        try:
            check(wait_for(lambda: set(sdpd.records) == {0x10000} and
                           sdpd.updates == [0x10000], 3),
                  "watch did not clean up at start: %r %r" %
                  (sorted(sdpd.records), sdpd.updates))
            check(sdpd.records[0x10000] == HUB_RECORD,
                  "watch left an unexpected HID record")
            sdpd.close()
            time.sleep(0.3)
            sdpd = hub_sdpd()
            check(wait_for(lambda: set(sdpd.records) == {0x10000} and
                           sdpd.updates == [0x10000], 3),
                  "watch did not clean up after a restart: %r %r" %
                  (sorted(sdpd.records), sdpd.updates))
            check(not sdpd.errors, "sdpd errors: %r" % sdpd.errors)
        finally:
            watch.terminate()
            out = watch.communicate(timeout=10)[0].decode()
            sdpd.close()
        check("bluetoothd-sdp-closed" in out and
              "state=hid=patched att=hidden" in out and
              out.count("sdp-att record") == 4, "watch log: " + out)

        sdpd = FakeSdpd(sock_path, {0x10000: hub_prefix, 0x10001: gatt},
                        search={0x1124: [0x10000],
                                0x0007: [0x10000, 0x10001]})
        try:
            out = subprocess.run(exe + ["fire", "3", "--sdp-watch-test"],
                                 capture_output=True, check=True).stdout.decode()
            check("state=skip profile=fire" in out and not sdpd.updates and
                  not sdpd.removed, "watch must skip other profiles: " + out)
        finally:
            sdpd.close()

        # No SDP server at all: a clear error, not a hang.
        p = subprocess.run(exe + ["btkeyboard", "10", "--sdp-hid-check"],
                           capture_output=True, timeout=10)
        check(p.returncode == 1 and b"connect" in p.stderr,
              "missing socket: %r" % p.stderr)

    print("PASS SDP HID battery strip, keyboard-only trim and ATT record hide")


if __name__ == "__main__":
    main()
