"""Local gitignored hub configuration and safety-tier policy."""

from __future__ import annotations

from dataclasses import dataclass, field
import json
from pathlib import Path
from typing import Any

from .models import SafetyTier


DEFAULT_LOCAL_CONFIG_NAME = "config.local.json"


@dataclass
class HoldProbeTarget:
    """Explicit user-opted-in device/command for hold-to-repeat testing."""

    device_id: str
    command: str


@dataclass
class RunConfig:
    """Contributor-supplied local configuration + per-run CLI safety flags.

    All hub-specific addresses, SSH settings, and optional test targets come
    from the gitignored local file or CLI flags -- never hardcoded in the repo.
    """

    # Connection
    ssh_target: str = ""       # e.g. "my-harmony-hub" (~/.ssh/config alias) or "root@192.0.2.10"
    hub_host: str = ""         # IPv4 or hostname for HTTP (port 8080); auto-detected from ath0 if omitted
    ssh_user: str = "root"
    ssh_port: int = 22
    ssh_key_path: str = ""     # Optional private key path; omitted when ssh_target uses ~/.ssh/config
    webui_port: int = 8080
    webui_username: str = ""   # Optional HTTP Basic auth username
    webui_password: str = ""   # Optional HTTP Basic auth password
    ssh_timeout_sec: int = 20
    http_timeout_sec: int = 15

    # Optional contributor hints (never required; live detection comes first)
    wired_ip_hint: str = ""
    wifi_ssid_redact: list[str] = field(default_factory=list)
    extra_redact_literals: list[str] = field(default_factory=list)
    test_activity_id: str = ""  # Optional activity ID to use when --allow-activity-toggle is set
    test_hold: HoldProbeTarget | None = None
    ha_webhook_url: str = ""

    # Safety tiering & explicit per-run opt-in gates (all False by default)
    tier: SafetyTier = SafetyTier.SAFE
    allow_state_change: bool = False
    allow_activity_toggle: bool = False
    allow_hold_probe: bool = False
    allow_wol: bool = False
    allow_disruptive: bool = False
    allow_reboot: bool = False

    # Execution filters & HITL mode
    interactive: bool = False
    only_checks: list[str] = field(default_factory=list)
    skip_checks: list[str] = field(default_factory=list)

    def effective_ssh_destination(self) -> str:
        """Return the destination passed to the OpenSSH client."""
        if self.ssh_target:
            return self.ssh_target
        if not self.hub_host:
            raise ValueError(
                "No hub target configured: set 'ssh_target' or 'hub_host' in "
                "tools/hw-regression/config.local.json (copy from config.example.json)."
            )
        return f"{self.ssh_user}@{self.hub_host}"

    def check_tier_permitted(self, required_tier: SafetyTier, requires_flag: str = "") -> tuple[bool, str]:
        """Verify both the safety tier and any explicit action flag are enabled."""
        if self.tier.rank < required_tier.rank:
            return (
                False,
                f"requires --tier {required_tier.value} (current tier is {self.tier.value})",
            )
        if required_tier == SafetyTier.ACTIVE and not self.allow_state_change:
            return (
                False,
                "active-tier check requires --allow-state-change opt-in",
            )
        if required_tier == SafetyTier.DISRUPTIVE and not self.allow_disruptive:
            return (
                False,
                "disruptive-tier check requires --allow-disruptive opt-in",
            )
        if requires_flag:
            if not bool(getattr(self, requires_flag, False)):
                cli_flag = "--" + requires_flag.replace("_", "-")
                return (
                    False,
                    f"requires explicit per-run opt-in flag {cli_flag}",
                )
        return True, ""


def load_local_config(path: Path) -> RunConfig:
    """Parse and validate a JSON config file into a RunConfig.

    Note: safety opt-in flags (allow_state_change, allow_reboot, etc.) are
    deliberately NOT enabled from the config file -- the safety model requires
    explicit per-run CLI opt-in flags for any state-changing check.
    """
    if not path.is_file():
        raise FileNotFoundError(
            f"Config file not found: {path}\n"
            f"Copy tools/hw-regression/config.example.json to "
            f"tools/hw-regression/{DEFAULT_LOCAL_CONFIG_NAME} and fill in your hub's SSH/HTTP details."
        )
    raw_text = path.read_text(encoding="utf-8")
    try:
        data: dict[str, Any] = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"Config in {path} must be a JSON object")

    # Reject attempts to persistently bake state-changing opt-ins into config.local.json
    forbidden_persistent_flags = {
        "allow_state_change",
        "allow_activity_toggle",
        "allow_hold_probe",
        "allow_wol",
        "allow_disruptive",
        "allow_reboot",
    }
    enabled_in_file = [k for k in forbidden_persistent_flags if data.get(k) is True]
    if enabled_in_file:
        joined = ", ".join(sorted(enabled_in_file))
        raise ValueError(
            f"Safety opt-in flags ({joined}) cannot be enabled permanently in {path.name}; "
            f"pass them on the command line per run."
        )

    hold_cfg = data.get("test_hold")
    hold_target: HoldProbeTarget | None = None
    if isinstance(hold_cfg, dict):
        dev_id = str(hold_cfg.get("device_id", "")).strip()
        cmd = str(hold_cfg.get("command", "")).strip()
        if dev_id and cmd:
            hold_target = HoldProbeTarget(device_id=dev_id, command=cmd)

    ssh_key_raw = str(data.get("ssh_key_path", "")).strip()
    ssh_key = str(Path(ssh_key_raw).expanduser()) if ssh_key_raw else ""

    cfg = RunConfig(
        ssh_target=str(data.get("ssh_target", "")).strip(),
        hub_host=str(data.get("hub_host", "")).strip(),
        ssh_user=str(data.get("ssh_user", "root")).strip() or "root",
        ssh_port=int(data.get("ssh_port", 22)),
        ssh_key_path=ssh_key,
        webui_port=int(data.get("webui_port", 8080)),
        webui_username=str(data.get("webui_username", "")).strip(),
        webui_password=str(data.get("webui_password", "")),
        ssh_timeout_sec=int(data.get("ssh_timeout_sec", 20)),
        http_timeout_sec=int(data.get("http_timeout_sec", 15)),
        wired_ip_hint=str(data.get("wired_ip_hint", "")).strip(),
        wifi_ssid_redact=[str(x) for x in data.get("wifi_ssid_redact", []) if str(x).strip()],
        extra_redact_literals=[str(x) for x in data.get("extra_redact_literals", []) if str(x).strip()],
        test_activity_id=str(data.get("test_activity_id", "")).strip(),
        test_hold=hold_target,
        ha_webhook_url=str(data.get("ha_webhook_url", "")).strip(),
    )
    cfg.effective_ssh_destination()
    return cfg
