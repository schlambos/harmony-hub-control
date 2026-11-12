#!/bin/sh
# Run CI's "Pins and reproducible builds" job on your own machine, in the
# same Debian image. Needs Docker. It checks the commit you name (default
# HEAD), not your working tree, so commit first.
#
#   sh tools/ci/rebuild_in_docker.sh [commit]
#
# Downloads are kept in build/toolchains/ci-cache/ for the next run.
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$HERE/../.." && pwd)
COMMIT=${1:-HEAD}
#: debian:bookworm-slim, the digest .github/workflows/ci.yml pins
IMAGE=debian@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
CACHE="$REPO_ROOT/build/toolchains/ci-cache"
mkdir -p "$CACHE"

# linux/amd64: Bootlin's toolchain (Dropbear) is x86_64 only
git -C "$REPO_ROOT" archive "$COMMIT" | docker run --rm -i --platform linux/amd64 \
  -v "$CACHE":/cache "$IMAGE" sh -c '
    set -eu
    apt-get update -q > /dev/null
    apt-get install -y -q --no-install-recommends \
      bzip2 ca-certificates file gcc git libc6-dev make patch \
      python3 python3-pyelftools unzip wget xz-utils > /dev/null
    mkdir -p /work/build/toolchains /work/build/tmp && cd /work && tar -x
    cp /cache/toolchains/* build/toolchains/ 2> /dev/null || true
    cp /cache/tmp/* build/tmp/ 2> /dev/null || true
    # the generators are checked with git diff, so the tree must be a commit
    git init -q . && git add -A > /dev/null
    git -c user.name=ci -c user.email=ci@localhost commit -q -m tree
    sh tools/ci/install_bun.sh /usr/local/bin > /dev/null
    status=0
    python3 tools/ci/verify_pins.py || status=1
    sh tools/ci/rebuild_check.sh || status=1
    mkdir -p /cache/toolchains /cache/tmp
    cp build/toolchains/*.tar.* /cache/toolchains/ 2> /dev/null || true
    cp build/tmp/*.tar.* /cache/tmp/ 2> /dev/null || true
    exit $status'
