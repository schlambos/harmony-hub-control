"""The Melodious hub's HTTP API, as this integration uses it."""

from __future__ import annotations

from typing import Any

import aiohttp


class HubError(Exception):
    """The hub couldn't be reached or didn't take the request."""


class HubRefused(HubError):
    """The hub's writer refused the device set (HTTP 422); retrying won't help."""


class HubClient:
    """codex_webui on the hub. Bodies are JSON with Content-Length; it ignores chunked ones."""

    def __init__(
        self,
        session: aiohttp.ClientSession,
        host: str,
        port: int,
        username: str | None = None,
        password: str | None = None,
    ) -> None:
        self._session = session
        self._base = f"http://{host}:{port}"
        self._auth = aiohttp.BasicAuth(username, password or "") if username else None

    async def _request(self, method: str, path: str, payload: Any = None, timeout: int = 20) -> Any:
        try:
            async with self._session.request(
                method,
                self._base + path,
                json=payload,
                auth=self._auth,
                timeout=aiohttp.ClientTimeout(total=timeout),
            ) as response:
                if response.status == 401:
                    raise HubError("the hub asked for a username and password")
                if response.status == 404:
                    raise HubError(f"the hub has no {path}; update Melodious on the hub")
                try:
                    body = await response.json(content_type=None)
                except ValueError:
                    body = None
                if response.status == 422:
                    raise HubRefused((body or {}).get("error") or "the hub refused the change")
                if response.status != 200 or not isinstance(body, dict):
                    detail = (body or {}).get("error") if isinstance(body, dict) else None
                    raise HubError(detail or f"the hub answered HTTP {response.status}")
                return body
        except (aiohttp.ClientError, TimeoutError) as err:
            raise HubError(f"could not reach the hub: {err}") from err

    async def device_names(self) -> set[str]:
        """Names of the hub's devices that aren't Home Assistant devices."""
        config = await self._request("GET", "/api/activity-config")
        names = set()
        for entry in (config.get("deviceList") or {}).get("DevicesWithFeatures") or []:
            device = entry.get("Device") or {}
            tag = str((device.get("AutoDetectedDevice") or {}).get("Id") or "")
            if device.get("Name") and not tag.startswith("melodious-ha-"):
                names.add(str(device["Name"]))
        return names

    async def commit(self, device_set: dict, dry_run: bool = False) -> dict:
        """Replace the hub's Home Assistant devices. The writer can take up to 45 s."""
        return await self._request("POST", "/api/ha-devices", {**device_set, "dryRun": dry_run}, timeout=120)
