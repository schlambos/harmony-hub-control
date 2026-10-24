"""Set up Melodious: the hub, and the entities it gets as devices."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components import webhook
from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.const import CONF_HOST, CONF_PASSWORD, CONF_PORT, CONF_USERNAME
from homeassistant.core import callback
from homeassistant.helpers import selector
from homeassistant.helpers.network import NoURLAvailableError, get_url

from . import hub_client
from .const import CONF_ENTITIES, CONF_HA_URL, CONF_WEBHOOK_ID, DEFAULT_PORT, DOMAIN
from .devices import SUPPORTED_DOMAINS
from .hub import HubError, HubRefused


class MelodiousConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        placeholders = {"error": ""}
        if user_input is not None:
            data = {**user_input, CONF_HOST: user_input[CONF_HOST].strip()}
            data[CONF_HA_URL] = user_input[CONF_HA_URL].strip().rstrip("/")
            await self.async_set_unique_id(data[CONF_HOST])
            self._abort_if_unique_id_configured()
            # The hub can't verify Let's Encrypt certificates.
            if not data[CONF_HA_URL].startswith("http://"):
                errors[CONF_HA_URL] = "http_only"
            else:
                try:
                    # A dry run: proves the hub has the device writer, saves nothing.
                    await hub_client(self.hass, data).commit({"devices": []}, dry_run=True)
                except HubRefused:
                    pass  # It answered; an activity just uses a device already there.
                except HubError as err:
                    errors["base"] = "cannot_connect"
                    placeholders["error"] = str(err)
            if not errors:
                return self.async_create_entry(
                    title=f"Melodious hub {data[CONF_HOST]}",
                    data={**data, CONF_WEBHOOK_ID: webhook.async_generate_id()},
                    options={CONF_ENTITIES: []},
                )

        try:
            guess = get_url(self.hass, allow_external=False, allow_ip=True, require_ssl=False)
        except NoURLAvailableError:
            guess = ""
        defaults = user_input or {CONF_HA_URL: guess if guess.startswith("http://") else ""}
        schema = vol.Schema(
            {
                vol.Required(CONF_HOST, default=defaults.get(CONF_HOST, "")): str,
                vol.Required(CONF_PORT, default=defaults.get(CONF_PORT, DEFAULT_PORT)): int,
                vol.Optional(CONF_USERNAME, default=defaults.get(CONF_USERNAME, "")): str,
                vol.Optional(CONF_PASSWORD, default=defaults.get(CONF_PASSWORD, "")): selector.TextSelector(
                    selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD)
                ),
                vol.Required(CONF_HA_URL, default=defaults.get(CONF_HA_URL, "")): str,
            }
        )
        return self.async_show_form(
            step_id="user", data_schema=schema, errors=errors, description_placeholders=placeholders
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return MelodiousOptionsFlow()


class MelodiousOptionsFlow(OptionsFlow):
    """Pick the entities the hub gets as devices."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data=user_input)
        schema = vol.Schema(
            {
                vol.Optional(
                    CONF_ENTITIES, default=self.config_entry.options.get(CONF_ENTITIES, [])
                ): selector.EntitySelector(
                    selector.EntitySelectorConfig(domain=list(SUPPORTED_DOMAINS), multiple=True)
                ),
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema)
