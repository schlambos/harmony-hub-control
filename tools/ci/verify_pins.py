#!/usr/bin/env python3
"""Check that every pin of a shipped binary matches the committed file.

The pins live in several files, and nothing compared them until now:

  payload/bin/MANIFEST.txt             size and MD5 of each payload/bin binary
  build/build_harmony_tools_kali.sh    *_EXPECT_SHA256 / *_EXPECT_SIZE
  docs/BUILD.md                        the size/SHA-256 table, "size N, SHA-256"
                                       sentences, and source blob ids
  payload/modules/usb-net/README.md    size, SHA-256 and MD5 of each module

No build and no toolchain: this only reads the tree, so it is the fast half of
the gate. tools/ci/rebuild_check.sh is the other half (does the source build
these exact files).

  python3 tools/ci/verify_pins.py
"""
from __future__ import annotations

import hashlib
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = "payload/bin/MANIFEST.txt"
BUILD_SCRIPT = "build/build_harmony_tools_kali.sh"
BUILD_MD = "docs/BUILD.md"
MODULES_README = "payload/modules/usb-net/README.md"

#: the build script's variable prefix for each binary it pins
SCRIPT_PINS = {
    "WEBUI": "payload/bin/codex_webui",
    "PAIR": "payload/bin/codex_bt_pair_agent",
    "BTHID": "payload/bin/codex_bthid_keyboard",
    "HAL": "payload/bin/codex_hal_ltcp",
    "HBUS": "payload/bin/codex_hbus",
    "DHCPD": "payload/bin/codex_dhcpd",
    "PORTAL": "payload/bin/codex_portal",
    "ANDROIDTV": "payload/bin/codex_androidtv",
    "USBETH": "payload/bin/codex_usbeth",
    "BUSYBOX": "payload/bin/busybox-extra",
    "DROPBEAR": "payload/bin/dropbearmulti",
    "FLASHFREE": "payload/helpers/codex_flash_free",
}
#: payload/bin files that are lists, not binaries
INVENTORY_FILES = {"MANIFEST.txt", "FILES"}


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

    def manifest(self) -> None:
        sizes: dict[str, int] = {}
        md5s: dict[str, str] = {}
        for line in self.text(MANIFEST).splitlines():
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
        shipped = {p.name for p in (self.root / "payload/bin").iterdir() if p.is_file()} - INVENTORY_FILES
        for name in sorted(shipped - set(md5s)):
            self.problems.append(f"{MANIFEST}: payload/bin/{name} has no MD5 line")
        for name in sorted(shipped - set(sizes)):
            self.problems.append(f"{MANIFEST}: payload/bin/{name} has no size line")

    def build_script(self) -> None:
        text = self.text(BUILD_SCRIPT)
        seen = set()
        for prefix, kind, value in re.findall(r"^([A-Z]+)_EXPECT_(SHA256|SIZE)=(\S+)$", text, re.M):
            rel = SCRIPT_PINS.get(prefix)
            if rel is None:
                self.problems.append(f"{BUILD_SCRIPT}: {prefix}_EXPECT_{kind} pins a binary tools/ci/verify_pins.py doesn't know")
                continue
            seen.add((prefix, kind))
            self.expect(BUILD_SCRIPT, rel, "sha256" if kind == "SHA256" else "size",
                        value if kind == "SHA256" else int(value))
        for prefix, rel in SCRIPT_PINS.items():
            for kind in ("SHA256", "SIZE"):
                if (prefix, kind) not in seen:
                    self.problems.append(f"{BUILD_SCRIPT}: no {prefix}_EXPECT_{kind} for {rel}")

    def build_md(self) -> None:
        text = self.text(BUILD_MD)
        # | `name` | size | `sha256` |
        for name, size, sha in re.findall(r"^\| `([\w.-]+)` \| (\d+) \| `([0-9a-f]{64})` \|$", text, re.M):
            rel = f"payload/bin/{name}"
            self.expect(f"{BUILD_MD} table", rel, "size", int(size))
            self.expect(f"{BUILD_MD} table", rel, "sha256", sha)
        # "size N, SHA-256 `...`" under a "### name" heading; a hash from history
        # (an older build the text explains) is not under such a heading
        by_sha = {self.digests(rel)["sha256"]: rel for rel in SCRIPT_PINS.values() if self.digests(rel)}
        for section in re.split(r"^#{2,3} ", text, flags=re.M)[1:]:
            heading = section.split("\n", 1)[0]
            name = re.match(r"([\w-]+)", heading)
            rel = next((r for r in SCRIPT_PINS.values() if name and r.endswith("/" + name.group(1))), None)
            if rel is None:
                continue
            for size, sha in re.findall(r"size (\d+),\s+SHA-256\s+`([0-9a-f]{64})`", section):
                self.expect(f"{BUILD_MD} '{heading}'", rel, "size", int(size))
                self.expect(f"{BUILD_MD} '{heading}'", rel, "sha256", sha)
                if by_sha.get(sha, rel) != rel:
                    self.problems.append(f"{BUILD_MD} '{heading}': SHA-256 {sha} belongs to {by_sha[sha]}")
        # `payload/source/x` — `blob id`, and (`payload/source/x` blob `id`)
        blobs = re.findall(r"`(payload/source/[\w./-]+)` — `([0-9a-f]{40})`", text)
        blobs += re.findall(r"`(payload/source/[\w./-]+)`\s+blob\s+`([0-9a-f]{40})`", text)
        for rel, blob in blobs:
            self.checked += 1
            if not (self.root / rel).is_file():
                self.problems.append(f"{BUILD_MD}: pins {rel}, which is not in the tree")
                continue
            actual = subprocess.run(["git", "hash-object", rel], cwd=self.root, check=True,
                                    capture_output=True, text=True).stdout.strip()
            if actual != blob:
                self.problems.append(f"{BUILD_MD}: {rel} blob is pinned as {blob}, the file is {actual}")

    def modules(self) -> None:
        readme = self.root / MODULES_README
        if not readme.is_file():
            return
        rows = re.findall(r"^\| `([\w.-]+\.ko)` \| (\d+) \| `([0-9a-f]{64})` \| `([0-9a-f]{32})` \|",
                          readme.read_text(encoding="utf-8"), re.M)
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
        self.manifest()
        self.build_script()
        self.build_md()
        self.modules()
        return self.problems


def main() -> int:
    checker = Checker(ROOT)
    problems = checker.run()
    for problem in problems:
        print(f"stale pin: {problem}", file=sys.stderr)
    if problems:
        print(f"verify_pins: {len(problems)} of {checker.checked} pins don't match the committed files", file=sys.stderr)
        return 1
    print(f"verify_pins: ok, {checker.checked} pins match the committed files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
