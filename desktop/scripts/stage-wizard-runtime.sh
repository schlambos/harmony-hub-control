#!/bin/sh
# stage-wizard-runtime.sh — deterministically stage relocatable CPython +
# hidapi==0.15.0 into desktop/build/wizard-python/{arm64,x64} for packaged
# macOS Melodious.app builds.
#
# Usage:
#   sh scripts/stage-wizard-runtime.sh [--arch arm64|x64|all]
#
# All upstream tarballs and wheels are SHA-256 verified before extraction.
# Licensing:
#   - python-build-standalone (PSF-2.0 + BSD-3-Clause; retains lib/python3.12/LICENSE.txt)
#   - hidapi 0.15.0 PyPI binary wheel (BSD-3-Clause / GPL-3.0 dual-licensed;
#     retains site-packages/hidapi-0.15.0.dist-info/licenses/LICENSE*.txt)
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DESKTOP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

TARGET_ARCH="all"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --arch)
      shift
      if [ "$#" -eq 0 ]; then
        echo "stage-wizard-runtime: --arch requires arm64, x64, or all" >&2
        exit 2
      fi
      TARGET_ARCH="$1"
      shift
      ;;
    --arch=*)
      TARGET_ARCH="${1#--arch=}"
      shift
      ;;
    -h|--help)
      echo "usage: $0 [--arch arm64|x64|all]"
      exit 0
      ;;
    *)
      echo "stage-wizard-runtime: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$TARGET_ARCH" in
  arm64) ARCH_LIST="arm64" ;;
  x64) ARCH_LIST="x64" ;;
  all) ARCH_LIST="arm64 x64" ;;
  *)
    echo "stage-wizard-runtime: invalid --arch '$TARGET_ARCH' (expected arm64, x64, or all)" >&2
    exit 2
    ;;
esac

PY_MINOR="3.12"
PBS_RELEASE="20261110"
PY_VERSION="3.12.16"
HIDAPI_VERSION="0.15.0"

PBS_ARM64_FILE="cpython-${PY_VERSION}+${PBS_RELEASE}-aarch64-apple-darwin-install_only_stripped.tar.gz"
PBS_ARM64_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/cpython-${PY_VERSION}%2B${PBS_RELEASE}-aarch64-apple-darwin-install_only_stripped.tar.gz"
PBS_ARM64_SHA256="2f11b8aa3726bdbd87dd9eb76568412faddf4f47e26913fa45d6a2e424972acd"

PBS_X64_FILE="cpython-${PY_VERSION}+${PBS_RELEASE}-x86_64-apple-darwin-install_only_stripped.tar.gz"
PBS_X64_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/cpython-${PY_VERSION}%2B${PBS_RELEASE}-x86_64-apple-darwin-install_only_stripped.tar.gz"
PBS_X64_SHA256="b78a4c479f1964ec484880bee567568266f68da102269fb93a05fe8716b45f91"

HID_ARM64_FILE="hidapi-${HIDAPI_VERSION}-cp312-cp312-macosx_11_0_arm64.whl"
HID_ARM64_URL="https://files.pythonhosted.org/packages/4e/9c/9335957cb7e1ca1be997e97afe850f62a9ff0708015048b3871b553eed5c/${HID_ARM64_FILE}"
HID_ARM64_SHA256="27933e7f3da7007e5e8d0b25bcf48a79a74e802555e496bba2c7d87f8a77cd61"

HID_X64_FILE="hidapi-${HIDAPI_VERSION}-cp312-cp312-macosx_10_13_x86_64.whl"
HID_X64_URL="https://files.pythonhosted.org/packages/b3/fd/9076aba0736f339b71bda5ee26cb678c02420bf96c7ea5bd9ebcbaf0aa3c/${HID_X64_FILE}"
HID_X64_SHA256="0b7eb950214191c936b5bdabaeaf1cab99c0dfc3ae3edc220e3c6d4547296053"

CACHE_DIR="${MELODIOUS_WIZARD_CACHE_DIR:-$DESKTOP_DIR/build/wizard-cache}"
OUT_ROOT="$DESKTOP_DIR/build/wizard-python"
mkdir -p "$CACHE_DIR" "$OUT_ROOT"

sha256_file() {
  if command -v shasum > /dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

fetch_verified() {
  _file="$1"
  _url="$2"
  _expected="$3"
  _dest="$CACHE_DIR/$_file"

  if [ -f "$_dest" ]; then
    _actual=$(sha256_file "$_dest")
    if [ "$_actual" = "$_expected" ]; then
      echo "  • cached $_file (sha256 verified)"
      return 0
    fi
    echo "  • cache mismatch for $_file (got $_actual, expected $_expected); re-downloading"
    rm -f "$_dest"
  fi

  _tmp="${_dest}.tmp.$$"
  rm -f "$_tmp"
  echo "  • downloading $_file"
  if ! curl -fsSL --retry 3 -o "$_tmp" "$_url"; then
    rm -f "$_tmp"
    echo "stage-wizard-runtime: failed to download $_url" >&2
    exit 1
  fi
  _actual=$(sha256_file "$_tmp")
  if [ "$_actual" != "$_expected" ]; then
    rm -f "$_tmp"
    echo "stage-wizard-runtime: SHA-256 mismatch for $_file (got $_actual, expected $_expected)" >&2
    exit 1
  fi
  mv "$_tmp" "$_dest"
}

verify_otool_clean() {
  _bin="$1"
  _deps=$(otool -L "$_bin" | tail -n +2 | awk '{print $1}')
  for _dep in $_deps; do
    case "$_dep" in
      /opt/homebrew/*|/usr/local/*|/Users/*|/Library/Frameworks/Python.framework/*|/nix/*|/macports/*)
        echo "stage-wizard-runtime: forbidden non-system dylib dependency '$_dep' in $_bin" >&2
        exit 1
        ;;
    esac
  done
}

verify_hid_system_only() {
  _hid_so="$1"
  _deps=$(otool -L "$_hid_so" | tail -n +2 | awk '{print $1}')
  if [ -z "$_deps" ]; then
    echo "stage-wizard-runtime: otool -L returned no dependencies for $_hid_so" >&2
    exit 1
  fi
  for _dep in $_deps; do
    case "$_dep" in
      /System/Library/Frameworks/IOKit.framework/*|\
      /System/Library/Frameworks/CoreFoundation.framework/*|\
      /System/Library/Frameworks/AppKit.framework/*|\
      /usr/lib/libSystem.B.dylib)
        ;;
      *)
        echo "stage-wizard-runtime: unexpected dependency '$_dep' in $_hid_so (must link only Apple system frameworks)" >&2
        exit 1
        ;;
    esac
  done
}

stage_one_arch() {
  _arch="$1"
  case "$_arch" in
    arm64)
      _pbs_file="$PBS_ARM64_FILE"
      _pbs_url="$PBS_ARM64_URL"
      _pbs_sha="$PBS_ARM64_SHA256"
      _hid_file="$HID_ARM64_FILE"
      _hid_url="$HID_ARM64_URL"
      _hid_sha="$HID_ARM64_SHA256"
      _macho_arch="arm64"
      ;;
    x64)
      _pbs_file="$PBS_X64_FILE"
      _pbs_url="$PBS_X64_URL"
      _pbs_sha="$PBS_X64_SHA256"
      _hid_file="$HID_X64_FILE"
      _hid_url="$HID_X64_URL"
      _hid_sha="$HID_X64_SHA256"
      _macho_arch="x86_64"
      ;;
    *)
      echo "stage-wizard-runtime: unsupported arch $_arch" >&2
      exit 1
      ;;
  esac

  echo "stage-wizard-runtime: staging $_arch ($_macho_arch)"
  fetch_verified "$_pbs_file" "$_pbs_url" "$_pbs_sha"
  fetch_verified "$_hid_file" "$_hid_url" "$_hid_sha"

  _stage_tmp="${OUT_ROOT}/.${_arch}.tmp.$$"
  _target_dir="${OUT_ROOT}/${_arch}"
  rm -rf "$_stage_tmp" "$_target_dir"
  mkdir -p "$_stage_tmp"

  tar -xzf "$CACHE_DIR/$_pbs_file" -C "$_stage_tmp"
  if [ ! -d "$_stage_tmp/python" ]; then
    rm -rf "$_stage_tmp"
    echo "stage-wizard-runtime: expected python/ directory in $_pbs_file" >&2
    exit 1
  fi
  mv "$_stage_tmp/python" "$_target_dir"
  rmdir "$_stage_tmp"

  _stdlib="$_target_dir/lib/python${PY_MINOR}"
  _site="$_stdlib/site-packages"

  # Trim unused headers, manpages, Tcl/Tk, static config, pip, and stdlib GUI/test packages
  rm -rf \
    "$_target_dir/include" \
    "$_target_dir/share" \
    "$_target_dir/lib/pkgconfig" \
    "$_target_dir/lib/tcl"* \
    "$_target_dir/lib/tk"* \
    "$_target_dir/lib/itcl"* \
    "$_target_dir/lib/thread"* \
    "$_target_dir/lib/libtcl"* \
    "$_target_dir/bin/2to3"* \
    "$_target_dir/bin/idle"* \
    "$_target_dir/bin/pip"* \
    "$_target_dir/bin/pydoc"* \
    "$_target_dir/bin/python"*-config \
    "$_stdlib/test" \
    "$_stdlib/tests" \
    "$_stdlib/idlelib" \
    "$_stdlib/tkinter" \
    "$_stdlib/ensurepip" \
    "$_stdlib/turtledemo" \
    "$_stdlib/turtle.py" \
    "$_stdlib/pydoc_data" \
    "$_stdlib/venv" \
    "$_stdlib/config-${PY_MINOR}-darwin" \
    "$_stdlib/lib-dynload/_tkinter"*.so \
    "$_site/pip" \
    "$_site/pip-"*.dist-info

  mkdir -p "$_site"
  unzip -q "$CACHE_DIR/$_hid_file" -d "$_site"

  _py_bin="$_target_dir/bin/python3"
  _py_real="$_target_dir/bin/python${PY_MINOR}"
  _libpy="$_target_dir/lib/libpython${PY_MINOR}.dylib"
  _hid_so="$_site/hid.cpython-312-darwin.so"

  for _req in \
    "$_py_bin" \
    "$_py_real" \
    "$_libpy" \
    "$_stdlib/LICENSE.txt" \
    "$_hid_so" \
    "$_site/hidapi-${HIDAPI_VERSION}.dist-info/METADATA" \
    "$_site/hidapi-${HIDAPI_VERSION}.dist-info/licenses/LICENSE.txt" \
    "$_site/hidapi-${HIDAPI_VERSION}.dist-info/licenses/LICENSE-bsd.txt" \
    "$_site/hidapi-${HIDAPI_VERSION}.dist-info/licenses/LICENSE-gpl3.txt" \
    "$_site/hidapi-${HIDAPI_VERSION}.dist-info/licenses/LICENSE-orig.txt"
  do
    if [ ! -e "$_req" ]; then
      echo "stage-wizard-runtime: missing required file $_req" >&2
      exit 1
    fi
  done

  chmod 0755 "$_py_real" "$_libpy" "$_hid_so"

  find "$_target_dir" -name '__pycache__' -type d -prune -exec rm -rf {} +
  find "$_target_dir" \( -name '*.pyc' -o -name '*.pyo' -o -name '.DS_Store' \) -delete

  # Verify Mach-O architecture and linkage on every binary/dylib/.so
  for _mach in "$_py_real" "$_libpy" "$_hid_so"; do
    _got_arch=$(lipo -archs "$_mach" | tr -d '[:space:]')
    if [ "$_got_arch" != "$_macho_arch" ]; then
      echo "stage-wizard-runtime: expected arch $_macho_arch for $_mach, got '$_got_arch'" >&2
      exit 1
    fi
  done

  find "$_target_dir" -type f \( -name '*.so' -o -name '*.dylib' \) | while IFS= read -r _so; do
    verify_otool_clean "$_so"
  done
  verify_otool_clean "$_py_real"
  verify_hid_system_only "$_hid_so"

  # Execute runtime smoke check when host can run this architecture
  _host_arch=$(uname -m)
  _runner=""
  if [ "$_arch" = "arm64" ] && [ "$_host_arch" = "arm64" ]; then
    _runner="direct"
  elif [ "$_arch" = "x64" ] && [ "$_host_arch" = "x86_64" ]; then
    _runner="direct"
  elif [ "$_arch" = "x64" ] && arch -x86_64 /usr/bin/true > /dev/null 2>&1; then
    _runner="rosetta"
  fi

  _smoke_py='
import ctypes, hashlib, json, pathlib, secrets, shlex, socket, sqlite3, ssl, subprocess, sys, urllib.request, xml.etree.ElementTree, zipfile, zlib
import hid

expected_prefix = pathlib.Path(sys.argv[1]).resolve()
actual_prefix = pathlib.Path(sys.prefix).resolve()
assert actual_prefix == expected_prefix, f"sys.prefix {actual_prefix} != {expected_prefix}"
for entry in sys.path:
    if not entry:
        continue
    resolved = pathlib.Path(entry).resolve()
    assert str(resolved).startswith(str(expected_prefix)), f"non-relocatable sys.path entry: {entry}"
assert hasattr(hid, "enumerate") and hasattr(hid, "device"), "hid module missing enumerate/device"
'

  if [ "$_runner" = "direct" ]; then
    PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1 "$_py_bin" -I -B -c "$_smoke_py" "$_target_dir"
    echo "  • verified $_arch runtime execution (native)"
  elif [ "$_runner" = "rosetta" ]; then
    PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1 arch -x86_64 "$_py_bin" -I -B -c "$_smoke_py" "$_target_dir"
    echo "  • verified $_arch runtime execution (Rosetta x86_64)"
  else
    echo "  • verified $_arch Mach-O arch + otool linkage (execution skipped on $_host_arch)"
  fi

  # Ensure smoke check left zero bytecode artifacts behind
  find "$_target_dir" -name '__pycache__' -type d -prune -exec rm -rf {} +
  find "$_target_dir" \( -name '*.pyc' -o -name '*.pyo' \) -delete
}

for _a in $ARCH_LIST; do
  stage_one_arch "$_a"
done

echo "stage-wizard-runtime: ready in $OUT_ROOT ($ARCH_LIST)"
