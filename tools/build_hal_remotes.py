#!/usr/bin/env python3
"""Build payload/helpers/hal_remotes_patch.json from payload/source/hal_remotes.

The hub's hal is never shipped. This compiles the added code (hal_remotes.c,
glue.s) with the pinned Zig, lays it over hal's unloaded .pdr bytes, and writes
the edits the installers apply to the hub's own /usr/bin/hal: a program header
that maps those bytes, the jumps into them, and PR #109's per-slot key-thread
edits. See docs/TWO_SCREEN_REMOTES.md.

    tools/build_hal_remotes.py                 build; write the patch file
    tools/build_hal_remotes.py --check         build; fail if the patch file differs
    tools/build_hal_remotes.py --stock <hal>   also apply to a stock hal and print the md5
    tools/build_hal_remotes.py --out <hal>     ... and write the patched hal there (never commit it)

Zig: $HAL_REMOTES_ZIG, else $OFFICIAL_ZIG, else `zig` on PATH. It must be 0.16.0.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "payload" / "source" / "hal_remotes"
PATCH_FILE = ROOT / "payload" / "helpers" / "hal_remotes_patch.json"
MULTI_PATCH_FILE = ROOT / "payload" / "helpers" / "hal_multiremote_patch.json"
ZIG_VERSION = "0.16.0"

STOCK_MD5 = "a3fdd823440c43f36e235fe51c45f008"
STOCK_SIZE = 363640
LOAD_BASE = 0x400000  # file offset 0 of the text segment

# hal's .pdr section: debugger procedure descriptors, not loaded.
PDR_OFFSET = 0x53CD0
PDR_SIZE = 0x49E0
BLOB_VADDR = 0x473CD0  # same offset within a 4 KiB (and a 64 KiB) page as PDR_OFFSET
DATA_VADDR = 0x477000
PHDR7_OFFSET = 0x34 + 7 * 32  # the spare PT_NULL program header
PHDR7_STOCK = struct.pack(">8I", 0, 0, 0, 0, 0, 0, 0, 4)
PHDR7_LOAD = struct.pack(">8I", 1, PDR_OFFSET, BLOB_VADDR, BLOB_VADDR, PDR_SIZE, PDR_SIZE, 7, 0x1000)

# No abicalls and -mgpopt with -G0: LLVM then keeps $gp out of register
# allocation (it is hal's, and hal's import stubs need it) and still puts
# nothing in gp-relative small data. Zig's driver drops -mno-abicalls, hence
# the -Xclang form. check_code() verifies the result either way.
CFLAGS = [
    "-target", "mips-freestanding-eabi", "-mcpu=mips32r2", "-msoft-float",
    "-Xclang", "-target-feature", "-Xclang", "+noabicalls", "-mllvm", "-mgpopt", "-G0",
    "-Os", "-ffreestanding", "-fno-pic", "-fno-builtin", f"-I{SRC}",
    "-fno-asynchronous-unwind-tables", "-fno-unwind-tables", "-fno-stack-protector",
    "-Wall", "-Wextra", "-Werror",
]  # fmt: skip
LDFLAGS = [
    "-target", "mips-freestanding-eabi", "-mcpu=mips32r2", "-msoft-float",
    "-nostdlib", "-static", "-Wl,--no-dynamic-linker", "-Wl,--build-id=none", "-Wl,--entry=g_hot_loop",
]  # fmt: skip

# Stock addresses the added code may jump to (glue.s): the bodies of the
# functions whose entry is hooked, and the HOT thread's loop and exit path.
STOCK_JUMP_TARGETS = {0x42E084, 0x42E618, 0x42A248, 0x4292F8, 0x42BF04, 0x42D100, 0x42D240}

NOP = 0


def j(target: int) -> int:
    return 0x08000000 | ((target >> 2) & 0x03FFFFFF)


def jal(target: int) -> int:
    return 0x0C000000 | ((target >> 2) & 0x03FFFFFF)


def beqz_a2(pc: int, target: int) -> int:
    return 0x10C00000 | (((target - (pc + 4)) >> 2) & 0xFFFF)


def hooks(sym: dict[str, int]) -> list[tuple[int, list[int], list[int], str]]:
    """(file offset, stock words, new words, what)."""
    return [
        (0x2D0F8, [0xAFA00038, 0x27B20018], [j(sym["g_hot_loop"]), NOP],
         "HOT thread, after rf_msg_subscribe: the per-slot loop (gate off: the stock loop)"),
        (0x2E078, [0x3C1C0004, 0x279CD4A8], [j(sym["g_send_data"]), NOP],
         "hot_send_data entry: send to a named slot's context"),
        (0x2E60C, [0x3C1C0004, 0x279CCF14], [j(sym["g_notify_send"]), NOP],
         "hot_hbus_notify_send entry: notify every linked screen remote"),
        (0x2E6E0, [0x3C1C0004, 0x279CCE40], [j(sym["g_update_pair_status"]), NOP],
         "hot_update_pair_status entry: also record which slots hold a screen remote"),
        (0x2A23C, [0x3C1C0004, 0x279C12E4], [j(sym["g_hot_hbus"]), NOP],
         "libhal_rf_hot_hbus_without_lock entry: hot.1N names slot N"),
        (0x292EC, [0x3C1C0004, 0x279C2234], [j(sym["g_hot_open"]), NOP],
         "libhal_rf_hot_open entry: /rf/hot/1N/ names slot N"),
        (0x2BEF8, [0x3C1C0004, 0x279CF628], [j(sym["g_object_data"]), NOP],
         "hot_object_data entry: a second request waits for the handler instead of replacing the first"),
        (0x2E49C, [0x8EF80088], [jal(sym["g_wr_link"])],
         "hot_send_data_wait_reply: link test on the context the request went to"),
        (0x28A38, [0x8F9982A0, 0x0320F809, 0x00002821], [jal(sym["g_handler_wait"]), 0x00002821, NOP],
         "HOT handler thread: remember which slot a request came from"),
        (0x27CDC, [0x3406880E, 0x1066FFDB, 0x24420018, 0x24024021, 0x14620004],
         [jal(sym["g_elim"]), 0x00603021, beqz_a2(0x427CE4, 0x427C48), 0x24C6FFFF, beqz_a2(0x427CEC, 0x427D00)],
         "rf_eliminate_multiple_device: which same-model duplicate stays, by gate"),
        (0x52BB4, [0x0042E724], [sym["g_stats"]],
         "hot.stats handler: all contexts, and the per-slot view"),
    ]  # fmt: skip


def find_zig() -> str:
    for cand in (os.environ.get("HAL_REMOTES_ZIG"), os.environ.get("OFFICIAL_ZIG"), shutil.which("zig")):
        if not cand:
            continue
        version = subprocess.run([cand, "version"], capture_output=True, text=True).stdout.strip()
        if version == ZIG_VERSION:
            return cand
        if cand != shutil.which("zig"):
            sys.exit(f"{cand} is Zig {version}; hal_remotes is pinned to {ZIG_VERSION}")
    sys.exit(f"Zig {ZIG_VERSION} not found; set HAL_REMOTES_ZIG to the official {ZIG_VERSION} binary")


def run(cmd: list[str]) -> None:
    done = subprocess.run(cmd, capture_output=True, text=True)
    if done.returncode or done.stderr.strip():  # warnings included
        sys.exit("\n".join([" ".join(cmd), done.stderr, done.stdout]))


def compile_blob(zig: str, work: Path) -> Path:
    obj = work / "hal_remotes.o"
    run([zig, "cc", *CFLAGS, "-c", str(SRC / "hal_remotes.c"), "-o", str(obj)])  # includes glue.s
    elf = work / "hal_remotes.elf"
    run([zig, "cc", *LDFLAGS, f"-Wl,-T,{SRC / 'link.ld'}", "-o", str(elf), str(obj)])
    return elf


def read_elf(elf: Path) -> tuple[bytes, int, bytes, dict[str, int], dict[str, tuple[int, int]]]:
    """(code+constants, end of code, data, symbol -> address, function -> (address, size))."""
    from elftools.elf.elffile import ELFFile

    with elf.open("rb") as fh:
        f = ELFFile(fh)
        text, rodata, data = f.get_section_by_name(".text"), f.get_section_by_name(".rodata"), f.get_section_by_name(".data")
        if text["sh_addr"] != BLOB_VADDR or data["sh_addr"] != DATA_VADDR:
            sys.exit("hal_remotes: unexpected section addresses")
        code = text.data()
        ro = rodata.data() if rodata else b""
        if rodata and rodata["sh_addr"] != BLOB_VADDR + len(code):
            sys.exit("hal_remotes: .rodata does not follow .text")
        for sec in f.iter_sections():
            if sec["sh_flags"] & 2 and sec.name not in (".text", ".rodata", ".data") and sec["sh_size"]:
                sys.exit(f"hal_remotes: unexpected section {sec.name}")
        sym, funcs = {}, {}
        for s in f.get_section_by_name(".symtab").iter_symbols():
            if s.name and s["st_shndx"] != "SHN_UNDEF":
                sym[s.name] = s["st_value"]
                if s["st_info"]["type"] == "STT_FUNC":
                    funcs[s.name] = (s["st_value"], s["st_size"])
        return code + ro, len(code), data.data(), sym, funcs


def check_code(code: bytes, sym: dict[str, int], funcs: dict[str, tuple[int, int]]) -> None:
    """The rules in hal_remotes.c: calls out through $t9, $gp only set by the glue, no stray jumps."""
    glue = [(a, a + n) for name, (a, n) in funcs.items() if name.startswith(("g_", "orig_"))]
    end = BLOB_VADDR + len(code)
    problems = []
    for i in range(0, len(code), 4):
        pc = BLOB_VADDR + i
        (w,) = struct.unpack(">I", code[i : i + 4])
        op, rs, rt, rd, fn = w >> 26, (w >> 21) & 31, (w >> 16) & 31, (w >> 11) & 31, w & 63
        in_glue = any(a <= pc < b for a, b in glue)
        if op == 0 and fn == 9 and rs != 25:  # jalr
            problems.append(f"{pc:#x}: jalr through ${rs}, not $t9")
        if op in (2, 3):  # j, jal
            target = (pc & 0xF0000000) | ((w & 0x03FFFFFF) << 2)
            if not (BLOB_VADDR <= target < end or (in_glue and target in STOCK_JUMP_TARGETS)):
                problems.append(f"{pc:#x}: jump to {target:#x}")
        writes_gp = (op == 0 and rd == 28 and fn not in (8, 9, 12, 24, 25, 26, 27) and w != 0) or (
            op in (8, 9, 10, 11, 12, 13, 14, 15, 32, 33, 34, 35, 36, 37, 38) and rt == 28
        )
        set_gp = in_glue and (w >> 16) in (0x3C1C, 0x379C)  # lui $gp / ori $gp,$gp
        if writes_gp and not set_gp:
            problems.append(f"{pc:#x}: writes $gp ({w:08x})")
        if op >= 4 and op not in (15, 28, 31) and rs == 28 and not set_gp:  # $gp as a base or operand
            problems.append(f"{pc:#x}: uses $gp ({w:08x})")
        if (op == 28 and rd == 28) or (op == 31 and 28 in (rt, rd)):  # mul, ext/ins/seb/seh
            problems.append(f"{pc:#x}: writes $gp ({w:08x})")
        if op == 1 and rt in (16, 17):  # bltzal, bgezal
            problems.append(f"{pc:#x}: branch-and-link")
    if problems:
        sys.exit("hal_remotes: the compiled code breaks its rules:\n  " + "\n  ".join(problems))


def build(zig: str) -> tuple[dict, dict[str, int]]:
    with tempfile.TemporaryDirectory() as tmp:
        elf = compile_blob(zig, Path(tmp))
        text, code_len, data, sym, funcs = read_elf(elf)
    check_code(text[:code_len], sym, funcs)
    if BLOB_VADDR + len(text) > DATA_VADDR or len(data) > PDR_OFFSET + PDR_SIZE - (DATA_VADDR - BLOB_VADDR + PDR_OFFSET):
        sys.exit("hal_remotes: the build does not fit in .pdr")
    blob = text.ljust(DATA_VADDR - BLOB_VADDR, b"\0") + data
    blob = blob.ljust(PDR_SIZE, b"\0")

    edits = [
        {"offset": f"0x{PHDR7_OFFSET:05x}", "stock": PHDR7_STOCK.hex(), "patched": PHDR7_LOAD.hex(),
         "what": "spare program header: map the added code (file .pdr) at 0x473cd0"},
        {"offset": f"0x{PDR_OFFSET:05x}", "patched": blob.hex(),
         "what": "the added code, over .pdr (debugger data, not loaded by stock)"},
    ]  # fmt: skip
    for offset, stock, new, what in hooks(sym):
        edits.append({
            "offset": f"0x{offset:05x}",
            "stock": b"".join(struct.pack(">I", w) for w in stock).hex(),
            "patched": b"".join(struct.pack(">I", w) for w in new).hex(),
            "what": what,
        })  # fmt: skip
    multi = json.loads(MULTI_PATCH_FILE.read_text(encoding="utf-8"))
    if multi["stock_md5"] != STOCK_MD5:
        sys.exit("hal_multiremote_patch.json is for another hal")
    policy = range(0x27CDC, 0x27CF0)  # the same-model unpair, replaced by the gated one above
    for e in multi["edits"]:
        if int(e["offset"], 16) not in policy:
            edits.append({"offset": e["offset"], "stock": e["stock"], "patched": e["patched"],
                          "what": "multi-remote: key threads per slot (hal_multiremote_patch.json)"})  # fmt: skip
    edits.sort(key=lambda e: int(e["offset"], 16))
    spans = [(int(e["offset"], 16), int(e["offset"], 16) + len(e["patched"]) // 2) for e in edits]
    if any(a[1] > b[0] for a, b in zip(spans, spans[1:])):
        sys.exit("hal_remotes: edits overlap")

    sources = {name: hashlib.sha256((SRC / name).read_bytes()).hexdigest() for name in ("glue.s", "hal_remotes.c", "link.ld")}
    doc = {
        "description": "Two remotes with a screen, and multiple remotes of one model, in one hal "
        "(docs/TWO_SCREEN_REMOTES.md): edits to the hub's own /usr/bin/hal (firmware 4.15.600). "
        "The installers apply them to the hub's file; hal itself is never shipped. "
        "Built by tools/build_hal_remotes.py; do not edit by hand.",
        "file": "/usr/bin/hal",
        "size": STOCK_SIZE,
        "stock_md5": STOCK_MD5,
        "patched_md5": None,
        "gates_file": "/var/run/codex_hal_gates",
        "zig_version": ZIG_VERSION,
        "source_sha256": sources,
        "edits": edits,
    }
    return doc, sym


def apply(doc: dict, stock: bytes) -> bytes:
    if hashlib.md5(stock).hexdigest() != doc["stock_md5"] or len(stock) != doc["size"]:
        sys.exit("that is not the stock hal of firmware 4.15.600")
    out = bytearray(stock)
    for e in doc["edits"]:
        offset, new = int(e["offset"], 16), bytes.fromhex(e["patched"])
        if "stock" in e and bytes(out[offset : offset + len(new)]) != bytes.fromhex(e["stock"]):
            sys.exit(f"unexpected stock bytes at {offset:#x}")
        out[offset : offset + len(new)] = new
    return bytes(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="fail if the committed patch file differs from this build")
    ap.add_argument("--stock", type=Path, help="a stock hal (4.15.600) to pin the patched md5 against")
    ap.add_argument("--out", type=Path, help="write the patched hal here (with --stock)")
    ap.add_argument("--symbols", type=Path, help="write the added code's symbol addresses here (JSON)")
    args = ap.parse_args()

    doc, sym = build(find_zig())
    committed = json.loads(PATCH_FILE.read_text(encoding="utf-8")) if PATCH_FILE.exists() else None
    if args.stock:
        patched = apply(doc, args.stock.read_bytes())
        doc["patched_md5"] = hashlib.md5(patched).hexdigest()
        if args.out:
            args.out.write_bytes(patched)
    elif committed and {**committed, "patched_md5": None} == doc:
        doc["patched_md5"] = committed["patched_md5"]  # same edits, so the same result
    else:
        sys.exit("the edits changed: run again with --stock <stock hal> to pin the patched md5")
    if args.symbols:
        args.symbols.write_text(json.dumps(sym, indent=1, sort_keys=True) + "\n", encoding="utf-8")

    text = json.dumps(doc, indent=1) + "\n"
    if args.check:
        if not PATCH_FILE.exists() or PATCH_FILE.read_text(encoding="utf-8") != text:
            sys.exit(f"{PATCH_FILE.relative_to(ROOT)} is not what this source builds")
        print(f"ok {doc['patched_md5']}")
        return 0
    PATCH_FILE.write_text(text, encoding="utf-8")
    code_bytes = next(len(e["patched"]) // 2 for e in doc["edits"] if e["offset"] == f"0x{PDR_OFFSET:05x}")
    print(f"{PATCH_FILE.relative_to(ROOT)}: {len(doc['edits'])} edits, blob {code_bytes} bytes, patched md5 {doc['patched_md5']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
