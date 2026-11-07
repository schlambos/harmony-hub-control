#!/usr/bin/env python3
"""Read-only Home Assistant inventory for the Melodious HA-devices design.

Connects to Home Assistant's WebSocket API, reads the device registry, the
entity registry and the current states, groups entities by device, and writes
one JSON file. It never calls a service and never writes to Home Assistant.

The output is anonymised: serial numbers, unique IDs, identifiers,
connections, URLs, MAC addresses and IPv4 addresses are removed or replaced.
Use --anonymise to replace device and entity names with stable placeholders
as well.

Requirements: Python 3.10+ and aiohttp (``pip install aiohttp``).

Usage:

    HA_TOKEN=... python3 tools/ha_device_inventory.py \
        --url http://homeassistant.local:8123 \
        --out ha-inventory.json

The token is read from ``--token``, ``--token-file`` or the ``HA_TOKEN``
environment variable, in that order. Prefer the file or the environment so
the token does not appear in the process list.

Create a long-lived access token in Home Assistant under
Profile -> Security -> Long-lived access tokens. The token is only sent to
the Home Assistant URL you pass; it is never written to the output.

To inventory only the two proving targets:

    python3 tools/ha_device_inventory.py ... --device "LG" --device "Google"

``--device`` matches the device name, model, manufacturer or registry ID,
case-insensitively. Repeat it for several devices.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any

# aiohttp is imported inside fetch_inventory so the pure helpers below can be
# tested (and --help can run) without it.

# Attributes worth keeping for the merge profiles. Everything else is
# dropped: the design only needs capabilities and the few state fields the
# hub will display.
KEEP_ATTRIBUTES = {
    "activity_list",
    "app_id",
    "app_name",
    "assumed_state",
    "current_activity",
    "current_option",
    "device_class",
    "friendly_name",
    "is_volume_muted",
    "max",
    "media_artist",
    "media_title",
    "min",
    "options",
    "sound_output",
    "source",
    "source_list",
    "step",
    "supported_color_modes",
    "supported_features",
    "volume_level",
}

# Never keep these, even if they appear in an attribute we otherwise keep.
DROP_KEYS = {
    "access_token",
    "configuration_url",
    "connections",
    "identifiers",
    "ip_address",
    "latitude",
    "longitude",
    "mac",
    "password",
    "serial_number",
    "ssid",
    "token",
    "unique_id",
}

MAC_RE = re.compile(r"\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b")
IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
SECRET_RE = re.compile(r"(?i)(password|token|secret|key)\s*[:=]\s*\S+")


def redact_text(value: str) -> str:
    """Mask MAC addresses, IPv4 addresses and obvious secrets in a string."""
    value = MAC_RE.sub("<mac>", value)
    value = IPV4_RE.sub("<ip>", value)
    value = SECRET_RE.sub(r"\1=<redacted>", value)
    return value


def redact(value: Any, key: str = "") -> Any:
    """Recursively drop sensitive keys and mask addresses in strings."""
    if key.lower() in DROP_KEYS:
        return "<redacted>"
    if isinstance(value, dict):
        return {str(k): redact(v, str(k)) for k, v in value.items() if str(k).lower() not in DROP_KEYS}
    if isinstance(value, (list, tuple)):
        return [redact(item) for item in value]
    if isinstance(value, str):
        return redact_text(value)
    return value


def stable_placeholder(prefix: str, value: str, seen: dict[str, str]) -> str:
    """A stable, non-identifying name for --anonymise."""
    if value not in seen:
        seen[value] = f"{prefix} {len(seen) + 1}"
    return seen[value]


def stable_entity_placeholder(value: str, seen: dict[str, str]) -> str:
    """Keep the domain visible but hide the object id."""
    if value not in seen:
        domain = value.split(".", 1)[0]
        seen[value] = f"{domain}.entity_{sum(1 for key in seen if key.startswith(domain + '.')) + 1}"
    return seen[value]


async def ws_command(
    ws: aiohttp.ClientWebSocketResponse, message_id: int, command_type: str, **payload: Any
) -> Any:
    """Send one WebSocket command and return its result."""
    await ws.send_json({"id": message_id, "type": command_type, **payload})
    while True:
        message = await ws.receive_json()
        if message.get("id") != message_id:
            continue
        if not message.get("success"):
            raise RuntimeError(
                f"{command_type} failed: {(message.get('error') or {}).get('message', message)}"
            )
        return message.get("result")


async def fetch_inventory(url: str, token: str) -> dict[str, Any]:
    """Read the registries and states over Home Assistant's WebSocket API."""
    try:
        import aiohttp
    except ImportError as err:  # pragma: no cover - environment-specific
        raise RuntimeError(
            "This script needs aiohttp: python3 -m pip install aiohttp"
        ) from err

    ws_url = url.rstrip("/") + "/api/websocket"
    if ws_url.startswith("https://"):
        ws_url = "wss://" + ws_url[len("https://") :]
    elif ws_url.startswith("http://"):
        ws_url = "ws://" + ws_url[len("http://") :]

    timeout = aiohttp.ClientTimeout(total=60)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.ws_connect(ws_url, heartbeat=30) as ws:
            first = await ws.receive_json()
            if first.get("type") != "auth_required":
                raise RuntimeError(f"unexpected WebSocket greeting: {first}")
            await ws.send_json({"type": "auth", "access_token": token})
            auth = await ws.receive_json()
            if auth.get("type") != "auth_ok":
                raise RuntimeError(f"Home Assistant refused the token: {auth}")

            devices = await ws_command(ws, 1, "config/device_registry/list")
            entities = await ws_command(ws, 2, "config/entity_registry/list")
            states = await ws_command(ws, 3, "get_states")
            config = await ws_command(ws, 4, "get_config")
            return {
                "ha_version": config.get("version"),
                "devices": devices,
                "entities": entities,
                "states": states,
            }


def build_inventory(
    raw: dict[str, Any],
    device_filters: list[str],
    anonymise: bool,
) -> dict[str, Any]:
    """Group entities by device and keep only the fields the design needs."""
    states = {state["entity_id"]: state for state in raw["states"]}
    entity_entries = {entry["entity_id"]: entry for entry in raw["entities"]}
    by_device: dict[str, list[dict[str, Any]]] = {}
    unassigned: list[dict[str, Any]] = []

    def entity_record(entry: dict[str, Any]) -> dict[str, Any]:
        entity_id = entry["entity_id"]
        state = states.get(entity_id, {})
        attributes = state.get("attributes") or {}
        kept = {
            key: redact(value, key)
            for key, value in attributes.items()
            if key in KEEP_ATTRIBUTES
        }
        return {
            "entity_id": entity_id,
            "domain": entity_id.split(".", 1)[0],
            "platform": entry.get("platform"),
            "device_class": entry.get("device_class") or attributes.get("device_class"),
            "entity_category": entry.get("entity_category"),
            "original_name": entry.get("original_name"),
            "name": entry.get("name"),
            "disabled_by": entry.get("disabled_by"),
            "hidden_by": entry.get("hidden_by"),
            "supported_features": attributes.get("supported_features"),
            "state": state.get("state"),
            "attributes": kept,
        }

    for entry in raw["entities"]:
        device_id = entry.get("device_id")
        record = entity_record(entry)
        if device_id:
            by_device.setdefault(device_id, []).append(record)
        else:
            unassigned.append(record)

    selected = []
    filters = [text.lower() for text in device_filters if text]
    for device in raw["devices"]:
        haystack = " ".join(
            str(device.get(key) or "")
            for key in ("id", "name", "name_by_user", "manufacturer", "model", "model_id")
        ).lower()
        if filters and not any(text in haystack for text in filters):
            continue
        entities = sorted(by_device.get(device["id"], []), key=lambda item: item["entity_id"])
        if not entities:
            continue
        selected.append(
            {
                "id": device["id"],
                "name": device.get("name_by_user") or device.get("name"),
                "manufacturer": device.get("manufacturer"),
                "model": device.get("model"),
                "model_id": device.get("model_id"),
                "sw_version": device.get("sw_version"),
                "hw_version": device.get("hw_version"),
                "entry_type": device.get("entry_type"),
                "disabled_by": device.get("disabled_by"),
                "area_id": device.get("area_id"),
                "identifiers": "<redacted>",
                "connections": "<redacted>",
                "entities": entities,
            }
        )

    if filters:
        unassigned = [
            record
            for record in unassigned
            if any(text in record["entity_id"].lower() for text in filters)
        ]
    else:
        unassigned = sorted(unassigned, key=lambda item: item["entity_id"])

    if anonymise:
        device_names: dict[str, str] = {}
        entity_names: dict[str, str] = {}
        for device in selected:
            device["name"] = stable_placeholder("Device", str(device["name"]), device_names)
            device["id"] = stable_placeholder("device-id", str(device["id"]), device_names)
            for entity in device["entities"]:
                entity["entity_id"] = stable_entity_placeholder(
                    str(entity["entity_id"]), entity_names
                )
                entity["original_name"] = None
                entity["name"] = None
                entity["attributes"].pop("friendly_name", None)
        for entity in unassigned:
            entity["entity_id"] = stable_entity_placeholder(
                str(entity["entity_id"]), entity_names
            )
            entity["original_name"] = None
            entity["name"] = None
            entity["attributes"].pop("friendly_name", None)

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "ha_version": raw.get("ha_version"),
        "device_filters": device_filters,
        "anonymised": anonymise,
        "devices": selected,
        "unassigned_entities": unassigned,
    }


def print_summary(inventory: dict[str, Any]) -> None:
    """A short human-readable summary on stderr; JSON goes to the file."""
    for device in inventory["devices"]:
        print(
            f"{device['name']}  [{device.get('manufacturer')} / {device.get('model')}]",
            file=sys.stderr,
        )
        for entity in device["entities"]:
            features = entity.get("supported_features")
            suffix = f" features={features}" if features not in (None, 0) else ""
            print(
                f"  {entity['entity_id']}  {entity['domain']}  {entity.get('platform')}{suffix}",
                file=sys.stderr,
            )
    if inventory["unassigned_entities"]:
        print(
            f"{len(inventory['unassigned_entities'])} entities have no device registry entry",
            file=sys.stderr,
        )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", required=True, help="Home Assistant URL, e.g. http://homeassistant.local:8123")
    parser.add_argument(
        "--token",
        default=os.environ.get("HA_TOKEN"),
        help="long-lived access token (or set HA_TOKEN)",
    )
    parser.add_argument(
        "--token-file",
        help="file whose first line is the long-lived access token",
    )
    parser.add_argument("--out", default="ha-inventory.json", help="output JSON file")
    parser.add_argument(
        "--device",
        action="append",
        default=[],
        help="only devices whose name, model, manufacturer or id contains this text (repeatable)",
    )
    parser.add_argument(
        "--anonymise",
        action="store_true",
        help="replace device and entity names with stable placeholders",
    )
    return parser.parse_args(argv)


async def async_main(argv: list[str]) -> int:
    args = parse_args(argv)
    token = args.token
    if args.token_file:
        try:
            with open(args.token_file, encoding="utf-8") as handle:
                token = handle.readline().strip()
        except OSError as err:
            print(f"error: cannot read {args.token_file}: {err}", file=sys.stderr)
            return 1
    if not token:
        print(
            "error: give --token, --token-file or set HA_TOKEN",
            file=sys.stderr,
        )
        return 1
    try:
        raw = await fetch_inventory(args.url, token)
    except Exception as err:  # aiohttp errors, timeouts, auth refusals
        print(f"error: {err}", file=sys.stderr)
        return 1
    inventory = build_inventory(raw, args.device, args.anonymise)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(inventory, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print_summary(inventory)
    print(f"wrote {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(async_main(sys.argv[1:])))
