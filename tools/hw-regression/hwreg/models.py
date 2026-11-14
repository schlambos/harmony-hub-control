"""Core data models for hardware regression checks, capabilities, and reports."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable


class SafetyTier(str, Enum):
    """Execution tiers ordered from read-only to disruptive."""

    SAFE = "safe"              # Read-only SSH/HTTP + passive traffic probes (default)
    ACTIVE = "active"          # Reversible runtime actions (activity toggle, hold-to-repeat, WoL)
    DISRUPTIVE = "disruptive"  # Network toggle, sleep/wake drills, or opt-in reboot

    @property
    def rank(self) -> int:
        return {
            SafetyTier.SAFE: 0,
            SafetyTier.ACTIVE: 1,
            SafetyTier.DISRUPTIVE: 2,
        }[self]


class EvidenceClass(str, Enum):
    """Required Verified / Reported / Unresolved split for every check outcome."""

    VERIFIED = "Verified"      # Measured directly by the suite over SSH/HTTP/counters
    REPORTED = "Reported"      # Operator-confirmed physical observation (HITL)
    UNRESOLVED = "Unresolved"  # Not run / skipped / awaiting interactive run on this hub


class CheckOutcome(str, Enum):
    """Per-check execution outcome."""

    PASS = "PASS"
    WARN = "WARN"
    FAIL = "FAIL"
    SKIP = "SKIP"


class CheckKind(str, Enum):
    """Whether a check is fully automated or human-in-the-loop."""

    AUTOMATABLE = "automatable"
    HITL = "human-in-the-loop"


@dataclass(frozen=True)
class PairedRemote:
    """One paired RF device reported by hal's rf.info."""

    slot: int
    equad_id: str
    rfid: str
    skin_id: str
    name: str
    role: str  # "screen" | "no-screen" | "keyboard" | "dongle" | "other"


@dataclass(frozen=True)
class PairedAndroidTv:
    """One paired Android/Google TV reported by codex_androidtv."""

    tv_id: str
    name: str
    host: str
    mac: str
    bt_addr: str = ""
    connected: bool = False
    power_on: bool = False
    error: str = ""


@dataclass
class HubCapabilities:
    """Live capability and configuration snapshot discovered off the hub."""

    ssh_reachable: bool = False
    webui_reachable: bool = False
    firmware_version: str = ""
    kernel_release: str = ""
    uptime_seconds: float = 0.0
    hub_id_present: bool = False
    hub_id_raw: str = ""
    melodious_off: bool = False
    tde_flag: str = "0"

    # Provision / resource state
    provisioned: bool = False
    activity_count: int = 0
    device_count: int = 0
    activity_ids: list[str] = field(default_factory=list)

    # Feature conf gates & live hal state
    cloud_blocker_conf: str = ""
    two_screen_conf: str = ""
    multi_remote_conf: str = ""
    hal_bind_mounted: bool = False
    hal_running_md5: str = ""
    hal_gates: str = ""
    hal_remotes_tries: int = 0

    # Paired RF remotes
    rf_pairing_open: bool = False
    rf_info_ok: bool = False
    hub_rfid: str = ""
    paired_remotes: list[PairedRemote] = field(default_factory=list)

    # Network & USB Ethernet
    wifi_if: str = "ath0"
    wifi_ip: str = ""
    wifi_mac: str = ""
    wifi_up: bool = False
    saved_gateway: str = ""
    usb_eth_conf_enabled: bool = False
    usb_eth_state: str = ""
    usb_eth_reason: str = ""
    usb_eth_operational: bool = False
    usb_eth_ifname: str = ""
    usb_eth_ip: str = ""
    usb_eth_mac: str = ""
    usb_eth_driver: str = ""
    usb_eth_device: str = ""
    usb_eth_route_mode: str = ""

    # Optional integrations
    androidtv_running: bool = False
    paired_tvs: list[PairedAndroidTv] = field(default_factory=list)
    bt_keyboard_configured: bool = False
    bt_target_mac: str = ""
    bt_profile: str = ""
    time_restrictions_configured: bool = False
    ha_devices_count: int = 0
    ha_webhook_host: str = ""
    ha_webhook_url: str = ""
    mqtt_configured: bool = False

    # Discovery diagnostics
    notes: list[str] = field(default_factory=list)

    @property
    def two_screen_enabled(self) -> bool:
        return self.two_screen_conf in {"1", "once", "serial", "serial-once"}

    @property
    def multi_remote_enabled(self) -> bool:
        return self.multi_remote_conf == "1"

    @property
    def cloud_blocker_enabled(self) -> bool:
        return self.cloud_blocker_conf == "1"

    @property
    def screen_remote_slots(self) -> list[int]:
        return [r.slot for r in self.paired_remotes if r.equad_id == "16417"]

    @property
    def androidtv_configured(self) -> bool:
        return len(self.paired_tvs) > 0

    @property
    def ha_configured(self) -> bool:
        return self.ha_devices_count > 0


@dataclass
class CheckResult:
    """Recorded outcome and evidence for a single regression check."""

    check_id: str
    title: str
    category: str
    kind: CheckKind
    tier: SafetyTier
    outcome: CheckOutcome
    evidence_class: EvidenceClass
    summary: str
    details: list[str] = field(default_factory=list)
    evidence: dict[str, Any] = field(default_factory=dict)
    operator_note: str = ""
    skip_reason: str = ""
    recovery_hint: str = ""
    duration_ms: int = 0


@dataclass(frozen=True)
class CheckSpec:
    """Declarative metadata + callable for an automatable check."""

    check_id: str
    title: str
    category: str
    tier: SafetyTier
    description: str
    applies_when: Callable[[HubCapabilities], tuple[bool, str]]
    run_fn: Callable[[Any], CheckResult]
    requires_flag: str = ""  # Optional extra per-action opt-in attribute on RunConfig
    recovery_hint: str = ""


@dataclass(frozen=True)
class HitlCheckSpec:
    """Declarative specification for a human-in-the-loop physical check."""

    check_id: str
    title: str
    category: str
    tier: SafetyTier
    applies_when: Callable[[HubCapabilities], tuple[bool, str]]
    safety_notice: str
    setup_steps: list[str]
    operator_prompt: str
    expected_result: str
    recovery_steps: str
    pre_capture: Callable[[Any], dict[str, Any]] | None = None
    post_capture: Callable[[Any, dict[str, Any]], tuple[dict[str, Any], list[str]]] | None = None


@dataclass
class StateActionRecord:
    """Audit trail entry for every state-changing operation performed during a run."""

    timestamp_utc: str
    check_id: str
    action: str
    reverted: bool
    detail: str = ""


@dataclass
class SuiteReport:
    """Complete run report ready for masking and Markdown/JSON serialization."""

    suite_version: str
    started_utc: str
    finished_utc: str
    requested_tier: SafetyTier
    interactive: bool
    verdict: str  # "PASS" | "PASS WITH CAVEATS" | "FAIL"
    verdict_reason: str
    capabilities_summary: dict[str, Any]
    results: list[CheckResult]
    state_actions: list[StateActionRecord] = field(default_factory=list)
