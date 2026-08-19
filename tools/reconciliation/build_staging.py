#!/usr/bin/env python3
"""Deterministic staging builder for box snapshot `box-snapshot-20260818`.

Reads (strictly read-only, offline, standard library only):

  * ``provenance/box-snapshot-20260818/public-payload-manifest.json`` -- the
    sanitized NON-CANONICAL public live manifest (authoritative live paths,
    kinds, modes, sizes, SHA-256 digests and symlink targets);
  * ``provenance/box-snapshot-20260818/reproducibility-status.json`` -- the
    per-entry build statuses and source provenance;
  * ``provenance/box-snapshot-20260818/staging-contract.json`` -- the reviewed
    staging contract (required closure, exact mappings, allowed exact-build
    binaries, expected blockers, no-fallback policy, output schema);
  * the current repository working-tree text sources (repo-relative paths
    declared by the contract only);
  * an explicit, caller-supplied ``--build-output-dir`` of fresh source-built
    binaries (optional; the ONLY place binaries are ever read from).

Writes ONLY to the caller ``--out-dir``:

  * ``rootfs/``                        -- the staged local root filesystem
                                          (files with exact live modes, the
                                          three exact symlinks), published by
                                          an atomic rename;
  * ``staging-manifest.json``          -- what was staged, against which
                                          sources, with every entry verified
                                          byte/size/mode/target against the
                                          public live manifest before publish;
  * ``blockers.json``                  -- every omitted closure entry with an
                                          exact reason code and the live
                                          build_status/source_provenance;
  * ``staging-attestation.json``       -- public-safe attestation (canonical
                                          false, complete false while any
                                          blocker remains, NON-CANONICAL
                                          notice, no private evidence paths,
                                          host/user identity, or MD5).

Policy encoded by this tool (enforced, not assumed):

  * Every required-closure entry must be staged exactly (bytes, size, mode,
    symlink target -- re-verified from disk against the live manifest before
    publish) or reported as a blocker; a staging with any blocker is
    incomplete.
  * A live binary is staged only when its ``build_status`` is
    ``EXACT_SOURCE_REPRODUCIBLE`` AND a regular file named by the contract
    exists in ``--build-output-dir`` matching the live SHA-256 and size.
    Currently that is codex_dhcpd and codex_portal only; the other six live
    binaries are omitted with exact statuses.
  * The repository ``payload/bin`` tree is NEVER read and never a fallback:
    a binary without a qualifying source-built artifact is omitted, never
    sourced from tracked binaries.  A ``--build-output-dir`` inside
    ``payload/bin`` is rejected.
  * The stale live ``/data/codex/bin/MANIFEST.txt`` is never staged.  A fresh
    legacy ``MANIFEST.txt`` is emitted only for a COMPLETE staging (every
    required binary source-reproducible and present); it is never emitted for
    a partial staging.
  * Without ``--allow-partial`` an incomplete staging fails closed: no rootfs
    is published (diagnostic staging-manifest.json and blockers.json only).

Determinism: outputs are canonical JSON (sorted keys, 2-space indent, ASCII,
LF-terminated) with no wall-clock timestamps; metadata is inherited from the
reproducibility record and input digests.  Two runs over identical inputs
produce byte-identical outputs.

Exit codes: 0 = complete staging published; 2 = usage/input/contract/safety
failure (nothing published); 3 = partial staging published under
--allow-partial; 4 = incomplete staging without --allow-partial (fail closed,
no rootfs published).

Invocation (no personal or machine-specific defaults are baked in):

    python3 tools/reconciliation/build_staging.py \
        --out-dir /path/to/staging-output \
        [--build-output-dir /path/to/source-built-binaries] \
        [--allow-partial]

Optional environment overrides: HARMONY_STAGING_LIVE_MANIFEST,
HARMONY_STAGING_REPRO_STATUS, HARMONY_STAGING_CONTRACT,
HARMONY_STAGING_REPO_ROOT, HARMONY_STAGING_BUILD_OUTPUT_DIR.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from typing import Any, Dict, List, Optional, Set, Tuple

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

TOOL_NAME = "build_staging"
TOOL_VERSION = "1.0.0"
SNAPSHOT_ID = "box-snapshot-20260818"

SCHEMA_LIVE_MANIFEST = "public-payload-manifest/1"
SCHEMA_REPRO_STATUS = "provenance-reproducibility-status/1"
SCHEMA_CONTRACT = "staging-contract/1"
SCHEMA_STAGING_MANIFEST = "staging-manifest/1"
SCHEMA_STAGING_BLOCKERS = "staging-blockers/1"
SCHEMA_STAGING_ATTESTATION = "staging-attestation/1"

STATUS_EXACT = "EXACT_SOURCE_REPRODUCIBLE"
REASON_UNRESOLVED = "UNRESOLVED_BINARY_REPRODUCIBILITY"
REASON_NO_BUILD_OUTPUT = "NO_SOURCE_BUILD_OUTPUT"
REASON_BUILD_MISMATCH = "BUILD_OUTPUT_MISMATCH"
REASON_TEXT_MISSING = "SOURCE_TEXT_MISSING"
REASON_TEXT_MISMATCH = "SOURCE_TEXT_MISMATCH"

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_PROVENANCE_DIR = os.path.join(REPO_ROOT, "provenance", SNAPSHOT_ID)
DEFAULT_LIVE_MANIFEST = os.path.join(DEFAULT_PROVENANCE_DIR, "public-payload-manifest.json")
DEFAULT_REPRO_STATUS = os.path.join(DEFAULT_PROVENANCE_DIR, "reproducibility-status.json")
DEFAULT_CONTRACT = os.path.join(DEFAULT_PROVENANCE_DIR, "staging-contract.json")

LIVE_MANIFEST_ENV = "HARMONY_STAGING_LIVE_MANIFEST"
REPRO_STATUS_ENV = "HARMONY_STAGING_REPRO_STATUS"
CONTRACT_ENV = "HARMONY_STAGING_CONTRACT"
REPO_ROOT_ENV = "HARMONY_STAGING_REPO_ROOT"
BUILD_OUTPUT_ENV = "HARMONY_STAGING_BUILD_OUTPUT_DIR"

#: output layout (mirrors the contract's ``outputs`` section)
ROOTFS_DIR_NAME = "rootfs"
MANIFEST_NAME = "staging-manifest.json"
BLOCKERS_NAME = "blockers.json"
ATTESTATION_NAME = "staging-attestation.json"
MANIFEST_MODE = 0o644
ROOTFS_DIR_MODE = 0o755

#: exit codes
EXIT_COMPLETE = 0
EXIT_USAGE = 2
EXIT_PARTIAL = 3
EXIT_FAIL_CLOSED = 4

#: repository trees the out-dir must never be placed in (the tool itself must
#: never write into the tracked payload, provenance, docs, or tools trees)
PROTECTED_REPO_TREES = ("payload", "provenance", "docs", "tools", ".git", ".slim")

REPO_SOURCE_LABEL = "harmony-hub-control working tree (repo-relative paths only)"
BUILD_OUTPUT_LABEL = "caller-supplied source-built output dir"

RE_SHA256 = re.compile(r"\A[0-9a-f]{64}\Z")
RE_MODE = re.compile(r"\A[l-][r-][w-][xSs-][r-][w-][xSs-][r-][w-][xtT-]\Z")
RE_BUILD_NAME = re.compile(r"\A[A-Za-z0-9._-]+\Z")

NOTICE_MANIFEST_PUBLISHED = (
    "NON-CANONICAL staged rootfs manifest: every staged entry was "
    "byte/size/mode/target-verified against public-payload-manifest/1 before "
    "publish; derived from the sanitized public payload manifest, the "
    "reproducibility status record, current repository text sources, and "
    "caller-supplied source-built binaries only")
NOTICE_MANIFEST_FAIL_CLOSED = (
    "NON-CANONICAL staging plan record: the staging is incomplete and failed "
    "closed (no --allow-partial), so NO rootfs was published or verified; the "
    "entries below are the plan derived from the sanitized public payload "
    "manifest, the reproducibility status record, current repository text "
    "sources, and caller-supplied source-built binaries only")
NOTICE_BLOCKERS = (
    "NON-CANONICAL staging blocker record: every required-closure entry that "
    "could not be staged is listed with an exact reason code plus the live "
    "build_status/source_provenance; a staging with any blocker is incomplete")
NOTICE_ATTESTATION = (
    "NON-CANONICAL public-safe staging attestation derived from the sanitized "
    "public payload manifest, the reproducibility status record, current "
    "repository text sources, and caller-supplied source-built binaries; "
    "contains no private evidence paths, host/user identity, or MD5 digests")

ARTIFACT_ABSENT = "absent"
ARTIFACT_NOT_REGULAR = "not_regular_file"
ARTIFACT_MATCH_INELIGIBLE = "present_hash_match_not_eligible"
ARTIFACT_MISMATCH = "present_hash_mismatch"


class UsageError(Exception):
    """Bad CLI usage, input, contract, or safety failure.  Fatal (exit 2)."""


# ---------------------------------------------------------------------------
# Deterministic serialization / atomic output
# ---------------------------------------------------------------------------

def canonical_json_bytes(obj: Any) -> bytes:
    """Deterministic JSON: sorted keys, 2-space indent, ascii, LF-final."""
    return (
        json.dumps(obj, sort_keys=True, indent=2, ensure_ascii=True).encode("ascii")
        + b"\n"
    )


def atomic_write_bytes(path: str, data: bytes, mode: int = MANIFEST_MODE) -> None:
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


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def md5_bytes(data: bytes) -> str:
    """Used ONLY for the on-hub legacy MANIFEST.txt format, never in a
    generated JSON manifest."""
    return hashlib.md5(data).hexdigest()


def oct_mode(mode: int) -> str:
    return "%04o" % (mode & 0o7777)


# ---------------------------------------------------------------------------
# ls-style mode parsing (public live manifest mode strings)
# ---------------------------------------------------------------------------

_MODE_POSITIONS: Tuple[Tuple[Tuple[str, int], ...], ...] = (
    (("r", 0o400), ("-", 0)),
    (("w", 0o200), ("-", 0)),
    (("x", 0o100), ("S", 0o400), ("s", 0o500), ("-", 0)),
    (("r", 0o040), ("-", 0)),
    (("w", 0o020), ("-", 0)),
    (("x", 0o010), ("S", 0o200), ("s", 0o210), ("-", 0)),
    (("r", 0o004), ("-", 0)),
    (("w", 0o002), ("-", 0)),
    (("x", 0o001), ("T", 0o1000), ("t", 0o1001), ("-", 0)),
)


def parse_ls_mode(mode: str, context: str) -> int:
    if not isinstance(mode, str) or not RE_MODE.match(mode):
        raise UsageError("%s: invalid ls-style mode %r" % (context, mode))
    value = 0
    for index, char in enumerate(mode[1:]):
        for expected, bits in _MODE_POSITIONS[index]:
            if char == expected:
                value |= bits
                break
        else:
            raise UsageError(
                "%s: mode character %r at position %d" % (context, char, index))
    return value


# ---------------------------------------------------------------------------
# Path safety
# ---------------------------------------------------------------------------

def validate_live_path(path: str, context: str) -> List[str]:
    """A live path must be absolute, normalized, NUL-free, and traversal-free."""
    if not isinstance(path, str) or not path.startswith("/"):
        raise UsageError("%s: live path must be absolute: %r" % (context, path))
    if "\x00" in path:
        raise UsageError("%s: live path contains NUL" % context)
    if os.path.normpath(path) != path:
        raise UsageError(
            "%s: live path is not normalized: %r" % (context, path))
    if path == "/":
        raise UsageError("%s: live path is the filesystem root" % context)
    parts = path.split("/")[1:]
    if any(part in ("", ".", "..") for part in parts):
        raise UsageError("%s: live path has empty/dot/dotdot segments: %r"
                         % (context, path))
    return parts


def is_within(candidate: str, root: str) -> bool:
    candidate = os.path.normpath(candidate)
    root = os.path.normpath(root)
    return candidate == root or candidate.startswith(root + os.sep)


def dir_path_pair(path: str, label: str) -> Tuple[str, str]:
    """(lexical absolute, symlink-resolved) pair for a directory argument."""
    if not isinstance(path, str) or not path:
        raise UsageError("%s: empty path" % label)
    if "\x00" in path:
        raise UsageError("%s: path contains NUL" % label)
    lex = os.path.normpath(os.path.abspath(path))
    real = os.path.realpath(lex)
    return lex, real


def check_out_dir_safety(out_lex: str, out_real: str, repo_root: str) -> None:
    for base, kind in ((out_lex, "path"), (out_real, "resolved path")):
        if base == os.sep:
            raise UsageError("out-dir %s is the filesystem root; refusing" % kind)
    repo_lex = os.path.abspath(repo_root)
    repo_real = os.path.realpath(repo_root)
    for base, kind in ((out_lex, "path"), (out_real, "resolved path")):
        if base in (repo_lex, repo_real):
            raise UsageError(
                "out-dir %s is the repository root; refusing" % kind)
        for tree in PROTECTED_REPO_TREES:
            for repo_base in (repo_lex, repo_real):
                protected = os.path.join(repo_base, tree)
                if base == protected or is_within(base, protected):
                    raise UsageError(
                        "out-dir %s is inside the repository %s tree; "
                        "refusing (staging outputs never go there)" % (kind, tree))


def check_build_output_safety(
        build_lex: str, build_real: str,
        out_lex: str, out_real: str, repo_root: str) -> None:
    repo_lex = os.path.abspath(repo_root)
    repo_real = os.path.realpath(repo_root)
    payload_bin_bases = [
        os.path.join(repo_base, "payload", "bin")
        for repo_base in (repo_lex, repo_real)
    ]
    for base, kind in ((build_lex, "path"), (build_real, "resolved path")):
        for payload_bin in payload_bin_bases:
            if base == payload_bin or is_within(base, payload_bin):
                raise UsageError(
                    "build-output-dir %s is the repository payload/bin tree; "
                    "refusing: tracked payload/bin is never a binary source "
                    "(no fallback)" % kind)
    for a_lex, a_real in ((build_lex, build_real),):
        for b_lex, b_real in ((out_lex, out_real),):
            for a, b in ((a_lex, b_lex), (a_real, b_real)):
                if a == b or is_within(a, b) or is_within(b, a):
                    raise UsageError(
                        "build-output-dir and out-dir overlap; refusing")


# ---------------------------------------------------------------------------
# Input loading and validation
# ---------------------------------------------------------------------------

def load_json_input(path: str, label: str) -> Tuple[Dict[str, Any], str]:
    if not os.path.isfile(path):
        raise UsageError("%s not found: %s" % (label, path))
    with open(path, "rb") as handle:
        raw = handle.read()
    try:
        obj = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise UsageError("%s is not valid JSON: %s" % (label, exc)) from exc
    if not isinstance(obj, dict):
        raise UsageError("%s must be a JSON object" % label)
    return obj, sha256_bytes(raw)


def validate_live_manifest(obj: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    if obj.get("schema") != SCHEMA_LIVE_MANIFEST:
        raise UsageError("live manifest schema mismatch: %r" % obj.get("schema"))
    if obj.get("snapshot_id") != SNAPSHOT_ID:
        raise UsageError(
            "live manifest snapshot mismatch: %r" % obj.get("snapshot_id"))
    if obj.get("canonical") is not False:
        raise UsageError("live manifest must carry canonical=false")
    entries = obj.get("entries")
    if not isinstance(entries, list) or not entries:
        raise UsageError("live manifest has no entries")
    if obj.get("entry_count") != len(entries):
        raise UsageError("live manifest entry_count disagrees with entries")
    by_path: Dict[str, Dict[str, Any]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise UsageError("live manifest entry is not an object")
        path = entry.get("path")
        if not isinstance(path, str):
            raise UsageError("live manifest entry path must be a string")
        context = "live manifest entry %r" % path
        validate_live_path(path, context)
        if path in by_path:
            raise UsageError("live manifest duplicate path %s" % path)
        kind = entry.get("kind")
        if kind not in ("file", "symlink"):
            raise UsageError("%s: invalid kind %r" % (context, kind))
        mode_str = entry.get("mode")
        if not isinstance(mode_str, str):
            raise UsageError("%s: mode must be a string" % context)
        mode = parse_ls_mode(mode_str, context)
        digest = entry.get("sha256")
        if not isinstance(digest, str) or not RE_SHA256.match(digest):
            raise UsageError("%s: invalid sha256" % context)
        size = entry.get("size")
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise UsageError("%s: invalid size" % context)
        target = entry.get("target")
        if kind == "symlink":
            if not isinstance(target, str) or not target:
                raise UsageError("%s: symlink entry missing target" % context)
            if len(target.encode("utf-8")) != size:
                raise UsageError("%s: symlink size != target length" % context)
            if sha256_bytes(target.encode("utf-8")) != digest:
                raise UsageError("%s: symlink sha256 != digest(target)" % context)
        else:
            if "target" in entry:
                raise UsageError("%s: file entry carries a target" % context)
        by_path[path] = {
            "kind": kind, "mode_str": mode_str, "mode": mode,
            "sha256": digest, "size": size, "target": target,
        }
    return by_path


def validate_repro_status(
        obj: Dict[str, Any],
        live_paths: Set[str]) -> Dict[str, Tuple[str, str]]:
    if obj.get("schema") != SCHEMA_REPRO_STATUS:
        raise UsageError(
            "reproducibility status schema mismatch: %r" % obj.get("schema"))
    if obj.get("snapshot_id") != SNAPSHOT_ID:
        raise UsageError(
            "reproducibility status snapshot mismatch: %r"
            % obj.get("snapshot_id"))
    entries = obj.get("entries")
    if not isinstance(entries, list) or not entries:
        raise UsageError("reproducibility status has no entries")
    if obj.get("entry_count") != len(entries):
        raise UsageError("reproducibility status entry_count disagrees")
    by_path: Dict[str, Tuple[str, str]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise UsageError("reproducibility status entry is not an object")
        path = entry.get("path")
        if not isinstance(path, str) or path not in live_paths:
            raise UsageError(
                "reproducibility status entry path %r is not a live manifest "
                "path" % path)
        if path in by_path:
            raise UsageError("reproducibility status duplicate path %s" % path)
        build_status = entry.get("build_status")
        provenance = entry.get("source_provenance")
        if not isinstance(build_status, str) or not build_status:
            raise UsageError("reproducibility status entry %s: bad build_status"
                             % path)
        if not isinstance(provenance, str) or not provenance:
            raise UsageError("reproducibility status entry %s: bad "
                             "source_provenance" % path)
        by_path[path] = (build_status, provenance)
    if set(by_path) != live_paths:
        raise UsageError(
            "reproducibility status entries do not match the live manifest "
            "entries (missing=%s extra=%s)"
            % (sorted(live_paths - set(by_path))[:3],
               sorted(set(by_path) - live_paths)[:3]))
    return by_path


def _require_mapping(container: Dict[str, Any], key: str, label: str) -> Any:
    value = container.get(key)
    if not isinstance(value, dict):
        raise UsageError("staging contract %s must be an object" % label)
    return value


def validate_contract(
        obj: Dict[str, Any],
        live: Dict[str, Dict[str, Any]],
        repro: Dict[str, Tuple[str, str]]) -> Dict[str, Any]:
    if obj.get("schema") != SCHEMA_CONTRACT:
        raise UsageError(
            "staging contract schema mismatch: %r" % obj.get("schema"))
    if obj.get("snapshot_id") != SNAPSHOT_ID:
        raise UsageError(
            "staging contract snapshot mismatch: %r" % obj.get("snapshot_id"))
    if obj.get("canonical") is not False:
        raise UsageError("staging contract must carry canonical=false")

    closure = _require_mapping(obj, "required_closure", "required_closure")
    paths = closure.get("paths")
    if (not isinstance(paths, list) or not paths
            or not all(isinstance(p, str) for p in paths)):
        raise UsageError("staging contract closure paths must be a list")
    if len(set(paths)) != len(paths):
        raise UsageError("staging contract closure has duplicate paths")
    if closure.get("entry_count") != len(paths):
        raise UsageError("staging contract closure entry_count disagrees")
    excluded_raw = closure.get("excluded_live_paths")
    if not isinstance(excluded_raw, list) or not excluded_raw:
        raise UsageError("staging contract must exclude at least one live path")
    excluded: List[Dict[str, str]] = []
    for item in excluded_raw:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise UsageError("staging contract excluded entry is malformed")
        excluded.append({
            "path": item["path"],
            "reason_code": str(item.get("reason_code", "")),
            "detail": str(item.get("detail", "")),
        })
    excluded_paths = [item["path"] for item in excluded]
    if len(set(excluded_paths)) != len(excluded_paths):
        raise UsageError("staging contract excluded paths duplicate")
    for path in excluded_paths:
        if path not in live:
            raise UsageError(
                "staging contract excludes unknown live path %s" % path)
    closure_set = set(paths)
    for path in paths:
        if path not in live:
            raise UsageError("staging contract closure path %s is not a live "
                             "entry" % path)
    if closure_set & set(excluded_paths):
        raise UsageError("staging contract closure overlaps the excluded paths")
    if closure_set | set(excluded_paths) != set(live):
        raise UsageError(
            "staging contract closure + excluded must equal the live manifest "
            "entries exactly (uncovered=%s)"
            % sorted(set(live) - closure_set - set(excluded_paths))[:3])

    mappings = _require_mapping(obj, "mappings", "mappings")
    text_map = _require_mapping(mappings, "text_sources", "mappings.text_sources")
    literal_map = _require_mapping(
        mappings, "installer_literals", "mappings.installer_literals")
    symlink_map = _require_mapping(mappings, "symlinks", "mappings.symlinks")
    binary_map = _require_mapping(mappings, "binaries", "mappings.binaries")
    mapped = list(text_map) + list(literal_map) + list(symlink_map) + list(binary_map)
    if len(mapped) != len(set(mapped)):
        raise UsageError("staging contract mappings overlap")
    if set(mapped) != closure_set:
        raise UsageError(
            "staging contract mappings must partition the closure exactly "
            "(unmapped=%s)" % sorted(closure_set - set(mapped))[:3])

    for path, spec in text_map.items():
        if not isinstance(spec, dict) or not isinstance(spec.get("repo_path"), str):
            raise UsageError("staging contract text mapping %s is malformed" % path)
        if live[path]["kind"] != "file":
            raise UsageError("text mapping %s must map a live file entry" % path)
        repo_path = spec["repo_path"]
        if (repo_path.startswith("/") or "\x00" in repo_path
                or os.path.normpath(repo_path) != repo_path
                or any(part in ("", ".", "..") for part in repo_path.split("/"))):
            raise UsageError(
                "staging contract text mapping %s has an unsafe repo_path %r"
                % (path, repo_path))
    for path, spec in literal_map.items():
        if not isinstance(spec, dict) or not isinstance(spec.get("literal"), str):
            raise UsageError("literal mapping %s is malformed" % path)
        if live[path]["kind"] != "file":
            raise UsageError("literal mapping %s must map a live file entry" % path)
        data = spec["literal"].encode("utf-8")
        if sha256_bytes(data) != live[path]["sha256"]:
            raise UsageError(
                "literal mapping %s is not byte-identical to the live entry"
                % path)
        if len(data) != live[path]["size"]:
            raise UsageError(
                "literal mapping %s size disagrees with the live entry" % path)
    for path, spec in symlink_map.items():
        if not isinstance(spec, dict) or not isinstance(spec.get("target"), str):
            raise UsageError("symlink mapping %s is malformed" % path)
        if live[path]["kind"] != "symlink":
            raise UsageError(
                "symlink mapping %s must map a live symlink entry" % path)
        if spec["target"] != live[path]["target"]:
            raise UsageError(
                "symlink mapping %s target disagrees with the live manifest"
                % path)
    for path, spec in binary_map.items():
        if not isinstance(spec, dict) or not isinstance(
                spec.get("build_output_name"), str):
            raise UsageError("binary mapping %s is malformed" % path)
        if live[path]["kind"] != "file":
            raise UsageError("binary mapping %s must map a live file entry" % path)
        name = spec["build_output_name"]
        if (name != os.path.basename(path) or not RE_BUILD_NAME.match(name)
                or name in (".", "..")):
            raise UsageError(
                "binary mapping %s has an unsafe build_output_name %r"
                % (path, name))

    # allowed exact-build binaries must equal the EXACT_SOURCE_REPRODUCIBLE set
    allowed = _require_mapping(
        obj, "allowed_exact_build_binaries", "allowed_exact_build_binaries")
    allowed_paths = allowed.get("paths")
    if (not isinstance(allowed_paths, list)
            or not all(isinstance(p, str) for p in allowed_paths)):
        raise UsageError("allowed_exact_build_binaries.paths must be a list")
    computed_exact = {
        path for path in binary_map
        if repro[path][0] == STATUS_EXACT
    }
    if set(allowed_paths) != computed_exact or len(set(allowed_paths)) != len(allowed_paths):
        raise UsageError(
            "staging contract allowed_exact_build_binaries disagree with the "
            "reproducibility status EXACT_SOURCE_REPRODUCIBLE set "
            "(contract=%s computed=%s)"
            % (sorted(set(allowed_paths)), sorted(computed_exact)))

    # declared current blockers must equal the computed unresolved set
    blockers = _require_mapping(obj, "blockers", "blockers")
    current = blockers.get("current_expected")
    if not isinstance(current, list):
        raise UsageError("blockers.current_expected must be a list")
    declared: Dict[str, Tuple[str, str, str]] = {}
    for item in current:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise UsageError("blockers.current_expected entry is malformed")
        path = item["path"]
        if path in declared:
            raise UsageError("blockers.current_expected duplicate path %s" % path)
        declared[path] = (
            str(item.get("build_status", "")),
            str(item.get("source_provenance", "")),
            str(item.get("reason_code", "")),
        )
    computed_unresolved: Dict[str, Tuple[str, str, str]] = {
        path: (repro[path][0], repro[path][1], REASON_UNRESOLVED)
        for path in binary_map
        if repro[path][0] != STATUS_EXACT
    }
    if declared != computed_unresolved:
        raise UsageError(
            "staging contract blockers.current_expected disagree with the "
            "reproducibility status (contract=%s computed=%s)"
            % (sorted(declared), sorted(computed_unresolved)))

    # legacy manifest gate
    legacy = _require_mapping(obj, "legacy_manifest", "legacy_manifest")
    legacy_path = legacy.get("live_path")
    if not isinstance(legacy_path, str) or legacy_path not in excluded_paths:
        raise UsageError(
            "legacy_manifest.live_path must be an excluded live path")
    legacy_mode = legacy.get("mode")
    if not isinstance(legacy_mode, str) or not re.match(r"\A0[0-7]{3}\Z", legacy_mode):
        raise UsageError("legacy_manifest.mode must be a 4-digit octal string")
    if int(legacy_mode, 8) != live[legacy_path]["mode"]:
        raise UsageError(
            "legacy_manifest.mode disagrees with the live manifest mode for "
            "%s" % legacy_path)
    legacy_binaries = legacy.get("binaries")
    if (not isinstance(legacy_binaries, list) or not legacy_binaries
            or not all(isinstance(n, str) for n in legacy_binaries)):
        raise UsageError("legacy_manifest.binaries must be a list of names")
    if len(set(legacy_binaries)) != len(legacy_binaries):
        raise UsageError("legacy_manifest.binaries has duplicates")
    if set(legacy_binaries) != {
            os.path.basename(path) for path in binary_map}:
        raise UsageError(
            "legacy_manifest.binaries must equal the mapped binary names")

    # output layout contract
    outputs = _require_mapping(obj, "outputs", "outputs")
    if outputs.get("rootfs_dir") != ROOTFS_DIR_NAME:
        raise UsageError("staging contract outputs.rootfs_dir must be %r"
                         % ROOTFS_DIR_NAME)
    if set(outputs.get("manifests") or []) != {
            MANIFEST_NAME, BLOCKERS_NAME, ATTESTATION_NAME}:
        raise UsageError("staging contract outputs.manifests must be exactly "
                         "the three staging manifests")
    if set(outputs.get("fail_closed_outputs") or []) != {
            MANIFEST_NAME, BLOCKERS_NAME}:
        raise UsageError("staging contract outputs.fail_closed_outputs must "
                         "be the two diagnostic manifests")

    return {
        "closure_paths": sorted(closure_set),
        "closure_count": len(closure_set),
        "excluded": sorted(excluded, key=lambda item: item["path"]),
        "text_map": text_map,
        "literal_map": literal_map,
        "symlink_map": symlink_map,
        "binary_map": binary_map,
        "legacy_path": legacy_path,
        "legacy_mode": int(legacy_mode, 8),
        "legacy_binaries": list(legacy_binaries),
        "legacy_format": str(legacy.get("format", "")),
        "legacy_emit_policy": str(legacy.get("emit_policy", "")),
        "blockers_policy": str(blockers.get("policy", "")),
        "no_fallback_policy": _require_mapping(
            obj, "no_fallback_policy", "no_fallback_policy"),
        "exit_codes": _require_mapping(obj, "exit_codes", "exit_codes"),
    }


# ---------------------------------------------------------------------------
# Staging plan
# ---------------------------------------------------------------------------

def _new_staged(
        path: str, live_entry: Dict[str, Any], repro: Dict[str, Tuple[str, str]],
        source_type: str, **extra: Any) -> Dict[str, Any]:
    build_status, provenance = repro[path]
    record: Dict[str, Any] = {
        "path": path,
        "kind": live_entry["kind"],
        "mode": live_entry["mode"],
        "mode_str": live_entry["mode_str"],
        "size": live_entry["size"],
        "sha256": live_entry["sha256"],
        "target": live_entry["target"],
        "build_status": build_status,
        "source_provenance": provenance,
        "source_type": source_type,
        "repo_path": None,
        "build_output_name": None,
        "literal": None,
        "bytes": None,
    }
    record.update(extra)
    return record


def _new_blocker(
        path: str, live_entry: Dict[str, Any], reason_code: str, detail: str,
        build_status: Optional[str] = None,
        source_provenance: Optional[str] = None,
        build_output_artifact: Optional[str] = None) -> Dict[str, Any]:
    return {
        "path": path,
        "kind": live_entry["kind"],
        "reason_code": reason_code,
        "build_status": build_status,
        "source_provenance": source_provenance,
        "build_output_artifact": build_output_artifact,
        "detail": detail,
    }


def describe_build_artifact(
        build_output_dir: str, name: str,
        live_entry: Dict[str, Any]) -> Optional[str]:
    """Classify what the build-output dir holds for an ineligible binary."""
    candidate = os.path.join(build_output_dir, name)
    if not os.path.lexists(candidate):
        return ARTIFACT_ABSENT
    if os.path.islink(candidate):
        return ARTIFACT_NOT_REGULAR
    if not os.path.isfile(candidate):
        return ARTIFACT_NOT_REGULAR
    try:
        with open(candidate, "rb") as handle:
            data = handle.read()
    except OSError:
        return ARTIFACT_NOT_REGULAR
    if sha256_bytes(data) == live_entry["sha256"] and len(data) == live_entry["size"]:
        return ARTIFACT_MATCH_INELIGIBLE
    return ARTIFACT_MISMATCH


def plan_staging(
        contract: Dict[str, Any],
        live: Dict[str, Dict[str, Any]],
        repro: Dict[str, Tuple[str, str]],
        repo_root: str,
        build_output_dir: Optional[str],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], bool]:
    staged: List[Dict[str, Any]] = []
    blocked: List[Dict[str, Any]] = []
    repo_real = os.path.realpath(repo_root)

    for path in contract["closure_paths"]:
        live_entry = live[path]
        if path in contract["text_map"]:
            repo_path = contract["text_map"][path]["repo_path"]
            source_lex = os.path.normpath(os.path.join(repo_root, repo_path))
            if not is_within(source_lex, repo_root):
                blocked.append(_new_blocker(
                    path, live_entry, REASON_TEXT_MISSING,
                    "repository source %s resolves outside the repository"
                    % repo_path))
                continue
            if (os.path.islink(source_lex)
                    or not os.path.isfile(source_lex)):
                blocked.append(_new_blocker(
                    path, live_entry, REASON_TEXT_MISSING,
                    "repository source %s is missing or not a regular file"
                    % repo_path))
                continue
            source_real = os.path.realpath(source_lex)
            if not is_within(source_real, repo_real):
                blocked.append(_new_blocker(
                    path, live_entry, REASON_TEXT_MISSING,
                    "repository source %s resolves outside the repository"
                    % repo_path))
                continue
            with open(source_lex, "rb") as handle:
                data = handle.read()
            digest = sha256_bytes(data)
            if digest != live_entry["sha256"] or len(data) != live_entry["size"]:
                blocked.append(_new_blocker(
                    path, live_entry, REASON_TEXT_MISMATCH,
                    "repository source %s is not byte-identical to the live "
                    "entry (expected sha256 %s size %d, found sha256 %s size %d)"
                    % (repo_path, live_entry["sha256"], live_entry["size"],
                       digest, len(data))))
                continue
            staged.append(_new_staged(
                path, live_entry, repro, "repo_text",
                repo_path=repo_path, bytes=data))
        elif path in contract["literal_map"]:
            literal = contract["literal_map"][path]["literal"]
            staged.append(_new_staged(
                path, live_entry, repro, "installer_literal",
                literal=literal, bytes=literal.encode("utf-8")))
        elif path in contract["symlink_map"]:
            staged.append(_new_staged(
                path, live_entry, repro, "contract_symlink"))
        else:  # binary
            build_status, provenance = repro[path]
            name = contract["binary_map"][path]["build_output_name"]
            if build_status != STATUS_EXACT:
                artifact = None
                if build_output_dir is not None:
                    artifact = describe_build_artifact(
                        build_output_dir, name, live_entry)
                detail = (
                    "build_status %s: the binary lacks proven exact source "
                    "reproduction, so it is never staged regardless of any "
                    "build-output artifact" % build_status)
                if artifact == ARTIFACT_MATCH_INELIGIBLE:
                    detail += (
                        " (a file matching the live digest exists in the "
                        "build-output dir but is not eligible)")
                blocked.append(_new_blocker(
                    path, live_entry, REASON_UNRESOLVED, detail,
                    build_status=build_status,
                    source_provenance=provenance,
                    build_output_artifact=artifact))
                continue
            if build_output_dir is None:
                blocked.append(_new_blocker(
                    path, live_entry, REASON_NO_BUILD_OUTPUT,
                    "no --build-output-dir supplied; tracked payload/bin is "
                    "never a fallback",
                    build_status=build_status,
                    source_provenance=provenance))
                continue
            candidate = os.path.join(build_output_dir, name)
            if not os.path.lexists(candidate):
                blocked.append(_new_blocker(
                    path, live_entry, REASON_NO_BUILD_OUTPUT,
                    "no source-built artifact named %s in the build-output "
                    "dir; tracked payload/bin is never a fallback" % name,
                    build_status=build_status,
                    source_provenance=provenance,
                    build_output_artifact=ARTIFACT_ABSENT))
                continue
            if os.path.islink(candidate) or not os.path.isfile(candidate):
                blocked.append(_new_blocker(
                    path, live_entry, REASON_NO_BUILD_OUTPUT,
                    "source-built artifact %s is not a regular file "
                    "(symlinks are refused)" % name,
                    build_status=build_status,
                    source_provenance=provenance,
                    build_output_artifact=ARTIFACT_NOT_REGULAR))
                continue
            with open(candidate, "rb") as handle:
                data = handle.read()
            digest = sha256_bytes(data)
            if digest != live_entry["sha256"] or len(data) != live_entry["size"]:
                blocked.append(_new_blocker(
                    path, live_entry, REASON_BUILD_MISMATCH,
                    "source-built artifact %s does not match the live entry "
                    "(expected sha256 %s size %d, found sha256 %s size %d)"
                    % (name, live_entry["sha256"], live_entry["size"],
                       digest, len(data)),
                    build_status=build_status,
                    source_provenance=provenance,
                    build_output_artifact=ARTIFACT_MISMATCH))
                continue
            staged.append(_new_staged(
                path, live_entry, repro, "build_output",
                build_output_name=name, bytes=data))

    complete = (not blocked
                and len(staged) == contract["closure_count"])
    if complete:
        staged.append(_build_legacy_manifest_entry(
            contract, live, repro, staged))
    return staged, blocked, complete


def _build_legacy_manifest_entry(
        contract: Dict[str, Any],
        live: Dict[str, Dict[str, Any]],
        repro: Dict[str, Tuple[str, str]],
        staged: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Generate the fresh legacy MANIFEST.txt (complete staging only).

    Emitted only when every required binary was staged from a qualifying
    source-built artifact; the stale live MANIFEST.txt bytes are never
    staged (and are refused even if the generated bytes would coincide).
    """
    by_name = {
        os.path.basename(rec["path"]): rec["bytes"]
        for rec in staged
        if rec["source_type"] == "build_output"
    }
    lines = []
    for name in contract["legacy_binaries"]:
        data = by_name[name]
        lines.append("%s  %s\n" % (md5_bytes(data), name))
    content = "".join(lines).encode("ascii")
    live_stale = live[contract["legacy_path"]]
    if sha256_bytes(content) == live_stale["sha256"]:
        raise UsageError(
            "generated legacy MANIFEST.txt equals the stale live "
            "MANIFEST.txt bytes; refusing to stage stale content")
    build_status, provenance = repro[contract["legacy_path"]]
    return {
        "path": contract["legacy_path"],
        "kind": "file",
        "mode": contract["legacy_mode"],
        "mode_str": live_stale["mode_str"],
        "size": len(content),
        "sha256": sha256_bytes(content),
        "target": None,
        "build_status": build_status,
        "source_provenance": provenance,
        "source_type": "legacy_manifest_generated",
        "repo_path": None,
        "build_output_name": None,
        "literal": None,
        "bytes": content,
    }


# ---------------------------------------------------------------------------
# Materialization and verification
# ---------------------------------------------------------------------------

def materialize(staged: List[Dict[str, Any]], rootfs_dir: str) -> None:
    for record in staged:
        parts = record["path"][1:].split("/")
        destination = os.path.join(rootfs_dir, *parts)
        parent = os.path.dirname(destination)
        os.makedirs(parent, exist_ok=True)
        if not is_within(destination, rootfs_dir):
            raise UsageError(
                "materialization escapes the rootfs: %s" % record["path"])
        if record["kind"] == "symlink":
            if os.path.lexists(destination):
                raise UsageError("rootfs path already exists: %s"
                                 % record["path"])
            os.symlink(record["target"], destination)
        else:
            fd, tmp_path = tempfile.mkstemp(
                prefix=".stage-", dir=parent)
            try:
                os.write(fd, record["bytes"])
                os.close(fd)
                os.chmod(tmp_path, record["mode"])
                os.replace(tmp_path, destination)
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


def verify_rootfs(
        rootfs_dir: str,
        staged: List[Dict[str, Any]],
        live: Dict[str, Dict[str, Any]]) -> None:
    """Re-verify every staged byte/mode/target from disk against the public
    live manifest, and assert the tree contains exactly the staged entries
    (nothing extra, nothing missing, no unexpected file types)."""
    planned: Dict[str, Dict[str, Any]] = {
        record["path"]: record for record in staged}
    expected_dirs: Set[str] = set()
    for record in staged:
        parts = record["path"][1:].split("/")
        for index in range(1, len(parts)):
            expected_dirs.add(os.path.join(rootfs_dir, *parts[:index]))
    seen_files: Dict[str, None] = {}
    seen_links: Dict[str, None] = {}
    seen_dirs: Set[str] = set()
    for root, dirnames, filenames in os.walk(rootfs_dir, followlinks=False):
        for name in dirnames + filenames:
            path = os.path.join(root, name)
            rel = os.path.relpath(path, rootfs_dir)
            if os.path.islink(path):
                seen_links[rel] = None
            elif os.path.isdir(path):
                seen_dirs.add(path)
            elif os.path.isfile(path):
                seen_files[rel] = None
            else:
                raise UsageError(
                    "unexpected non-regular entry in the staged rootfs: %s"
                    % rel)
    expected_rel = {record["path"][1:]: None for record in staged}
    if set(seen_files) | set(seen_links) != set(expected_rel):
        raise UsageError(
            "staged rootfs contents differ from the plan "
            "(extra=%s missing=%s)"
            % (sorted((set(seen_files) | set(seen_links)) - set(expected_rel))[:3],
               sorted(set(expected_rel) - set(seen_files) - set(seen_links))[:3]))
    if seen_dirs != expected_dirs:
        raise UsageError(
            "staged rootfs directories differ from the plan "
            "(extra=%s missing=%s)"
            % (sorted(seen_dirs - expected_dirs)[:3],
               sorted(expected_dirs - seen_dirs)[:3]))

    for record in staged:
        path = record["path"]
        parts = path[1:].split("/")
        disk_path = os.path.join(rootfs_dir, *parts)
        if record["source_type"] == "legacy_manifest_generated":
            # generated fresh for a complete staging; the excluded live entry
            # is the STALE listing and must never be compared against it
            # (generation already refuses bytes equal to the stale digest)
            live_entry = None
        else:
            live_entry = live.get(path)
        if record["kind"] == "symlink":
            if not os.path.islink(disk_path):
                raise UsageError("verification: %s is not a symlink" % path)
            target = os.readlink(disk_path)
            if target != record["target"]:
                raise UsageError(
                    "verification: %s target %r != planned %r"
                    % (path, target, record["target"]))
            if live_entry is not None:
                if target != live_entry["target"]:
                    raise UsageError(
                        "verification: %s target disagrees with the live "
                        "manifest" % path)
                if len(target.encode("utf-8")) != live_entry["size"]:
                    raise UsageError(
                        "verification: %s target size disagrees with the "
                        "live manifest" % path)
                if sha256_bytes(target.encode("utf-8")) != live_entry["sha256"]:
                    raise UsageError(
                        "verification: %s target digest disagrees with the "
                        "live manifest" % path)
            continue
        if os.path.islink(disk_path) or not os.path.isfile(disk_path):
            raise UsageError("verification: %s is not a regular file" % path)
        with open(disk_path, "rb") as handle:
            data = handle.read()
        if sha256_bytes(data) != record["sha256"] or len(data) != record["size"]:
            raise UsageError(
                "verification: %s bytes differ from the staged plan" % path)
        mode = stat.S_IMODE(os.lstat(disk_path).st_mode)
        if mode != record["mode"]:
            raise UsageError(
                "verification: %s mode %s != planned %s"
                % (path, oct_mode(mode), oct_mode(record["mode"])))
        if live_entry is not None:
            if sha256_bytes(data) != live_entry["sha256"]:
                raise UsageError(
                    "verification: %s bytes disagree with the live manifest"
                    % path)
            if len(data) != live_entry["size"]:
                raise UsageError(
                    "verification: %s size disagrees with the live manifest"
                    % path)
            if mode != live_entry["mode"]:
                raise UsageError(
                    "verification: %s mode disagrees with the live manifest"
                    % path)


def normalize_rootfs_modes(rootfs_dir: str) -> None:
    """Explicit restrictive directory modes before publish (0755 dirs; file
    modes were already set exactly at materialization)."""
    os.chmod(rootfs_dir, ROOTFS_DIR_MODE)
    for root, dirnames, _filenames in os.walk(rootfs_dir, followlinks=False):
        for name in dirnames:
            path = os.path.join(root, name)
            if os.path.islink(path):
                continue
            os.chmod(path, ROOTFS_DIR_MODE)
    for root, dirnames, _filenames in os.walk(rootfs_dir, followlinks=False):
        for name in dirnames:
            path = os.path.join(root, name)
            if os.path.islink(path):
                continue
            if stat.S_IMODE(os.lstat(path).st_mode) != ROOTFS_DIR_MODE:
                raise UsageError("rootfs directory mode drift: %s" % name)


# ---------------------------------------------------------------------------
# Generated documents
# ---------------------------------------------------------------------------

def _source_block(record: Dict[str, Any]) -> Dict[str, Any]:
    source_type = record["source_type"]
    if source_type == "repo_text":
        return {"type": source_type, "repo_path": record["repo_path"]}
    if source_type == "installer_literal":
        return {"type": source_type, "literal": record["literal"]}
    if source_type == "build_output":
        return {
            "type": source_type,
            "build_output_name": record["build_output_name"],
        }
    if source_type == "legacy_manifest_generated":
        return {"type": source_type}
    return {"type": source_type}


def public_staged_record(record: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "path": record["path"],
        "kind": record["kind"],
        "mode": oct_mode(record["mode"]),
        "live_mode": record["mode_str"],
        "size": record["size"],
        "sha256": record["sha256"],
        "build_status": record["build_status"],
        "source_provenance": record["source_provenance"],
        "source": _source_block(record),
    }
    if record["kind"] == "symlink":
        out["target"] = record["target"]
    return out


def public_blocker_record(record: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "path": record["path"],
        "kind": record["kind"],
        "reason_code": record["reason_code"],
        "detail": record["detail"],
    }
    for key in ("build_status", "source_provenance", "build_output_artifact"):
        if record.get(key) is not None:
            out[key] = record[key]
    return out


def build_staging_manifest(
        contract: Dict[str, Any],
        staged: List[Dict[str, Any]],
        blocked: List[Dict[str, Any]],
        complete: bool,
        rootfs_published: bool,
        allow_partial: bool,
        inputs: Dict[str, Any]) -> Dict[str, Any]:
    legacy_emitted = any(
        record["source_type"] == "legacy_manifest_generated"
        for record in staged)
    return {
        "schema": SCHEMA_STAGING_MANIFEST,
        "snapshot_id": SNAPSHOT_ID,
        "canonical": False,
        "notice": (NOTICE_MANIFEST_PUBLISHED if rootfs_published
                   else NOTICE_MANIFEST_FAIL_CLOSED),
        "tool": {"name": TOOL_NAME, "version": TOOL_VERSION},
        "complete": complete,
        "partial": not complete,
        "rootfs_published": rootfs_published,
        "allow_partial": allow_partial,
        "legacy_manifest_emitted": legacy_emitted,
        "generated_from_evidence_utc": inputs["generated_from_evidence_utc"],
        "inputs": {
            "live_manifest_sha256": inputs["live_manifest_sha256"],
            "reproducibility_status_sha256":
                inputs["reproducibility_status_sha256"],
            "staging_contract_sha256": inputs["staging_contract_sha256"],
            "repo_text_sources": REPO_SOURCE_LABEL,
            "build_output_dir": {
                "provided": inputs["build_output_provided"],
                "label": BUILD_OUTPUT_LABEL,
            },
        },
        "closure_entry_count": contract["closure_count"],
        "staged_entry_count": len(staged),
        "staged": [public_staged_record(r) for r in staged],
        "omitted_count": len(blocked),
        "omitted": [
            {"path": r["path"], "reason_code": r["reason_code"]}
            for r in blocked],
        "excluded_live_paths": contract["excluded"],
    }


def build_blockers_doc(
        contract: Dict[str, Any],
        blocked: List[Dict[str, Any]],
        complete: bool,
        rootfs_published: bool,
        allow_partial: bool,
        inherited: List[str],
        inputs: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "schema": SCHEMA_STAGING_BLOCKERS,
        "snapshot_id": SNAPSHOT_ID,
        "canonical": False,
        "notice": NOTICE_BLOCKERS,
        "tool": {"name": TOOL_NAME, "version": TOOL_VERSION},
        "complete": complete,
        "rootfs_published": rootfs_published,
        "allow_partial": allow_partial,
        "policy": contract["blockers_policy"],
        "no_fallback_policy": contract["no_fallback_policy"],
        "omitted_count": len(blocked),
        "omitted": [public_blocker_record(r) for r in blocked],
        "excluded_live_paths": contract["excluded"],
        "inherited_from_reproducibility_status": inherited,
        "inputs": {
            "live_manifest_sha256": inputs["live_manifest_sha256"],
            "reproducibility_status_sha256":
                inputs["reproducibility_status_sha256"],
            "staging_contract_sha256": inputs["staging_contract_sha256"],
        },
    }


def build_attestation(
        contract: Dict[str, Any],
        staged: List[Dict[str, Any]],
        blocked: List[Dict[str, Any]],
        complete: bool,
        inputs: Dict[str, Any]) -> Dict[str, Any]:
    by_type: Dict[str, int] = {}
    for record in staged:
        by_type[record["source_type"]] = by_type.get(record["source_type"], 0) + 1
    by_reason: Dict[str, int] = {}
    for record in blocked:
        by_reason[record["reason_code"]] = (
            by_reason.get(record["reason_code"], 0) + 1)
    legacy_emitted = any(
        record["source_type"] == "legacy_manifest_generated"
        for record in staged)
    return {
        "schema": SCHEMA_STAGING_ATTESTATION,
        "snapshot_id": SNAPSHOT_ID,
        "canonical": False,
        "complete": complete,
        "partial": not complete,
        "notice": NOTICE_ATTESTATION,
        "tool": {"name": TOOL_NAME, "version": TOOL_VERSION},
        "attestation": {
            "verified_against_live_manifest": (
                "every staged file's bytes, size and mode and every staged "
                "symlink's target, target size and target digest were "
                "re-verified from disk against public-payload-manifest/1 "
                "before publish, and the staged tree was asserted to contain "
                "exactly the staged entries"),
            "binary_staging_policy": (
                "a live binary is staged only when its build_status is "
                "EXACT_SOURCE_REPRODUCIBLE and a regular file in the "
                "caller-supplied source-built output dir matches the live "
                "SHA-256 and size"),
            "no_fallback": (
                "the repository payload/bin tree is never read and never a "
                "fallback; a binary without a qualifying source-built "
                "artifact is omitted with a blocker"),
            "stale_live_manifest_never_staged": True,
            "legacy_manifest": {
                "emitted": legacy_emitted,
                "policy": contract["legacy_emit_policy"],
            },
            "fail_closed": (
                "without --allow-partial an incomplete staging publishes no "
                "rootfs (exit 4); a partial rootfs is published only under "
                "--allow-partial (exit 3)"),
        },
        "staged_summary": {
            "entry_count": len(staged),
            "by_source_type": dict(sorted(by_type.items())),
        },
        "omitted_summary": {
            "count": len(blocked),
            "by_reason_code": dict(sorted(by_reason.items())),
        },
        "inputs": {
            "live_manifest_sha256": inputs["live_manifest_sha256"],
            "reproducibility_status_sha256":
                inputs["reproducibility_status_sha256"],
            "staging_contract_sha256": inputs["staging_contract_sha256"],
            "repo_text_sources": REPO_SOURCE_LABEL,
            "build_output_dir": {
                "provided": inputs["build_output_provided"],
                "label": BUILD_OUTPUT_LABEL,
            },
        },
        "exit_codes": contract["exit_codes"],
        "validation": {"owner": "security verifier + Oracle Gate 2"},
    }


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def stage(
        live_manifest_path: str,
        repro_status_path: str,
        contract_path: str,
        repo_root: str,
        build_output_dir: Optional[str],
        out_dir: str,
        allow_partial: bool,
) -> Tuple[int, Dict[str, str]]:
    """Run the full staging; returns (exit code, {name: absolute path})."""
    live_obj, live_sha = load_json_input(live_manifest_path, "live manifest")
    repro_obj, repro_sha = load_json_input(
        repro_status_path, "reproducibility status")
    contract_obj, contract_sha = load_json_input(
        contract_path, "staging contract")

    live = validate_live_manifest(live_obj)
    repro = validate_repro_status(repro_obj, set(live))
    contract = validate_contract(contract_obj, live, repro)

    repo_root = os.path.abspath(repo_root)
    if not os.path.isdir(repo_root):
        raise UsageError("repo root not found: %s" % repo_root)
    out_lex, out_real = dir_path_pair(out_dir, "out-dir")
    check_out_dir_safety(out_lex, out_real, repo_root)

    build_lex: Optional[str] = None
    if build_output_dir is not None:
        build_lex, build_real = dir_path_pair(
            build_output_dir, "build-output-dir")
        check_build_output_safety(
            build_lex, build_real, out_lex, out_real, repo_root)
        if not os.path.isdir(build_lex):
            raise UsageError(
                "build-output-dir not found: %s" % build_output_dir)

    staged, blocked, complete = plan_staging(
        contract, live, repro, repo_root, build_lex)

    inputs = {
        "live_manifest_sha256": live_sha,
        "reproducibility_status_sha256": repro_sha,
        "staging_contract_sha256": contract_sha,
        "build_output_provided": build_lex is not None,
        "generated_from_evidence_utc":
            (repro_obj.get("generated") or {}).get(
                "generated_from_evidence_utc"),
    }
    inherited = [
        str(item) for item in (repro_obj.get("blockers") or [])
        if isinstance(item, str)]

    if complete or allow_partial:
        if os.path.lexists(out_lex) and not os.path.isdir(out_lex):
            raise UsageError("out-dir exists and is not a directory")
        os.makedirs(out_lex, exist_ok=True)
        tmp_rootfs = tempfile.mkdtemp(prefix=".staging-tmp-", dir=out_lex)
        try:
            materialize(staged, tmp_rootfs)
            verify_rootfs(tmp_rootfs, staged, live)
            normalize_rootfs_modes(tmp_rootfs)
            rootfs_final = os.path.join(out_lex, ROOTFS_DIR_NAME)
            if os.path.lexists(rootfs_final):
                if not (os.path.isdir(rootfs_final)
                        and not os.path.islink(rootfs_final)):
                    raise UsageError(
                        "out-dir/%s exists and is not a directory"
                        % ROOTFS_DIR_NAME)
                backup = tempfile.mkdtemp(
                    prefix=".staging-old-", dir=out_lex)
                os.replace(rootfs_final, backup)
                os.replace(tmp_rootfs, rootfs_final)
                shutil.rmtree(backup)
            else:
                os.replace(tmp_rootfs, rootfs_final)
        except BaseException:
            shutil.rmtree(tmp_rootfs, ignore_errors=True)
            raise
        written = {
            ROOTFS_DIR_NAME: rootfs_final,
            MANIFEST_NAME: os.path.join(out_lex, MANIFEST_NAME),
            BLOCKERS_NAME: os.path.join(out_lex, BLOCKERS_NAME),
            ATTESTATION_NAME: os.path.join(out_lex, ATTESTATION_NAME),
        }
        manifest_doc = build_staging_manifest(
            contract, staged, blocked, complete,
            rootfs_published=True, allow_partial=allow_partial, inputs=inputs)
        blockers_doc = build_blockers_doc(
            contract, blocked, complete,
            rootfs_published=True, allow_partial=allow_partial,
            inherited=inherited, inputs=inputs)
        attestation_doc = build_attestation(
            contract, staged, blocked, complete, inputs=inputs)
        for name, doc in ((MANIFEST_NAME, manifest_doc),
                          (BLOCKERS_NAME, blockers_doc),
                          (ATTESTATION_NAME, attestation_doc)):
            atomic_write_bytes(written[name], canonical_json_bytes(doc))
        code = EXIT_COMPLETE if complete else EXIT_PARTIAL
        return code, written

    # fail closed: publish NO rootfs; diagnostics only
    if os.path.lexists(out_lex) and not os.path.isdir(out_lex):
        raise UsageError("out-dir exists and is not a directory")
    os.makedirs(out_lex, exist_ok=True)
    manifest_doc = build_staging_manifest(
        contract, staged, blocked, complete,
        rootfs_published=False, allow_partial=False, inputs=inputs)
    blockers_doc = build_blockers_doc(
        contract, blocked, complete,
        rootfs_published=False, allow_partial=False,
        inherited=inherited, inputs=inputs)
    written = {
        MANIFEST_NAME: os.path.join(out_lex, MANIFEST_NAME),
        BLOCKERS_NAME: os.path.join(out_lex, BLOCKERS_NAME),
    }
    for name, doc in ((MANIFEST_NAME, manifest_doc),
                      (BLOCKERS_NAME, blockers_doc)):
        atomic_write_bytes(written[name], canonical_json_bytes(doc))
    return EXIT_FAIL_CLOSED, written


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog=TOOL_NAME,
        description="Deterministic staging builder for %s" % SNAPSHOT_ID)
    parser.add_argument(
        "--live-manifest",
        default=os.environ.get(LIVE_MANIFEST_ENV) or DEFAULT_LIVE_MANIFEST,
        help="public live payload manifest (env: %s)" % LIVE_MANIFEST_ENV)
    parser.add_argument(
        "--repro-status",
        default=os.environ.get(REPRO_STATUS_ENV) or DEFAULT_REPRO_STATUS,
        help="reproducibility status record (env: %s)" % REPRO_STATUS_ENV)
    parser.add_argument(
        "--staging-contract",
        default=os.environ.get(CONTRACT_ENV) or DEFAULT_CONTRACT,
        help="staging contract (env: %s)" % CONTRACT_ENV)
    parser.add_argument(
        "--repo-root",
        default=os.environ.get(REPO_ROOT_ENV) or REPO_ROOT,
        help="repository root holding the exact text sources "
             "(env: %s)" % REPO_ROOT_ENV)
    parser.add_argument(
        "--build-output-dir",
        default=os.environ.get(BUILD_OUTPUT_ENV),
        help="explicit directory of fresh source-built binaries; the ONLY "
             "binary source (tracked payload/bin is never a fallback) "
             "(env: %s)" % BUILD_OUTPUT_ENV)
    parser.add_argument(
        "--out-dir", required=True,
        help="caller output directory (rootfs + manifests); the tool writes "
             "nowhere else")
    parser.add_argument(
        "--allow-partial", action="store_true",
        help="publish an incomplete (partial) staging; without this flag an "
             "incomplete staging fails closed and publishes no rootfs")
    args = parser.parse_args(argv)

    try:
        code, written = stage(
            args.live_manifest, args.repro_status, args.staging_contract,
            args.repo_root, args.build_output_dir, args.out_dir,
            args.allow_partial)
    except UsageError as exc:
        print("%s: error: %s" % (TOOL_NAME, exc), file=sys.stderr)
        return EXIT_USAGE
    for name in (ROOTFS_DIR_NAME, MANIFEST_NAME, BLOCKERS_NAME,
                 ATTESTATION_NAME):
        if name in written:
            print("%s: wrote %s" % (TOOL_NAME, written[name]))
    staged = written.get(MANIFEST_NAME)
    if staged:
        with open(staged, "r", encoding="utf-8") as handle:
            summary = json.load(handle)
        print("%s: staged %d of %d closure entries (%d blocker(s), "
              "complete=%s, rootfs_published=%s)"
              % (TOOL_NAME, summary["staged_entry_count"],
                 summary["closure_entry_count"], summary["omitted_count"],
                 summary["complete"], summary["rootfs_published"]))
    return code


if __name__ == "__main__":
    sys.exit(main())
