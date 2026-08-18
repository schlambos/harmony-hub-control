#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

SRC="$REPO_ROOT/payload/source"
TOOLS="$SCRIPT_DIR/toolchains"
BUILD="$SCRIPT_DIR/tmp"
OUT="$SCRIPT_DIR/output"

mkdir -p "$TOOLS" "$BUILD" "$OUT"

TOOLCHAIN_NAME=mips32--uclibc--stable-2017.05-toolchains-1-1
TOOLCHAIN_TARBALL="$TOOLS/$TOOLCHAIN_NAME.tar.bz2"
TOOLCHAIN_URL="https://toolchains.bootlin.com/downloads/releases/toolchains/mips32/tarballs/$TOOLCHAIN_NAME.tar.bz2"
TOOLCHAIN_DIR="$TOOLS/mips32--uclibc--stable"

if [ ! -x "$TOOLCHAIN_DIR/bin/mips-buildroot-linux-uclibc-gcc" ]; then
  if [ ! -f "$TOOLCHAIN_TARBALL" ]; then
    wget -O "$TOOLCHAIN_TARBALL" "$TOOLCHAIN_URL"
  fi
  tar -C "$TOOLS" -xf "$TOOLCHAIN_TARBALL"
fi

export PATH="$TOOLCHAIN_DIR/bin:$PATH"
CC=mips-buildroot-linux-uclibc-gcc
STRIP=mips-buildroot-linux-uclibc-strip

# ---------------------------------------------------------------------------
# GCC-built helpers (Bootlin mips32 uClibc 2017.05).  Unchanged: dhcpd and
# portal are built exactly as before with the Bootlin GCC 5.4 toolchain.
# ---------------------------------------------------------------------------
"$CC" -Os -static -s -o "$OUT/codex_dhcpd" "$SRC/codex_dhcpd.c"
"$CC" -Os -static -s -o "$OUT/codex_portal" "$SRC/codex_portal.c"

# ---------------------------------------------------------------------------
# Zig-built binaries.  Two DISTINCT Zig distributions are required, each
# fail-closed pinned by executable SHA-256, version, and clang/LLD
# fingerprint.  They are NOT interchangeable: the deployed binaries were
# built with different clang/LLD versions whose .comment sections differ.
#
#   WEBUI_ZIG    Homebrew Zig 0.16.0_1 (clang/LLD 21.1.8) — builds codex_webui
#                executable SHA-256
#                0bfa8cb6f5f64c6d645e1d5dfb5c6f62c2b79d7249c3f38a279e118cb49b02ae
#   OFFICIAL_ZIG Official Zig 0.16.0 (clang/LLD 21.1.0) — builds pair-agent,
#                bthid, HAL, HBus
#                executable SHA-256
#                e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec
#
# No absolute private defaults are baked in: both are supplied via
# environment variables (or the caller's PATH for WEBUI_ZIG).
# ---------------------------------------------------------------------------

#: expected output digests (fail closed on any mismatch)
WEBUI_EXPECT_SHA256=c400173bb42f735734c522556c69f6c80f0604949413eb974c7b361b9e4ac11a
WEBUI_EXPECT_SIZE=906872
PAIR_EXPECT_SHA256=563c6c58a3629edfebd7ec30ebcf14e6384a2d84e89669b1d7c3d79c75b619c8
PAIR_EXPECT_SIZE=111796
BTHID_EXPECT_SHA256=c6a3c4cd0db3aab1bbdc92ae22e3ae2ffe11d442ac7fe0920b46a6da0b5cef13
BTHID_EXPECT_SIZE=116452
HAL_EXPECT_SHA256=7fa9a84b9ee270bdf6e47d40859d29b6c1c30e5a1766f0ab59e9143dd13ca26c
HAL_EXPECT_SIZE=76772
HBUS_EXPECT_SHA256=4be9e6ac2e09e7eb052f9c47e81480d1e32aee7190bedb6ef7f932cf07aab8f9
HBUS_EXPECT_SIZE=74660

#: pinned executable SHA-256 for each Zig distribution
WEBUI_ZIG_SHA256=0bfa8cb6f5f64c6d645e1d5dfb5c6f62c2b79d7249c3f38a279e118cb49b02ae
OFFICIAL_ZIG_SHA256=e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec

#: pinned clang/LLD fingerprint (first line of `zig cc --version`)
WEBUI_ZIG_FINGERPRINT="Homebrew clang version 21.1.8"
OFFICIAL_ZIG_FINGERPRINT="clang version 21.1.0"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

#: resolve a Zig binary and fail closed on a wrong executable SHA-256,
#: version, or clang/LLD fingerprint.
check_zig() {
  _label="$1"
  _bin="$2"
  _expect_sha="$3"
  _expect_fp="$4"
  if [ -z "$_bin" ]; then
    echo "error: $_label is not set (supply it via environment)" >&2
    exit 1
  fi
  if [ ! -x "$_bin" ]; then
    echo "error: $_label is not an executable: $_bin" >&2
    exit 1
  fi
  _sha=$(sha256_of "$_bin")
  if [ "$_sha" != "$_expect_sha" ]; then
    echo "error: $_label executable SHA-256 mismatch (found $_sha, expected $_expect_sha)" >&2
    exit 1
  fi
  _ver=$("$_bin" version 2>/dev/null || true)
  if [ "$_ver" != "0.16.0" ]; then
    echo "error: $_label requires Zig 0.16.0 (found: ${_ver:-unknown})" >&2
    exit 1
  fi
  _fp=$("$_bin" cc --version 2>/dev/null | head -n 1 || true)
  case "$_fp" in
    "$_expect_fp"*) ;;
    *)
      echo "error: $_label clang/LLD fingerprint mismatch (found '$_fp', expected '$_expect_fp')" >&2
      exit 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# codex_webui — Homebrew Zig 0.16.0_1 (clang/LLD 21.1.8), mips32r2.
# ---------------------------------------------------------------------------
WEBUI_ZIG=${WEBUI_ZIG:-$(command -v zig || true)}
check_zig "WEBUI_ZIG" "$WEBUI_ZIG" "$WEBUI_ZIG_SHA256" "$WEBUI_ZIG_FINGERPRINT"

(
  cd "$REPO_ROOT"
  "$WEBUI_ZIG" cc -target mips-linux-musleabi -Os -static -s \
    -I payload/source \
    -o build/output/codex_webui \
    payload/source/codex_webui.c
)
WEBUI_SHA256=$(sha256_of "$OUT/codex_webui")
WEBUI_SIZE=$(wc -c < "$OUT/codex_webui" | tr -d ' ')
if [ "$WEBUI_SHA256" != "$WEBUI_EXPECT_SHA256" ] || [ "$WEBUI_SIZE" != "$WEBUI_EXPECT_SIZE" ]; then
  echo "error: codex_webui build is not exact (size $WEBUI_SIZE, sha256 $WEBUI_SHA256; expected size $WEBUI_EXPECT_SIZE, sha256 $WEBUI_EXPECT_SHA256)" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# pair-agent / bthid / HAL / HBus — Official Zig 0.16.0 (clang/LLD 21.1.0).
# HBus additionally requires -mcpu=mips32 (mips32 r1 target).
# ---------------------------------------------------------------------------
OFFICIAL_ZIG=${OFFICIAL_ZIG:-}
check_zig "OFFICIAL_ZIG" "$OFFICIAL_ZIG" "$OFFICIAL_ZIG_SHA256" "$OFFICIAL_ZIG_FINGERPRINT"

(
  cd "$REPO_ROOT"
  "$OFFICIAL_ZIG" cc -target mips-linux-musleabi -Os -static -s \
    -o build/output/codex_bt_pair_agent \
    payload/source/codex_bt_pair_agent.c
  "$OFFICIAL_ZIG" cc -target mips-linux-musleabi -Os -static -s \
    -o build/output/codex_bthid_keyboard \
    payload/source/codex_bthid_keyboard.c
  "$OFFICIAL_ZIG" cc -target mips-linux-musleabi -Os -static -s \
    -o build/output/codex_hal_ltcp \
    payload/source/codex_hal_ltcp.c
  "$OFFICIAL_ZIG" cc -target mips-linux-musleabi -mcpu=mips32 -Os -static -s \
    -o build/output/codex_hbus \
    payload/source/codex_hbus.c
)

PAIR_SHA256=$(sha256_of "$OUT/codex_bt_pair_agent")
PAIR_SIZE=$(wc -c < "$OUT/codex_bt_pair_agent" | tr -d ' ')
if [ "$PAIR_SHA256" != "$PAIR_EXPECT_SHA256" ] || [ "$PAIR_SIZE" != "$PAIR_EXPECT_SIZE" ]; then
  echo "error: codex_bt_pair_agent build is not exact (size $PAIR_SIZE, sha256 $PAIR_SHA256; expected size $PAIR_EXPECT_SIZE, sha256 $PAIR_EXPECT_SHA256)" >&2
  exit 1
fi
BTHID_SHA256=$(sha256_of "$OUT/codex_bthid_keyboard")
BTHID_SIZE=$(wc -c < "$OUT/codex_bthid_keyboard" | tr -d ' ')
if [ "$BTHID_SHA256" != "$BTHID_EXPECT_SHA256" ] || [ "$BTHID_SIZE" != "$BTHID_EXPECT_SIZE" ]; then
  echo "error: codex_bthid_keyboard build is not exact (size $BTHID_SIZE, sha256 $BTHID_SHA256; expected size $BTHID_EXPECT_SIZE, sha256 $BTHID_EXPECT_SHA256)" >&2
  exit 1
fi
HAL_SHA256=$(sha256_of "$OUT/codex_hal_ltcp")
HAL_SIZE=$(wc -c < "$OUT/codex_hal_ltcp" | tr -d ' ')
if [ "$HAL_SHA256" != "$HAL_EXPECT_SHA256" ] || [ "$HAL_SIZE" != "$HAL_EXPECT_SIZE" ]; then
  echo "error: codex_hal_ltcp build is not exact (size $HAL_SIZE, sha256 $HAL_SHA256; expected size $HAL_EXPECT_SIZE, sha256 $HAL_EXPECT_SHA256)" >&2
  exit 1
fi
HBUS_SHA256=$(sha256_of "$OUT/codex_hbus")
HBUS_SIZE=$(wc -c < "$OUT/codex_hbus" | tr -d ' ')
if [ "$HBUS_SHA256" != "$HBUS_EXPECT_SHA256" ] || [ "$HBUS_SIZE" != "$HBUS_EXPECT_SIZE" ]; then
  echo "error: codex_hbus build is not exact (size $HBUS_SIZE, sha256 $HBUS_SHA256; expected size $HBUS_EXPECT_SIZE, sha256 $HBUS_EXPECT_SHA256)" >&2
  exit 1
fi

DROPBEAR_VERSION=2025.89
DROPBEAR_TARBALL="$BUILD/dropbear-$DROPBEAR_VERSION.tar.bz2"
DROPBEAR_URL="https://matt.ucc.asn.au/dropbear/releases/dropbear-$DROPBEAR_VERSION.tar.bz2"

if [ ! -f "$DROPBEAR_TARBALL" ]; then
  wget -O "$DROPBEAR_TARBALL" "$DROPBEAR_URL"
fi

rm -rf "$BUILD/dropbear-$DROPBEAR_VERSION"
tar -C "$BUILD" -xf "$DROPBEAR_TARBALL"
cd "$BUILD/dropbear-$DROPBEAR_VERSION"

./configure \
  --host=mips-buildroot-linux-uclibc \
  --disable-zlib \
  --disable-pam \
  --disable-lastlog \
  --disable-utmp \
  --disable-utmpx \
  --disable-wtmp \
  --disable-wtmpx \
  --disable-loginfunc \
  --disable-pututline \
  --disable-pututxline \
  CC="$CC" \
  CFLAGS="-Os -static" \
  LDFLAGS="-static"

make -j"$(nproc)" MULTI=1 PROGRAMS="dropbear dropbearkey dbclient scp" dropbearmulti
"$STRIP" dropbearmulti || true
cp dropbearmulti "$OUT/dropbearmulti"

cd "$OUT"
ln -sf dropbearmulti dropbear
ln -sf dropbearmulti dropbearkey
md5sum codex_dhcpd codex_portal codex_hbus codex_hal_ltcp codex_bthid_keyboard codex_bt_pair_agent codex_webui dropbearmulti > MD5SUMS
file codex_dhcpd codex_portal codex_hbus codex_hal_ltcp codex_bthid_keyboard codex_bt_pair_agent codex_webui dropbearmulti > FILES
ls -l codex_dhcpd codex_portal codex_hbus codex_hal_ltcp codex_bthid_keyboard codex_bt_pair_agent codex_webui dropbearmulti > MANIFEST.txt
cat MD5SUMS >> MANIFEST.txt
