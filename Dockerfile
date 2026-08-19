# syntax=docker/dockerfile:1

FROM python:3.13-alpine

ARG BUILD_DATE=""
ARG VCS_REF="d87cebafdee36ec33f1e4ea3055239dbfea6aa09"

LABEL org.opencontainers.image.title="Harmony Hub Control for Unraid" \
      org.opencontainers.image.description="One-time Harmony Hub Control installer with a persistent LAN web proxy" \
      org.opencontainers.image.source="https://github.com/Ripthulhu/harmony-hub-control" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}"

RUN apk add --no-cache \
        ca-certificates \
        nginx \
        openssh-client \
        tzdata \
    && mkdir -p \
        /app \
        /config/.ssh \
        /config/state \
        /keys \
        /run/harmony \
        /var/lib/nginx/tmp/client_body \
        /var/lib/nginx/tmp/proxy \
    && chmod 0700 /config/.ssh \
    && chown -R nginx:nginx /var/lib/nginx/tmp \
    && rm -rf /root/.ssh \
    && ln -s /config/.ssh /root/.ssh

WORKDIR /app

COPY install_webui.py /app/install_webui.py
COPY payload/ /app/payload/
COPY UPSTREAM_REVISION /app/UPSTREAM_REVISION
COPY docker/manager.py /usr/local/bin/harmony-container

RUN chmod 0755 /app/install_webui.py /usr/local/bin/harmony-container

ENV HOME=/config \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HUB_SSH_PORT=22 \
    HUB_SSH_USER=root \
    HUB_WEB_PORT=8080 \
    SSH_KEY_PATH=/keys/harmony_owner_key \
    MQTT_ENABLED=false \
    MQTT_PORT=1883 \
    MQTT_BASE_TOPIC=harmony/hub \
    MQTT_DISCOVERY_PREFIX=homeassistant \
    MQTT_CLIENT_ID=harmony-local-mqtt \
    CLOUD_BLOCKER_ENABLED=true \
    REBOOT_HUB_AFTER_INSTALL=true \
    INSTALL_MODE=once \
    FORCE_INSTALL=false

VOLUME ["/config", "/keys"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5m --retries=3 \
    CMD wget -q -T 2 -O /dev/null http://127.0.0.1:8080/container-health || exit 1

ENTRYPOINT ["/usr/local/bin/harmony-container"]
CMD ["serve"]
