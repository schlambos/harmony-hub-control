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
`build/output/`.

### Mixed toolchains

The build uses **three toolchains**:

- **Bootlin mips32 uClibc 2017.05 GCC 5.4** for `codex_dhcpd` and
  `codex_portal` (and `dropbearmulti`).
- **Homebrew Zig 0.16.0_1** (bundled clang/LLD 21.1.8) for `codex_webui` only.
- **Official Zig 0.16.0** (bundled clang/LLD 21.1.0) for `codex_bt_pair_agent`,
  `codex_bthid_keyboard`, `codex_hal_ltcp`, and `codex_hbus`.

The deployed binaries were built with Zig's bundled clang, not the Bootlin GCC
5.4 toolchain (GCC 5.4 emits mips32 r1; the live binaries are mips32r2 with a
clang/LLD section layout, except `codex_hbus` which is mips32 r1). The exact
builds are:

```sh
# codex_webui (Homebrew Zig, clang/LLD 21.1.8)
zig cc -target mips-linux-musleabi -Os -static -s -I payload/source \
    -o build/output/codex_webui payload/source/codex_webui.c

# pair-agent / bthid / HAL (Official Zig, clang/LLD 21.1.0)
zig cc -target mips-linux-musleabi -Os -static -s \
    -o build/output/codex_bt_pair_agent payload/source/codex_bt_pair_agent.c
zig cc -target mips-linux-musleabi -Os -static -s \
    -o build/output/codex_bthid_keyboard payload/source/codex_bthid_keyboard.c
zig cc -target mips-linux-musleabi -Os -static -s \
    -o build/output/codex_hal_ltcp payload/source/codex_hal_ltcp.c

# codex_hbus (Official Zig, clang/LLD 21.1.0, mips32 r1)
zig cc -target mips-linux-musleabi -mcpu=mips32 -Os -static -s \
    -o build/output/codex_hbus payload/source/codex_hbus.c
```

### Dual Zig distributions

The build requires **two distinct Zig distributions**, which are **not
interchangeable**: the deployed binaries were built with different clang/LLD
versions whose `.comment` sections differ (Homebrew patches the Zig binary to
prefix `Homebrew ` to the clang/LLD version strings and append a third
`clang version 21.1.0` string, growing the `.comment` section by 39 bytes and
the file by 40 bytes).

| Variable | Distribution | clang/LLD | Executable SHA-256 |
| --- | --- | --- | --- |
| `WEBUI_ZIG` | Homebrew Zig 0.16.0_1 | 21.1.8 | `0bfa8cb6f5f64c6d645e1d5dfb5c6f62c2b79d7249c3f38a279e118cb49b02ae` |
| `OFFICIAL_ZIG` | Official Zig 0.16.0 | 21.1.0 | `e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec` |

The official distribution is downloaded from
`https://ziglang.org/download/0.16.0/zig-aarch64-macos-0.16.0.tar.xz`
(tarball SHA-256 `b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489`,
verified against the authoritative `ziglang.org/download/index.json`). Its
signature status is **NOT_VERIFIED**: the `.minisig` file was archived but its
signature could not be cryptographically verified in this environment; only the
authoritative index SHA-256 was verified.

The build script fails closed (exit 1) if either Zig binary is missing, is not
exactly 0.16.0, has the wrong executable SHA-256, or has the wrong clang/LLD
fingerprint, and again if any built binary does not match its expected
size/SHA-256. No absolute private paths are baked in: `WEBUI_ZIG` defaults to
`zig` on `PATH` and `OFFICIAL_ZIG` must be supplied via the environment.

### Output hashes (fail closed)

| Binary | Size | SHA-256 |
| --- | --- | --- |
| `codex_webui` | 906872 | `c400173bb42f735734c522556c69f6c80f0604949413eb974c7b361b9e4ac11a` |
| `codex_bt_pair_agent` | 111796 | `563c6c58a3629edfebd7ec30ebcf14e6384a2d84e89669b1d7c3d79c75b619c8` |
| `codex_bthid_keyboard` | 116452 | `c6a3c4cd0db3aab1bbdc92ae22e3ae2ffe11d442ac7fe0920b46a6da0b5cef13` |
| `codex_hal_ltcp` | 76772 | `7fa9a84b9ee270bdf6e47d40859d29b6c1c30e5a1766f0ab59e9143dd13ca26c` |
| `codex_hbus` | 74660 | `4be9e6ac2e09e7eb052f9c47e81480d1e32aee7190bedb6ef7f932cf07aab8f9` |

All Zig-built outputs go only to `build/output/` (never `payload/bin`).

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
