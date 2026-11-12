#!/bin/sh
# Rebuild every shipped binary from source with the pinned toolchains and
# compare each with the committed file, byte for byte. CI runs this
# (.github/workflows/ci.yml) in a pinned Debian container; docs/CI.md has the
# same command for a local container.
#
#   sh tools/ci/rebuild_check.sh
#
# Linux only: Dropbear needs the Bootlin toolchain and BusyBox needs GNU make.
# It checks, in order:
#   1. the generated sources are what their generators write
#      (harmony_shell_assets.h with bun 1.3.14, activity_ui_assets.h, and the
#      two-screen hal edits when pyelftools is installed);
#   2. build/build_harmony_tools_kali.sh builds everything, against its own
#      *_EXPECT_* pins;
#   3. each built file is the committed one.
# Not rebuilt: payload/modules/usb-net/*.ko. Their kernel tree and backport
# sources are not in the repository; tools/ci/verify_pins.py checks their pins.
#
# Toolchains go to build/toolchains/ (ignored by git), each checked against a
# pinned SHA-256 before it is unpacked. Set OFFICIAL_ZIG to use a Zig 0.16.0
# you already have; the build script still checks its executable.
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$HERE/../.." && pwd)
TOOLS="$REPO_ROOT/build/toolchains"
OUT="$REPO_ROOT/build/output"
cd "$REPO_ROOT"

#: official Zig 0.16.0 tarballs, SHA-256 from https://ziglang.org/download/index.json
ZIG_VERSION=0.16.0
ZIG_TARBALL_SHA256_X86_64=70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00
ZIG_TARBALL_SHA256_AARCH64=ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17
#: Bootlin's toolchain (Dropbear only), SHA-256 from the .sha256 beside the tarball
BOOTLIN_NAME=mips32--uclibc--stable-2017.05-toolchains-1-1
BOOTLIN_SHA256=a75aeb0f82eaeaf1989a7dfdf80219486b5ed1470c29c6f253fbcf824922c29f
BUN_VERSION=1.3.14

sha256_of() { sha256sum "$1" | awk '{print $1}'; }

#: fetch <url> <file> <sha256>: download unless already there, then fail closed
fetch() {
  if [ ! -f "$2" ]; then
    wget -q -O "$2.part" "$1"
    mv "$2.part" "$2"
  fi
  _found=$(sha256_of "$2")
  if [ "$_found" != "$3" ]; then
    echo "error: $(basename "$2") SHA-256 mismatch (found $_found, expected $3)" >&2
    exit 1
  fi
}

if [ "$(uname -s)" != Linux ]; then
  echo "error: rebuild_check needs Linux (docs/CI.md has the container command)" >&2
  exit 1
fi
mkdir -p "$TOOLS"

if [ -z "${OFFICIAL_ZIG:-}" ]; then
  case $(uname -m) in
    x86_64) zig_arch=x86_64 zig_sha=$ZIG_TARBALL_SHA256_X86_64 ;;
    aarch64 | arm64) zig_arch=aarch64 zig_sha=$ZIG_TARBALL_SHA256_AARCH64 ;;
    *) echo "error: no pinned Zig for $(uname -m)" >&2; exit 1 ;;
  esac
  zig_name=zig-$zig_arch-linux-$ZIG_VERSION
  fetch "https://ziglang.org/download/$ZIG_VERSION/$zig_name.tar.xz" "$TOOLS/$zig_name.tar.xz" "$zig_sha"
  [ -x "$TOOLS/$zig_name/zig" ] || tar -C "$TOOLS" -xJf "$TOOLS/$zig_name.tar.xz"
  OFFICIAL_ZIG=$TOOLS/$zig_name/zig
fi
export OFFICIAL_ZIG WEBUI_ZIG="${WEBUI_ZIG:-$OFFICIAL_ZIG}"

#: the build script downloads this itself but doesn't check it; put a checked
#: copy where it looks first
fetch "https://toolchains.bootlin.com/downloads/releases/toolchains/mips32/tarballs/$BOOTLIN_NAME.tar.bz2" \
  "$TOOLS/$BOOTLIN_NAME.tar.bz2" "$BOOTLIN_SHA256"

status=0
note() { printf '%-9s %s\n' "$1" "$2"; }

echo "== generated sources"
BUN=${BUN:-$(command -v bun || true)}
if [ -z "$BUN" ] || [ "$("$BUN" --version 2>/dev/null)" != "$BUN_VERSION" ]; then
  note FAIL "harmony_shell_assets.h: needs bun $BUN_VERSION (found: ${BUN:-none} $("${BUN:-false}" --version 2>/dev/null || true))"
  status=1
else
  BUN=$BUN sh tools/package_harmony_shell.sh > /dev/null
fi
sh tools/embed_activity_ui.sh > /dev/null
for header in payload/source/harmony_shell_assets.h payload/source/activity_ui_assets.h; do
  if git diff --quiet -- "$header"; then
    note ok "$header is what its generator writes"
  else
    note FAIL "$header differs from what its generator writes (run the generator and commit the result)"
    git --no-pager diff --stat -- "$header"
    status=1
  fi
done
if python3 -c 'import elftools' 2> /dev/null; then
  if HAL_REMOTES_ZIG=$OFFICIAL_ZIG python3 tools/build_hal_remotes.py --check > /dev/null; then
    note ok "payload/helpers/hal_remotes_patch.json is what its source builds"
  else
    note FAIL "payload/helpers/hal_remotes_patch.json differs from what its source builds"
    status=1
  fi
else
  note skipped "hal_remotes_patch.json (pyelftools is not installed)"
fi

echo "== build"
rm -rf "$OUT"
if sh build/build_harmony_tools_kali.sh > "$TOOLS/build.log" 2>&1; then
  note ok "build/build_harmony_tools_kali.sh built everything and its pins held"
else
  note FAIL "build/build_harmony_tools_kali.sh stopped (last lines follow; binaries after that point were not built)"
  tail -n 25 "$TOOLS/build.log"
  status=1
fi

echo "== built file against committed file"
BUILT="codex_webui codex_hbus codex_bt_pair_agent codex_bthid_keyboard codex_hal_ltcp
  codex_dhcpd codex_portal codex_usbeth codex_androidtv busybox-extra dropbearmulti"
#: a payload/bin binary the build doesn't write would otherwise go unchecked
for path in payload/bin/*; do
  name=$(basename "$path")
  case $name in MANIFEST.txt | FILES) continue ;; esac
  case " $(echo $BUILT) " in
    *" $name "*) ;;
    *)
      note FAIL "$path: tools/ci/rebuild_check.sh doesn't rebuild it, so nothing proves its source"
      status=1
      ;;
  esac
done
for name in $BUILT codex_flash_free; do
  committed=payload/bin/$name
  [ "$name" = codex_flash_free ] && committed=payload/helpers/$name
  if [ ! -f "$OUT/$name" ]; then
    note FAIL "$committed: not built"
    status=1
  elif cmp -s "$OUT/$name" "$committed"; then
    note ok "$committed  $(sha256_of "$committed")"
  else
    note FAIL "$committed: built $(sha256_of "$OUT/$name") ($(wc -c < "$OUT/$name" | tr -d ' ') bytes), committed $(sha256_of "$committed") ($(wc -c < "$committed" | tr -d ' ') bytes)"
    status=1
  fi
done
note skipped "payload/modules/usb-net/*.ko (kernel tree and backport sources are not in the repository)"

if [ "$status" -eq 0 ]; then
  echo "rebuild_check: every shipped binary is what its source builds"
else
  echo "rebuild_check: FAILED" >&2
fi
exit "$status"
