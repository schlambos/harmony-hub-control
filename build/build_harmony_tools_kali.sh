#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

SRC="$REPO_ROOT/payload/source"
TOOLS="$SCRIPT_DIR/toolchains"
BUILD="$SCRIPT_DIR/tmp"
OUT="$SCRIPT_DIR/output"
PINS="$SCRIPT_DIR/pins"

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

#: expected output digests live in build/pins/<name> (SHA256 and SIZE, fail
#: closed on any mismatch).

#: BearSSL 0.6 source for codex_androidtv (bearssl.org publishes no checksum; this
#: is the tarball's SHA-256 as downloaded on 2026-11-07)
BEARSSL_VERSION=0.6
BEARSSL_SHA256=6705bba1714961b41a728dfc5debbe348d2966c117649392f8c8139efc83ff14
#: BusyBox 1.37.0 (GPL-2.0): pinned upstream tarball (busybox.net publishes a
#: .sha256 beside it; this matches it)
BUSYBOX_VERSION=1.37.0
BUSYBOX_TARBALL_SHA256=3311dff32e746499f4df0d5df04d7eb396382d7e108bb9250e7b519b837043a4
#: Dropbear 2025.89 pinned upstream source tarball
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

#: check_pin <name> <built_file>: read build/pins/<name> and fail closed on any
#: size or SHA-256 mismatch.
check_pin() {
  _pin_name="$1"
  _pin_file="$2"
  _pin_path="$PINS/$_pin_name"
  if [ ! -f "$_pin_path" ]; then
    echo "error: missing pin file $_pin_path" >&2
    exit 1
  fi
  SHA256=""
  SIZE=""
  # shellcheck disable=SC1090
  . "$_pin_path"
  if [ -z "$SHA256" ] || [ -z "$SIZE" ]; then
    echo "error: $_pin_path must define SHA256 and SIZE" >&2
    exit 1
  fi
  _found_sha=$(sha256_of "$_pin_file")
  _found_size=$(wc -c < "$_pin_file" | tr -d ' ')
  if [ "$_found_sha" != "$SHA256" ] || [ "$_found_size" != "$SIZE" ]; then
    echo "error: $_pin_name build is not exact (size $_found_size, sha256 $_found_sha; expected size $SIZE, sha256 $SHA256 from build/pins/$_pin_name)" >&2
    exit 1
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
check_pin codex_webui "$OUT/codex_webui"

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

for _zig_bin in codex_bt_pair_agent codex_bthid_keyboard codex_hal_ltcp codex_hbus codex_dhcpd codex_portal codex_usbeth codex_flash_free; do
  check_pin "$_zig_bin" "$OUT/$_zig_bin"
done

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
check_pin codex_androidtv "$OUT/codex_androidtv"

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
check_pin busybox-extra "$OUT/busybox-extra"

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
# -R .pdr: also drop the MIPS procedure-descriptor section, a debugging aid
# that no segment loads (plain strip keeps it). Same code and data, 41 KB
# smaller; the file tools/hub-root bundles, and the one proposed for
# harmony-hub-root in Ripthulhu/harmony-hub-root#10. Plain strip gave sha256
# e2ea632a..., 577296 bytes (what harmony-hub-root ships until then), which
# the installers still accept (DROPBEAR_BUILDS).
"$STRIP" -R .pdr dropbearmulti || true
cp dropbearmulti "$OUT/dropbearmulti"

#: fail closed unless the rebuild reproduces the committed binary exactly
check_pin dropbearmulti "$OUT/dropbearmulti"

cd "$OUT"
ln -sf dropbearmulti dropbear
ln -sf dropbearmulti dropbearkey
BIN_LIST="busybox-extra codex_androidtv codex_bt_pair_agent codex_bthid_keyboard codex_dhcpd codex_hal_ltcp codex_hbus codex_portal codex_usbeth codex_webui dropbearmulti"
# shellcheck disable=SC2086
md5sum $BIN_LIST > MD5SUMS
# shellcheck disable=SC2086
file $BIN_LIST > FILES
: > MANIFEST.txt
for _bin in $BIN_LIST; do
  _sz=$(wc -c < "$_bin" | tr -d ' ')
  printf -- '-rwxr-xr-x 1 codex codex %s 1970-01-01 00:00 %s\n' "$_sz" "$_bin" >> MANIFEST.txt
done
cat MD5SUMS >> MANIFEST.txt
