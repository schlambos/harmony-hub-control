"""Melodious: Home Assistant entities as devices on a Melodious Harmony hub.

Each exposed entity becomes an ordinary Harmony device on the hub, so it can
sit in activities and on remote buttons. Its commands are IP commands: the
hub's engine posts {"device": <entity_id>, "command": <value>} to this
integration's webhook, which runs the matching service call. No Home
Assistant token lives on the hub; the webhook ID is the only secret.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from aiohttp import web

from homeassistant.components import persistent_notification, webhook
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST, CONF_PASSWORD, CONF_PORT, CONF_USERNAME, STATE_UNAVAILABLE
from homeassistant.core import CALLBACK_TYPE, Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_call_later, async_track_state_change_event
from homeassistant.helpers.start import async_at_started
from homeassistant.helpers.storage import Store

from .const import CONF_ENTITIES, CONF_HA_URL, CONF_WEBHOOK_ID, DOMAIN, PUSH_DELAY_SECONDS, RETRY_SECONDS
from .devices import Entity, allowed_values, build_device_set, service_call
from .hub import HubClient, HubError, HubRefused

_LOGGER = logging.getLogger(__name__)

type MelodiousConfigEntry = ConfigEntry[MelodiousRuntime]


def hub_client(hass: HomeAssistant, data: dict[str, Any]) -> HubClient:
    return HubClient(
        async_get_clientsession(hass),
        data[CONF_HOST],
        data[CONF_PORT],
        data.get(CONF_USERNAME) or None,
        data.get(CONF_PASSWORD) or None,
    )


class MelodiousRuntime:
    """Keeps the hub's Home Assistant devices in step with the exposed entities."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.client = hub_client(hass, entry.data)
        self.store: Store[dict] = Store(hass, 1, f"{DOMAIN}.{entry.entry_id}")
        # The set the hub last took, and the commands a webhook call may run.
        self.sent: dict | None = None
        self.allowed: dict[str, set[str]] = {}
        self.taken_names: set[str] = set()
        self._lock = asyncio.Lock()
        self._timer: CALLBACK_TYPE | None = None

    @property
    def webhook_url(self) -> str:
        return f"{self.entry.data[CONF_HA_URL].rstrip('/')}/api/webhook/{self.entry.data[CONF_WEBHOOK_ID]}"

    async def async_load(self) -> None:
        self.sent = await self.store.async_load()
        self.allowed = allowed_values(self.sent or {})

    def entities(self) -> list[Entity]:
        out = []
        for entity_id in self.entry.options.get(CONF_ENTITIES, []):
            state = self.hass.states.get(entity_id)
            if state is None:
                out.append(Entity(entity_id, entity_id, available=False))
                continue
            out.append(
                Entity(
                    entity_id,
                    state.name,
                    # Scenes, scripts and buttons sit at "unknown" until used.
                    available=state.state != STATE_UNAVAILABLE,
                    supported_features=int(state.attributes.get("supported_features") or 0),
                    attributes=dict(state.attributes),
                )
            )
        return out

    def _build(self) -> dict:
        previous = {d["entity"]: d for d in (self.sent or {}).get("devices", [])}
        return build_device_set(self.webhook_url, self.entities(), previous, self.taken_names)

    async def async_push(self, force: bool = False) -> None:
        """Send the set to the hub. The hub saves nothing when it hasn't changed."""
        self._cancel_timer()
        async with self._lock:
            try:
                self.taken_names = await self.client.device_names()
                device_set = self._build()
                if device_set == self.sent and not force:
                    return
                result = await self.client.commit(device_set)
            except HubRefused as err:
                _LOGGER.warning("The hub refused the Home Assistant devices: %s", err)
                persistent_notification.async_create(
                    self.hass,
                    f"The hub didn't take the change: {err}",
                    title="Melodious",
                    notification_id=f"{DOMAIN}_{self.entry.entry_id}",
                )
                return
            except HubError as err:
                _LOGGER.warning("Could not update the hub's devices, trying again in %ss: %s", RETRY_SECONDS, err)
                self._timer = async_call_later(self.hass, RETRY_SECONDS, self._timer_fired)
                return
            self.sent = device_set
            self.allowed = allowed_values(device_set)
            await self.store.async_save(device_set)
            persistent_notification.async_dismiss(self.hass, f"{DOMAIN}_{self.entry.entry_id}")
            if result.get("changed"):
                _LOGGER.info(
                    "Hub devices: added %s, updated %s, removed %s",
                    result.get("added") or [], result.get("updated") or [], result.get("removed") or [],
                )

    @callback
    def _timer_fired(self, _now: Any) -> None:
        self._timer = None
        self.entry.async_create_background_task(self.hass, self.async_push(), f"{DOMAIN} push")

    @callback
    def _cancel_timer(self) -> None:
        if self._timer:
            self._timer()
            self._timer = None

    @callback
    def async_state_changed(self, _event: Event[EventStateChangedData]) -> None:
        """Push again only when the set itself would change, not on every state update."""
        if self._timer is None and self.sent is not None and self._build() != self.sent:
            self._timer = async_call_later(self.hass, PUSH_DELAY_SECONDS, self._timer_fired)

    @callback
    def run(self, entity_id: str, value: str) -> None:
        """Run one webhook call, without waiting: the hub drops IP commands queued over 500 ms."""
        if value not in self.allowed.get(entity_id, set()):
            _LOGGER.warning("Ignoring %s for %s: not a command Melodious set up", value, entity_id)
            return
        state = self.hass.states.get(entity_id)
        call = service_call(entity_id, value, dict(state.attributes) if state else {})
        if call is None:
            _LOGGER.warning("Ignoring %s for %s: no service for it", value, entity_id)
            return
        domain, service, data = call
        _LOGGER.debug("Hub sent %s for %s: %s.%s", value, entity_id, domain, service)
        self.hass.async_create_task(self.hass.services.async_call(domain, service, data, blocking=False))


async def async_setup_entry(hass: HomeAssistant, entry: MelodiousConfigEntry) -> bool:
    runtime = MelodiousRuntime(hass, entry)
    await runtime.async_load()
    entry.runtime_data = runtime

    async def handle_webhook(hass: HomeAssistant, webhook_id: str, request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except ValueError:
            body = None
        if isinstance(body, dict):
            runtime.run(str(body.get("device", "")), str(body.get("command", "")))
        # Always 200: any other answer makes the hub's engine rescan the network.
        return web.Response(status=200)

    webhook.async_register(
        hass, DOMAIN, entry.title, entry.data[CONF_WEBHOOK_ID], handle_webhook,
        local_only=True, allowed_methods=["POST"],
    )
    entry.async_on_unload(lambda: webhook.async_unregister(hass, entry.data[CONF_WEBHOOK_ID]))
    entry.async_on_unload(runtime._cancel_timer)
    entry.async_on_unload(entry.add_update_listener(_async_options_updated))
    entry.async_on_unload(
        async_track_state_change_event(hass, entry.options.get(CONF_ENTITIES, []), runtime.async_state_changed)
    )

    async def push_when_started(_hass: HomeAssistant) -> None:
        # Once per start: the hub may have been reset since the last push.
        await runtime.async_push(force=True)

    entry.async_on_unload(async_at_started(hass, push_when_started))
    return True


async def _async_options_updated(hass: HomeAssistant, entry: MelodiousConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: MelodiousConfigEntry) -> bool:
    return True


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Take this integration's devices off the hub. The hub keeps any an activity still uses."""
    try:
        await hub_client(hass, entry.data).commit({"devices": []})
    except HubError as err:
        _LOGGER.warning("The hub kept its Home Assistant devices: %s", err)
    await Store(hass, 1, f"{DOMAIN}.{entry.entry_id}").async_remove()
