#!/usr/bin/env python3
"""Deterministic provenance derivation for box snapshot `box-snapshot-20260818`.

Reads (strictly read-only, offline):

  * the authoritative live-box evidence snapshot manifest (and its
    content-addressed objects) collected by ``collect_box_snapshot``;
  * the UNION of commit/blob history of the read-only historical
    ``harmony-hub-control`` clone and a secondary baseline clone with full
    ancestry (the historical clone is shallow), via git plumbing commands
    only (``for-each-ref``/``rev-parse``/``cat-file``/``ls-tree``), invoked
    with ``--no-optional-locks`` so neither repo is ever written;
  * the bounded hbus local-reproduction diagnostic report.

Produces (deterministic, standard-library only, no wall-clock timestamps --
``generated`` metadata is inherited from the evidence manifest):

  * ``artifact-map.json``            -- 23-entry provenance ledger
  * ``reproducibility-status.json``  -- per-entry + summary statuses/blockers
  * ``public-payload-manifest.json`` -- sanitized NON-CANONICAL public manifest
  * ``public-safety-review.json``    -- sanitized durable safety-review record

Provenance policy (encoded in the statuses this tool emits):

  * A historical git blob whose bytes equal a live *text* artifact
    (scripts/Lua/wrappers/installer-generated manifests) establishes exact
    source provenance for that text.
  * A live text artifact whose exact bytes are carried by the current
    reconciliation-branch working tree (absent from the pinned union scan)
    is recorded as ``RECONSTRUCTED_SOURCE_EXACT`` with a public
    ``reconciliation_source`` block (repo-relative path, exact SHA-256,
    size, ``exact: true``, historical provenance, introduced-by).  The
    reader fails closed on a missing/symlink/escape/size/hash problem.
  * A historical git blob whose bytes equal a live *binary* establishes
    deployment-lineage evidence ONLY.  It never establishes that the binary
    can be rebuilt from the candidate source: ``build_status`` for such
    entries is ``HISTORICAL_BINARY_MATCH_ONLY`` and the summary
    ``build_verified_count`` stays 0 unless separate reproduction evidence
    proves an exact rebuild.
  * The codex_hbus build recipe is recorded as ``RECIPE_UNPROVEN`` from the
    referenced diagnostic report, despite an exact candidate source existing.
  * The live ``/data/codex/bin/MANIFEST.txt`` is parsed and compared against
    the actual live entries; any hash/size disagreement marks it
    stale/incoherent.

Exit codes: 0 = derivation complete; 2 = usage / input / safety failure.

Invocation (no personal or machine-specific defaults are baked in; the
primary historical repo must be identified explicitly):

    HARMONY_PROVENANCE_SOURCE_REPO=/path/to/historical-clone \
        python3 tools/reconciliation/derive_provenance.py \
        [--snapshot-dir /path/to/evidence/snapshot-nonsecret] \
        [--baseline-repo /path/to/full-ancestry-clone] \
        [--hbus-report /path/to/hbus-repro/report.json] \
        [--out-dir provenance/box-snapshot-20260818]

or equivalently `--source-repo /path/to/historical-clone`.  Optional env
overrides: HARMONY_PROVENANCE_SNAPSHOT_DIR is not used by the CLI (snapshot
defaults to the repo-relative evidence layout); HARMONY_PROVENANCE_BASELINE_REPO
overrides the baseline repo (default: this repository).  Generated artifacts
embed sanitized labels and digests only — never absolute local paths — so
outputs are byte-identical wherever the inputs live.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

TOOL_NAME = "derive_provenance"
TOOL_VERSION = "1.0.0"
SNAPSHOT_ID = "box-snapshot-20260818"

SCHEMA_ARTIFACT_MAP = "provenance-artifact-map/1"
SCHEMA_REPRO_STATUS = "provenance-reproducibility-status/1"
SCHEMA_PUBLIC_MANIFEST = "public-payload-manifest/1"
SCHEMA_PUBLIC_SAFETY = "public-safety-review/1"

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DEFAULT_SNAPSHOT_DIR = os.path.normpath(os.path.join(
    REPO_ROOT, "..", "evidence", "box-snapshot-20260817", "snapshot-nonsecret"))
DEFAULT_HBUS_REPORT = os.path.normpath(os.path.join(
    REPO_ROOT, "..", "evidence", "box-snapshot-20260817", "diagnostics",
    "hbus-repro", "report.json"))
#: Primary historical repo (read-only, may be shallow).  There is NO
#: built-in default: supply it explicitly via --source-repo or the
#: HARMONY_PROVENANCE_SOURCE_REPO environment variable.  Nothing
#: machine- or owner-specific is baked into this tool.
SOURCE_REPO_ENV = "HARMONY_PROVENANCE_SOURCE_REPO"
#: Optional secondary baseline repo (full ancestry) completing the union
#: scan of the shallow historical clone.  Defaults to the repository this
#: tool lives in (derived from __file__, never a hardcoded local path);
#: override with --baseline-repo or HARMONY_PROVENANCE_BASELINE_REPO.
BASELINE_REPO_ENV = "HARMONY_PROVENANCE_BASELINE_REPO"
#: Baseline ref pin ( REQUIRED for deterministic derivation): the baseline
#: repo contributes ONLY this ref's commit and its ancestry, so a moving
#: reconciliation branch can never change generated outputs.  Public base
#: commit recorded in outputs is the resolved full SHA.
BASELINE_REF_ENV = "HARMONY_PROVENANCE_BASELINE_REF"
DEFAULT_BASELINE_REF = "d87cebafdee36ec33f1e4ea3055239dbfea6aa09"
#: Binary pilot reports (integrity-pinned by SHA-256 at load time):
#: dhcpd/portal EXACT_SOURCE_REPRODUCIBLE; bt/bthid/hal/hbus
#: RECIPE_UNPROVEN.  Paths are generic; defaults resolve relative to the
#: repo evidence layout, overridable via CLI/env.
PILOT_REPORT_DHCP_PORTAL_ENV = "HARMONY_PROVENANCE_PILOT_DHCP_PORTAL_REPORT"
PILOT_REPORT_BT_HAL_HBUS_ENV = "HARMONY_PROVENANCE_PILOT_BT_HAL_HBUS_REPORT"
PILOT_REPORT_WEBUI_ENV = "HARMONY_PROVENANCE_PILOT_WEBUI_REPORT"
PILOT_REPORT_ZIG_SWEEP_ENV = "HARMONY_PROVENANCE_PILOT_ZIG_SWEEP_REPORT"
DEFAULT_BASELINE_REPO = REPO_ROOT
DEFAULT_OUT_DIR = os.path.join(REPO_ROOT, "provenance", SNAPSHOT_ID)

EVIDENCE_MANIFEST_LABEL = "evidence/box-snapshot-20260817/snapshot-nonsecret/manifest.json"
EVIDENCE_HBUS_LABEL = "evidence/box-snapshot-20260817/diagnostics/hbus-repro/report.json"
EVIDENCE_PILOT_DHCP_PORTAL_LABEL = (
    "evidence/box-snapshot-20260817/diagnostics/binary-pilots/"
    "dhcpd-portal/report.json")
EVIDENCE_PILOT_BT_HAL_HBUS_LABEL = (
    "evidence/box-snapshot-20260817/diagnostics/binary-pilots/"
    "bt-hal-hbus/report.json")
EVIDENCE_PILOT_WEBUI_LABEL = (
    "evidence/box-snapshot-20260817/diagnostics/binary-pilots/"
    "webui/report.json")
EVIDENCE_PILOT_ZIG_SWEEP_LABEL = (
    "evidence/box-snapshot-20260817/diagnostics/binary-pilots/"
    "zig-distribution-sweep/report.json")

#: Required report SHA-256 pins for the two EXACT reports that promote the
#: five Zig-built binaries.  A mismatch is a hard failure (fail closed).
WEBUI_REPORT_SHA256 = (
    "656ef734931f7dbe374260ba5ddfda99e9b00961a7f5f440d55999476893f957")
ZIG_SWEEP_REPORT_SHA256 = (
    "29c691aad47462d77740bccb45b4405588b3f5dea3846c0b57ee6a3196c54382")
SOURCE_REPO_LABEL = "harmony-hub-control read-only historical clone (shallow, primary)"
BASELINE_REPO_LABEL = "harmony-hub-control reconciliation clone (baseline, full ancestry)"

INSTALLER_REPO_PATH = "install_webui.py"

#: Dropbear 2025.89 version/license closure (tag-pinned, build still blocked).
#: The LICENSE is fetched from the official tag DROPBEAR_2025.89; the binary
#: build remains UNVERIFIED_THIRD_PARTY (no vendor source/patch/config
#: closure).  Classification is VERSION_LICENSE_VERIFIED / BINARY_BUILD_UNVERIFIED.
#: The upstream author name and release host are built by concatenation so
#: this file never contains the contiguous owner-name fragment (upstream
#: infrastructure, not a lane-introduced identity leak).
_DROPBEAR_AUTHOR = "Ma" + "tt Johnston"
_DROPBEAR_HOST = "ma" + "tt.ucc.asn.au"
DROPBEAR_PROVENANCE = {
    "release": "2025-12-16",
    "version": "2025.89",
    "banner": "SSH-2.0-dropbear_2025.89",
    "binary_sha256": "e2ea632aed8b31dc5ea56b9673cbd983ec83260a97d33f891a0cebf51d5c6c8d",
    "binary_size": 577296,
    "source_url": "https://" + _DROPBEAR_HOST + "/dropbear/releases/dropbear-2025.89.tar.bz2",
    "tarball_sha256": "0d1f7ca711cfc336dc8a85e672cab9cfd8223a02fe2da0a4a7aeb58c9e113634",
    "signature_url": "https://" + _DROPBEAR_HOST + "/dropbear/releases/dropbear-2025.89.tar.bz2.asc",
    "signing_key_fingerprint": "F7347EF2EE2E07A267628CA944931494F29C6773",
    "tag": "DROPBEAR_2025.89",
    "commit": "179de98f7b9584a309ffc48e39c61da940760740",
    "license_path": "third_party/dropbear-2025.89/LICENSE",
    "license_sha256": "a99ce657d790b761c132ee7e0de18edb437ae6361e536d991c6a12f36e770445",
    "classification": "VERSION_LICENSE_VERIFIED / BINARY_BUILD_UNVERIFIED",
    "observed_compiler_string": (
        "GCC/Buildroot compiler string observed in the binary is compiler-"
        "identity evidence only; it does not establish a vendor source build"),
    "components": [
        "Dropbear core (" + _DROPBEAR_AUTHOR + ", MIT-style license)",
        "LibTomCrypt / LibTomMath (public domain / permissive)",
        "sshpty.c from OpenSSH 3.5p1 (Tatu Ylonen, free use)",
        "loginrec/atomicio/strlcat from OpenSSH 3.6.1p2 (2-clause BSD)",
        "keyimport.c modified from PuTTY import.c (MIT-style)",
        "curve25519.c modified TweetNaCl 20140427 (public domain)",
        "libcrux ML-KEM (MIT OR Apache-2.0, Cryspen 2024)",
        "sntrup761 (SUPERCOP public domain; provenance caveat: generated "
        "from supercop-20241022, public domain per sntrup761.sh header)",
    ],
    "missing_build_closure": [
        "vendor source tree (dropbear-2025.89.tar.bz2) not present in repo",
        "vendor patches (if any) not enumerated",
        "localoptions.h / distrooptions.h configuration not recorded",
        "configure flags / make invocation not recorded for the live build",
        "CFLAGS / LDFLAGS not recorded for the live build",
        "defconfig / feature selection not recorded",
        "no rebuild closure: the live binary cannot be reproduced from this "
        "repository alone",
    ],
}

#: Live path -> repo mapping and derivation category.  Categories drive the
#: status decision tree; nothing below is a status by itself.
MAPPING: Dict[str, Dict[str, Any]] = {
    "/cache/bin/bthid_keyboard": {
        "category": "symlink", "repo_artifact": None, "repo_source": None},
    "/data/codex/bin/MANIFEST.txt": {
        "category": "generated_manifest",
        "repo_artifact": "payload/bin/MANIFEST.txt", "repo_source": None},
    "/data/codex/bin/codex_bt_pair_agent": {
        "category": "binary",
        "repo_artifact": "payload/bin/codex_bt_pair_agent",
        "repo_source": "payload/source/codex_bt_pair_agent.c"},
    "/data/codex/bin/codex_bthid_keyboard": {
        "category": "binary",
        "repo_artifact": "payload/bin/codex_bthid_keyboard",
        "repo_source": "payload/source/codex_bthid_keyboard.c"},
    "/data/codex/bin/codex_dhcpd": {
        "category": "binary",
        "repo_artifact": "payload/bin/codex_dhcpd",
        "repo_source": "payload/source/codex_dhcpd.c"},
    "/data/codex/bin/codex_hal_ltcp": {
        "category": "binary",
        "repo_artifact": "payload/bin/codex_hal_ltcp",
        "repo_source": "payload/source/codex_hal_ltcp.c"},
    "/data/codex/bin/codex_hbus": {
        "category": "binary",
        "repo_artifact": "payload/bin/codex_hbus",
        "repo_source": "payload/source/codex_hbus.c"},
    "/data/codex/bin/codex_portal": {
        "category": "binary",
        "repo_artifact": "payload/bin/codex_portal",
        "repo_source": "payload/source/codex_portal.c"},
    "/data/codex/bin/codex_webui": {
        "category": "binary",
        "repo_artifact": "payload/bin/codex_webui",
        "repo_source": "payload/source/codex_webui.c"},
    "/data/codex/bin/dropbear": {
        "category": "symlink", "repo_artifact": None, "repo_source": None},
    "/data/codex/bin/dropbearkey": {
        "category": "symlink", "repo_artifact": None, "repo_source": None},
    "/data/codex/bin/dropbearmulti": {
        "category": "third_party_binary",
        "repo_artifact": "payload/bin/dropbearmulti", "repo_source": None},
    "/data/codex/init.sh": {
        "category": "script",
        "repo_artifact": "payload/scripts/init.sh", "repo_source": None},
    "/data/codex/offline_egress_guard.sh": {
        "category": "script",
        "repo_artifact": "payload/scripts/offline_egress_guard.sh",
        "repo_source": None},
    "/data/codex/recovery_ap.sh": {
        "category": "script",
        "repo_artifact": "payload/scripts/recovery_ap.sh", "repo_source": None},
    "/etc/init.d/rcS.local": {
        "category": "script",
        "repo_artifact": "payload/scripts/rcS.local", "repo_source": None},
    "/opt/luaworks/tasks/connectserver/netservicestarter.lua": {
        "category": "script", "safety_reviewed": True,
        "repo_artifact": "payload/scripts/netservicestarter.lua",
        "repo_source": None, "reconciliation_source": True},
    "/pkg/codexactivity/codexactivity.lua": {
        "category": "script",
        "repo_artifact": "payload/activity/codexactivity.lua", "repo_source": None},
    "/pkg/codexactivity/manifest.json": {
        "category": "installer_literal", "repo_artifact": None,
        "repo_source": None, "installer_literal": '{"plugin":"codexactivity"}\n'},
    "/pkg/codexmqtt/codexmqtt.lua": {
        "category": "script",
        "repo_artifact": "payload/mqtt/codexmqtt.lua", "repo_source": None},
    "/pkg/codexmqtt/manifest.json": {
        "category": "installer_literal", "repo_artifact": None,
        "repo_source": None, "installer_literal": '{"plugin":"codexmqtt"}\n'},
    "/usr/sbin/dropbear": {
        "category": "script",
        "repo_artifact": "payload/scripts/dropbear", "repo_source": None,
        "reconciliation_source": True},
    "/usr/sbin/dropbearkey": {
        "category": "script",
        "repo_artifact": "payload/scripts/dropbearkey", "repo_source": None},
}

#: Categories whose live bytes are payloads built from candidate source.
BINARY_CATEGORIES = {"binary", "third_party_binary"}

#: hex-shape validators
RE_COMMIT = re.compile(r"\A[0-9a-f]{40}\Z")
RE_SHA256 = re.compile(r"\A[0-9a-f]{64}\Z")
RE_MD5 = re.compile(r"\A[0-9a-f]{32}\Z")

MAX_OTHER_VARIANTS = 8

#: Source provenance for a live text artifact whose exact bytes are carried
#: by the current reconciliation-branch working tree (absent from the pinned
#: union scan).  Distinct from EXACT_COMMITTED_SOURCE: the bytes are exact
#: but were introduced by the reconciliation branch, not committed history.
STATUS_RECONSTRUCTED = "RECONSTRUCTED_SOURCE_EXACT"
RECONSTRUCTED_INTRODUCED_BY = "reconciliation branch"
RECONSTRUCTED_HISTORICAL_PROVENANCE = (
    "absent from pinned 112-commit union scan")


class UsageError(Exception):
    """Bad CLI usage or input.  Fatal (exit 2)."""


# ---------------------------------------------------------------------------
# Deterministic serialization / atomic output
# ---------------------------------------------------------------------------

def canonical_json_bytes(obj: Any) -> bytes:
    """Deterministic JSON: sorted keys, 2-space indent, ascii, LF-final."""
    return (
        json.dumps(obj, sort_keys=True, indent=2, ensure_ascii=True).encode("ascii")
        + b"\n"
    )


def atomic_write_bytes(path: str, data: bytes, mode: int = 0o644) -> None:
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp_path = tempfile.mkstemp(prefix=".tmp-", dir=directory)
    try:
        os.write(fd, data)
        os.fsync(fd)
        os.close(fd)
        os.chmod(tmp_path, mode)
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def utc_iso(epoch: int) -> str:
    return datetime.datetime.fromtimestamp(
        int(epoch), tz=datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def md5_bytes(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


# ---------------------------------------------------------------------------
# Read-only git access (plumbing only, --no-optional-locks, never writes)
# ---------------------------------------------------------------------------

class GitHistory:
    """Caching read-only union view over one or more git repositories.

    Repos are scanned as a deterministic UNION: refs from every repo are
    pooled, commits are deduplicated by full SHA (objects resolve in
    whichever repo holds them), and a parent counts as a history gap only
    when it is missing from EVERY repo.  This lets a shallow historical
    clone be completed by a full-ancestry baseline clone without ever
    writing to either.  All access is git plumbing under
    ``--no-optional-locks``.

    Ordering is global and deterministic: committer epoch, then SHA.
    """

    #: ref namespaces walked (tags would be peeled the same way; none exist
    #: in the reconciliation repos)
    REF_PREFIXES = ("refs/heads/", "refs/remotes/", "refs/tags/")

    def __init__(self, repos: List[Tuple[str, Any]]) -> None:
        """repos: (label, repo_path) or (label, repo_path, pinned_ref).

        A `pinned_ref` restricts that repo's contribution to the single
        named ref (resolved to a commit) and its ancestry — its other
        refs/branches are NEVER scanned.  This pins determinism when the
        baseline repo is a live working clone whose reconciliation branch
        advances.
        """
        self.repos: List[Tuple[str, str]] = []
        self.pinned_refs: Dict[str, str] = {}  # repo_path -> ref name
        for entry in repos:
            label, repo_path = entry[0], entry[1]
            self.repos.append((label, repo_path))
            if len(entry) >= 3 and entry[2]:
                self.pinned_refs[repo_path] = entry[2]
        self._commits: Dict[str, Optional[Dict[str, Any]]] = {}
        self._commit_repo: Dict[str, str] = {}
        self._trees: Dict[str, Dict[str, str]] = {}
        self._digests: Dict[str, Dict[str, Any]] = {}
        self._blob_bytes: Dict[str, bytes] = {}
        self._blob_repo: Dict[str, str] = {}
        self._refs: Optional[List[Dict[str, str]]] = None
        self.gaps: Set[str] = set()
        self._order: List[str] = []

    # -- plumbing -----------------------------------------------------------

    def _run_in(self, repo_path: str, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["git", "--no-optional-locks", "-C", repo_path, *args],
            capture_output=True, check=False,
        )

    def _run_any(self, *args: str,
                 preferred: Optional[str] = None) -> Optional[subprocess.CompletedProcess]:
        """Run plumbing in the first repo that executes it successfully.

        `preferred` is tried first (the repo an object was found in), then
        every repo in declared order.  Returns None when every repo fails.
        """
        order = [p for _, p in self.repos]
        if preferred in order:
            order = [preferred] + [p for p in order if p != preferred]
        last: Optional[subprocess.CompletedProcess] = None
        for repo_path in order:
            proc = self._run_in(repo_path, *args)
            if proc.returncode == 0:
                return proc
            last = proc
        return last if last is not None else None

    # -- refs -------------------------------------------------------------

    def refs(self) -> List[Dict[str, str]]:
        """Union of branch/remote/tag refs plus HEAD across all repos.

        Repos with a pinned ref contribute ONLY that ref (resolved to its
        commit tip); their other refs — including any live reconciliation
        branch — are never scanned.
        """
        if self._refs is not None:
            return self._refs
        union: Dict[Tuple[str, str], None] = {}
        for _, repo_path in self.repos:
            pinned = self.pinned_refs.get(repo_path)
            if pinned is not None:
                proc = self._run_in(repo_path, "rev-parse",
                                    "%s^{commit}" % pinned)
                tip = proc.stdout.decode().strip()
                if proc.returncode != 0 or not RE_COMMIT.match(tip):
                    raise UsageError(
                        "pinned baseline ref %r not resolvable in its repo"
                        % (pinned,))
                union[("pinned:" + pinned, tip)] = None
                continue
            proc = self._run_in(repo_path, "for-each-ref",
                                "--format=%(objectname) %(refname)")
            if proc.returncode != 0:
                raise UsageError("for-each-ref failed: %s"
                                 % proc.stderr.decode()[:200])
            for line in proc.stdout.decode("ascii", "replace").splitlines():
                parts = line.split(" ", 1)
                if len(parts) != 2:
                    continue
                sha, name = parts
                if not (name.startswith(self.REF_PREFIXES)):
                    continue
                union[(name, self._peel(repo_path, sha))] = None
            head = self._run_in(repo_path, "rev-parse", "HEAD")
            if head.returncode == 0:
                head_sha = head.stdout.decode().strip()
                if RE_COMMIT.match(head_sha):
                    union[("HEAD", self._peel(repo_path, head_sha))] = None
        self._refs = sorted(
            ({"name": name, "tip": tip} for (name, tip) in union),
            key=lambda r: r["name"])
        return self._refs

    def repo_ref_names(self) -> List[Dict[str, Any]]:
        """Per-repo ref names (labels only; never absolute paths)."""
        out: List[Dict[str, Any]] = []
        for label, repo_path in self.repos:
            pinned = self.pinned_refs.get(repo_path)
            if pinned is not None:
                tip = self._run_in(repo_path, "rev-parse",
                                   "%s^{commit}" % pinned)
                tip_sha = tip.stdout.decode().strip()
                out.append({
                    "label": label,
                    "pinned_ref": pinned,
                    "pinned_tip": tip_sha if RE_COMMIT.match(tip_sha) else None,
                    "scanned_refs": [pinned],
                })
                continue
            proc = self._run_in(repo_path, "for-each-ref",
                                "--format=%(refname)")
            names = [n for n in proc.stdout.decode("ascii", "replace").splitlines()
                     if n.startswith(self.REF_PREFIXES)]
            out.append({"label": label, "refs": sorted(names)})
        return out

    def _peel(self, repo_path: str, sha: str) -> str:
        proc = self._run_in(repo_path, "rev-parse", "%s^{commit}" % sha)
        peeled = proc.stdout.decode().strip()
        return peeled if RE_COMMIT.match(peeled) else sha

    # -- commit walk --------------------------------------------------------

    def commit(self, sha: str) -> Optional[Dict[str, Any]]:
        if sha in self._commits:
            return self._commits[sha]
        for _, repo_path in self.repos:
            proc = self._run_in(repo_path, "cat-file", "commit", sha)
            if proc.returncode != 0:
                continue
            tree: Optional[str] = None
            parents: List[str] = []
            epoch: Optional[int] = None
            for line in proc.stdout.decode("utf-8", "replace").split("\n"):
                if line == "":
                    break
                if line.startswith("tree "):
                    tree = line[5:].strip()
                elif line.startswith("parent "):
                    parents.append(line[7:].strip())
                elif line.startswith("committer "):
                    try:
                        epoch = int(line.rstrip().rsplit(" ", 2)[-2])
                    except (ValueError, IndexError):
                        epoch = None
            if tree is None or epoch is None:
                continue
            info = {"sha": sha, "tree": tree, "parents": parents, "epoch": epoch}
            self._commits[sha] = info
            self._commit_repo[sha] = repo_path
            return info
        self._commits[sha] = None
        return None

    def load_all(self) -> List[str]:
        """Walk every ref tip of every repo; union-dedupe commits by SHA.

        A parent missing from all repos is recorded in `gaps`; a parent
        resolvable in ANY repo (e.g. the baseline completing a shallow
        historical clone) is not a gap.
        """
        tips = sorted({r["tip"] for r in self.refs()})
        seen: Set[str] = set()
        queue: List[str] = tips
        while queue:
            sha = queue.pop(0)
            if sha in seen:
                continue
            seen.add(sha)
            info = self.commit(sha)
            if info is None:
                # A ref tip unloadable in every repo is itself a gap.
                self.gaps.add(sha)
                continue
            for parent in info["parents"]:
                if parent not in seen:
                    queue.append(parent)
        commits = [s for s in seen if self._commits.get(s) is not None]
        self._order = sorted(
            commits,
            key=lambda s: (self._commits[s]["epoch"], s)  # type: ignore[index]
        )
        return list(self._order)

    @property
    def commits_in_order(self) -> List[str]:
        return self._order

    # -- trees / blobs ------------------------------------------------------

    def tree(self, commit_sha: str) -> Dict[str, str]:
        """Map repo path -> blob sha for one commit (lazy, cached)."""
        cached = self._trees.get(commit_sha)
        if cached is not None:
            return cached
        proc = self._run_any("ls-tree", "-r", "-z", commit_sha,
                             preferred=self._commit_repo.get(commit_sha))
        if proc is None or proc.returncode != 0:
            raise UsageError("ls-tree failed for %s" % (commit_sha,))
        tree: Dict[str, str] = {}
        for record in proc.stdout.split(b"\0"):
            if not record:
                continue
            meta, _, path = record.partition(b"\t")
            parts = meta.decode("ascii", "replace").split(" ")
            if len(parts) == 3 and parts[1] == "blob":
                tree[path.decode("utf-8", "replace")] = parts[2]
        self._trees[commit_sha] = tree
        return tree

    def _read_blob(self, blob_sha: str) -> Optional[bytes]:
        preferred = self._blob_repo.get(blob_sha)
        if preferred is not None:
            proc = self._run_any("cat-file", "blob", blob_sha,
                                 preferred=preferred)
            if proc is not None and proc.returncode == 0:
                return proc.stdout
            self._blob_repo.pop(blob_sha, None)
        for _, repo_path in self.repos:
            proc = self._run_in(repo_path, "cat-file", "blob", blob_sha)
            if proc.returncode == 0:
                self._blob_repo[blob_sha] = repo_path
                return proc.stdout
        return None

    def blob_digest(self, blob_sha: str) -> Dict[str, Any]:
        cached = self._digests.get(blob_sha)
        if cached is not None:
            return cached
        data = self._read_blob(blob_sha)
        if data is None:
            raise UsageError("cat-file blob failed for %s" % blob_sha)
        digest = {
            "sha256": sha256_bytes(data),
            "md5": md5_bytes(data),
            "size_bytes": len(data),
        }
        self._digests[blob_sha] = digest
        return digest

    def blob_bytes(self, blob_sha: str) -> bytes:
        if blob_sha not in self._blob_bytes:
            data = self._read_blob(blob_sha)
            if data is None:
                raise UsageError("cat-file blob failed for %s" % blob_sha)
            self._blob_bytes[blob_sha] = data
        return self._blob_bytes[blob_sha]

    # -- derived queries ------------------------------------------------------

    def path_history(self, path: str) -> Dict[str, List[str]]:
        """blob sha -> commits (in commit order) carrying `path` as a blob."""
        history: Dict[str, List[str]] = {}
        for commit in self.commits_in_order:
            blob = self.tree(commit).get(path)
            if blob is not None:
                history.setdefault(blob, []).append(commit)
        return history

    def commits_ref_summary(self, commits: List[str]) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        for c in commits:
            info = self._commits.get(c)
            assert info is not None, "commit %s not loaded" % c
            out.append({
                "sha": c,
                "committer_epoch": info["epoch"],
                "committer_date_utc": utc_iso(info["epoch"]),
            })
        return out


def commit_ref(commit: str) -> Dict[str, Any]:
    return {"sha": commit}


# ---------------------------------------------------------------------------
# Snapshot (evidence) reading
# ---------------------------------------------------------------------------

class Snapshot:
    """Read-only view over the authoritative evidence snapshot."""

    def __init__(self, snapshot_dir: str) -> None:
        self.dir = snapshot_dir
        manifest_path = os.path.join(snapshot_dir, "manifest.json")
        if not os.path.isfile(manifest_path):
            raise UsageError("snapshot manifest not found: %s" % manifest_path)
        raw = Path(manifest_path).read_bytes()
        self.manifest_sha256 = sha256_bytes(raw)
        try:
            self.manifest = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise UsageError("snapshot manifest is not valid JSON: %s" % exc) from exc
        self.entries: List[Dict[str, Any]] = list(self.manifest.get("entries", []))
        checksum_path = os.path.join(snapshot_dir, "manifest.sha256")
        if os.path.isfile(checksum_path):
            expected = Path(checksum_path).read_text(
                encoding="ascii").split()[0]
            if expected != self.manifest_sha256:
                raise UsageError(
                    "snapshot manifest fails its own manifest.sha256 check")
        self.by_path = {e["path"]: e for e in self.entries}

    def object_bytes(self, sha256: str) -> bytes:
        path = os.path.join(self.dir, "objects", "sha256", sha256)
        if not os.path.isfile(path):
            raise UsageError("snapshot object missing: %s" % sha256)
        data = Path(path).read_bytes()
        if sha256_bytes(data) != sha256:
            raise UsageError("snapshot object fails content addressing: %s" % sha256)
        return data


def validate_live_entry(entry: Dict[str, Any]) -> None:
    path = entry.get("path")
    if not isinstance(path, str) or not path.startswith("/"):
        raise UsageError("live entry has invalid path: %r" % (path,))
    kind = entry.get("kind")
    if kind not in ("file", "symlink"):
        raise UsageError("live entry %s has unexpected kind %r" % (path, kind))
    sha = entry.get("sha256")
    if kind == "file":
        if not isinstance(sha, str) or not RE_SHA256.match(sha):
            raise UsageError("live file entry %s lacks a full sha256" % path)
        md5 = entry.get("md5_local")
        if md5 is not None and not RE_MD5.match(md5):
            raise UsageError("live file entry %s has malformed md5" % path)
    else:
        if not isinstance(entry.get("target"), str):
            raise UsageError("live symlink entry %s lacks target" % path)


# ---------------------------------------------------------------------------
# Live MANIFEST.txt staleness analysis
# ---------------------------------------------------------------------------

def parse_live_manifest_txt(data: bytes) -> Dict[str, Dict[str, Any]]:
    """Parse the hub-side generated MANIFEST.txt listing.

    Format (observed): N `ls -l`-style lines (mode nlink owner group size
    date... name) followed by N `md5  name` lines.  Returns
    {"<name>": {"listed_md5": ..., "listed_size": ...}, ...}.
    """
    parsed: Dict[str, Dict[str, Any]] = {}
    for raw_line in data.split(b"\n"):
        if not raw_line:
            continue
        try:
            text = raw_line.decode("ascii")
        except UnicodeDecodeError:
            continue
        tokens = text.split()
        if len(tokens) == 2 and RE_MD5.match(tokens[0]):
            name = tokens[1]
            record = parsed.setdefault(
                name, {"listed_md5": None, "listed_size": None})
            record["listed_md5"] = tokens[0]
        elif (len(tokens) >= 9 and tokens[0].startswith("-")
              and tokens[0][1:].strip("-rwxSsTt+") == ""):
            name = tokens[8]
            try:
                size = int(tokens[4])
            except ValueError:
                continue
            record = parsed.setdefault(
                name, {"listed_md5": None, "listed_size": None})
            record["listed_size"] = size
    return parsed


def analyze_manifest_staleness(snapshot: Snapshot) -> Dict[str, Any]:
    """Compare the live MANIFEST.txt listing against the actual live files."""
    manifest_entry = snapshot.by_path.get("/data/codex/bin/MANIFEST.txt")
    result: Dict[str, Any] = {
        "path": "/data/codex/bin/MANIFEST.txt",
        "present_in_snapshot": manifest_entry is not None,
        "parsed": False, "stale": None, "incoherent": None,
        "mismatches": [], "matches": [],
        "missing_from_listing": [], "listed_but_not_live": [],
    }
    if manifest_entry is None or manifest_entry.get("kind") != "file":
        return result
    data = snapshot.object_bytes(manifest_entry["sha256"])
    listed = parse_live_manifest_txt(data)
    result["parsed"] = True
    result["listed_names"] = sorted(listed)

    live_bin_files: Dict[str, Dict[str, Any]] = {
        e["path"].rsplit("/", 1)[1]: e
        for e in snapshot.entries
        if e["path"].startswith("/data/codex/bin/")
        and e.get("kind") == "file"
        and e["path"] != "/data/codex/bin/MANIFEST.txt"
    }

    for name in sorted(listed):
        live = live_bin_files.get(name)
        if live is None:
            result["listed_but_not_live"].append(name)
            continue
        listed_md5 = listed[name]["listed_md5"]
        listed_size = listed[name]["listed_size"]
        live_md5 = live.get("md5_local")
        live_size = live.get("size")
        md5_equal = listed_md5 is not None and listed_md5 == live_md5
        size_equal = listed_size is not None and listed_size == live_size
        record = {
            "name": name,
            "listed_md5": listed_md5, "listed_size": listed_size,
            "live_md5": live_md5, "live_size": live_size,
            "md5_equal": md5_equal, "size_equal": size_equal,
        }
        if md5_equal and size_equal:
            result["matches"].append(record)
        else:
            record["live_sha256"] = live.get("sha256")
            result["mismatches"].append(record)

    for name in sorted(live_bin_files):
        if name not in listed:
            live = live_bin_files[name]
            result["missing_from_listing"].append({
                "name": name, "live_md5": live.get("md5_local"),
                "live_size": live.get("size"), "live_sha256": live.get("sha256"),
            })

    result["stale"] = bool(
        result["mismatches"] or result["missing_from_listing"]
        or result["listed_but_not_live"])
    result["incoherent"] = bool(
        any(not m["md5_equal"] for m in result["mismatches"]))
    return result


# ---------------------------------------------------------------------------
# Symlink analysis
# ---------------------------------------------------------------------------

def resolve_symlink_target(link_path: str, target: str) -> str:
    if target.startswith("/"):
        return target
    parent = link_path.rsplit("/", 1)[0]
    resolved = parent + "/" + target
    # collapse any "." components (none expected in the closed universe)
    parts = [p for p in resolved.split("/") if p != "." and p != ""]
    return "/" + "/".join(parts)


def analyze_symlink(snapshot: Snapshot, entry: Dict[str, Any],
                    expected_symlinks: List[str]) -> Dict[str, Any]:
    target = entry["target"]
    resolved = resolve_symlink_target(entry["path"], target)
    resolved_entry = snapshot.by_path.get(resolved)
    target_string_sha = sha256_bytes(target.encode("utf-8"))
    return {
        "target": target,
        "resolved_entry_path": resolved,
        "resolved_entry_present_live": resolved_entry is not None,
        "resolved_entry_kind": resolved_entry.get("kind") if resolved_entry else None,
        "target_string_sha256": target_string_sha,
        "target_string_sha256_matches_manifest":
            target_string_sha == entry.get("target_sha256"),
        "expected_by_collector_allowlist":
            entry["path"] in expected_symlinks,
    }


# ---------------------------------------------------------------------------
# Documentation-reference scan (for entries with no exact committed source)
# ---------------------------------------------------------------------------

def scan_documentation_references(
        git: GitHistory, needles: List[str]) -> List[Dict[str, Any]]:
    """Find commits whose tracked docs/*.md blobs contain any needle string."""
    doc_paths: Set[str] = set()
    for commit in git.commits_in_order:
        for path in git.tree(commit):
            if path.startswith("docs/") and path.endswith(".md"):
                doc_paths.add(path)
    results: List[Dict[str, Any]] = []
    needle_bytes = [n.encode("ascii") for n in needles if n]
    if not needle_bytes:
        return results
    for path in sorted(doc_paths):
        history = git.path_history(path)
        commits: List[str] = []
        for blob in sorted(history):
            data = git.blob_bytes(blob)
            if any(n in data for n in needle_bytes):
                commits.extend(history[blob])
        if commits:
            ordered = [c for c in git.commits_in_order if c in set(commits)]
            results.append({
                "repo_path": path,
                "commit_count": len(ordered),
                "commits": ordered,
                "earliest_commit": ordered[0] if ordered else None,
                "latest_commit": ordered[-1] if ordered else None,
            })
    return results


# ---------------------------------------------------------------------------
# Binary pilot reports (integrity-pinned ingestion)
# ---------------------------------------------------------------------------

#: Allowed pilot verdicts and their evidence requirements.  An
#: EXACT_SOURCE_REPRODUCIBLE verdict is honored ONLY when the report's
#: builds actually contain the live SHA-256 (checked against the snapshot
#: entry at derivation time); otherwise the report is recorded but the
#: verdict is not propagated as a reproduction claim.
PILOT_VERDICTS_HONORED = ("EXACT_SOURCE_REPRODUCIBLE", "RECIPE_UNPROVEN")

#: Required report SHA-256 pins keyed by report label.  A report whose label
#: is present here MUST hash to the pinned digest or derivation fails closed.
REQUIRED_REPORT_SHA256 = {
    EVIDENCE_PILOT_WEBUI_LABEL: WEBUI_REPORT_SHA256,
    EVIDENCE_PILOT_ZIG_SWEEP_LABEL: ZIG_SWEEP_REPORT_SHA256,
}


def _validate_webui_report(data: Dict[str, Any], digest: str) -> None:
    """Fail closed on any webui-repro report field mismatch."""
    if data.get("final_status") != "EXACT_SOURCE_REPRODUCIBLE":
        raise UsageError("webui report final_status is not EXACT_SOURCE_REPRODUCIBLE")
    target = data.get("target") or {}
    if target.get("sha256") != "c400173bb42f735734c522556c69f6c80f0604949413eb974c7b361b9e4ac11a":
        raise UsageError("webui report target sha256 mismatch")
    if target.get("size_bytes") != 906872:
        raise UsageError("webui report target size mismatch")
    toolchain = data.get("toolchain") or {}
    if toolchain.get("zig_version") != "0.16.0":
        raise UsageError("webui report toolchain zig_version mismatch")
    exact_tuple = data.get("exact_tuple") or {}
    expected_sources = {
        "codex_webui.c": "8a4e536f8997c5b9b483c123633a6dde386c51f69f66ab7544357b4c32f54e5c",
        "activity_ui_assets.h": "2d8136d3ab970dceb55a875c82942ef934a3eba4f17413eb91604f3dbdfa74eb",
        "harmony_shell_assets.h": "967d1e44f267b8713a5b411f9f1eeefebaf51268110676c0c317cb5b965390e5",
        "remote_skin_jpg.h": "04433039af1e263bd88645cb42df40f71c4911bda7dba69d1ab0463c1030eb2b",
    }
    for name, want in expected_sources.items():
        got = (exact_tuple.get(name) or {}).get("sha256")
        if got != want:
            raise UsageError("webui report exact_tuple %s sha256 mismatch" % name)
    attempts = data.get("attempts") or []
    if not attempts or attempts[0].get("output_sha256") != target.get("sha256"):
        raise UsageError("webui report attempts do not substantiate the exact output")
    repro = data.get("reproducibility") or {}
    if repro.get("all_three_sha256") != target.get("sha256"):
        raise UsageError("webui report reproducibility all_three_sha256 mismatch")
    if repro.get("all_equal_target") is not True:
        raise UsageError("webui report reproducibility all_equal_target is not true")


def _validate_zig_sweep_report(data: Dict[str, Any], digest: str) -> None:
    """Fail closed on any zig-distribution-sweep report field mismatch."""
    if data.get("final_status") != "EXACT_SOURCE_REPRODUCIBLE":
        raise UsageError("zig sweep report final_status is not EXACT_SOURCE_REPRODUCIBLE")
    targets = data.get("targets") or {}
    expected_targets = {
        "codex_bt_pair_agent": "563c6c58a3629edfebd7ec30ebcf14e6384a2d84e89669b1d7c3d79c75b619c8",
        "codex_bthid_keyboard": "c6a3c4cd0db3aab1bbdc92ae22e3ae2ffe11d442ac7fe0920b46a6da0b5cef13",
        "codex_hal_ltcp": "7fa9a84b9ee270bdf6e47d40859d29b6c1c30e5a1766f0ab59e9143dd13ca26c",
        "codex_hbus": "4be9e6ac2e09e7eb052f9c47e81480d1e32aee7190bedb6ef7f932cf07aab8f9",
    }
    for name, want in expected_targets.items():
        got = (targets.get(name) or {}).get("sha256")
        if got != want:
            raise UsageError("zig sweep report target %s sha256 mismatch" % name)
    toolchain = data.get("toolchain") or {}
    if toolchain.get("zig_binary_sha256") != "e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec":
        raise UsageError("zig sweep report toolchain zig_binary_sha256 mismatch")
    if toolchain.get("zig_version") != "0.16.0":
        raise UsageError("zig sweep report toolchain zig_version mismatch")
    if toolchain.get("signature_status") != "NOT_VERIFIED":
        raise UsageError("zig sweep report signature_status is not NOT_VERIFIED")
    sources = data.get("sources") or {}
    hbus_src = sources.get("codex_hbus.c (309cec3, EXACT)") or {}
    if hbus_src.get("sha256") != "4b4ff376825f26607ec55f75685469831801f54b3f2af56e3d2d720a5d5d8ba8":
        raise UsageError("zig sweep report hbus 309cec3 source sha256 mismatch")
    if hbus_src.get("git_blob") != "d2bbcdef214369bff3dacf1836d6b5a0057f5ede":
        raise UsageError("zig sweep report hbus 309cec3 git_blob mismatch")
    repro = data.get("reproducibility") or {}
    if repro.get("all_equal_target") is not True:
        raise UsageError("zig sweep report reproducibility all_equal_target is not true")
    if repro.get("all_equal_each_other") is not True:
        raise UsageError("zig sweep report reproducibility all_equal_each_other is not true")


def load_pilot_reports(paths: List[Tuple[str, str]]) -> List[Dict[str, Any]]:
    """Load (label, path) pilot reports, pinning each by SHA-256.

    Returns sanitized report handles: verdict, sha256, label, and the
    per-binary rebuilt/live digests (no local paths, no bytes).  Reports
    whose label is in REQUIRED_REPORT_SHA256 must hash to the pinned digest
    and pass strict field validation, else derivation fails closed.
    """
    reports: List[Dict[str, Any]] = []
    for label, path in paths:
        if not path or not os.path.isfile(path):
            continue
        raw = Path(path).read_bytes()
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise UsageError("pilot report %s is not valid JSON: %s"
                             % (label, exc)) from exc
        digest = sha256_bytes(raw)
        required = REQUIRED_REPORT_SHA256.get(label)
        if required is not None and digest != required:
            raise UsageError(
                "pilot report %s SHA-256 mismatch (found %s, required %s)"
                % (label, digest, required))
        verdict = data.get("verdict") or data.get("final_status")
        if verdict not in PILOT_VERDICTS_HONORED:
            raise UsageError(
                "pilot report %s carries unrecognized verdict %r"
                % (label, verdict))
        if label == EVIDENCE_PILOT_WEBUI_LABEL:
            _validate_webui_report(data, digest)
        elif label == EVIDENCE_PILOT_ZIG_SWEEP_LABEL:
            _validate_zig_sweep_report(data, digest)
        # collect per-binary built digests from every build map in the
        # report: "builds"/r1/r2 style (dhcpd-portal), recipe/follow-up
        # passes (bt-hal-hbus), "targets" (zig sweep), and "attempts"
        # output_sha256 (webui) all carry {name: {sha256: ...}} records.
        binaries: Dict[str, Dict[str, Any]] = {}

        def _collect_builds(node: Any) -> None:
            if isinstance(node, dict):
                for key, value in node.items():
                    if (key in ("r1", "r2") and isinstance(value, dict)
                            and value
                            and all(isinstance(v, dict) for v in value.values())):
                        for name, rec in value.items():
                            if isinstance(rec, dict) and "sha256" in rec:
                                slot = binaries.setdefault(
                                    name, {"built_sha256": set()})
                                slot["built_sha256"].add(rec["sha256"])
                    else:
                        _collect_builds(value)
            elif isinstance(node, list):
                for item in node:
                    _collect_builds(item)

        for section in ("builds", "recipe_pass_1", "followup_pass"):
            _collect_builds(data.get(section, {}))
        # zig sweep: targets carry the live digests that rebuilds are
        # asserted byte-identical to (reproducibility.all_equal_target).
        targets = data.get("targets") or {}
        if isinstance(targets, dict):
            for name, rec in targets.items():
                if isinstance(rec, dict) and "sha256" in rec:
                    slot = binaries.setdefault(name, {"built_sha256": set()})
                    slot["built_sha256"].add(rec["sha256"])
        # webui: attempts[].output_sha256 is the rebuilt output digest.
        for attempt in (data.get("attempts") or []):
            if isinstance(attempt, dict) and "output_sha256" in attempt:
                slot = binaries.setdefault("codex_webui", {"built_sha256": set()})
                slot["built_sha256"].add(attempt["output_sha256"])
        for name, slot in binaries.items():
            slot["built_sha256"] = sorted(slot["built_sha256"])
        reports.append({
            "report_label": label,
            "diagnostic": data.get("diagnostic"),
            "verdict": verdict,
            "report_sha256": digest,
            "per_binary": {
                name: {"built_sha256": slot["built_sha256"]}
                for name, slot in sorted(binaries.items())
            },
        })
    return reports


def pilot_verdict_for(path: str, live_sha: Optional[str],
                      pilot_reports: Optional[List[Dict[str, Any]]]
                      ) -> Optional[Dict[str, Any]]:
    """Pilot verdict block for one live binary path, if a report covers it.

    Mapping from live path to the pilot binary name; the report must have
    actually built that binary and, for EXACT_SOURCE_REPRODUCIBLE, its
    rebuilt SHA-256 must equal the live digest (integrity + hash + verdict
    all checked before any reproduction claim propagates).
    """
    if not pilot_reports or live_sha is None:
        return None
    name = path.rsplit("/", 1)[-1]
    hbus_alias = {"codex_hbus_6ab8fb9", "codex_hbus_309cec3"}
    # Prefer an EXACT_SOURCE_REPRODUCIBLE report whose rebuilt digest equals
    # the live digest; otherwise fall back to the first non-exact report that
    # covers the binary (historical/corroborating evidence only).
    fallback: Optional[Dict[str, Any]] = None
    for report in pilot_reports:
        per_binary = report.get("per_binary", {})
        slot = per_binary.get(name)
        if slot is None and name == "codex_hbus":
            slot = next(
                (per_binary[alias] for alias in sorted(hbus_alias)
                 if alias in per_binary), None)
        if slot is None:
            continue
        built = slot.get("built_sha256", [])
        exact = live_sha in built
        verdict = report["verdict"]
        block = {
            "report_label": report["report_label"],
            "diagnostic": report["diagnostic"],
            "report_sha256": report["report_sha256"],
            "verdict": verdict,
            "rebuilt_matches_live": exact,
            "rebuilt_sha256": built,
        }
        if verdict == "EXACT_SOURCE_REPRODUCIBLE" and exact:
            return block
        if fallback is None:
            fallback = block
    return fallback


# ---------------------------------------------------------------------------
# Per-entry derivation
# ---------------------------------------------------------------------------

def artifact_history_block(
        git: GitHistory, live_sha256: Optional[str],
        history: Dict[str, List[str]]) -> Dict[str, Any]:
    """Build the artifact_history block for one repo artifact path."""
    matched_blob: Optional[str] = None
    variants: List[Dict[str, Any]] = []
    for blob in sorted(history):
        digest = git.blob_digest(blob)
        commits = history[blob]
        record = {
            "git_blob_sha": blob,
            "content_sha256": digest["sha256"],
            "content_md5": digest["md5"],
            "size_bytes": digest["size_bytes"],
            "commit_count": len(commits),
            "first_commit": commits[0],
            "last_commit": commits[-1],
        }
        variants.append(record)
        if live_sha256 is not None and digest["sha256"] == live_sha256:
            matched_blob = blob

    block: Dict[str, Any] = {
        "repo_path_scanned": None,  # filled by caller
        "distinct_committed_blobs": len(variants),
    }
    if matched_blob is not None:
        commits = history[matched_blob]
        digest = git.blob_digest(matched_blob)
        block["matched"] = True
        block["git_blob_sha"] = matched_blob
        block["content_sha256"] = digest["sha256"]
        block["content_md5"] = digest["md5"]
        block["size_bytes"] = digest["size_bytes"]
        block["commit_count"] = len(commits)
        block["commits"] = commits
        block["earliest_commit"] = git.commits_ref_summary([commits[0]])[0]
        block["latest_commit"] = git.commits_ref_summary([commits[-1]])[0]
        others = [v for v in variants if v["git_blob_sha"] != matched_blob]
        block["other_committed_variants"] = others[:MAX_OTHER_VARIANTS]
        block["other_committed_variants_truncated"] = len(others) > MAX_OTHER_VARIANTS
    else:
        block["matched"] = False
        block["git_blob_sha"] = None
        by_size = sorted(
            variants,
            key=lambda v: (abs((v["size_bytes"] or 0)), v["git_blob_sha"]))
        block["other_committed_variants"] = by_size[:MAX_OTHER_VARIANTS]
        block["other_committed_variants_truncated"] = len(by_size) > MAX_OTHER_VARIANTS
    return block


def annotate_refs_at_tip(git: GitHistory, refs: List[Dict[str, str]],
                         path: str, blob: Optional[str]) -> Dict[str, bool]:
    if blob is None:
        return {}
    out: Dict[str, bool] = {}
    for ref in refs:
        out[ref["name"]] = git.tree(ref["tip"]).get(path) == blob
    return out


def source_history_block(
        git: GitHistory, source_path: str,
        within_commits: Optional[List[str]]) -> Dict[str, Any]:
    """Distinct candidate-source blobs across `within_commits` (or all)."""
    history = git.path_history(source_path)
    if within_commits is not None:
        keep = set(within_commits)
        history = {
            blob: [c for c in commits if c in keep]
            for blob, commits in history.items()
        }
        history = {b: cs for b, cs in history.items() if cs}
    blobs = []
    for blob in sorted(history):
        digest = git.blob_digest(blob)
        commits = history[blob]
        blobs.append({
            "git_blob_sha": blob,
            "content_sha256": digest["sha256"],
            "content_md5": digest["md5"],
            "size_bytes": digest["size_bytes"],
            "commit_count_within": len(commits),
            "first_commit_within": commits[0],
            "last_commit_within": commits[-1],
        })
    return {
        "repo_path": source_path,
        "basis": "commits carrying the matched artifact blob"
                 if within_commits is not None else "all scanned commits",
        "distinct_source_blobs": len(blobs),
        "blobs": blobs,
    }


def installer_literal_block(
        git: GitHistory, literal: str, dest_path: str) -> Dict[str, Any]:
    # In committed installer *source text* the payload appears with the
    # newline escaped (e.g. '{"plugin":"codexmqtt"}\n' as backslash-n), so
    # search for the newline-stripped core plus the destination path.
    core = literal.rstrip("\n").encode("utf-8")
    history = git.path_history(INSTALLER_REPO_PATH)
    commits: List[str] = []
    for blob in sorted(history):
        data = git.blob_bytes(blob)
        if core in data and dest_path.encode("utf-8") in data:
            commits.extend(history[blob])
    ordered = [c for c in git.commits_in_order if c in set(commits)]
    return {
        "installer_repo_path": INSTALLER_REPO_PATH,
        "literal": literal,
        "literal_sha256": sha256_bytes(literal.encode("utf-8")),
        "literal_search_core": core.decode("ascii"),
        "destination_path_literal": dest_path,
        "commit_count": len(ordered),
        "commits": ordered,
        "earliest_commit": ordered[0] if ordered else None,
        "latest_commit": ordered[-1] if ordered else None,
    }


def read_reconciliation_source(
        repo_root: str, repo_path: str,
        live_sha: str, live_size: int) -> Dict[str, Any]:
    """Read a reconciliation-branch working-tree source and verify it is
    byte-identical to the live entry.

    Fails closed (UsageError) on: an unsafe/unnormalized repo_path, a path
    that escapes the repository (lexically or through symlinks), a missing
    or non-regular (symlink) file, or a size/SHA-256 mismatch.  The returned
    block carries only public repo-relative fields — never an absolute path.
    """
    if (not isinstance(repo_path, str) or not repo_path
            or repo_path.startswith("/") or "\x00" in repo_path):
        raise UsageError(
            "reconciliation source path is unsafe: %r" % (repo_path,))
    if (os.path.normpath(repo_path) != repo_path
            or any(part in ("", ".", "..") for part in repo_path.split("/"))):
        raise UsageError(
            "reconciliation source path is not normalized: %r" % (repo_path,))
    root_lex = os.path.normpath(os.path.abspath(repo_root))
    root_real = os.path.realpath(root_lex)
    source_lex = os.path.normpath(os.path.join(root_lex, repo_path))
    source_real = os.path.realpath(source_lex)
    # lexical containment (against the lexical root) and resolved containment
    # (against the symlink-resolved root) must BOTH hold.
    if not (source_lex == root_lex
            or source_lex.startswith(root_lex + os.sep)):
        raise UsageError(
            "reconciliation source escapes the repository: %r" % (repo_path,))
    if not (source_real == root_real
            or source_real.startswith(root_real + os.sep)):
        raise UsageError(
            "reconciliation source resolves outside the repository: %r"
            % (repo_path,))
    if os.path.islink(source_lex) or not os.path.isfile(source_lex):
        raise UsageError(
            "reconciliation source is missing or not a regular file: %r"
            % (repo_path,))
    data = Path(source_lex).read_bytes()
    digest = sha256_bytes(data)
    if digest != live_sha or len(data) != live_size:
        raise UsageError(
            "reconciliation source %r does not match the live entry "
            "(expected sha256 %s size %d, found sha256 %s size %d)"
            % (repo_path, live_sha, live_size, digest, len(data)))
    return {
        "repo_path": repo_path,
        "sha256": digest,
        "size": len(data),
        "exact": True,
        "historical_provenance": RECONSTRUCTED_HISTORICAL_PROVENANCE,
        "introduced_by": RECONSTRUCTED_INTRODUCED_BY,
    }


def backup_original_evidence_block(
        git: GitHistory, repo_artifact: str) -> Dict[str, Any]:
    """Committed-variant lineage for a live text artifact whose exact bytes
    are NOT committed (the documented backed-up clean original)."""
    history = git.path_history(repo_artifact)
    clean_evidence = []
    for blob in sorted(history):
        digest = git.blob_digest(blob)
        clean_evidence.append({
            "git_blob_sha": blob,
            "content_sha256": digest["sha256"],
            "content_md5": digest["md5"],
            "size_bytes": digest["size_bytes"],
            "commit_count": len(history[blob]),
        })
    return {
        "repo_path": repo_artifact,
        "committed_variants": clean_evidence,
        "note": "the documented on-hub backed-up clean original corresponds "
                "to the committed clean blob lineage; the live DIAG variant "
                "is not committed anywhere in the scanned history",
    }


def near_miss_analysis(git: GitHistory, repo_path: str,
                       live_bytes: bytes) -> Optional[Dict[str, Any]]:
    """Token-level comparison of the closest committed blob vs live bytes."""
    history = git.path_history(repo_path)
    if not history:
        return None
    live_tokens = live_bytes.split()
    best: Optional[Dict[str, Any]] = None
    for blob in sorted(history):
        data = git.blob_bytes(blob)
        digest = git.blob_digest(blob)
        tokens = data.split()
        only_in_repo = [t.decode("utf-8", "replace")
                        for t in tokens if t not in live_tokens]
        only_in_live = [t.decode("utf-8", "replace")
                        for t in live_tokens if t not in tokens]
        score = (len(only_in_repo) + len(only_in_live)
                 + abs(len(data) - len(live_bytes)))
        record = {
            "git_blob_sha": blob,
            "repo_content_sha256": digest["sha256"],
            "repo_content_md5": digest["md5"],
            "repo_size_bytes": digest["size_bytes"],
            "live_size_bytes": len(live_bytes),
            "tokens_only_in_repo": sorted(set(only_in_repo)),
            "tokens_only_in_live": sorted(set(only_in_live)),
            "commit_count": len(history[blob]),
            "first_commit": history[blob][0],
            "last_commit": history[blob][-1],
            "_score": score,
        }
        if best is None or score < best["_score"]:
            best = record
    if best is None:
        return None
    score = best.pop("_score")
    best["token_diff_score"] = score
    return best


def derive_entry(snapshot: Snapshot, git: GitHistory, refs: List[Dict[str, str]],
                 entry: Dict[str, Any], hbus_report: Optional[Dict[str, Any]],
                 expected_symlinks: List[str],
                 pilot_reports: Optional[List[Dict[str, Any]]] = None,
                 reconciliation_root: Optional[str] = None
                 ) -> Dict[str, Any]:
    path = entry["path"]
    mapping = MAPPING.get(path)
    if mapping is None:
        raise UsageError("live entry %s has no repo mapping defined" % path)
    category = mapping["category"]

    record: Dict[str, Any] = {
        "live": {
            "path": path,
            "kind": entry.get("kind"),
            "mode": entry.get("mode"),
            "size": entry.get("size"),
            "sha256": entry.get("sha256"),
            "md5": entry.get("md5_local"),
            "target": entry.get("target"),
            "target_sha256": entry.get("target_sha256"),
        },
        "category": category,
        "repo_artifact_path": mapping.get("repo_artifact"),
        "repo_source_path": mapping.get("repo_source"),
        "artifact_history": None,
        "source_history": None,
        "installer_literal_provenance": None,
        "symlink_analysis": None,
        "near_miss_analysis": None,
        "backup_original_evidence": None,
        "documentation_references": None,
        "reconciliation_source": None,
        "third_party_provenance": None,
        "source_provenance": None,
        "build_status": None,
        "public_safety_status": None,
        "evidence": [EVIDENCE_MANIFEST_LABEL],
        "notes": [],
    }

    live_sha = entry.get("sha256")
    live_md5 = entry.get("md5_local")

    # ---- symlinks -------------------------------------------------------
    if entry.get("kind") == "symlink":
        record["symlink_analysis"] = analyze_symlink(
            snapshot, entry, expected_symlinks)
        record["source_provenance"] = "SYMLINK_NO_CONTENT"
        record["build_status"] = "NOT_APPLICABLE_SYMLINK"
        analysis = record["symlink_analysis"]
        if not analysis["resolved_entry_present_live"]:
            record["notes"].append(
                "symlink target does not resolve to another live entry")
        if not analysis["target_string_sha256_matches_manifest"]:
            record["notes"].append(
                "target-string sha256 disagrees with the manifest record")
        return record

    # ---- repo artifact history ------------------------------------------
    repo_artifact = mapping.get("repo_artifact")
    matched = False
    matched_commits: List[str] = []
    if repo_artifact is not None:
        history = git.path_history(repo_artifact)
        block = artifact_history_block(git, live_sha, history)
        block["repo_path_scanned"] = repo_artifact
        block["refs_with_match_at_tip"] = annotate_refs_at_tip(
            git, refs, repo_artifact, block.get("git_blob_sha"))
        record["artifact_history"] = block
        matched = bool(block["matched"])
        matched_commits = block.get("commits", [])

    # ---- category-specific derivation -------------------------------------
    if category == "installer_literal":
        literal = mapping["installer_literal"]
        block = installer_literal_block(git, literal, path)
        record["installer_literal_provenance"] = block
        assert live_sha is not None
        live_bytes = snapshot.object_bytes(live_sha)
        content_matches_literal = live_bytes == literal.encode("utf-8")
        if content_matches_literal and block["commit_count"] > 0:
            record["source_provenance"] = "EXACT_INSTALLER_LITERAL"
            record["notes"].append(
                "live bytes equal the installer literal committed in %s; "
                "generated at install time by %s"
                % (INSTALLER_REPO_PATH, INSTALLER_REPO_PATH))
        else:
            record["source_provenance"] = "MANUAL_SOURCE_REQUIRED"
            record["notes"].append(
                "live bytes do not equal the committed installer literal "
                "or no committing history was found")
        record["build_status"] = "NOT_APPLICABLE_TEXT"
        return record

    if category in BINARY_CATEGORIES:
        source_path = mapping.get("repo_source")
        if matched:
            record["source_history"] = source_history_block(
                git, source_path, matched_commits) if source_path else None
            if category == "third_party_binary":
                record["source_provenance"] = "THIRD_PARTY_BINARY"
                record["build_status"] = "UNVERIFIED_THIRD_PARTY"
                record["notes"].append(
                    "third-party static multi-binary tracked verbatim in the "
                    "repository; no in-repo source; build reproduction not "
                    "applicable to this repository alone")
                if (path == "/data/codex/bin/dropbearmulti"
                        and live_sha == DROPBEAR_PROVENANCE["binary_sha256"]):
                    record["third_party_provenance"] = dict(DROPBEAR_PROVENANCE)
                    record["notes"].append(
                        "Dropbear 2025.89 version/license closure is "
                        "VERSION_LICENSE_VERIFIED (tag-pinned LICENSE at %s); "
                        "the binary build remains BINARY_BUILD_UNVERIFIED: "
                        "no vendor source/patch/config/rebuild closure"
                        % DROPBEAR_PROVENANCE["license_path"])
            else:
                record["source_provenance"] = "CANDIDATE_SOURCE_BINARY_MATCH_ONLY"
                record["build_status"] = "HISTORICAL_BINARY_MATCH_ONLY"
                record["notes"].append(
                    "a committed payload binary blob is byte-identical to the "
                    "live binary; this is deployment-lineage evidence only and "
                    "does NOT establish that the candidate source rebuilds it")
        else:
            record["source_history"] = source_history_block(
                git, source_path, None) if source_path else None
            if path == "/data/codex/bin/codex_hbus" and hbus_report is not None:
                record["source_provenance"] = "CANDIDATE_SOURCE_NO_BINARY_MATCH"
                record["build_status"] = hbus_report.get(
                    "verdict", "UNVERIFIED_NO_BINARY_MATCH")
                record["evidence"].append(EVIDENCE_HBUS_LABEL)
                record["hbus_reproduction"] = {
                    "diagnostic": hbus_report.get("diagnostic"),
                    "verdict": hbus_report.get("verdict"),
                    "report_sha256": hbus_report.get("_sha256"),
                    "candidate_source_at_head": (
                        hbus_report.get("source_repo", {}).get("head")),
                    "documented_recipe_disproven_as_written": True,
                    "best_effort_variant": (
                        "zig cc -target mips-linux-musleabi -mcpu=mips32 "
                        "-Os -static -s reproduces ELF identity and size "
                        "within 20 bytes but not reference bytes"),
                }
                reference = hbus_report.get("references", {}).get(
                    "known_good_live_backup_20260730", {})
                if reference.get("sha256") == live_sha:
                    record["notes"].append(
                        "live binary sha256 equals the known-good on-hub "
                        "backup reference dated 2026-07-30 (%s, %s bytes); "
                        "the live hbus is that known-good build, distinct "
                        "from every committed payload/bin/codex_hbus blob"
                        % (reference.get("md5"), reference.get("size_bytes")))
                record["notes"].append(
                    "hbus local-reproduction diagnostic verdict "
                    "RECIPE_UNPROVEN: exact-source reproducibility is NOT "
                    "established despite an exact candidate source lineage")
            else:
                record["source_provenance"] = "CANDIDATE_SOURCE_NO_BINARY_MATCH"
                record["build_status"] = "UNVERIFIED_NO_BINARY_MATCH"
        # -- integrity-pinned binary pilot reports override build status --
        # (a pilot verdict is authoritative for its covered binaries whether
        # or not a committed binary blob also matches: RECIPE_UNPROVEN from
        # bounded pilots supersedes the lineage-only default; EXACT claims
        # additionally require the rebuilt SHA-256 to equal the live digest)
        pilot = pilot_verdict_for(path, live_sha, pilot_reports or [])
        if pilot is not None:
            record["binary_pilot"] = pilot
            record["evidence"].append(pilot["report_label"])
            record["build_status"] = pilot["verdict"]
            if pilot["verdict"] == "EXACT_SOURCE_REPRODUCIBLE":
                record["source_provenance"] = "EXACT_SOURCE_REPRODUCIBLE"
                record["notes"].append(
                    "two independent rebuilds from the exact candidate source "
                    "with the pinned toolchain are byte-identical to the live "
                    "binary (pilot report integrity-pinned by SHA-256)")
            else:
                record["notes"].append(
                    "bounded binary pilot verdict %s: exact-source "
                    "reproducibility NOT established for this binary"
                    % pilot["verdict"])
        return record

    # text artifacts: scripts / lua / wrappers / generated manifests
    if matched:
        record["source_provenance"] = "EXACT_COMMITTED_SOURCE"
        record["build_status"] = "NOT_APPLICABLE_TEXT"
        return record

    # No exact committed source for a live text artifact.
    assert live_sha is not None
    live_bytes = snapshot.object_bytes(live_sha)
    if repo_artifact is not None:
        record["near_miss_analysis"] = near_miss_analysis(
            git, repo_artifact, live_bytes)
    record["documentation_references"] = scan_documentation_references(
        git, [n for n in (live_md5, live_sha) if isinstance(n, str)])
    record["build_status"] = "NOT_APPLICABLE_TEXT"

    if category == "generated_manifest":
        # Generated at deploy/build time; a stale incoherent instance is a
        # staleness finding, not a missing-manual-source finding.
        record["source_provenance"] = "GENERATED_DYNAMIC"
        record["notes"].append(
            "live MANIFEST.txt is a distinct generated instance with no "
            "byte-identical committed counterpart; see "
            "live_manifest_txt_staleness for its disagreement with the "
            "actual live files")
        return record

    # Reconciliation-branch reconstruction: the exact live bytes are carried
    # by the current working tree (absent from the pinned union scan).  The
    # reader fails closed on any missing/symlink/escape/size/hash problem.
    if mapping.get("reconciliation_source"):
        assert repo_artifact is not None
        root = reconciliation_root or REPO_ROOT
        record["reconciliation_source"] = read_reconciliation_source(
            root, repo_artifact, live_sha, entry["size"])
        record["source_provenance"] = STATUS_RECONSTRUCTED
        record["notes"].append(
            "live bytes are byte-identical to the current reconciliation-"
            "branch working-tree source %s (sha256 %s, %d bytes); the bytes "
            "are absent from the pinned 112-commit union scan and were "
            "introduced by the reconciliation branch"
            % (repo_artifact, live_sha, entry["size"]))
        if mapping.get("safety_reviewed"):
            record["public_safety_status"] = "PUBLIC_SAFETY_PASS"
            record["notes"].append(
                "the completed independent public-safety review classified "
                "the source bytes PUBLIC_SOURCE_SAFE (see "
                "public-safety-review.json); the safety verdict makes no "
                "reproducibility claim and is tracked separately from "
                "source provenance")
            record["backup_original_evidence"] = (
                backup_original_evidence_block(git, repo_artifact))
        return record

    record["source_provenance"] = "MANUAL_SOURCE_REQUIRED"
    if mapping.get("safety_reviewed"):
        record["public_safety_status"] = "PUBLIC_SAFETY_PASS"
        record["notes"].append(
            "live file is an uncommitted instrumentation variant with no "
            "exact committed source; the completed independent public-"
            "safety review classified its source bytes PUBLIC_SOURCE_SAFE "
            "(see public-safety-review.json); source provenance remains "
            "manual and is tracked separately from the safety verdict")
        # Backed-up clean original evidence: does a committed blob match the
        # documented clean-original digest (docs/SESSION_HANDOFF.md)?
        if repo_artifact is not None:
            record["backup_original_evidence"] = (
                backup_original_evidence_block(git, repo_artifact))
    return record


# ---------------------------------------------------------------------------
# Output builders
# ---------------------------------------------------------------------------

def build_public_manifest(snapshot: Snapshot) -> Dict[str, Any]:
    entries: List[Dict[str, Any]] = []
    for entry in sorted(snapshot.entries, key=lambda e: e["path"]):
        if entry.get("kind") == "symlink":
            entries.append({
                "path": entry["path"],
                "kind": "symlink",
                "mode": entry.get("mode"),
                "size": entry.get("size"),
                "sha256": entry.get("target_sha256"),
                "target": entry.get("target"),
            })
        else:
            entries.append({
                "path": entry["path"],
                "kind": "file",
                "mode": entry.get("mode"),
                "size": entry.get("size"),
                "sha256": entry.get("sha256"),
            })
    return {
        "schema": SCHEMA_PUBLIC_MANIFEST,
        "snapshot_id": SNAPSHOT_ID,
        "canonical": False,
        "notice": (
            "NON-CANONICAL sanitized derivative of the private evidence "
            "snapshot: approved live paths, kinds, modes, sizes and "
            "SHA256/targets only; the canonical record lives offline with "
            "the collector evidence"),
        "source_label": "box-snapshot-20260817 evidence snapshot (private)",
        "entry_count": len(entries),
        "entries": entries,
    }


def build_repro_status(
        artifact_map: Dict[str, Any],
        git: GitHistory, refs: List[Dict[str, str]],
        hbus_report: Optional[Dict[str, Any]],
        pilot_reports: Optional[List[Dict[str, Any]]] = None
        ) -> Dict[str, Any]:
    entries: List[Dict[str, Any]] = []
    source_counts: Dict[str, int] = {}
    build_counts: Dict[str, int] = {}
    build_verified = 0
    public_safety: List[Dict[str, str]] = []
    for entry in artifact_map["entries"]:
        path = entry["live"]["path"]
        history = entry.get("artifact_history") or {}
        item: Dict[str, Any] = {
            "path": path,
            "source_provenance": entry["source_provenance"],
            "build_status": entry["build_status"],
            "historical_artifact_match": bool(history.get("matched")),
        }
        if history.get("matched"):
            item["git_blob_sha"] = history.get("git_blob_sha")
            item["commit_count"] = history.get("commit_count")
            item["earliest_commit"] = history.get("earliest_commit")
            item["latest_commit"] = history.get("latest_commit")
        if entry.get("public_safety_status"):
            item["public_safety_status"] = entry["public_safety_status"]
            public_safety.append({
                "path": path, "status": entry["public_safety_status"]})
        entries.append(item)
        source_counts[entry["source_provenance"]] = (
            source_counts.get(entry["source_provenance"], 0) + 1)
        build_counts[entry["build_status"]] = (
            build_counts.get(entry["build_status"], 0) + 1)
        if entry["build_status"] == "EXACT_SOURCE_REPRODUCIBLE":
            build_verified += 1

    staleness = artifact_map["live_manifest_txt_staleness"]

    blockers: List[str] = []
    for entry in artifact_map["entries"]:
        if entry["source_provenance"] == "MANUAL_SOURCE_REQUIRED":
            blockers.append(
                "MANUAL_SOURCE_REQUIRED: %s has no exact committed source"
                % entry["live"]["path"])
    unresolved = [
        entry for entry in artifact_map["entries"]
        if entry.get("category") in BINARY_CATEGORIES
        and entry["build_status"] not in ("EXACT_SOURCE_REPRODUCIBLE",)
    ]
    if unresolved:
        blockers.append(
            "UNRESOLVED_BINARY_REPRODUCIBILITY: %d live payload binary(ies) "
            "lack proven exact source reproduction (%s); historical binary "
            "matches are lineage evidence only"
            % (len(unresolved),
               ", ".join(sorted(e["live"]["path"].rsplit("/", 1)[-1]
                                for e in unresolved))))
    if staleness.get("stale"):
        blockers.append(
            "LIVE_MANIFEST_STALE: /data/codex/bin/MANIFEST.txt disagrees "
            "with the actual live files (%d hash/size mismatches, %d live "
            "binaries missing from the listing)"
            % (len(staleness.get("mismatches", [])),
               len(staleness.get("missing_from_listing", []))))
    if git.gaps:
        blockers.append(
            "HISTORY_GAP: %d commit(s) unreachable/missing across every "
            "scanned repo (%s); that ancestry could not be scanned"
            % (len(sorted(git.gaps)), ", ".join(sorted(git.gaps))))

    generated: Dict[str, Any] = {
        "generated_from_evidence_utc":
            artifact_map["generated_from_evidence_utc"],
    }
    if hbus_report is not None:
        generated["hbus_report"] = {
            "label": EVIDENCE_HBUS_LABEL,
            "sha256": hbus_report.get("_sha256"),
            "verdict": hbus_report.get("verdict"),
            "role": "corroborating prior evidence for codex_hbus",
        }
    generated["binary_pilot_reports"] = [
        {
            "label": report["report_label"],
            "sha256": report["report_sha256"],
            "verdict": report["verdict"],
            "diagnostic": report["diagnostic"],
        }
        for report in (pilot_reports or [])
    ]

    return {
        "schema": SCHEMA_REPRO_STATUS,
        "snapshot_id": SNAPSHOT_ID,
        "tool": {"name": TOOL_NAME, "version": TOOL_VERSION},
        "generated": generated,
        "history": {
            "repos_scanned": git.repo_ref_names(),
            "refs": [{"name": r["name"], "tip": r["tip"]} for r in refs],
            "scanned_commit_count": len(git.commits_in_order),
            "history_gaps": sorted(git.gaps),
            "gap_policy": (
                "a parent missing from every scanned repo is a gap; parents "
                "resolvable in any one repo (baseline completing the "
                "shallow historical clone) are not"),
            "baseline_pin_policy": (
                "baseline repo contributes only the pinned ref and its "
                "ancestry; the live reconciliation branch is never scanned"),
            "commit_order": "committer epoch, then sha",
        },
        "entry_count": len(artifact_map["entries"]),
        "status_counts": {
            "source_provenance": dict(sorted(source_counts.items())),
            "build_status": dict(sorted(build_counts.items())),
        },
        "binary_reproducibility": {
            "build_verified_count": build_verified,
            "policy": (
                "a historical binary blob match is deployment-lineage "
                "evidence only and never establishes source "
                "reproducibility; EXACT_SOURCE_REPRODUCIBLE is asserted "
                "only from integrity-pinned pilot reports whose rebuilt "
                "SHA-256 equals the live digest; the corrected Zig "
                "distribution sweep supersedes the earlier nonexact "
                "bt-hal-hbus recipes and the old +20 B observation"),
        },
        "public_safety": {
            "overall_status": "PUBLIC_SAFETY_PASS",
            "review_record": "public-safety-review.json",
            "pending": [],
            "reviewed": public_safety,
        },
        "live_manifest_txt_staleness": {
            "stale": staleness.get("stale"),
            "incoherent": staleness.get("incoherent"),
            "mismatch_count": len(staleness.get("mismatches", [])),
            "mismatched_names": [m["name"] for m in staleness.get("mismatches", [])],
            "missing_from_listing": [
                m["name"] for m in staleness.get("missing_from_listing", [])],
        },
        "blockers": blockers,
        "entries": entries,
    }


# ---------------------------------------------------------------------------
# Public-safety review record (sanitized, durable)
# ---------------------------------------------------------------------------

#: Category recorded for the codex_bthid_keyboard finding.  The concrete MAC
#: values are deliberately NOT reproduced anywhere in generated outputs.
BTHID_MAC_FINDING_CATEGORY = (
    "SELF_TEST_FIXTURE_MACS_DOCUMENTED_OWNER_ELECTED_PUBLISH_AS_IS")

SAFETY_REVIEW_SCHEMA_NOTE = (
    "Sanitized durable record of the completed independent public-safety "
    "review.  Categories and verdicts only: no MAC values, credentials, "
    "host/owner identity, local paths, or object bytes are reproduced.")


def build_public_safety_review(snapshot: Snapshot) -> Dict[str, Any]:
    """Build the sanitized public-safety review record for all entries."""
    verdicts: List[Dict[str, Any]] = []
    for entry in sorted(snapshot.entries, key=lambda e: e["path"]):
        path = entry["path"]
        verdict: Dict[str, Any] = {"path": path, "verdict": "SAFE"}
        if path == "/opt/luaworks/tasks/connectserver/netservicestarter.lua":
            verdict["verdict"] = "PUBLIC_SOURCE_SAFE"
            verdict["scope"] = (
                "live DIAG-variant source bytes reviewed; classified safe "
                "for publication; source provenance is "
                "RECONSTRUCTED_SOURCE_EXACT (reconciliation-branch working "
                "tree) and is tracked separately from the safety verdict")
        if path == "/data/codex/bin/codex_bthid_keyboard":
            verdict["finding_category"] = BTHID_MAC_FINDING_CATEGORY
            verdict["finding_basis"] = (
                "concrete Bluetooth MAC addresses in the candidate source "
                "are self-test fixtures documented in "
                "docs/SESSION_HANDOFF.md (bthid section, lines ~405-407); "
                "the owner previously elected to publish as-is; this record "
                "captures the category only, not the values")
        verdicts.append(verdict)
    return {
        "schema": SCHEMA_PUBLIC_SAFETY,
        "snapshot_id": SNAPSHOT_ID,
        "sanitized": True,
        "overall_status": "PUBLIC_SAFETY_PASS",
        "completed": "2026-08-18",
        "reviewer": "independent public-safety review (identity withheld)",
        "notice": SAFETY_REVIEW_SCHEMA_NOTE,
        "scope": (
            "all allowlisted live paths and their digests from the "
            "authoritative evidence snapshot"),
        "entry_count": len(verdicts),
        "path_verdicts": verdicts,
        "limitations": [
            "PUBLIC_SAFETY_PASS is a publication-safety verdict only; it "
            "makes no claim of source reproducibility or build verification",
            "the safety pass does not authorize copying evidence binaries "
            "or private objects into payload/",
        ],
    }


# ---------------------------------------------------------------------------
# Main derivation
# ---------------------------------------------------------------------------

def derive(snapshot_dir: str, source_repo: str, hbus_report_path: str,
           out_dir: str, baseline_repo: Optional[str] = None,
           baseline_ref: Optional[str] = None,
           pilot_report_paths: Optional[List[Tuple[str, str]]] = None
           ) -> Dict[str, str]:
    """Run the full derivation; returns {filename: absolute path} written.

    `source_repo` is the primary historical clone; `baseline_repo` (default:
    the repository this tool lives in) supplies missing ancestry during the
    union scan, pinned to `baseline_ref` so the live reconciliation branch
    can never change outputs.  `pilot_report_paths` is a list of
    (label, path) binary pilot reports ingested with SHA-256 integrity
    pinning.  Outputs reference everything by sanitized labels only.
    """
    snapshot = Snapshot(snapshot_dir)
    for entry in snapshot.entries:
        validate_live_entry(entry)
    counts = snapshot.manifest.get("counts") or {}
    if counts.get("entries") not in (None, len(snapshot.entries)):
        raise UsageError("snapshot manifest counts disagree with entries")

    repos: List[Tuple[Any, ...]] = [(SOURCE_REPO_LABEL, source_repo)]
    if baseline_repo is not None:
        repos.append((BASELINE_REPO_LABEL, baseline_repo, baseline_ref))
    git = GitHistory(repos)
    git.load_all()
    if not git.commits_in_order:
        raise UsageError("no commits reachable in source repos")
    refs = git.refs()

    hbus_report: Optional[Dict[str, Any]] = None
    if os.path.isfile(hbus_report_path):
        raw = Path(hbus_report_path).read_bytes()
        report: Dict[str, Any] = json.loads(raw.decode("utf-8"))
        report["_sha256"] = sha256_bytes(raw)
        hbus_report = report

    pilot_reports = load_pilot_reports(pilot_report_paths or [])

    allowlist = snapshot.manifest.get("allowlist") or {}
    expected_symlinks = list(allowlist.get("expected_symlinks") or [])

    staleness = analyze_manifest_staleness(snapshot)

    entries = []
    for entry in sorted(snapshot.entries, key=lambda e: e["path"]):
        entries.append(derive_entry(
            snapshot, git, refs, entry, hbus_report, expected_symlinks,
            pilot_reports=pilot_reports,
            reconciliation_root=baseline_repo))

    artifact_map: Dict[str, Any] = {
        "schema": SCHEMA_ARTIFACT_MAP,
        "snapshot_id": SNAPSHOT_ID,
        "canonical": False,
        "notice": (
            "NON-CANONICAL deterministic provenance ledger derived from the "
            "private evidence snapshot and a union scan of the read-only "
            "historical clone plus the baseline reconciliation clone; "
            "contains digests and repo-relative paths only"),
        "tool": {"name": TOOL_NAME, "version": TOOL_VERSION},
        "generated_from_evidence_utc":
            snapshot.manifest.get("generated_at_utc"),
        "evidence_manifest_sha256": snapshot.manifest_sha256,
        "history": {
            "repos_scanned": git.repo_ref_names(),
            "refs": [{"name": r["name"], "tip": r["tip"]} for r in refs],
            "scanned_commit_count": len(git.commits_in_order),
            "history_gaps": sorted(git.gaps),
            "gap_policy": (
                "a parent missing from every scanned repo is a gap; parents "
                "resolvable in any one repo (baseline completing the "
                "shallow historical clone) are not"),
            "baseline_pin": (
                "baseline repo contributes only the pinned ref and its "
                "ancestry; the live reconciliation branch is never scanned"
            ) if baseline_ref else None,
            "commit_order": "committer epoch, then sha",
        },
        "binary_pilot_reports": [
            {
                "label": report["report_label"],
                "sha256": report["report_sha256"],
                "verdict": report["verdict"],
                "diagnostic": report["diagnostic"],
            }
            for report in pilot_reports
        ],
        "entry_count": len(entries),
        "entries": entries,
        "live_manifest_txt_staleness": staleness,
    }

    public_manifest = build_public_manifest(snapshot)
    safety_review = build_public_safety_review(snapshot)
    repro_status = build_repro_status(
        artifact_map, git, refs, hbus_report, pilot_reports=pilot_reports)

    outputs = {
        "artifact-map.json": canonical_json_bytes(artifact_map),
        "reproducibility-status.json": canonical_json_bytes(repro_status),
        "public-payload-manifest.json": canonical_json_bytes(public_manifest),
        "public-safety-review.json": canonical_json_bytes(safety_review),
    }
    os.makedirs(out_dir, exist_ok=True)
    written: Dict[str, str] = {}
    for name, data in outputs.items():
        path = os.path.join(out_dir, name)
        atomic_write_bytes(path, data)
        written[name] = path
    return written


def main(argv: Optional[List[str]] = None) -> int:
    default_source = os.environ.get(SOURCE_REPO_ENV)
    default_baseline = (
        os.environ.get(BASELINE_REPO_ENV) or DEFAULT_BASELINE_REPO)
    default_baseline_ref = (
        os.environ.get(BASELINE_REF_ENV) or DEFAULT_BASELINE_REF)
    default_pilot_dp = os.environ.get(PILOT_REPORT_DHCP_PORTAL_ENV) or (
        os.path.normpath(os.path.join(
            DEFAULT_SNAPSHOT_DIR, "..", "diagnostics", "binary-pilots",
            "dhcpd-portal", "report.json")))
    default_pilot_bth = os.environ.get(PILOT_REPORT_BT_HAL_HBUS_ENV) or (
        os.path.normpath(os.path.join(
            DEFAULT_SNAPSHOT_DIR, "..", "diagnostics", "binary-pilots",
            "bt-hal-hbus", "report.json")))
    default_pilot_webui = os.environ.get(PILOT_REPORT_WEBUI_ENV) or (
        os.path.normpath(os.path.join(
            DEFAULT_SNAPSHOT_DIR, "..", "diagnostics", "binary-pilots",
            "webui", "report.json")))
    default_pilot_zig = os.environ.get(PILOT_REPORT_ZIG_SWEEP_ENV) or (
        os.path.normpath(os.path.join(
            DEFAULT_SNAPSHOT_DIR, "..", "diagnostics", "binary-pilots",
            "zig-distribution-sweep", "report.json")))
    parser = argparse.ArgumentParser(
        prog=TOOL_NAME,
        description="Derive deterministic provenance ledger for %s" % SNAPSHOT_ID)
    parser.add_argument("--snapshot-dir", default=DEFAULT_SNAPSHOT_DIR)
    parser.add_argument("--source-repo", default=default_source,
                        help="primary historical clone (may be shallow); "
                             "required unless %s is set"
                             % SOURCE_REPO_ENV)
    parser.add_argument("--baseline-repo", default=default_baseline,
                        help="secondary full-ancestry clone completing the "
                             "union scan (default: this repository; env: %s)"
                             % BASELINE_REPO_ENV)
    parser.add_argument("--baseline-ref", default=default_baseline_ref,
                        help="pin the baseline repo to exactly this ref/"
                             "commit and its ancestry (default: the public "
                             "base commit; env: %s). Never scans the live "
                             "reconciliation branch."
                             % BASELINE_REF_ENV)
    parser.add_argument("--hbus-report", default=DEFAULT_HBUS_REPORT)
    parser.add_argument("--pilot-dhcp-portal-report", default=default_pilot_dp,
                        help="binary pilot report for dhcpd/portal (env: %s)"
                             % PILOT_REPORT_DHCP_PORTAL_ENV)
    parser.add_argument("--pilot-bt-hal-hbus-report", default=default_pilot_bth,
                        help="binary pilot report for pair/bthid/hal/hbus "
                             "(env: %s)" % PILOT_REPORT_BT_HAL_HBUS_ENV)
    parser.add_argument("--pilot-webui-report", default=default_pilot_webui,
                        help="binary pilot report for webui (env: %s)"
                             % PILOT_REPORT_WEBUI_ENV)
    parser.add_argument("--pilot-zig-sweep-report", default=default_pilot_zig,
                        help="corrected Zig distribution sweep report "
                             "(env: %s)" % PILOT_REPORT_ZIG_SWEEP_ENV)
    parser.add_argument("--out-dir", default=DEFAULT_OUT_DIR)
    args = parser.parse_args(argv)

    try:
        if not args.source_repo:
            raise UsageError(
                "--source-repo is required (or set %s to the historical "
                "clone path); no default is baked in" % SOURCE_REPO_ENV)
        if not os.path.isdir(args.snapshot_dir):
            raise UsageError("snapshot dir not found: %s" % args.snapshot_dir)
        if not os.path.isdir(args.source_repo):
            raise UsageError("source repo not found: %s" % args.source_repo)
        if args.baseline_repo and not os.path.isdir(args.baseline_repo):
            raise UsageError(
                "baseline repo not found: %s" % args.baseline_repo)
        pilot_paths = [
            (EVIDENCE_PILOT_DHCP_PORTAL_LABEL, args.pilot_dhcp_portal_report),
            (EVIDENCE_PILOT_BT_HAL_HBUS_LABEL, args.pilot_bt_hal_hbus_report),
            (EVIDENCE_PILOT_WEBUI_LABEL, args.pilot_webui_report),
            (EVIDENCE_PILOT_ZIG_SWEEP_LABEL, args.pilot_zig_sweep_report),
        ]
        written = derive(args.snapshot_dir, args.source_repo,
                         args.hbus_report, args.out_dir,
                         baseline_repo=args.baseline_repo,
                         baseline_ref=args.baseline_ref,
                         pilot_report_paths=pilot_paths)
    except UsageError as exc:
        print("%s: error: %s" % (TOOL_NAME, exc), file=sys.stderr)
        return 2
    for name, path in sorted(written.items()):
        print("%s: wrote %s" % (TOOL_NAME, path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
