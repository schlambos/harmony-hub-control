#!/usr/bin/env python3
"""Check that every pin of a shipped binary matches the committed file.

Each binary's SHA-256 and size have a single home under build/pins/<name>:

  build/pins/<name>                    SHA256 and SIZE of each shipped binary
  payload/bin/MANIFEST.txt             deterministic size and MD5 inventory
  payload/modules/usb-net/README.md    size, SHA-256 and MD5 of each module

build/build_harmony_tools_kali.sh reads build/pins/<name> directly, and
docs/BUILD.md keeps the build recipes without repeating digests, sizes or git
source-blob hashes. This script checks all three invariants plus byte-exact
canonical formatting of payload/bin/MANIFEST.txt.

  python3 tools/ci/verify_pins.py
  python3 tools/ci/verify_pins.py --write-manifest
"""
from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PINS_DIR = "build/pins"
MANIFEST = "payload/bin/MANIFEST.txt"
BUILD_SCRIPT = "build/build_harmony_tools_kali.sh"
BUILD_MD = "docs/BUILD.md"
MODULES_README = "payload/modules/usb-net/README.md"
CANONICAL_MTIME = "1970-01-01 00:00"

#: shipped binaries pinned under build/pins/<name> -> repo-relative path
PINNED_BINARIES = {
    "busybox-extra": "payload/bin/busybox-extra",
    "codex_androidtv": "payload/bin/codex_androidtv",
    "codex_bt_pair_agent": "payload/bin/codex_bt_pair_agent",
    "codex_bthid_keyboard": "payload/bin/codex_bthid_keyboard",
    "codex_dhcpd": "payload/bin/codex_dhcpd",
    "codex_flash_free": "payload/helpers/codex_flash_free",
    "codex_hal_ltcp": "payload/bin/codex_hal_ltcp",
    "codex_hbus": "payload/bin/codex_hbus",
    "codex_portal": "payload/bin/codex_portal",
    "codex_usbeth": "payload/bin/codex_usbeth",
    "codex_webui": "payload/bin/codex_webui",
    "dropbearmulti": "payload/bin/dropbearmulti",
}

#: payload/bin files that are lists, not binaries
INVENTORY_FILES = {"MANIFEST.txt", "FILES", "MD5SUMS"}


def shipped_bin_names(bin_dir: Path) -> list[str]:
    if not bin_dir.is_dir():
        return []
    return sorted(
        p.name
        for p in bin_dir.iterdir()
        if p.is_file() and not p.is_symlink() and p.name not in INVENTORY_FILES
    )


def format_manifest(bin_dir: Path) -> str:
    """Return the canonical deterministic MANIFEST.txt for `bin_dir`."""
    names = shipped_bin_names(bin_dir)
    listings: list[str] = []
    digests: list[str] = []
    for name in names:
        data = (bin_dir / name).read_bytes()
        listings.append(f"-rwxr-xr-x 1 codex codex {len(data)} {CANONICAL_MTIME} {name}\n")
        digests.append(f"{hashlib.md5(data).hexdigest()}  {name}\n")
    return "".join(listings + digests)


def write_manifest(bin_dir: Path) -> Path:
    target = bin_dir / "MANIFEST.txt"
    target.write_bytes(format_manifest(bin_dir).encode("utf-8"))
    return target


class Checker:
    def __init__(self, root: Path):
        self.root = root
        self.problems: list[str] = []
        self.checked = 0
        self._digests: dict[str, dict[str, object]] = {}

    def text(self, rel: str) -> str:
        return (self.root / rel).read_text(encoding="utf-8")

    def digests(self, rel: str) -> dict[str, object] | None:
        if rel not in self._digests:
            path = self.root / rel
            if not path.is_file():
                return None
            data = path.read_bytes()
            self._digests[rel] = {
                "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "md5": hashlib.md5(data).hexdigest(),
            }
        return self._digests[rel]

    def expect(self, where: str, rel: str, kind: str, pinned: object) -> None:
        """One pin: `where` says `rel`'s `kind` is `pinned`."""
        self.checked += 1
        actual = self.digests(rel)
        if actual is None:
            self.problems.append(f"{where}: pins {rel}, which is not in the tree")
        elif actual[kind] != pinned:
            self.problems.append(f"{where}: {rel} {kind} is pinned as {pinned}, the file is {actual[kind]}")

    def pins_dir(self) -> None:
        pins_root = self.root / PINS_DIR
        if not pins_root.is_dir():
            self.problems.append(f"{PINS_DIR}: directory is missing")
            return
        expected_names = set(PINNED_BINARIES)
        for name in shipped_bin_names(self.root / "payload/bin"):
            expected_names.add(name)
        actual_files = {p.name for p in pins_root.iterdir() if p.is_file()}
        for extra in sorted(actual_files - expected_names):
            self.problems.append(f"{PINS_DIR}/{extra}: pins unknown binary {extra}")
        for name in sorted(expected_names):
            rel = PINNED_BINARIES.get(name, f"payload/bin/{name}")
            pin_rel = f"{PINS_DIR}/{name}"
            pin_path = self.root / pin_rel
            if not pin_path.is_file():
                self.problems.append(f"{pin_rel}: missing pin file for {rel}")
                continue
            raw = pin_path.read_bytes()
            if b"\r" in raw:
                self.problems.append(f"{pin_rel}: contains CR line endings (must be LF)")
            kv: dict[str, str] = {}
            for line in raw.decode("utf-8", "replace").splitlines():
                if not line.strip() or line.startswith("#"):
                    self.problems.append(f"{pin_rel}: unexpected line: {line}")
                    continue
                m = re.match(r"^([A-Z0-9_]+)=(\S+)$", line)
                if not m or m.group(1) not in {"SHA256", "SIZE"} or m.group(1) in kv:
                    self.problems.append(f"{pin_rel}: invalid pin line: {line}")
                    continue
                kv[m.group(1)] = m.group(2)
            if "SHA256" not in kv or not re.match(r"^[0-9a-f]{64}$", kv["SHA256"]):
                self.problems.append(f"{pin_rel}: missing or invalid SHA256")
            else:
                self.expect(pin_rel, rel, "sha256", kv["SHA256"])
            if "SIZE" not in kv or not kv["SIZE"].isdigit():
                self.problems.append(f"{pin_rel}: missing or invalid SIZE")
            else:
                self.expect(pin_rel, rel, "size", int(kv["SIZE"]))
            if "SHA256" in kv and "SIZE" in kv:
                canonical = f"SHA256={kv['SHA256']}\nSIZE={kv['SIZE']}\n".encode("utf-8")
                if raw != canonical:
                    self.problems.append(f"{pin_rel}: not in canonical 'SHA256=...\\nSIZE=...\\n' order")

    def manifest(self) -> None:
        manifest_path = self.root / MANIFEST
        if not manifest_path.is_file():
            self.problems.append(f"{MANIFEST}: missing")
            return
        raw = manifest_path.read_bytes()
        if b"\r" in raw:
            self.problems.append(f"{MANIFEST}: contains CR line endings (must be LF)")
        text = raw.decode("utf-8", "replace")
        sizes: dict[str, int] = {}
        md5s: dict[str, str] = {}
        for line in text.splitlines():
            listing = re.match(r"^-\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+.*\s(\S+)$", line)
            digest = re.match(r"^([0-9a-f]{32})\s+(\S+)$", line)
            if listing:
                sizes[listing.group(2)] = int(listing.group(1))
            elif digest:
                md5s[digest.group(2)] = digest.group(1)
            elif line.strip():
                self.problems.append(f"{MANIFEST}: unrecognised line: {line}")
        for name, size in sizes.items():
            self.expect(MANIFEST, f"payload/bin/{name}", "size", size)
        for name, md5 in md5s.items():
            self.expect(MANIFEST, f"payload/bin/{name}", "md5", md5)
        shipped = set(shipped_bin_names(self.root / "payload/bin"))
        for name in sorted(shipped - set(md5s)):
            self.problems.append(f"{MANIFEST}: payload/bin/{name} has no MD5 line")
        for name in sorted(shipped - set(sizes)):
            self.problems.append(f"{MANIFEST}: payload/bin/{name} has no size line")
        for name in sorted((set(md5s) | set(sizes)) - shipped):
            self.problems.append(f"{MANIFEST}: lists {name}, which is not in payload/bin")
        self.checked += 1
        canonical = format_manifest(self.root / "payload/bin")
        if text != canonical:
            self.problems.append(
                f"{MANIFEST}: does not match canonical deterministic generator output "
                "(run sh tools/repin.sh or python3 tools/ci/verify_pins.py --write-manifest)"
            )

    def single_home(self) -> None:
        script_path = self.root / BUILD_SCRIPT
        if script_path.is_file():
            text = self.text(BUILD_SCRIPT)
            self.checked += 1
            for prefix, kind in re.findall(r"^([A-Z]+)_EXPECT_(SHA256|SIZE)=\S+$", text, re.M):
                self.problems.append(
                    f"{BUILD_SCRIPT}: inline {prefix}_EXPECT_{kind} must live in {PINS_DIR}/ instead"
                )
            if "check_pin " not in text:
                self.problems.append(f"{BUILD_SCRIPT}: does not verify built binaries via check_pin / {PINS_DIR}/")

        md_path = self.root / BUILD_MD
        if md_path.is_file():
            text = self.text(BUILD_MD)
            self.checked += 1
            for name, _size, _sha in re.findall(r"^\| `([\w.-]+)` \| (\d+) \| `([0-9a-f]{64})` \|$", text, re.M):
                self.problems.append(
                    f"{BUILD_MD}: duplicate digest table row for {name} (pins belong in {PINS_DIR}/{name})"
                )
            for _size, sha in re.findall(r"size (\d+),\s+SHA-256\s+`([0-9a-f]{64})`", text):
                self.problems.append(
                    f"{BUILD_MD}: duplicate 'size N, SHA-256 {sha[:12]}...' pin (pins belong in {PINS_DIR}/)"
                )
            blobs = re.findall(r"`(payload/source/[\w./-]+)` — `([0-9a-f]{40})`", text)
            blobs += re.findall(r"`(payload/source/[\w./-]+)`\s+blob\s+`([0-9a-f]{40})`", text)
            for rel, blob in blobs:
                self.problems.append(
                    f"{BUILD_MD}: duplicate source blob hash {blob[:12]}... for {rel}"
                )

    def modules(self) -> None:
        readme = self.root / MODULES_README
        if not readme.is_file():
            return
        rows = re.findall(
            r"^\| `([\w.-]+\.ko)` \| (\d+) \| `([0-9a-f]{64})` \| `([0-9a-f]{32})` \|",
            readme.read_text(encoding="utf-8"),
            re.M,
        )
        for name, size, sha, md5 in rows:
            rel = f"payload/modules/usb-net/{name}"
            self.expect(MODULES_README, rel, "size", int(size))
            self.expect(MODULES_README, rel, "sha256", sha)
            self.expect(MODULES_README, rel, "md5", md5)
        pinned = {row[0] for row in rows}
        for path in sorted((self.root / "payload/modules/usb-net").glob("*.ko")):
            if path.name not in pinned:
                self.problems.append(f"{MODULES_README}: {path.name} has no row")

    def run(self) -> list[str]:
        self.pins_dir()
        self.manifest()
        self.single_home()
        self.modules()
        return self.problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help="repository root")
    parser.add_argument(
        "--write-manifest",
        nargs="?",
        const="payload/bin",
        metavar="BIN_DIR",
        help="write canonical deterministic MANIFEST.txt in BIN_DIR (default: payload/bin)",
    )
    args = parser.parse_args(argv)
    root = args.root.resolve()
    if args.write_manifest is not None:
        bin_dir = Path(args.write_manifest)
        if not bin_dir.is_absolute():
            bin_dir = root / bin_dir
        write_manifest(bin_dir)
        return 0

    checker = Checker(root)
    problems = checker.run()
    for problem in problems:
        print(f"stale pin: {problem}", file=sys.stderr)
    if problems:
        print(
            f"verify_pins: {len(problems)} problem(s) across {checker.checked} checks",
            file=sys.stderr,
        )
        return 1
    print(f"verify_pins: ok, {checker.checked} pins match the committed files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
