"""SSH, HTTP, and local-network transport layer with BusyBox and safety guards."""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
import socket as _socket
from typing import Any
from pathlib import Path
import platform
import re
import subprocess
import time
import urllib.error
import urllib.request

from .config import RunConfig
from .models import StateActionRecord


# Stock Harmony Hub BusyBox lacks these applets / flags (see HANDOFF.md).
# Catching them in the transport guarantees no check works only on full GNU hosts.
UNSUPPORTED_HUB_SHELL_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"(?<![A-Za-z0-9_/-])head(?![A-Za-z0-9_/-])"), "BusyBox on the hub has no 'head' applet (use sed)"),
    (re.compile(r"(?<![A-Za-z0-9_/-])tail(?![A-Za-z0-9_/-])"), "BusyBox on the hub has no 'tail' applet (use sed)"),
    (re.compile(r"(?<![A-Za-z0-9_/-])sort(?![A-Za-z0-9_/-])"), "BusyBox on the hub has no 'sort' applet"),
    (re.compile(r"(?<![A-Za-z0-9_/-])find(?![A-Za-z0-9_/-])"), "BusyBox on the hub has no 'find' applet"),
    (re.compile(r"(?<![A-Za-z0-9_/-])df(?![A-Za-z0-9_/-])"), "BusyBox on the hub has no 'df' applet"),
    (re.compile(r"(?<![A-Za-z0-9_/-])stat(?![A-Za-z0-9_/-])"), "BusyBox on the hub has no 'stat' applet"),
    (re.compile(r"(?<![A-Za-z0-9_/-])mktemp(?![A-Za-z0-9_/-])"), "BusyBox on the hub has no 'mktemp' applet"),
    (re.compile(r"(?<![A-Za-z0-9_/-])sha256sum(?![A-Za-z0-9_/-])"), "BusyBox on the hub has no 'sha256sum' applet (use md5sum)"),
    (re.compile(r"\bgrep\s+-[A-Za-z]*E"), "BusyBox grep on the hub has no -E flag"),
    (re.compile(r"\bping\s+-[A-Za-z]"), "BusyBox ping on the hub takes no flags (use 'ping <host>')"),
)

# Hard safety prohibitions: never allow irreversible / destructive commands.
FORBIDDEN_DESTRUCTIVE_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"sys\.factoryreset"), "factory reset is strictly forbidden by the regression suite"),
    (re.compile(r"flash_erase|mtd\s+write|dd\s+.*mtdblock"), "raw flash writes are strictly forbidden"),
    (re.compile(r"rm\s+-[rf]*\s+/data/resources"), "deleting /data/resources is strictly forbidden"),
    (re.compile(r"rm\s+-[rf]*\s+/data/codex-backups"), "pruning /data/codex-backups is strictly forbidden"),
    (re.compile(r"/data/codexmqtt/config\.json"), "reading or modifying /data/codexmqtt/config.json contents is forbidden (test -s only)"),
)


def audit_remote_command(command: str, *, allow_mqtt_test_s: bool = True) -> None:
    """Validate that a hub shell command obeys BusyBox limits and safety rules."""
    for pattern, reason in UNSUPPORTED_HUB_SHELL_PATTERNS:
        if pattern.search(command):
            raise ValueError(f"Unsupported hub shell construct in command ({reason}): {command!r}")

    for pattern, reason in FORBIDDEN_DESTRUCTIVE_PATTERNS:
        if pattern.pattern == r"/data/codexmqtt/config\.json" and allow_mqtt_test_s:
            # Allow strictly `[ -s /data/codexmqtt/config.json ]` existence probe, never cat/grep/sed
            stripped = re.sub(r"\[\s+-[fs]\s+/data/codexmqtt/config\.json\s+\]", "", command)
            if not pattern.search(stripped):
                continue
        if pattern.search(command):
            raise PermissionError(f"Safety violation ({reason}): {command!r}")


def remote_quote(value: str) -> str:
    """POSIX-safe single-quote escaping for remote sh arguments."""
    return "'" + value.replace("'", "'\"'\"'") + "'"


@dataclass(frozen=True)
class SshResult:
    returncode: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.returncode == 0


@dataclass(frozen=True)
class HttpResult:
    status: int
    body: str
    headers: dict[str, str] = field(default_factory=dict)
    error: str = ""

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300 and not self.error


class HubTransport:
    """Live SSH + HTTP + host-network transport to a user's Harmony Hub."""

    def __init__(self, config: RunConfig) -> None:
        self.config = config
        self._resolved_http_host: str = config.hub_host
        self.state_actions: list[StateActionRecord] = []
        self._ssh_alias_cfg: dict[str, Any] | None = None

    @property
    def http_host(self) -> str:
        return self._resolved_http_host or self.config.hub_host

    def set_discovered_http_host(self, host: str) -> None:
        if host and not self._resolved_http_host:
            self._resolved_http_host = host

    def record_state_action(self, check_id: str, action: str, reverted: bool, detail: str = "") -> None:
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.state_actions.append(
            StateActionRecord(
                timestamp_utc=ts,
                check_id=check_id,
                action=action,
                reverted=reverted,
                detail=detail,
            )
        )

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)

    def _resolve_ssh_alias(self) -> dict[str, Any]:
        """Resolve ~/.ssh/config settings for config.ssh_target once via `ssh -G`."""
        if self._ssh_alias_cfg is not None:
            return self._ssh_alias_cfg
        parsed: dict[str, Any] = {"hostname": "", "user": "", "port": 22, "identityfiles": []}
        target = self.config.ssh_target.strip()
        if not target:
            self._ssh_alias_cfg = parsed
            return parsed
        try:
            proc = subprocess.run(
                ["ssh", "-G", target],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=4,
                check=False,
            )
        except OSError:
            self._ssh_alias_cfg = parsed
            return parsed
        if proc.returncode != 0:
            self._ssh_alias_cfg = parsed
            return parsed
        for ln in proc.stdout.decode("utf-8", "replace").splitlines():
            parts = ln.strip().split(None, 1)
            if len(parts) != 2:
                continue
            key, val = parts[0].lower(), parts[1].strip()
            if key == "hostname":
                parsed["hostname"] = val
            elif key == "user":
                parsed["user"] = val
            elif key == "port":
                try:
                    parsed["port"] = int(val)
                except ValueError:
                    pass
            elif key == "identityfile":
                exp = Path(val).expanduser()
                if exp.is_file():
                    parsed["identityfiles"].append(str(exp))
        self._ssh_alias_cfg = parsed
        return parsed

    def ssh_base_args(self, host_override: str = "") -> list[str]:
        args = [
            "ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            f"ConnectTimeout={min(self.config.ssh_timeout_sec, 12)}",
            "-o",
            "StrictHostKeyChecking=accept-new",
        ]
        if host_override:
            alias_cfg = self._resolve_ssh_alias() if (self.config.ssh_target and not self.config.ssh_key_path) else {}
            alias_host = str(alias_cfg.get("hostname", "")).strip()
            if self.config.ssh_target and alias_host and host_override == alias_host:
                if self.config.ssh_port and self.config.ssh_port != 22:
                    args.extend(["-p", str(self.config.ssh_port)])
                args.append(self.config.effective_ssh_destination())
                return args

            eff_port = self.config.ssh_port if (self.config.ssh_port and self.config.ssh_port != 22) else int(alias_cfg.get("port") or 22)
            if eff_port != 22:
                args.extend(["-p", str(eff_port)])
            if self.config.ssh_key_path:
                args.extend(["-i", self.config.ssh_key_path, "-o", "IdentitiesOnly=yes"])
            elif alias_cfg.get("identityfiles"):
                for id_path in alias_cfg["identityfiles"]:
                    args.extend(["-i", id_path])
                args.extend(["-o", "IdentitiesOnly=yes"])
            eff_user = str(alias_cfg.get("user") or self.config.ssh_user or "root")
            args.append(f"{eff_user}@{host_override}")
            return args

        if self.config.ssh_port and self.config.ssh_port != 22:
            args.extend(["-p", str(self.config.ssh_port)])
        if self.config.ssh_key_path:
            args.extend(["-i", self.config.ssh_key_path, "-o", "IdentitiesOnly=yes"])
        args.append(self.config.effective_ssh_destination())
        return args

    def run_ssh(
        self,
        command: str,
        timeout: int | None = None,
        *,
        host_override: str = "",
    ) -> SshResult:
        audit_remote_command(command)
        eff_timeout = timeout or self.config.ssh_timeout_sec
        try:
            proc = subprocess.run(
                self.ssh_base_args(host_override=host_override) + [command],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=eff_timeout,
                check=False,
            )
            return SshResult(
                returncode=proc.returncode,
                stdout=proc.stdout.decode("utf-8", "replace"),
                stderr=proc.stderr.decode("utf-8", "replace"),
            )
        except subprocess.TimeoutExpired:
            return SshResult(returncode=124, stdout="", stderr=f"SSH command timed out after {eff_timeout}s")
        except OSError as exc:
            return SshResult(returncode=127, stdout="", stderr=str(exc))

    def http_request(
        self,
        method: str,
        path: str,
        *,
        body: bytes | None = None,
        content_type: str = "",
        host_override: str = "",
        timeout: int | None = None,
    ) -> HttpResult:
        host = host_override or self.http_host
        if not host:
            return HttpResult(status=0, body="", error="No HTTP host configured or discovered")
        if not path.startswith("/"):
            path = "/" + path
        url = f"http://{host}:{self.config.webui_port}{path}"

        headers: dict[str, str] = {
            "Accept": "application/json, text/html;q=0.9, */*;q=0.8",
            "Connection": "close",
        }
        if self.config.webui_username or self.config.webui_password:
            raw_creds = f"{self.config.webui_username}:{self.config.webui_password}".encode("utf-8")
            headers["Authorization"] = "Basic " + base64.b64encode(raw_creds).decode("ascii")

        if body is not None:
            # codex_webui requires an exact Content-Length (no chunked transfer encoding).
            headers["Content-Length"] = str(len(body))
            if content_type:
                headers["Content-Type"] = content_type
            if content_type == "application/json":
                headers["Origin"] = f"http://{host}:{self.config.webui_port}"

        req = urllib.request.Request(url=url, data=body, headers=headers, method=method.upper())
        eff_timeout = timeout or self.config.http_timeout_sec
        try:
            with urllib.request.urlopen(req, timeout=eff_timeout) as resp:
                resp_bytes = resp.read()
                resp_headers = {k.lower(): v for k, v in resp.headers.items()}
                return HttpResult(
                    status=resp.status,
                    body=resp_bytes.decode("utf-8", "replace"),
                    headers=resp_headers,
                )
        except urllib.error.HTTPError as exc:
            err_body = ""
            try:
                err_body = exc.read().decode("utf-8", "replace")
            except Exception:
                pass
            return HttpResult(status=exc.code, body=err_body, error=f"HTTP {exc.code}")
        except Exception as exc:
            return HttpResult(status=0, body="", error=str(exc))

    def mqtt_roundtrip(
        self,
        *,
        broker_host: str,
        broker_port: int,
        base_topic: str,
        discovery_prefix: str,
        username: str = "",
        password: str = "",
        activity_payload: str = "",
        client_id_suffix: str = "hwreg",
        timeout_sec: float = 12.0,
    ) -> dict[str, Any]:
        """Subscribe to discovery/state/result, publish one activity select, collect replies.

        Returns a plain dict (never raises for broker-side failures) so checks
        can report evidence uniformly. Credentials are used only for CONNECT
        and are never included in the result.
        """
        result: dict[str, Any] = {
            "connected": False,
            "discovery_topics": [],
            "state_payloads": [],
            "result_payloads": [],
            "published_topic": "",
            "error": "",
        }
        base = base_topic.rstrip("/")
        state_topic = f"{base}/state"
        result_topic = f"{base}/result"
        discovery_topic = f"{discovery_prefix}/select/+/config"
        sock = None
        try:
            sock = _socket.create_connection((broker_host, broker_port), timeout=timeout_sec)
            sock.settimeout(2.0)
            client_id = f"harmony-hwreg-{client_id_suffix}"
            sock.sendall(mqtt_build_connect(client_id, username=username, password=password))
            ptype, body = mqtt_read_packet(sock)
            if ptype != 2 or len(body) < 2 or body[1] != 0:
                result["error"] = f"broker refused CONNECT (packet={ptype})"
                return result
            result["connected"] = True
            sock.sendall(mqtt_build_subscribe(1, [state_topic, result_topic, discovery_topic]))
            if activity_payload:
                result["published_topic"] = f"{base}/activity/set"
            deadline = time.monotonic() + timeout_sec
            published = False
            while time.monotonic() < deadline:
                try:
                    ptype, body = mqtt_read_packet(sock)
                except _socket.timeout:
                    if not published and activity_payload:
                        sock.sendall(mqtt_build_publish(f"{base}/activity/set", activity_payload))
                        published = True
                    continue
                if ptype == 9:  # SUBACK: now safe to publish the activity select
                    if not published and activity_payload:
                        sock.sendall(mqtt_build_publish(f"{base}/activity/set", activity_payload))
                        published = True
                    continue
                if ptype != 3:
                    continue
                topic, payload = mqtt_parse_publish(body)
                if topic == state_topic:
                    result["state_payloads"].append(payload)
                elif topic == result_topic:
                    result["result_payloads"].append(payload)
                elif topic.startswith(f"{discovery_prefix}/"):
                    result["discovery_topics"].append(topic)
                if published and result["state_payloads"] and result["result_payloads"]:
                    break
        except Exception as exc:  # broker unreachable / protocol error: reported, not raised
            result["error"] = str(exc)
        finally:
            if sock is not None:
                try:
                    sock.sendall(bytes([0xE0, 0x00]))
                except Exception:
                    pass
                try:
                    sock.close()
                except Exception:
                    pass
        return result

    def host_ping(self, target_ip: str, count: int = 3, timeout_sec: int = 2) -> tuple[bool, str]:
        """Run a short ICMP ping from the contributor's host to target_ip."""
        sys_name = platform.system().lower()
        if sys_name == "windows":
            cmd = ["ping", "-n", str(count), "-w", str(timeout_sec * 1000), target_ip]
        elif sys_name == "darwin":
            cmd = ["ping", "-n", "-c", str(count), "-W", str(timeout_sec * 1000), target_ip]
        else:
            cmd = ["ping", "-n", "-c", str(count), "-W", str(timeout_sec), target_ip]
        try:
            proc = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=max(10, count * (timeout_sec + 2)),
                check=False,
            )
            out = (proc.stdout.decode("utf-8", "replace") + "\n" + proc.stderr.decode("utf-8", "replace")).strip()
            return proc.returncode == 0, out
        except Exception as exc:
            return False, str(exc)

    def host_arp_mac(self, target_ip: str) -> str:
        """Best-effort L2 MAC lookup for target_ip in the host's neighbor table."""
        mac_re = re.compile(r"\b(?:[0-9A-Fa-f]{1,2}:){5}[0-9A-Fa-f]{1,2}\b")
        for cmd in (["arp", "-n", target_ip], ["ip", "neigh", "show", target_ip]):
            try:
                proc = subprocess.run(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=4,
                    check=False,
                )
            except OSError:
                continue
            text = proc.stdout.decode("utf-8", "replace")
            m = mac_re.search(text)
            if m:
                octets = [part.zfill(2).lower() for part in m.group(0).split(":")]
                norm = ":".join(octets)
                if norm not in {"00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff"}:
                    return norm
        return ""


# ---------------------------------------------------------------------------
# Minimal MQTT 3.1.1 client (stdlib socket only) for mqtt.broker_roundtrip.
# Supports CONNECT (optional user/pass), SUBSCRIBE QoS 0, PUBLISH QoS 0, and
# collecting PUBLISH packets for a bounded time. No TLS (LAN brokers only).
# ---------------------------------------------------------------------------

def _mqtt_utf(text: str) -> bytes:
    raw = text.encode("utf-8")
    return len(raw).to_bytes(2, "big") + raw


def mqtt_encode_remaining_length(length: int) -> bytes:
    out = bytearray()
    while True:
        digit = length % 128
        length //= 128
        if length:
            digit |= 0x80
        out.append(digit)
        if not length:
            return bytes(out)


def mqtt_build_connect(client_id: str, *, username: str = "", password: str = "", keepalive_sec: int = 15) -> bytes:
    flags = 0x02  # clean session
    payload = _mqtt_utf(client_id)
    if username:
        flags |= 0x80
        payload += _mqtt_utf(username)
        if password:
            flags |= 0x40
            payload += _mqtt_utf(password)
    variable = _mqtt_utf("MQTT") + bytes([4, flags]) + keepalive_sec.to_bytes(2, "big")
    body = variable + payload
    return b"\x10" + mqtt_encode_remaining_length(len(body)) + body


def mqtt_build_subscribe(packet_id: int, topics: list[str]) -> bytes:
    body = packet_id.to_bytes(2, "big") + b"".join(_mqtt_utf(t) + b"\x00" for t in topics)
    return b"\x82" + mqtt_encode_remaining_length(len(body)) + body


def mqtt_build_publish(topic: str, payload: str) -> bytes:
    body = _mqtt_utf(topic) + payload.encode("utf-8")
    return b"\x30" + mqtt_encode_remaining_length(len(body)) + body


def _mqtt_read_exact(sock: Any, count: int) -> bytes:
    data = b""
    while len(data) < count:
        chunk = sock.recv(count - len(data))
        if not chunk:
            raise ConnectionError("MQTT broker closed the connection")
        data += chunk
    return data


def mqtt_read_packet(sock: Any) -> tuple[int, bytes]:
    """Read one MQTT control packet; returns (packet_type, body_bytes)."""
    first = _mqtt_read_exact(sock, 1)[0]
    multiplier = 1
    remaining = 0
    while True:
        digit = _mqtt_read_exact(sock, 1)[0]
        remaining += (digit & 0x7F) * multiplier
        multiplier *= 128
        if not digit & 0x80:
            break
    body = _mqtt_read_exact(sock, remaining) if remaining else b""
    return first >> 4, body


def mqtt_parse_publish(body: bytes) -> tuple[str, str]:
    if len(body) < 2:
        return "", ""
    topic_len = int.from_bytes(body[:2], "big")
    topic = body[2 : 2 + topic_len].decode("utf-8", "replace")
    payload = body[2 + topic_len :].decode("utf-8", "replace")
    return topic, payload
