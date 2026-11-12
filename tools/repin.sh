#!/bin/sh
# Regenerate embedded web headers, rebuild changed or requested MIPS binaries,
# update build/pins/<name> and payload/bin/MANIFEST.txt, and verify all pins.
#
# Usage:
#   sh tools/repin.sh                  # rebuild Zig binaries whose inputs changed
#   sh tools/repin.sh codex_webui ...  # rebuild the named binaries
#   sh tools/repin.sh --all            # rebuild all 10 Zig binaries + web headers
#   sh tools/repin.sh --pin-only [..]  # refresh build/pins/* + MANIFEST.txt without compiling
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=${REPIN_REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || (CDPATH= cd -- "$HERE/.." && pwd))}
cd "$REPO_ROOT"

ZIG_VERSION=0.16.0
ZIG_SHA256_AARCH64_MACOS=e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec
ZIG_SHA256_X86_64_LINUX=2317bbb91798556d9d0f38aabdac23db83f0979b25f767259ae474546724087c
ZIG_SHA256_AARCH64_LINUX=6e2989a7efbd4e81acbacb6c6378e34340d8e88bb023b10c4a941021be55cdcb
ZIG_ALL_SHA256="$ZIG_SHA256_AARCH64_MACOS $ZIG_SHA256_X86_64_LINUX $ZIG_SHA256_AARCH64_LINUX"
ZIG_FINGERPRINT="clang version 21.1.0"

ZIG_TARBALL_SHA256_MACOS_AARCH64=b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489
ZIG_TARBALL_SHA256_LINUX_X86_64=70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00
ZIG_TARBALL_SHA256_LINUX_AARCH64=ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17

BEARSSL_VERSION=0.6
BEARSSL_SHA256=6705bba1714961b41a728dfc5debbe348d2966c117649392f8c8139efc83ff14
BUN_VERSION=1.3.14

ZIG_BINS="codex_webui codex_bt_pair_agent codex_bthid_keyboard codex_hal_ltcp codex_hbus codex_dhcpd codex_portal codex_usbeth codex_flash_free codex_androidtv"
ALL_BINS="$ZIG_BINS busybox-extra dropbearmulti"

usage() {
  cat <<'EOF'
Usage: sh tools/repin.sh [--all] [--pin-only] [--base <ref>] [binary...]

Rebuilds changed (or requested) MIPS binaries from source using Official Zig
0.16.0, updates build/pins/<name> and payload/bin/MANIFEST.txt, and verifies
every pin with tools/ci/verify_pins.py.
EOF
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

download_file() {
  _url="$1"
  _dest="$2"
  mkdir -p "$(dirname "$_dest")"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$_url" -o "$_dest.part"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$_dest.part" "$_url"
  else
    echo "error: need curl or wget to download $_url" >&2
    exit 1
  fi
  mv "$_dest.part" "$_dest"
}

is_valid_zig() {
  _cand="$1"
  [ -n "$_cand" ] && [ -x "$_cand" ] || return 1
  _sha=$(sha256_of "$_cand")
  case " $ZIG_ALL_SHA256 " in
    *" $_sha "*) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_zig() {
  if [ -n "${OFFICIAL_ZIG:-}" ]; then
    check_zig "$OFFICIAL_ZIG"
    return 0
  fi
  for _cand in \
    "${WEBUI_ZIG:-}" \
    "$REPO_ROOT/build/toolchains/zig-aarch64-macos-$ZIG_VERSION/zig" \
    "$REPO_ROOT/build/toolchains/zig-x86_64-linux-$ZIG_VERSION/zig" \
    "$REPO_ROOT/build/toolchains/zig-aarch64-linux-$ZIG_VERSION/zig" \
    "$REPO_ROOT/../toolchains/zig-aarch64-macos-$ZIG_VERSION/zig" \
    "$REPO_ROOT/../toolchains/zig-x86_64-linux-$ZIG_VERSION/zig" \
    "$REPO_ROOT/../toolchains/zig-aarch64-linux-$ZIG_VERSION/zig" \
    "$HOME/Repos/harmony/toolchains/zig-aarch64-macos-$ZIG_VERSION/zig" \
    "$HOME/.cache/melodious-toolchains/zig-aarch64-macos-$ZIG_VERSION/zig" \
    "$HOME/.cache/melodious-toolchains/zig-x86_64-linux-$ZIG_VERSION/zig" \
    "$HOME/.cache/melodious-toolchains/zig-aarch64-linux-$ZIG_VERSION/zig" \
    "$(command -v zig 2>/dev/null || true)"; do
    if is_valid_zig "$_cand"; then
      OFFICIAL_ZIG="$_cand"
      check_zig "$OFFICIAL_ZIG"
      return 0
    fi
  done

  _cache_dir="${MELODIOUS_TOOLCHAIN_CACHE:-$HOME/.cache/melodious-toolchains}"
  mkdir -p "$_cache_dir"
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64|Darwin-aarch64)
      _zname="zig-aarch64-macos-$ZIG_VERSION"
      _zsha="$ZIG_TARBALL_SHA256_MACOS_AARCH64"
      ;;
    Linux-x86_64)
      _zname="zig-x86_64-linux-$ZIG_VERSION"
      _zsha="$ZIG_TARBALL_SHA256_LINUX_X86_64"
      ;;
    Linux-aarch64|Linux-arm64)
      _zname="zig-aarch64-linux-$ZIG_VERSION"
      _zsha="$ZIG_TARBALL_SHA256_LINUX_AARCH64"
      ;;
    *)
      echo "error: Official Zig $ZIG_VERSION is not found and no pinned download is configured for $(uname -s)-$(uname -m); set OFFICIAL_ZIG" >&2
      exit 1
      ;;
  esac
  _ztar="$_cache_dir/$_zname.tar.xz"
  if [ ! -f "$_ztar" ]; then
    echo "repin: downloading $_zname.tar.xz..." >&2
    download_file "https://ziglang.org/download/$ZIG_VERSION/$_zname.tar.xz" "$_ztar"
  fi
  _found_sha=$(sha256_of "$_ztar")
  if [ "$_found_sha" != "$_zsha" ]; then
    echo "error: $_ztar SHA-256 mismatch (found $_found_sha, expected $_zsha)" >&2
    exit 1
  fi
  if [ ! -x "$_cache_dir/$_zname/zig" ]; then
    tar -C "$_cache_dir" -xJf "$_ztar"
  fi
  OFFICIAL_ZIG="$_cache_dir/$_zname/zig"
  check_zig "$OFFICIAL_ZIG"
}

check_zig() {
  _bin="$1"
  if [ ! -x "$_bin" ]; then
    echo "error: OFFICIAL_ZIG is not an executable: $_bin" >&2
    exit 1
  fi
  _sha=$(sha256_of "$_bin")
  case " $ZIG_ALL_SHA256 " in
    *" $_sha "*) ;;
    *)
      echo "error: OFFICIAL_ZIG executable SHA-256 mismatch (found $_sha, expected one of: $ZIG_ALL_SHA256)" >&2
      exit 1
      ;;
  esac
  _ver=$("$_bin" version 2>/dev/null || true)
  if [ "$_ver" != "$ZIG_VERSION" ]; then
    echo "error: OFFICIAL_ZIG requires Zig $ZIG_VERSION (found: ${_ver:-unknown})" >&2
    exit 1
  fi
  _fp=$("$_bin" cc --version 2>/dev/null | head -n 1 || true)
  case "$_fp" in
    "$ZIG_FINGERPRINT"*) ;;
    *)
      echo "error: OFFICIAL_ZIG clang/LLD fingerprint mismatch (found '$_fp', expected '$ZIG_FINGERPRINT')" >&2
      exit 1
      ;;
  esac
}

resolve_bun() {
  for _cand in \
    "${BUN:-}" \
    "$(command -v bun 2>/dev/null || true)" \
    "$HOME/.local/bin/bun" \
    "$HOME/.bun/bin/bun" \
    "/opt/homebrew/bin/bun" \
    "/usr/local/bin/bun"; do
    if [ -n "$_cand" ] && [ -x "$_cand" ] && [ "$("$_cand" --version 2>/dev/null || true)" = "$BUN_VERSION" ]; then
      BUN="$_cand"
      export BUN
      return 0
    fi
  done
  if [ -f "$REPO_ROOT/tools/ci/install_bun.sh" ]; then
    sh "$REPO_ROOT/tools/ci/install_bun.sh" "$HOME/.local/bin" >/dev/null
    if [ -x "$HOME/.local/bin/bun" ] && [ "$("$HOME/.local/bin/bun" --version 2>/dev/null || true)" = "$BUN_VERSION" ]; then
      BUN="$HOME/.local/bin/bun"
      export BUN
      return 0
    fi
  fi
  echo "error: harmony_shell_assets.h requires bun $BUN_VERSION (run: sh tools/ci/install_bun.sh \"\$HOME/.local/bin\")" >&2
  exit 1
}

binary_path() {
  case "$1" in
    codex_flash_free) echo "payload/helpers/codex_flash_free" ;;
    *) echo "payload/bin/$1" ;;
  esac
}

write_pin() {
  _name="$1"
  _rel=$(binary_path "$_name")
  _full="$REPO_ROOT/$_rel"
  if [ ! -f "$_full" ]; then
    echo "error: cannot pin missing file $_rel" >&2
    exit 1
  fi
  mkdir -p "$REPO_ROOT/build/pins"
  _sha=$(sha256_of "$_full")
  _size=$(wc -c < "$_full" | tr -d ' ')
  printf 'SHA256=%s\nSIZE=%s\n' "$_sha" "$_size" > "$REPO_ROOT/build/pins/$_name"
  echo "repin: pinned $_name (size $_size, sha256 $_sha)"
}

ensure_bearssl() {
  _build_tmp="$REPO_ROOT/build/tmp"
  mkdir -p "$_build_tmp"
  _tar="$_build_tmp/bearssl-$BEARSSL_VERSION.tar.gz"
  if [ ! -f "$_tar" ]; then
    for _cached in \
      "$REPO_ROOT/../harmony-hub-control/build/tmp/bearssl-$BEARSSL_VERSION.tar.gz" \
      "$HOME/Repos/harmony/harmony-hub-control/build/tmp/bearssl-$BEARSSL_VERSION.tar.gz" \
      "$HOME/.cache/melodious-toolchains/bearssl-$BEARSSL_VERSION.tar.gz"; do
      if [ -f "$_cached" ]; then
        cp "$_cached" "$_tar"
        break
      fi
    done
  fi
  if [ ! -f "$_tar" ]; then
    _cache_dir="${MELODIOUS_TOOLCHAIN_CACHE:-$HOME/.cache/melodious-toolchains}"
    mkdir -p "$_cache_dir"
    download_file "https://www.bearssl.org/bearssl-$BEARSSL_VERSION.tar.gz" "$_cache_dir/bearssl-$BEARSSL_VERSION.tar.gz"
    cp "$_cache_dir/bearssl-$BEARSSL_VERSION.tar.gz" "$_tar"
  fi
  _found=$(sha256_of "$_tar")
  if [ "$_found" != "$BEARSSL_SHA256" ]; then
    echo "error: BearSSL tarball SHA-256 mismatch (found $_found, expected $BEARSSL_SHA256)" >&2
    exit 1
  fi
  if [ ! -d "$_build_tmp/bearssl-$BEARSSL_VERSION/src" ]; then
    rm -rf "$_build_tmp/bearssl-$BEARSSL_VERSION"
    tar -C "$_build_tmp" -xzf "$_tar"
  fi
}

build_one() {
  _name="$1"
  case "$_name" in
    busybox-extra|dropbearmulti)
      if [ "$(uname -s)" != Linux ]; then
        echo "error: $_name cannot be rebuilt on $(uname -s) (needs Linux / GNU make / Bootlin toolchain; run 'sh tools/ci/rebuild_in_docker.sh' or build on Linux)" >&2
        exit 1
      fi
      ;;
  esac

  case "$REPO_ROOT" in
    *,*)
      echo "error: checkout path contains a comma, which -Wl, would split: $REPO_ROOT" >&2
      exit 1
      ;;
  esac
  _pdr="-Wl,-T,$REPO_ROOT/build/discard-mips-pdr.ld"

  case "$_name" in
    codex_webui)
      resolve_zig
      echo "repin: building codex_webui..."
      "$OFFICIAL_ZIG" cc -target mips-linux-musleabi -Os -static -s "$_pdr" \
        -I payload/source \
        -o payload/bin/codex_webui \
        payload/source/codex_webui.c
      ;;
    codex_bt_pair_agent|codex_bthid_keyboard|codex_hal_ltcp|codex_dhcpd|codex_portal|codex_usbeth)
      resolve_zig
      echo "repin: building $_name..."
      "$OFFICIAL_ZIG" cc -target mips-linux-musleabi -Os -static -s "$_pdr" \
        -o "payload/bin/$_name" \
        "payload/source/$_name.c"
      ;;
    codex_hbus)
      resolve_zig
      echo "repin: building codex_hbus..."
      "$OFFICIAL_ZIG" cc -target mips-linux-musleabi -mcpu=mips32 -Os -static -s "$_pdr" \
        -o payload/bin/codex_hbus \
        payload/source/codex_hbus.c
      ;;
    codex_flash_free)
      resolve_zig
      echo "repin: building codex_flash_free..."
      "$OFFICIAL_ZIG" cc -target mips-linux-musleabi -mcpu=mips32 -Os -static -s "$_pdr" \
        -o payload/helpers/codex_flash_free \
        payload/source/codex_flash_free.c
      ;;
    codex_androidtv)
      resolve_zig
      ensure_bearssl
      echo "repin: building codex_androidtv..."
      (
        cd "$REPO_ROOT/build/tmp"
        # shellcheck disable=SC2046
        "$OFFICIAL_ZIG" cc -target mips-linux-musleabi -Os -static -s "$_pdr" \
          -ffunction-sections -fdata-sections -Wl,--gc-sections \
          -Ibearssl-$BEARSSL_VERSION/inc -Ibearssl-$BEARSSL_VERSION/src \
          -o "$REPO_ROOT/payload/bin/codex_androidtv" "$REPO_ROOT/payload/source/codex_androidtv.c" \
          $(find "bearssl-$BEARSSL_VERSION/src" -name '*.c' | LC_ALL=C sort)
      )
      ;;
    busybox-extra)
      resolve_zig
      echo "repin: building busybox-extra..."
      _bb_ver=1.37.0
      _bb_sha=3311dff32e746499f4df0d5df04d7eb396382d7e108bb9250e7b519b837043a4
      _bb_tar="$REPO_ROOT/build/tmp/busybox-$_bb_ver.tar.bz2"
      _bb_tp="$REPO_ROOT/third_party/busybox-$_bb_ver"
      mkdir -p "$REPO_ROOT/build/tmp"
      [ -f "$_bb_tar" ] || download_file "https://busybox.net/downloads/busybox-$_bb_ver.tar.bz2" "$_bb_tar"
      if [ "$(sha256_of "$_bb_tar")" != "$_bb_sha" ]; then
        echo "error: BusyBox tarball SHA-256 mismatch" >&2
        exit 1
      fi
      rm -rf "$REPO_ROOT/build/tmp/busybox-$_bb_ver" "$REPO_ROOT/build/tmp/busybox-out"
      tar -C "$REPO_ROOT/build/tmp" -xjf "$_bb_tar"
      for _patch in "$_bb_tp"/patches/*.patch; do
        patch -d "$REPO_ROOT/build/tmp/busybox-$_bb_ver" -p1 --no-backup-if-mismatch < "$_patch"
      done
      mkdir -p "$REPO_ROOT/build/tmp/busybox-out"
      cp "$_bb_tp/busybox.config" "$REPO_ROOT/build/tmp/busybox-out/.config"
      (
        export BUSYBOX_ZIG="$OFFICIAL_ZIG" SOURCE_DATE_EPOCH=1727395200 TZ=UTC LC_ALL=C
        make -s -C "$REPO_ROOT/build/tmp/busybox-$_bb_ver" O="$REPO_ROOT/build/tmp/busybox-out" \
          HOSTCC="${HOSTCC:-cc}" oldconfig < /dev/null > /dev/null
        cmp -s "$_bb_tp/busybox.config" "$REPO_ROOT/build/tmp/busybox-out/.config"
        make -s -C "$REPO_ROOT/build/tmp/busybox-$_bb_ver" O="$REPO_ROOT/build/tmp/busybox-out" -j"$(nproc)" \
          CC="$REPO_ROOT/build/busybox-zig-cc.sh" AR="$REPO_ROOT/build/busybox-zig-ar.sh" \
          HOSTCC="${HOSTCC:-cc}" EXTRA_LDFLAGS="-s $_pdr" SKIP_STRIP=y busybox
      )
      cp "$REPO_ROOT/build/tmp/busybox-out/busybox" "$REPO_ROOT/payload/bin/busybox-extra"
      ;;
    dropbearmulti)
      echo "repin: building dropbearmulti..."
      _tc_name=mips32--uclibc--stable-2017.05-toolchains-1-1
      _tc_sha=a75aeb0f82eaeaf1989a7dfdf80219486b5ed1470c29c6f253fbcf824922c29f
      _tc_tar="$REPO_ROOT/build/toolchains/$_tc_name.tar.bz2"
      _tc_dir="$REPO_ROOT/build/toolchains/mips32--uclibc--stable"
      mkdir -p "$REPO_ROOT/build/toolchains" "$REPO_ROOT/build/tmp"
      if [ ! -x "$_tc_dir/bin/mips-buildroot-linux-uclibc-gcc" ]; then
        [ -f "$_tc_tar" ] || download_file "https://toolchains.bootlin.com/downloads/releases/toolchains/mips32/tarballs/$_tc_name.tar.bz2" "$_tc_tar"
        if [ "$(sha256_of "$_tc_tar")" != "$_tc_sha" ]; then
          echo "error: Bootlin tarball SHA-256 mismatch" >&2
          exit 1
        fi
        tar -C "$REPO_ROOT/build/toolchains" -xf "$_tc_tar"
      fi
      _db_ver=2025.89
      _db_sha=0d1f7ca711cfc336dc8a85e672cab9cfd8223a02fe2da0a4a7aeb58c9e113634
      _db_tar="$REPO_ROOT/build/tmp/dropbear-$_db_ver.tar.bz2"
      [ -f "$_db_tar" ] || download_file "https://matt.ucc.asn.au/dropbear/releases/dropbear-$_db_ver.tar.bz2" "$_db_tar"
      if [ "$(sha256_of "$_db_tar")" != "$_db_sha" ]; then
        echo "error: Dropbear tarball SHA-256 mismatch" >&2
        exit 1
      fi
      rm -rf "$REPO_ROOT/build/tmp/dropbear-$_db_ver"
      tar -C "$REPO_ROOT/build/tmp" -xf "$_db_tar"
      (
        export PATH="$_tc_dir/bin:$PATH"
        cd "$REPO_ROOT/build/tmp/dropbear-$_db_ver"
        ./configure \
          --host=mips-buildroot-linux-uclibc \
          --disable-zlib --disable-pam --disable-lastlog \
          --disable-utmp --disable-utmpx --disable-wtmp --disable-wtmpx \
          --disable-loginfunc --disable-pututline --disable-pututxline \
          CC=mips-buildroot-linux-uclibc-gcc CFLAGS="-Os -static" LDFLAGS="-static"
        make -j"$(nproc)" MULTI=1 PROGRAMS="dropbear dropbearkey dbclient scp" dropbearmulti
        mips-buildroot-linux-uclibc-strip dropbearmulti || true
        cp dropbearmulti "$REPO_ROOT/payload/bin/dropbearmulti"
      )
      ;;
    *)
      echo "error: unknown binary '$_name' (expected one of: $ALL_BINS)" >&2
      exit 1
      ;;
  esac
  write_pin "$_name"
}

changed_files() {
  _base="$1"
  {
    git diff --name-only HEAD 2>/dev/null || true
    git diff --name-only --cached 2>/dev/null || true
    git ls-files --others --exclude-standard 2>/dev/null || true
    if [ -n "$_base" ] && git rev-parse -q --verify "$_base" >/dev/null 2>&1; then
      _mb=$(git merge-base HEAD "$_base" 2>/dev/null || true)
      if [ -n "$_mb" ]; then
        git diff --name-only "$_mb..HEAD" 2>/dev/null || true
      fi
    fi
    if git rev-parse -q --verify HEAD^2 >/dev/null 2>&1; then
      git diff --name-only HEAD^1..HEAD 2>/dev/null || true
      git diff --name-only HEAD^2..HEAD 2>/dev/null || true
    fi
  } | sort -u
}

ALL=0
PIN_ONLY=0
BASE="${REPIN_BASE:-}"
REQUESTED=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --all) ALL=1; shift ;;
    --pin-only) PIN_ONLY=1; shift ;;
    --base)
      [ "$#" -ge 2 ] || { echo "error: --base requires a git ref" >&2; exit 1; }
      BASE="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    -*)
      echo "error: unknown flag '$1'" >&2
      usage >&2
      exit 1
      ;;
    *)
      REQUESTED="$REQUESTED $1"
      shift
      ;;
  esac
done

if [ -z "$BASE" ]; then
  if git rev-parse -q --verify origin/main >/dev/null 2>&1; then
    BASE="origin/main"
  elif git rev-parse -q --verify main >/dev/null 2>&1; then
    BASE="main"
  fi
fi

if [ "$PIN_ONLY" -eq 1 ]; then
  _targets="${REQUESTED:-$ALL_BINS}"
  for _b in $_targets; do
    write_pin "$_b"
  done
  python3 "$REPO_ROOT/tools/ci/verify_pins.py" --write-manifest
  python3 "$REPO_ROOT/tools/ci/verify_pins.py"
  exit 0
fi

NEED_SHELL_HEADER=0
NEED_ACTIVITY_HEADER=0
TO_BUILD=""

add_build() {
  case " $TO_BUILD " in
    *" $1 "*) ;;
    *) TO_BUILD="$TO_BUILD $1" ;;
  esac
}

if [ "$ALL" -eq 1 ]; then
  NEED_SHELL_HEADER=1
  NEED_ACTIVITY_HEADER=1
  for _b in $ZIG_BINS; do
    add_build "$_b"
  done
fi

for _b in $REQUESTED; do
  if [ "$_b" = codex_webui ]; then
    NEED_SHELL_HEADER=1
    NEED_ACTIVITY_HEADER=1
  fi
  add_build "$_b"
done

if [ "$ALL" -eq 0 ] && [ -z "$REQUESTED" ]; then
  for _path in $(changed_files "$BASE"); do
    case "$_path" in
      tools/webui-sim/public/*|tools/package_harmony_shell.sh)
        NEED_SHELL_HEADER=1
        add_build codex_webui
        ;;
      payload/web/*|tools/embed_activity_ui.sh)
        NEED_ACTIVITY_HEADER=1
        add_build codex_webui
        ;;
      payload/source/codex_webui.c|payload/source/harmony_shell_assets.h|payload/source/activity_ui_assets.h|payload/source/remote_skin_jpg.h)
        add_build codex_webui
        ;;
      payload/source/codex_bt_pair_agent.c) add_build codex_bt_pair_agent ;;
      payload/source/codex_bthid_keyboard.c) add_build codex_bthid_keyboard ;;
      payload/source/codex_hal_ltcp.c) add_build codex_hal_ltcp ;;
      payload/source/codex_hbus.c) add_build codex_hbus ;;
      payload/source/codex_dhcpd.c) add_build codex_dhcpd ;;
      payload/source/codex_portal.c) add_build codex_portal ;;
      payload/source/codex_usbeth.c) add_build codex_usbeth ;;
      payload/source/codex_flash_free.c) add_build codex_flash_free ;;
      payload/source/codex_androidtv.c) add_build codex_androidtv ;;
      build/discard-mips-pdr.ld)
        for _zb in $ZIG_BINS; do add_build "$_zb"; done
        ;;
    esac
  done
fi

if [ "$NEED_SHELL_HEADER" -eq 1 ]; then
  resolve_bun
  echo "repin: regenerating payload/source/harmony_shell_assets.h..."
  BUN="$BUN" sh "$REPO_ROOT/tools/package_harmony_shell.sh" >/dev/null
fi

if [ "$NEED_ACTIVITY_HEADER" -eq 1 ]; then
  echo "repin: regenerating payload/source/activity_ui_assets.h..."
  sh "$REPO_ROOT/tools/embed_activity_ui.sh" >/dev/null
fi

for _b in $TO_BUILD; do
  build_one "$_b"
done

# Ensure every shipped binary has an up-to-date pin in build/pins/<name>
for _b in $ALL_BINS; do
  _pin_file="$REPO_ROOT/build/pins/$_b"
  _rel=$(binary_path "$_b")
  _full="$REPO_ROOT/$_rel"
  [ -f "$_full" ] || continue
  _actual_sha=$(sha256_of "$_full")
  _actual_size=$(wc -c < "$_full" | tr -d ' ')
  _expected=$(printf 'SHA256=%s\nSIZE=%s\n' "$_actual_sha" "$_actual_size")
  if [ ! -f "$_pin_file" ] || [ "$(cat "$_pin_file")" != "$_expected" ]; then
    write_pin "$_b"
  fi
done

python3 "$REPO_ROOT/tools/ci/verify_pins.py" --write-manifest
python3 "$REPO_ROOT/tools/ci/verify_pins.py"
