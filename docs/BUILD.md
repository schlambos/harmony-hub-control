# Build Notes — final product

The repository ships ready-to-install MIPS binaries in `payload/bin/`. Rebuild
only when native source or embedded assets change. This document is the
**current product build flow**; the historical `box-snapshot-20260818`
reconciliation is recorded separately in
[docs/reconciliation/box-snapshot-20260818.md](reconciliation/box-snapshot-20260818.md)
and is not the current-main truth.

## Target

- CPU: MIPS, big-endian
- Userspace: uClibc-era embedded Linux
- Output: mostly static helper binaries

## Final product artifact identities

The shipped `payload/bin/` binaries are the final product artifacts. Their
exact SHA-256 digests and sizes are:

| Binary | Size | SHA-256 |
| --- | --- | --- |
| `codex_webui` | 778408 | `7bcf00bdcc98ded1795851ea72864f434e4e15d376a95dc7bedc70d34902b2a2` |
| `codex_hbus` | 74660 | `4be9e6ac2e09e7eb052f9c47e81480d1e32aee7190bedb6ef7f932cf07aab8f9` |

The remaining six binaries (`codex_bt_pair_agent`, `codex_bthid_keyboard`,
`codex_dhcpd`, `codex_hal_ltcp`, `codex_portal`, `dropbearmulti`) are pinned by
their MD5 digests in `payload/bin/MANIFEST.txt` and by SHA-256 in the
integration artifact ledger
(`provenance/integration/main-product-20260819/artifact-ledger.json`).

## Toolchains — dual Zig pins (non-interchangeable)

Two distinct Zig 0.16.0 distributions are required. They are **not
interchangeable**: each reproduces a specific subset of binaries byte-for-byte.

| Pin | Distribution | clang/LLD | SHA-256 |
| --- | --- | --- | --- |
| `WEBUI_ZIG` | Homebrew Zig 0.16.0 | clang 21.1.8 | `0bfa8cb6f5f64c6d645e1d5dfb5c6f62c2b79d7249c3f38a279e118cb49b02ae` |
| `OFFICIAL_ZIG` | Official Zig 0.16.0 tarball | clang 21.1.0 | `e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec` |

### codex_webui (Homebrew Zig)

```sh
sh tools/embed_activity_ui.sh   # embed the advanced editor assets first
"$WEBUI_ZIG" cc -target mips-linux-musleabi -Os -static -s \
  -I payload/source -o payload/bin/codex_webui payload/source/codex_webui.c
```

Result must be `ELF 32-bit MSB executable, MIPS, MIPS32 rel2, statically
linked, stripped`, size 778408, SHA-256
`7bcf00bdcc98ded1795851ea72864f434e4e15d376a95dc7bedc70d34902b2a2`.

### codex_hbus (Official Zig, `-mcpu=mips32`)

```sh
"$OFFICIAL_ZIG" cc -target mips-linux-musleabi -mcpu=mips32 -Os -static -s \
  -o build/output/codex_hbus payload/source/codex_hbus.c
```

Result must be size 74660, SHA-256
`4be9e6ac2e09e7eb052f9c47e81480d1e32aee7190bedb6ef7f932cf07aab8f9`.

### Bluetooth trio (Official Zig)

```sh
"$OFFICIAL_ZIG" cc -target mips-linux-musleabi -Os -static -s \
  -o build/output/codex_bt_pair_agent payload/source/codex_bt_pair_agent.c
"$OFFICIAL_ZIG" cc -target mips-linux-musleabi -Os -static -s \
  -o build/output/codex_bthid_keyboard payload/source/codex_bthid_keyboard.c
"$OFFICIAL_ZIG" cc -target mips-linux-musleabi -Os -static -s \
  -o build/output/codex_hal_ltcp payload/source/codex_hal_ltcp.c
```

### dhcpd / portal (Bootlin mips32-uclibc)

`codex_dhcpd` and `codex_portal` reproduce with the pinned Bootlin
`mips32--uclibc--stable-2017.05` toolchain (tarball SHA-256 verified); see
`build/build_harmony_tools_kali.sh`.

## Per-binary build status (all 8)

| Binary | Build status |
| --- | --- |
| `codex_webui` | EXACT_SOURCE_REPRODUCIBLE (Homebrew Zig 0.16.0) |
| `codex_hbus` | EXACT_SOURCE_REPRODUCIBLE (Official Zig 0.16.0, `-mcpu=mips32`) |
| `codex_bt_pair_agent` | EXACT_SOURCE_REPRODUCIBLE (Official Zig 0.16.0) |
| `codex_bthid_keyboard` | EXACT_SOURCE_REPRODUCIBLE (Official Zig 0.16.0) |
| `codex_hal_ltcp` | EXACT_SOURCE_REPRODUCIBLE (Official Zig 0.16.0) |
| `codex_dhcpd` | EXACT_SOURCE_REPRODUCIBLE (Bootlin mips32-uclibc) |
| `codex_portal` | EXACT_SOURCE_REPRODUCIBLE (Bootlin mips32-uclibc) |
| `dropbearmulti` | **UNVERIFIED_THIRD_PARTY** (version/license verified, build unverified) |

`dropbearmulti` is the **only** UNVERIFIED_THIRD_PARTY artifact. Its
version/license closure is recorded in
`docs/reconciliation/box-snapshot-20260818.md` (Dropbear 2025.89, tag-pinned
LICENSE at `third_party/dropbear-2025.89/LICENSE`); no exact-source or
VERIFIED_THIRD_PARTY claim is made for it.

## Linux Build

The helper build script is written for a Debian/Kali-like Linux environment:

```sh
cd build
./build_harmony_tools_kali.sh
```

It downloads the Bootlin MIPS uClibc toolchain and Dropbear source into
`build/toolchains/` and `build/tmp/`, then writes fresh binaries to
`build/output/`. Before compilation it also runs
`tools/embed_activity_ui.sh`, which regenerates
`payload/source/activity_ui_assets.h` from the readable CSS and JavaScript under
`payload/web/`.

Deploy `codex_webui` and `codex_hbus` from the same build. Activity resource
updates use the fail-closed `payload/activity/codexactivity.lua` plugin and a
root-only volatile file channel, so the full ActivityList, MapList, and
FunctionList transaction never passes through a shell argument or firmware
network-sync command.

The host-side HBus smoke test deliberately sends notifications, a ping, an
unrelated response, and a fragmented 350 KB response before the matching
request ID:

```sh
cc -std=c99 -O2 -o /tmp/codex_hbus_host payload/source/codex_hbus.c
python3 tools/hbus_notification_smoke.py /tmp/codex_hbus_host
```

The activity save path also has a host-side regression for semantic JSON
comparison. It verifies that object-key order, escaped slashes, Unicode escape
forms, and equivalent numeric forms do not create false resource writes:

```sh
tools/activity_json_semantic_smoke.sh
```

The activity editor model regression verifies orphan-map repair, required
per-surface and activity-function-map creation, the zero/omitted local identity
format, and duplicate canonical button-ID rejection:

```sh
node tools/activity_ui_model_smoke.mjs
```

The offline guard rejects resource-proxy, firmware-sync, queue, socket, session,
and account-service paths in the activity writer. It also verifies that the
paired-remote HBus guards and reversible LAN-only route guard are packaged, and
that the installer references the exact `activity/codexactivity.lua` candidate
(accepting either the Windows backslash or portable forward-slash separator):

```sh
tools/activity_offline_guard.sh
```

The Linux build script runs all three tests automatically before downloading or
invoking the cross toolchain.

After rebuilding:

1. Copy the required binaries from `build/output/` into `payload/bin/`.
2. Refresh `payload/bin/MANIFEST.txt`.
3. Deploy to a test hub with `install_webui.ps1` or `python3 install_webui.py`.
4. Confirm checksums and runtime behavior.

## Windows

Windows can deploy with PowerShell, and Linux/macOS can deploy with the Python
installer. Use WSL, a Linux VM, or the existing build server for rebuilding MIPS
binaries.

## Dropbear

`dropbearmulti` is included so the web UI package can keep SSH reachable on a
rooted hub. The installer does not replace `authorized_keys`; it only uploads
Dropbear binaries/wrappers and starts the service if needed. Its build status is
`UNVERIFIED_THIRD_PARTY` (see above).
