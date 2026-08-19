#!/usr/bin/env python3
"""Read-only inventory collector for the immutable box snapshot (reconciliation).

Collects a deterministic, content-addressed local snapshot of a hard-coded,
closed allowlist of paths on a remote box over SSH, using strictly read-only
remote commands.

HARD SAFETY CONTRACT (enforced in code before every subprocess invocation):
  * Transport is `ssh` only.  No HTTP, no scp/sftp/ftp, no arbitrary ports.
  * Remote commands are restricted to a closed grammar: `ls`, `stat`,
    `readlink`, `md5sum`, and `cat -- '<literal validated path>'`.  Nothing
    else can ever be sent (see assert_safe_remote_command).
  * No remote writes of any kind: no redirects/pipes (no `>`, `>>`, `|`,
    `;`, `&&`, backticks, `$(...)`), no mkdir/chmod/touch/rm/mv/cp/install/
    service/kill/reboot/sync, no interpreters, no editors.
  * Every remote path is validated against the hard-coded closed allowlist
    and a safe-character charset before it is ever placed in a command.
  * ssh is invoked with BatchMode=yes, IdentitiesOnly=yes,
    StrictHostKeyChecking=yes (fail closed on unknown host keys), an
    explicit identity, and a pinned config (-F).  No pseudo-terminal (-T).
  * Remote file bytes are streamed straight into local SHA-256 objects and
    are never printed or logged; only digests and byte counts are recorded.
  * The collector writes only to the caller-provided LOCAL --out-dir, using
    atomic writes and restrictive permissions.

BusyBox grounding: sha256sum/stat/readlink may be absent on old BusyBox.
Hashing therefore happens LOCALLY over streamed `cat` output.  `stat` and
`md5sum` are optional cross-checks; `ls -ldn` (with fallbacks) is the
metadata authority.  ls output is accepted in exactly two tightly
constrained forms - GNU/BusyBox lines WITH a 3-token date column, and
BusyBox no-date lines (mode nlink owner group size rest, rest anchored
to '/'); lines matching both forms or neither are rejected, and mtime_raw
is null for the no-date form (epoch mtime comes only from optional stat).
The collector fails closed on metadata ambiguity.

RESIDUAL TOCTOU (documented, accepted): metadata (ls/stat/md5sum) and
content (cat) are separate read-only SSH operations, so a path could in
principle change between them.  This collector assumes the box is
immutable for the duration of a run (no concurrent change).  The ls-vs-
stat size cross-check and the remote-vs-local MD5 cross-check detect
most divergences and fail closed, but an attacker-controlled same-size
swap between the md5sum and cat invocations cannot be cryptographically
eliminated without introducing new remote verbs, which this contract
forbids.  This is evidence-level mitigation only; consumers of the
snapshot must treat it as a documented residual risk.

Exit codes: 0 = complete collection; 1 = collection ran but is incomplete
(entry errors, unsafe names, type mismatches, missing expected symlinks);
2 = usage / configuration / safety-violation / fatal local failure.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import re
import select as _select
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any, Dict, List, Optional, Set, Tuple, cast

# ---------------------------------------------------------------------------
# Constants and the closed allowlist
# ---------------------------------------------------------------------------

COLLECTOR_NAME = "collect_box_snapshot"
COLLECTOR_VERSION = "1.0.0"

MANIFEST_SCHEMA = "box-snapshot-manifest/1"
RECORD_SCHEMA = "box-snapshot-record/1"
PLAN_SCHEMA = "box-snapshot-plan/1"

#: Directory whose direct children are enumerated dynamically.  Only regular
#: files and symlinks directly under this directory are inventoried.
DYNAMIC_DIR = "/data/codex/bin"

#: Fixed allowlist: paths collected as regular files (content is streamed
#: via remote `cat` and hashed locally).
FIXED_FILE_PATHS = frozenset({
    "/data/codex/init.sh",
    "/data/codex/recovery_ap.sh",
    "/data/codex/offline_egress_guard.sh",
    "/etc/init.d/rcS.local",
    "/usr/sbin/dropbear",
    "/usr/sbin/dropbearkey",
    "/opt/luaworks/tasks/connectserver/netservicestarter.lua",
    "/pkg/codexactivity/codexactivity.lua",
    "/pkg/codexactivity/manifest.json",
    "/pkg/codexmqtt/codexmqtt.lua",
    "/pkg/codexmqtt/manifest.json",
})

#: Fixed allowlist: paths expected to be symlinks.  Symlink-class paths are
#: NEVER followed for object collection; only the target string is recorded
#: and hashed.  Two of these live inside DYNAMIC_DIR and are therefore also
#: covered by enumeration.
EXPECTED_SYMLINK_PATHS = frozenset({
    "/data/codex/bin/dropbear",
    "/data/codex/bin/dropbearkey",
    "/cache/bin/bthid_keyboard",
})

#: All other paths are excluded.  The union of the sets above plus validated
#: children of DYNAMIC_DIR is the complete invocable universe.
MAX_DYNAMIC_ENTRIES_DEFAULT = 256

# Component charset: letters, digits, '.', '_', '+', '-'; must start with an
# alphanumeric.  Rejects '.', '..', leading-dash option injection, spaces,
# shell metacharacters, unicode, and control characters.
SAFE_COMPONENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$")
#: Hidden variant (leading dot, then alphanumeric): a BENIGN dotfile basename.
#: Such names are classified "hidden" (excluded by default glob semantics,
#: collected only with --include-hidden); they are never classified "unsafe".
SAFE_HIDDEN_COMPONENT_RE = re.compile(r"^\.[A-Za-z0-9][A-Za-z0-9._+-]{0,253}$")


def classify_dynamic_name(name: str) -> Tuple[str, str]:
    """Classify an enumerated basename as 'accept', 'hidden', or 'unsafe'.

    'hidden' is a benign dotfile (safe charset, leading dot): excluded by
    default, includable via --include-hidden.  'unsafe' fails every safe
    charset (dotfiles with metacharacters, '..', leading dashes, spaces,
    unicode, control characters, ...): rejected and reported, fail closed.
    """
    if SAFE_COMPONENT_RE.match(name):
        return "accept", name
    if SAFE_HIDDEN_COMPONENT_RE.match(name):
        return "hidden", name
    return "unsafe", name


#: Characters that may never appear anywhere in a remote command string.
#: Single quotes are excluded from this set because they are the deliberate
#: delimiters produced by the command builders and constrained by the
#: grammar checks in assert_safe_remote_command.
FORBIDDEN_COMMAND_CHARS = ";|&><$`\\\"\n\r\t\x00\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c\x0e\x0f"

#: stat format string (pinned exactly; the only format the guard accepts).
STAT_FMT = "%s %Y %u %g %h"

#: Secondary composite grammar.  A command matches only as
#: <approved head> + " " + '<absolute path with no quotes>'  --  i.e. after
#: the head there is EXACTLY ONE separator space before the quoted path
#: (the `--` separator, when present, is part of the head).  This fixes the
#: old regex, which consumed the single separator space and then demanded a
#: second one, rejecting every no-dash BusyBox fallback form.
_STAT_HEAD = re.escape("stat -c '" + STAT_FMT + "'")
REMOTE_COMMAND_RE = re.compile(
    r"\A(?:"
    r"ls(?: -ldn| -ld| -1a)(?: --)?"
    r"|" + _STAT_HEAD + r"(?: --)?"
    r"|(?:readlink|md5sum)(?: --)?"
    r"|cat --"
    r")"
    r" '/[^']*'\Z"
)

#: Primary structural grammar (per-verb head forms), enforced by
#: assert_safe_remote_command together with REMOTE_COMMAND_RE.
_VERB_HEAD_RES: Dict[str, re.Pattern[str]] = {
    "ls": re.compile(r"\Als(?: -ldn| -ld| -1a)(?: --)?\Z"),
    "stat": re.compile(_STAT_HEAD + r"(?: --)?\Z"),
    "readlink": re.compile(r"\Areadlink(?: --)?\Z"),
    "md5sum": re.compile(r"\Amd5sum(?: --)?\Z"),
    "cat": re.compile(r"\Acat --\Z"),
}

#: Human-readable grammar documentation embedded in the plan and record.
REMOTE_GRAMMAR_DOC = (
    "closed grammar (all forms; P = single-quoted absolute allowlisted "
    "path preceded by exactly one separator space): "
    "\"ls -ldn -- 'P'\" | \"ls -ldn 'P'\" | \"ls -ld -- 'P'\" | \"ls -ld 'P'\" | "
    "\"ls -1a -- 'P'\" | \"ls -1a 'P'\" | \"stat -c '%s %Y %u %g %h' -- 'P'\" | "
    "\"stat -c '%s %Y %u %g %h' 'P'\" | \"readlink -- 'P'\" | \"readlink 'P'\" | "
    "\"md5sum -- 'P'\" | \"md5sum 'P'\" | \"cat -- 'P'\"; every other command "
    "(other verbs, flags, extra args, separators, quoting) is rejected before "
    "any subprocess invocation"
)

#: `stat -c '%s %Y %u %g %h'` output parser (size mtime uid gid nlink).
STAT_LINE_RE = re.compile(r"^([0-9]+) (-?[0-9]+) ([0-9]+) ([0-9]+) ([0-9]+)$")

MD5SUM_LINE_RE = re.compile(r"^([0-9a-f]{32})[ \t]+[ *]?(.+)$")

#: `ls -ldn` / `ls -ld` single-line parser, date form (GNU and BusyBox with
#: a date column).  date is captured raw (3 whitespace-separated tokens);
#: epoch mtime comes only from optional stat, never guessed from ls.
LS_LINE_RE = re.compile(
    r"^(?P<mode>[bcdlps-][-rwxSsTt+]{9}[.+@]?)"
    r"[ \t]+(?P<nlink>[0-9]+)"
    r"[ \t]+(?P<owner>[^ \t/]+)"
    r"[ \t]+(?P<group>[^ \t/]+)"
    r"[ \t]+(?P<size>[0-9]+)"
    r"[ \t]+(?P<date>\S+[ \t]+\S+[ \t]+\S+)"
    r"[ \t]+(?P<rest>\S.*)$"
)

#: `ls -ldn` / `ls -ld` single-line parser, BusyBox NO-DATE form (observed
#: on the box): mode nlink owner group size rest, with NO date column.  The
#: rest group is anchored to a leading '/' so that date-form lines can
#: never satisfy this pattern (their first post-size token is a month
#: name).  A line matching BOTH forms is ambiguous and rejected.  For this
#: form mtime_raw is None; epoch mtime comes only from optional stat.
LS_LINE_NO_DATE_RE = re.compile(
    r"^(?P<mode>[bcdlps-][-rwxSsTt+]{9}[.+@]?)"
    r"[ \t]+(?P<nlink>[0-9]+)"
    r"[ \t]+(?P<owner>[^ \t/]+)"
    r"[ \t]+(?P<group>[^ \t/]+)"
    r"[ \t]+(?P<size>[0-9]+)"
    r"[ \t]+(?P<rest>/\S.*)$"
)

FILE_TYPE_BY_MODE_CHAR = {
    "-": "regular",
    "l": "symlink",
    "d": "directory",
    "c": "char_device",
    "b": "block_device",
    "p": "fifo",
    "s": "socket",
}

HOSTNAME_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$")
USERNAME_RE = re.compile(r"^[a-z_][a-z0-9._-]{0,31}$")

TIMESTAMP_FORMAT = "%Y-%m-%dT%H:%M:%SZ"

REQUIRED_SSH_OPTIONS = ("BatchMode=yes", "IdentitiesOnly=yes", "StrictHostKeyChecking=yes")

# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class SafetyViolation(Exception):
    """A command/path/config violates the hard safety contract.  Fatal (exit 2)."""


class UsageError(Exception):
    """Bad CLI usage or configuration.  Fatal (exit 2)."""


class RemoteInvocationError(Exception):
    """An ssh invocation failed, timed out, or returned unusable output.

    Caught per-entry; the entry is failed (fail closed) but collection of
    the remaining allowlisted entries continues.
    """


class MetadataViolation(Exception):
    """Remote metadata was ambiguous or self-contradictory (fail closed)."""


class CollectorFatal(Exception):
    """Unrecoverable local problem (missing ssh binary, unwritable out-dir)."""


# ---------------------------------------------------------------------------
# Path / basename validation
# ---------------------------------------------------------------------------


def validate_basename(name: str, *, allow_hidden: bool = False) -> str:
    """Validate a single path component against safe-character constraints."""
    if not isinstance(name, str) or not name or len(name) > 255:
        raise SafetyViolation("unsafe basename: %r" % (name,))
    if name in (".", ".."):
        raise SafetyViolation("unsafe basename: %r is a relative component" % (name,))
    if SAFE_COMPONENT_RE.match(name):
        return name
    if allow_hidden and SAFE_HIDDEN_COMPONENT_RE.match(name):
        return name
    raise SafetyViolation("unsafe basename: %r fails safe charset" % (name,))


def validate_abs_path(path: str, *, allow_hidden_components: bool = False) -> str:
    """Validate an absolute path whose components satisfy safe constraints."""
    if not isinstance(path, str) or len(path) > 4096:
        raise SafetyViolation("unsafe path: %r" % (path,))
    if not path.startswith("/"):
        raise SafetyViolation("unsafe path (not absolute): %r" % (path,))
    if path.endswith("/") or "//" in path:
        raise SafetyViolation("unsafe path (empty component): %r" % (path,))
    for comp in path.split("/")[1:]:
        try:
            validate_basename(comp, allow_hidden=allow_hidden_components)
        except SafetyViolation as exc:
            raise SafetyViolation("unsafe path %r: %s" % (path, exc)) from exc
    return path


# ---------------------------------------------------------------------------
# Remote command builders and the guard
# ---------------------------------------------------------------------------


def _q(path: str) -> str:
    """Quote an already-validated path literal for the remote shell."""
    return "'" + path + "'"


def cmd_enumerate() -> str:
    return "ls -1a -- " + _q(DYNAMIC_DIR)


def cmd_enumerate_nodash() -> str:
    return "ls -1a " + _q(DYNAMIC_DIR)


def cmd_ls(p: str) -> str:
    return "ls -ldn -- " + _q(p)


def cmd_ls_nodash(p: str) -> str:
    return "ls -ldn " + _q(p)


def cmd_ls_names(p: str) -> str:
    return "ls -ld -- " + _q(p)


def cmd_ls_names_nodash(p: str) -> str:
    return "ls -ld " + _q(p)


def cmd_stat(p: str) -> str:
    return "stat -c '" + STAT_FMT + "' -- " + _q(p)


def cmd_stat_nodash(p: str) -> str:
    return "stat -c '" + STAT_FMT + "' " + _q(p)


#: Real allowlisted paths used for guard-valid fallback examples in the plan:
#: a fixed file for ls/stat/md5sum and an expected symlink for readlink.
FALLBACK_EXAMPLE = sorted(FIXED_FILE_PATHS)[0]
FALLBACK_EXAMPLE_SYMLINK = sorted(EXPECTED_SYMLINK_PATHS)[0]


def cmd_readlink(p: str) -> str:
    return "readlink -- " + _q(p)


def cmd_readlink_nodash(p: str) -> str:
    return "readlink " + _q(p)


def cmd_md5sum(p: str) -> str:
    return "md5sum -- " + _q(p)


def cmd_md5sum_nodash(p: str) -> str:
    return "md5sum " + _q(p)


def cmd_cat(p: str) -> str:
    return "cat -- " + _q(p)


def assert_safe_remote_command(cmd: str, allowed: Dict[str, Set[str]],
                               *, allow_hidden_components: bool = False) -> Tuple[str, str]:
    """Assert that `cmd` satisfies the complete safety contract.

    `allowed` maps command family -> set of invocable paths for that family.
    Families: "ls", "stat", "readlink", "md5sum", "cat".  Returns
    (verb, path) on success; raises SafetyViolation otherwise.

    `allow_hidden_components` exists ONLY for dynamically enumerated benign
    dotfiles when the operator passed --include-hidden; hidden components
    remain charset-locked (dot + alphanumeric + [._+-]), and quotes,
    metacharacters, and control characters stay banned in all modes.

    Structure enforced (primary, structural parse):
        <verb>[approved flags][ --] <single space> '<absolute path>'
    i.e. exactly ONE separator space between the head (verb/flags/`--`) and
    the single-quoted path literal.  Both primary and secondary checks
    (REMOTE_COMMAND_RE) must pass; both are closed grammars with no
    metacharacter, extra-argument, or unapproved-verb escape.
    """
    if not isinstance(cmd, str) or not cmd or len(cmd) > 512:
        raise SafetyViolation("remote command is not a bounded string: %r" % (cmd,))
    for ch in FORBIDDEN_COMMAND_CHARS:
        if ch in cmd:
            raise SafetyViolation("remote command contains forbidden character %r: %r" % (ch, cmd))
    # Secondary closed-grammar check.
    if not REMOTE_COMMAND_RE.fullmatch(cmd):
        raise SafetyViolation("remote command does not match the closed grammar: %r" % (cmd,))
    # Primary structural parse: the command must END with a quoted literal,
    # and the quote pair delimiting it is the LAST pair in the string (for
    # `stat` the earlier pair belongs to the pinned format string).
    if len(cmd) < 4 or not cmd.endswith("'"):
        raise SafetyViolation("remote command lacks a quoted path literal: %r" % (cmd,))
    rquote = len(cmd) - 1
    try:
        lquote = cmd.rindex("'", 0, rquote)
    except ValueError:
        raise SafetyViolation("remote command lacks a quoted path literal: %r" % (cmd,)) from None
    path = cmd[lquote + 1:rquote]
    head = cmd[:lquote]
    # Exactly one separator space between head and quoted path (no doubles,
    # no tabs, no leading space: those fail the head regex below anyway).
    if not head.endswith(" ") or head.endswith("  "):
        raise SafetyViolation(
            "remote command must have exactly one separator space before the path: %r" % (cmd,)
        )
    head = head[:-1]
    verb = head.split(" ", 1)[0]
    head_re = _VERB_HEAD_RES.get(verb)
    if head_re is None or not head_re.fullmatch(head):
        raise SafetyViolation(
            "remote command head %r is not an approved form for verb %r" % (head, verb)
        )
    # Path must satisfy the safe charset...
    validate_abs_path(path, allow_hidden_components=allow_hidden_components)
    # ...and must be a member of the closed, family-specific allowlist.
    family_set = allowed.get(verb)
    if family_set is None or path not in family_set:
        raise SafetyViolation(
            "path %r is not on the closed allowlist for remote %s" % (path, verb)
        )
    return verb, path


# ---------------------------------------------------------------------------
# SSH configuration and argv construction
# ---------------------------------------------------------------------------


class SshConfig:
    """Validated, pinned ssh invocation parameters."""

    __slots__ = (
        "host", "user", "port", "identity", "known_hosts", "ssh_binary",
        "ssh_config", "connect_timeout", "ssh_timeout", "cat_timeout",
    )

    def __init__(
        self,
        host: str,
        user: str,
        port: int,
        identity: str,
        known_hosts: Optional[str],
        ssh_binary: str,
        ssh_config: str,
        connect_timeout: int,
        ssh_timeout: int,
        cat_timeout: int,
    ) -> None:
        self.host = host
        self.user = user
        self.port = port
        self.identity = identity
        self.known_hosts = known_hosts
        self.ssh_binary = ssh_binary
        self.ssh_config = ssh_config
        self.connect_timeout = connect_timeout
        self.ssh_timeout = ssh_timeout
        self.cat_timeout = cat_timeout

    @property
    def destination(self) -> str:
        return "%s@%s" % (self.user, self.host)


def _validate_identity_path(identity: str, *, must_exist: bool) -> str:
    if not isinstance(identity, str) or not identity:
        raise UsageError("--identity is required")
    if any(ord(ch) < 0x20 or ch == "\x7f" for ch in identity):
        raise UsageError("--identity contains control characters")
    expanded = os.path.expanduser(identity)
    if must_exist and not os.path.isfile(expanded):
        raise UsageError("identity file does not exist: %s" % (expanded,))
    return expanded


def build_ssh_config(args: argparse.Namespace) -> SshConfig:
    """Validate CLI parameters into a pinned SshConfig (fail closed)."""
    if not args.host or not HOSTNAME_RE.match(args.host):
        raise UsageError("invalid --host (hostname/IPv4 charset only): %r" % (args.host,))
    if not args.user or not USERNAME_RE.match(args.user):
        raise UsageError("invalid --user charset: %r" % (args.user,))
    if not (1 <= int(args.port) <= 65535):
        raise UsageError("invalid --port: %r" % (args.port,))
    if int(args.connect_timeout) < 1 or int(args.ssh_timeout) < 1 or int(args.cat_timeout) < 1:
        raise UsageError("timeouts must be >= 1 second")

    identity = _validate_identity_path(args.identity, must_exist=not args.dry_run)

    known_hosts: Optional[str] = None
    if args.known_hosts:
        known_hosts = os.path.abspath(os.path.expanduser(args.known_hosts))
        if not os.path.isfile(known_hosts):
            raise UsageError("--known-hosts file does not exist: %s" % (known_hosts,))

    ssh_config = args.ssh_config or "/dev/null"
    if ssh_config != "/dev/null":
        ssh_config = os.path.abspath(os.path.expanduser(ssh_config))
        if not os.path.isfile(ssh_config):
            raise UsageError("--ssh-config file does not exist: %s" % (ssh_config,))

    raw_binary = args.ssh_binary or "ssh"
    if os.path.basename(raw_binary) != "ssh":
        raise UsageError("--ssh-binary must resolve to a binary named 'ssh'")
    resolved = shutil.which(raw_binary)
    if resolved is None:
        raise UsageError("ssh binary not found on PATH: %r" % (raw_binary,))
    if os.path.basename(resolved) != "ssh":
        raise UsageError("resolved ssh binary must be named 'ssh': %r" % (resolved,))

    return SshConfig(
        host=args.host,
        user=args.user,
        port=int(args.port),
        identity=identity,
        known_hosts=known_hosts,
        ssh_binary=resolved,
        ssh_config=ssh_config,
        connect_timeout=int(args.connect_timeout),
        ssh_timeout=int(args.ssh_timeout),
        cat_timeout=int(args.cat_timeout),
    )


def ssh_argv(cfg: SshConfig, remote_command: str) -> List[str]:
    """Deterministic ssh argv with pinned options.  Never a shell string."""
    argv: List[str] = [
        cfg.ssh_binary,
        "-o", "BatchMode=yes",
        "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=yes",
        "-o", "ConnectTimeout=%d" % (cfg.connect_timeout,),
        "-F", cfg.ssh_config,
    ]
    if cfg.known_hosts:
        argv += ["-o", "UserKnownHostsFile=" + cfg.known_hosts]
    argv += [
        "-i", cfg.identity,
        "-p", str(cfg.port),
        "-T",
        cfg.destination,
        remote_command,
    ]
    return argv


# ---------------------------------------------------------------------------
# Output parsing (strict, fail closed)
# ---------------------------------------------------------------------------


def parse_ls_line(line: str, expected_path: str) -> Dict[str, object]:
    """Parse one `ls -ldn`/`ls -ld` line for expected_path.

    Accepts exactly two tightly constrained forms:
      * date form:    mode nlink owner group size <3 date tokens> rest
      * no-date form: mode nlink owner group size rest, rest anchored to '/'
    A line matching BOTH forms is rejected as ambiguous; a line matching
    neither is unparseable.  mtime_raw is None for the no-date form (epoch
    mtime comes only from optional stat).  Raises MetadataViolation on any
    ambiguity, including a `rest` field that does not anchor to
    expected_path and an expected_path containing whitespace (all allowlist
    paths are whitespace-free, so this is pure fail-closed defense).
    """
    if any(ch.isspace() for ch in expected_path):
        raise MetadataViolation(
            "expected path contains whitespace: %r" % (expected_path,)
        )
    m_date = LS_LINE_RE.match(line)
    m_nodate = LS_LINE_NO_DATE_RE.match(line)
    if m_date and m_nodate:
        raise MetadataViolation(
            "ambiguous ls line (matches both date and no-date forms) for %s: %r"
            % (expected_path, line)
        )
    m = m_date or m_nodate
    if not m:
        raise MetadataViolation("unparseable ls line for %s: %r" % (expected_path, line))
    mode = m.group("mode")
    type_char = mode[0]
    file_type = FILE_TYPE_BY_MODE_CHAR.get(type_char, "unknown")
    if file_type == "unknown":
        raise MetadataViolation("unknown file type char %r for %s" % (type_char, expected_path))
    owner, group = m.group("owner"), m.group("group")
    uid = int(owner) if owner.isdigit() else None
    gid = int(group) if group.isdigit() else None
    rest = m.group("rest")
    mtime_raw: Optional[str] = m.group("date") if m_date else None
    ls_target: Optional[str] = None
    if file_type == "symlink":
        prefix = expected_path + " -> "
        if not rest.startswith(prefix):
            raise MetadataViolation(
                "ls symlink rest %r does not anchor to %s" % (rest, expected_path)
            )
        ls_target = rest[len(prefix):]
    elif rest != expected_path:
        raise MetadataViolation("ls rest %r does not equal %s" % (rest, expected_path))
    return {
        "mode": mode,
        "type_char": type_char,
        "file_type": file_type,
        "nlink": int(m.group("nlink")),
        "uid": uid,
        "gid": gid,
        "owner_name": None if uid is not None else owner,
        "group_name": None if gid is not None else group,
        "size": int(m.group("size")),
        "mtime_raw": mtime_raw,
        "ls_raw": line,
        "ls_target": ls_target,
    }


def parse_stat_line(line: str) -> Dict[str, int]:
    m = STAT_LINE_RE.match(line)
    if not m:
        raise MetadataViolation("unparseable stat line: %r" % (line,))
    return {
        "size": int(m.group(1)),
        "mtime_epoch": int(m.group(2)),
        "uid": int(m.group(3)),
        "gid": int(m.group(4)),
        "nlink": int(m.group(5)),
    }


def parse_md5sum_line(line: str, expected_path: str) -> str:
    m = MD5SUM_LINE_RE.match(line)
    if not m:
        raise MetadataViolation("unparseable md5sum line for %s: %r" % (expected_path, line))
    digest, echoed = m.group(1), m.group(2)
    if echoed != expected_path:
        raise MetadataViolation(
            "md5sum echoed path %r != requested %r" % (echoed, expected_path)
        )
    return digest


def parse_readlink_output(data: bytes, expected_path: str) -> bytes:
    """Return the exact target bytes (single trailing newline stripped)."""
    if not data.endswith(b"\n"):
        raise MetadataViolation("readlink output for %s lacks trailing newline" % (expected_path,))
    target = data[:-1]
    if not target:
        raise MetadataViolation("readlink returned an empty target for %s" % (expected_path,))
    if b"\n" in target or b"\x00" in target:
        raise MetadataViolation("readlink target for %s contains control bytes" % (expected_path,))
    return target


# ---------------------------------------------------------------------------
# Local atomic output helpers
# ---------------------------------------------------------------------------


def canonical_json_bytes(obj: object) -> bytes:
    """Deterministic JSON encoding (sorted keys, compact, ascii, LF-final)."""
    return (
        json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")
        + b"\n"
    )


def _ensure_dir(path: str) -> bool:
    """Create a directory (and parents) if needed.  Returns True if created.

    os.makedirs applies `mode` only to the leaf directory, so every level
    created here is explicitly chmod-ed to 0o700 (umask-independent).
    """
    path = os.path.abspath(path)
    if os.path.isdir(path):
        return False
    ancestor = os.path.dirname(path)
    while not os.path.isdir(ancestor):
        ancestor = os.path.dirname(ancestor)
    os.makedirs(path, mode=0o700)
    cur = path
    while cur != ancestor:
        os.chmod(cur, 0o700)
        cur = os.path.dirname(cur)
    return True


def atomic_write_bytes(path: str, data: bytes, mode: int = 0o600) -> None:
    """Atomic local write via same-directory temp file + rename."""
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp_path = tempfile.mkstemp(prefix=".tmp-", dir=directory)
    try:
        _write_all(fd, data)
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
    _fsync_dir_best_effort(directory)


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError("short write")
        view = view[written:]


def _fsync_dir_best_effort(directory: str) -> None:
    try:
        dfd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(dfd)
    except OSError:
        pass
    finally:
        os.close(dfd)


# ---------------------------------------------------------------------------
# The collector
# ---------------------------------------------------------------------------

PURPOSE_ENUMERATE = "enumerate"
PURPOSE_METADATA = "metadata-ls"
PURPOSE_STAT = "metadata-stat"
PURPOSE_READLINK = "readlink"
PURPOSE_MD5 = "md5sum-crosscheck"
PURPOSE_CONTENT = "content-cat"


class SnapshotCollector:
    def __init__(self, cfg: SshConfig, out_dir: Optional[str], *, timestamp: str,
                 include_hidden: bool = False, remote_md5: bool = True,
                 remote_stat: bool = True, max_dynamic_entries: int = MAX_DYNAMIC_ENTRIES_DEFAULT,
                 overwrite: bool = False, dry_run: bool = False) -> None:
        self.cfg = cfg
        self.out_dir = os.path.abspath(out_dir) if out_dir else None
        self.timestamp = timestamp
        self.include_hidden = include_hidden
        self.remote_md5 = remote_md5
        self.remote_stat = remote_stat
        self.max_dynamic_entries = max_dynamic_entries
        self.overwrite = overwrite
        self.dry_run = dry_run

        self.objects_dir: Optional[str] = None

        # Family-specific closed allowlists (the only invocable universe).
        self._allowed: Dict[str, Set[str]] = {
            "ls": set(FIXED_FILE_PATHS) | set(EXPECTED_SYMLINK_PATHS) | {DYNAMIC_DIR},
            "stat": set(FIXED_FILE_PATHS),
            "readlink": set(EXPECTED_SYMLINK_PATHS),
            "md5sum": set(FIXED_FILE_PATHS),
            "cat": set(FIXED_FILE_PATHS),
        }

        # Run state.
        self.started_utc = _utc_now()
        self.invocations: List[Dict[str, object]] = []
        self.entries_detail: Dict[str, Dict[str, object]] = {}
        self.manifest_entries: List[Dict[str, object]] = []
        self.errors: List[Dict[str, str]] = []
        self.skipped: List[Dict[str, str]] = []
        self.missing_from_enumeration: List[str] = []
        self.objects_published: List[str] = []
        self.dynamic_names: List[str] = []
        self.guard_checks = 0
        #: Exit code of the run as it will be reported in
        #: collection-record.json; assigned BEFORE artifact writes so the
        #: record always reflects the computed result (0/1/2).
        self.pending_exit_code = 1

    # -- invocation plumbing ------------------------------------------------

    def _argv_for(self, remote_command: str) -> List[str]:
        verb, path = assert_safe_remote_command(
            remote_command, self._allowed,
            allow_hidden_components=self.include_hidden,
        )
        self.guard_checks += 1
        return ssh_argv(self.cfg, remote_command)

    def _run_remote(self, remote_command: str, *, purpose: str, path: str,
                    timeout: Optional[int] = None) -> Tuple[int, bytes, bytes]:
        """Guard + run one small remote command via ssh (captured output)."""
        argv = self._argv_for(remote_command)
        t0 = time.monotonic()
        rc, out, err = -1, b"", b""
        problem: Optional[str] = None
        try:
            proc = subprocess.run(
                argv,
                capture_output=True,
                timeout=timeout or self.cfg.ssh_timeout,
                check=False,
                stdin=subprocess.DEVNULL,
            )
            rc, out, err = proc.returncode, proc.stdout, proc.stderr
        except subprocess.TimeoutExpired:
            problem = "ssh timeout after %ss" % (timeout or self.cfg.ssh_timeout,)
        except OSError as exc:
            raise CollectorFatal("cannot execute ssh binary: %s" % (exc,)) from exc
        self._log_invocation(purpose, path, remote_command, argv, rc, out, err,
                             time.monotonic() - t0, problem, timeout)
        if problem is not None:
            raise RemoteInvocationError("%s failed for %s: %s" % (purpose, path, problem))
        return rc, out, err

    def _log_invocation(self, purpose: str, path: str, remote_command: str,
                        argv: List[str], rc: int, out: bytes, err: bytes,
                        duration: float, problem: Optional[str],
                        timeout: Optional[int]) -> None:
        self.invocations.append({
            "seq": len(self.invocations) + 1,
            "purpose": purpose,
            "path": path,
            "remote_command": remote_command,
            "argv": list(argv),
            "returncode": rc,
            "stdout_bytes": len(out),
            "stderr_tail_base64": _b64(err[-400:]),
            "duration_ms": int(duration * 1000),
            "timeout_sec": timeout if timeout is not None else self.cfg.ssh_timeout,
            "problem": problem,
        })

    # -- streaming content ---------------------------------------------------

    def _read_chunk(self, stream: Any, deadline: float) -> Optional[bytes]:
        """Read one chunk honouring a wall-clock deadline.

        Returns b"" at EOF, None on deadline expiry.  Falls back to a plain
        blocking read when the stream is not select()-able (test doubles).
        """
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        try:
            ready, _, _ = _select.select([stream], [], [], remaining)
            if not ready:
                return None
            return stream.read(65536)
        except (ValueError, OSError, AttributeError, TypeError):
            return stream.read(65536)

    def _stream_cat(self, path: str, spool_fd: int) -> Dict[str, object]:
        """Stream `cat -- '<path>'` stdout into hashers + spool file.

        Bytes are never printed and never buffered whole in memory.
        """
        remote_command = cmd_cat(path)
        argv = self._argv_for(remote_command)
        t0 = time.monotonic()
        deadline = t0 + self.cfg.cat_timeout
        sha = hashlib.sha256()
        md5 = hashlib.md5()
        total = 0
        out_dir = self.out_dir
        assert out_dir is not None, "streaming requires an out_dir"
        err_tmp = tempfile.TemporaryFile(dir=out_dir)  # stays inside out_dir
        try:
            try:
                proc = subprocess.Popen(
                    argv,
                    stdout=subprocess.PIPE,
                    stderr=err_tmp,
                    stdin=subprocess.DEVNULL,
                )
            except OSError as exc:
                raise CollectorFatal("cannot execute ssh binary: %s" % (exc,)) from exc
            killed = False
            try:
                stream = proc.stdout
                while True:
                    chunk = self._read_chunk(stream, deadline)
                    if chunk is None:
                        killed = True
                        proc.kill()
                        break
                    if chunk == b"":
                        break
                    total += len(chunk)
                    sha.update(chunk)
                    md5.update(chunk)
                    _write_all(spool_fd, chunk)
                try:
                    rc = proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    killed = True
                    rc = proc.wait()
            finally:
                if proc.stdout is not None:
                    proc.stdout.close()
            err_tmp.seek(0)
            stderr = err_tmp.read()
            duration = time.monotonic() - t0
            self._log_invocation(PURPOSE_CONTENT, path, remote_command, argv, rc,
                                 b"", stderr, duration,
                                 "cat deadline exceeded" if killed else None,
                                 self.cfg.cat_timeout)
            if killed:
                raise RemoteInvocationError("cat timed out for %s" % (path,))
            if rc != 0:
                raise RemoteInvocationError(
                    "cat failed for %s: rc=%d stderr=%r" % (path, rc, stderr[-200:])
                )
            return {
                "sha256": sha.hexdigest(),
                "md5_local": md5.hexdigest(),
                "size_bytes": total,
            }
        finally:
            err_tmp.close()

    def _publish_object(self, spool_fd: int, spool_path: str, digest: str) -> bool:
        """Atomically publish the spooled bytes as objects/sha256/<digest>."""
        objects_dir = self.objects_dir
        assert objects_dir is not None, "publishing requires an objects dir"
        os.fsync(spool_fd)
        os.close(spool_fd)
        final_path = os.path.join(objects_dir, digest)
        if os.path.exists(final_path):
            os.unlink(spool_path)  # content-addressed: existing object stands
            return False
        os.chmod(spool_path, 0o400)
        os.replace(spool_path, final_path)
        _fsync_dir_best_effort(objects_dir)
        return True

    # -- top-level ------------------------------------------------------------

    def run(self) -> int:
        if self.dry_run:
            return self._run_dry()
        if not self.out_dir:
            raise UsageError("--out-dir is required unless --dry-run is given")
        if self.out_dir == "/":
            raise UsageError("--out-dir may not be the filesystem root")
        if os.path.exists(self.out_dir) and not os.path.isdir(self.out_dir):
            raise UsageError("--out-dir exists and is not a directory")

        manifest_path = os.path.join(self.out_dir, "manifest.json")
        if os.path.exists(manifest_path) and not self.overwrite:
            raise UsageError(
                "%s already exists; pass --overwrite to replace it" % (manifest_path,)
            )

        try:
            _ensure_dir(self.out_dir)
            self.objects_dir = os.path.join(self.out_dir, "objects", "sha256")
            _ensure_dir(self.objects_dir)
        except OSError as exc:
            raise CollectorFatal("cannot prepare out-dir: %s" % (exc,)) from exc

        exit_code = 1
        fatal_error: Optional[CollectorFatal] = None
        try:
            self._enumerate_dynamic()
            paths = self._final_path_list()
            for path in paths:
                self._process_entry(path)
            exit_code = 0 if self._complete() else 1
        except (RemoteInvocationError, MetadataViolation) as exc:
            self.errors.append({"path": DYNAMIC_DIR, "stage": "enumerate", "error": str(exc)[:500]})
            exit_code = 1
        except CollectorFatal as exc:
            # Record the fatal failure, still write artifacts (record says 2).
            fatal_error = exc
            self.errors.append({"path": DYNAMIC_DIR, "stage": "fatal", "error": str(exc)[:500]})
            exit_code = 2
        finally:
            # Assign the pending exit code BEFORE writing artifacts so that
            # collection-record.json reports the computed result exactly.
            self.pending_exit_code = exit_code
            try:
                self._write_artifacts()
            except Exception as exc:  # noqa: BLE001 - report but keep exit semantics
                print("collect_box_snapshot: artifact write failed: %s" % (exc,), file=sys.stderr)
                exit_code = 2
                self.pending_exit_code = 2
        if fatal_error is not None:
            print("%s: fatal: %s" % (COLLECTOR_NAME, fatal_error), file=sys.stderr)
        return exit_code

    # -- enumeration ----------------------------------------------------------

    def _enumerate_dynamic(self) -> None:
        """Enumerate direct children of DYNAMIC_DIR via `ls -1a`."""
        for command in (cmd_enumerate(), cmd_enumerate_nodash()):
            rc, out, err = self._run_remote(command, purpose=PURPOSE_ENUMERATE, path=DYNAMIC_DIR)
            if rc == 0:
                try:
                    text = out.decode("utf-8", "strict")
                except UnicodeDecodeError as exc:
                    raise MetadataViolation("enumeration output not UTF-8: %s" % (exc,))
                names = [ln for ln in text.split("\n") if ln != ""]
                self._register_dynamic_names(names)
                return
        raise RemoteInvocationError("dynamic enumeration of %s failed" % (DYNAMIC_DIR,))

    def _register_dynamic_names(self, names: List[str]) -> None:
        accepted: List[str] = []
        for name in names:
            if name in (".", ".."):
                continue
            kind, _ = classify_dynamic_name(name)
            if kind == "unsafe":
                # Dotfiles with metacharacters, '..', leading dashes, spaces,
                # unicode, control chars, ... : reject, fail closed.
                self.skipped.append({"name": name, "reason": "unsafe basename (rejected)"})
                continue
            if kind == "hidden" and not self.include_hidden:
                # Benign dotfile: excluded by default glob semantics, but NOT
                # unsafe - it does not by itself make the run incomplete.
                self.skipped.append({"name": name, "reason": "hidden (glob semantics)"})
                continue
            if len(accepted) + 1 > self.max_dynamic_entries:
                raise RemoteInvocationError(
                    "dynamic entry count exceeds safety cap %d" % (self.max_dynamic_entries,)
                )
            accepted.append(name)
        self.dynamic_names = sorted(set(accepted))
        for name in self.dynamic_names:
            path = DYNAMIC_DIR + "/" + name
            validate_abs_path(path, allow_hidden_components=self.include_hidden)
            self._allowed["ls"].add(path)

    # -- entry processing -----------------------------------------------------

    def _final_path_list(self) -> List[str]:
        dynamic_paths = {DYNAMIC_DIR + "/" + n for n in self.dynamic_names}
        enumerated_names = set(self.dynamic_names)
        for expected in sorted(EXPECTED_SYMLINK_PATHS):
            if expected.startswith(DYNAMIC_DIR + "/"):
                base = expected[len(DYNAMIC_DIR) + 1:]
                if base not in enumerated_names:
                    self.missing_from_enumeration.append(expected)
        all_paths = set(FIXED_FILE_PATHS) | set(EXPECTED_SYMLINK_PATHS) | dynamic_paths
        return sorted(all_paths)

    def _classification(self, path: str) -> str:
        if path in FIXED_FILE_PATHS:
            return "file"
        if path in EXPECTED_SYMLINK_PATHS:
            return "symlink"
        return "dynamic"

    def _detail(self, path: str) -> Dict[str, object]:
        if path not in self.entries_detail:
            self.entries_detail[path] = {
                "path": path,
                "classification": self._classification(path),
                "ok": False,
                "error": None,
            }
        return self.entries_detail[path]

    def _entry_error(self, path: str, stage: str, message: object) -> None:
        err = {"path": path, "stage": stage, "error": str(message)[:500]}
        self.errors.append(err)
        detail = self._detail(path)
        detail["error"] = err
        detail["ok"] = False

    def _process_entry(self, path: str) -> None:
        detail = self._detail(path)
        try:
            meta = self._collect_ls(path)
        except (RemoteInvocationError, MetadataViolation) as exc:
            self._entry_error(path, PURPOSE_METADATA, exc)
            return
        detail.update({
            "mode": meta["mode"],
            "observed_type": meta["file_type"],
            "uid": meta["uid"],
            "gid": meta["gid"],
            "owner_name": meta["owner_name"],
            "group_name": meta["group_name"],
            "nlink": meta["nlink"],
            "size": meta["size"],
            "mtime_raw": meta["mtime_raw"],
            "ls_raw": meta["ls_raw"],
        })

        ftype = str(meta["file_type"])
        classification = str(detail["classification"])

        if ftype == "symlink":
            self._process_symlink(path, detail, meta, classification)
            return
        if ftype != "regular":
            if classification == "dynamic":
                self.skipped.append({
                    "path": path,
                    "reason": "non-regular/non-symlink type %s excluded by contract" % (ftype,),
                })
                detail["ok"] = True
                detail["excluded"] = "non-regular type"
                return
            self._entry_error(
                path, PURPOSE_METADATA,
                "expected file/symlink but observed %s" % (ftype,),
            )
            return

        # Observed regular file.
        if classification == "symlink":
            detail["type_mismatch"] = True
            self._entry_error(
                path, PURPOSE_METADATA,
                "expected symlink but observed regular file (not collected)",
            )
            return
        self._process_regular(path, detail, meta, classification)

    # ls with old-BusyBox fallbacks
    def _collect_ls(self, path: str) -> Dict[str, object]:
        attempts = (cmd_ls(path), cmd_ls_nodash(path), cmd_ls_names(path), cmd_ls_names_nodash(path))
        first_problem = "no ls attempt succeeded"
        for command in attempts:
            rc, out, err = self._run_remote(command, purpose=PURPOSE_METADATA, path=path)
            if rc != 0:
                first_problem = "ls rc=%d stderr=%r" % (rc, err[-200:])
                continue
            try:
                text = out.decode("utf-8", "strict")
            except UnicodeDecodeError as exc:
                first_problem = "ls output not UTF-8: %s" % (exc,)
                continue
            lines = [ln for ln in text.split("\n") if ln != ""]
            if len(lines) != 1:
                first_problem = "expected exactly one ls line for %s, got %d" % (path, len(lines))
                continue
            try:
                meta = parse_ls_line(lines[0], path)
            except MetadataViolation as exc:
                first_problem = str(exc)
                continue
            meta["ls_variant"] = command.split(" ", 1)[1].split(" ")[0]
            return meta
        raise RemoteInvocationError("metadata ls failed for %s: %s" % (path, first_problem))

    def _process_symlink(self, path: str, detail: Dict[str, object],
                         meta: Dict[str, object], classification: str) -> None:
        detail["type_mismatch"] = classification == "file"
        ls_target = cast(Optional[str], meta.get("ls_target"))
        target_bytes: Optional[bytes] = None
        target_source: Optional[str] = None
        if classification != "file":
            # Symlink-class paths may be readlink-ed (never cat-ed).
            self._allowed["readlink"].add(path)
            target_bytes, target_source = self._collect_readlink(path)
            if target_bytes is None and ls_target is not None:
                target_bytes = ls_target.encode("utf-8", "strict")
                target_source = "ls-fallback"
        elif ls_target is not None:
            target_bytes = ls_target.encode("utf-8", "strict")
            target_source = "ls-rest"
        if target_bytes is None:
            self._entry_error(path, PURPOSE_READLINK, "could not determine symlink target")
            return
        # Cross-check readlink vs ls when both are available: fail closed.
        if target_source in ("readlink", "ls-fallback") and ls_target is not None:
            if target_bytes != ls_target.encode("utf-8", "strict"):
                self._entry_error(
                    path, PURPOSE_READLINK,
                    "readlink target disagrees with ls target (ambiguous metadata)",
                )
                return
        try:
            target_str = target_bytes.decode("utf-8", "strict")
            target_b64: Optional[str] = None
        except UnicodeDecodeError:
            target_str = None
            target_b64 = _b64(target_bytes)
        detail["target"] = target_str
        detail["target_base64"] = target_b64
        detail["target_source"] = target_source
        detail["target_length_bytes"] = len(target_bytes)
        detail["target_sha256"] = hashlib.sha256(target_bytes).hexdigest()
        detail["ok"] = True
        self.manifest_entries.append({
            "path": path,
            "kind": "symlink",
            "classification": classification,
            "observed_type": "symlink",
            "type_mismatch": bool(detail["type_mismatch"]),
            "mode": meta["mode"],
            "uid": meta["uid"],
            "gid": meta["gid"],
            "owner_name": meta["owner_name"],
            "group_name": meta["group_name"],
            "nlink": meta["nlink"],
            "size": meta["size"],
            "mtime_raw": meta["mtime_raw"],
            "mtime_epoch": None,
            "target": target_str,
            "target_base64": target_b64,
            "target_length_bytes": len(target_bytes),
            "target_sha256": detail["target_sha256"],
            "object": None,
        })

    def _collect_readlink(self, path: str) -> Tuple[Optional[bytes], Optional[str]]:
        for command in (cmd_readlink(path), cmd_readlink_nodash(path)):
            rc, out, err = self._run_remote(command, purpose=PURPOSE_READLINK, path=path)
            if rc == 0:
                try:
                    return parse_readlink_output(out, path), "readlink"
                except MetadataViolation:
                    continue
            if rc == 127:  # applet absent on old BusyBox
                break
        return None, None

    def _process_regular(self, path: str, detail: Dict[str, object],
                         meta: Dict[str, object], classification: str) -> None:
        detail["type_mismatch"] = False
        self._allowed["stat"].add(path)
        self._allowed["md5sum"].add(path)
        self._allowed["cat"].add(path)

        stat_info = self._collect_stat(path)
        detail["stat"] = stat_info
        if stat_info is not None:
            try:
                self._cross_check_stat(path, meta, stat_info)
            except MetadataViolation as exc:
                # Contradictory metadata for this entry: fail this entry
                # closed and continue with the rest of the allowlist.
                self._entry_error(path, PURPOSE_STAT, exc)
                return

        md5_remote: Optional[str] = None
        if self.remote_md5:
            md5_remote = self._collect_md5(path)
        detail["md5_remote"] = md5_remote

        # Stream content to a spool file, verify, then publish the object.
        fd, spool_path = tempfile.mkstemp(prefix=".spool-", dir=self.objects_dir)
        try:
            stream_info = self._stream_cat(path, fd)
            ok, problem = self._verify_stream(path, meta, stat_info, md5_remote, stream_info)
            if not ok:
                self._entry_error(path, PURPOSE_CONTENT, problem or "content verification failed")
                return
            digest = str(stream_info["sha256"])
            published = self._publish_object(fd, spool_path, digest)
            if published:
                self.objects_published.append(digest)
            else:
                try:
                    os.close(fd)
                except OSError:
                    pass
        except (RemoteInvocationError, MetadataViolation) as exc:
            try:
                os.close(fd)
            except OSError:
                pass
            try:
                os.unlink(spool_path)
            except OSError:
                pass
            self._entry_error(path, PURPOSE_CONTENT, exc)
            return
        except BaseException:
            try:
                os.close(fd)
            except OSError:
                pass
            try:
                os.unlink(spool_path)
            except OSError:
                pass
            raise

        entry = {
            "path": path,
            "kind": "file",
            "classification": classification,
            "observed_type": "regular",
            "type_mismatch": False,
            "mode": meta["mode"],
            "uid": meta["uid"],
            "gid": meta["gid"],
            "owner_name": meta["owner_name"],
            "group_name": meta["group_name"],
            "nlink": meta["nlink"],
            "size": meta["size"],
            "mtime_raw": meta["mtime_raw"],
            "mtime_epoch": stat_info["mtime_epoch"] if stat_info else None,
            "size_bytes": stream_info["size_bytes"],
            "sha256": digest,
            "md5_local": stream_info["md5_local"],
            "md5_remote": md5_remote,
            "object": "objects/sha256/" + digest,
        }
        detail.update({k: v for k, v in entry.items() if k != "path"})
        detail["ok"] = True
        self.manifest_entries.append(entry)

    def _collect_stat(self, path: str) -> Optional[Dict[str, int]]:
        if not self.remote_stat:
            return None
        for command in (cmd_stat(path), cmd_stat_nodash(path)):
            rc, out, err = self._run_remote(command, purpose=PURPOSE_STAT, path=path)
            if rc == 0:
                try:
                    text = out.decode("utf-8", "strict").strip()
                    return parse_stat_line(text)
                except (UnicodeDecodeError, MetadataViolation):
                    return None  # optional enrichment: note-only, never fatal alone
            if rc == 127:
                return None  # stat applet absent on old BusyBox
        return None

    def _cross_check_stat(self, path: str, meta: Dict[str, object],
                          stat_info: Dict[str, int]) -> None:
        # Only meaningful when ls reported the regular file itself.
        if meta["size"] != stat_info["size"]:
            raise MetadataViolation(
                "stat size %d != ls size %d for %s" % (stat_info["size"], meta["size"], path)
            )
        if meta["uid"] is not None and meta["uid"] != stat_info["uid"]:
            raise MetadataViolation("stat uid != ls uid for %s" % (path,))
        if meta["gid"] is not None and meta["gid"] != stat_info["gid"]:
            raise MetadataViolation("stat gid != ls gid for %s" % (path,))

    def _collect_md5(self, path: str) -> Optional[str]:
        for command in (cmd_md5sum(path), cmd_md5sum_nodash(path)):
            rc, out, err = self._run_remote(command, purpose=PURPOSE_MD5, path=path)
            if rc == 0:
                try:
                    text = out.decode("utf-8", "strict")
                    lines = [ln for ln in text.split("\n") if ln != ""]
                    if len(lines) != 1:
                        raise MetadataViolation("md5sum returned %d lines" % (len(lines),))
                    return parse_md5sum_line(lines[0], path)
                except (UnicodeDecodeError, MetadataViolation):
                    return None  # optional cross-check: note-only when unusable
            if rc == 127:
                return None  # md5sum applet absent on old BusyBox
        return None

    def _verify_stream(self, path: str, meta: Dict[str, object],
                       stat_info: Optional[Dict[str, int]], md5_remote: Optional[str],
                       stream_info: Dict[str, object]) -> Tuple[bool, Optional[str]]:
        size_bytes = int(stream_info["size_bytes"])  # type: ignore[arg-type]
        if meta["size"] != size_bytes:
            return False, "streamed %d bytes but ls size is %s for %s" % (
                size_bytes, meta["size"], path)
        if stat_info is not None and stat_info["size"] != size_bytes:
            return False, "streamed %d bytes but stat size is %d for %s" % (
                size_bytes, stat_info["size"], path)
        if md5_remote is not None and md5_remote != stream_info["md5_local"]:
            return False, "remote md5 %s != local md5 %s for %s" % (
                md5_remote, stream_info["md5_local"], path)
        return True, None

    # -- completeness ---------------------------------------------------------

    def _complete(self) -> bool:
        if self.errors:
            return False
        if any(s.get("reason", "").startswith("unsafe basename") for s in self.skipped):
            return False
        if self.missing_from_enumeration:
            return False
        mismatched = [d for d in self.entries_detail.values() if d.get("type_mismatch")]
        if mismatched:
            return False
        return True

    # -- artifacts ------------------------------------------------------------

    def _manifest(self) -> Dict[str, object]:
        files = [e for e in self.manifest_entries if e["kind"] == "file"]
        symlinks = [e for e in self.manifest_entries if e["kind"] == "symlink"]
        return {
            "schema": MANIFEST_SCHEMA,
            "collector": {"name": COLLECTOR_NAME, "version": COLLECTOR_VERSION},
            "box": {"host": self.cfg.host, "user": self.cfg.user, "port": self.cfg.port},
            "generated_at_utc": self.timestamp,
            "dynamic_dir": DYNAMIC_DIR,
            "allowlist": {
                "fixed_files": sorted(FIXED_FILE_PATHS),
                "expected_symlinks": sorted(EXPECTED_SYMLINK_PATHS),
                "dynamic_entries": list(self.dynamic_names),
            },
            "entries": sorted(self.manifest_entries, key=lambda e: cast(str, e["path"])),
            "counts": {
                "entries": len(self.manifest_entries),
                "files": len(files),
                "symlinks": len(symlinks),
                "objects_published": len(self.objects_published),
                "errors": len(self.errors),
                "type_mismatches": sum(
                    1 for d in self.entries_detail.values() if d.get("type_mismatch")
                ),
                "skipped_unsafe": sum(
                    1 for s in self.skipped if s.get("reason", "").startswith("unsafe basename")
                ),
                "skipped_hidden": sum(
                    1 for s in self.skipped if "hidden" in s.get("reason", "")
                ),
                "skipped_nonregular": sum(
                    1 for s in self.skipped if "non-regular" in s.get("reason", "")
                ),
            },
            "complete": self._complete(),
            "errors": sorted(self.errors, key=lambda e: (e["path"], e["stage"])),
        }

    def _record(self, exit_code: int) -> Dict[str, object]:
        return {
            "schema": RECORD_SCHEMA,
            "collector": {"name": COLLECTOR_NAME, "version": COLLECTOR_VERSION},
            "python_version": sys.version.split()[0],
            "started_utc": self.started_utc,
            "finished_utc": _utc_now(),
            "dry_run": self.dry_run,
            "config": {
                "host": self.cfg.host,
                "user": self.cfg.user,
                "port": self.cfg.port,
                "identity": self.cfg.identity,
                "known_hosts": self.cfg.known_hosts,
                "ssh_binary": self.cfg.ssh_binary,
                "ssh_config": self.cfg.ssh_config,
                "connect_timeout": self.cfg.connect_timeout,
                "ssh_timeout": self.cfg.ssh_timeout,
                "cat_timeout": self.cfg.cat_timeout,
                "out_dir": self.out_dir,
                "include_hidden": self.include_hidden,
                "remote_md5": self.remote_md5,
                "remote_stat": self.remote_stat,
                "max_dynamic_entries": self.max_dynamic_entries,
                "overwrite": self.overwrite,
                "timestamp": self.timestamp,
            },
            "ssh_options_pinned": list(REQUIRED_SSH_OPTIONS)
            + ["ConnectTimeout=%d" % self.cfg.connect_timeout]
            + (["UserKnownHostsFile=%s" % self.cfg.known_hosts] if self.cfg.known_hosts else [])
            + ["-F %s" % self.cfg.ssh_config, "-T"],
            "safety": {
                "guard_checks_passed": self.guard_checks,
                "grammar": REMOTE_GRAMMAR_DOC,
                "violations": [],
            },
            "residual_risks": {
                "toctou": (
                    "metadata (ls/stat/md5sum) and content (cat) are separate "
                    "read-only SSH operations; the box is assumed immutable "
                    "with no concurrent change during a run.  Size and "
                    "remote-vs-local MD5 cross-checks mitigate but cannot "
                    "cryptographically eliminate a same-size swap between "
                    "invocations; no additional remote verbs may be "
                    "introduced to close this."
                ),
            },
            "invocations": self.invocations,
            "entries": self.entries_detail,
            "skipped": self.skipped,
            "missing_from_enumeration": self.missing_from_enumeration,
            "objects_published": self.objects_published,
            "errors": sorted(self.errors, key=lambda e: (e["path"], e["stage"])),
            "counts": self._manifest()["counts"],
            "complete": self._complete(),
            "exit_code": exit_code,
        }

    def _write_artifacts(self) -> None:
        if self.dry_run or not self.out_dir:
            return
        manifest_bytes = canonical_json_bytes(self._manifest())
        manifest_path = os.path.join(self.out_dir, "manifest.json")
        atomic_write_bytes(manifest_path, manifest_bytes, mode=0o600)
        digest = hashlib.sha256(manifest_bytes).hexdigest()
        atomic_write_bytes(
            os.path.join(self.out_dir, "manifest.sha256"),
            ("%s  manifest.json\n" % digest).encode("ascii"),
            mode=0o600,
        )
        atomic_write_bytes(
            os.path.join(self.out_dir, "collection-record.json"),
            canonical_json_bytes(self._record(self.pending_exit_code)),
            mode=0o600,
        )

    # -- dry run --------------------------------------------------------------

    def _run_dry(self) -> int:
        plan = self.build_plan()
        sys.stdout.write(json.dumps(plan, indent=2, sort_keys=True) + "\n")
        sys.stdout.flush()
        return 0

    def build_plan(self) -> Dict[str, object]:
        """Machine-readable plan of every fixed invocation; nothing executes."""
        planned: List[Dict[str, object]] = []

        def add(purpose: str, path: str, remote_command: str) -> None:
            verb, _p = assert_safe_remote_command(remote_command, self._allowed)
            self.guard_checks += 1
            planned.append({
                "purpose": purpose,
                "path": path,
                "verb": verb,
                "remote_command": remote_command,
                "argv": ssh_argv(self.cfg, remote_command),
            })

        add(PURPOSE_ENUMERATE, DYNAMIC_DIR, cmd_enumerate())
        for path in sorted(FIXED_FILE_PATHS):
            add(PURPOSE_METADATA, path, cmd_ls(path))
            if self.remote_stat:
                add(PURPOSE_STAT, path, cmd_stat(path))
            if self.remote_md5:
                add(PURPOSE_MD5, path, cmd_md5sum(path))
            add(PURPOSE_CONTENT, path, cmd_cat(path))
        for path in sorted(EXPECTED_SYMLINK_PATHS - set(FIXED_FILE_PATHS)):
            add(PURPOSE_METADATA, path, cmd_ls(path))
            add(PURPOSE_READLINK, path, cmd_readlink(path))

        return {
            "schema": PLAN_SCHEMA,
            "dry_run": True,
            "collector": {"name": COLLECTOR_NAME, "version": COLLECTOR_VERSION},
            "box": {"host": self.cfg.host, "user": self.cfg.user, "port": self.cfg.port},
            "generated_at_utc": self.timestamp,
            "ssh_options_pinned": list(REQUIRED_SSH_OPTIONS)
            + ["ConnectTimeout=%d" % self.cfg.connect_timeout]
            + (["UserKnownHostsFile=%s" % self.cfg.known_hosts] if self.cfg.known_hosts else [])
            + ["-F %s" % self.cfg.ssh_config, "-T"],
            "dynamic_dir": DYNAMIC_DIR,
            "dynamic_dir_note": (
                "children of the dynamic dir are enumerated with the command above; "
                "each validated child adds ls/stat/md5sum/cat (regular files) or "
                "ls/readlink (symlinks) invocations at run time"
            ),
            "fixed_entries": {
                "files": sorted(FIXED_FILE_PATHS),
                "symlinks": sorted(EXPECTED_SYMLINK_PATHS),
            },
            "fallback_commands": {
                "note": (
                    "old-BusyBox fallbacks are attempted only when the primary "
                    "form fails; every fallback passes the same closed guard"
                ),
                "ls": [cmd_ls_nodash(FALLBACK_EXAMPLE), cmd_ls_names(FALLBACK_EXAMPLE),
                       cmd_ls_names_nodash(FALLBACK_EXAMPLE)],
                "stat": [cmd_stat_nodash(FALLBACK_EXAMPLE)],
                "readlink": [cmd_readlink_nodash(FALLBACK_EXAMPLE_SYMLINK)],
                "md5sum": [cmd_md5sum_nodash(FALLBACK_EXAMPLE)],
            },
            "planned_invocations": planned,
            "residual_risks": {
                "toctou": (
                    "metadata (ls/stat/md5sum) and content (cat) are separate "
                    "read-only SSH operations; the box is assumed immutable "
                    "with no concurrent change during a run.  Size and "
                    "remote-vs-local MD5 cross-checks mitigate but cannot "
                    "cryptographically eliminate a same-size swap between "
                    "invocations; no additional remote verbs may be "
                    "introduced to close this."
                ),
            },
            "safety": {
                "guard_checks_passed": self.guard_checks,
                "grammar": REMOTE_GRAMMAR_DOC,
                "status": "ok",
            },
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime(TIMESTAMP_FORMAT)


def _b64(data: bytes) -> str:
    import base64

    return base64.b64encode(data).decode("ascii")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog=COLLECTOR_NAME,
        description=(
            "Read-only SSH inventory collector for the box snapshot allowlist. "
            "Never writes to the remote host; writes only to --out-dir."
        ),
    )
    parser.add_argument("--host", required=True, help="box hostname or IPv4 address")
    parser.add_argument("--user", default="root", help="ssh user (default: root)")
    parser.add_argument("--port", type=int, default=22, help="ssh port (default: 22)")
    parser.add_argument("--identity", required=True,
                        help="path to the ssh private key (IdentitiesOnly)")
    parser.add_argument("--known-hosts", default=None,
                        help="UserKnownHostsFile for StrictHostKeyChecking (recommended)")
    parser.add_argument("--ssh-binary", default="ssh",
                        help="ssh binary to use (must be named 'ssh')")
    parser.add_argument("--ssh-config", default="/dev/null",
                        help="ssh -F config file (default: /dev/null to pin options)")
    parser.add_argument("--connect-timeout", type=int, default=10)
    parser.add_argument("--ssh-timeout", type=int, default=30,
                        help="per-invocation timeout for small commands (seconds)")
    parser.add_argument("--cat-timeout", type=int, default=120,
                        help="per-file streaming timeout for remote cat (seconds)")
    parser.add_argument("--out-dir", default=None,
                        help="LOCAL output directory (required unless --dry-run)")
    parser.add_argument("--timestamp", default=None,
                        help="pin generated_at_utc (%%Y-%%m-%%dT%%H:%%M:%%SZ) for "
                             "deterministic runs; default: now UTC")
    parser.add_argument("--include-hidden", action="store_true",
                        help="also collect hidden entries under the dynamic dir")
    parser.add_argument("--no-remote-md5", action="store_true",
                        help="skip the optional remote md5sum cross-check")
    parser.add_argument("--no-remote-stat", action="store_true",
                        help="skip the optional remote stat enrichment")
    parser.add_argument("--max-dynamic-entries", type=int, default=MAX_DYNAMIC_ENTRIES_DEFAULT)
    parser.add_argument("--overwrite", action="store_true",
                        help="allow replacing an existing manifest.json in --out-dir")
    parser.add_argument("--dry-run", action="store_true",
                        help="print the exact SSH argv/remote commands and a "
                             "machine-readable plan; execute and write nothing")
    parser.add_argument("--version", action="version",
                        version="%s %s" % (COLLECTOR_NAME, COLLECTOR_VERSION))
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    try:
        cfg = build_ssh_config(args)
        timestamp = args.timestamp
        if timestamp is not None:
            try:
                datetime.datetime.strptime(timestamp, TIMESTAMP_FORMAT)
            except ValueError as exc:
                raise UsageError("invalid --timestamp format: %s" % (exc,)) from exc
        else:
            timestamp = _utc_now()
        collector = SnapshotCollector(
            cfg,
            args.out_dir,
            timestamp=timestamp,
            include_hidden=args.include_hidden,
            remote_md5=not args.no_remote_md5,
            remote_stat=not args.no_remote_stat,
            max_dynamic_entries=args.max_dynamic_entries,
            overwrite=args.overwrite,
            dry_run=args.dry_run,
        )
        return collector.run()
    except UsageError as exc:
        print("%s: usage error: %s" % (COLLECTOR_NAME, exc), file=sys.stderr)
        return 2
    except SafetyViolation as exc:
        print("%s: SAFETY VIOLATION (nothing executed): %s" % (COLLECTOR_NAME, exc), file=sys.stderr)
        return 2
    except CollectorFatal as exc:
        print("%s: fatal: %s" % (COLLECTOR_NAME, exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
