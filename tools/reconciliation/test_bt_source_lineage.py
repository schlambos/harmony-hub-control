#!/usr/bin/env python3
"""Offline source-lineage tests for the BT trio (box-snapshot-20260818, lane B).

Phase 2 lane B reconstructs local source lineage ONLY: the three Bluetooth
tool sources under payload/source/ are pinned to the exact blobs of full
commit 09d83b67367cb46e32579e4b3c2ccb13a8cc24ad in the private historical
clone, and build/build_harmony_tools_kali.sh gained that commit's pair-agent
compile line and inventory entries (its pre-build smoke-tool invocations are
deliberately NOT carried over: those scripts do not exist in this repo).

Two layers:

  * Offline tests (always run): pinned SHA-256 and git blob IDs of the three
    imported sources, the exact 09d pair-agent compile line and inventory
    placement in the build script, no writes into payload/bin by the build,
    no tracked-binary drift under payload/bin, and publication hygiene of
    every file this lane is allowed to touch.

  * Real-evidence tests: when the read-only historical clone is identified
    by environment variable, the worktree sources are compared byte-for-byte
    against `git show` of commit 09d and its ls-tree blob IDs, and the build
    script's pair-agent line is checked verbatim against the 09d recipe.
    Skipped otherwise.  No network, no box access, nothing written outside
    temp dirs.

Build reproducibility of codex_bt_pair_agent is UNVERIFIED by these tests
and awaits the separate cross-toolchain pilot.

Run:  python3 -m unittest tools.reconciliation.test_bt_source_lineage -v
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

#: Full commit whose blobs are the authoritative source lineage for the BT
#: trio.  Never shortened: short hashes are ambiguous across clones.
LINEAGE_COMMIT = "09d83b67367cb46e32579e4b3c2ccb13a8cc24ad"

#: Real-evidence input is identified by ENVIRONMENT VARIABLE only — no
#: personal or machine-specific path is baked into this file.  The primary
#: variable is lane-specific; HARMONY_PROVENANCE_SOURCE_REPO (already used
#: by test_derive_provenance for the same read-only historical clone) is
#: accepted as a fallback so a single environment drives both modules.
SOURCE_REPO_ENV = "HARMONY_LINEAGE_SOURCE_REPO"
FALLBACK_SOURCE_REPO_ENV = "HARMONY_PROVENANCE_SOURCE_REPO"

REAL_SOURCE_REPO = (
    os.environ.get(SOURCE_REPO_ENV) or os.environ.get(FALLBACK_SOURCE_REPO_ENV) or ""
)


def _repo_env_candidate() -> str:
    return REAL_SOURCE_REPO


REAL_EVIDENCE_AVAILABLE = bool(
    REAL_SOURCE_REPO
    and os.path.isdir(os.path.join(REAL_SOURCE_REPO, ".git"))
)

SOURCE_DIR = os.path.join(REPO_ROOT, "payload", "source")
BUILD_SCRIPT = os.path.join(REPO_ROOT, "build", "build_harmony_tools_kali.sh")

#: relpath -> (git blob ID at 09d, SHA-256 of exact blob bytes).  Both are
#: regression constants: the git blob IDs come from
#: `git ls-tree 09d83b6 -- payload/source/` and the SHA-256 sums from
#: hashing those exact blobs.
PINNED_SOURCES = {
    "codex_bt_pair_agent.c": (
        "be5be52aa32d00f4ef19c64477dd2b1422b1beca",
        "070278725b6d2a4b9590efb4e126e07f68e5f67930da33b7cd65ac0f00dad8c5",
    ),
    "codex_bthid_keyboard.c": (
        "cfb831152ccd576ea5bb307e71c687212c60c684",
        "fcfc5c9c44ce5c0ea599dd51082d8341ef75de255b9979f78233c9d8e59c0375",
    ),
    "codex_hal_ltcp.c": (
        "03ba4c72cccd173606cde7c63f51e421c42f2fdc",
        "a24dc967d610af9cb6e59c35822c84f7ae7a4ed8a2a3efdfd43f9b5972dd103d",
    ),
}

#: exact 09d build recipe lines this lane must reproduce
PAIR_AGENT_COMPILE_LINE = (
    '"$CC" -Os -static -s -o "$OUT/codex_bt_pair_agent"'
    ' "$SRC/codex_bt_pair_agent.c"'
)
BTHID_COMPILE_LINE = (
    '"$CC" -Os -static -s -o "$OUT/codex_bthid_keyboard"'
    ' "$SRC/codex_bthid_keyboard.c"'
)
HAL_COMPILE_LINE = (
    '"$CC" -Os -static -s -o "$OUT/codex_hal_ltcp" "$SRC/codex_hal_ltcp.c"'
)

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
#: pre-existing build script — at 09d and in this repo's HEAD alike — and is
#: upstream infrastructure, not a lane-introduced identity leak.  Built by
#: concatenation so this file never contains the contiguous name either.
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


class OfflineLineageTests(unittest.TestCase):
    """Always-run checks against pinned constants; no historical repo."""

    def test_pinned_constants_are_well_formed(self):
        for name, (blob, sha) in PINNED_SOURCES.items():
            self.assertTrue(name.endswith(".c"), name)
            self.assertRegex(blob, RE_BLOB)
            self.assertRegex(sha, RE_SHA256)
        self.assertRegex(LINEAGE_COMMIT, RE_BLOB)

    def test_sources_match_pinned_sha256(self):
        for name, (_blob, sha) in PINNED_SOURCES.items():
            path = os.path.join(SOURCE_DIR, name)
            data = read_bytes(path)
            self.assertEqual(
                sha256_bytes(data), sha,
                "%s: SHA-256 drift from pinned 09d blob" % name,
            )

    def test_sources_match_pinned_git_blob_ids(self):
        for name, (blob, _sha) in PINNED_SOURCES.items():
            path = os.path.join(SOURCE_DIR, name)
            data = read_bytes(path)
            self.assertEqual(
                git_blob_id(data), blob,
                "%s: git blob ID drift from pinned 09d blob" % name,
            )

    def test_pair_agent_source_exists_and_is_not_empty(self):
        path = os.path.join(SOURCE_DIR, "codex_bt_pair_agent.c")
        self.assertTrue(os.path.isfile(path), path)
        self.assertGreater(len(read_bytes(path)), 1024)

    # -- build script ------------------------------------------------------

    def setUp_build_script(self) -> str:
        with open(BUILD_SCRIPT, "r", encoding="utf-8") as fh:
            return fh.read()

    def test_build_script_compiles_pair_agent_with_09d_recipe(self):
        script = self.setUp_build_script()
        self.assertIn(PAIR_AGENT_COMPILE_LINE, script,
                      "pair-agent compile line must match the 09d recipe")
        self.assertIn(BTHID_COMPILE_LINE, script)
        self.assertIn(HAL_COMPILE_LINE, script)
        # 09d ordering: pair agent compiles after bthid and before webui
        self.assertLess(script.index(BTHID_COMPILE_LINE),
                        script.index(PAIR_AGENT_COMPILE_LINE))
        self.assertLess(script.index(PAIR_AGENT_COMPILE_LINE),
                        script.index('"$OUT/codex_webui"'))

    def test_build_script_inventory_includes_pair_agent(self):
        script = self.setUp_build_script()
        for command in ("md5sum", "file", "ls -l"):
            line = next(
                (ln for ln in script.splitlines() if ln.startswith(command + " ")),
                None,
            )
            self.assertIsNotNone(line, "missing %s inventory line" % command)
            assert line is not None  # for type checkers
            names = line.split()[1:]
            # entry appears exactly once, in the 09d slot between bthid and webui
            self.assertEqual(names.count("codex_bt_pair_agent"), 1, line)
            self.assertLess(names.index("codex_bthid_keyboard"),
                            names.index("codex_bt_pair_agent"))
            self.assertLess(names.index("codex_bt_pair_agent"),
                            names.index("codex_webui"))
            self.assertLess(names.index("codex_hal_ltcp"),
                            names.index("codex_bt_pair_agent"))

    def test_build_script_does_not_write_payload_bin(self):
        """Outputs go to build/output only; payload/bin is never a target."""
        script = self.setUp_build_script()
        self.assertNotIn("payload/bin", script)
        self.assertNotIn("payload/bin", script.replace(" ", ""))
        self.assertIn('OUT="$SCRIPT_DIR/output"', script)

    # -- tracked binaries / publication hygiene ----------------------------

    def test_no_tracked_binary_changes_under_payload_bin(self):
        proc = run_git(REPO_ROOT, "status", "--porcelain", "--", "payload/bin")
        entries = [
            ln for ln in proc.stdout.decode().splitlines() if ln.strip()
        ]
        self.assertEqual(
            entries, [],
            "payload/bin must remain untouched by source-lineage work: %r"
            % entries,
        )

    def test_payload_bin_still_has_no_pair_agent_binary(self):
        """This lane imports source only; no binary is added to payload/bin."""
        listing = os.listdir(os.path.join(REPO_ROOT, "payload", "bin"))
        self.assertNotIn("codex_bt_pair_agent", listing)

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
                match, "%s leaks identity fragment %r" % (path, match and match.group(0))
            )


@unittest.skipUnless(
    REAL_EVIDENCE_AVAILABLE,
    "read-only historical clone not identified "
    "(set %s or %s)" % (SOURCE_REPO_ENV, FALLBACK_SOURCE_REPO_ENV),
)
class RealEvidenceLineageTests(unittest.TestCase):
    """Byte-level comparison against `git show` of 09d in the historical repo."""

    def setUp(self):
        proc = run_git(
            REAL_SOURCE_REPO, "rev-parse", "--verify",
            "%s^{commit}" % LINEAGE_COMMIT, check=False,
        )
        if proc.returncode != 0:
            self.skipTest("commit %s absent from historical repo" % LINEAGE_COMMIT)

    def test_worktree_sources_identical_to_git_show_09d(self):
        for name, (blob, sha) in PINNED_SOURCES.items():
            relpath = "payload/source/%s" % name
            shown = run_git(
                REAL_SOURCE_REPO, "show", "%s:%s" % (LINEAGE_COMMIT, relpath)
            ).stdout
            self.assertEqual(
                sha256_bytes(shown), sha,
                "%s: historical repo 09d blob does not hash to the pinned "
                "constant (pinned constants are stale?)" % name,
            )
            local = read_bytes(os.path.join(SOURCE_DIR, name))
            self.assertEqual(
                local, shown,
                "%s: worktree bytes differ from git show 09d" % name,
            )
            resolved = run_git(
                REAL_SOURCE_REPO, "rev-parse",
                "%s:%s" % (LINEAGE_COMMIT, relpath),
            ).stdout.decode().strip()
            self.assertEqual(resolved, blob)

    def test_pair_agent_recipe_matches_09d_build_script(self):
        historical = run_git(
            REAL_SOURCE_REPO, "show",
            "%s:build/build_harmony_tools_kali.sh" % LINEAGE_COMMIT,
        ).stdout.decode()
        historical_pair_lines = [
            ln for ln in historical.splitlines()
            if "codex_bt_pair_agent" in ln and ln.startswith('"$CC"')
        ]
        self.assertEqual(
            len(historical_pair_lines), 1,
            "expected exactly one pair-agent compile line in the 09d recipe",
        )
        with open(BUILD_SCRIPT, "r", encoding="utf-8") as fh:
            self.assertIn(historical_pair_lines[0], fh.read())


if __name__ == "__main__":
    unittest.main()
