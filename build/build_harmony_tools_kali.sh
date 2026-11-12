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
# them all: WEBUI_ZIG (codex_webui) and OFFICIAL_ZIG (pair-agent, bthid,
# HAL, HBus, dhcpd, portal, usbeth, codex_androidtv, codex_flash_free) are
# separate variables but carry the same pin.
#
#   executable SHA-256
#   e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec
#
# Box binaries up to 2026-10-20 (webui sha256 6061b907...) were built with
# Homebrew Zig 0.16.0_1 (clang/LLD 21.1.8), which Homebrew no longer serves.
# Official Zig 0.16.0 rebuilds them with identical code and data; only the
# .comment compiler stamp (and, since builds drop it, .pdr) differ, so
# compare such builds with tools/elf_load_cmp.py.
#
# codex_webui 974fe544... (8231751) was built with Homebrew Zig 0.17.0
# (clang/LLD 22.1.8). Its code and data differ, so it was replaced with the
# official 0.16.0 build.
#
# No absolute private defaults are baked in: both are supplied via
# environment variables (or the caller's PATH for WEBUI_ZIG).
# ---------------------------------------------------------------------------

#: expected output digests (fail closed on any mismatch)
WEBUI_EXPECT_SHA256=337c70ec50f984334d082c86e534f946e80d7b2c32258b2e549377eb5768e40b
WEBUI_EXPECT_SIZE=1349656
PAIR_EXPECT_SHA256=6d5c5f0056187c6029ff2ebc1226c81c6df69ef2edb80d20eca6963530cab816
PAIR_EXPECT_SIZE=83160
BTHID_EXPECT_SHA256=7e2498cacd94d93db912ac7e1e1fb90afe7e70218e7dc1ae932669879da09180
BTHID_EXPECT_SIZE=89544
HAL_EXPECT_SHA256=239327e3ff8d9ebfc3f11ed06d1cfba91de9207206958f142af9a2aa68783b62
HAL_EXPECT_SIZE=53848
HBUS_EXPECT_SHA256=5d649e9455c93badf6843b7f973d526ac2be7313465525ca81f5b24b85ff8b74
HBUS_EXPECT_SIZE=47160
DHCPD_EXPECT_SHA256=749161a5cd140cb72a73619c61d77c4beeb4a71f31ca87810ead4575b8f1ce81
DHCPD_EXPECT_SIZE=31464
PORTAL_EXPECT_SHA256=4cf21f469d3ff4ef0c37b00bc40d14e1a143713d3777b7bd7e19c4b2ff0b4c33
PORTAL_EXPECT_SIZE=48680
ANDROIDTV_EXPECT_SHA256=9a1423cf63ce3b56d7ee624e118d0ac8c62a2a670209baf16807e2fbf6f95817
ANDROIDTV_EXPECT_SIZE=232824
USBETH_EXPECT_SHA256=f45949f5cab0fdbda3394e8024d8b5bda8d706c502a43b7d6e1e04ae23c81a90
USBETH_EXPECT_SIZE=57736
#: installer helper (payload/helpers): run from RAM staging, never installed
FLASHFREE_EXPECT_SHA256=749c055e9fdc5cea50d3f48d0775441bd758f6811ee32f625c5b423121854177
FLASHFREE_EXPECT_SIZE=27912

#: BearSSL 0.6 source for codex_androidtv (bearssl.org publishes no checksum; this
#: is the tarball's SHA-256 as downloaded on 2026-11-07)
BEARSSL_VERSION=0.6
BEARSSL_SHA256=6705bba1714961b41a728dfc5debbe348d2966c117649392f8c8139efc83ff14
#: BusyBox 1.37.0 (GPL-2.0): pinned upstream tarball (busybox.net publishes a
#: .sha256 beside it; this matches it) and the committed binary's identity
BUSYBOX_VERSION=1.37.0
BUSYBOX_TARBALL_SHA256=3311dff32e746499f4df0d5df04d7eb396382d7e108bb9250e7b519b837043a4
BUSYBOX_EXPECT_SHA256=f516bde18556bfe4c63731f882bc06d02beed1f61dff92898fd9cd9773e6a3bc
BUSYBOX_EXPECT_SIZE=418688
#: committed dropbearmulti identity and its pinned upstream source tarball
DROPBEAR_EXPECT_SHA256=e2ea632aed8b31dc5ea56b9673cbd983ec83260a97d33f891a0cebf51d5c6c8d
DROPBEAR_EXPECT_SIZE=577296
DROPBEAR_TARBALL_SHA256=0d1f7ca711cfc336dc8a85e672cab9cfd8223a02fe2da0a4a7aeb58c9e113634

#: pinned executable SHA-256 of the official Zig 0.16.0 `zig`, one per host
#: it is published for: aarch64-macos, x86_64-linux (CI), aarch64-linux. Each
#: comes from the tarball whose SHA-256 ziglang.org's index.json lists.
ZIG_SHA256_AARCH64_MACOS=e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec
ZIG_SHA256_X86_64_LINUX=2317bbb91798556d9d0f38aabdac23db83f0979b25f767259ae474546724087c
ZIG_SHA256_AARCH64_LINUX=6e2989a7efbd4e81acbacb6c6378e34340d8e88bb023b10c4a941021be55cdcb
WEBUI_ZIG_SHA256="$ZIG_SHA256_AARCH64_MACOS $ZIG_SHA256_X86_64_LINUX $ZIG_SHA256_AARCH64_LINUX"
OFFICIAL_ZIG_SHA256=$WEBUI_ZIG_SHA256

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
  case " $_expect_sha " in
    *" $_sha "*) ;;
    *)
      echo "error: $_label executable SHA-256 mismatch (found $_sha, expected one of: $_expect_sha)" >&2
      exit 1
      ;;
  esac
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

#: every Zig-built binary drops the unloaded MIPS .pdr section (why: see
#: build/discard-mips-pdr.ld). -Wl, splits on commas, so refuse a path that has one.
case $SCRIPT_DIR in
  *,*) echo "error: the checkout path contains a comma, which -Wl, would split: $SCRIPT_DIR" >&2; exit 1 ;;
esac
PDR_LDFLAGS="-Wl,-T,$SCRIPT_DIR/discard-mips-pdr.ld"

# ---------------------------------------------------------------------------
# codex_webui — Official Zig 0.16.0 (clang/LLD 21.1.0), mips32r2.
# ---------------------------------------------------------------------------
WEBUI_ZIG=${WEBUI_ZIG:-$(command -v zig || true)}
check_zig "WEBUI_ZIG" "$WEBUI_ZIG" "$WEBUI_ZIG_SHA256" "$WEBUI_ZIG_FINGERPRINT"

(
  cd "$REPO_ROOT"
  "$WEBUI_ZIG" cc -target mips-linux-musleabi -Os -static -s "$PDR_LDFLAGS" \
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
  "$OFFICIAL_ZIG" cc -target mips-linux-musleabi -Os -static -s "$PDR_LDFLAGS" \
    -o build/output/codex_bt_pair_agent \
    payload/source/codex_bt_pair_agent.c
  "$OFFICIAL_ZIG" cc -target mips-linux-musleabi -Os -static -s "$PDR_LDFLAGS" \
    -o build/output/codex_bthid_keyboard \
    payload/source/codex_bthid_keyboard.c
  "$OFFICIAL_ZIG" cc -target mips-linux-musleabi -Os -static -s "$PDR_LDFLAGS" \
    -o build/output/codex_hal_ltcp \
    payload/source/codex_hal_ltcp.c
  "$OFFICIAL_ZIG" cc -target mips-linux-musleabi -mcpu=mips32 -Os -static -s "$PDR_LDFLAGS" \
    -o build/output/codex_hbus \
    payload/source/codex_hbus.c
  "$OFFICIAL_ZIG" cc -target mips-linux-musleabi -Os -static -s "$PDR_LDFLAGS" \
    -o build/output/codex_dhcpd \
    payload/source/codex_dhcpd.c
  "$OFFICIAL_ZIG" cc -target mips-linux-musleabi -Os -static -s "$PDR_LDFLAGS" \
    -o build/output/codex_portal \
    payload/source/codex_portal.c
  "$OFFICIAL_ZIG" cc -target mips-linux-musleabi -Os -static -s "$PDR_LDFLAGS" \
    -o build/output/codex_usbeth \
    payload/source/codex_usbeth.c
  "$OFFICIAL_ZIG" cc -target mips-linux-musleabi -mcpu=mips32 -Os -static -s "$PDR_LDFLAGS" \
    -o build/output/codex_flash_free \
    payload/source/codex_flash_free.c
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
USBETH_SHA256=$(sha256_of "$OUT/codex_usbeth")
USBETH_SIZE=$(wc -c < "$OUT/codex_usbeth" | tr -d ' ')
if [ "$USBETH_SHA256" != "$USBETH_EXPECT_SHA256" ] || [ "$USBETH_SIZE" != "$USBETH_EXPECT_SIZE" ]; then
  echo "error: codex_usbeth build is not exact (size $USBETH_SIZE, sha256 $USBETH_SHA256; expected size $USBETH_EXPECT_SIZE, sha256 $USBETH_EXPECT_SHA256)" >&2
  exit 1
fi
FLASHFREE_SHA256=$(sha256_of "$OUT/codex_flash_free")
FLASHFREE_SIZE=$(wc -c < "$OUT/codex_flash_free" | tr -d ' ')
if [ "$FLASHFREE_SHA256" != "$FLASHFREE_EXPECT_SHA256" ] || [ "$FLASHFREE_SIZE" != "$FLASHFREE_EXPECT_SIZE" ]; then
  echo "error: codex_flash_free build is not exact (size $FLASHFREE_SIZE, sha256 $FLASHFREE_SHA256; expected size $FLASHFREE_EXPECT_SIZE, sha256 $FLASHFREE_EXPECT_SHA256)" >&2
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
  "$OFFICIAL_ZIG" cc -target mips-linux-musleabi -Os -static -s "$PDR_LDFLAGS" \
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

# ---------------------------------------------------------------------------
# busybox-extra — BusyBox 1.37.0, Official Zig 0.16.0, static. A second
# BusyBox beside the hub's own (1.13.4, which is left alone) with the
# commands the stock one lacks. Not named "busybox", so a PATH that puts
# /data/codex/bin first still finds the stock one; BusyBox answers to any
# name that starts with "busybox". The complete corresponding source is the pinned upstream
# tarball plus third_party/busybox-$BUSYBOX_VERSION/ (patches, the exact
# .config, LICENSE) and this section. Needs a host C compiler for kconfig
# (HOSTCC, default cc) and GNU make.
# ---------------------------------------------------------------------------
BUSYBOX_TARBALL="$BUILD/busybox-$BUSYBOX_VERSION.tar.bz2"
BUSYBOX_URL="https://busybox.net/downloads/busybox-$BUSYBOX_VERSION.tar.bz2"
BUSYBOX_THIRD_PARTY="$REPO_ROOT/third_party/busybox-$BUSYBOX_VERSION"
if [ ! -f "$BUSYBOX_TARBALL" ]; then
  # download to .part first, so an interrupted fetch isn't mistaken for the tarball
  wget -O "$BUSYBOX_TARBALL.part" "$BUSYBOX_URL"
  mv "$BUSYBOX_TARBALL.part" "$BUSYBOX_TARBALL"
fi
BUSYBOX_TARBALL_SHA256_FOUND=$(sha256_of "$BUSYBOX_TARBALL")
if [ "$BUSYBOX_TARBALL_SHA256_FOUND" != "$BUSYBOX_TARBALL_SHA256" ]; then
  echo "error: BusyBox tarball SHA-256 mismatch (found $BUSYBOX_TARBALL_SHA256_FOUND, expected $BUSYBOX_TARBALL_SHA256)" >&2
  exit 1
fi
rm -rf "$BUILD/busybox-$BUSYBOX_VERSION" "$BUILD/busybox-out"
tar -C "$BUILD" -xjf "$BUSYBOX_TARBALL"
for _patch in "$BUSYBOX_THIRD_PARTY"/patches/*.patch; do
  patch -d "$BUILD/busybox-$BUSYBOX_VERSION" -p1 --no-backup-if-mismatch < "$_patch"
done
mkdir -p "$BUILD/busybox-out"
cp "$BUSYBOX_THIRD_PARTY/busybox.config" "$BUILD/busybox-out/.config"
(
  # A fixed build date (1.37.0's release day) and locale keep the output
  # the same on every machine.
  export BUSYBOX_ZIG="$OFFICIAL_ZIG" SOURCE_DATE_EPOCH=1727395200 TZ=UTC LC_ALL=C
  make -s -C "$BUILD/busybox-$BUSYBOX_VERSION" O="$BUILD/busybox-out" \
    HOSTCC="${HOSTCC:-cc}" oldconfig < /dev/null > /dev/null
  #: fail closed if kconfig resolved the committed .config to anything else
  if ! cmp -s "$BUSYBOX_THIRD_PARTY/busybox.config" "$BUILD/busybox-out/.config"; then
    echo "error: BusyBox .config changed under oldconfig; regenerate third_party/busybox-$BUSYBOX_VERSION/busybox.config" >&2
    exit 1
  fi
  make -s -C "$BUILD/busybox-$BUSYBOX_VERSION" O="$BUILD/busybox-out" -j"$(nproc)" \
    CC="$SCRIPT_DIR/busybox-zig-cc.sh" AR="$SCRIPT_DIR/busybox-zig-ar.sh" \
    HOSTCC="${HOSTCC:-cc}" EXTRA_LDFLAGS="-s $PDR_LDFLAGS" SKIP_STRIP=y busybox
)
cp "$BUILD/busybox-out/busybox" "$OUT/busybox-extra"
BUSYBOX_SHA256=$(sha256_of "$OUT/busybox-extra")
BUSYBOX_SIZE=$(wc -c < "$OUT/busybox-extra" | tr -d ' ')
if [ "$BUSYBOX_SHA256" != "$BUSYBOX_EXPECT_SHA256" ] || [ "$BUSYBOX_SIZE" != "$BUSYBOX_EXPECT_SIZE" ]; then
  echo "error: busybox-extra build is not exact (size $BUSYBOX_SIZE, sha256 $BUSYBOX_SHA256; expected size $BUSYBOX_EXPECT_SIZE, sha256 $BUSYBOX_EXPECT_SHA256)" >&2
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
md5sum codex_dhcpd codex_portal codex_hbus codex_hal_ltcp codex_bthid_keyboard codex_bt_pair_agent codex_androidtv codex_usbeth codex_webui dropbearmulti busybox-extra > MD5SUMS
file codex_dhcpd codex_portal codex_hbus codex_hal_ltcp codex_bthid_keyboard codex_bt_pair_agent codex_androidtv codex_usbeth codex_webui dropbearmulti busybox-extra > FILES
ls -l codex_dhcpd codex_portal codex_hbus codex_hal_ltcp codex_bthid_keyboard codex_bt_pair_agent codex_androidtv codex_usbeth codex_webui dropbearmulti busybox-extra > MANIFEST.txt
cat MD5SUMS >> MANIFEST.txt
