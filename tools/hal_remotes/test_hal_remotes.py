#!/usr/bin/env python3
"""Off-hub tests of the hal_remotes patch (docs/TWO_SCREEN_REMOTES.md).

The patch is applied to a stock hal 4.15.600 and hal's own HOT code is run
under Unicorn (emu.py) against stock copies of hal in the remote's role.

    HAL_STOCK=/path/to/stock/hal  python3 tools/hal_remotes/test_hal_remotes.py

Logitech's hal is not in this repository; without HAL_STOCK (md5 a3fdd823...)
the emulation tests are skipped and only the patch file itself is checked.
Needs: unicorn, pyelftools.
"""
from __future__ import annotations

import hashlib
import json
import os
import struct
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PATCH_FILE = ROOT / "payload" / "helpers" / "hal_remotes_patch.json"
MULTI_PATCH_FILE = ROOT / "payload" / "helpers" / "hal_multiremote_patch.json"
PATCH = json.loads(PATCH_FILE.read_text(encoding="utf-8"))

sys.path.insert(0, str(HERE))

STOCK: bytes | None = None
_stock_path = os.environ.get("HAL_STOCK")
if _stock_path and Path(_stock_path).is_file():
    _data = Path(_stock_path).read_bytes()
    if hashlib.md5(_data).hexdigest() == PATCH["stock_md5"]:
        STOCK = _data
try:
    import emu
except ImportError:  # unicorn or pyelftools missing
    emu = None

SCREEN, SMART = 0x4021, 0x401E


def apply_patch(stock: bytes) -> bytes:
    out = bytearray(stock)
    for e in PATCH["edits"]:
        offset, new = int(e["offset"], 16), bytes.fromhex(e["patched"])
        if "stock" in e:
            assert bytes(out[offset : offset + len(new)]) == bytes.fromhex(e["stock"]), e["offset"]
        out[offset : offset + len(new)] = new
    return bytes(out)


PATCHED = apply_patch(STOCK) if STOCK else None


def word(image: bytes, offset: int) -> int:
    return struct.unpack(">I", image[offset : offset + 4])[0]


def jump_target(image: bytes, offset: int) -> int:
    w = word(image, offset)
    assert w >> 26 in (2, 3), hex(w)
    return (w & 0x03FFFFFF) << 2


def _reply(hub, results):
    rc = yield ("call", emu.HOT_SEND_DATA, 0x389, emu.iov(hub, b"answer"), 1)
    results.append(rc)


class Rig:
    """One hub and its screen remotes, each with a handler thread that answers
    what it is sent. hub.seen / remote.seen are what the handlers received."""

    def __init__(self, image: bytes, gates: str | None, slots=(2,), seed: int | None = None, latency_ms: float = 2,
                 work_ms: float = 0, think_ms: float = 0):
        self.world = w = emu.World(seed, latency_ms)
        w.pairs = [(SMART, 1)] + [(SCREEN, s) for s in slots]
        self.hub = hub = emu.Hal(w, image, "hub", "hub", gates=gates)
        if word(image, 0x28A38) != 0x8F9982A0:  # patched: the handler's wait goes through the hook
            hub.handler_wait = jump_target(image, 0x28A38)
        self.remotes = {s: emu.Hal(w, STOCK, f"remote{s}", "remote", slot=s) for s in slots}
        hub.start()
        hub.seen = []
        hub.spawn("handler", gen=emu.handler(hub, self._hub_request, work_ms, think_ms))
        for r in self.remotes.values():
            r.start()
            r.seen = []
            r.spawn("handler", gen=emu.handler(r, lambda slot, typ, p, r=r: self._remote_request(r, typ, p)))
        self.results: list = []
        w.run()

    def _hub_request(self, slot: int, typ: int, payload: bytes):
        self.hub.seen.append((slot, typ & 0xFF, payload))
        return b"re:%d:" % slot + payload[:24]

    def _remote_request(self, r, typ: int, payload: bytes):
        r.seen.append((typ & 0xFF, payload))
        return None if typ & 0xFF == 10 else b"ok:%d:" % r.slot + payload[:16]

    # what people and the engine do

    def press(self, slot: int, payload: bytes, tag=None, timeout_ms: int = 5000):
        """A remote sends the hub a request and waits for the answer."""
        r = self.remotes[slot]
        return r.spawn("app", gen=emu.request(r, 9, payload, timeout_ms, self.results, (slot, payload[:8]) if tag is None else tag))

    def notify(self, payload: bytes, tag=None):
        return self.hub.spawn("notify", gen=emu.notify(self.hub, payload, self.results, tag or ("notify", payload[:8])))

    def command(self, payload: bytes, tag=None, typ: int = 9, timeout_ms: int = 5000):
        """The hub sends a remote a request (hot.1.<cmd>) and waits for the answer."""
        return self.hub.spawn("cmd", gen=emu.request(self.hub, typ, payload, timeout_ms, self.results, tag or ("cmd", payload[:8])))

    def sleep(self, slot: int) -> None:
        self.remotes[slot].awake = False
        self.hub.link_loss(slot)

    def wake(self, slot: int) -> None:
        self.remotes[slot].awake = True

    def run(self, ms: float | None = None) -> str:
        return self.world.run(until_ms=ms)

    def trace(self):
        """Everything observable from outside the hub's hal."""
        return {
            "hub_tx": self.hub.tx,
            "remote_tx": {s: r.tx for s, r in self.remotes.items()},
            "hub_seen": self.hub.seen,
            "remote_seen": {s: r.seen for s, r in self.remotes.items()},
            "results": self.results,
            "stats": self.hub.stat(),
            "clock": self.world.now,
        }


def big(tag: bytes, n: int) -> bytes:
    return (tag * (n // len(tag) + 1))[:n]


def everyday(rig: Rig, slot: int) -> None:
    """One remote's ordinary traffic in both directions, with a lost frame each
    way, a sleep, a notify nobody is awake for, and a wake."""
    lost = {"hub": 0, "remote": 0}

    def air(src, dst, frame):
        side = "hub" if src is rig.hub else "remote"
        lost[side] += 1
        return lost[side] not in ((7, 31) if side == "hub" else (5, 40))

    rig.world.air_filter = air
    rig.press(slot, b"key-press-1")
    rig.run()
    rig.press(slot, big(b"sync-resource-", 3000))
    rig.run()
    for i in range(3):
        rig.notify(big(b"state-digest-%d-" % i, 700))
        rig.run()
    rig.command(b"hot.1.sys.info")
    rig.run()
    rig.press(slot, b"key-press-2")
    rig.notify(b"crossing-notify")
    rig.run()
    rig.sleep(slot)
    rig.run()
    rig.notify(b"nobody-awake")
    rig.run()
    rig.wake(slot)
    rig.press(slot, b"key-after-wake")
    rig.run()
    rig.notify(big(b"after-wake-", 400))
    rig.run()


@unittest.skipUnless(STOCK and emu, "needs HAL_STOCK (stock hal 4.15.600), unicorn and pyelftools")
class SingleRemoteIsStock(unittest.TestCase):
    """With one screen remote the patched hal must put the same frames on the
    air at the same times as stock, whatever the gates say."""

    @classmethod
    def setUpClass(cls):
        rig = Rig(STOCK, None)
        everyday(rig, 2)
        cls.stock = rig.trace()

    def test_the_script_exercises_the_protocol(self):
        t = self.stock
        self.assertEqual([r[1] for r in t["results"] if r[0][0] == 2], [0, 0, 0, 0])  # every press answered
        self.assertEqual(len([s for s in t["remote_seen"][2] if s[0] == 10]), 5)  # notifies that arrived
        self.assertGreater(len(t["hub_tx"]), 60)
        self.assertGreater(t["stats"]["TIMEOUT"] + t["stats"]["MSG SEQ ERROR"], 0)  # the lost frames cost something
        self.assertEqual(t["stats"]["LINK LOSS"], 1)

    def check(self, gates):
        rig = Rig(PATCHED, gates)
        everyday(rig, 2)
        got = rig.trace()
        for key in self.stock:
            self.assertEqual(got[key], self.stock[key], f"gates={gates!r}: {key} differs from stock")

    def test_no_gates_file(self):
        self.check(None)

    def test_gates_off(self):
        self.check("000")

    def test_multi_remote_gate_only(self):
        self.check("010")

    def test_two_screen_gate(self):
        self.check("100")

    def test_both_gates(self):
        self.check("110")

    def test_two_screen_serial(self):
        self.check("101")

    def test_garbage_gates_file_is_off(self):
        self.check("1")  # too short: not three characters


@unittest.skipUnless(STOCK and emu, "needs HAL_STOCK (stock hal 4.15.600), unicorn and pyelftools")
class GateOffIsStockWithTwoRemotes(unittest.TestCase):
    def test_two_remotes_gate_off(self):
        """Gate off must not help either: the singleton's behaviour, frame for frame."""
        traces = []
        for image, gates in ((STOCK, None), (PATCHED, None), (PATCHED, "010")):
            rig = Rig(image, gates, slots=(2, 3))
            rig.press(2, big(b"from-two-", 600))
            rig.press(3, big(b"from-three-", 600))
            rig.run(20000)
            rig.notify(b"n1")
            rig.run(20000)
            traces.append(rig.trace())
        self.assertEqual(traces[1], traces[0])
        self.assertEqual(traces[2], traces[0])


@unittest.skipUnless(STOCK and emu, "needs HAL_STOCK (stock hal 4.15.600), unicorn and pyelftools")
class TwoScreenRemotes(unittest.TestCase):
    def both(self, image, gates):
        rig = Rig(image, gates, slots=(2, 3))
        start = rig.world.now
        rig.press(2, big(b"touch-sync-", 4000), tag="a")
        rig.press(3, big(b"elite-sync-", 4000), tag="b")
        rig.run(30000)
        return rig, (rig.world.now - start) / emu.MS

    def test_stock_cannot_do_it(self):
        """The baseline this sprint exists for: on stock, two remotes sending at
        once do not both get through cleanly."""
        rig, _ = self.both(STOCK, None)
        ok = [r for r in rig.results if r[1] == 0 and r[2] is not None]
        clean = (
            len(ok) == 2
            and sorted(s for s, _, _ in rig.hub.seen) == [2, 3]
            and rig.hub.stat()["MSG SEQ ERROR"] == 0
            and rig.hub.stat()["TIMEOUT"] == 0
        )
        self.assertFalse(clean)

    def test_both_at_once(self):
        rig, _ = self.both(PATCHED, "100")
        results = {r[0]: r for r in rig.results}
        self.assertEqual(results["a"][1], 0)
        self.assertEqual(results["b"][1], 0)
        self.assertEqual(results["a"][2], b"re:2:" + big(b"touch-sync-", 24))
        self.assertEqual(results["b"][2], b"re:3:" + big(b"elite-sync-", 24))
        self.assertEqual(sorted(rig.hub.seen), [(2, 9, big(b"touch-sync-", 4000)), (3, 9, big(b"elite-sync-", 4000))])
        stats = rig.hub.hot_stats()
        for name in ("MSG SEQ ERROR", "PKT SEQ ERROR", "CRC ERROR", "TIMEOUT", "RX BAD PACKETS", "IO ERROR"):
            self.assertEqual(stats[name], 0, name)
        # no 2-second resend anywhere: both finished in the time the frames take
        finished = max(r[3] for r in rig.results) - min(t for t, _ in rig.hub.tx)
        self.assertLess(finished / emu.MS, 1000)

    def test_frames_really_interleave(self):
        rig, _ = self.both(PATCHED, "100")
        order = [f[1] for _, f in rig.hub.tx]  # slot each hub frame went to
        switches = sum(1 for a, b in zip(order, order[1:]) if a != b)
        self.assertGreater(switches, 10)

    def test_alternating_keys(self):
        rig = Rig(PATCHED, "100", slots=(2, 3))
        for i in range(12):
            slot = 2 + i % 2
            rig.press(slot, b"key-%d" % i, tag=i)
            rig.run(300)
        self.assertEqual([(r[0], r[1]) for r in rig.results], [(i, 0) for i in range(12)])
        self.assertEqual([s for s, _, _ in rig.hub.seen], [2 + i % 2 for i in range(12)])
        self.assertEqual([r[2] for r in rig.results], [b"re:%d:key-%d" % (2 + i % 2, i) for i in range(12)])
        self.assertEqual(rig.hub.hot_stats()["TIMEOUT"], 0)

    def test_notify_reaches_both(self):
        rig = Rig(PATCHED, "100", slots=(2, 3))
        rig.press(2, b"wake-2")
        rig.press(3, b"wake-3")
        rig.run()
        for i in range(4):
            rig.notify(big(b"digest-%d-" % i, 500), tag=("n", i))
            rig.run()
        want = [(10, big(b"digest-%d-" % i, 500)) for i in range(4)]
        self.assertEqual(rig.remotes[2].seen, want)
        self.assertEqual(rig.remotes[3].seen, want)
        self.assertEqual([r[1] for r in rig.results if r[0][0] == "n"], [0, 0, 0, 0])

    def test_sleeping_remote_does_not_starve_the_other(self):
        rig = Rig(PATCHED, "100", slots=(2, 3))
        rig.press(2, b"wake-2")
        rig.press(3, b"wake-3")
        rig.run()
        rig.sleep(3)
        rig.run()
        for i in range(5):
            start = rig.world.now
            rig.notify(b"while-3-sleeps-%d" % i, tag=("n", i))
            rig.run()
            self.assertLess((rig.results[-1][2] - start) / emu.MS, 100)  # not a 5 s send timeout
        self.assertEqual(len(rig.remotes[2].seen), 5)
        self.assertEqual(rig.remotes[3].seen, [])
        self.assertEqual(rig.hub.hot_stats()["TIMEOUT"], 0)
        # and it is back as soon as it speaks
        rig.wake(3)
        rig.press(3, b"awake-again")
        rig.run()
        rig.notify(b"both-again")
        rig.run()
        self.assertEqual(rig.remotes[3].seen, [(10, b"both-again")])
        self.assertEqual(rig.remotes[2].seen[-1], (10, b"both-again"))

    def test_remote_that_vanishes_without_a_link_loss(self):
        """Out of range, no report from the radio: its notify times out once,
        then it sits out until it is heard again; the other keeps its notifies."""
        rig = Rig(PATCHED, "100", slots=(2, 3))
        rig.press(2, b"wake-2")
        rig.press(3, b"wake-3")
        rig.run()
        rig.remotes[3].awake = False
        start = rig.world.now
        rig.notify(b"first")
        rig.run()
        self.assertGreater((rig.results[-1][2] - start) / emu.MS, 4500)  # the one send timeout
        for i in range(3):
            start = rig.world.now
            rig.notify(b"later-%d" % i)
            rig.run()
            self.assertLess((rig.results[-1][2] - start) / emu.MS, 100)
        self.assertEqual([p for _, p in rig.remotes[2].seen], [b"first", b"later-0", b"later-1", b"later-2"])

    def test_link_loss_of_one_does_not_abort_the_other(self):
        rig = Rig(PATCHED, "100", slots=(2, 3))
        rig.press(3, b"wake-3")
        rig.run()
        rig.press(2, big(b"long-object-", 6000), tag="long")
        rig.run(20)  # mid-object
        self.assertEqual(rig.results[1:], [])
        rig.sleep(3)
        rig.run()
        self.assertEqual([(r[0], r[1]) for r in rig.results[1:]], [("long", 0)])
        self.assertEqual(rig.hub.hot_stats()["TIMEOUT"], 0)

    def test_hub_command_goes_to_the_remote_that_asked_last(self):
        rig = Rig(PATCHED, "100", slots=(2, 3))
        rig.press(2, b"wake-2")
        rig.run()
        rig.press(3, b"wake-3")
        rig.run()
        rig.command(b"led-for-3", tag="c1")
        rig.run()
        rig.press(2, b"press-2")
        rig.run()
        rig.command(b"led-for-2", tag="c2")
        rig.run()
        results = {r[0]: r for r in rig.results}
        self.assertEqual(results["c1"][1:3], (0, b"ok:3:led-for-3"))
        self.assertEqual(results["c2"][1:3], (0, b"ok:2:led-for-2"))
        # the asker asleep: the command goes to the one that is linked
        rig.sleep(2)
        rig.run()
        rig.command(b"led-fallback", tag="c3")
        rig.run()
        self.assertEqual({r[0]: r for r in rig.results}["c3"][1:3], (0, b"ok:3:led-fallback"))

    def test_command_to_a_sleeping_only_remote_fails_as_stock(self):
        outcomes = []
        for image, gates in ((STOCK, None), (PATCHED, "100")):
            rig = Rig(image, gates, slots=(2,))
            rig.press(2, b"wake")
            rig.run()
            rig.sleep(2)
            rig.run()
            rig.command(b"nobody-home", tag="c")
            rig.run()
            outcomes.append((rig.results[-1][:3], rig.hub.tx, rig.world.now))
        self.assertEqual(outcomes[1], outcomes[0])
        self.assertLess(outcomes[0][0][1], 0)

    def test_serial_mode_one_object_at_a_time(self):
        rig = Rig(PATCHED, "101", slots=(2, 3))
        rig.press(2, big(b"touch-sync-", 4000), tag="a")
        rig.press(3, big(b"elite-sync-", 4000), tag="b")
        rig.run(30000)
        results = {r[0]: r for r in rig.results}
        self.assertEqual((results["a"][1], results["b"][1]), (0, 0))
        self.assertEqual(sorted(rig.hub.seen), [(2, 9, big(b"touch-sync-", 4000)), (3, 9, big(b"elite-sync-", 4000))])
        stats = rig.hub.hot_stats()
        self.assertEqual(stats["TS MODE"], 2)
        self.assertGreater(stats["TS DROPS"], 0)
        # the loser waited for its own 2-second resend
        self.assertGreater((max(r[3] for r in rig.results) - min(r[3] for r in rig.results)) / emu.MS, 1500)

    def test_hot_stats(self):
        rig = Rig(PATCHED, "100", slots=(2, 3))
        rig.press(2, b"a")
        rig.press(3, b"b")
        rig.run()
        rig.press(3, b"c")
        rig.run()
        stats = rig.hub.hot_stats()
        self.assertEqual(stats["RX OBJECTS"], 3)
        self.assertEqual(stats["TX OBJECTS"], 3)
        self.assertEqual((stats["S2 RX OBJECTS"], stats["S3 RX OBJECTS"]), (1, 2))
        self.assertEqual((stats["S2 LINK"], stats["S3 LINK"]), (1, 1))
        self.assertEqual((stats["TS MODE"], stats["TS SLOTS"], stats["TS CONTEXTS"]), (1, 0b1100, 2))
        self.assertEqual(len([k for k in stats if not k.startswith(("TS ", "S2 ", "S3 "))]), 17)
        # gate off: exactly stock's 17
        off = Rig(PATCHED, "000", slots=(2,))
        self.assertEqual(off.hub.hot_stats(), Rig(STOCK, None, slots=(2,)).hub.hot_stats())

    def test_requests_wait_for_a_busy_handler(self):
        """Stock replaces a request the handler thread has not taken yet. With
        the handler slow (holding the request, then sending its reply), three
        remotes' requests must all be handled, in the order they arrived."""
        for work_ms, think_ms in ((0, 30), (30, 0), (20, 20)):
            with self.subTest(work_ms=work_ms, think_ms=think_ms):
                rig = Rig(PATCHED, "100", slots=(2, 3, 5), work_ms=work_ms, think_ms=think_ms)
                for round_ in range(3):
                    for s in (2, 3, 5):
                        rig.press(s, b"r%d-s%d" % (round_, s), tag=(round_, s))
                    rig.run(15)
                rig.run()
                self.assertEqual(sorted((r[0], r[1]) for r in rig.results), [((r, s), 0) for r in range(3) for s in (2, 3, 5)])
                self.assertEqual(len(rig.hub.seen), 9)
                for s in (2, 3, 5):
                    self.assertEqual([p for slot, _, p in rig.hub.seen if slot == s], [b"r%d-s%d" % (r, s) for r in range(3)])
                self.assertEqual(rig.hub.hot_stats()["TIMEOUT"], 0)

    def test_three_screen_remotes(self):
        rig = Rig(PATCHED, "100", slots=(2, 3, 5))
        for s in (2, 3, 5):
            rig.press(s, big(b"slot-%d-" % s, 1500), tag=s)
        rig.run(30000)
        self.assertEqual(sorted((r[0], r[1]) for r in rig.results), [(2, 0), (3, 0), (5, 0)])
        rig.notify(b"to-all-three")
        rig.run()
        for s in (2, 3, 5):
            self.assertEqual(rig.remotes[s].seen, [(10, b"to-all-three")])


@unittest.skipUnless(STOCK and emu, "needs HAL_STOCK (stock hal 4.15.600), unicorn and pyelftools")
class Soak(unittest.TestCase):
    """Random traffic, random thread interleaving, and optionally a lossy air.

    Lost frames cost stock something too (resends, the odd request that times
    out, now and then a CRC error), so the lossy runs are judged against stock
    with one remote on the same seeds, not against zero.
    """

    def soak(self, image, gates, slots, seed: int, loss: float):
        rig = Rig(image, gates, slots=slots, seed=seed)
        rng = rig.world.rng
        rig.world.air_filter = lambda src, dst, frame: rng.random() >= loss
        sent = {s: [] for s in slots}
        for i in range(40):
            what = rng.random()
            if what < 0.6:
                slot = rng.choice(slots)
                payload = b"%d-%d-" % (slot, i) + big(b"x", rng.choice((1, 20, 200, 1500)))
                sent[slot].append(payload)
                rig.press(slot, payload, tag=("press", slot, payload))
            elif what < 0.85:
                rig.notify(b"n-%d-" % i + big(b"y", rng.choice((10, 600))), tag=("notify", i))
            else:
                rig.command(b"c-%d" % i, tag=("cmd", i))
            rig.run(rng.choice((0, 5, 40, 300, 2500)))
        self.assertEqual(rig.run(120000), "idle")  # nothing is stuck resending
        self.assertEqual(len(rig.results), 40)  # every caller got an answer or an error

        # Whatever succeeded is right: the hub saw each answered request once,
        # from the remote that sent it, and nothing it saw was invented.
        delivered = {s: [p for slot, _, p in rig.hub.seen if slot == s] for s in slots}
        failed = 0
        for r in rig.results:
            tag, rc = r[0], r[1]
            failed += rc != 0
            if tag[0] == "press" and rc == 0:
                _, slot, payload = tag
                self.assertEqual(r[2], b"re:%d:" % slot + payload[:24])
                self.assertEqual(delivered[slot].count(payload), 1)
            elif tag[0] == "cmd" and rc == 0:
                self.assertIn(r[2], [b"ok:%d:c-%d" % (s, tag[1]) for s in slots])
        for s in slots:
            self.assertTrue(set(delivered[s]) <= set(sent[s]))
        stats = rig.hub.stat() if image is STOCK else rig.hub.hot_stats()
        self.assertEqual(stats["RX BAD PACKETS"], 0)
        return failed, stats

    def test_clean_air(self):
        for seed in range(1, 9):
            with self.subTest(seed=seed):
                failed, stats = self.soak(PATCHED, "100", (2, 3), seed, 0.0)
                self.assertEqual(failed, 0)
                for name in ("TIMEOUT", "PKT SEQ ERROR", "CRC ERROR", "IO ERROR"):
                    self.assertEqual(stats[name], 0, name)

    def lossy(self, gates, seeds, loss):
        ours = [self.soak(PATCHED, gates, (2, 3), seed, loss) for seed in seeds]
        stock = [self.soak(STOCK, None, (2,), seed, loss) for seed in seeds]

        def rate(runs, name):
            return sum(st[name] for _, st in runs) / sum(st["RX OBJECTS"] + st["TX OBJECTS"] for _, st in runs)

        return ours, stock, rate

    def test_lossy_air_is_no_worse_than_stock_with_one_remote(self):
        ours, stock, rate = self.lossy("100", range(11, 19), 0.05)
        self.assertLessEqual(sum(f for f, _ in ours), 2 * sum(f for f, _ in stock) + 4)
        for name in ("MSG SEQ ERROR", "PKT SEQ ERROR", "TIMEOUT", "CRC ERROR"):
            self.assertLessEqual(rate(ours, name), 2 * rate(stock, name) + 0.02, name)

    def test_serial_mode_lossy_air(self):
        ours, stock, _ = self.lossy("101", range(21, 25), 0.03)
        self.assertLessEqual(sum(f for f, _ in ours), 3 * sum(f for f, _ in stock) + 6)


@unittest.skipUnless(STOCK and emu, "needs HAL_STOCK (stock hal 4.15.600), unicorn and pyelftools")
class PairingPolicy(unittest.TestCase):
    """rf_eliminate_multiple_device's hook: 0 keep both, 1 unpair the older one
    now, 2 stock's screen-remote path."""

    def policy(self, gates, model):
        w = emu.World()
        hub = emu.Hal(w, PATCHED, "hub", "hub", gates=gates)
        t = hub.spawn("elim", jump_target(PATCHED, 0x27CDC))
        t.regs[emu.A2], t.regs[emu.V0], t.regs[3], t.regs[emu.A0] = model, 0x1111, model, 0x33
        w.run(done=lambda: t.state == "done")
        self.assertEqual((t.final[emu.V0], t.final[3], t.final[emu.A0]), (0x1111, model, 0x33))  # live registers kept
        self.assertEqual(t.final[28], 0x46B520)
        return t.final[emu.A2]

    def test_table(self):
        dongle, keyboard, smart, companion = 0x880E, 0x4024, 0x401E, 0x4026
        want = {
            # gates: (dongle, screen, 16418, keyboard, smart control, companion)
            None: (0, 2, 1, 1, 1, 1),
            "000": (0, 2, 1, 1, 1, 1),
            "010": (0, 2, 1, 1, 0, 0),
            "100": (0, 0, 1, 1, 1, 1),
            "110": (0, 0, 1, 1, 0, 0),
            "101": (0, 0, 1, 1, 1, 1),
        }
        for gates, row in want.items():
            got = tuple(self.policy(gates, m) for m in (dongle, SCREEN, 0x4022, keyboard, smart, companion))
            self.assertEqual(got, row, f"gates={gates!r}")


@unittest.skipUnless(STOCK and emu, "needs HAL_STOCK (stock hal 4.15.600), unicorn and pyelftools")
class HooksInPlace(unittest.TestCase):
    """The two hooks the scenarios above reach by another road, run where they
    sit in stock code, from the instruction before to the instruction after."""

    def run_from(self, hub, pc, regs, exits):
        hit = []
        for addr in exits:
            hub.internal[addr] = lambda t, a, addr=addr: (hit.append(addr), hub.block(t))[1]  # park it there
            hub.uc.hook_add(emu.UC_HOOK_CODE, hub._on_code, begin=addr, end=addr)
        t = hub.spawn("site", pc)
        for r, v in regs.items():
            t.regs[r] = v
        t.regs[28] = 0x46B520  # stock code has its $gp by here
        hub.world.run(done=lambda: bool(hit))
        return hit[0], [hub.uc.reg_read(r) for r in emu.REGS]

    def test_handler_thread_wait(self):
        """0x428a24: hot_object_lock, then the wait for a request, then on."""
        w = emu.World()
        w.pairs = [(SCREEN, 2)]
        hub = emu.Hal(w, PATCHED, "hub", "hub", gates="100")
        hub.start()
        req = emu.HOT_REQUEST_OBJ
        hub.w32(req, hub.alloc(8, b"request!"))  # a request from slot 5 is waiting
        hub.w32(req + 4, 8)
        hub.w32(req + 8, 0x309)
        hub.uc.mem_write(req + 0xC, bytes([5, 0]))
        hub.w32(req + 0x10, 1)
        frame = hub.alloc(0x2000) + 0x800  # the handler's 0xf18-byte frame, with room below for its callees
        exit_, regs = self.run_from(hub, 0x428A24, {16: req, emu.SP: frame}, [0x428A44])
        self.assertEqual(exit_, 0x428A44)
        self.assertEqual(regs[16], req)
        self.assertEqual(regs[emu.SP], frame)
        self.assertEqual(hub.mutex[req + 0x14].name, "site")  # still holding the request, as stock
        # and the reply to it goes to slot 5: nothing else is paired there, so only the snapshot can say so
        hub.mutex[req + 0x14] = None
        results = []
        hub.spawn("reply", gen=_reply(hub, results))
        w.run(6000)
        self.assertEqual({f[1] for _, f in hub.tx}, {5})

    def exits(self, gates, model, delayunpair):
        w = emu.World()
        hub = emu.Hal(w, PATCHED, "hub", "hub", gates=gates)
        frame = hub.alloc(0x800) + 0x400
        hub.w32(frame + 0x258, delayunpair)
        keep, unpair, delayed = 0x427C48, 0x427D00, 0x427C6C
        exit_, regs = self.run_from(hub, 0x427CDC, {3: model, emu.V0: 0x5000, emu.A0: 3, emu.SP: frame}, [keep, unpair, delayed])
        self.assertEqual(regs[emu.A0], 3)  # the slot libhal_rf_host_unpair gets
        self.assertEqual(regs[emu.SP], frame)
        if exit_ == keep:
            self.assertEqual(regs[emu.V0], 0x5000)  # the loop pointer, not yet advanced
        if exit_ == unpair:
            self.assertEqual(regs[emu.T9], 0x427320)  # libhal_rf_host_unpair
        return {keep: "keep", unpair: "unpair", delayed: "delayed"}[exit_]

    def test_same_model_unpair_in_place(self):
        smart, keyboard, dongle = 0x401E, 0x4024, 0x880E
        # stock, with both gates off
        self.assertEqual(self.exits("000", dongle, 0), "keep")
        self.assertEqual(self.exits("000", smart, 0), "unpair")
        self.assertEqual(self.exits("000", SCREEN, 0), "unpair")
        self.assertEqual(self.exits("000", SCREEN, 1), "delayed")
        self.assertEqual(self.exits("000", keyboard, 1), "unpair")
        # multi-remote
        self.assertEqual(self.exits("010", smart, 0), "keep")
        self.assertEqual(self.exits("010", SCREEN, 0), "unpair")
        self.assertEqual(self.exits("010", keyboard, 0), "unpair")
        # two-screen
        self.assertEqual(self.exits("100", SCREEN, 0), "keep")
        self.assertEqual(self.exits("100", SCREEN, 1), "keep")
        self.assertEqual(self.exits("100", smart, 0), "unpair")
        # both
        self.assertEqual(self.exits("110", SCREEN, 0), "keep")
        self.assertEqual(self.exits("110", smart, 0), "keep")
        self.assertEqual(self.exits("110", keyboard, 0), "unpair")


class PatchFile(unittest.TestCase):
    """What can be said about the edits without Logitech's file."""

    def test_shape(self):
        self.assertEqual(PATCH["stock_md5"], "a3fdd823440c43f36e235fe51c45f008")
        self.assertRegex(PATCH["patched_md5"], r"^[0-9a-f]{32}$")
        self.assertEqual(PATCH["size"], 363640)
        spans = sorted((int(e["offset"], 16), len(e["patched"]) // 2) for e in PATCH["edits"])
        for (a, n), (b, _) in zip(spans, spans[1:]):
            self.assertLessEqual(a + n, b)
        self.assertLessEqual(spans[-1][0] + spans[-1][1], PATCH["size"])

    def test_only_the_blob_lacks_stock_bytes(self):
        """Every edit states what it replaces, except the code laid over .pdr:
        18.9 KB of Logitech's file does not belong in this repository."""
        no_stock = [e["offset"] for e in PATCH["edits"] if "stock" not in e]
        self.assertEqual(no_stock, ["0x53cd0"])
        self.assertEqual(len(bytes.fromhex(next(e for e in PATCH["edits"] if e["offset"] == "0x53cd0")["patched"])), 0x49E0)

    def test_program_header(self):
        e = next(e for e in PATCH["edits"] if e["offset"] == "0x00114")
        self.assertEqual(struct.unpack(">8I", bytes.fromhex(e["stock"])), (0, 0, 0, 0, 0, 0, 0, 4))
        typ, off, va, pa, filesz, memsz, flags, align = struct.unpack(">8I", bytes.fromhex(e["patched"]))
        self.assertEqual((typ, off, filesz, memsz, flags), (1, 0x53CD0, 0x49E0, 0x49E0, 7))
        self.assertEqual(va, pa)
        self.assertEqual(va % 0x10000, off % 0x10000)  # same offset in a page, whatever the page size
        self.assertGreaterEqual(va, 0x46A000)  # above hal's bss

    def test_carries_the_multi_remote_edits(self):
        multi = json.loads(MULTI_PATCH_FILE.read_text(encoding="utf-8"))
        ours = {e["offset"]: e for e in PATCH["edits"]}
        policy = {"0x27cdc", "0x27ce0", "0x27ce4", "0x27ce8", "0x27cec"}
        for e in multi["edits"]:
            if e["offset"] in policy:
                continue
            self.assertEqual((ours[e["offset"]]["stock"], ours[e["offset"]]["patched"]), (e["stock"], e["patched"]))
        self.assertEqual(len(bytes.fromhex(ours["0x27cdc"]["patched"])), 20)

    def test_hooks_jump_into_the_blob(self):
        blob = range(0x473CD0, 0x473CD0 + 0x49E0)
        for e in PATCH["edits"]:
            offset, new = int(e["offset"], 16), bytes.fromhex(e["patched"])
            if offset in (0x114, 0x53CD0) or "multi-remote" in e["what"]:
                continue
            first = struct.unpack(">I", new[:4])[0]
            target = first if offset == 0x52BB4 else (first & 0x03FFFFFF) << 2
            self.assertIn(target, blob, e["offset"])

    @unittest.skipUnless(STOCK, "needs HAL_STOCK")
    def test_md5(self):
        self.assertEqual(hashlib.md5(PATCHED).hexdigest(), PATCH["patched_md5"])
        self.assertEqual(len(PATCHED), len(STOCK))


if __name__ == "__main__":
    unittest.main(verbosity=2)
