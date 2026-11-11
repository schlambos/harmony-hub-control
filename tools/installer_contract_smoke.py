#!/usr/bin/env python3
"""Deterministic local contract tests for the Step 4A root installers.

Subjects under test (repo root):

* ``install_webui.py``  -- Python installer.
  [PYTHON BEHAVIORAL] coverage: the real installer code is executed through a
  fake SSH/transport harness (a simulated BusyBox hub that answers the
  installer's shell commands). No network, no real ssh, no subprocesses.

* ``install_webui.ps1`` -- PowerShell installer.
  [PS1 STATIC] coverage: structured assertions on flags, constants, path
  arrays, and main-flow call ordering (always run; pwsh not required).
  [PS1 RUNTIME-OPTIONAL] coverage: a pwsh AST parse/param check that runs
  only when pwsh is installed; otherwise it is skipped and left to Main.

Contract proven (Python behavioral):
  preflight-only stages candidates in a private /var/volatile/codex-install-*
  0700 tree (no mktemp), strict-MD5 verifies them, probes destinations with
  one BusyBox ls/md5sum probe, checks RAM for rollback copies, performs no
  persistent writes/prune/handoff/install/restart, reports ALLOWED/BLOCKED_*,
  and removes only its staging tree; unchanged files are not rewritten; a
  flash-full phase 1 removes every new copy and changes nothing live; strict
  checksum failure; later-rename failure restoring earlier files' bytes and
  original modes; created-file removal on rollback; post-write verification
  failure; simulated service validation failure; incomplete rollback is fatal
  and preserves staging; upgrade preserves existing configuration;
  codex_webui is installed last; no service action before post-install
  verification; only installer handoffs are pruned; reboot only when the
  cloud-blocker files change; free flash is measured from RAM and a short
  hub is blocked before any write, with a fallback when it can't be
  measured; harmony-hub-root's identical Dropbear is hard-linked (copied if
  the link fails) and survives rollback; its leftovers are reported and
  removed only with --remove-root-tool-leftovers, the spare Dropbear only
  while SSH runs ours.

Determinism: no randomness, no clock reads, fixed fake staging suffix,
fixed fake timestamps. All hosts/IDs/credentials are obviously fake
(192.0.2.0/24 TEST-NET-1, hub id 1234, "fake-*" literals).

Run (single command, from the repo root or anywhere):

    python3 tools/installer_contract_smoke.py

Python stdlib only. The Python behavioral suite does NOT require pwsh.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import importlib.util
import io
import os
import re
import shutil
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
INSTALLER_PY = REPO_ROOT / "install_webui.py"
INSTALLER_PS1 = REPO_ROOT / "install_webui.ps1"

# Obviously fake endpoint/identity literals (TEST-NET-1, no real secrets).
FAKE_HUB_HOST = "192.0.2.10"
FAKE_BROKER = "192.0.2.20"
FAKE_HUB_ID = "1234"
FAKE_MQTT_USER = "fake-user"
FAKE_MQTT_PASSWORD = "fake-password-never-used"
FAKE_STAGE = "/var/volatile/codex-install-fake01"
FAKE_HANDOFF_STAMP = "20260101-000000"
FAKE_EXISTING_GENERATION = "/data/codex-backups/webui-handoff-20251231-235959"


def load_installer_module():
    """Import install_webui.py without executing installer logic."""
    spec = importlib.util.spec_from_file_location("install_webui_under_test", INSTALLER_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


INST = load_installer_module()
INST_SOURCE = INSTALLER_PY.read_text(encoding="utf-8")


def md5_bytes(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def flip_digest(digest: str) -> str:
    return digest[:-1] + ("0" if digest[-1] != "0" else "1")


class FakeHub:
    """Simulated BusyBox hub: a fake filesystem answering the installer's shell.

    Every remote command the installer issues over ssh lands in dispatch().
    The fake records an ordered event log used for sequencing assertions and
    tracks file-level persistent writes (any mutation outside the staging
    prefix). Like the real hub it has no mktemp, stat, readlink, or df.
    """

    def __init__(self, available_bytes: int = 4_000_000) -> None:
        self.fs: dict[str, dict[str, object]] = {}
        self.symlinks: set[str] = set()
        self.events: list[tuple] = []
        self.stage = FAKE_STAGE
        # Free flash, charged with the installer's own jffs2 estimate per new
        # file. codex_flash_free reports it unless flash_probe is False.
        self.available_bytes = available_bytes
        self.flash_total = 5_242_880
        self.flash_probe = True
        # A unionfs that refuses hard links.
        self.fail_link = False
        # harmony-hub-root staging folders: path -> (bytes, files).
        self.root_stages: dict[str, tuple[int, int]] = {}
        self.next_inode = 100
        # Report a fresh inode per path, as the hub's unionfs does after a reboot.
        self.union_inodes = False
        self.ram_free_kb = 26_000
        self.ram_inactive_file_kb = 0
        self.ram_slab_reclaimable_kb = 0
        self.backup_listing = [FAKE_EXISTING_GENERATION]
        self.handoff_stamp = FAKE_HANDOFF_STAMP
        self.fail_rename_dest: str | None = None
        self.fail_rollback_restore_dest: str | None = None
        self.corrupt_staged_md5: str | None = None
        # Post-install probe corruption: flip the reported md5 after N renames.
        self.file_status_corrupt_md5_after: int | None = None
        self.file_status_wrong_mode: dict[str, str] = {}
        self.file_status_garbage: set[str] = set()
        self.installs_done = 0
        self.smoke_fail = False
        # Transport-level failures (must NOT be RuntimeError subclasses).
        self.timeout_rename_dest: str | None = None
        # Wiring/service exceptions after destinations were replaced.
        self.fail_wiring = False
        self.fail_service_start_times = 0
        # /usr/bin/hal has the multi-remote copy bind-mounted over it.
        self.hal_bound = False
        # The next reboot leaves hal as it was (rcS.local didn't bind the copy).
        self.reboot_keeps_hal = False
        # /usr/bin/hal has the two-screen copy bind-mounted over it, and the
        # gates rcS.local wrote for it (/var/run, gone with every boot).
        self.remotes_bound = False
        self.hal_gates = ""
        # Reads of /usr/bin/hal return the copy bound over it (the two-screen
        # tests; the multi-remote tests place the bytes they want read).
        self.read_through_bind = False
        # The hub's kernel and loader start the two-screen copy.
        self.hal_copy_loads = True
        # A pairing window is open, and hal's rf.info answer.
        self.rf_pairing = False
        self.rf_info = RF_INFO_ONE_SMART
        # The pending-restart guard can't be written.
        self.guard_fail = False
        # Short md5sum responses: these paths emit no output line.
        self.md5sum_drop_paths: set[str] = set()

    # ------------------------------------------------------------- fs model

    def set_file(self, path: str, data: bytes, mode: str) -> None:
        self.fs[path] = {"data": data, "mode": mode}
        if not path.startswith(self.stage + "/"):
            self.events.append(("persistent_write", path))

    def remove_file(self, path: str) -> None:
        self.release(path)
        self.fs.pop(path, None)

    def links(self, entry: dict[str, object]) -> int:
        return sum(1 for value in self.fs.values() if value is entry)

    def release(self, path: str) -> None:
        """Give back the flash of a persistent file whose last name goes away."""
        entry = self.fs.get(path)
        if entry is None or path.startswith(self.stage + "/") or self.links(entry) > 1:
            return
        self.available_bytes += INST.flash_estimate(entry["data"], path.rsplit("/", 1)[-1])

    def inode(self, entry: dict[str, object]) -> int:
        if "inode" not in entry:
            self.next_inode += 1
            entry["inode"] = self.next_inode
        return int(entry["inode"])

    def paths_under_stage(self) -> list[str]:
        return sorted(p for p in self.fs if p.startswith(self.stage + "/") or p == self.stage)

    def leftovers(self) -> list[str]:
        return sorted(p for p in self.fs if p.endswith((INST.NEW_SUFFIX, INST.RESTORE_SUFFIX)))

    # ------------------------------------------------------------ dispatch

    def dispatch(self, command: str, input_bytes: bytes | None = None) -> tuple[int, str, str]:
        self.events.append(("cmd", command))
        c = command.strip()

        # The real hub's BusyBox has none of these applets.
        for missing in ("mktemp", "stat ", "readlink", "df ", "statvfs"):
            if missing in c:
                raise AssertionError(f"fake hub has no {missing.strip()!r}: {c!r}")

        if c == "id; uname -a":
            return 0, "uid=0(root) gid=0(root)\nLinux harmony-fake 3.10.14-codex #1 MIPS\n", ""

        if c == INST.MELODIOUS_OFF_CHECK_CMD:
            is_off = INST.MELODIOUS_OFF_MARKER in self.fs or INST.LEGACY_MELODIOUS_OFF_MARKER in self.fs
            return 0, "off\n" if is_off else "", ""

        if c == "cat /data/codex/hub_id 2>/dev/null || true":
            entry = self.fs.get("/data/codex/hub_id")
            return 0, entry["data"].decode("utf-8") if entry else "", ""

        if c == "cat /proc/meminfo":
            self.events.append(("meminfo",))
            return 0, (
                f"MemTotal:          62524 kB\nMemFree:           {self.ram_free_kb} kB\n"
                f"Inactive(file):    {self.ram_inactive_file_kb} kB\n"
                f"SReclaimable:      {self.ram_slab_reclaimable_kb} kB\n"
            ), ""

        if c.startswith("mkdir " + INST.STAGE_PREFIX):
            path = shlex.split(c)[1]
            if path != self.stage:
                raise AssertionError(f"unexpected staging path {path!r}")
            self.events.append(("staging_create", path, "700"))
            return 0, path + "\n", ""

        if c.startswith("cat > "):
            segments = c.split(" && ")
            path = shlex.split(segments[0])[2]
            mode = shlex.split(segments[1])[1] if len(segments) > 1 else ""
            self.set_file(path, input_bytes or b"", mode)
            self.events.append(("staged_upload", path, mode))
            return 0, "", ""

        if c == f"{self.stage}/{INST.FLASH_HELPER_NAME} {INST.FLASH_PATH}":
            self.events.append(("flash_probe",))
            if f"{self.stage}/{INST.FLASH_HELPER_NAME}" not in self.fs:
                return 127, "", "sh: codex_flash_free: not found"
            if not self.flash_probe:
                return 1, "", "/data: Function not implemented"
            free = min(self.available_bytes, self.flash_total)
            return 0, (
                f"flash type=0xf15f083d total_bytes={self.flash_total} free_bytes={free} "
                f"avail_bytes={free} path={INST.FLASH_PATH}\n"
            ), ""

        if c == INST.ROOT_TOOL_SCAN:
            lines = [
                f"root_tool_stage bytes={size} files={files} path={path}"
                for path, (size, files) in sorted(self.root_stages.items())
            ]
            for path in (INST.ROOT_TOOL_DROPBEAR, INST.DROPBEAR_DEST):
                entry = self.fs.get(path)
                if entry is not None and path not in self.symlinks:
                    links = sum(1 for e in self.fs.values() if e is entry)
                    # The hub's unionfs, after a reboot, numbers each path afresh.
                    inode = 900000 + len(path) if self.union_inodes else self.inode(entry)
                    lines.append(f"dropbear_copy inode={inode} links={links} path={path}")
            return 0, "".join(line + "\n" for line in lines), ""

        if c == INST.ROOT_TOOL_DROPBEAR_REMOVE:
            wrapper = self.fs.get("/usr/sbin/dropbear")
            if INST.DROPBEAR_DEST in self.fs and wrapper and b"/data/codex/bin/dropbear" in wrapper["data"]:
                for path in INST.ROOT_TOOL_FILES:
                    self.remove_file(path)
                    self.events.append(("rm", path))
                return 0, "removed\n", ""
            return 0, "", ""

        if c.startswith("ln "):
            return self.do_link(c)

        if c.startswith("for p in "):
            return self.do_probe(shlex.split(c[len("for p in "):c.index("; do ")]))

        if c == INST.running_hal_command():
            # What runs is what is bound over /usr/bin/hal, if anything.
            path = INST.HAL_REMOTES_DEST if self.remotes_bound else INST.HAL_MULTI_DEST if self.hal_bound else INST.HAL_PATH
            entry = self.fs.get(path)
            conf = self.fs.get(INST.MULTI_REMOTE_CONF, {}).get("data", b"")
            out = (md5_bytes(entry["data"]) + f"  {INST.HAL_PATH}\n") if entry else ""
            out += f"gates={self.hal_gates}\nmulti={conf.decode().strip()}\n"
            out += "multi_copy=" + ("yes" if INST.HAL_MULTI_DEST in self.fs else "no") + "\n"
            return 0, out, ""

        if c == INST.hal_load_check_command():
            self.events.append(("load_check",))
            if INST.HAL_REMOTES_DEST not in self.fs:
                return 0, f"sh: {INST.HAL_REMOTES_DEST}: not found\nrc=127\n", ""
            if not self.hal_copy_loads:
                return 0, "Segmentation fault\nrc=139\n", ""
            # As the hub prints it: the usage text has no trailing newline, so
            # the status lands glued to it ("...threadrc=1") unless the check
            # command puts it on its own line (the f6bd325 fix).
            usage = f"Usage: {INST.HAL_REMOTES_DEST}\n\t-d: enable debug\n\t-w: disable watchdog thread"
            if "echo; echo rc=" in c:
                return 0, usage + "\nrc=1\n", ""
            return 0, usage + "rc=1\n", ""

        if c == f"echo 0 > {INST.TWO_SCREEN_CONF}":
            self.set_file(INST.TWO_SCREEN_CONF, b"0\n", "644")
            return 0, "", ""

        if c.startswith("md5sum "):
            return self.do_md5sum(shlex.split(c)[1:])

        if c.startswith("cp -p "):
            return self.do_rollback_copy(c)

        if c.startswith("cp "):
            return self.do_copy(c)

        if c.startswith("mv -f "):
            src, dst = shlex.split(c)[2:4]
            return self.do_rename(src, dst)

        if c.startswith("rm -rf "):
            target = shlex.split(c)[2]
            self.events.append(("rm_rf", target))
            for path in list(self.fs):
                if path == target or path.startswith(target + "/"):
                    self.fs.pop(path, None)
            if target in self.backup_listing:
                self.backup_listing.remove(target)
            if target in self.root_stages:
                # Base64 chunks take about two thirds of their size on jffs2.
                self.available_bytes += self.root_stages.pop(target)[0] * 2 // 3
            return 0, "", ""

        if c in (INST.multi_remote_off_check_command(True), INST.multi_remote_off_check_command(False)):
            # --multi-remote off's check: guard, pairing window, rf.info.
            if not self.hal_bound:
                return 0, "inactive\n", ""
            if c == INST.multi_remote_off_check_command(True):
                if self.guard_fail:
                    return 0, "guard-failed\n", ""
                self.events.append(("guard", INST.MULTI_REMOTE_PENDING))
            if self.rf_pairing:
                return 0, "pairing\n", ""
            return 0, self.rf_info + "\n", ""

        if c.startswith("rm -f "):
            target = shlex.split(c)[2]
            self.remove_file(target)
            self.events.append(("rm", target))
            return 0, "", ""

        if c.startswith("test ! -e "):
            target = shlex.split(c)[3]
            return (1, "", "") if target in self.fs else (0, "", "")

        if c.startswith("mkdir -p") and "ln -sf dropbearmulti" in c:
            if self.fail_wiring:
                return 1, "", "simulated wiring failure"
            self.events.append(("wiring",))
            return 0, "", ""

        if c.startswith("mkdir -p"):
            self.events.append(("mkdir",))
            return 0, "", ""

        if c.startswith("for d in /data/codex-backups"):
            return 0, "".join(p + "\n" for p in self.backup_listing), ""

        if c.startswith("S=$(date"):
            handoff = f"{INST.HANDOFF_ROOT}/webui-handoff-{self.handoff_stamp}"
            self.events.append(("handoff", handoff))
            self.backup_listing.append(handoff)
            return 0, f"handoff={handoff}\n", ""

        if c.startswith("killall codex_webui"):
            self.events.append(("service", "start"))
            if self.fail_service_start_times > 0:
                self.fail_service_start_times -= 1
                return 1, "", "simulated service start failure"
            return 0, " 4242 root     codex_webui\n", ""

        if c.startswith("(/bin/sleep 2;"):
            self.events.append(("service", "reboot"))
            # Like rcS.local at the next boot: the two-screen copy when its
            # setting asks for it, else the multi-remote copy when its setting is 1.
            conf = self.fs.get(INST.MULTI_REMOTE_CONF, {}).get("data")
            two = self.fs.get(INST.TWO_SCREEN_CONF, {}).get("data", b"").decode().strip()
            self.remotes_bound, self.hal_gates = False, ""
            if two in INST.TWO_SCREEN_SETTINGS.values() and INST.HAL_REMOTES_DEST in self.fs and not self.reboot_keeps_hal:
                if two.endswith("once"):
                    self.fs[INST.TWO_SCREEN_CONF]["data"] = b"0\n"
                self.remotes_bound = True
                self.hal_gates = "1" + ("1" if conf == b"1\n" else "0") + ("1" if two.startswith("serial") else "0")
            elif two not in INST.TWO_SCREEN_SETTINGS.values():
                self.fs.pop(INST.HAL_REMOTES_DEST, None)
            self.hal_bound = (
                not self.remotes_bound and conf == b"1\n" and INST.HAL_MULTI_DEST in self.fs and not self.reboot_keeps_hal
            )
            return 0, "rebooting\n", ""

        if c == INST.hal_bound_command():
            return 0, ("bound\n" if self.hal_bound or self.remotes_bound else "stock\n"), ""

        if c == f"touch {INST.MULTI_REMOTE_PENDING} 2>/dev/null; true":
            self.events.append(("guard", INST.MULTI_REMOTE_PENDING))
            return 0, "", ""

        raise AssertionError(f"fake hub received unexpected command: {c!r}")

    # --------------------------------------------------------- sub-handlers

    def do_probe(self, paths: list[str]) -> tuple[int, str, str]:
        if self.installs_done > 0:
            self.events.append(("verify_installed",))
        self.events.append(("probe", tuple(paths)))
        lines = []
        for path in paths:
            if path in self.file_status_garbage:
                lines.append(f"file_status type=regular perm=?????????? bytes=x md5=none path={path}")
            elif path in self.symlinks:
                lines.append(f"file_status type=symlink path={path}")
            elif path not in self.fs:
                lines.append(f"file_status type=absent path={path}")
            else:
                entry = self.fs[path]
                mode = entry["mode"]
                if self.installs_done > 0:
                    mode = self.file_status_wrong_mode.get(path, mode)
                digest = md5_bytes(entry["data"])
                if (
                    self.file_status_corrupt_md5_after is not None
                    and self.installs_done >= self.file_status_corrupt_md5_after
                ):
                    digest = flip_digest(digest)
                lines.append(
                    f"file_status type=regular perm={mode_to_perm(mode)} "
                    f"bytes={len(entry['data'])} md5={digest} path={path}"
                )
        return 0, "\n".join(lines) + "\n", ""

    def do_md5sum(self, paths: list[str]) -> tuple[int, str, str]:
        lines = []
        for path in paths:
            if path in self.md5sum_drop_paths:
                continue
            entry = self.fs.get(path)
            if entry is None:
                return 1, "", f"md5sum: {path}: No such file or directory"
            digest = md5_bytes(entry["data"])
            if self.corrupt_staged_md5 == path:
                digest = flip_digest(digest)
            lines.append(f"{digest}  {path}")
        return 0, "\n".join(lines) + "\n", ""

    def do_rollback_copy(self, command: str) -> tuple[int, str, str]:
        segments = command.split(" && ")
        src, dst = shlex.split(segments[0])[2], shlex.split(segments[0])[3]
        entry = self.fs.get(src)
        if entry is None:
            return 1, "", f"cp: {src}: No such file or directory"
        mode = shlex.split(segments[1])[1]
        self.set_file(dst, entry["data"], mode)
        self.events.append(("rollback_copy", src, dst))
        return 0, f"{md5_bytes(entry['data'])}  {dst}\n", ""

    def do_copy(self, command: str) -> tuple[int, str, str]:
        segments = command.split(" && ")
        src, dst = shlex.split(segments[0])[1:3]
        mode = shlex.split(segments[1])[1]
        data = self.fs[src]["data"]
        if dst.endswith(INST.NEW_SUFFIX):
            cost = INST.flash_estimate(data, dst.rsplit("/", 1)[-1])
            if cost > self.available_bytes:
                # Real cp leaves a truncated file behind on ENOSPC.
                self.set_file(dst, data[: self.available_bytes], "644")
                self.available_bytes = 0
                return 1, "", "cp: write error: No space left on device"
            self.available_bytes -= cost
            self.set_file(dst, data, mode)
            self.events.append(("new_copy", dst[: -len(INST.NEW_SUFFIX)]))
            return 0, f"{md5_bytes(data)}  {dst}\n", ""
        if dst.endswith(INST.RESTORE_SUFFIX):
            dest = dst[: -len(INST.RESTORE_SUFFIX)]
            if self.fail_rollback_restore_dest == dest:
                return 1, "", "simulated rollback restore failure"
            final = shlex.split(segments[2])[3]
            self.set_file(final, data, mode)
            self.events.append(("install_file", dest, True))
            return 0, "", ""
        raise AssertionError(f"unexpected copy destination {dst!r}")

    def do_link(self, command: str) -> tuple[int, str, str]:
        """`ln SRC DST && chmod MODE DST && md5sum DST`: a second name, same file."""
        segments = command.split(" && ")
        src, dst = shlex.split(segments[0])[1:3]
        mode = shlex.split(segments[1])[1]
        if self.fail_link or src not in self.fs:
            return 1, "", f"ln: {dst}: Operation not permitted"
        entry = self.fs[src]
        self.fs[dst] = entry
        entry["mode"] = mode
        self.events.append(("persistent_write", dst))
        self.events.append(("link", src, dst[: -len(INST.NEW_SUFFIX)]))
        return 0, f"{md5_bytes(entry['data'])}  {dst}\n", ""

    def do_rename(self, src: str, dst: str) -> tuple[int, str, str]:
        if self.timeout_rename_dest == dst:
            raise subprocess.TimeoutExpired(cmd=f"ssh mv {dst}", timeout=60, output=None, stderr=None)
        if self.fail_rename_dest == dst:
            return 1, "", f"mv: can't rename '{src}': simulated failure"
        self.release(dst)
        # Same file under a new name: hard links stay links.
        self.fs[dst] = self.fs.pop(src)
        self.events.append(("persistent_write", dst))
        self.installs_done += 1
        self.events.append(("install_file", dst, False))
        return 0, "", ""

    # ------------------------------------------------------------- queries

    def indices(self, predicate) -> list[int]:
        return [i for i, event in enumerate(self.events) if predicate(event)]

    def first_index(self, predicate) -> int:
        found = self.indices(predicate)
        assert found, f"no event matched {predicate!r} in {self.events!r}"
        return found[0]


def mode_to_perm(mode: str) -> str:
    """`ls -l` permission string for an octal mode (inverse of perm_to_mode)."""
    value = int(mode, 8)
    out = "-"
    for shift in (6, 3, 0):
        bits = (value >> shift) & 7
        out += ("r" if bits & 4 else "-") + ("w" if bits & 2 else "-") + ("x" if bits & 1 else "-")
    return out


def prime_upgrade_hub(hub: FakeHub, pre_modes: dict[str, str] | None = None) -> dict[str, bytes]:
    """Populate a deterministic existing-install hub state (upgrade scenario).

    Returns the original bytes per path so tests can assert byte-exact
    restoration after rollback.
    """
    pre_modes = pre_modes or {}
    originals: dict[str, bytes] = {}

    def put(path: str, data: bytes, mode: str) -> None:
        hub.fs[path] = {"data": data, "mode": mode}
        originals[path] = data

    for name in INST.bin_manifest_names():
        put(f"/data/codex/bin/{name}", f"fake-original-binary {name} v0\n".encode() * 4,
            pre_modes.get(f"/data/codex/bin/{name}", "755"))
    for path in ("/usr/sbin/dropbear", "/usr/sbin/dropbearkey"):
        put(path, f"fake-original {path}\n".encode() * 3, pre_modes.get(path, "755"))
    for path in (
        "/data/codex/init.sh",
        "/data/codex/offline_egress_guard.sh",
        "/data/codex/recovery_ap.sh",
        "/data/codex/androidtv_service.sh",
        "/data/codex/usb_eth_service.sh",
        "/etc/init.d/rcS.local",
    ):
        put(path, f"fake-original {path}\n".encode() * 3, pre_modes.get(path, "755"))
    for path in (
        "/data/codex/modules/usb-net/r8152.ko",
        "/data/codex/modules/usb-net/usbnet.ko",
        "/data/codex/modules/usb-net/asix.ko",
        "/data/codex/modules/usb-net/cdc_ether.ko",
        "/data/codex/modules/usb-net/cdc_ncm.ko",
        "/data/codex/modules/usb-net/ax88179_178a.ko",
        "/data/codex/modules/usb-net/README.md",
    ):
        put(path, f"fake-original {path}\n".encode() * 3, pre_modes.get(path, "644"))
    put("/opt/luaworks/tasks/connectserver/netservicestarter.lua",
        b"fake-original netservicestarter\n" * 3,
        pre_modes.get("/opt/luaworks/tasks/connectserver/netservicestarter.lua", "644"))
    put("/pkg/codexactivity/codexactivity.lua", b"fake-original codexactivity\n" * 3, "644")
    put("/pkg/codexmqtt/codexmqtt.lua", b"fake-original codexmqtt\n" * 3, "644")
    # Existing configuration an upgrade must preserve.
    put("/data/codex/hub_id", (FAKE_HUB_ID + "\n").encode(), "644")
    put("/data/codex/cloud_blocker.conf", b"1\n", "644")
    put("/data/codexmqtt/config.json", b'{"fake":"old-config"}\n', "600")
    put("/etc/tdeenable", b"1\n", "644")
    # Deliberately absent: if-missing candidates become "create" actions.
    # (/pkg/codexactivity/manifest.json and /pkg/codexmqtt/manifest.json)
    return originals


def prime_current_hub(hub: FakeHub) -> None:
    """A hub that already runs exactly this payload (nothing to install)."""
    prime_upgrade_hub(hub)
    installer = INST.Installer.__new__(INST.Installer)
    installer.args = INST.parse_args(["--hub-host", FAKE_HUB_HOST])
    installer.hub_id = FAKE_HUB_ID
    installer.build_inventory()
    for cand in installer.candidates:
        hub.fs[cand.dest] = {"data": cand.data(), "mode": cand.mode}


class InstallerHarness:
    """Runs the real installer main() against a FakeHub.

    Patches exactly five seams on the imported module: the ssh transport
    (Installer.run_remote_rc, and Installer.run_remote_raw for binary reads),
    wait_for_port, time.sleep, and the random staging suffix. Everything else
    is real installer code.
    """

    def __init__(self, hub: FakeHub) -> None:
        self.hub = hub
        self._tmpdir = tempfile.mkdtemp(prefix="installer-contract-")
        self.key_path = os.path.join(self._tmpdir, "fake_id_ed25519")
        with open(self.key_path, "w", encoding="utf-8") as handle:
            handle.write("fake-ssh-private-key-material-never-used\n")

    def close(self) -> None:
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def base_argv(self, *extra: str) -> list[str]:
        return [
            "--hub-host", FAKE_HUB_HOST,
            "--key-path", self.key_path,
            "--no-prompt",
            "--no-apply-cloud-restart",
            *extra,
        ]

    def run(self, argv: list[str]) -> tuple[int, str, str]:
        hub = self.hub

        def fake_run_remote_rc(self_installer, command, input_bytes=None, timeout=90):
            return hub.dispatch(command, input_bytes)

        def fake_run_remote_raw(self_installer, command, timeout=90):
            # Binary reads (the multi-remote hal): `cat '<path>'` only.
            match = re.match(r"^cat '?([^' ]+)'?$", command.strip())
            if not match:
                raise AssertionError(f"fake hub: unexpected raw command {command!r}")
            hub.events.append(("raw_read", match.group(1)))
            bound = INST.HAL_REMOTES_DEST if hub.remotes_bound else INST.HAL_MULTI_DEST if hub.hal_bound else None
            if match.group(1) == INST.HAL_PATH and bound and hub.read_through_bind:
                entry = hub.fs.get(bound)  # a read of /usr/bin/hal sees the copy bound over it
            else:
                entry = hub.fs.get(match.group(1))
            return (0, entry["data"], "") if entry else (1, b"", f"cat: {match.group(1)}: No such file or directory")

        def fake_wait_for_port(host, port, seconds, label):
            hub.events.append(("port_wait", port, label))
            if hub.smoke_fail and port == 8080:
                raise RuntimeError("simulated service validation failure (fake port 8080)")

        old_rrc = INST.Installer.run_remote_rc
        old_raw = INST.Installer.run_remote_raw
        old_wait = INST.wait_for_port
        old_sleep = INST.time.sleep
        old_suffix = INST.stage_suffix
        INST.Installer.run_remote_rc = fake_run_remote_rc
        INST.Installer.run_remote_raw = fake_run_remote_raw
        INST.wait_for_port = fake_wait_for_port
        INST.time.sleep = lambda _seconds: None
        INST.stage_suffix = lambda: FAKE_STAGE[len(INST.STAGE_PREFIX):]
        stdout_buf, stderr_buf = io.StringIO(), io.StringIO()
        try:
            with contextlib.redirect_stdout(stdout_buf), contextlib.redirect_stderr(stderr_buf):
                try:
                    code = INST.main(argv)
                except SystemExit as exc:
                    code = int(exc.code or 0)
        finally:
            INST.Installer.run_remote_rc = old_rrc
            INST.Installer.run_remote_raw = old_raw
            INST.wait_for_port = old_wait
            INST.time.sleep = old_sleep
            INST.stage_suffix = old_suffix
        return code, stdout_buf.getvalue(), stderr_buf.getvalue()


def kv_values(stdout: str, key: str) -> list[str]:
    prefix = key + "="
    return [line[len(prefix):] for line in stdout.splitlines() if line.startswith(prefix)]


def kv_value(stdout: str, key: str) -> str | None:
    prefix = key + "="
    for line in stdout.splitlines():
        if line.startswith(prefix):
            return line[len(prefix):]
    return None


def kv_multi(stdout: str, key: str) -> list[str]:
    prefix = key + "="
    return [line[len(prefix):] for line in stdout.splitlines() if line.startswith(prefix)]


def install_file_dests(hub: FakeHub, rollback: bool | None = None) -> list[str]:
    return [
        event[1]
        for event in hub.events
        if event[0] == "install_file" and (rollback is None or event[2] is rollback)
    ]


class PythonInstallerPreflight(unittest.TestCase):
    """[PYTHON BEHAVIORAL] --preflight-only contracts: no mutation, verdicts."""

    def setUp(self):
        self.hub = FakeHub()
        self.originals = prime_upgrade_hub(self.hub)
        self.harness = InstallerHarness(self.hub)
        self.addCleanup(self.harness.close)

    def assert_no_persistent_mutation(self):
        writes = [e[1] for e in self.hub.events if e[0] == "persistent_write"]
        self.assertEqual(writes, [], f"unexpected persistent writes: {writes}")
        self.assertFalse(any(e[0] in ("install_file", "new_copy", "handoff") for e in self.hub.events))
        self.assertFalse(any(e[0] == "service" for e in self.hub.events))
        self.assertFalse(any(e[0] == "rm" for e in self.hub.events))
        self.assertEqual(self.hub.fs, {k: v for k, v in self.hub.fs.items()
                                       if not k.startswith(self.hub.stage)})

    def assert_stage_removed_only(self):
        rm_rf_targets = [e[1] for e in self.hub.events if e[0] == "rm_rf"]
        self.assertEqual(rm_rf_targets, [self.hub.stage],
                         "cleanup must remove exactly the owned staging tree")
        self.assertEqual(self.hub.paths_under_stage(), [])
        self.assertEqual(kv_value(self._stdout, "staging_removed"), self.hub.stage)

    def test_preflight_only_allowed_no_mutation(self):
        """[PYTHON BEHAVIORAL] preflight stages in a 0700 volatile tree without
        mktemp, verifies MD5 strictly, probes destinations with one BusyBox
        probe, checks RAM, reports ALLOWED, and mutates nothing else."""
        argv = self.harness.base_argv(
            "--preflight-only",
            "--mqtt-broker", FAKE_BROKER,
            "--mqtt-user", FAKE_MQTT_USER,
            "--mqtt-password", FAKE_MQTT_PASSWORD,
        )
        code, stdout, _stderr = self.harness.run(argv)
        self._stdout = stdout
        self.assertEqual(code, 0, stdout)
        self.assertEqual(kv_value(stdout, "verdict"), INST.VERDICT_ALLOWED)
        self.assertEqual(kv_value(stdout, "staging_dir"), self.hub.stage)
        self.assertIn(("staging_create", self.hub.stage, "700"), self.hub.events)
        # Staged candidates uploaded at 0600 under the private tree; only the
        # flash probe is executable.
        uploads = [e for e in self.hub.events if e[0] == "staged_upload"]
        self.assertTrue(uploads)
        helper = f"{self.hub.stage}/{INST.FLASH_HELPER_NAME}"
        for _kind, path, mode in uploads:
            self.assertTrue(path.startswith(self.hub.stage + "/"))
            self.assertEqual(mode, "700" if path == helper else "600", f"staged {path} mode")
        self.assertIn(("staged_upload", helper, "700"), self.hub.events)
        self.assertEqual(len([e for e in self.hub.events if e[0] == "probe"]), 1)
        self.assertIn(("meminfo",), self.hub.events)
        self.assertIn(("flash_probe",), self.hub.events)
        self.assertEqual(kv_value(stdout, "flash_capacity_check"), "measured")
        # Sensitive MQTT config redaction in staged + report lines.
        sensitive_lines = [
            line for line in stdout.splitlines()
            if "dest=/data/codexmqtt/config.json" in line and "md5=" in line
        ]
        self.assertTrue(sensitive_lines)
        for line in sensitive_lines:
            self.assertIn("md5=<hidden>", line)
            self.assertNotRegex(line, r"md5=[0-9a-f]{32}")
        self.assert_no_persistent_mutation()
        self.assert_stage_removed_only()

    def test_preflight_totals_cover_changed_files_only(self):
        """[PYTHON BEHAVIORAL] forward bytes are the changed candidates' sizes,
        rollback bytes the replaced originals' sizes, and RAM required is
        rollback plus the fixed margin."""
        code, stdout, _ = self.harness.run(self.harness.base_argv("--preflight-only"))
        self._stdout = stdout
        self.assertEqual(code, 0, stdout)
        lines = [l for l in stdout.splitlines() if l.startswith("candidate ")]
        forward = sum(
            int(re.search(r" bytes=(\d+)", l).group(1))
            for l in lines if re.search(r"action=(replace|create)\b", l)
        )
        rollback = sum(
            len(self.originals[re.search(r" dest=(\S+)", l).group(1)])
            for l in lines if "action=replace" in l
        )
        self.assertEqual(int(kv_value(stdout, "forward_total_bytes")), forward)
        self.assertEqual(int(kv_value(stdout, "rollback_total_bytes")), rollback)
        self.assertEqual(int(kv_value(stdout, "ram_required_bytes")), rollback + INST.RAM_MARGIN_BYTES)

    def test_preflight_blocked_rollback_ram(self):
        """[PYTHON BEHAVIORAL] too little free RAM for rollback copies refuses
        with BLOCKED_ROLLBACK_CAPACITY and no persistent mutation."""
        self.hub.ram_free_kb = 1024
        code, stdout, _ = self.harness.run(self.harness.base_argv("--preflight-only"))
        self._stdout = stdout
        self.assertEqual(code, 2, stdout)
        self.assertEqual(kv_value(stdout, "verdict"), INST.VERDICT_ROLLBACK_CAPACITY)
        self.assert_no_persistent_mutation()
        self.assert_stage_removed_only()

    def test_preflight_credits_reclaimable_ram(self):
        """[PYTHON BEHAVIORAL] the hub kernel has no MemAvailable, so usable
        RAM is MemFree plus inactive file cache plus reclaimable slab. A 32 MB
        hub after staging (about 1 MiB free, 8 MiB reclaimable) is allowed."""
        self.hub.ram_free_kb = 1176
        self.hub.ram_inactive_file_kb = 7312
        self.hub.ram_slab_reclaimable_kb = 988
        code, stdout, _ = self.harness.run(self.harness.base_argv("--preflight-only"))
        self._stdout = stdout
        self.assertEqual(code, 0, stdout)
        self.assertEqual(int(kv_value(stdout, "ram_free_bytes")), (1176 + 7312 + 988) * 1024)
        self.assertEqual(kv_value(stdout, "verdict"), INST.VERDICT_ALLOWED)
        self.assert_no_persistent_mutation()
        self.assert_stage_removed_only()

    def test_unchanged_destinations_are_not_rewritten(self):
        """[PYTHON BEHAVIORAL] a destination whose md5 and mode already match
        is reported unchanged and excluded from the forward total."""
        webui = (INST.PAYLOAD / "bin" / "codex_webui").read_bytes()
        self.hub.fs[INST.WEBUI_DEST] = {"data": webui, "mode": "755"}
        code, stdout, _ = self.harness.run(self.harness.base_argv("--preflight-only"))
        self._stdout = stdout
        self.assertEqual(code, 0, stdout)
        line = next(l for l in stdout.splitlines()
                    if l.startswith("candidate ") and f"dest={INST.WEBUI_DEST} " in l)
        self.assertIn("action=unchanged", line)
        self.assertLess(int(kv_value(stdout, "forward_total_bytes")), sum(
            int(re.search(r" bytes=(\d+)", l).group(1))
            for l in stdout.splitlines() if l.startswith("candidate ")))

    def test_strict_staged_md5_failure(self):
        """[PYTHON BEHAVIORAL] a corrupted staged digest is rejected by the
        strict BusyBox md5 verification before any persistent mutation."""
        first_binary = next(n for n in INST.bin_manifest_names() if n != "codex_webui")
        staged_path = f"{self.hub.stage}/00-{first_binary}"
        self.hub.corrupt_staged_md5 = staged_path
        code, stdout, stderr = self.harness.run(self.harness.base_argv("--preflight-only"))
        self._stdout = stdout
        self.assertEqual(code, 1, stderr)
        self.assertIn("staged md5 mismatch", stderr)
        self.assert_no_persistent_mutation()
        self.assert_stage_removed_only()

    def test_dropped_sensitive_checksum_is_fatal(self):
        """[PYTHON BEHAVIORAL] a missing sensitive md5sum line is fatal,
        even though sensitive hashes are redacted from reports."""
        binary_count = len(INST.bin_manifest_names())
        # The fixed candidates after the binaries: dropbear, dropbearkey,
        # init.sh, the egress guard, recovery_ap.sh, androidtv_service.sh,
        # usb_eth_service.sh, r8152.ko, usbnet.ko, asix.ko, cdc_ether.ko,
        # cdc_ncm.ko, ax88179_178a.ko, modules README.md, rcS.local,
        # netservicestarter.lua, the two plugins, ... then config.json.
        sensitive_index = binary_count + 22
        self.hub.md5sum_drop_paths.add(
            f"{self.hub.stage}/{sensitive_index:02d}-config.json"
        )
        argv = self.harness.base_argv(
            "--preflight-only",
            "--clean-install",
            "--mqtt-broker", FAKE_BROKER,
            "--mqtt-user", FAKE_MQTT_USER,
            "--mqtt-password", FAKE_MQTT_PASSWORD,
        )
        code, stdout, stderr = self.harness.run(argv)
        self._stdout = stdout
        self.assertEqual(code, 1, stderr)
        self.assertIn("sensitive candidate failed md5 verification", stderr)
        self.assert_no_persistent_mutation()
        self.assert_stage_removed_only()


class PythonInstallerMutating(unittest.TestCase):
    """[PYTHON BEHAVIORAL] normal install, rollback, and service contracts."""

    def setUp(self):
        self.hub = FakeHub()
        self.originals = prime_upgrade_hub(
            self.hub,
            # Non-canonical observed mode: rollback must restore THIS mode,
            # not the candidate's canonical 755.
            pre_modes={"/data/codex/init.sh": "600"},
        )
        self.harness = InstallerHarness(self.hub)
        self.addCleanup(self.harness.close)
        self.webui_dest = INST.WEBUI_DEST
        self.protected_configs = [
            "/data/codex/hub_id",
            "/data/codex/cloud_blocker.conf",
            "/data/codexmqtt/config.json",
            "/etc/tdeenable",
        ]
        self.created_paths = [
            "/pkg/codexactivity/manifest.json",
            "/pkg/codexmqtt/manifest.json",
        ]

    def assert_originals_restored(self, restored_modes: dict[str, str]):
        for path, data in self.originals.items():
            entry = self.hub.fs.get(path)
            self.assertIsNotNone(entry, f"{path} missing after rollback")
            self.assertEqual(md5_bytes(entry["data"]), md5_bytes(data),
                             f"{path} bytes not restored")
        for path, mode in restored_modes.items():
            self.assertEqual(self.hub.fs[path]["mode"], mode,
                             f"{path} mode not restored to observed {mode}")
        self.assertEqual(self.hub.leftovers(), [])

    def assert_no_service_before(self, index: int):
        service = self.hub.indices(lambda e: e[0] == "service")
        for i in service:
            self.assertGreater(i, index, f"service action at {i} before index {index}")

    def test_full_install_ordering_config_preservation_webui_last(self):
        """[PYTHON BEHAVIORAL] happy path: rollback copies and handoff precede
        phase 1, every new copy lands before the first rename, codex_webui is
        renamed last, upgrade configuration is preserved, and no service action
        happens before post-write verification."""
        code, stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(kv_value(stdout, "verdict"), INST.VERDICT_ALLOWED)

        last_rb_copy = max(self.hub.indices(lambda e: e[0] == "rollback_copy"))
        handoff = self.hub.first_index(lambda e: e[0] == "handoff")
        first_copy = self.hub.first_index(lambda e: e[0] == "new_copy")
        last_copy = max(self.hub.indices(lambda e: e[0] == "new_copy"))
        first_install = self.hub.first_index(lambda e: e[0] == "install_file")
        self.assertLess(last_rb_copy, first_copy)
        self.assertLess(handoff, first_copy)
        self.assertLess(last_copy, first_install)

        # codex_webui is the final replacement and appears exactly once.
        forward = install_file_dests(self.hub, rollback=False)
        self.assertEqual(forward[-1], self.webui_dest)
        self.assertEqual(forward.count(self.webui_dest), 1)

        # Upgrade omits protected configuration candidates entirely.
        for path in self.protected_configs:
            self.assertNotIn(path, forward, f"upgrade replaced protected {path}")
        candidate_lines = [l for l in stdout.splitlines() if l.startswith("candidate ")]
        hub_id_lines = [l for l in candidate_lines if "dest=/data/codex/hub_id" in l]
        self.assertEqual(hub_id_lines, [], "upgrade must not carry a hub_id candidate")
        tde_lines = [l for l in candidate_lines if "dest=/etc/tdeenable" in l]
        self.assertTrue(tde_lines and all("action=preserve" in l for l in tde_lines))

        # Existing configuration byte-identical after the install.
        for path in ("/data/codex/hub_id", "/data/codex/cloud_blocker.conf",
                     "/data/codexmqtt/config.json", "/etc/tdeenable"):
            self.assertEqual(md5_bytes(self.hub.fs[path]["data"]),
                             md5_bytes(self.originals[path]))

        # No service action before post-write verification.
        verify_index = self.hub.first_index(lambda e: e[0] == "verify_installed")
        self.assert_no_service_before(verify_index)
        webui_bytes = (INST.PAYLOAD / "bin" / "codex_webui").read_bytes()
        self.assertEqual(md5_bytes(self.hub.fs[self.webui_dest]["data"]),
                         md5_bytes(webui_bytes))
        self.assertEqual(self.hub.fs[self.webui_dest]["mode"], "755")

        # Staging removed, no .codex-new/.codex-rb left, and only candidate
        # dests (plus their temporary copies) were persistently touched.
        rm_rf_targets = [e[1] for e in self.hub.events if e[0] == "rm_rf"]
        self.assertEqual(rm_rf_targets, [self.hub.stage])
        self.assertEqual(self.hub.paths_under_stage(), [])
        self.assertEqual(self.hub.leftovers(), [])
        for event in self.hub.events:
            if event[0] == "persistent_write":
                self.assertTrue(
                    event[1] in forward or event[1].removesuffix(INST.NEW_SUFFIX) in forward,
                    f"unrelated persistent path mutated: {event[1]}",
                )
        self.assertNotIn(("service", "reboot"), self.hub.events)

    def test_flash_full_in_phase_one_changes_nothing(self):
        """[PYTHON BEHAVIORAL] running out of flash while writing new copies
        removes every copy (including the truncated one), leaves all live
        files untouched, starts no services, and reports BLOCKED_CAPACITY.
        The flash probe is off, so only the two-phase commit protects."""
        self.hub.flash_probe = False
        webui = INST.flash_estimate((INST.PAYLOAD / "bin" / "codex_webui").read_bytes(), "codex_webui.codex-new")
        self.hub.available_bytes = webui  # earlier copies use some of it
        code, stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 2, stderr or stdout)
        self.assertEqual(kv_multi(stdout, "verdict")[-1], INST.VERDICT_CAPACITY)
        self.assertEqual(kv_value(stdout, "flash_capacity_check"), "two-phase-commit")
        self.assertIn("flash filled up while writing the new copies", stdout)
        self.assertEqual(install_file_dests(self.hub), [])
        self.assert_originals_restored({"/data/codex/init.sh": "600"})
        for path in self.created_paths:
            self.assertNotIn(path, self.hub.fs)
        self.assertFalse(any(e[0] == "service" for e in self.hub.events))
        self.assertEqual(self.hub.paths_under_stage(), [])

    def test_nothing_to_install_writes_nothing(self):
        """[PYTHON BEHAVIORAL] a hub that already matches the payload gets no
        handoff, no writes, and no service restart."""
        hub = FakeHub()
        prime_current_hub(hub)
        harness = InstallerHarness(hub)
        self.addCleanup(harness.close)
        code, stdout, stderr = harness.run(harness.base_argv())
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(kv_value(stdout, "changed_count"), "0")
        self.assertEqual([e for e in hub.events if e[0] == "persistent_write"], [])
        self.assertFalse(any(e[0] in ("handoff", "service", "new_copy") for e in hub.events))

    def test_true_reverse_install_order_on_rollback(self):
        """[PYTHON BEHAVIORAL] failing the LAST rename (codex_webui)
        reverse-restores every earlier file to original bytes and observed
        mode, removes created files and leftover copies, and never continues
        to services."""
        self.hub.fail_rename_dest = self.webui_dest
        code, _stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 1, stderr)
        self.assertIn("install failed and was rolled back", stderr)

        forward = install_file_dests(self.hub, rollback=False)
        self.assertNotIn(self.webui_dest, forward)
        self.assertTrue(forward)
        restored = install_file_dests(self.hub, rollback=True)
        self.assertEqual(
            restored,
            [d for d in reversed(forward) if d in self.originals],
            "rollback must restore replaced files in reverse order",
        )
        self.assert_originals_restored({"/data/codex/init.sh": "600"})
        for path in self.created_paths:
            self.assertNotIn(path, self.hub.fs, f"created {path} must be removed")
            self.assertIn(("rm", path), self.hub.events)

        # Never continues: no service actions, no reboot, staging removed.
        self.assertFalse(any(e[0] == "service" for e in self.hub.events))
        rm_rf_targets = [e[1] for e in self.hub.events if e[0] == "rm_rf"]
        self.assertEqual(rm_rf_targets, [self.hub.stage])
        self.assertEqual(self.hub.paths_under_stage(), [])

    def test_transport_timeout_rolls_back(self):
        """[PYTHON BEHAVIORAL] transport timeout after earlier replacements
        follows the same rollback path and removes staging."""
        self.hub.timeout_rename_dest = "/data/codex/init.sh"
        code, _stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 1, stderr)
        self.assertIn("install failed and was rolled back", stderr)
        self.assertTrue(install_file_dests(self.hub, rollback=True))
        self.assert_originals_restored({"/data/codex/init.sh": "600"})
        self.assertEqual(self.hub.paths_under_stage(), [])
        self.assertFalse(any(e[0] == "service" for e in self.hub.events))

    def test_wiring_failure_rolls_back_and_restarts(self):
        """[PYTHON BEHAVIORAL] post-install wiring failure reverses every
        replacement and starts services again with the originals."""
        self.hub.fail_wiring = True
        code, _stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 1, stderr)
        self.assertIn("post-install wiring/start failed and changes were rolled back", stderr)
        self.assertTrue(install_file_dests(self.hub, rollback=True))
        self.assert_originals_restored({"/data/codex/init.sh": "600"})
        starts = [e for e in self.hub.events if e == ("service", "start")]
        self.assertGreaterEqual(len(starts), 1)

    def test_service_start_failure_rolls_back_and_restarts(self):
        """[PYTHON BEHAVIORAL] a service-start failure after wiring reverses
        replacements and the retry starts services successfully."""
        self.hub.fail_service_start_times = 1
        code, _stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 1, stderr)
        self.assertIn("post-install wiring/start failed and changes were rolled back", stderr)
        self.assertTrue(install_file_dests(self.hub, rollback=True))
        self.assert_originals_restored({"/data/codex/init.sh": "600"})
        starts = [e for e in self.hub.events if e == ("service", "start")]
        self.assertGreaterEqual(len(starts), 2)

    def test_post_write_verification_failure_rolls_back(self):
        """[PYTHON BEHAVIORAL] a post-install checksum mismatch triggers a
        full reverse restore and exits nonzero."""
        self.hub.file_status_corrupt_md5_after = 1
        code, _stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 1, stderr)
        self.assertIn("post-install checksum mismatch", stderr)
        self.assertIn("install failed and was rolled back", stderr)
        self.assert_originals_restored({"/data/codex/init.sh": "600"})
        for path in self.created_paths:
            self.assertNotIn(path, self.hub.fs)
        self.assertFalse(any(e[0] == "service" for e in self.hub.events))
        self.assertEqual(self.hub.paths_under_stage(), [])

    def test_service_validation_failure_rolls_back_and_restarts(self):
        """[PYTHON BEHAVIORAL] simulated post-install service validation
        failure rolls changes back and restarts services with the originals."""
        self.hub.smoke_fail = True
        code, _stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 1, stderr)
        self.assertIn("smoke test failed and changes were rolled back", stderr)
        starts = self.hub.indices(lambda e: e[0] == "service" and e[1] == "start")
        self.assertGreaterEqual(len(starts), 2,
                                "services must be restarted after rollback")
        restore_indices = self.hub.indices(
            lambda e: e[0] == "install_file" and e[2] is True
        )
        self.assertTrue(restore_indices)
        self.assertLess(starts[0], min(restore_indices))
        self.assertLess(max(restore_indices), starts[-1])
        self.assert_originals_restored({"/data/codex/init.sh": "600"})
        self.assertNotIn(("service", "reboot"), self.hub.events)
        self.assertEqual(self.hub.paths_under_stage(), [])

    def test_incomplete_rollback_is_fatal_and_preserves_stage(self):
        """[PYTHON BEHAVIORAL] a failed rollback restore is fatal: staging is
        deliberately preserved for manual recovery and never removed."""
        self.hub.fail_rename_dest = self.webui_dest
        self.hub.fail_rollback_restore_dest = "/data/codex/bin/codex_hbus"
        code, _stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 1, stderr)
        self.assertIn("rollback incomplete", stderr)
        self.assertIn("Do NOT reboot", stderr)
        # Staging preserved: no rm -rf of the tree, staged files still there.
        self.assertEqual([e[1] for e in self.hub.events if e[0] == "rm_rf"], [])
        self.assertTrue(self.hub.paths_under_stage())
        self.assertFalse(any(e[0] == "service" for e in self.hub.events))
        # The unrestorable file keeps the new content; the others were
        # restored (reverse order continued past the failed item).
        restored = install_file_dests(self.hub, rollback=True)
        self.assertNotIn("/data/codex/bin/codex_hbus", restored)
        self.assertTrue(restored)

    def test_prunes_only_old_installer_handoffs(self):
        """[PYTHON BEHAVIORAL] after the new handoff, only installer-owned
        webui-handoff-* generations beyond the newest HANDOFF_KEEP are
        removed; other backups are never touched."""
        old = [f"{INST.HANDOFF_ROOT}/webui-handoff-2025010{i}-000000" for i in range(1, 5)]
        other = f"{INST.HANDOFF_ROOT}/webui-irdb-fix-20250101T000000Z"
        self.hub.backup_listing = old + [other]
        code, stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 0, stderr or stdout)
        pruned = kv_multi(stdout, "pruned")
        self.assertEqual(pruned, old[:2])
        rm_rf_targets = [e[1] for e in self.hub.events if e[0] == "rm_rf"]
        self.assertNotIn(other, rm_rf_targets)
        self.assertEqual(set(rm_rf_targets), set(old[:2]) | {self.hub.stage})

    def test_reboot_only_when_cloud_blocker_or_plugins_change(self):
        """[PYTHON BEHAVIORAL] without --no-apply-cloud-restart the hub reboots
        only if netservicestarter.lua, cloud_blocker.conf or an engine plugin
        changed: the engine loads /pkg plugins once, at start."""
        argv = [a for a in self.harness.base_argv() if a != "--no-apply-cloud-restart"]
        code, stdout, stderr = self.harness.run(argv)
        self.assertEqual(code, 0, stderr or stdout)
        self.assertIn(("service", "reboot"), self.hub.events)

        def hub_matching_engine_files():
            hub = FakeHub()
            prime_upgrade_hub(hub)
            same = {
                "/opt/luaworks/tasks/connectserver/netservicestarter.lua":
                    (INST.PAYLOAD / "scripts" / "netservicestarter.lua").read_bytes(),
                "/pkg/codexactivity/codexactivity.lua":
                    (INST.PAYLOAD / "activity" / "codexactivity.lua").read_bytes(),
                "/pkg/codexmqtt/codexmqtt.lua":
                    (INST.PAYLOAD / "mqtt" / "codexmqtt.lua").read_bytes(),
                "/pkg/codexactivity/manifest.json": b'{"plugin":"codexactivity"}\n',
                "/pkg/codexmqtt/manifest.json": b'{"plugin":"codexmqtt"}\n',
            }
            for path, data in same.items():
                hub.fs[path] = {"data": data, "mode": "644"}
            return hub

        hub = hub_matching_engine_files()
        harness = InstallerHarness(hub)
        self.addCleanup(harness.close)
        code, stdout, stderr = harness.run(argv)
        self.assertEqual(code, 0, stderr or stdout)
        self.assertNotIn(("service", "reboot"), hub.events)

        hub = hub_matching_engine_files()
        hub.fs["/pkg/codexactivity/codexactivity.lua"]["data"] = b"-- older writer\n"
        harness = InstallerHarness(hub)
        self.addCleanup(harness.close)
        code, stdout, stderr = harness.run(argv)
        self.assertEqual(code, 0, stderr or stdout)
        self.assertIn(("service", "reboot"), hub.events)
        self.assertIn("engine loads the updated plugins", stdout)


class PythonInstallerFirstInstall(unittest.TestCase):
    """[PYTHON BEHAVIORAL] a hub with no configuration of ours, and a hub whose
    cloud blocker file went missing, both end up with the blocker on."""

    BLOCKER = "/data/codex/cloud_blocker.conf"

    def setUp(self):
        self.hub = FakeHub()
        self.harness = InstallerHarness(self.hub)
        self.addCleanup(self.harness.close)

    def candidate_line(self, stdout: str, dest: str) -> str:
        lines = [l for l in stdout.splitlines() if l.startswith("candidate ") and f"dest={dest} " in l]
        self.assertEqual(len(lines), 1, f"expected one candidate line for {dest}")
        return lines[0]

    def test_fresh_hub_default_run_writes_configuration(self):
        """[PYTHON BEHAVIORAL] with no /data/codex/hub_id on the hub, a default
        run is a first install: it writes the hub id, the cloud blocker (on) and
        a disabled MQTT config, and installs codex_webui last."""
        code, stdout, stderr = self.harness.run(self.harness.base_argv("--hub-id", FAKE_HUB_ID))
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(kv_value(stdout, "verdict"), INST.VERDICT_ALLOWED)
        self.assertEqual(kv_value(stdout, "preflight_mode"), "clean")
        self.assertIn("first install", stdout)
        self.assertEqual(self.hub.fs["/data/codex/hub_id"]["data"], (FAKE_HUB_ID + "\n").encode())
        self.assertEqual(self.hub.fs[self.BLOCKER]["data"], b"1\n")
        mqtt = self.hub.fs["/data/codexmqtt/config.json"]
        self.assertEqual(mqtt["mode"], "600")
        self.assertIn(b'"enabled": false', mqtt["data"].replace(b'"enabled":false', b'"enabled": false'))
        self.assertEqual(install_file_dests(self.hub, rollback=False)[-1], INST.WEBUI_DEST)
        self.assertEqual(self.hub.leftovers(), [])

    def test_fresh_hub_takes_hub_id_from_root_tool_handoff(self):
        """[PYTHON BEHAVIORAL] on a fresh hub the root tool's handoff file is
        enough: the preflight is ALLOWED and creates the hub id, instead of
        BLOCKED_CONFIGURATION_UNCERTAINTY."""
        old = INST.resolve_saved_hub_id
        INST.resolve_saved_hub_id = lambda host: (FAKE_HUB_ID, "test handoff")
        self.addCleanup(setattr, INST, "resolve_saved_hub_id", old)
        code, stdout, stderr = self.harness.run(self.harness.base_argv("--preflight-only"))
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(kv_value(stdout, "verdict"), INST.VERDICT_ALLOWED)
        self.assertIn("action=create", self.candidate_line(stdout, "/data/codex/hub_id"))
        self.assertIn("action=create", self.candidate_line(stdout, self.BLOCKER))
        writes = [e[1] for e in self.hub.events if e[0] == "persistent_write"]
        self.assertEqual(writes, [], "preflight must not write")

    def test_upgrade_creates_missing_cloud_blocker(self):
        """[PYTHON BEHAVIORAL] an installed hub without the blocker file gets it
        created (on); the rest of its configuration is untouched."""
        originals = prime_upgrade_hub(self.hub)
        del self.hub.fs[self.BLOCKER]
        code, stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(kv_value(stdout, "preflight_mode"), "upgrade")
        self.assertNotIn("first install", stdout)
        self.assertEqual(self.hub.fs[self.BLOCKER]["data"], b"1\n")
        for path in ("/data/codex/hub_id", "/data/codexmqtt/config.json", "/etc/tdeenable"):
            self.assertEqual(md5_bytes(self.hub.fs[path]["data"]), md5_bytes(originals[path]))

    def test_upgrade_keeps_existing_cloud_blocker_value(self):
        """[PYTHON BEHAVIORAL] an existing blocker value is preserved, even 0."""
        prime_upgrade_hub(self.hub)
        self.hub.fs[self.BLOCKER] = {"data": b"0\n", "mode": "644"}
        code, stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 0, stderr or stdout)
        self.assertIn("action=preserve", self.candidate_line(stdout, self.BLOCKER))
        self.assertEqual(self.hub.fs[self.BLOCKER]["data"], b"0\n")

    def test_skip_cloud_suppression_never_creates_blocker_on_upgrade(self):
        """[PYTHON BEHAVIORAL] --skip-cloud-suppression leaves a missing blocker
        file missing on an upgrade."""
        prime_upgrade_hub(self.hub)
        del self.hub.fs[self.BLOCKER]
        code, stdout, stderr = self.harness.run(self.harness.base_argv("--skip-cloud-suppression"))
        self.assertEqual(code, 0, stderr or stdout)
        self.assertNotIn(self.BLOCKER, self.hub.fs)


ROOT_TOOL_WRAPPER = b'#!/bin/sh\nexec /data/rootssh/bin/dropbear -s -g -K 300 "$@"\n'


def candidate_flash(stdout: str) -> list[tuple[str, str, int]]:
    """(dest, action, estimated flash bytes) for every candidate line."""
    rows = []
    for line in stdout.splitlines():
        if line.startswith("candidate "):
            rows.append((
                re.search(r" dest=(\S+)", line).group(1),
                re.search(r" action=(\S+)", line).group(1),
                int(re.search(r" flash=(\d+)", line).group(1)),
            ))
    return rows


class PythonInstallerFlash(unittest.TestCase):
    """[PYTHON BEHAVIORAL] measured free flash, harmony-hub-root's Dropbear
    reused as a hard link, and its leftovers removed only on request."""

    DROPBEAR = (INST.PAYLOAD / "bin" / "dropbearmulti").read_bytes()

    def setUp(self):
        self.hub = FakeHub()
        self.harness = InstallerHarness(self.hub)
        self.addCleanup(self.harness.close)

    def root_tool_hub(self, stages: dict[str, tuple[int, int]] | None = None) -> None:
        """A hub harmony-hub-root just rooted: its Dropbear and wrapper, no Melodious."""
        self.hub.fs[INST.ROOT_TOOL_DROPBEAR] = {"data": self.DROPBEAR, "mode": "755"}
        self.hub.fs["/usr/sbin/dropbear"] = {"data": ROOT_TOOL_WRAPPER, "mode": "755"}
        self.hub.fs["/etc/tdeenable"] = {"data": b"1\n", "mode": "644"}
        self.hub.root_stages.update(stages or {})

    def expected_required(self, stdout: str, linked: tuple[str, ...] = ()) -> int:
        copies = sum(
            flash for dest, action, flash in candidate_flash(stdout)
            if action in ("replace", "create") and dest not in linked
        )
        handoff = int(kv_value(stdout, "handoff_estimate_bytes")) // 2 + 1024
        return copies + handoff + INST.flash_margin(copies)

    def required(self, *extra: str) -> int:
        """flash_required_bytes from a preflight against a copy of this hub."""
        hub = FakeHub(self.hub.available_bytes)
        hub.fs = {path: dict(entry) for path, entry in self.hub.fs.items()}
        hub.root_stages = dict(self.hub.root_stages)
        harness = InstallerHarness(hub)
        self.addCleanup(harness.close)
        _code, stdout, _ = harness.run(harness.base_argv("--preflight-only", *extra))
        return int(kv_value(stdout, "flash_required_bytes"))

    def persistent_writes(self) -> list[str]:
        return [e[1] for e in self.hub.events if e[0] == "persistent_write"]

    def test_flash_estimate_models_compression(self):
        """[PYTHON BEHAVIORAL] the jffs2 estimate charges compressed 4 KiB
        nodes: binaries about half, zeros almost nothing, random bytes raw."""
        webui = (INST.PAYLOAD / "bin" / "codex_webui").read_bytes()
        ratio = INST.flash_estimate(webui, "codex_webui") / len(webui)
        self.assertTrue(0.35 < ratio < 0.6, ratio)
        self.assertLess(INST.flash_estimate(bytes(65536), "z"), 2048)
        # One page of incompressible bytes is stored raw.
        random_page = b"".join(hashlib.sha256(bytes([i])).digest() for i in range(128))
        self.assertEqual(INST.flash_estimate(random_page, "r"),
                         ((INST.JFFS2_DIRENT_HEADER + 1 + 3) & ~3) + INST.JFFS2_NODE_HEADER + 4096)

    def test_preflight_reports_measured_flash(self):
        """[PYTHON BEHAVIORAL] the preflight runs codex_flash_free from RAM and
        reports free flash, the estimate for the changed files, and the free
        space left afterwards."""
        prime_upgrade_hub(self.hub)
        code, stdout, _ = self.harness.run(self.harness.base_argv("--preflight-only"))
        self.assertEqual(code, 0, stdout)
        self.assertEqual(kv_value(stdout, "flash_capacity_check"), "measured")
        self.assertEqual(int(kv_value(stdout, "flash_free_bytes")), self.hub.available_bytes)
        self.assertEqual(int(kv_value(stdout, "flash_total_bytes")), self.hub.flash_total)
        self.assertEqual(int(kv_value(stdout, "flash_required_bytes")), self.expected_required(stdout))
        self.assertIsNotNone(kv_value(stdout, "flash_after_bytes"))
        self.assertEqual(self.persistent_writes(), [])

    def test_preflight_blocks_when_flash_is_short(self):
        """[PYTHON BEHAVIORAL] measured free flash below the estimate stops a
        normal run at the preflight with BLOCKED_CAPACITY: no handoff, no
        copies, no writes."""
        prime_upgrade_hub(self.hub)
        self.hub.available_bytes = self.required() - 1
        code, stdout, _ = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 2, stdout)
        self.assertEqual(kv_value(stdout, "verdict"), INST.VERDICT_CAPACITY)
        self.assertIn("not enough free flash", stdout)
        self.assertIn("--skip-flash-check", stdout)
        self.assertEqual(self.persistent_writes(), [])
        self.assertFalse(any(e[0] in ("handoff", "new_copy", "service") for e in self.hub.events))
        self.assertEqual(self.hub.paths_under_stage(), [])

    def test_skip_flash_check_tries_anyway(self):
        """[PYTHON BEHAVIORAL] --skip-flash-check installs past a pessimistic
        estimate; here the copies themselves fit."""
        prime_upgrade_hub(self.hub)
        _code, stdout, _ = self.harness.run(self.harness.base_argv("--preflight-only"))
        copies = sum(f for _d, action, f in candidate_flash(stdout) if action in ("replace", "create"))
        self.hub.available_bytes = copies + 1000
        self.hub.events.clear()
        code, stdout, _ = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 2, stdout)
        self.assertEqual(kv_value(stdout, "verdict"), INST.VERDICT_CAPACITY)
        code, stdout, stderr = self.harness.run(self.harness.base_argv("--skip-flash-check"))
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(kv_value(stdout, "verdict"), INST.VERDICT_ALLOWED)
        self.assertEqual(install_file_dests(self.hub, rollback=False)[-1], INST.WEBUI_DEST)

    def test_unmeasurable_flash_falls_back_to_two_phase_commit(self):
        """[PYTHON BEHAVIORAL] when the probe fails the run is not blocked;
        the two-phase commit still protects the hub."""
        prime_upgrade_hub(self.hub)
        self.hub.flash_probe = False
        code, stdout, _ = self.harness.run(self.harness.base_argv("--preflight-only"))
        self.assertEqual(code, 0, stdout)
        self.assertEqual(kv_value(stdout, "flash_capacity_check"), "two-phase-commit")
        self.assertIsNone(kv_value(stdout, "flash_free_bytes"))
        self.assertIn("couldn't be measured", stdout)
        self.assertEqual(kv_value(stdout, "verdict"), INST.VERDICT_ALLOWED)

    def test_missing_helper_falls_back(self):
        """[PYTHON BEHAVIORAL] a payload without the probe binary uploads no
        probe and falls back to the two-phase commit."""
        prime_upgrade_hub(self.hub)
        old = INST.FLASH_HELPER
        INST.FLASH_HELPER = INST.PAYLOAD / "helpers" / "missing-flash-probe"
        self.addCleanup(setattr, INST, "FLASH_HELPER", old)
        code, stdout, _ = self.harness.run(self.harness.base_argv("--preflight-only"))
        self.assertEqual(code, 0, stdout)
        self.assertEqual(kv_value(stdout, "flash_capacity_check"), "two-phase-commit")
        self.assertIn("is missing", stdout)
        self.assertNotIn(("flash_probe",), self.hub.events)

    def test_root_tool_dropbear_hard_linked_on_first_install(self):
        """[PYTHON BEHAVIORAL] harmony-hub-root's byte-identical dropbearmulti
        becomes ours by hard link: no second copy, and the estimate leaves it out."""
        self.root_tool_hub()
        code, stdout, stderr = self.harness.run(self.harness.base_argv("--hub-id", FAKE_HUB_ID))
        self.assertEqual(code, 0, stderr or stdout)
        self.assertIs(self.hub.fs[INST.DROPBEAR_DEST], self.hub.fs[INST.ROOT_TOOL_DROPBEAR])
        self.assertIn(("link", INST.ROOT_TOOL_DROPBEAR, INST.DROPBEAR_DEST), self.hub.events)
        self.assertNotIn(("new_copy", INST.DROPBEAR_DEST), self.hub.events)
        self.assertEqual(kv_value(stdout, "flash_link dest"),
                         f"{INST.DROPBEAR_DEST} source={INST.ROOT_TOOL_DROPBEAR}")
        self.assertEqual(int(kv_value(stdout, "flash_required_bytes")),
                         self.expected_required(stdout, linked=(INST.DROPBEAR_DEST,)))
        wrapper = (INST.PAYLOAD / "scripts" / "dropbear").read_bytes()
        self.assertEqual(self.hub.fs["/usr/sbin/dropbear"]["data"], wrapper)
        self.assertEqual(self.hub.leftovers(), [])

    # A stand-in for the other build of the same Dropbear (the real stripped
    # one is a MIPS strip away), registered as equivalent for the test.
    OTHER_BUILD = DROPBEAR[: len(DROPBEAR) - 41644]

    def other_build_known(self):
        version = INST.DROPBEAR_BUILDS[hashlib.md5(self.DROPBEAR).hexdigest()]
        other = {hashlib.md5(self.OTHER_BUILD).hexdigest(): version}
        return mock.patch.dict(INST.DROPBEAR_BUILDS, other)

    def test_payload_dropbear_is_a_known_build(self):
        """[PYTHON BEHAVIORAL] the shipped dropbearmulti is listed in
        DROPBEAR_BUILDS, or no other build would count as the same program."""
        self.assertIn(hashlib.md5(self.DROPBEAR).hexdigest(), INST.DROPBEAR_BUILDS)

    def test_a_new_dropbear_version_still_replaces_the_old_one(self):
        """[PYTHON BEHAVIORAL] builds count as each other only within one
        Dropbear version: a hub with an older version's build gets ours."""
        ours = hashlib.md5(self.DROPBEAR).hexdigest()
        old = hashlib.md5(self.OTHER_BUILD).hexdigest()
        with mock.patch.dict(INST.DROPBEAR_BUILDS, {old: "2020.1"}):
            self.assertFalse(INST.hub_copy_current(INST.DROPBEAR_DEST, old, ours))
        with self.other_build_known():
            self.assertTrue(INST.hub_copy_current(INST.DROPBEAR_DEST, old, ours))
            self.assertFalse(INST.hub_copy_current(INST.WEBUI_DEST, old, ours))

    def test_root_tool_other_dropbear_build_is_linked(self):
        """[PYTHON BEHAVIORAL] a root tool that ships the other (.pdr-stripped)
        build still gets its copy reused by hard link, and the install verifies
        the linked file against that build."""
        self.root_tool_hub()
        self.hub.fs[INST.ROOT_TOOL_DROPBEAR] = {"data": self.OTHER_BUILD, "mode": "755"}
        with self.other_build_known():
            code, stdout, stderr = self.harness.run(self.harness.base_argv("--hub-id", FAKE_HUB_ID))
        self.assertEqual(code, 0, stderr or stdout)
        self.assertIs(self.hub.fs[INST.DROPBEAR_DEST], self.hub.fs[INST.ROOT_TOOL_DROPBEAR])
        self.assertEqual(self.hub.fs[INST.DROPBEAR_DEST]["data"], self.OTHER_BUILD)
        self.assertIn(("link", INST.ROOT_TOOL_DROPBEAR, INST.DROPBEAR_DEST), self.hub.events)
        self.assertNotIn(("new_copy", INST.DROPBEAR_DEST), self.hub.events)
        self.assertEqual(kv_value(stdout, "flash_link dest"),
                         f"{INST.DROPBEAR_DEST} source={INST.ROOT_TOOL_DROPBEAR}")
        self.assertEqual(self.hub.leftovers(), [])

    def test_installed_other_dropbear_build_is_left_alone(self):
        """[PYTHON BEHAVIORAL] once linked, the other build counts as current:
        the next run leaves it (and the link) alone instead of copying ours."""
        self.root_tool_hub()
        self.hub.fs[INST.ROOT_TOOL_DROPBEAR] = {"data": self.OTHER_BUILD, "mode": "755"}
        with self.other_build_known():
            code, stdout, stderr = self.harness.run(self.harness.base_argv("--hub-id", FAKE_HUB_ID))
            self.assertEqual(code, 0, stderr or stdout)
            self.hub.events.clear()
            code, stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 0, stderr or stdout)
        line = next(l for l in stdout.splitlines()
                    if l.startswith(f"destination dest={INST.DROPBEAR_DEST} "))
        self.assertIn("action=unchanged", line)
        self.assertNotIn(("new_copy", INST.DROPBEAR_DEST), self.hub.events)
        self.assertIs(self.hub.fs[INST.DROPBEAR_DEST], self.hub.fs[INST.ROOT_TOOL_DROPBEAR])

    def test_linked_dropbear_is_not_a_leftover_after_a_reboot(self):
        """[PYTHON BEHAVIORAL] after a reboot the hub's unionfs shows the two
        names of the linked Dropbear with different inodes; their link counts
        and MD5 still mark them as one file, so it is neither reported as a
        spare copy nor removed with --remove-root-tool-leftovers."""
        self.root_tool_hub()
        self.hub.fs[INST.ROOT_TOOL_DROPBEAR] = {"data": self.OTHER_BUILD, "mode": "755"}
        with self.other_build_known():
            code, stdout, stderr = self.harness.run(self.harness.base_argv("--hub-id", FAKE_HUB_ID))
            self.assertEqual(code, 0, stderr or stdout)
            self.hub.union_inodes = True
            code, stdout, stderr = self.harness.run(self.harness.base_argv("--remove-root-tool-leftovers"))
        self.assertEqual(code, 0, stderr or stdout)
        self.assertNotIn(f"path={INST.ROOT_TOOL_DROPBEAR}", stdout)
        self.assertNotIn(f"removed_leftover={INST.ROOT_TOOL_DROPBEAR}", stdout)
        self.assertIs(self.hub.fs[INST.DROPBEAR_DEST], self.hub.fs[INST.ROOT_TOOL_DROPBEAR])

    def test_separate_root_dropbear_copy_is_credited_at_its_own_size(self):
        """[PYTHON BEHAVIORAL] a separate (unlinked) root-tool copy of the
        other, smaller build is reported, and credited, at its own size."""
        self.root_tool_hub()
        self.hub.fs[INST.ROOT_TOOL_DROPBEAR] = {"data": self.OTHER_BUILD, "mode": "755"}
        self.hub.fail_link = True  # the first install has to copy ours
        with self.other_build_known():
            code, stdout, stderr = self.harness.run(self.harness.base_argv("--hub-id", FAKE_HUB_ID))
            self.assertEqual(code, 0, stderr or stdout)
            code, stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 0, stderr or stdout)
        self.assertIn(f"root_tool_leftover bytes={len(self.OTHER_BUILD)} files=1 path={INST.ROOT_TOOL_DROPBEAR}", stdout)
        # On a full hub, the advice names the credit: ours scaled to the root copy's size.
        ours_flash = next(int(flash) for dest, _action, flash in candidate_flash(stdout) if dest == INST.DROPBEAR_DEST)
        self.hub.fs[INST.WEBUI_DEST] = {"data": b"an older codex_webui\n", "mode": "755"}  # something to install
        self.hub.available_bytes = 1
        with self.other_build_known():
            code, stdout, _stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(kv_value(stdout, "verdict"), INST.VERDICT_CAPACITY)
        expect = INST.kib(ours_flash * len(self.OTHER_BUILD) // len(self.DROPBEAR))
        self.assertIn(f"--remove-root-tool-leftovers) frees about {expect}", stdout)

    def test_unknown_root_tool_dropbear_is_not_linked(self):
        """[PYTHON BEHAVIORAL] a root-tool Dropbear that is neither build gets
        an ordinary copy of ours, never a link."""
        self.root_tool_hub()
        self.hub.fs[INST.ROOT_TOOL_DROPBEAR] = {"data": self.OTHER_BUILD, "mode": "755"}
        code, stdout, stderr = self.harness.run(self.harness.base_argv("--hub-id", FAKE_HUB_ID))
        self.assertEqual(code, 0, stderr or stdout)
        self.assertIn(("new_copy", INST.DROPBEAR_DEST), self.hub.events)
        self.assertEqual(self.hub.fs[INST.DROPBEAR_DEST]["data"], self.DROPBEAR)
        self.assertIsNone(kv_value(stdout, "flash_link dest"))

    def test_hard_link_lets_a_tight_hub_install(self):
        """[PYTHON BEHAVIORAL] flash that fits everything but a second Dropbear
        is enough once the root tool's copy is linked, and too little without it."""
        self.root_tool_hub()
        need = self.required("--hub-id", FAKE_HUB_ID)
        self.hub.available_bytes = need
        code, stdout, stderr = self.harness.run(self.harness.base_argv("--hub-id", FAKE_HUB_ID))
        self.assertEqual(code, 0, stderr or stdout)
        self.assertIsNotNone(kv_value(stdout, "flash_free_after_bytes"))

        hub = FakeHub(need)  # same hub without the root tool's copy
        hub.fs["/etc/tdeenable"] = {"data": b"1\n", "mode": "644"}
        harness = InstallerHarness(hub)
        self.addCleanup(harness.close)
        code, stdout, _ = harness.run(harness.base_argv("--hub-id", FAKE_HUB_ID))
        self.assertEqual(code, 2, stdout)
        self.assertEqual(kv_value(stdout, "verdict"), INST.VERDICT_CAPACITY)

    def test_link_failure_copies_instead(self):
        """[PYTHON BEHAVIORAL] a filesystem that refuses the hard link gets an
        ordinary verified copy."""
        self.root_tool_hub()
        self.hub.fail_link = True
        code, stdout, stderr = self.harness.run(self.harness.base_argv("--hub-id", FAKE_HUB_ID))
        self.assertEqual(code, 0, stderr or stdout)
        self.assertIn("copying instead", stdout)
        self.assertIn(("new_copy", INST.DROPBEAR_DEST), self.hub.events)
        self.assertIsNot(self.hub.fs[INST.DROPBEAR_DEST], self.hub.fs[INST.ROOT_TOOL_DROPBEAR])
        self.assertEqual(self.hub.fs[INST.DROPBEAR_DEST]["data"], self.DROPBEAR)
        self.assertEqual(self.hub.leftovers(), [])

    def test_rollback_after_link_keeps_root_tool_dropbear(self):
        """[PYTHON BEHAVIORAL] rolling back removes only our name for the
        linked Dropbear; the root tool's copy and wrapper keep SSH working."""
        self.root_tool_hub()
        self.hub.fail_rename_dest = INST.WEBUI_DEST
        code, _stdout, stderr = self.harness.run(self.harness.base_argv("--hub-id", FAKE_HUB_ID))
        self.assertEqual(code, 1, stderr)
        self.assertIn("install failed and was rolled back", stderr)
        self.assertNotIn(INST.DROPBEAR_DEST, self.hub.fs)
        self.assertEqual(self.hub.fs[INST.ROOT_TOOL_DROPBEAR]["data"], self.DROPBEAR)
        self.assertEqual(self.hub.fs[INST.ROOT_TOOL_DROPBEAR]["mode"], "755")
        self.assertEqual(self.hub.fs["/usr/sbin/dropbear"]["data"], ROOT_TOOL_WRAPPER)
        self.assertEqual(self.hub.leftovers(), [])

    def test_leftovers_reported_but_kept_without_flag(self):
        """[PYTHON BEHAVIORAL] root-tool staging folders are listed with their
        size and a hint, and left alone."""
        stages = {"/data/codexssh_19f9ec4dbc1_094b_stage": (771_000, 556),
                  "/data/codexssh_19f9ed7731a_7bc7_stage": (771_000, 556)}
        self.root_tool_hub(stages)
        code, stdout, stderr = self.harness.run(self.harness.base_argv("--hub-id", FAKE_HUB_ID))
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(kv_multi(stdout, "root_tool_leftover bytes"),
                         [f"771000 files=556 path={p}" for p in sorted(stages)])
        self.assertIn("--remove-root-tool-leftovers", stdout)
        rm_rf_targets = [e[1] for e in self.hub.events if e[0] == "rm_rf"]
        self.assertEqual(rm_rf_targets, [self.hub.stage])
        self.assertEqual(sorted(self.hub.root_stages), sorted(stages))

    def test_leftovers_removed_before_install_with_flag(self):
        """[PYTHON BEHAVIORAL] --remove-root-tool-leftovers deletes exactly the
        staging folders before the handoff and phase 1; the root tool's
        Dropbear stays while SSH still runs it."""
        stages = {"/data/codexssh_19f9ec4dbc1_094b_stage": (771_000, 556)}
        self.root_tool_hub(stages)
        code, stdout, stderr = self.harness.run(
            self.harness.base_argv("--hub-id", FAKE_HUB_ID, "--remove-root-tool-leftovers"))
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(kv_multi(stdout, "removed_leftover"), list(stages))
        removed = self.hub.first_index(lambda e: e == ("rm_rf", next(iter(stages))))
        self.assertLess(removed, self.hub.first_index(lambda e: e[0] == "handoff"))
        self.assertLess(removed, self.hub.first_index(lambda e: e[0] in ("new_copy", "link")))
        self.assertEqual(self.hub.root_stages, {})
        self.assertIn(INST.ROOT_TOOL_DROPBEAR, self.hub.fs)
        self.assertIsNotNone(kv_value(stdout, "flash_free_after_cleanup_bytes"))

    def test_leftover_removal_unblocks_a_short_hub(self):
        """[PYTHON BEHAVIORAL] a hub too full for the install fits once the
        root tool's staging folder goes, and the block says so."""
        stages = {"/data/codexssh_19f9ec4dbc1_094b_stage": (900_000, 640)}
        self.root_tool_hub(stages)
        self.hub.available_bytes = self.required("--hub-id", FAKE_HUB_ID) - 300_000
        code, stdout, _ = self.harness.run(self.harness.base_argv("--hub-id", FAKE_HUB_ID))
        self.assertEqual(code, 2, stdout)
        self.assertEqual(kv_value(stdout, "verdict"), INST.VERDICT_CAPACITY)
        self.assertIn("Removing harmony-hub-root's leftovers", stdout)
        self.assertEqual(self.persistent_writes(), [])
        code, stdout, stderr = self.harness.run(
            self.harness.base_argv("--hub-id", FAKE_HUB_ID, "--remove-root-tool-leftovers"))
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(kv_value(stdout, "verdict"), INST.VERDICT_ALLOWED)

    def test_too_little_even_after_cleanup_removes_nothing(self):
        """[PYTHON BEHAVIORAL] when removing the leftovers wouldn't be enough
        either, the preflight blocks before deleting anything."""
        stages = {"/data/codexssh_19f9ec4dbc1_094b_stage": (900_000, 640)}
        self.root_tool_hub(stages)
        self.hub.available_bytes = self.required("--hub-id", FAKE_HUB_ID) - 700_000
        code, stdout, _ = self.harness.run(
            self.harness.base_argv("--hub-id", FAKE_HUB_ID, "--remove-root-tool-leftovers"))
        self.assertEqual(code, 2, stdout)
        self.assertEqual(kv_value(stdout, "verdict"), INST.VERDICT_CAPACITY)
        self.assertEqual(sorted(self.hub.root_stages), sorted(stages))
        self.assertEqual(self.persistent_writes(), [])

    def test_preflight_only_never_removes_leftovers(self):
        """[PYTHON BEHAVIORAL] --preflight-only with the cleanup flag still
        writes and removes nothing."""
        stages = {"/data/codexssh_19f9ec4dbc1_094b_stage": (771_000, 556)}
        self.root_tool_hub(stages)
        code, stdout, _ = self.harness.run(self.harness.base_argv(
            "--hub-id", FAKE_HUB_ID, "--preflight-only", "--remove-root-tool-leftovers"))
        self.assertEqual(code, 0, stdout)
        self.assertEqual([e[1] for e in self.hub.events if e[0] == "rm_rf"], [self.hub.stage])
        self.assertEqual(self.persistent_writes(), [])
        self.assertEqual(sorted(self.hub.root_stages), sorted(stages))

    def test_spare_root_tool_dropbear_removed_once_ssh_runs_ours(self):
        """[PYTHON BEHAVIORAL] on a hub already running Melodious, the root
        tool's separate Dropbear copy is a leftover; the cleanup flag removes
        it even when nothing else needs installing."""
        prime_current_hub(self.hub)
        self.hub.fs[INST.ROOT_TOOL_DROPBEAR] = {"data": self.DROPBEAR, "mode": "755"}
        before = self.hub.available_bytes
        code, stdout, _ = self.harness.run(self.harness.base_argv("--preflight-only"))
        self.assertIn(f"root_tool_leftover bytes={len(self.DROPBEAR)} files=1 path={INST.ROOT_TOOL_DROPBEAR}", stdout)
        code, stdout, stderr = self.harness.run(self.harness.base_argv("--remove-root-tool-leftovers"))
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(kv_multi(stdout, "removed_leftover"), [INST.ROOT_TOOL_DROPBEAR])
        for path in INST.ROOT_TOOL_FILES:
            self.assertNotIn(path, self.hub.fs)
        self.assertIn(INST.DROPBEAR_DEST, self.hub.fs)
        self.assertGreater(self.hub.available_bytes, before)
        self.assertFalse(any(e[0] in ("handoff", "service", "new_copy") for e in self.hub.events))

    def test_root_tool_dropbear_kept_while_ours_is_damaged(self):
        """[PYTHON BEHAVIORAL] while our Dropbear isn't a known build (a
        damaged copy), the root tool's working one is never offered for removal."""
        # A root copy that isn't a listed build is never a link source, so
        # only the known-build check on ours can keep it.
        argv = self.harness.base_argv("--preflight-only", "--remove-root-tool-leftovers")
        prime_current_hub(self.hub)
        self.hub.fs[INST.ROOT_TOOL_DROPBEAR] = {"data": self.OTHER_BUILD, "mode": "755"}
        code, stdout, stderr = self.harness.run(argv)
        self.assertEqual(code, 0, stderr or stdout)
        self.assertIn(f"root_tool_leftover bytes={len(self.OTHER_BUILD)} files=1 path={INST.ROOT_TOOL_DROPBEAR}", stdout)

        self.hub.fs[INST.DROPBEAR_DEST] = {"data": self.DROPBEAR[:4096], "mode": "755"}
        code, stdout, stderr = self.harness.run(argv)
        self.assertEqual(code, 0, stderr or stdout)
        self.assertNotIn(f"path={INST.ROOT_TOOL_DROPBEAR}", stdout)
        self.assertIn(INST.ROOT_TOOL_DROPBEAR, self.hub.fs)

    def test_spare_root_tool_dropbear_kept_while_ssh_uses_it(self):
        """[PYTHON BEHAVIORAL] with the root tool's wrapper still in
        /usr/sbin/dropbear its Dropbear is never offered for removal."""
        prime_current_hub(self.hub)
        self.hub.fs[INST.ROOT_TOOL_DROPBEAR] = {"data": self.DROPBEAR, "mode": "755"}
        self.hub.fs["/usr/sbin/dropbear"] = {"data": ROOT_TOOL_WRAPPER, "mode": "755"}
        code, stdout, stderr = self.harness.run(self.harness.base_argv("--remove-root-tool-leftovers"))
        self.assertEqual(code, 0, stderr or stdout)
        self.assertNotIn(f"path={INST.ROOT_TOOL_DROPBEAR}", stdout.replace("source=", ""))
        self.assertIn(INST.ROOT_TOOL_DROPBEAR, self.hub.fs)
        self.assertEqual(kv_multi(stdout, "removed_leftover"), [])

    def test_root_tool_dropbear_kept_when_it_is_the_link_source(self):
        """[PYTHON BEHAVIORAL] when our Dropbear is out of date and the root
        tool's copy matches the payload, the cleanup flag keeps that copy and
        phase 1 links it."""
        prime_current_hub(self.hub)
        self.hub.fs[INST.DROPBEAR_DEST] = {"data": b"fake-older-dropbear\n" * 64, "mode": "755"}
        self.hub.fs[INST.ROOT_TOOL_DROPBEAR] = {"data": self.DROPBEAR, "mode": "755"}
        code, stdout, stderr = self.harness.run(self.harness.base_argv("--remove-root-tool-leftovers"))
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(kv_multi(stdout, "removed_leftover"), [])
        self.assertIn(("link", INST.ROOT_TOOL_DROPBEAR, INST.DROPBEAR_DEST), self.hub.events)
        self.assertIs(self.hub.fs[INST.DROPBEAR_DEST], self.hub.fs[INST.ROOT_TOOL_DROPBEAR])

    def test_linked_dropbear_is_not_a_leftover(self):
        """[PYTHON BEHAVIORAL] a root-tool name that is a hard link to our
        Dropbear frees nothing, so it is not reported."""
        prime_current_hub(self.hub)
        self.hub.fs[INST.ROOT_TOOL_DROPBEAR] = self.hub.fs[INST.DROPBEAR_DEST]
        code, stdout, _ = self.harness.run(self.harness.base_argv("--preflight-only"))
        self.assertEqual(code, 0, stdout)
        self.assertEqual(kv_multi(stdout, "root_tool_leftover bytes"), [])

    def test_free_flash_reported_after_install(self):
        """[PYTHON BEHAVIORAL] a finished install measures flash once more,
        after the originals were replaced, before removing the staging tree."""
        prime_upgrade_hub(self.hub)
        code, stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(int(kv_value(stdout, "flash_free_after_bytes")), self.hub.available_bytes)
        probes = self.hub.indices(lambda e: e == ("flash_probe",))
        self.assertEqual(len(probes), 2)
        self.assertLess(probes[-1], self.hub.first_index(lambda e: e == ("rm_rf", self.hub.stage)))


class PythonInstallerFileStatus(unittest.TestCase):
    """[PYTHON BEHAVIORAL] the BusyBox ls/md5sum probe powers discovery and
    post-install verification; the fake fails any stat/readlink/mktemp/df."""

    def setUp(self):
        self.hub = FakeHub()
        self.originals = prime_upgrade_hub(self.hub)
        self.harness = InstallerHarness(self.hub)
        self.addCleanup(self.harness.close)

    def test_probe_covers_candidates_and_handoff_paths(self):
        """[PYTHON BEHAVIORAL] one probe covers every candidate and handoff path."""
        code, stdout, stderr = self.harness.run(self.harness.base_argv("--preflight-only"))
        self.assertEqual(code, 0, stderr or stdout)
        probes = [e[1] for e in self.hub.events if e[0] == "probe"]
        self.assertEqual(len(probes), 1)
        for path in INST.HANDOFF_REQUIRED_PATHS:
            self.assertIn(path, probes[0], f"handoff path {path} not probed")

    def test_post_install_wrong_mode_rejected(self):
        """[PYTHON BEHAVIORAL] a post-install mode mismatch fails verification
        and rolls back."""
        self.hub.file_status_wrong_mode["/data/codex/init.sh"] = "777"
        code, _stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 1, stderr)
        self.assertIn("post-install mode mismatch", stderr)
        self.assertIn("install failed and was rolled back", stderr)

    def test_malformed_probe_output_is_fatal_validation(self):
        """[PYTHON BEHAVIORAL] an unparsable probe record is a validation
        failure with no persistent mutation."""
        self.hub.file_status_garbage.add("/data/codex/init.sh")
        code, stdout, stderr = self.harness.run(self.harness.base_argv("--preflight-only"))
        self.assertNotEqual(code, 0, stderr or stdout)
        self.assertIn("file-status", stderr)
        self.assertEqual([e[1] for e in self.hub.events if e[0] == "persistent_write"], [])

    def test_symlink_destination_is_refused(self):
        """[PYTHON BEHAVIORAL] a candidate destination that is a symlink is a
        validation failure, never written through."""
        self.hub.symlinks.add("/data/codex/init.sh")
        code, stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertNotEqual(code, 0, stderr or stdout)
        self.assertIn("symlink", stderr)
        self.assertEqual([e[1] for e in self.hub.events if e[0] == "persistent_write"], [])

    def test_absence_and_presence_via_probe(self):
        """[PYTHON BEHAVIORAL] absent if-missing destinations are created and
        present ones replaced with the payload bytes."""
        code, stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 0, stderr or stdout)
        for path in ("/pkg/codexactivity/manifest.json", "/pkg/codexmqtt/manifest.json"):
            self.assertIn(path, self.hub.fs, f"absent {path} must be created")
        self.assertEqual(
            md5_bytes(self.hub.fs["/data/codex/bin/codex_webui"]["data"]),
            md5_bytes((INST.PAYLOAD / "bin" / "codex_webui").read_bytes()),
        )

    def test_perm_string_round_trip(self):
        """[PYTHON BEHAVIORAL] ls -l permission strings map to octal modes."""
        for mode in ("755", "644", "600", "700", "777"):
            self.assertEqual(INST.perm_to_mode(mode_to_perm(mode)), mode)
        self.assertEqual(INST.perm_to_mode("-rwsr-xr-x"), "4755")
        self.assertEqual(INST.perm_to_mode("-rwxr-xr-t"), "1755")
        with self.assertRaises(ValueError):
            INST.perm_to_mode("drwxr-xr-x")


RF_INFO_ONE_SMART = '{"id":1,"data":{"EquadID":"34827","Devices":[{"EquadID":"16414","SkinId":"","DeviceIndex":"1","RFID":"1"}],"DeviceCount":1},"code":200}'
RF_INFO_TWO_SMART = '{"id":1,"data":{"EquadID":"34827","Devices":[{"EquadID":"16414","SkinId":"","DeviceIndex":"1","RFID":"1"},{"EquadID":"16414","SkinId":"","DeviceIndex":"2","RFID":"2"}],"DeviceCount":2},"code":200}'


def fake_stock_hal() -> bytes:
    """A stand-in for the hub's /usr/bin/hal: filler bytes carrying the real
    stock instructions at the real patch offsets (hal itself is never in
    the repo). Tests point HAL_STOCK_MD5/HAL_MULTI_MD5 at it."""
    data = bytearray((b"fake-hal-image-" * 25000)[:363640])  # hal's size: the two-screen edits reach its end
    for offset, old, _new in INST.HAL_MULTI_PATCH:
        data[offset : offset + len(old)] = old
    return bytes(data)


def fake_patched_hal() -> bytes:
    data = bytearray(fake_stock_hal())
    for offset, _old, new in INST.HAL_MULTI_PATCH:
        data[offset : offset + len(new)] = new
    return bytes(data)


class PythonInstallerMultiRemote(unittest.TestCase):
    """[PYTHON BEHAVIORAL] --multi-remote on|off: the patched hal is built from
    the hub's own file and fails closed on any other build, the setting
    reboots the hub only when it changes, off removes the copy, and leaving
    the flag out touches nothing."""

    def setUp(self):
        saved = (INST.HAL_STOCK_MD5, INST.HAL_MULTI_MD5)
        INST.HAL_STOCK_MD5 = md5_bytes(fake_stock_hal())
        INST.HAL_MULTI_MD5 = md5_bytes(fake_patched_hal())

        def restore():
            INST.HAL_STOCK_MD5, INST.HAL_MULTI_MD5 = saved

        self.addCleanup(restore)

    def current_hub(self, conf: bytes | None = None, copy: bool = False) -> FakeHub:
        """A hub that already runs this payload, with the stock hal."""
        hub = FakeHub()
        prime_current_hub(hub)
        hub.fs[INST.HAL_PATH] = {"data": fake_stock_hal(), "mode": "755"}
        if conf is not None:
            hub.fs[INST.MULTI_REMOTE_CONF] = {"data": conf, "mode": "644"}
        if copy:
            hub.fs[INST.HAL_MULTI_DEST] = {"data": fake_patched_hal(), "mode": "755"}
        return hub

    def run_on(self, hub: FakeHub, *extra: str, restart: bool = True) -> tuple[int, str, str]:
        harness = InstallerHarness(hub)
        self.addCleanup(harness.close)
        argv = harness.base_argv(*extra)
        if restart:
            argv = [a for a in argv if a != "--no-apply-cloud-restart"]
        elif "--no-apply-cloud-restart" not in argv:
            argv.append("--no-apply-cloud-restart")
        return harness.run(argv)

    def writes(self, hub: FakeHub) -> list[str]:
        return [e[1] for e in hub.events if e[0] == "persistent_write"]

    def test_patch_changes_only_the_two_instructions(self):
        """[PYTHON BEHAVIORAL] the patch rewrites exactly the table's bytes,
        accepts an already-patched copy as is, and refuses anything else."""
        stock, patched = fake_stock_hal(), INST.patched_hal(fake_stock_hal())
        self.assertEqual(patched, fake_patched_hal())
        diff = [i for i in range(len(stock)) if stock[i] != patched[i]]
        allowed = {o + k for o, old, _ in INST.HAL_MULTI_PATCH for k in range(len(old))}
        self.assertTrue(diff and set(diff) <= allowed, diff)
        self.assertEqual(INST.patched_hal(patched), patched)
        with self.assertRaisesRegex(RuntimeError, "not the hal build"):
            INST.patched_hal(stock + b"x")
        wrong = bytearray(stock)
        wrong[INST.HAL_MULTI_PATCH[0][0]] ^= 0xFF
        INST.HAL_STOCK_MD5 = md5_bytes(bytes(wrong))
        with self.assertRaisesRegex(RuntimeError, "unexpected bytes"):
            INST.patched_hal(bytes(wrong))

    def test_real_patch_matches_rcs_local(self):
        """[PYTHON BEHAVIORAL] the patch file is well formed, the boot script
        binds only the builds it describes, and it carries both parts: the
        same-model unpair kept for 16417 and 16420 only, and the per-slot key
        threads."""
        doc = json.loads(INST.HAL_PATCH_FILE.read_text(encoding="utf-8"))
        self.assertEqual(doc["stock_md5"], "a3fdd823440c43f36e235fe51c45f008")
        self.assertEqual(doc["size"], 363640)
        rcs = (INST.PAYLOAD / "scripts" / "rcS.local").read_text(encoding="utf-8")
        for value in (doc["stock_md5"], doc["patched_md5"], INST.HAL_MULTI_DEST, INST.MULTI_REMOTE_CONF, INST.HAL_PATH):
            self.assertIn(value, rcs)
        offsets = [o for o, _, _ in INST.HAL_MULTI_PATCH]
        self.assertEqual(offsets, sorted(set(offsets)))  # sorted, no overlap
        for offset, old, new in INST.HAL_MULTI_PATCH:
            self.assertEqual((len(old), len(new)), (4, 4))
            self.assertNotEqual(old, new)
            self.assertLess(offset + 4, doc["size"])
        table = {o: (old, new) for o, old, new in INST.HAL_MULTI_PATCH}
        # Same-model unpair: skip unless 16417..16420 (only 16417 and 16420
        # reach it); odd (16417) keeps the stock flag check, even unpairs.
        self.assertEqual(table[0x27CDC], (bytes.fromhex("3406880e"), bytes.fromhex("2466bfdf")))  # addiu a2, v1, -16417
        self.assertEqual(table[0x27CE0][1], bytes.fromhex("2cc60004"))  # sltiu a2, a2, 4
        self.assertEqual(table[0x27CE4][1], bytes.fromhex("10c0ffd9"))  # beqz a2, 0x427c4c (skip)
        self.assertEqual(table[0x27CE8][1], bytes.fromhex("30660001"))  # andi a2, v1, 1
        self.assertEqual(table[0x27CEC][1], bytes.fromhex("10c00004"))  # beqz a2, 0x427d00 (unpair)
        self.assertEqual(table[0x07B04], (bytes.fromhex("8c920000"), bytes.fromhex("00809021")))  # arg by value
        self.assertIn(0x07B64, table)  # the key thread's malloc'd subscriber

    def test_preflight_on_writes_nothing(self):
        """[PYTHON BEHAVIORAL] --preflight-only --multi-remote on reads hal and
        stages the copy in RAM only."""
        hub = self.current_hub()
        code, stdout, stderr = self.run_on(hub, "--preflight-only", "--multi-remote", "on")
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(kv_value(stdout, "multi_remote"), "on")
        self.assertIn(("raw_read", INST.HAL_PATH), hub.events)
        self.assertEqual(self.writes(hub), [])
        self.assertNotIn(INST.HAL_MULTI_DEST, hub.fs)

    def test_on_installs_the_patched_copy_and_reboots(self):
        """[PYTHON BEHAVIORAL] on: the patched copy and conf=1 go in, nothing
        else changes, and the hub reboots so rcS.local binds it."""
        hub = self.current_hub()
        code, stdout, stderr = self.run_on(hub, "--multi-remote", "on")
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(hub.fs[INST.HAL_MULTI_DEST]["data"], fake_patched_hal())
        self.assertEqual(hub.fs[INST.HAL_MULTI_DEST]["mode"], "755")
        self.assertEqual(hub.fs[INST.MULTI_REMOTE_CONF]["data"], b"1\n")
        self.assertEqual(hub.fs[INST.HAL_PATH]["data"], fake_stock_hal())
        self.assertEqual(set(install_file_dests(hub, rollback=False)), {INST.HAL_MULTI_DEST, INST.MULTI_REMOTE_CONF})
        self.assertIn(("service", "reboot"), hub.events)
        self.assertIn("starts the multi-remote hal", stdout)

        # Run again: nothing changes, no reboot.
        hub.events.clear()
        code, stdout, stderr = self.run_on(hub, "--multi-remote", "on")
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(self.writes(hub), [])
        self.assertNotIn(("service", "reboot"), hub.events)

    def test_on_while_bound_reads_the_patched_copy(self):
        """[PYTHON BEHAVIORAL] with the copy bind-mounted, /usr/bin/hal reads
        as the patched build; that is accepted as is."""
        hub = self.current_hub(conf=b"1\n", copy=True)
        hub.fs[INST.HAL_PATH] = {"data": fake_patched_hal(), "mode": "755"}
        code, stdout, stderr = self.run_on(hub, "--multi-remote", "on")
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(self.writes(hub), [])

    def test_on_refuses_another_hal_build(self):
        """[PYTHON BEHAVIORAL] any other /usr/bin/hal stops the run before a
        write: the patch is only right for the build it was made from."""
        hub = self.current_hub()
        hub.fs[INST.HAL_PATH]["data"] = b"a different firmware's hal\n" * 100
        code, stdout, stderr = self.run_on(hub, "--multi-remote", "on")
        self.assertNotEqual(code, 0)
        self.assertIn("not the hal build", stdout + stderr)
        self.assertEqual(self.writes(hub), [])

    def test_off_restores_stock_and_leaves_the_copy_to_rcs_local(self):
        """[PYTHON BEHAVIORAL] off while the multi-remote hal runs, one remote of
        each model: the guard goes up, conf=0, the hub reboots into the stock
        hal; the copy stays for rcS.local to delete at boot (deleting it while
        bound would leave /usr/bin/hal a stale handle)."""
        hub = self.current_hub(conf=b"1\n", copy=True)
        hub.hal_bound = True
        code, stdout, stderr = self.run_on(hub, "--multi-remote", "off")
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(kv_value(stdout, "multi_remote_off_check"), "ok")
        self.assertIn(("guard", INST.MULTI_REMOTE_PENDING), hub.events)
        self.assertEqual(hub.fs[INST.MULTI_REMOTE_CONF]["data"], b"0\n")
        self.assertIn(INST.HAL_MULTI_DEST, hub.fs)
        self.assertFalse([e for e in hub.events if e[0] == "rm"])
        self.assertNotIn(("raw_read", INST.HAL_PATH), hub.events)
        self.assertIn(("service", "reboot"), hub.events)
        self.assertIn("starts the stock hal", stdout)
        rcs = (INST.PAYLOAD / "scripts" / "rcS.local").read_text(encoding="utf-8")
        self.assertIn("rm -f /data/codex/bin/hal_multiremote", rcs)

    def test_off_refused_with_two_remotes_of_one_model(self):
        """[PYTHON BEHAVIORAL] off with two Smart Controls paired would boot the
        stock hal onto them and hang its radio: refused before any write, and
        the guard comes down again."""
        hub = self.current_hub(conf=b"1\n", copy=True)
        hub.hal_bound = True
        hub.rf_info = RF_INFO_TWO_SMART
        code, stdout, stderr = self.run_on(hub, "--multi-remote", "off")
        self.assertNotEqual(code, 0)
        self.assertIn("16414 (slots 1, 2)", stdout + stderr)
        self.assertEqual(self.writes(hub), [])
        self.assertIn(("rm", INST.MULTI_REMOTE_PENDING), hub.events)
        self.assertNotIn(("service", "reboot"), hub.events)

    def test_off_refused_during_pairing_or_without_a_slot_table(self):
        """[PYTHON BEHAVIORAL] an open pairing window, an rf.info answer that
        can't be read, or a guard that can't be written refuses off too: the
        check can't vouch for the table until the reboot."""
        expected = {"pairing": "pairing window is open", "garbage": "didn't list its paired remotes",
                    "guard": "couldn't write /var/run/codex-multi-remote-pending"}
        for setup in ("pairing", "garbage", "guard"):
            hub = self.current_hub(conf=b"1\n", copy=True)
            hub.hal_bound = True
            if setup == "pairing":
                hub.rf_pairing = True
            elif setup == "guard":
                hub.guard_fail = True
            else:
                hub.rf_info = "decode_ltcp_payload failed (raw_len=0)"
            code, stdout, stderr = self.run_on(hub, "--multi-remote", "off")
            self.assertNotEqual(code, 0, setup)
            self.assertIn(expected[setup], stdout + stderr)
            self.assertEqual(self.writes(hub), [], setup)

    def test_off_without_restart_refused_while_the_copy_runs(self):
        """[PYTHON BEHAVIORAL] --multi-remote off --no-apply-cloud-restart would
        save 0 and leave the multi-remote hal running, with nothing blocking a
        duplicate pair once the guard lapses: refused before any write, with no
        guard left behind. With the stock hal already running it's harmless."""
        hub = self.current_hub(conf=b"1\n", copy=True)
        hub.hal_bound = True
        code, stdout, stderr = self.run_on(hub, "--multi-remote", "off", restart=False)
        self.assertNotEqual(code, 0)
        self.assertIn("leave out --no-apply-cloud-restart", stdout + stderr)
        self.assertEqual(self.writes(hub), [])
        self.assertNotIn(("guard", INST.MULTI_REMOTE_PENDING), hub.events)
        self.assertNotIn(("service", "reboot"), hub.events)
        hub = self.current_hub(conf=b"1\n", copy=True)
        code, stdout, stderr = self.run_on(hub, "--multi-remote", "off", restart=False)
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(kv_value(stdout, "multi_remote_off_check"), "inactive")
        self.assertEqual(hub.fs[INST.MULTI_REMOTE_CONF]["data"], b"0\n")
        self.assertNotIn(("service", "reboot"), hub.events)

    def test_reboots_when_the_running_hal_is_not_the_one_asked_for(self):
        """[PYTHON BEHAVIORAL] the files can be right while the hal isn't (a
        setting saved without a reboot): on with conf=1 and the copy in place
        but the stock hal running reboots, and so does off with conf=0 while
        the copy still runs. After the reboot the installer checks the mount
        and warns when rcS.local didn't bind what was asked for."""
        hub = self.current_hub(conf=b"1\n", copy=True)
        code, stdout, stderr = self.run_on(hub, "--multi-remote", "on")
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(self.writes(hub), [])
        self.assertIn(("service", "reboot"), hub.events)
        self.assertEqual(kv_values(stdout, "multi_remote_active"), ["no", "yes"])  # before, after the reboot
        self.assertNotIn("WARNING", stdout)

        hub = self.current_hub(conf=b"0\n", copy=True)
        hub.hal_bound = True
        code, stdout, stderr = self.run_on(hub, "--multi-remote", "off")
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(self.writes(hub), [])
        self.assertIn(("service", "reboot"), hub.events)
        self.assertEqual(kv_values(stdout, "multi_remote_active"), ["no"])  # after the reboot

        hub = self.current_hub(conf=b"1\n", copy=True)
        hub.reboot_keeps_hal = True
        code, stdout, stderr = self.run_on(hub, "--multi-remote", "on")
        self.assertEqual(code, 0, stderr or stdout)
        self.assertIn("WARNING: the hub restarted but still runs the stock hal", stdout)

    def test_force_off_skips_the_radio(self):
        """[PYTHON BEHAVIORAL] force-off is for a radio that stopped answering:
        it asks hal nothing (an open window or an unreadable table doesn't stop
        it), still puts the guard up, writes conf=0 and reboots; it warns that
        duplicates would hang the stock hal too. With --no-apply-cloud-restart
        it is refused while the copy runs."""
        hub = self.current_hub(conf=b"1\n", copy=True)
        hub.hal_bound = True
        hub.rf_pairing = True
        hub.rf_info = "decode_ltcp_payload failed (raw_len=0)"
        code, stdout, stderr = self.run_on(hub, "--multi-remote", "force-off")
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(kv_value(stdout, "multi_remote"), "force-off")
        self.assertEqual(kv_value(stdout, "multi_remote_off_check"), "forced")
        self.assertIn("WARNING: force-off skips the radio check", stdout)
        self.assertIn(("guard", INST.MULTI_REMOTE_PENDING), hub.events)
        self.assertEqual(hub.fs[INST.MULTI_REMOTE_CONF]["data"], b"0\n")
        self.assertIn(("service", "reboot"), hub.events)
        self.assertFalse(hub.hal_bound)

        hub = self.current_hub(conf=b"1\n", copy=True)
        hub.hal_bound = True
        code, stdout, stderr = self.run_on(hub, "--multi-remote", "force-off", restart=False)
        self.assertNotEqual(code, 0)
        self.assertIn("leave out --no-apply-cloud-restart", stdout + stderr)
        self.assertEqual(self.writes(hub), [])
        self.assertNotIn(("guard", INST.MULTI_REMOTE_PENDING), hub.events)

    def test_off_preflight_checks_without_a_guard(self):
        """[PYTHON BEHAVIORAL] --preflight-only --multi-remote off reports the
        check but leaves no guard behind and writes nothing."""
        hub = self.current_hub(conf=b"1\n", copy=True)
        hub.hal_bound = True
        code, stdout, stderr = self.run_on(hub, "--preflight-only", "--multi-remote", "off")
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(kv_value(stdout, "multi_remote_off_check"), "ok")
        self.assertNotIn(("guard", INST.MULTI_REMOTE_PENDING), hub.events)
        self.assertEqual(self.writes(hub), [])

    def test_off_when_already_off_changes_nothing(self):
        """[PYTHON BEHAVIORAL] conf already 0 and the stock hal running: the
        check has nothing to do, nothing is written or rebooted, and a leftover
        copy is left for rcS.local."""
        hub = self.current_hub(conf=b"0\n", copy=True)
        code, stdout, stderr = self.run_on(hub, "--multi-remote", "off")
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(kv_value(stdout, "multi_remote_off_check"), "inactive")
        self.assertIn(INST.HAL_MULTI_DEST, hub.fs)
        self.assertEqual(self.writes(hub), [])
        self.assertNotIn(("service", "reboot"), hub.events)

    def test_rf_duplicate_models(self):
        """[PYTHON BEHAVIORAL] the duplicate finder reads hal's rf.info text."""
        self.assertEqual(INST.rf_duplicate_models(RF_INFO_ONE_SMART), "")
        self.assertEqual(INST.rf_duplicate_models(RF_INFO_TWO_SMART), "16414 (slots 1, 2)")
        self.assertIsNone(INST.rf_duplicate_models("decode_ltcp_payload failed"))
        self.assertIsNone(INST.rf_duplicate_models('{"id":1,"code":500}'))

    def test_without_the_flag_nothing_changes(self):
        """[PYTHON BEHAVIORAL] an upgrade without --multi-remote keeps the
        setting and the copy exactly as they are, and never reads hal."""
        hub = self.current_hub(conf=b"1\n", copy=True)
        code, stdout, stderr = self.run_on(hub)
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(kv_value(stdout, "multi_remote"), "unchanged")
        self.assertEqual(hub.fs[INST.MULTI_REMOTE_CONF]["data"], b"1\n")
        self.assertIn(INST.HAL_MULTI_DEST, hub.fs)
        self.assertEqual(self.writes(hub), [])
        self.assertNotIn(("raw_read", INST.HAL_PATH), hub.events)
        self.assertFalse([e for e in hub.events if e[0] == "rm"])


def fake_remotes_patch() -> list[tuple[int, bytes | None, bytes]]:
    """The real two-screen edits, with the stock bytes of the multi-remote
    region taken from the fake stock hal (the real ones would not match it
    anywhere else)."""
    stock = fake_stock_hal()
    return [(o, None if old is None else stock[o : o + len(old)], new) for o, old, new in INST.HAL_REMOTES_PATCH]


def fake_remotes_hal() -> bytes:
    data = bytearray(fake_stock_hal())
    for offset, _old, new in INST.HAL_REMOTES_PATCH:
        data[offset : offset + len(new)] = new
    return bytes(data)


class PythonInstallerTwoScreen(unittest.TestCase):
    """[PYTHON BEHAVIORAL] --two-screen: the copy is built from the hub's own
    hal (stock, or the multi-remote copy with its edits taken back out) and
    fails closed on anything else; the hub reboots only when the setting or
    the running hal changes; "once" is spent by the boot; off leaves the copy
    to rcS.local; and multi-remote is never left on without a copy to carry it."""

    def setUp(self):
        saved = (INST.HAL_STOCK_MD5, INST.HAL_MULTI_MD5, INST.HAL_REMOTES_MD5, INST.HAL_REMOTES_PATCH)
        INST.HAL_STOCK_MD5 = md5_bytes(fake_stock_hal())
        INST.HAL_MULTI_MD5 = md5_bytes(fake_patched_hal())
        INST.HAL_REMOTES_MD5 = md5_bytes(fake_remotes_hal())
        INST.HAL_REMOTES_PATCH = fake_remotes_patch()

        def restore():
            INST.HAL_STOCK_MD5, INST.HAL_MULTI_MD5, INST.HAL_REMOTES_MD5, INST.HAL_REMOTES_PATCH = saved

        self.addCleanup(restore)

    def current_hub(self, two: bytes | None = None, multi: bytes | None = None, multi_copy: bool = False) -> FakeHub:
        hub = FakeHub()
        prime_current_hub(hub)
        hub.read_through_bind = True
        hub.fs[INST.HAL_PATH] = {"data": fake_stock_hal(), "mode": "755"}
        if two is not None:
            hub.fs[INST.TWO_SCREEN_CONF] = {"data": two, "mode": "644"}
        if multi is not None:
            hub.fs[INST.MULTI_REMOTE_CONF] = {"data": multi, "mode": "644"}
        if multi_copy:
            hub.fs[INST.HAL_MULTI_DEST] = {"data": fake_patched_hal(), "mode": "755"}
        return hub

    def run_on(self, hub: FakeHub, *extra: str, restart: bool = True) -> tuple[int, str, str]:
        harness = InstallerHarness(hub)
        self.addCleanup(harness.close)
        argv = harness.base_argv(*extra)
        if restart:
            argv = [a for a in argv if a != "--no-apply-cloud-restart"]
        elif "--no-apply-cloud-restart" not in argv:
            argv.append("--no-apply-cloud-restart")
        return harness.run(argv)

    def writes(self, hub: FakeHub) -> list[str]:
        """Destinations written, without the installer's own temporary names."""
        temp = (INST.NEW_SUFFIX, INST.RESTORE_SUFFIX)
        return sorted({e[1] for e in hub.events if e[0] == "persistent_write" and not e[1].endswith(temp)})

    def reboots(self, hub: FakeHub) -> int:
        return hub.events.count(("service", "reboot"))

    def test_build_from_stock_or_multi_remote_only(self):
        want = fake_remotes_hal()
        self.assertEqual(INST.remotes_hal(fake_stock_hal()), want)
        self.assertEqual(INST.remotes_hal(fake_patched_hal()), want)  # the multi-remote copy, undone first
        self.assertEqual(INST.remotes_hal(want), want)  # already this build
        with self.assertRaisesRegex(RuntimeError, "not the hal build two-screen supports"):
            INST.remotes_hal(fake_stock_hal() + b"x")
        other = bytearray(fake_stock_hal())
        other[0x27CE8:0x27CEC] = bytes.fromhex("24064021")  # the Phase 1 test build's first word
        with self.assertRaisesRegex(RuntimeError, "restart the hub into the stock hal first"):
            INST.remotes_hal(bytes(other))

    def test_real_patch_matches_rcs_local(self):
        """The boot script binds only the builds the patch file names, writes
        the gates before the mount, and clears "once" before either."""
        doc = json.loads(INST.HAL_REMOTES_PATCH_FILE.read_text(encoding="utf-8"))
        rcs = (INST.PAYLOAD / "scripts" / "rcS.local").read_text(encoding="utf-8")
        block = rcs[rcs.index("# Two remotes with a screen") : rcs.index("# Multiple remotes of one model")]
        for value in (doc["stock_md5"], doc["patched_md5"], INST.HAL_REMOTES_DEST, INST.TWO_SCREEN_CONF,
                      INST.HAL_REMOTES_TRIES, INST.HAL_GATES, doc["gates_file"], INST.HAL_PATH):
            self.assertIn(value, block)
        self.assertEqual(doc["gates_file"], INST.HAL_GATES)
        self.assertLess(block.index("echo 0 > /data/codex/two_screen.conf"), block.index("mount -o bind"))
        self.assertLess(block.index('> /var/run/codex_hal_gates'), block.index("mount -o bind"))
        self.assertLess(block.index("hal_remotes.tries &&"), block.index("mount -o bind"))
        self.assertIn("\n" + " | ".join(INST.TWO_SCREEN_SETTINGS.values()) + ") ;;\n", block)
        # and the multi-remote copy is not bound on top of it
        legacy = rcs[rcs.index("# Multiple remotes of one model") :]
        self.assertIn("! grep ' /usr/bin/hal ' /proc/mounts", legacy[: legacy.index("mount -o bind")])

    def test_preflight_writes_nothing(self):
        hub = self.current_hub()
        code, stdout, stderr = self.run_on(hub, "--preflight-only", "--two-screen", "on")
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(kv_value(stdout, "two_screen"), "on")
        self.assertEqual(kv_value(stdout, "two_screen_active"), "no")
        self.assertEqual(self.writes(hub), [])
        self.assertEqual(self.reboots(hub), 0)

    def test_on_installs_the_copy_and_reboots_once(self):
        hub = self.current_hub()
        code, stdout, stderr = self.run_on(hub, "--two-screen", "on")
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(sorted(self.writes(hub)), sorted([INST.HAL_REMOTES_DEST, INST.TWO_SCREEN_CONF, INST.HAL_REMOTES_TRIES]))
        self.assertEqual(hub.fs[INST.HAL_REMOTES_DEST]["data"], fake_remotes_hal())
        self.assertEqual(hub.fs[INST.TWO_SCREEN_CONF]["data"], b"1\n")
        self.assertEqual(hub.fs[INST.HAL_PATH]["data"], fake_stock_hal())  # the stock file is never written
        self.assertEqual(self.reboots(hub), 1)
        self.assertEqual(kv_values(stdout, "two_screen_active"), ["no", "yes"])
        self.assertEqual(kv_values(stdout, "two_screen_gates")[-1], "100")
        self.assertNotIn("WARNING", stdout)
        # again: it reads the bound copy, finds everything in place, restarts nothing
        hub.events.clear()
        code, stdout, stderr = self.run_on(hub, "--two-screen", "on")
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(self.writes(hub), [])
        self.assertEqual(self.reboots(hub), 0)

    def test_copy_must_start_on_the_hub_before_any_reboot(self):
        """The installer runs the installed copy with -h before it restarts the
        hub. A hub whose kernel can't start it keeps running what it runs."""
        hub = self.current_hub()
        code, stdout, stderr = self.run_on(hub, "--two-screen", "on")
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(kv_value(stdout, "two_screen_load_check"), "ok")
        self.assertLess(hub.events.index(("load_check",)), hub.events.index(("service", "reboot")))

        hub = self.current_hub()
        hub.hal_copy_loads = False
        code, stdout, stderr = self.run_on(hub, "--two-screen", "on")
        self.assertNotEqual(code, 0)
        self.assertEqual(kv_value(stdout, "two_screen_load_check"), "failed")
        self.assertIn("could not start", stderr + stdout)
        self.assertEqual(self.reboots(hub), 0)
        self.assertEqual(hub.fs[INST.TWO_SCREEN_CONF]["data"], b"0\n")
        self.assertFalse(hub.remotes_bound)

    def test_once_is_spent_by_the_boot(self):
        hub = self.current_hub()
        code, stdout, stderr = self.run_on(hub, "--two-screen", "serial-once")
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(hub.fs[INST.TWO_SCREEN_CONF]["data"], b"0\n")  # rcS.local cleared it before binding
        self.assertEqual(kv_values(stdout, "two_screen_gates")[-1], "101")
        self.assertEqual(kv_values(stdout, "two_screen_active")[-1], "yes")
        self.assertNotIn("WARNING", stdout)
        # the next boot of any kind is the stock hal, and the copy is gone
        hub.dispatch("(/bin/sleep 2; /sbin/reboot || reboot) >/dev/null 2>&1 & echo rebooting")
        self.assertFalse(hub.remotes_bound)
        self.assertNotIn(INST.HAL_REMOTES_DEST, hub.fs)

    def test_from_a_hub_running_the_multi_remote_copy(self):
        hub = self.current_hub(multi=b"1\n", multi_copy=True)
        hub.hal_bound = True
        code, stdout, stderr = self.run_on(hub, "--two-screen", "on")
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(hub.fs[INST.HAL_REMOTES_DEST]["data"], fake_remotes_hal())
        self.assertTrue(hub.remotes_bound and not hub.hal_bound)
        self.assertEqual(kv_values(stdout, "two_screen_gates")[-1], "110")  # multi-remote stays on, inside it
        self.assertIn(INST.HAL_MULTI_DEST, hub.fs)
        # off again: back to the multi-remote copy, not to stock
        hub.events.clear()
        code, stdout, stderr = self.run_on(hub, "--two-screen", "off")
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(self.reboots(hub), 1)
        self.assertTrue(hub.hal_bound and not hub.remotes_bound)
        self.assertNotIn(INST.HAL_REMOTES_DEST, hub.fs)

    def test_refuses_any_other_hal_before_writing(self):
        hub = self.current_hub()
        hub.fs[INST.HAL_PATH] = {"data": fake_stock_hal() + b"firmware-update", "mode": "755"}
        code, stdout, stderr = self.run_on(hub, "--two-screen", "on")
        self.assertNotEqual(code, 0)
        self.assertIn("not the hal build two-screen supports", stderr + stdout)
        self.assertEqual(self.writes(hub), [])
        self.assertEqual(self.reboots(hub), 0)

    def test_off_writes_the_setting_and_reboots_into_stock(self):
        hub = self.current_hub(two=b"1\n")
        hub.fs[INST.HAL_REMOTES_DEST] = {"data": fake_remotes_hal(), "mode": "755"}
        hub.remotes_bound, hub.hal_gates = True, "100"
        for flag in ("off", "force-off"):
            with self.subTest(flag=flag):
                h = self.current_hub(two=b"1\n")
                h.fs[INST.HAL_REMOTES_DEST] = {"data": fake_remotes_hal(), "mode": "755"}
                h.remotes_bound, h.hal_gates = True, "100"
                code, stdout, stderr = self.run_on(h, "--two-screen", flag)
                self.assertEqual(code, 0, stderr or stdout)
                self.assertEqual(self.writes(h), [INST.TWO_SCREEN_CONF])
                self.assertEqual(h.fs[INST.TWO_SCREEN_CONF]["data"], b"0\n")
                self.assertEqual(self.reboots(h), 1)
                self.assertFalse(h.remotes_bound)
                self.assertEqual(kv_values(stdout, "two_screen_active"), ["yes", "no"])
                self.assertIn("stay paired", stdout)

    def test_off_refused_when_only_this_copy_carries_multi_remote(self):
        hub = self.current_hub(two=b"1\n", multi=b"1\n")  # multi-remote on, no hal_multiremote
        hub.fs[INST.HAL_REMOTES_DEST] = {"data": fake_remotes_hal(), "mode": "755"}
        hub.remotes_bound, hub.hal_gates = True, "110"
        code, stdout, stderr = self.run_on(hub, "--two-screen", "off")
        self.assertNotEqual(code, 0)
        self.assertIn("--two-screen off refused", stderr + stdout)
        self.assertEqual(self.writes(hub), [])
        self.assertEqual(self.reboots(hub), 0)

    def test_multi_remote_on_while_it_runs_only_saves_the_setting(self):
        hub = self.current_hub(two=b"1\n", multi=b"0\n")
        hub.fs[INST.HAL_REMOTES_DEST] = {"data": fake_remotes_hal(), "mode": "755"}
        hub.remotes_bound, hub.hal_gates = True, "100"
        code, stdout, stderr = self.run_on(hub, "--multi-remote", "on")
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(self.writes(hub), [INST.MULTI_REMOTE_CONF])
        self.assertNotIn(INST.HAL_MULTI_DEST, hub.fs)
        self.assertEqual(self.reboots(hub), 1)
        self.assertTrue(hub.remotes_bound)
        self.assertEqual(hub.hal_gates, "110")

    def test_warns_when_the_boot_did_not_bind_it(self):
        hub = self.current_hub()
        hub.reboot_keeps_hal = True
        code, stdout, stderr = self.run_on(hub, "--two-screen", "on")
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(kv_values(stdout, "two_screen_active"), ["no", "no"])
        self.assertIn("WARNING: the hub restarted but does not run the two-screen hal", stdout)

    def test_leaving_the_flag_out_touches_nothing(self):
        hub = self.current_hub(two=b"1\n")
        hub.fs[INST.HAL_REMOTES_DEST] = {"data": fake_remotes_hal(), "mode": "755"}
        hub.remotes_bound, hub.hal_gates = True, "100"
        code, stdout, stderr = self.run_on(hub)
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(self.writes(hub), [])
        self.assertEqual(self.reboots(hub), 0)
        self.assertNotIn(("raw_read", INST.HAL_PATH), hub.events)


class RcsLocalHalBoot(unittest.TestCase):
    """[SHELL BEHAVIORAL] the two hal blocks of rcS.local, run by /bin/sh in a
    scratch root with mount, md5sum, pidof and sleep stubbed: which copy gets
    bound, what it is told, and what a boot leaves behind."""

    STOCK, MULTI = "a3fdd823440c43f36e235fe51c45f008", "cafdd7930309c7d74a6a41a87642f0c1"
    SHELL = "/bin/sh"

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="rcs-hal-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        for d in ("data/codex/bin", "run", "usr/bin", "cache", "proc"):
            (self.root / d).mkdir(parents=True)
        (self.root / "proc/mounts").write_text("rootfs / rootfs rw 0 0\n")
        (self.root / "usr/bin/hal").write_text("stock")
        self.remotes_md5 = json.loads(INST.HAL_REMOTES_PATCH_FILE.read_text(encoding="utf-8"))["patched_md5"]
        rcs = (INST.PAYLOAD / "scripts" / "rcS.local").read_text(encoding="utf-8")
        block = rcs[rcs.index("# Two remotes with a screen") : rcs.index("# USB Ethernet over")]
        self.assertIn("# Multiple remotes of one model", block)
        for path, to in (("/data/codex", "data/codex"), ("/var/run", "run"), ("/usr/bin/hal", "usr/bin/hal"),
                         ("/cache", "cache"), ("/proc/mounts", "proc/mounts")):
            block = block.replace(path, str(self.root / to))
        self.assertNotIn(" /data", block)
        stubs = f"""
md5sum() {{ case "$1" in
  */usr/bin/hal) echo "$HAL_MD5  $1" ;;
  */hal_remotes) echo "$REMOTES_MD5  $1" ;;
  */hal_multiremote) echo "$MULTI_MD5  $1" ;;
esac; }}
mount() {{ [ -n "${{MOUNT_FAILS:-}}" ] && return 1; echo "none {self.root}/usr/bin/hal unionfs rw 0 0 from=$3" >> {self.root}/proc/mounts; }}
pidof() {{ [ -z "${{HAL_DIED:-}}" ]; }}
sleep() {{ :; }}
"""
        self.script = stubs + block + "\nwait\n"

    def put(self, name: str, text: str) -> None:
        (self.root / "data/codex" / name).write_text(text)

    def get(self, name: str) -> str | None:
        path = self.root / name
        return path.read_text() if path.exists() else None

    def boot(self, **env: str) -> str:
        """One boot; returns which copy was bound ("" for the stock hal)."""
        (self.root / "proc/mounts").write_text("rootfs / rootfs rw 0 0\n")  # mounts and /var/run don't outlive a boot
        (self.root / "run/codex_hal_gates").unlink(missing_ok=True)
        full = {"HAL_MD5": self.STOCK, "REMOTES_MD5": self.remotes_md5, "MULTI_MD5": self.MULTI, "PATH": os.environ["PATH"], **env}
        # rcS sources rcS.local without -e; -u is ours, to catch a misspelt variable.
        done = subprocess.run([self.SHELL, "-u", "-c", self.script], env=full, capture_output=True, text=True)
        self.assertEqual((done.returncode, done.stderr), (0, ""), done.stdout)
        bound = [line.rsplit("from=", 1)[1] for line in self.get("proc/mounts").splitlines() if "from=" in line]
        self.assertLessEqual(len(bound), 1, "two copies bound over one another")
        return Path(bound[0]).name if bound else ""

    def test_nothing_configured_is_the_stock_hal(self):
        self.assertEqual(self.boot(), "")
        self.assertIsNone(self.get("run/codex_hal_gates"))
        self.assertIsNone(self.get("cache/codex-init.log"))

    def test_each_setting(self):
        for setting, gates, after in (("1", "100", "1"), ("serial", "101", "serial"), ("once", "100", "0"), ("serial-once", "101", "0")):
            with self.subTest(setting=setting):
                self.put("bin/hal_remotes", "copy")
                self.put("two_screen.conf", setting + "\n")
                self.assertEqual(self.boot(), "hal_remotes")
                self.assertEqual(self.get("run/codex_hal_gates"), gates + "\n")
                self.assertEqual(self.get("data/codex/two_screen.conf").strip(), after)
                self.assertEqual(self.get("data/codex/hal_remotes.tries").strip(), "0")  # it stayed up
                self.assertIn(f"bound over {self.root}/usr/bin/hal (setting {setting}, gates {gates})", self.get("cache/codex-init.log"))

    def test_once_then_any_boot_is_stock_and_the_copy_goes(self):
        self.put("bin/hal_remotes", "copy")
        self.put("two_screen.conf", "once\n")
        self.assertEqual(self.boot(), "hal_remotes")
        self.assertEqual(self.boot(), "")
        self.assertIsNone(self.get("data/codex/bin/hal_remotes"))
        self.assertIsNone(self.get("run/codex_hal_gates"))
        self.assertEqual(self.boot(), "")

    def test_with_multi_remote_on_one_copy_carries_both(self):
        self.put("bin/hal_remotes", "copy")
        self.put("bin/hal_multiremote", "copy")
        self.put("two_screen.conf", "1\n")
        self.put("multi_remote.conf", "1\n")
        self.assertEqual(self.boot(), "hal_remotes")
        self.assertEqual(self.get("run/codex_hal_gates"), "110\n")
        self.assertIsNotNone(self.get("data/codex/bin/hal_multiremote"))  # kept for when two-screen goes off
        self.assertNotIn("multi-remote hal", self.get("cache/codex-init.log"))
        # two-screen off: the multi-remote copy takes over, with no gates file
        self.put("two_screen.conf", "0\n")
        self.assertEqual(self.boot(), "hal_multiremote")
        self.assertIsNone(self.get("run/codex_hal_gates"))
        self.assertIsNone(self.get("data/codex/bin/hal_remotes"))

    def test_multi_remote_alone_is_unchanged(self):
        self.put("bin/hal_multiremote", "copy")
        self.put("multi_remote.conf", "1\n")
        self.assertEqual(self.boot(), "hal_multiremote")
        self.assertIsNone(self.get("run/codex_hal_gates"))
        self.put("multi_remote.conf", "0\n")
        self.assertEqual(self.boot(), "")
        self.assertIsNone(self.get("data/codex/bin/hal_multiremote"))

    def test_fails_closed_on_any_other_build(self):
        for env in ({"HAL_MD5": "0" * 32}, {"REMOTES_MD5": "1" * 32}):
            with self.subTest(env=env):
                self.put("bin/hal_remotes", "copy")
                self.put("two_screen.conf", "1\n")
                self.assertEqual(self.boot(**env), "")
                self.assertIsNone(self.get("run/codex_hal_gates"))
                self.assertIn("skipped (unexpected hal build)", self.get("cache/codex-init.log"))

    def test_garbage_setting_is_off(self):
        self.put("bin/hal_remotes", "copy")
        for text in ("", "2\n", "on\n", "1 1\n", "once more\n"):
            with self.subTest(text=text):
                self.put("bin/hal_remotes", "copy")
                self.put("two_screen.conf", text)
                self.assertEqual(self.boot(), "")
                self.assertIsNone(self.get("data/codex/bin/hal_remotes"))

    def test_three_boots_that_did_not_stay_up(self):
        self.put("bin/hal_remotes", "copy")
        self.put("two_screen.conf", "1\n")
        for n in (1, 2, 3):
            self.assertEqual(self.boot(HAL_DIED="1"), "hal_remotes")
            self.assertEqual(self.get("data/codex/hal_remotes.tries").strip(), str(n))
        self.assertEqual(self.boot(HAL_DIED="1"), "")  # left alone now
        self.assertEqual(self.boot(), "")
        self.assertIn("didn't stay up", self.get("cache/codex-init.log"))
        self.assertEqual(self.get("data/codex/two_screen.conf"), "1\n")
        self.put("hal_remotes.tries", "0\n")  # what saving the setting again does
        self.assertEqual(self.boot(), "hal_remotes")
        self.assertEqual(self.get("data/codex/hal_remotes.tries").strip(), "0")
        # a count that isn't a number is no count
        self.put("hal_remotes.tries", "many\n")
        self.assertEqual(self.boot(), "hal_remotes")

    def test_mount_failure_leaves_no_gates(self):
        self.put("bin/hal_remotes", "copy")
        self.put("two_screen.conf", "1\n")
        self.assertEqual(self.boot(MOUNT_FAILS="1"), "")
        self.assertIsNone(self.get("run/codex_hal_gates"))
        self.assertIn("not bound", self.get("cache/codex-init.log"))


@unittest.skipUnless(os.path.exists("/bin/dash"), "no /bin/dash")
class RcsLocalHalBootDash(RcsLocalHalBoot):
    """The same, under dash: nearer the hub's BusyBox ash than bash is."""

    SHELL = "/bin/dash"


def relocate_hub_script(text: str, root: Path) -> str:
    """Relocate absolute hub paths in a shell script to a scratch root while
    preserving the #!/bin/sh shebang and /dev/null."""
    lines = text.splitlines(keepends=True)
    shebang = ""
    if lines and lines[0].startswith("#!"):
        shebang = lines.pop(0)
    body = "".join(lines)
    # Protect /dev/null first so /dev replacement doesn't touch it.
    sentinel = "__CODEX_DEV_NULL__"
    body = body.replace("/dev/null", sentinel)
    prefixes = (
        "/data/codex-backups",
        "/data/codexmqtt",
        "/data/codex",
        "/data/luaworks",
        "/data",
        "/etc",
        "/var",
        "/usr",
        "/sbin",
        "/cache",
        "/proc",
        "/sys",
        "/lib",
        "/pkg",
        "/opt",
        "/home",
        "/tmp",
        "/dev",
    )
    # Also a ${VAR:-/path} default (offline_egress_guard.sh's GUARD_* paths).
    pattern = re.compile(r"(?:(?<=:-)|(?<![A-Za-z0-9_.-]))(" + "|".join(re.escape(p) for p in prefixes) + r")(?=/|[\s\"';)&|}]|$)")
    body = pattern.sub(lambda m: str(root) + m.group(1), body)
    body = body.replace(sentinel, "/dev/null")
    return shebang + body


class SingleStateBootAndDefenseInDepth(unittest.TestCase):
    """[SHELL/LUA/STATIC] /etc/melodious-off gates rcS.local + init.sh and
    every payload script and Lua plugin."""

    def test_every_payload_script_and_plugin_references_melodious_off(self):
        scripts_dir = INST.PAYLOAD / "scripts"
        checked = []
        for path in sorted(scripts_dir.iterdir()):
            if path.name in ("dropbear", "dropbearkey") or not path.is_file():
                continue
            checked.append(path)
            self.assertIn(
                "/etc/melodious-off",
                path.read_text(encoding="utf-8"),
                f"{path.relative_to(REPO_ROOT)} must check /etc/melodious-off",
            )
        for sub in ("activity", "mqtt"):
            for path in sorted((INST.PAYLOAD / sub).glob("*.lua")):
                checked.append(path)
                self.assertIn(
                    "/etc/melodious-off",
                    path.read_text(encoding="utf-8"),
                    f"{path.relative_to(REPO_ROOT)} must check /etc/melodious-off",
                )
        self.assertGreaterEqual(len(checked), 9)

    def _make_boot_root(self) -> Path:
        root = Path(tempfile.mkdtemp(prefix="rcs-full-"))
        self.addCleanup(shutil.rmtree, root, True)
        for d in (
            "bin", "sbin", "usr/bin", "usr/sbin", "etc/init.d", "etc/dropbear",
            "data/codex/bin", "cache", "proc/sys/vm", "sys/class/input/input0",
            "sys/class/net/ath0", "lib/firmware", "lib/modules/2.6.31-g89d565c",
            "var/run", "var/volatile", "tmp", "dev",
        ):
            (root / d).mkdir(parents=True, exist_ok=True)

        (root / "sys/class/input/input0/tde").write_text("1 0x0\n")
        (root / "sys/class/net/ath0/address").write_text("00:04:20:aa:bb:cc\n")
        (root / "etc/tdeinfo").write_text("5\n")
        (root / "etc/modules.wlan").write_text("adf\nath_hal\n")
        (root / "etc/wpa_supplicant.conf").write_text('network={\n\tssid="Home"\n}\n')
        (root / "etc/hosts").write_text(
            "127.0.0.1\tlocalhost\n127.0.0.1\tping.myharmony.com\t# codex: Harmony Touch sync probe\n"
        )
        (root / "proc/mounts").write_text("rootfs / rootfs rw 0 0\n")
        (root / "proc/mtd").write_text('dev: size erasesize name\nmtd6: 00010000 00010000 "mfg"\n')
        (root / "dev/mtd6").write_text("hw_ver\n\n\n\n00.40\n")
        (root / "lib/firmware/csr8811-a08-pb1.psr").write_text("// pskeys\n")
        (root / "lib/firmware/csr8811-a08.psr").write_text("// pskeys\n")
        (root / "usr/bin/hal").write_text("stock-hal")

        # Enable every Melodious boot feature at once.
        (root / "data/codex/hub_id").write_text("1234\n")
        (root / "data/codex/cloud_blocker.conf").write_text("1\n")
        (root / "data/codex/two_screen.conf").write_text("1\n")
        (root / "data/codex/multi_remote.conf").write_text("1\n")
        (root / "data/codex/usb_eth.conf").write_text("ENABLED=1\n")
        (root / "data/codex/bin/hal_remotes").write_text("remotes-hal")
        (root / "data/codex/bin/hal_multiremote").write_text("multi-hal")

        inv_log = root / "codex_invocations.log"
        sys_log = root / "sys_calls.log"
        mount_log = root / "mounts.log"

        # Real init.sh relocated, plus a tracker line right after #!/bin/sh so any
        # invocation of init.sh itself is recorded before init.sh's own guard.
        real_init = relocate_hub_script((INST.PAYLOAD / "scripts/init.sh").read_text(encoding="utf-8"), root)
        init_lines = [
            f'PATH="{root}/data/codex/bin:{root}/bin:{root}/sbin:{root}/usr/bin:{root}/usr/sbin:/usr/bin:/bin"\n'
            if line.startswith("PATH=") else line
            for line in real_init.splitlines(keepends=True)
        ]
        tracked_init = (
            init_lines[0]
            + f'echo "init.sh $*" >> "{inv_log}"\n'
            + "".join(init_lines[1:])
        )
        init_path = root / "data/codex/init.sh"
        init_path.write_text(tracked_init, encoding="utf-8")
        init_path.chmod(0o755)

        # Every other /data/codex executable records any invocation.
        for rel in (
            "recovery_ap.sh", "usb_eth_service.sh", "offline_egress_guard.sh",
            "androidtv_service.sh", "bin/codex_webui", "bin/codex_bt_pair_agent",
            "bin/codex_bthid_keyboard", "bin/codex_hbus", "bin/dropbear",
        ):
            target = root / "data/codex" / rel
            target.write_text(f'#!/bin/sh\necho "{rel} $*" >> "{inv_log}"\nexit 0\n')
            target.chmod(0o755)

        # Shimmed system commands called by rcS.local.
        shims = {
            "sbin/insmod": f'#!/bin/sh\necho "insmod $*" >> "{sys_log}"\n',
            "sbin/wlanconfig": f'#!/bin/sh\necho "wlanconfig $*" >> "{sys_log}"\n',
            "usr/sbin/wpa_supplicant": f'#!/bin/sh\necho "wpa_supplicant $*" >> "{sys_log}"\n',
            "usr/bin/netmonitor": f'#!/bin/sh\necho "netmonitor $*" >> "{sys_log}"\n',
            "usr/sbin/bccmd": (
                f'#!/bin/sh\necho "bccmd $*" >> "{sys_log}"\n'
                'if [ "$3" = "buildname" ]; then echo "CSR8811 A08"; fi\n'
            ),
            "usr/sbin/hciattach": f'#!/bin/sh\necho "hciattach $*" >> "{sys_log}"\n',
            "usr/sbin/dropbear": f'#!/bin/sh\necho "dropbear $*" >> "{sys_log}"\n',
            "bin/ifup": f'#!/bin/sh\necho "ifup $*" >> "{sys_log}"\n',
            "bin/ps": "#!/bin/sh\nexit 0\n",
            "bin/reboot": f'#!/bin/sh\necho "reboot $*" >> "{sys_log}"\n',
            "bin/mount": (
                f'#!/bin/sh\necho "mount $*" >> "{mount_log}"\n'
                f'echo "none {root}/usr/bin/hal unionfs rw 0 0" >> "{root}/proc/mounts"\n'
            ),
        }
        for rel, content in shims.items():
            p = root / rel
            p.write_text(content)
            p.chmod(0o755)

        real_rcs = relocate_hub_script((INST.PAYLOAD / "scripts/rcS.local").read_text(encoding="utf-8"), root)
        (root / "etc/init.d/rcS.local").write_text(real_rcs, encoding="utf-8")
        (root / "etc/init.d/rcS.local").chmod(0o755)
        return root

    def _run_rcs_local(self, root: Path, wait_bg: bool = True) -> subprocess.CompletedProcess[str]:
        remotes_md5 = json.loads(INST.HAL_REMOTES_PATCH_FILE.read_text(encoding="utf-8"))["patched_md5"]
        stock_md5 = "a3fdd823440c43f36e235fe51c45f008"
        multi_md5 = "cafdd7930309c7d74a6a41a87642f0c1"
        out_log = root / "rcs_stdout.log"
        wait_line = (
            "wait"
            if wait_bg
            else f'i=0; while [ "$i" -lt 50 ] && ! grep "codex init done" "{root}/cache/codex-init.log" >/dev/null 2>&1; do /bin/sleep 0.05; i=$((i + 1)); done; /bin/sleep 0.1'
        )
        wrapper = f"""
exec >"{out_log}" 2>&1
load_modules() {{
  while read module args; do
    case "$module" in \\#*|"") continue ;; esac
    "{root}/sbin/insmod" "{root}/lib/modules/2.6.31-g89d565c/${{module}}.ko" $args
  done < "$1"
}}
uname() {{ echo "2.6.31-g89d565c"; }}
md5sum() {{
  case "$1" in
    */usr/bin/hal) echo "{stock_md5}  $1" ;;
    */hal_remotes) echo "{remotes_md5}  $1" ;;
    */hal_multiremote) echo "{multi_md5}  $1" ;;
  esac
}}
pidof() {{ return 0; }}
sleep() {{ :; }}
run_rcs() {{ . "{root}/etc/init.d/rcS.local"; }}
run_rcs
{wait_line}
"""
        env = {"PATH": f"{root}/bin:{root}/sbin:{root}/usr/bin:{root}/usr/sbin:" + os.environ["PATH"]}
        # start_new_session so any daemon spawned in the ON control case can be reaped cleanly.
        proc = subprocess.Popen(["/bin/sh", "-c", wrapper], env=env, start_new_session=True)
        try:
            rc = proc.wait(timeout=10)
        finally:
            try:
                import signal
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        out = out_log.read_text() if out_log.exists() else ""
        return subprocess.CompletedProcess(["/bin/sh"], rc, out, "")

    def test_real_rcs_local_with_melodious_off_invokes_zero_codex_and_zero_bind_mounts(self):
        root = self._make_boot_root()
        (root / "etc/melodious-off").write_text("off 20261111-120000\n")
        done = self._run_rcs_local(root)
        self.assertEqual(done.returncode, 0, done.stderr or done.stdout)

        invocations = (root / "codex_invocations.log").read_text() if (root / "codex_invocations.log").exists() else ""
        mounts = (root / "mounts.log").read_text() if (root / "mounts.log").exists() else ""
        self.assertEqual(invocations, "", f"expected zero /data/codex/* invocations, got: {invocations!r}")
        self.assertEqual(mounts, "", f"expected zero mount -o bind calls, got: {mounts!r}")

        # Touch sync probe removed atomically from /etc/hosts; stock entries kept.
        hosts = (root / "etc/hosts").read_text()
        self.assertIn("127.0.0.1\tlocalhost", hosts)
        self.assertNotIn("ping.myharmony.com", hosts)
        self.assertFalse((root / "etc/hosts.codex-new").exists())

        # Stock Wi-Fi and Bluetooth boot steps still ran.
        sys_calls = (root / "sys_calls.log").read_text()
        for expected in ("wlanconfig ath0", "wpa_supplicant", "netmonitor", "bccmd -t bcsp psload", "hciattach ttyS0"):
            self.assertIn(expected, sys_calls)

        # Saved Melodious configs and hal copies stay untouched for --turn-on.
        self.assertEqual((root / "data/codex/two_screen.conf").read_text(), "1\n")
        self.assertEqual((root / "data/codex/multi_remote.conf").read_text(), "1\n")
        self.assertEqual((root / "data/codex/usb_eth.conf").read_text(), "ENABLED=1\n")
        self.assertTrue((root / "data/codex/bin/hal_remotes").exists())
        self.assertTrue((root / "data/codex/bin/hal_multiremote").exists())
        self.assertIn("melodious off", (root / "cache/codex-init.log").read_text())

        # Direct init.sh invocation also exits 0 immediately while marker exists.
        direct = subprocess.run(["/bin/sh", str(root / "data/codex/init.sh")], capture_output=True, text=True, timeout=10)
        self.assertEqual(direct.returncode, 0)
        inv_after = (root / "codex_invocations.log").read_text().splitlines()
        self.assertEqual(inv_after, ["init.sh "], "init.sh must exit before spawning any daemon")

        # Control check: unlink /etc/melodious-off -> TDE=1 runs recovery_ap.sh boot-tde;
        # TDE=0 binds hal_remotes, starts usb_eth_service.sh and init.sh.
        (root / "codex_invocations.log").unlink()
        (root / "etc/melodious-off").unlink()
        done_tde = self._run_rcs_local(root)
        self.assertEqual(done_tde.returncode, 0)
        self.assertIn("recovery_ap.sh boot-tde", (root / "codex_invocations.log").read_text())

        (root / "codex_invocations.log").unlink()
        (root / "sys/class/input/input0/tde").write_text("0 0x0\n")
        done_on = self._run_rcs_local(root, wait_bg=False)
        self.assertEqual(done_on.returncode, 0)
        self.assertIn("mount -o bind", (root / "mounts.log").read_text())
        inv_on = (root / "codex_invocations.log").read_text()
        self.assertIn("usb_eth_service.sh start", inv_on)
        self.assertIn("init.sh ", inv_on)
        self.assertIn("bin/codex_webui 8080", inv_on, done_on.stdout + "\nLOG:\n" + (root / "cache/codex-init.log").read_text())

    def test_defense_in_depth_scripts_and_lua_plugins_honor_melodious_off(self):
        root = Path(tempfile.mkdtemp(prefix="did-off-"))
        self.addCleanup(shutil.rmtree, root, True)
        for d in ("etc", "data/codex/bin", "var/volatile", "var/run", "cache", "bin"):
            (root / d).mkdir(parents=True, exist_ok=True)
        (root / "etc/melodious-off").write_text("off\n")
        (root / "data/codex/cloud_blocker.conf").write_text("1\n")
        (root / "var/volatile/codex-default-gateway").write_text("192.0.2.1\n")

        # 1. offline_egress_guard.sh: restores WAN default route when marker exists, even with cloud_blocker.conf=1.
        route_log = root / "route.log"
        route_shim = root / "bin/route"
        route_shim.write_text(
            '#!/bin/sh\n'
            'if [ "$1" = "-n" ]; then\n'
            '  echo "Destination Gateway Genmask Flags Metric Ref Use Iface"\n'
            '  echo "10.0.0.0 192.0.2.1 255.0.0.0 UG 0 0 0 ath0"\n'
            '  echo "224.0.0.0 0.0.0.0 240.0.0.0 U 0 0 0 ath0"\n'
            '  exit 0\n'
            'fi\n'
            f'echo "route $*" >> "{route_log}"\n'
        )
        route_shim.chmod(0o755)
        egress = root / "egress.sh"
        egress_lines = relocate_hub_script(
            (INST.PAYLOAD / "scripts/offline_egress_guard.sh").read_text(encoding="utf-8"), root
        ).splitlines(keepends=True)
        egress_text = "".join(
            f'PATH="{root}/bin:"$PATH\n' if line.startswith("PATH=") else line
            for line in egress_lines
        )
        egress.write_text(egress_text)
        egress.chmod(0o755)
        res = subprocess.run(["/bin/sh", str(egress)], capture_output=True, text=True, timeout=10)
        self.assertEqual(res.returncode, 0, res.stderr)
        routes = route_log.read_text()
        self.assertIn("route add default gw 192.0.2.1 dev ath0", routes)
        self.assertIn("route del -net 10.0.0.0 netmask 255.0.0.0 gw 192.0.2.1", routes)

        # 2. androidtv_service.sh and recovery_ap.sh (monitor + boot-tde) exit 0 without spawning.
        spawn_log = root / "spawn.log"
        for name in ("codex_androidtv", "codex_dhcpd", "codex_portal"):
            b = root / "data/codex/bin" / name
            b.write_text(f'#!/bin/sh\necho "{name}" >> "{spawn_log}"\n')
            b.chmod(0o755)
        atv = root / "atv.sh"
        atv.write_text(relocate_hub_script((INST.PAYLOAD / "scripts/androidtv_service.sh").read_text(encoding="utf-8"), root))
        atv.chmod(0o755)
        self.assertEqual(subprocess.run(["/bin/sh", str(atv)], timeout=5).returncode, 0)

        rec = root / "rec.sh"
        rec.write_text(relocate_hub_script((INST.PAYLOAD / "scripts/recovery_ap.sh").read_text(encoding="utf-8"), root))
        rec.chmod(0o755)
        for mode in ("monitor", "boot-tde"):
            self.assertEqual(subprocess.run(["/bin/sh", str(rec), mode], timeout=5).returncode, 0)
        self.assertFalse(spawn_log.exists())

        # 3. codexactivity.lua and codexmqtt.lua: discover() returns {} and spawns 0 tasks when off.
        if shutil.which("luajit"):
            lua_check = f"""
local tasks = {{}}
local noop = function() return nil end
local anything
anything = function() return setmetatable({{}}, {{ __index = function() return noop end }}) end
local realOpen = io.open
io.open = function(p, m)
  if p == "/etc/melodious-off" then return {{ read = function() return "off" end, close = noop }} end
  return realOpen(p, m)
end
package.preload["system"] = function()
  return {{ addTask = function(n) tasks[#tasks + 1] = n return n end, sleep = noop, safeCall = pcall,
            taskStatus = function() return "dead" end }}
end
package.preload["json"] = function() return {{ encode = noop, decode = noop, null = {{}} }} end
package.preload["log"] = function() return {{ logger = function() return anything() end }} end
package.preload["socket"] = function() return anything() end
for _, m in ipairs({{
  "tasks.harmonywebservices.core.resourcemanager",
  "tasks.connectserver.core.utils",
  "tasks.connectserver.core.engine",
  "tasks.harmonywebservices.core.session",
}}) do package.preload[m] = function() return anything() end end
package.preload["tasks.harmonywebservices.core.statedigest"] = function()
  return {{ instance = function() return {{}} end }}
end
package.path = "{INST.PAYLOAD}/activity/?.lua;{INST.PAYLOAD}/mqtt/?.lua;" .. package.path
local act = require("codexactivity")
local mqtt = require("codexmqtt")
local g1 = act:discover()
local g2 = mqtt:discover()
act:monitor()
mqtt:monitor()
assert(type(g1) == "table" and next(g1) == nil, "codexactivity discover not empty")
assert(type(g2) == "table" and next(g2) == nil, "codexmqtt discover not empty")
assert(#tasks == 0, "tasks spawned: " .. table.concat(tasks, ","))
print("LUA_PLUGINS_OFF_OK")
"""
            lua_res = subprocess.run(["luajit", "-e", lua_check], capture_output=True, text=True, timeout=10)
            self.assertEqual(lua_res.returncode, 0, lua_res.stderr or lua_res.stdout)
            self.assertIn("LUA_PLUGINS_OFF_OK", lua_res.stdout)


RF_INFO_TWO_SCREEN = (
    '{"id":1,"data":{"EquadID":"34827","Devices":['
    '{"EquadID":"16417","SkinId":"97","DeviceIndex":"1","RFID":"1"},'
    '{"EquadID":"16417","SkinId":"97","DeviceIndex":"2","RFID":"2"}'
    '],"DeviceCount":2},"code":200}'
)
CLOUD_PREFS_JSON = (
    '{"accountId":"998877","authToken":"fake-cloud-token-xyz","mode":3,'
    '"remoteId":1234,"discoveryServerUri":"https://svcs.myharmony.com/Discovery/Discovery.svc"}\n'
)
LOCAL_PREFS_JSON = (
    '{\n  "accountId": "hub2-local",\n  "authToken": "local",\n  "mode": 3,\n  "remoteId": 1234\n}\n'
)


class SingleStateTurnOffTree:
    """Fake hub filesystem on disk for testing TURN_OFF_SCRIPT + real rcS.local
    + install_webui.py (--turn-off, --turn-on, and normal-run refusal)."""

    STOCK_HAL_MD5 = "a3fdd823440c43f36e235fe51c45f008"

    def __init__(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="ss-turnoff-"))
        self.root = self.dir / "root"
        self.bin_shims = self.dir / "shims"
        self.bin_shims.mkdir(parents=True)
        self.calls_log = self.dir / "shim_calls.log"
        self.rf_reply = RF_INFO_ONE_SMART
        self.hal_loads = True
        self.wifi_ip = "192.0.2.10"
        self.wired_ip = ""
        self.wpa_disconnected = False
        self.boot_counter = 1
        self.reboot_noops = False
        self.post_boot_override: dict[str, object] = {}
        self._build_root()

    def close(self) -> None:
        for dirpath, _dirs, _files in os.walk(self.dir):
            try:
                os.chmod(dirpath, 0o755)
            except OSError:
                pass
        shutil.rmtree(self.dir, ignore_errors=True)

    def put(self, path: str, data: bytes | str, mode: int = 0o644) -> Path:
        raw = data.encode("utf-8") if isinstance(data, str) else data
        target = self.root / path.lstrip("/")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        target.chmod(mode)
        return target

    def read(self, path: str) -> bytes:
        return (self.root / path.lstrip("/")).read_bytes()

    def exists(self, path: str) -> bool:
        return os.path.lexists(self.root / path.lstrip("/"))

    def mode(self, path: str) -> int:
        return (self.root / path.lstrip("/")).stat().st_mode & 0o777

    def snapshot(self) -> dict[str, tuple[bytes, int]]:
        out: dict[str, tuple[bytes, int]] = {}
        for dirpath, _dirs, files in os.walk(self.root):
            for name in files:
                full = Path(dirpath) / name
                rel = "/" + str(full.relative_to(self.root))
                if rel.startswith(("/proc/", "/sys/", "/tmp/")):
                    continue
                out[rel] = (full.read_bytes(), full.stat().st_mode & 0o777)
        return out

    def _write_shims(self) -> None:
        state_file = self.dir / "shim_state.json"
        self._sync_shim_state()

        (self.bin_shims / "ifconfig").write_text(
            f'''#!/usr/bin/env python3
import json, sys
s = json.loads(open({str(state_file)!r}).read())
arg = sys.argv[1] if len(sys.argv) > 1 else ""
if arg in ("", "ath0"):
    print("ath0      Link encap:Ethernet  HWaddr 00:04:20:AA:BB:CC")
    if s.get("wifi_ip"):
        print(f"          inet addr:{{s['wifi_ip']}}  Bcast:192.0.2.255  Mask:255.255.255.0")
if arg == "" and s.get("wired_ip"):
    print("eth2      Link encap:Ethernet  HWaddr 00:E0:4C:11:22:33")
    print(f"          inet addr:{{s['wired_ip']}}  Bcast:192.0.2.255  Mask:255.255.255.0")
'''
        )
        (self.bin_shims / "ifconfig").chmod(0o755)

        (self.bin_shims / "wpa_cli").write_text(
            f'''#!/usr/bin/env python3
import json, sys
p = {str(state_file)!r}
s = json.loads(open(p).read())
with open({str(self.calls_log)!r}, "a") as f:
    f.write("wpa_cli " + " ".join(sys.argv[1:]) + "\\n")
cmd = sys.argv[-1] if len(sys.argv) > 1 else ""
if cmd == "status":
    st = "DISCONNECTED" if s.get("wpa_disconnected") else "COMPLETED"
    print(f"wpa_state={{st}}")
elif cmd == "reconnect":
    s["wpa_disconnected"] = False
    if s.get("wifi_ip_on_reconnect"):
        s["wifi_ip"] = s["wifi_ip_on_reconnect"]
    open(p, "w").write(json.dumps(s))
    print("OK")
'''
        )
        (self.bin_shims / "wpa_cli").chmod(0o755)

        (self.bin_shims / "route").write_text(
            f'''#!/usr/bin/env python3
import pathlib, sys
rf = pathlib.Path({str(self.root / "proc/codex_route")!r})
with open({str(self.calls_log)!r}, "a") as f:
    f.write("route " + " ".join(sys.argv[1:]) + "\\n")
args = sys.argv[1:]
if args == ["-n"]:
    print(rf.read_text() if rf.exists() else "")
elif len(args) >= 4 and args[:3] == ["add", "default", "gw"]:
    gw = args[3]
    lines = rf.read_text().splitlines() if rf.exists() else [
        "Destination Gateway Genmask Flags Metric Ref Use Iface"
    ]
    lines.append(f"0.0.0.0 {{gw}} 0.0.0.0 UG 0 0 0 ath0")
    rf.write_text("\\n".join(lines) + "\\n")
elif len(args) >= 2 and args[:2] == ["del", "default"]:
    if rf.exists():
        lines = [l for l in rf.read_text().splitlines() if not l.startswith("0.0.0.0 ")]
        rf.write_text("\\n".join(lines) + "\\n")
'''
        )
        (self.bin_shims / "route").chmod(0o755)

    def _sync_shim_state(self, wifi_ip_on_reconnect: str = "") -> None:
        state_file = self.dir / "shim_state.json"
        state_file.write_text(
            json.dumps(
                {
                    "wifi_ip": self.wifi_ip,
                    "wired_ip": self.wired_ip,
                    "wpa_disconnected": self.wpa_disconnected,
                    "wifi_ip_on_reconnect": wifi_ip_on_reconnect,
                }
            )
        )

    def _build_root(self) -> None:
        for d in (
            "etc/init.d", "etc/dropbear", "home/root/.ssh", "data/codex/bin",
            "data/luaworks/provision", "opt/luaworks/tasks/connectserver",
            "pkg/codexactivity", "pkg/codexmqtt", "pkg/heos", "var/run",
            "var/volatile", "cache", "proc/sys/kernel/random", "proc/sys/vm",
            "sys/class/input/input0", "sys/class/net/ath0", "lib/firmware",
            "lib/modules/2.6.31-g89d565c", "usr/bin", "usr/sbin", "sbin", "bin", "tmp", "dev",
        ):
            (self.root / d).mkdir(parents=True, exist_ok=True)

        # Current gate-aware Melodious files from the repo.
        for dest, mode, _kind, local in INST.GATE_SCRIPT_SPECS:
            self.put(dest, local.read_bytes(), int(mode, 8))
        self.put("/pkg/codexactivity/manifest.json", '{"plugin":"codexactivity"}\n')
        self.put("/pkg/codexmqtt/manifest.json", '{"plugin":"codexmqtt"}\n')
        self.put("/pkg/heos/heos.lua", "-- stock heos\n")

        # Relocate offline_egress_guard.sh paths so running it in apply updates self.root!
        reloc_egress = relocate_hub_script(
            (INST.PAYLOAD / "scripts/offline_egress_guard.sh").read_text(encoding="utf-8"), self.root
        )
        egress_lines = [
            f'PATH="{self.bin_shims}:"$PATH\n' if line.startswith("PATH=") else line
            for line in reloc_egress.splitlines(keepends=True)
        ]
        # Keep the literal /etc/melodious-off comment so bootstrap check sees it as gate-aware!
        egress_lines.insert(1, "# gate: /etc/melodious-off\n")
        self.put("/data/codex/offline_egress_guard.sh", "".join(egress_lines), 0o755)

        # SSH survival prerequisites.
        self.put(
            "/etc/init.d/rcS",
            "if [ -r /etc/tdeenable -a -x /usr/sbin/dropbear ]; then /usr/sbin/dropbear; fi\n",
            0o755,
        )
        self.put("/etc/tdeenable", "1\n")
        self.put("/usr/sbin/dropbear", '#!/bin/sh\nexec /data/codex/bin/dropbear -K 300 "$@"\n', 0o755)
        self.put("/usr/sbin/dropbearkey", '#!/bin/sh\nexec /data/codex/bin/dropbearkey "$@"\n', 0o755)
        self.put("/data/codex/bin/dropbear", "#!/bin/sh\nexit 0\n", 0o755)
        self.put("/data/codex/bin/dropbearkey", "#!/bin/sh\nexit 0\n", 0o755)
        self.put("/home/root/.ssh/authorized_keys", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeOwnerKey owner@local\n", 0o600)
        self.put("/etc/dropbear/dropbear_rsa_host_key", "fake-rsa-host-key-bytes\n", 0o600)

        # Wi-Fi + Logitech cloud provisioning + Melodious configs all active.
        self.put("/etc/wpa_supplicant.conf", 'ctrl_interface=/var/run/wpa_supplicant\nnetwork={\n\tssid="HomeWiFi"\n}\n')
        self.put("/data/luaworks/provision/preferences", CLOUD_PREFS_JSON)
        self.put("/data/codex/hub_id", "1234\n")
        self.put("/data/codex/cloud_blocker.conf", "1\n")
        self.put("/data/codex/two_screen.conf", "1\n")
        self.put("/data/codex/multi_remote.conf", "1\n")
        self.put("/data/codex/usb_eth.conf", "ENABLED=1\n")
        self.put("/data/codex/timezone.conf", "America/New_York\nEST5EDT,M3.2.0,M11.1.0\n")
        self.put("/data/codex/activity-restrictions.json", '{"activities":{}}\n')
        self.put(
            "/etc/hosts",
            "127.0.0.1\tlocalhost\n127.0.0.1\tping.myharmony.com\t# codex: Harmony Touch sync probe\n",
        )
        self.put("/var/volatile/codex-default-gateway", "192.0.2.1\n")

        # Stock and patched hal copies.
        self.put("/usr/bin/hal", fake_remotes_hal(), 0o755)
        self.put("/data/codex/bin/hal_multiremote", fake_patched_hal(), 0o755)
        self._refresh_hal_helpers()

        # Pre-reboot running Melodious state: bound hal, running daemons, blocked WAN route.
        self.put("/proc/mounts", "rootfs / rootfs rw 0 0\nnone /usr/bin/hal unionfs rw 0 0\n")
        self.put(
            "/proc/codex_ps",
            "  201 root /data/codex/bin/codex_webui 8080\n"
            "  202 root /bin/sh /data/codex/offline_egress_guard.sh monitor\n"
            "  203 root /bin/sh /data/codex/usb_eth_service.sh worker\n"
            "  204 root /data/codex/bin/codex_androidtv\n",
        )
        self.put("/var/run/codex-offline-egress.pid", "202\n")
        self.put("/var/run/codex-usb-eth-worker.pid", "203\n")
        self.put(
            "/proc/codex_route",
            "Destination Gateway Genmask Flags Metric Ref Use Iface\n"
            "192.0.2.0 0.0.0.0 255.255.255.0 U 0 0 0 ath0\n"
            "224.0.0.0 0.0.0.0 240.0.0.0 U 0 0 0 ath0\n",
        )
        self.put("/proc/sys/kernel/random/boot_id", "00000000-0000-4000-8000-000000000001\n")
        self.put("/proc/stat", "btime 1760000100\n")
        self.put("/proc/uptime", "540.20 500.00\n")
        self._write_shims()

    def _refresh_hal_helpers(self) -> None:
        ltcp = self.root / "data/codex/bin/codex_hal_ltcp"
        ltcp.write_text(f"#!/bin/sh\ncat <<'EOF'\n{self.rf_reply}\nEOF\n")
        ltcp.chmod(0o755)

        hal_rem = self.root / "data/codex/bin/hal_remotes"
        if self.hal_loads:
            # Executable script when invoked with -h, whose md5 we match via patch mock in tests.
            hal_rem.write_text('#!/bin/sh\nprintf "Usage: hal [-f] [-s]" >&2\nexit 1\n')
        else:
            hal_rem.write_text('#!/bin/sh\necho "Segmentation fault" >&2\nexit 139\n')
        hal_rem.chmod(0o755)

    def simulate_reboot(self) -> None:
        """Simulate a real hub reboot by resetting volatile state, advancing
        boot_id/btime/uptime, and running the relocated rcS.local under /bin/sh."""
        if self.reboot_noops:
            return
        self.boot_counter += 1
        self.put(
            "/proc/sys/kernel/random/boot_id",
            f"00000000-0000-4000-8000-{self.boot_counter:012d}\n",
        )
        self.put("/proc/stat", f"btime {1760000100 + self.boot_counter * 100}\n")
        self.put("/proc/uptime", "12.40 10.00\n")
        # Volatile /var/run and /proc/mounts reset across boot; /usr/bin/hal starts as stock.
        shutil.rmtree(self.root / "var/run", ignore_errors=True)
        (self.root / "var/run").mkdir(parents=True, exist_ok=True)
        self.put("/proc/mounts", "rootfs / rootfs rw 0 0\n")
        self.put("/usr/bin/hal", b"stock-hal-image", 0o755)
        self.put("/proc/codex_ps", "  101 root /usr/sbin/dropbear\n")
        self.put(
            "/proc/codex_route",
            "Destination Gateway Genmask Flags Metric Ref Use Iface\n"
            "0.0.0.0 192.0.2.1 0.0.0.0 UG 0 0 0 ath0\n",
        )

        # Execute the hub's installed /etc/init.d/rcS.local against self.root!
        for d in ("sys/class/input/input0", "sys/class/net/ath0", "lib/firmware", "dev", "sbin", "usr/sbin", "usr/bin", "bin"):
            (self.root / d).mkdir(parents=True, exist_ok=True)
        self.put("/sys/class/input/input0/tde", "0 0x0\n")
        self.put("/sys/class/net/ath0/address", "00:04:20:aa:bb:cc\n")
        self.put("/etc/modules.wlan", "")
        self.put("/proc/mtd", 'mtd6: 00010000 00010000 "mfg"\n')
        self.put("/dev/mtd6", "hw_ver\n\n\n\n00.40\n")
        self.put("/lib/firmware/csr8811-a08.psr", "// pskeys\n")
        self.put("/lib/firmware/csr8811-a08-pb1.psr", "// pskeys\n")

        installed_rcs = self.read("/etc/init.d/rcS.local").decode("utf-8")
        reloc_rcs = relocate_hub_script(installed_rcs, self.root)
        rcs_runner = self.dir / "boot_rcs.sh"
        real_remotes_md5 = json.loads(INST.HAL_REMOTES_PATCH_FILE.read_text(encoding="utf-8"))["patched_md5"]
        real_multi_md5 = json.loads(INST.HAL_PATCH_FILE.read_text(encoding="utf-8"))["patched_md5"]
        rcs_runner.write_text(
            f"""#!/bin/sh
load_modules() {{ :; }}
ifup() {{ :; }}
wlanconfig() {{ :; }}
wpa_supplicant() {{ :; }}
netmonitor() {{ :; }}
bccmd() {{ [ "${{3:-}}" = "buildname" ] && echo "CSR8811 A08" || true; }}
hciattach() {{ :; }}
pidof() {{ return 0; }}
sleep() {{ :; }}
md5sum() {{
  case "$1" in
    */usr/bin/hal) echo "{self.STOCK_HAL_MD5}  $1" ;;
    */hal_remotes) echo "{real_remotes_md5}  $1" ;;
    */hal_multiremote) echo "{real_multi_md5}  $1" ;;
  esac
}}
mount() {{
  echo "none /usr/bin/hal {self.root}/usr/bin/hal unionfs rw 0 0" >> "{self.root}/proc/mounts"
  cp "$3" "{self.root}/usr/bin/hal"
}}
"""
            + "\n".join(
                line
                for line in reloc_rcs.splitlines()
                if "/sbin/wlanconfig" not in line
                and "/usr/sbin/wpa_supplicant" not in line
                and "/usr/bin/netmonitor" not in line
                and "/usr/sbin/bccmd" not in line
                and "/usr/sbin/hciattach" not in line
            )
            + "\n",
            encoding="utf-8",
        )
        # Stub init.sh and usb_eth_service.sh during simulated boot to record daemon state in codex_ps
        orig_init = self.read("/data/codex/init.sh")
        orig_usb = self.read("/data/codex/usb_eth_service.sh")
        if b"/etc/melodious-off" in orig_init:
            boot_init = (
                f"#!/bin/sh\n[ -f '{self.root}/etc/melodious-off' ] && exit 0\n"
                f"echo '  301 root /data/codex/bin/codex_webui 8080' >> '{self.root}/proc/codex_ps'\n"
            ).encode()
        else:
            boot_init = (
                f"#!/bin/sh\necho '  301 root /data/codex/bin/codex_webui 8080' >> '{self.root}/proc/codex_ps'\n"
            ).encode()
        self.put("/data/codex/init.sh", boot_init, orig_init and self.mode("/data/codex/init.sh") or 0o755)
        self.put("/data/codex/usb_eth_service.sh", b"#!/bin/sh\nexit 0\n", 0o755)
        try:
            subprocess.run(["/bin/sh", str(rcs_runner)], check=True, capture_output=True, text=True, timeout=10)
        finally:
            self.put("/data/codex/init.sh", orig_init, 0o755)
            self.put("/data/codex/usb_eth_service.sh", orig_usb, 0o755)

        for k, v in self.post_boot_override.items():
            self.put(k, v)

    def run_turn_off_script(self, mode: str, *extra: str) -> tuple[int, str, str]:
        self._refresh_hal_helpers()
        script = self.dir / "turn_off.sh"
        script.write_text(INST.TURN_OFF_SCRIPT, encoding="utf-8")
        env = {
            **os.environ,
            "CODEX_OFF_ROOT": str(self.root),
            "CODEX_OFF_PATH": f"{self.bin_shims}:{os.environ['PATH']}",
            "CODEX_WIFI_WAIT": "1",
        }
        proc = subprocess.run(
            ["/bin/sh", str(script), mode, *extra],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return proc.returncode, proc.stdout, proc.stderr


class SingleStateTurnOffOnFlow(unittest.TestCase):
    """[PYTHON + SHELL BEHAVIORAL] single-state /etc/melodious-off --turn-off,
    --turn-on, normal-install refusal, older-install bootstrap, preflight gates,
    and post-reboot verification."""

    def setUp(self):
        self.tree = SingleStateTurnOffTree()
        self.addCleanup(self.tree.close)
        self.key_file = self.tree.dir / "fake_key"
        self.key_file.write_text("fake-private-key\n")
        self.hosts_contacted: list[tuple[str, str]] = []
        self.ports_waited: list[tuple[str, int, str]] = []

        # Point INST.HAL_REMOTES_MD5 / HAL_MULTI_MD5 at our fake hal files on disk.
        self._saved_md5s = (INST.HAL_REMOTES_MD5, INST.HAL_MULTI_MD5)
        self.tree._refresh_hal_helpers()
        INST.HAL_REMOTES_MD5 = hashlib.md5(self.tree.read("/data/codex/bin/hal_remotes")).hexdigest()
        INST.HAL_MULTI_MD5 = hashlib.md5(self.tree.read("/data/codex/bin/hal_multiremote")).hexdigest()
        self.addCleanup(self._restore_md5s)

    def _restore_md5s(self):
        INST.HAL_REMOTES_MD5, INST.HAL_MULTI_MD5 = self._saved_md5s

    def run_cli(self, *argv: str, host: str = FAKE_HUB_HOST) -> tuple[int, str, str]:
        tree = self.tree
        uploaded = tree.dir / "uploaded_turn_off.sh"
        hosts_contacted = self.hosts_contacted
        ports_waited = self.ports_waited
        # Also wire a FakeHub synced with tree.root for bootstrap staging/handoff commands!
        fake_hub = FakeHub()
        for rel, (data, fmode) in tree.snapshot().items():
            fake_hub.fs[rel] = {"data": data, "mode": f"{fmode:o}"}

        def fake_rrc(self_inst, command, input_bytes=None, timeout=90):
            c = command.strip()
            hosts_contacted.append((self_inst.args.hub_host, c))
            if c == "id; uname -a":
                return 0, "uid=0(root) gid=0(root)\n", ""
            if c == INST.MELODIOUS_OFF_CHECK_CMD:
                is_off = tree.exists(INST.MELODIOUS_OFF_MARKER) or tree.exists(INST.LEGACY_MELODIOUS_OFF_MARKER)
                return 0, "off\n" if is_off else "", ""
            if c == f"cat > {INST.TURN_OFF_SCRIPT_PATH}":
                uploaded.write_bytes(input_bytes or b"")
                return 0, "", ""
            if c.startswith(f"sh {INST.TURN_OFF_SCRIPT_PATH} "):
                parts = shlex.split(c)[2:]
                return tree.run_turn_off_script(*parts)
            if c == f"rm -f {INST.TURN_OFF_SCRIPT_PATH}":
                uploaded.unlink(missing_ok=True)
                return 0, "", ""
            if c.startswith("(/bin/sleep 2;"):
                tree.simulate_reboot()
                return 0, "rebooting\n", ""
            # Bootstrap commands delegate to FakeHub and mirror persistent writes back to tree.root!
            rc, out, err = fake_hub.dispatch(command, input_bytes)
            for path, entry in list(fake_hub.fs.items()):
                if not path.startswith(fake_hub.stage):
                    tree.put(path, entry["data"], int(str(entry["mode"]), 8))
            for rel in list(tree.snapshot()):
                if rel.startswith("/data/codex-backups/webui-handoff-") and rel not in fake_hub.fs:
                    # Keep handoff directories created by FakeHub.do_handoff
                    pass
            return rc, out, err

        old_rrc = INST.Installer.run_remote_rc
        old_wait = INST.wait_for_port
        old_sleep = INST.time.sleep
        old_suffix = INST.stage_suffix
        INST.Installer.run_remote_rc = fake_rrc
        INST.wait_for_port = lambda h, p, _s, label: ports_waited.append((h, p, label))
        INST.time.sleep = lambda _s: None
        INST.stage_suffix = lambda: "fake01"
        out_buf, err_buf = io.StringIO(), io.StringIO()
        try:
            with contextlib.redirect_stdout(out_buf), contextlib.redirect_stderr(err_buf):
                try:
                    code = INST.main(["--hub-host", host, "--key-path", str(self.key_file), *argv])
                except SystemExit as exc:
                    code = int(exc.code or 0)
        finally:
            INST.Installer.run_remote_rc = old_rrc
            INST.wait_for_port = old_wait
            INST.time.sleep = old_sleep
            INST.stage_suffix = old_suffix
        self.assertFalse(uploaded.exists(), "RAM helper must be cleaned up")
        return code, out_buf.getvalue(), err_buf.getvalue()

    def test_flag_mutual_exclusions_and_rejections(self):
        for bad_args, needle in (
            (("--turn-off", "--turn-on", "--no-prompt"), "cannot be used together"),
            (("--turn-off", "--clean-install", "--no-prompt"), "--clean-install"),
            (("--turn-on", "--clean-install", "--no-prompt"), "--clean-install"),
            (("--turn-off", "--no-apply-cloud-restart", "--no-prompt"), "--no-apply-cloud-restart"),
            (("--turn-on", "--no-apply-cloud-restart", "--no-prompt"), "--no-apply-cloud-restart"),
            (("--force", "--no-prompt"), "only be used with --turn-off"),
            (("--turn-on", "--force", "--no-prompt"), "only be used with --turn-off"),
        ):
            with self.subTest(bad_args=bad_args):
                code, _out, err = self.run_cli(*bad_args)
                self.assertEqual(code, 1)
                self.assertIn(needle, err)
                self.assertEqual(self.hosts_contacted, [])

    def test_experimental_banner_prints_and_noninteractive_requires_ack(self):
        """[PYTHON BEHAVIORAL] --turn-off/--turn-on print the EXPERIMENTAL
        banner before any action; non-interactive runs refuse without
        --i-understand-experimental; --preflight-only prints the banner and
        needs no ack; the interactive confirmation carries the warning."""
        banner_first = INST.EXPERIMENTAL_TURN_OFF_WARNING.split("\n")[0]

        # 1. --preflight-only prints the banner before any action, needs no ack,
        #    and mutates nothing.
        before = self.tree.snapshot()
        code_pf, out_pf, err_pf = self.run_cli("--turn-off", "--preflight-only", "--no-prompt")
        self.assertEqual(code_pf, 0, err_pf or out_pf)
        self.assertIn(banner_first, out_pf)
        self.assertLess(out_pf.index(banner_first), out_pf.index("== Checking SSH =="))
        self.assertEqual(self.tree.snapshot(), before)
        code_on_pf, out_on_pf, err_on_pf = self.run_cli("--turn-on", "--preflight-only", "--no-prompt")
        self.assertEqual(code_on_pf, 0, err_on_pf or out_on_pf)
        self.assertIn(banner_first, out_on_pf)
        self.assertEqual(self.tree.snapshot(), before)

        # 2. Non-interactive without the ack flag: refuses before contacting
        #    the hub, pointing at the flag; nothing changes.
        self.hosts_contacted.clear()
        code, out, err = self.run_cli("--turn-off", "--no-prompt")
        self.assertEqual(code, 1)
        self.assertIn(banner_first, out)
        self.assertIn("--i-understand-experimental", err)
        self.assertEqual(self.hosts_contacted, [])
        self.assertFalse(self.tree.exists("/etc/melodious-off"))
        self.assertEqual(self.tree.snapshot(), before)

        code_ton, out_ton, err_ton = self.run_cli("--turn-on", "--no-prompt")
        self.assertEqual(code_ton, 1)
        self.assertIn(banner_first, out_ton)
        self.assertIn("--i-understand-experimental", err_ton)
        self.assertEqual(self.hosts_contacted, [])
        self.assertEqual(self.tree.snapshot(), before)

        # 3. Interactive mode: the confirmation prompt itself carries the warning.
        import builtins
        prompts = []
        old_input = builtins.input
        builtins.input = lambda p="": (prompts.append(p), "n")[1]
        self.addCleanup(setattr, builtins, "input", old_input)
        code_no, _out_no, _err_no = self.run_cli("--turn-off")
        self.assertEqual(code_no, 1)
        self.assertEqual(self.tree.snapshot(), before)
        self.assertTrue(any("EXPERIMENTAL" in p for p in prompts), prompts)

        # 4. With the ack flag the banner still prints and the turn-off proceeds.
        code_ack, out_ack, err_ack = self.run_cli(
            "--turn-off", "--no-prompt", "--i-understand-experimental"
        )
        self.assertEqual(code_ack, 0, err_ack or out_ack)
        self.assertIn(banner_first, out_ack)
        self.assertTrue(self.tree.exists("/etc/melodious-off"))

    def test_normal_install_refuses_when_melodious_off_marker_exists(self):
        for marker in (INST.MELODIOUS_OFF_MARKER, INST.LEGACY_MELODIOUS_OFF_MARKER):
            with self.subTest(marker=marker):
                hub = FakeHub()
                prime_current_hub(hub)
                hub.fs[marker] = {"data": b"off\n", "mode": "644"}
                harness = InstallerHarness(hub)
                self.addCleanup(harness.close)
                for extra in ((), ("--preflight-only",)):
                    code, stdout, stderr = harness.run(harness.base_argv(*extra))
                    self.assertEqual(code, 1, stdout + stderr)
                    self.assertIn(INST.MELODIOUS_OFF_REFUSAL, stderr)
                    self.assertEqual([e for e in hub.events if e[0] == "persistent_write"], [])

    def test_turn_off_preflight_only_checks_all_gates_and_mutates_nothing(self):
        before = self.tree.snapshot()
        code, out, err = self.run_cli("--turn-off", "--preflight-only", "--no-prompt")
        self.assertEqual(code, 0, err or out)
        self.assertEqual(kv_value(out, "rf_check"), "ok")
        self.assertEqual(kv_value(out, "wifi_check"), "ok")
        self.assertEqual(kv_value(out, "provision_state"), "cloud")
        self.assertEqual(kv_value(out, "bootstrap_needed"), "no")
        self.assertEqual(kv_value(out, "active_off"), "no")
        self.assertEqual(self.tree.snapshot(), before)
        self.assertEqual(self.ports_waited, [])

    def test_turn_off_current_hub_writes_only_marker_restores_wan_and_verifies_reboot(self):
        before = self.tree.snapshot()
        code, out, err = self.run_cli("--turn-off", "--no-prompt", "--i-understand-experimental")
        self.assertEqual(code, 0, err or out)
        self.assertEqual(kv_value(out, "reboot_confirmed"), "yes")
        self.assertTrue(self.tree.exists("/etc/melodious-off"))
        self.assertLessEqual(len(self.tree.read("/etc/melodious-off")), 32)
        self.assertIn("route add default gw 192.0.2.1 dev ath0", self.tree.calls_log.read_text())

        # Every Melodious config, plugin, init.sh mode, and patched hal copy is untouched!
        for untouched in (
            "/data/codex/cloud_blocker.conf",
            "/data/codex/two_screen.conf",
            "/data/codex/multi_remote.conf",
            "/data/codex/usb_eth.conf",
            "/data/codex/timezone.conf",
            "/data/codex/activity-restrictions.json",
            "/data/codex/init.sh",
            "/pkg/codexactivity/codexactivity.lua",
            "/pkg/codexmqtt/codexmqtt.lua",
            "/data/codex/bin/hal_remotes",
            "/data/codex/bin/hal_multiremote",
        ):
            self.assertEqual(self.tree.snapshot()[untouched], before[untouched], untouched)
        self.assertNotIn(b"ping.myharmony.com", self.tree.read("/etc/hosts"))
        self.assertFalse(any(p.endswith(".codex-new") for p in self.tree.snapshot()))

        # Idempotent second --turn-off: already off, no second reboot.
        self.ports_waited.clear()
        code2, out2, err2 = self.run_cli("--turn-off", "--no-prompt", "--i-understand-experimental")
        self.assertEqual(code2, 0, err2 or out2)
        self.assertIn("already off", out2)
        self.assertEqual(self.ports_waited, [])

    def test_declining_prompt_changes_nothing(self):
        import builtins
        old_input = builtins.input
        builtins.input = lambda _p="": "n"
        self.addCleanup(setattr, builtins, "input", old_input)

        before = self.tree.snapshot()
        code, _out, _err = self.run_cli("--turn-off")
        self.assertEqual(code, 1)
        self.assertEqual(self.tree.snapshot(), before)

    def test_bootstrap_older_install_updates_gate_scripts_and_prunes_handoffs(self):
        # Simulate pre-single-state rcS.local and netservicestarter.lua without /etc/melodious-off,
        # plus 3 existing webui-handoff backups so pruning to HANDOFF_KEEP=3 runs.
        self.tree.put("/etc/init.d/rcS.local", "#!/bin/sh\n[ -x /data/codex/init.sh ] && /data/codex/init.sh &\n", 0o755)
        self.tree.put("/opt/luaworks/tasks/connectserver/netservicestarter.lua", "-- old nss\n", 0o644)
        code_pf, out_pf, err_pf = self.run_cli("--turn-off", "--preflight-only", "--no-prompt")
        self.assertEqual(code_pf, 0, err_pf or out_pf)
        self.assertEqual(kv_value(out_pf, "bootstrap_needed"), "yes")
        self.assertFalse(self.tree.exists("/etc/melodious-off"))

        code, out, err = self.run_cli("--turn-off", "--no-prompt", "--i-understand-experimental")
        self.assertEqual(code, 0, err or out)
        self.assertIn("Bootstrapping gate-aware scripts", out)
        self.assertIn("handoff=/data/codex-backups/webui-handoff-", out)
        self.assertIn(b"/etc/melodious-off", self.tree.read("/etc/init.d/rcS.local"))
        self.assertIn(b"/etc/melodious-off", self.tree.read("/opt/luaworks/tasks/connectserver/netservicestarter.lua"))
        self.assertTrue(self.tree.exists("/etc/melodious-off"))

    def test_false_success_prevented_on_no_reboot_or_any_surviving_component(self):
        # 1. Reboot did not happen (boot_id/btime/uptime unchanged).
        self.tree.reboot_noops = True
        code, out, err = self.run_cli("--turn-off", "--no-prompt", "--i-understand-experimental")
        self.assertEqual(code, 1)
        self.assertIn("did not restart", err)
        self.assertEqual(kv_value(out, "reboot_confirmed"), "no")

        # 2. Reboot happened, but individual Melodious components kept running / stayed bound.
        cases = [
            ({"/proc/codex_ps": "  401 root /data/codex/bin/codex_webui 8080\n"}, "webui=running"),
            ({"/proc/codex_ps": "  402 root /bin/sh /data/codex/offline_egress_guard.sh monitor\n"}, "egress_guard=running"),
            ({"/var/run/codex-usb-eth-worker.pid": "403\n", "/proc/codex_ps": "  403 root worker\n"}, "usb_eth_worker=running"),
            ({"/proc/codex_ps": "  404 root /data/codex/bin/codex_androidtv\n"}, "androidtv=running"),
            ({"/proc/mounts": "rootfs / rootfs rw 0 0\nnone /usr/bin/hal unionfs rw 0 0\n"}, "hal_mount=bound"),
            ({"/etc/hosts": "127.0.0.1\tping.myharmony.com\t# codex: Harmony Touch sync probe\n"}, "touch_probe=present"),
        ]
        for override, expected_reason in cases:
            with self.subTest(expected_reason=expected_reason):
                t = SingleStateTurnOffTree()
                self.addCleanup(t.close)
                self.tree = t
                self.tree._refresh_hal_helpers()
                INST.HAL_REMOTES_MD5 = hashlib.md5(self.tree.read("/data/codex/bin/hal_remotes")).hexdigest()
                t.post_boot_override = override
                code, _out, err = self.run_cli("--turn-off", "--no-prompt", "--i-understand-experimental")
                self.assertEqual(code, 1, expected_reason)
                self.assertIn(expected_reason, err)

    def test_duplicate_remote_gate_refuses_noscreen_dups_and_warns_two_screen(self):
        # Two Smart Controls (16414) -> refused without --force, allowed with --force.
        self.tree.rf_reply = RF_INFO_TWO_SMART
        code, _out, err = self.run_cli("--turn-off", "--no-prompt", "--i-understand-experimental")
        self.assertEqual(code, 1)
        self.assertIn("16414 (slots 1, 2)", err)
        self.assertFalse(self.tree.exists("/etc/melodious-off"))

        code_f, out_f, err_f = self.run_cli("--turn-off", "--force", "--no-prompt", "--i-understand-experimental")
        self.assertEqual(code_f, 0, err_f or out_f)
        self.assertIn("WARNING:", out_f)
        self.assertTrue(self.tree.exists("/etc/melodious-off"))

        # Two screen remotes (16417) -> warns and proceeds without --force.
        t2 = SingleStateTurnOffTree()
        self.addCleanup(t2.close)
        self.tree = t2
        t2.rf_reply = RF_INFO_TWO_SCREEN
        self.tree._refresh_hal_helpers()
        INST.HAL_REMOTES_MD5 = hashlib.md5(self.tree.read("/data/codex/bin/hal_remotes")).hexdigest()
        code_s, out_s, err_s = self.run_cli("--turn-off", "--no-prompt", "--i-understand-experimental")
        self.assertEqual(code_s, 0, err_s or out_s)
        self.assertIn("EquadID 16417, slots 1, 2", out_s)

    def test_wifi_survival_gate_reconnects_wifi_off_and_switches_from_wired_ip(self):
        # 1. Pristine wpa_supplicant.conf without network={ -> refused unless --force.
        self.tree.put("/etc/wpa_supplicant.conf", "ctrl_interface=/var/run/wpa_supplicant\n")
        code, _out, err = self.run_cli("--turn-off", "--no-prompt", "--i-understand-experimental")
        self.assertEqual(code, 1)
        self.assertIn("wpa_supplicant.conf", err)
        self.assertFalse(self.tree.exists("/etc/melodious-off"))

        # Restore valid wpa_supplicant.conf; simulate #125 wifi-off active while connected on wired IP!
        self.tree.put("/etc/wpa_supplicant.conf", 'network={\n\tssid="HomeWiFi"\n}\n')
        self.tree.put("/var/run/codex-usb-eth-wifi-off", "")
        self.tree.wifi_ip = ""
        self.tree.wired_ip = "192.0.2.50"
        self.tree.wpa_disconnected = True
        self.tree._sync_shim_state(wifi_ip_on_reconnect="192.0.2.10")

        # Preflight-only must NOT run wpa_cli reconnect.
        code_pf, out_pf, err_pf = self.run_cli("--turn-off", "--preflight-only", "--no-prompt", host="192.0.2.50")
        self.assertEqual(code_pf, 0, err_pf or out_pf)
        self.assertEqual(kv_value(out_pf, "wifi_off_active"), "yes")
        calls = self.tree.calls_log.read_text() if self.tree.calls_log.exists() else ""
        self.assertNotIn("wpa_cli -i ath0 reconnect", calls)

        # Apply reconnects ath0, obtains 192.0.2.10, and waits/verifies on 192.0.2.10 after reboot!
        self.ports_waited.clear()
        self.hosts_contacted.clear()
        code_go, out_go, err_go = self.run_cli("--turn-off", "--no-prompt", "--i-understand-experimental", host="192.0.2.50")
        self.assertEqual(code_go, 0, err_go or out_go)
        self.assertIn("wpa_cli -i ath0 reconnect", self.tree.calls_log.read_text())
        self.assertEqual(kv_value(out_go, "post_reboot_host"), "192.0.2.10")
        self.assertIn("Hub Wi-Fi IP: 192.0.2.10", out_go)
        self.assertIn(("192.0.2.10", 22, "SSH"), self.ports_waited)
        verify_hosts = [h for h, cmd in self.hosts_contacted if "verify-off" in cmd]
        self.assertEqual(verify_hosts, ["192.0.2.10"])

    def test_fresh_hub_local_account_and_unprovisioned_refused_unless_force(self):
        # #130 local account
        self.tree.put("/data/luaworks/provision/preferences", LOCAL_PREFS_JSON)
        code, _out, err = self.run_cli("--turn-off", "--no-prompt", "--i-understand-experimental")
        self.assertEqual(code, 1)
        self.assertIn("local_account", err)
        self.assertIn("cleanDataFolder", err)
        self.assertFalse(self.tree.exists("/etc/melodious-off"))

        # Unprovisioned
        (self.tree.root / "data/luaworks/provision/preferences").unlink()
        code_u, _out_u, err_u = self.run_cli("--turn-off", "--no-prompt", "--i-understand-experimental")
        self.assertEqual(code_u, 1)
        self.assertIn("unprovisioned", err_u)

        # --force overrides with warning
        code_f, out_f, err_f = self.run_cli("--turn-off", "--force", "--no-prompt", "--i-understand-experimental")
        self.assertEqual(code_f, 0, err_f or out_f)
        self.assertIn("WARNING:", out_f)
        self.assertTrue(self.tree.exists("/etc/melodious-off"))

    def test_hardened_ssh_survival_checks_never_bypassed_by_force(self):
        # 1. Missing authorized_keys or whitespace-only authorized_keys
        self.tree.put("/home/root/.ssh/authorized_keys", "   \n")
        code, _out, err = self.run_cli("--turn-off", "--force", "--no-prompt", "--i-understand-experimental")
        self.assertEqual(code, 1)
        self.assertIn("authorized_keys", err)
        self.tree.put("/home/root/.ssh/authorized_keys", "ssh-ed25519 AAAAC3Nza owner\n")

        # 2. Missing host key AND broken dropbearkey -> refused; working dropbearkey -> allowed!
        (self.tree.root / "etc/dropbear/dropbear_rsa_host_key").unlink()
        (self.tree.root / "data/codex/bin/dropbearkey").unlink()
        code2, _out2, err2 = self.run_cli("--turn-off", "--force", "--no-prompt", "--i-understand-experimental")
        self.assertEqual(code2, 1)
        self.assertIn("dropbearkey", err2)

        self.tree.put("/data/codex/bin/dropbearkey", "#!/bin/sh\nexit 0\n", 0o755)
        code3, out3, err3 = self.run_cli("--turn-off", "--preflight-only", "--no-prompt")
        self.assertEqual(code3, 0, err3 or out3)

        # 3. Empty 0-byte host key file (rcS [ -r ] would skip dropbearkey and Dropbear would fail!)
        self.tree.put("/etc/dropbear/dropbear_rsa_host_key", "")
        code4, _out4, err4 = self.run_cli("--turn-off", "--force", "--no-prompt", "--i-understand-experimental")
        self.assertEqual(code4, 1)
        self.assertIn("dropbear_rsa_host_key", err4)

    def test_turn_on_checks_hal_load_unlinks_markers_and_verifies_reboot(self):
        # Turn off first.
        code_off, out_off, err_off = self.run_cli("--turn-off", "--no-prompt", "--i-understand-experimental")
        self.assertEqual(code_off, 0, err_off or out_off)
        self.tree.put(INST.LEGACY_MELODIOUS_OFF_MARKER, "legacy\n")

        # 1. --turn-on --preflight-only runs hal_remotes load-check and keeps marker.
        code_pf, out_pf, err_pf = self.run_cli("--turn-on", "--preflight-only", "--no-prompt")
        self.assertEqual(code_pf, 0, err_pf or out_pf)
        self.assertEqual(kv_value(out_pf, "expected_hal"), "two-screen")
        self.assertEqual(kv_value(out_pf, "two_screen_load_check"), "ok")
        self.assertTrue(self.tree.exists(INST.MELODIOUS_OFF_MARKER))

        # 2. Broken hal_remotes binary: --turn-on refuses BEFORE unlinking /etc/melodious-off!
        self.tree.hal_loads = False
        self.tree._refresh_hal_helpers()
        INST.HAL_REMOTES_MD5 = hashlib.md5(self.tree.read("/data/codex/bin/hal_remotes")).hexdigest()
        self.ports_waited.clear()
        code_bad, out_bad, err_bad = self.run_cli("--turn-on", "--no-prompt", "--i-understand-experimental")
        self.assertEqual(code_bad, 1)
        self.assertEqual(kv_value(out_bad, "two_screen_load_check"), "failed")
        self.assertIn("left off", err_bad)
        self.assertTrue(self.tree.exists(INST.MELODIOUS_OFF_MARKER))
        self.assertEqual(self.ports_waited, [])

        # 3. Working hal_remotes: --turn-on unlinks both markers, reboots, waits for :22 and :8080,
        # and verifies codex_webui + two-screen hal!
        self.tree.hal_loads = True
        self.tree._refresh_hal_helpers()
        INST.HAL_REMOTES_MD5 = hashlib.md5(self.tree.read("/data/codex/bin/hal_remotes")).hexdigest()
        code_on, out_on, err_on = self.run_cli("--turn-on", "--no-prompt", "--i-understand-experimental")
        self.assertEqual(code_on, 0, out_on + "\nERR:\n" + err_on + "\nLOG:\n" + self.tree.read("/cache/codex-init.log").decode())
        self.assertFalse(self.tree.exists(INST.MELODIOUS_OFF_MARKER))
        self.assertFalse(self.tree.exists(INST.LEGACY_MELODIOUS_OFF_MARKER))
        self.assertIn((FAKE_HUB_HOST, 22, "SSH"), self.ports_waited)
        self.assertIn((FAKE_HUB_HOST, 8080, "Web UI"), self.ports_waited)
        self.assertEqual(kv_value(out_on, "reboot_confirmed"), "yes")
        self.assertEqual(kv_value(out_on, "active_on"), "yes")
        self.assertIn("Melodious is back on (hal: two-screen).", out_on)

        # 4. Already on -> no-op.
        self.ports_waited.clear()
        code_again, out_again, err_again = self.run_cli("--turn-on", "--no-prompt", "--i-understand-experimental")
        self.assertEqual(code_again, 0, err_again or out_again)
        self.assertIn("already on", out_again)
        self.assertEqual(self.ports_waited, [])


class PowerShellStaticContract(unittest.TestCase):
    """[PS1 STATIC] structured assertions on install_webui.ps1 (no pwsh run).

    These verify the PowerShell installer exposes the same flags/constants
    and the same orchestration ordering as the Python behavioral contract.
    """

    @classmethod
    def setUpClass(cls):
        cls.text = INSTALLER_PS1.read_text(encoding="utf-8")
        cls.main = cls.text.split('Step "Checking SSH"', 1)[1]
        cls.inventory = cls.text.split("function Build-Inventory()", 1)[1].split(
            "# --------------------------------------------------------------- staging", 1
        )[0]
        cls.rollback = cls.text.split("function Invoke-Rollback(", 1)[1].split(
            "function Remove-StagingTree()", 1
        )[0]

    def ps_scalar(self, variable: str) -> str:
        match = re.search(rf"\${re.escape(variable)}\s*=\s*\"([^\"]*)\"", self.text)
        assert match, f"missing ${variable} string assignment"
        return match.group(1)

    def ps_array(self, variable: str) -> list[str]:
        match = re.search(rf"\${re.escape(variable)} = @\((.*?)\)", self.text, re.S)
        assert match, f"missing ${variable} array"
        return re.findall(r'"([^"]+)"', match.group(1))

    def test_dropbear_builds_match_python(self):
        """[PS1 STATIC] $DropbearBuilds lists the same builds as DROPBEAR_BUILDS."""
        match = re.search(r"\$DropbearBuilds = @\{(.*?)\n\}", self.text, re.S)
        self.assertIsNotNone(match)
        builds = dict(re.findall(r'"([0-9a-f]{32})"\s*=\s*"([^"]+)"', match.group(1)))
        self.assertEqual(builds, INST.DROPBEAR_BUILDS)
        for name in ("Set-UpgradeGates", "Set-DropbearLink"):
            body = self.text.split(f"function {name}(", 1)[1].split("\nfunction ", 1)[0]
            self.assertIn("Test-HubCopyCurrent", body, name)
        removable = self.text.split("function Test-RootToolDropbearRemovable(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("$DropbearLinks[$RootToolDropbear] -ne 1", removable)
        self.assertIn("$DropbearBuilds.Keys -ccontains [string]$Probe[$DropbearDest]", removable)
        credit = self.text.split("function Get-LeftoverCredit(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn('$Probe[$RootToolDropbear]["size"]', credit)
        self.assertIn("$Cand.LinkMd5", self.text.split("function Add-NewCopyLink(", 1)[1].split("\nfunction ", 1)[0])
        self.assertIn("$cand.LinkMd5", self.text.split("function Test-Installed(", 1)[1].split("\nfunction ", 1)[0])

    def test_contract_switches_present(self):
        """[PS1 STATIC] -PreflightOnly and -CleanInstall switches exist."""
        self.assertIn("[switch]$PreflightOnly", self.text)
        self.assertIn("[switch]$CleanInstall", self.text)

    def test_start_services_replaces_the_guard_and_the_usb_eth_worker(self):
        """[PS1 STATIC] Like the Python installer: the running egress guard is
        stopped (so the new one, with the Wi-Fi watchdog, takes over) before it's
        started, and USB Ethernet's worker is restarted only if switched on."""
        start = self.text.split("function Start-Services()", 1)[1].split("function Ensure-ParentDirs()", 1)[0]
        kill = start.index("cat /var/run/codex-offline-egress.pid")
        self.assertLess(kill, start.index("offline_egress_guard.sh monitor"))
        self.assertIn("grep '^ENABLED=1`$' /data/codex/usb_eth.conf", start)
        self.assertIn("/data/codex/usb_eth_service.sh restart", start)
        py = INST_SOURCE.split("def start_services(self)", 1)[1].split("\n    def ", 1)[0]
        self.assertLess(py.index("GUARD_REPLACE"), py.index("offline_egress_guard.sh monitor"))
        self.assertIn("USB_ETH_RESTART", py)
        self.assertIn("usb_eth_service.sh restart", INST_SOURCE.split("USB_ETH_RESTART = (", 1)[1].split(")", 1)[0])

    def test_flag_parity_with_python(self):
        """[PS1 STATIC] Python's preflight/clean-install flags have PS1 parity."""
        source = INSTALLER_PY.read_text(encoding="utf-8")
        self.assertIn('"--preflight-only"', source)
        self.assertIn('"--clean-install"', source)
        self.assertIn("[switch]$PreflightOnly", self.text)
        self.assertIn("[switch]$CleanInstall", self.text)

    def test_first_install_and_missing_blocker_parity(self):
        """[PS1 STATIC] like Python, a hub without /data/codex/hub_id makes the
        run a first (clean) install, and an upgrade creates a missing cloud
        blocker file without replacing an existing one."""
        source = INSTALLER_PY.read_text(encoding="utf-8")
        self.assertIn("self.args.clean_install = True", source)
        self.assertIn('Candidate("/data/codex/cloud_blocker.conf", "644", "config", text="1\\n", condition="if-missing")', source)
        resolve = self.text.split("function Resolve-HubIdentity()", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("$script:CleanInstall = $true", resolve)
        self.assertIn("$script:FirstInstall = $true", resolve)
        self.assertIn(
            'Add-Candidate (New-Candidate "/data/codex/cloud_blocker.conf" "644" "config" -Text "1`n" -Condition "if-missing")',
            self.inventory,
        )

    def test_constants_match_python(self):
        """[PS1 STATIC] stage prefix, suffixes, margins, verdicts match Python."""
        self.assertIn(f"$HandoffKeep = {INST.HANDOFF_KEEP}", self.text)
        self.assertIn(f"$RamMarginBytes = {INST.RAM_MARGIN_BYTES // 1048576} * 1048576", self.text)
        self.assertEqual(self.ps_scalar("NewSuffix"), INST.NEW_SUFFIX)
        self.assertEqual(self.ps_scalar("RestoreSuffix"), INST.RESTORE_SUFFIX)
        self.assertEqual(self.ps_scalar("StagePrefix"), INST.STAGE_PREFIX)
        self.assertEqual(self.ps_scalar("HandoffRoot"), INST.HANDOFF_ROOT)
        self.assertEqual(self.ps_scalar("WebuiDest"), INST.WEBUI_DEST)
        self.assertEqual(self.ps_scalar("VerdictAllowed"), INST.VERDICT_ALLOWED)
        self.assertEqual(self.ps_scalar("VerdictCapacity"), INST.VERDICT_CAPACITY)
        self.assertEqual(self.ps_scalar("VerdictRollbackCapacity"),
                         INST.VERDICT_ROLLBACK_CAPACITY)
        self.assertEqual(self.ps_scalar("VerdictConfigUncertain"),
                         INST.VERDICT_CONFIG_UNCERTAIN)
        self.assertEqual(self.ps_scalar("VerdictValidation"), INST.VERDICT_VALIDATION)

    def test_multi_remote_parity(self):
        """[PS1 STATIC] -MultiRemote on|off mirrors --multi-remote: same
        paths, md5s and patch table, both inventory branches, the copy
        removed after a good install (and on the nothing-to-install path),
        and a reboot when the setting changes."""
        self.assertEqual(self.ps_scalar("HalPath"), INST.HAL_PATH)
        self.assertEqual(self.ps_scalar("HalMultiDest"), INST.HAL_MULTI_DEST)
        self.assertEqual(self.ps_scalar("MultiRemoteConf"), INST.MULTI_REMOTE_CONF)
        # Both installers apply the one patch file: no md5s or edits inline.
        self.assertEqual(self.ps_scalar("HalPatchFile"), "helpers/hal_multiremote_patch.json")
        self.assertEqual(INST.HAL_PATCH_FILE, INST.PAYLOAD / "helpers" / "hal_multiremote_patch.json")
        getter = self.text.split("function Get-PatchedHal(", 1)[1].split("\nfunction ", 1)[0]
        for needle in ("ConvertFrom-Json", "$patch.stock_md5", "$patch.patched_md5", "$patch.edits",
                       "$edit.stock", "$edit.patched", "$edit.offset"):
            self.assertIn(needle, getter)
        doc = json.loads(INST.HAL_PATCH_FILE.read_text(encoding="utf-8"))
        self.assertNotIn(doc["patched_md5"], self.text)
        self.assertIn('Add-Candidate (New-Candidate $HalMultiDest "755" "binary" -Blob $hal)', self.inventory)
        self.assertIn('Add-Candidate (New-Candidate $MultiRemoteConf "644" "config" -Text "1`n")', self.inventory)
        self.assertIn('Add-Candidate (New-Candidate $MultiRemoteConf "644" "config" -Text "0`n")', self.inventory)
        # Neither installer deletes the copy (rcS.local does, at boot); both check
        # the slot table before turning it off.
        self.assertNotIn("Remove-MultiRemoteCopy", self.text)
        self.assertNotIn("rm -f /data/codex/bin/hal_multiremote", self.text)
        self.assertEqual(self.ps_scalar("MultiRemotePending"), INST.MULTI_REMOTE_PENDING)
        self.assertEqual(self.ps_array("NoScreenEquads"), list(INST.NO_SCREEN_EQUADS))
        self.assertIn('Resolve-HubIdentity\nTest-MultiRemoteOff\n', self.main)
        command = self.text.split("function Get-MultiRemoteOffCheckCommand(", 1)[1].split("\nfunction ", 1)[0]
        python_command = INST.multi_remote_off_check_command(True)
        for fragment in ("then echo inactive; ", "then echo guard-failed; ",
                         "elif ps | grep '[r]f.pairing' >/dev/null 2>&1; then echo pairing; ",
                         "else /data/codex/bin/codex_hal_ltcp rf.info '{}' 8 2>&1; fi"):
            self.assertIn(fragment, python_command)
            self.assertIn(fragment, command)
        self.assertIn("-or $multiRemoteChanged) -and -not $NoApplyCloudRestart", self.main)
        # force-off, the mount probe, and the reboot decided by the running hal too.
        self.assertRegex(self.text, r'\[ValidateSet\("on", "off", "force-off"\)\]\s*\[string\]\$MultiRemote')
        self.assertIn('$MultiRemoteForce = $MultiRemote -eq "force-off"', self.text)
        bound = self.text.split("function Get-HalBoundCommand(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn(INST.hal_bound_command().replace(INST.HAL_PATH, "$HalPath"), bound)
        check = self.text.split("function Test-MultiRemoteOff(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn('KV "multi_remote_off_check=forced"', check)
        self.assertIn("WARNING: force-off skips the radio check", check)
        self.assertIn('Invoke-Remote "touch $MultiRemotePending 2>/dev/null; true"', check)
        self.assertLess(check.index("if ($MultiRemoteForce) {"), check.index("Get-MultiRemoteOffCheckCommand"))
        changed = self.text.split("function Test-MultiRemoteChanged(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn('($script:HalBound -ne ($MultiRemote -eq "on"))', changed)
        restart = self.text.split("function Restart-HubAndWait(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("WARNING: the hub restarted but still runs the", restart)
        early = self.main.split("if ((Get-ActiveCandidates).Count -eq 0) {", 1)[1].split("\n}\n", 1)[0]
        self.assertIn("(Test-MultiRemoteChanged) -and -not $NoApplyCloudRestart", early)
        self.assertIn("Restart-HubAndWait", early)
        # Off without the restart is refused while the copy runs, before the guard.
        check = self.text.split("function Test-MultiRemoteOff(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("$guard = (-not $PreflightOnly) -and (-not $NoApplyCloudRestart)", check)
        self.assertLess(check.index('if ($out -eq "inactive")'), check.index("if ($NoApplyCloudRestart) {"))
        self.assertLess(check.index("if ($NoApplyCloudRestart) {"), check.index('elseif ($out -eq "guard-failed")'))
        self.assertNotIn("FromHexString", self.text)  # Windows PowerShell 5.1

    def test_path_arrays_match_python(self):
        """[PS1 STATIC] handoff-required and upgrade-protected paths match."""
        self.assertEqual(self.ps_array("HandoffRequiredPaths"),
                         list(INST.HANDOFF_REQUIRED_PATHS))
        self.assertEqual(self.ps_array("UpgradeProtectedPaths"),
                         list(INST.UPGRADE_PROTECTED_PATHS))

    def test_preflight_gate_precedes_mutation(self):
        """[PS1 STATIC] the PreflightOnly and verdict gates exit before any
        rollback-copy/handoff/install mutation in the main flow."""
        main = self.main
        preflight_gate = main.index("if ($PreflightOnly)")
        verdict_gate = main.index("if ($Verdict -ne $VerdictAllowed)")
        mutation = main.index("Add-RollbackCopies")
        self.assertLess(main.index("Show-PreflightReport"), preflight_gate)
        self.assertLess(preflight_gate, mutation)
        self.assertLess(verdict_gate, mutation)
        # Volatile staging and strict verification precede the probe/plans.
        self.assertLess(main.index("New-StagingTree"), main.index("Send-CandidatesToStage"))
        self.assertLess(main.index("Send-CandidatesToStage"), main.index("Test-StagedMd5"))
        self.assertLess(main.index("Test-StagedMd5"), main.index("Invoke-DestinationProbe"))
        self.assertLess(main.index("Build-Plans"), main.index("Set-Verdict"))

    def test_rollback_prepared_before_replacement_and_verified_before_services(self):
        """[PS1 STATIC] main order: rollback copies -> retention/handoff ->
        install -> Test-Installed -> wiring -> Start-Services -> cleanup."""
        main = self.main
        self.assertLess(main.index("Add-RollbackCopies"), main.index("New-HandoffBackup"))
        self.assertLess(main.index("New-HandoffBackup"), main.index("Write-NewCopies"))
        self.assertLess(main.index("Write-NewCopies"), main.index("Install-Sequence"))
        self.assertLess(main.index("Install-Sequence"), main.index("Test-Installed"))
        self.assertLess(main.index("Test-Installed"), main.index("Invoke-PostWiring"))
        self.assertLess(main.index("Invoke-PostWiring"), main.index("Start-Services"))
        self.assertLess(main.index("Start-Services"),
                        main.index("Remove-StagingTree", main.index("Start-Services")))

    def test_webui_installed_last_in_inventory(self):
        """[PS1 STATIC] codex_webui skipped in the manifest loop and appended
        as the final candidate."""
        self.assertIn('if ($name -eq "codex_webui") { continue }', self.inventory)
        add_lines = [
            line.strip()
            for line in self.inventory.splitlines()
            if line.strip().startswith("Add-Candidate")
        ]
        self.assertTrue(add_lines)
        self.assertIn("$WebuiDest", add_lines[-1])

    def test_rollback_contract_tokens(self):
        """[PS1 STATIC] rollback removes leftover copies, restores in reverse
        via copy-then-rename, and an incomplete rollback preserves staging."""
        self.assertIn("Remove-NewCopies", self.rollback)
        self.assertIn("$RestoreSuffix", self.rollback)
        self.assertIn("mv -f", self.rollback)
        self.assertIn("[Array]::Reverse($pending)", self.rollback)
        self.assertIn("$script:PreserveStage = $true", self.rollback)
        self.assertIn("rollback incomplete", self.rollback)
        self.assertIn("Do NOT reboot", self.rollback)

    def test_busybox_only_and_strict_md5(self):
        """[PS1 STATIC] no C engine modes or missing BusyBox applets remain;
        strict BusyBox md5 regex and the flash-full abort are present."""
        for gone in ("--storage-status", "--install-plan", "--install-file",
                     "--prune-backups", "--rollback-restore", "--file-status",
                     "mktemp -d", "Invoke-StagedC"):
            self.assertNotIn(gone, self.text)
        self.assertIn("'^[0-9a-f]{32}  .+$'", self.text)
        self.assertIn("catch [CapacityAbort]", self.main)
        self.assertIn("cat /proc/meminfo", self.text)

    def test_no_remote_shell_stat_or_readlink(self):
        """[PS1 STATIC] no remote shell stat/readlink may remain anywhere in
        the PowerShell installer (documentation text excepted)."""
        self.assertNotIn("stat -c", self.text)
        self.assertNotIn("$(stat", self.text)
        self.assertNotIn("readlink", self.text)

    def test_file_status_powers_probe_and_verify(self):
        """[PS1 STATIC] destination discovery and post-install verification
        both use the shared BusyBox Get-FileStatus probe, which matches the
        Python probe command byte for byte."""
        probe = self.text.split("function Invoke-DestinationProbe()", 1)[1].split(
            "function Stop-WithValidation(", 1
        )[0]
        self.assertIn("Get-FileStatus", probe)
        verify = self.text.split("function Test-Installed()", 1)[1].split(
            "function Invoke-Rollback(", 1
        )[0]
        self.assertIn("Get-FileStatus", verify)
        self.assertNotIn("md5sum", verify)
        loop = INST.file_status_command(["X"]).split("; do ", 1)[1]
        ps_loop = "".join(re.findall(
            r"'([^']*)'", self.text.split("function Get-FileStatus(", 1)[1].split("$r = Invoke-RemoteRc", 1)[0]))
        self.assertEqual(ps_loop, loop)
        handoff = self.text.split("function New-HandoffBackup()", 1)[1].split(
            "function Install-Sequence()", 1
        )[0]
        self.assertNotIn("stat -c", handoff)
        self.assertNotIn("$(stat", handoff)
        self.assertNotIn("readlink", handoff)

    def ps_here_string(self, variable: str) -> str:
        match = re.search(rf"\${re.escape(variable)} = @'\r?\n(.*?)\r?\n'@", self.text, re.S)
        assert match, f"missing ${variable} here-string"
        return match.group(1)

    def test_flash_constants_match_python(self):
        """[PS1 STATIC] flash probe, jffs2 model, margins, and root-tool paths
        match Python."""
        for variable, value in (
            ("Jffs2Page", INST.JFFS2_PAGE),
            ("Jffs2NodeHeader", INST.JFFS2_NODE_HEADER),
            ("Jffs2DirentHeader", INST.JFFS2_DIRENT_HEADER),
            ("FlashMarginPercent", INST.FLASH_MARGIN_PERCENT),
        ):
            self.assertIn(f"${variable} = {value}\n", self.text)
        self.assertIn(f"$FlashMarginBytes = {INST.FLASH_MARGIN_BYTES // 1024} * 1024", self.text)
        self.assertEqual(self.ps_scalar("FlashHelperName"), INST.FLASH_HELPER_NAME)
        self.assertEqual(INST.FLASH_HELPER.name, INST.FLASH_HELPER_NAME)
        self.assertEqual(self.ps_scalar("FlashPath"), INST.FLASH_PATH)
        self.assertEqual(self.ps_scalar("DropbearDest"), INST.DROPBEAR_DEST)
        self.assertEqual(self.ps_scalar("RootToolDropbear"), INST.ROOT_TOOL_DROPBEAR)
        pattern = re.search(r"\$RootToolStagePattern = '([^']*)'", self.text).group(1)
        self.assertEqual(pattern, INST.ROOT_TOOL_STAGE_RE.pattern)

    def test_root_tool_commands_match_python(self):
        """[PS1 STATIC] the leftover scan and the Dropbear removal run the
        same hub commands as Python, byte for byte."""
        self.assertEqual(self.ps_here_string("RootToolScan"), INST.ROOT_TOOL_SCAN)
        self.assertEqual(self.ps_here_string("RootToolDropbearRemove"), INST.ROOT_TOOL_DROPBEAR_REMOVE)

    def test_flash_switches_parity(self):
        """[PS1 STATIC] Python's flash and cleanup flags have PS1 switches."""
        source = INSTALLER_PY.read_text(encoding="utf-8")
        self.assertIn('"--remove-root-tool-leftovers"', source)
        self.assertIn('"--skip-flash-check"', source)
        self.assertIn("[switch]$RemoveRootToolLeftovers", self.text)
        self.assertIn("[switch]$SkipFlashCheck", self.text)

    def test_flash_steps_in_main_flow(self):
        """[PS1 STATIC] main order matches Python: probe staged with the
        candidates, flash measured before the plans, link planned after the
        gates, leftovers removed after the verdict gate and before any
        rollback copy, flash measured again before the final cleanup."""
        main = self.main
        self.assertLess(main.index("Send-CandidatesToStage"), main.index("Send-FlashHelper"))
        self.assertLess(main.index("Send-FlashHelper"), main.index("Test-StagedMd5"))
        self.assertLess(main.index("Set-UpgradeGates"), main.index("Set-DropbearLink"))
        self.assertLess(main.index("Measure-Flash"), main.index("Build-Plans"))
        self.assertLess(main.index("Get-RootToolLeftovers"), main.index("Build-Plans"))
        self.assertLess(main.index("if ($Verdict -ne $VerdictAllowed)"), main.index("Remove-RootToolLeftovers"))
        self.assertLess(main.index("Remove-RootToolLeftovers"), main.index("Add-RollbackCopies"))
        self.assertLess(main.index("Show-FlashAfterInstall"), main.rindex("Remove-StagingTree"))
        self.assertIn('$script:CapacityStage = "phase1"', main)
        write = self.text.split("function Write-NewCopies()", 1)[1].split("function Install-Sequence()", 1)[0]
        self.assertLess(write.index("Add-NewCopyLink"), write.index("cp $(Remote-Quote"))
        probe = self.text.split("function Invoke-DestinationProbe()", 1)[1].split("function Stop-WithValidation(", 1)[0]
        self.assertIn("$RootToolDropbear", probe)

    def test_trap_guarantees_staging_cleanup(self):
        """[PS1 STATIC] unhandled terminating errors remove the owned stage."""
        main = self.main
        trap_at = main.index("trap {")
        self.assertLess(trap_at, main.index("New-StagingTree"))
        self.assertIn("Remove-StagingTree", main[trap_at:trap_at + 120])

    def test_turn_off_and_turn_on_parity_and_crlf(self):
        """[PS1 STATIC] install_webui.ps1 keeps CRLF, embeds the exact same
        TURN_OFF_SCRIPT and MELODIOUS_OFF_CHECK_CMD bytes as install_webui.py,
        and mirrors -TurnOff, -TurnOn, -Force, refusal, bootstrap, and Wi-Fi
        switchover."""
        raw = INSTALLER_PS1.read_bytes()
        self.assertIn(b"\r\n", raw)
        self.assertNotIn(b"\n", raw.replace(b"\r\n", b""), "install_webui.ps1 must use CRLF on every line")

        for sw in ("[switch]$TurnOff", "[switch]$TurnOn", "[switch]$Force"):
            self.assertIn(sw, self.text)
        self.assertEqual(self.ps_scalar("TurnOffScriptPath"), INST.TURN_OFF_SCRIPT_PATH)
        self.assertEqual(self.ps_scalar("MelodiousOffMarker"), INST.MELODIOUS_OFF_MARKER)
        self.assertEqual(self.ps_scalar("LegacyMelodiousOffMarker"), INST.LEGACY_MELODIOUS_OFF_MARKER)
        self.assertEqual(self.ps_here_string("MelodiousOffCheckCmd"), INST.MELODIOUS_OFF_CHECK_CMD)
        self.assertEqual(self.ps_here_string("TurnOffScript") + "\n", INST.TURN_OFF_SCRIPT)

        # GateScriptSpecs matches GATE_SCRIPT_SPECS destinations and modes in order.
        specs_block = self.text.split("$GateScriptSpecs = @(", 1)[1].split("\n)", 1)[0]
        ps_specs = re.findall(r'@\("([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)"\)', specs_block)
        py_specs = [
            (dest, mode, kind, str(local.relative_to(INST.PAYLOAD)).replace("\\", "/"))
            for dest, mode, kind, local in INST.GATE_SCRIPT_SPECS
        ]
        self.assertEqual(ps_specs, py_specs)

        # Mutual exclusions + normal-run refusal + TurnOff/TurnOn dispatch order.
        self.assertIn('if ($TurnOff -and $TurnOn)', self.text)
        self.assertIn('if ($Force -and -not $TurnOff)', self.text)
        self.assertIn('if ($CleanInstall) { throw "$modeFlag cannot be combined with -CleanInstall" }', self.text)
        self.assertIn('if ($NoApplyCloudRestart) { throw "$modeFlag cannot be combined with -NoApplyCloudRestart" }', self.text)
        main = self.main.replace("\r\n", "\n")
        self.assertLess(main.index("if ($TurnOff) { exit (Invoke-TurnOff) }"), main.index("Test-NotTurnedOff"))
        self.assertLess(main.index("if ($TurnOn) { exit (Invoke-TurnOn) }"), main.index("Test-NotTurnedOff"))
        self.assertLess(main.index("Test-NotTurnedOff"), main.index("Resolve-HubIdentity"))
        self.assertIn("Invoke-TurnOffBootstrap", self.text)
        self.assertIn("post_reboot_host=$wifiIp", self.text)
        self.assertIn("reboot_confirmed=", self.text)

        # EXPERIMENTAL disclaimer parity: identical banner bytes, printed
        # before any action, with an explicit non-interactive acknowledgment
        # gate and the warning folded into both confirmation prompts.
        self.assertEqual(
            self.ps_here_string("ExperimentalTurnOffWarning"), INST.EXPERIMENTAL_TURN_OFF_WARNING
        )
        self.assertIn("[switch]$IUnderstandExperimental", self.text)
        self.assertIn("if ($IUnderstandExperimental -and -not ($TurnOff -or $TurnOn))", self.text)
        banner_call = self.text.index("Warn-ExperimentalTurnOffOn\n")
        ack_gate = self.text.index("if ($NoPrompt -and -not $PreflightOnly -and -not $IUnderstandExperimental)")
        ssh_step = self.text.index('Step "Checking SSH"')
        self.assertLess(banner_call, ssh_step, "the EXPERIMENTAL banner must print before any action")
        self.assertLess(ack_gate, ssh_step, "the -NoPrompt ack gate must fire before any hub contact")
        for prompt in (
            "EXPERIMENTAL, not validated on live hardware. Turn Melodious off and restart the hub?",
            "EXPERIMENTAL, not validated on live hardware. Turn Melodious back on and restart the hub?",
        ):
            self.assertIn(prompt, self.text)
            self.assertIn(prompt, INST_SOURCE)


@unittest.skipUnless(shutil.which("pwsh"),
                     "[PS1 RUNTIME-OPTIONAL] pwsh not installed; left to Main")
class PowerShellRuntimeParse(unittest.TestCase):
    """[PS1 RUNTIME-OPTIONAL] pwsh AST parse: the script must parse cleanly
    and expose the contract parameters. No installer logic is executed."""

    def test_script_parses_and_exposes_contract_parameters(self):
        ps_code = (
            "$tokens = $null; $errors = $null\n"
            "$ast = [System.Management.Automation.Language.Parser]::ParseFile("
            f"'{INSTALLER_PS1}', [ref]$tokens, [ref]$errors)\n"
            "if ($errors.Count -gt 0) { $errors | ForEach-Object { "
            "Write-Error $_.Message }; exit 1 }\n"
            "$pb = $ast.Find({ param($n) $n -is "
            "[System.Management.Automation.Language.ParamBlockAst] }, $true)\n"
            "($pb.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath }) "
            "-join ','\n"
        )
        proc = subprocess.run(
            ["pwsh", "-NoProfile", "-Command", ps_code],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8", "replace"))
        names = proc.stdout.decode("utf-8", "replace").strip().split(",")
        for required in ("HubHost", "PreflightOnly", "CleanInstall", "MqttPassword"):
            self.assertIn(required, names)


if __name__ == "__main__":
    unittest.main(verbosity=2)
