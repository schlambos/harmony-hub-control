#!/usr/bin/env python3
"""Offline tests for build_staging (box-snapshot-20260818).

Two layers:

  * Fixture tests: a tiny synthetic repo + synthetic live manifest +
    reproducibility status + staging contract (built in a temp dir, fixed
    bytes) exercise every staging path: source-built binary hashes, exact
    text-source hashes, installer literals, modes/symlinks, deterministic
    outputs, unresolved-binary omission, the no-payload/bin-fallback rule,
    path-traversal/out-dir safety, the no-stale/legacy-MANIFEST-on-partial
    rule, and fail-closed semantics.  They run anywhere, offline.

  * Real-evidence tests: when the caller identifies the directory of fresh
    source-built binaries via ``HARMONY_SOURCE_BUILT_OUTPUT_DIR``, a real
    partial staging is run against the committed provenance inputs and the
    current working-tree text sources, and its files/hashes/modes/symlinks
    and blockers are verified.  Skipped otherwise.  No network, no box
    access, nothing written outside temp dirs.

Run:  python3 -W error::ResourceWarning -m unittest \
        tools.reconciliation.test_build_staging -v
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import unittest
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import build_staging as bs  # noqa: E402

#: Real source-built outputs are identified by ENVIRONMENT VARIABLE only —
#: no personal or machine-specific path is baked into this file.
BUILD_OUTPUT_ENV = "HARMONY_SOURCE_BUILT_OUTPUT_DIR"
REAL_BUILD_OUTPUT = os.environ.get(BUILD_OUTPUT_ENV, "")

#: Combined explicit build-output dir (all seven exact binaries) is
#: identified by ENVIRONMENT VARIABLE only.
COMBINED_OUTPUT_ENV = "HARMONY_COMBINED_BUILD_OUTPUT_DIR"
REAL_COMBINED_OUTPUT = os.environ.get(COMBINED_OUTPUT_ENV, "")

REAL_EVIDENCE_AVAILABLE = bool(
    REAL_BUILD_OUTPUT and os.path.isdir(REAL_BUILD_OUTPUT)
)

COMBINED_EVIDENCE_AVAILABLE = bool(
    REAL_COMBINED_OUTPUT and os.path.isdir(REAL_COMBINED_OUTPUT)
)

#: absolute-path and identity fragments that must never appear in the files
#: this lane touches (built by concatenation so this file's own pattern
#: constants can never trip the hygiene scanner)
_USERS_PATH = "/Use" + "rs/"
_OWNER_TAG = "schlam" + "bo"
_PERSONAL_NAME = "ma" + "tt"
_BOX_IP = "192.168" + ".0.123"
BANNED_FRAGMENTS = (
    _USERS_PATH, "/Docu" + "ments/", "/Co" + "dex/", "/Rep" + "os/",
    "/private" + "/tmp", "/var/" + "folders", _BOX_IP,
)
RE_PERSONAL_NAME = re.compile(r"\b" + "ma" + r"tt\b", re.IGNORECASE)
RE_ROOT_AT_DEST = re.compile("ro" + r"ot@" + r"[0-9]")

RE_SHA256 = re.compile(r"\A[0-9a-f]{64}\Z")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)


def read_bytes(path: str) -> bytes:
    with open(path, "rb") as fh:
        return fh.read()


# ---------------------------------------------------------------------------
# Fixture construction
# ---------------------------------------------------------------------------

def file_entry(path: str, mode: str, data: bytes) -> dict:
    return {
        "kind": "file", "mode": mode, "path": path,
        "sha256": sha256(data), "size": len(data),
    }


def symlink_entry(path: str, target: str) -> dict:
    tb = target.encode("utf-8")
    return {
        "kind": "symlink", "mode": "lrwxrwxrwx", "path": path,
        "sha256": sha256(tb), "size": len(tb), "target": target,
    }


def repro_entry(path: str, build_status: str, source_provenance: str) -> dict:
    return {
        "path": path, "build_status": build_status,
        "source_provenance": source_provenance,
    }


def build_fixture(base: str, complete: bool = False) -> dict:
    """Synthetic repo + live manifest + repro status + contract + build-out.

    ``complete=True`` makes every binary EXACT_SOURCE_REPRODUCIBLE so a
    complete staging (with a fresh legacy MANIFEST.txt) is reachable;
    otherwise codex_webui stays RECIPE_UNPROVEN and the staging is partial.
    """
    repo = os.path.join(base, "repo")
    os.makedirs(os.path.join(repo, "payload", "scripts"))
    os.makedirs(os.path.join(repo, "payload", "bin"))
    build_out = os.path.join(base, "build-out")
    os.makedirs(build_out)

    dhcpd = b"DHCPD-SOURCE-BUILT-BINARY-0001\n"
    portal = b"PORTAL-SOURCE-BUILT-BINARY-0002\n"
    webui = b"WEBUI-BINARY-0003\n"
    init = b"#!/bin/sh\necho init\n"
    dropbearkey = b"#!/bin/sh\nexec dropbearkey\n"
    manifest_literal = b'{"plugin":"codexactivity"}\n'
    stale = b"STALE-LIVE-MANIFEST\n"

    # repo text sources (exact bytes)
    write(os.path.join(repo, "payload/scripts/init.sh"), init)
    write(os.path.join(repo, "payload/scripts/dropbearkey"), dropbearkey)
    # a matching payload/bin binary that must NEVER be read (no-fallback proof)
    write(os.path.join(repo, "payload/bin/codex_dhcpd"), dhcpd)

    # source-built binaries (the ONLY binary source)
    write(os.path.join(build_out, "codex_dhcpd"), dhcpd)
    write(os.path.join(build_out, "codex_portal"), portal)
    if complete:
        write(os.path.join(build_out, "codex_webui"), webui)

    webui_status = (
        "EXACT_SOURCE_REPRODUCIBLE" if complete else "RECIPE_UNPROVEN")
    webui_prov = (
        "EXACT_SOURCE_REPRODUCIBLE" if complete
        else "CANDIDATE_SOURCE_BINARY_MATCH_ONLY")

    live_entries = [
        file_entry("/data/codex/bin/codex_dhcpd", "-rwxr-xr-x", dhcpd),
        file_entry("/data/codex/bin/codex_portal", "-rwxr-xr-x", portal),
        file_entry("/data/codex/bin/codex_webui", "-rwxr-xr-x", webui),
        file_entry("/data/codex/init.sh", "-rwxr-xr-x", init),
        file_entry("/pkg/codexactivity/manifest.json", "-rw-r--r--",
                   manifest_literal),
        symlink_entry("/data/codex/bin/dropbear", "dropbearmulti"),
        file_entry("/usr/sbin/dropbearkey", "-rwxr-xr-x", dropbearkey),
        file_entry("/data/codex/bin/MANIFEST.txt", "-rw-r--r--", stale),
    ]
    live_entries.sort(key=lambda e: e["path"])
    live_manifest = {
        "schema": "public-payload-manifest/1",
        "snapshot_id": "box-snapshot-20260818",
        "canonical": False,
        "entry_count": len(live_entries),
        "entries": live_entries,
    }

    repro_entries = [
        repro_entry("/data/codex/bin/codex_dhcpd",
                    "EXACT_SOURCE_REPRODUCIBLE", "EXACT_SOURCE_REPRODUCIBLE"),
        repro_entry("/data/codex/bin/codex_portal",
                    "EXACT_SOURCE_REPRODUCIBLE", "EXACT_SOURCE_REPRODUCIBLE"),
        repro_entry("/data/codex/bin/codex_webui", webui_status, webui_prov),
        repro_entry("/data/codex/init.sh",
                    "NOT_APPLICABLE_TEXT", "EXACT_COMMITTED_SOURCE"),
        repro_entry("/pkg/codexactivity/manifest.json",
                    "NOT_APPLICABLE_TEXT", "EXACT_INSTALLER_LITERAL"),
        repro_entry("/data/codex/bin/dropbear",
                    "NOT_APPLICABLE_SYMLINK", "SYMLINK_NO_CONTENT"),
        repro_entry("/usr/sbin/dropbearkey",
                    "NOT_APPLICABLE_TEXT", "EXACT_COMMITTED_SOURCE"),
        repro_entry("/data/codex/bin/MANIFEST.txt",
                    "NOT_APPLICABLE_TEXT", "GENERATED_DYNAMIC"),
    ]
    repro_entries.sort(key=lambda e: e["path"])
    repro_status = {
        "schema": "provenance-reproducibility-status/1",
        "snapshot_id": "box-snapshot-20260818",
        "entry_count": len(repro_entries),
        "entries": repro_entries,
        "blockers": [
            "UNRESOLVED_BINARY_REPRODUCIBILITY: codex_webui lacks proven "
            "exact source reproduction",
        ],
        "generated": {"generated_from_evidence_utc": "2026-08-18T00:00:00Z"},
    }

    closure_paths = [
        "/data/codex/bin/codex_dhcpd",
        "/data/codex/bin/codex_portal",
        "/data/codex/bin/codex_webui",
        "/data/codex/init.sh",
        "/pkg/codexactivity/manifest.json",
        "/data/codex/bin/dropbear",
        "/usr/sbin/dropbearkey",
    ]
    exact_paths = [
        "/data/codex/bin/codex_dhcpd",
        "/data/codex/bin/codex_portal",
    ]
    unresolved = []
    if not complete:
        exact_paths = exact_paths
        unresolved = [{
            "path": "/data/codex/bin/codex_webui",
            "build_status": "RECIPE_UNPROVEN",
            "source_provenance": "CANDIDATE_SOURCE_BINARY_MATCH_ONLY",
            "reason_code": "UNRESOLVED_BINARY_REPRODUCIBILITY",
        }]
    else:
        exact_paths = [
            "/data/codex/bin/codex_dhcpd",
            "/data/codex/bin/codex_portal",
            "/data/codex/bin/codex_webui",
        ]

    contract = {
        "schema": "staging-contract/1",
        "snapshot_id": "box-snapshot-20260818",
        "canonical": False,
        "required_closure": {
            "entry_count": len(closure_paths),
            "paths": closure_paths,
            "excluded_live_paths": [{
                "path": "/data/codex/bin/MANIFEST.txt",
                "reason_code": "LIVE_MANIFEST_STALE",
                "detail": "stale live listing; never staged",
            }],
        },
        "mappings": {
            "text_sources": {
                "/data/codex/init.sh": {"repo_path": "payload/scripts/init.sh"},
                "/usr/sbin/dropbearkey": {
                    "repo_path": "payload/scripts/dropbearkey"},
            },
            "installer_literals": {
                "/pkg/codexactivity/manifest.json": {
                    "literal": '{"plugin":"codexactivity"}\n'},
            },
            "symlinks": {
                "/data/codex/bin/dropbear": {"target": "dropbearmulti"},
            },
            "binaries": {
                "/data/codex/bin/codex_dhcpd": {
                    "build_output_name": "codex_dhcpd"},
                "/data/codex/bin/codex_portal": {
                    "build_output_name": "codex_portal"},
                "/data/codex/bin/codex_webui": {
                    "build_output_name": "codex_webui"},
            },
        },
        "allowed_exact_build_binaries": {"paths": exact_paths},
        "blockers": {
            "policy": "omitted entries carry an exact reason code",
            "current_expected": unresolved,
        },
        "no_fallback_policy": {
            "tracked_payload_bin": "never read, never a fallback",
        },
        "legacy_manifest": {
            "live_path": "/data/codex/bin/MANIFEST.txt",
            "mode": "0644",
            "format": "one '<md5sum>  <name>' line per binary",
            "binaries": ["codex_dhcpd", "codex_portal", "codex_webui"],
            "emit_policy": "only for a complete staging",
        },
        "outputs": {
            "rootfs_dir": "rootfs",
            "manifests": [
                "staging-manifest.json",
                "blockers.json",
                "staging-attestation.json",
            ],
            "fail_closed_outputs": [
                "staging-manifest.json",
                "blockers.json",
            ],
        },
        "exit_codes": {
            "0": "complete", "2": "usage", "3": "partial", "4": "fail closed",
        },
    }

    live_path = os.path.join(base, "live-manifest.json")
    repro_path = os.path.join(base, "repro-status.json")
    contract_path = os.path.join(base, "staging-contract.json")
    write(live_path, json.dumps(live_manifest, sort_keys=True).encode())
    write(repro_path, json.dumps(repro_status, sort_keys=True).encode())
    write(contract_path, json.dumps(contract, sort_keys=True).encode())

    return {
        "repo": repo,
        "build_out": build_out,
        "live_path": live_path,
        "repro_path": repro_path,
        "contract_path": contract_path,
        "live_manifest": live_manifest,
        "dhcpd": dhcpd,
        "portal": portal,
        "webui": webui,
        "init": init,
        "dropbearkey": dropbearkey,
        "manifest_literal": manifest_literal,
        "stale": stale,
        "complete": complete,
    }


def run_stage(fixture, out_dir, build_output_dir=None, allow_partial=False):
    return bs.stage(
        fixture["live_path"], fixture["repro_path"], fixture["contract_path"],
        fixture["repo"], build_output_dir, out_dir, allow_partial)


# ---------------------------------------------------------------------------
# Pure-function unit tests
# ---------------------------------------------------------------------------

class TestPureFunctions(unittest.TestCase):

    def test_parse_ls_mode(self):
        self.assertEqual(bs.parse_ls_mode("-rwxr-xr-x", "t"), 0o755)
        self.assertEqual(bs.parse_ls_mode("-rw-r--r--", "t"), 0o644)
        self.assertEqual(bs.parse_ls_mode("lrwxrwxrwx", "t"), 0o777)
        self.assertEqual(bs.parse_ls_mode("----------", "t"), 0)
        with self.assertRaises(bs.UsageError):
            bs.parse_ls_mode("drwxr-xr-x", "t")  # 'd' is not a valid type char

    def test_canonical_json_deterministic(self):
        obj = {"b": [1, 2], "a": {"z": None, "y": True}}
        self.assertEqual(bs.canonical_json_bytes(obj),
                         bs.canonical_json_bytes(json.loads(json.dumps(obj))))
        self.assertTrue(bs.canonical_json_bytes(obj).endswith(b"\n"))
        # ASCII-only output: non-ASCII is escaped, never raw UTF-8 bytes
        raw = bs.canonical_json_bytes({"k": "\u00e9"})
        raw.decode("ascii")
        self.assertIn(b"\\u00e9", raw)

    def test_validate_live_path(self):
        self.assertEqual(bs.validate_live_path("/a/b/c", "t"), ["a", "b", "c"])
        for bad in ("relative", "/a/../b", "/a//b", "/a/./b", "/", "/a/\x00b"):
            with self.assertRaises(bs.UsageError):
                bs.validate_live_path(bad, "t")


# ---------------------------------------------------------------------------
# Fixture staging tests
# ---------------------------------------------------------------------------

class TestFixtureStaging(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.base = tempfile.mkdtemp(prefix="build-staging-fixture-")
        cls.fixture = build_fixture(cls.base, complete=False)
        cls.out = os.path.join(cls.base, "out")
        cls.code, cls.written = run_stage(
            cls.fixture, cls.out,
            build_output_dir=cls.fixture["build_out"], allow_partial=True)
        cls.manifest = json.loads(
            Path(cls.written["staging-manifest.json"]).read_text())
        cls.blockers = json.loads(
            Path(cls.written["blockers.json"]).read_text())
        cls.attestation = json.loads(
            Path(cls.written["staging-attestation.json"]).read_text())

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.base, ignore_errors=True)

    def staged_by_path(self):
        return {r["path"]: r for r in self.manifest["staged"]}

    def test_partial_exit_code_and_publish(self):
        self.assertEqual(self.code, bs.EXIT_PARTIAL)
        self.assertTrue(self.manifest["rootfs_published"])
        self.assertFalse(self.manifest["complete"])
        self.assertTrue(self.manifest["partial"])
        self.assertFalse(self.manifest["canonical"])

    def test_source_built_binary_hashes(self):
        staged = self.staged_by_path()
        self.assertEqual(
            staged["/data/codex/bin/codex_dhcpd"]["sha256"],
            sha256(self.fixture["dhcpd"]))
        self.assertEqual(
            staged["/data/codex/bin/codex_portal"]["sha256"],
            sha256(self.fixture["portal"]))
        self.assertEqual(
            staged["/data/codex/bin/codex_dhcpd"]["source"]["type"],
            "build_output")
        self.assertEqual(
            staged["/data/codex/bin/codex_dhcpd"]["source"]["build_output_name"],
            "codex_dhcpd")

    def test_exact_text_source_hashes(self):
        staged = self.staged_by_path()
        self.assertEqual(
            staged["/data/codex/init.sh"]["sha256"],
            sha256(self.fixture["init"]))
        self.assertEqual(
            staged["/usr/sbin/dropbearkey"]["sha256"],
            sha256(self.fixture["dropbearkey"]))
        self.assertEqual(
            staged["/data/codex/init.sh"]["source"]["type"], "repo_text")
        self.assertEqual(
            staged["/data/codex/init.sh"]["source"]["repo_path"],
            "payload/scripts/init.sh")

    def test_installer_literal(self):
        staged = self.staged_by_path()
        self.assertEqual(
            staged["/pkg/codexactivity/manifest.json"]["sha256"],
            sha256(self.fixture["manifest_literal"]))
        self.assertEqual(
            staged["/pkg/codexactivity/manifest.json"]["source"]["type"],
            "installer_literal")
        self.assertEqual(
            staged["/pkg/codexactivity/manifest.json"]["source"]["literal"],
            '{"plugin":"codexactivity"}\n')

    def test_modes_and_symlinks(self):
        staged = self.staged_by_path()
        self.assertEqual(
            staged["/data/codex/bin/codex_dhcpd"]["mode"], "0755")
        self.assertEqual(
            staged["/pkg/codexactivity/manifest.json"]["mode"], "0644")
        self.assertEqual(
            staged["/data/codex/bin/dropbear"]["kind"], "symlink")
        self.assertEqual(
            staged["/data/codex/bin/dropbear"]["target"], "dropbearmulti")

    def test_unresolved_binary_omitted(self):
        omitted = {o["path"]: o for o in self.blockers["omitted"]}
        self.assertIn("/data/codex/bin/codex_webui", omitted)
        self.assertEqual(
            omitted["/data/codex/bin/codex_webui"]["reason_code"],
            "UNRESOLVED_BINARY_REPRODUCIBILITY")
        self.assertEqual(
            omitted["/data/codex/bin/codex_webui"]["build_status"],
            "RECIPE_UNPROVEN")
        self.assertEqual(self.blockers["omitted_count"], 1)

    def test_no_legacy_manifest_on_partial(self):
        self.assertFalse(self.manifest["legacy_manifest_emitted"])
        self.assertFalse(self.attestation["attestation"]["legacy_manifest"]["emitted"])
        rootfs = self.written["rootfs"]
        self.assertFalse(
            os.path.lexists(os.path.join(rootfs, "data/codex/bin/MANIFEST.txt")))

    def test_rootfs_files_match_live_manifest(self):
        live = {e["path"]: e for e in self.fixture["live_manifest"]["entries"]}
        rootfs = self.written["rootfs"]
        for rec in self.manifest["staged"]:
            path = rec["path"]
            disk = os.path.join(rootfs, path[1:])
            entry = live[path]
            if entry["kind"] == "symlink":
                self.assertTrue(os.path.islink(disk), path)
                self.assertEqual(os.readlink(disk), entry["target"], path)
            else:
                data = read_bytes(disk)
                self.assertEqual(sha256(data), entry["sha256"], path)
                self.assertEqual(len(data), entry["size"], path)
                mode = stat.S_IMODE(os.lstat(disk).st_mode)
                self.assertEqual(bs.oct_mode(mode), bs.oct_mode(
                    bs.parse_ls_mode(entry["mode"], path)), path)

    def test_deterministic_outputs(self):
        out2 = os.path.join(self.base, "out2")
        code2, written2 = run_stage(
            self.fixture, out2,
            build_output_dir=self.fixture["build_out"], allow_partial=True)
        self.assertEqual(code2, self.code)
        for name in ("staging-manifest.json", "blockers.json",
                     "staging-attestation.json"):
            self.assertEqual(
                read_bytes(self.written[name]), read_bytes(written2[name]),
                "%s differs across runs" % name)


class TestNoFallback(unittest.TestCase):
    """A matching payload/bin binary is never read; no build-output => omit."""

    @classmethod
    def setUpClass(cls):
        cls.base = tempfile.mkdtemp(prefix="build-staging-nofb-")
        cls.fixture = build_fixture(cls.base, complete=False)
        cls.out = os.path.join(cls.base, "out")
        # NO build-output-dir supplied, even though payload/bin/codex_dhcpd
        # in the synthetic repo holds the exact live bytes.
        cls.code, cls.written = run_stage(cls.fixture, cls.out,
                                          allow_partial=True)
        cls.blockers = json.loads(
            Path(cls.written["blockers.json"]).read_text())

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.base, ignore_errors=True)

    def test_exact_binary_omitted_without_build_output(self):
        omitted = {o["path"]: o for o in self.blockers["omitted"]}
        self.assertIn("/data/codex/bin/codex_dhcpd", omitted)
        self.assertEqual(
            omitted["/data/codex/bin/codex_dhcpd"]["reason_code"],
            "NO_SOURCE_BUILD_OUTPUT")
        self.assertIn("/data/codex/bin/codex_portal", omitted)
        self.assertEqual(
            omitted["/data/codex/bin/codex_portal"]["reason_code"],
            "NO_SOURCE_BUILD_OUTPUT")

    def test_payload_bin_never_staged(self):
        rootfs = self.written["rootfs"]
        self.assertFalse(
            os.path.lexists(os.path.join(rootfs, "data/codex/bin/codex_dhcpd")))
        self.assertFalse(
            os.path.lexists(os.path.join(rootfs, "data/codex/bin/codex_portal")))


class TestFailClosed(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.base = tempfile.mkdtemp(prefix="build-staging-fc-")
        cls.fixture = build_fixture(cls.base, complete=False)
        cls.out = os.path.join(cls.base, "out")
        cls.code, cls.written = run_stage(
            cls.fixture, cls.out,
            build_output_dir=cls.fixture["build_out"], allow_partial=False)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.base, ignore_errors=True)

    def test_fail_closed_no_rootfs(self):
        self.assertEqual(self.code, bs.EXIT_FAIL_CLOSED)
        self.assertNotIn("rootfs", self.written)
        self.assertFalse(os.path.lexists(os.path.join(self.out, "rootfs")))
        self.assertIn("staging-manifest.json", self.written)
        self.assertIn("blockers.json", self.written)
        self.assertNotIn("staging-attestation.json", self.written)

    def test_fail_closed_manifest_flags(self):
        manifest = json.loads(
            Path(self.written["staging-manifest.json"]).read_text())
        self.assertFalse(manifest["rootfs_published"])
        self.assertFalse(manifest["complete"])


class TestCompleteStaging(unittest.TestCase):
    """All binaries EXACT => complete staging with a fresh legacy MANIFEST."""

    @classmethod
    def setUpClass(cls):
        cls.base = tempfile.mkdtemp(prefix="build-staging-complete-")
        cls.fixture = build_fixture(cls.base, complete=True)
        cls.out = os.path.join(cls.base, "out")
        cls.code, cls.written = run_stage(
            cls.fixture, cls.out,
            build_output_dir=cls.fixture["build_out"], allow_partial=False)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.base, ignore_errors=True)

    def test_complete_exit_and_publish(self):
        self.assertEqual(self.code, bs.EXIT_COMPLETE)
        self.assertIn("rootfs", self.written)
        self.assertIn("staging-attestation.json", self.written)

    def test_fresh_legacy_manifest_emitted(self):
        manifest = json.loads(
            Path(self.written["staging-manifest.json"]).read_text())
        self.assertTrue(manifest["complete"])
        self.assertTrue(manifest["legacy_manifest_emitted"])
        rootfs = self.written["rootfs"]
        legacy = os.path.join(rootfs, "data/codex/bin/MANIFEST.txt")
        self.assertTrue(os.path.isfile(legacy))
        content = read_bytes(legacy)
        # never the stale live bytes
        self.assertNotEqual(content, self.fixture["stale"])
        # one '<md5>  <name>' line per binary, in declared order
        lines = content.decode("ascii").splitlines()
        self.assertEqual(len(lines), 3)
        for line, name in zip(lines, ["codex_dhcpd", "codex_portal",
                                       "codex_webui"]):
            md5sum, sep, got_name = line.partition("  ")
            self.assertEqual(sep, "  ")
            self.assertEqual(got_name, name)
            self.assertRegex(md5sum, r"\A[0-9a-f]{32}\Z")


# ---------------------------------------------------------------------------
# Safety tests
# ---------------------------------------------------------------------------

class TestSafety(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.base = tempfile.mkdtemp(prefix="build-staging-safety-")
        cls.fixture = build_fixture(cls.base, complete=False)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.base, ignore_errors=True)

    def test_out_dir_inside_payload_bin_rejected(self):
        bad = os.path.join(self.fixture["repo"], "payload", "bin", "out")
        with self.assertRaises(bs.UsageError):
            run_stage(self.fixture, bad,
                      build_output_dir=self.fixture["build_out"],
                      allow_partial=True)

    def test_out_dir_is_repo_root_rejected(self):
        with self.assertRaises(bs.UsageError):
            run_stage(self.fixture, self.fixture["repo"],
                      build_output_dir=self.fixture["build_out"],
                      allow_partial=True)

    def test_out_dir_inside_protected_tree_rejected(self):
        for tree in ("payload", "provenance", "docs", "tools"):
            bad = os.path.join(self.fixture["repo"], tree, "out")
            with self.assertRaises(bs.UsageError):
                run_stage(self.fixture, bad,
                          build_output_dir=self.fixture["build_out"],
                          allow_partial=True)

    def test_build_output_dir_inside_payload_bin_rejected(self):
        bad = os.path.join(self.fixture["repo"], "payload", "bin")
        out = os.path.join(self.base, "out")
        with self.assertRaises(bs.UsageError):
            run_stage(self.fixture, out, build_output_dir=bad,
                      allow_partial=True)

    def test_build_output_dir_overlaps_out_dir_rejected(self):
        out = os.path.join(self.base, "shared")
        with self.assertRaises(bs.UsageError):
            run_stage(self.fixture, out, build_output_dir=out,
                      allow_partial=True)

    def test_out_dir_is_filesystem_root_rejected(self):
        with self.assertRaises(bs.UsageError):
            run_stage(self.fixture, "/",
                      build_output_dir=self.fixture["build_out"],
                      allow_partial=True)

    def test_missing_build_output_dir_rejected(self):
        out = os.path.join(self.base, "out")
        with self.assertRaises(bs.UsageError):
            run_stage(self.fixture, out,
                      build_output_dir=os.path.join(self.base, "nope"),
                      allow_partial=True)


# ---------------------------------------------------------------------------
# No subprocess / network
# ---------------------------------------------------------------------------

class TestNoSubprocessNetwork(unittest.TestCase):

    def test_tool_uses_standard_library_only(self):
        source = Path(HERE, "build_staging.py").read_text()
        for banned in ("import subprocess", "import socket", "import urllib",
                       "import http", "import requests", "import paramiko",
                       "import ftplib", "import telnetlib", "import smtplib"):
            self.assertNotIn(banned, source)
        for call in ("subprocess.", "socket.", "urlopen", "requests.",
                     "os.system", "os.popen"):
            self.assertNotIn(call, source)

    def test_tool_imports_are_stdlib(self):
        import build_staging  # noqa: F401  (already imported as bs)
        for name in ("argparse", "hashlib", "json", "os", "re", "shutil",
                     "stat", "sys", "tempfile", "typing"):
            self.assertIn(name, sys.modules)


# ---------------------------------------------------------------------------
# Publication hygiene
# ---------------------------------------------------------------------------

class TestPublicationHygiene(unittest.TestCase):

    #: only the files THIS lane is allowed to touch are scanned (other lanes'
    #: files carry their own pattern constants and are out of scope here)
    LANE_FILES = (
        os.path.join(REPO_ROOT, "tools", "reconciliation", "build_staging.py"),
        os.path.join(REPO_ROOT, "tools", "reconciliation",
                     "test_build_staging.py"),
        os.path.join(REPO_ROOT, "provenance", "box-snapshot-20260818",
                     "staging-contract.json"),
        os.path.join(REPO_ROOT, "docs", "reconciliation",
                     "staging-contract.md"),
    )

    def test_deliverables_free_of_personal_identifiers(self):
        for path in self.LANE_FILES:
            if not os.path.isfile(path):
                continue
            text = Path(path).read_text(encoding="utf-8", errors="replace")
            context = str(path)
            for fragment in BANNED_FRAGMENTS:
                self.assertNotIn(fragment, text,
                                 "%s leaks %r" % (context, fragment))
            self.assertIsNone(RE_PERSONAL_NAME.search(text),
                              "%s leaks a personal name" % context)
            self.assertIsNone(RE_ROOT_AT_DEST.search(text),
                              "%s leaks root@destination" % context)

    def test_no_personal_defaults_in_tool(self):
        self.assertEqual(bs.BUILD_OUTPUT_ENV, "HARMONY_STAGING_BUILD_OUTPUT_DIR")
        # the tool must not default to any hardcoded build-output path
        self.assertIsNone(getattr(bs, "DEFAULT_BUILD_OUTPUT_DIR", None))


# ---------------------------------------------------------------------------
# Real-evidence staging (env-gated)
# ---------------------------------------------------------------------------

@unittest.skipUnless(
    REAL_EVIDENCE_AVAILABLE,
    "real source-built outputs not identified (set %s to the directory of "
    "fresh source-built binaries)" % BUILD_OUTPUT_ENV,
)
class TestRealEvidenceStaging(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.out = tempfile.mkdtemp(prefix="build-staging-real-")
        cls.code, cls.written = bs.stage(
            bs.DEFAULT_LIVE_MANIFEST, bs.DEFAULT_REPRO_STATUS,
            bs.DEFAULT_CONTRACT, REPO_ROOT, REAL_BUILD_OUTPUT, cls.out,
            allow_partial=True)
        cls.manifest = json.loads(
            Path(cls.written["staging-manifest.json"]).read_text())
        cls.blockers = json.loads(
            Path(cls.written["blockers.json"]).read_text())
        cls.attestation = json.loads(
            Path(cls.written["staging-attestation.json"]).read_text())
        cls.live = json.loads(
            Path(bs.DEFAULT_LIVE_MANIFEST).read_text())

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.out, ignore_errors=True)

    def test_partial_staging_published(self):
        self.assertEqual(self.code, bs.EXIT_PARTIAL)
        self.assertTrue(self.manifest["rootfs_published"])
        self.assertFalse(self.manifest["complete"])
        self.assertFalse(self.manifest["canonical"])
        self.assertFalse(self.attestation["canonical"])
        self.assertFalse(self.blockers["canonical"])

    def test_dhcpd_and_portal_staged(self):
        staged = {r["path"]: r for r in self.manifest["staged"]}
        self.assertIn("/data/codex/bin/codex_dhcpd", staged)
        self.assertIn("/data/codex/bin/codex_portal", staged)
        self.assertEqual(
            staged["/data/codex/bin/codex_dhcpd"]["source"]["type"],
            "build_output")
        self.assertEqual(
            staged["/data/codex/bin/codex_portal"]["source"]["type"],
            "build_output")

    def test_blockers_with_partial_build_output(self):
        """With only dhcpd/portal supplied, the five other exact binaries are
        blocked with NO_SOURCE_BUILD_OUTPUT and dropbearmulti with
        UNRESOLVED_BINARY_REPRODUCIBILITY (the only remaining build blocker)."""
        omitted = {o["path"]: o for o in self.blockers["omitted"]}
        no_output = {
            "/data/codex/bin/codex_bt_pair_agent",
            "/data/codex/bin/codex_bthid_keyboard",
            "/data/codex/bin/codex_hal_ltcp",
            "/data/codex/bin/codex_hbus",
            "/data/codex/bin/codex_webui",
        }
        for path in no_output:
            self.assertEqual(
                omitted[path]["reason_code"], "NO_SOURCE_BUILD_OUTPUT", path)
        self.assertEqual(
            omitted["/data/codex/bin/dropbearmulti"]["reason_code"],
            "UNRESOLVED_BINARY_REPRODUCIBILITY")
        self.assertEqual(set(omitted), no_output | {
            "/data/codex/bin/dropbearmulti"})

    def test_staged_files_match_live_manifest(self):
        live = {e["path"]: e for e in self.live["entries"]}
        rootfs = self.written["rootfs"]
        for rec in self.manifest["staged"]:
            path = rec["path"]
            disk = os.path.join(rootfs, path[1:])
            entry = live[path]
            if entry["kind"] == "symlink":
                self.assertTrue(os.path.islink(disk), path)
                self.assertEqual(os.readlink(disk), entry["target"], path)
            else:
                data = read_bytes(disk)
                self.assertEqual(sha256(data), entry["sha256"], path)
                self.assertEqual(len(data), entry["size"], path)
                mode = stat.S_IMODE(os.lstat(disk).st_mode)
                self.assertEqual(
                    bs.oct_mode(mode),
                    bs.oct_mode(bs.parse_ls_mode(entry["mode"], path)), path)

    def test_no_stale_live_manifest_staged(self):
        rootfs = self.written["rootfs"]
        self.assertFalse(
            os.path.lexists(os.path.join(rootfs, "data/codex/bin/MANIFEST.txt")))
        self.assertFalse(self.manifest["legacy_manifest_emitted"])

    def test_no_private_paths_or_md5_in_artifacts(self):
        for name in ("staging-manifest.json", "blockers.json",
                     "staging-attestation.json"):
            text = Path(self.written[name]).read_text()
            for fragment in BANNED_FRAGMENTS:
                self.assertNotIn(fragment, text, name)
            self.assertNotIn("md5", text, name)
            self.assertNotIn("md5sum", text, name)


@unittest.skipUnless(
    COMBINED_EVIDENCE_AVAILABLE,
    "combined explicit build-output dir not identified (set %s to a dir "
    "containing all seven exact binaries)" % COMBINED_OUTPUT_ENV,
)
class TestCombinedOutputStaging(unittest.TestCase):
    """A combined explicit build-output dir with all seven exact binaries
    stages 21/22, blocking only dropbearmulti."""

    @classmethod
    def setUpClass(cls):
        cls.out = tempfile.mkdtemp(prefix="build-staging-combined-")
        cls.code, cls.written = bs.stage(
            bs.DEFAULT_LIVE_MANIFEST, bs.DEFAULT_REPRO_STATUS,
            bs.DEFAULT_CONTRACT, REPO_ROOT, REAL_COMBINED_OUTPUT, cls.out,
            allow_partial=True)
        cls.manifest = json.loads(
            Path(cls.written["staging-manifest.json"]).read_text())
        cls.blockers = json.loads(
            Path(cls.written["blockers.json"]).read_text())
        cls.attestation = json.loads(
            Path(cls.written["staging-attestation.json"]).read_text())
        cls.live = json.loads(
            Path(bs.DEFAULT_LIVE_MANIFEST).read_text())

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.out, ignore_errors=True)

    def test_21_of_22_staged_only_dropbearmulti_blocked(self):
        self.assertEqual(self.code, bs.EXIT_PARTIAL)
        self.assertTrue(self.manifest["rootfs_published"])
        self.assertFalse(self.manifest["complete"])
        self.assertFalse(self.manifest["canonical"])
        self.assertEqual(self.manifest["staged_entry_count"], 21)
        self.assertEqual(self.manifest["closure_entry_count"], 22)
        self.assertEqual(self.blockers["omitted_count"], 1)
        omitted = self.blockers["omitted"]
        self.assertEqual(omitted[0]["path"], "/data/codex/bin/dropbearmulti")
        self.assertEqual(omitted[0]["reason_code"],
                         "UNRESOLVED_BINARY_REPRODUCIBILITY")
        # no legacy MANIFEST on partial
        self.assertFalse(self.manifest["legacy_manifest_emitted"])

    def test_all_seven_binaries_staged_from_build_output(self):
        staged = {r["path"]: r for r in self.manifest["staged"]}
        for name in ("codex_bt_pair_agent", "codex_bthid_keyboard",
                     "codex_dhcpd", "codex_hal_ltcp", "codex_hbus",
                     "codex_portal", "codex_webui"):
            path = "/data/codex/bin/%s" % name
            self.assertIn(path, staged, name)
            self.assertEqual(staged[path]["source"]["type"], "build_output",
                             name)

    def test_staged_files_match_live_manifest(self):
        live = {e["path"]: e for e in self.live["entries"]}
        rootfs = self.written["rootfs"]
        for rec in self.manifest["staged"]:
            path = rec["path"]
            disk = os.path.join(rootfs, path[1:])
            entry = live[path]
            if entry["kind"] == "symlink":
                self.assertTrue(os.path.islink(disk), path)
                self.assertEqual(os.readlink(disk), entry["target"], path)
            else:
                data = read_bytes(disk)
                self.assertEqual(sha256(data), entry["sha256"], path)
                self.assertEqual(len(data), entry["size"], path)
                mode = stat.S_IMODE(os.lstat(disk).st_mode)
                self.assertEqual(
                    bs.oct_mode(mode),
                    bs.oct_mode(bs.parse_ls_mode(entry["mode"], path)), path)

    def test_no_stale_live_manifest_staged(self):
        rootfs = self.written["rootfs"]
        self.assertFalse(
            os.path.lexists(os.path.join(rootfs, "data/codex/bin/MANIFEST.txt")))
        self.assertFalse(self.manifest["legacy_manifest_emitted"])


if __name__ == "__main__":
    unittest.main()
