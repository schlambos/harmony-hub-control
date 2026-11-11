#!/usr/bin/env python3
"""
Linux/macOS installer for the Harmony Hub Control post-root web UI.

The hub must already have root SSH access. This installer intentionally uses
plain ssh plus remote "cat > file" uploads, because the minimal Dropbear setup
used by the root tool does not provide scp, sftp, or tftp.

Every candidate file is first uploaded into ONE private 0700 staging tree
under /var/volatile/codex-install-* (RAM), verified against locally computed
MD5 sums using strict BusyBox md5sum output, and compared with the hub's
current files. Candidates that already match are left alone.

The hub's BusyBox has no mktemp, stat, df, or sync applets, so everything
here uses only cat, cp, ln, mv, rm, chmod, mkdir, ls -l, awk, and md5sum.
Free flash is measured by payload/helpers/codex_flash_free, which runs from
the RAM staging tree and is never installed. The preflight compares it with
an estimate of what the changed files take on the hub's compressing jffs2 and
blocks (BLOCKED_CAPACITY) before writing anything when they don't fit.

Changed files install as a two-phase commit:

  1. copy each changed file next to its destination as <dest>.codex-new and
     verify it; if flash fills up anyway, every .codex-new is removed and no
     live file has changed (BLOCKED_CAPACITY);
  2. rename each .codex-new over its destination, codex_webui last.

When harmony-hub-root already left its dropbearmulti on the hub (the same
build as ours, or the .pdr-stripped one: DROPBEAR_BUILDS), phase 1
hard-links it instead of writing a second copy. Its leftover staging
folders are reported, and removed with --remove-root-tool-leftovers.

Originals are copied into RAM before phase 1, so any later failure restores
them (copy to <dest>.codex-rb, then rename) with their observed modes.

Preflight-only mode reports the inventory, actions, RAM headroom, backup
generations, handoff estimate, and verdict with zero persistent mutations and
no service actions. Default mode is upgrade and preserves existing
configuration; --clean-install regenerates configuration.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import re
import secrets
import shlex
import socket
import subprocess
import sys
import time
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PAYLOAD = ROOT / "payload"

STAGE_PREFIX = "/var/volatile/codex-install-"
HANDOFF_ROOT = "/data/codex-backups"
HANDOFF_BUDGET_BYTES = 256 * 1024
HANDOFF_KEEP = 3
WEBUI_DEST = "/data/codex/bin/codex_webui"
NEW_SUFFIX = ".codex-new"
RESTORE_SUFFIX = ".codex-rb"
# RAM that must stay free after staging and rollback copies (tmpfs is RAM).
RAM_MARGIN_BYTES = 4 * 1048576

# Free-space probe, run from the RAM staging tree only.
FLASH_HELPER = PAYLOAD / "helpers" / "codex_flash_free"
FLASH_HELPER_NAME = "codex_flash_free"
FLASH_PATH = "/data"
# jffs2 stores a file as zlib-compressed nodes of at most one 4 KiB page, each
# with a 68-byte header; its directory entry adds 40 bytes plus the name.
JFFS2_PAGE = 4096
JFFS2_NODE_HEADER = 68
JFFS2_DIRENT_HEADER = 40
# Flash kept spare on top of the estimate: one 64 KiB erase block plus 5%.
FLASH_MARGIN_BYTES = 64 * 1024
FLASH_MARGIN_PERCENT = 5

# What harmony-hub-root leaves behind. Its dropbearmulti is our Dropbear
# (DROPBEAR_BUILDS), and its staging folders hold about 0.5 MB of base64
# chunks each.
DROPBEAR_DEST = "/data/codex/bin/dropbearmulti"
ROOT_TOOL_DROPBEAR = "/data/rootssh/bin/dropbearmulti"
ROOT_TOOL_FILES = ["/data/rootssh/bin/dropbearmulti", "/data/rootssh/bin/dropbear", "/data/rootssh/bin/dropbearkey"]
ROOT_TOOL_STAGE_RE = re.compile(r"^/data/codexssh_[A-Za-z0-9_]+_stage$")
# Known builds of Dropbear, by MD5: their version. For 2025.89 that is the
# build build/build_harmony_tools_kali.sh makes, and the same file with the
# unloaded MIPS .pdr section stripped, which is what harmony-hub-root ships
# from its stripped release on. Builds of one version load the same image, so
# either counts as the installed Dropbear and the root tool's copy is reused
# whichever it is. A new Dropbear release gets its own version here, so it
# still replaces the old one.
DROPBEAR_BUILDS = {
    "3733327fd04bca282dbf06f33da0bf6c": "2025.89",  # as built, 577296 bytes
    "ceabc15471be6f67f1e13fccd20a9508": "2025.89",  # .pdr stripped, 535652 bytes
}
# The hub's ls has no -R; a root-tool stage holds files and a chunks/ folder.
ROOT_TOOL_SCAN = (
    'for d in /data/codexssh_*_stage; do [ -d "$d" ] || continue; '
    "set -- $(ls -l \"$d\" \"$d/chunks\" 2>/dev/null | awk '/^-/ {s += $5; n++} END {print s + 0, n + 0}'); "
    'echo "root_tool_stage bytes=$1 files=$2 path=$d"; done; '
    "for f in /data/rootssh/bin/dropbearmulti /data/codex/bin/dropbearmulti; do "
    '[ -f "$f" ] && [ ! -L "$f" ] || continue; set -- $(ls -il "$f"); '
    'echo "dropbear_copy inode=$1 links=$3 path=$f"; done'
)
# Removes the root tool's Dropbear only while SSH runs ours.
ROOT_TOOL_DROPBEAR_REMOVE = (
    "if [ -x /data/codex/bin/dropbear ] && grep /data/codex/bin/dropbear /usr/sbin/dropbear >/dev/null; then "
    "rm -f " + " ".join(ROOT_TOOL_FILES) + " && echo removed; fi"
)


def hub_copy_current(dest: str, have: str, want: str) -> bool:
    """True when a file with MD5 `have` on the hub can stand for ours (`want`)
    at `dest`: the same bytes, or at the Dropbear destination, another build
    of the same Dropbear version (DROPBEAR_BUILDS)."""
    if have == want:
        return True
    version = DROPBEAR_BUILDS.get(have)
    return dest == DROPBEAR_DEST and version is not None and version == DROPBEAR_BUILDS.get(want)

# Multiple remotes of one model (docs/MULTI_REMOTE.md). Stock hal keeps one
# remote per model: it unpairs an older one after every pair, and its key
# threads keep per-model state (one radio subscriber, one thread handle), so
# two remotes of one model hang its radio dispatcher. --multi-remote on makes a
# copy of the hub's own /usr/bin/hal with those made per slot and the
# same-model unpair kept only for remotes with a screen and the keyboard
# (whose thread state is per model too); rcS.local bind-mounts
# it over /usr/bin/hal at boot. The copy is built here from the hub's file
# with the edits in payload/helpers/hal_multiremote_patch.json; hal itself is
# never shipped.
HAL_PATH = "/usr/bin/hal"
HAL_MULTI_DEST = "/data/codex/bin/hal_multiremote"
MULTI_REMOTE_CONF = "/data/codex/multi_remote.conf"
HAL_PATCH_FILE = PAYLOAD / "helpers" / "hal_multiremote_patch.json"
# Turning it off reboots into the stock hal, which hangs its radio on two
# remotes of one model. So --multi-remote off first checks the slot table on
# the hub, while the multi-remote hal runs: it writes the pending-restart guard
# (codex_webui's /api/remote-pair refuses while it's there; it lives in RAM
# and lapses after 10 minutes), refuses during an open pairing window, then
# reads rf.info. The copy itself is left to rcS.local, which deletes it at the
# next boot when the setting isn't 1.
MULTI_REMOTE_PENDING = "/var/run/codex-multi-remote-pending"
NO_SCREEN_EQUADS = ("16414", "16422", "16423")


def hal_bound_command() -> str:
    """Whether rcS.local bind-mounted the multi-remote copy over /usr/bin/hal at boot."""
    return f"if grep ' {HAL_PATH} ' /proc/mounts >/dev/null 2>&1; then echo bound; else echo stock; fi"


def multi_remote_off_check_command(guard: bool) -> str:
    # A guard that can't be written stops the check (guard-failed): without
    # it, nothing blocks a pair between the check and the reboot.
    touch = f"elif ! touch {MULTI_REMOTE_PENDING}; then echo guard-failed; " if guard else ""
    return (
        f"if ! grep ' {HAL_PATH} ' /proc/mounts >/dev/null 2>&1; then echo inactive; "
        f"{touch}elif ps | grep '[r]f.pairing' >/dev/null 2>&1; then echo pairing; "
        "else /data/codex/bin/codex_hal_ltcp rf.info '{}' 8 2>&1; fi"
    )


def rf_duplicate_models(reply: str) -> str | None:
    """Models without a screen paired more than once in hal's rf.info answer,
    as "16414 (slots 1, 2)"; "" when none; None when it isn't a valid answer."""
    start = reply.find("{")
    try:
        doc = json.loads(reply[start:]) if start >= 0 else None
    except ValueError:
        doc = None
    if not isinstance(doc, dict) or doc.get("code") != 200 or not isinstance(doc.get("data"), dict):
        return None
    slots: dict[str, list[str]] = {}
    for dev in doc["data"].get("Devices") or []:
        if isinstance(dev, dict) and str(dev.get("EquadID")) in NO_SCREEN_EQUADS:
            slots.setdefault(str(dev["EquadID"]), []).append(str(dev.get("DeviceIndex", "?")))
    return "; ".join(f"{m} (slots {', '.join(v)})" for m, v in slots.items() if len(v) > 1)


def load_hal_patch(path: Path = HAL_PATCH_FILE) -> tuple[str, str, list[tuple[int, bytes, bytes]]]:
    """(stock md5, patched md5, [(offset, stock bytes, patched bytes)])."""
    doc = json.loads(path.read_text(encoding="utf-8"))
    edits = [(int(e["offset"], 16), bytes.fromhex(e["stock"]), bytes.fromhex(e["patched"])) for e in doc["edits"]]
    return doc["stock_md5"], doc["patched_md5"], edits


HAL_STOCK_MD5, HAL_MULTI_MD5, HAL_MULTI_PATCH = load_hal_patch()


def patched_hal(data: bytes) -> bytes:
    """The multi-remote hal from the hub's own /usr/bin/hal; fails closed."""
    digest = hashlib.md5(data).hexdigest()
    if digest == HAL_MULTI_MD5:
        return data  # already the patched build (read while it is bind-mounted)
    if digest != HAL_STOCK_MD5:
        raise RuntimeError(
            f"{HAL_PATH} on this hub is not the hal build multi-remote supports "
            f"(md5 {digest}, expected {HAL_STOCK_MD5} from firmware 4.15.600)"
        )
    out = bytearray(data)
    for offset, old, new in HAL_MULTI_PATCH:
        if bytes(out[offset : offset + len(old)]) != old:
            raise RuntimeError(f"{HAL_PATH}: unexpected bytes at {offset:#x}")
        out[offset : offset + len(new)] = new
    if hashlib.md5(out).hexdigest() != HAL_MULTI_MD5:
        raise RuntimeError("the patched hal does not match its expected md5")
    return bytes(out)


# Two remotes with a screen (docs/TWO_SCREEN_REMOTES.md). Stock hal has one
# HOT context (the link to remotes with a screen), so it unpairs an older
# screen remote after every pair, and two of them paired anyway share one set
# of sequence numbers. --two-screen on makes a second copy of the hub's own
# /usr/bin/hal that keeps HOT per radio slot; it carries the multi-remote
# changes too, and rcS.local binds it instead of the multi-remote copy while
# two_screen.conf asks for it. The copy is built here with the edits in
# payload/helpers/hal_remotes_patch.json (tools/build_hal_remotes.py writes
# that file from payload/source/hal_remotes).
HAL_REMOTES_DEST = "/data/codex/bin/hal_remotes"
TWO_SCREEN_CONF = "/data/codex/two_screen.conf"
# Boots in a row that bound the copy and didn't stay up four minutes (rcS.local).
HAL_REMOTES_TRIES = "/data/codex/hal_remotes.tries"
# What rcS.local told the copy at this boot: 1 or 0 for two-screen, multi-remote, serial.
HAL_GATES = "/var/run/codex_hal_gates"
HAL_REMOTES_PATCH_FILE = PAYLOAD / "helpers" / "hal_remotes_patch.json"
# --two-screen value -> two_screen.conf. "once" is cleared by rcS.local before
# it binds the copy, so the next boot of any kind is back on the stock hal;
# "serial" serves one remote's object at a time (the fallback mode).
TWO_SCREEN_SETTINGS = {"on": "1", "once": "once", "serial": "serial", "serial-once": "serial-once"}


def load_hal_remotes_patch(path: Path = HAL_REMOTES_PATCH_FILE) -> tuple[str, list[tuple[int, bytes | None, bytes]]]:
    """(patched md5, [(offset, stock bytes or None, patched bytes)]). The one
    edit without stock bytes is the added code, laid over hal's unloaded .pdr
    section: the whole-file md5 vouches for what it replaces."""
    doc = json.loads(path.read_text(encoding="utf-8"))
    if doc["stock_md5"] != HAL_STOCK_MD5:
        raise RuntimeError(f"{path.name} is for another hal build")
    edits = [
        (int(e["offset"], 16), bytes.fromhex(e["stock"]) if "stock" in e else None, bytes.fromhex(e["patched"]))
        for e in doc["edits"]
    ]
    return doc["patched_md5"], edits


HAL_REMOTES_MD5, HAL_REMOTES_PATCH = load_hal_remotes_patch()


def running_hal_command() -> str:
    """The hal that runs (through the bind mount, if there is one), the gates
    rcS.local gave it, and whether multi-remote would be left without a copy."""
    return (
        f"md5sum {HAL_PATH} 2>/dev/null; echo gates=$(cat {HAL_GATES} 2>/dev/null); "
        f"echo multi=$(cat {MULTI_REMOTE_CONF} 2>/dev/null); "
        f"if [ -f {HAL_MULTI_DEST} ]; then echo multi_copy=yes; else echo multi_copy=no; fi"
    )


def hal_load_check_command() -> str:
    """Run the installed copy with an option hal doesn't have: it prints its
    usage and exits before it opens anything. That the hub's kernel and loader
    start the copy at all is the one thing no test off the hub can show."""
    # hal's usage text ends without a newline: put the exit status on its own line.
    return f"{HAL_REMOTES_DEST} -h 2>&1; rc=$?; echo; echo rc=$rc"


def remotes_hal(data: bytes) -> bytes:
    """The two-screen hal from the hub's own /usr/bin/hal; fails closed."""
    digest = hashlib.md5(data).hexdigest()
    if digest == HAL_REMOTES_MD5:
        return data  # already this build (read while it is bind-mounted)
    if digest == HAL_MULTI_MD5:
        # The multi-remote copy is bound: take its edits back out to get the stock file.
        out = bytearray(data)
        for offset, old, new in HAL_MULTI_PATCH:
            if bytes(out[offset : offset + len(new)]) != new:
                raise RuntimeError(f"{HAL_PATH}: unexpected bytes at {offset:#x}")
            out[offset : offset + len(old)] = old
        data = bytes(out)
        digest = hashlib.md5(data).hexdigest()
    if digest != HAL_STOCK_MD5:
        raise RuntimeError(
            f"{HAL_PATH} on this hub is not the hal build two-screen supports "
            f"(md5 {digest}, expected {HAL_STOCK_MD5} from firmware 4.15.600). If another "
            "copy of hal is bound over it, restart the hub into the stock hal first."
        )
    out = bytearray(data)
    for offset, old, new in HAL_REMOTES_PATCH:
        if old is not None and bytes(out[offset : offset + len(old)]) != old:
            raise RuntimeError(f"{HAL_PATH}: unexpected bytes at {offset:#x}")
        out[offset : offset + len(new)] = new
    if len(out) != len(data) or hashlib.md5(out).hexdigest() != HAL_REMOTES_MD5:
        raise RuntimeError("the two-screen hal does not match its expected md5")
    return bytes(out)


HANDOFF_REQUIRED_PATHS = [
    "/etc/init.d/rcS.local",
    "/opt/luaworks/tasks/connectserver/netservicestarter.lua",
    "/usr/sbin/dropbear",
    "/usr/sbin/dropbearkey",
    "/data/codex/hub_id",
    "/data/codex/cloud_blocker.conf",
    "/data/codex/offline_egress_guard.sh",
    "/data/codexmqtt/config.json",
    "/pkg/codexactivity/codexactivity.lua",
    "/pkg/codexactivity/manifest.json",
]

# Artifacts an upgrade must never replace unless explicitly supplied.
UPGRADE_PROTECTED_PATHS = [
    "/data/codex/hub_id",
    "/data/codex/cloud_blocker.conf",
    MULTI_REMOTE_CONF,
    TWO_SCREEN_CONF,
    "/data/codexmqtt/config.json",
    "/data/codex/resource-backups",
    "/data/codex-backups",
    "/data/codex/update-backups",
]

VERDICT_ALLOWED = "ALLOWED"
VERDICT_CAPACITY = "BLOCKED_CAPACITY"
VERDICT_ROLLBACK_CAPACITY = "BLOCKED_ROLLBACK_CAPACITY"
VERDICT_CONFIG_UNCERTAIN = "BLOCKED_CONFIGURATION_UNCERTAINTY"
VERDICT_VALIDATION = "BLOCKED_VALIDATION_FAILURE"

MD5_LINE_RE = re.compile(r"^([0-9a-f]{32})  (.+)$")

TURN_OFF_SCRIPT_PATH = "/var/volatile/codex-turn-off.sh"
MELODIOUS_OFF_MARKER = "/etc/melodious-off"
LEGACY_MELODIOUS_OFF_MARKER = "/data/codex/melodious-off"
MELODIOUS_OFF_REFUSAL = "Melodious is turned off on this hub. Run with --turn-on to turn it back on first."
MELODIOUS_OFF_CHECK_CMD = (
    f"if [ -f {MELODIOUS_OFF_MARKER} ] || [ -f {LEGACY_MELODIOUS_OFF_MARKER} ]; then echo off; fi"
)
# EXPERIMENTAL turn-off/on disclaimer, printed as a banner before any action.
# install_webui.ps1 carries an identical copy ($ExperimentalTurnOffWarning;
# tools/installer_contract_smoke.py checks byte-for-byte parity).
EXPERIMENTAL_TURN_OFF_WARNING = (
    "EXPERIMENTAL: turning Melodious off/on has NOT been validated on live hardware.\n"
    "Whether the Harmony app fully reclaims the hub is unproven.\n"
    "Back up first (Web UI -> Download full backup). Proceed at your own risk."
)

GATE_SCRIPT_SPECS: list[tuple[str, str, str, Path]] = [
    ("/etc/init.d/rcS.local", "755", "runtime", PAYLOAD / "scripts" / "rcS.local"),
    (
        "/opt/luaworks/tasks/connectserver/netservicestarter.lua",
        "644",
        "runtime",
        PAYLOAD / "scripts" / "netservicestarter.lua",
    ),
    ("/data/codex/init.sh", "755", "runtime", PAYLOAD / "scripts" / "init.sh"),
    (
        "/data/codex/offline_egress_guard.sh",
        "755",
        "runtime",
        PAYLOAD / "scripts" / "offline_egress_guard.sh",
    ),
    ("/data/codex/usb_eth_service.sh", "755", "runtime", PAYLOAD / "scripts" / "usb_eth_service.sh"),
    ("/data/codex/androidtv_service.sh", "755", "runtime", PAYLOAD / "scripts" / "androidtv_service.sh"),
    ("/data/codex/recovery_ap.sh", "755", "runtime", PAYLOAD / "scripts" / "recovery_ap.sh"),
    ("/pkg/codexactivity/codexactivity.lua", "644", "plugin", PAYLOAD / "activity" / "codexactivity.lua"),
    ("/pkg/codexmqtt/codexmqtt.lua", "644", "plugin", PAYLOAD / "mqtt" / "codexmqtt.lua"),
]

# Runs on the hub. install_webui.ps1 carries an identical copy
# (tools/installer_contract_smoke.py checks byte-for-byte parity).
TURN_OFF_SCRIPT = r"""#!/bin/sh
# Single-state Melodious off/on helper, run ON THE HUB by install_webui.py
# (--turn-off / --turn-on) and install_webui.ps1 (-TurnOff / -TurnOn).
#
# One marker file, /etc/melodious-off, gates rcS.local, netservicestarter.lua,
# init.sh, the *_service.sh wrappers, and the /pkg Lua plugins. No Melodious
# configs, plugins, or patched hal copies are moved or edited.
#
#   sh turn_off.sh check [--force]         preflight + current state for --turn-off
#   sh turn_off.sh apply [--force]         write /etc/melodious-off, restore WAN
#                                          route, reconnect Wi-Fi if suspended
#   sh turn_off.sh verify-off              post-reboot verification for --turn-off
#   sh turn_off.sh check-on                preflight + hal load-check for --turn-on
#   sh turn_off.sh apply-on                unlink /etc/melodious-off (+ legacy)
#   sh turn_off.sh verify-on <hal-kind>    post-reboot verification for --turn-on
#
# BusyBox 1.13 on the hub: no stat, mktemp, rmdir, head, tail, sort, df or grep -E.

set -u
R=${CODEX_OFF_ROOT:-}
PATH=${CODEX_OFF_PATH:-/data/codex/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}
export PATH

MARKER=/etc/melodious-off
LEGACY_MARKER=/data/codex/melodious-off
HOSTS=/etc/hosts
PROBE_MARK="# codex: Harmony Touch sync probe"
WPA_CONF=/etc/wpa_supplicant.conf
PREFS=/data/luaworks/provision/preferences
WIFI_OFF_STATE=/var/run/codex-usb-eth-wifi-off
MULTI_PENDING=/var/run/codex-multi-remote-pending
HAL_PATH=/usr/bin/hal
HAL_REMOTES=/data/codex/bin/hal_remotes
HAL_MULTI=/data/codex/bin/hal_multiremote
HAL_GATES=/var/run/codex_hal_gates
TWO_SCREEN_CONF=/data/codex/two_screen.conf
MULTI_REMOTE_CONF=/data/codex/multi_remote.conf
USB_ETH_CONF=/data/codex/usb_eth.conf
WIFI_WAIT=${CODEX_WIFI_WAIT:-15}

BOOTSTRAP_ALWAYS="/etc/init.d/rcS.local /opt/luaworks/tasks/connectserver/netservicestarter.lua"
BOOTSTRAP_IF_PRESENT="/data/codex/init.sh /data/codex/offline_egress_guard.sh /data/codex/usb_eth_service.sh /data/codex/androidtv_service.sh /data/codex/recovery_ap.sh /pkg/codexactivity/codexactivity.lua /pkg/codexmqtt/codexmqtt.lua"

die() { echo "error=$*"; exit 1; }

ps_out() {
  if [ -n "${CODEX_OFF_PS_FILE:-}" ]; then
    cat "$CODEX_OFF_PS_FILE" 2>/dev/null || true
  elif [ -n "$R" ]; then
    cat "$R/proc/codex_ps" 2>/dev/null || true
  else
    ps 2>/dev/null || true
  fi
}

pid_alive() {
  [ -f "$1" ] || return 1
  _p=$(sed -n '1p' "$1" 2>/dev/null)
  case "$_p" in *[!0-9]*|"") return 1 ;; esac
  if [ -n "$R" ]; then
    ps_out | awk -v p="$_p" '$1 == p { f = 1 } END { exit !f }'
  else
    kill -0 "$_p" 2>/dev/null
  fi
}

route_out() {
  if [ -n "$R" ] && [ -f "$R/proc/codex_route" ]; then
    cat "$R/proc/codex_route" 2>/dev/null || true
  else
    route -n 2>/dev/null || true
  fi
}

emit_boot_stamp() {
  _bid=$(sed -n '1p' "$R/proc/sys/kernel/random/boot_id" 2>/dev/null || true)
  _bt=$(awk '$1 == "btime" { print $2; exit }' "$R/proc/stat" 2>/dev/null || true)
  _up=$(awk '{ print int($1); exit }' "$R/proc/uptime" 2>/dev/null || true)
  echo "boot_id=$_bid"
  echo "btime=$_bt"
  echo "uptime_s=$_up"
}

wifi_ipv4() {
  ifconfig ath0 2>/dev/null | sed -n 's/.*inet addr:\([0-9.]*\).*/\1/p' | sed -n '1p'
}

wired_ipv4s() {
  {
    if [ -x "$R/data/codex/bin/codex_usbeth" ]; then
      "$R/data/codex/bin/codex_usbeth" status 2>/dev/null | sed -n 's/^ipv4=\([0-9.]*\)$/\1/p'
    fi
    ifconfig 2>/dev/null | awk '
      /^[A-Za-z0-9]/ { iface = $1 }
      iface != "" && iface != "lo" && iface != "ath0" && iface != "ath1" && /inet addr:/ {
        s = $0; sub(/^.*inet addr:/, "", s); sub(/[^0-9.].*$/, "", s)
        if (s != "") print s
      }'
  } | awk '!seen[$0]++'
}

wifi_off_active() {
  [ -f "$R$WIFI_OFF_STATE" ] && return 0
  if grep '^WIFI_OFF=1$' "$R$USB_ETH_CONF" >/dev/null 2>&1; then
    if wpa_cli -i ath0 status 2>/dev/null | grep '^wpa_state=DISCONNECTED$' >/dev/null 2>&1; then
      return 0
    fi
  fi
  return 1
}

emit_network_state() {
  if route_out | awk '$1 == "0.0.0.0" && $4 ~ /G/ { f = 1 } END { exit !f }'; then
    echo "internet_route=yes"
  else
    echo "internet_route=no"
  fi
  if wifi_off_active; then
    echo "wifi_off_active=yes"
  else
    echo "wifi_off_active=no"
  fi
  echo "wifi_ip=$(wifi_ipv4)"
  for _wip in $(wired_ipv4s); do
    echo "wired_ip=$_wip"
  done
}

check_bootstrap_targets() {
  _need=no
  for _p in $BOOTSTRAP_ALWAYS; do
    if [ ! -f "$R$_p" ] || ! grep -F "$MARKER" "$R$_p" >/dev/null 2>&1; then
      _need=yes
      echo "bootstrap_target=$_p"
    fi
  done
  for _p in $BOOTSTRAP_IF_PRESENT; do
    if [ -f "$R$_p" ] && ! grep -F "$MARKER" "$R$_p" >/dev/null 2>&1; then
      _need=yes
      echo "bootstrap_target=$_p"
    fi
  done
  echo "bootstrap_needed=$_need"
}

report_off() {
  emit_boot_stamp
  _reasons=""
  add_reason() { _reasons="${_reasons:+$_reasons, }$1"; }

  if [ -f "$R$MARKER" ]; then
    echo "marker=present"
  else
    echo "marker=absent"
    add_reason "marker=absent"
  fi
  if [ -f "$R$LEGACY_MARKER" ]; then
    echo "legacy_marker=present"
    add_reason "legacy_marker=present"
  else
    echo "legacy_marker=absent"
  fi

  _boot_out=$(check_bootstrap_targets)
  echo "$_boot_out"
  if echo "$_boot_out" | grep '^bootstrap_needed=yes$' >/dev/null 2>&1; then
    add_reason "bootstrap_needed=yes"
  fi

  _ps=$(ps_out)
  if echo "$_ps" | grep '[c]odex_webui' >/dev/null 2>&1; then
    echo "webui=running"
    add_reason "webui=running"
  else
    echo "webui=stopped"
  fi
  if echo "$_ps" | grep '[o]ffline_egress_guard.sh' >/dev/null 2>&1 ||
     pid_alive "$R/var/run/codex-offline-egress.pid"; then
    echo "egress_guard=running"
    add_reason "egress_guard=running"
  else
    echo "egress_guard=stopped"
  fi
  if echo "$_ps" | grep '[u]sb_eth_service.sh' >/dev/null 2>&1 ||
     pid_alive "$R/var/run/codex-usb-eth-worker.pid"; then
    echo "usb_eth_worker=running"
    add_reason "usb_eth_worker=running"
  else
    echo "usb_eth_worker=stopped"
  fi
  if echo "$_ps" | grep '[c]odex_androidtv' >/dev/null 2>&1 ||
     echo "$_ps" | grep '[a]ndroidtv_service.sh' >/dev/null 2>&1; then
    echo "androidtv=running"
    add_reason "androidtv=running"
  else
    echo "androidtv=stopped"
  fi
  if echo "$_ps" | grep '[c]odex_bt_pair_agent' >/dev/null 2>&1 ||
     echo "$_ps" | grep '[c]odex_bthid_keyboard' >/dev/null 2>&1 ||
     echo "$_ps" | grep '[r]ecovery_ap.sh' >/dev/null 2>&1 ||
     echo "$_ps" | grep '[c]odex_portal' >/dev/null 2>&1 ||
     echo "$_ps" | grep '[c]odex_dhcpd' >/dev/null 2>&1; then
    echo "other_codex_daemons=running"
    add_reason "other_codex_daemons=running"
  else
    echo "other_codex_daemons=stopped"
  fi

  if grep " $HAL_PATH " "$R/proc/mounts" >/dev/null 2>&1; then
    echo "hal_mount=bound"
    add_reason "hal_mount=bound"
  else
    echo "hal_mount=stock"
  fi
  if grep -F "$PROBE_MARK" "$R$HOSTS" >/dev/null 2>&1; then
    echo "touch_probe=present"
    add_reason "touch_probe=present"
  else
    echo "touch_probe=absent"
  fi

  emit_network_state
  if [ -z "$_reasons" ]; then
    echo "active_off=yes"
  else
    echo "active_off=no"
    echo "still_active=$_reasons"
  fi
}

inspect_ssh() {
  [ -f "$R/etc/init.d/rcS" ] &&
    grep -F tdeenable "$R/etc/init.d/rcS" >/dev/null 2>&1 &&
    grep -F /usr/sbin/dropbear "$R/etc/init.d/rcS" >/dev/null 2>&1 ||
    die "The hub's boot script (/etc/init.d/rcS) doesn't start Dropbear, so SSH wouldn't come back after the reboot."
  [ -r "$R/etc/tdeenable" ] ||
    die "/etc/tdeenable is missing or unreadable, so SSH wouldn't start after the reboot."
  [ -x "$R/usr/sbin/dropbear" ] ||
    die "/usr/sbin/dropbear is missing or not executable, so SSH wouldn't start after the reboot."
  if [ "$(sed -n 1p "$R/usr/sbin/dropbear" 2>/dev/null)" = "#!/bin/sh" ]; then
    target=$(sed -n 's/^exec \([^ ]*\).*/\1/p' "$R/usr/sbin/dropbear")
    if [ -z "$target" ] || [ ! -x "$R$target" ]; then
      die "/usr/sbin/dropbear runs ${target:-nothing}, which is missing or not executable, so SSH wouldn't start after the reboot."
    fi
  fi
  if [ ! -r "$R/home/root/.ssh/authorized_keys" ] ||
     ! grep '[^ 	]' "$R/home/root/.ssh/authorized_keys" >/dev/null 2>&1; then
    die "/home/root/.ssh/authorized_keys is missing or empty, so SSH key login wouldn't work after the reboot."
  fi
  if [ -r "$R/etc/dropbear/dropbear_rsa_host_key" ] && [ -s "$R/etc/dropbear/dropbear_rsa_host_key" ]; then
    :
  elif [ ! -e "$R/etc/dropbear/dropbear_rsa_host_key" ] && [ -x "$R/usr/sbin/dropbearkey" ]; then
    if [ "$(sed -n 1p "$R/usr/sbin/dropbearkey" 2>/dev/null)" = "#!/bin/sh" ]; then
      key_target=$(sed -n 's/^exec \([^ ]*\).*/\1/p' "$R/usr/sbin/dropbearkey")
      if [ -z "$key_target" ] || [ ! -x "$R$key_target" ]; then
        die "/etc/dropbear/dropbear_rsa_host_key is missing and /usr/sbin/dropbearkey runs ${key_target:-nothing}, which is missing, so SSH wouldn't start after the reboot."
      fi
    fi
  else
    die "/etc/dropbear/dropbear_rsa_host_key is missing or empty and /usr/sbin/dropbearkey isn't executable, so SSH wouldn't start after the reboot."
  fi
}

inspect_remotes() {
  _force=$1
  if ps_out | grep '[r]f.pairing' >/dev/null 2>&1; then
    if [ "$_force" = "1" ]; then
      echo "warning=A remote pairing window is open on the hub (--force)."
      echo "rf_check=forced"
      return 0
    fi
    die "A remote pairing window is open on the hub; close it and try again (or pass --force)."
  fi
  if [ ! -x "$R/data/codex/bin/codex_hal_ltcp" ]; then
    if grep " $HAL_PATH " "$R/proc/mounts" >/dev/null 2>&1; then
      if [ "$_force" = "1" ]; then
        echo "warning=Patched hal is mounted and codex_hal_ltcp is missing (--force)."
        echo "rf_check=forced"
        return 0
      fi
      die "A patched hal is running and /data/codex/bin/codex_hal_ltcp is missing, so paired remotes couldn't be checked."
    fi
    echo "rf_check=skipped"
    return 0
  fi
  _rf=$("$R/data/codex/bin/codex_hal_ltcp" rf.info '{}' 8 2>&1) || true
  _parsed=$(echo "$_rf" | awk '
    { line = line " " $0 }
    END {
      if (line !~ /"code"[ \t]*:[ \t]*200/) { print "INVALID"; exit }
      n = split(line, parts, "{")
      for (i = 1; i <= n; i++) {
        obj = parts[i]
        sub(/\}.*$/, "", obj)
        if (obj ~ /"DeviceIndex"/) {
          eq = ""; idx = "?"
          if (match(obj, /"EquadID"[ \t]*:[ \t]*"?[0-9]+"?/)) {
            s = substr(obj, RSTART, RLENGTH)
            sub(/^.*:[ \t]*"?/, "", s); sub(/"?$/, "", s); eq = s
          }
          if (match(obj, /"DeviceIndex"[ \t]*:[ \t]*"?[0-9]+"?/)) {
            s = substr(obj, RSTART, RLENGTH)
            sub(/^.*:[ \t]*"?/, "", s); sub(/"?$/, "", s); idx = s
          }
          if (eq != "") {
            cnt[eq]++
            slots[eq] = (cnt[eq] > 1 ? slots[eq] ", " idx : idx)
          }
        }
      }
      dups = ""
      split("16414 16422 16423", noscr, " ")
      for (k = 1; k <= 3; k++) {
        m = noscr[k]
        if (cnt[m] > 1) dups = (dups != "" ? dups "; " : "") m " (slots " slots[m] ")"
      }
      print "DUPS=" dups
      if (cnt["16417"] > 1) print "SCREEN=" slots["16417"]
    }')
  if [ "$_parsed" = "INVALID" ]; then
    if [ "$_force" = "1" ]; then
      echo "warning=The hub radio didn't list its paired remotes (--force); if duplicate remotes without a screen are paired, the stock hal will hang."
      echo "rf_check=forced"
      return 0
    fi
    die "The hub's radio didn't list its paired remotes (rf.info failed); pass --force to turn off without checking."
  fi
  _dups=$(echo "$_parsed" | sed -n 's/^DUPS=//p')
  _scr=$(echo "$_parsed" | sed -n 's/^SCREEN=//p')
  if [ -n "$_scr" ]; then
    echo "warning=Two remotes with a screen (EquadID 16417, slots $_scr) are paired; the stock hal serves one of them at a time."
  fi
  if [ -n "$_dups" ]; then
    if [ "$_force" = "1" ]; then
      echo "warning=Duplicate remotes without a screen are paired (EquadID $_dups); the stock hal hangs on them (--force)."
      echo "rf_check=forced"
      return 0
    fi
    die "More than one remote without a screen of the same model is paired (EquadID $_dups). The stock hal hangs on duplicate remotes; unpair the extra ones in Settings -> Remotes first (or pass --force)."
  fi
  echo "rf_check=ok"
}

inspect_wifi() {
  _force=$1
  if [ ! -r "$R$WPA_CONF" ] || ! grep '^[ 	]*network[ 	]*=[ 	]*{' "$R$WPA_CONF" >/dev/null 2>&1; then
    if [ "$_force" = "1" ]; then
      echo "warning=/etc/wpa_supplicant.conf has no network={ block (--force); USB Ethernet won't start when Melodious is off, so the hub may be unreachable."
      echo "wifi_check=forced"
      return 0
    fi
    die "/etc/wpa_supplicant.conf has no network={ block. USB Ethernet doesn't run when Melodious is off, so the hub wouldn't join Wi-Fi after the reboot (configure Wi-Fi first, or pass --force)."
  fi
  echo "wifi_check=ok"
}

inspect_provision() {
  _force=$1
  _state=unprovisioned
  if [ -r "$R$PREFS" ] && [ -s "$R$PREFS" ]; then
    _state=$(awk '
      { line = line " " $0 }
      END {
        if (line !~ /"mode"[ \t]*:[ \t]*[23]/ || line !~ /"accountId"[ \t]*:[ \t]*"[^"]+"/ || line !~ /"authToken"[ \t]*:[ \t]*"[^"]+"/) {
          print "unprovisioned"
        } else if (line ~ /"authToken"[ \t]*:[ \t]*"local"/) {
          print "local_account"
        } else {
          print "cloud"
        }
      }' "$R$PREFS")
  fi
  echo "provision_state=$_state"
  if [ "$_state" = "local_account" ] || [ "$_state" = "unprovisioned" ]; then
    _msg="This hub is $_state (/data/luaworks/provision/preferences); re-provisioning it in the Harmony app runs cleanDataFolder(\"/data\") and wipes root SSH and /data/codex."
    if [ "$_force" = "1" ]; then
      echo "warning=$_msg (--force)"
      return 0
    fi
    die "$_msg Pass --force only if you intend to wipe /data/codex and root SSH."
  fi
}

check_off() {
  _force=$1
  [ -d "$R/data/codex" ] || die "Melodious isn't installed on this hub: /data/codex is missing."
  inspect_ssh
  _rep=$(report_off)
  if echo "$_rep" | grep '^active_off=yes$' >/dev/null 2>&1; then
    echo "$_rep"
    return 0
  fi
  inspect_remotes "$_force"
  inspect_wifi "$_force"
  inspect_provision "$_force"
  echo "$_rep"
}

apply_off() {
  _force=$1
  [ -d "$R/data/codex" ] || die "Melodious isn't installed on this hub: /data/codex is missing."
  inspect_ssh
  inspect_remotes "$_force"
  inspect_wifi "$_force"
  inspect_provision "$_force"
  for _p in $BOOTSTRAP_ALWAYS; do
    if [ ! -f "$R$_p" ] || ! grep -F "$MARKER" "$R$_p" >/dev/null 2>&1; then
      die "$_p does not yet support $MARKER; bootstrap gate scripts first."
    fi
  done

  trap '' HUP PIPE
  stamp=$(date -u +%Y%m%d-%H%M%S)
  mkdir -p "$R/etc" || die "Couldn't access /etc."
  if ! { echo "off $stamp" > "$R$MARKER.codex-new" &&
         chmod 644 "$R$MARKER.codex-new" &&
         mv -f "$R$MARKER.codex-new" "$R$MARKER"; }; then
    rm -f "$R$MARKER.codex-new"
    die "Couldn't write $MARKER; nothing changed."
  fi
  rm -f "$R$LEGACY_MARKER"

  if grep " $HAL_PATH " "$R/proc/mounts" >/dev/null 2>&1; then
    mkdir -p "$R/var/run" 2>/dev/null || true
    touch "$R$MULTI_PENDING" 2>/dev/null || true
  fi

  if [ -x "$R/data/codex/offline_egress_guard.sh" ]; then
    "$R/data/codex/offline_egress_guard.sh" >/dev/null 2>&1 || true
  fi

  if wifi_off_active; then
    wpa_cli -i ath0 reconnect >/dev/null 2>&1 || true
    rm -f "$R$WIFI_OFF_STATE" "$R$WIFI_OFF_STATE.failed"
    echo "wifi_reconnected=yes"
    _w=0
    while [ "$_w" -lt "$WIFI_WAIT" ] && [ -z "$(wifi_ipv4)" ]; do
      sleep 1
      _w=$((_w + 1))
    done
  fi

  emit_boot_stamp
  emit_network_state
  echo "result=off"
}

expected_hal_kind() {
  _two=$(cat "$R$TWO_SCREEN_CONF" 2>/dev/null || true)
  case "$_two" in
    1|once|serial|serial-once)
      if [ -f "$R$HAL_REMOTES" ]; then
        echo "two-screen"
        return 0
      fi
      ;;
  esac
  if [ "$(cat "$R$MULTI_REMOTE_CONF" 2>/dev/null || true)" = "1" ] && [ -f "$R$HAL_MULTI" ]; then
    echo "multi-remote"
    return 0
  fi
  echo "stock"
}

hal_matches_expected() {
  _want=$1
  _want_md5=${2:-}
  _bound=no
  grep " $HAL_PATH " "$R/proc/mounts" >/dev/null 2>&1 && _bound=yes
  _md5=$(md5sum "$R$HAL_PATH" 2>/dev/null | awk '{ print $1 }')
  case "$_want" in
    two-screen)
      _exp=${_want_md5:-$(md5sum "$R$HAL_REMOTES" 2>/dev/null | awk '{ print $1 }')}
      [ "$_bound" = "yes" ] && [ -n "$_exp" ] && [ "$_md5" = "$_exp" ]
      ;;
    multi-remote)
      _exp=${_want_md5:-$(md5sum "$R$HAL_MULTI" 2>/dev/null | awk '{ print $1 }')}
      [ "$_bound" = "yes" ] && [ -n "$_exp" ] && [ "$_md5" = "$_exp" ]
      ;;
    *) [ "$_bound" = "no" ] ;;
  esac
}

check_two_screen_load() {
  _out=$("$R$HAL_REMOTES" -h 2>&1; rc=$?; echo; echo "rc=$rc")
  if echo "$_out" | grep 'Usage:' >/dev/null 2>&1 &&
     echo "$_out" | grep '^rc=1$' >/dev/null 2>&1; then
    echo "two_screen_load_check=ok"
    return 0
  fi
  echo "two_screen_load_check=failed"
  die "The hub could not start $HAL_REMOTES; Melodious was left off and the hub was not restarted."
}

check_on() {
  [ -d "$R/data/codex" ] || die "Melodious isn't installed on this hub: /data/codex is missing."
  emit_boot_stamp
  _want=$(expected_hal_kind)
  echo "expected_hal=$_want"
  if [ "$_want" = "two-screen" ]; then
    check_two_screen_load
  fi
  _marker=absent
  [ -f "$R$MARKER" ] && _marker=present
  _legacy=absent
  [ -f "$R$LEGACY_MARKER" ] && _legacy=present
  echo "marker=$_marker"
  echo "legacy_marker=$_legacy"
  _webui=stopped
  ps_out | grep '[c]odex_webui' >/dev/null 2>&1 && _webui=running
  echo "webui=$_webui"
  if [ "$_marker" = "absent" ] && [ "$_legacy" = "absent" ] &&
     [ "$_webui" = "running" ] && hal_matches_expected "$_want"; then
    echo "already_on=yes"
  else
    echo "already_on=no"
  fi
}

apply_on() {
  [ -d "$R/data/codex" ] || die "Melodious isn't installed on this hub: /data/codex is missing."
  _want=$(expected_hal_kind)
  if [ "$_want" = "two-screen" ]; then
    check_two_screen_load
  fi
  trap '' HUP PIPE
  emit_boot_stamp
  rm -f "$R$MARKER" "$R$LEGACY_MARKER" || die "Couldn't remove $MARKER."
  if [ -e "$R$MARKER" ] || [ -e "$R$LEGACY_MARKER" ]; then
    die "Couldn't remove $MARKER."
  fi
  echo "expected_hal=$_want"
  echo "result=on"
}

verify_on() {
  _want=${1:-stock}
  emit_boot_stamp
  _missing=""
  add_missing() { _missing="${_missing:+$_missing, }$1"; }
  if [ -f "$R$MARKER" ]; then
    echo "marker=present"
    add_missing "marker=present"
  else
    echo "marker=absent"
  fi
  if [ -f "$R$LEGACY_MARKER" ]; then
    echo "legacy_marker=present"
    add_missing "legacy_marker=present"
  else
    echo "legacy_marker=absent"
  fi
  if ps_out | grep '[c]odex_webui' >/dev/null 2>&1; then
    echo "webui=running"
  else
    echo "webui=stopped"
    add_missing "webui=stopped"
  fi
  if grep " $HAL_PATH " "$R/proc/mounts" >/dev/null 2>&1; then
    echo "hal_mount=bound"
  else
    echo "hal_mount=stock"
  fi
  _md5=$(md5sum "$R$HAL_PATH" 2>/dev/null | awk '{ print $1 }')
  echo "hal_md5=$_md5"
  echo "hal_gates=$(cat "$R$HAL_GATES" 2>/dev/null || true)"
  if ! hal_matches_expected "$_want" "${2:-}"; then
    add_missing "hal!=$_want"
  fi
  if [ -z "$_missing" ]; then
    echo "active_on=yes"
  else
    echo "active_on=no"
    echo "missing_on=$_missing"
  fi
}

MODE=${1:-}
FORCE=0
[ "${2:-}" = "--force" ] && FORCE=1

case "$MODE" in
  check) check_off "$FORCE" ;;
  apply) apply_off "$FORCE" ;;
  verify-off) report_off ;;
  check-on) check_on ;;
  apply-on) apply_on ;;
  verify-on) verify_on "${2:-stock}" "${3:-}" ;;
  *) echo "usage: $0 {check|apply} [--force] | verify-off | check-on | apply-on | verify-on <hal>" >&2; exit 2 ;;
esac
"""


def boot_changed(before: dict[str, list[str]], after: dict[str, list[str]]) -> bool:
    """True when post-reboot boot_id, btime, or uptime proves a reboot happened."""
    b_id = (before.get("boot_id") or [""])[0].strip()
    a_id = (after.get("boot_id") or [""])[0].strip()
    if b_id and a_id:
        return a_id != b_id
    b_bt = (before.get("btime") or [""])[0].strip()
    a_bt = (after.get("btime") or [""])[0].strip()
    if b_bt.isdigit() and a_bt.isdigit() and a_bt != b_bt:
        return True
    b_up = (before.get("uptime_s") or [""])[0].strip()
    a_up = (after.get("uptime_s") or [""])[0].strip()
    if b_up.isdigit() and a_up.isdigit() and int(a_up) < int(b_up):
        return True
    return False


def step(text: str) -> None:
    print(f"\n== {text} ==")


def info(text: str) -> None:
    print(f"  {text}")


def kv(text: str) -> None:
    print(text)


def warn_experimental_turn_off_on() -> None:
    """Prominent EXPERIMENTAL banner for --turn-off/--turn-on, before any action."""
    line = "!" * 78
    print("")
    print(line)
    for text_line in EXPERIMENTAL_TURN_OFF_WARNING.split("\n"):
        print(f"!! {text_line}")
    print(line)


def fail(message: str) -> None:
    print(f"\nERROR: {message}", file=sys.stderr)
    sys.exit(1)


def prompt_if_missing(value: str | None, label: str, required: bool, no_prompt: bool) -> str:
    if value:
        return value
    if no_prompt:
        if required:
            raise RuntimeError(f"{label} is required")
        return ""
    entered = input(f"{label}: ").strip()
    if required and not entered:
        raise RuntimeError(f"{label} is required")
    return entered


def resolve_default_key_path() -> Path | None:
    ssh_dir = Path.home() / ".ssh"
    if not ssh_dir.is_dir():
        return None
    keys = [
        p
        for p in ssh_dir.glob("harmony_owner_*")
        if p.is_file() and not p.name.endswith(".pub")
    ]
    if not keys:
        return None
    return sorted(keys, key=lambda p: p.stat().st_mtime, reverse=True)[0]


def valid_hub_id(value: str) -> bool:
    return value.isdigit() and len(value) >= 4


def read_json_file(path: Path) -> object | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def resolve_saved_hub_id(hub_host: str) -> tuple[str, Path] | None:
    candidate_paths: list[Path] = []
    home = Path.home()
    candidate_paths.extend(
        [
            home / ".harmony-hub" / "known_hubs.json",
            home / ".harmony-hub" / "last_root.json",
            home / ".harmony-hub" / "hub_id.txt",
            ROOT / "harmony_hub_id.txt",
        ]
    )

    seen: set[Path] = set()
    for path in candidate_paths:
        if path in seen:
            continue
        seen.add(path)
        if not path.is_file():
            continue
        if path.name == "known_hubs.json":
            known = read_json_file(path)
            if isinstance(known, dict):
                entry = known.get(hub_host)
                if isinstance(entry, dict):
                    hub_id = str(entry.get("hub_id", "")).strip()
                    if valid_hub_id(hub_id):
                        return hub_id, path
            continue
        if path.name == "last_root.json":
            last = read_json_file(path)
            if isinstance(last, dict) and str(last.get("host", "")) == hub_host:
                hub_id = str(last.get("hub_id", "")).strip()
                if valid_hub_id(hub_id):
                    return hub_id, path
            continue
        try:
            hub_id = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if valid_hub_id(hub_id):
            return hub_id, path
    return None


def remote_quote(value: str) -> str:
    return shlex.quote(value)


def bin_manifest_names() -> list[str]:
    """Install binary list from payload/bin/MANIFEST.txt (canonical inventory)."""
    manifest = PAYLOAD / "bin" / "MANIFEST.txt"
    names: list[str] = []
    for line in manifest.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) >= 2 and len(parts[0]) == 32:
            names.append(parts[-1])
    if not names:
        raise RuntimeError(f"no binaries listed in {manifest}")
    for name in names:
        path = PAYLOAD / "bin" / name
        if not path.is_file():
            raise RuntimeError(f"MANIFEST lists {name} but {path} is missing")
    return names


def flash_estimate(data: bytes, name: str) -> int:
    """Bytes a new file takes on the hub's jffs2: one zlib node (level 3, as
    jffs2 uses) per 4 KiB page, stored raw when that is smaller, plus the
    directory entry. Nodes are 4-byte aligned."""
    total = (JFFS2_DIRENT_HEADER + len(name.encode("utf-8")) + 3) & ~3
    for start in range(0, len(data), JFFS2_PAGE):
        page = data[start : start + JFFS2_PAGE]
        stored = min(len(zlib.compress(page, 3)), len(page))
        total += (JFFS2_NODE_HEADER + stored + 3) & ~3
    return total


def flash_margin(estimate: int) -> int:
    return FLASH_MARGIN_BYTES + estimate * FLASH_MARGIN_PERCENT // 100


def kib(value: int) -> str:
    return f"{(value + 1023) // 1024} KB"


def stage_suffix() -> str:
    """Random staging-dir suffix (the hub has no mktemp)."""
    return secrets.token_hex(6)


def tcp_open(host: str, port: int, timeout: float = 1.2) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def wait_for_port(host: str, port: int, seconds: int, label: str) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if tcp_open(host, port):
            info(f"{label} is reachable on port {port}")
            return
        time.sleep(2)
    raise RuntimeError(f"{label} did not become reachable on port {port} within {seconds} seconds")


class Candidate:
    """One file the installer may place on the hub."""

    def __init__(
        self,
        dest: str,
        mode: str,
        kind: str,
        local: Path | None = None,
        text: str | None = None,
        sensitive: bool = False,
        condition: str = "always",
        blob: bytes | None = None,
    ) -> None:
        self.dest = dest
        self.mode = mode
        self.kind = kind  # binary | runtime | plugin | config
        self.local = local
        self.text = text
        self.blob = blob  # bytes built at install time (the multi-remote hal)
        self.sensitive = sensitive
        self.condition = condition  # always | if-missing
        self.bytes = 0
        self.md5 = ""
        self.flash_bytes = 0
        self.action = "replace"  # replace | create | preserve | unchanged
        self.staged_name = ""
        # An identical (or, for Dropbear, equivalent) file already on the hub
        # that phase 1 hard-links, and the MD5 and size it has.
        self.link_source = ""
        self.link_md5 = ""
        self.link_bytes = 0
        self.linked = False  # phase 1 linked it rather than copying the payload

    def data(self) -> bytes:
        if self.blob is not None:
            return self.blob
        if self.local is not None:
            return self.local.read_bytes()
        return (self.text or "").encode("utf-8")

    def prepare(self) -> None:
        data = self.data()
        self.bytes = len(data)
        self.md5 = hashlib.md5(data).hexdigest()
        self.flash_bytes = flash_estimate(data, self.dest.rsplit("/", 1)[-1] + NEW_SUFFIX)


MD5_HEX_RE = re.compile(r"^[0-9a-f]{32}$")
PERM_RE = re.compile(r"^-[r-][w-][xsS-][r-][w-][xsS-][r-][w-][xtT-]$")
FILE_STATUS_TYPES = ("absent", "regular", "symlink", "other")
STATUS_LINE_RE = re.compile(r"^file_status type=(\S+)(?: perm=(\S*) bytes=(\S*) md5=(\S*))? path=(.+)$")


def perm_to_mode(perm: str) -> str:
    """Octal mode from an `ls -l` permission string, e.g. -rwxr-xr-x -> 755."""
    if not PERM_RE.match(perm):
        raise ValueError(perm)
    special = 0
    digits = []
    for index, (shift, flag) in enumerate(((0, 4), (3, 2), (6, 1))):
        r, w, x = perm[1 + shift : 4 + shift]
        value = (4 if r == "r" else 0) + (2 if w == "w" else 0)
        if x in "xst":
            value += 1
        if x in "sStT":
            special |= flag
        digits.append(str(value))
    mode = "".join(digits)
    return f"{special}{mode}" if special else mode


def file_status_command(paths: list[str]) -> str:
    """One BusyBox-only probe for many paths (no stat/readlink on the hub)."""
    quoted = " ".join(remote_quote(p) for p in paths)
    return (
        f"for p in {quoted}; do "
        'if [ -L "$p" ]; then echo "file_status type=symlink path=$p"; '
        'elif [ -f "$p" ]; then set -- $(ls -l "$p"); m=$(md5sum "$p"); '
        'echo "file_status type=regular perm=$1 bytes=$5 md5=${m%% *} path=$p"; '
        'elif [ -e "$p" ]; then echo "file_status type=other path=$p"; '
        'else echo "file_status type=absent path=$p"; fi; done'
    )


def parse_file_status(paths: list[str], raw: str) -> dict[str, dict[str, str]]:
    """Validate probe output into {path: {path, kind, size, mode, md5}}.

    Strict: every requested path must appear exactly once with a known type;
    regular files need a valid permission string, decimal size, and 32-hex
    md5. Fails closed on anything else.
    """
    wanted = set(paths)
    states: dict[str, dict[str, str]] = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        match = STATUS_LINE_RE.match(line)
        if not match:
            raise RuntimeError(f"file-status: unexpected probe line: {line!r}")
        kind, perm, size, md5, path = match.groups()
        if path not in wanted:
            raise RuntimeError(f"file-status: probe reported unexpected path: {path!r}")
        if path in states:
            raise RuntimeError(f"file-status: probe reported {path} twice")
        if kind not in FILE_STATUS_TYPES:
            raise RuntimeError(f"file-status for {path} reported invalid type {kind!r}")
        if kind != "regular":
            if perm is not None:
                raise RuntimeError(f"file-status for {path}: {kind} with file fields: {line!r}")
            states[path] = {"path": path, "kind": kind, "size": "0", "mode": "", "md5": ""}
            continue
        try:
            mode = perm_to_mode(perm or "")
        except ValueError:
            raise RuntimeError(f"file-status for {path} reported invalid permissions {perm!r}")
        if not (size or "").isdigit():
            raise RuntimeError(f"file-status for {path} reported invalid size {size!r}")
        if not MD5_HEX_RE.match(md5 or ""):
            raise RuntimeError(f"file-status for {path}: regular file without a computed md5")
        states[path] = {"path": path, "kind": "regular", "size": size, "mode": mode, "md5": md5}
    missing = wanted - set(states)
    if missing:
        raise RuntimeError(f"file-status: probe output missing {sorted(missing)}")
    return states


class Installer:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.key_path = Path(args.key_path).expanduser().resolve()
        self.first_install = False
        self.stage = ""
        self.preserve_stage = False
        self.candidates: list[Candidate] = []
        # Whether the multi-remote hal runs now; None until checked (--multi-remote only).
        self.hal_bound: bool | None = None
        # md5 of the hal that runs now, and what the hub says about multi-remote;
        # None until checked (--two-screen or --multi-remote only).
        self.running_hal: str | None = None
        self.running_hal_facts: dict[str, str] = {}
        self.probe: dict[str, dict[str, str]] = {}
        self.handoff_estimate = 0
        self.forward_total = 0
        self.rollback_total = 0
        self.staged_total = 0
        self.ram_free_bytes = 0
        self.ram_required_bytes = 0
        self.verdict = VERDICT_VALIDATION
        self.verdict_reasons: list[str] = []
        self.generations = {"handoff": 0, "resource": 0, "settings": 0, "update": 0}
        self.handoff_dirs: list[str] = []
        self.changed: list[dict[str, object]] = []
        self.new_copies: list[str] = []
        self.hub_id = ""
        # Flash, from codex_flash_free; None when it couldn't be measured.
        self.flash_helper = ""
        self.flash_avail: int | None = None
        self.flash_total = 0
        self.flash_written = 0
        self.flash_required = 0
        self.flash_released = 0
        self.flash_note = ""
        # "preflight" when the measured check blocked, "phase1" when a copy failed.
        self.capacity_stage = ""
        self.root_tool_stages: list[dict[str, object]] = []
        # Inode of each Dropbear copy, by path.
        self.dropbear_copies: dict[str, str] = {}
        # Hard-link count of each, by path.
        self.dropbear_links: dict[str, int] = {}

    # ------------------------------------------------------------------ ssh

    def ssh_base_args(self) -> list[str]:
        return [
            "ssh",
            "-p",
            str(self.args.port),
            "-i",
            str(self.key_path),
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
            f"{self.args.ssh_user}@{self.args.hub_host}",
        ]

    def run_remote_raw(self, command: str, timeout: int = 90) -> tuple[int, bytes, str]:
        """Like run_remote_rc, with stdout left as bytes (for reading a binary)."""
        proc = subprocess.run(
            self.ssh_base_args() + [command],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
        return proc.returncode, proc.stdout, proc.stderr.decode("utf-8", "replace")

    def read_remote_bytes(self, path: str, timeout: int = 120) -> bytes:
        code, out, err = self.run_remote_raw(f"cat {remote_quote(path)}", timeout=timeout)
        if code != 0:
            raise RuntimeError(f"could not read {path} from the hub (exit {code}): {err.strip()}")
        return out

    def run_remote_rc(
        self,
        command: str,
        input_bytes: bytes | None = None,
        timeout: int = 90,
    ) -> tuple[int, str, str]:
        proc = subprocess.run(
            self.ssh_base_args() + [command],
            input=input_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
        return (
            proc.returncode,
            proc.stdout.decode("utf-8", "replace"),
            proc.stderr.decode("utf-8", "replace"),
        )

    def run_remote(
        self,
        command: str,
        input_bytes: bytes | None = None,
        timeout: int = 90,
        quiet: bool = False,
    ) -> str:
        code, stdout, stderr = self.run_remote_rc(command, input_bytes, timeout)
        if code != 0:
            raise RuntimeError(
                "ssh failed with exit {code}\ncommand={cmd}\nstdout={out}\nstderr={err}".format(
                    code=code,
                    cmd=command,
                    out=stdout,
                    err=stderr,
                )
            )
        if stderr.strip() and not quiet:
            print(stderr.strip())
        return stdout

    def remote_md5(self, path: str, timeout: int = 90) -> str:
        code, out, _err = self.run_remote_rc(f"md5sum {remote_quote(path)}", timeout=timeout)
        match = MD5_LINE_RE.match(out.strip()) if code == 0 else None
        return match.group(1) if match and match.group(2) == path else ""

    # ------------------------------------------------------------- staging

    def create_stage(self) -> None:
        step("Creating private staging tree")
        stage = f"{STAGE_PREFIX}{stage_suffix()}"
        if not re.match(r"^/var/volatile/codex-install-[0-9a-z]+$", stage):
            raise RuntimeError(f"unsafe staging path: {stage!r}")
        # mkdir fails if the path already exists, so the tree is ours alone.
        cmd = f"mkdir {remote_quote(stage)} && chmod 700 {remote_quote(stage)} && echo {remote_quote(stage)}"
        out = self.run_remote(cmd, timeout=30).strip()
        if out != stage:
            raise RuntimeError(f"staging tree creation echoed {out!r}, expected {stage!r}")
        self.stage = stage
        kv(f"staging_dir={self.stage}")
        info("mode=0700 owner-only volatile staging; deleted before exit unless rollback needs it")

    def upload_candidates(self) -> None:
        step("Uploading candidates to staging")
        for index, cand in enumerate(self.candidates):
            name = f"{index:02d}-{cand.dest.rsplit('/', 1)[-1]}"
            cand.staged_name = name
            remote = f"{self.stage}/{name}"
            command = (
                f"cat > {remote_quote(remote)} && "
                f"chmod 600 {remote_quote(remote)}"
            )
            timeout = max(90, 45 + int(cand.bytes / 12000))
            self.run_remote(command, cand.data(), timeout=timeout, quiet=True)
            shown = "<hidden>" if cand.sensitive else cand.md5
            kv(f"staged index={index} dest={cand.dest} bytes={cand.bytes} md5={shown}")

    def upload_flash_helper(self) -> None:
        if not FLASH_HELPER.is_file():
            self.flash_note = f"{FLASH_HELPER.relative_to(ROOT)} is missing"
            return
        remote = f"{self.stage}/{FLASH_HELPER_NAME}"
        self.run_remote(
            f"cat > {remote_quote(remote)} && chmod 700 {remote_quote(remote)}",
            FLASH_HELPER.read_bytes(),
            timeout=90,
            quiet=True,
        )
        self.flash_helper = remote
        info(f"staged flash probe {remote} (RAM only, never installed)")

    def measure_flash(self) -> None:
        """Free flash from codex_flash_free; leaves flash_avail None on any doubt."""
        self.flash_avail = None
        if not self.flash_helper:
            return
        code, out, err = self.run_remote_rc(f"{remote_quote(self.flash_helper)} {FLASH_PATH}", timeout=30)
        match = re.search(
            r"^flash type=(0x[0-9a-f]+) total_bytes=(\d+) free_bytes=(\d+) avail_bytes=(\d+) path=(\S+)$",
            out.strip(),
            re.M,
        )
        if code != 0 or not match or match.group(5) != FLASH_PATH:
            self.flash_note = f"the flash probe didn't answer ({(err or out).strip()[:120] or f'exit {code}'})"
            return
        total, avail = int(match.group(2)), int(match.group(4))
        if not (1048576 <= total <= 64 * 1048576) or avail > total:
            self.flash_note = f"the flash probe reported an unlikely size (total {total}, available {avail})"
            return
        self.flash_total = total
        self.flash_avail = avail
        self.flash_note = ""

    def verify_stage_md5(self) -> None:
        step("Verifying staged candidate MD5 (strict BusyBox format)")
        entries = [(c.staged_name, c.md5, c.dest) for c in self.candidates if not c.sensitive]
        paths = " ".join(remote_quote(f"{self.stage}/{name}") for name, _, _ in entries)
        out = self.run_remote(f"md5sum {paths}", timeout=120)
        expected = {f"{self.stage}/{name}": md5 for name, md5, _ in entries}
        seen: set[str] = set()
        for line in out.splitlines():
            match = MD5_LINE_RE.match(line.strip())
            if not match:
                raise RuntimeError(f"unexpected md5sum output line: {line!r}")
            digest, path = match.group(1), match.group(2)
            if path not in expected:
                raise RuntimeError(f"md5sum reported unexpected path: {path!r}")
            if digest != expected[path]:
                raise RuntimeError(f"staged md5 mismatch for {path}: expected {expected[path]} got {digest}")
            seen.add(path)
        missing = set(expected) - seen
        if missing:
            raise RuntimeError(f"md5sum output missing entries: {sorted(missing)}")
        sensitive_paths = [f"{self.stage}/{c.staged_name}" for c in self.candidates if c.sensitive]
        if sensitive_paths:
            out = self.run_remote("md5sum " + " ".join(remote_quote(p) for p in sensitive_paths), timeout=60)
            expected_s = {f"{self.stage}/{c.staged_name}": c.md5 for c in self.candidates if c.sensitive}
            seen_s: set[str] = set()
            for line in out.splitlines():
                match = MD5_LINE_RE.match(line.strip())
                if not match or match.group(2) not in expected_s or match.group(1) != expected_s[match.group(2)]:
                    raise RuntimeError("staged sensitive candidate failed md5 verification")
                seen_s.add(match.group(2))
            if seen_s != set(expected_s):
                raise RuntimeError("staged sensitive candidate failed md5 verification")
        info("all staged candidates verified")

    # ----------------------------------------------------------- inventory

    def build_mqtt_config(self) -> str:
        broker = self.args.mqtt_broker or ""
        enabled = bool(broker) and not self.args.mqtt_disabled
        cfg = {
            "enabled": enabled,
            "name": "Harmony Hub",
            "clientId": self.args.mqtt_client_id,
            "baseTopic": self.args.mqtt_base_topic.strip("/"),
            "discoveryPrefix": self.args.mqtt_discovery_prefix.strip("/"),
            "haDiscovery": True,
            "pollSeconds": 10,
            "keepAlive": 60,
            "broker": {
                "host": broker,
                "port": self.args.mqtt_port,
                "username": self.args.mqtt_user or "",
                "password": self.args.mqtt_password or "",
            },
        }
        return json.dumps(cfg, separators=(",", ":")) + "\n"

    def mqtt_explicit(self) -> bool:
        return bool(getattr(self.args, "mqtt_explicit_supplied", False))

    def build_inventory(self) -> None:
        clean = self.args.clean_install
        candidates: list[Candidate] = []

        bin_names = bin_manifest_names()
        for name in bin_names:
            if name == "codex_webui":
                continue  # webui is installed last, after every noncritical file
            candidates.append(
                Candidate(f"/data/codex/bin/{name}", "755", "binary", local=PAYLOAD / "bin" / name)
            )
        candidates.append(
            Candidate("/usr/sbin/dropbear", "755", "binary", local=PAYLOAD / "scripts" / "dropbear")
        )
        candidates.append(
            Candidate("/usr/sbin/dropbearkey", "755", "binary", local=PAYLOAD / "scripts" / "dropbearkey")
        )

        candidates.extend(
            [
                Candidate("/data/codex/init.sh", "755", "runtime", local=PAYLOAD / "scripts" / "init.sh"),
                Candidate(
                    "/data/codex/offline_egress_guard.sh",
                    "755",
                    "runtime",
                    local=PAYLOAD / "scripts" / "offline_egress_guard.sh",
                ),
                Candidate(
                    "/data/codex/recovery_ap.sh", "755", "runtime", local=PAYLOAD / "scripts" / "recovery_ap.sh"
                ),
                Candidate(
                    "/data/codex/androidtv_service.sh", "755", "runtime", local=PAYLOAD / "scripts" / "androidtv_service.sh"
                ),
                Candidate(
                    "/data/codex/usb_eth_service.sh", "755", "runtime", local=PAYLOAD / "scripts" / "usb_eth_service.sh"
                ),
                Candidate(
                    "/data/codex/modules/usb-net/r8152.ko", "644", "runtime", local=PAYLOAD / "modules" / "usb-net" / "r8152.ko"
                ),
                Candidate(
                    "/data/codex/modules/usb-net/usbnet.ko", "644", "runtime", local=PAYLOAD / "modules" / "usb-net" / "usbnet.ko"
                ),
                Candidate(
                    "/data/codex/modules/usb-net/asix.ko", "644", "runtime", local=PAYLOAD / "modules" / "usb-net" / "asix.ko"
                ),
                Candidate(
                    "/data/codex/modules/usb-net/cdc_ether.ko", "644", "runtime", local=PAYLOAD / "modules" / "usb-net" / "cdc_ether.ko"
                ),
                Candidate(
                    "/data/codex/modules/usb-net/cdc_ncm.ko", "644", "runtime", local=PAYLOAD / "modules" / "usb-net" / "cdc_ncm.ko"
                ),
                Candidate(
                    "/data/codex/modules/usb-net/ax88179_178a.ko", "644", "runtime", local=PAYLOAD / "modules" / "usb-net" / "ax88179_178a.ko"
                ),
                Candidate(
                    "/data/codex/modules/usb-net/README.md", "644", "runtime", local=PAYLOAD / "modules" / "usb-net" / "README.md"
                ),
                Candidate("/etc/init.d/rcS.local", "755", "runtime", local=PAYLOAD / "scripts" / "rcS.local"),
            ]
        )
        if not self.args.skip_cloud_suppression:
            candidates.append(
                Candidate(
                    "/opt/luaworks/tasks/connectserver/netservicestarter.lua",
                    "644",
                    "runtime",
                    local=PAYLOAD / "scripts" / "netservicestarter.lua",
                )
            )
        candidates.extend(
            [
                Candidate(
                    "/pkg/codexactivity/codexactivity.lua",
                    "644",
                    "plugin",
                    local=PAYLOAD / "activity" / "codexactivity.lua",
                ),
                Candidate(
                    "/pkg/codexmqtt/codexmqtt.lua", "644", "plugin", local=PAYLOAD / "mqtt" / "codexmqtt.lua"
                ),
            ]
        )

        # Configuration: generated only in clean mode or when explicitly supplied.
        hub_id_explicit = bool(self.args.hub_id)
        if clean or hub_id_explicit:
            candidates.append(Candidate("/data/codex/hub_id", "644", "config", text=f"{self.hub_id}\n"))
        if clean:
            candidates.append(
                Candidate(
                    "/data/codex/cloud_blocker.conf",
                    "644",
                    "config",
                    text="0\n" if self.args.skip_cloud_suppression else "1\n",
                )
            )
        elif not self.args.skip_cloud_suppression:
            # Without the file, codex_webui and netservicestarter.lua treat the
            # cloud as blocked but the egress guard and the activity writer
            # don't: create it, and keep whatever value is already there.
            candidates.append(
                Candidate("/data/codex/cloud_blocker.conf", "644", "config", text="1\n", condition="if-missing")
            )
        for dest, text in (
            ("/etc/tdeenable", "1\n"),
            ("/pkg/codexactivity/manifest.json", '{"plugin":"codexactivity"}\n'),
            ("/pkg/codexmqtt/manifest.json", '{"plugin":"codexmqtt"}\n'),
        ):
            candidates.append(Candidate(dest, "644", "config", text=text, condition="if-missing"))
        # Multiple remotes of one model: only when asked, either way.
        hal_read = self.read_remote_bytes(HAL_PATH) if "on" in (self.args.multi_remote, self.two_screen_wanted()) else b""
        if self.args.multi_remote == "on":
            if hashlib.md5(hal_read).hexdigest() != HAL_REMOTES_MD5:
                candidates.append(Candidate(HAL_MULTI_DEST, "755", "binary", blob=patched_hal(hal_read)))
            # else the two-screen hal runs and carries multi-remote; its own
            # copy can only be built from the stock hal (check_two_screen()).
            candidates.append(Candidate(MULTI_REMOTE_CONF, "644", "config", text="1\n"))
        elif self.args.multi_remote == "off":
            # The copy itself goes after a successful install (post_install_wiring).
            candidates.append(Candidate(MULTI_REMOTE_CONF, "644", "config", text="0\n"))
        # Two remotes with a screen: only when asked, either way.
        if self.args.two_screen in TWO_SCREEN_SETTINGS:
            candidates.append(Candidate(HAL_REMOTES_DEST, "755", "binary", blob=remotes_hal(hal_read)))
            candidates.append(
                Candidate(TWO_SCREEN_CONF, "644", "config", text=TWO_SCREEN_SETTINGS[self.args.two_screen] + "\n")
            )
            candidates.append(Candidate(HAL_REMOTES_TRIES, "644", "config", text="0\n"))
        elif self.args.two_screen == "off":
            # rcS.local deletes the copy at the next boot.
            candidates.append(Candidate(TWO_SCREEN_CONF, "644", "config", text="0\n"))
        if clean or self.mqtt_explicit():
            candidates.append(
                Candidate(
                    "/data/codexmqtt/config.json",
                    "600",
                    "config",
                    text=self.build_mqtt_config(),
                    sensitive=True,
                )
            )

        # codex_webui is always the final replacement.
        candidates.append(Candidate(WEBUI_DEST, "755", "binary", local=PAYLOAD / "bin" / "codex_webui"))

        for cand in candidates:
            cand.prepare()
        self.candidates = candidates

    # ------------------------------------------------------------ discovery

    def file_status(self, paths: list[str]) -> dict[str, dict[str, str]]:
        code, out, err = self.run_remote_rc(file_status_command(paths), timeout=180)
        if code != 0:
            self.fail_validation(f"file-status probe failed (exit {code}): {err.strip()}")
        try:
            return parse_file_status(paths, out)
        except RuntimeError as exc:
            self.fail_validation(str(exc))
        raise AssertionError("unreachable")

    def probe_destinations(self) -> None:
        step("Probing destination state (BusyBox ls -l / md5sum)")
        dests = [c.dest for c in self.candidates]
        dests += [p for p in HANDOFF_REQUIRED_PATHS + [ROOT_TOOL_DROPBEAR, HAL_MULTI_DEST] if p not in dests]
        self.probe = self.file_status(dests)
        for cand in self.candidates:
            if self.probe[cand.dest]["kind"] in ("symlink", "other"):
                self.fail_validation(
                    f"destination {cand.dest} is a {self.probe[cand.dest]['kind']}, not a regular file"
                )

    def fail_validation(self, reason: str) -> None:
        self.verdict = VERDICT_VALIDATION
        self.verdict_reasons.append(reason)
        raise RuntimeError(reason)

    def resolve_hub_id(self) -> None:
        hub_id = self.args.hub_id or ""
        existing = self.run_remote("cat /data/codex/hub_id 2>/dev/null || true", timeout=30).strip()
        if not existing and not self.args.clean_install:
            # A hub without /data/codex/hub_id has no configuration of ours to
            # preserve, so the first install writes it, as --clean-install does.
            self.args.clean_install = True
            self.first_install = True
            info("first install: the hub has no /data/codex/hub_id yet, so this run writes the configuration (as --clean-install)")
        if not hub_id:
            if existing:
                hub_id = existing
                info(f"hub id from existing /data/codex/hub_id: {hub_id}")
            else:
                saved = resolve_saved_hub_id(self.args.hub_host)
                if saved:
                    hub_id, source = saved
                    info(f"hub id from root-tool handoff: {hub_id} ({source})")
        if not valid_hub_id(hub_id):
            if hub_id:
                raise RuntimeError(f"Invalid Hub ID {hub_id!r}. Re-run the root tool or pass --hub-id with the numeric value.")
            raise RuntimeError(
                "Hub ID is required. Re-run the root tool so it writes the handoff file, "
                "or pass --hub-id with the numeric value printed as hub_id=..."
            )
        self.hub_id = hub_id
        info(f"using hub id {hub_id}")

    def apply_upgrade_gates(self) -> None:
        """Decide replace/create/preserve/unchanged per candidate from probe state."""
        for cand in self.candidates:
            state = self.probe.get(cand.dest, {})
            exists = state.get("kind") == "regular"
            if cand.condition == "if-missing" and exists and not self.args.clean_install:
                cand.action = "preserve"
            elif exists and state.get("mode") == cand.mode and hub_copy_current(cand.dest, state.get("md5", ""), cand.md5):
                cand.action = "unchanged"
            elif exists:
                cand.action = "replace"
            else:
                cand.action = "create"
        # Upgrade mode: hub_id must exist or be explicitly supplied.
        hub_state = self.probe.get("/data/codex/hub_id", {})
        if not self.args.clean_install and hub_state.get("kind") != "regular" and not any(
            c.dest == "/data/codex/hub_id" for c in self.candidates
        ):
            self.verdict = VERDICT_CONFIG_UNCERTAIN
            self.verdict_reasons.append(
                "upgrade mode: /data/codex/hub_id missing and no explicit --hub-id supplied"
            )

    def plan_dropbear_link(self) -> None:
        """Reuse harmony-hub-root's dropbearmulti when it is the same build
        as ours, or another build of the same Dropbear (DROPBEAR_BUILDS)."""
        source = self.probe.get(ROOT_TOOL_DROPBEAR, {})
        md5 = source.get("md5", "")
        for cand in self.candidates:
            if (
                cand.dest == DROPBEAR_DEST
                and cand.action in ("replace", "create")
                and source.get("kind") == "regular"
                and hub_copy_current(cand.dest, md5, cand.md5)
            ):
                cand.link_source = ROOT_TOOL_DROPBEAR
                cand.link_md5 = md5
                cand.link_bytes = int(source["size"])

    def scan_root_tool_leftovers(self) -> None:
        out = self.run_remote(ROOT_TOOL_SCAN, timeout=60, quiet=True)
        self.root_tool_stages = []
        self.dropbear_copies = {}
        self.dropbear_links = {}
        for line in out.splitlines():
            line = line.strip()
            stage = re.match(r"^root_tool_stage bytes=(\d+) files=(\d+) path=(\S+)$", line)
            if stage and ROOT_TOOL_STAGE_RE.match(stage.group(3)):
                self.root_tool_stages.append(
                    {"path": stage.group(3), "bytes": int(stage.group(1)), "files": int(stage.group(2))}
                )
                continue
            copy = re.match(r"^dropbear_copy inode=(\d+) links=(\d+) path=(\S+)$", line)
            if copy and copy.group(3) in (ROOT_TOOL_DROPBEAR, DROPBEAR_DEST):
                self.dropbear_copies[copy.group(3)] = copy.group(1)
                self.dropbear_links[copy.group(3)] = int(copy.group(2))

    def root_tool_dropbear_removable(self) -> bool:
        """True when the root tool's Dropbear is a separate copy that SSH no
        longer uses and phase 1 won't link."""
        # Separate means its only name: with a second link (ours, or anything
        # else), removing it frees nothing. Inode numbers can't tell: the hub's
        # unionfs numbers each path afresh after a reboot.
        separate = self.dropbear_links.get(ROOT_TOOL_DROPBEAR) == 1
        # And only while ours is a working Dropbear: never trade the root
        # tool's copy for a damaged one.
        ours_ok = self.probe.get(DROPBEAR_DEST, {}).get("md5") in DROPBEAR_BUILDS
        wrapper = next((c for c in self.candidates if c.dest == "/usr/sbin/dropbear"), None)
        return bool(
            DROPBEAR_DEST in self.dropbear_copies
            and separate
            and ours_ok
            and wrapper is not None
            and self.probe.get("/usr/sbin/dropbear", {}).get("md5") == wrapper.md5
            and not any(c.link_source == ROOT_TOOL_DROPBEAR for c in self.candidates)
        )

    def leftover_credit(self) -> int:
        """Flash the removable root-tool leftovers are estimated to free."""
        # Base64 chunks compress to about two thirds; count three fifths.
        credit = sum(int(s["bytes"]) * 3 // 5 for s in self.root_tool_stages)
        if self.root_tool_dropbear_removable():
            dropbear = next((c for c in self.candidates if c.dest == DROPBEAR_DEST), None)
            if dropbear is not None and dropbear.bytes:
                # Scaled to the root tool's copy, which may be the smaller build.
                # (Its stripped .pdr compressed well, so this errs low: safe.)
                size = int(self.probe.get(ROOT_TOOL_DROPBEAR, {}).get("size", dropbear.bytes))
                credit += dropbear.flash_bytes * size // dropbear.bytes
        return credit

    def active_candidates(self) -> list[Candidate]:
        return [c for c in self.candidates if c.action in ("replace", "create")]

    def ram_status(self) -> None:
        """Usable RAM from /proc/meminfo; staging and rollback copies live in tmpfs.

        The hub kernel has no MemAvailable, so credit what the kernel reclaims for
        tmpfs on demand: inactive file cache and reclaimable slab. On a 32 MB hub
        MemFree alone is about 1 MiB after staging while about 8 MiB is reclaimable.
        """
        out = self.run_remote("cat /proc/meminfo", timeout=30, quiet=True)
        fields = dict(re.findall(r"^(\S+):\s+(\d+) kB$", out, re.M))
        if "MemFree" not in fields:
            self.fail_validation("could not read MemFree from /proc/meminfo")
        kb = sum(int(fields.get(name, 0)) for name in ("MemFree", "Inactive(file)", "SReclaimable"))
        self.ram_free_bytes = kb * 1024

    def build_plans(self) -> None:
        step("Planning changed destinations")
        self.forward_total = 0
        self.rollback_total = 0
        self.staged_total = sum(c.bytes for c in self.candidates)
        copies = 0
        self.flash_released = 0
        for cand in self.candidates:
            state = self.probe.get(cand.dest, {})
            if cand.action in ("replace", "create"):
                self.forward_total += cand.bytes
                if not cand.link_source:
                    copies += cand.flash_bytes
            if cand.action == "replace":
                old = int(state.get("size", "0"))
                self.rollback_total += old
                # The replaced original's flash comes back after the rename;
                # assume it compressed like its replacement.
                self.flash_released += cand.flash_bytes * old // max(cand.bytes, 1)
            kv(
                f"destination dest={cand.dest} exists={1 if state.get('kind') == 'regular' else 0} "
                f"action={cand.action} bytes={cand.bytes} mode={cand.mode}"
                + (f" link={cand.link_source}" if cand.link_source else "")
            )
        # Staged candidates already occupy RAM; rollback copies are added next.
        self.ram_required_bytes = self.rollback_total + RAM_MARGIN_BYTES
        # Phase 1 writes every new copy before any original goes, after the
        # handoff backup: text the installer hasn't read, assumed to halve.
        handoff = self.handoff_estimate // 2 + 1024 if self.active_candidates() else 0
        self.flash_written = copies + handoff
        self.flash_required = self.flash_written + (flash_margin(copies) if copies else 0)

    def flash_after(self) -> int:
        """Estimated free flash once the install (and any opted-in cleanup) is done."""
        credit = self.leftover_credit() if self.args.remove_root_tool_leftovers else 0
        return max(0, (self.flash_avail or 0) + credit - self.flash_written + self.flash_released)

    def flash_shortfall(self, credit: int = 0) -> int:
        """Bytes of flash missing for phase 1; 0 when enough or not measured."""
        if self.flash_avail is None:
            return 0
        return max(0, self.flash_required - self.flash_avail - credit)

    def update_flash_need(self) -> int:
        """Flash a later codex_webui update needs while both copies exist."""
        webui = next(c for c in self.candidates if c.dest == WEBUI_DEST)
        return webui.flash_bytes + flash_margin(webui.flash_bytes)

    def count_backup_generations(self) -> None:
        cmd = (
            "for d in /data/codex-backups /data/codex/resource-backups /data/codex/update-backups; do "
            '[ -d "$d" ] || continue; for n in "$d"/*; do [ -e "$n" ] && echo "$n"; done; done'
        )
        out = self.run_remote(cmd, timeout=30, quiet=True)
        stamp_re = re.compile(r"^\d{8}-\d{6}$")
        for line in out.splitlines():
            path = line.strip()
            name = path.rsplit("/", 1)[-1]
            if name.startswith("webui-handoff-") and stamp_re.match(name[len("webui-handoff-"):]):
                self.generations["handoff"] += 1
                if path == f"{HANDOFF_ROOT}/{name}":
                    self.handoff_dirs.append(path)
            elif name.startswith("settings_") and re.match(r"^\d{8}_\d{6}$", name[len("settings_"):]):
                self.generations["settings"] += 1
            elif re.match(r"^\d{8}_\d{6}$", name):
                self.generations["resource"] += 1
            elif name.isdigit():
                self.generations["update"] += 1

    def compute_handoff_estimate(self) -> None:
        self.handoff_estimate = sum(
            int(state.get("size", "0"))
            for path, state in self.probe.items()
            if path in HANDOFF_REQUIRED_PATHS and state.get("kind") == "regular"
        )

    def decide_verdict(self) -> None:
        if self.verdict == VERDICT_CONFIG_UNCERTAIN:
            return
        credit = self.leftover_credit() if self.args.remove_root_tool_leftovers else 0
        if self.ram_free_bytes < self.ram_required_bytes:
            self.verdict = VERDICT_ROLLBACK_CAPACITY
            self.verdict_reasons.append(
                f"free RAM {self.ram_free_bytes} < rollback copies + margin {self.ram_required_bytes}"
            )
        elif self.flash_shortfall(credit) and not self.args.skip_flash_check:
            self.verdict = VERDICT_CAPACITY
            self.capacity_stage = "preflight"
            self.verdict_reasons.append(
                f"free flash {self.flash_avail} < estimated need {self.flash_required}"
                + (f" (after about {credit} freed from root-tool leftovers)" if credit else "")
            )
        else:
            self.verdict = VERDICT_ALLOWED

    # -------------------------------------------------------------- report

    def render_preflight_report(self) -> None:
        # NOTE(InstallerCliUX): human-facing step/info strings in this method
        # are owned by InstallerCliUX; key=value lines are the stable contract.
        step("Preflight report")
        info(
            "Status so far uses private volatile staging under "
            "/var/volatile/codex-install-* only."
        )
        info(
            "No persistent hub paths have been written, pruned, handed off, "
            "installed, or restarted yet."
        )
        if self.args.preflight_only:
            info(
                "Mode: --preflight-only — stages, verifies, compares, and "
                "prints a terminal verdict; performs no persistent writes "
                "and no service actions."
            )
        if self.first_install:
            info(
                "Install mode: first install — the hub has no configuration "
                "of ours yet, so configuration candidates are written."
            )
        elif self.args.clean_install:
            info(
                "Install mode: explicit clean install — configuration "
                "candidates are regenerated."
            )
        else:
            info(
                "Install mode: default upgrade — existing configuration is "
                "preserved unless a candidate explicitly replaces it."
            )
        kv(f"preflight_mode={'clean' if self.args.clean_install else 'upgrade'}")
        kv(f"multi_remote={'force-off' if self.args.multi_remote_force else self.args.multi_remote or 'unchanged'}")
        if self.args.multi_remote == "on":
            info(
                f"Multiple remotes of one model: {HAL_MULTI_DEST} is the hub's own hal "
                f"(md5 {HAL_STOCK_MD5}) with per-slot remote threads and the one-remote-per-model "
                "rule lifted for remotes without a screen; rcS.local runs it from the next boot."
            )
        kv(f"two_screen={self.args.two_screen or 'unchanged'}")
        if self.args.two_screen in TWO_SCREEN_SETTINGS:
            info(
                f"Two remotes with a screen: {HAL_REMOTES_DEST} is the hub's own hal "
                f"(md5 {HAL_STOCK_MD5}) with the link to screen remotes kept per radio slot "
                f"(md5 {HAL_REMOTES_MD5}); rcS.local runs it from the next boot"
                + (", for that boot only." if self.args.two_screen.endswith("once") else ".")
            )
        kv(f"candidate_count={len(self.candidates)}")
        kv(f"changed_count={len(self.active_candidates())}")
        info(
            "Candidate destinations and nonsensitive expected MD5 hashes "
            "(sensitive values redacted):"
        )
        for index, cand in enumerate(self.candidates):
            shown = "<hidden>" if cand.sensitive else cand.md5
            kv(
                f"candidate index={index} dest={cand.dest} bytes={cand.bytes} md5={shown} "
                f"mode={cand.mode} kind={cand.kind} action={cand.action} flash={cand.flash_bytes}"
            )
            info(
                f"candidate[{index}] path={cand.dest} expected_md5={shown} "
                f"bytes={cand.bytes} mode={cand.mode} action={cand.action}"
            )
        if not self.args.clean_install:
            kv(f"protected_upgrade_paths={','.join(UPGRADE_PROTECTED_PATHS)}")
            info(
                "Upgrade protects existing configuration at: "
                + ", ".join(UPGRADE_PROTECTED_PATHS)
            )
        kv(
            f"backup_generations handoff={self.generations['handoff']} "
            f"resource={self.generations['resource']} settings={self.generations['settings']} "
            f"update={self.generations['update']}"
        )
        kv(f"handoff_estimate_bytes={self.handoff_estimate}")
        kv(f"flash_capacity_check={'two-phase-commit' if self.flash_avail is None else 'measured'}")
        kv(f"forward_total_bytes={self.forward_total}")
        kv(f"rollback_total_bytes={self.rollback_total}")
        kv(f"staged_total_bytes={self.staged_total}")
        kv(f"ram_free_bytes={self.ram_free_bytes}")
        kv(f"ram_required_bytes={self.ram_required_bytes}")
        kv(f"flash_required_bytes={self.flash_required}")
        if self.flash_avail is not None:
            kv(f"flash_total_bytes={self.flash_total}")
            kv(f"flash_free_bytes={self.flash_avail}")
            kv(f"flash_after_bytes={self.flash_after()}")
        self.render_flash_report()
        info(
            f"RAM: free={self.ram_free_bytes} required={self.ram_required_bytes} "
            f"(rollback copies {self.rollback_total} + margin {RAM_MARGIN_BYTES})"
        )
        for reason in self.verdict_reasons:
            kv(f"verdict_reason={reason}")
            info(f"verdict_reason: {reason}")
        self.render_verdict()

    def render_flash_report(self) -> None:
        # NOTE(InstallerCliUX): human-facing prose; the key=value lines are
        # the stable contract.
        if self.flash_avail is None:
            info(
                f"Free flash couldn't be measured ({self.flash_note}): changed files "
                f"(about {kib(self.flash_written)} on flash) are written as {NEW_SUFFIX} copies "
                "first, and the install stops with no live changes if flash fills up."
            )
        else:
            info(
                f"Flash: {kib(self.flash_avail)} free of {kib(self.flash_total)}. The changed files "
                f"need about {kib(self.flash_required)} while old and new copies both exist "
                "(an estimate with a safety margin)."
            )
            if self.flash_shortfall() and self.args.skip_flash_check:
                info("--skip-flash-check: installing anyway; the install stops with no live changes if flash fills up.")
            after = self.flash_after()
            info(f"About {kib(after)} will be free afterwards.")
            if after < self.update_flash_need():
                info(
                    f"That is less than the {kib(self.update_flash_need())} a later web UI update "
                    "needs. Free some space before updating (see the README)."
                )
        for cand in self.active_candidates():
            if cand.link_source:
                kv(f"flash_link dest={cand.dest} source={cand.link_source}")
                info(
                    f"{cand.dest}: harmony-hub-root's copy of the same Dropbear at {cand.link_source} is reused "
                    "as a hard link, so it takes no extra flash."
                )
        leftovers = [(str(s["path"]), int(s["bytes"]), int(s["files"])) for s in self.root_tool_stages]
        if self.root_tool_dropbear_removable():
            leftovers.append((ROOT_TOOL_DROPBEAR, int(self.probe[ROOT_TOOL_DROPBEAR]["size"]), 1))
        for path, size, files in leftovers:
            kv(f"root_tool_leftover bytes={size} files={files} path={path}")
            what = "a second copy of Dropbear that SSH no longer uses" if path == ROOT_TOOL_DROPBEAR else "staging files"
            info(f"harmony-hub-root left {path} behind: {what}, {kib(size)} in {files} file(s).")
        if leftovers:
            if self.args.remove_root_tool_leftovers and not self.args.preflight_only:
                info("They are removed before the install (--remove-root-tool-leftovers).")
            else:
                info("Run the installer with --remove-root-tool-leftovers to remove them and free that flash.")

    def render_verdict(self) -> None:
        # NOTE(InstallerCliUX): human-facing verdict prose is owned by
        # InstallerCliUX; the verdict= key=value line is the stable contract.
        kv(f"verdict={self.verdict}")
        info(f"Terminal verdict: {self.verdict}")
        if self.verdict == VERDICT_ALLOWED:
            info("ALLOWED — validation and RAM headroom are sufficient for the selected mode.")
            if self.args.preflight_only:
                info(
                    "Preflight-only complete: volatile staging will be removed; "
                    "no persistent changes or service actions were performed."
                )
            else:
                info(
                    "Persistent install may proceed after this report "
                    f"({NEW_SUFFIX} copies, then same-directory renames)."
                )
        elif self.verdict == VERDICT_CAPACITY and self.capacity_stage == "preflight":
            info(
                f"BLOCKED_CAPACITY — not enough free flash: about {kib(self.flash_required)} needed, "
                f"{kib(self.flash_avail or 0)} free. Nothing was installed."
            )
            if (self.root_tool_stages or self.root_tool_dropbear_removable()) and not self.args.remove_root_tool_leftovers:
                info(
                    f"Removing harmony-hub-root's leftovers (--remove-root-tool-leftovers) frees about "
                    f"{kib(self.leftover_credit())}."
                )
            info(
                "Otherwise free space on the hub, or pass --skip-flash-check to try anyway: "
                "the install still stops with no live changes if flash fills up."
            )
        elif self.verdict == VERDICT_CAPACITY:
            info(
                "BLOCKED_CAPACITY — flash filled up while writing the new copies; "
                "they were removed and no live file changed."
            )
        elif self.verdict == VERDICT_ROLLBACK_CAPACITY:
            info(
                "BLOCKED_ROLLBACK_CAPACITY — not enough free RAM to hold rollback "
                "copies of the files being replaced. No persistent changes."
            )
        elif self.verdict == VERDICT_CONFIG_UNCERTAIN:
            info(
                "BLOCKED_CONFIGURATION_UNCERTAINTY — required configuration "
                "state is missing or ambiguous for default upgrade; pass "
                "--hub-id or use --clean-install. No persistent changes."
            )
        else:
            info(
                "BLOCKED_VALIDATION_FAILURE — staging, path, hash, or probe "
                "validation failed; see verdict_reason lines above. "
                "No persistent changes."
            )

    # -------------------------------------------------------------- mutate

    def stage_rollback_copies(self) -> None:
        step("Preparing volatile rollback copies")
        # Build rollback records in candidate install order (replaces and
        # creates interleaved) so reversed() rollback is true reverse order.
        for index, cand in enumerate(self.candidates):
            if cand.action == "replace":
                state = self.probe[cand.dest]
                rb = f"{self.stage}/rb-{index:02d}-{cand.dest.rsplit('/', 1)[-1]}"
                cmd = (
                    f"cp -p {remote_quote(cand.dest)} {remote_quote(rb)} && "
                    f"chmod 600 {remote_quote(rb)} && "
                    f"md5sum {remote_quote(rb)}"
                )
                out = self.run_remote(cmd, timeout=90, quiet=True)
                match = MD5_LINE_RE.match(out.strip().splitlines()[-1])
                if not match or match.group(1) != state.get("md5"):
                    raise RuntimeError(f"rollback copy verification failed for {cand.dest}")
                self.changed.append(
                    {
                        "dest": cand.dest,
                        "mode": state.get("mode", cand.mode),
                        "md5": state.get("md5", ""),
                        "rb": rb,
                        "was_absent": False,
                        "done": False,
                    }
                )
                shown = "<hidden>" if cand.sensitive else state.get("md5")
                info(f"rollback copy ready dest={cand.dest} mode={state.get('mode')} md5={shown}")
            elif cand.action == "create":
                self.changed.append(
                    {
                        "dest": cand.dest,
                        "mode": cand.mode,
                        "md5": "",
                        "rb": "",
                        "was_absent": True,
                        "done": False,
                    }
                )

    def prune_handoffs(self) -> None:
        """Keep only the newest HANDOFF_KEEP installer handoff generations.

        Only installer-owned webui-handoff-<stamp> directories directly under
        HANDOFF_ROOT are ever removed; other backups are never touched.
        """
        step(f"Pruning installer handoff backups (keeping newest {HANDOFF_KEEP})")
        old = sorted(self.handoff_dirs)[: max(0, len(self.handoff_dirs) - HANDOFF_KEEP)]
        for path in old:
            if not re.match(rf"^{re.escape(HANDOFF_ROOT)}/webui-handoff-\d{{8}}-\d{{6}}$", path):
                raise RuntimeError(f"refusing to prune unexpected path {path!r}")
            code, _out, err = self.run_remote_rc(f"rm -rf {remote_quote(path)}", timeout=60)
            if code != 0:
                info(f"warning: could not prune {path}: {err.strip()}")
            else:
                kv(f"pruned={path}")
        if not old:
            info("nothing to prune")

    def create_handoff(self) -> None:
        step("Creating bounded handoff backup")
        sized: list[tuple[str, int]] = []
        for path in HANDOFF_REQUIRED_PATHS:
            state = self.probe.get(path, {})
            if state.get("kind") == "regular":
                sized.append((path, int(state.get("size", "0"))))
        cmd = (
            "S=$(date -u +%Y%m%d-%H%M%S); "
            f"B={HANDOFF_ROOT}; "
            'I="$B/.incomplete-webui-handoff-$S"; '
            'mkdir -p "$B" || exit 1; '
            'mkdir "$I" || exit 1; '
            "tot=0; "
        )
        for path, size in sized:
            cmd += (
                f"sz={size}; "
                f"if [ $((tot + sz)) -le {HANDOFF_BUDGET_BYTES} ]; then "
                f"n=$(echo {remote_quote(path)} | sed 's#/#_#g'); "
                f'cp -p {remote_quote(path)} "$I/$n" || {{ rm -rf "$I"; exit 1; }}; '
                "tot=$((tot + sz)); "
                f'else echo "handoff_skipped={path}"; fi; '
            )
        cmd += (
            'mv "$I" "$B/webui-handoff-$S" || { rm -rf "$I"; exit 1; }; '
            'echo "handoff=$B/webui-handoff-$S"'
        )
        out = self.run_remote(cmd, timeout=120)
        for line in out.strip().splitlines():
            info(line)
        created = [line[len("handoff="):] for line in out.strip().splitlines() if line.startswith("handoff=")]
        if not created:
            raise RuntimeError("handoff directory rename did not complete")
        self.handoff_dirs.append(created[-1])

    def remove_root_tool_leftovers(self) -> None:
        """Delete harmony-hub-root's staging folders and, while SSH runs ours,
        its spare Dropbear. Opted in with --remove-root-tool-leftovers; not
        rolled back, since nothing reads them."""
        step("Removing harmony-hub-root leftovers")
        for stage in self.root_tool_stages:
            path = str(stage["path"])
            if not ROOT_TOOL_STAGE_RE.match(path):
                raise RuntimeError(f"refusing to remove unexpected path {path!r}")
            code, _out, err = self.run_remote_rc(f"rm -rf {remote_quote(path)}", timeout=120)
            if code != 0:
                info(f"warning: could not remove {path}: {err.strip()}")
            else:
                kv(f"removed_leftover={path}")
        if self.root_tool_dropbear_removable():
            code, out, _err = self.run_remote_rc(ROOT_TOOL_DROPBEAR_REMOVE, timeout=30)
            if code == 0 and out.strip() == "removed":
                kv(f"removed_leftover={ROOT_TOOL_DROPBEAR}")
            else:
                info(f"kept {ROOT_TOOL_DROPBEAR}: SSH doesn't run the installed Dropbear yet")
        self.scan_root_tool_leftovers()
        self.measure_flash()
        if self.flash_avail is not None:
            kv(f"flash_free_after_cleanup_bytes={self.flash_avail}")
            info(f"Flash free after removing them: {kib(self.flash_avail)}.")

    def report_flash_after_install(self) -> None:
        self.measure_flash()
        if self.flash_avail is None:
            return
        kv(f"flash_free_after_bytes={self.flash_avail}")
        info(f"Flash free after the install: {kib(self.flash_avail)}.")
        if self.flash_avail < self.update_flash_need():
            info(
                f"A later web UI update needs about {kib(self.update_flash_need())}. "
                "Free some space before updating (see the README)."
            )

    def remove_new_copies(self) -> list[str]:
        """Remove every <dest>.codex-new this run wrote; return those that failed."""
        failed = []
        for path in self.new_copies:
            code, _out, _err = self.run_remote_rc(f"rm -f {remote_quote(path)}", timeout=30)
            if code != 0:
                failed.append(path)
        self.new_copies = []
        return failed

    def link_new_copy(self, cand: Candidate, new: str) -> bool:
        """Hard-link an identical (or equivalent) file already on the hub as <dest>.codex-new."""
        code, out, err = self.run_remote_rc(
            f"ln {remote_quote(cand.link_source)} {remote_quote(new)} && "
            f"chmod {remote_quote(cand.mode)} {remote_quote(new)} && "
            f"md5sum {remote_quote(new)}",
            timeout=60,
        )
        lines = out.strip().splitlines()
        match = MD5_LINE_RE.match(lines[-1]) if code == 0 and lines else None
        if match and match.group(1) == cand.link_md5:
            info(f"linked dest={new} to {cand.link_source} (no extra flash)")
            cand.linked = True
            return True
        self.run_remote_rc(f"rm -f {remote_quote(new)}", timeout=30)
        info(f"could not link {cand.link_source} ({err.strip() or 'verification failed'}); copying instead")
        return False

    def write_new_copies(self) -> None:
        """Phase 1: write and verify <dest>.codex-new next to every changed dest."""
        step(f"Phase 1: writing verified {NEW_SUFFIX} copies (no live file changes)")
        for cand in self.active_candidates():
            new = cand.dest + NEW_SUFFIX
            self.new_copies.append(new)
            if cand.link_source and self.link_new_copy(cand, new):
                continue
            cmd = (
                f"cp {remote_quote(f'{self.stage}/{cand.staged_name}')} {remote_quote(new)} && "
                f"chmod {remote_quote(cand.mode)} {remote_quote(new)} && "
                f"md5sum {remote_quote(new)}"
            )
            code, out, err = self.run_remote_rc(cmd, timeout=180)
            lines = out.strip().splitlines()
            match = MD5_LINE_RE.match(lines[-1]) if code == 0 and lines else None
            if not match or match.group(1) != cand.md5:
                left = self.remove_new_copies()
                reason = err.strip() or "copy verification failed"
                if left:
                    raise InstallFailure(
                        f"could not write {new} ({reason}) and could not remove {left}"
                    )
                raise CapacityAbort(f"could not write {new}: {reason}")
            info(f"staged dest={new} bytes={cand.bytes}")

    def install_sequence(self) -> None:
        """Phase 2: rename each verified copy over its destination, codex_webui last."""
        step("Phase 2: renaming new copies into place (codex_webui last)")
        for cand in self.active_candidates():
            new = cand.dest + NEW_SUFFIX
            code, _out, err = self.run_remote_rc(
                f"mv -f {remote_quote(new)} {remote_quote(cand.dest)}", timeout=60
            )
            if code != 0:
                raise InstallFailure(f"rename failed for {cand.dest}: {err.strip()}")
            self.new_copies.remove(new)
            for item in self.changed:
                if item["dest"] == cand.dest:
                    item["done"] = True
            info(f"installed dest={cand.dest} mode={cand.mode} bytes={cand.link_bytes if cand.linked else cand.bytes}")

    def verify_installed(self) -> None:
        step("Verifying installed bytes, hashes, and modes")
        active = self.active_candidates()
        states = self.file_status([c.dest for c in active])
        for cand in active:
            state = states[cand.dest]
            # A linked Dropbear is the root tool's copy, which may be the other build.
            want_bytes, want_md5 = (cand.link_bytes, cand.link_md5) if cand.linked else (cand.bytes, cand.md5)
            if state["kind"] != "regular":
                raise InstallFailure(f"post-install verification failed for {cand.dest}: kind={state['kind']}")
            if int(state["size"], 10) != want_bytes:
                raise InstallFailure(
                    f"post-install byte mismatch for {cand.dest}: "
                    f"expected {want_bytes} got {state['size']}"
                )
            if state["md5"] != want_md5:
                raise InstallFailure(f"post-install checksum mismatch for {cand.dest}")
            if state["mode"] != cand.mode:
                raise InstallFailure(
                    f"post-install mode mismatch for {cand.dest}: "
                    f"expected {cand.mode} got {state['mode']}"
                )
        info("installed candidates verified")

    def rollback_changes(self, trigger: str) -> None:
        step("Rolling back changed paths")
        info(f"trigger: {trigger}")
        incomplete = False
        for path in self.remove_new_copies():
            incomplete = True
            info(f"ROLLBACK FAILED could not remove leftover {path}")
        done_items = [item for item in self.changed if item["done"]]
        for item in reversed(done_items):
            dest = str(item["dest"])
            if item["was_absent"]:
                code, out, _err = self.run_remote_rc(f"rm -f {remote_quote(dest)}", timeout=30)
                if code != 0:
                    incomplete = True
                    info(f"ROLLBACK FAILED remove new path {dest}: {out.strip()}")
                    continue
                info(f"removed new path {dest} (original absence recorded)")
                continue
            tmp = dest + RESTORE_SUFFIX
            code, out, err = self.run_remote_rc(
                f"cp {remote_quote(str(item['rb']))} {remote_quote(tmp)} && "
                f"chmod {remote_quote(str(item['mode']))} {remote_quote(tmp)} && "
                f"mv -f {remote_quote(tmp)} {remote_quote(dest)}",
                timeout=180,
            )
            if code != 0:
                incomplete = True
                self.run_remote_rc(f"rm -f {remote_quote(tmp)}", timeout=30)
                info(f"ROLLBACK FAILED restore {dest}: {(err or out).strip()}")
                continue
            info(f"restored {dest} mode={item['mode']}")
        # verify rollback
        for item in done_items:
            dest = str(item["dest"])
            if item["was_absent"]:
                code, _out, _err = self.run_remote_rc(f"test ! -e {remote_quote(dest)}", timeout=30)
                if code != 0:
                    incomplete = True
                    info(f"ROLLBACK VERIFY FAILED path still present: {dest}")
                continue
            if self.remote_md5(dest) != item["md5"]:
                incomplete = True
                info(f"ROLLBACK VERIFY FAILED md5 for {dest}")
        if incomplete:
            self.preserve_stage = True
            raise RuntimeError(
                f"rollback incomplete; staged tree preserved for manual recovery at {self.stage}. "
                "Do NOT reboot (it is in RAM); inspect the staged rollback copies and restore manually."
            )
        info("rollback verified: all changed paths restored")
        self.cleanup_stage()

    def cleanup_stage(self) -> None:
        if not self.stage or self.preserve_stage:
            return
        step("Cleaning owned staging tree")
        code, out, _err = self.run_remote_rc(
            f"rm -rf {remote_quote(self.stage)}", timeout=60
        )
        if code != 0:
            info(f"warning: could not remove staging tree {self.stage}: {out.strip()}")
        else:
            kv(f"staging_removed={self.stage}")
            self.stage = ""

    # -------------------------------------------------------------- finish

    def post_install_wiring(self) -> None:
        step("Post-install wiring")
        bin_names = bin_manifest_names()
        bin_chmod = " ".join(f"/data/codex/bin/{n}" for n in bin_names)
        post = (
            "mkdir -p /data/codex/bin /data/codex/modules/usb-net /etc/dropbear /home/root/.ssh /data/codexmqtt /pkg/codexactivity /pkg/codexmqtt; "
            "ln -sf dropbearmulti /data/codex/bin/dropbear; "
            "ln -sf dropbearmulti /data/codex/bin/dropbearkey; "
            f"chmod 755 {bin_chmod} /data/codex/init.sh /data/codex/offline_egress_guard.sh "
            "/data/codex/recovery_ap.sh /data/codex/androidtv_service.sh /data/codex/usb_eth_service.sh /usr/sbin/dropbear "
            "/usr/sbin/dropbearkey /etc/init.d/rcS.local; "
            "chmod 644 /data/codex/modules/usb-net/r8152.ko /data/codex/modules/usb-net/usbnet.ko /data/codex/modules/usb-net/asix.ko /data/codex/modules/usb-net/cdc_ether.ko /data/codex/modules/usb-net/cdc_ncm.ko /data/codex/modules/usb-net/ax88179_178a.ko /data/codex/modules/usb-net/README.md 2>/dev/null || true; "
            "chmod 600 /data/codexmqtt/config.json 2>/dev/null || true; "
            "/bin/busybox sync 2>/dev/null || true"
        )
        self.run_remote(post, timeout=60, quiet=True)

    def probe_hal_bound(self) -> bool:
        out = self.run_remote(hal_bound_command(), timeout=30, quiet=True).strip()
        if out not in ("bound", "stock"):
            raise RuntimeError(f"couldn't tell whether the multi-remote hal runs: {out!r}")
        return out == "bound"

    def two_screen_wanted(self) -> str | None:
        """"on" for any of the settings that run the two-screen hal."""
        return "on" if self.args.two_screen in TWO_SCREEN_SETTINGS else self.args.two_screen

    def probe_running_hal(self) -> tuple[str, dict[str, str]]:
        out = self.run_remote(running_hal_command(), timeout=60, quiet=True)
        lines = out.splitlines()
        digest = lines[0].split()[0] if lines and lines[0].split() else ""
        facts = dict(line.split("=", 1) for line in lines if "=" in line and " " not in line.split("=", 1)[0])
        if len(digest) != 32 or "gates" not in facts:
            raise RuntimeError(f"couldn't tell which hal runs: {out!r}")
        return digest, facts

    def check_two_screen(self) -> None:
        """--two-screen, or --multi-remote on a hub that runs the two-screen
        hal: record which hal runs (self.running_hal decides the reboot as much
        as the files do), and refuse the two cases that would leave
        multi-remote switched on with no hal copy to carry it."""
        if not (self.args.two_screen or self.args.multi_remote):
            return
        self.running_hal, self.running_hal_facts = self.probe_running_hal()
        active = self.running_hal == HAL_REMOTES_MD5
        if self.args.two_screen:
            kv(f"two_screen_active={'yes' if active else 'no'}")
            kv(f"two_screen_gates={self.running_hal_facts.get('gates') or 'none'}")
        multi_after = (
            self.args.multi_remote == "on"
            if self.args.multi_remote
            else self.running_hal_facts.get("multi") == "1"
        )
        no_multi_copy = self.running_hal_facts.get("multi_copy") != "yes"
        if active and self.args.multi_remote == "on" and no_multi_copy and self.args.two_screen == "off":
            raise RuntimeError(
                "--multi-remote on with --two-screen off refused: the multi-remote copy can only be built "
                "from the stock hal, and the two-screen hal is running. Turn two-screen off first, then run "
                "--multi-remote on."
            )
        if self.args.two_screen == "off" and multi_after and no_multi_copy:
            raise RuntimeError(
                "--two-screen off refused: multi-remote is on and only the two-screen hal carries it "
                f"({HAL_MULTI_DEST} is missing), so the hub would restart into the stock hal with two "
                "remotes of one model allowed to be paired. Turn multi-remote off as well "
                "(--multi-remote off --two-screen off), then turn it back on by itself."
            )
        if self.args.two_screen == "off":
            info(
                "Remotes with a screen that are paired stay paired. The stock hal serves one of them at a "
                "time, so unpair all but one in Settings -> Remotes."
            )

    def check_multi_remote_off(self) -> None:
        """--multi-remote off while the multi-remote hal runs: refuse unless the
        slot table holds no two remotes of one model (see MULTI_REMOTE_PENDING).
        Also records whether the copy runs now (self.hal_bound), which decides
        the reboot as much as the files do: a setting saved without one (or a
        copy rcS.local didn't bind) leaves the files right and the hal wrong."""
        if self.args.multi_remote == "on":
            self.hal_bound = self.probe_hal_bound()
            kv(f"multi_remote_active={'yes' if self.hal_bound else 'no'}")
        if self.args.multi_remote != "off":
            return
        if self.args.multi_remote_force:
            # force-off: for a radio that stopped answering, check nothing that
            # needs hal. The guard is best effort; the reboot follows at once.
            self.hal_bound = self.probe_hal_bound()
            kv(f"multi_remote_active={'yes' if self.hal_bound else 'no'}")
            if self.hal_bound and self.args.no_apply_cloud_restart:
                raise RuntimeError(
                    "--multi-remote force-off refused: the multi-remote hal is running, and "
                    "--no-apply-cloud-restart would keep it running; leave out --no-apply-cloud-restart"
                )
            if self.hal_bound and not self.args.preflight_only:
                self.run_remote(f"touch {MULTI_REMOTE_PENDING} 2>/dev/null; true", timeout=30, quiet=True)
            kv("multi_remote_off_check=forced")
            info(
                "WARNING: force-off skips the radio check: if two remotes of one model are still paired, the stock hal "
                "hangs on them too. Turn it back on (--multi-remote on), unpair the extra remote, then turn it off."
            )
            return
        # Without the reboot the multi-remote hal keeps running on setting 0, and
        # once the guard lapses a pair could add a duplicate that the stock hal
        # hangs on at the next boot: refuse that before writing anything.
        no_restart = self.args.no_apply_cloud_restart
        guard = not self.args.preflight_only and not no_restart
        out = self.run_remote(multi_remote_off_check_command(guard), timeout=60, quiet=True).strip()
        self.hal_bound = out != "inactive"
        if out == "inactive":
            kv("multi_remote_off_check=inactive")
            return
        problem = ""
        if no_restart:
            problem = (
                "the multi-remote hal is running, and --no-apply-cloud-restart would keep it running after the "
                "setting is saved, with nothing to stop a second remote of one model being paired before the "
                "stock hal starts; leave out --no-apply-cloud-restart so the hub restarts"
            )
        elif out == "guard-failed":
            problem = f"the hub couldn't write {MULTI_REMOTE_PENDING}, which blocks new pairings until it restarts"
        elif out == "pairing":
            problem = "a pairing window is open on the hub; try again when it closes"
        else:
            dups = rf_duplicate_models(out)
            if dups is None:
                problem = "the hub's radio didn't list its paired remotes"
            elif dups:
                problem = (
                    f"more than one remote of the same model is paired (EquadID {dups}); the stock hal "
                    "can't run two of one model, so unpair the extra ones first (Settings → Remotes)"
                )
        if problem:
            if guard:
                self.run_remote(f"rm -f {MULTI_REMOTE_PENDING}", timeout=30, quiet=True)
            raise RuntimeError(f"--multi-remote off refused: {problem}")
        kv("multi_remote_off_check=ok")

    def start_services(self) -> None:
        start = (
            "killall codex_webui 2>/dev/null || true; killall codex_bthid_keyboard 2>/dev/null || true; "
            "if ! ps | grep '[o]ffline_egress_guard.sh monitor' >/dev/null 2>&1; then "
            "/data/codex/offline_egress_guard.sh monitor >> /cache/codex-init.log 2>&1 & fi; "
            "if ! ps | grep '[d]ropbear' >/dev/null 2>&1; then /usr/sbin/dropbear -R -p 22; fi; "
            "mkdir -p /cache/bin; ln -sf /data/codex/bin/codex_bthid_keyboard /cache/bin/bthid_keyboard; "
            "/data/codex/bin/codex_webui 8080 >> /cache/codex-init.log 2>&1 & "
            "/data/codex/bin/codex_bthid_keyboard >> /cache/codex-init.log 2>&1 & "
            # codex_androidtv: kill the running copy; its service loop starts the new one.
            "killall codex_androidtv 2>/dev/null || true; "
            "if [ -x /data/codex/androidtv_service.sh ]; then /data/codex/androidtv_service.sh >/dev/null 2>&1 & fi; "
            "sleep 1; "
            f"/data/codex/bin/codex_hbus {remote_quote(self.hub_id)} harmony.automation?discover "
            f"{remote_quote('{\"gatewayType\":\"codexactivity\"}')} >> /cache/codex-init.log 2>&1 || true; "
            f"/data/codex/bin/codex_hbus {remote_quote(self.hub_id)} harmony.automation?discover "
            f"{remote_quote('{\"gatewayType\":\"codexmqtt\"}')} >> /cache/codex-init.log 2>&1 || true; "
            "ps | grep '[c]odex_webui' || true; ps | grep '[c]odex_bthid_keyboard' || true; ps | grep '[d]ropbear' || true; "
            "ps | grep '[a]tv_service.sh' || true"
        )
        print(self.run_remote(start, timeout=90).strip())

    def ensure_parent_dirs(self) -> None:
        dirs = sorted({c.dest.rsplit("/", 1)[0] for c in self.active_candidates()})
        cmd = "mkdir -p " + " ".join(remote_quote(d) for d in dirs)
        self.run_remote(cmd, timeout=30, quiet=True)

    def cloud_blocker_changed(self) -> bool:
        cloud = {"/opt/luaworks/tasks/connectserver/netservicestarter.lua", "/data/codex/cloud_blocker.conf"}
        return any(c.dest in cloud for c in self.active_candidates())

    def multi_remote_changed(self) -> bool:
        # hal starts once at boot (rcS), so only a reboot swaps it: needed when
        # the files change, or when the running hal isn't the one asked for.
        files = any(c.dest in (HAL_MULTI_DEST, MULTI_REMOTE_CONF) for c in self.active_candidates())
        if self.args.multi_remote not in ("on", "off") or self.hal_bound is None:
            return files
        return files or self.hal_bound != (self.args.multi_remote == "on")

    def two_screen_changed(self) -> bool:
        # As multi_remote_changed(): the files, or a running hal that isn't the one asked for.
        files = any(c.dest in (HAL_REMOTES_DEST, TWO_SCREEN_CONF) for c in self.active_candidates())
        if not self.args.two_screen or self.running_hal is None:
            return files
        return files or (self.running_hal == HAL_REMOTES_MD5) != (self.two_screen_wanted() == "on")

    def hal_setting_changed(self) -> bool:
        return self.multi_remote_changed() or self.two_screen_changed()

    def wanted_hal(self) -> str:
        if self.two_screen_wanted() == "on":
            return "two-screen"
        if self.args.two_screen == "off" and self.running_hal_facts.get("multi") == "1" and not self.args.multi_remote:
            return "multi-remote"
        return "multi-remote" if self.args.multi_remote == "on" else "stock"

    def check_two_screen_loads(self) -> None:
        """Before a reboot into the two-screen hal: the copy must start on this
        hub. If it doesn't, the setting goes back to 0 and the hub stays up."""
        if self.two_screen_wanted() != "on":
            return
        out = self.run_remote(hal_load_check_command(), timeout=60, quiet=True)
        if "Usage:" in out and "rc=1" in out.split():
            kv("two_screen_load_check=ok")
            return
        kv("two_screen_load_check=failed")
        self.run_remote(f"echo 0 > {TWO_SCREEN_CONF}", timeout=30, quiet=True)
        raise RuntimeError(
            f"the hub could not start {HAL_REMOTES_DEST} ({' '.join(out.split())[:200]!r}); "
            f"{TWO_SCREEN_CONF} was put back to 0 and the hub was not restarted"
        )

    def reboot_and_wait(self) -> None:
        self.check_two_screen_loads()
        self.run_remote("(/bin/sleep 2; /sbin/reboot || reboot) >/dev/null 2>&1 & echo rebooting", timeout=30, quiet=True)
        time.sleep(8)
        wait_for_port(self.args.hub_host, self.args.port, 180, "SSH")
        wait_for_port(self.args.hub_host, 8080, 180, "Web UI")
        if self.args.two_screen:
            self.verify_two_screen_after_reboot()
        else:
            self.verify_multi_remote_after_reboot()

    def verify_two_screen_after_reboot(self) -> None:
        want = self.two_screen_wanted() == "on"
        digest, facts = self.probe_running_hal()
        active = digest == HAL_REMOTES_MD5
        gates = facts.get("gates", "")
        kv(f"two_screen_active={'yes' if active else 'no'}")
        kv(f"two_screen_gates={gates or 'none'}")
        serial = "1" if self.args.two_screen.startswith("serial") else "0"
        if active != want or (want and (gates[:1] != "1" or gates[2:3] != serial)):
            info(
                "WARNING: the hub restarted but "
                + (f"runs the two-screen hal with gates {gates or 'none'}" if active else "does not run the two-screen hal")
                + "; see /cache/codex-init.log on the hub"
            )

    def verify_multi_remote_after_reboot(self) -> None:
        if self.args.multi_remote not in ("on", "off"):
            return
        want = self.args.multi_remote == "on"
        bound = self.probe_hal_bound()
        kv(f"multi_remote_active={'yes' if bound else 'no'}")
        if bound != want:
            info(
                "WARNING: the hub restarted but still runs the " + ("stock" if want else "multi-remote")
                + " hal; see /cache/codex-init.log on the hub"
            )

    def plugins_changed(self) -> bool:
        # The engine loads /pkg plugins once at start; only a reboot restarts it.
        return any(c.kind == "plugin" for c in self.active_candidates())

    # ------------------------------------------------------- turn off / on

    def check_not_turned_off(self) -> None:
        out = self.run_remote(MELODIOUS_OFF_CHECK_CMD, timeout=30, quiet=True).strip()
        if out == "off":
            raise RuntimeError(MELODIOUS_OFF_REFUSAL)

    def run_turn_off_script(self, mode: str, *extra: str) -> dict[str, list[str]]:
        """Upload TURN_OFF_SCRIPT into volatile RAM, execute it, and parse key=value output."""
        self.run_remote(f"cat > {TURN_OFF_SCRIPT_PATH}", TURN_OFF_SCRIPT.encode("utf-8"), timeout=30, quiet=True)
        arg_str = " ".join([remote_quote(mode), *(remote_quote(a) for a in extra)])
        try:
            code, out, err = self.run_remote_rc(f"sh {TURN_OFF_SCRIPT_PATH} {arg_str}", timeout=120)
        finally:
            self.run_remote_rc(f"rm -f {TURN_OFF_SCRIPT_PATH}", timeout=30)
        values: dict[str, list[str]] = {}
        for line in out.splitlines():
            stripped = line.strip()
            key, sep, value = stripped.partition("=")
            if sep and key:
                values.setdefault(key, []).append(value)
                kv(stripped)
                if key == "warning":
                    info(f"WARNING: {value}")
        if "error" in values:
            raise RuntimeError(values["error"][0])
        if code != 0:
            raise RuntimeError(f"the turn-off helper exited with {code}: {err.strip()}")
        return values

    def bootstrap_gate_scripts(self, targets: list[str]) -> None:
        """Update older installs' text scripts/plugins to gate-aware versions
        (.codex-new + MD5 verify + webui-handoff-<stamp> backup, HANDOFF_KEEP=3)
        before writing /etc/melodious-off."""
        step("Bootstrapping gate-aware scripts for /etc/melodious-off")
        wanted = set(targets)
        candidates = [
            Candidate(dest, mode, kind, local=local)
            for dest, mode, kind, local in GATE_SCRIPT_SPECS
            if dest in wanted
        ]
        for cand in candidates:
            cand.prepare()
        self.candidates = candidates

        self.create_stage()
        self.upload_candidates()
        self.verify_stage_md5()
        self.probe_destinations()
        for cand in self.candidates:
            state = self.probe.get(cand.dest, {})
            exists = state.get("kind") == "regular"
            if exists and state.get("mode") == cand.mode and state.get("md5") == cand.md5:
                cand.action = "unchanged"
            elif exists:
                cand.action = "replace"
            else:
                cand.action = "create"
        self.ram_status()
        rollback_bytes = sum(
            int(self.probe[c.dest].get("size", "0")) for c in self.candidates if c.action == "replace"
        )
        if self.ram_free_bytes < rollback_bytes + RAM_MARGIN_BYTES:
            self.cleanup_stage()
            raise RuntimeError(
                f"free RAM {self.ram_free_bytes} < rollback copies + margin {rollback_bytes + RAM_MARGIN_BYTES}"
            )
        self.count_backup_generations()
        if not self.active_candidates():
            self.cleanup_stage()
            return
        try:
            self.stage_rollback_copies()
            self.create_handoff()
            self.prune_handoffs()
            self.ensure_parent_dirs()
            self.write_new_copies()
            self.install_sequence()
            self.verify_installed()
        except CapacityAbort as exc:
            self.cleanup_stage()
            raise RuntimeError(f"not enough free flash to bootstrap gate scripts: {exc}") from exc
        except InstallFailure as exc:
            self.rollback_changes(str(exc))
            raise RuntimeError(f"gate-script bootstrap failed and was rolled back: {exc}") from exc
        except Exception as exc:
            if self.new_copies or any(item["done"] for item in self.changed):
                self.rollback_changes(str(exc))
                raise RuntimeError(f"gate-script bootstrap failed and was rolled back: {exc}") from exc
            self.cleanup_stage()
            raise
        self.cleanup_stage()

    def wait_post_reboot_verify(
        self,
        before: dict[str, list[str]],
        verify_mode: str,
        *verify_args: str,
        wait_webui: bool = False,
    ) -> dict[str, list[str]]:
        """Wait for SSH (and Web UI if requested), confirm the reboot actually
        happened via boot_id/btime/uptime, and return the post-reboot probe."""
        time.sleep(8)
        wait_for_port(self.args.hub_host, self.args.port, 180, "SSH")
        after: dict[str, list[str]] = {}
        confirmed = False
        for attempt in range(15):
            try:
                after = self.run_turn_off_script(verify_mode, *verify_args)
            except Exception:
                if attempt == 14:
                    raise
                time.sleep(2)
                continue
            if boot_changed(before, after):
                confirmed = True
                break
            time.sleep(2)
        kv(f"reboot_confirmed={'yes' if confirmed else 'no'}")
        if not confirmed:
            raise RuntimeError(
                "the hub did not restart (boot_id, btime, and uptime did not reset); refusing to report success"
            )
        if wait_webui:
            wait_for_port(self.args.hub_host, 8080, 180, "Web UI")
            if after.get("active_on") != ["yes"]:
                after = self.run_turn_off_script(verify_mode, *verify_args)
        return after

    def turn_off(self) -> int:
        step("Checking SSH")
        identity = self.run_remote("id; uname -a", timeout=30)
        print(identity.strip())

        step("Checking preflight gates for turning Melodious off")
        extra = ("--force",) if self.args.force else ()
        before = self.run_turn_off_script("check", *extra)
        if before.get("active_off") == ["yes"]:
            step("Done")
            info("Melodious is already off on this hub.")
            return 0
        if self.args.preflight_only:
            step("Done")
            info("Preflight only: nothing was changed.")
            return 0
        if not self.args.no_prompt:
            info("The hub goes back to Logitech's cloud and the Harmony app. Melodious stops running.")
            answer = input(
                "EXPERIMENTAL, not validated on live hardware. Turn Melodious off and restart the hub? [y/N]: "
            ).strip().lower()
            if answer not in ("y", "yes"):
                info("Nothing was changed.")
                return 1

        if before.get("bootstrap_needed") == ["yes"]:
            self.bootstrap_gate_scripts(before.get("bootstrap_target", []))

        step("Turning Melodious off")
        applied = self.run_turn_off_script("apply", *extra)
        if applied.get("result") != ["off"]:
            raise RuntimeError("the turn-off helper did not confirm /etc/melodious-off")

        wifi_ip = (applied.get("wifi_ip") or [""])[0].strip()
        wired_ips = [ip.strip() for ip in applied.get("wired_ip", []) if ip.strip()]
        switched_to_wifi = False
        step("Restarting the hub")
        self.run_remote("(/bin/sleep 2; /sbin/reboot || reboot) >/dev/null 2>&1 & echo rebooting", timeout=30, quiet=True)
        if self.args.hub_host in wired_ips and wifi_ip and wifi_ip != self.args.hub_host:
            kv(f"post_reboot_host={wifi_ip}")
            info(
                f"Connected over USB Ethernet ({self.args.hub_host}); USB Ethernet stays off after the restart, "
                f"so waiting for SSH on Wi-Fi IP {wifi_ip}."
            )
            self.args.hub_host = wifi_ip
            switched_to_wifi = True

        step("Checking the hub after the restart")
        after = self.wait_post_reboot_verify(applied, "verify-off")
        if after.get("active_off") != ["yes"]:
            reasons = (after.get("still_active") or ["unknown"])[0]
            raise RuntimeError(f"after the restart some of Melodious is still active ({reasons})")

        step("Done")
        info("Melodious is off (/etc/melodious-off): stock hal and Logitech's cloud tasks run; Melodious services, plugins, and restrictions are off.")
        if switched_to_wifi:
            info(f"Hub Wi-Fi IP: {wifi_ip}")
        info("Next, open the Harmony app on the same Wi-Fi network and Sync the hub to 100%.")
        info("The Harmony app's cloud setup replaces local-only devices and activities.")
        if after.get("internet_route") == ["no"]:
            info("The hub has no internet route yet; it gets one as soon as Wi-Fi DHCP finishes.")
        info("To turn Melodious back on later, run this installer with --turn-on.")
        return 0

    def turn_on(self) -> int:
        step("Checking SSH")
        identity = self.run_remote("id; uname -a", timeout=30)
        print(identity.strip())

        step("Checking preflight gates for turning Melodious on")
        before = self.run_turn_off_script("check-on")
        expected_hal = (before.get("expected_hal") or ["stock"])[0]
        if before.get("already_on") == ["yes"]:
            step("Done")
            info("Melodious is already on.")
            return 0
        if self.args.preflight_only:
            step("Done")
            info("Preflight only: nothing was changed.")
            return 0
        if not self.args.no_prompt:
            info("Melodious will start again at boot, with the cloud blocker and your saved settings restored.")
            answer = input(
                "EXPERIMENTAL, not validated on live hardware. Turn Melodious back on and restart the hub? [y/N]: "
            ).strip().lower()
            if answer not in ("y", "yes"):
                info("Nothing was changed.")
                return 1

        step("Turning Melodious on")
        applied = self.run_turn_off_script("apply-on")
        if applied.get("result") != ["on"]:
            raise RuntimeError("the turn-on helper did not confirm removing /etc/melodious-off")
        expected_hal = (applied.get("expected_hal") or [expected_hal])[0]

        step("Restarting the hub")
        self.run_remote("(/bin/sleep 2; /sbin/reboot || reboot) >/dev/null 2>&1 & echo rebooting", timeout=30, quiet=True)

        step("Checking the hub after the restart")
        expected_md5 = (
            HAL_REMOTES_MD5
            if expected_hal == "two-screen"
            else (HAL_MULTI_MD5 if expected_hal == "multi-remote" else "")
        )
        verify_args = (expected_hal, expected_md5) if expected_md5 else (expected_hal,)
        after = self.wait_post_reboot_verify(applied, "verify-on", *verify_args, wait_webui=True)
        if after.get("active_on") != ["yes"]:
            reasons = (after.get("missing_on") or ["unknown"])[0]
            raise RuntimeError(f"after the restart Melodious did not come back cleanly ({reasons})")

        step("Done")
        info(f"Melodious is back on (hal: {expected_hal}).")
        info(f"Web UI: http://{self.args.hub_host}:8080/")
        return 0

    def run(self) -> int:
        step("Checking SSH")
        identity = self.run_remote("id; uname -a", timeout=30)
        print(identity.strip())
        self.check_not_turned_off()

        step("Resolving hub id")
        self.resolve_hub_id()
        self.check_two_screen()
        self.check_multi_remote_off()

        step("Building candidate inventory")
        self.build_inventory()
        info(f"candidates={len(self.candidates)} (codex_webui installed last)")

        self.create_stage()
        self.upload_candidates()
        self.upload_flash_helper()
        self.verify_stage_md5()

        self.probe_destinations()
        self.apply_upgrade_gates()
        self.plan_dropbear_link()
        self.ram_status()
        self.measure_flash()
        self.scan_root_tool_leftovers()

        self.count_backup_generations()
        self.compute_handoff_estimate()
        if self.verdict == VERDICT_CONFIG_UNCERTAIN:
            self.render_preflight_report()
            self.cleanup_stage()
            return 2

        self.build_plans()
        self.decide_verdict()
        self.render_preflight_report()

        if self.args.preflight_only:
            self.cleanup_stage()
            return 0 if self.verdict == VERDICT_ALLOWED else 2

        if self.verdict != VERDICT_ALLOWED:
            self.cleanup_stage()
            info("normal mode aborted before any persistent mutation")
            return 2

        if self.args.remove_root_tool_leftovers and (self.root_tool_stages or self.root_tool_dropbear_removable()):
            self.remove_root_tool_leftovers()
            if self.active_candidates() and self.flash_shortfall() and not self.args.skip_flash_check:
                self.verdict = VERDICT_CAPACITY
                self.capacity_stage = "preflight"
                reason = (
                    f"free flash {self.flash_avail} < estimated need {self.flash_required} "
                    "after removing the leftovers"
                )
                self.verdict_reasons.append(reason)
                kv(f"verdict_reason={reason}")
                self.render_verdict()
                self.cleanup_stage()
                return 2

        if not self.active_candidates():
            self.cleanup_stage()
            if self.hal_setting_changed() and not self.args.no_apply_cloud_restart:
                # The files match, but the running hal isn't the one asked for.
                step("Restarting the hub")
                info("The files already match; rebooting the hub so it starts the " + self.wanted_hal() + " hal.")
                self.reboot_and_wait()
                step("Done")
                info(
                    "The hub already matched this payload; it was restarted to apply the "
                    + ("two-screen" if self.args.two_screen else "multi-remote")
                    + " setting."
                )
                return 0
            step("Done")
            info("The hub already matches this payload; nothing was installed or restarted.")
            return 0

        try:
            self.stage_rollback_copies()
            self.create_handoff()
            self.prune_handoffs()
            self.ensure_parent_dirs()
            self.write_new_copies()
            self.install_sequence()
            self.verify_installed()
        except CapacityAbort as exc:
            self.verdict = VERDICT_CAPACITY
            self.capacity_stage = "phase1"
            self.verdict_reasons.append(str(exc))
            kv(f"verdict_reason={exc}")
            self.render_verdict()
            self.cleanup_stage()
            return 2
        except InstallFailure as exc:
            try:
                self.rollback_changes(str(exc))
            except RuntimeError as rb_exc:
                fail(str(rb_exc))
            fail(f"install failed and was rolled back: {exc}")
        except Exception as exc:
            # Transport-level failures (subprocess.TimeoutExpired, OSError,
            # anything else mid-install) must reach the same rollback
            # decision, never escape past it into blanket staging cleanup.
            if self.new_copies or any(item["done"] for item in self.changed):
                try:
                    self.rollback_changes(str(exc))
                except RuntimeError as rb_exc:
                    fail(str(rb_exc))
                fail(f"install failed and was rolled back: {exc}")
            self.cleanup_stage()
            raise

        try:
            self.post_install_wiring()
            step("Restarting services")
            self.start_services()
        except Exception as exc:
            # Wiring/start failures after destinations were replaced must
            # reverse-roll back; the rollback material stays intact.
            try:
                self.rollback_changes(f"post-install wiring/start failed: {exc}")
                self.start_services()
            except RuntimeError as rb_exc:
                fail(str(rb_exc))
            fail(f"post-install wiring/start failed and changes were rolled back: {exc}")
        try:
            wait_for_port(self.args.hub_host, 8080, 60, "Web UI")
        except Exception as exc:
            try:
                self.rollback_changes(f"smoke test failed: {exc}")
                self.start_services()
            except RuntimeError as rb_exc:
                fail(str(rb_exc))
            fail(f"smoke test failed and changes were rolled back: {exc}")

        self.report_flash_after_install()
        self.cleanup_stage()

        if (
            self.cloud_blocker_changed() or self.plugins_changed() or self.hal_setting_changed()
        ) and not self.args.no_apply_cloud_restart:
            step("Restarting the hub")
            if self.cloud_blocker_changed():
                info("Rebooting the hub so Logitech cloud services restart in blocked mode.")
            elif self.plugins_changed():
                info("Rebooting the hub so its engine loads the updated plugins.")
            else:
                info("Rebooting the hub so it starts the " + self.wanted_hal() + " hal.")
            self.reboot_and_wait()

        step("Done")
        if self.first_install:
            info("Install finished as a first install (configuration written).")
        elif self.args.clean_install:
            info("Install finished in explicit clean-install mode (configuration regenerated).")
        else:
            info("Install finished in default upgrade mode (existing configuration preserved where applicable).")
        info("Persistent paths were mutated only after preflight ALLOWED; staging was volatile until then.")
        info(f"Web UI: http://{self.args.hub_host}:8080/")
        info("Web UI authentication: disabled")
        if not self.args.skip_cloud_suppression:
            info("Cloud blocker: enabled" + (" and applied" if self.cloud_blocker_changed() else " (unchanged)"))
        if self.args.multi_remote:
            info(
                "Multiple remotes of one model: "
                + ("on (remotes without a screen)" if self.args.multi_remote == "on" else "off")
                + (" and applied" if self.multi_remote_changed() else " (unchanged)")
            )
        if self.args.two_screen:
            info(
                "Two remotes with a screen: "
                + {"on": "on", "once": "on for one boot", "serial": "on, serial mode",
                   "serial-once": "on for one boot, serial mode", "off": "off"}[self.args.two_screen]
                + (" and applied" if self.two_screen_changed() else " (unchanged)")
            )
        info("If IR commands do not work, update /data/codex/hub_id with the correct hub id and restart codex_webui.")
        return 0


class InstallFailure(RuntimeError):
    """Failure after persistent changes began; requires rollback."""


class CapacityAbort(RuntimeError):
    """Phase 1 could not write a new copy; every copy was removed, nothing live changed."""


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Install or upgrade Harmony Hub Control on an already rooted "
            "Harmony Hub over SSH. Default mode is upgrade and preserves "
            "existing configuration. Use --clean-install for an explicit clean "
            "install that regenerates configuration. Use --preflight-only to "
            "stage candidates in private volatile storage, verify MD5 hashes, "
            "compare with the hub, and print a terminal verdict with zero persistent "
            "writes and no service actions."
        ),
    )
    parser.add_argument("--hub-host", "--host", dest="hub_host", default="", help="Harmony Hub IP address or hostname")
    parser.add_argument("--key-path", default="", help="SSH private key for root login; defaults to ~/.ssh/harmony_owner_*")
    parser.add_argument("--port", type=int, default=22, help="SSH port")
    parser.add_argument("--ssh-user", default="root", help="SSH username")
    parser.add_argument("--hub-id", default="", help="Hub ID from the root tool output")
    parser.add_argument("--mqtt-broker", default=None, help="MQTT broker host/IP; leave blank to disable MQTT")
    parser.add_argument("--mqtt-port", type=int, default=None, help="MQTT broker port")
    parser.add_argument("--mqtt-user", default=None, help="MQTT username")
    parser.add_argument("--mqtt-password", default=None, help="MQTT password (never printed in preflight or logs)")
    parser.add_argument("--mqtt-base-topic", default=None, help="MQTT base topic")
    parser.add_argument("--mqtt-discovery-prefix", default=None, help="Home Assistant MQTT discovery prefix")
    parser.add_argument("--mqtt-client-id", default=None, help="MQTT client ID")
    parser.add_argument("--mqtt-disabled", action="store_true", default=None, help="Install with MQTT disabled")
    parser.add_argument(
        "--skip-cloud-suppression",
        action="store_true",
        help=(
            "Do not replace netservicestarter.lua (with --clean-install, also write the cloud blocker as off). "
            "This does not undo an existing install; use --turn-off for that"
        ),
    )
    parser.add_argument(
        "--turn-off",
        action="store_true",
        help=(
            "EXPERIMENTAL (not yet validated on live hardware): turn Melodious off via "
            "/etc/melodious-off and restart the hub so Logitech's cloud and the Harmony app "
            "can manage it again. Keeps Melodious's files, configs, and root SSH intact; "
            "supports --preflight-only"
        ),
    )
    parser.add_argument(
        "--turn-on",
        action="store_true",
        help=(
            "EXPERIMENTAL (not yet validated on live hardware): turn Melodious back on by "
            "removing /etc/melodious-off and restarting the hub, restoring the cloud "
            "blocker and saved settings; supports --preflight-only"
        ),
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="With --turn-off, bypass preflight refusals for duplicate remotes, missing Wi-Fi config, or a local-account hub",
    )
    parser.add_argument(
        "--i-understand-experimental",
        action="store_true",
        help=(
            "With --turn-off/--turn-on, acknowledge the EXPERIMENTAL warning that turning "
            "Melodious off/on has not been validated on live hardware; required for "
            "--no-prompt (scripted) runs"
        ),
    )
    parser.add_argument("--no-apply-cloud-restart", action="store_true", help="Do not reboot after the Logitech cloud blocker files, engine plugins or multi-remote setting change")
    parser.add_argument(
        "--multi-remote",
        choices=("on", "off", "force-off"),
        default=None,
        help=(
            "Let the hub keep several remotes without a screen of the same model (they share one "
            "button setup); 'off' restores the stock one-remote-per-model rule. 'force-off' does "
            "that without asking the radio first, for a radio that stopped answering. Omitted: "
            "unchanged. See docs/MULTI_REMOTE.md"
        ),
    )
    parser.add_argument(
        "--two-screen",
        choices=(*TWO_SCREEN_SETTINGS, "off", "force-off"),
        default=None,
        help=(
            "Let the hub keep and serve two remotes with a screen at once (experimental). 'once' "
            "runs it for the next boot only; 'serial' / 'serial-once' use the fallback mode that "
            "serves one remote's message at a time; 'off' (or 'force-off', which is the same here: "
            "nothing is asked of the radio) restores the stock hal. Omitted: unchanged. "
            "See docs/TWO_SCREEN_REMOTES.md"
        ),
    )
    parser.add_argument("--no-prompt", action="store_true", help="Fail instead of asking for missing required values")
    parser.add_argument(
        "--remove-root-tool-leftovers",
        action="store_true",
        help=(
            "Delete harmony-hub-root's leftover /data/codexssh_*_stage folders, and its spare "
            "/data/rootssh/bin/dropbearmulti once SSH runs the installed Dropbear, before installing"
        ),
    )
    parser.add_argument(
        "--skip-flash-check",
        action="store_true",
        help=(
            "Install even when the measured free flash looks too small; the install still stops "
            "with no live changes if flash fills up"
        ),
    )
    parser.add_argument(
        "--preflight-only",
        action="store_true",
        help=(
            "Volatile preflight only: upload candidates into a private "
            "/var/volatile/codex-install-* tree, verify nonsensitive MD5 "
            "hashes, compare them with the hub's current files, check RAM "
            "for rollback copies and free flash for the changed files, and "
            "print inventory plus a terminal verdict (ALLOWED or BLOCKED_*). "
            "Performs no persistent writes, pruning, handoff, installs, "
            "restarts, or other service actions."
        ),
    )
    parser.add_argument(
        "--clean-install",
        action="store_true",
        help=(
            "Explicit clean install: regenerate configuration candidates. "
            "Default when this flag is omitted is upgrade, which preserves "
            "existing configuration unless a candidate explicitly replaces it."
        ),
    )
    args = parser.parse_args(argv)
    # force-off is off without the radio check (check_multi_remote_off()).
    args.multi_remote_force = args.multi_remote == "force-off"
    if args.multi_remote_force:
        args.multi_remote = "off"
    if args.two_screen == "force-off":
        args.two_screen = "off"
    return args


def validate_mode_args(args: argparse.Namespace) -> None:
    if args.turn_off and args.turn_on:
        raise RuntimeError("--turn-off and --turn-on cannot be used together")
    if args.force and not args.turn_off:
        raise RuntimeError("--force can only be used with --turn-off")
    if args.i_understand_experimental and not (args.turn_off or args.turn_on):
        raise RuntimeError("--i-understand-experimental can only be used with --turn-off or --turn-on")
    if args.turn_off or args.turn_on:
        flag = "--turn-off" if args.turn_off else "--turn-on"
        if args.clean_install:
            raise RuntimeError(f"{flag} cannot be combined with --clean-install")
        if args.no_apply_cloud_restart:
            raise RuntimeError(f"{flag} cannot be combined with --no-apply-cloud-restart")


def warn_and_gate_experimental(args: argparse.Namespace) -> None:
    """Print the EXPERIMENTAL banner before any action, and in non-interactive
    runs require the explicit acknowledgment flag so the warning can never be
    silently bypassed. --preflight-only prints the banner without the ack."""
    warn_experimental_turn_off_on()
    if args.no_prompt and not args.preflight_only and not args.i_understand_experimental:
        flag = "--turn-off" if args.turn_off else "--turn-on"
        raise RuntimeError(
            f"{flag} is experimental and has not been validated on live hardware; "
            "non-interactive runs must pass --i-understand-experimental to acknowledge the warning"
        )


def main(argv: list[str]) -> int:
    installer: Installer | None = None
    try:
        args = parse_args(argv)
        validate_mode_args(args)
        if args.turn_off or args.turn_on:
            warn_and_gate_experimental(args)
        args.hub_host = prompt_if_missing(args.hub_host, "Harmony hub IP address", True, args.no_prompt)

        if not args.key_path:
            default_key = resolve_default_key_path()
            if default_key:
                args.key_path = str(default_key)
                info(f"using SSH key {args.key_path}")
        args.key_path = prompt_if_missing(args.key_path, "SSH private key path for root login", True, args.no_prompt)
        key_path = Path(args.key_path).expanduser()
        if not key_path.is_file():
            raise RuntimeError(f"SSH key not found: {key_path}")
        args.key_path = str(key_path)
        if args.turn_off:
            installer = Installer(args)
            return installer.turn_off()
        if args.turn_on:
            installer = Installer(args)
            return installer.turn_on()
        mqtt_cli_supplied = any(
            value is not None
            for value in (
                args.mqtt_broker,
                args.mqtt_port,
                args.mqtt_user,
                args.mqtt_password,
                args.mqtt_base_topic,
                args.mqtt_discovery_prefix,
                args.mqtt_client_id,
                args.mqtt_disabled,
            )
        )
        if not args.no_prompt and args.mqtt_broker is None and args.mqtt_disabled is None:
            if args.clean_install:
                args.mqtt_broker = input("MQTT broker host/IP (blank to disable MQTT for now): ").strip()
                if not args.mqtt_broker:
                    args.mqtt_disabled = True
                # Only a nonblank broker counts as an explicit MQTT choice;
                # a blank answer must never mark MQTT as explicitly supplied.
                mqtt_cli_supplied = bool(args.mqtt_broker)
            else:
                # Default upgrade: never prompt into the MQTT configuration and
                # never regenerate it; the existing /data/codexmqtt/config.json
                # is preserved unless explicit MQTT arguments are supplied.
                args.mqtt_disabled = True
        if not args.no_prompt and args.mqtt_broker:
            if args.mqtt_user is None:
                args.mqtt_user = input("MQTT username (blank if none): ").strip()
            if args.mqtt_password is None:
                args.mqtt_password = getpass.getpass("MQTT password (blank if none): ")
        args.mqtt_explicit_supplied = mqtt_cli_supplied

        # Defaults for MQTT fields never supplied; build_mqtt_config handles empties.
        for field in ("mqtt_broker", "mqtt_user", "mqtt_password", "mqtt_base_topic", "mqtt_discovery_prefix", "mqtt_client_id"):
            if getattr(args, field) is None:
                setattr(args, field, {
                    "mqtt_base_topic": "harmony/hub",
                    "mqtt_discovery_prefix": "homeassistant",
                    "mqtt_client_id": "harmony-local-mqtt",
                }.get(field, ""))
        if args.mqtt_port is None:
            args.mqtt_port = 1883
        if args.mqtt_disabled is None:
            args.mqtt_disabled = False

        installer = Installer(args)
        return installer.run()
    except KeyboardInterrupt:
        if installer is not None and installer.stage and not installer.preserve_stage:
            try:
                installer.cleanup_stage()
            except Exception:
                pass
        fail("cancelled")
    except Exception as exc:
        # Always remove the owned volatile staging tree unless the rollback is
        # incomplete and the tree is deliberately preserved for manual recovery.
        if installer is not None and installer.stage and not installer.preserve_stage:
            try:
                installer.cleanup_stage()
            except Exception:
                pass
        fail(str(exc))
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
