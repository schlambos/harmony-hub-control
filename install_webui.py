#!/usr/bin/env python3
"""
Linux/macOS installer for the Harmony Hub Control post-root web UI.

The hub must already have root SSH access. This installer intentionally uses
plain ssh plus remote "cat > file" uploads, because the minimal Dropbear setup
used by the root tool does not provide scp, sftp, or tftp.

Every candidate file is first uploaded into ONE private 0700 staging tree
under /var/volatile/codex-install-* (RAM), verified against locally computed
MD5 sums using strict BusyBox md5sum output, and compared with the hub's
current files. Candidates that already match are left alone.

The hub's BusyBox has no mktemp, stat, df, or sync applets, so everything
here uses only cat, cp, ln, mv, rm, chmod, mkdir, ls -l, awk, and md5sum.
Free flash is measured by payload/helpers/codex_flash_free, which runs from
the RAM staging tree and is never installed. The preflight compares it with
an estimate of what the changed files take on the hub's compressing jffs2 and
blocks (BLOCKED_CAPACITY) before writing anything when they don't fit.

Changed files install as a two-phase commit:

  1. copy each changed file next to its destination as <dest>.codex-new and
     verify it; if flash fills up anyway, every .codex-new is removed and no
     live file has changed (BLOCKED_CAPACITY);
  2. rename each .codex-new over its destination, codex_webui last.

When harmony-hub-root already left an identical dropbearmulti on the hub,
phase 1 hard-links it instead of writing a second copy. Its leftover staging
folders are reported, and removed with --remove-root-tool-leftovers.

Originals are copied into RAM before phase 1, so any later failure restores
them (copy to <dest>.codex-rb, then rename) with their observed modes.

Preflight-only mode reports the inventory, actions, RAM headroom, backup
generations, handoff estimate, and verdict with zero persistent mutations and
no service actions. Default mode is upgrade and preserves existing
configuration; --clean-install regenerates configuration.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import re
import secrets
import shlex
import socket
import subprocess
import sys
import time
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PAYLOAD = ROOT / "payload"

STAGE_PREFIX = "/var/volatile/codex-install-"
HANDOFF_ROOT = "/data/codex-backups"
HANDOFF_BUDGET_BYTES = 256 * 1024
HANDOFF_KEEP = 3
WEBUI_DEST = "/data/codex/bin/codex_webui"
NEW_SUFFIX = ".codex-new"
RESTORE_SUFFIX = ".codex-rb"
# RAM that must stay free after staging and rollback copies (tmpfs is RAM).
RAM_MARGIN_BYTES = 4 * 1048576

# Free-space probe, run from the RAM staging tree only.
FLASH_HELPER = PAYLOAD / "helpers" / "codex_flash_free"
FLASH_HELPER_NAME = "codex_flash_free"
FLASH_PATH = "/data"
# jffs2 stores a file as zlib-compressed nodes of at most one 4 KiB page, each
# with a 68-byte header; its directory entry adds 40 bytes plus the name.
JFFS2_PAGE = 4096
JFFS2_NODE_HEADER = 68
JFFS2_DIRENT_HEADER = 40
# Flash kept spare on top of the estimate: one 64 KiB erase block plus 5%.
FLASH_MARGIN_BYTES = 64 * 1024
FLASH_MARGIN_PERCENT = 5

# What harmony-hub-root leaves behind. Its dropbearmulti is the same build as
# ours, and its staging folders hold about 0.5 MB of base64 chunks each.
DROPBEAR_DEST = "/data/codex/bin/dropbearmulti"
ROOT_TOOL_DROPBEAR = "/data/rootssh/bin/dropbearmulti"
ROOT_TOOL_FILES = ["/data/rootssh/bin/dropbearmulti", "/data/rootssh/bin/dropbear", "/data/rootssh/bin/dropbearkey"]
ROOT_TOOL_STAGE_RE = re.compile(r"^/data/codexssh_[A-Za-z0-9_]+_stage$")
# The hub's ls has no -R; a root-tool stage holds files and a chunks/ folder.
ROOT_TOOL_SCAN = (
    'for d in /data/codexssh_*_stage; do [ -d "$d" ] || continue; '
    "set -- $(ls -l \"$d\" \"$d/chunks\" 2>/dev/null | awk '/^-/ {s += $5; n++} END {print s + 0, n + 0}'); "
    'echo "root_tool_stage bytes=$1 files=$2 path=$d"; done; '
    "for f in /data/rootssh/bin/dropbearmulti /data/codex/bin/dropbearmulti; do "
    '[ -f "$f" ] && [ ! -L "$f" ] || continue; set -- $(ls -il "$f"); '
    'echo "dropbear_copy inode=$1 path=$f"; done'
)
# Removes the root tool's Dropbear only while SSH runs ours.
ROOT_TOOL_DROPBEAR_REMOVE = (
    "if [ -x /data/codex/bin/dropbear ] && grep /data/codex/bin/dropbear /usr/sbin/dropbear >/dev/null; then "
    "rm -f " + " ".join(ROOT_TOOL_FILES) + " && echo removed; fi"
)

# Multiple remotes of one model (docs/MULTI_REMOTE.md). Stock hal keeps one
# remote per model: it unpairs an older one after every pair, and its key
# threads keep per-model state (one radio subscriber, one thread handle), so
# two remotes of one model hang its radio dispatcher. --multi-remote on makes a
# copy of the hub's own /usr/bin/hal with those made per slot and the
# same-model unpair kept only for remotes with a screen and the keyboard
# (whose thread state is per model too); rcS.local bind-mounts
# it over /usr/bin/hal at boot. The copy is built here from the hub's file
# with the edits in payload/helpers/hal_multiremote_patch.json; hal itself is
# never shipped.
HAL_PATH = "/usr/bin/hal"
HAL_MULTI_DEST = "/data/codex/bin/hal_multiremote"
MULTI_REMOTE_CONF = "/data/codex/multi_remote.conf"
HAL_PATCH_FILE = PAYLOAD / "helpers" / "hal_multiremote_patch.json"
# Turning it off reboots into the stock hal, which hangs its radio on two
# remotes of one model. So --multi-remote off first checks the slot table on
# the hub, while the multi-remote hal runs: it writes the pending-restart guard
# (codex_webui's /api/remote-pair refuses while it's there; it lives in RAM
# and lapses after 10 minutes), refuses during an open pairing window, then
# reads rf.info. The copy itself is left to rcS.local, which deletes it at the
# next boot when the setting isn't 1.
MULTI_REMOTE_PENDING = "/var/run/codex-multi-remote-pending"
NO_SCREEN_EQUADS = ("16414", "16422", "16423")


def hal_bound_command() -> str:
    """Whether rcS.local bind-mounted the multi-remote copy over /usr/bin/hal at boot."""
    return f"if grep ' {HAL_PATH} ' /proc/mounts >/dev/null 2>&1; then echo bound; else echo stock; fi"


def multi_remote_off_check_command(guard: bool) -> str:
    # A guard that can't be written stops the check (guard-failed): without
    # it, nothing blocks a pair between the check and the reboot.
    touch = f"elif ! touch {MULTI_REMOTE_PENDING}; then echo guard-failed; " if guard else ""
    return (
        f"if ! grep ' {HAL_PATH} ' /proc/mounts >/dev/null 2>&1; then echo inactive; "
        f"{touch}elif ps | grep '[r]f.pairing' >/dev/null 2>&1; then echo pairing; "
        "else /data/codex/bin/codex_hal_ltcp rf.info '{}' 8 2>&1; fi"
    )


def rf_duplicate_models(reply: str) -> str | None:
    """Models without a screen paired more than once in hal's rf.info answer,
    as "16414 (slots 1, 2)"; "" when none; None when it isn't a valid answer."""
    start = reply.find("{")
    try:
        doc = json.loads(reply[start:]) if start >= 0 else None
    except ValueError:
        doc = None
    if not isinstance(doc, dict) or doc.get("code") != 200 or not isinstance(doc.get("data"), dict):
        return None
    slots: dict[str, list[str]] = {}
    for dev in doc["data"].get("Devices") or []:
        if isinstance(dev, dict) and str(dev.get("EquadID")) in NO_SCREEN_EQUADS:
            slots.setdefault(str(dev["EquadID"]), []).append(str(dev.get("DeviceIndex", "?")))
    return "; ".join(f"{m} (slots {', '.join(v)})" for m, v in slots.items() if len(v) > 1)


def load_hal_patch(path: Path = HAL_PATCH_FILE) -> tuple[str, str, list[tuple[int, bytes, bytes]]]:
    """(stock md5, patched md5, [(offset, stock bytes, patched bytes)])."""
    doc = json.loads(path.read_text(encoding="utf-8"))
    edits = [(int(e["offset"], 16), bytes.fromhex(e["stock"]), bytes.fromhex(e["patched"])) for e in doc["edits"]]
    return doc["stock_md5"], doc["patched_md5"], edits


HAL_STOCK_MD5, HAL_MULTI_MD5, HAL_MULTI_PATCH = load_hal_patch()


def patched_hal(data: bytes) -> bytes:
    """The multi-remote hal from the hub's own /usr/bin/hal; fails closed."""
    digest = hashlib.md5(data).hexdigest()
    if digest == HAL_MULTI_MD5:
        return data  # already the patched build (read while it is bind-mounted)
    if digest != HAL_STOCK_MD5:
        raise RuntimeError(
            f"{HAL_PATH} on this hub is not the hal build multi-remote supports "
            f"(md5 {digest}, expected {HAL_STOCK_MD5} from firmware 4.15.600)"
        )
    out = bytearray(data)
    for offset, old, new in HAL_MULTI_PATCH:
        if bytes(out[offset : offset + len(old)]) != old:
            raise RuntimeError(f"{HAL_PATH}: unexpected bytes at {offset:#x}")
        out[offset : offset + len(new)] = new
    if hashlib.md5(out).hexdigest() != HAL_MULTI_MD5:
        raise RuntimeError("the patched hal does not match its expected md5")
    return bytes(out)


HANDOFF_REQUIRED_PATHS = [
    "/etc/init.d/rcS.local",
    "/opt/luaworks/tasks/connectserver/netservicestarter.lua",
    "/usr/sbin/dropbear",
    "/usr/sbin/dropbearkey",
    "/data/codex/hub_id",
    "/data/codex/cloud_blocker.conf",
    "/data/codex/offline_egress_guard.sh",
    "/data/codexmqtt/config.json",
    "/pkg/codexactivity/codexactivity.lua",
    "/pkg/codexactivity/manifest.json",
]

# Artifacts an upgrade must never replace unless explicitly supplied.
UPGRADE_PROTECTED_PATHS = [
    "/data/codex/hub_id",
    "/data/codex/cloud_blocker.conf",
    MULTI_REMOTE_CONF,
    "/data/codexmqtt/config.json",
    "/data/codex/resource-backups",
    "/data/codex-backups",
    "/data/codex/update-backups",
]

VERDICT_ALLOWED = "ALLOWED"
VERDICT_CAPACITY = "BLOCKED_CAPACITY"
VERDICT_ROLLBACK_CAPACITY = "BLOCKED_ROLLBACK_CAPACITY"
VERDICT_CONFIG_UNCERTAIN = "BLOCKED_CONFIGURATION_UNCERTAINTY"
VERDICT_VALIDATION = "BLOCKED_VALIDATION_FAILURE"

MD5_LINE_RE = re.compile(r"^([0-9a-f]{32})  (.+)$")


def step(text: str) -> None:
    print(f"\n== {text} ==")


def info(text: str) -> None:
    print(f"  {text}")


def kv(text: str) -> None:
    print(text)


def fail(message: str) -> None:
    print(f"\nERROR: {message}", file=sys.stderr)
    sys.exit(1)


def prompt_if_missing(value: str | None, label: str, required: bool, no_prompt: bool) -> str:
    if value:
        return value
    if no_prompt:
        if required:
            raise RuntimeError(f"{label} is required")
        return ""
    entered = input(f"{label}: ").strip()
    if required and not entered:
        raise RuntimeError(f"{label} is required")
    return entered


def resolve_default_key_path() -> Path | None:
    ssh_dir = Path.home() / ".ssh"
    if not ssh_dir.is_dir():
        return None
    keys = [
        p
        for p in ssh_dir.glob("harmony_owner_*")
        if p.is_file() and not p.name.endswith(".pub")
    ]
    if not keys:
        return None
    return sorted(keys, key=lambda p: p.stat().st_mtime, reverse=True)[0]


def valid_hub_id(value: str) -> bool:
    return value.isdigit() and len(value) >= 4


def read_json_file(path: Path) -> object | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def resolve_saved_hub_id(hub_host: str) -> tuple[str, Path] | None:
    candidate_paths: list[Path] = []
    home = Path.home()
    candidate_paths.extend(
        [
            home / ".harmony-hub" / "known_hubs.json",
            home / ".harmony-hub" / "last_root.json",
            home / ".harmony-hub" / "hub_id.txt",
            ROOT / "harmony_hub_id.txt",
        ]
    )

    seen: set[Path] = set()
    for path in candidate_paths:
        if path in seen:
            continue
        seen.add(path)
        if not path.is_file():
            continue
        if path.name == "known_hubs.json":
            known = read_json_file(path)
            if isinstance(known, dict):
                entry = known.get(hub_host)
                if isinstance(entry, dict):
                    hub_id = str(entry.get("hub_id", "")).strip()
                    if valid_hub_id(hub_id):
                        return hub_id, path
            continue
        if path.name == "last_root.json":
            last = read_json_file(path)
            if isinstance(last, dict) and str(last.get("host", "")) == hub_host:
                hub_id = str(last.get("hub_id", "")).strip()
                if valid_hub_id(hub_id):
                    return hub_id, path
            continue
        try:
            hub_id = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if valid_hub_id(hub_id):
            return hub_id, path
    return None


def remote_quote(value: str) -> str:
    return shlex.quote(value)


def bin_manifest_names() -> list[str]:
    """Install binary list from payload/bin/MANIFEST.txt (canonical inventory)."""
    manifest = PAYLOAD / "bin" / "MANIFEST.txt"
    names: list[str] = []
    for line in manifest.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) >= 2 and len(parts[0]) == 32:
            names.append(parts[-1])
    if not names:
        raise RuntimeError(f"no binaries listed in {manifest}")
    for name in names:
        path = PAYLOAD / "bin" / name
        if not path.is_file():
            raise RuntimeError(f"MANIFEST lists {name} but {path} is missing")
    return names


def flash_estimate(data: bytes, name: str) -> int:
    """Bytes a new file takes on the hub's jffs2: one zlib node (level 3, as
    jffs2 uses) per 4 KiB page, stored raw when that is smaller, plus the
    directory entry. Nodes are 4-byte aligned."""
    total = (JFFS2_DIRENT_HEADER + len(name.encode("utf-8")) + 3) & ~3
    for start in range(0, len(data), JFFS2_PAGE):
        page = data[start : start + JFFS2_PAGE]
        stored = min(len(zlib.compress(page, 3)), len(page))
        total += (JFFS2_NODE_HEADER + stored + 3) & ~3
    return total


def flash_margin(estimate: int) -> int:
    return FLASH_MARGIN_BYTES + estimate * FLASH_MARGIN_PERCENT // 100


def kib(value: int) -> str:
    return f"{(value + 1023) // 1024} KB"


def stage_suffix() -> str:
    """Random staging-dir suffix (the hub has no mktemp)."""
    return secrets.token_hex(6)


def tcp_open(host: str, port: int, timeout: float = 1.2) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def wait_for_port(host: str, port: int, seconds: int, label: str) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if tcp_open(host, port):
            info(f"{label} is reachable on port {port}")
            return
        time.sleep(2)
    raise RuntimeError(f"{label} did not become reachable on port {port} within {seconds} seconds")


class Candidate:
    """One file the installer may place on the hub."""

    def __init__(
        self,
        dest: str,
        mode: str,
        kind: str,
        local: Path | None = None,
        text: str | None = None,
        sensitive: bool = False,
        condition: str = "always",
        blob: bytes | None = None,
    ) -> None:
        self.dest = dest
        self.mode = mode
        self.kind = kind  # binary | runtime | plugin | config
        self.local = local
        self.text = text
        self.blob = blob  # bytes built at install time (the multi-remote hal)
        self.sensitive = sensitive
        self.condition = condition  # always | if-missing
        self.bytes = 0
        self.md5 = ""
        self.flash_bytes = 0
        self.action = "replace"  # replace | create | preserve | unchanged
        self.staged_name = ""
        # An identical file already on the hub that phase 1 hard-links.
        self.link_source = ""

    def data(self) -> bytes:
        if self.blob is not None:
            return self.blob
        if self.local is not None:
            return self.local.read_bytes()
        return (self.text or "").encode("utf-8")

    def prepare(self) -> None:
        data = self.data()
        self.bytes = len(data)
        self.md5 = hashlib.md5(data).hexdigest()
        self.flash_bytes = flash_estimate(data, self.dest.rsplit("/", 1)[-1] + NEW_SUFFIX)


MD5_HEX_RE = re.compile(r"^[0-9a-f]{32}$")
PERM_RE = re.compile(r"^-[r-][w-][xsS-][r-][w-][xsS-][r-][w-][xtT-]$")
FILE_STATUS_TYPES = ("absent", "regular", "symlink", "other")
STATUS_LINE_RE = re.compile(r"^file_status type=(\S+)(?: perm=(\S*) bytes=(\S*) md5=(\S*))? path=(.+)$")


def perm_to_mode(perm: str) -> str:
    """Octal mode from an `ls -l` permission string, e.g. -rwxr-xr-x -> 755."""
    if not PERM_RE.match(perm):
        raise ValueError(perm)
    special = 0
    digits = []
    for index, (shift, flag) in enumerate(((0, 4), (3, 2), (6, 1))):
        r, w, x = perm[1 + shift : 4 + shift]
        value = (4 if r == "r" else 0) + (2 if w == "w" else 0)
        if x in "xst":
            value += 1
        if x in "sStT":
            special |= flag
        digits.append(str(value))
    mode = "".join(digits)
    return f"{special}{mode}" if special else mode


def file_status_command(paths: list[str]) -> str:
    """One BusyBox-only probe for many paths (no stat/readlink on the hub)."""
    quoted = " ".join(remote_quote(p) for p in paths)
    return (
        f"for p in {quoted}; do "
        'if [ -L "$p" ]; then echo "file_status type=symlink path=$p"; '
        'elif [ -f "$p" ]; then set -- $(ls -l "$p"); m=$(md5sum "$p"); '
        'echo "file_status type=regular perm=$1 bytes=$5 md5=${m%% *} path=$p"; '
        'elif [ -e "$p" ]; then echo "file_status type=other path=$p"; '
        'else echo "file_status type=absent path=$p"; fi; done'
    )


def parse_file_status(paths: list[str], raw: str) -> dict[str, dict[str, str]]:
    """Validate probe output into {path: {path, kind, size, mode, md5}}.

    Strict: every requested path must appear exactly once with a known type;
    regular files need a valid permission string, decimal size, and 32-hex
    md5. Fails closed on anything else.
    """
    wanted = set(paths)
    states: dict[str, dict[str, str]] = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        match = STATUS_LINE_RE.match(line)
        if not match:
            raise RuntimeError(f"file-status: unexpected probe line: {line!r}")
        kind, perm, size, md5, path = match.groups()
        if path not in wanted:
            raise RuntimeError(f"file-status: probe reported unexpected path: {path!r}")
        if path in states:
            raise RuntimeError(f"file-status: probe reported {path} twice")
        if kind not in FILE_STATUS_TYPES:
            raise RuntimeError(f"file-status for {path} reported invalid type {kind!r}")
        if kind != "regular":
            if perm is not None:
                raise RuntimeError(f"file-status for {path}: {kind} with file fields: {line!r}")
            states[path] = {"path": path, "kind": kind, "size": "0", "mode": "", "md5": ""}
            continue
        try:
            mode = perm_to_mode(perm or "")
        except ValueError:
            raise RuntimeError(f"file-status for {path} reported invalid permissions {perm!r}")
        if not (size or "").isdigit():
            raise RuntimeError(f"file-status for {path} reported invalid size {size!r}")
        if not MD5_HEX_RE.match(md5 or ""):
            raise RuntimeError(f"file-status for {path}: regular file without a computed md5")
        states[path] = {"path": path, "kind": "regular", "size": size, "mode": mode, "md5": md5}
    missing = wanted - set(states)
    if missing:
        raise RuntimeError(f"file-status: probe output missing {sorted(missing)}")
    return states


class Installer:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.key_path = Path(args.key_path).expanduser().resolve()
        self.first_install = False
        self.stage = ""
        self.preserve_stage = False
        self.candidates: list[Candidate] = []
        # Whether the multi-remote hal runs now; None until checked (--multi-remote only).
        self.hal_bound: bool | None = None
        self.probe: dict[str, dict[str, str]] = {}
        self.handoff_estimate = 0
        self.forward_total = 0
        self.rollback_total = 0
        self.staged_total = 0
        self.ram_free_bytes = 0
        self.ram_required_bytes = 0
        self.verdict = VERDICT_VALIDATION
        self.verdict_reasons: list[str] = []
        self.generations = {"handoff": 0, "resource": 0, "settings": 0, "update": 0}
        self.handoff_dirs: list[str] = []
        self.changed: list[dict[str, object]] = []
        self.new_copies: list[str] = []
        self.hub_id = ""
        # Flash, from codex_flash_free; None when it couldn't be measured.
        self.flash_helper = ""
        self.flash_avail: int | None = None
        self.flash_total = 0
        self.flash_written = 0
        self.flash_required = 0
        self.flash_released = 0
        self.flash_note = ""
        # "preflight" when the measured check blocked, "phase1" when a copy failed.
        self.capacity_stage = ""
        self.root_tool_stages: list[dict[str, object]] = []
        # Inode of each Dropbear copy, by path.
        self.dropbear_copies: dict[str, str] = {}

    # ------------------------------------------------------------------ ssh

    def ssh_base_args(self) -> list[str]:
        return [
            "ssh",
            "-p",
            str(self.args.port),
            "-i",
            str(self.key_path),
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
            f"{self.args.ssh_user}@{self.args.hub_host}",
        ]

    def run_remote_raw(self, command: str, timeout: int = 90) -> tuple[int, bytes, str]:
        """Like run_remote_rc, with stdout left as bytes (for reading a binary)."""
        proc = subprocess.run(
            self.ssh_base_args() + [command],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
        return proc.returncode, proc.stdout, proc.stderr.decode("utf-8", "replace")

    def read_remote_bytes(self, path: str, timeout: int = 120) -> bytes:
        code, out, err = self.run_remote_raw(f"cat {remote_quote(path)}", timeout=timeout)
        if code != 0:
            raise RuntimeError(f"could not read {path} from the hub (exit {code}): {err.strip()}")
        return out

    def run_remote_rc(
        self,
        command: str,
        input_bytes: bytes | None = None,
        timeout: int = 90,
    ) -> tuple[int, str, str]:
        proc = subprocess.run(
            self.ssh_base_args() + [command],
            input=input_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
        return (
            proc.returncode,
            proc.stdout.decode("utf-8", "replace"),
            proc.stderr.decode("utf-8", "replace"),
        )

    def run_remote(
        self,
        command: str,
        input_bytes: bytes | None = None,
        timeout: int = 90,
        quiet: bool = False,
    ) -> str:
        code, stdout, stderr = self.run_remote_rc(command, input_bytes, timeout)
        if code != 0:
            raise RuntimeError(
                "ssh failed with exit {code}\ncommand={cmd}\nstdout={out}\nstderr={err}".format(
                    code=code,
                    cmd=command,
                    out=stdout,
                    err=stderr,
                )
            )
        if stderr.strip() and not quiet:
            print(stderr.strip())
        return stdout

    def remote_md5(self, path: str, timeout: int = 90) -> str:
        code, out, _err = self.run_remote_rc(f"md5sum {remote_quote(path)}", timeout=timeout)
        match = MD5_LINE_RE.match(out.strip()) if code == 0 else None
        return match.group(1) if match and match.group(2) == path else ""

    # ------------------------------------------------------------- staging

    def create_stage(self) -> None:
        step("Creating private staging tree")
        stage = f"{STAGE_PREFIX}{stage_suffix()}"
        if not re.match(r"^/var/volatile/codex-install-[0-9a-z]+$", stage):
            raise RuntimeError(f"unsafe staging path: {stage!r}")
        # mkdir fails if the path already exists, so the tree is ours alone.
        cmd = f"mkdir {remote_quote(stage)} && chmod 700 {remote_quote(stage)} && echo {remote_quote(stage)}"
        out = self.run_remote(cmd, timeout=30).strip()
        if out != stage:
            raise RuntimeError(f"staging tree creation echoed {out!r}, expected {stage!r}")
        self.stage = stage
        kv(f"staging_dir={self.stage}")
        info("mode=0700 owner-only volatile staging; deleted before exit unless rollback needs it")

    def upload_candidates(self) -> None:
        step("Uploading candidates to staging")
        for index, cand in enumerate(self.candidates):
            name = f"{index:02d}-{cand.dest.rsplit('/', 1)[-1]}"
            cand.staged_name = name
            remote = f"{self.stage}/{name}"
            command = (
                f"cat > {remote_quote(remote)} && "
                f"chmod 600 {remote_quote(remote)}"
            )
            timeout = max(90, 45 + int(cand.bytes / 12000))
            self.run_remote(command, cand.data(), timeout=timeout, quiet=True)
            shown = "<hidden>" if cand.sensitive else cand.md5
            kv(f"staged index={index} dest={cand.dest} bytes={cand.bytes} md5={shown}")

    def upload_flash_helper(self) -> None:
        if not FLASH_HELPER.is_file():
            self.flash_note = f"{FLASH_HELPER.relative_to(ROOT)} is missing"
            return
        remote = f"{self.stage}/{FLASH_HELPER_NAME}"
        self.run_remote(
            f"cat > {remote_quote(remote)} && chmod 700 {remote_quote(remote)}",
            FLASH_HELPER.read_bytes(),
            timeout=90,
            quiet=True,
        )
        self.flash_helper = remote
        info(f"staged flash probe {remote} (RAM only, never installed)")

    def measure_flash(self) -> None:
        """Free flash from codex_flash_free; leaves flash_avail None on any doubt."""
        self.flash_avail = None
        if not self.flash_helper:
            return
        code, out, err = self.run_remote_rc(f"{remote_quote(self.flash_helper)} {FLASH_PATH}", timeout=30)
        match = re.search(
            r"^flash type=(0x[0-9a-f]+) total_bytes=(\d+) free_bytes=(\d+) avail_bytes=(\d+) path=(\S+)$",
            out.strip(),
            re.M,
        )
        if code != 0 or not match or match.group(5) != FLASH_PATH:
            self.flash_note = f"the flash probe didn't answer ({(err or out).strip()[:120] or f'exit {code}'})"
            return
        total, avail = int(match.group(2)), int(match.group(4))
        if not (1048576 <= total <= 64 * 1048576) or avail > total:
            self.flash_note = f"the flash probe reported an unlikely size (total {total}, available {avail})"
            return
        self.flash_total = total
        self.flash_avail = avail
        self.flash_note = ""

    def verify_stage_md5(self) -> None:
        step("Verifying staged candidate MD5 (strict BusyBox format)")
        entries = [(c.staged_name, c.md5, c.dest) for c in self.candidates if not c.sensitive]
        paths = " ".join(remote_quote(f"{self.stage}/{name}") for name, _, _ in entries)
        out = self.run_remote(f"md5sum {paths}", timeout=120)
        expected = {f"{self.stage}/{name}": md5 for name, md5, _ in entries}
        seen: set[str] = set()
        for line in out.splitlines():
            match = MD5_LINE_RE.match(line.strip())
            if not match:
                raise RuntimeError(f"unexpected md5sum output line: {line!r}")
            digest, path = match.group(1), match.group(2)
            if path not in expected:
                raise RuntimeError(f"md5sum reported unexpected path: {path!r}")
            if digest != expected[path]:
                raise RuntimeError(f"staged md5 mismatch for {path}: expected {expected[path]} got {digest}")
            seen.add(path)
        missing = set(expected) - seen
        if missing:
            raise RuntimeError(f"md5sum output missing entries: {sorted(missing)}")
        sensitive_paths = [f"{self.stage}/{c.staged_name}" for c in self.candidates if c.sensitive]
        if sensitive_paths:
            out = self.run_remote("md5sum " + " ".join(remote_quote(p) for p in sensitive_paths), timeout=60)
            expected_s = {f"{self.stage}/{c.staged_name}": c.md5 for c in self.candidates if c.sensitive}
            seen_s: set[str] = set()
            for line in out.splitlines():
                match = MD5_LINE_RE.match(line.strip())
                if not match or match.group(2) not in expected_s or match.group(1) != expected_s[match.group(2)]:
                    raise RuntimeError("staged sensitive candidate failed md5 verification")
                seen_s.add(match.group(2))
            if seen_s != set(expected_s):
                raise RuntimeError("staged sensitive candidate failed md5 verification")
        info("all staged candidates verified")

    # ----------------------------------------------------------- inventory

    def build_mqtt_config(self) -> str:
        broker = self.args.mqtt_broker or ""
        enabled = bool(broker) and not self.args.mqtt_disabled
        cfg = {
            "enabled": enabled,
            "name": "Harmony Hub",
            "clientId": self.args.mqtt_client_id,
            "baseTopic": self.args.mqtt_base_topic.strip("/"),
            "discoveryPrefix": self.args.mqtt_discovery_prefix.strip("/"),
            "haDiscovery": True,
            "pollSeconds": 10,
            "keepAlive": 60,
            "broker": {
                "host": broker,
                "port": self.args.mqtt_port,
                "username": self.args.mqtt_user or "",
                "password": self.args.mqtt_password or "",
            },
        }
        return json.dumps(cfg, separators=(",", ":")) + "\n"

    def mqtt_explicit(self) -> bool:
        return bool(getattr(self.args, "mqtt_explicit_supplied", False))

    def build_inventory(self) -> None:
        clean = self.args.clean_install
        candidates: list[Candidate] = []

        bin_names = bin_manifest_names()
        for name in bin_names:
            if name == "codex_webui":
                continue  # webui is installed last, after every noncritical file
            candidates.append(
                Candidate(f"/data/codex/bin/{name}", "755", "binary", local=PAYLOAD / "bin" / name)
            )
        candidates.append(
            Candidate("/usr/sbin/dropbear", "755", "binary", local=PAYLOAD / "scripts" / "dropbear")
        )
        candidates.append(
            Candidate("/usr/sbin/dropbearkey", "755", "binary", local=PAYLOAD / "scripts" / "dropbearkey")
        )

        candidates.extend(
            [
                Candidate("/data/codex/init.sh", "755", "runtime", local=PAYLOAD / "scripts" / "init.sh"),
                Candidate(
                    "/data/codex/offline_egress_guard.sh",
                    "755",
                    "runtime",
                    local=PAYLOAD / "scripts" / "offline_egress_guard.sh",
                ),
                Candidate(
                    "/data/codex/recovery_ap.sh", "755", "runtime", local=PAYLOAD / "scripts" / "recovery_ap.sh"
                ),
                Candidate(
                    "/data/codex/androidtv_service.sh", "755", "runtime", local=PAYLOAD / "scripts" / "androidtv_service.sh"
                ),
                Candidate(
                    "/data/codex/usb_eth_service.sh", "755", "runtime", local=PAYLOAD / "scripts" / "usb_eth_service.sh"
                ),
                Candidate(
                    "/data/codex/modules/usb-net/r8152.ko", "644", "runtime", local=PAYLOAD / "modules" / "usb-net" / "r8152.ko"
                ),
                Candidate(
                    "/data/codex/modules/usb-net/usbnet.ko", "644", "runtime", local=PAYLOAD / "modules" / "usb-net" / "usbnet.ko"
                ),
                Candidate(
                    "/data/codex/modules/usb-net/asix.ko", "644", "runtime", local=PAYLOAD / "modules" / "usb-net" / "asix.ko"
                ),
                Candidate(
                    "/data/codex/modules/usb-net/cdc_ether.ko", "644", "runtime", local=PAYLOAD / "modules" / "usb-net" / "cdc_ether.ko"
                ),
                Candidate(
                    "/data/codex/modules/usb-net/cdc_ncm.ko", "644", "runtime", local=PAYLOAD / "modules" / "usb-net" / "cdc_ncm.ko"
                ),
                Candidate(
                    "/data/codex/modules/usb-net/ax88179_178a.ko", "644", "runtime", local=PAYLOAD / "modules" / "usb-net" / "ax88179_178a.ko"
                ),
                Candidate(
                    "/data/codex/modules/usb-net/README.md", "644", "runtime", local=PAYLOAD / "modules" / "usb-net" / "README.md"
                ),
                Candidate("/etc/init.d/rcS.local", "755", "runtime", local=PAYLOAD / "scripts" / "rcS.local"),
            ]
        )
        if not self.args.skip_cloud_suppression:
            candidates.append(
                Candidate(
                    "/opt/luaworks/tasks/connectserver/netservicestarter.lua",
                    "644",
                    "runtime",
                    local=PAYLOAD / "scripts" / "netservicestarter.lua",
                )
            )
        candidates.extend(
            [
                Candidate(
                    "/pkg/codexactivity/codexactivity.lua",
                    "644",
                    "plugin",
                    local=PAYLOAD / "activity" / "codexactivity.lua",
                ),
                Candidate(
                    "/pkg/codexmqtt/codexmqtt.lua", "644", "plugin", local=PAYLOAD / "mqtt" / "codexmqtt.lua"
                ),
            ]
        )

        # Configuration: generated only in clean mode or when explicitly supplied.
        hub_id_explicit = bool(self.args.hub_id)
        if clean or hub_id_explicit:
            candidates.append(Candidate("/data/codex/hub_id", "644", "config", text=f"{self.hub_id}\n"))
        if clean:
            candidates.append(
                Candidate(
                    "/data/codex/cloud_blocker.conf",
                    "644",
                    "config",
                    text="0\n" if self.args.skip_cloud_suppression else "1\n",
                )
            )
        elif not self.args.skip_cloud_suppression:
            # Without the file, codex_webui and netservicestarter.lua treat the
            # cloud as blocked but the egress guard and the activity writer
            # don't: create it, and keep whatever value is already there.
            candidates.append(
                Candidate("/data/codex/cloud_blocker.conf", "644", "config", text="1\n", condition="if-missing")
            )
        for dest, text in (
            ("/etc/tdeenable", "1\n"),
            ("/pkg/codexactivity/manifest.json", '{"plugin":"codexactivity"}\n'),
            ("/pkg/codexmqtt/manifest.json", '{"plugin":"codexmqtt"}\n'),
        ):
            candidates.append(Candidate(dest, "644", "config", text=text, condition="if-missing"))
        # Multiple remotes of one model: only when asked, either way.
        if self.args.multi_remote == "on":
            hal = patched_hal(self.read_remote_bytes(HAL_PATH))
            candidates.append(Candidate(HAL_MULTI_DEST, "755", "binary", blob=hal))
            candidates.append(Candidate(MULTI_REMOTE_CONF, "644", "config", text="1\n"))
        elif self.args.multi_remote == "off":
            # The copy itself goes after a successful install (post_install_wiring).
            candidates.append(Candidate(MULTI_REMOTE_CONF, "644", "config", text="0\n"))
        if clean or self.mqtt_explicit():
            candidates.append(
                Candidate(
                    "/data/codexmqtt/config.json",
                    "600",
                    "config",
                    text=self.build_mqtt_config(),
                    sensitive=True,
                )
            )

        # codex_webui is always the final replacement.
        candidates.append(Candidate(WEBUI_DEST, "755", "binary", local=PAYLOAD / "bin" / "codex_webui"))

        for cand in candidates:
            cand.prepare()
        self.candidates = candidates

    # ------------------------------------------------------------ discovery

    def file_status(self, paths: list[str]) -> dict[str, dict[str, str]]:
        code, out, err = self.run_remote_rc(file_status_command(paths), timeout=180)
        if code != 0:
            self.fail_validation(f"file-status probe failed (exit {code}): {err.strip()}")
        try:
            return parse_file_status(paths, out)
        except RuntimeError as exc:
            self.fail_validation(str(exc))
        raise AssertionError("unreachable")

    def probe_destinations(self) -> None:
        step("Probing destination state (BusyBox ls -l / md5sum)")
        dests = [c.dest for c in self.candidates]
        dests += [p for p in HANDOFF_REQUIRED_PATHS + [ROOT_TOOL_DROPBEAR, HAL_MULTI_DEST] if p not in dests]
        self.probe = self.file_status(dests)
        for cand in self.candidates:
            if self.probe[cand.dest]["kind"] in ("symlink", "other"):
                self.fail_validation(
                    f"destination {cand.dest} is a {self.probe[cand.dest]['kind']}, not a regular file"
                )

    def fail_validation(self, reason: str) -> None:
        self.verdict = VERDICT_VALIDATION
        self.verdict_reasons.append(reason)
        raise RuntimeError(reason)

    def resolve_hub_id(self) -> None:
        hub_id = self.args.hub_id or ""
        existing = self.run_remote("cat /data/codex/hub_id 2>/dev/null || true", timeout=30).strip()
        if not existing and not self.args.clean_install:
            # A hub without /data/codex/hub_id has no configuration of ours to
            # preserve, so the first install writes it, as --clean-install does.
            self.args.clean_install = True
            self.first_install = True
            info("first install: the hub has no /data/codex/hub_id yet, so this run writes the configuration (as --clean-install)")
        if not hub_id:
            if existing:
                hub_id = existing
                info(f"hub id from existing /data/codex/hub_id: {hub_id}")
            else:
                saved = resolve_saved_hub_id(self.args.hub_host)
                if saved:
                    hub_id, source = saved
                    info(f"hub id from root-tool handoff: {hub_id} ({source})")
        if not valid_hub_id(hub_id):
            if hub_id:
                raise RuntimeError(f"Invalid Hub ID {hub_id!r}. Re-run the root tool or pass --hub-id with the numeric value.")
            raise RuntimeError(
                "Hub ID is required. Re-run the root tool so it writes the handoff file, "
                "or pass --hub-id with the numeric value printed as hub_id=..."
            )
        self.hub_id = hub_id
        info(f"using hub id {hub_id}")

    def apply_upgrade_gates(self) -> None:
        """Decide replace/create/preserve/unchanged per candidate from probe state."""
        for cand in self.candidates:
            state = self.probe.get(cand.dest, {})
            exists = state.get("kind") == "regular"
            if cand.condition == "if-missing" and exists and not self.args.clean_install:
                cand.action = "preserve"
            elif exists and state.get("md5") == cand.md5 and state.get("mode") == cand.mode:
                cand.action = "unchanged"
            elif exists:
                cand.action = "replace"
            else:
                cand.action = "create"
        # Upgrade mode: hub_id must exist or be explicitly supplied.
        hub_state = self.probe.get("/data/codex/hub_id", {})
        if not self.args.clean_install and hub_state.get("kind") != "regular" and not any(
            c.dest == "/data/codex/hub_id" for c in self.candidates
        ):
            self.verdict = VERDICT_CONFIG_UNCERTAIN
            self.verdict_reasons.append(
                "upgrade mode: /data/codex/hub_id missing and no explicit --hub-id supplied"
            )

    def plan_dropbear_link(self) -> None:
        """Reuse harmony-hub-root's dropbearmulti when it is byte-identical."""
        source = self.probe.get(ROOT_TOOL_DROPBEAR, {})
        for cand in self.candidates:
            if (
                cand.dest == DROPBEAR_DEST
                and cand.action in ("replace", "create")
                and source.get("kind") == "regular"
                and source.get("md5") == cand.md5
            ):
                cand.link_source = ROOT_TOOL_DROPBEAR

    def scan_root_tool_leftovers(self) -> None:
        out = self.run_remote(ROOT_TOOL_SCAN, timeout=60, quiet=True)
        self.root_tool_stages = []
        self.dropbear_copies = {}
        for line in out.splitlines():
            line = line.strip()
            stage = re.match(r"^root_tool_stage bytes=(\d+) files=(\d+) path=(\S+)$", line)
            if stage and ROOT_TOOL_STAGE_RE.match(stage.group(3)):
                self.root_tool_stages.append(
                    {"path": stage.group(3), "bytes": int(stage.group(1)), "files": int(stage.group(2))}
                )
                continue
            copy = re.match(r"^dropbear_copy inode=(\d+) path=(\S+)$", line)
            if copy and copy.group(2) in (ROOT_TOOL_DROPBEAR, DROPBEAR_DEST):
                self.dropbear_copies[copy.group(2)] = copy.group(1)

    def root_tool_dropbear_removable(self) -> bool:
        """True when the root tool's Dropbear is a separate copy that SSH no
        longer uses and phase 1 won't link."""
        ours = self.dropbear_copies.get(DROPBEAR_DEST)
        theirs = self.dropbear_copies.get(ROOT_TOOL_DROPBEAR)
        wrapper = next((c for c in self.candidates if c.dest == "/usr/sbin/dropbear"), None)
        return bool(
            ours
            and theirs
            and ours != theirs
            and wrapper is not None
            and self.probe.get("/usr/sbin/dropbear", {}).get("md5") == wrapper.md5
            and not any(c.link_source == ROOT_TOOL_DROPBEAR for c in self.candidates)
        )

    def leftover_credit(self) -> int:
        """Flash the removable root-tool leftovers are estimated to free."""
        # Base64 chunks compress to about two thirds; count three fifths.
        credit = sum(int(s["bytes"]) * 3 // 5 for s in self.root_tool_stages)
        if self.root_tool_dropbear_removable():
            dropbear = next((c for c in self.candidates if c.dest == DROPBEAR_DEST), None)
            if dropbear is not None:
                credit += dropbear.flash_bytes
        return credit

    def active_candidates(self) -> list[Candidate]:
        return [c for c in self.candidates if c.action in ("replace", "create")]

    def ram_status(self) -> None:
        """Usable RAM from /proc/meminfo; staging and rollback copies live in tmpfs.

        The hub kernel has no MemAvailable, so credit what the kernel reclaims for
        tmpfs on demand: inactive file cache and reclaimable slab. On a 32 MB hub
        MemFree alone is about 1 MiB after staging while about 8 MiB is reclaimable.
        """
        out = self.run_remote("cat /proc/meminfo", timeout=30, quiet=True)
        fields = dict(re.findall(r"^(\S+):\s+(\d+) kB$", out, re.M))
        if "MemFree" not in fields:
            self.fail_validation("could not read MemFree from /proc/meminfo")
        kb = sum(int(fields.get(name, 0)) for name in ("MemFree", "Inactive(file)", "SReclaimable"))
        self.ram_free_bytes = kb * 1024

    def build_plans(self) -> None:
        step("Planning changed destinations")
        self.forward_total = 0
        self.rollback_total = 0
        self.staged_total = sum(c.bytes for c in self.candidates)
        copies = 0
        self.flash_released = 0
        for cand in self.candidates:
            state = self.probe.get(cand.dest, {})
            if cand.action in ("replace", "create"):
                self.forward_total += cand.bytes
                if not cand.link_source:
                    copies += cand.flash_bytes
            if cand.action == "replace":
                old = int(state.get("size", "0"))
                self.rollback_total += old
                # The replaced original's flash comes back after the rename;
                # assume it compressed like its replacement.
                self.flash_released += cand.flash_bytes * old // max(cand.bytes, 1)
            kv(
                f"destination dest={cand.dest} exists={1 if state.get('kind') == 'regular' else 0} "
                f"action={cand.action} bytes={cand.bytes} mode={cand.mode}"
                + (f" link={cand.link_source}" if cand.link_source else "")
            )
        # Staged candidates already occupy RAM; rollback copies are added next.
        self.ram_required_bytes = self.rollback_total + RAM_MARGIN_BYTES
        # Phase 1 writes every new copy before any original goes, after the
        # handoff backup: text the installer hasn't read, assumed to halve.
        handoff = self.handoff_estimate // 2 + 1024 if self.active_candidates() else 0
        self.flash_written = copies + handoff
        self.flash_required = self.flash_written + (flash_margin(copies) if copies else 0)

    def flash_after(self) -> int:
        """Estimated free flash once the install (and any opted-in cleanup) is done."""
        credit = self.leftover_credit() if self.args.remove_root_tool_leftovers else 0
        return max(0, (self.flash_avail or 0) + credit - self.flash_written + self.flash_released)

    def flash_shortfall(self, credit: int = 0) -> int:
        """Bytes of flash missing for phase 1; 0 when enough or not measured."""
        if self.flash_avail is None:
            return 0
        return max(0, self.flash_required - self.flash_avail - credit)

    def update_flash_need(self) -> int:
        """Flash a later codex_webui update needs while both copies exist."""
        webui = next(c for c in self.candidates if c.dest == WEBUI_DEST)
        return webui.flash_bytes + flash_margin(webui.flash_bytes)

    def count_backup_generations(self) -> None:
        cmd = (
            "for d in /data/codex-backups /data/codex/resource-backups /data/codex/update-backups; do "
            '[ -d "$d" ] || continue; for n in "$d"/*; do [ -e "$n" ] && echo "$n"; done; done'
        )
        out = self.run_remote(cmd, timeout=30, quiet=True)
        stamp_re = re.compile(r"^\d{8}-\d{6}$")
        for line in out.splitlines():
            path = line.strip()
            name = path.rsplit("/", 1)[-1]
            if name.startswith("webui-handoff-") and stamp_re.match(name[len("webui-handoff-"):]):
                self.generations["handoff"] += 1
                if path == f"{HANDOFF_ROOT}/{name}":
                    self.handoff_dirs.append(path)
            elif name.startswith("settings_") and re.match(r"^\d{8}_\d{6}$", name[len("settings_"):]):
                self.generations["settings"] += 1
            elif re.match(r"^\d{8}_\d{6}$", name):
                self.generations["resource"] += 1
            elif name.isdigit():
                self.generations["update"] += 1

    def compute_handoff_estimate(self) -> None:
        self.handoff_estimate = sum(
            int(state.get("size", "0"))
            for path, state in self.probe.items()
            if path in HANDOFF_REQUIRED_PATHS and state.get("kind") == "regular"
        )

    def decide_verdict(self) -> None:
        if self.verdict == VERDICT_CONFIG_UNCERTAIN:
            return
        credit = self.leftover_credit() if self.args.remove_root_tool_leftovers else 0
        if self.ram_free_bytes < self.ram_required_bytes:
            self.verdict = VERDICT_ROLLBACK_CAPACITY
            self.verdict_reasons.append(
                f"free RAM {self.ram_free_bytes} < rollback copies + margin {self.ram_required_bytes}"
            )
        elif self.flash_shortfall(credit) and not self.args.skip_flash_check:
            self.verdict = VERDICT_CAPACITY
            self.capacity_stage = "preflight"
            self.verdict_reasons.append(
                f"free flash {self.flash_avail} < estimated need {self.flash_required}"
                + (f" (after about {credit} freed from root-tool leftovers)" if credit else "")
            )
        else:
            self.verdict = VERDICT_ALLOWED

    # -------------------------------------------------------------- report

    def render_preflight_report(self) -> None:
        # NOTE(InstallerCliUX): human-facing step/info strings in this method
        # are owned by InstallerCliUX; key=value lines are the stable contract.
        step("Preflight report")
        info(
            "Status so far uses private volatile staging under "
            "/var/volatile/codex-install-* only."
        )
        info(
            "No persistent hub paths have been written, pruned, handed off, "
            "installed, or restarted yet."
        )
        if self.args.preflight_only:
            info(
                "Mode: --preflight-only — stages, verifies, compares, and "
                "prints a terminal verdict; performs no persistent writes "
                "and no service actions."
            )
        if self.first_install:
            info(
                "Install mode: first install — the hub has no configuration "
                "of ours yet, so configuration candidates are written."
            )
        elif self.args.clean_install:
            info(
                "Install mode: explicit clean install — configuration "
                "candidates are regenerated."
            )
        else:
            info(
                "Install mode: default upgrade — existing configuration is "
                "preserved unless a candidate explicitly replaces it."
            )
        kv(f"preflight_mode={'clean' if self.args.clean_install else 'upgrade'}")
        kv(f"multi_remote={'force-off' if self.args.multi_remote_force else self.args.multi_remote or 'unchanged'}")
        if self.args.multi_remote == "on":
            info(
                f"Multiple remotes of one model: {HAL_MULTI_DEST} is the hub's own hal "
                f"(md5 {HAL_STOCK_MD5}) with per-slot remote threads and the one-remote-per-model "
                "rule lifted for remotes without a screen; rcS.local runs it from the next boot."
            )
        kv(f"candidate_count={len(self.candidates)}")
        kv(f"changed_count={len(self.active_candidates())}")
        info(
            "Candidate destinations and nonsensitive expected MD5 hashes "
            "(sensitive values redacted):"
        )
        for index, cand in enumerate(self.candidates):
            shown = "<hidden>" if cand.sensitive else cand.md5
            kv(
                f"candidate index={index} dest={cand.dest} bytes={cand.bytes} md5={shown} "
                f"mode={cand.mode} kind={cand.kind} action={cand.action} flash={cand.flash_bytes}"
            )
            info(
                f"candidate[{index}] path={cand.dest} expected_md5={shown} "
                f"bytes={cand.bytes} mode={cand.mode} action={cand.action}"
            )
        if not self.args.clean_install:
            kv(f"protected_upgrade_paths={','.join(UPGRADE_PROTECTED_PATHS)}")
            info(
                "Upgrade protects existing configuration at: "
                + ", ".join(UPGRADE_PROTECTED_PATHS)
            )
        kv(
            f"backup_generations handoff={self.generations['handoff']} "
            f"resource={self.generations['resource']} settings={self.generations['settings']} "
            f"update={self.generations['update']}"
        )
        kv(f"handoff_estimate_bytes={self.handoff_estimate}")
        kv(f"flash_capacity_check={'two-phase-commit' if self.flash_avail is None else 'measured'}")
        kv(f"forward_total_bytes={self.forward_total}")
        kv(f"rollback_total_bytes={self.rollback_total}")
        kv(f"staged_total_bytes={self.staged_total}")
        kv(f"ram_free_bytes={self.ram_free_bytes}")
        kv(f"ram_required_bytes={self.ram_required_bytes}")
        kv(f"flash_required_bytes={self.flash_required}")
        if self.flash_avail is not None:
            kv(f"flash_total_bytes={self.flash_total}")
            kv(f"flash_free_bytes={self.flash_avail}")
            kv(f"flash_after_bytes={self.flash_after()}")
        self.render_flash_report()
        info(
            f"RAM: free={self.ram_free_bytes} required={self.ram_required_bytes} "
            f"(rollback copies {self.rollback_total} + margin {RAM_MARGIN_BYTES})"
        )
        for reason in self.verdict_reasons:
            kv(f"verdict_reason={reason}")
            info(f"verdict_reason: {reason}")
        self.render_verdict()

    def render_flash_report(self) -> None:
        # NOTE(InstallerCliUX): human-facing prose; the key=value lines are
        # the stable contract.
        if self.flash_avail is None:
            info(
                f"Free flash couldn't be measured ({self.flash_note}): changed files "
                f"(about {kib(self.flash_written)} on flash) are written as {NEW_SUFFIX} copies "
                "first, and the install stops with no live changes if flash fills up."
            )
        else:
            info(
                f"Flash: {kib(self.flash_avail)} free of {kib(self.flash_total)}. The changed files "
                f"need about {kib(self.flash_required)} while old and new copies both exist "
                "(an estimate with a safety margin)."
            )
            if self.flash_shortfall() and self.args.skip_flash_check:
                info("--skip-flash-check: installing anyway; the install stops with no live changes if flash fills up.")
            after = self.flash_after()
            info(f"About {kib(after)} will be free afterwards.")
            if after < self.update_flash_need():
                info(
                    f"That is less than the {kib(self.update_flash_need())} a later web UI update "
                    "needs. Free some space before updating (see the README)."
                )
        for cand in self.active_candidates():
            if cand.link_source:
                kv(f"flash_link dest={cand.dest} source={cand.link_source}")
                info(
                    f"{cand.dest}: harmony-hub-root's identical copy at {cand.link_source} is reused "
                    "as a hard link, so it takes no extra flash."
                )
        leftovers = [(str(s["path"]), int(s["bytes"]), int(s["files"])) for s in self.root_tool_stages]
        if self.root_tool_dropbear_removable():
            leftovers.append((ROOT_TOOL_DROPBEAR, int(self.probe[ROOT_TOOL_DROPBEAR]["size"]), 1))
        for path, size, files in leftovers:
            kv(f"root_tool_leftover bytes={size} files={files} path={path}")
            what = "a second copy of Dropbear that SSH no longer uses" if path == ROOT_TOOL_DROPBEAR else "staging files"
            info(f"harmony-hub-root left {path} behind: {what}, {kib(size)} in {files} file(s).")
        if leftovers:
            if self.args.remove_root_tool_leftovers and not self.args.preflight_only:
                info("They are removed before the install (--remove-root-tool-leftovers).")
            else:
                info("Run the installer with --remove-root-tool-leftovers to remove them and free that flash.")

    def render_verdict(self) -> None:
        # NOTE(InstallerCliUX): human-facing verdict prose is owned by
        # InstallerCliUX; the verdict= key=value line is the stable contract.
        kv(f"verdict={self.verdict}")
        info(f"Terminal verdict: {self.verdict}")
        if self.verdict == VERDICT_ALLOWED:
            info("ALLOWED — validation and RAM headroom are sufficient for the selected mode.")
            if self.args.preflight_only:
                info(
                    "Preflight-only complete: volatile staging will be removed; "
                    "no persistent changes or service actions were performed."
                )
            else:
                info(
                    "Persistent install may proceed after this report "
                    f"({NEW_SUFFIX} copies, then same-directory renames)."
                )
        elif self.verdict == VERDICT_CAPACITY and self.capacity_stage == "preflight":
            info(
                f"BLOCKED_CAPACITY — not enough free flash: about {kib(self.flash_required)} needed, "
                f"{kib(self.flash_avail or 0)} free. Nothing was installed."
            )
            if (self.root_tool_stages or self.root_tool_dropbear_removable()) and not self.args.remove_root_tool_leftovers:
                info(
                    f"Removing harmony-hub-root's leftovers (--remove-root-tool-leftovers) frees about "
                    f"{kib(self.leftover_credit())}."
                )
            info(
                "Otherwise free space on the hub, or pass --skip-flash-check to try anyway: "
                "the install still stops with no live changes if flash fills up."
            )
        elif self.verdict == VERDICT_CAPACITY:
            info(
                "BLOCKED_CAPACITY — flash filled up while writing the new copies; "
                "they were removed and no live file changed."
            )
        elif self.verdict == VERDICT_ROLLBACK_CAPACITY:
            info(
                "BLOCKED_ROLLBACK_CAPACITY — not enough free RAM to hold rollback "
                "copies of the files being replaced. No persistent changes."
            )
        elif self.verdict == VERDICT_CONFIG_UNCERTAIN:
            info(
                "BLOCKED_CONFIGURATION_UNCERTAINTY — required configuration "
                "state is missing or ambiguous for default upgrade; pass "
                "--hub-id or use --clean-install. No persistent changes."
            )
        else:
            info(
                "BLOCKED_VALIDATION_FAILURE — staging, path, hash, or probe "
                "validation failed; see verdict_reason lines above. "
                "No persistent changes."
            )

    # -------------------------------------------------------------- mutate

    def stage_rollback_copies(self) -> None:
        step("Preparing volatile rollback copies")
        # Build rollback records in candidate install order (replaces and
        # creates interleaved) so reversed() rollback is true reverse order.
        for index, cand in enumerate(self.candidates):
            if cand.action == "replace":
                state = self.probe[cand.dest]
                rb = f"{self.stage}/rb-{index:02d}-{cand.dest.rsplit('/', 1)[-1]}"
                cmd = (
                    f"cp -p {remote_quote(cand.dest)} {remote_quote(rb)} && "
                    f"chmod 600 {remote_quote(rb)} && "
                    f"md5sum {remote_quote(rb)}"
                )
                out = self.run_remote(cmd, timeout=90, quiet=True)
                match = MD5_LINE_RE.match(out.strip().splitlines()[-1])
                if not match or match.group(1) != state.get("md5"):
                    raise RuntimeError(f"rollback copy verification failed for {cand.dest}")
                self.changed.append(
                    {
                        "dest": cand.dest,
                        "mode": state.get("mode", cand.mode),
                        "md5": state.get("md5", ""),
                        "rb": rb,
                        "was_absent": False,
                        "done": False,
                    }
                )
                shown = "<hidden>" if cand.sensitive else state.get("md5")
                info(f"rollback copy ready dest={cand.dest} mode={state.get('mode')} md5={shown}")
            elif cand.action == "create":
                self.changed.append(
                    {
                        "dest": cand.dest,
                        "mode": cand.mode,
                        "md5": "",
                        "rb": "",
                        "was_absent": True,
                        "done": False,
                    }
                )

    def prune_handoffs(self) -> None:
        """Keep only the newest HANDOFF_KEEP installer handoff generations.

        Only installer-owned webui-handoff-<stamp> directories directly under
        HANDOFF_ROOT are ever removed; other backups are never touched.
        """
        step(f"Pruning installer handoff backups (keeping newest {HANDOFF_KEEP})")
        old = sorted(self.handoff_dirs)[: max(0, len(self.handoff_dirs) - HANDOFF_KEEP)]
        for path in old:
            if not re.match(rf"^{re.escape(HANDOFF_ROOT)}/webui-handoff-\d{{8}}-\d{{6}}$", path):
                raise RuntimeError(f"refusing to prune unexpected path {path!r}")
            code, _out, err = self.run_remote_rc(f"rm -rf {remote_quote(path)}", timeout=60)
            if code != 0:
                info(f"warning: could not prune {path}: {err.strip()}")
            else:
                kv(f"pruned={path}")
        if not old:
            info("nothing to prune")

    def create_handoff(self) -> None:
        step("Creating bounded handoff backup")
        sized: list[tuple[str, int]] = []
        for path in HANDOFF_REQUIRED_PATHS:
            state = self.probe.get(path, {})
            if state.get("kind") == "regular":
                sized.append((path, int(state.get("size", "0"))))
        cmd = (
            "S=$(date -u +%Y%m%d-%H%M%S); "
            f"B={HANDOFF_ROOT}; "
            'I="$B/.incomplete-webui-handoff-$S"; '
            'mkdir -p "$B" || exit 1; '
            'mkdir "$I" || exit 1; '
            "tot=0; "
        )
        for path, size in sized:
            cmd += (
                f"sz={size}; "
                f"if [ $((tot + sz)) -le {HANDOFF_BUDGET_BYTES} ]; then "
                f"n=$(echo {remote_quote(path)} | sed 's#/#_#g'); "
                f'cp -p {remote_quote(path)} "$I/$n" || {{ rm -rf "$I"; exit 1; }}; '
                "tot=$((tot + sz)); "
                f'else echo "handoff_skipped={path}"; fi; '
            )
        cmd += (
            'mv "$I" "$B/webui-handoff-$S" || { rm -rf "$I"; exit 1; }; '
            'echo "handoff=$B/webui-handoff-$S"'
        )
        out = self.run_remote(cmd, timeout=120)
        for line in out.strip().splitlines():
            info(line)
        created = [line[len("handoff="):] for line in out.strip().splitlines() if line.startswith("handoff=")]
        if not created:
            raise RuntimeError("handoff directory rename did not complete")
        self.handoff_dirs.append(created[-1])

    def remove_root_tool_leftovers(self) -> None:
        """Delete harmony-hub-root's staging folders and, while SSH runs ours,
        its spare Dropbear. Opted in with --remove-root-tool-leftovers; not
        rolled back, since nothing reads them."""
        step("Removing harmony-hub-root leftovers")
        for stage in self.root_tool_stages:
            path = str(stage["path"])
            if not ROOT_TOOL_STAGE_RE.match(path):
                raise RuntimeError(f"refusing to remove unexpected path {path!r}")
            code, _out, err = self.run_remote_rc(f"rm -rf {remote_quote(path)}", timeout=120)
            if code != 0:
                info(f"warning: could not remove {path}: {err.strip()}")
            else:
                kv(f"removed_leftover={path}")
        if self.root_tool_dropbear_removable():
            code, out, _err = self.run_remote_rc(ROOT_TOOL_DROPBEAR_REMOVE, timeout=30)
            if code == 0 and out.strip() == "removed":
                kv(f"removed_leftover={ROOT_TOOL_DROPBEAR}")
            else:
                info(f"kept {ROOT_TOOL_DROPBEAR}: SSH doesn't run the installed Dropbear yet")
        self.scan_root_tool_leftovers()
        self.measure_flash()
        if self.flash_avail is not None:
            kv(f"flash_free_after_cleanup_bytes={self.flash_avail}")
            info(f"Flash free after removing them: {kib(self.flash_avail)}.")

    def report_flash_after_install(self) -> None:
        self.measure_flash()
        if self.flash_avail is None:
            return
        kv(f"flash_free_after_bytes={self.flash_avail}")
        info(f"Flash free after the install: {kib(self.flash_avail)}.")
        if self.flash_avail < self.update_flash_need():
            info(
                f"A later web UI update needs about {kib(self.update_flash_need())}. "
                "Free some space before updating (see the README)."
            )

    def remove_new_copies(self) -> list[str]:
        """Remove every <dest>.codex-new this run wrote; return those that failed."""
        failed = []
        for path in self.new_copies:
            code, _out, _err = self.run_remote_rc(f"rm -f {remote_quote(path)}", timeout=30)
            if code != 0:
                failed.append(path)
        self.new_copies = []
        return failed

    def link_new_copy(self, cand: Candidate, new: str) -> bool:
        """Hard-link an identical file already on the hub as <dest>.codex-new."""
        code, out, err = self.run_remote_rc(
            f"ln {remote_quote(cand.link_source)} {remote_quote(new)} && "
            f"chmod {remote_quote(cand.mode)} {remote_quote(new)} && "
            f"md5sum {remote_quote(new)}",
            timeout=60,
        )
        lines = out.strip().splitlines()
        match = MD5_LINE_RE.match(lines[-1]) if code == 0 and lines else None
        if match and match.group(1) == cand.md5:
            info(f"linked dest={new} to {cand.link_source} (no extra flash)")
            return True
        self.run_remote_rc(f"rm -f {remote_quote(new)}", timeout=30)
        info(f"could not link {cand.link_source} ({err.strip() or 'verification failed'}); copying instead")
        return False

    def write_new_copies(self) -> None:
        """Phase 1: write and verify <dest>.codex-new next to every changed dest."""
        step(f"Phase 1: writing verified {NEW_SUFFIX} copies (no live file changes)")
        for cand in self.active_candidates():
            new = cand.dest + NEW_SUFFIX
            self.new_copies.append(new)
            if cand.link_source and self.link_new_copy(cand, new):
                continue
            cmd = (
                f"cp {remote_quote(f'{self.stage}/{cand.staged_name}')} {remote_quote(new)} && "
                f"chmod {remote_quote(cand.mode)} {remote_quote(new)} && "
                f"md5sum {remote_quote(new)}"
            )
            code, out, err = self.run_remote_rc(cmd, timeout=180)
            lines = out.strip().splitlines()
            match = MD5_LINE_RE.match(lines[-1]) if code == 0 and lines else None
            if not match or match.group(1) != cand.md5:
                left = self.remove_new_copies()
                reason = err.strip() or "copy verification failed"
                if left:
                    raise InstallFailure(
                        f"could not write {new} ({reason}) and could not remove {left}"
                    )
                raise CapacityAbort(f"could not write {new}: {reason}")
            info(f"staged dest={new} bytes={cand.bytes}")

    def install_sequence(self) -> None:
        """Phase 2: rename each verified copy over its destination, codex_webui last."""
        step("Phase 2: renaming new copies into place (codex_webui last)")
        for cand in self.active_candidates():
            new = cand.dest + NEW_SUFFIX
            code, _out, err = self.run_remote_rc(
                f"mv -f {remote_quote(new)} {remote_quote(cand.dest)}", timeout=60
            )
            if code != 0:
                raise InstallFailure(f"rename failed for {cand.dest}: {err.strip()}")
            self.new_copies.remove(new)
            for item in self.changed:
                if item["dest"] == cand.dest:
                    item["done"] = True
            info(f"installed dest={cand.dest} mode={cand.mode} bytes={cand.bytes}")

    def verify_installed(self) -> None:
        step("Verifying installed bytes, hashes, and modes")
        active = self.active_candidates()
        states = self.file_status([c.dest for c in active])
        for cand in active:
            state = states[cand.dest]
            if state["kind"] != "regular":
                raise InstallFailure(f"post-install verification failed for {cand.dest}: kind={state['kind']}")
            if int(state["size"], 10) != cand.bytes:
                raise InstallFailure(
                    f"post-install byte mismatch for {cand.dest}: "
                    f"expected {cand.bytes} got {state['size']}"
                )
            if state["md5"] != cand.md5:
                raise InstallFailure(f"post-install checksum mismatch for {cand.dest}")
            if state["mode"] != cand.mode:
                raise InstallFailure(
                    f"post-install mode mismatch for {cand.dest}: "
                    f"expected {cand.mode} got {state['mode']}"
                )
        info("installed candidates verified")

    def rollback_changes(self, trigger: str) -> None:
        step("Rolling back changed paths")
        info(f"trigger: {trigger}")
        incomplete = False
        for path in self.remove_new_copies():
            incomplete = True
            info(f"ROLLBACK FAILED could not remove leftover {path}")
        done_items = [item for item in self.changed if item["done"]]
        for item in reversed(done_items):
            dest = str(item["dest"])
            if item["was_absent"]:
                code, out, _err = self.run_remote_rc(f"rm -f {remote_quote(dest)}", timeout=30)
                if code != 0:
                    incomplete = True
                    info(f"ROLLBACK FAILED remove new path {dest}: {out.strip()}")
                    continue
                info(f"removed new path {dest} (original absence recorded)")
                continue
            tmp = dest + RESTORE_SUFFIX
            code, out, err = self.run_remote_rc(
                f"cp {remote_quote(str(item['rb']))} {remote_quote(tmp)} && "
                f"chmod {remote_quote(str(item['mode']))} {remote_quote(tmp)} && "
                f"mv -f {remote_quote(tmp)} {remote_quote(dest)}",
                timeout=180,
            )
            if code != 0:
                incomplete = True
                self.run_remote_rc(f"rm -f {remote_quote(tmp)}", timeout=30)
                info(f"ROLLBACK FAILED restore {dest}: {(err or out).strip()}")
                continue
            info(f"restored {dest} mode={item['mode']}")
        # verify rollback
        for item in done_items:
            dest = str(item["dest"])
            if item["was_absent"]:
                code, _out, _err = self.run_remote_rc(f"test ! -e {remote_quote(dest)}", timeout=30)
                if code != 0:
                    incomplete = True
                    info(f"ROLLBACK VERIFY FAILED path still present: {dest}")
                continue
            if self.remote_md5(dest) != item["md5"]:
                incomplete = True
                info(f"ROLLBACK VERIFY FAILED md5 for {dest}")
        if incomplete:
            self.preserve_stage = True
            raise RuntimeError(
                f"rollback incomplete; staged tree preserved for manual recovery at {self.stage}. "
                "Do NOT reboot (it is in RAM); inspect the staged rollback copies and restore manually."
            )
        info("rollback verified: all changed paths restored")
        self.cleanup_stage()

    def cleanup_stage(self) -> None:
        if not self.stage or self.preserve_stage:
            return
        step("Cleaning owned staging tree")
        code, out, _err = self.run_remote_rc(
            f"rm -rf {remote_quote(self.stage)}", timeout=60
        )
        if code != 0:
            info(f"warning: could not remove staging tree {self.stage}: {out.strip()}")
        else:
            kv(f"staging_removed={self.stage}")
            self.stage = ""

    # -------------------------------------------------------------- finish

    def post_install_wiring(self) -> None:
        step("Post-install wiring")
        bin_names = bin_manifest_names()
        bin_chmod = " ".join(f"/data/codex/bin/{n}" for n in bin_names)
        post = (
            "mkdir -p /data/codex/bin /data/codex/modules/usb-net /etc/dropbear /home/root/.ssh /data/codexmqtt /pkg/codexactivity /pkg/codexmqtt; "
            "ln -sf dropbearmulti /data/codex/bin/dropbear; "
            "ln -sf dropbearmulti /data/codex/bin/dropbearkey; "
            f"chmod 755 {bin_chmod} /data/codex/init.sh /data/codex/offline_egress_guard.sh "
            "/data/codex/recovery_ap.sh /data/codex/androidtv_service.sh /data/codex/usb_eth_service.sh /usr/sbin/dropbear "
            "/usr/sbin/dropbearkey /etc/init.d/rcS.local; "
            "chmod 644 /data/codex/modules/usb-net/r8152.ko /data/codex/modules/usb-net/usbnet.ko /data/codex/modules/usb-net/asix.ko /data/codex/modules/usb-net/cdc_ether.ko /data/codex/modules/usb-net/cdc_ncm.ko /data/codex/modules/usb-net/ax88179_178a.ko /data/codex/modules/usb-net/README.md 2>/dev/null || true; "
            "chmod 600 /data/codexmqtt/config.json 2>/dev/null || true; "
            "/bin/busybox sync 2>/dev/null || true"
        )
        self.run_remote(post, timeout=60, quiet=True)

    def probe_hal_bound(self) -> bool:
        out = self.run_remote(hal_bound_command(), timeout=30, quiet=True).strip()
        if out not in ("bound", "stock"):
            raise RuntimeError(f"couldn't tell whether the multi-remote hal runs: {out!r}")
        return out == "bound"

    def check_multi_remote_off(self) -> None:
        """--multi-remote off while the multi-remote hal runs: refuse unless the
        slot table holds no two remotes of one model (see MULTI_REMOTE_PENDING).
        Also records whether the copy runs now (self.hal_bound), which decides
        the reboot as much as the files do: a setting saved without one (or a
        copy rcS.local didn't bind) leaves the files right and the hal wrong."""
        if self.args.multi_remote == "on":
            self.hal_bound = self.probe_hal_bound()
            kv(f"multi_remote_active={'yes' if self.hal_bound else 'no'}")
        if self.args.multi_remote != "off":
            return
        if self.args.multi_remote_force:
            # force-off: for a radio that stopped answering, check nothing that
            # needs hal. The guard is best effort; the reboot follows at once.
            self.hal_bound = self.probe_hal_bound()
            kv(f"multi_remote_active={'yes' if self.hal_bound else 'no'}")
            if self.hal_bound and self.args.no_apply_cloud_restart:
                raise RuntimeError(
                    "--multi-remote force-off refused: the multi-remote hal is running, and "
                    "--no-apply-cloud-restart would keep it running; leave out --no-apply-cloud-restart"
                )
            if self.hal_bound and not self.args.preflight_only:
                self.run_remote(f"touch {MULTI_REMOTE_PENDING} 2>/dev/null; true", timeout=30, quiet=True)
            kv("multi_remote_off_check=forced")
            info(
                "WARNING: force-off skips the radio check: if two remotes of one model are still paired, the stock hal "
                "hangs on them too. Turn it back on (--multi-remote on), unpair the extra remote, then turn it off."
            )
            return
        # Without the reboot the multi-remote hal keeps running on setting 0, and
        # once the guard lapses a pair could add a duplicate that the stock hal
        # hangs on at the next boot: refuse that before writing anything.
        no_restart = self.args.no_apply_cloud_restart
        guard = not self.args.preflight_only and not no_restart
        out = self.run_remote(multi_remote_off_check_command(guard), timeout=60, quiet=True).strip()
        self.hal_bound = out != "inactive"
        if out == "inactive":
            kv("multi_remote_off_check=inactive")
            return
        problem = ""
        if no_restart:
            problem = (
                "the multi-remote hal is running, and --no-apply-cloud-restart would keep it running after the "
                "setting is saved, with nothing to stop a second remote of one model being paired before the "
                "stock hal starts; leave out --no-apply-cloud-restart so the hub restarts"
            )
        elif out == "guard-failed":
            problem = f"the hub couldn't write {MULTI_REMOTE_PENDING}, which blocks new pairings until it restarts"
        elif out == "pairing":
            problem = "a pairing window is open on the hub; try again when it closes"
        else:
            dups = rf_duplicate_models(out)
            if dups is None:
                problem = "the hub's radio didn't list its paired remotes"
            elif dups:
                problem = (
                    f"more than one remote of the same model is paired (EquadID {dups}); the stock hal "
                    "can't run two of one model, so unpair the extra ones first (Settings → Remotes)"
                )
        if problem:
            if guard:
                self.run_remote(f"rm -f {MULTI_REMOTE_PENDING}", timeout=30, quiet=True)
            raise RuntimeError(f"--multi-remote off refused: {problem}")
        kv("multi_remote_off_check=ok")

    def start_services(self) -> None:
        start = (
            "killall codex_webui 2>/dev/null || true; killall codex_bthid_keyboard 2>/dev/null || true; "
            "if ! ps | grep '[o]ffline_egress_guard.sh monitor' >/dev/null 2>&1; then "
            "/data/codex/offline_egress_guard.sh monitor >> /cache/codex-init.log 2>&1 & fi; "
            "if ! ps | grep '[d]ropbear' >/dev/null 2>&1; then /usr/sbin/dropbear -R -p 22; fi; "
            "mkdir -p /cache/bin; ln -sf /data/codex/bin/codex_bthid_keyboard /cache/bin/bthid_keyboard; "
            "/data/codex/bin/codex_webui 8080 >> /cache/codex-init.log 2>&1 & "
            "/data/codex/bin/codex_bthid_keyboard >> /cache/codex-init.log 2>&1 & "
            # codex_androidtv: kill the running copy; its service loop starts the new one.
            "killall codex_androidtv 2>/dev/null || true; "
            "if [ -x /data/codex/androidtv_service.sh ]; then /data/codex/androidtv_service.sh >/dev/null 2>&1 & fi; "
            "sleep 1; "
            f"/data/codex/bin/codex_hbus {remote_quote(self.hub_id)} harmony.automation?discover "
            f"{remote_quote('{\"gatewayType\":\"codexactivity\"}')} >> /cache/codex-init.log 2>&1 || true; "
            f"/data/codex/bin/codex_hbus {remote_quote(self.hub_id)} harmony.automation?discover "
            f"{remote_quote('{\"gatewayType\":\"codexmqtt\"}')} >> /cache/codex-init.log 2>&1 || true; "
            "ps | grep '[c]odex_webui' || true; ps | grep '[c]odex_bthid_keyboard' || true; ps | grep '[d]ropbear' || true; "
            "ps | grep '[a]tv_service.sh' || true"
        )
        print(self.run_remote(start, timeout=90).strip())

    def ensure_parent_dirs(self) -> None:
        dirs = sorted({c.dest.rsplit("/", 1)[0] for c in self.active_candidates()})
        cmd = "mkdir -p " + " ".join(remote_quote(d) for d in dirs)
        self.run_remote(cmd, timeout=30, quiet=True)

    def cloud_blocker_changed(self) -> bool:
        cloud = {"/opt/luaworks/tasks/connectserver/netservicestarter.lua", "/data/codex/cloud_blocker.conf"}
        return any(c.dest in cloud for c in self.active_candidates())

    def multi_remote_changed(self) -> bool:
        # hal starts once at boot (rcS), so only a reboot swaps it: needed when
        # the files change, or when the running hal isn't the one asked for.
        files = any(c.dest in (HAL_MULTI_DEST, MULTI_REMOTE_CONF) for c in self.active_candidates())
        if self.args.multi_remote not in ("on", "off") or self.hal_bound is None:
            return files
        return files or self.hal_bound != (self.args.multi_remote == "on")

    def wanted_hal(self) -> str:
        return "multi-remote" if self.args.multi_remote == "on" else "stock"

    def reboot_and_wait(self) -> None:
        self.run_remote("(/bin/sleep 2; /sbin/reboot || reboot) >/dev/null 2>&1 & echo rebooting", timeout=30, quiet=True)
        time.sleep(8)
        wait_for_port(self.args.hub_host, self.args.port, 180, "SSH")
        wait_for_port(self.args.hub_host, 8080, 180, "Web UI")
        self.verify_multi_remote_after_reboot()

    def verify_multi_remote_after_reboot(self) -> None:
        if self.args.multi_remote not in ("on", "off"):
            return
        want = self.args.multi_remote == "on"
        bound = self.probe_hal_bound()
        kv(f"multi_remote_active={'yes' if bound else 'no'}")
        if bound != want:
            info(
                "WARNING: the hub restarted but still runs the " + ("stock" if want else "multi-remote")
                + " hal; see /cache/codex-init.log on the hub"
            )

    def plugins_changed(self) -> bool:
        # The engine loads /pkg plugins once at start; only a reboot restarts it.
        return any(c.kind == "plugin" for c in self.active_candidates())

    def run(self) -> int:
        step("Checking SSH")
        identity = self.run_remote("id; uname -a", timeout=30)
        print(identity.strip())

        step("Resolving hub id")
        self.resolve_hub_id()
        self.check_multi_remote_off()

        step("Building candidate inventory")
        self.build_inventory()
        info(f"candidates={len(self.candidates)} (codex_webui installed last)")

        self.create_stage()
        self.upload_candidates()
        self.upload_flash_helper()
        self.verify_stage_md5()

        self.probe_destinations()
        self.apply_upgrade_gates()
        self.plan_dropbear_link()
        self.ram_status()
        self.measure_flash()
        self.scan_root_tool_leftovers()

        self.count_backup_generations()
        self.compute_handoff_estimate()
        if self.verdict == VERDICT_CONFIG_UNCERTAIN:
            self.render_preflight_report()
            self.cleanup_stage()
            return 2

        self.build_plans()
        self.decide_verdict()
        self.render_preflight_report()

        if self.args.preflight_only:
            self.cleanup_stage()
            return 0 if self.verdict == VERDICT_ALLOWED else 2

        if self.verdict != VERDICT_ALLOWED:
            self.cleanup_stage()
            info("normal mode aborted before any persistent mutation")
            return 2

        if self.args.remove_root_tool_leftovers and (self.root_tool_stages or self.root_tool_dropbear_removable()):
            self.remove_root_tool_leftovers()
            if self.active_candidates() and self.flash_shortfall() and not self.args.skip_flash_check:
                self.verdict = VERDICT_CAPACITY
                self.capacity_stage = "preflight"
                reason = (
                    f"free flash {self.flash_avail} < estimated need {self.flash_required} "
                    "after removing the leftovers"
                )
                self.verdict_reasons.append(reason)
                kv(f"verdict_reason={reason}")
                self.render_verdict()
                self.cleanup_stage()
                return 2

        if not self.active_candidates():
            self.cleanup_stage()
            if self.multi_remote_changed() and not self.args.no_apply_cloud_restart:
                # The files match, but the running hal isn't the one asked for.
                step("Restarting the hub")
                info("The files already match; rebooting the hub so it starts the " + self.wanted_hal() + " hal.")
                self.reboot_and_wait()
                step("Done")
                info("The hub already matched this payload; it was restarted to apply the multi-remote setting.")
                return 0
            step("Done")
            info("The hub already matches this payload; nothing was installed or restarted.")
            return 0

        try:
            self.stage_rollback_copies()
            self.create_handoff()
            self.prune_handoffs()
            self.ensure_parent_dirs()
            self.write_new_copies()
            self.install_sequence()
            self.verify_installed()
        except CapacityAbort as exc:
            self.verdict = VERDICT_CAPACITY
            self.capacity_stage = "phase1"
            self.verdict_reasons.append(str(exc))
            kv(f"verdict_reason={exc}")
            self.render_verdict()
            self.cleanup_stage()
            return 2
        except InstallFailure as exc:
            try:
                self.rollback_changes(str(exc))
            except RuntimeError as rb_exc:
                fail(str(rb_exc))
            fail(f"install failed and was rolled back: {exc}")
        except Exception as exc:
            # Transport-level failures (subprocess.TimeoutExpired, OSError,
            # anything else mid-install) must reach the same rollback
            # decision, never escape past it into blanket staging cleanup.
            if self.new_copies or any(item["done"] for item in self.changed):
                try:
                    self.rollback_changes(str(exc))
                except RuntimeError as rb_exc:
                    fail(str(rb_exc))
                fail(f"install failed and was rolled back: {exc}")
            self.cleanup_stage()
            raise

        try:
            self.post_install_wiring()
            step("Restarting services")
            self.start_services()
        except Exception as exc:
            # Wiring/start failures after destinations were replaced must
            # reverse-roll back; the rollback material stays intact.
            try:
                self.rollback_changes(f"post-install wiring/start failed: {exc}")
                self.start_services()
            except RuntimeError as rb_exc:
                fail(str(rb_exc))
            fail(f"post-install wiring/start failed and changes were rolled back: {exc}")
        try:
            wait_for_port(self.args.hub_host, 8080, 60, "Web UI")
        except Exception as exc:
            try:
                self.rollback_changes(f"smoke test failed: {exc}")
                self.start_services()
            except RuntimeError as rb_exc:
                fail(str(rb_exc))
            fail(f"smoke test failed and changes were rolled back: {exc}")

        self.report_flash_after_install()
        self.cleanup_stage()

        if (
            self.cloud_blocker_changed() or self.plugins_changed() or self.multi_remote_changed()
        ) and not self.args.no_apply_cloud_restart:
            step("Restarting the hub")
            if self.cloud_blocker_changed():
                info("Rebooting the hub so Logitech cloud services restart in blocked mode.")
            elif self.plugins_changed():
                info("Rebooting the hub so its engine loads the updated plugins.")
            else:
                info("Rebooting the hub so it starts the " + self.wanted_hal() + " hal.")
            self.reboot_and_wait()

        step("Done")
        if self.first_install:
            info("Install finished as a first install (configuration written).")
        elif self.args.clean_install:
            info("Install finished in explicit clean-install mode (configuration regenerated).")
        else:
            info("Install finished in default upgrade mode (existing configuration preserved where applicable).")
        info("Persistent paths were mutated only after preflight ALLOWED; staging was volatile until then.")
        info(f"Web UI: http://{self.args.hub_host}:8080/")
        info("Web UI authentication: disabled")
        if not self.args.skip_cloud_suppression:
            info("Cloud blocker: enabled" + (" and applied" if self.cloud_blocker_changed() else " (unchanged)"))
        if self.args.multi_remote:
            info(
                "Multiple remotes of one model: "
                + ("on (remotes without a screen)" if self.args.multi_remote == "on" else "off")
                + (" and applied" if self.multi_remote_changed() else " (unchanged)")
            )
        info("If IR commands do not work, update /data/codex/hub_id with the correct hub id and restart codex_webui.")
        return 0


class InstallFailure(RuntimeError):
    """Failure after persistent changes began; requires rollback."""


class CapacityAbort(RuntimeError):
    """Phase 1 could not write a new copy; every copy was removed, nothing live changed."""


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Install or upgrade Harmony Hub Control on an already rooted "
            "Harmony Hub over SSH. Default mode is upgrade and preserves "
            "existing configuration. Use --clean-install for an explicit clean "
            "install that regenerates configuration. Use --preflight-only to "
            "stage candidates in private volatile storage, verify MD5 hashes, "
            "compare with the hub, and print a terminal verdict with zero persistent "
            "writes and no service actions."
        ),
    )
    parser.add_argument("--hub-host", "--host", dest="hub_host", default="", help="Harmony Hub IP address or hostname")
    parser.add_argument("--key-path", default="", help="SSH private key for root login; defaults to ~/.ssh/harmony_owner_*")
    parser.add_argument("--port", type=int, default=22, help="SSH port")
    parser.add_argument("--ssh-user", default="root", help="SSH username")
    parser.add_argument("--hub-id", default="", help="Hub ID from the root tool output")
    parser.add_argument("--mqtt-broker", default=None, help="MQTT broker host/IP; leave blank to disable MQTT")
    parser.add_argument("--mqtt-port", type=int, default=None, help="MQTT broker port")
    parser.add_argument("--mqtt-user", default=None, help="MQTT username")
    parser.add_argument("--mqtt-password", default=None, help="MQTT password (never printed in preflight or logs)")
    parser.add_argument("--mqtt-base-topic", default=None, help="MQTT base topic")
    parser.add_argument("--mqtt-discovery-prefix", default=None, help="Home Assistant MQTT discovery prefix")
    parser.add_argument("--mqtt-client-id", default=None, help="MQTT client ID")
    parser.add_argument("--mqtt-disabled", action="store_true", default=None, help="Install with MQTT disabled")
    parser.add_argument("--skip-cloud-suppression", action="store_true", help="Do not replace netservicestarter.lua")
    parser.add_argument("--no-apply-cloud-restart", action="store_true", help="Do not reboot after the Logitech cloud blocker files, engine plugins or multi-remote setting change")
    parser.add_argument(
        "--multi-remote",
        choices=("on", "off", "force-off"),
        default=None,
        help=(
            "Let the hub keep several remotes without a screen of the same model (they share one "
            "button setup); 'off' restores the stock one-remote-per-model rule. 'force-off' does "
            "that without asking the radio first, for a radio that stopped answering. Omitted: "
            "unchanged. See docs/MULTI_REMOTE.md"
        ),
    )
    parser.add_argument("--no-prompt", action="store_true", help="Fail instead of asking for missing required values")
    parser.add_argument(
        "--remove-root-tool-leftovers",
        action="store_true",
        help=(
            "Delete harmony-hub-root's leftover /data/codexssh_*_stage folders, and its spare "
            "/data/rootssh/bin/dropbearmulti once SSH runs the installed Dropbear, before installing"
        ),
    )
    parser.add_argument(
        "--skip-flash-check",
        action="store_true",
        help=(
            "Install even when the measured free flash looks too small; the install still stops "
            "with no live changes if flash fills up"
        ),
    )
    parser.add_argument(
        "--preflight-only",
        action="store_true",
        help=(
            "Volatile preflight only: upload candidates into a private "
            "/var/volatile/codex-install-* tree, verify nonsensitive MD5 "
            "hashes, compare them with the hub's current files, check RAM "
            "for rollback copies and free flash for the changed files, and "
            "print inventory plus a terminal verdict (ALLOWED or BLOCKED_*). "
            "Performs no persistent writes, pruning, handoff, installs, "
            "restarts, or other service actions."
        ),
    )
    parser.add_argument(
        "--clean-install",
        action="store_true",
        help=(
            "Explicit clean install: regenerate configuration candidates. "
            "Default when this flag is omitted is upgrade, which preserves "
            "existing configuration unless a candidate explicitly replaces it."
        ),
    )
    args = parser.parse_args(argv)
    # force-off is off without the radio check (check_multi_remote_off()).
    args.multi_remote_force = args.multi_remote == "force-off"
    if args.multi_remote_force:
        args.multi_remote = "off"
    return args


def main(argv: list[str]) -> int:
    installer: Installer | None = None
    try:
        args = parse_args(argv)
        args.hub_host = prompt_if_missing(args.hub_host, "Harmony hub IP address", True, args.no_prompt)

        if not args.key_path:
            default_key = resolve_default_key_path()
            if default_key:
                args.key_path = str(default_key)
                info(f"using SSH key {args.key_path}")
        args.key_path = prompt_if_missing(args.key_path, "SSH private key path for root login", True, args.no_prompt)
        key_path = Path(args.key_path).expanduser()
        if not key_path.is_file():
            raise RuntimeError(f"SSH key not found: {key_path}")
        args.key_path = str(key_path)
        mqtt_cli_supplied = any(
            value is not None
            for value in (
                args.mqtt_broker,
                args.mqtt_port,
                args.mqtt_user,
                args.mqtt_password,
                args.mqtt_base_topic,
                args.mqtt_discovery_prefix,
                args.mqtt_client_id,
                args.mqtt_disabled,
            )
        )
        if not args.no_prompt and args.mqtt_broker is None and args.mqtt_disabled is None:
            if args.clean_install:
                args.mqtt_broker = input("MQTT broker host/IP (blank to disable MQTT for now): ").strip()
                if not args.mqtt_broker:
                    args.mqtt_disabled = True
                # Only a nonblank broker counts as an explicit MQTT choice;
                # a blank answer must never mark MQTT as explicitly supplied.
                mqtt_cli_supplied = bool(args.mqtt_broker)
            else:
                # Default upgrade: never prompt into the MQTT configuration and
                # never regenerate it; the existing /data/codexmqtt/config.json
                # is preserved unless explicit MQTT arguments are supplied.
                args.mqtt_disabled = True
        if not args.no_prompt and args.mqtt_broker:
            if args.mqtt_user is None:
                args.mqtt_user = input("MQTT username (blank if none): ").strip()
            if args.mqtt_password is None:
                args.mqtt_password = getpass.getpass("MQTT password (blank if none): ")
        args.mqtt_explicit_supplied = mqtt_cli_supplied

        # Defaults for MQTT fields never supplied; build_mqtt_config handles empties.
        for field in ("mqtt_broker", "mqtt_user", "mqtt_password", "mqtt_base_topic", "mqtt_discovery_prefix", "mqtt_client_id"):
            if getattr(args, field) is None:
                setattr(args, field, {
                    "mqtt_base_topic": "harmony/hub",
                    "mqtt_discovery_prefix": "homeassistant",
                    "mqtt_client_id": "harmony-local-mqtt",
                }.get(field, ""))
        if args.mqtt_port is None:
            args.mqtt_port = 1883
        if args.mqtt_disabled is None:
            args.mqtt_disabled = False

        installer = Installer(args)
        return installer.run()
    except KeyboardInterrupt:
        if installer is not None and installer.stage and not installer.preserve_stage:
            try:
                installer.cleanup_stage()
            except Exception:
                pass
        fail("cancelled")
    except Exception as exc:
        # Always remove the owned volatile staging tree unless the rollback is
        # incomplete and the tree is deliberately preserved for manual recovery.
        if installer is not None and installer.stage and not installer.preserve_stage:
            try:
                installer.cleanup_stage()
            except Exception:
                pass
        fail(str(exc))
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
