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
  cloud-blocker files change.

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

    def __init__(self, available_bytes: int = 100_000_000) -> None:
        self.fs: dict[str, dict[str, object]] = {}
        self.symlinks: set[str] = set()
        self.events: list[tuple] = []
        self.stage = FAKE_STAGE
        # Flash bytes left for phase-1 copies; there is no way to query it.
        self.available_bytes = available_bytes
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
        # Short md5sum responses: these paths emit no output line.
        self.md5sum_drop_paths: set[str] = set()

    # ------------------------------------------------------------- fs model

    def set_file(self, path: str, data: bytes, mode: str) -> None:
        self.fs[path] = {"data": data, "mode": mode}
        if not path.startswith(self.stage + "/"):
            self.events.append(("persistent_write", path))

    def remove_file(self, path: str) -> None:
        self.fs.pop(path, None)

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

        if c.startswith("for p in "):
            return self.do_probe(shlex.split(c[len("for p in "):c.index("; do ")]))

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
            return 0, "", ""

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
            return 0, "rebooting\n", ""

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
            if len(data) > self.available_bytes:
                # Real cp leaves a truncated file behind on ENOSPC.
                self.set_file(dst, data[: self.available_bytes], "644")
                self.available_bytes = 0
                return 1, "", "cp: write error: No space left on device"
            self.available_bytes -= len(data)
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

    def do_rename(self, src: str, dst: str) -> tuple[int, str, str]:
        if self.timeout_rename_dest == dst:
            raise subprocess.TimeoutExpired(cmd=f"ssh mv {dst}", timeout=60, output=None, stderr=None)
        if self.fail_rename_dest == dst:
            return 1, "", f"mv: can't rename '{src}': simulated failure"
        entry = self.fs.pop(src)
        self.set_file(dst, entry["data"], entry["mode"])
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
        "/etc/init.d/rcS.local",
    ):
        put(path, f"fake-original {path}\n".encode() * 3, pre_modes.get(path, "755"))
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

    Patches exactly four seams on the imported module: the ssh transport
    (Installer.run_remote_rc), wait_for_port, time.sleep, and the random
    staging suffix. Everything else is real installer code.
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

        def fake_wait_for_port(host, port, seconds, label):
            hub.events.append(("port_wait", port, label))
            if hub.smoke_fail and port == 8080:
                raise RuntimeError("simulated service validation failure (fake port 8080)")

        old_rrc = INST.Installer.run_remote_rc
        old_wait = INST.wait_for_port
        old_sleep = INST.time.sleep
        old_suffix = INST.stage_suffix
        INST.Installer.run_remote_rc = fake_run_remote_rc
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
            INST.wait_for_port = old_wait
            INST.time.sleep = old_sleep
            INST.stage_suffix = old_suffix
        return code, stdout_buf.getvalue(), stderr_buf.getvalue()


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
        # Staged candidates uploaded at 0600 under the private tree.
        uploads = [e for e in self.hub.events if e[0] == "staged_upload"]
        self.assertTrue(uploads)
        for _kind, path, mode in uploads:
            self.assertTrue(path.startswith(self.hub.stage + "/"))
            self.assertEqual(mode, "600", f"staged {path} must be 0600")
        self.assertEqual(len([e for e in self.hub.events if e[0] == "probe"]), 1)
        self.assertIn(("meminfo",), self.hub.events)
        self.assertEqual(kv_value(stdout, "flash_capacity_check"), "two-phase-commit")
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
        sensitive_index = binary_count + 13
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
        files untouched, starts no services, and reports BLOCKED_CAPACITY."""
        webui_size = (INST.PAYLOAD / "bin" / "codex_webui").stat().st_size
        self.hub.available_bytes = webui_size  # earlier copies use some of it
        code, stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 2, stderr or stdout)
        self.assertEqual(kv_multi(stdout, "verdict")[-1], INST.VERDICT_CAPACITY)
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

    def test_reboot_only_when_cloud_blocker_changes(self):
        """[PYTHON BEHAVIORAL] without --no-apply-cloud-restart the hub reboots
        only if netservicestarter.lua or cloud_blocker.conf changed."""
        argv = [a for a in self.harness.base_argv() if a != "--no-apply-cloud-restart"]
        code, stdout, stderr = self.harness.run(argv)
        self.assertEqual(code, 0, stderr or stdout)
        self.assertIn(("service", "reboot"), self.hub.events)

        hub = FakeHub()
        prime_upgrade_hub(hub)
        nss = INST.PAYLOAD / "scripts" / "netservicestarter.lua"
        hub.fs["/opt/luaworks/tasks/connectserver/netservicestarter.lua"] = {
            "data": nss.read_bytes(), "mode": "644"}
        harness = InstallerHarness(hub)
        self.addCleanup(harness.close)
        code, stdout, stderr = harness.run(argv)
        self.assertEqual(code, 0, stderr or stdout)
        self.assertNotIn(("service", "reboot"), hub.events)


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

    def test_contract_switches_present(self):
        """[PS1 STATIC] -PreflightOnly and -CleanInstall switches exist."""
        self.assertIn("[switch]$PreflightOnly", self.text)
        self.assertIn("[switch]$CleanInstall", self.text)

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

    def test_trap_guarantees_staging_cleanup(self):
        """[PS1 STATIC] unhandled terminating errors remove the owned stage."""
        main = self.main
        trap_at = main.index("trap {")
        self.assertLess(trap_at, main.index("New-StagingTree"))
        self.assertIn("Remove-StagingTree", main[trap_at:trap_at + 120])


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
