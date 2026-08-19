#!/usr/bin/env python3
"""Container entrypoint for the Harmony Hub Control Unraid package."""

from __future__ import annotations

import argparse
import fcntl
import http.client
import importlib.util
import ipaddress
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping, Sequence


TRUE_VALUES = frozenset({"1", "true", "yes", "on"})
FALSE_VALUES = frozenset({"0", "false", "no", "off"})
HOSTNAME_RE = re.compile(
    r"(?=^.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*"
    r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.?"
)
SSH_USER_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_.-]{0,31}")


class ConfigError(RuntimeError):
    """Raised for an invalid container setting."""


def log(message: str) -> None:
    print(f"[harmony-container] {message}", flush=True)


def env_bool(env: Mapping[str, str], name: str, default: bool) -> bool:
    raw = env.get(name, str(default)).strip().lower()
    if raw in TRUE_VALUES:
        return True
    if raw in FALSE_VALUES:
        return False
    accepted = ", ".join(sorted(TRUE_VALUES | FALSE_VALUES))
    raise ConfigError(f"{name} must be one of: {accepted}")


def env_port(env: Mapping[str, str], name: str, default: int) -> int:
    raw = env.get(name, str(default)).strip()
    try:
        port = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer") from exc
    if not 1 <= port <= 65535:
        raise ConfigError(f"{name} must be between 1 and 65535")
    return port


def normalize_host(raw: str) -> str:
    host = raw.strip()
    if not host:
        raise ConfigError("HUB_HOST is required")
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        pass
    if not HOSTNAME_RE.fullmatch(host):
        raise ConfigError(
            "HUB_HOST must be an IP address or hostname without a scheme, port, path, or whitespace"
        )
    return host.rstrip(".").lower()


def read_secret_file(path: Path, setting_name: str) -> str:
    try:
        value = path.read_text(encoding="utf-8").rstrip("\r\n")
    except OSError as exc:
        raise ConfigError(f"{setting_name} file is not readable: {path}") from exc
    if "\x00" in value:
        raise ConfigError(f"{setting_name} file contains a NUL byte")
    return value


@dataclass(frozen=True)
class Settings:
    hub_host: str
    hub_id: str
    ssh_port: int
    ssh_user: str
    hub_web_port: int
    ssh_key_path: Path
    mqtt_enabled: bool
    mqtt_broker: str
    mqtt_port: int
    mqtt_user: str
    mqtt_password: str
    mqtt_base_topic: str
    mqtt_discovery_prefix: str
    mqtt_client_id: str
    cloud_blocker_enabled: bool
    reboot_hub_after_install: bool
    install_mode: str
    force_install: bool
    app_root: Path
    config_root: Path
    runtime_root: Path

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        values = os.environ if env is None else env
        hub_host = normalize_host(values.get("HUB_HOST", ""))
        hub_id = values.get("HUB_ID", "").strip()
        if hub_id and (not hub_id.isdigit() or len(hub_id) < 4):
            raise ConfigError("HUB_ID must be the exact numeric ID (at least four digits)")

        ssh_user = values.get("HUB_SSH_USER", "root").strip()
        if not SSH_USER_RE.fullmatch(ssh_user):
            raise ConfigError("HUB_SSH_USER contains unsupported characters")

        install_mode = values.get("INSTALL_MODE", "once").strip().lower()
        if install_mode not in {"once", "always", "never"}:
            raise ConfigError("INSTALL_MODE must be once, always, or never")

        mqtt_enabled = env_bool(values, "MQTT_ENABLED", False)
        mqtt_broker = values.get("MQTT_BROKER", "").strip()
        if mqtt_enabled and not mqtt_broker:
            raise ConfigError("MQTT_BROKER is required when MQTT_ENABLED=true")

        mqtt_password = ""
        if mqtt_enabled:
            password_file = values.get("MQTT_PASSWORD_FILE", "").strip()
            mqtt_password = (
                read_secret_file(Path(password_file), "MQTT_PASSWORD")
                if password_file
                else values.get("MQTT_PASSWORD", "")
            )

        return cls(
            hub_host=hub_host,
            hub_id=hub_id,
            ssh_port=env_port(values, "HUB_SSH_PORT", 22),
            ssh_user=ssh_user,
            hub_web_port=env_port(values, "HUB_WEB_PORT", 8080),
            ssh_key_path=Path(values.get("SSH_KEY_PATH", "/keys/harmony_owner_key")),
            mqtt_enabled=mqtt_enabled,
            mqtt_broker=mqtt_broker,
            mqtt_port=env_port(values, "MQTT_PORT", 1883),
            mqtt_user=values.get("MQTT_USER", ""),
            mqtt_password=mqtt_password,
            mqtt_base_topic=values.get("MQTT_BASE_TOPIC", "harmony/hub"),
            mqtt_discovery_prefix=values.get("MQTT_DISCOVERY_PREFIX", "homeassistant"),
            mqtt_client_id=values.get("MQTT_CLIENT_ID", "harmony-local-mqtt"),
            cloud_blocker_enabled=env_bool(values, "CLOUD_BLOCKER_ENABLED", True),
            reboot_hub_after_install=env_bool(values, "REBOOT_HUB_AFTER_INSTALL", True),
            install_mode=install_mode,
            force_install=env_bool(values, "FORCE_INSTALL", False),
            app_root=Path(values.get("HARMONY_APP_ROOT", "/app")),
            config_root=Path(values.get("HARMONY_CONFIG_ROOT", "/config")),
            runtime_root=Path(values.get("HARMONY_RUNTIME_ROOT", "/run/harmony")),
        )

    @property
    def state_dir(self) -> Path:
        return self.config_root / "state"

    @property
    def marker_path(self) -> Path:
        return self.state_dir / "install.json"

    @property
    def lock_path(self) -> Path:
        return self.state_dir / "install.lock"


def ensure_runtime_dirs(settings: Settings) -> None:
    settings.state_dir.mkdir(parents=True, exist_ok=True)
    settings.runtime_root.mkdir(parents=True, exist_ok=True)
    ssh_dir = settings.config_root / ".ssh"
    ssh_dir.mkdir(parents=True, exist_ok=True)
    ssh_dir.chmod(0o700)


def prepare_private_key(settings: Settings) -> Path:
    source = settings.ssh_key_path
    if not source.is_file():
        raise ConfigError(
            f"SSH private key not found: {source}. Mount the key directory at /keys "
            "or update SSH_KEY_PATH."
        )
    target = settings.runtime_root / "deploy_key"
    try:
        key_bytes = source.read_bytes()
    except OSError as exc:
        raise ConfigError(f"SSH private key is not readable: {source}") from exc
    if not key_bytes.strip():
        raise ConfigError(f"SSH private key is empty: {source}")
    target.write_bytes(key_bytes)
    target.chmod(0o600)
    return target


def installer_arguments(settings: Settings, runtime_key: Path) -> list[str]:
    args = [
        "--hub-host",
        settings.hub_host,
        "--key-path",
        str(runtime_key),
        "--port",
        str(settings.ssh_port),
        "--ssh-user",
        settings.ssh_user,
    ]
    if settings.hub_id:
        args.extend(["--hub-id", settings.hub_id])

    if settings.mqtt_enabled:
        args.extend(
            [
                "--mqtt-broker",
                settings.mqtt_broker,
                "--mqtt-port",
                str(settings.mqtt_port),
                "--mqtt-user",
                settings.mqtt_user,
                "--mqtt-password",
                settings.mqtt_password,
                "--mqtt-base-topic",
                settings.mqtt_base_topic,
                "--mqtt-discovery-prefix",
                settings.mqtt_discovery_prefix,
                "--mqtt-client-id",
                settings.mqtt_client_id,
            ]
        )
    else:
        args.append("--mqtt-disabled")

    if not settings.cloud_blocker_enabled:
        args.append("--skip-cloud-suppression")
    elif not settings.reboot_hub_after_install:
        args.append("--no-apply-cloud-restart")

    args.append("--no-prompt")
    return args


def source_revision(settings: Settings) -> str:
    try:
        return (settings.app_root / "UPSTREAM_REVISION").read_text(encoding="utf-8").strip()
    except OSError:
        return "unknown"


def load_marker(settings: Settings) -> dict[str, object] | None:
    try:
        value = json.loads(settings.marker_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def install_needed(settings: Settings) -> tuple[bool, str]:
    if settings.install_mode == "never":
        return False, "INSTALL_MODE=never"
    if settings.force_install:
        return True, "FORCE_INSTALL=true"
    if settings.install_mode == "always":
        return True, "INSTALL_MODE=always"

    marker = load_marker(settings)
    if marker is None:
        return True, "no successful-install marker exists"
    if marker.get("hub_host") != settings.hub_host:
        return True, "HUB_HOST changed"
    if settings.hub_id and marker.get("hub_id") != settings.hub_id:
        return True, "HUB_ID changed"
    return False, "matching successful-install marker exists"


def write_marker(settings: Settings) -> None:
    marker = {
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "hub_host": settings.hub_host,
        "hub_id": settings.hub_id,
        "source_revision": source_revision(settings),
        "mqtt_enabled": settings.mqtt_enabled,
        "cloud_blocker_enabled": settings.cloud_blocker_enabled,
        "reboot_hub_after_install": settings.reboot_hub_after_install,
    }
    settings.state_dir.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=".install-", suffix=".json", dir=settings.state_dir)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(marker, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(settings.marker_path)
    finally:
        temporary.unlink(missing_ok=True)


def load_upstream_installer(settings: Settings):
    installer_path = settings.app_root / "install_webui.py"
    if not installer_path.is_file():
        raise ConfigError(f"upstream installer is missing: {installer_path}")
    spec = importlib.util.spec_from_file_location("harmony_upstream_installer", installer_path)
    if spec is None or spec.loader is None:
        raise ConfigError(f"could not load upstream installer: {installer_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def perform_install(settings: Settings) -> None:
    ensure_runtime_dirs(settings)
    with settings.lock_path.open("a+", encoding="utf-8") as lock_handle:
        try:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ConfigError("another Harmony Hub installation is already running") from exc

        runtime_key = prepare_private_key(settings)
        args = installer_arguments(settings, runtime_key)
        log(
            "installing upstream revision "
            f"{source_revision(settings)[:12]} to {settings.ssh_user}@{settings.hub_host}:"
            f"{settings.ssh_port}"
        )
        log(
            "MQTT is "
            f"{'enabled' if settings.mqtt_enabled else 'disabled'}; cloud blocker is "
            f"{'enabled' if settings.cloud_blocker_enabled else 'disabled'}; "
            f"reboot after install is {settings.reboot_hub_after_install}"
        )

        try:
            installer = load_upstream_installer(settings)
            result = installer.main(args)
        except SystemExit as exc:
            result = exc.code if isinstance(exc.code, int) else 1
        finally:
            runtime_key.unlink(missing_ok=True)
        if result != 0:
            raise RuntimeError(f"upstream installer exited with status {result}")
        write_marker(settings)
        log(f"successful-install marker written to {settings.marker_path}")


def nginx_upstream_host(host: str) -> str:
    return f"[{host}]" if ":" in host else host


def nginx_config(settings: Settings) -> str:
    upstream = f"http://{nginx_upstream_host(settings.hub_host)}:{settings.hub_web_port}"
    return f"""\
worker_processes auto;
pid /run/harmony/nginx.pid;
error_log /dev/stderr notice;

events {{
    worker_connections 256;
}}

http {{
    access_log /dev/stdout;
    server_tokens off;
    client_body_temp_path /var/lib/nginx/tmp/client_body;
    proxy_temp_path /var/lib/nginx/tmp/proxy;

    server {{
        listen 8080;
        server_name _;
        client_max_body_size 32m;

        location = /container-health {{
            default_type application/json;
            return 200 '{{"ok":true,"service":"harmony-hub-control"}}\\n';
        }}

        location / {{
            proxy_pass {upstream};
            proxy_http_version 1.1;
            proxy_set_header Host $proxy_host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header Authorization $http_authorization;
            proxy_set_header Connection "";
            proxy_buffering off;
            proxy_request_buffering off;
            proxy_connect_timeout 5s;
            proxy_send_timeout 300s;
            proxy_read_timeout 300s;
        }}
    }}
}}
"""


def write_nginx_config(settings: Settings) -> Path:
    ensure_runtime_dirs(settings)
    config_path = settings.runtime_root / "nginx.conf"
    config_path.write_text(nginx_config(settings), encoding="utf-8")
    return config_path


def start_proxy(settings: Settings) -> None:
    config_path = write_nginx_config(settings)
    log(
        f"starting web proxy on container port 8080 -> "
        f"http://{nginx_upstream_host(settings.hub_host)}:{settings.hub_web_port}"
    )
    subprocess.run(["nginx", "-t", "-c", str(config_path)], check=True)
    os.execvp("nginx", ["nginx", "-c", str(config_path), "-g", "daemon off;"])


def probe_hub(settings: Settings, timeout: float = 3.0) -> tuple[bool, str]:
    connection = http.client.HTTPConnection(settings.hub_host, settings.hub_web_port, timeout=timeout)
    try:
        connection.request("GET", "/")
        response = connection.getresponse()
        response.read(1024)
        if 100 <= response.status < 500:
            return True, f"HTTP {response.status}"
        return False, f"HTTP {response.status}"
    except OSError as exc:
        return False, str(exc)
    finally:
        connection.close()


def print_status(settings: Settings) -> None:
    marker = load_marker(settings)
    print(json.dumps(marker or {"installed": False}, indent=2, sort_keys=True))
    reachable, detail = probe_hub(settings)
    print(
        json.dumps(
            {
                "hub_url": f"http://{nginx_upstream_host(settings.hub_host)}:{settings.hub_web_port}/",
                "reachable": reachable,
                "probe": detail,
            },
            indent=2,
            sort_keys=True,
        )
    )


def parse_cli(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Install Harmony Hub Control once, then proxy its hub-hosted web UI."
    )
    parser.add_argument(
        "command",
        nargs="?",
        choices=("serve", "install", "proxy", "status"),
        default="serve",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_cli(sys.argv[1:] if argv is None else argv)
    try:
        settings = Settings.from_env()
        ensure_runtime_dirs(settings)

        if args.command == "status":
            print_status(settings)
            return 0
        if args.command == "install":
            perform_install(settings)
            return 0
        if args.command == "proxy":
            start_proxy(settings)
            return 0

        needed, reason = install_needed(settings)
        if needed:
            if settings.install_mode == "always" or settings.force_install:
                log(f"warning: startup will reinstall the hub because {reason}")
            else:
                log(f"first-run installation required: {reason}")
            perform_install(settings)
        else:
            log(f"skipping hub installation: {reason}")
            marker = load_marker(settings)
            if marker and marker.get("source_revision") != source_revision(settings):
                log(
                    "container payload revision differs from the installed marker; "
                    "use the hub updater or run 'harmony-container install' to deploy it"
                )
        start_proxy(settings)
        return 0
    except ConfigError as exc:
        print(f"CONFIG ERROR: {exc}", file=sys.stderr, flush=True)
        return 2
    except subprocess.CalledProcessError as exc:
        print(f"ERROR: command failed with status {exc.returncode}: {exc.cmd}", file=sys.stderr, flush=True)
        return exc.returncode or 1
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
