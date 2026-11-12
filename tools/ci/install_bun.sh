#!/bin/sh
# Install the pinned bun (the one whose output harmony_shell_assets.h is) for
# CI: download the official release zip, check its SHA-256, unpack `bun` into
# the directory given.
#
#   sh tools/ci/install_bun.sh <directory>
#
# SHA-256 values are from the release's SHASUMS256.txt. Needs unzip, and wget
# or curl.
set -eu

BUN_VERSION=1.3.14
BUN_SHA256_X64=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
BUN_SHA256_AARCH64=a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b
BUN_SHA256_DARWIN_AARCH64=d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620

DEST=${1:?usage: install_bun.sh <directory>}
case "$(uname -s) $(uname -m)" in
  "Linux x86_64") asset=bun-linux-x64 sha=$BUN_SHA256_X64 ;;
  "Linux aarch64" | "Linux arm64") asset=bun-linux-aarch64 sha=$BUN_SHA256_AARCH64 ;;
  "Darwin arm64") asset=bun-darwin-aarch64 sha=$BUN_SHA256_DARWIN_AARCH64 ;;
  *) echo "error: no pinned bun for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
url="https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/$asset.zip"
if command -v wget > /dev/null 2>&1; then
  wget -q -O "$TMP/$asset.zip" "$url"
else
  curl -fsSL -o "$TMP/$asset.zip" "$url"
fi
if command -v sha256sum > /dev/null 2>&1; then
  found=$(sha256sum "$TMP/$asset.zip" | awk '{print $1}')
else
  found=$(shasum -a 256 "$TMP/$asset.zip" | awk '{print $1}')
fi
if [ "$found" != "$sha" ]; then
  echo "error: $asset.zip SHA-256 mismatch (found $found, expected $sha)" >&2
  exit 1
fi
unzip -q -d "$TMP" "$TMP/$asset.zip"
mkdir -p "$DEST"
install -m 755 "$TMP/$asset/bun" "$DEST/bun"
"$DEST/bun" --version
