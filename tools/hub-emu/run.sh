#!/bin/sh
# hub-emu bring-up: seed -> (re)build MIPS binaries if needed -> docker image
# -> container. Requires: zig, docker (colima), node (PATH or bundled runtime).
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
NODE=${NODE:-$(command -v node || echo /Users/matt/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node)}
REBUILD=${1:-}

echo "== seed from webui-sim fixture =="
"$NODE" "$HERE/make-seed.mjs"

echo "== embedded asset generation (vendor + harmony shell) =="
sh "$REPO/tools/embed_activity_ui.sh"

if [ ! -f "$HERE/build/codex_webui.mips" ] || [ "$REBUILD" = "--rebuild" ]; then
    echo "== cross-compiling real binaries (MIPS32 BE, production recipe) =="
    (cd "$REPO" && zig cc -target mips-linux-musleabi -Os -static -s \
        -I payload/source -o "$HERE/build/codex_webui.mips" payload/source/codex_webui.c)
    (cd "$REPO" && zig cc -target mips-linux-musleabi -Os -static -s \
        -o "$HERE/build/codex_hbus.mips" payload/source/codex_hbus.c)
fi
file "$HERE/build/codex_webui.mips" | grep -q "ELF 32-bit MSB.*MIPS" || {
    echo "codex_webui.mips is not a MIPS32 BE binary" >&2
    exit 1
}

echo "== docker image =="
docker build -t hub-emu -f "$HERE/docker/Dockerfile" "$HERE"

echo "== container =="
docker rm -f hub-emu >/dev/null 2>&1 || true
docker run -d --name hub-emu \
    -p 127.0.0.1:8788:8080 \
    -p 127.0.0.1:8789:8089 \
    hub-emu >/dev/null

printf "waiting for the real backend"
i=0
while [ "$i" -lt 60 ]; do
    if curl -sf -o /dev/null http://127.0.0.1:8788/api/activity-state; then
        echo " — up."
        echo
        echo "1:1 hub API : http://127.0.0.1:8788 (real codex_webui, MIPS under qemu)"
        echo "control     : http://127.0.0.1:8789 (POST /reset, GET /events, GET /status)"
        echo "front-end   : $NODE $HERE/dev-proxy.mjs   ->  http://127.0.0.1:8787/#control"
        exit 0
    fi
    printf "."
    i=$((i + 1))
    sleep 1
done
echo " backend did not come up; container logs:" >&2
docker logs hub-emu >&2
exit 1
