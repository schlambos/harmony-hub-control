#!/usr/bin/env python3
"""Release manifest and checksum checks for Melodious releases.

  manifest <dir>  Read the release assets in <dir>, write melodious-update.json
                  (versions, compatibility, and the SHA-256 of every hub payload
                  file) and SHA256SUMS.txt over all assets including that file.
                  A hub release also carries BusyBox's upstream source tarball,
                  checked against the pin in the hub zip.
  verify <dir>    Check every checksum, that nothing in <dir> is left out, and
                  that the manifest agrees with the assets.

Releases are not signed: the checksums prove a download is intact, not who
published it. See docs/RELEASING.md.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFEST_NAME = "melodious-update.json"
SUMS_NAME = "SHA256SUMS.txt"
SCHEMA = 1

# Certificate SHA-256 of the Android release key (~/.android/melodious-release.jks).
ANDROID_RELEASE_CERT = "7a766509ca8424065c5f6c7ae4214369862a5a18881ee00e434c9f833e0bd2de"

# Where each hub payload file goes, as install_webui.py installs it.
# Tier 1: binaries an app may update (restart only). Tier 2: Lua plugins
# (reboot). Tier 3: boot and recovery files, installer only.
HUB_FILES = {
    "payload/bin/codex_webui": ("/data/codex/bin/codex_webui", "755", 1),
    "payload/bin/codex_hbus": ("/data/codex/bin/codex_hbus", "755", 1),
    "payload/bin/codex_hal_ltcp": ("/data/codex/bin/codex_hal_ltcp", "755", 1),
    "payload/bin/codex_bthid_keyboard": ("/data/codex/bin/codex_bthid_keyboard", "755", 1),
    "payload/bin/codex_bt_pair_agent": ("/data/codex/bin/codex_bt_pair_agent", "755", 1),
    "payload/bin/codex_androidtv": ("/data/codex/bin/codex_androidtv", "755", 1),
    "payload/bin/codex_usbeth": ("/data/codex/bin/codex_usbeth", "755", 1),
    "payload/activity/codexactivity.lua": ("/pkg/codexactivity/codexactivity.lua", "644", 2),
    "payload/mqtt/codexmqtt.lua": ("/pkg/codexmqtt/codexmqtt.lua", "644", 2),
    "payload/bin/codex_portal": ("/data/codex/bin/codex_portal", "755", 3),
    "payload/bin/codex_dhcpd": ("/data/codex/bin/codex_dhcpd", "755", 3),
    "payload/bin/dropbearmulti": ("/data/codex/bin/dropbearmulti", "755", 3),
    "payload/bin/busybox-extra": ("/data/codex/bin/busybox-extra", "755", 3),
    "payload/scripts/dropbear": ("/usr/sbin/dropbear", "755", 3),
    "payload/scripts/dropbearkey": ("/usr/sbin/dropbearkey", "755", 3),
    "payload/scripts/init.sh": ("/data/codex/init.sh", "755", 3),
    "payload/scripts/offline_egress_guard.sh": ("/data/codex/offline_egress_guard.sh", "755", 3),
    "payload/scripts/recovery_ap.sh": ("/data/codex/recovery_ap.sh", "755", 3),
    "payload/scripts/androidtv_service.sh": ("/data/codex/androidtv_service.sh", "755", 3),
    "payload/androidtv/input-presets.json": ("/data/codex/androidtv-input-presets.json", "644", 3),
    "payload/scripts/usb_eth_service.sh": ("/data/codex/usb_eth_service.sh", "755", 3),
    "payload/modules/usb-net/r8152.ko": ("/data/codex/modules/usb-net/r8152.ko", "644", 3),
    "payload/modules/usb-net/usbnet.ko": ("/data/codex/modules/usb-net/usbnet.ko", "644", 3),
    "payload/modules/usb-net/asix.ko": ("/data/codex/modules/usb-net/asix.ko", "644", 3),
    "payload/modules/usb-net/cdc_ether.ko": ("/data/codex/modules/usb-net/cdc_ether.ko", "644", 3),
    "payload/modules/usb-net/cdc_ncm.ko": ("/data/codex/modules/usb-net/cdc_ncm.ko", "644", 3),
    "payload/modules/usb-net/ax88179_178a.ko": ("/data/codex/modules/usb-net/ax88179_178a.ko", "644", 3),
    "payload/modules/usb-net/README.md": ("/data/codex/modules/usb-net/README.md", "644", 3),
    "payload/scripts/rcS.local": ("/etc/init.d/rcS.local", "755", 3),
    "payload/scripts/netservicestarter.lua": ("/opt/luaworks/tasks/connectserver/netservicestarter.lua", "644", 3),
}
HUB_INVENTORY_FILES = {"payload/bin/MANIFEST.txt", "payload/bin/FILES"}
# Run by the installers from the hub's RAM staging folder; never installed,
# so no app update ships them.
HUB_INSTALLER_HELPERS = {"payload/helpers/codex_flash_free"}
# GPL-2.0 BusyBox ships as payload/bin/busybox-extra, so the hub zip must
# carry its licence and the corresponding source this repository holds: the
# build scripts, and one third_party/busybox-<version>/ folder with LICENSE,
# README.md (which names the upstream tarball), busybox.config and patches/.
HUB_GPL_SOURCE = {"LICENSE", "build/build_harmony_tools_kali.sh", "build/busybox-zig-cc.sh",
                  "build/busybox-zig-ar.sh", "build/discard-mips-pdr.ld"}
BUSYBOX_SOURCE_DIR = re.compile(r"^third_party/busybox-[0-9.]+/")
BUSYBOX_SOURCE_FILES = ("LICENSE", "README.md", "busybox.config")
# The upstream tarball itself is a release asset beside the hub zip, so the
# complete source comes from where the binary does (GPLv2 section 3(a)). The
# README names it and pins its SHA-256.
BUSYBOX_UPSTREAM = re.compile(r"\b(busybox-([0-9.]+)\.tar\.bz2)`?, SHA-256 `([0-9a-f]{64})`")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")


class ReleaseError(Exception):
    pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def asset_names(series: str, version: str) -> dict:
    mac = {
        "dmg": {arch: f"Melodious-{version}-{arch}.dmg" for arch in ("arm64", "x64")},
        "zip": {arch: f"Melodious-{version}-{arch}.zip" for arch in ("arm64", "x64")},
    }
    if series == "desktop":
        return {"mac": mac}
    return {"hub": f"melodious-hub-{version}.zip", "apk": f"melodious-{version}.apk", "mac": mac}


def source_assets(folder: Path, series: str, version: str) -> dict[str, str]:
    """GPL source tarballs a hub release carries beside its zip: name -> pinned SHA-256.

    Read from the hub zip's third_party/busybox-<version>/README.md."""
    if series != "hub":
        return {}
    zip_path = folder / asset_names(series, version)["hub"]
    if not zip_path.is_file():
        raise ReleaseError(f"missing asset {zip_path.name} in {folder}")
    top = f"melodious-hub-{version}/"
    with zipfile.ZipFile(zip_path) as z:
        readmes = [n for n in z.namelist()
                   if n.startswith(top) and BUSYBOX_SOURCE_DIR.match(n[len(top):])
                   and n[len(top):].count("/") == 2 and n.endswith("/README.md")]
        if len(readmes) != 1:
            raise ReleaseError(f"{zip_path.name}: expected one third_party/busybox-<version>/README.md, found {len(readmes)}")
        text = z.read(readmes[0]).decode("utf-8", "replace")
    m = BUSYBOX_UPSTREAM.search(text)
    readme = readmes[0][len(top):]
    if not m:
        raise ReleaseError(f"{zip_path.name}: {readme} doesn't name the upstream busybox-<version>.tar.bz2 and its SHA-256")
    if readme != f"third_party/busybox-{m.group(2)}/README.md":
        raise ReleaseError(f"{zip_path.name}: {readme} names {m.group(1)}, another version")
    return {m.group(1): m.group(3)}


def check_source_assets(folder: Path, sources: dict[str, str]) -> None:
    for name, digest in sources.items():
        path = folder / name
        if not path.is_file():
            raise ReleaseError(f"missing asset {name} in {folder}: BusyBox's upstream source, which a hub "
                               "release carries for the GPL (download it from busybox.net; see docs/RELEASING.md)")
        if sha256_file(path) != digest:
            raise ReleaseError(f"{name}: SHA-256 differs from the pin in the hub zip's third_party README")


def release_assets(folder: Path, series: str, version: str) -> list[str]:
    """Every asset SHA256SUMS.txt covers, apart from the manifest."""
    return ordered_assets(series, version) + sorted(source_assets(folder, series, version))


def ordered_assets(series: str, version: str) -> list[str]:
    """SHA256SUMS order used since 1.0: hub, apk, dmgs, zips."""
    names = asset_names(series, version)
    out = []
    if series == "hub":
        out += [names["hub"], names["apk"]]
    out += [names["mac"]["dmg"]["arm64"], names["mac"]["dmg"]["x64"]]
    out += [names["mac"]["zip"]["arm64"], names["mac"]["zip"]["x64"]]
    return out


# ---------------------------------------------------------------- hub zip

def hub_zip_files(zip_path: Path, version: str) -> tuple[list[dict], str]:
    """Per-file entries for the hub payload, and the commit in the zip comment."""
    top = f"melodious-hub-{version}/"
    files = []
    seen = set()
    with zipfile.ZipFile(zip_path) as z:
        commit = z.comment.decode("ascii", "replace").strip()
        contents = {}
        for info in z.infolist():
            if not info.filename.startswith(top):
                raise ReleaseError(f"{zip_path.name}: {info.filename} is outside {top}")
            rel = info.filename[len(top):]
            if rel in HUB_GPL_SOURCE or (BUSYBOX_SOURCE_DIR.match(rel) and not info.is_dir()):
                contents[rel] = z.read(info)
                continue
            if info.is_dir() or not rel.startswith("payload/"):
                continue
            data = z.read(info)
            contents[rel] = data
            if rel in HUB_INVENTORY_FILES or rel in HUB_INSTALLER_HELPERS:
                continue
            if rel not in HUB_FILES:
                raise ReleaseError(
                    f"{zip_path.name}: {rel} has no install destination in tools/releases/release.py HUB_FILES"
                )
            dest, mode, tier = HUB_FILES[rel]
            seen.add(rel)
            files.append({
                "path": rel, "dest": dest, "mode": mode, "tier": tier,
                "size": len(data), "sha256": sha256_bytes(data),
            })
    missing = sorted(set(HUB_FILES) - seen) + sorted(HUB_INSTALLER_HELPERS - set(contents))
    if missing:
        raise ReleaseError(f"{zip_path.name}: missing payload files {', '.join(missing)}")
    missing = sorted(HUB_GPL_SOURCE - set(contents))
    dirs = sorted({BUSYBOX_SOURCE_DIR.match(rel).group(0) for rel in contents if BUSYBOX_SOURCE_DIR.match(rel)})
    if len(dirs) != 1:
        missing.append("third_party/busybox-<version>/ (found %d)" % len(dirs))
    else:
        missing += [dirs[0] + f for f in BUSYBOX_SOURCE_FILES if dirs[0] + f not in contents]
        if not any(rel.startswith(dirs[0] + "patches/") and rel.endswith(".patch") for rel in contents):
            missing.append(dirs[0] + "patches/*.patch")
    if missing:
        raise ReleaseError(f"{zip_path.name}: missing BusyBox licence/source files {', '.join(missing)}")
    check_bin_manifest(contents, zip_path.name)
    files.sort(key=lambda f: (f["tier"], f["path"]))
    return files, commit


def check_bin_manifest(contents: dict, label: str) -> None:
    """payload/bin/MANIFEST.txt must match the binaries next to it."""
    text = contents.get("payload/bin/MANIFEST.txt")
    if text is None:
        raise ReleaseError(f"{label}: payload/bin/MANIFEST.txt is missing")
    for line in text.decode("utf-8", "replace").splitlines():
        m = re.match(r"^([0-9a-f]{32})\s+(\S+)$", line)
        if not m:
            continue
        data = contents.get(f"payload/bin/{m.group(2)}")
        if data is None or hashlib.md5(data).hexdigest() != m.group(1):
            raise ReleaseError(f"{label}: payload/bin/MANIFEST.txt md5 for {m.group(2)} does not match the file")


# ---------------------------------------------------------------- APK

def build_tools_dir() -> Path:
    home = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT") or str(Path.home() / "Library/Android/sdk")
    root = Path(home) / "build-tools"
    versions = sorted((p for p in root.glob("*") if (p / "apksigner").exists()),
                      key=lambda p: [int(x) if x.isdigit() else 0 for x in p.name.split(".")])
    if not versions:
        raise ReleaseError(f"no Android build-tools with apksigner under {root} (set ANDROID_HOME)")
    return versions[-1]


def apk_info(apk: Path) -> dict:
    """Package, versionCode and signing certificate, read from the APK itself."""
    tools = build_tools_dir()
    badging = subprocess.run([str(tools / "aapt2"), "dump", "badging", str(apk)],
                             capture_output=True, text=True, check=False)
    m = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'", badging.stdout)
    if badging.returncode != 0 or not m:
        raise ReleaseError(f"{apk.name}: aapt2 could not read the package: {badging.stderr.strip()[:200]}")
    certs = subprocess.run([str(tools / "apksigner"), "verify", "--print-certs", str(apk)],
                           capture_output=True, text=True, check=False)
    digests = re.findall(r"certificate SHA-256 digest: ([0-9a-f]{64})", certs.stdout)
    if certs.returncode != 0 or not digests:
        raise ReleaseError(f"{apk.name}: apksigner verify failed: {(certs.stderr or certs.stdout).strip()[:200]}")
    return {"package": m.group(1), "versionCode": int(m.group(2)), "versionName": m.group(3), "certs": digests}


def check_apk(info: dict, version: str, label: str) -> None:
    if info["package"] != "app.melodious":
        raise ReleaseError(f"{label}: package is {info['package']}, expected app.melodious")
    if info["versionName"] != version:
        raise ReleaseError(f"{label}: versionName is {info['versionName']}, expected {version}")
    if info["certs"] != [ANDROID_RELEASE_CERT]:
        raise ReleaseError(f"{label}: signed by {info['certs']}, expected the release key {ANDROID_RELEASE_CERT}")


# ---------------------------------------------------------------- manifest

def build_manifest(folder: Path, series: str, version: str, min_hub: str | None,
                   commit: str | None, apk_reader=apk_info) -> dict:
    if not VERSION_RE.match(version):
        raise ReleaseError(f"version {version!r} is not MAJOR.MINOR.PATCH")
    names = asset_names(series, version)
    for name in ordered_assets(series, version):
        if not (folder / name).is_file():
            raise ReleaseError(f"missing asset {name} in {folder}")
    manifest = {
        "schema": SCHEMA,
        "product": "melodious",
        "series": series,
        "version": version,
        "tag": f"v{version}" if series == "hub" else f"desktop-v{version}",
        "commit": commit or "",
        "macos": {
            "assets": dict(names["mac"]["zip"]),
            "minSystem": "13.0",
        },
    }
    if min_hub:
        if not VERSION_RE.match(min_hub):
            raise ReleaseError(f"--min-hub {min_hub!r} is not MAJOR.MINOR.PATCH")
        manifest["macos"]["minHub"] = min_hub
    if series == "hub":
        if not min_hub:
            raise ReleaseError("--min-hub is required for a hub release")
        files, zip_commit = hub_zip_files(folder / names["hub"], version)
        if commit and zip_commit and commit != zip_commit:
            raise ReleaseError(f"--commit {commit} differs from the hub zip's commit {zip_commit}")
        manifest["commit"] = commit or zip_commit
        check_source_assets(folder, source_assets(folder, series, version))
        info = apk_reader(folder / names["apk"])
        check_apk(info, version, names["apk"])
        manifest["android"] = {
            "asset": names["apk"],
            "package": "app.melodious",
            "versionCode": info["versionCode"],
            "certSha256": ANDROID_RELEASE_CERT,
            "minHub": min_hub,
        }
        manifest["hub"] = {
            "asset": names["hub"],
            "updateProtocol": 0,
            "files": files,
        }
    if not manifest["commit"]:
        raise ReleaseError("no commit: pass --commit (desktop releases have no hub zip to read it from)")
    return manifest


def write_sums(folder: Path, names: list[str]) -> str:
    lines = [f"{sha256_file(folder / n)}  {n}" for n in names]
    text = "\n".join(lines) + "\n"
    (folder / SUMS_NAME).write_text(text)
    return text


def parse_sums(text: str) -> dict[str, str]:
    out = {}
    for line in text.splitlines():
        m = re.match(r"^([0-9a-f]{64})  (\S+)$", line)
        if not m:
            raise ReleaseError(f"bad {SUMS_NAME} line: {line!r}")
        if m.group(2) in out:
            raise ReleaseError(f"{SUMS_NAME} lists {m.group(2)} twice")
        out[m.group(2)] = m.group(1)
    return out


# ---------------------------------------------------------------- verify

def verify_release(folder: Path, apk_reader=apk_info) -> list[str]:
    sums = parse_sums((folder / SUMS_NAME).read_text())
    for name, digest in sums.items():
        path = folder / name
        if not path.is_file():
            raise ReleaseError(f"{SUMS_NAME} lists {name}, which is not in {folder}")
        if sha256_file(path) != digest:
            raise ReleaseError(f"{name}: SHA-256 does not match {SUMS_NAME}")
    unlisted = sorted(p.name for p in folder.iterdir()
                      if p.is_file() and not p.name.startswith(".")
                      and p.name not in sums and p.name != SUMS_NAME)
    if unlisted:
        raise ReleaseError(f"assets not covered by {SUMS_NAME}: {', '.join(unlisted)}")
    if MANIFEST_NAME not in sums:
        raise ReleaseError(f"{SUMS_NAME} does not cover {MANIFEST_NAME}")
    manifest = json.loads((folder / MANIFEST_NAME).read_text())
    if manifest.get("schema") != SCHEMA:
        raise ReleaseError(f"{MANIFEST_NAME}: schema {manifest.get('schema')}, expected {SCHEMA}")
    series, version = manifest.get("series"), manifest.get("version", "")
    if series not in ("hub", "desktop"):
        raise ReleaseError(f"{MANIFEST_NAME}: unknown series {series!r}")
    expected = set(release_assets(folder, series, version)) | {MANIFEST_NAME}
    if set(sums) != expected:
        raise ReleaseError(f"{SUMS_NAME} covers {sorted(set(sums))}, expected {sorted(expected)}")
    min_hub = (manifest.get("android") if series == "hub" else manifest.get("macos", {})).get("minHub")
    rebuilt = build_manifest(folder, series, version, min_hub, manifest.get("commit"), apk_reader=apk_reader)
    if rebuilt != manifest:
        raise ReleaseError(f"{MANIFEST_NAME} does not match the assets it describes")
    return [f"{len(sums)} files match {SUMS_NAME}; {MANIFEST_NAME} matches the assets "
            f"({manifest['tag']}, commit {manifest['commit'][:12]})"]


# ---------------------------------------------------------------- CLI

def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("manifest", help="write melodious-update.json and SHA256SUMS.txt")
    m.add_argument("dir", type=Path)
    m.add_argument("--version", required=True)
    m.add_argument("--series", choices=("hub", "desktop"), default="hub")
    m.add_argument("--min-hub", help="oldest hub software the apps in this release work with")
    m.add_argument("--commit", help="release commit (read from the hub zip comment when omitted)")
    v = sub.add_parser("verify", help="check the checksums and manifest")
    v.add_argument("dir", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.cmd == "manifest":
            manifest = build_manifest(args.dir, args.series, args.version, args.min_hub, args.commit)
            (args.dir / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2) + "\n")
            write_sums(args.dir, release_assets(args.dir, args.series, args.version) + [MANIFEST_NAME])
            print(f"wrote {args.dir / MANIFEST_NAME} and {args.dir / SUMS_NAME}")
        else:
            for line in verify_release(args.dir):
                print(line)
            print("release verified")
    except ReleaseError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
