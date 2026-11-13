#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Matthew Gibbons (Melodious — LICENSE section 2)
"""Read-only NDJSON bridge over tools/hub-root for the Melodious Root Wizard.

Strictly read-only on any hub. Allowed hub operations only:
  - USB HID enumeration (046D:C129)
  - USB raw preflight (/rf/deviceinfo)
  - USB hbus connect.sysinfo?get
  - LAN HTTP POST :8088 setup.account?getProvisionInfo
  - LAN TCP port checks (:5222 XMPP, :22 SSH, :8080 Web UI)

No flashes, resets, writes, reboots, TDE/provision/root actions, or prompts.
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

ALLOWED_ACTIONS = (
    "probe",
    "classify",
    "usb-enumerate",
    "usb-preflight",
    "usb-sysinfo",
    "lan-provision-info",
)

REQUIRED_FIRMWARE = "4.15.600"

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


def mask_free_text(text: str, mask: bool = True) -> str:
    if not mask or not text:
        return text
    out = _MAC_RE.sub("XX:XX:XX:XX:XX:XX", text)
    out = _IPV4_RE.sub("<ip-redacted>", out)
    return out


def parse_skin_decimal(skin_value: Any) -> int | None:
    if skin_value is None:
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


def extract_sysinfo_fields(raw_reply: dict[str, Any]) -> dict[str, Any]:
    """Normalize the payload of connect.sysinfo?get across dict, body, or key=value forms."""
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
    features = fields.get("features") if isinstance(fields.get("features"), list) else []

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
    data: Any = reply.get("data") if isinstance(reply, dict) else None
    if isinstance(data, dict) and "body" in data and any(k in data for k in ("cmd", "errorCode", "errorcode")):
        body = data.get("body")
        if isinstance(body, str):
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                data = {}
        elif isinstance(body, dict):
            data = body
    if not isinstance(data, dict):
        data = {}

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
    discovery_server = str(data.get("discoveryServer") or data.get("discoveryServerCF") or "").strip()
    is_local_hint = bool(
        (account_id and "local" in account_id.lower())
        or (email and (email.lower().endswith("@local") or "local" in email.lower()))
    )
    is_provisioned = bool(mode_int == 3 or has_remote_id or account_id)

    return {
        "ok": True,
        "code": str(reply.get("code", 200)),
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


def classify_signals(usb_result: dict[str, Any], lan_result: dict[str, Any]) -> dict[str, Any]:
    """Compute a read-only classification summary from USB + LAN probe results."""
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
    usb_has_hub_id = bool(usb_preflight.get("hasHubId")) if isinstance(usb_preflight, dict) else False

    fw_ver = ""
    if isinstance(usb_sysinfo, dict) and usb_sysinfo.get("fwVer"):
        fw_ver = str(usb_sysinfo["fwVer"])

    if port_8080:
        verdict = "melodious-installed"
        reason = "Melodious web UI port 8080 is open."
    elif port_5222 and (lan_provisioned is not False):
        verdict = "provisioned-xmpp-on"
        reason = "XMPP port 5222 is open on a provisioned hub."
    elif lan_provisioned is True or usb_has_hub_id:
        verdict = "provisioned-local"
        reason = "Hub is provisioned (mode 3 / Hub ID present) with XMPP port 5222 closed."
    elif lan_provisioned is False or (usb_connected and isinstance(usb_preflight, dict) and usb_preflight.get("ok") and not usb_has_hub_id):
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


def make_emitter(stream: Any = None) -> Callable[[dict[str, Any]], None]:
    target = stream if stream is not None else sys.__stdout__

    def emit(event: dict[str, Any]) -> None:
        line = json.dumps(event, separators=(",", ":"), ensure_ascii=True)
        target.write(line + "\n")
        target.flush()

    return emit


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

    usb_args = usb.parse_args(usb_argv)
    emit({"type": "step", "step": "usb-enumerate", "message": "Enumerating Harmony Hub USB HID devices (046D:C129)"})

    try:
        with silence_library_stdout():
            bridge = usb.HarmonyUsbBridge(usb_args)
            devices = bridge.enumerate_devices()
    except Exception as exc:
        msg = mask_free_text(str(exc), mask)
        emit({"type": "progress", "step": "usb-enumerate", "status": "failed", "error": msg})
        return {
            "ok": False,
            "connected": False,
            "deviceCount": 0,
            "devices": [],
            "usbWedge": False,
            "error": msg,
        }

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

    result: dict[str, Any] = {
        "ok": True,
        "connected": len(devices) == 1,
        "deviceCount": len(devices),
        "devices": summarized_devices,
        "device": summarized_devices[0] if len(summarized_devices) == 1 else None,
        "preflight": None,
        "sysinfo": None,
        "usbWedge": False,
    }

    if action == "usb-enumerate":
        return result

    if len(devices) == 0:
        result["ok"] = False
        result["error"] = "No Harmony Hub USB HID device (046D:C129) found."
        return result

    if len(devices) > 1 and not device_path:
        result["ok"] = False
        result["error"] = f"Multiple Harmony Hub USB devices found ({len(devices)}); specify --usb-device-path."
        return result

    chosen = devices[0]
    usb_args.device_path = chosen.path
    usb_args.backend = chosen.backend

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

    # Step 2: Engine hbus connect.sysinfo?get over USB source 6.
    emit({"type": "step", "step": "usb-sysinfo", "message": "Querying connect.sysinfo?get over USB hbus"})
    try:
        timeout_sec = max(5, min(30, timeout_ms // 1000))
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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Read-only NDJSON bridge for Melodious Root Wizard (Detect & Classify)",
        allow_abbrev=False,
    )
    parser.add_argument("--action", choices=ALLOWED_ACTIONS, default="probe")
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
    parser.add_argument("--skip-usb", action="store_true", help="Run LAN-only probes without touching USB")
    mask_group = parser.add_mutually_exclusive_group()
    mask_group.add_argument("--mask", dest="mask", action="store_true", default=True, help="Mask MAC/IP/SSID/hub-id/RF-serials (default)")
    mask_group.add_argument("--no-mask", dest="mask", action="store_false", help="Do not mask identifiers")
    return parser


def run_wizard_bridge(argv: list[str] | None = None, *, stream: Any = None) -> int:
    emit = make_emitter(stream)
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else 2
        if code != 0:
            emit({"type": "error", "step": "args", "code": "invalid_args", "message": "Invalid or unsupported wizard_bridge arguments; only read-only probe/classify options are permitted."})
        return code

    if args.timeout_ms <= 0:
        emit({"type": "error", "step": "args", "code": "invalid_timeout", "message": "--timeout-ms must be positive"})
        return 2

    started_at = time.time()
    usb_result: dict[str, Any] = {"ok": False, "skipped": True, "connected": False, "usbWedge": False}
    lan_result: dict[str, Any] = {"ok": False, "skipped": True}

    try:
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
        msg = mask_free_text(str(exc), args.mask)
        emit({"type": "error", "step": "unhandled", "code": "bridge_exception", "message": msg})
        return 1


if __name__ == "__main__":
    raise SystemExit(run_wizard_bridge())
