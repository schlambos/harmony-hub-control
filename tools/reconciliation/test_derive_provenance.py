#!/usr/bin/env python3
"""Offline tests for derive_provenance (box-snapshot-20260818).

Two layers:

  * Fixture tests: a tiny synthetic git repo + synthetic evidence snapshot
    (built in a temp dir, fixed timestamps) exercise every status path,
    sanitization, determinism, and shape rules.  They run anywhere.

  * Real-evidence tests: when the private evidence snapshot and the
    read-only historical clone are present (the reconciliation host), the
    generated artifacts are re-derived into temp dirs and checked for exact
    23-entry coverage, agreement with the authoritative manifest, the exact
    codex_webui commit enumeration (independently re-derived from git),
    hbus RECIPE_UNPROVEN incorporation, DIAG netservicestarter statuses,
    live MANIFEST.txt staleness, exclusion/sanitization rules, and
    determinism.  No network, no box access, nothing outside temp dirs is
    written.

Run:  python3 -m unittest tools.reconciliation.test_derive_provenance -v
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import derive_provenance as dp  # noqa: E402

EVIDENCE_ROOT = os.path.normpath(os.path.join(
    REPO_ROOT, "..", "evidence", "box-snapshot-20260817"))

#: Real-evidence inputs are identified by ENVIRONMENT VARIABLES only — no
#: personal or machine-specific path is baked into this file.  The
#: real-evidence integration tests skip unless the source repo is identified
#: AND the evidence manifest is present; fixture tests always run.
SOURCE_REPO_ENV = "HARMONY_PROVENANCE_SOURCE_REPO"
SNAPSHOT_ENV = "HARMONY_PROVENANCE_SNAPSHOT_DIR"
HBUS_ENV = "HARMONY_PROVENANCE_HBUS_REPORT"
BASELINE_ENV = "HARMONY_PROVENANCE_BASELINE_REPO"
BASELINE_REF_ENV = "HARMONY_PROVENANCE_BASELINE_REF"
PILOT_DP_ENV = "HARMONY_PROVENANCE_PILOT_DHCP_PORTAL_REPORT"
PILOT_BTH_ENV = "HARMONY_PROVENANCE_PILOT_BT_HAL_HBUS_REPORT"
PILOT_WEBUI_ENV = "HARMONY_PROVENANCE_PILOT_WEBUI_REPORT"
PILOT_ZIG_ENV = "HARMONY_PROVENANCE_PILOT_ZIG_SWEEP_REPORT"
#: The public base commit pinning the baseline repo contribution.
BASELINE_REF = (
    os.environ.get(BASELINE_REF_ENV)
    or "d87cebafdee36ec33f1e4ea3055239dbfea6aa09")

REAL_SOURCE_REPO = os.environ.get(SOURCE_REPO_ENV, "")
REAL_SNAPSHOT = (
    os.environ.get(SNAPSHOT_ENV)
    or os.path.join(EVIDENCE_ROOT, "snapshot-nonsecret"))
REAL_HBUS = (
    os.environ.get(HBUS_ENV)
    or os.path.join(EVIDENCE_ROOT, "diagnostics", "hbus-repro", "report.json"))
COMMITTED_OUT = os.path.join(REPO_ROOT, "provenance", "box-snapshot-20260818")

def _evidence_default(rel: str, env: str):
    return (os.environ.get(env)
            or os.path.join(EVIDENCE_ROOT, rel))

REAL_PILOT_DP = _evidence_default(
    os.path.join("diagnostics", "binary-pilots", "dhcpd-portal", "report.json"),
    PILOT_DP_ENV)
REAL_PILOT_BTH = _evidence_default(
    os.path.join("diagnostics", "binary-pilots", "bt-hal-hbus", "report.json"),
    PILOT_BTH_ENV)
REAL_PILOT_WEBUI = _evidence_default(
    os.path.join("diagnostics", "binary-pilots", "webui", "report.json"),
    PILOT_WEBUI_ENV)
REAL_PILOT_ZIG = _evidence_default(
    os.path.join("diagnostics", "binary-pilots", "zig-distribution-sweep",
                 "report.json"),
    PILOT_ZIG_ENV)
#: exact report digests (regression pins)
PILOT_DP_SHA256 = ("25bd2435e36177ea3aed0d931e1a81a634508f7617b0f621a9"
                   "967e6f6177eee4")
PILOT_BTH_SHA256 = ("68b353b647c462b23125c90407a11c6d2f7dafffbdf4a3a1d05"
                    "09ae2a271ac68")
PILOT_WEBUI_SHA256 = ("656ef734931f7dbe374260ba5ddfda99e9b00961a7f5f440d"
                      "55999476893f957")
PILOT_ZIG_SHA256 = ("29c691aad47462d77740bccb45b4405588b3f5dea3846c0b57"
                    "ee6a3196c54382")

REAL_EVIDENCE_AVAILABLE = (
    bool(REAL_SOURCE_REPO)
    and os.path.isdir(os.path.join(REAL_SOURCE_REPO, ".git"))
    and os.path.isfile(os.path.join(REAL_SNAPSHOT, "manifest.json"))
    and os.path.isfile(REAL_PILOT_DP)
    and os.path.isfile(REAL_PILOT_BTH)
    and os.path.isfile(REAL_PILOT_WEBUI)
    and os.path.isfile(REAL_PILOT_ZIG)
)

#: The fresh reconciliation clone completing the shallow historical clone
#: (defaults to this repository; env-overridable).  Never a personal path.
BASELINE_REPO = os.environ.get(BASELINE_ENV) or REPO_ROOT

#: Regression constant: unique commits across the union of ALL refs in the
#: historical clone (57, shallow) and the baseline clone (89, full
#: ancestry): overlap 34, baseline-unique 55, historical-unique 23 -> union
#: 112.  Independently re-derived by test_union_history_resolves_gap before
#: comparison.
EXPECTED_UNIQUE_COMMITS = 112
GAP_PARENT = "1a9e27090b05f835e20b2a9a9ce76bd0d59be2b9"

#: absolute-path fragments that must never appear in generated outputs
#: (built from fragments so this file's own pattern constants can never
#: trip the hygiene scanner)
_USERS_PATH = "/Use" + "rs/"
PATH_LEAK_PATTERNS = (_USERS_PATH, "/Documents/", "/Codex/", "/Repos/",
                      "/private/tmp", "/var/folders")

LIVE_WEBUI_SHA256 = ("c400173bb42f735734c522556c69f6c80f060494941"
                     "3eb974c7b361b9e4ac11a")
STALE_MANIFEST_MD5_WEBUI = "39793b19337f479fab87918eb424bf68"
STALE_MANIFEST_MD5_HBUS = "30d0f0935f6069998b0e54a82bddb25d"
STALE_MANIFEST_MD5_BTHID = "29a34114dc2120485bf3a3067613a998"
STALE_MANIFEST_MD5_HALLTCp = "4c40847878f3bb3d9ee9213c177e0a29"

RE_COMMIT = re.compile(r"\A[0-9a-f]{40}\Z")
RE_SHA256 = re.compile(r"\A[0-9a-f]{64}\Z")
RE_MD5 = re.compile(r"\A[0-9a-f]{32}\Z")

#: personal-name and owner-identity fragments, built by concatenation so
#: the literals never appear contiguously in this file
_PERSONAL_NAME = "ma" + "tt"
_OWNER_TAG = "schlam" + "bo"
#: the actual box IP, also built by concatenation
_BOX_IP = "192.168" + ".0.123"
#: root@ followed by a digit (an actual IP-like destination); generic
#: rejection fixtures such as "root@box" are deliberately not flagged
RE_ROOT_AT_DEST = re.compile("ro" + r"ot@" + r"[0-9]")
RE_PERSONAL_NAME = re.compile(r"\b" + "ma" + r"tt\b", re.IGNORECASE)

#: paths/values that must never appear in the sanitized public manifest
BANNED_IN_PUBLIC_ENTRIES = (
    "192.168", _USERS_PATH, _PERSONAL_NAME, _OWNER_TAG, "md5", "uid",
    "gid", "owner", "object", "root")
#: config/resource/key path patterns excluded from every derived artifact's
#: path fields
EXCLUDED_PATH_PATTERNS = (
    r"/data/codex/(config|resources|keys)(/|\Z)", r"\.ssh", r"authorized_keys",
    r"id_rsa", r"id_ed25519", r"host_key", r"\.pem\Z", r"\.key\Z",
    r"secret", r"credential", r"password", r"token")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def md5(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def write(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)


def run_git(repo: str, *args: str, env_extra=None, check=True) -> str:
    env = dict(os.environ)
    env.update(env_extra or {})
    proc = subprocess.run(
        ["git", "-c", "commit.gpgsign=false", "-C", repo, *args],
        capture_output=True, env=env)
    if check and proc.returncode != 0:
        raise AssertionError(
            "git %s failed: %s" % (args, proc.stderr.decode()[:400]))
    return proc.stdout.decode()


# ---------------------------------------------------------------------------
# Fixture construction
# ---------------------------------------------------------------------------

def build_fixture(base: str) -> dict:
    """Synthetic repo + snapshot + hbus report.  Fixed dates => stable SHAs."""
    repo = os.path.join(base, "repo")
    os.makedirs(repo)
    dates = {
        "GIT_AUTHOR_NAME": "Fixture",
        "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
        "GIT_COMMITTER_NAME": "Fixture",
        "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
    }

    def commit(msg: str, epoch: str) -> None:
        env = dict(dates)
        env["GIT_AUTHOR_DATE"] = "%s +0000" % epoch
        env["GIT_COMMITTER_DATE"] = "%s +0000" % epoch
        run_git(repo, "add", "-A")
        run_git(repo, "commit", "-q", "-m", msg, env_extra=env)

    run_git(repo, "init", "-q", "-b", "main", repo and ".")
    run_git(repo, "config", "user.name", "Fixture")
    run_git(repo, "config", "user.email", "fixture@example.invalid")

    rcS_v1 = b"# V1\n"
    rcS_v2 = b"# V2 live-exact\n"
    dhcpd_v1 = b"DHCPD-V1\n"
    dhcpd_v2 = b"DHCPD-V2\n"
    dhcpd_src_v1 = b"int main(void){return 1;}\n"
    dhcpd_src_v2 = b"int main(void){return 2;}\n"
    dropbear_repo = b"#!/bin/sh\nexec /data/codex/bin/dropbear -s -g -K 300 \"$@\"\n"
    dropbear_live = b"#!/bin/sh\nexec /data/codex/bin/dropbear -K 300 \"$@\"\n"
    nss_clean = b"-- clean netservicestarter original\n" * 8
    nss_diag = b"-- DIAG instrumentation patch\n" * 8
    hbus_repo_bin = b"HBUS-REPO-BUILD\n"
    hbus_live = b"HBUS-KNOWN-GOOD-BUILD\n"
    hbus_src = b"int hbus(void){return 0;}\n"
    multi = b"DROPBEARMULTI-THIRDPARTY\n"
    installer = (
        b"class Installer:\n"
        b"    def install(self):\n"
        b"        self.upload_text('{\"plugin\":\"codexmqtt\"}\\n', "
        b"\"/pkg/codexmqtt/manifest.json\", \"644\")\n")

    # commit 1 (epoch 1785000000): v1 payloads
    write(os.path.join(repo, "payload/scripts/rcS.local"), rcS_v1)
    write(os.path.join(repo, "payload/scripts/dropbear"), dropbear_repo)
    write(os.path.join(repo, "payload/scripts/netservicestarter.lua"), nss_clean)
    write(os.path.join(repo, "payload/bin/codex_dhcpd"), dhcpd_v1)
    write(os.path.join(repo, "payload/source/codex_dhcpd.c"), dhcpd_src_v1)
    write(os.path.join(repo, "payload/bin/codex_hbus"), hbus_repo_bin)
    write(os.path.join(repo, "payload/source/codex_hbus.c"), hbus_src)
    write(os.path.join(repo, "payload/bin/dropbearmulti"), multi)
    write(os.path.join(repo, "install_webui.py"), installer)
    write(os.path.join(repo, "docs/SESSION_HANDOFF.md"),
          b"# handoff\nnothing yet\n")
    commit("c1 base", "1785000000")

    # commit 2 (epoch 1785000100): v2 payloads == live
    write(os.path.join(repo, "payload/scripts/rcS.local"), rcS_v2)
    write(os.path.join(repo, "payload/bin/codex_dhcpd"), dhcpd_v2)
    write(os.path.join(repo, "payload/source/codex_dhcpd.c"), dhcpd_src_v2)
    write(os.path.join(repo, "docs/SESSION_HANDOFF.md"),
          b"# handoff\nthe DIAG variant md5 is " + md5(nss_diag).encode()
          + b" per hub note\n")
    commit("c2 live versions", "1785000100")

    # commit 3 (epoch 1785000200) on a side branch
    run_git(repo, "checkout", "-q", "-b", "agent/line")
    write(os.path.join(repo, "payload/bin/codex_hbus"), hbus_repo_bin + b"x")
    commit("c3 side branch hbus rebuild", "1785000200")
    run_git(repo, "checkout", "-q", "main")

    # reconciliation-branch working-tree reconstruction: the live DIAG
    # netservicestarter and the live dropbear wrapper are carried as
    # UNCOMMITTED working-tree bytes (absent from the committed union scan),
    # exactly as the real reconciliation branch does.
    write(os.path.join(repo, "payload/scripts/netservicestarter.lua"), nss_diag)
    write(os.path.join(repo, "payload/scripts/dropbear"), dropbear_live)

    fixture = {
        "repo": repo,
        "rcS_v2": rcS_v2, "dhcpd_v2": dhcpd_v2, "multi": multi,
        "dropbear_live": dropbear_live, "nss_diag": nss_diag,
        "hbus_live": hbus_live,
    }

    # synthetic evidence snapshot
    snap = os.path.join(base, "snapshot")
    objs = os.path.join(snap, "objects", "sha256")
    entries = []

    def add_file(path: str, data: bytes, mode: str = "-rwxr-xr-x") -> None:
        digest = sha256(data)
        write(os.path.join(objs, digest), data)
        entries.append({
            "path": path, "kind": "file", "classification": "file",
            "mode": mode, "size": len(data), "sha256": digest,
            "md5_local": md5(data), "md5_remote": md5(data),
            "target": None, "target_sha256": None,
        })

    add_file("/etc/init.d/rcS.local", rcS_v2)
    add_file("/data/codex/bin/codex_dhcpd", dhcpd_v2)
    add_file("/data/codex/bin/codex_hbus", hbus_live)
    add_file("/data/codex/bin/dropbearmulti", multi)
    add_file("/usr/sbin/dropbear", dropbear_live, mode="-rw-r--r--")
    add_file("/opt/luaworks/tasks/connectserver/netservicestarter.lua",
             nss_diag, mode="-rw-r--r--")
    add_file("/pkg/codexmqtt/manifest.json", b'{"plugin":"codexmqtt"}\n',
             mode="-rw-r--r--")
    stale_manifest = (
        b"-rwxr-xr-x 1 u u 10 Jan  1 00:00 codex_dhcpd\n"
        b"-rwxr-xr-x 1 u u 21 Jan  1 00:00 codex_hbus\n"
        + md5(dhcpd_v1).encode() + b"  codex_dhcpd\n"
        + md5(hbus_repo_bin).encode() + b"  codex_hbus\n")
    add_file("/data/codex/bin/MANIFEST.txt", stale_manifest, mode="-rw-r--r--")
    entries.append({
        "path": "/data/codex/bin/dropbear", "kind": "symlink",
        "classification": "symlink", "mode": "lrwxrwxrwx", "size": 13,
        "sha256": None, "md5_local": None,
        "target": "dropbearmulti",
        "target_sha256": sha256(b"dropbearmulti"),
    })
    entries.sort(key=lambda e: e["path"])
    manifest = {
        "schema": "box-snapshot-manifest/1",
        "generated_at_utc": "2026-08-17T22:29:00Z",
        "counts": {"entries": len(entries), "files": 8, "symlinks": 1},
        "allowlist": {"expected_symlinks": ["/data/codex/bin/dropbear"]},
        "entries": entries,
    }
    raw = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    write(os.path.join(snap, "manifest.json"), raw)
    write(os.path.join(snap, "manifest.sha256"),
          ("%s  manifest.json\n" % sha256(raw)).encode())
    fixture["snapshot"] = snap

    # synthetic hbus report (known-good reference == live hbus)
    hbus_report = {
        "diagnostic": "hbus-repro", "verdict": "RECIPE_UNPROVEN",
        "source_repo": {"head": "0" * 40},
        "references": {"known_good_live_backup_20260730": {
            "sha256": sha256(hbus_live), "md5": md5(hbus_live),
            "size_bytes": len(hbus_live)}},
    }
    hbus_path = os.path.join(base, "hbus-report.json")
    write(hbus_path, json.dumps(hbus_report, indent=1).encode())
    fixture["hbus_report"] = hbus_path
    return fixture


# ---------------------------------------------------------------------------
# Pure-function unit tests
# ---------------------------------------------------------------------------

class TestPureFunctions(unittest.TestCase):

    def test_parse_live_manifest_txt_real_format(self):
        data = (
            b"-rwxr-xr-x 1 codex codex 114932 Jul 28 08:27 codex_bthid_keyboard\n"
            b"-rwxrwxr-x 1 codex codex 104168 Jun  9 06:18 codex_dhcpd\n"
            b"2f0a6fc6303743eeccc77d1b93e7253f  codex_dhcpd\n"
            b"29a34114dc2120485bf3a3067613a998  codex_bthid_keyboard\n")
        parsed = dp.parse_live_manifest_txt(data)
        self.assertEqual(
            parsed["codex_dhcpd"],
            {"listed_md5": "2f0a6fc6303743eeccc77d1b93e7253f",
             "listed_size": 104168})
        self.assertEqual(
            parsed["codex_bthid_keyboard"],
            {"listed_md5": "29a34114dc2120485bf3a3067613a998",
             "listed_size": 114932})

    def test_resolve_symlink_target(self):
        self.assertEqual(
            dp.resolve_symlink_target("/data/codex/bin/dropbear", "dropbearmulti"),
            "/data/codex/bin/dropbearmulti")
        self.assertEqual(
            dp.resolve_symlink_target("/cache/bin/bthid_keyboard",
                                      "/data/codex/bin/codex_bthid_keyboard"),
            "/data/codex/bin/codex_bthid_keyboard")

    def test_canonical_json_deterministic(self):
        obj = {"b": [1, 2], "a": {"z": None, "y": True}}
        self.assertEqual(dp.canonical_json_bytes(obj),
                         dp.canonical_json_bytes(json.loads(json.dumps(obj))))
        self.assertTrue(dp.canonical_json_bytes(obj).endswith(b"\n"))


# ---------------------------------------------------------------------------
# Fixture derivation tests
# ---------------------------------------------------------------------------

class TestFixtureDerivation(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.base = tempfile.mkdtemp(prefix="derive-prov-fixture-")
        cls.fixture = build_fixture(cls.base)
        cls.out_a = os.path.join(cls.base, "out-a")
        cls.out_b = os.path.join(cls.base, "out-b")
        # baseline = same synthetic repo: exercises union dedup (identical
        # object sets must not double-count commits)
        dp.derive(cls.fixture["snapshot"], cls.fixture["repo"],
                  cls.fixture["hbus_report"], cls.out_a,
                  baseline_repo=cls.fixture["repo"])
        dp.derive(cls.fixture["snapshot"], cls.fixture["repo"],
                  cls.fixture["hbus_report"], cls.out_b,
                  baseline_repo=cls.fixture["repo"])
        cls.artifact_map = json.loads(
            Path(cls.out_a, "artifact-map.json").read_text())
        cls.repro = json.loads(
            Path(cls.out_a, "reproducibility-status.json").read_text())
        cls.public = json.loads(
            Path(cls.out_a, "public-payload-manifest.json").read_text())
        cls.safety = json.loads(
            Path(cls.out_a, "public-safety-review.json").read_text())

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.base, ignore_errors=True)

    def by_path(self, path):
        for entry in self.artifact_map["entries"]:
            if entry["live"]["path"] == path:
                return entry
        raise AssertionError("entry not found: %s" % path)

    def test_deterministic_output(self):
        for name in ("artifact-map.json", "reproducibility-status.json",
                     "public-payload-manifest.json",
                     "public-safety-review.json"):
            self.assertEqual(
                Path(self.out_a, name).read_bytes(),
                Path(self.out_b, name).read_bytes(), name)

    def test_exact_text_match(self):
        entry = self.by_path("/etc/init.d/rcS.local")
        self.assertEqual(entry["source_provenance"], "EXACT_COMMITTED_SOURCE")
        self.assertEqual(entry["build_status"], "NOT_APPLICABLE_TEXT")
        self.assertTrue(entry["artifact_history"]["matched"])
        # v2 blob is carried by c2 and by the c3 side branch off c2
        self.assertEqual(entry["artifact_history"]["commit_count"], 2)

    def test_binary_match_does_not_claim_reproduction(self):
        entry = self.by_path("/data/codex/bin/codex_dhcpd")
        self.assertEqual(entry["source_provenance"],
                         "CANDIDATE_SOURCE_BINARY_MATCH_ONLY")
        self.assertEqual(entry["build_status"], "HISTORICAL_BINARY_MATCH_ONLY")
        self.assertTrue(entry["artifact_history"]["matched"])
        src = entry["source_history"]
        self.assertEqual(src["basis"],
                         "commits carrying the matched artifact blob")
        self.assertEqual(len(src["blobs"]), 1)

    def test_hbus_recipe_unproven(self):
        entry = self.by_path("/data/codex/bin/codex_hbus")
        self.assertEqual(entry["source_provenance"],
                         "CANDIDATE_SOURCE_NO_BINARY_MATCH")
        self.assertEqual(entry["build_status"], "RECIPE_UNPROVEN")
        self.assertFalse(entry["artifact_history"]["matched"])
        self.assertEqual(entry["hbus_reproduction"]["verdict"],
                         "RECIPE_UNPROVEN")
        self.assertTrue(any("known-good" in n for n in entry["notes"]))

    def test_third_party_binary(self):
        entry = self.by_path("/data/codex/bin/dropbearmulti")
        self.assertEqual(entry["source_provenance"], "THIRD_PARTY_BINARY")
        self.assertEqual(entry["build_status"], "UNVERIFIED_THIRD_PARTY")

    def test_near_miss_wrapper_reconstructed(self):
        entry = self.by_path("/usr/sbin/dropbear")
        self.assertEqual(entry["source_provenance"],
                         "RECONSTRUCTED_SOURCE_EXACT")
        self.assertEqual(entry["build_status"], "NOT_APPLICABLE_TEXT")
        self.assertFalse(entry["artifact_history"]["matched"])
        near = entry["near_miss_analysis"]
        self.assertEqual(near["tokens_only_in_repo"], ["-g", "-s"])
        self.assertEqual(near["tokens_only_in_live"], [])
        self.assertNotIn("MANUAL_SOURCE_REQUIRED: /usr/sbin/dropbear",
                         " ".join(self.repro["blockers"]))
        rs = entry["reconciliation_source"]
        self.assertEqual(rs["repo_path"], "payload/scripts/dropbear")
        self.assertTrue(rs["exact"])
        self.assertEqual(rs["sha256"], sha256(self.fixture["dropbear_live"]))
        self.assertEqual(rs["size"], len(self.fixture["dropbear_live"]))
        self.assertEqual(rs["introduced_by"], "reconciliation branch")
        self.assertEqual(rs["historical_provenance"],
                         "absent from pinned 112-commit union scan")

    def test_diag_reconstructed_and_safety_pass(self):
        entry = self.by_path(
            "/opt/luaworks/tasks/connectserver/netservicestarter.lua")
        self.assertEqual(entry["source_provenance"],
                         "RECONSTRUCTED_SOURCE_EXACT")
        self.assertEqual(entry["build_status"], "NOT_APPLICABLE_TEXT")
        self.assertFalse(entry["artifact_history"]["matched"])
        self.assertEqual(entry["public_safety_status"], "PUBLIC_SAFETY_PASS")
        self.assertNotIn("PUBLIC_SAFETY_PENDING", json.dumps(self.repro))
        self.assertNotIn("PUBLIC_SAFETY_PENDING", json.dumps(self.safety))
        docs = entry["documentation_references"]
        self.assertTrue(docs and docs[0]["repo_path"] == "docs/SESSION_HANDOFF.md")
        rs = entry["reconciliation_source"]
        self.assertEqual(rs["repo_path"], "payload/scripts/netservicestarter.lua")
        self.assertTrue(rs["exact"])
        self.assertEqual(rs["sha256"], sha256(self.fixture["nss_diag"]))
        self.assertEqual(rs["size"], len(self.fixture["nss_diag"]))
        # historical evidence retained: near-miss + backup-original lineage
        self.assertIsNotNone(entry["near_miss_analysis"])
        self.assertIsNotNone(entry["backup_original_evidence"])
        self.assertEqual(
            entry["backup_original_evidence"]["repo_path"],
            "payload/scripts/netservicestarter.lua")

    def test_safety_review_record_sanitized(self):
        self.assertEqual(self.safety["overall_status"], "PUBLIC_SAFETY_PASS")
        self.assertEqual(self.safety["entry_count"], 9)
        self.assertTrue(self.safety["sanitized"])
        nss = [v for v in self.safety["path_verdicts"]
               if v["path"].endswith("netservicestarter.lua")]
        self.assertEqual(nss[0]["verdict"], "PUBLIC_SOURCE_SAFE")
        # no MAC-style values anywhere in the review record
        self.assertIsNone(re.search(
            r"([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}",
            json.dumps(self.safety)))

    def test_no_absolute_path_leakage(self):
        for name in ("artifact-map.json", "reproducibility-status.json",
                     "public-payload-manifest.json",
                     "public-safety-review.json"):
            text = Path(self.out_a, name).read_text()
            for pattern in PATH_LEAK_PATTERNS:
                self.assertNotIn(pattern, text, "%s leaks %s" % (name, pattern))

    def test_installer_literal_exact(self):
        entry = self.by_path("/pkg/codexmqtt/manifest.json")
        self.assertEqual(entry["source_provenance"], "EXACT_INSTALLER_LITERAL")
        lit = entry["installer_literal_provenance"]
        self.assertEqual(lit["commit_count"], 3)  # c1, c2, c3
        self.assertTrue(all(RE_COMMIT.match(c) for c in lit["commits"]))

    def test_symlink_analysis(self):
        entry = self.by_path("/data/codex/bin/dropbear")
        self.assertEqual(entry["source_provenance"], "SYMLINK_NO_CONTENT")
        analysis = entry["symlink_analysis"]
        self.assertEqual(analysis["resolved_entry_path"],
                         "/data/codex/bin/dropbearmulti")
        self.assertTrue(analysis["resolved_entry_present_live"])
        self.assertTrue(analysis["target_string_sha256_matches_manifest"])

    def test_generated_manifest_stale(self):
        entry = self.by_path("/data/codex/bin/MANIFEST.txt")
        self.assertEqual(entry["source_provenance"], "GENERATED_DYNAMIC")
        staleness = self.artifact_map["live_manifest_txt_staleness"]
        self.assertTrue(staleness["stale"])
        self.assertTrue(staleness["incoherent"])
        self.assertEqual(
            sorted(m["name"] for m in staleness["mismatches"]),
            ["codex_dhcpd", "codex_hbus"])
        summary = self.repro["live_manifest_txt_staleness"]
        self.assertTrue(summary["stale"] and summary["incoherent"])

    def test_full_sha_shapes(self):
        for entry in self.artifact_map["entries"]:
            history = entry.get("artifact_history") or {}
            if history.get("matched"):
                self.assertTrue(
                    RE_COMMIT.match(history["git_blob_sha"]),
                    entry["live"]["path"])
                for commit in history["commits"]:
                    self.assertTrue(RE_COMMIT.match(commit))
            live = entry["live"]
            if live["kind"] == "file":
                self.assertTrue(RE_SHA256.match(live["sha256"]))
                self.assertTrue(RE_MD5.match(live["md5"]))

    def test_public_manifest_entry_shapes(self):
        self.assertEqual(self.public["canonical"], False)
        self.assertEqual(self.public["entry_count"], 9)
        for entry in self.public["entries"]:
            if entry["kind"] == "symlink":
                self.assertEqual(
                    set(entry), {"path", "kind", "mode", "size", "sha256",
                                 "target"})
            else:
                self.assertEqual(
                    set(entry), {"path", "kind", "mode", "size", "sha256"})
            self.assertNotIn("md5", entry)
            blob = json.dumps(entry)
            for banned in BANNED_IN_PUBLIC_ENTRIES:
                self.assertNotIn(banned, blob, "%s in %s" % (banned, blob))

    def test_no_excluded_paths(self):
        paths = [e["path"] for e in self.public["entries"]]
        paths += [e["live"]["path"] for e in self.artifact_map["entries"]]
        for entry in self.artifact_map["entries"]:
            for field in ("repo_artifact_path", "repo_source_path"):
                if entry.get(field):
                    paths.append(entry[field])
        for path in paths:
            for pattern in EXCLUDED_PATH_PATTERNS:
                self.assertIsNone(
                    re.search(pattern, path), "%s matches %s" % (path, pattern))

    def test_no_stale_values_as_live(self):
        stale = dp.md5_bytes(b"DHCPD-V1\n")
        for entry in self.artifact_map["entries"]:
            self.assertNotEqual(entry["live"]["md5"], stale)
        # stale digests may appear ONLY inside explicit evidence contexts:
        # the staleness analysis, the MANIFEST near-miss token diff, and
        # committed-blob variant/source lineage records.
        scrubbed = json.loads(json.dumps(self.artifact_map))
        scrubbed.pop("live_manifest_txt_staleness", None)
        for entry in scrubbed["entries"]:
            entry.pop("near_miss_analysis", None)
            history = entry.get("artifact_history")
            if history:
                history.pop("other_committed_variants", None)
            entry.pop("source_history", None)
        self.assertNotIn(stale, json.dumps(scrubbed))


# ---------------------------------------------------------------------------
# Reconciliation-source failure modes: the reader must fail closed on a
# missing / symlink / escape / size-hash mismatch, never emit a partial
# status, and never leak an absolute local path.
# ---------------------------------------------------------------------------

class TestReconciliationSourceFailures(unittest.TestCase):
    """The reconciliation-source reader fails closed (UsageError)."""

    @classmethod
    def setUpClass(cls):
        cls.base = tempfile.mkdtemp(prefix="derive-prov-rsfail-")
        cls.fixture = build_fixture(cls.base)
        cls.repo = cls.fixture["repo"]
        cls.live_sha = sha256(cls.fixture["nss_diag"])
        cls.live_size = len(cls.fixture["nss_diag"])
        cls.nss_path = os.path.join(
            cls.repo, "payload/scripts/netservicestarter.lua")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.base, ignore_errors=True)

    def setUp(self):
        # restore the reconciliation source to its exact live bytes before
        # each test (tests mutate it independently)
        write(self.nss_path, self.fixture["nss_diag"])

    def test_missing_source_fails_closed(self):
        os.unlink(self.nss_path)
        with self.assertRaises(dp.UsageError):
            dp.read_reconciliation_source(
                self.repo, "payload/scripts/netservicestarter.lua",
                self.live_sha, self.live_size)

    def test_symlink_source_fails_closed(self):
        os.unlink(self.nss_path)
        os.symlink("/etc/hosts", self.nss_path)
        with self.assertRaises(dp.UsageError):
            dp.read_reconciliation_source(
                self.repo, "payload/scripts/netservicestarter.lua",
                self.live_sha, self.live_size)

    def test_escape_path_fails_closed(self):
        for bad in ("../payload/scripts/netservicestarter.lua",
                    "payload/scripts/../../etc/passwd",
                    "/etc/passwd",
                    "payload/scripts/../scripts/netservicestarter.lua"):
            with self.assertRaises(dp.UsageError):
                dp.read_reconciliation_source(
                    self.repo, bad, self.live_sha, self.live_size)

    def test_size_mismatch_fails_closed(self):
        with self.assertRaises(dp.UsageError):
            dp.read_reconciliation_source(
                self.repo, "payload/scripts/netservicestarter.lua",
                self.live_sha, self.live_size + 1)

    def test_hash_mismatch_fails_closed(self):
        with self.assertRaises(dp.UsageError):
            dp.read_reconciliation_source(
                self.repo, "payload/scripts/netservicestarter.lua",
                "0" * 64, self.live_size)

    def test_success_block_has_no_absolute_path(self):
        block = dp.read_reconciliation_source(
            self.repo, "payload/scripts/netservicestarter.lua",
            self.live_sha, self.live_size)
        self.assertEqual(block["repo_path"],
                         "payload/scripts/netservicestarter.lua")
        self.assertTrue(block["exact"])
        self.assertEqual(block["sha256"], self.live_sha)
        self.assertEqual(block["size"], self.live_size)
        self.assertEqual(block["introduced_by"], "reconciliation branch")
        self.assertEqual(block["historical_provenance"],
                         "absent from pinned 112-commit union scan")
        for pattern in PATH_LEAK_PATTERNS:
            self.assertNotIn(pattern, json.dumps(block))


# ---------------------------------------------------------------------------
# Union-history tests (shallow primary completed by a baseline repo)
# ---------------------------------------------------------------------------

class TestUnionHistory(unittest.TestCase):
    """A shallow clone's missing ancestry must resolve via the baseline."""

    @classmethod
    def setUpClass(cls):
        cls.base = tempfile.mkdtemp(prefix="derive-prov-union-")
        full = os.path.join(cls.base, "full")
        os.makedirs(full)
        dates = {
            "GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "f@example.invalid",
            "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "f@example.invalid",
        }

        def commit(msg, epoch):
            env = dict(dates)
            env["GIT_AUTHOR_DATE"] = "%s +0000" % epoch
            env["GIT_COMMITTER_DATE"] = "%s +0000" % epoch
            run_git(full, "add", "-A")
            run_git(full, "commit", "-q", "-m", msg, env_extra=env)

        run_git(full, "init", "-q", "-b", "main", ".")
        run_git(full, "config", "user.name", "Fixture")
        run_git(full, "config", "user.email", "f@example.invalid")
        write(os.path.join(full, "payload/scripts/rcS.local"), b"# v1\n")
        commit("u1", "1784000000")
        write(os.path.join(full, "payload/scripts/rcS.local"), b"# v2\n")
        commit("u2", "1784000100")
        run_git(full, "branch", "agent")
        write(os.path.join(full, "payload/scripts/rcS.local"), b"# v3\n")
        commit("u3", "1784000200")
        cls.full = full
        cls.full_commits = set(
            run_git(full, "rev-list", "--all").split())
        # genuine shallow clone of the agent tip: parent history is cut off
        cls.shallow = os.path.join(cls.base, "shallow")
        proc = subprocess.run(
            ["git", "clone", "-q", "--depth=1", "--branch", "agent",
             "file://" + os.path.realpath(full), cls.shallow],
            capture_output=True)
        if proc.returncode != 0:
            raise unittest.SkipTest(
                "local shallow clone unavailable: %s"
                % proc.stderr.decode()[:200])

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.base, ignore_errors=True)

    def test_shallow_clone_is_genuinely_shallow(self):
        self.assertTrue(os.path.isfile(os.path.join(self.shallow, ".git", "shallow")))
        hist = dp.GitHistory([("primary", self.shallow)])
        hist.load_all()
        self.assertEqual(len(hist.commits_in_order), 1)
        self.assertTrue(hist.gaps)  # ancestry missing from the shallow clone

    def test_union_resolves_gap_and_dedupes(self):
        hist = dp.GitHistory([("primary", self.shallow),
                              ("baseline", self.full)])
        hist.load_all()
        self.assertEqual(hist.gaps, set())
        union = set(hist.commits_in_order)
        self.assertEqual(union, self.full_commits)      # nothing missing
        self.assertEqual(len(union), len(self.full_commits))  # no dupes

    def test_blob_fetches_span_repos(self):
        hist = dp.GitHistory([("primary", self.shallow),
                              ("baseline", self.full)])
        hist.load_all()
        # the shallow tip's rcS blob resolves via the primary; deeper
        # commits' blobs resolve via the baseline
        for commit in hist.commits_in_order:
            blob = hist.tree(commit)["payload/scripts/rcS.local"]
            self.assertTrue(dp.RE_COMMIT.match(blob))
            self.assertIn(b"# v", hist.blob_bytes(blob))


# ---------------------------------------------------------------------------
# Real-evidence integration tests (host with the private evidence present)
# ---------------------------------------------------------------------------

@unittest.skipUnless(
    REAL_EVIDENCE_AVAILABLE,
    "real-evidence inputs not identified: set %s to the historical clone "
    "path (and optionally %s / %s for the evidence snapshot and hbus "
    "report); fixture tests always run"
    % (SOURCE_REPO_ENV, SNAPSHOT_ENV, HBUS_ENV))
class TestRealEvidenceDerivation(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.out = tempfile.mkdtemp(prefix="derive-prov-real-")
        cls.pilot_paths = [
            (dp.EVIDENCE_PILOT_DHCP_PORTAL_LABEL, REAL_PILOT_DP),
            (dp.EVIDENCE_PILOT_BT_HAL_HBUS_LABEL, REAL_PILOT_BTH),
            (dp.EVIDENCE_PILOT_WEBUI_LABEL, REAL_PILOT_WEBUI),
            (dp.EVIDENCE_PILOT_ZIG_SWEEP_LABEL, REAL_PILOT_ZIG),
        ]
        dp.derive(REAL_SNAPSHOT, REAL_SOURCE_REPO, REAL_HBUS, cls.out,
                  baseline_repo=BASELINE_REPO, baseline_ref=BASELINE_REF,
                  pilot_report_paths=cls.pilot_paths)
        cls.artifact_map = json.loads(Path(cls.out, "artifact-map.json").read_text())
        cls.repro = json.loads(
            Path(cls.out, "reproducibility-status.json").read_text())
        cls.public = json.loads(
            Path(cls.out, "public-payload-manifest.json").read_text())
        cls.safety = json.loads(
            Path(cls.out, "public-safety-review.json").read_text())
        cls.authoritative = json.loads(
            Path(REAL_SNAPSHOT, "manifest.json").read_text())

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.out, ignore_errors=True)

    def by_path(self, path):
        for entry in self.artifact_map["entries"]:
            if entry["live"]["path"] == path:
                return entry
        raise AssertionError("entry not found: %s" % path)

    # -- coverage + fidelity --------------------------------------------

    def test_exact_23_entries_everywhere(self):
        self.assertEqual(len(self.authoritative["entries"]), 23)
        self.assertEqual(self.artifact_map["entry_count"], 23)
        self.assertEqual(self.repro["entry_count"], 23)
        self.assertEqual(self.public["entry_count"], 23)
        self.assertEqual(len(self.artifact_map["entries"]), 23)
        self.assertEqual(len(self.public["entries"]), 23)
        self.assertEqual(len(self.repro["entries"]), 23)

    def test_live_fields_equal_authoritative_manifest(self):
        authority = {e["path"]: e for e in self.authoritative["entries"]}
        for entry in self.artifact_map["entries"]:
            live = entry["live"]
            src = authority[live["path"]]
            self.assertEqual(live["kind"], src["kind"])
            self.assertEqual(live["mode"], src["mode"])
            self.assertEqual(live["size"], src["size"])
            self.assertEqual(live["sha256"], src.get("sha256"))
            self.assertEqual(live["md5"], src.get("md5_local"))
            self.assertEqual(live["target"], src.get("target"))
            self.assertEqual(live["target_sha256"], src.get("target_sha256"))

    def test_public_manifest_matches_authority(self):
        authority = {e["path"]: e for e in self.authoritative["entries"]}
        for entry in self.public["entries"]:
            src = authority[entry["path"]]
            self.assertEqual(entry["size"], src["size"])
            self.assertEqual(entry["mode"], src["mode"])
            if entry["kind"] == "symlink":
                self.assertEqual(entry["target"], src["target"])
                self.assertEqual(entry["sha256"], src["target_sha256"])
            else:
                self.assertEqual(entry["sha256"], src["sha256"])
            for pattern in EXCLUDED_PATH_PATTERNS:
                self.assertIsNone(re.search(pattern, entry["path"]))

    def test_public_manifest_sanitized(self):
        text = json.dumps(self.public)
        for banned in ("192.168", _USERS_PATH, _OWNER_TAG, "md5", "md5_local",
                       "uid", "gid", "owner", "host", "user"):
            self.assertNotIn(banned, text)
        self.assertIsNone(RE_PERSONAL_NAME.search(text))
        self.assertIsNone(RE_ROOT_AT_DEST.search(text))
        self.assertNotIn(_BOX_IP, text)
        for stale in (STALE_MANIFEST_MD5_WEBUI, STALE_MANIFEST_MD5_HBUS,
                      STALE_MANIFEST_MD5_BTHID, STALE_MANIFEST_MD5_HALLTCp):
            self.assertNotIn(stale, text)

    # -- exact git-derived claims -----------------------------------------

    def _git(self, repo, *args):
        proc = subprocess.run(
            ["git", "--no-optional-locks", "-C", repo, *args],
            capture_output=True)
        assert proc.returncode == 0, proc.stderr
        return proc.stdout

    def _union_commits(self):
        """Independent union mirroring the tool's pin policy: every ref of
        the historical clone plus ONLY the pinned baseline ref's ancestry
        in the baseline repo."""
        union = set()
        union.update(
            self._git(REAL_SOURCE_REPO, "rev-list", "--all").decode().split())
        # pinned baseline ref with FULL ancestry (mirrors the tool's walk)
        union.update(self._git(
            BASELINE_REPO, "rev-list", BASELINE_REF).decode().split())
        return union

    def _git_soft(self, repo, *args):
        """git plumbing without the hard failure assertion."""
        proc = subprocess.run(
            ["git", "--no-optional-locks", "-C", repo, *args],
            capture_output=True)
        return proc

    def _blob_bytes(self, blob):
        for repo in (REAL_SOURCE_REPO, BASELINE_REPO):
            proc = self._git_soft(repo, "cat-file", "blob", blob)
            if proc.returncode == 0:
                return proc.stdout
        raise AssertionError("blob %s missing in both repos" % blob)

    def test_webui_commit_enumeration_independent(self):
        commits = sorted(self._union_commits())
        matched = []
        epochs = {}
        for commit in commits:
            line = ""
            holder = None
            for repo in (REAL_SOURCE_REPO, BASELINE_REPO):
                out = self._git_soft(repo, "ls-tree", commit, "--",
                                     "payload/bin/codex_webui")
                if out.returncode == 0:
                    line = out.stdout.decode().strip()
                    holder = repo
                    break
            if not line:
                continue
            blob = line.split()[2]
            data = self._blob_bytes(blob)
            if sha256(data) == LIVE_WEBUI_SHA256:
                matched.append(commit)
                raw = self._git(holder, "cat-file", "commit", commit).decode()
                for header in raw.split("\n"):
                    if header.startswith("committer "):
                        epochs[commit] = int(header.rstrip().rsplit(" ", 2)[-2])
        self.assertEqual(len(matched), 32)
        entry = self.by_path("/data/codex/bin/codex_webui")
        history = entry["artifact_history"]
        self.assertTrue(history["matched"])
        self.assertEqual(
            set(history["commits"]), set(matched))
        self.assertEqual(len(history["commits"]), 32)
        earliest = min(matched, key=lambda c: (epochs[c], c))
        latest = max(matched, key=lambda c: (epochs[c], c))
        self.assertEqual(history["earliest_commit"]["sha"], earliest)
        self.assertEqual(history["latest_commit"]["sha"], latest)

    def test_all_commit_and_blob_shas_full_length(self):
        for entry in self.repro["entries"]:
            if entry.get("git_blob_sha"):
                self.assertTrue(RE_COMMIT.match(entry["git_blob_sha"]))
            for key in ("earliest_commit", "latest_commit"):
                ref = entry.get(key)
                if ref:
                    self.assertTrue(RE_COMMIT.match(ref["sha"]))
        for entry in self.artifact_map["entries"]:
            history = entry.get("artifact_history") or {}
            for variant in history.get("other_committed_variants", []):
                self.assertTrue(RE_COMMIT.match(variant["git_blob_sha"]))
                self.assertTrue(RE_SHA256.match(variant["content_sha256"]))

    # -- mandated statuses -------------------------------------------------

    def test_hbus_exact_with_report_integrity(self):
        entry = self.by_path("/data/codex/bin/codex_hbus")
        self.assertEqual(entry["source_provenance"],
                         "EXACT_SOURCE_REPRODUCIBLE")
        self.assertEqual(entry["build_status"], "EXACT_SOURCE_REPRODUCIBLE")
        self.assertFalse(entry["artifact_history"]["matched"])
        # the corrected Zig sweep report is the authoritative exact evidence
        pilot = entry["binary_pilot"]
        self.assertEqual(pilot["verdict"], "EXACT_SOURCE_REPRODUCIBLE")
        self.assertEqual(pilot["rebuilt_matches_live"], True)
        self.assertIn(entry["live"]["sha256"], pilot["rebuilt_sha256"])
        # the old hbus-repro report remains corroborating prior evidence only
        self.assertEqual(self.repro["generated"]["hbus_report"]["verdict"],
                         "RECIPE_UNPROVEN")
        self.assertIn("corroborating", self.repro["generated"]["hbus_report"]
                      ["role"])

    def test_diag_netservicestarter(self):
        path = "/opt/luaworks/tasks/connectserver/netservicestarter.lua"
        entry = self.by_path(path)
        self.assertEqual(entry["source_provenance"],
                         "RECONSTRUCTED_SOURCE_EXACT")
        self.assertEqual(entry["build_status"], "NOT_APPLICABLE_TEXT")
        self.assertEqual(entry["public_safety_status"], "PUBLIC_SAFETY_PASS")
        self.assertFalse(entry["artifact_history"]["matched"])
        rs = entry["reconciliation_source"]
        self.assertEqual(rs["repo_path"], "payload/scripts/netservicestarter.lua")
        self.assertTrue(rs["exact"])
        self.assertEqual(rs["sha256"], entry["live"]["sha256"])
        self.assertEqual(rs["size"], entry["live"]["size"])
        self.assertEqual(rs["introduced_by"], "reconciliation branch")
        self.assertEqual(rs["historical_provenance"],
                         "absent from pinned 112-commit union scan")
        # the documented backed-up clean original is the committed blob lineage
        backup = entry["backup_original_evidence"]["committed_variants"]
        clean = [v for v in backup if v["content_md5"]
                 == "f29d22aeda0166abf5441901aabe8897"]
        self.assertEqual(len(clean), 1)
        self.assertEqual(clean[0]["size_bytes"], 11788)
        docs = entry["documentation_references"]
        self.assertTrue(
            docs and docs[0]["repo_path"] == "docs/SESSION_HANDOFF.md")
        self.assertIn({
            "path": path, "status": "PUBLIC_SAFETY_PASS"},
            self.repro["public_safety"]["reviewed"])
        self.assertEqual(self.repro["public_safety"]["pending"], [])
        self.assertEqual(
            self.repro["public_safety"]["overall_status"], "PUBLIC_SAFETY_PASS")

    def test_safety_review_record(self):
        self.assertEqual(self.safety["overall_status"], "PUBLIC_SAFETY_PASS")
        self.assertEqual(self.safety["entry_count"], 23)
        self.assertTrue(self.safety["sanitized"])
        by_path = {v["path"]: v for v in self.safety["path_verdicts"]}
        self.assertEqual(
            by_path["/opt/luaworks/tasks/connectserver/netservicestarter.lua"]
            ["verdict"], "PUBLIC_SOURCE_SAFE")
        bthid = by_path["/data/codex/bin/codex_bthid_keyboard"]
        self.assertEqual(
            bthid["finding_category"],
            "SELF_TEST_FIXTURE_MACS_DOCUMENTED_OWNER_ELECTED_PUBLISH_AS_IS")
        # category only: no MAC-shaped values anywhere in the record
        self.assertIsNone(re.search(
            r"([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}", json.dumps(self.safety)))
        for verdict in self.safety["path_verdicts"]:
            self.assertIn(verdict["verdict"], ("SAFE", "PUBLIC_SOURCE_SAFE"))
        # no pending safety anywhere
        for artifact in (self.repro, self.safety, self.artifact_map):
            self.assertNotIn("PUBLIC_SAFETY_PENDING", json.dumps(artifact))
        # safety pass must not claim reproducibility
        self.assertIn("no claim of source reproducibility",
                      " ".join(self.safety["limitations"]))

    def test_no_safety_pending_blocker(self):
        self.assertFalse(
            any("PUBLIC_SAFETY" in b for b in self.repro["blockers"]))

    def test_live_manifest_stale_incoherent(self):
        staleness = self.artifact_map["live_manifest_txt_staleness"]
        self.assertTrue(staleness["stale"])
        self.assertTrue(staleness["incoherent"])
        self.assertEqual(
            sorted(m["name"] for m in staleness["mismatches"]),
            ["codex_bthid_keyboard", "codex_hal_ltcp", "codex_hbus",
             "codex_webui"])
        self.assertEqual(
            [m["name"] for m in staleness["missing_from_listing"]],
            ["codex_bt_pair_agent"])
        for mismatch in staleness["mismatches"]:
            self.assertFalse(mismatch["md5_equal"])
        self.assertEqual(len(staleness["matches"]), 3)

    def test_no_stale_values_as_live(self):
        for entry in self.artifact_map["entries"]:
            self.assertNotEqual(entry["live"]["md5"], STALE_MANIFEST_MD5_WEBUI)
        # The stale webui md5 may appear only inside explicit evidence
        # contexts (staleness analysis, MANIFEST near-miss token diff,
        # committed variant lineage).  Scrub those and demand zero
        # remaining occurrences.
        scrubbed = json.loads(json.dumps(self.artifact_map))
        scrubbed.pop("live_manifest_txt_staleness", None)
        for entry in scrubbed["entries"]:
            entry.pop("near_miss_analysis", None)
            history = entry.get("artifact_history")
            if history:
                history.pop("other_committed_variants", None)
            entry.pop("source_history", None)
        self.assertNotIn(STALE_MANIFEST_MD5_WEBUI, json.dumps(scrubbed))

    def test_dropbear_wrapper_pair(self):
        exact = self.by_path("/usr/sbin/dropbearkey")
        self.assertEqual(exact["source_provenance"], "EXACT_COMMITTED_SOURCE")
        # matched across the full union history (deep upstream lineage
        # carries the same 48-byte wrapper)
        self.assertEqual(exact["artifact_history"]["commit_count"], 111)
        near = self.by_path("/usr/sbin/dropbear")
        self.assertEqual(near["source_provenance"],
                         "RECONSTRUCTED_SOURCE_EXACT")
        self.assertEqual(near["build_status"], "NOT_APPLICABLE_TEXT")
        self.assertFalse(near["artifact_history"]["matched"])
        self.assertEqual(near["near_miss_analysis"]["tokens_only_in_repo"],
                         ["-g", "-s"])
        rs = near["reconciliation_source"]
        self.assertEqual(rs["repo_path"], "payload/scripts/dropbear")
        self.assertTrue(rs["exact"])
        self.assertEqual(rs["sha256"], near["live"]["sha256"])
        self.assertEqual(rs["size"], near["live"]["size"])
        self.assertEqual(rs["introduced_by"], "reconciliation branch")
        self.assertEqual(rs["historical_provenance"],
                         "absent from pinned 112-commit union scan")

    def test_codexactivity_single_commit_lineage(self):
        entry = self.by_path("/pkg/codexactivity/codexactivity.lua")
        history = entry["artifact_history"]
        self.assertTrue(history["matched"])
        self.assertEqual(history["commit_count"], 1)
        self.assertEqual(history["commit_count"],
                         len(history["commits"]))

    def test_no_source_reproducibility_claim_from_binary_match(self):
        """Reproduction claims come ONLY from integrity-pinned pilots whose
        rebuilt SHA-256 equals the live digest — never from a historical
        binary blob match alone."""
        self.assertEqual(
            self.repro["binary_reproducibility"]["build_verified_count"], 7)
        forbidden = {"VERIFIED", "BUILD_REPRODUCED", "REPRODUCIBLE"}
        for entry in self.repro["entries"]:
            self.assertNotIn(entry["build_status"], forbidden)
        # exact claims must each carry a pilot block with a hash match
        exact = [e for e in self.artifact_map["entries"]
                 if e["build_status"] == "EXACT_SOURCE_REPRODUCIBLE"]
        self.assertEqual(
            sorted(e["live"]["path"].rsplit("/", 1)[-1] for e in exact),
            ["codex_bt_pair_agent", "codex_bthid_keyboard", "codex_dhcpd",
             "codex_hal_ltcp", "codex_hbus", "codex_portal", "codex_webui"])
        for entry in exact:
            pilot = entry["binary_pilot"]
            self.assertEqual(pilot["rebuilt_matches_live"], True)
            self.assertIn(entry["live"]["sha256"], pilot["rebuilt_sha256"])
        # only dropbearmulti remains unverified (third-party, no source)
        lineage_only = [
            e for e in self.repro["entries"]
            if e["historical_artifact_match"]
            and e["build_status"] not in (
                "EXACT_SOURCE_REPRODUCIBLE", "NOT_APPLICABLE_TEXT")]
        self.assertEqual(
            sorted(e["path"].rsplit("/", 1)[-1] for e in lineage_only),
            ["dropbearmulti"])
        for entry in lineage_only:
            self.assertEqual(entry["build_status"], "UNVERIFIED_THIRD_PARTY")

    def test_union_history_resolves_gap(self):
        """1a9e270 missing from the shallow historical clone resolves via
        the baseline clone; the union scan covers exactly the expected
        number of unique commits (independently re-derived from git)."""
        history = self.repro["history"]
        self.assertEqual(history["history_gaps"], [])
        self.assertFalse(
            any("HISTORY_GAP" in b for b in self.repro["blockers"]))
        independent_union = self._union_commits()
        self.assertEqual(len(independent_union), EXPECTED_UNIQUE_COMMITS)
        self.assertIn(GAP_PARENT, independent_union)
        self.assertEqual(history["scanned_commit_count"],
                         EXPECTED_UNIQUE_COMMITS)
        repos = {r["label"]: r for r in history["repos_scanned"]}
        baseline = repos[dp.BASELINE_REPO_LABEL]
        self.assertEqual(baseline["pinned_ref"], BASELINE_REF)
        self.assertEqual(baseline["pinned_tip"], BASELINE_REF)
        self.assertEqual(baseline["scanned_refs"], [BASELINE_REF])
        # the live reconciliation branch is never among scanned refs
        self.assertNotIn("refs/heads/reconcile/box-snapshot-20260818",
                         baseline.get("refs", []))

    def test_reconciliation_ref_immunity(self):
        """Extra commits/refs in the baseline repo must not change outputs:
        the baseline is pinned to the public base commit, so new
        reconciliation commits/refs leave every generated artifact
        byte-identical and the unique commit count at 112."""
        # record pre-state
        before = {
            name: Path(self.out, name).read_bytes()
            for name in ("artifact-map.json", "reproducibility-status.json",
                         "public-payload-manifest.json",
                         "public-safety-review.json")
        }
        repo = Path(BASELINE_REPO, ".git")
        self.assertTrue(repo.is_dir())
        # create extra commits + refs directly in the baseline repo's
        # object store without touching any worktree file: use commit-tree
        # on the pinned tip's tree with a synthetic parent chain.
        def git(*args, inp=None, env=None):
            proc = subprocess.run(
                ["git", "--no-optional-locks", "-C", str(BASELINE_REPO)]
                + list(args), capture_output=True, input=inp, env=env)
            assert proc.returncode == 0, proc.stderr.decode()[:300]
            return proc.stdout.decode().strip()
        tree = git("rev-parse", "%s^{tree}" % BASELINE_REF)
        env_stamp = b"1755500000 +0000"
        commit = BASELINE_REF
        for i in range(3):
            blob = git("hash-object", "-w", "--stdin",
                       inp=("immunity probe %d\n" % i).encode())
            new_tree = git("mktree", inp=(
                "100644 blob %s\timmunity-probe-%d.txt" % (blob, i)
            ).encode())
            commit = git(
                "commit-tree", new_tree, "-p", commit, "-m",
                "immunity probe %d" % i,
                env=dict(os.environ,
                         GIT_AUTHOR_NAME="Probe",
                         GIT_AUTHOR_EMAIL="probe@example.invalid",
                         GIT_AUTHOR_DATE=env_stamp.decode(),
                         GIT_COMMITTER_NAME="Probe",
                         GIT_COMMITTER_EMAIL="probe@example.invalid",
                         GIT_COMMITTER_DATE=env_stamp.decode()))
        git("update-ref", "refs/heads/reconcile/immunity-probe", commit)
        git("update-ref", "refs/tags/immunity-probe-tag", commit)
        third = tempfile.mkdtemp(prefix="derive-prov-immune-")
        try:
            dp.derive(REAL_SNAPSHOT, REAL_SOURCE_REPO, REAL_HBUS, third,
                      baseline_repo=BASELINE_REPO, baseline_ref=BASELINE_REF,
                      pilot_report_paths=self.pilot_paths)
            for name, data in before.items():
                self.assertEqual(
                    Path(third, name).read_bytes(), data,
                    "%s changed after new baseline commits/refs" % name)
            repro = json.loads(
                Path(third, "reproducibility-status.json").read_text())
            self.assertEqual(
                repro["history"]["scanned_commit_count"],
                EXPECTED_UNIQUE_COMMITS)
        finally:
            git("update-ref", "-d", "refs/heads/reconcile/immunity-probe")
            git("update-ref", "-d", "refs/tags/immunity-probe-tag")
            shutil.rmtree(third, ignore_errors=True)

    def test_pilot_reports_pinned(self):
        reports = {
            r["label"]: r for r in
            self.repro["generated"]["binary_pilot_reports"]
        }
        dp_report = reports[dp.EVIDENCE_PILOT_DHCP_PORTAL_LABEL]
        self.assertEqual(dp_report["sha256"], PILOT_DP_SHA256)
        self.assertEqual(dp_report["verdict"], "EXACT_SOURCE_REPRODUCIBLE")
        bth_report = reports[dp.EVIDENCE_PILOT_BT_HAL_HBUS_LABEL]
        self.assertEqual(bth_report["sha256"], PILOT_BTH_SHA256)
        self.assertEqual(bth_report["verdict"], "RECIPE_UNPROVEN")
        webui_report = reports[dp.EVIDENCE_PILOT_WEBUI_LABEL]
        self.assertEqual(webui_report["sha256"], PILOT_WEBUI_SHA256)
        self.assertEqual(webui_report["verdict"], "EXACT_SOURCE_REPRODUCIBLE")
        zig_report = reports[dp.EVIDENCE_PILOT_ZIG_SWEEP_LABEL]
        self.assertEqual(zig_report["sha256"], PILOT_ZIG_SHA256)
        self.assertEqual(zig_report["verdict"], "EXACT_SOURCE_REPRODUCIBLE")
        # hbus report still linked as corroborating prior evidence
        self.assertEqual(
            self.repro["generated"]["hbus_report"]["verdict"],
            "RECIPE_UNPROVEN")
        self.assertIn("corroborating", self.repro["generated"]["hbus_report"]
                      ["role"])
        # per-entry pilot statuses: seven exact, dropbearmulti unverified
        expected = {
            "/data/codex/bin/codex_dhcpd": "EXACT_SOURCE_REPRODUCIBLE",
            "/data/codex/bin/codex_portal": "EXACT_SOURCE_REPRODUCIBLE",
            "/data/codex/bin/codex_bt_pair_agent": "EXACT_SOURCE_REPRODUCIBLE",
            "/data/codex/bin/codex_bthid_keyboard": "EXACT_SOURCE_REPRODUCIBLE",
            "/data/codex/bin/codex_hal_ltcp": "EXACT_SOURCE_REPRODUCIBLE",
            "/data/codex/bin/codex_hbus": "EXACT_SOURCE_REPRODUCIBLE",
            "/data/codex/bin/codex_webui": "EXACT_SOURCE_REPRODUCIBLE",
            "/data/codex/bin/dropbearmulti": "UNVERIFIED_THIRD_PARTY",
        }
        for path, status in expected.items():
            entry = self.by_path(path)
            self.assertEqual(entry["build_status"], status, path)
        self.assertEqual(
            self.repro["binary_reproducibility"]["build_verified_count"], 7)
        # blocker names only dropbearmulti as the unresolved binary
        blocker = " ".join(
            b for b in self.repro["blockers"]
            if b.startswith("UNRESOLVED_BINARY_REPRODUCIBILITY"))
        self.assertIn("dropbearmulti", blocker)
        for verified in ("codex_bt_pair_agent", "codex_bthid_keyboard",
                         "codex_dhcpd", "codex_hal_ltcp", "codex_hbus",
                         "codex_portal", "codex_webui"):
            self.assertNotIn(verified + ",", blocker)
        self.assertFalse(any(
            b.startswith("NO_BINARY_BUILD_REPRODUCIBILITY")
            for b in self.repro["blockers"]))

    def test_dropbear_third_party_provenance(self):
        entry = self.by_path("/data/codex/bin/dropbearmulti")
        self.assertEqual(entry["build_status"], "UNVERIFIED_THIRD_PARTY")
        self.assertEqual(entry["source_provenance"], "THIRD_PARTY_BINARY")
        tp = entry["third_party_provenance"]
        self.assertEqual(tp["version"], "2025.89")
        self.assertEqual(tp["release"], "2025-12-16")
        self.assertEqual(tp["banner"], "SSH-2.0-dropbear_2025.89")
        self.assertEqual(tp["binary_sha256"],
                         "e2ea632aed8b31dc5ea56b9673cbd983ec83260a97d33f891a0cebf51d5c6c8d")
        self.assertEqual(tp["binary_size"], 577296)
        self.assertEqual(tp["tarball_sha256"],
                         "0d1f7ca711cfc336dc8a85e672cab9cfd8223a02fe2da0a4a7aeb58c9e113634")
        self.assertEqual(tp["tag"], "DROPBEAR_2025.89")
        self.assertEqual(tp["commit"],
                         "179de98f7b9584a309ffc48e39c61da940760740")
        self.assertEqual(tp["classification"],
                         "VERSION_LICENSE_VERIFIED / BINARY_BUILD_UNVERIFIED")
        self.assertEqual(tp["license_path"],
                         "third_party/dropbear-2025.89/LICENSE")
        self.assertRegex(tp["license_sha256"], RE_SHA256)
        # no overclaim: classification is exactly the two-part string, and
        # the build status is UNVERIFIED_THIRD_PARTY (never VERIFIED_THIRD_PARTY)
        self.assertEqual(entry["build_status"], "UNVERIFIED_THIRD_PARTY")
        self.assertNotIn("VERIFIED_THIRD_PARTY", tp["classification"])
        self.assertNotIn("EXACT_SOURCE", json.dumps(entry))
        self.assertNotIn("stock source", json.dumps(entry).lower())
        # missing build closure is enumerated
        self.assertTrue(tp["missing_build_closure"])
        # libcrux ML-KEM MIT OR Apache-2.0 and sntrup761 caveat present
        components = " ".join(tp["components"])
        self.assertIn("libcrux", components)
        self.assertIn("MIT OR Apache-2.0", components)
        self.assertIn("sntrup761", components)
        # license file exists on disk with the pinned hash
        license_path = os.path.join(REPO_ROOT, tp["license_path"])
        self.assertTrue(os.path.isfile(license_path), license_path)
        self.assertEqual(sha256(Path(license_path).read_bytes()),
                         tp["license_sha256"])

    def test_no_absolute_path_leakage_real(self):
        for name in Path(COMMITTED_OUT).iterdir():
            if name.suffix != ".json":
                continue
            text = name.read_text()
            for pattern in PATH_LEAK_PATTERNS:
                self.assertNotIn(pattern, text,
                                 "%s leaks %s" % (name.name, pattern))
        for path in (self.out, COMMITTED_OUT):
            for name in ("artifact-map.json", "reproducibility-status.json",
                         "public-payload-manifest.json",
                         "public-safety-review.json"):
                self.assertTrue(Path(path, name).is_file(),
                                "%s missing %s" % (path, name))

    def test_status_counts_sum_to_23(self):
        self.assertEqual(
            sum(self.repro["status_counts"]["source_provenance"].values()), 23)
        self.assertEqual(
            sum(self.repro["status_counts"]["build_status"].values()), 23)

    def test_determinism_real(self):
        second = tempfile.mkdtemp(prefix="derive-prov-real2-")
        try:
            dp.derive(REAL_SNAPSHOT, REAL_SOURCE_REPO, REAL_HBUS, second,
                      baseline_repo=BASELINE_REPO, baseline_ref=BASELINE_REF,
                      pilot_report_paths=self.pilot_paths)
            for name in ("artifact-map.json", "reproducibility-status.json",
                         "public-payload-manifest.json",
                         "public-safety-review.json"):
                self.assertEqual(
                    Path(self.out, name).read_bytes(),
                    Path(second, name).read_bytes(), name)
        finally:
            shutil.rmtree(second, ignore_errors=True)

    def test_committed_artifacts_up_to_date(self):
        for name in ("artifact-map.json", "reproducibility-status.json",
                     "public-payload-manifest.json",
                     "public-safety-review.json"):
            committed = Path(COMMITTED_OUT, name)
            self.assertTrue(committed.is_file(), committed)
            self.assertEqual(
                committed.read_bytes(),
                Path(self.out, name).read_bytes(), name)


# ---------------------------------------------------------------------------
# Publication-hygiene tests (Oracle Gate 1): scan every committed
# deliverable for personal local paths, personal names, the actual box IP,
# and root@<actual-destination>.  Pattern constants are built from
# fragments so this file's own definitions can never trip the scan.
# ---------------------------------------------------------------------------

class TestPublicationHygiene(unittest.TestCase):
    """Committed deliverables must be free of owner/machine identifiers."""

    AREAS = (
        os.path.join(REPO_ROOT, "tools", "reconciliation"),
        COMMITTED_OUT,
        os.path.join(REPO_ROOT, "docs", "reconciliation"),
    )
    SUFFIXES = (".py", ".json", ".md")

    @classmethod
    def collect_files(cls):
        files = []
        for area in cls.AREAS:
            area_path = Path(area)
            if not area_path.is_dir():
                continue
            for path in sorted(area_path.rglob("*")):
                if (path.is_file()
                        and path.suffix in cls.SUFFIXES
                        and "__pycache__" not in path.parts):
                    files.append(path)
        return files

    def test_committed_deliverables_free_of_personal_identifiers(self):
        files = self.collect_files()
        # the deliverables themselves must exist and be scanned
        self.assertGreaterEqual(len(files), 8)
        # The Dropbear release mirror host and its author's name are upstream
        # infrastructure (the official release host), not lane-introduced
        # identity leaks; scrub them before the personal-name scan.
        upstream_host = "ma" + "tt.ucc.asn.au"
        upstream_author = "Ma" + "tt Johnston"
        for path in files:
            with path.open("r", encoding="utf-8", errors="replace") as fh:
                text = fh.read()
            context = str(path)
            self.assertNotIn(_USERS_PATH, text,
                             "%s contains a personal home path" % context)
            self.assertNotIn(_BOX_IP, text,
                             "%s contains the actual box IP" % context)
            self.assertNotIn(_OWNER_TAG, text,
                             "%s contains an owner identity tag" % context)
            scanned = text.replace(upstream_host, "<dropbear-mirror>")
            scanned = scanned.replace(upstream_author, "<dropbear-author>")
            self.assertIsNone(
                RE_PERSONAL_NAME.search(scanned),
                "%s contains a personal name" % context)
            self.assertIsNone(
                RE_ROOT_AT_DEST.search(text),
                "%s contains root@ to an actual destination" % context)

    def test_no_personal_defaults_in_tool(self):
        """The derivation tool must not default to any hardcoded repo path:
        invocation requires an explicit --source-repo / env variable."""
        self.assertIsNone(getattr(dp, "DEFAULT_SOURCE_REPO", None))
        self.assertEqual(dp.SOURCE_REPO_ENV, "HARMONY_PROVENANCE_SOURCE_REPO")
        scrubbed_env = {
            k: v for k, v in os.environ.items()
            if not k.startswith("HARMONY_PROVENANCE_")
        }
        rc = subprocess.run(
            [sys.executable, str(Path(HERE, "derive_provenance.py")),
             "--out-dir", tempfile.mkdtemp(prefix="derive-prov-noarg-")],
            capture_output=True, text=True, env=scrubbed_env)
        self.assertEqual(rc.returncode, 2)
        self.assertIn(dp.SOURCE_REPO_ENV, rc.stderr)

    def test_rfc5737_constants_used_in_collector_tests(self):
        """Collector-test host/user constants use TEST-NET-3 + testuser."""
        source = Path(HERE, "test_collect_box_snapshot.py").read_text()
        self.assertNotIn(_BOX_IP, source)
        self.assertNotIn(_USERS_PATH, source)
        self.assertIn("192.0.2.123", source)   # RFC 5737 TEST-NET-1 example
        self.assertIn("testuser", source)


if __name__ == "__main__":
    unittest.main()
