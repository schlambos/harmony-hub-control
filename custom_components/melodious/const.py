"""Constants for the Melodious integration."""

DOMAIN = "melodious"

CONF_HA_URL = "ha_url"
CONF_WEBHOOK_ID = "webhook_id"
CONF_ENTITIES = "entities"

DEFAULT_PORT = 8080

# Coalesce state changes before re-sending the device set to the hub.
PUSH_DELAY_SECONDS = 5
# How long to wait before trying the hub again after it couldn't take a set.
RETRY_SECONDS = 60
