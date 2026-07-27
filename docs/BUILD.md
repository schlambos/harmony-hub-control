# Build Notes

The repository ships ready-to-install MIPS binaries in `payload/bin/`. Rebuild
only when native source changes.

## Target

- CPU: MIPS, big-endian
- Userspace: uClibc-era embedded Linux
- Output: mostly static helper binaries

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
paired-remote HBus guards and reversible LAN-only route guard are packaged:

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
Dropbear binaries/wrappers and starts the service if needed.
