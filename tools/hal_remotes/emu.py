"""The HOT layer of the hub's hal, run off the hub.

Unicorn executes hal's own MIPS code (stock, or stock with the hal_remotes
edits applied) for everything in src/libhal/rf/hot.c and the added code. What
sits under it is modelled here: pthreads (cooperative, on a virtual clock), the
heap, the radio (rf_msg_*), and the few imports those paths reach.

hal is built from code shared with the remotes, and hot_init(1) puts it in the
remote's role. So a "remote" here is a second, stock copy of the same binary in
that role, and frames are carried between the copies the way the radio carries
them: tagged with the slot the remote is paired in.

Nothing in this file knows how the patch works. tests drive hal through the
entry points stock hal has (hot_send_data, hot_hbus_notify_send, ...).
"""
from __future__ import annotations

import heapq
import random
import struct

from elftools.elf.elffile import ELFFile
from unicorn import UC_ARCH_MIPS, UC_HOOK_CODE, UC_HOOK_INTR, UC_MODE_BIG_ENDIAN, UC_MODE_MIPS32, Uc, UcError
from unicorn import mips_const as mc

MS = 1_000_000  # ns
RET_MAGIC = 0x7FFF0000
HEAP_BASE, HEAP_SIZE = 0x10000000, 0x400000
STACK_BASE, STACK_SIZE = 0x60000000, 0x10000
GATES_PATH = b"/var/run/codex_hal_gates"

# stock hal 4.15.600
HOT_INIT = 0x42E7F0
HOT_SEND_DATA = 0x42E078
HOT_SEND_DATA_WAIT_REPLY = 0x42E340
HOT_HBUS_NOTIFY_SEND = 0x42E60C
HOT_OBJECT_LOCK = 0x42C038
HOT_OBJECT_WAIT = 0x42C0AC
HOT_OBJECT_FREE = 0x42C2D8
HOT_STATS = 0x42E724
HOT_REQUEST_OBJ = 0x469E10
HOT_CONTEXT = 0x466F74
STAT_NAME = 0x4634B0
HOT_CMD_MUTEX = 0x4675B0
PTHREAD_MUTEX_LOCK, PTHREAD_MUTEX_UNLOCK = 0x442290, 0x4429D0  # hal's import stubs
STUBS = (0x441E60, 0x442CF0)

LIBHAL_LOG = 0x416058
RF_MSG_WRITE = 0x42ADD4
RF_MSG_INTERRUPT = 0x42AF18
RF_MSG_SUBSCRIBE = 0x42B008
RF_MSG_UNSUBSCRIBE = 0x42B108
RF_MSG_WAIT = 0x42B1F4
GET_PAIRED_DEVICE_INFO = 0x425C30

GPR = [mc.UC_MIPS_REG_0 + i for i in range(32)]
REGS = GPR + [mc.UC_MIPS_REG_PC, mc.UC_MIPS_REG_HI, mc.UC_MIPS_REG_LO]
V0, A0, A1, A2, A3, T9, SP, RA = 2, 4, 5, 6, 7, 25, 29, 31

BLOCK = object()


class HalAssert(Exception):
    pass


class Thread:
    def __init__(self, hal: "Hal", name: str):
        self.hal, self.name = hal, name
        self.regs = [0] * len(REGS)
        self.state = "new"  # run | blocked | ret | done
        self.deadline: int | None = None
        self.timedout = False
        self.cw: dict | None = None  # pthread_cond_wait in progress
        self.rfw = False  # rf_msg_wait in progress
        self.gen = None
        self.skip = False  # the modelled call at pc is done; let its "jr $ra" run
        self.started = False
        self.sleeping = False
        self.ret = 0
        self.stack_top = 0

    def __repr__(self) -> str:
        return f"<{self.hal.name}:{self.name} {self.state}>"


class World:
    """The clock, the scheduler and the air between one hub and its remotes."""

    def __init__(self, seed: int | None = None, latency_ms: float = 2):
        self.now = 1_000 * 1000 * MS  # ns; monotonic and wall clock are the same here
        self.threads: list[Thread] = []
        self.timers: list = []
        self.seq = 0
        self.rng = random.Random(seed) if seed is not None else None
        self.preempt = 0.3  # with a seed: chance that a thread is descheduled at a modelled call
        self.latency = int(latency_ms * MS)
        self.hub: Hal | None = None
        self.remotes: dict[int, Hal] = {}
        self.pairs: list[tuple[int, int]] = []  # (EquadID, slot) as the radio lists them
        self.air_filter = None  # fn(src_hal, dst_hal, frame) -> False to lose the frame
        self.air: list = []  # (time, src name, dst name, frame)

    def at(self, when: int, fn) -> None:
        self.seq += 1
        heapq.heappush(self.timers, (when, self.seq, fn))

    def carry(self, src: "Hal", frame: bytes) -> None:
        if src is self.hub:
            if len(frame) != 0x1E:
                return
            slot = frame[1]
            dst = self.remotes.get(slot)
            msg = b"\x20\x01\x12" + bytes([slot]) + frame[2:30]
        else:
            if len(frame) != 0x20:  # hot_set_powermode's short report
                return
            dst = self.hub
            msg = bytes([0x12, src.slot]) + frame[4:32] + b"\0\0"
        ok = dst is not None and dst.awake and src.awake
        if ok and self.air_filter is not None:
            ok = self.air_filter(src, dst, frame) is not False
        self.air.append((self.now, src.name, dst.name if dst else "-", frame, ok))
        if ok:
            self.at(self.now + self.latency, lambda: dst.rx(msg))

    def run(self, until_ms: float | None = None, done=None, limit: int = 2_000_000) -> str:
        """Run until every thread is blocked with nothing pending ("idle"),
        done() is true ("done"), or until_ms of virtual time passed ("time")."""
        until = None if until_ms is None else self.now + int(until_ms * MS)
        cur: Thread | None = None
        for _ in range(limit):
            if done is not None and done():
                return "done"
            runnable = [t for t in self.threads if t.state in ("run", "ret")]
            if not runnable:
                nxt = [t.deadline for t in self.threads if t.state == "blocked" and t.deadline is not None]
                if self.timers:
                    nxt.append(self.timers[0][0])
                if not nxt:
                    return "idle"
                when = min(nxt)
                if until is not None and when > until:
                    self.now = until
                    return "time"
                self.now = max(self.now, when)
                while self.timers and self.timers[0][0] <= self.now:
                    heapq.heappop(self.timers)[2]()
                for t in self.threads:
                    if t.state == "blocked" and t.deadline is not None and t.deadline <= self.now:
                        t.timedout, t.deadline = True, None
                        t.state, t.sleeping, t.ret = ("ret", False, 0) if t.sleeping else ("run", False, t.ret)
                continue
            if cur not in runnable or self.rng is not None:
                cur = self.rng.choice(runnable) if self.rng is not None else runnable[0]
            cur.hal.step(cur)
            self.threads = [t for t in self.threads if t.state != "done"]
        raise RuntimeError("scheduler limit reached")


class Hal:
    def __init__(self, world: World, image: bytes, name: str, role: str, slot: int = 0, gates: str | None = None,
                 symbols: dict[str, int] | None = None):
        self.world, self.name, self.role, self.slot = world, name, role, slot
        self.gates = gates.encode() if gates is not None else None
        self.sym = symbols or {}
        self.awake = True
        self.rxq: list[bytes] = []
        self.intr = 0
        self.rf_waiter: Thread | None = None
        self.tx: list[tuple[int, bytes]] = []
        self.log: list[tuple[int, str]] = []
        self.mutex: dict[int, Thread | None] = {}
        self.mutex_waiters: dict[int, list[Thread]] = {}
        self.cond: dict[int, list[Thread]] = {}
        self.heap = HEAP_BASE
        self.free: dict[int, int] = {}
        self.json: dict[int, object] = {}
        self.json_next = 0x7E000000
        self.nthreads = 0
        self.fd_pos: dict[int, int] = {}
        self.cur: Thread | None = None
        self.error: BaseException | None = None
        self.replies: list = []
        self.handler_wait = HOT_OBJECT_WAIT

        self.uc = uc = Uc(UC_ARCH_MIPS, UC_MODE_MIPS32 | UC_MODE_BIG_ENDIAN)
        self.stub: dict[int, str] = {}
        self._load(image)
        uc.mem_map(HEAP_BASE, HEAP_SIZE)
        uc.mem_map(RET_MAGIC, 0x1000)
        self.internal = {
            LIBHAL_LOG: self.h_log,
            RF_MSG_WRITE: self.h_rf_write,
            RF_MSG_INTERRUPT: self.h_rf_interrupt,
            RF_MSG_SUBSCRIBE: lambda t, a: 0,
            RF_MSG_UNSUBSCRIBE: lambda t, a: 0,
            RF_MSG_WAIT: self.h_rf_wait,
            GET_PAIRED_DEVICE_INFO: self.h_paired,
            RET_MAGIC: self.h_return,
        }
        # Every modelled function becomes "jr $ra; nop" with a hook on it: the
        # hook does the work (or stops the thread there, to be retried).
        uc.hook_add(UC_HOOK_CODE, self._on_code, begin=STUBS[0], end=STUBS[1])
        for addr in list(self.stub) + list(self.internal):
            uc.mem_write(addr, bytes.fromhex("03e0000800000000"))
            if addr in self.internal:
                uc.hook_add(UC_HOOK_CODE, self._on_code, begin=addr, end=addr)
        uc.hook_add(UC_HOOK_INTR, self._on_intr)
        if role == "hub":
            world.hub = self
        else:
            world.remotes[slot] = self

    # ---- image ----

    def _load(self, image: bytes) -> None:
        import io

        elf = ELFFile(io.BytesIO(image))
        mapped: set[int] = set()
        for seg in elf.iter_segments():
            if seg["p_type"] != "PT_LOAD":
                continue
            lo, hi = seg["p_vaddr"] & ~0xFFF, (seg["p_vaddr"] + seg["p_memsz"] + 0xFFF) & ~0xFFF
            for page in range(lo, hi, 0x1000):
                if page not in mapped:
                    self.uc.mem_map(page, 0x1000)
                    mapped.add(page)
            self.uc.mem_write(seg["p_vaddr"], image[seg["p_offset"] : seg["p_offset"] + seg["p_filesz"]])
        names = [s.name for s in elf.get_section_by_name(".dynsym").iter_symbols()]
        for addr in range(STUBS[0], STUBS[1], 16):
            off = addr - 0x400000
            self.stub[addr] = names[struct.unpack(">I", image[off + 12 : off + 16])[0] & 0xFFFF]

    # ---- memory ----

    def u32(self, addr: int) -> int:
        return struct.unpack(">I", self.uc.mem_read(addr, 4))[0]

    def u8(self, addr: int) -> int:
        return self.uc.mem_read(addr, 1)[0]

    def w32(self, addr: int, value: int) -> None:
        self.uc.mem_write(addr, struct.pack(">I", value & 0xFFFFFFFF))

    def read(self, addr: int, n: int) -> bytes:
        return bytes(self.uc.mem_read(addr, n))

    def cstr(self, addr: int) -> bytes:
        out = b""
        while True:
            chunk = self.read(addr + len(out), 64)
            if b"\0" in chunk:
                return out + chunk[: chunk.index(b"\0")]
            out += chunk

    def alloc(self, n: int, data: bytes | None = None) -> int:
        n = (max(n, 1) + 15) & ~15
        addr = self.heap
        self.heap += n
        if self.heap > HEAP_BASE + HEAP_SIZE:
            raise MemoryError("emulated heap exhausted")
        self.free[addr] = n
        self.uc.mem_write(addr, (data or b"").ljust(n, b"\0"))
        return addr

    # ---- threads ----

    def spawn(self, name: str, pc: int = 0, args: tuple = (), gen=None) -> Thread:
        t = Thread(self, name)
        self.uc.mem_map(STACK_BASE + self.nthreads * STACK_SIZE, STACK_SIZE)
        self.nthreads += 1
        t.stack_top = STACK_BASE + self.nthreads * STACK_SIZE - 0x100
        t.gen = gen
        if gen is not None:
            t.state = "ret"
        else:
            self._enter(t, pc, args)
        self.world.threads.append(t)
        return t

    def _enter(self, t: Thread, pc: int, args: tuple) -> None:
        t.regs = [0] * len(REGS)
        sp = t.stack_top - 0x40
        for i, a in enumerate(args):
            if i < 4:
                t.regs[A0 + i] = a & 0xFFFFFFFF
            else:
                self.w32(sp + 4 * i, a)
        t.regs[SP], t.regs[RA], t.regs[T9], t.regs[32] = sp, RET_MAGIC, pc, pc
        t.regs[28] = 0xDEAD0000  # a caller's $gp is never hal's business
        t.state = "run"

    def step(self, t: Thread) -> None:
        """Run one thread until its next modelled call."""
        if t.state == "ret":
            self._advance(t)
            return
        uc = self.uc
        for i, r in enumerate(REGS):
            uc.reg_write(r, t.regs[i])
        self.cur, self.error = t, None
        try:
            uc.emu_start(t.regs[32], RET_MAGIC + 0x800, timeout=20_000_000)
        except UcError as e:
            if self.error is None:
                pc = uc.reg_read(mc.UC_MIPS_REG_PC)
                raise RuntimeError(f"{t!r}: {e} at pc={pc:#x} ra={uc.reg_read(GPR[RA]):#x}") from None
        finally:
            self.cur = None
        if self.error is not None:  # raised inside a hook; Unicorn can't carry it out
            raise self.error
        for i, r in enumerate(REGS):
            t.regs[i] = uc.reg_read(r)

    def _advance(self, t: Thread) -> None:
        """A driver thread: feed the last call's result to its generator."""
        try:
            step = t.gen.send(t.ret) if t.started else next(t.gen)
        except StopIteration:
            t.state = "done"
            return
        t.started = True
        if step[0] == "call":
            self._enter(t, step[1], tuple(step[2:]))
        elif step[0] == "sleep":
            t.state, t.deadline, t.timedout = "blocked", self.world.now + int(step[1] * MS), False
            t.sleeping = True
        else:
            raise ValueError(step)

    def block(self, t: Thread, deadline: int | None = None):
        t.state, t.deadline, t.timedout = "blocked", deadline, False
        return BLOCK

    def wake(self, t: Thread | None) -> None:
        if t is not None and t.state == "blocked":
            t.state, t.deadline = "run", None

    # ---- hooks ----

    def _on_code(self, uc, address, size, user) -> None:
        t = self.cur
        if address not in self.internal and address not in self.stub:
            return  # the second word of a stub
        if t.skip:
            t.skip = False
            return
        try:
            if address in self.internal:
                fn = self.internal[address]
            else:
                name = self.stub[address]
                fn = getattr(self, "i_" + name, None)
                if fn is None:
                    raise NotImplementedError(f"{self.name}: import {name} is not modelled")
            ret = fn(t, [uc.reg_read(GPR[A0 + i]) for i in range(4)])
        except BaseException as e:  # noqa: BLE001 - re-raised by step()
            self.error = e
            uc.emu_stop()
            return
        if ret is BLOCK:
            uc.emu_stop()  # the thread stays on this call
            return
        if ret is not None:
            uc.reg_write(GPR[V0], ret & 0xFFFFFFFF)
        if self.world.rng is not None and self.world.rng.random() < self.world.preempt:
            t.skip = True
            uc.emu_stop()  # a scheduling point: another thread may run before this one returns

    def _on_intr(self, uc, intno, user) -> None:
        try:
            self._syscall(uc, intno)
        except BaseException as e:  # noqa: BLE001 - re-raised by step()
            self.error = e
            uc.emu_stop()

    def _syscall(self, uc, intno) -> None:
        if intno != 17:
            raise RuntimeError(f"{self.name}: exception {intno} at {uc.reg_read(mc.UC_MIPS_REG_PC):#x}")
        nr, a0, a1, a2 = (uc.reg_read(GPR[r]) for r in (V0, A0, A1, A2))
        err, ret = 0, 0
        if nr == 4263:  # clock_gettime
            self.w32(a1, self.world.now // 1_000_000_000)
            self.w32(a1 + 4, self.world.now % 1_000_000_000)
        elif nr == 4005:  # open
            if self.cstr(a0) == GATES_PATH and self.gates is not None:
                ret = 100
                self.fd_pos[ret] = 0
            else:
                err, ret = 1, 2
        elif nr == 4003:  # read
            chunk = self.gates[self.fd_pos[a0] : self.fd_pos[a0] + a2]
            uc.mem_write(a1, chunk)
            self.fd_pos[a0] += len(chunk)
            ret = len(chunk)
        elif nr == 4006:  # close
            self.fd_pos.pop(a0, None)
        elif nr == 4166:  # nanosleep
            self.block(self.cur, self.world.now + self.u32(a0) * 1_000_000_000 + self.u32(a0 + 4))
            uc.emu_stop()
        else:
            raise RuntimeError(f"{self.name}: syscall {nr}")
        uc.reg_write(GPR[V0], ret)
        uc.reg_write(GPR[A3], err)

    def h_return(self, t: Thread, a) -> object:
        t.final = [self.uc.reg_read(r) for r in REGS]
        t.ret = t.final[V0]
        t.state = "ret" if t.gen is not None else "done"
        return BLOCK

    # ---- libhal_log ----

    def h_log(self, t: Thread, a) -> int:
        """Keep hal's log lines readable. Formatting is best effort: stock passes
        doubles and, here and there, fewer arguments than its format names."""
        fmt = self.cstr(a[1]).decode("latin1")
        sp = self.uc.reg_read(GPR[SP])
        vals = [a[2], a[3]] + [self.u32(sp + 16 + 4 * i) for i in range(6)]
        out, i, k = "", 0, 0
        while i < len(fmt):
            if fmt[i] != "%":
                out += fmt[i]
                i += 1
                continue
            j = i + 1
            while j < len(fmt) and fmt[j] not in "sdxXuc%f":
                j += 1
            conv = fmt[j] if j < len(fmt) else "%"
            v = vals[k] if k < len(vals) else 0
            if conv == "%":
                out += "%"
            elif conv == "f":
                k += 2
                out += "?"
            else:
                k += 1
                try:
                    if conv == "s":
                        out += self.cstr(v).decode("latin1") if v else "(null)"
                    elif conv == "d":
                        out += str(v - (1 << 32) if v & 0x80000000 else v)
                    elif conv in "xX":
                        out += format(v, "x")
                    else:
                        out += str(v)
                except UcError:
                    out += "?"
            i = j + 1
        self.log.append((a[0], out.strip()))
        return 0

    # ---- radio ----

    def rx(self, msg: bytes) -> None:
        self.rxq.append(msg.ljust(32, b"\0"))
        self.wake(self.rf_waiter)

    def link_loss(self, slot: int) -> None:
        """The radio's "device connection" report with the link-lost bit, as the hub gets it."""
        self.rx(bytes([0x10, slot, 0x41, 0x00, 0x40]))

    def h_rf_write(self, t: Thread, a) -> int:
        frame = self.read(a[0], a[1])
        self.tx.append((self.world.now, frame))
        self.world.carry(self, frame)
        return a[1]

    def h_rf_interrupt(self, t: Thread, a) -> int:
        self.intr += 1
        self.wake(self.rf_waiter)
        return 0

    def h_rf_wait(self, t: Thread, a) -> object:
        timed_out = t.rfw and t.timedout
        if self.intr:
            self.intr -= 1
            ret = -4
        elif self.rxq:
            self.uc.mem_write(a[2], self.rxq.pop(0))
            ret = 0
        elif timed_out:
            ret = -0x91
        else:
            t.rfw, self.rf_waiter = True, t
            return self.block(t, self.world.now + a[1] * MS if a[1] else None)
        t.rfw = False
        return ret

    def h_paired(self, t: Thread, a) -> int:
        self.uc.mem_write(a[0], b"\0" * (6 * 0x18))
        for i, (model, slot) in enumerate(self.world.pairs):
            self.uc.mem_write(a[0] + i * 0x18, struct.pack(">H", model))
            self.w32(a[0] + i * 0x18 + 0x14, slot)
        return len(self.world.pairs)

    # ---- imports: pthreads ----

    def i_pthread_mutex_init(self, t, a):
        self.mutex[a[0]] = None
        return 0

    def i_pthread_cond_init(self, t, a):
        self.cond[a[0]] = []
        return 0

    def i_pthread_cond_destroy(self, t, a):
        return 0

    def i_pthread_mutex_lock(self, t, a):
        owner = self.mutex.get(a[0])
        if owner is None:
            self.mutex[a[0]] = t
            return 0
        if owner is t:
            raise RuntimeError(f"{t!r} locks mutex {a[0]:#x} twice")
        self.mutex_waiters.setdefault(a[0], []).append(t)
        return self.block(t)

    def i_pthread_mutex_trylock(self, t, a):
        if self.mutex.get(a[0]) is None:
            self.mutex[a[0]] = t
            return 0
        return 16

    def _unlock(self, t: Thread, m: int) -> None:
        if self.mutex.get(m) is not t:
            raise RuntimeError(f"{t!r} unlocks mutex {m:#x} it does not hold")
        self.mutex[m] = None
        for w in self.mutex_waiters.pop(m, []):
            self.wake(w)

    def i_pthread_mutex_unlock(self, t, a):
        self._unlock(t, a[0])
        return 0

    def _cond_wait(self, t: Thread, cond: int, m: int, deadline: int | None):
        if t.cw is None:
            self._unlock(t, m)
            t.cw = {"signaled": False}
            self.cond.setdefault(cond, []).append(t)
            return self.block(t, deadline)
        if not t.cw["signaled"] and not t.cw.get("expired"):
            if t.timedout:
                t.cw["expired"] = True
                if t in self.cond.get(cond, []):
                    self.cond[cond].remove(t)
            else:
                return self.block(t, deadline)
        if self.mutex.get(m) is not None:
            self.mutex_waiters.setdefault(m, []).append(t)
            return self.block(t)
        self.mutex[m] = t
        ret = 0 if t.cw["signaled"] else 0x91
        t.cw = None
        return ret

    def i_pthread_cond_wait(self, t, a):
        return self._cond_wait(t, a[0], a[1], None)

    def i_pthread_cond_timedwait(self, t, a):
        return self._cond_wait(t, a[0], a[1], self.u32(a[2]) * 1_000_000_000 + self.u32(a[2] + 4))

    def i_pthread_cond_signal(self, t, a):
        waiters = self.cond.get(a[0], [])
        if waiters:
            w = waiters.pop(0)
            w.cw["signaled"] = True
            self.wake(w)
        return 0

    def i_pthread_create(self, t, a):
        self.spawn(f"thread@{a[2]:x}", a[2], (a[3],))
        return 0

    # ---- imports: libc ----

    def i_malloc(self, t, a):
        return self.alloc(a[0])

    def i_calloc(self, t, a):
        return self.alloc(a[0] * a[1])

    def i_free(self, t, a):
        if a[0] and self.free.pop(a[0], None) is None:
            raise RuntimeError(f"{t!r}: free({a[0]:#x}) of something not allocated")
        return 0

    def i_memcpy(self, t, a):
        self.uc.mem_write(a[0], self.read(a[1], a[2]))
        return a[0]

    def i_memset(self, t, a):
        self.uc.mem_write(a[0], bytes([a[1] & 0xFF]) * a[2])
        return a[0]

    def i_clock_gettime(self, t, a):
        self.w32(a[1], self.world.now // 1_000_000_000)
        self.w32(a[1] + 4, self.world.now % 1_000_000_000)
        return 0

    def i_time(self, t, a):
        return self.world.now // 1_000_000_000

    def i_srand48(self, t, a):
        return 0

    def i_strerror(self, t, a):
        if not hasattr(self, "_strerror"):
            self._strerror = self.alloc(16, b"error")
        return self._strerror

    def i___assert(self, t, a):
        raise HalAssert(f"{self.name}: assert {self.cstr(a[0]).decode()} ({self.cstr(a[1]).decode()}:{a[2]})")

    # ---- imports: jansson, as far as hot.stats goes ----

    def _json(self, value) -> int:
        self.json_next += 16
        self.json[self.json_next] = value
        return self.json_next

    def i_json_object(self, t, a):
        return self._json({})

    def i_json_integer(self, t, a):
        return self._json((a[0] << 32) | a[1])

    def i_json_object_set_new_nocheck(self, t, a):
        self.json[a[0]][self.cstr(a[1]).decode()] = self.json.pop(a[2])
        return 0

    # ---- driving hal ----

    def call(self, pc: int, *args, run_ms: float | None = None) -> int:
        """Call a hal function on a new thread and run the world until it returns."""
        t = self.spawn(f"call@{pc:x}", pc, args)
        self.world.run(until_ms=run_ms, done=lambda: t.state == "done")
        if t.state != "done":
            raise RuntimeError(f"{self.name}: call {pc:#x} did not return ({t!r})")
        return t.ret

    def start(self) -> None:
        self.call(HOT_INIT, 1 if self.role == "remote" else 0)
        self.world.run()

    def hot_stats(self) -> dict:
        req = self.alloc(0x40)
        self.call(self.u32(0x462BB4), req)
        return dict(self.json[self.u32(req + 0x10)])

    def stat(self, ctx: int = HOT_CONTEXT) -> dict:
        names = [self.cstr(self.u32(STAT_NAME + 4 * i)).decode() for i in range(17)]
        return {n: self.u32(ctx + 0x12C + 4 * i) for i, n in enumerate(names)}


def iov(hal: Hal, payload: bytes) -> int:
    buf = hal.alloc(len(payload), payload)
    return hal.alloc(8, struct.pack(">II", buf, len(payload)))


def handler(hal: Hal, on_request, work_ms: float = 0, think_ms: float = 0):
    """The HOT handler thread's loop (0x4288f8), with the request passed to
    on_request(slot, type, payload) -> reply payload or None. Stock works on a
    request with the request object locked (work_ms), frees it, and then sends
    the reply with hot_send_data (after think_ms)."""
    req = HOT_REQUEST_OBJ
    while True:
        yield ("call", HOT_OBJECT_LOCK, req)
        yield ("call", hal.handler_wait, req, 0)
        data, size, typ, slot = hal.u32(req), hal.u32(req + 4), hal.u32(req + 8), hal.u8(req + 0xC)
        payload = hal.read(data, size) if data else b""
        if work_ms:
            yield ("sleep", work_ms)
        yield ("call", HOT_OBJECT_FREE, req)
        if think_ms:
            yield ("sleep", think_ms)
        reply = on_request(slot, typ, payload)
        if reply is not None:
            rc = yield ("call", HOT_SEND_DATA, (typ & 0xFFFFFF00) | ((typ & 0xFF) + 0x80), iov(hal, reply), 1)
            hal.replies.append((slot, typ, rc - (1 << 32) if rc & 0x80000000 else rc))


def request(hal: Hal, typ: int, payload: bytes, timeout_ms: int, results: list, tag=None):
    """hot_send_data_wait_reply, as libhal_rf_hot_hbus calls it: one request
    at a time, under hot_cmd_mutex."""
    out = hal.alloc(8)
    yield ("call", PTHREAD_MUTEX_LOCK, HOT_CMD_MUTEX)
    rc = yield ("call", HOT_SEND_DATA_WAIT_REPLY, typ, iov(hal, payload), 1, out, out + 4, timeout_ms)
    yield ("call", PTHREAD_MUTEX_UNLOCK, HOT_CMD_MUTEX)
    rc = rc - (1 << 32) if rc & 0x80000000 else rc
    reply = hal.read(hal.u32(out), hal.u32(out + 4)) if rc == 0 else None
    results.append((tag, rc, reply, hal.world.now))


def notify(hal: Hal, payload: bytes, results: list, tag=None):
    buf = hal.alloc(len(payload), payload)
    rc = yield ("call", HOT_HBUS_NOTIFY_SEND, buf, len(payload))
    results.append((tag, rc - (1 << 32) if rc & 0x80000000 else rc, hal.world.now))
