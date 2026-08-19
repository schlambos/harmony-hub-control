#!/usr/bin/env python3
"""
Linux/macOS installer for the Harmony Hub Control post-root web UI.

The hub must already have root SSH access. This installer intentionally uses
plain ssh plus remote "cat > file" uploads, because the minimal Dropbear setup
used by the root tool does not provide scp, sftp, or tftp.

Step 4A flow: every candidate file is first uploaded into ONE private 0700
staging tree under /var/volatile/codex-install-*, verified against locally
computed MD5 sums using strict BusyBox md5sum output, and only then installed
through the staged codex_webui C engine (--storage-status / --install-plan /
--install-file / --rollback-restore), which performs capacity-gated,
same-directory atomic replacements with /mnt/data (or /data) as the
authoritative statvfs source. Preflight-only mode reports the complete
inventory, plans, backup generations, handoff estimate, and verdict with zero
persistent mutations and no service actions. Default mode is upgrade and
preserves existing configuration; --clean-install regenerates configuration.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import re
import shlex
import socket
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PAYLOAD = ROOT / "payload"

FLOOR_BYTES = 1048576
STAGE_PREFIX = "/var/volatile/codex-install-"
HANDOFF_ROOT = "/data/codex-backups"
HANDOFF_BUDGET_BYTES = 256 * 1024
WEBUI_DEST = "/data/codex/bin/codex_webui"
DEFAULT_FRAGMENT_BYTES = 4096

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


def parse_kv_lines(text: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or "=" not in line:
            continue
        key, _, value = line.partition("=")
        result[key.strip()] = value.strip()
    return result


def ceil_to_fragment(size: int, fragment: int) -> int:
    if size <= 0:
        return 0
    return ((size + fragment - 1) // fragment) * fragment


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
    ) -> None:
        self.dest = dest
        self.mode = mode
        self.kind = kind  # binary | runtime | plugin | config
        self.local = local
        self.text = text
        self.sensitive = sensitive
        self.condition = condition  # always | if-missing
        self.bytes = 0
        self.md5 = ""
        self.action = "replace"  # replace | create | preserve | skipped
        self.staged_name = ""
        self.forward_reservation = 0
        self.rollback_reservation = 0

    def data(self) -> bytes:
        if self.local is not None:
            return self.local.read_bytes()
        return (self.text or "").encode("utf-8")

    def prepare(self) -> None:
        data = self.data()
        self.bytes = len(data)
        self.md5 = hashlib.md5(data).hexdigest()


MD5_HEX_RE = re.compile(r"^[0-9a-f]{32}$")
FILE_STATUS_TYPES = ("absent", "regular", "symlink", "other")


def parse_file_status(destination: str, parsed: dict[str, str], raw: str) -> dict[str, str]:
    """Validate one staged-C --file-status record into the installer probe shape.

    Strict: operation/ok/destination/allowed/exists/type plus unsigned
    bytes/allocated_bytes/mode_decimal are required; md5 must be 32 lowercase
    hex or none. Fails closed on any unexpected or missing field.
    Returns {path, kind, size, mode(octal string), md5}.
    """
    context = f"file-status for {destination}"
    if parsed.get("operation") != "file-status":
        raise RuntimeError(f"{context} reported unexpected operation:\n{raw.strip()}")
    if parsed.get("ok") != "1":
        raise RuntimeError(f"{context} failed: reason={parsed.get('reason', 'unknown')}")
    if parsed.get("destination") != destination:
        raise RuntimeError(f"{context} echoed wrong destination:\n{raw.strip()}")
    if parsed.get("allowed") != "1":
        raise RuntimeError(f"{context} refused: reason={parsed.get('reason', 'destination_not_allowed')}")
    exists = parsed.get("exists")
    kind = parsed.get("type")
    if exists not in ("0", "1") or kind not in FILE_STATUS_TYPES:
        raise RuntimeError(f"{context} reported invalid exists/type:\n{raw.strip()}")
    try:
        size = int(parsed["bytes"], 10)
        int(parsed["allocated_bytes"], 10)
        int(parsed["mode_decimal"], 10)
    except (KeyError, ValueError):
        raise RuntimeError(f"{context} reported invalid numeric fields:\n{raw.strip()}")
    md5 = parsed.get("md5", "")
    if not (md5 == "none" or MD5_HEX_RE.match(md5)):
        raise RuntimeError(f"{context} reported invalid md5:\n{raw.strip()}")
    if exists == "0":
        if kind != "absent":
            raise RuntimeError(f"{context} exists=0 without type=absent:\n{raw.strip()}")
        return {"path": destination, "kind": "absent", "size": "0", "mode": "", "md5": ""}
    if kind != "regular":
        return {"path": destination, "kind": kind, "size": "0", "mode": "", "md5": ""}
    if not MD5_HEX_RE.match(md5):
        raise RuntimeError(f"{context} regular file without a computed md5:\n{raw.strip()}")
    return {
        "path": destination,
        "kind": "regular",
        "size": str(size),
        "mode": format(int(parsed["mode_decimal"], 10), "o"),
        "md5": md5,
    }


class Installer:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.key_path = Path(args.key_path).expanduser().resolve()
        self.stage = ""
        self.fragment = DEFAULT_FRAGMENT_BYTES
        self.preserve_stage = False
        self.storage_path = ""
        self.candidates: list[Candidate] = []
        self.probe: dict[str, dict[str, str]] = {}
        self.handoff_estimate = 0
        self.handoff_reservation = 0
        self.forward_total = 0
        self.rollback_total = 0
        self.required_total = 0
        self.verdict = VERDICT_VALIDATION
        self.verdict_reasons: list[str] = []
        self.generations = {"handoff": 0, "resource": 0, "settings": 0, "update": 0}
        self.changed: list[dict[str, object]] = []
        self.hub_id = ""
        self.engine = ""

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

    # ------------------------------------------------------------- staging

    def create_stage(self) -> None:
        step("Creating private staging tree")
        cmd = (
            f"D=$(mktemp -d {STAGE_PREFIX}XXXXXX 2>/dev/null) || exit 1; "
            f'chmod 700 "$D" || exit 1; echo "$D"'
        )
        out = self.run_remote(cmd, timeout=30).strip()
        if not out.startswith(STAGE_PREFIX) or ".." in out or out.count("/") != 3:
            raise RuntimeError(f"unsafe staging path from mktemp: {out!r}")
        self.stage = out
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
        for dest, text in (
            ("/etc/tdeenable", "1\n"),
            ("/pkg/codexactivity/manifest.json", '{"plugin":"codexactivity"}\n'),
            ("/pkg/codexmqtt/manifest.json", '{"plugin":"codexmqtt"}\n'),
        ):
            candidates.append(Candidate(dest, "644", "config", text=text, condition="if-missing"))
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

    def staged_webui(self) -> str:
        for cand in self.candidates:
            if cand.dest == WEBUI_DEST:
                return f"{self.stage}/{cand.staged_name}"
        raise RuntimeError("codex_webui candidate missing from inventory")

    def prepare_engine(self) -> None:
        """Make an executable 0700 copy of the staged engine.

        Candidates stay at 0600 per contract; the C engine itself must be
        executable to run the staged maintenance modes.
        """
        if self.engine:
            return
        source = self.staged_webui()
        engine = f"{self.stage}/engine-{source.rsplit('/', 1)[-1]}"
        cmd = (
            f"cp -p {remote_quote(source)} {remote_quote(engine)} && "
            f"chmod 700 {remote_quote(engine)} && md5sum {remote_quote(engine)}"
        )
        out = self.run_remote(cmd, timeout=60, quiet=True)
        match = MD5_LINE_RE.match(out.strip().splitlines()[-1])
        expected = next(c.md5 for c in self.candidates if c.dest == WEBUI_DEST)
        if not match or match.group(1) != expected:
            raise RuntimeError("staged engine copy failed md5 verification")
        self.engine = engine

    def run_c(self, arguments: list[str], timeout: int = 120) -> tuple[int, str]:
        self.prepare_engine()
        command = " ".join([remote_quote(self.engine)] + [remote_quote(a) for a in arguments])
        code, out, err = self.run_remote_rc(command, timeout=timeout)
        return code, f"{out}{err}"

    def probe_destinations(self) -> None:
        step("Probing destination state (staged C --file-status)")
        dests = [c.dest for c in self.candidates]
        dests += [p for p in HANDOFF_REQUIRED_PATHS if p not in dests]
        for dest in dests:
            code, out = self.run_c(["--file-status", dest])
            parsed = parse_kv_lines(out)
            try:
                state = parse_file_status(dest, parsed, out)
            except RuntimeError as exc:
                self.fail_validation(str(exc))
            self.probe[dest] = state
            if code != 0:
                self.fail_validation(f"file-status nonzero exit for {dest} (exit {code})")

    def fail_validation(self, reason: str) -> None:
        self.verdict = VERDICT_VALIDATION
        self.verdict_reasons.append(reason)
        raise RuntimeError(reason)

    def resolve_hub_id(self) -> None:
        hub_id = self.args.hub_id or ""
        if not hub_id:
            existing = self.run_remote("cat /data/codex/hub_id 2>/dev/null || true", timeout=30).strip()
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
        """Decide replace/create/preserve per candidate from probe state."""
        for cand in self.candidates:
            state = self.probe.get(cand.dest, {})
            exists = state.get("kind") == "regular"
            if cand.condition == "if-missing" and exists and not self.args.clean_install:
                cand.action = "preserve"
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

    def storage_status(self, floor: int) -> dict[str, str]:
        code, out = self.run_c(["--storage-status", str(floor)])
        parsed = parse_kv_lines(out)
        if code != 0 and not parsed.get("available_bytes"):
            raise RuntimeError(f"staged codex_webui --storage-status failed (exit {code}):\n{out.strip()}")
        try:
            self.available_bytes = int(parsed["available_bytes"])
        except (KeyError, ValueError):
            raise RuntimeError(f"storage-status did not report available_bytes:\n{out.strip()}")
        self.storage_path = parsed.get("storage_path", "")
        if parsed.get("fragment_bytes", "").isdigit():
            self.fragment = int(parsed["fragment_bytes"])
        return parsed

    def build_plans(self) -> None:
        step("Building capacity plans per destination")
        self.forward_total = 0
        self.rollback_total = 0
        for cand in self.candidates:
            if cand.action not in ("replace", "create"):
                continue
            code, out = self.run_c(
                [
                    "--install-plan",
                    f"{self.stage}/{cand.staged_name}",
                    cand.dest,
                    cand.mode,
                    str(FLOOR_BYTES),
                ]
            )
            parsed = parse_kv_lines(out)
            # C returns exit 1 for a capacity shortfall while still emitting
            # ok=1 with the complete reservation fields. Accept that truthful
            # refusal and classify it as capacity; any other nonzero (ok=0:
            # mode/floor/allowlist/evaluate refusal) is a validation failure.
            if parsed.get("ok") != "1":
                self.fail_validation(f"install-plan failed for {cand.dest} (exit {code}):\n{out.strip()}")
            if code != 0 and parsed.get("sufficient") != "0":
                self.fail_validation(f"install-plan failed for {cand.dest} (exit {code}):\n{out.strip()}")
            try:
                cand.forward_reservation = int(parsed["candidate_reservation_bytes"])
                cand.rollback_reservation = int(parsed["rollback_reservation_bytes"])
            except (KeyError, ValueError):
                self.fail_validation(f"install-plan for {cand.dest} missing reservation keys:\n{out.strip()}")
            if code != 0:
                self.verdict_reasons.append(
                    f"install-plan insufficient for {cand.dest}: "
                    f"available {parsed.get('available_bytes', '?')} < required "
                    f"{parsed.get('required_bytes', '?')} (exit {code}, sufficient=0)"
                )
            self.forward_total += cand.forward_reservation
            self.rollback_total += cand.rollback_reservation
            kv(
                f"destination dest={cand.dest} exists={1 if cand.action == 'replace' else 0} "
                f"action={cand.action} bytes={cand.bytes} mode={cand.mode} "
                f"forward_reservation_bytes={cand.forward_reservation} "
                f"rollback_reservation_bytes={cand.rollback_reservation}"
            )
        if self.verdict_reasons:
            # Truthful classification: any per-candidate shortfall blocks on
            # capacity before decide_verdict's aggregate comparison.
            self.verdict = VERDICT_CAPACITY

    def count_backup_generations(self) -> None:
        cmd = (
            "for d in /data/codex-backups /data/codex/resource-backups /data/codex/update-backups; do "
            '[ -d "$d" ] || continue; for n in "$d"/*; do [ -e "$n" ] && echo "$n"; done; done'
        )
        out = self.run_remote(cmd, timeout=30, quiet=True)
        stamp_re = re.compile(r"^\d{8}-\d{6}$")
        for line in out.splitlines():
            name = line.strip().rsplit("/", 1)[-1]
            if name.startswith("webui-handoff-") and stamp_re.match(name[len("webui-handoff-"):]):
                self.generations["handoff"] += 1
            elif name.startswith("settings_") and re.match(r"^\d{8}_\d{6}$", name[len("settings_"):]):
                self.generations["settings"] += 1
            elif re.match(r"^\d{8}_\d{6}$", name):
                self.generations["resource"] += 1
            elif name.isdigit():
                self.generations["update"] += 1

    def compute_handoff_estimate(self) -> None:
        total = 0
        for path in HANDOFF_REQUIRED_PATHS:
            state = self.probe.get(path, {})
            if state.get("kind") == "regular":
                total += int(state.get("size", "0"))
        self.handoff_estimate = total
        self.handoff_reservation = sum(
            ceil_to_fragment(int(state.get("size", "0")), self.fragment) + self.fragment
            for path, state in self.probe.items()
            if path in HANDOFF_REQUIRED_PATHS and state.get("kind") == "regular"
        )

    def decide_verdict(self) -> None:
        if self.verdict == VERDICT_CONFIG_UNCERTAIN:
            return
        self.required_total = (
            FLOOR_BYTES + self.handoff_reservation + self.forward_total + self.rollback_total
        )
        if self.verdict == VERDICT_CAPACITY:
            # Per-candidate plan shortfall already classified truthfully.
            return
        if self.available_bytes < FLOOR_BYTES + self.handoff_reservation + self.forward_total:
            self.verdict = VERDICT_CAPACITY
            self.verdict_reasons.append(
                f"available {self.available_bytes} < floor+handoff+forward "
                f"{FLOOR_BYTES + self.handoff_reservation + self.forward_total}"
            )
        elif self.available_bytes < self.required_total:
            self.verdict = VERDICT_ROLLBACK_CAPACITY
            self.verdict_reasons.append(
                f"available {self.available_bytes} < total required incl. rollback {self.required_total}"
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
                "Mode: --preflight-only — stages, verifies, plans capacity, "
                "and prints a terminal verdict; performs no persistent writes "
                "and no service actions."
            )
        if self.args.clean_install:
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
        kv(f"candidate_count={len(self.candidates)}")
        info(
            "Candidate destinations and nonsensitive expected MD5 hashes "
            "(sensitive values redacted):"
        )
        for index, cand in enumerate(self.candidates):
            shown = "<hidden>" if cand.sensitive else cand.md5
            kv(
                f"candidate index={index} dest={cand.dest} bytes={cand.bytes} md5={shown} "
                f"mode={cand.mode} kind={cand.kind} action={cand.action}"
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
        kv(f"handoff_reservation_bytes={self.handoff_reservation}")
        kv(f"storage_path={self.storage_path}")
        kv(f"available_bytes={self.available_bytes}")
        kv(f"fragment_bytes={self.fragment}")
        kv(f"floor_bytes={FLOOR_BYTES}")
        kv(f"forward_total_bytes={self.forward_total}")
        kv(f"rollback_total_bytes={self.rollback_total}")
        kv(f"required_total_bytes={self.required_total}")
        info(
            f"Capacity summary: available={self.available_bytes} "
            f"floor={FLOOR_BYTES} forward={self.forward_total} "
            f"rollback={self.rollback_total} required_total={self.required_total} "
            f"storage_path={self.storage_path or '(unset)'}"
        )
        for reason in self.verdict_reasons:
            kv(f"verdict_reason={reason}")
            info(f"verdict_reason: {reason}")
        self.render_verdict()

    def render_verdict(self) -> None:
        # NOTE(InstallerCliUX): human-facing verdict prose is owned by
        # InstallerCliUX; the verdict= key=value line is the stable contract.
        kv(f"verdict={self.verdict}")
        info(f"Terminal verdict: {self.verdict}")
        if self.verdict == VERDICT_ALLOWED:
            info(
                "ALLOWED — capacity, rollback reservation, and validation are "
                "sufficient for the selected mode."
            )
            if self.args.preflight_only:
                info(
                    "Preflight-only complete: volatile staging will be removed; "
                    "no persistent changes or service actions were performed."
                )
            else:
                info(
                    "Persistent install may proceed after this report "
                    "(atomic same-directory replacements via staged C engine)."
                )
        elif self.verdict == VERDICT_CAPACITY:
            info(
                "BLOCKED_CAPACITY — free space is below the floor plus handoff "
                "and forward candidate reservations. No persistent changes."
            )
        elif self.verdict == VERDICT_ROLLBACK_CAPACITY:
            info(
                "BLOCKED_ROLLBACK_CAPACITY — free space covers forward install "
                "reservations but not the additional rollback reservation. "
                "No persistent changes."
            )
        elif self.verdict == VERDICT_CONFIG_UNCERTAIN:
            info(
                "BLOCKED_CONFIGURATION_UNCERTAINTY — required configuration "
                "state is missing or ambiguous for default upgrade; pass "
                "--hub-id or use --clean-install. No persistent changes."
            )
        else:
            info(
                "BLOCKED_VALIDATION_FAILURE — staging, path, hash, or plan "
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
                # Flat leaf under the staging dir: C requires SOURCE
                # /var/volatile/codex-install-<dir>/<leaf>.
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
                        "canonical_mode": cand.mode,
                        "md5": state.get("md5", ""),
                        "rb": rb,
                        "bytes": int(state.get("size", "0")),
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
                        "canonical_mode": cand.mode,
                        "md5": "",
                        "rb": "",
                        "bytes": 0,
                        "was_absent": True,
                        "done": False,
                    }
                )

    def run_retention(self, label: str) -> None:
        step(label)
        code, out = self.run_c(["--prune-backups"], timeout=120)
        for line in out.strip().splitlines():
            info(line)
        if code != 0 and "over_budget=1 errors=0" not in out:
            raise RuntimeError(f"staged --prune-backups failed (exit {code})")

    def create_handoff(self) -> None:
        step("Creating bounded handoff backup")
        # Sizes come from the staged C probe (no remote shell stat). The shell
        # only copies and accumulates installer-supplied sizes; the budget
        # guard remains on the hub side.
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
        if not any(line.startswith("handoff=") for line in out.strip().splitlines()):
            raise RuntimeError("handoff directory rename did not complete")

    def install_sequence(self) -> None:
        step("Installing candidates (staged C atomic replace, codex_webui last)")
        active = [c for c in self.candidates if c.action in ("replace", "create")]
        reservations = [c.forward_reservation + c.rollback_reservation for c in active]
        for position, cand in enumerate(active):
            # The handoff was already written and consumed its reservation on
            # the same authoritative backing; per-file floors after handoff
            # are floor + remaining reservations only.
            floor = FLOOR_BYTES + sum(reservations[position + 1 :])
            code, out = self.run_c(
                [
                    "--install-file",
                    f"{self.stage}/{cand.staged_name}",
                    cand.dest,
                    cand.mode,
                    str(floor),
                ],
                timeout=180,
            )
            parsed = parse_kv_lines(out)
            if parsed.get("rename_completed") == "1":
                # The destination was replaced even though C reported a
                # nonzero outcome (post-write measurement/floor failure):
                # record it as changed so rollback restores the original.
                for item in self.changed:
                    if item["dest"] == cand.dest:
                        item["done"] = True
            # Fail closed: nonzero exit, missing/unrecognized result, or a
            # completed write whose post-write outcome is bad all abort.
            result = parsed.get("result")
            if code != 0 or result not in ("installed", "no-op"):
                raise InstallFailure(f"install-file failed for {cand.dest} (exit {code}):\n{out.strip()}")
            if result == "installed":
                if parsed.get("errors") != "0":
                    raise InstallFailure(
                        f"install-file post-write outcome failed for {cand.dest}:\n{out.strip()}"
                    )
                if "available_bytes_after" in parsed:
                    try:
                        after = int(parsed["available_bytes_after"])
                    except ValueError:
                        after = -1
                    if after < 0 or after < FLOOR_BYTES or parsed.get("floor_met_after") != "1":
                        raise InstallFailure(
                            f"install-file post-write floor failed for {cand.dest}:\n{out.strip()}"
                        )
            for item in self.changed:
                if item["dest"] == cand.dest:
                    item["done"] = True
            info(f"installed dest={cand.dest} mode={cand.mode} bytes={cand.bytes}")


    def verify_installed(self) -> None:
        step("Verifying installed bytes, hashes, modes, and storage (staged C --file-status)")
        active = [c for c in self.candidates if c.action in ("replace", "create")]
        for cand in active:
            code, out = self.run_c(["--file-status", cand.dest])
            parsed = parse_kv_lines(out)
            state = parse_file_status(cand.dest, parsed, out)
            if code != 0 or state["kind"] != "regular":
                raise RuntimeError(
                    f"post-install verification failed for {cand.dest}: "
                    f"kind={state['kind']} exit={code}"
                )
            if int(state["size"], 10) != cand.bytes:
                raise RuntimeError(
                    f"post-install byte mismatch for {cand.dest}: "
                    f"expected {cand.bytes} got {state['size']}"
                )
            if state["md5"] != cand.md5:
                raise RuntimeError(f"post-install checksum mismatch for {cand.dest}")
            try:
                got_mode = int(state["mode"], 8)
            except ValueError:
                got_mode = -1
            if got_mode != int(cand.mode, 8):
                raise RuntimeError(
                    f"post-install mode mismatch for {cand.dest}: "
                    f"expected {cand.mode} got {state['mode']}"
                )
        self.storage_status(FLOOR_BYTES)
        info("installed candidates verified; storage rechecked")

    def rollback_changes(self, trigger: str) -> None:
        step("Rolling back changed paths")
        info(f"trigger: {trigger}")
        done_items = [item for item in self.changed if item["done"]]
        pending = list(reversed(done_items))
        restore_items = [item for item in pending if not item["was_absent"]]
        reservations = [
            ceil_to_fragment(int(item["bytes"]), self.fragment) + self.fragment
            for item in restore_items
        ]
        incomplete = False
        for item in pending:
            dest = str(item["dest"])
            if item["was_absent"]:
                code, out, _err = self.run_remote_rc(f"rm -f {remote_quote(dest)}", timeout=30)
                if code != 0:
                    incomplete = True
                    info(f"ROLLBACK FAILED remove new path {dest}: {out.strip()}")
                    continue
                code, out, _err = self.run_remote_rc(f'test ! -e {remote_quote(dest)}', timeout=30)
                if code != 0:
                    incomplete = True
                    info(f"ROLLBACK FAILED path still present after remove: {dest}")
                    continue
                info(f"removed new path {dest} (original absence recorded)")
                continue
            index = restore_items.index(item)
            # Caller floor = 1048576 plus all later reverse restorations.
            floor = FLOOR_BYTES + sum(reservations[index + 1 :])
            # C requires MODE to equal the destination's canonical allowlist
            # mode; the observed pre-install mode is restored afterwards.
            code, out = self.run_c(
                [
                    "--install-file",
                    str(item["rb"]),
                    dest,
                    str(item["canonical_mode"]),
                    str(floor),
                    "--rollback-restore",
                ],
                timeout=180,
            )
            if code != 0:
                incomplete = True
                info(f"ROLLBACK FAILED restore {dest}: {out.strip()}")
                continue
            if str(item["mode"]) != str(item["canonical_mode"]):
                chmod_code, chmod_out, _chmod_err = self.run_remote_rc(
                    f"chmod {remote_quote(str(item['mode']))} {remote_quote(dest)}", timeout=30
                )
                if chmod_code != 0:
                    incomplete = True
                    info(f"ROLLBACK FAILED mode restore {dest}: {chmod_out.strip()}")
                    continue
            info(f"restored {dest} mode={item['mode']}")
        # verify rollback
        for item in done_items:
            dest = str(item["dest"])
            if item["was_absent"]:
                code, _out, _err = self.run_remote_rc(f'test ! -e {remote_quote(dest)}', timeout=30)
                if code != 0:
                    incomplete = True
                    info(f"ROLLBACK VERIFY FAILED path still present: {dest}")
                continue
            code, out, _err = self.run_remote_rc(f"md5sum {remote_quote(dest)}", timeout=60)
            match = MD5_LINE_RE.match(out.strip()) if code == 0 else None
            if not match or match.group(1) != item["md5"]:
                incomplete = True
                info(f"ROLLBACK VERIFY FAILED md5 for {dest}")
        if incomplete:
            self.preserve_stage = True
            raise RuntimeError(
                f"rollback incomplete; staged tree preserved for manual recovery at {self.stage}. "
                "Do NOT reboot; inspect the staged rollback copies and restore manually."
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
            "mkdir -p /data/codex/bin /etc/dropbear /home/root/.ssh /data/codexmqtt /pkg/codexactivity /pkg/codexmqtt; "
            "ln -sf dropbearmulti /data/codex/bin/dropbear; "
            "ln -sf dropbearmulti /data/codex/bin/dropbearkey; "
            f"chmod 755 {bin_chmod} /data/codex/init.sh /data/codex/offline_egress_guard.sh "
            "/data/codex/recovery_ap.sh /usr/sbin/dropbear "
            "/usr/sbin/dropbearkey /etc/init.d/rcS.local; "
            "chmod 600 /data/codexmqtt/config.json 2>/dev/null || true; "
            "/bin/busybox sync 2>/dev/null || true"
        )
        self.run_remote(post, timeout=60, quiet=True)

    def start_services(self) -> None:
        start = (
            "killall codex_webui 2>/dev/null || true; killall codex_bthid_keyboard 2>/dev/null || true; "
            "/data/codex/offline_egress_guard.sh monitor >> /cache/codex-init.log 2>&1 & "
            "if ! ps | grep '[d]ropbear' >/dev/null 2>&1; then /usr/sbin/dropbear -R -p 22; fi; "
            "mkdir -p /cache/bin; ln -sf /data/codex/bin/codex_bthid_keyboard /cache/bin/bthid_keyboard; "
            "/data/codex/bin/codex_webui 8080 >> /cache/codex-init.log 2>&1 & "
            "/data/codex/bin/codex_bthid_keyboard >> /cache/codex-init.log 2>&1 & "
            "sleep 1; "
            f"/data/codex/bin/codex_hbus {remote_quote(self.hub_id)} harmony.automation?discover "
            f"{remote_quote('{\"gatewayType\":\"codexactivity\"}')} >> /cache/codex-init.log 2>&1 || true; "
            f"/data/codex/bin/codex_hbus {remote_quote(self.hub_id)} harmony.automation?discover "
            f"{remote_quote('{\"gatewayType\":\"codexmqtt\"}')} >> /cache/codex-init.log 2>&1 || true; "
            "ps | grep '[c]odex_webui' || true; ps | grep '[c]odex_bthid_keyboard' || true; ps | grep '[d]ropbear' || true"
        )
        print(self.run_remote(start, timeout=90).strip())

    def ensure_parent_dirs(self) -> None:
        dirs = sorted({c.dest.rsplit("/", 1)[0] for c in self.candidates if c.action in ("replace", "create")})
        cmd = "mkdir -p " + " ".join(remote_quote(d) for d in dirs)
        self.run_remote(cmd, timeout=30, quiet=True)

    def run(self) -> int:
        step("Checking SSH")
        identity = self.run_remote("id; uname -a", timeout=30)
        print(identity.strip())

        step("Resolving hub id")
        self.resolve_hub_id()

        step("Building candidate inventory")
        self.build_inventory()
        info(f"candidates={len(self.candidates)} (codex_webui installed last)")

        self.create_stage()
        self.upload_candidates()
        self.verify_stage_md5()

        self.probe_destinations()
        self.apply_upgrade_gates()

        step("Querying authoritative storage status")
        status = self.storage_status(FLOOR_BYTES)
        for key in sorted(status):
            kv(f"storage {key}={status[key]}")

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

        try:
            self.stage_rollback_copies()
            self.run_retention("Step 3 retention (before handoff)")
            self.create_handoff()
            self.run_retention("Step 3 retention (after handoff)")
            # The handoff reservation was consumed by the handoff itself on
            # the same authoritative backing; recheck against the remaining
            # floor + forward + rollback only (never re-charge the handoff).
            post_handoff_required = FLOOR_BYTES + self.forward_total + self.rollback_total
            step("Rechecking storage after retention and handoff")
            self.storage_status(max(FLOOR_BYTES, post_handoff_required))
            if self.available_bytes < post_handoff_required:
                raise InstallFailure(
                    f"storage recheck failed: available {self.available_bytes} "
                    f"< required {post_handoff_required}"
                )
            self.ensure_parent_dirs()
            self.install_sequence()
            self.verify_installed()
        except InstallFailure as exc:
            try:
                self.rollback_changes(str(exc))
            except RuntimeError as rb_exc:
                fail(str(rb_exc))
            fail(f"install failed and was rolled back: {exc}")
        except RuntimeError as exc:
            if self.changed and any(item["done"] for item in self.changed):
                try:
                    self.rollback_changes(str(exc))
                except RuntimeError as rb_exc:
                    fail(str(rb_exc))
                fail(f"install failed and was rolled back: {exc}")
            self.cleanup_stage()
            raise
        except Exception as exc:
            # Transport-level failures (subprocess.TimeoutExpired, OSError,
            # anything else mid-install) must reach the same rollback
            # decision, never escape past it into blanket staging cleanup.
            if self.changed and any(item["done"] for item in self.changed):
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

        self.cleanup_stage()

        if not self.args.skip_cloud_suppression and not self.args.no_apply_cloud_restart:
            step("Applying cloud blocker")
            info("Rebooting the hub so Logitech cloud services restart in blocked mode.")
            self.run_remote("(/bin/sleep 2; /sbin/reboot || reboot) >/dev/null 2>&1 & echo rebooting", timeout=30, quiet=True)
            time.sleep(8)
            wait_for_port(self.args.hub_host, self.args.port, 180, "SSH")
            wait_for_port(self.args.hub_host, 8080, 180, "Web UI")

        step("Done")
        if self.args.clean_install:
            info("Install finished in explicit clean-install mode (configuration regenerated).")
        else:
            info("Install finished in default upgrade mode (existing configuration preserved where applicable).")
        info("Persistent paths were mutated only after preflight ALLOWED; staging was volatile until then.")
        info(f"Web UI: http://{self.args.hub_host}:8080/")
        info("Web UI authentication: disabled")
        if not self.args.skip_cloud_suppression:
            info("Cloud blocker: enabled and applied")
        info("If IR commands do not work, update /data/codex/hub_id with the correct hub id and restart codex_webui.")
        return 0


class InstallFailure(RuntimeError):
    """Failure after persistent changes began; requires rollback."""


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Install or upgrade Harmony Hub Control on an already rooted "
            "Harmony Hub over SSH. Default mode is upgrade and preserves "
            "existing configuration. Use --clean-install for an explicit clean "
            "install that regenerates configuration. Use --preflight-only to "
            "stage candidates in private volatile storage, verify MD5 hashes, "
            "plan capacity, and print a terminal verdict with zero persistent "
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
    parser.add_argument("--no-apply-cloud-restart", action="store_true", help="Do not reboot after enabling the Logitech cloud blocker")
    parser.add_argument("--no-prompt", action="store_true", help="Fail instead of asking for missing required values")
    parser.add_argument(
        "--preflight-only",
        action="store_true",
        help=(
            "Volatile preflight only: upload candidates into a private "
            "/var/volatile/codex-install-* tree, verify nonsensitive MD5 "
            "hashes, run C storage-status/install-plan checks, and print "
            "inventory plus a terminal verdict (ALLOWED or BLOCKED_*). "
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
    return parser.parse_args(argv)


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
