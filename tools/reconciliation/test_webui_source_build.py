#!/usr/bin/env python3
"""Offline source/build tests for the exact-Zig artifacts (box-snapshot-20260818).

Phase 2 reconstructs the EXACT source tuples and build recipes for the five
deployed binaries built with Zig's bundled clang/LLD.  Two DISTINCT Zig
distributions are required and are NOT interchangeable:

  * WEBUI_ZIG    Homebrew Zig 0.16.0_1 (clang/LLD 21.1.8) — codex_webui only.
                 executable SHA-256
                 0bfa8cb6f5f64c6d645e1d5dfb5c6f62c2b79d7249c3f38a279e118cb49b02ae
  * OFFICIAL_ZIG Official Zig 0.16.0 (clang/LLD 21.1.0) — pair-agent, bthid,
                 HAL, HBus.
                 executable SHA-256
                 e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec

The exact source tuples (from the verified webui-repro and
zig-distribution-sweep pilot reports):

  codex_webui.c          aa173f177b8ac10270372a126b5b1d4bab41df9c
  activity_ui_assets.h   5dad607f7c09a0d5cc0034969b76e6c5df1eb2bc
  harmony_shell_assets.h ba6c4ce95dec58429ed965961904a1ac1cf7755c
  remote_skin_jpg.h      419611c5ff0713f1f5de2dd684d699f6d77238d5
  codex_hbus.c           d2bbcdef214369bff3dacf1836d6b5a0057f5ede (309cec3)

The worktree previously carried LATER, unbuilt drift of codex_webui.c (blob
d379d1fe) and codex_hbus.c (blob 19f535cd).  This lane intentionally rolls
back to the live-reproducing tuples because the later revisions were never
built into the deployed binaries.

Two layers:

  * Offline tests (always run): pinned SHA-256 and git blob IDs of the source
    files, the direct include closure, the build script's dual-Zig
    requirement (distinct executable SHA-256/version/fingerprint pins), the
    exact target/flags (including HBus -mcpu=mips32), the exact output
    hashes, no writes into payload/bin, and publication hygiene.

  * Real-evidence tests: when the read-only historical clone is identified
    by environment variable, the worktree sources are compared byte-for-byte
    against `git cat-file` of the pinned blobs.  Skipped otherwise.  No
    network, no box access, nothing written outside temp dirs.

Run:  python3 -m unittest tools.reconciliation.test_webui_source_build -v
"""

from __future__ import annotations

import hashlib
import os
import re
import subprocess
import unittest
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))

#: Real-evidence input is identified by ENVIRONMENT VARIABLE only — no
#: personal or machine-specific path is baked into this file.
SOURCE_REPO_ENV = "HARMONY_LINEAGE_SOURCE_REPO"
FALLBACK_SOURCE_REPO_ENV = "HARMONY_PROVENANCE_SOURCE_REPO"

REAL_SOURCE_REPO = (
    os.environ.get(SOURCE_REPO_ENV) or os.environ.get(FALLBACK_SOURCE_REPO_ENV) or ""
)

REAL_EVIDENCE_AVAILABLE = bool(
    REAL_SOURCE_REPO and os.path.isdir(os.path.join(REAL_SOURCE_REPO, ".git"))
)

SOURCE_DIR = os.path.join(REPO_ROOT, "payload", "source")
BUILD_SCRIPT = os.path.join(REPO_ROOT, "build", "build_harmony_tools_kali.sh")

#: relpath -> (git blob ID, SHA-256 of exact blob bytes, size).  Regression
#: constants from the verified pilot reports.
PINNED_SOURCES = {
    "codex_webui.c": (
        "aa173f177b8ac10270372a126b5b1d4bab41df9c",
        "8a4e536f8997c5b9b483c123633a6dde386c51f69f66ab7544357b4c32f54e5c",
        519094,
    ),
    "activity_ui_assets.h": (
        "5dad607f7c09a0d5cc0034969b76e6c5df1eb2bc",
        "2d8136d3ab970dceb55a875c82942ef934a3eba4f17413eb91604f3dbdfa74eb",
        502204,
    ),
    "harmony_shell_assets.h": (
        "ba6c4ce95dec58429ed965961904a1ac1cf7755c",
        "967d1e44f267b8713a5b411f9f1eeefebaf51268110676c0c317cb5b965390e5",
        1126675,
    ),
    "remote_skin_jpg.h": (
        "419611c5ff0713f1f5de2dd684d699f6d77238d5",
        "04433039af1e263bd88645cb42df40f71c4911bda7dba69d1ab0463c1030eb2b",
        87382,
    ),
    "codex_hbus.c": (
        "d2bbcdef214369bff3dacf1836d6b5a0057f5ede",
        "4b4ff376825f26607ec55f75685469831801f54b3f2af56e3d2d720a5d5d8ba8",
        12680,
    ),
}

#: exact live binary targets (verified pilot reports)
TARGETS = {
    "codex_webui": (
        "c400173bb42f735734c522556c69f6c80f0604949413eb974c7b361b9e4ac11a",
        906872,
    ),
    "codex_bt_pair_agent": (
        "563c6c58a3629edfebd7ec30ebcf14e6384a2d84e89669b1d7c3d79c75b619c8",
        111796,
    ),
    "codex_bthid_keyboard": (
        "c6a3c4cd0db3aab1bbdc92ae22e3ae2ffe11d442ac7fe0920b46a6da0b5cef13",
        116452,
    ),
    "codex_hal_ltcp": (
        "7fa9a84b9ee270bdf6e47d40859d29b6c1c30e5a1766f0ab59e9143dd13ca26c",
        76772,
    ),
    "codex_hbus": (
        "4be9e6ac2e09e7eb052f9c47e81480d1e32aee7190bedb6ef7f932cf07aab8f9",
        74660,
    ),
}

#: pinned Zig distribution executable SHA-256 + clang/LLD fingerprint
WEBUI_ZIG_SHA256 = (
    "0bfa8cb6f5f64c6d645e1d5dfb5c6f62c2b79d7249c3f38a279e118cb49b02ae")
WEBUI_ZIG_FINGERPRINT = "Homebrew clang version 21.1.8"
OFFICIAL_ZIG_SHA256 = (
    "e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec")
OFFICIAL_ZIG_FINGERPRINT = "clang version 21.1.0"

#: exact Zig build recipe fragments
ZIG_TARGET_FLAGS = "-target mips-linux-musleabi -Os -static -s"
ZIG_INCLUDE_FLAG = "-I payload/source"
ZIG_HBUS_MCPU = "-mcpu=mips32"
ZIG_VERSION_REQUIRED = "0.16.0"

#: absolute-path and identity fragments that must never appear in the files
#: this lane touches (built by concatenation so this file's own pattern
#: constants can never trip the hygiene check)
_USERS_PATH = "/Use" + "rs/"
_PERSONAL_NAME = "ma" + "tt"
_OWNER_TAG = "schlam" + "bo"
BANNED_FRAGMENTS = (
    _USERS_PATH, "/Docu" + "ments/", "/Co" + "dex/", "/Rep" + "os/",
    "/private" + "/tmp", "/var/" + "folders", "192.168" + ".",
)
_RE_BANNED_NAME = re.compile(
    r"\b" + "ma" + r"tt\b|schlam" + r"bo|ro" + r"ot@" + r"[0-9]",
    re.IGNORECASE,
)

#: The official Dropbear release mirror (its author's host) appears in the
#: pre-existing build script and is upstream infrastructure, not a
#: lane-introduced identity leak.  Built by concatenation so this file never
#: contains the contiguous name either.
_UPSTREAM_DROPBEAR_HOST = "ma" + "tt.ucc.asn.au"

RE_BLOB = re.compile(r"\A[0-9a-f]{40}\Z")
RE_SHA256 = re.compile(r"\A[0-9a-f]{64}\Z")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git_blob_id(data: bytes) -> str:
    """Git blob object ID for exact bytes (no repo needed)."""
    header = b"blob %d\x00" % len(data)
    return hashlib.sha1(header + data).hexdigest()


def read_bytes(path: str) -> bytes:
    with open(path, "rb") as fh:
        return fh.read()


def run_git(repo: str, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(
        ["git", "-c", "commit.gpgsign=false", "-C", repo, *args],
        capture_output=True,
    )
    if check and proc.returncode != 0:
        raise AssertionError(
            "git %s failed: %s" % (list(args), proc.stderr.decode()[:400])
        )
    return proc


class OfflineWebuiSourceBuildTests(unittest.TestCase):
    """Always-run checks against pinned constants; no historical repo."""

    def test_pinned_constants_are_well_formed(self):
        for name, (blob, sha, size) in PINNED_SOURCES.items():
            self.assertRegex(blob, RE_BLOB, name)
            self.assertRegex(sha, RE_SHA256, name)
            self.assertGreater(size, 0, name)
        for name, (sha, size) in TARGETS.items():
            self.assertRegex(sha, RE_SHA256, name)
            self.assertGreater(size, 0, name)
        self.assertRegex(WEBUI_ZIG_SHA256, RE_SHA256)
        self.assertRegex(OFFICIAL_ZIG_SHA256, RE_SHA256)

    def test_sources_match_pinned_sha256_and_size(self):
        for name, (_blob, sha, size) in PINNED_SOURCES.items():
            path = os.path.join(SOURCE_DIR, name)
            data = read_bytes(path)
            self.assertEqual(
                sha256_bytes(data), sha,
                "%s: SHA-256 drift from pinned blob" % name)
            self.assertEqual(
                len(data), size,
                "%s: size drift from pinned blob" % name)

    def test_sources_match_pinned_git_blob_ids(self):
        for name, (blob, _sha, _size) in PINNED_SOURCES.items():
            path = os.path.join(SOURCE_DIR, name)
            data = read_bytes(path)
            self.assertEqual(
                git_blob_id(data), blob,
                "%s: git blob ID drift from pinned blob" % name)

    def test_direct_include_closure_no_nested_includes(self):
        """codex_webui.c includes exactly the three asset headers (plus
        system headers); the asset headers must not include anything."""
        webui = read_bytes(os.path.join(SOURCE_DIR, "codex_webui.c")).decode(
            "utf-8", errors="replace")
        for name in ("activity_ui_assets.h", "harmony_shell_assets.h",
                     "remote_skin_jpg.h"):
            self.assertIn('#include "%s"' % name, webui, name)
        for name in ("activity_ui_assets.h", "harmony_shell_assets.h",
                     "remote_skin_jpg.h"):
            header = read_bytes(os.path.join(SOURCE_DIR, name)).decode(
                "utf-8", errors="replace")
            self.assertNotIn("#include", header,
                             "%s must not include anything" % name)

    def test_build_script_requires_zig_0160(self):
        script = read_bytes(BUILD_SCRIPT).decode("utf-8", errors="replace")
        self.assertIn('"0.16.0"', script)
        self.assertIn("zig", script)
        self.assertIn("exit 1", script)

    def test_build_script_pins_both_zig_distributions(self):
        script = read_bytes(BUILD_SCRIPT).decode("utf-8", errors="replace")
        # distinct executable SHA-256 pins
        self.assertIn(WEBUI_ZIG_SHA256, script)
        self.assertIn(OFFICIAL_ZIG_SHA256, script)
        # distinct clang/LLD fingerprints
        self.assertIn(WEBUI_ZIG_FINGERPRINT, script)
        self.assertIn(OFFICIAL_ZIG_FINGERPRINT, script)
        # distinct variable names
        self.assertIn("WEBUI_ZIG", script)
        self.assertIn("OFFICIAL_ZIG", script)
        # no absolute private default paths (built by concatenation so this
        # file's own hygiene scan never trips on the literal)
        self.assertNotIn("/opt/" + "homebrew", script)
        self.assertNotIn("/Use" + "rs/", script)

    def test_build_script_uses_exact_zig_target_and_flags(self):
        script = read_bytes(BUILD_SCRIPT).decode("utf-8", errors="replace")
        self.assertIn(ZIG_TARGET_FLAGS, script)
        self.assertIn(ZIG_INCLUDE_FLAG, script)
        self.assertIn("-o build/output/codex_webui", script)
        self.assertIn("payload/source/codex_webui.c", script)
        # HBus requires -mcpu=mips32
        self.assertIn(ZIG_HBUS_MCPU, script)
        self.assertIn("-o build/output/codex_hbus", script)
        self.assertIn("payload/source/codex_hbus.c", script)
        # the other three official-Zig outputs
        for name in ("codex_bt_pair_agent", "codex_bthid_keyboard",
                     "codex_hal_ltcp"):
            self.assertIn("-o build/output/%s" % name, script)
            self.assertIn("payload/source/%s.c" % name, script)

    def test_build_script_never_writes_payload_bin(self):
        """Outputs go only to build/output; the repository payload/bin tree
        is never a build target."""
        script = read_bytes(BUILD_SCRIPT).decode("utf-8", errors="replace")
        # the old GCC lines for the four Zig-built binaries must be gone
        for name in ("codex_hbus", "codex_hal_ltcp", "codex_bthid_keyboard",
                     "codex_bt_pair_agent", "codex_webui"):
            self.assertNotIn(
                '"$CC" -Os -static -s -o "$OUT/%s"' % name, script, name)
        self.assertNotIn("payload/bin", script)
        self.assertNotIn("payload/bin", script.replace(" ", ""))

    def test_build_script_pins_exact_output_hashes(self):
        script = read_bytes(BUILD_SCRIPT).decode("utf-8", errors="replace")
        for name, (sha, size) in TARGETS.items():
            self.assertIn(sha, script, name)
            self.assertIn(str(size), script, name)
        self.assertIn("WEBUI_EXPECT_SHA256", script)
        self.assertIn("PAIR_EXPECT_SHA256", script)
        self.assertIn("BTHID_EXPECT_SHA256", script)
        self.assertIn("HAL_EXPECT_SHA256", script)
        self.assertIn("HBUS_EXPECT_SHA256", script)

    def test_build_script_preserves_bootlin_gcc_dhcpd_portal(self):
        script = read_bytes(BUILD_SCRIPT).decode("utf-8", errors="replace")
        self.assertIn('"$CC" -Os -static -s -o "$OUT/codex_dhcpd"', script)
        self.assertIn('"$CC" -Os -static -s -o "$OUT/codex_portal"', script)

    def test_publication_hygiene_of_lane_files(self):
        lane_files = [
            os.path.join(SOURCE_DIR, name) for name in PINNED_SOURCES
        ] + [BUILD_SCRIPT, os.path.abspath(__file__)]
        for path in lane_files:
            data = read_bytes(path)
            text = data.decode("utf-8", errors="replace")
            for fragment in BANNED_FRAGMENTS:
                self.assertNotIn(fragment, text, "%s leaks %r" % (path, fragment))
            scanned = text.replace(_UPSTREAM_DROPBEAR_HOST, "<dropbear-mirror>")
            match = _RE_BANNED_NAME.search(scanned)
            self.assertIsNone(
                match, "%s leaks identity fragment %r" % (path, match and match.group(0)))


@unittest.skipUnless(
    REAL_EVIDENCE_AVAILABLE,
    "read-only historical clone not identified "
    "(set %s or %s)" % (SOURCE_REPO_ENV, FALLBACK_SOURCE_REPO_ENV),
)
class RealEvidenceWebuiSourceTests(unittest.TestCase):
    """Byte-level comparison against `git cat-file` of the pinned blobs."""

    def test_worktree_sources_identical_to_pinned_blobs(self):
        for name, (blob, sha, _size) in PINNED_SOURCES.items():
            shown = run_git(
                REAL_SOURCE_REPO, "cat-file", "blob", blob).stdout
            self.assertEqual(
                sha256_bytes(shown), sha,
                "%s: historical blob does not hash to the pinned constant" % name)
            local = read_bytes(os.path.join(SOURCE_DIR, name))
            self.assertEqual(
                local, shown,
                "%s: worktree bytes differ from the pinned blob" % name)


if __name__ == "__main__":
    unittest.main()
