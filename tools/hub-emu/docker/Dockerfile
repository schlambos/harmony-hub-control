# hub-emu — the Harmony hub's own web backend, virtualized.
# The real codex_webui + codex_hbus binaries (MIPS32 big-endian, built with the
# production zig recipe) run under qemu user-mode emulation. Only the engine
# daemon behind the HBus socket and the BT/HAL CLIs are emulated (engine-emu.py
# + stubs/) — exactly where physical hardware sits on the box.
#
# Build context: tools/hub-emu/
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends qemu-user python3 curl \
    && rm -rf /var/lib/apt/lists/*

COPY build/codex_webui.mips build/codex_hbus.mips /opt/hub/bin/
COPY engine-emu.py /opt/hub/engine-emu.py
COPY stubs/ /opt/hub/stubs/
COPY seed/resources/ /seed/resources/
COPY seed/settings/ /seed/settings/
COPY docker/entrypoint.sh /opt/hub/entrypoint.sh

EXPOSE 8080 8089
ENTRYPOINT ["/bin/sh", "/opt/hub/entrypoint.sh"]
