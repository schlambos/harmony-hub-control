#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Matthew Gibbons (Melodious — LICENSE section 2)
"""Structured NDJSON bridge over tools/hub-root for the Melodious Root Wizard.

Provides:
  - Read-only discovery and classification probes over USB HID and LAN:
    `probe`, `classify`, `usb-enumerate`, `usb-preflight`, `usb-sysinfo`,
    `usb-provision-info`, `usb-discovery-info`, `lan-provision-info`,
    `usb-wifi-scan`, `usb-wifi-status`
  - Explicitly confirmed (`--confirm-action <action>`), non-interactive
    pre-root and root actions:
    `usb-wifi-connect` (credentials over stdin JSON only, never argv),
    `usb-factory-reset` (body "1" only, never "all", plus 0xFF/0x00 reboot),
    `usb-flash-firmware` (.hfw2 skin-match check + bootUpdaterHandoff support),
    `usb-tde-enable` (/tde/enable length-mode "1" + 598 fallback),
    `usb-provision-local` (mode 3, strictly positive integer remoteId),
    `usb-seed-automation` (AutomationConfig via proxy.resource?put),
    `lan-root-xmpp`, `usb-root`, and experimental `post-root`
    (gated behind `--allow-unproven-post`).

Every line written to stdout is a single JSON object (NDJSON).
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import pathlib
import re
import sys
import time
from typing import Any, Callable

if sys.version_info < (3, 10):
    raise SystemExit("Python 3.10 or newer is required.")

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import harmony_usb_bridge as usb  # noqa: E402
import harmony_xmpp_root_shell as lan  # noqa: E402

READONLY_ACTIONS = (
    "probe",
    "classify",
    "usb-enumerate",
    "usb-preflight",
    "usb-sysinfo",
    "usb-provision-info",
    "usb-discovery-info",
    "lan-provision-info",
    "usb-wifi-scan",
    "usb-wifi-status",
)

MUTATING_ACTIONS = (
    "usb-wifi-connect",
    "usb-factory-reset",
    "usb-flash-firmware",
    "usb-tde-enable",
    "usb-provision-local",
    "usb-seed-automation",
    "lan-root-xmpp",
    "usb-root",
    "post-root",
)

ALLOWED_ACTIONS = READONLY_ACTIONS + MUTATING_ACTIONS

REQUIRED_FIRMWARE = "4.15.600"
FACTORY_RESET_BODY = b"1"  # Never "all" (which chip-erases CC2544 RF pairings)
DEFAULT_DISCOVERY_URI = "https://svcs.myharmony.com/Discovery/Discovery.svc"
DEFAULT_DISCOVERY_URI_CF = "https://cf-svcs.myharmony.com/Discovery/Discovery.svc"

_MAC_RE = re.compile(r"\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b")
_IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")


def mask_mac(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    return "XX:XX:XX:XX:XX:XX"


def mask_ip(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    return "<ip-redacted>"


def mask_id(value: Any, label: str = "id") -> str:
    text = str(value if value is not None else "").strip()
    if not text:
        return ""
    return f"<{label}-redacted>"


def scrub_secrets(text: str, secrets: list[str] | None = None) -> str:
    if not text or not secrets:
        return text
    out = text
    for secret in secrets:
        if secret:
            out = out.replace(secret, "<redacted>")
    return out


def mask_free_text(text: str, mask: bool = True, secrets: list[str] | None = None) -> str:
    out = scrub_secrets(text, secrets)
    if not mask or not out:
        return out
    out = _MAC_RE.sub("XX:XX:XX:XX:XX:XX", out)
    out = _IPV4_RE.sub("<ip-redacted>", out)
    return out


def parse_skin_decimal(skin_value: Any) -> int | None:
    if skin_value is None or isinstance(skin_value, bool):
        return None
    if isinstance(skin_value, int):
        return skin_value
    text = str(skin_value).strip().lower()
    if not text:
        return None
    try:
        if text.startswith("0x"):
            return int(text, 16)
        if any(c in "abcdef" for c in text):
            return int(text, 16)
        return int(text, 10)
    except ValueError:
        return None


def validate_positive_remote_id(value: Any, *, allow_numeric_str: bool = False) -> int:
    """Validate that remoteId is a strictly positive integer (> 0), never a string unless explicitly parsed from CLI."""
    if isinstance(value, bool) or value is None:
        raise ValueError("remoteId must be a positive integer (> 0)")
    if isinstance(value, int):
        if value <= 0:
            raise ValueError("remoteId must be a strictly positive integer (> 0)")
        return value
    if allow_numeric_str and isinstance(value, str):
        stripped = value.strip()
        if re.fullmatch(r"[1-9]\d*", stripped):
            parsed = int(stripped, 10)
            if parsed > 0:
                return parsed
        raise ValueError("remoteId must be a strictly positive integer (> 0)")
    raise ValueError("remoteId must be a JSON number (positive integer), never a string")


def is_usb_wedge_error(message: str) -> bool:
    low = (message or "").lower()
    return any(
        needle in low
        for needle in (
            "ltcp hbus error frame",
            "write returned no bytes",
            "timed out without matching response",
            "did not return the expected raw ltcp response",
            "returned no data before eof",
        )
    )


def extract_hbus_data_dict(raw_reply: dict[str, Any]) -> dict[str, Any]:
    """Normalize the payload of an hbus reply across dict, body, or key=value forms."""
    data: Any = raw_reply.get("data") if isinstance(raw_reply, dict) else None
    if isinstance(data, dict) and "body" in data and any(k in data for k in ("cmd", "errorCode", "errorcode")):
        data = data.get("body")
    if isinstance(data, str):
        stripped = data.strip()
        if stripped.startswith("{"):
            try:
                data = json.loads(stripped)
            except json.JSONDecodeError:
                pass
        if isinstance(data, str):
            kv: dict[str, Any] = {}
            sep = ";" if ";" in stripped else ":"
            for part in stripped.split(sep):
                if "=" in part:
                    k, v = part.split("=", 1)
                    kv[k.strip()] = v.strip()
            data = kv
    if not isinstance(data, dict):
        data = {}
    return data


def extract_sysinfo_fields(raw_reply: dict[str, Any]) -> dict[str, Any]:
    """Normalize the payload of connect.sysinfo?get across dict, body, or key=value forms."""
    return extract_hbus_data_dict(raw_reply)


def summarize_usb_device(device: usb.DeviceInfo, mask: bool = True) -> dict[str, Any]:
    serial_raw = str(device.serial or "").strip()
    return {
        "backend": device.backend,
        "vendorId": f"{device.vendor_id:04X}",
        "productId": f"{device.product_id:04X}",
        "devicePath": device.path,
        "product": device.product,
        "manufacturer": device.manufacturer,
        "hasSerial": bool(serial_raw),
        "serial": mask_id(serial_raw, "serial") if mask else serial_raw,
        "usagePage": device.usage_page,
        "usage": device.usage,
        "inputReportByteLength": device.input_report_length,
        "outputReportByteLength": device.output_report_length,
    }


def summarize_preflight_read(read: usb.RawFileRead, mask: bool = True) -> dict[str, Any]:
    text = usb.decode_raw_text(read.data)
    rows = usb.parse_property_lines(text)
    candidates = usb.extract_hub_id_candidates_from_rows(rows)
    alternates = usb.extract_alternate_numeric_ids_from_rows(rows)

    paired_devices: list[dict[str, Any]] = []
    device_count = 0
    has_rfid = False
    has_equad_id = False

    for row in rows:
        key = str(row.get("key") or "").strip().lower()
        value = str(row.get("value") or "").strip()
        if key == "response":
            try:
                parsed = json.loads(value)
            except json.JSONDecodeError:
                parsed = None
            if isinstance(parsed, dict):
                has_rfid = has_rfid or bool(parsed.get("RFID"))
                has_equad_id = has_equad_id or bool(parsed.get("EquadID"))
                raw_devices = parsed.get("Devices")
                if isinstance(raw_devices, list):
                    for dev in raw_devices:
                        if isinstance(dev, dict):
                            paired_devices.append(
                                {
                                    "skinId": dev.get("SkinId"),
                                    "deviceIndex": dev.get("DeviceIndex"),
                                    "hasEquadId": bool(dev.get("EquadID")),
                                    "equadId": mask_id(dev.get("EquadID"), "rf-id") if mask else dev.get("EquadID"),
                                }
                            )
                if isinstance(parsed.get("DeviceCount"), int):
                    device_count = parsed["DeviceCount"]
                else:
                    device_count = len(paired_devices)
        elif key == "rfid" and value:
            has_rfid = True
        elif key == "equadid" and value:
            has_equad_id = True

    hub_id = candidates[0] if candidates else ""
    masked_alternates = [
        {
            "source": item.get("source", ""),
            "confidence": item.get("confidence", "low"),
            "value": mask_id(item.get("value"), "rf-id") if mask else item.get("value", ""),
        }
        for item in alternates
    ]

    return {
        "ok": True,
        "remotePath": read.remote_path,
        "reportedSize": read.size,
        "bytesRead": len(read.data),
        "hasHubId": bool(hub_id),
        "hubId": mask_id(hub_id, "hub-id") if mask else hub_id,
        "hubIdCandidateCount": len(candidates),
        "hubIdCandidates": [mask_id(c, "hub-id") if mask else c for c in candidates],
        "hasRfid": has_rfid,
        "hasEquadId": has_equad_id,
        "alternateNumericIds": masked_alternates,
        "pairedDeviceCount": device_count,
        "pairedDevices": paired_devices,
    }


def summarize_sysinfo_reply(reply: dict[str, Any], mask: bool = True) -> dict[str, Any]:
    fields = extract_sysinfo_fields(reply)
    inner_data = reply.get("data") if isinstance(reply, dict) else {}
    error_code = str(
        inner_data.get("errorCode", reply.get("code", ""))
        if isinstance(inner_data, dict)
        else reply.get("code", "")
    )
    fw_ver = str(fields.get("fw_ver") or fields.get("current_fw_version") or "").strip()
    hw_ver = str(fields.get("hw_ver") or "").strip()
    skin_raw = fields.get("skin") if "skin" in fields else fields.get("productId")
    skin_str = str(skin_raw if skin_raw is not None else "").strip()
    skin_dec = parse_skin_decimal(skin_raw)
    ram_size = str(fields.get("ram_size") or "").strip()
    arch = str(fields.get("arch") or "").strip()
    bt_addr = str(fields.get("bt_addr") or "").strip()
    serial_num = str(fields.get("serial_number") or fields.get("unit_id") or "").strip()
    features = fields.get("features") if isinstance(fields.get("features"), list) else (
        fields.get("feature") if isinstance(fields.get("feature"), list) else []
    )

    return {
        "ok": error_code in ("200", ""),
        "code": error_code or "200",
        "fwVer": fw_ver,
        "firmwareMatchesGate": fw_ver == REQUIRED_FIRMWARE if fw_ver else None,
        "requiredFirmware": REQUIRED_FIRMWARE,
        "hwVer": hw_ver,
        "skin": skin_str,
        "skinDecimal": skin_dec,
        "ramSize": ram_size,
        "arch": arch,
        "features": features,
        "hasBtAddr": bool(bt_addr),
        "btAddr": mask_mac(bt_addr) if mask else bt_addr,
        "hasSerialNumber": bool(serial_num),
        "serialNumber": mask_id(serial_num, "serial") if mask else serial_num,
    }


def summarize_provision_info_reply(reply: dict[str, Any], mask: bool = True) -> dict[str, Any]:
    data = extract_hbus_data_dict(reply)
    inner_data = reply.get("data") if isinstance(reply, dict) else {}
    error_code = str(
        inner_data.get("errorCode", reply.get("code", 200))
        if isinstance(inner_data, dict)
        else reply.get("code", 200)
    )

    raw_mode = data.get("mode")
    mode_int: int | None = None
    if raw_mode is not None and str(raw_mode).strip() != "":
        try:
            mode_int = int(raw_mode)
        except (ValueError, TypeError):
            mode_int = None

    active_remote_id = data.get("activeRemoteId")
    if active_remote_id is None:
        active_remote_id = data.get("remoteId")
    remote_id_type: str | None = None
    has_remote_id = False
    if isinstance(active_remote_id, int) and not isinstance(active_remote_id, bool):
        remote_id_type = "number"
        has_remote_id = True
    elif isinstance(active_remote_id, str) and active_remote_id.strip():
        remote_id_type = "string"
        has_remote_id = True

    account_id = str(data.get("accountId") or "").strip()
    email = str(data.get("email") or data.get("username") or "").strip()
    if email.lower() == "unknown":
        email = ""
    discovery_server = str(
        data.get("discoveryServer")
        or data.get("discoveryServerUri")
        or data.get("discoveryServerCF")
        or data.get("discoveryServerUriCF")
        or ""
    ).strip()
    is_local_hint = bool(
        (account_id and "local" in account_id.lower())
        or (email and (email.lower().endswith("@local") or "local" in email.lower()))
    )
    is_provisioned = bool(mode_int == 3 or has_remote_id or account_id)

    return {
        "ok": error_code in ("200", ""),
        "code": error_code or "200",
        "provisioned": is_provisioned,
        "mode": mode_int,
        "hasActiveRemoteId": has_remote_id,
        "remoteIdType": remote_id_type,
        "activeRemoteId": mask_id(active_remote_id, "hub-id") if (mask and has_remote_id) else (active_remote_id if has_remote_id else None),
        "hasAccountId": bool(account_id),
        "accountId": mask_id(account_id, "account-id") if (mask and account_id) else account_id,
        "hasEmail": bool(email),
        "email": mask_id(email, "email") if (mask and email) else email,
        "isLocalAccountHint": is_local_hint,
        "discoveryServer": discovery_server,
        "keys": sorted(str(k) for k in data.keys()),
    }


def summarize_discovery_info_reply(reply: dict[str, Any], mask: bool = True) -> dict[str, Any]:
    data = extract_hbus_data_dict(reply)
    inner_data = reply.get("data") if isinstance(reply, dict) else {}
    error_code = str(
        inner_data.get("errorCode", reply.get("code", 200))
        if isinstance(inner_data, dict)
        else reply.get("code", 200)
    )

    raw_mode = data.get("mode")
    mode_int: int | None = None
    if raw_mode is not None and str(raw_mode).strip() != "":
        try:
            mode_int = int(raw_mode)
        except (ValueError, TypeError):
            mode_int = None

    remote_id_raw = data.get("remoteId")
    if remote_id_raw is None or str(remote_id_raw).strip() == "":
        remote_id_raw = data.get("activeRemoteId")
    remote_id_str = str(remote_id_raw if remote_id_raw is not None else "").strip()
    has_remote_id = bool(remote_id_str)

    account_id = str(data.get("accountId") or "").strip()
    email = str(data.get("email") or "").strip()
    if email.lower() == "unknown":
        email = ""

    fw_ver = str(data.get("current_fw_version") or data.get("fw_ver") or "").strip()
    friendly_name = str(data.get("friendlyName") or data.get("host_name") or "").strip()
    product_id = str(data.get("productId") or "").strip()
    skin_dec = parse_skin_decimal(data.get("hubId"))
    raw_ip = str(data.get("ip") or "").strip()
    raw_uuid = str(data.get("uuid") or "").strip()
    setup_status = str(data.get("setupStatus") or "").strip()
    discovery_server = str(data.get("discoveryServerUri") or data.get("discoveryServer") or "").strip()

    is_local_hint = bool(
        (account_id and "local" in account_id.lower())
        or (email and (email.lower().endswith("@local") or "local" in email.lower()))
    )
    is_provisioned = bool(mode_int == 3 or has_remote_id or account_id)

    return {
        "ok": error_code in ("200", ""),
        "code": error_code or "200",
        "provisioned": is_provisioned,
        "mode": mode_int,
        "hasRemoteId": has_remote_id,
        "remoteId": mask_id(remote_id_str, "hub-id") if (mask and has_remote_id) else (remote_id_str if has_remote_id else None),
        "hasAccountId": bool(account_id),
        "accountId": mask_id(account_id, "account-id") if (mask and account_id) else account_id,
        "hasEmail": bool(email),
        "email": mask_id(email, "email") if (mask and email) else email,
        "isLocalAccountHint": is_local_hint,
        "currentFwVersion": fw_ver,
        "friendlyName": friendly_name,
        "productId": product_id,
        "skinDecimal": skin_dec,
        "hasIp": bool(raw_ip),
        "ip": mask_ip(raw_ip) if (mask and raw_ip) else raw_ip,
        "hasUuid": bool(raw_uuid),
        "uuid": mask_id(raw_uuid, "uuid") if (mask and raw_uuid) else raw_uuid,
        "setupStatus": setup_status,
        "discoveryServerUri": discovery_server,
    }


def classify_signals(usb_result: dict[str, Any], lan_result: dict[str, Any]) -> dict[str, Any]:
    """Compute a classification summary from USB + LAN probe results (including offline USB provisioning info)."""
    ports = lan_result.get("ports") if isinstance(lan_result, dict) else {}
    if not isinstance(ports, dict):
        ports = {}
    port_8080 = bool(ports.get("8080"))
    port_5222 = bool(ports.get("5222"))
    port_22 = bool(ports.get("22"))

    prov = lan_result.get("provisionInfo") if isinstance(lan_result, dict) else None
    lan_provisioned: bool | None = prov.get("provisioned") if isinstance(prov, dict) and prov.get("ok") else None

    usb_connected = bool(usb_result.get("connected")) if isinstance(usb_result, dict) else False
    usb_preflight = usb_result.get("preflight") if isinstance(usb_result, dict) else None
    usb_sysinfo = usb_result.get("sysinfo") if isinstance(usb_result, dict) else None
    usb_prov = usb_result.get("provisionInfo") if isinstance(usb_result, dict) else None
    usb_disc = usb_result.get("discoveryInfo") if isinstance(usb_result, dict) else None
    usb_has_hub_id = bool(usb_preflight.get("hasHubId")) if isinstance(usb_preflight, dict) else False

    usb_prov_ok = isinstance(usb_prov, dict) and bool(usb_prov.get("ok"))
    usb_disc_ok = isinstance(usb_disc, dict) and bool(usb_disc.get("ok"))

    usb_provisioned: bool | None = None
    if (
        (usb_prov_ok and bool(usb_prov.get("provisioned")))
        or (usb_disc_ok and bool(usb_disc.get("provisioned")))
        or usb_has_hub_id
    ):
        usb_provisioned = True
    elif (
        (usb_prov_ok and not bool(usb_prov.get("provisioned")))
        or (usb_disc_ok and not bool(usb_disc.get("provisioned")))
        or (usb_connected and isinstance(usb_preflight, dict) and usb_preflight.get("ok") and not usb_has_hub_id)
    ):
        usb_provisioned = False

    fw_ver = ""
    if isinstance(usb_sysinfo, dict) and usb_sysinfo.get("fwVer"):
        fw_ver = str(usb_sysinfo["fwVer"])
    elif usb_disc_ok and usb_disc.get("currentFwVersion"):
        fw_ver = str(usb_disc["currentFwVersion"])

    if port_8080:
        verdict = "melodious-installed"
        reason = "Melodious web UI port 8080 is open."
    elif port_5222 and (lan_provisioned is not False) and (usb_provisioned is not False):
        verdict = "provisioned-xmpp-on"
        reason = "XMPP port 5222 is open on a provisioned hub."
    elif lan_provisioned is True or usb_provisioned is True:
        verdict = "provisioned-local"
        via = "over USB hbus" if (usb_provisioned is True and lan_provisioned is not True) else "with XMPP port 5222 closed"
        reason = f"Hub is provisioned (mode 3 / Hub ID present) {via}."
    elif lan_provisioned is False or usb_provisioned is False:
        verdict = "fresh"
        reason = "Hub is unprovisioned / factory-reset (no account or Hub ID)."
    else:
        verdict = "unknown"
        reason = "Insufficient LAN or USB signals to classify hub state."

    return {
        "verdict": verdict,
        "reason": reason,
        "sshOpen": port_22,
        "xmppOpen": port_5222,
        "webUiOpen": port_8080,
        "usbConnected": usb_connected,
        "usbProvisioned": usb_provisioned,
        "lanProvisioned": lan_provisioned,
        "usbWedge": bool(usb_result.get("usbWedge")) if isinstance(usb_result, dict) else False,
        "fwVer": fw_ver,
        "firmwareMatchesGate": (fw_ver == REQUIRED_FIRMWARE) if fw_ver else None,
        "requiredFirmware": REQUIRED_FIRMWARE,
    }


@contextlib.contextmanager
def silence_library_stdout() -> Any:
    """Redirect library print() calls away from stdout so stdout stays pure NDJSON."""
    sink = io.StringIO()
    with contextlib.redirect_stdout(sink):
        yield sink


def make_emitter(stream: Any = None, secrets: list[str] | None = None) -> Callable[[dict[str, Any]], None]:
    target = stream if stream is not None else sys.__stdout__

    def emit(event: dict[str, Any]) -> None:
        line = json.dumps(event, separators=(",", ":"), ensure_ascii=True)
        line = scrub_secrets(line, secrets)
        target.write(line + "\n")
        target.flush()

    return emit


def make_usb_args(
    *,
    backend: str,
    device_path: str,
    vendor_id: str,
    product_id: str,
    timeout_ms: int,
) -> argparse.Namespace:
    usb_argv = [
        "--backend",
        backend,
        "--vendor-id",
        vendor_id,
        "--product-id",
        product_id,
        "--timeout-ms",
        str(timeout_ms),
    ]
    if device_path:
        usb_argv += ["--device-path", device_path]
    return usb.parse_args(usb_argv)


def resolve_single_usb_device(
    usb_args: argparse.Namespace,
    *,
    mask: bool,
    emit: Callable[[dict[str, Any]], None],
) -> tuple[list[usb.DeviceInfo], list[dict[str, Any]], str | None]:
    emit({"type": "step", "step": "usb-enumerate", "message": "Enumerating Harmony Hub USB HID devices (046D:C129)"})
    try:
        with silence_library_stdout():
            bridge = usb.HarmonyUsbBridge(usb_args)
            devices = bridge.enumerate_devices()
    except Exception as exc:
        msg = mask_free_text(str(exc), mask)
        emit({"type": "progress", "step": "usb-enumerate", "status": "failed", "error": msg})
        return [], [], msg

    summarized_devices = [summarize_usb_device(dev, mask=mask) for dev in devices]
    emit(
        {
            "type": "progress",
            "step": "usb-enumerate",
            "status": "ok",
            "deviceCount": len(summarized_devices),
            "devices": summarized_devices,
        }
    )

    if len(devices) == 0:
        return [], summarized_devices, "No Harmony Hub USB HID device (046D:C129) found."
    if len(devices) > 1 and not usb_args.device_path:
        return devices, summarized_devices, f"Multiple Harmony Hub USB devices found ({len(devices)}); specify --usb-device-path."

    chosen = devices[0]
    usb_args.device_path = chosen.path
    usb_args.backend = chosen.backend
    return devices, summarized_devices, None


def run_usb_probes(
    *,
    action: str,
    backend: str,
    device_path: str,
    vendor_id: str,
    product_id: str,
    timeout_ms: int,
    mask: bool,
    emit: Callable[[dict[str, Any]], None],
) -> dict[str, Any]:
    usb_args = make_usb_args(
        backend=backend,
        device_path=device_path,
        vendor_id=vendor_id,
        product_id=product_id,
        timeout_ms=timeout_ms,
    )
    devices, summarized_devices, enum_error = resolve_single_usb_device(usb_args, mask=mask, emit=emit)

    result: dict[str, Any] = {
        "ok": enum_error is None or action == "usb-enumerate",
        "connected": len(devices) == 1,
        "deviceCount": len(devices),
        "devices": summarized_devices,
        "device": summarized_devices[0] if len(summarized_devices) == 1 else None,
        "preflight": None,
        "sysinfo": None,
        "provisionInfo": None,
        "discoveryInfo": None,
        "usbWedge": False,
    }

    if action == "usb-enumerate":
        if enum_error and len(devices) == 0 and not summarized_devices:
            # Distinguish backend enumeration exception from normal 0 devices
            pass
        return result

    if enum_error:
        result["ok"] = False
        result["error"] = enum_error
        return result

    # Step 1: Always run raw file read preflight (/rf/deviceinfo) BEFORE hbus calls,
    # and release usb_process_lock() before UsbHbusTransport.call() acquires its own lock.
    emit({"type": "step", "step": "usb-preflight", "message": "Reading /rf/deviceinfo over USB HID raw file protocol"})
    try:
        with silence_library_stdout(), usb.usb_process_lock():
            preflight_bridge = usb.HarmonyUsbBridge(usb_args)
            read = usb.raw_read_file(preflight_bridge, usb.RAW_DEVICE_INFO_PATH, 50, max(timeout_ms, 12000))
        preflight_summary = summarize_preflight_read(read, mask=mask)
        result["preflight"] = preflight_summary
        emit({"type": "progress", "step": "usb-preflight", "status": "ok", "preflight": preflight_summary})
    except Exception as exc:
        msg = mask_free_text(str(exc), mask)
        wedge = is_usb_wedge_error(str(exc))
        result["ok"] = False
        result["usbWedge"] = wedge
        result["error"] = msg
        result["preflight"] = {"ok": False, "error": msg, "usbWedge": wedge}
        emit({"type": "progress", "step": "usb-preflight", "status": "failed", "error": msg, "usbWedge": wedge})
        return result

    if action == "usb-preflight":
        return result

    timeout_sec = max(5, min(30, timeout_ms // 1000))

    # Step 2: Engine hbus connect.sysinfo?get over USB source 6.
    if action in ("probe", "classify", "usb-sysinfo"):
        emit({"type": "step", "step": "usb-sysinfo", "message": "Querying connect.sysinfo?get over USB hbus"})
        try:
            with silence_library_stdout():
                transport = usb.UsbHbusTransport(usb_args)
                reply = transport.call("connect.sysinfo?get", {}, timeout=timeout_sec)
            sysinfo_summary = summarize_sysinfo_reply(reply, mask=mask)
            result["sysinfo"] = sysinfo_summary
            emit({"type": "progress", "step": "usb-sysinfo", "status": "ok", "sysinfo": sysinfo_summary})
        except Exception as exc:
            msg = mask_free_text(str(exc), mask)
            wedge = is_usb_wedge_error(str(exc))
            result["ok"] = False
            result["usbWedge"] = wedge
            result["error"] = msg
            result["sysinfo"] = {"ok": False, "error": msg, "usbWedge": wedge}
            emit({"type": "progress", "step": "usb-sysinfo", "status": "failed", "error": msg, "usbWedge": wedge})
            return result

        if action == "usb-sysinfo":
            return result

    # Step 3: Offline USB provisioning check: setup.account?getProvisionInfo over UsbHbusTransport.
    if action in ("probe", "classify", "usb-provision-info"):
        emit({"type": "step", "step": "usb-provision-info", "message": "Querying setup.account?getProvisionInfo over USB hbus"})
        try:
            with silence_library_stdout():
                transport = usb.UsbHbusTransport(usb_args)
                prov_reply = transport.call("setup.account?getProvisionInfo", {}, timeout=timeout_sec)
            prov_summary = summarize_provision_info_reply(prov_reply, mask=mask)
            result["provisionInfo"] = prov_summary
            emit({"type": "progress", "step": "usb-provision-info", "status": "ok", "provisionInfo": prov_summary})
        except Exception as exc:
            msg = mask_free_text(str(exc), mask)
            wedge = is_usb_wedge_error(str(exc))
            result["provisionInfo"] = {"ok": False, "error": msg, "usbWedge": wedge}
            emit({"type": "progress", "step": "usb-provision-info", "status": "failed", "error": msg, "usbWedge": wedge})
            if wedge or action == "usb-provision-info":
                result["ok"] = False
                result["usbWedge"] = wedge
                result["error"] = msg
                return result

        if action == "usb-provision-info":
            return result

    # Step 4: Offline USB discovery record: connect.discoveryinfo?get over UsbHbusTransport.
    if action in ("probe", "classify", "usb-discovery-info"):
        emit({"type": "step", "step": "usb-discovery-info", "message": "Querying connect.discoveryinfo?get over USB hbus"})
        try:
            with silence_library_stdout():
                transport = usb.UsbHbusTransport(usb_args)
                disc_reply = transport.call("connect.discoveryinfo?get", {}, timeout=timeout_sec)
            disc_summary = summarize_discovery_info_reply(disc_reply, mask=mask)
            result["discoveryInfo"] = disc_summary
            emit({"type": "progress", "step": "usb-discovery-info", "status": "ok", "discoveryInfo": disc_summary})
        except Exception as exc:
            msg = mask_free_text(str(exc), mask)
            wedge = is_usb_wedge_error(str(exc))
            result["discoveryInfo"] = {"ok": False, "error": msg, "usbWedge": wedge}
            emit({"type": "progress", "step": "usb-discovery-info", "status": "failed", "error": msg, "usbWedge": wedge})
            if wedge or action == "usb-discovery-info":
                result["ok"] = False
                result["usbWedge"] = wedge
                result["error"] = msg
                return result

    return result


def run_lan_probes(
    *,
    host: str,
    hbus_port: int,
    xmpp_port: int,
    ssh_port: int,
    webui_port: int,
    timeout_sec: float,
    mask: bool,
    ports_check: bool,
    emit: Callable[[dict[str, Any]], None],
) -> dict[str, Any]:
    clean_host = (host or "").strip()
    if not clean_host:
        return {"ok": False, "skipped": True}

    masked_host = mask_ip(clean_host) if mask else clean_host
    lan_out: dict[str, Any] = {
        "ok": True,
        "host": masked_host,
        "provisionInfo": None,
        "ports": {},
    }

    emit({"type": "step", "step": "lan-provision-info", "message": "Querying setup.account?getProvisionInfo over HTTP POST :8088"})
    try:
        with silence_library_stdout():
            post = lan.HttpPostTransport(clean_host, port=hbus_port)
            reply = post.call("setup.account?getProvisionInfo", {}, timeout=max(3, int(timeout_sec)))
        prov_summary = summarize_provision_info_reply(reply, mask=mask)
        lan_out["provisionInfo"] = prov_summary
        emit({"type": "progress", "step": "lan-provision-info", "status": "ok", "provisionInfo": prov_summary})
    except Exception as exc:
        msg = mask_free_text(str(exc), mask)
        lan_out["provisionInfo"] = {"ok": False, "error": msg}
        emit({"type": "progress", "step": "lan-provision-info", "status": "failed", "error": msg})

    if ports_check:
        emit({"type": "step", "step": "lan-ports", "message": "Checking TCP ports (:8080, :8088, :5222, :22)"})
        ports = {
            str(webui_port): lan.is_port_open(clean_host, webui_port, timeout=min(2.5, timeout_sec)),
            str(hbus_port): lan.is_port_open(clean_host, hbus_port, timeout=min(2.5, timeout_sec)),
            str(xmpp_port): lan.is_port_open(clean_host, xmpp_port, timeout=min(2.5, timeout_sec)),
            str(ssh_port): lan.is_port_open(clean_host, ssh_port, timeout=min(2.5, timeout_sec)),
        }
        lan_out["ports"] = ports
        emit({"type": "progress", "step": "lan-ports", "status": "ok", "ports": ports})

    return lan_out


def read_stdin_json(stdin_stream: Any) -> dict[str, Any]:
    stream = stdin_stream if stdin_stream is not None else sys.stdin
    if stream is None:
        raise ValueError("stdin stream is unavailable")
    raw = stream.read()
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    text = str(raw or "").strip()
    if not text:
        raise ValueError("Expected JSON object on stdin, but stdin was empty")
    first_line = next((line.strip() for line in text.splitlines() if line.strip()), "")
    parsed = json.loads(first_line)
    if not isinstance(parsed, dict):
        raise ValueError("Expected a JSON object on stdin")
    return parsed


def run_usb_wifi_scan_action(
    *,
    usb_args: argparse.Namespace,
    show_ssids: bool,
    mask: bool,
    emit: Callable[[dict[str, Any]], None],
) -> tuple[bool, dict[str, Any]]:
    devices, summarized_devices, enum_error = resolve_single_usb_device(usb_args, mask=mask, emit=emit)
    if enum_error:
        return False, {"ok": False, "connected": False, "devices": summarized_devices, "error": enum_error}

    emit({"type": "step", "step": "usb-wifi-scan", "message": "Scanning visible Wi-Fi networks over USB HID (/wifi/networks)"})
    try:
        with silence_library_stdout(), usb.usb_process_lock():
            bridge = usb.HarmonyUsbBridge(usb_args)
            read = usb.raw_read_file(bridge, usb.RAW_WIFI_NETWORKS_PATH, 100, max(usb_args.timeout_ms, 60000))
        summary = usb.wifi_scan_summary(read, show_ssids=show_ssids, raw_output=False)
        emit(
            {
                "type": "progress",
                "step": "usb-wifi-scan",
                "status": "ok",
                "networkCount": summary.get("networkCount", 0),
                "ssidsShown": show_ssids,
                "networks": summary.get("networks", []),
            }
        )
        return True, summary
    except Exception as exc:
        msg = mask_free_text(str(exc), mask)
        wedge = is_usb_wedge_error(str(exc))
        emit({"type": "progress", "step": "usb-wifi-scan", "status": "failed", "error": msg, "usbWedge": wedge})
        return False, {"ok": False, "error": msg, "usbWedge": wedge}


def run_usb_wifi_status_action(
    *,
    usb_args: argparse.Namespace,
    show_ssids: bool,
    mask: bool,
    emit: Callable[[dict[str, Any]], None],
) -> tuple[bool, dict[str, Any]]:
    devices, summarized_devices, enum_error = resolve_single_usb_device(usb_args, mask=mask, emit=emit)
    if enum_error:
        return False, {"ok": False, "connected": False, "devices": summarized_devices, "error": enum_error}

    emit({"type": "step", "step": "usb-wifi-status", "message": "Reading Wi-Fi status over USB HID (/wifi/status)"})
    try:
        with silence_library_stdout(), usb.usb_process_lock():
            bridge = usb.HarmonyUsbBridge(usb_args)
            read = usb.raw_read_file(bridge, usb.RAW_WIFI_STATUS_PATH, 50, max(usb_args.timeout_ms, 25000))
        summary = usb.wifi_status_summary(read, show_ssids=show_ssids, raw_output=False)
        if mask and summary.get("ipAddress"):
            summary["ipAddress"] = mask_ip(summary["ipAddress"])
        emit({"type": "progress", "step": "usb-wifi-status", "status": "ok", "wifiStatus": summary})
        return True, summary
    except Exception as exc:
        msg = mask_free_text(str(exc), mask)
        wedge = is_usb_wedge_error(str(exc))
        emit({"type": "progress", "step": "usb-wifi-status", "status": "failed", "error": msg, "usbWedge": wedge})
        return False, {"ok": False, "error": msg, "usbWedge": wedge}


def run_usb_wifi_connect_action(
    *,
    usb_args: argparse.Namespace,
    stdin_payload: dict[str, Any],
    cli_ssid: str,
    cli_encryption: str,
    no_save: bool,
    show_ssids: bool,
    mask: bool,
    secrets_sink: list[str],
    emit: Callable[[dict[str, Any]], None],
) -> tuple[bool, dict[str, Any]]:
    ssid = str(stdin_payload.get("ssid") if "ssid" in stdin_payload else cli_ssid or "").strip()
    raw_password = stdin_payload.get("password", "")
    if raw_password is None:
        raw_password = ""
    password = str(raw_password)
    if password:
        secrets_sink.append(password)

    encryption = str(stdin_payload.get("encryption") or cli_encryption or "WPA2-PSK").strip() or "WPA2-PSK"
    save_disabled = bool(stdin_payload.get("noSave", no_save))

    if not ssid:
        emit({"type": "error", "step": "usb-wifi-connect", "code": "invalid_ssid", "message": "Wi-Fi SSID is required in stdin JSON (or --ssid)."})
        return False, {"ok": False, "code": "invalid_ssid", "error": "Wi-Fi SSID is required."}

    if any(ch in ssid for ch in ("\r", "\n", "\0")) or not (1 <= len(ssid.encode("utf-8")) <= 32):
        emit({"type": "error", "step": "usb-wifi-connect", "code": "invalid_ssid", "message": "Wi-Fi SSID must be 1..32 UTF-8 bytes without newlines or NUL bytes."})
        return False, {"ok": False, "code": "invalid_ssid", "error": "Invalid Wi-Fi SSID."}

    if any(ch in password for ch in ("\r", "\n", "\0")):
        emit({"type": "error", "step": "usb-wifi-connect", "code": "invalid_wifi_password", "message": "Wi-Fi password must not contain newlines or NUL bytes."})
        return False, {"ok": False, "code": "invalid_wifi_password", "error": "Invalid Wi-Fi password."}

    if encryption.upper() not in ("NONE", "OPEN") and password == "":
        emit({"type": "error", "step": "usb-wifi-connect", "code": "missing_wifi_password", "message": "Wi-Fi password is required on stdin JSON unless encryption is NONE/OPEN."})
        return False, {"ok": False, "code": "missing_wifi_password", "error": "Wi-Fi password is required."}

    devices, summarized_devices, enum_error = resolve_single_usb_device(usb_args, mask=mask, emit=emit)
    if enum_error:
        return False, {"ok": False, "connected": False, "devices": summarized_devices, "error": enum_error}

    usb_args.ssid = ssid
    usb_args.wifi_password = password
    usb_args.encryption = encryption
    usb_args.no_save = save_disabled

    display_ssid = ssid if (show_ssids and not mask) else "<ssid>"
    emit({"type": "step", "step": "usb-wifi-connect", "message": f"Writing Wi-Fi credentials over USB HID (/wifi/connect, encryption={encryption})"})
    try:
        payload = usb.wifi_connect_payload(usb_args)
        close_error: str | None = None
        with silence_library_stdout(), usb.usb_process_lock():
            bridge = usb.HarmonyUsbBridge(usb_args)
            handle, device = bridge.open_handle()
            try:
                handle_id = usb.raw_open_write_file_on_handle(bridge, handle, device, usb.RAW_WIFI_CONNECT_PATH, len(payload), 60000)
                responses = bridge.raw_write_data_on_handle(
                    handle,
                    device,
                    handle_id,
                    payload,
                    max(usb_args.timeout_ms, 100000),
                    packets_per_chunk=50,
                    packet_count_width="byte",
                    label=usb.RAW_WIFI_CONNECT_PATH,
                )
                try:
                    usb.raw_close_file_on_handle(bridge, handle, device, handle_id, usb.RAW_WIFI_CONNECT_PATH, 30000)
                except Exception as close_exc:
                    close_error = mask_free_text(str(close_exc), mask, secrets_sink)
            finally:
                handle.close()

        write_acks = [usb.raw_write_ack_summary(r, expected_handle_id=handle_id) for r in responses]
        accepted_async = any(item.get("meaning") == "ok/handle-echo" for item in write_acks)
        summary = {
            "ok": True,
            "remotePath": usb.RAW_WIFI_CONNECT_PATH,
            "bytesWritten": len(payload),
            "ssid": display_ssid,
            "encryption": encryption,
            "save": not save_disabled,
            "passwordRedacted": True,
            "writeAcks": write_acks,
            "acceptedAsync": accepted_async,
            "closeWarning": close_error,
        }
        emit({"type": "progress", "step": "usb-wifi-connect", "status": "ok", "wifiConnect": summary})
        return True, summary
    except Exception as exc:
        msg = mask_free_text(str(exc), mask, secrets_sink)
        wedge = is_usb_wedge_error(str(exc))
        emit({"type": "progress", "step": "usb-wifi-connect", "status": "failed", "error": msg, "usbWedge": wedge})
        return False, {"ok": False, "error": msg, "usbWedge": wedge}
    finally:
        usb_args.wifi_password = ""


def run_usb_factory_reset_action(
    *,
    usb_args: argparse.Namespace,
    mask: bool,
    emit: Callable[[dict[str, Any]], None],
) -> tuple[bool, dict[str, Any]]:
    devices, summarized_devices, enum_error = resolve_single_usb_device(usb_args, mask=mask, emit=emit)
    if enum_error:
        return False, {"ok": False, "connected": False, "devices": summarized_devices, "error": enum_error}

    # Safety invariant: factory reset MUST send "1" ONLY, never "all" (which chip-erases CC2544 RF pairings).
    reset_payload = FACTORY_RESET_BODY
    assert reset_payload == b"1"

    emit(
        {
            "type": "step",
            "step": "usb-factory-reset",
            "message": "Writing /sys/factoryreset marker ('1' only, never 'all') and triggering USB device-control reboot (0xFF/0x00)",
        }
    )

    reset_handle_id: int | None = None
    reboot_handle_id: int | None = None
    reset_write_responses: list[usb.RawResponse] = []
    reboot_write_responses: list[usb.RawResponse] = []
    reboot_write_warning: str | None = None
    reboot_close_warning: str | None = None
    devctrl_reboot_sent = False
    devctrl_reboot_warning: str | None = None

    try:
        with silence_library_stdout(), usb.usb_process_lock():
            bridge = usb.HarmonyUsbBridge(usb_args)
            handle, device = bridge.open_handle()
            try:
                handle_id = usb.raw_open_write_file_on_handle(bridge, handle, device, "/sys/factoryreset", None, sequence=0)
                reset_handle_id = handle_id
                reset_write_responses = bridge.raw_write_data_on_handle(
                    handle,
                    device,
                    handle_id,
                    reset_payload,
                    180000,
                    packets_per_chunk=5,
                    include_done=False,
                    label="/sys/factoryreset",
                    packet_count_width="word",
                    data_length_mode="zero",
                    fixed_sequence=0,
                )
                usb.raw_close_file_on_handle(bridge, handle, device, handle_id, "/sys/factoryreset", sequence=0)

                try:
                    r_handle_id = usb.raw_open_write_file_on_handle(bridge, handle, device, "/sys/reboot", None, sequence=0)
                    reboot_handle_id = r_handle_id
                    reboot_write_responses = bridge.raw_write_data_on_handle(
                        handle,
                        device,
                        r_handle_id,
                        b"reboot",
                        180000,
                        packets_per_chunk=5,
                        include_done=False,
                        label="/sys/reboot",
                        packet_count_width="word",
                        data_length_mode="zero",
                        fixed_sequence=0,
                        allow_error_ack=True,
                    )
                    try:
                        usb.raw_close_file_on_handle(bridge, handle, device, r_handle_id, "/sys/reboot", timeout_ms=180000, sequence=0)
                    except Exception as close_exc:
                        reboot_close_warning = mask_free_text(str(close_exc), mask)
                except Exception as reb_exc:
                    reboot_write_warning = mask_free_text(str(reb_exc), mask)

                # Per docs/FRESH_HUB_ACTIVATION.md §Step 2: /sys/reboot alone leaves the hub up;
                # send the USB device-control reboot (0xFF, arg 0x00) to take it down into initramfs wipe.
                try:
                    usb.raw_reboot_device_on_handle(bridge, handle, device)
                    devctrl_reboot_sent = True
                except Exception as devctrl_exc:
                    devctrl_reboot_sent = True
                    devctrl_reboot_warning = mask_free_text(str(devctrl_exc), mask)
            finally:
                handle.close()

        reset_acks = [usb.raw_write_ack_summary(r, expected_handle_id=reset_handle_id) for r in reset_write_responses]
        reboot_acks = [usb.raw_write_ack_summary(r, expected_handle_id=reboot_handle_id) for r in reboot_write_responses]
        power_cycle_guidance = (
            "Factory reset marker ('1') and USB device-control reboot (0xFF/0x00) sent. "
            "The hub will fast-blink red while initramfs erases /data and /cache, and normally stays absent from USB afterward. "
            "Recovery (docs/FRESH_HUB_ACTIVATION.md §Step 2): wait ~30-60s for the wipe, unplug the USB power cable for 15 seconds, "
            "plug it back in (expect USB re-enumeration in ~10s), and wait ~5 minutes for boot to settle before running usb-preflight."
        )
        summary = {
            "ok": True,
            "factoryResetMarked": True,
            "resetPayload": "1",
            "resetWriteAcks": reset_acks,
            "sysRebootRequested": reboot_handle_id is not None,
            "sysRebootWriteAcks": reboot_acks,
            "sysRebootWriteWarning": reboot_write_warning,
            "sysRebootCloseWarning": reboot_close_warning,
            "deviceControlRebootSent": devctrl_reboot_sent,
            "deviceControlRebootWarning": devctrl_reboot_warning,
            "powerCycleRecoveryRequired": True,
            "powerCycleGuidance": power_cycle_guidance,
        }
        emit({"type": "progress", "step": "usb-factory-reset", "status": "ok", "factoryReset": summary})
        return True, summary
    except Exception as exc:
        msg = mask_free_text(str(exc), mask)
        wedge = is_usb_wedge_error(str(exc))
        emit({"type": "progress", "step": "usb-factory-reset", "status": "failed", "error": msg, "usbWedge": wedge})
        return False, {"ok": False, "error": msg, "usbWedge": wedge}


def run_usb_flash_firmware_action(
    *,
    usb_args: argparse.Namespace,
    firmware_file: str,
    verify_timeout_s: int,
    skip_post_reboot_verify: bool,
    mask: bool,
    emit: Callable[[dict[str, Any]], None],
) -> tuple[bool, dict[str, Any]]:
    clean_fw_file = (firmware_file or "").strip()
    if not clean_fw_file:
        emit({"type": "error", "step": "usb-flash-firmware", "code": "missing_firmware_file", "message": "--firmware-file is required for --action usb-flash-firmware."})
        return False, {"ok": False, "code": "missing_firmware_file", "error": "--firmware-file is required."}

    emit({"type": "step", "step": "usb-flash-validate-bundle", "message": "Validating .hfw2 firmware bundle and Description.xml checksums"})
    try:
        with silence_library_stdout():
            bundle = usb.parse_hfw2_bundle(clean_fw_file)
            bundle_summary = usb.firmware_bundle_summary(bundle)
        for image in bundle.images:
            if image.operation_type.lower() != "firmwareupgrade":
                raise usb.UsbBridgeError(f"{image.name} has unsupported operation type {image.operation_type!r}")
            if not image.remote_path:
                raise usb.UsbBridgeError(f"{image.name} has no remote PATH in Description.xml")
    except Exception as exc:
        msg = mask_free_text(str(exc), mask)
        emit({"type": "error", "step": "usb-flash-validate-bundle", "code": "invalid_firmware_bundle", "message": msg})
        return False, {"ok": False, "code": "invalid_firmware_bundle", "error": msg}

    emit({"type": "progress", "step": "usb-flash-validate-bundle", "status": "ok", "bundle": bundle_summary})

    devices, summarized_devices, enum_error = resolve_single_usb_device(usb_args, mask=mask, emit=emit)
    if enum_error:
        return False, {"ok": False, "connected": False, "devices": summarized_devices, "error": enum_error}

    # Check connected hub skin against Description.xml INTENDED/SKIN before any flash write
    emit({"type": "step", "step": "usb-flash-check-skin", "message": "Checking connected hub skinDecimal against firmware bundle Description.xml"})
    try:
        timeout_sec = max(5, min(30, usb_args.timeout_ms // 1000))
        with silence_library_stdout():
            transport = usb.UsbHbusTransport(usb_args)
            sysinfo_reply = transport.call("connect.sysinfo?get", {}, timeout=timeout_sec)
        sysinfo_summary = summarize_sysinfo_reply(sysinfo_reply, mask=mask)
    except Exception as exc:
        msg = mask_free_text(str(exc), mask)
        wedge = is_usb_wedge_error(str(exc))
        emit({"type": "progress", "step": "usb-flash-check-skin", "status": "failed", "error": msg, "usbWedge": wedge})
        return False, {"ok": False, "code": "skin_check_failed", "error": msg, "usbWedge": wedge}

    hub_skin = sysinfo_summary.get("skinDecimal")
    intended_skins = list(bundle.intended_skins)
    if hub_skin is None:
        msg = "Connected hub did not report a valid skinDecimal in connect.sysinfo?get; refusing to flash firmware."
        emit({"type": "error", "step": "usb-flash-check-skin", "code": "unknown_hub_skin", "message": msg})
        return False, {"ok": False, "code": "unknown_hub_skin", "error": msg, "intendedSkins": intended_skins}

    if not intended_skins or hub_skin not in intended_skins:
        msg = (
            f"Refusing to flash firmware: connected hub skinDecimal is {hub_skin} ({sysinfo_summary.get('skin')}), "
            f"but {bundle.path.name} Description.xml is intended only for skins {intended_skins}."
        )
        emit(
            {
                "type": "error",
                "step": "usb-flash-check-skin",
                "code": "skin_mismatch",
                "message": msg,
                "hubSkinDecimal": hub_skin,
                "intendedSkins": intended_skins,
            }
        )
        return False, {
            "ok": False,
            "code": "skin_mismatch",
            "error": msg,
            "hubSkinDecimal": hub_skin,
            "intendedSkins": intended_skins,
        }

    emit(
        {
            "type": "progress",
            "step": "usb-flash-check-skin",
            "status": "ok",
            "hubSkinDecimal": hub_skin,
            "intendedSkins": intended_skins,
            "firmwareBefore": sysinfo_summary.get("fwVer", ""),
        }
    )

    # Execute firmware upload non-interactively (--yes)
    usb_args.firmware_file = str(bundle.path)
    usb_args.yes = True
    emit({"type": "step", "step": "usb-flash-upload", "message": f"Uploading {bundle.path.name} over USB HID (--yes non-interactive)"})
    try:
        with silence_library_stdout() as sink, usb.usb_process_lock():
            bridge = usb.HarmonyUsbBridge(usb_args)
            usb.run_flash_firmware(bridge, usb_args)
        raw_out = sink.getvalue()
    except Exception as exc:
        msg = mask_free_text(str(exc), mask)
        wedge = is_usb_wedge_error(str(exc))
        emit({"type": "progress", "step": "usb-flash-upload", "status": "failed", "error": msg, "usbWedge": wedge})
        return False, {"ok": False, "code": "flash_upload_failed", "error": msg, "usbWedge": wedge}

    flash_summary: dict[str, Any] = {}
    decoder = json.JSONDecoder()
    idx = 0
    while idx < len(raw_out):
        brace = raw_out.find("{", idx)
        if brace < 0:
            break
        try:
            obj, end = decoder.raw_decode(raw_out, brace)
            if isinstance(obj, dict) and obj.get("action") == "flash-firmware":
                flash_summary = obj
            idx = end
        except json.JSONDecodeError:
            idx = brace + 1

    images = flash_summary.get("images", []) if isinstance(flash_summary, dict) else []
    boot_updater_handoff = any(
        isinstance(img, dict) and img.get("resultMode") == "bootUpdaterHandoff" for img in images
    )
    handoff_ok = bool(flash_summary.get("usbHandoffOk", True))

    emit(
        {
            "type": "progress",
            "step": "usb-flash-upload",
            "status": "ok" if handoff_ok else "failed",
            "usbHandoffOk": handoff_ok,
            "bootUpdaterHandoff": boot_updater_handoff,
            "images": images,
        }
    )

    post_reboot_verified = False
    post_reboot_fw = ""
    if handoff_ok and not skip_post_reboot_verify and verify_timeout_s > 0:
        emit(
            {
                "type": "step",
                "step": "usb-flash-verify",
                "message": f"Waiting for hub reboot and verifying firmware {REQUIRED_FIRMWARE}",
            }
        )
        deadline = time.monotonic() + verify_timeout_s
        while time.monotonic() < deadline:
            try:
                with silence_library_stdout():
                    transport = usb.UsbHbusTransport(usb_args)
                    verify_reply = transport.call("connect.sysinfo?get", {}, timeout=8)
                verify_summary = summarize_sysinfo_reply(verify_reply, mask=mask)
                post_reboot_fw = str(verify_summary.get("fwVer") or "")
                if post_reboot_fw:
                    post_reboot_verified = post_reboot_fw == REQUIRED_FIRMWARE
                    break
            except Exception:
                time.sleep(1.0)

        emit(
            {
                "type": "progress",
                "step": "usb-flash-verify",
                "status": "ok" if post_reboot_verified else "pending",
                "postRebootFirmware": post_reboot_fw,
                "postRebootVerified": post_reboot_verified,
                "requiredFirmware": REQUIRED_FIRMWARE,
            }
        )

    out_summary = {
        "ok": handoff_ok and (post_reboot_verified or skip_post_reboot_verify or verify_timeout_s <= 0),
        "bundle": bundle_summary,
        "hubSkinDecimal": hub_skin,
        "intendedSkins": intended_skins,
        "usbHandoffOk": handoff_ok,
        "bootUpdaterHandoff": boot_updater_handoff,
        "images": images,
        "reboot": bool(flash_summary.get("reboot", True)),
        "postRebootFirmware": post_reboot_fw,
        "postRebootVerified": post_reboot_verified,
        "requiredFirmware": REQUIRED_FIRMWARE,
    }
    return bool(out_summary["ok"]), out_summary


def run_usb_tde_enable_action(
    *,
    usb_args: argparse.Namespace,
    mask: bool,
    emit: Callable[[dict[str, Any]], None],
) -> tuple[bool, dict[str, Any]]:
    devices, summarized_devices, enum_error = resolve_single_usb_device(usb_args, mask=mask, emit=emit)
    if enum_error:
        return False, {"ok": False, "connected": False, "devices": summarized_devices, "error": enum_error}

    # Step 1: Write "1" to /tde/enable with data_length_mode="length" (length byte 0x01; 0x00 removes the marker!)
    emit(
        {
            "type": "step",
            "step": "usb-tde-write",
            "message": "Writing '1' to /tde/enable over USB HID with secondary-packet length byte 0x01 (data_length_mode='length')",
        }
    )
    try:
        with silence_library_stdout(), usb.usb_process_lock():
            bridge = usb.HarmonyUsbBridge(usb_args)
            handle, device = bridge.open_handle()
            try:
                handle_id = usb.raw_open_write_file_on_handle(bridge, handle, device, "/tde/enable", 1, 60000)
                responses = bridge.raw_write_data_on_handle(
                    handle,
                    device,
                    handle_id,
                    b"1",
                    60000,
                    packets_per_chunk=50,
                    packet_count_width="word",
                    label="/tde/enable",
                    data_length_mode="length",
                )
                usb.raw_close_file_on_handle(bridge, handle, device, handle_id, "/tde/enable", 30000)
            finally:
                handle.close()
        write_acks = [usb.raw_write_ack_summary(r, expected_handle_id=handle_id) for r in responses]
        emit({"type": "progress", "step": "usb-tde-write", "status": "ok", "writeAcks": write_acks, "dataLengthMode": "length"})
    except Exception as exc:
        msg = mask_free_text(str(exc), mask)
        wedge = is_usb_wedge_error(str(exc))
        emit({"type": "progress", "step": "usb-tde-write", "status": "failed", "error": msg, "usbWedge": wedge})
        return False, {"ok": False, "error": msg, "usbWedge": wedge}

    # Step 2: Read back /tde/enable and verify it reads "1"
    emit({"type": "step", "step": "usb-tde-readback", "message": "Reading back /tde/enable over USB HID to verify '1'"})
    try:
        with silence_library_stdout(), usb.usb_process_lock():
            bridge = usb.HarmonyUsbBridge(usb_args)
            read = usb.raw_read_file(bridge, "/tde/enable", 50, max(usb_args.timeout_ms, 25000))
        tde_text = usb.decode_raw_text(read.data).strip()
        if tde_text != "1":
            msg = f"/tde/enable read-back returned {tde_text!r} instead of '1'"
            emit({"type": "progress", "step": "usb-tde-readback", "status": "failed", "tdeReadback": tde_text, "error": msg})
            return False, {"ok": False, "tdeReadback": tde_text, "error": msg}
        emit({"type": "progress", "step": "usb-tde-readback", "status": "ok", "tdeReadback": tde_text})
    except Exception as exc:
        msg = mask_free_text(str(exc), mask)
        wedge = is_usb_wedge_error(str(exc))
        emit({"type": "progress", "step": "usb-tde-readback", "status": "failed", "error": msg, "usbWedge": wedge})
        return False, {"ok": False, "error": msg, "usbWedge": wedge}

    # Step 3: Verify ../../etc/tdeenable via connect.jsonfiletransfer?get; if 598 (empty file), write fallback 1
    emit({"type": "step", "step": "usb-tde-marker-verify", "message": "Checking ../../etc/tdeenable over USB hbus jsonfiletransfer"})
    fallback_written = False
    try:
        timeout_sec = max(5, min(30, usb_args.timeout_ms // 1000))
        with silence_library_stdout():
            transport = usb.UsbHbusTransport(usb_args)
            jft_reply = transport.call(
                "connect.jsonfiletransfer?get",
                {"path": "../../etc", "file": "tdeenable"},
                timeout=timeout_sec,
            )

        inner = jft_reply.get("data") if isinstance(jft_reply, dict) else {}
        code_str = str(
            inner.get("errorCode", jft_reply.get("code", ""))
            if isinstance(inner, dict) and "errorCode" in inner
            else jft_reply.get("code", "")
        )
        payload_str = json.dumps(inner) if isinstance(inner, dict) else str(inner or "")

        if code_str == "594":
            msg = "connect.jsonfiletransfer?get still returned 594 (production mode) after /tde/enable write."
            emit({"type": "progress", "step": "usb-tde-marker-verify", "status": "failed", "code": code_str, "error": msg})
            return False, {"ok": False, "tdeReadback": tde_text, "code": code_str, "error": msg}

        needs_fallback = code_str == "598" or (code_str == "200" and "1" not in payload_str)
        if needs_fallback:
            emit(
                {
                    "type": "step",
                    "step": "usb-tde-marker-fallback",
                    "message": "Writing fallback marker 1 to ../../etc/tdeenable because /etc/tdeenable read back empty (598)",
                }
            )
            with silence_library_stdout():
                transport = usb.UsbHbusTransport(usb_args)
                transport.call(
                    "connect.jsonfiletransfer?put",
                    {"path": "../../etc", "file": "tdeenable", "content": 1},
                    timeout=timeout_sec,
                )
                verify_reply = transport.call(
                    "connect.jsonfiletransfer?get",
                    {"path": "../../etc", "file": "tdeenable"},
                    timeout=timeout_sec,
                )
            fallback_written = True
            v_inner = verify_reply.get("data") if isinstance(verify_reply, dict) else {}
            v_code = str(
                v_inner.get("errorCode", verify_reply.get("code", ""))
                if isinstance(v_inner, dict) and "errorCode" in v_inner
                else verify_reply.get("code", "")
            )
            v_payload = json.dumps(v_inner) if isinstance(v_inner, dict) else str(v_inner or "")
            if v_code != "200" or "1" not in v_payload:
                msg = f"Fallback ../../etc/tdeenable verification failed: code={v_code}"
                emit({"type": "progress", "step": "usb-tde-marker-fallback", "status": "failed", "error": msg})
                return False, {"ok": False, "tdeReadback": tde_text, "fallbackWritten": True, "error": msg}
            emit({"type": "progress", "step": "usb-tde-marker-fallback", "status": "ok", "code": v_code})

        summary = {
            "ok": True,
            "tdeReadback": tde_text,
            "dataLengthMode": "length",
            "markerVerified": True,
            "fallbackWritten": fallback_written,
        }
        emit({"type": "progress", "step": "usb-tde-marker-verify", "status": "ok", "tdeEnable": summary})
        return True, summary
    except Exception as exc:
        msg = mask_free_text(str(exc), mask)
        wedge = is_usb_wedge_error(str(exc))
        emit({"type": "progress", "step": "usb-tde-marker-verify", "status": "failed", "error": msg, "usbWedge": wedge})
        return False, {"ok": False, "tdeReadback": tde_text, "error": msg, "usbWedge": wedge}


def run_usb_provision_local_action(
    *,
    usb_args: argparse.Namespace,
    remote_id_value: Any,
    allow_numeric_str: bool,
    account_id: str,
    hub_name: str,
    email: str,
    no_reboot: bool,
    mask: bool,
    emit: Callable[[dict[str, Any]], None],
) -> tuple[bool, dict[str, Any]]:
    try:
        remote_id_int = validate_positive_remote_id(remote_id_value, allow_numeric_str=allow_numeric_str)
    except ValueError as exc:
        msg = str(exc)
        emit({"type": "error", "step": "usb-provision-local", "code": "invalid_remote_id", "message": msg})
        return False, {"ok": False, "code": "invalid_remote_id", "error": msg}

    # Guarantee remoteId is an int (never str or bool)
    assert type(remote_id_int) is int and remote_id_int > 0

    clean_account_id = (account_id or f"hub-local-{remote_id_int}").strip()
    clean_name = (hub_name or "Harmony Hub").strip()
    clean_email = (email or "hub@local").strip()

    preferences = {
        "accountId": clean_account_id,
        "authToken": f"local-offline-token-{remote_id_int}",
        "configStale": True,
        "mode": 3,
        "name": clean_name,
        "susChannel": "",
        "remoteId": remote_id_int,
        "discoveryServerUri": DEFAULT_DISCOVERY_URI,
        "discoveryServerUriCF": DEFAULT_DISCOVERY_URI_CF,
        "email": clean_email,
        "language": "en",
    }

    devices, summarized_devices, enum_error = resolve_single_usb_device(usb_args, mask=mask, emit=emit)
    if enum_error:
        return False, {"ok": False, "connected": False, "devices": summarized_devices, "error": enum_error}

    emit(
        {
            "type": "step",
            "step": "usb-provision-write",
            "message": "Writing local mode-3 provisioning preferences (/data/luaworks/provision/preferences) with numeric remoteId",
        }
    )
    timeout_sec = max(5, min(30, usb_args.timeout_ms // 1000))
    try:
        with silence_library_stdout():
            transport = usb.UsbHbusTransport(usb_args)
            put_reply = transport.call(
                "connect.jsonfiletransfer?put",
                {
                    "path": "../../data/luaworks/provision",
                    "file": "preferences",
                    "content": preferences,
                },
                timeout=timeout_sec,
            )
            read_reply = transport.call(
                "connect.jsonfiletransfer?get",
                {"path": "../../data/luaworks/provision", "file": "preferences"},
                timeout=timeout_sec,
            )

        put_code = str(put_reply.get("code", ""))
        read_data = extract_hbus_data_dict(read_reply)
        if put_code not in ("200", "") or read_data.get("mode") != 3 or type(read_data.get("remoteId")) is not int:
            msg = f"Local provisioning preferences read-back validation failed (put_code={put_code})"
            emit({"type": "progress", "step": "usb-provision-write", "status": "failed", "error": msg})
            return False, {"ok": False, "error": msg}

        emit(
            {
                "type": "progress",
                "step": "usb-provision-write",
                "status": "ok",
                "mode": 3,
                "remoteIdType": "number",
                "remoteId": mask_id(remote_id_int, "hub-id") if mask else remote_id_int,
            }
        )
    except Exception as exc:
        msg = mask_free_text(str(exc), mask)
        wedge = is_usb_wedge_error(str(exc))
        emit({"type": "progress", "step": "usb-provision-write", "status": "failed", "error": msg, "usbWedge": wedge})
        return False, {"ok": False, "error": msg, "usbWedge": wedge}

    reboot_sent = False
    if not no_reboot:
        emit({"type": "step", "step": "usb-provision-reboot", "message": "Sending USB device-control reboot (0xFF/0x00) to activate mode-3 provisioning"})
        try:
            with silence_library_stdout(), usb.usb_process_lock():
                bridge = usb.HarmonyUsbBridge(usb_args)
                handle, device = bridge.open_handle()
                try:
                    usb.raw_reboot_device_on_handle(bridge, handle, device)
                    reboot_sent = True
                finally:
                    handle.close()
            emit({"type": "progress", "step": "usb-provision-reboot", "status": "ok", "rebootSent": True})
        except Exception as exc:
            msg = mask_free_text(str(exc), mask)
            emit({"type": "progress", "step": "usb-provision-reboot", "status": "warning", "warning": msg})

    emit({"type": "step", "step": "usb-provision-verify", "message": "Verifying setup.account?getProvisionInfo reports mode 3 and numeric activeRemoteId"})
    try:
        with silence_library_stdout():
            transport = usb.UsbHbusTransport(usb_args)
            prov_reply = transport.call("setup.account?getProvisionInfo", {}, timeout=timeout_sec)
        prov_summary = summarize_provision_info_reply(prov_reply, mask=mask)
        verified = (
            bool(prov_summary.get("ok"))
            and bool(prov_summary.get("provisioned"))
            and prov_summary.get("mode") == 3
            and prov_summary.get("remoteIdType") == "number"
        )
        if not verified:
            msg = "getProvisionInfo verification did not report mode 3 with a numeric activeRemoteId"
            emit({"type": "progress", "step": "usb-provision-verify", "status": "failed", "provisionInfo": prov_summary, "error": msg})
            return False, {"ok": False, "provisionInfo": prov_summary, "error": msg}

        summary = {
            "ok": True,
            "mode": 3,
            "remoteId": mask_id(remote_id_int, "hub-id") if mask else remote_id_int,
            "remoteIdType": "number",
            "accountId": mask_id(clean_account_id, "account-id") if mask else clean_account_id,
            "discoveryServerUri": DEFAULT_DISCOVERY_URI,
            "rebootSent": reboot_sent,
            "provisionInfo": prov_summary,
        }
        emit({"type": "progress", "step": "usb-provision-verify", "status": "ok", "provisionLocal": summary})
        return True, summary
    except Exception as exc:
        msg = mask_free_text(str(exc), mask)
        wedge = is_usb_wedge_error(str(exc))
        emit({"type": "progress", "step": "usb-provision-verify", "status": "failed", "error": msg, "usbWedge": wedge})
        return False, {"ok": False, "error": msg, "usbWedge": wedge}


def run_usb_seed_automation_action(
    *,
    usb_args: argparse.Namespace,
    remote_id_value: Any,
    account_id: str,
    mask: bool,
    emit: Callable[[dict[str, Any]], None],
) -> tuple[bool, dict[str, Any]]:
    devices, summarized_devices, enum_error = resolve_single_usb_device(usb_args, mask=mask, emit=emit)
    if enum_error:
        return False, {"ok": False, "connected": False, "devices": summarized_devices, "error": enum_error}

    timeout_sec = max(5, min(30, usb_args.timeout_ms // 1000))
    resolved_remote_id: int | None = None
    if remote_id_value is not None and str(remote_id_value).strip() != "":
        try:
            resolved_remote_id = validate_positive_remote_id(remote_id_value, allow_numeric_str=True)
        except ValueError as exc:
            emit({"type": "error", "step": "usb-seed-automation", "code": "invalid_remote_id", "message": str(exc)})
            return False, {"ok": False, "code": "invalid_remote_id", "error": str(exc)}

    resolved_account_id = (account_id or "").strip()
    if resolved_remote_id is None or not resolved_account_id:
        try:
            with silence_library_stdout():
                transport = usb.UsbHbusTransport(usb_args)
                prov_reply = transport.call("setup.account?getProvisionInfo", {}, timeout=timeout_sec)
            prov_data = extract_hbus_data_dict(prov_reply)
            if resolved_remote_id is None:
                raw_rid = prov_data.get("activeRemoteId", prov_data.get("remoteId"))
                resolved_remote_id = validate_positive_remote_id(raw_rid, allow_numeric_str=True)
            if not resolved_account_id:
                resolved_account_id = str(prov_data.get("accountId") or f"hub-local-{resolved_remote_id}").strip()
        except Exception as exc:
            msg = f"Could not resolve provisioned remoteId/accountId for AutomationConfig seed: {mask_free_text(str(exc), mask)}"
            emit({"type": "error", "step": "usb-seed-automation", "code": "unprovisioned_hub", "message": msg})
            return False, {"ok": False, "code": "unprovisioned_hub", "error": msg}

    remote_id_str = str(resolved_remote_id)
    uri = f"dynamite://HomeAutomationService/Config/{remote_id_str}"
    config_resource = {
        "id": remote_id_str,
        "enableXMPP": 1,
        "account_uri": f"harmony://Account/{resolved_account_id}",
        "devices": {},
        "programs": {},
        "maps": {},
        "scenes": {},
        "scenes2": {},
        "groups": {},
        "gateways": {},
        "unknownDevices": {},
    }

    emit(
        {
            "type": "step",
            "step": "usb-seed-automation",
            "message": "Seeding minimal AutomationConfig resource over USB hbus so harmony.automation?discover succeeds",
        }
    )
    method_used = "proxy.resource?put"
    try:
        with silence_library_stdout():
            transport = usb.UsbHbusTransport(usb_args)
            put_reply = transport.call("proxy.resource?put", {"uri": uri, "resource": config_resource}, timeout=max(30, timeout_sec))
            put_inner = put_reply.get("data") if isinstance(put_reply, dict) else {}
            put_err = str(put_inner.get("errorCode", put_reply.get("code", "200"))) if isinstance(put_inner, dict) else str(put_reply.get("code", "200"))
            if put_err not in ("200", "204", ""):
                method_used = "connect.jsonfiletransfer?put"
                transport.call(
                    "connect.jsonfiletransfer?put",
                    {"path": "../../data/resources", "file": "AutomationConfig.json", "content": config_resource},
                    timeout=timeout_sec,
                )

            verify_reply = transport.call(
                "connect.jsonfiletransfer?get",
                {"path": "../../data/resources", "file": "AutomationConfig.json"},
                timeout=timeout_sec,
            )

        v_inner = verify_reply.get("data") if isinstance(verify_reply, dict) else {}
        v_code = str(
            v_inner.get("errorCode", verify_reply.get("code", "200"))
            if isinstance(v_inner, dict) and "errorCode" in v_inner
            else verify_reply.get("code", "200")
        )
        if v_code not in ("200", ""):
            msg = f"AutomationConfig.json read-back failed with code={v_code}"
            emit({"type": "progress", "step": "usb-seed-automation", "status": "failed", "error": msg})
            return False, {"ok": False, "error": msg}

        summary = {
            "ok": True,
            "method": method_used,
            "uri": mask_id(uri, "automation-uri") if mask else uri,
            "remoteId": mask_id(resolved_remote_id, "hub-id") if mask else resolved_remote_id,
            "enableXMPP": 1,
            "verified": True,
        }
        emit({"type": "progress", "step": "usb-seed-automation", "status": "ok", "automationConfig": summary})
        return True, summary
    except Exception as exc:
        msg = mask_free_text(str(exc), mask)
        wedge = is_usb_wedge_error(str(exc))
        emit({"type": "progress", "step": "usb-seed-automation", "status": "failed", "error": msg, "usbWedge": wedge})
        return False, {"ok": False, "error": msg, "usbWedge": wedge}


def run_root_action(
    *,
    action: str,
    host: str,
    usb_args: argparse.Namespace,
    hbus_port: int,
    xmpp_port: int,
    ssh_port: int,
    ssh_wait: int,
    private_key: str,
    pubkey: str,
    hub_id: str,
    ignore_saved_hub_id: bool,
    mask: bool,
    emit: Callable[[dict[str, Any]], None],
) -> tuple[bool, dict[str, Any]]:
    clean_host = (host or "").strip()
    if not clean_host:
        emit({"type": "error", "step": action, "code": "missing_host", "message": f"--hub-host is required for --action {action}."})
        return False, {"ok": False, "code": "missing_host", "error": f"--hub-host is required for --action {action}."}

    transport_map = {
        "lan-root-xmpp": "xmpp",
        "usb-root": "usb",
        "post-root": "post",
    }
    transport_mode = transport_map[action]
    experimental = transport_mode == "post"

    if transport_mode == "usb":
        devices, summarized_devices, enum_error = resolve_single_usb_device(usb_args, mask=mask, emit=emit)
        if enum_error:
            return False, {"ok": False, "connected": False, "devices": summarized_devices, "error": enum_error}
        # Pre-check /rf/deviceinfo before USB hbus root (per docs/FRESH_HUB_ACTIVATION.md)
        emit({"type": "step", "step": "usb-preflight", "message": "Running USB HID preflight (/rf/deviceinfo) before usb-root"})
        try:
            with silence_library_stdout(), usb.usb_process_lock():
                preflight_bridge = usb.HarmonyUsbBridge(usb_args)
                usb.raw_read_file(preflight_bridge, usb.RAW_DEVICE_INFO_PATH, 50, max(usb_args.timeout_ms, 12000))
            emit({"type": "progress", "step": "usb-preflight", "status": "ok"})
        except Exception as exc:
            msg = mask_free_text(str(exc), mask)
            wedge = is_usb_wedge_error(str(exc))
            emit({"type": "progress", "step": "usb-preflight", "status": "failed", "error": msg, "usbWedge": wedge})
            return False, {"ok": False, "error": msg, "usbWedge": wedge}

    priv_path = pathlib.Path(private_key).expanduser() if private_key.strip() else lan.default_key_path()
    pub_path = pathlib.Path(pubkey).expanduser() if pubkey.strip() else pathlib.Path(str(priv_path) + ".pub")
    dropbear_path = SCRIPT_DIR / "dropbearmulti"

    lan_argv = [
        "--host",
        clean_host,
        "--transport",
        transport_mode,
        "--usb-backend",
        usb_args.backend,
        "--usb-device-path",
        usb_args.device_path,
        "--xmpp-port",
        str(xmpp_port),
        "--hbus-port",
        str(hbus_port),
        "--dropbearmulti",
        str(dropbear_path),
        "--private-key",
        str(priv_path),
        "--pubkey",
        str(pub_path),
        "--ssh-wait",
        str(max(5, ssh_wait)),
        "--no-shell",
    ]
    if transport_mode in ("usb", "post") or ignore_saved_hub_id:
        lan_argv.append("--ignore-saved-hub-id")
    if hub_id.strip():
        lan_argv.extend(["--hub-id", hub_id.strip()])

    emit(
        {
            "type": "step",
            "step": action,
            "experimental": experimental,
            "message": (
                f"Installing persistent Dropbear root SSH over {transport_mode} (--no-shell"
                + (", experimental unproven POST transport)" if experimental else ")")
            ),
        }
    )

    try:
        with silence_library_stdout():
            lan.main(lan_argv)
        ssh_open = lan.is_port_open(clean_host, ssh_port, timeout=3.0)
        summary = {
            "ok": True,
            "action": action,
            "transport": transport_mode,
            "experimental": experimental,
            "host": mask_ip(clean_host) if mask else clean_host,
            "sshPort": ssh_port,
            "sshPortOpen": ssh_open,
            "privateKeyPath": str(priv_path),
            "publicKeyPath": str(pub_path),
            "noShell": True,
        }
        emit({"type": "progress", "step": action, "status": "ok", "root": summary})
        return True, summary
    except BaseException as exc:
        if isinstance(exc, KeyboardInterrupt):
            raise
        msg = mask_free_text(str(exc), mask)
        wedge = is_usb_wedge_error(str(exc))
        emit({"type": "progress", "step": action, "status": "failed", "error": msg, "usbWedge": wedge, "experimental": experimental})
        return False, {"ok": False, "transport": transport_mode, "experimental": experimental, "error": msg, "usbWedge": wedge}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Structured NDJSON bridge for Melodious Root Wizard",
        allow_abbrev=False,
    )
    parser.add_argument("--action", choices=ALLOWED_ACTIONS, default="probe")
    parser.add_argument("--confirm-action", default="", help="Required confirmation matching --action for any state-changing action")
    parser.add_argument("--allow-unproven-post", action="store_true", help="Explicitly unlock experimental post-root action")
    parser.add_argument("--hub-host", "--host", dest="hub_host", default="")
    parser.add_argument("--usb-backend", "--backend", dest="usb_backend", choices=("auto", "hidapi", "hidraw", "winhid"), default="auto")
    parser.add_argument("--usb-device-path", "--device-path", dest="usb_device_path", default="")
    parser.add_argument("--vendor-id", default="046D")
    parser.add_argument("--product-id", default="C129")
    parser.add_argument("--timeout-ms", type=int, default=12000)
    parser.add_argument("--hbus-port", type=int, default=8088)
    parser.add_argument("--xmpp-port", type=int, default=5222)
    parser.add_argument("--ssh-port", type=int, default=22)
    parser.add_argument("--webui-port", type=int, default=8080)
    parser.add_argument("--ssh-wait", type=int, default=120)
    parser.add_argument("--skip-usb", action="store_true", help="Run LAN-only probes without touching USB")
    # Wi-Fi scan / connect options (NEVER accept --wifi-password on CLI argv!)
    parser.add_argument("--ssid", default="")
    parser.add_argument("--encryption", default="WPA2-PSK")
    parser.add_argument("--no-save", action="store_true")
    ssid_group = parser.add_mutually_exclusive_group()
    ssid_group.add_argument("--show-ssids", dest="show_ssids", action="store_true", default=True)
    ssid_group.add_argument("--hide-ssids", dest="show_ssids", action="store_false")
    # Firmware flash options
    parser.add_argument("--firmware-file", default="")
    parser.add_argument("--verify-timeout-s", type=int, default=90)
    parser.add_argument("--skip-post-reboot-verify", action="store_true")
    # Local provisioning / AutomationConfig / root options
    parser.add_argument("--remote-id", default="")
    parser.add_argument("--account-id", default="")
    parser.add_argument("--hub-name", default="Harmony Hub")
    parser.add_argument("--email", default="hub@local")
    parser.add_argument("--no-reboot", action="store_true")
    parser.add_argument("--private-key", default="")
    parser.add_argument("--pubkey", default="")
    parser.add_argument("--hub-id", default="")
    parser.add_argument("--ignore-saved-hub-id", action="store_true")

    mask_group = parser.add_mutually_exclusive_group()
    mask_group.add_argument("--mask", dest="mask", action="store_true", default=True, help="Mask MAC/IP/SSID/hub-id/RF-serials (default)")
    mask_group.add_argument("--no-mask", dest="mask", action="store_false", help="Do not mask identifiers")
    return parser


def run_wizard_bridge(
    argv: list[str] | None = None,
    *,
    stream: Any = None,
    stdin_stream: Any = None,
) -> int:
    secrets_sink: list[str] = []
    emit = make_emitter(stream, secrets=secrets_sink)
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else 2
        if code != 0:
            emit(
                {
                    "type": "error",
                    "step": "args",
                    "code": "invalid_args",
                    "message": "Invalid or unsupported wizard_bridge arguments.",
                }
            )
        return code

    if args.timeout_ms <= 0:
        emit({"type": "error", "step": "args", "code": "invalid_timeout", "message": "--timeout-ms must be positive"})
        return 2

    if args.action in MUTATING_ACTIONS:
        if args.confirm_action != args.action:
            emit(
                {
                    "type": "error",
                    "step": "args",
                    "code": "confirmation_required",
                    "message": f"State-changing action '{args.action}' requires explicit '--confirm-action {args.action}'.",
                }
            )
            return 2
        if args.action == "post-root" and not args.allow_unproven_post:
            emit(
                {
                    "type": "error",
                    "step": "args",
                    "code": "unproven_post_blocked",
                    "message": "Action 'post-root' is experimental and unproven on a full root run; pass --allow-unproven-post to enable it.",
                }
            )
            return 2

    started_at = time.time()
    usb_args = make_usb_args(
        backend=args.usb_backend,
        device_path=args.usb_device_path,
        vendor_id=args.vendor_id,
        product_id=args.product_id,
        timeout_ms=args.timeout_ms,
    )

    try:
        # Handle dedicated Slice 2 actions
        if args.action == "usb-wifi-scan":
            ok, scan_res = run_usb_wifi_scan_action(
                usb_args=usb_args,
                show_ssids=args.show_ssids,
                mask=args.mask,
                emit=emit,
            )
            emit(
                {
                    "type": "result",
                    "action": args.action,
                    "ok": ok,
                    "masked": args.mask,
                    "elapsedMs": int((time.time() - started_at) * 1000),
                    "wifiScan": scan_res,
                }
            )
            return 0 if ok else 1

        if args.action == "usb-wifi-status":
            ok, status_res = run_usb_wifi_status_action(
                usb_args=usb_args,
                show_ssids=args.show_ssids,
                mask=args.mask,
                emit=emit,
            )
            emit(
                {
                    "type": "result",
                    "action": args.action,
                    "ok": ok,
                    "masked": args.mask,
                    "elapsedMs": int((time.time() - started_at) * 1000),
                    "wifiStatus": status_res,
                }
            )
            return 0 if ok else 1

        if args.action == "usb-wifi-connect":
            try:
                stdin_payload = read_stdin_json(stdin_stream)
            except Exception as exc:
                emit(
                    {
                        "type": "error",
                        "step": "usb-wifi-connect",
                        "code": "invalid_stdin_json",
                        "message": f"Failed to read Wi-Fi credentials JSON from stdin: {exc}",
                    }
                )
                return 2
            ok, wifi_res = run_usb_wifi_connect_action(
                usb_args=usb_args,
                stdin_payload=stdin_payload,
                cli_ssid=args.ssid,
                cli_encryption=args.encryption,
                no_save=args.no_save,
                show_ssids=args.show_ssids,
                mask=args.mask,
                secrets_sink=secrets_sink,
                emit=emit,
            )
            emit(
                {
                    "type": "result",
                    "action": args.action,
                    "ok": ok,
                    "masked": args.mask,
                    "elapsedMs": int((time.time() - started_at) * 1000),
                    "wifiConnect": wifi_res,
                }
            )
            return 0 if ok else 1

        if args.action == "usb-factory-reset":
            ok, reset_res = run_usb_factory_reset_action(
                usb_args=usb_args,
                mask=args.mask,
                emit=emit,
            )
            emit(
                {
                    "type": "result",
                    "action": args.action,
                    "ok": ok,
                    "masked": args.mask,
                    "elapsedMs": int((time.time() - started_at) * 1000),
                    "factoryReset": reset_res,
                }
            )
            return 0 if ok else 1

        if args.action == "usb-flash-firmware":
            ok, flash_res = run_usb_flash_firmware_action(
                usb_args=usb_args,
                firmware_file=args.firmware_file,
                verify_timeout_s=args.verify_timeout_s,
                skip_post_reboot_verify=args.skip_post_reboot_verify,
                mask=args.mask,
                emit=emit,
            )
            emit(
                {
                    "type": "result",
                    "action": args.action,
                    "ok": ok,
                    "masked": args.mask,
                    "elapsedMs": int((time.time() - started_at) * 1000),
                    "firmwareFlash": flash_res,
                }
            )
            return 0 if ok else 1

        if args.action == "usb-tde-enable":
            ok, tde_res = run_usb_tde_enable_action(
                usb_args=usb_args,
                mask=args.mask,
                emit=emit,
            )
            emit(
                {
                    "type": "result",
                    "action": args.action,
                    "ok": ok,
                    "masked": args.mask,
                    "elapsedMs": int((time.time() - started_at) * 1000),
                    "tdeEnable": tde_res,
                }
            )
            return 0 if ok else 1

        if args.action == "usb-provision-local":
            remote_id_val: Any = args.remote_id
            allow_num_str = True
            account_id_val = args.account_id
            hub_name_val = args.hub_name
            email_val = args.email
            if stdin_stream is not None:
                try:
                    stdin_obj = read_stdin_json(stdin_stream)
                    if "remoteId" in stdin_obj:
                        remote_id_val = stdin_obj["remoteId"]
                        allow_num_str = False  # JSON stdin must carry a strict JSON number, never a string
                    if "accountId" in stdin_obj:
                        account_id_val = str(stdin_obj["accountId"])
                    if "name" in stdin_obj:
                        hub_name_val = str(stdin_obj["name"])
                    if "email" in stdin_obj:
                        email_val = str(stdin_obj["email"])
                except Exception:
                    pass

            ok, prov_local_res = run_usb_provision_local_action(
                usb_args=usb_args,
                remote_id_value=remote_id_val,
                allow_numeric_str=allow_num_str,
                account_id=account_id_val,
                hub_name=hub_name_val,
                email=email_val,
                no_reboot=args.no_reboot,
                mask=args.mask,
                emit=emit,
            )
            emit(
                {
                    "type": "result",
                    "action": args.action,
                    "ok": ok,
                    "masked": args.mask,
                    "elapsedMs": int((time.time() - started_at) * 1000),
                    "provisionLocal": prov_local_res,
                }
            )
            return 0 if ok else 1

        if args.action == "usb-seed-automation":
            ok, seed_res = run_usb_seed_automation_action(
                usb_args=usb_args,
                remote_id_value=args.remote_id if args.remote_id != "" else None,
                account_id=args.account_id,
                mask=args.mask,
                emit=emit,
            )
            emit(
                {
                    "type": "result",
                    "action": args.action,
                    "ok": ok,
                    "masked": args.mask,
                    "elapsedMs": int((time.time() - started_at) * 1000),
                    "automationConfig": seed_res,
                }
            )
            return 0 if ok else 1

        if args.action in ("lan-root-xmpp", "usb-root", "post-root"):
            ok, root_res = run_root_action(
                action=args.action,
                host=args.hub_host,
                usb_args=usb_args,
                hbus_port=args.hbus_port,
                xmpp_port=args.xmpp_port,
                ssh_port=args.ssh_port,
                ssh_wait=args.ssh_wait,
                private_key=args.private_key,
                pubkey=args.pubkey,
                hub_id=args.hub_id or args.remote_id,
                ignore_saved_hub_id=args.ignore_saved_hub_id,
                mask=args.mask,
                emit=emit,
            )
            emit(
                {
                    "type": "result",
                    "action": args.action,
                    "ok": ok,
                    "masked": args.mask,
                    "elapsedMs": int((time.time() - started_at) * 1000),
                    "root": root_res,
                }
            )
            return 0 if ok else 1

        # Read-only probe / classify actions
        usb_result: dict[str, Any] = {"ok": False, "skipped": True, "connected": False, "usbWedge": False}
        lan_result: dict[str, Any] = {"ok": False, "skipped": True}

        if args.action == "lan-provision-info":
            if not args.hub_host.strip():
                emit({"type": "error", "step": "lan-provision-info", "code": "missing_host", "message": "--hub-host is required for --action lan-provision-info"})
                return 2
            lan_result = run_lan_probes(
                host=args.hub_host,
                hbus_port=args.hbus_port,
                xmpp_port=args.xmpp_port,
                ssh_port=args.ssh_port,
                webui_port=args.webui_port,
                timeout_sec=max(3.0, args.timeout_ms / 1000.0),
                mask=args.mask,
                ports_check=False,
                emit=emit,
            )
            ok = bool(lan_result.get("provisionInfo", {}).get("ok"))
        else:
            if not args.skip_usb:
                usb_result = run_usb_probes(
                    action=args.action,
                    backend=args.usb_backend,
                    device_path=args.usb_device_path,
                    vendor_id=args.vendor_id,
                    product_id=args.product_id,
                    timeout_ms=args.timeout_ms,
                    mask=args.mask,
                    emit=emit,
                )
            if args.hub_host.strip() and args.action in ("probe", "classify"):
                lan_result = run_lan_probes(
                    host=args.hub_host,
                    hbus_port=args.hbus_port,
                    xmpp_port=args.xmpp_port,
                    ssh_port=args.ssh_port,
                    webui_port=args.webui_port,
                    timeout_sec=max(3.0, args.timeout_ms / 1000.0),
                    mask=args.mask,
                    ports_check=True,
                    emit=emit,
                )
            ok = bool(usb_result.get("ok")) or bool(lan_result.get("ok") and not lan_result.get("skipped"))

        classification = None
        if args.action == "classify":
            emit({"type": "step", "step": "classify", "message": "Evaluating dual-signal hub classification"})
            classification = classify_signals(usb_result, lan_result)
            emit({"type": "progress", "step": "classify", "status": "ok", "classification": classification})

        elapsed_ms = int((time.time() - started_at) * 1000)
        emit(
            {
                "type": "result",
                "action": args.action,
                "ok": ok,
                "masked": args.mask,
                "elapsedMs": elapsed_ms,
                "usb": usb_result,
                "lan": lan_result,
                "classification": classification,
            }
        )
        return 0 if ok else 1
    except Exception as exc:
        msg = mask_free_text(str(exc), args.mask, secrets_sink)
        emit({"type": "error", "step": "unhandled", "code": "bridge_exception", "message": msg})
        return 1


if __name__ == "__main__":
    raise SystemExit(run_wizard_bridge())
