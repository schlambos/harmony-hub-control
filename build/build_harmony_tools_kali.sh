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

# The Bootlin GCC toolchain above is now used only for the Dropbear build
# below.  codex_dhcpd and codex_portal moved to the pinned Official Zig
# 0.16.0 build (issue #88) so every first-party binary is verifiable the
# same way; they were previously unpinned Bootlin GCC builds.

# ---------------------------------------------------------------------------
# Zig-built binaries.  Official Zig 0.16.0 (clang/LLD 21.1.0), fail-closed
# pinned by executable SHA-256, version, and clang/LLD fingerprint, builds
# all eight: WEBUI_ZIG (codex_webui) and OFFICIAL_ZIG (pair-agent, bthid,
# HAL, HBus, dhcpd, portal, codex_androidtv) are separate variables but carry
# the same pin.
#
#   executable SHA-256
#   e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec
#
# Box binaries up to 2026-10-20 (webui sha256 6061b907...) were built with
# Homebrew Zig 0.16.0_1 (clang/LLD 21.1.8), which Homebrew no longer serves.
# Official Zig 0.16.0 rebuilds them with identical code and data; only the
# .comment compiler stamp differs, so compare such builds after
# `llvm-objcopy --remove-section=.comment`.
#
# codex_webui 974fe544... (8231751) was built with Homebrew Zig 0.17.0
# (clang/LLD 22.1.8). Its code and data differ, so it was replaced with the
# official 0.16.0 build.
#
# No absolute private defaults are baked in: both are supplied via
# environment variables (or the caller's PATH for WEBUI_ZIG).
# ---------------------------------------------------------------------------

#: expected output digests (fail closed on any mismatch)
WEBUI_EXPECT_SHA256=b1bea946b1f5437d81ae515cf39ef772d53331755be9da86258f96367a74b7ec
WEBUI_EXPECT_SIZE=1257364
PAIR_EXPECT_SHA256=4d21e431436c034003efca036bb1a26d01cd868a5159cd1ea337aae431feb80b
PAIR_EXPECT_SIZE=127844
BTHID_EXPECT_SHA256=099b8a1428c2f34fe0b3428d280f65402cc6a5fd1e8e5723c56b462cc8ec2a86
BTHID_EXPECT_SIZE=119284
HAL_EXPECT_SHA256=a0b29bf8b72418ad3f99355889d2a07a7fd031395e1871f4e114fbab721592c8
HAL_EXPECT_SIZE=81636
HBUS_EXPECT_SHA256=4be9e6ac2e09e7eb052f9c47e81480d1e32aee7190bedb6ef7f932cf07aab8f9
HBUS_EXPECT_SIZE=74660
DHCPD_EXPECT_SHA256=e9db51f4691511f1ae10182143518e758fc7aca0a84994fe9be602be37957592
DHCPD_EXPECT_SIZE=58328
PORTAL_EXPECT_SHA256=1596f6cac03dad4ce0254ac118de5527c41789f10c7bc95357860d0d96c61b5f
PORTAL_EXPECT_SIZE=76724
ANDROIDTV_EXPECT_SHA256=fbf0e953b47b10f29fb30a41a4d339f5a034e1cc7a26c12d79f4d3711161bba2
ANDROIDTV_EXPECT_SIZE=266916

#: BearSSL 0.6 source for codex_androidtv (bearssl.org publishes no checksum; this
#: is the tarball's SHA-256 as downloaded on 2026-11-07)
BEARSSL_VERSION=0.6
BEARSSL_SHA256=6705bba1714961b41a728dfc5debbe348d2966c117649392f8c8139efc83ff14
#: committed dropbearmulti identity and its pinned upstream source tarball
DROPBEAR_EXPECT_SHA256=e2ea632aed8b31dc5ea56b9673cbd983ec83260a97d33f891a0cebf51d5c6c8d
DROPBEAR_EXPECT_SIZE=577296
DROPBEAR_TARBALL_SHA256=0d1f7ca711cfc336dc8a85e672cab9cfd8223a02fe2da0a4a7aeb58c9e113634

#: pinned executable SHA-256 for each Zig distribution
WEBUI_ZIG_SHA256=e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec
OFFICIAL_ZIG_SHA256=e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec

#: pinned clang/LLD fingerprint (first line of `zig cc --version`)
WEBUI_ZIG_FINGERPRINT="clang version 21.1.0"
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
# codex_webui — Official Zig 0.16.0 (clang/LLD 21.1.0), mips32r2.
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
# pair-agent / bthid / HAL / HBus / dhcpd / portal — Official Zig 0.16.0
# (clang/LLD 21.1.0).  HBus additionally requires -mcpu=mips32 (mips32 r1).
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
  "$OFFICIAL_ZIG" cc -target mips-linux-musleabi -Os -static -s \
    -o build/output/codex_dhcpd \
    payload/source/codex_dhcpd.c
  "$OFFICIAL_ZIG" cc -target mips-linux-musleabi -Os -static -s \
    -o build/output/codex_portal \
    payload/source/codex_portal.c
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
DHCPD_SHA256=$(sha256_of "$OUT/codex_dhcpd")
DHCPD_SIZE=$(wc -c < "$OUT/codex_dhcpd" | tr -d ' ')
if [ "$DHCPD_SHA256" != "$DHCPD_EXPECT_SHA256" ] || [ "$DHCPD_SIZE" != "$DHCPD_EXPECT_SIZE" ]; then
  echo "error: codex_dhcpd build is not exact (size $DHCPD_SIZE, sha256 $DHCPD_SHA256; expected size $DHCPD_EXPECT_SIZE, sha256 $DHCPD_EXPECT_SHA256)" >&2
  exit 1
fi
PORTAL_SHA256=$(sha256_of "$OUT/codex_portal")
PORTAL_SIZE=$(wc -c < "$OUT/codex_portal" | tr -d ' ')
if [ "$PORTAL_SHA256" != "$PORTAL_EXPECT_SHA256" ] || [ "$PORTAL_SIZE" != "$PORTAL_EXPECT_SIZE" ]; then
  echo "error: codex_portal build is not exact (size $PORTAL_SIZE, sha256 $PORTAL_SHA256; expected size $PORTAL_EXPECT_SIZE, sha256 $PORTAL_EXPECT_SHA256)" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# codex_androidtv (network Android/Google TVs) — Official Zig 0.16.0 with BearSSL.
# Built from inside $BUILD so BearSSL's paths are relative; the sorted file
# list keeps the link order, and so the output, the same everywhere.
# ---------------------------------------------------------------------------
BEARSSL_TARBALL="$BUILD/bearssl-$BEARSSL_VERSION.tar.gz"
BEARSSL_URL="https://www.bearssl.org/bearssl-$BEARSSL_VERSION.tar.gz"
if [ ! -f "$BEARSSL_TARBALL" ]; then
  wget -O "$BEARSSL_TARBALL" "$BEARSSL_URL"
fi
BEARSSL_FOUND_SHA256=$(sha256_of "$BEARSSL_TARBALL")
if [ "$BEARSSL_FOUND_SHA256" != "$BEARSSL_SHA256" ]; then
  echo "error: BearSSL tarball SHA-256 mismatch (found $BEARSSL_FOUND_SHA256, expected $BEARSSL_SHA256)" >&2
  exit 1
fi
rm -rf "$BUILD/bearssl-$BEARSSL_VERSION"
tar -C "$BUILD" -xzf "$BEARSSL_TARBALL"
(
  cd "$BUILD"
  # shellcheck disable=SC2046
  "$OFFICIAL_ZIG" cc -target mips-linux-musleabi -Os -static -s \
    -ffunction-sections -fdata-sections -Wl,--gc-sections \
    -Ibearssl-$BEARSSL_VERSION/inc -Ibearssl-$BEARSSL_VERSION/src \
    -o "$OUT/codex_androidtv" "$SRC/codex_androidtv.c" \
    $(find "bearssl-$BEARSSL_VERSION/src" -name '*.c' | LC_ALL=C sort)
)
ANDROIDTV_SHA256=$(sha256_of "$OUT/codex_androidtv")
ANDROIDTV_SIZE=$(wc -c < "$OUT/codex_androidtv" | tr -d ' ')
if [ "$ANDROIDTV_SHA256" != "$ANDROIDTV_EXPECT_SHA256" ] || [ "$ANDROIDTV_SIZE" != "$ANDROIDTV_EXPECT_SIZE" ]; then
  echo "error: codex_androidtv build is not exact (size $ANDROIDTV_SIZE, sha256 $ANDROIDTV_SHA256; expected size $ANDROIDTV_EXPECT_SIZE, sha256 $ANDROIDTV_EXPECT_SHA256)" >&2
  exit 1
fi

DROPBEAR_VERSION=2025.89
DROPBEAR_TARBALL="$BUILD/dropbear-$DROPBEAR_VERSION.tar.bz2"
DROPBEAR_URL="https://matt.ucc.asn.au/dropbear/releases/dropbear-$DROPBEAR_VERSION.tar.bz2"

if [ ! -f "$DROPBEAR_TARBALL" ]; then
  wget -O "$DROPBEAR_TARBALL" "$DROPBEAR_URL"
fi

#: fail closed on a tarball that is not the pinned upstream release
DROPBEAR_TARBALL_SHA256_FOUND=$(sha256_of "$DROPBEAR_TARBALL")
if [ "$DROPBEAR_TARBALL_SHA256_FOUND" != "$DROPBEAR_TARBALL_SHA256" ]; then
  echo "error: Dropbear tarball SHA-256 mismatch (found $DROPBEAR_TARBALL_SHA256_FOUND, expected $DROPBEAR_TARBALL_SHA256)" >&2
  exit 1
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

#: fail closed unless the rebuild reproduces the committed binary exactly
DROPBEAR_SHA256=$(sha256_of "$OUT/dropbearmulti")
DROPBEAR_SIZE=$(wc -c < "$OUT/dropbearmulti" | tr -d ' ')
if [ "$DROPBEAR_SHA256" != "$DROPBEAR_EXPECT_SHA256" ] || [ "$DROPBEAR_SIZE" != "$DROPBEAR_EXPECT_SIZE" ]; then
  echo "error: dropbearmulti build is not exact (size $DROPBEAR_SIZE, sha256 $DROPBEAR_SHA256; expected size $DROPBEAR_EXPECT_SIZE, sha256 $DROPBEAR_EXPECT_SHA256)" >&2
  exit 1
fi

cd "$OUT"
ln -sf dropbearmulti dropbear
ln -sf dropbearmulti dropbearkey
md5sum codex_dhcpd codex_portal codex_hbus codex_hal_ltcp codex_bthid_keyboard codex_bt_pair_agent codex_androidtv codex_webui dropbearmulti > MD5SUMS
file codex_dhcpd codex_portal codex_hbus codex_hal_ltcp codex_bthid_keyboard codex_bt_pair_agent codex_androidtv codex_webui dropbearmulti > FILES
ls -l codex_dhcpd codex_portal codex_hbus codex_hal_ltcp codex_bthid_keyboard codex_bt_pair_agent codex_androidtv codex_webui dropbearmulti > MANIFEST.txt
cat MD5SUMS >> MANIFEST.txt
