#!/usr/bin/env python3
"""Deterministic local contract tests for the Step 4A root installers.

Subjects under test (repo root):

* ``install_webui.py``  -- Python installer.
  [PYTHON BEHAVIORAL] coverage: the real installer code is executed through a
  fake SSH/transport harness (a simulated BusyBox hub with a fake staged C
  engine that answers key=value). No network, no real ssh, no subprocesses.

* ``install_webui.ps1`` -- PowerShell installer.
  [PS1 STATIC] coverage: structured assertions on flags, constants, path
  arrays, and main-flow call ordering (always run; pwsh not required).
  [PS1 RUNTIME-OPTIONAL] coverage: a pwsh AST parse/param check that runs
  only when pwsh is installed; otherwise it is skipped and left to Main.

Contract proven (Python behavioral):
  preflight-only stages candidates in a private /var/volatile/codex-install-*
  0700 tree, strict-MD5 verifies them, invokes the staged C storage status
  and install planner, performs no persistent writes/prune/handoff/install/
  restart, reports ALLOWED/BLOCKED_*, and removes only its staging tree;
  capacity refusal; rollback-capacity refusal; strict checksum failure;
  later-file failure restoring earlier files' bytes and original modes;
  created-file removal on rollback; post-write verification failure;
  simulated service validation failure; incomplete rollback is fatal and
  preserves staging; upgrade omits protected config candidates and preserves
  existing configuration; codex_webui is installed last; no service action
  before post-install verification; rollback is prepared before replacement;
  required_total == 1048576 floor + handoff + forward + rollback.

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


def ceil_fragment(size: int, fragment: int) -> int:
    if size <= 0:
        return 0
    return ((size + fragment - 1) // fragment) * fragment


class FakeHub:
    """Simulated BusyBox hub: fake filesystem + fake staged C engine.

    Every remote command the installer issues over ssh lands in dispatch().
    The fake records an ordered event log used for sequencing assertions and
    tracks file-level persistent writes (any mutation outside the staging
    prefix). Directory-level side effects of compound wiring commands are
    intentionally not modeled at file level.
    """

    def __init__(self, available_bytes: int = 100_000_000) -> None:
        self.fs: dict[str, dict[str, object]] = {}
        self.events: list[tuple] = []
        self.stage = FAKE_STAGE
        self.available_bytes = available_bytes
        self.fragment = 4096
        self.storage_path = "/mnt/data"
        self.fail_install_dest: str | None = None
        self.fail_rollback_restore_dest: str | None = None
        self.corrupt_staged_md5: str | None = None
        # --file-status post-install corruption: flip the reported md5 for any
        # destination after N successful installs.
        self.file_status_corrupt_md5_after: int | None = None
        self.installs_done = 0
        self.smoke_fail = False
        self.stage_created = False
        # Transport-level failures (must NOT be RuntimeError subclasses).
        self.timeout_install_dest: str | None = None
        # Wiring/service exceptions after destinations were replaced.
        self.fail_wiring = False
        self.fail_service_start_times = 0
        # C nonzero AFTER rename_completed=1 (post-write measurement failure).
        self.fail_post_write_dest: str | None = None
        # Short md5sum responses: these paths emit no output line.
        # Planner exit 1 with ok=1 is a capacity refusal, not validation.
        self.planner_exit1_ok1 = False
        self.md5sum_drop_paths: set[str] = set()
        # --file-status emulation knobs.
        self.file_status_wrong_mode: dict[str, str] = {}
        self.file_status_refuse: dict[str, str] = {}

    # ------------------------------------------------------------- fs model

    def set_file(self, path: str, data: bytes, mode: str) -> None:
        self.fs[path] = {"data": data, "mode": mode}
        if not path.startswith(self.stage + "/"):
            self.events.append(("persistent_write", path))

    def remove_file(self, path: str) -> None:
        self.fs.pop(path, None)

    def paths_under_stage(self) -> list[str]:
        return sorted(p for p in self.fs if p.startswith(self.stage + "/") or p == self.stage)

    # ------------------------------------------------------------ dispatch

    def dispatch(self, command: str, input_bytes: bytes | None = None) -> tuple[int, str, str]:
        self.events.append(("cmd", command))
        c = command.strip()

        # Reintroduction tripwire: destination discovery, post-install
        # verification, and handoff sizing must use staged C --file-status,
        # never remote shell stat/readlink. md5sum stays only for staged
        # candidate/engine/rollback-copy verification under the stage tree.
        if "stat -c" in c or "stat -c " in c or "readlink" in c or "$(stat" in c:
            raise AssertionError(f"fake hub rejected remote shell stat/readlink: {c!r}")

        if c == "id; uname -a":
            return 0, "uid=0(root) gid=0(root)\nLinux harmony-fake 3.10.14-codex #1 MIPS\n", ""

        if c == "cat /data/codex/hub_id 2>/dev/null || true":
            entry = self.fs.get("/data/codex/hub_id")
            return 0, entry["data"].decode("utf-8") if entry else "", ""

        if c.startswith("D=$(mktemp -d " + INST.STAGE_PREFIX):
            self.stage_created = True
            self.events.append(("staging_create", self.stage, "700"))
            return 0, self.stage + "\n", ""

        if c.startswith("cat > "):
            segments = c.split(" && ")
            path = shlex.split(segments[0])[2]
            mode = shlex.split(segments[1])[1] if len(segments) > 1 else ""
            self.set_file(path, input_bytes or b"", mode)
            self.events.append(("staged_upload", path, mode))
            return 0, "", ""

        if c.startswith("md5sum "):
            return self.do_md5sum(shlex.split(c)[1:])

        if c.startswith("cp -p "):
            return self.do_copy(c)

        if c.startswith("rm -rf "):
            target = shlex.split(c)[2]
            self.events.append(("rm_rf", target))
            for path in list(self.fs):
                if path == target or path.startswith(target + "/"):
                    self.fs.pop(path, None)
            return 0, "", ""

        if c.startswith("rm -f "):
            target = shlex.split(c)[2]
            self.remove_file(target)
            self.events.append(("rm", target))
            return 0, "", ""

        if c.startswith("test ! -e "):
            target = shlex.split(c)[3]
            return (1, "", "") if target in self.fs else (0, "", "")

        if c.startswith("chmod ") and "&&" not in c:
            tokens = shlex.split(c)
            mode, path = tokens[1], tokens[2]
            if path in self.fs:
                self.fs[path]["mode"] = mode
                self.events.append(("chmod", path, mode))
                return 0, "", ""
            return 1, "", f"chmod: {path}: No such file or directory"

        if c.startswith("mkdir -p") and "ln -sf dropbearmulti" in c:
            if self.fail_wiring:
                return 1, "", "simulated wiring failure"
            self.events.append(("wiring",))
            return 0, "", ""

        if c.startswith("mkdir -p"):
            self.events.append(("mkdir",))
            return 0, "", ""

        if c.startswith("for d in /data/codex-backups"):
            return 0, FAKE_EXISTING_GENERATION + "\n", ""

        if c.startswith("S=$(date"):
            # Handoff physically consumes the handoff-reserved bytes on the
            # same authoritative backing the C engine measures.
            consumed = 0
            for path in INST.HANDOFF_REQUIRED_PATHS:
                entry = self.fs.get(path)
                if entry is not None:
                    consumed += ceil_fragment(len(entry["data"]), self.fragment) + self.fragment
            self.available_bytes -= consumed
            handoff = f"{INST.HANDOFF_ROOT}/webui-handoff-{FAKE_HANDOFF_STAMP}"
            self.events.append(("handoff", handoff, consumed))
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

        tokens = shlex.split(c)
        if tokens and tokens[0].startswith(self.stage + "/engine-"):
            return self.do_engine(tokens)

        raise AssertionError(f"fake hub received unexpected command: {c!r}")

    # --------------------------------------------------------- sub-handlers

    def do_md5sum(self, paths: list[str]) -> tuple[int, str, str]:
        if all(p.startswith(self.stage + "/") for p in paths):
            phase = "stage-verify"
        elif len(paths) >= 2:
            phase = "post-install-verify"
        else:
            phase = "rollback-verify"
        if phase == "post-install-verify":
            self.events.append(("verify_installed",))
        lines = []
        for path in paths:
            if path in self.md5sum_drop_paths:
                continue
            entry = self.fs.get(path)
            if entry is None:
                return 1, "", f"md5sum: {path}: No such file or directory"
            digest = md5_bytes(entry["data"])
            if phase == "stage-verify" and self.corrupt_staged_md5 == path:
                digest = flip_digest(digest)
            lines.append(f"{digest}  {path}")
        return 0, "\n".join(lines) + "\n", ""

    def do_copy(self, command: str) -> tuple[int, str, str]:
        segments = command.split(" && ")
        src, dst = shlex.split(segments[0])[2], shlex.split(segments[0])[3]
        entry = self.fs.get(src)
        if entry is None:
            return 1, "", f"cp: {src}: No such file or directory"
        mode = shlex.split(segments[1])[1]
        self.set_file(dst, entry["data"], mode)
        basename = dst.rsplit("/", 1)[-1]
        if basename.startswith("rb-"):
            self.events.append(("rollback_copy", src, dst))
        elif basename.startswith("engine-"):
            self.events.append(("engine_copy", dst))
        return 0, f"{md5_bytes(entry['data'])}  {dst}\n", ""

    def do_engine(self, tokens: list[str]) -> tuple[int, str, str]:
        args = tokens[1:]
        self.events.append(("engine", tuple(args)))
        mode = args[0]
        if mode == "--storage-status":
            floor = int(args[1])
            body = (
                f"mode=storage-status\nok=1\nstorage_path={self.storage_path}\n"
                f"available_bytes={self.available_bytes}\n"
                f"fragment_bytes={self.fragment}\nrequired_bytes={floor}\n"
                f"sufficient={1 if self.available_bytes >= floor else 0}\n"
            )
            return (0 if self.available_bytes >= floor else 1), body, ""

        if mode == "--install-plan":
            src, dest, _mode_arg, floor_arg = args[1], args[2], args[3], int(args[4])
            size = len(self.fs[src]["data"])
            forward = ceil_fragment(size, self.fragment) + self.fragment
            existing = self.fs.get(dest)
            rollback = (
                ceil_fragment(len(existing["data"]), self.fragment) + self.fragment
                if existing
                else 0
            )
            required = floor_arg + forward + rollback
            sufficient = self.available_bytes >= required
            body = (
                f"mode=install-plan\nok=1\nsource={src}\ndestination={dest}\nallowed=1\n"
                f"candidate_reservation_bytes={forward}\n"
                f"rollback_reservation_bytes={rollback}\n"
                f"available_bytes={self.available_bytes}\n"
                f"required_bytes={required}\n"
                f"sufficient={1 if sufficient else 0}\n"
            )
            if self.planner_exit1_ok1:
                # The C planner contract deliberately returns exit 1 with a
                # complete reservation record and sufficient=0.
                return 1, body.replace("sufficient=1", "sufficient=0"), ""
            # Real C: exit 1 with ok=1 when capacity is insufficient.
            return (0 if sufficient else 1), body, ""

        if mode == "--install-file":
            src, dest, mode_arg, floor = args[1], args[2], args[3], int(args[4])
            is_rollback = "--rollback-restore" in args
            if not is_rollback and self.timeout_install_dest == dest:
                raise subprocess.TimeoutExpired(
                    cmd=f"ssh {dest}", timeout=180,
                    output=None, stderr=None,
                )
            if is_rollback and self.fail_rollback_restore_dest == dest:
                return 1, f"error=simulated_rollback_restore_failure\ndest={dest}\n", ""
            if not is_rollback and self.fail_install_dest == dest:
                return 1, f"error=simulated_install_failure\ndest={dest}\n", ""
            size = len(self.fs[src]["data"])
            reservation = ceil_fragment(size, self.fragment) + self.fragment
            if self.available_bytes < floor + reservation:
                return 1, "error=insufficient_space\n", ""
            self.set_file(dest, self.fs[src]["data"], mode_arg)
            self.available_bytes -= reservation
            if not is_rollback:
                self.installs_done += 1
            self.events.append(("install_file", dest, is_rollback))
            if not is_rollback and self.fail_post_write_dest == dest:
                # Real C: rename completes, then the post-write measurement
                # fails -> nonzero exit with rename_completed=1.
                return 1, (
                    f"rename_completed=1\nresult=installed\n"
                    f"errors=1\nreason=post_write_measurement_failed\ndest={dest}\n"
                ), ""
            return 0, (
                f"rename_completed={0 if is_rollback else 1}\nresult=installed\n"
                f"errors=0\ndest={dest}\nbytes={size}\n"
            ), ""

        if mode == "--prune-backups":
            self.events.append(("prune",))
            return 0, "scanned=3 deleted=0 pruned_bytes=0 over_budget=0 errors=0\n", ""

        if mode == "--file-status":
            return self.do_file_status(args[1])

        raise AssertionError(f"fake engine received unexpected mode: {mode!r}")

    def do_file_status(self, dest: str) -> tuple[int, str, str]:
        if dest in self.file_status_refuse:
            reason = self.file_status_refuse[dest]
            body = (
                f"operation=file-status\nok=0\ndestination={dest}\nallowed=0\n"
                f"exists=0\ntype=absent\nbytes=0\nallocated_bytes=0\n"
                f"md5=none\nmode_decimal=0\nerrors=1\nreason={reason}\n"
            )
            return 1, body, ""
        entry = self.fs.get(dest)
        if entry is None:
            body = (
                f"operation=file-status\nok=1\ndestination={dest}\nallowed=1\n"
                f"exists=0\ntype=absent\nbytes=0\nallocated_bytes=0\n"
                f"md5=none\nmode_decimal=0\nerrors=0\n"
            )
            return 0, body, ""
        mode = self.file_status_wrong_mode.get(dest, entry["mode"])
        mode_decimal = int(mode, 8)
        data = entry["data"]
        digest = md5_bytes(data)
        if (
            self.file_status_corrupt_md5_after is not None
            and self.installs_done >= self.file_status_corrupt_md5_after
        ):
            digest = flip_digest(digest)
        # Post-install verification marker: at least one install completed and
        # the destination is outside the staging tree.
        if self.installs_done > 0 and not dest.startswith(self.stage + "/"):
            self.events.append(("verify_installed",))
        allocated = ceil_fragment(len(data), self.fragment)
        body = (
            f"operation=file-status\nok=1\ndestination={dest}\nallowed=1\n"
            f"exists=1\ntype=regular\nbytes={len(data)}\nallocated_bytes={allocated}\n"
            f"md5={digest}\nmode_decimal={mode_decimal}\nerrors=0\n"
        )
        return 0, body, ""

    # ------------------------------------------------------------- queries

    def indices(self, predicate) -> list[int]:
        return [i for i, event in enumerate(self.events) if predicate(event)]

    def first_index(self, predicate) -> int:
        found = self.indices(predicate)
        assert found, f"no event matched {predicate!r} in {self.events!r}"
        return found[0]


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


class InstallerHarness:
    """Runs the real installer main() against a FakeHub.

    Patches exactly three seams on the imported module: the ssh transport
    (Installer.run_remote_rc), wait_for_port, and time.sleep. Everything
    else is real installer code.
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
        INST.Installer.run_remote_rc = fake_run_remote_rc
        INST.wait_for_port = fake_wait_for_port
        INST.time.sleep = lambda _seconds: None
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


def engine_calls(hub: FakeHub, mode: str) -> list[tuple]:
    return [
        event[1]
        for event in hub.events
        if event[0] == "engine" and event[1] and event[1][0] == mode
    ]


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
        self.assertEqual(engine_calls(self.hub, "--install-file"), [])
        self.assertEqual(engine_calls(self.hub, "--prune-backups"), [])
        self.assertFalse(any(e[0] == "handoff" for e in self.hub.events))
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
        """[PYTHON BEHAVIORAL] preflight stages in 0700 volatile tree, verifies
        MD5 strictly, runs staged C storage-status + install-plan, reports
        ALLOWED, removes only its staging tree, and mutates nothing else."""
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
        # Staged C engine invoked: storage status with the exact 1 MiB floor,
        # then one install-plan per active candidate, always floor 1048576.
        status_calls = engine_calls(self.hub, "--storage-status")
        self.assertIn(("1048576",), [(c[1],) for c in status_calls])
        plan_calls = engine_calls(self.hub, "--install-plan")
        self.assertTrue(plan_calls)
        for call in plan_calls:
            self.assertEqual(call[4], "1048576")
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

    def _run_preflight_verdict(self, available: int) -> tuple[int, str]:
        self.hub.available_bytes = available
        code, stdout, _stderr = self.harness.run(self.harness.base_argv("--preflight-only"))
        self._stdout = stdout
        return code, stdout

    def _totals(self, stdout: str) -> dict[str, int]:
        return {
            key: int(kv_value(stdout, key))
            for key in (
                "floor_bytes",
                "handoff_reservation_bytes",
                "forward_total_bytes",
                "rollback_total_bytes",
                "required_total_bytes",
            )
        }

    def _generous_totals(self) -> dict[str, int]:
        hub = FakeHub()
        prime_upgrade_hub(hub)
        harness = InstallerHarness(hub)
        self.addCleanup(harness.close)
        code, stdout, _ = harness.run(harness.base_argv("--preflight-only"))
        self.assertEqual(code, 0, stdout)
        return self._totals(stdout)

    def test_preflight_blocked_capacity(self):
        """[PYTHON BEHAVIORAL] available below floor+handoff+forward refuses
        with BLOCKED_CAPACITY and no persistent mutation."""
        totals = self._generous_totals()
        below = (
            totals["floor_bytes"]
            + totals["handoff_reservation_bytes"]
            + totals["forward_total_bytes"]
            - 1
        )
        code, stdout = self._run_preflight_verdict(below)
        self.assertEqual(code, 2)
        self.assertEqual(kv_value(stdout, "verdict"), INST.VERDICT_CAPACITY)
        self.assert_no_persistent_mutation()
        self.assert_stage_removed_only()

    def test_preflight_blocked_rollback_capacity(self):
        """[PYTHON BEHAVIORAL] forward fits but rollback reservation does not:
        BLOCKED_ROLLBACK_CAPACITY, both at the forward boundary and one byte
        under the total."""
        totals = self._generous_totals()
        forward_edge = (
            totals["floor_bytes"]
            + totals["handoff_reservation_bytes"]
            + totals["forward_total_bytes"]
        )
        self.assertGreater(totals["rollback_total_bytes"], 0)
        for available in (forward_edge, totals["required_total_bytes"] - 1):
            hub = FakeHub()
            prime_upgrade_hub(hub)
            harness = InstallerHarness(hub)
            self.addCleanup(harness.close)
            hub.available_bytes = available
            code, stdout, _ = harness.run(harness.base_argv("--preflight-only"))
            self._stdout = stdout
            self.hub = hub  # assertion helpers inspect the hub under test
            self.assertEqual(code, 2, stdout)
            self.assertEqual(kv_value(stdout, "verdict"), INST.VERDICT_ROLLBACK_CAPACITY)
            self.assert_no_persistent_mutation()
            self.assert_stage_removed_only()

    def test_preflight_allowed_at_exact_required_total(self):
        """[PYTHON BEHAVIORAL] exactly required_total bytes is ALLOWED; the
        aggregation identity required == floor+handoff+forward+rollback holds
        with the exact 1048576 floor."""
        totals = self._generous_totals()
        self.assertEqual(totals["floor_bytes"], 1048576)
        self.assertEqual(
            totals["required_total_bytes"],
            totals["floor_bytes"]
            + totals["handoff_reservation_bytes"]
            + totals["forward_total_bytes"]
            + totals["rollback_total_bytes"],
        )
        code, stdout = self._run_preflight_verdict(totals["required_total_bytes"])
        self.assertEqual(code, 0, stdout)
        self.assertEqual(kv_value(stdout, "verdict"), INST.VERDICT_ALLOWED)
        self.assert_no_persistent_mutation()
        self.assert_stage_removed_only()

    def test_preflight_planner_exit1_ok1_is_capacity(self):
        """[PYTHON BEHAVIORAL] planner exit 1 with ok=1 is classified as
        BLOCKED_CAPACITY and still performs no persistent mutation."""
        self.hub.planner_exit1_ok1 = True
        code, stdout = self._run_preflight_verdict(100_000_000)
        self.assertEqual(code, 2, stdout)
        self.assertEqual(kv_value(stdout, "verdict"), INST.VERDICT_CAPACITY)
        self.assert_no_persistent_mutation()
        self.assert_stage_removed_only()

    def test_handoff_consumption_exact_post_gate(self):
        """[PYTHON BEHAVIORAL] handoff consumption is charged once; the
        post-handoff gate accepts the exact remaining reservation."""
        totals = self._generous_totals()
        self.hub.available_bytes = totals["required_total_bytes"]
        code, stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(kv_value(stdout, "verdict"), INST.VERDICT_ALLOWED)
        handoffs = [e for e in self.hub.events if e[0] == "handoff"]
        self.assertEqual(len(handoffs), 1)
        self.assertEqual(handoffs[0][2], totals["handoff_reservation_bytes"])
        # Initial exact required_total is accepted; handoff consumption is
        # recorded once and subsequent replacement reservations may reclaim
        # more space than the conservative plan charged.
        self.assertGreaterEqual(self.hub.available_bytes, INST.FLOOR_BYTES)

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
        self.assertEqual(engine_calls(self.hub, "--install-file"), [])
        self.assertFalse(any(e[0] == "service" for e in self.hub.events))
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

    def assert_no_service_before(self, index: int):
        service = self.hub.indices(lambda e: e[0] == "service")
        for i in service:
            self.assertGreater(i, index, f"service action at {i} before index {index}")

    def test_full_install_ordering_config_preservation_webui_last(self):
        """[PYTHON BEHAVIORAL] happy path: rollback copies precede the first
        replacement, aggregation identity holds, codex_webui installs last,
        upgrade configuration is omitted/preserved, and no service action
        happens before post-write verification."""
        code, stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 0, stderr or stdout)
        self.assertEqual(kv_value(stdout, "verdict"), INST.VERDICT_ALLOWED)

        totals = {
            key: int(kv_value(stdout, key))
            for key in (
                "floor_bytes",
                "handoff_reservation_bytes",
                "forward_total_bytes",
                "rollback_total_bytes",
                "required_total_bytes",
            )
        }
        self.assertEqual(totals["floor_bytes"], 1048576)
        self.assertEqual(
            totals["required_total_bytes"],
            totals["floor_bytes"]
            + totals["handoff_reservation_bytes"]
            + totals["forward_total_bytes"]
            + totals["rollback_total_bytes"],
        )

        # Rollback preparation precedes the first persistent replacement.
        last_rb_copy = max(self.hub.indices(lambda e: e[0] == "rollback_copy"))
        first_install = min(self.hub.indices(lambda e: e[0] == "install_file"))
        self.assertLess(last_rb_copy, first_install)

        # Retention + handoff ordering, all before the first replacement.
        prunes = self.hub.indices(lambda e: e[0] == "prune")
        handoff = self.hub.first_index(lambda e: e[0] == "handoff")
        self.assertEqual(len(prunes), 2)
        self.assertLess(prunes[0], handoff)
        self.assertLess(handoff, prunes[1])
        self.assertLess(prunes[1], first_install)

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
        # Installed payload bytes actually landed; mode canonical.
        webui_bytes = (INST.PAYLOAD / "bin" / "codex_webui").read_bytes()
        self.assertEqual(md5_bytes(self.hub.fs[self.webui_dest]["data"]),
                         md5_bytes(webui_bytes))
        self.assertEqual(self.hub.fs[self.webui_dest]["mode"], "755")

        # Owned staging tree removed at the end; only candidate dests plus the
        # handoff root were persistently touched.
        rm_rf_targets = [e[1] for e in self.hub.events if e[0] == "rm_rf"]
        self.assertEqual(rm_rf_targets, [self.hub.stage])
        self.assertEqual(self.hub.paths_under_stage(), [])
        for event in self.hub.events:
            if event[0] == "persistent_write":
                self.assertTrue(
                    event[1] in forward or event[1].startswith(INST.HANDOFF_ROOT),
                    f"unrelated persistent path mutated: {event[1]}",
                )
        # base_argv passes --no-apply-cloud-restart, so the happy path must NOT
        # reboot; the cloud restart ordering is covered by its own flag contract.
        self.assertNotIn(("service", "reboot"), self.hub.events)

    def test_true_reverse_install_order_on_rollback(self):
        """[PYTHON BEHAVIORAL] failing the LAST replacement (codex_webui)
        reverse-restores every earlier file to original bytes and observed
        mode, removes created files, and never continues to services."""
        self.hub.fail_install_dest = self.webui_dest
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
        # Rollback restores pass the exact 1 MiB floor minimum.
        for call in engine_calls(self.hub, "--install-file"):
            if "--rollback-restore" in call:
                self.assertGreaterEqual(int(call[4]), 1048576)

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
        self.hub.timeout_install_dest = "/data/codex/init.sh"
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

    def test_post_rename_nonzero_rolls_back(self):
        """[PYTHON BEHAVIORAL] a nonzero C result after rename_completed=1
        is treated as changed and fully rolled back."""
        self.hub.fail_post_write_dest = self.webui_dest
        code, _stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 1, stderr)
        self.assertIn("install failed and was rolled back", stderr)
        self.assertTrue(install_file_dests(self.hub, rollback=True))
        self.assert_originals_restored({"/data/codex/init.sh": "600"})
        self.assertEqual(self.hub.paths_under_stage(), [])

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
        self.hub.fail_install_dest = self.webui_dest
        self.hub.fail_rollback_restore_dest = "/data/codex/bin/codex_hbus"
        code, _stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 1, stderr)
        self.assertIn("rollback incomplete", stderr)
        self.assertIn("Do NOT reboot", stderr)
        # Staging preserved: no rm -rf of the tree, staged files still there.
        self.assertEqual([e[1] for e in self.hub.events if e[0] == "rm_rf"], [])
        self.assertTrue(self.hub.paths_under_stage())
        # Never continues after a failed rollback.
        self.assertFalse(any(e[0] == "service" for e in self.hub.events))
        # The unrestorable file keeps the failed new content; the others were
        # restored (reverse order continued past the failed item).
        restored = install_file_dests(self.hub, rollback=True)
        self.assertNotIn("/data/codex/bin/codex_hbus", restored)
        self.assertTrue(restored)


class PythonInstallerFileStatus(unittest.TestCase):
    """[PYTHON BEHAVIORAL] staged C --file-status powers discovery and
    post-install verification; the fake fails any shell stat/readlink."""

    def setUp(self):
        self.hub = FakeHub()
        self.originals = prime_upgrade_hub(self.hub)
        self.harness = InstallerHarness(self.hub)
        self.addCleanup(self.harness.close)

    def test_probe_uses_file_status_no_shell_stat(self):
        """[PYTHON BEHAVIORAL] destination discovery emits --file-status for
        every candidate and handoff path; no remote shell stat/readlink."""
        code, stdout, stderr = self.harness.run(self.harness.base_argv("--preflight-only"))
        self.assertEqual(code, 0, stderr or stdout)
        calls = engine_calls(self.hub, "--file-status")
        self.assertTrue(calls)
        probed = {call[1] for call in calls}
        # Every handoff path was probed via staged C file-status.
        for event in self.hub.events:
            if event[0] == "cmd":
                self.assertNotIn("stat -c", event[1])
                self.assertNotIn("readlink", event[1])
        for path in INST.HANDOFF_REQUIRED_PATHS:
            self.assertIn(path, probed, f"handoff path {path} not probed via file-status")

    def test_post_install_wrong_mode_rejected(self):
        """[PYTHON BEHAVIORAL] a post-install mode mismatch from file-status
        fails verification and rolls back."""
        # Prime the fake so post-install file-status reports a wrong mode for
        # an always-replaced destination.
        self.hub.file_status_wrong_mode["/data/codex/init.sh"] = "777"
        code, _stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 1, stderr)
        self.assertIn("post-install mode mismatch", stderr)
        self.assertIn("install failed and was rolled back", stderr)

    def test_file_status_refusal_is_fatal_validation(self):
        """[PYTHON BEHAVIORAL] an allowed=0/ok=0 file-status refusal is a
        validation failure with no persistent mutation."""
        self.hub.file_status_refuse["/data/codex/init.sh"] = "destination_not_allowed"
        code, stdout, stderr = self.harness.run(self.harness.base_argv("--preflight-only"))
        self.assertNotEqual(code, 0, stderr or stdout)
        self.assertIn("file-status", stderr)
        writes = [e[1] for e in self.hub.events if e[0] == "persistent_write"]
        self.assertEqual(writes, [])

    def test_absence_and_presence_via_file_status(self):
        """[PYTHON BEHAVIORAL] allowed absence succeeds with exists=0 and
        created paths; presence reports regular with correct md5/mode."""
        # The primed hub already mixes present (upgrade originals) and absent
        # (if-missing manifests) destinations; the happy path covers both.
        code, stdout, stderr = self.harness.run(self.harness.base_argv())
        self.assertEqual(code, 0, stderr or stdout)
        for path in ("/pkg/codexactivity/manifest.json", "/pkg/codexmqtt/manifest.json"):
            self.assertIn(path, self.hub.fs, f"absent {path} must be created")
        self.assertEqual(
            md5_bytes(self.hub.fs["/data/codex/bin/codex_webui"]["data"]),
            md5_bytes((INST.PAYLOAD / "bin" / "codex_webui").read_bytes()),
        )


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

    def test_constants_match_python(self):
        """[PS1 STATIC] capacity floor, stage prefix, verdicts match Python."""
        self.assertIn(f"$FloorBytes = {INST.FLOOR_BYTES}", self.text)
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
        self.assertLess(main.index("Add-RollbackCopies"), main.index("Install-Sequence"))
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
        """[PS1 STATIC] rollback restores in reverse via the staged C engine,
        and an incomplete rollback preserves staging and throws."""
        self.assertIn("--rollback-restore", self.rollback)
        self.assertIn("[Array]::Reverse($pending)", self.rollback)
        self.assertIn("$script:PreserveStage = $true", self.rollback)
        self.assertIn("rollback incomplete", self.rollback)
        self.assertIn("Do NOT reboot", self.rollback)

    def test_engine_modes_and_strict_md5(self):
        """[PS1 STATIC] staged C engine modes and strict BusyBox md5 regex."""
        for flag in ("--storage-status", "--install-plan", "--install-file",
                     "--prune-backups", "--rollback-restore", "--file-status"):
            self.assertIn(flag, self.text)
        self.assertIn("'^[0-9a-f]{32}  .+$'", self.text)

    def test_no_remote_shell_stat_or_readlink(self):
        """[PS1 STATIC] no remote shell stat/readlink may remain anywhere in
        the PowerShell installer (documentation text excepted)."""
        self.assertNotIn("stat -c", self.text)
        self.assertNotIn("$(stat", self.text)
        self.assertNotIn("readlink", self.text)

    def test_file_status_powers_probe_and_verify(self):
        """[PS1 STATIC] destination discovery and post-install verification
        call staged C --file-status, never a remote shell loop."""
        probe = self.text.split("function Invoke-DestinationProbe()", 1)[1].split(
            "function Stop-WithValidation(", 1
        )[0]
        self.assertIn("--file-status", probe)
        self.assertNotIn("for p in", probe)
        verify = self.text.split("function Test-Installed()", 1)[1].split(
            "function Invoke-Rollback(", 1
        )[0]
        self.assertIn("--file-status", verify)
        self.assertNotIn("md5sum", verify)
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
