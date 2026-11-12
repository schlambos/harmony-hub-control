#!/usr/bin/env python3
"""Check that two 32-bit big-endian ELF executables load the same image.

Usage: python3 tools/elf_load_cmp.py A B [A2 B2 ...]

Compares the ELF header, the whole program header table and the file bytes
of every segment (PT_LOAD, and the ones the kernel reads by offset such as
PT_MIPS_ABIFLAGS or PT_INTERP). The header's section-table fields (e_shoff,
e_shnum, e_shstrndx) are masked first, wherever they appear: the loader
never reads them, and they change whenever a non-loaded section such as
.pdr or .comment is dropped. Every pair is checked. Exit status 0 if all
match, 1 if any differs, 2 if any file is unreadable or malformed.
"""

import struct
import sys


class Malformed(Exception):
    pass


def load_image(path):
    data = bytearray(open(path, "rb").read())
    if len(data) < 52 or data[:4] != b"\x7fELF" or data[4] != 1 or data[5] != 2:
        raise Malformed(f"{path}: not a 32-bit big-endian ELF file")
    data[32:36] = bytes(4)  # e_shoff
    data[48:52] = bytes(4)  # e_shnum, e_shstrndx
    header = bytes(data[:52])  # e_ident .. e_shstrndx, masked: e_entry, e_flags, e_phoff, ...
    phoff = struct.unpack(">I", data[28:32])[0]
    phentsize, phnum = struct.unpack(">HH", data[42:46])
    if phentsize < 32 or phoff + phnum * phentsize > len(data):
        raise Malformed(f"{path}: program header table runs past the end of the file")
    headers, segments = [], []
    for i in range(phnum):
        raw = bytes(data[phoff + i * phentsize: phoff + (i + 1) * phentsize])
        headers.append(raw)
        _type, p_offset, _vaddr, _paddr, p_filesz = struct.unpack(">5I", raw[:20])
        if p_offset + p_filesz > len(data):
            raise Malformed(f"{path}: segment {i} runs past the end of the file")
        segments.append(bytes(data[p_offset: p_offset + p_filesz]))
    return header, headers, segments


def main(argv):
    if len(argv) < 2 or len(argv) % 2:
        print(__doc__, file=sys.stderr)
        return 2
    status = 0
    for a, b in zip(argv[::2], argv[1::2]):
        try:
            same = load_image(a) == load_image(b)
        except (Malformed, OSError) as e:
            print(f"error: {e}", file=sys.stderr)
            status = 2
            continue
        if not same:
            status = max(status, 1)
        print(f"{'same loaded image' if same else 'DIFFERENT'}: {a} {b}")
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
