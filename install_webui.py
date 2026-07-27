#!/usr/bin/env python3
"""
Linux/macOS installer for the Harmony Hub Control post-root web UI.

The hub must already have root SSH access. This installer intentionally uses
plain ssh plus remote "cat > file" uploads, because the minimal Dropbear setup
used by the root tool does not provide scp, sftp, or tftp.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import shlex
import socket
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PAYLOAD = ROOT / "payload"


def step(text: str) -> None:
    print(f"\n== {text} ==")


def info(text: str) -> None:
    print(f"  {text}")


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


def split_remote_dir(path: str) -> str:
    parent = path.rsplit("/", 1)[0]
    return parent if parent else "/"


def local_md5(path: Path) -> str:
    h = hashlib.md5()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


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


class Installer:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.key_path = Path(args.key_path).expanduser().resolve()

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

    def run_remote(
        self,
        command: str,
        input_bytes: bytes | None = None,
        timeout: int = 90,
        quiet: bool = False,
    ) -> str:
        proc = subprocess.run(
            self.ssh_base_args() + [command],
            input=input_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
        stdout = proc.stdout.decode("utf-8", "replace")
        stderr = proc.stderr.decode("utf-8", "replace")
        if proc.returncode != 0:
            raise RuntimeError(
                "ssh failed with exit {code}\ncommand={cmd}\nstdout={out}\nstderr={err}".format(
                    code=proc.returncode,
                    cmd=command,
                    out=stdout,
                    err=stderr,
                )
            )
        if stderr.strip() and not quiet:
            print(stderr.strip())
        return stdout

    def upload_bytes(self, local_path: Path, remote_path: str, mode: str) -> None:
        if not local_path.is_file():
            raise RuntimeError(f"missing local file: {local_path}")
        data = local_path.read_bytes()
        remote_dir = split_remote_dir(remote_path)
        tmp = f"{remote_path}.tmp-handoff-{os.getpid()}-{int(time.time())}"
        command = (
            f"mkdir -p {remote_quote(remote_dir)} && "
            f"cat > {remote_quote(tmp)} && "
            f"mv {remote_quote(tmp)} {remote_quote(remote_path)} && "
            f"chmod {mode} {remote_quote(remote_path)}"
        )
        timeout = max(90, 45 + int(len(data) / 12000))
        self.run_remote(command, data, timeout=timeout, quiet=True)
        info(f"{remote_path} bytes={len(data)} md5={local_md5(local_path)}")

    def upload_text(self, text: str, remote_path: str, mode: str) -> None:
        data = text.encode("utf-8")
        remote_dir = split_remote_dir(remote_path)
        tmp = f"{remote_path}.tmp-handoff-{os.getpid()}-{int(time.time())}"
        command = (
            f"mkdir -p {remote_quote(remote_dir)} && "
            f"cat > {remote_quote(tmp)} && "
            f"mv {remote_quote(tmp)} {remote_quote(remote_path)} && "
            f"chmod {mode} {remote_quote(remote_path)}"
        )
        self.run_remote(command, data, timeout=90, quiet=True)
        if any(token in remote_path.lower() for token in ("pass", "authorized_keys", "config.json")):
            info(f"{remote_path} bytes={len(data)} md5=<hidden>")
        else:
            info(f"{remote_path} bytes={len(data)} md5={hashlib.md5(data).hexdigest()}")

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

    def run(self) -> None:
        step("Checking SSH")
        identity = self.run_remote("id; uname -a", timeout=30)
        print(identity.strip())

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
        info(f"using hub id {hub_id}")

        step("Creating remote backup")
        backup_cmd = r"""
STAMP=$(date +%Y%m%d-%H%M%S)
B=/data/codex-backups/webui-handoff-$STAMP
mkdir -p "$B"
for f in /etc/init.d/rcS.local /opt/luaworks/tasks/connectserver/netservicestarter.lua /usr/sbin/dropbear /usr/sbin/dropbearkey /data/codex/hub_id /data/codex/cloud_blocker.conf /data/codex/offline_egress_guard.sh /data/codexmqtt/config.json /pkg/codexactivity/codexactivity.lua /pkg/codexactivity/manifest.json; do
  if [ -e "$f" ]; then
    n=$(echo "$f" | sed 's#/#_#g')
    cp -p "$f" "$B/$n"
  fi
done
echo "$B"
"""
        backup_dir = self.run_remote(backup_cmd, timeout=30).strip()
        info(f"backup={backup_dir}")

        step("Uploading binaries")
        self.upload_bytes(PAYLOAD / "bin" / "dropbearmulti", "/data/codex/bin/dropbearmulti", "755")
        self.upload_bytes(PAYLOAD / "bin" / "codex_dhcpd", "/data/codex/bin/codex_dhcpd", "755")
        self.upload_bytes(PAYLOAD / "bin" / "codex_hbus", "/data/codex/bin/codex_hbus", "755")
        self.upload_bytes(PAYLOAD / "bin" / "codex_hal_ltcp", "/data/codex/bin/codex_hal_ltcp", "755")
        self.upload_bytes(PAYLOAD / "bin" / "codex_bthid_keyboard", "/data/codex/bin/codex_bthid_keyboard", "755")
        self.upload_bytes(PAYLOAD / "bin" / "codex_portal", "/data/codex/bin/codex_portal", "755")
        self.upload_bytes(PAYLOAD / "bin" / "codex_webui", "/data/codex/bin/codex_webui", "755")
        self.upload_bytes(PAYLOAD / "scripts" / "dropbear", "/usr/sbin/dropbear", "755")
        self.upload_bytes(PAYLOAD / "scripts" / "dropbearkey", "/usr/sbin/dropbearkey", "755")

        step("Uploading runtime files")
        self.upload_bytes(PAYLOAD / "scripts" / "init.sh", "/data/codex/init.sh", "755")
        self.upload_bytes(
            PAYLOAD / "scripts" / "offline_egress_guard.sh",
            "/data/codex/offline_egress_guard.sh",
            "755",
        )
        self.upload_bytes(PAYLOAD / "scripts" / "recovery_ap.sh", "/data/codex/recovery_ap.sh", "755")
        self.upload_bytes(PAYLOAD / "scripts" / "rcS.local", "/etc/init.d/rcS.local", "755")
        if not self.args.skip_cloud_suppression:
            self.upload_bytes(
                PAYLOAD / "scripts" / "netservicestarter.lua",
                "/opt/luaworks/tasks/connectserver/netservicestarter.lua",
                "644",
            )
        else:
            info("skipped netservicestarter.lua cloud-suppression patch")
        self.upload_bytes(
            PAYLOAD / "activity" / "codexactivity.lua",
            "/pkg/codexactivity/codexactivity.lua",
            "644",
        )
        self.upload_bytes(PAYLOAD / "mqtt" / "codexmqtt.lua", "/pkg/codexmqtt/codexmqtt.lua", "644")

        step("Uploading configuration")
        self.upload_text(f"{hub_id}\n", "/data/codex/hub_id", "644")
        self.upload_text("0\n" if self.args.skip_cloud_suppression else "1\n", "/data/codex/cloud_blocker.conf", "644")
        self.upload_text("1\n", "/etc/tdeenable", "644")
        self.upload_text('{"plugin":"codexactivity"}\n', "/pkg/codexactivity/manifest.json", "644")
        self.upload_text('{"plugin":"codexmqtt"}\n', "/pkg/codexmqtt/manifest.json", "644")
        self.upload_text(self.build_mqtt_config(), "/data/codexmqtt/config.json", "600")

        step("Post-install permissions and startup")
        post = (
            "mkdir -p /data/codex/bin /etc/dropbear /home/root/.ssh /data/codexmqtt /pkg/codexactivity /pkg/codexmqtt; "
            "ln -sf dropbearmulti /data/codex/bin/dropbear; "
            "ln -sf dropbearmulti /data/codex/bin/dropbearkey; "
            "chmod 755 /data/codex/bin/dropbearmulti /data/codex/bin/codex_dhcpd /data/codex/bin/codex_hbus "
            "/data/codex/bin/codex_hal_ltcp /data/codex/bin/codex_bthid_keyboard /data/codex/bin/codex_portal "
            "/data/codex/bin/codex_webui /data/codex/init.sh /data/codex/offline_egress_guard.sh "
            "/data/codex/recovery_ap.sh /usr/sbin/dropbear "
            "/usr/sbin/dropbearkey /etc/init.d/rcS.local; "
            "chmod 600 /data/codexmqtt/config.json 2>/dev/null || true; "
            "/bin/busybox sync 2>/dev/null || true"
        )
        self.run_remote(post, timeout=60, quiet=True)

        start = (
            "killall codex_webui 2>/dev/null || true; killall codex_bthid_keyboard 2>/dev/null || true; "
            "/data/codex/offline_egress_guard.sh monitor >> /cache/codex-init.log 2>&1 & "
            "if ! ps | grep '[d]ropbear' >/dev/null 2>&1; then /usr/sbin/dropbear -R -p 22; fi; "
            "mkdir -p /cache/bin; ln -sf /data/codex/bin/codex_bthid_keyboard /cache/bin/bthid_keyboard; "
            "/data/codex/bin/codex_webui 8080 >> /cache/codex-init.log 2>&1 & "
            "/data/codex/bin/codex_bthid_keyboard >> /cache/codex-init.log 2>&1 & "
            "sleep 1; "
            f"/data/codex/bin/codex_hbus {remote_quote(hub_id)} harmony.automation?discover "
            f"{remote_quote('{\"gatewayType\":\"codexactivity\"}')} >> /cache/codex-init.log 2>&1 || true; "
            f"/data/codex/bin/codex_hbus {remote_quote(hub_id)} harmony.automation?discover "
            f"{remote_quote('{\"gatewayType\":\"codexmqtt\"}')} >> /cache/codex-init.log 2>&1 || true; "
            "ps | grep '[c]odex_webui' || true; ps | grep '[c]odex_bthid_keyboard' || true; ps | grep '[d]ropbear' || true"
        )
        print(self.run_remote(start, timeout=90).strip())

        step("Verifying binary checksums")
        expected = {
            "/data/codex/bin/dropbearmulti": local_md5(PAYLOAD / "bin" / "dropbearmulti"),
            "/data/codex/bin/codex_dhcpd": local_md5(PAYLOAD / "bin" / "codex_dhcpd"),
            "/data/codex/bin/codex_hbus": local_md5(PAYLOAD / "bin" / "codex_hbus"),
            "/data/codex/bin/codex_hal_ltcp": local_md5(PAYLOAD / "bin" / "codex_hal_ltcp"),
            "/data/codex/bin/codex_bthid_keyboard": local_md5(PAYLOAD / "bin" / "codex_bthid_keyboard"),
            "/data/codex/bin/codex_portal": local_md5(PAYLOAD / "bin" / "codex_portal"),
            "/data/codex/bin/codex_webui": local_md5(PAYLOAD / "bin" / "codex_webui"),
        }
        paths = " ".join(remote_quote(p) for p in expected)
        verify = self.run_remote(f"md5sum {paths}", timeout=45)
        print(verify.strip())
        for line in verify.splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[1] in expected and expected[parts[1]] != parts[0]:
                raise RuntimeError(
                    f"checksum mismatch for {parts[1]}: expected {expected[parts[1]]} got {parts[0]}"
                )

        if not self.args.skip_cloud_suppression and not self.args.no_apply_cloud_restart:
            step("Applying cloud blocker")
            info("Rebooting the hub so Logitech cloud services restart in blocked mode.")
            self.run_remote("(/bin/sleep 2; /sbin/reboot || reboot) >/dev/null 2>&1 & echo rebooting", timeout=30, quiet=True)
            time.sleep(8)
            wait_for_port(self.args.hub_host, self.args.port, 180, "SSH")
            wait_for_port(self.args.hub_host, 8080, 180, "Web UI")

        step("Done")
        info(f"Web UI: http://{self.args.hub_host}:8080/")
        info("Web UI authentication: disabled")
        info(f"Backup directory on hub: {backup_dir}")
        if not self.args.skip_cloud_suppression:
            info("Cloud blocker: enabled and applied")
        info("If IR commands do not work, update /data/codex/hub_id with the correct hub id and restart codex_webui.")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Install Harmony Hub Control on an already rooted Harmony Hub over SSH.",
    )
    parser.add_argument("--hub-host", "--host", dest="hub_host", default="", help="Harmony Hub IP address or hostname")
    parser.add_argument("--key-path", default="", help="SSH private key for root login; defaults to ~/.ssh/harmony_owner_*")
    parser.add_argument("--port", type=int, default=22, help="SSH port")
    parser.add_argument("--ssh-user", default="root", help="SSH username")
    parser.add_argument("--hub-id", default="", help="Hub ID from the root tool output")
    parser.add_argument("--mqtt-broker", default="", help="MQTT broker host/IP; leave blank to disable MQTT")
    parser.add_argument("--mqtt-port", type=int, default=1883, help="MQTT broker port")
    parser.add_argument("--mqtt-user", default="", help="MQTT username")
    parser.add_argument("--mqtt-password", default="", help="MQTT password")
    parser.add_argument("--mqtt-base-topic", default="harmony/hub", help="MQTT base topic")
    parser.add_argument("--mqtt-discovery-prefix", default="homeassistant", help="Home Assistant MQTT discovery prefix")
    parser.add_argument("--mqtt-client-id", default="harmony-local-mqtt", help="MQTT client ID")
    parser.add_argument("--mqtt-disabled", action="store_true", help="Install with MQTT disabled")
    parser.add_argument("--skip-cloud-suppression", action="store_true", help="Do not replace netservicestarter.lua")
    parser.add_argument("--no-apply-cloud-restart", action="store_true", help="Do not reboot after enabling the Logitech cloud blocker")
    parser.add_argument("--no-prompt", action="store_true", help="Fail instead of asking for missing required values")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
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

        if not args.no_prompt and not args.mqtt_broker and not args.mqtt_disabled:
            args.mqtt_broker = input("MQTT broker host/IP (blank to disable MQTT for now): ").strip()
            if not args.mqtt_broker:
                args.mqtt_disabled = True
        if not args.no_prompt and args.mqtt_broker:
            if not args.mqtt_user:
                args.mqtt_user = input("MQTT username (blank if none): ").strip()
            if not args.mqtt_password:
                args.mqtt_password = getpass.getpass("MQTT password (blank if none): ")

        Installer(args).run()
        return 0
    except KeyboardInterrupt:
        fail("cancelled")
    except Exception as exc:
        fail(str(exc))
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
