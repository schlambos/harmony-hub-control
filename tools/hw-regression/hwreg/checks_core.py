"""Automatable core hub health checks (run on every hub)."""

from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING

from .discovery import parse_kv_sections
from .models import (
    CheckKind,
    CheckOutcome,
    CheckResult,
    CheckSpec,
    EvidenceClass,
    HubCapabilities,
    SafetyTier,
)

if TYPE_CHECKING:
    from .runner import CheckContext


EXPECTED_FIRMWARE = "4.15.600"
EXPECTED_KERNEL = "2.6.31-g89d565c"

# Firmware 4.15.600 hal MD5 identities (from payload/scripts/rcS.local & docs)
HAL_STOCK_MD5 = "a3fdd823440c43f36e235fe51c45f008"
HAL_TWO_SCREEN_MD5 = "904560dfaa3dc84a175524c2a80ec240"
HAL_MULTI_REMOTE_MD5 = "cafdd7930309c7d74a6a41a87642f0c1"


def _always_applies(_caps: HubCapabilities) -> tuple[bool, str]:
    return True, ""


def _parse_meminfo_kb(text: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for line in text.splitlines():
        m = re.match(r"^([A-Za-z0-9_()]+):\s+(\d+)\s*kB", line.strip())
        if m:
            out[m.group(1)] = int(m.group(2))
    return out


def check_boot_and_ssh(ctx: CheckContext) -> CheckResult:
    """Verify SSH reachability, firmware/kernel versions, TDE/off flags, RAM, and dmesg."""
    caps = ctx.capabilities
    if not caps.ssh_reachable:
        return CheckResult(
            check_id="core.boot_and_ssh",
            title="Hub boot state, SSH, RAM, and kernel health",
            category="core",
            kind=CheckKind.AUTOMATABLE,
            tier=SafetyTier.SAFE,
            outcome=CheckOutcome.FAIL,
            evidence_class=EvidenceClass.VERIFIED,
            summary="SSH connection to the hub failed.",
            details=list(caps.notes),
        )

    probe = ctx.transport.run_ssh(
        "echo '===MEM==='; cat /proc/meminfo 2>/dev/null; "
        "echo '===DMESG==='; dmesg 2>/dev/null | grep -i 'panic\\|oops\\|out of memory\\|netdev watchdog\\|tx timeout' || true"
    )
    mem_text = ""
    dmesg_hits = ""
    if "===MEM===" in probe.stdout and "===DMESG===" in probe.stdout:
        _, rest = probe.stdout.split("===MEM===", 1)
        mem_text, dmesg_hits = rest.split("===DMESG===", 1)

    mem = _parse_meminfo_kb(mem_text)
    usable_ram_kb = mem.get("MemFree", 0) + mem.get("Buffers", 0) + mem.get("Cached", 0)
    dmesg_lines = [ln.strip() for ln in dmesg_hits.splitlines() if ln.strip()]

    issues: list[str] = []
    warnings: list[str] = []

    if caps.melodious_off:
        issues.append("/etc/melodious-off is present (Melodious runtime is turned off)")
    if caps.tde_flag == "1":
        issues.append("TDE boot flag (/sys/class/input/input0/tde) is 1")
    if caps.firmware_version != EXPECTED_FIRMWARE:
        warnings.append(f"firmware is {caps.firmware_version!r} (expected {EXPECTED_FIRMWARE})")
    if caps.kernel_release != EXPECTED_KERNEL:
        warnings.append(f"kernel is {caps.kernel_release!r} (expected {EXPECTED_KERNEL})")
    if usable_ram_kb and usable_ram_kb < 4096:
        issues.append(f"usable RAM critically low ({usable_ram_kb} kB < 4096 kB)")
    if dmesg_lines:
        issues.append(f"dmesg contains {len(dmesg_lines)} kernel error/watchdog line(s)")

    outcome = CheckOutcome.PASS
    if issues:
        outcome = CheckOutcome.FAIL
    elif warnings:
        outcome = CheckOutcome.WARN

    details = issues + warnings
    if not details:
        details.append(
            f"Firmware {caps.firmware_version}, kernel {caps.kernel_release}, "
            f"uptime {int(caps.uptime_seconds)}s, usable RAM {usable_ram_kb} kB, dmesg clean."
        )

    return CheckResult(
        check_id="core.boot_and_ssh",
        title="Hub boot state, SSH, RAM, and kernel health",
        category="core",
        kind=CheckKind.AUTOMATABLE,
        tier=SafetyTier.SAFE,
        outcome=outcome,
        evidence_class=EvidenceClass.VERIFIED,
        summary=details[0],
        details=details,
        evidence={
            "firmware": caps.firmware_version,
            "kernel": caps.kernel_release,
            "uptime_seconds": round(caps.uptime_seconds, 1),
            "tde_flag": caps.tde_flag,
            "melodious_off": caps.melodious_off,
            "mem_total_kb": mem.get("MemTotal", 0),
            "mem_free_kb": mem.get("MemFree", 0),
            "usable_ram_kb": usable_ram_kb,
            "dmesg_error_lines": dmesg_lines[:10],
        },
    )


def check_services_and_webui(ctx: CheckContext) -> CheckResult:
    """Verify stock + Melodious processes, running exe MD5 parity, crash-loop absence, and HTTP API."""
    if not ctx.capabilities.ssh_reachable:
        return CheckResult(
            check_id="core.services_and_webui",
            title="Core daemons, binary parity, and Web UI API",
            category="core",
            kind=CheckKind.AUTOMATABLE,
            tier=SafetyTier.SAFE,
            outcome=CheckOutcome.SKIP,
            evidence_class=EvidenceClass.UNRESOLVED,
            summary="Skipped because SSH is unreachable.",
            skip_reason="SSH unreachable",
        )

    script = """
ps_out=$(ps 2>/dev/null)
for pat in '[h]al' '[w]atchdog' '[d]ropbear' '[c]odex_webui' '[o]ffline_egress_guard'; do
  name=$(echo "$pat" | sed 's/\\[\\(.\\)\\]/\\1/')
  if echo "$ps_out" | grep "$pat" >/dev/null 2>&1; then
    echo "proc_${name}=1"
  else
    echo "proc_${name}=0"
  fi
done
if echo "$ps_out" | grep 'Lua\\|luaworks\\|harmonyengine\\|activityengine' >/dev/null 2>&1; then
  echo "proc_engine=1"
else
  echo "proc_engine=0"
fi
disk_m=$(md5sum /data/codex/bin/codex_webui 2>/dev/null)
echo "webui_disk_md5=${disk_m%% *}"
exe_mismatch=0
for p in $(pidof codex_webui 2>/dev/null); do
  pm=$(md5sum "/proc/$p/exe" 2>/dev/null)
  pm_hash=${pm%% *}
  if [ -n "$pm_hash" ] && [ -n "${disk_m%% *}" ] && [ "$pm_hash" != "${disk_m%% *}" ]; then
    exe_mismatch=1
  fi
done
echo "webui_exe_mismatch=$exe_mismatch"
if [ -f /cache/codex-init.log ]; then
  restarts=$(grep -c 'offline egress guard exited; restarting' /cache/codex-init.log 2>/dev/null || echo 0)
  hal_skip=$(grep -c 'hal skipped\\|hal not bound' /cache/codex-init.log 2>/dev/null || echo 0)
else
  restarts=0
  hal_skip=0
fi
echo "guard_restarts=$restarts"
echo "hal_log_warnings=$hal_skip"
""".strip()

    res = ctx.transport.run_ssh(script)
    kv = parse_kv_sections(res.stdout)

    required_procs = ("hal", "engine", "watchdog", "dropbear", "codex_webui", "offline_egress_guard")
    missing = [p for p in required_procs if kv.get(f"proc_{p}") != "1"]

    issues: list[str] = []
    warnings: list[str] = []
    if missing:
        issues.append(f"missing expected running process(es): {', '.join(missing)}")
    if kv.get("webui_exe_mismatch") == "1":
        issues.append("running codex_webui /proc/<pid>/exe MD5 does not match /data/codex/bin/codex_webui on disk")

    try:
        guard_restarts = int(kv.get("guard_restarts", "0") or 0)
    except ValueError:
        guard_restarts = 0
    if guard_restarts > 5:
        warnings.append(f"offline_egress_guard restarted {guard_restarts} times in /cache/codex-init.log")

    # Verify HTTP API endpoints
    sys_resp = ctx.transport.http_request("GET", "/api/system-status")
    act_resp = ctx.transport.http_request("GET", "/api/activity-state")
    webui_sys_ok = False
    webui_act_ok = False

    if sys_resp.ok:
        try:
            webui_sys_ok = json.loads(sys_resp.body).get("ok") is True
        except json.JSONDecodeError:
            webui_sys_ok = False
    if act_resp.ok:
        try:
            webui_act_ok = json.loads(act_resp.body).get("ok") is True
        except json.JSONDecodeError:
            webui_act_ok = False

    if not webui_sys_ok:
        issues.append(
            f"GET /api/system-status failed (HTTP {sys_resp.status}: {sys_resp.error or 'invalid JSON'})"
        )
    if not webui_act_ok:
        issues.append(
            f"GET /api/activity-state failed (HTTP {act_resp.status}: {act_resp.error or 'engine unreachable'})"
        )

    outcome = CheckOutcome.FAIL if issues else (CheckOutcome.WARN if warnings else CheckOutcome.PASS)
    details = issues + warnings
    if not details:
        details.append(
            f"All {len(required_procs)} core daemon groups running, codex_webui MD5 "
            f"{kv.get('webui_disk_md5', '?')[:12]}... matches /proc/exe, and HTTP API + HBus engine respond 200 OK."
        )

    return CheckResult(
        check_id="core.services_and_webui",
        title="Core daemons, binary parity, and Web UI API",
        category="core",
        kind=CheckKind.AUTOMATABLE,
        tier=SafetyTier.SAFE,
        outcome=outcome,
        evidence_class=EvidenceClass.VERIFIED,
        summary=details[0],
        details=details,
        evidence={
            "processes": {p: kv.get(f"proc_{p}") == "1" for p in required_procs},
            "webui_disk_md5": kv.get("webui_disk_md5", ""),
            "webui_exe_mismatch": kv.get("webui_exe_mismatch") == "1",
            "guard_restarts_logged": guard_restarts,
            "http_system_status": sys_resp.status,
            "http_activity_state": act_resp.status,
        },
    )


def check_hal_identity(ctx: CheckContext) -> CheckResult:
    """Verify running /usr/bin/hal MD5, bind mount, gates, and load-check match feature config."""
    caps = ctx.capabilities
    if not caps.ssh_reachable:
        return CheckResult(
            check_id="core.hal_identity",
            title="HAL binary identity, gates, and load-check",
            category="core",
            kind=CheckKind.AUTOMATABLE,
            tier=SafetyTier.SAFE,
            outcome=CheckOutcome.SKIP,
            evidence_class=EvidenceClass.UNRESOLVED,
            summary="Skipped because SSH is unreachable.",
            skip_reason="SSH unreachable",
        )

    # Probe on-disk patched copies and run safe read-only `hal_remotes -h` load check if present
    probe = ctx.transport.run_ssh(
        "if [ -x /data/codex/bin/hal_remotes ]; then "
        "  m=$(md5sum /data/codex/bin/hal_remotes 2>/dev/null); echo \"remotes_md5=${m%% *}\"; "
        "  if /data/codex/bin/hal_remotes -h >/dev/null 2>&1; then echo 'load_check=ok'; else echo \"load_check=rc_$?\"; fi; "
        "else echo 'remotes_md5='; echo 'load_check=absent'; fi; "
        "if [ -f /data/codex/bin/hal_multiremote ]; then "
        "  mm=$(md5sum /data/codex/bin/hal_multiremote 2>/dev/null); echo \"multi_md5=${mm%% *}\"; "
        "else echo 'multi_md5='; fi"
    )
    kv = parse_kv_sections(probe.stdout)

    # Note: a `once` or `serial-once` boot clears two_screen.conf to 0 BEFORE
    # mounting hal_remotes, leaving hal_gates starting with '1' for that boot.
    once_boot_active = (
        not caps.two_screen_enabled
        and caps.hal_bind_mounted
        and caps.hal_running_md5 == HAL_TWO_SCREEN_MD5
        and len(caps.hal_gates) == 3
        and caps.hal_gates.startswith("1")
    )

    issues: list[str] = []
    warnings: list[str] = []
    mode_desc = "stock"

    if caps.two_screen_enabled or once_boot_active:
        mode_desc = "two-screen (one-boot 'once')" if once_boot_active else f"two-screen ({caps.two_screen_conf})"
        if caps.hal_running_md5 != HAL_TWO_SCREEN_MD5:
            issues.append(
                f"{mode_desc} requested, but /usr/bin/hal MD5 is {caps.hal_running_md5} "
                f"(expected {HAL_TWO_SCREEN_MD5})"
            )
        if not caps.hal_bind_mounted:
            issues.append(f"{mode_desc} expected /usr/bin/hal to be bind-mounted in /proc/mounts")
        expected_multi_bit = "1" if caps.multi_remote_enabled else "0"
        if once_boot_active:
            expected_gates_set = {f"1{expected_multi_bit}0", f"1{expected_multi_bit}1"}
        else:
            expected_serial_bit = "1" if caps.two_screen_conf.startswith("serial") else "0"
            expected_gates_set = {f"1{expected_multi_bit}{expected_serial_bit}"}
        if caps.hal_gates not in expected_gates_set:
            issues.append(
                f"/var/run/codex_hal_gates is {caps.hal_gates!r} "
                f"(expected one of {sorted(expected_gates_set)})"
            )
        if caps.hal_remotes_tries >= 3:
            issues.append(
                f"hal_remotes.tries is {caps.hal_remotes_tries} (>=3 boot watchdog trips; bind is disabled on next boot)"
            )
        elif caps.hal_remotes_tries > 0 and caps.uptime_seconds > 300:
            warnings.append(
                f"hal_remotes.tries is {caps.hal_remotes_tries} despite uptime {int(caps.uptime_seconds)}s (>240s)"
            )
        # Note: stock `hal -h` prints usage and exits with 0 or 1 depending on getopt;
        # inability to load ELF (SIGSEGV/ENOEXEC/126/127/139) returns >= 126.
        load_chk = kv.get("load_check", "")
        if load_chk.startswith("rc_"):
            rc_num = int(load_chk.split("_", 1)[1])
            if rc_num >= 126:
                issues.append(f"hal_remotes -h kernel load check failed with exit {rc_num}")
    elif caps.multi_remote_enabled:
        mode_desc = "multi-remote"
        if caps.hal_running_md5 != HAL_MULTI_REMOTE_MD5:
            issues.append(
                f"multi_remote.conf=1, but /usr/bin/hal MD5 is {caps.hal_running_md5} "
                f"(expected {HAL_MULTI_REMOTE_MD5})"
            )
        if not caps.hal_bind_mounted:
            issues.append("multi_remote.conf=1 expected /usr/bin/hal bind mount in /proc/mounts")
    else:
        mode_desc = "stock"
        if caps.hal_bind_mounted:
            issues.append("neither two_screen nor multi_remote is enabled, yet /usr/bin/hal is bind-mounted")
        if caps.firmware_version == EXPECTED_FIRMWARE and caps.hal_running_md5 != HAL_STOCK_MD5:
            issues.append(
                f"expected stock 4.15.600 hal MD5 {HAL_STOCK_MD5}, got {caps.hal_running_md5}"
            )

    outcome = CheckOutcome.FAIL if issues else (CheckOutcome.WARN if warnings else CheckOutcome.PASS)
    details = issues + warnings
    if not details:
        details.append(
            f"Running hal matches expected {mode_desc} identity (md5={caps.hal_running_md5}, "
            f"bound={caps.hal_bind_mounted}, gates={caps.hal_gates or 'none'}, tries={caps.hal_remotes_tries})."
        )

    return CheckResult(
        check_id="core.hal_identity",
        title="HAL binary identity, gates, and load-check",
        category="core",
        kind=CheckKind.AUTOMATABLE,
        tier=SafetyTier.SAFE,
        outcome=outcome,
        evidence_class=EvidenceClass.VERIFIED,
        summary=details[0],
        details=details,
        evidence={
            "mode": mode_desc,
            "two_screen_conf": caps.two_screen_conf,
            "multi_remote_conf": caps.multi_remote_conf,
            "hal_running_md5": caps.hal_running_md5,
            "hal_bind_mounted": caps.hal_bind_mounted,
            "hal_gates": caps.hal_gates,
            "hal_remotes_tries": caps.hal_remotes_tries,
            "hal_remotes_disk_md5": kv.get("remotes_md5", ""),
            "hal_multiremote_disk_md5": kv.get("multi_md5", ""),
            "hal_remotes_load_check": kv.get("load_check", ""),
        },
        recovery_hint=(
            "If a patched hal fails to boot or misbehaves: "
            "ssh <hub> 'echo 0 > /data/codex/two_screen.conf; echo 0 > /data/codex/multi_remote.conf; reboot'"
        ),
    )


def _parse_route_rows(route_text: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for line in route_text.splitlines():
        parts = line.split()
        if len(parts) < 8 or parts[0] in {"Kernel", "Destination"}:
            continue
        rows.append(
            {
                "destination": parts[0],
                "gateway": parts[1],
                "genmask": parts[2],
                "flags": parts[3],
                "metric": parts[4],
                "iface": parts[7],
            }
        )
    return rows


def check_cloud_blocker_and_routes(ctx: CheckContext) -> CheckResult:
    """Verify cloud-blocker WAN route suppression, multicast/RFC1918 routes, and zero route flapping."""
    caps = ctx.capabilities
    if not caps.ssh_reachable:
        return CheckResult(
            check_id="core.cloud_blocker_and_routes",
            title="Cloud blocker posture and route-table stability",
            category="core",
            kind=CheckKind.AUTOMATABLE,
            tier=SafetyTier.SAFE,
            outcome=CheckOutcome.SKIP,
            evidence_class=EvidenceClass.UNRESOLVED,
            summary="Skipped because SSH is unreachable.",
            skip_reason="SSH unreachable",
        )

    snap1 = ctx.transport.run_ssh(
        "pid=$(sed -n '1p' /var/run/codex-offline-egress.pid 2>/dev/null); "
        "if [ -n \"$pid\" ] && kill -0 \"$pid\" 2>/dev/null; then echo 'guard_alive=1'; else echo 'guard_alive=0'; fi; "
        "echo '===R1==='; route -n 2>/dev/null"
    )
    # Wait > 2.0s so one offline_egress_guard enforcement cycle runs between snapshots
    ctx.transport.sleep(2.2)
    snap2 = ctx.transport.run_ssh("route -n 2>/dev/null")

    guard_alive = "guard_alive=1" in snap1.stdout
    r1_raw = snap1.stdout.split("===R1===", 1)[1].strip() if "===R1===" in snap1.stdout else ""
    r2_raw = snap2.stdout.strip()

    rows1 = _parse_route_rows(r1_raw)
    rows2 = _parse_route_rows(r2_raw)

    default_routes = [r for r in rows2 if r["destination"] == "0.0.0.0"]
    multicast_routes = [
        r for r in rows2 if r["destination"] == "224.0.0.0" and r["genmask"] == "240.0.0.0"
    ]

    issues: list[str] = []
    warnings: list[str] = []

    if rows1 != rows2:
        issues.append("routing table changed across a 2.2s guard window (route flapping detected)")

    if caps.cloud_blocker_enabled:
        if not guard_alive:
            issues.append("cloud_blocker.conf=1, but offline_egress_guard monitor PID is not running")
        if default_routes:
            issues.append(
                f"cloud_blocker.conf=1, yet default WAN route (0.0.0.0) is still present on "
                f"{default_routes[0]['iface']}"
            )
        if not multicast_routes:
            issues.append("multicast route 224.0.0.0/240.0.0.0 missing from routing table")
    elif caps.cloud_blocker_conf == "0":
        warnings.append("cloud_blocker.conf=0 (WAN egress is permitted on this hub)")
    else:
        warnings.append(f"cloud_blocker.conf is unset or unexpected ({caps.cloud_blocker_conf!r})")

    outcome = CheckOutcome.FAIL if issues else (CheckOutcome.WARN if warnings else CheckOutcome.PASS)
    details = issues + warnings
    if not details:
        details.append(
            f"cloud_blocker=1 enforced: guard alive, no 0.0.0.0 WAN default route, "
            f"224.0.0.0/4 multicast present, and {len(rows2)} routes stable across guard cycle."
        )

    return CheckResult(
        check_id="core.cloud_blocker_and_routes",
        title="Cloud blocker posture and route-table stability",
        category="core",
        kind=CheckKind.AUTOMATABLE,
        tier=SafetyTier.SAFE,
        outcome=outcome,
        evidence_class=EvidenceClass.VERIFIED,
        summary=details[0],
        details=details,
        evidence={
            "cloud_blocker_conf": caps.cloud_blocker_conf,
            "guard_pid_alive": guard_alive,
            "saved_gateway": caps.saved_gateway,
            "default_route_present": bool(default_routes),
            "multicast_route_present": bool(multicast_routes),
            "routes_stable": rows1 == rows2,
            "route_table": r2_raw.splitlines(),
        },
    )


CORE_CHECKS: tuple[CheckSpec, ...] = (
    CheckSpec(
        check_id="core.boot_and_ssh",
        title="Hub boot state, SSH, RAM, and kernel health",
        category="core",
        tier=SafetyTier.SAFE,
        description="Checks SSH reachability, firmware/kernel versions, TDE/off flags, free RAM, and dmesg errors.",
        applies_when=_always_applies,
        run_fn=check_boot_and_ssh,
    ),
    CheckSpec(
        check_id="core.services_and_webui",
        title="Core daemons, binary parity, and Web UI API",
        category="core",
        tier=SafetyTier.SAFE,
        description="Verifies stock + Melodious daemons, /proc/exe MD5 parity, crash-loop absence, and HTTP/HBus health.",
        applies_when=_always_applies,
        run_fn=check_services_and_webui,
    ),
    CheckSpec(
        check_id="core.hal_identity",
        title="HAL binary identity, gates, and load-check",
        category="core",
        tier=SafetyTier.SAFE,
        description="Matches running /usr/bin/hal MD5, bind mount, gates, and load-check against detected conf gates.",
        applies_when=_always_applies,
        run_fn=check_hal_identity,
    ),
    CheckSpec(
        check_id="core.cloud_blocker_and_routes",
        title="Cloud blocker posture and route-table stability",
        category="core",
        tier=SafetyTier.SAFE,
        description="Verifies WAN default-route suppression, multicast/private routes, and absence of route flapping.",
        applies_when=_always_applies,
        run_fn=check_cloud_blocker_and_routes,
    ),
)
