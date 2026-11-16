# Melodious desktop (`desktop/`)

The Melodious web app in a desktop window on Windows, Linux and macOS,
plus hub Setup Wizard and Logitech catalog lookup. Windows and macOS
releases include the wizard after `v2.1.0`; it is on `main` and Linux can
run it from source. The bundled CLI works on all three platforms now. The
plan and its security model are in [`docs/DESKTOP_APP.md`](../docs/DESKTOP_APP.md);
user guides are [Setup Guide](../docs/SETUP_GUIDE.md) and the main
[README](../README.md#the-desktop-app-windows-linux-and-macos).

The app serves the packaged web UI (`tools/package_harmony_shell.sh`) over
`melodious://app` and forwards hub requests over the LAN. Logitech sign-in,
search and download run in the main process; the page reaches them only
through the `window.melodiousDesktop.catalog` bridge.

## Setup

Source prerequisites: Node.js, npm, the pinned bun
(`sh tools/ci/install_bun.sh "$HOME/.local/bin"` from the repository root,
then add that directory to PATH), and a shell (Git Bash on Windows).
The wizard additionally needs Python 3, `ssh` and `ssh-keygen` on PATH.
Windows' native `winhid` needs no Python USB package; macOS/Linux need
`tools/hub-root/requirements-usb.txt` in `tools/hub-root/.venv`.
Packaged Windows/macOS apps bundle Python and their USB backend instead.

```sh
cd desktop
npm ci
node node_modules/electron/install.js   # npm 11 skips Electron's postinstall
```

Electron, electron-builder and Playwright are pinned to exact versions in
`package.json`.

## Bundle and run

```sh
cd desktop
npm start
```

`scripts/bundle-shell.sh` runs `tools/package_harmony_shell.sh`, checks that
`payload/source/harmony_shell_assets.h` did not change, and copies the five
shell files into `desktop/build/shell/`. If the check fails, the web app
sources and the committed header disagree: rebuild `codex_webui` first
(`docs/BUILD.md`), so the app and the hub carry the same bundle.

## Tests

```sh
node --test desktop/test/                     # units: forwarder, discovery, settings, security, catalog client, IPC, preload
(cd desktop && npm run test:e2e)              # Playwright _electron suite against tools/webui-sim
node desktop/test/hub-emu.mjs                 # catalog import POSTs against tools/hub-emu (start it first)
(cd desktop && npm run test:dist)             # the built apps in dist/ (run npm run dist first)
```

`test:dist` checks each built `Melodious.app`: the ad-hoc signature, one
architecture per build, the app's own LC_UUID, an Info.plist with the Local
Network text and no URL scheme, update feed or login item, a shell
byte-identical to `build/shell/`, and the bundled Root & Setup Wizard Python +
`hidapi` runtime (`import hid` and `wizard_bridge.py --action usb-enumerate`).
It then launches the app against the simulator (on loopback, which Local Network
privacy doesn't cover, so the LAN prompt is a manual check), checks the catalog
tab, and verifies the Root & Setup Wizard entry renders on the Connect screen.
It never signs in to Logitech, and it runs with `--use-mock-keychain` so it
doesn't touch your login Keychain. The x64 build runs under Rosetta on Apple
silicon; without Rosetta it is skipped.

None of the tests contact Logitech or a real hub.

## macOS downloads

```sh
cd desktop
npm ci && node node_modules/electron/install.js
npm run dist
(cd dist && shasum -a 256 *.zip *.dmg > SHA256SUMS.txt && cat SHA256SUMS.txt)
npm run test:dist
```

`npm run dist` stages the shell (`scripts/bundle-shell.sh`), stages the
SHA-256-pinned Root & Setup Wizard Python + `hidapi` runtimes for `arm64` and
`x64` (`scripts/stage-wizard-runtime.sh --arch all`), then runs
`electron-builder --mac --arm64 --x64` with `electron-builder.yml`:

| File | What it is |
| --- | --- |
| `dist/Melodious-<version>-arm64.dmg`, `.zip` | Apple silicon |
| `dist/Melodious-<version>-x64.dmg`, `.zip` | Intel |

- Separate builds per architecture, not one universal app, which would
  double the download.
- `scripts/stage-wizard-runtime.sh` downloads, caches (`build/wizard-cache/`,
  gitignored) and verifies by SHA-256:
  - `astral-sh/python-build-standalone` `cpython-3.12.16+20261110`
    (`install_only_stripped` for `aarch64-apple-darwin` and
    `x86_64-apple-darwin`; PSF License 2.0 / BSD-3-Clause, keeping
    `lib/python3.12/LICENSE.txt`).
  - PyPI `hidapi==0.15.0` binary wheels (`cp312` `arm64` and `x86_64`;
    dual-licensed BSD-3-Clause / GPL-3.0, keeping
    `site-packages/hidapi-0.15.0.dist-info/licenses/LICENSE*.txt`, linked only
    against macOS `IOKit`, `CoreFoundation`, `AppKit` and `libSystem.B`).
  `mac.extraResources` copies the matching architecture's `wizard-python`,
  `tools/hub-root` (excluding `.venv`, `tests` and caches), `install_webui.py`
  and `payload/helpers` into `Contents/Resources/` outside `app.asar`.
- Ad-hoc signed (`identity: "-"`, hardened runtime off). No Developer ID,
  no notarisation, so macOS asks before the first launch (see below).
- No update feed, no URL scheme, no login item and no helper beyond
  Electron's own. Update checks (opt-in, `src/updates.js`) read GitHub's
  release list. Install and Restart (`src/self-update.js`) downloads this
  Mac's zip from the release, checks it against the release's
  `SHA256SUMS.txt`, unpacks it next to the app, checks the bundle id,
  version and code seal, swaps the two apps by rename (rolling back on
  failure) and relaunches. It only works for an app in a folder your account
  can write, such as /Applications for an admin. It doesn't work from the
  disk image or a translocated copy, and the app says so.
- `scripts/after-pack.js` gives the main executable its own LC_UUID before
  signing, derived from the bundle id and arch (`scripts/macho-uuid.js`), and
  ad-hoc signs every nested Mach-O binary, dylib and `.so` inside
  `Contents/Resources/wizard-python` (skipping MIPS ELF hub binaries such as
  `dropbearmulti` and `codex_flash_free`) before `electron-builder` seals the
  bundle.
  macOS Local Network privacy identifies apps by that UUID, and Electron's
  prebuilt executable has the same one in every app on the same version, so
  without it macOS files Melodious under another Electron app (often the
  development `Electron.app`), never asks, and every LAN connection to the hub
  fails ([electron/electron#55101](https://github.com/electron/electron/issues/55101)).
  The UUID stays the same across versions, so the permission survives updates.
  `Info.plist` carries `NSLocalNetworkUsageDescription` for the prompt.
- electron-builder downloads the Electron zips and its dmg tools on the
  first build and caches them in `~/Library/Caches/electron-builder`.
- The `.zip.blockmap` files are for auto-update, which the app doesn't
  have. Don't attach them to a release.

## Windows (experimental)

The same app builds for Windows 10 and 11 (x64). It is built and tested on
GitHub's Windows runner (`.github/workflows/desktop-windows.yml`), and
"Reinstall All Files" has been run against a real hub from a Windows PC. A
release carries the two files below beside the Mac files
(`docs/RELEASING.md`).

```sh
cd desktop                 # in Git Bash, from a checkout with LF line endings
npm ci && node node_modules/electron/install.js
npm run dist:win           # needs the pinned bun (tools/ci/install_bun.sh)
npm run test:dist:win
```

| File | What it is |
| --- | --- |
| `dist/Melodious-<version>-win-x64-setup.exe` | Installer, for the current user only (no administrator prompt) |
| `dist/Melodious-<version>-win-x64.zip` | The same app as a folder: unzip and run `Melodious.exe` |

- Unsigned: there is no code-signing certificate, so SmartScreen warns
  before the first launch ("More info", then "Run anyway").
- The hub update uses Windows' own OpenSSH client
  (`System32\OpenSSH\ssh.exe`) and `tar.exe`, and the installer's key in
  `%USERPROFILE%\.ssh\harmony_owner_…`.
- The app doesn't replace itself on Windows. An update notice opens the
  release page, and only for a release that carries the Windows installer.
- Saved sign-ins are encrypted with Windows data protection (DPAPI).
- `dist:win` runs `scripts/stage-wizard-runtime-win.sh` before packaging:
  official `python-3.12.10-embed-amd64.zip` from python.org, pinned by
  SHA-256 (published in its `.sigstore` bundle), cached in gitignored
  `build/wizard-cache/`, staged into `build/wizard-python/win-x64/`.
  3.12.10 is the last official 3.12 Windows binary release; subsequent
  3.12 security releases are source-only. `LICENSE.txt` is retained.
- `python312._pth` allows only the bundled stdlib zip and runtime directory;
  no `site`, registry, user packages or Python environment overrides.
  `wizard_bridge.py` adds its own sibling-module directory explicitly.
  The installer needs only the stdlib, even in a private staging workspace.
- `win.extraResources` bundles that runtime, `tools/hub-root`,
  `install_webui.py` and the three installer helpers outside `app.asar`,
  excluding venvs, tests, caches and Hub ID handoff files. Windows `winhid`
  uses built-in `ctypes`, so no HID wheel or host Python is required.
- `test:dist:win` checks resources, runs installer help with no host Python
  on PATH, invokes real `winhid` USB enumeration via packaged wizard IPC,
  and verifies Welcome and the File-menu wizard entry. No hub is needed.

## Linux from source

Install your distribution's Node.js/Electron runtime dependencies, Python 3
with venv support, OpenSSH client (`ssh`, `ssh-keygen`), `unzip` (hub release
extraction) and libusb. On Debian/Ubuntu the USB library is `libusb-1.0-0`.
Set up the pinned bun and npm dependencies as above, then from the repo root:

```sh
python3 -m venv tools/hub-root/.venv
tools/hub-root/.venv/bin/python -m pip install -r tools/hub-root/requirements-usb.txt
cd desktop
npm start
```

Give your user access to `046d:c129` with the
[USB udev rule](../tools/hub-root/README.md#usb-setup-and-diagnostics),
reload the rules and reconnect the cable. Don't run Electron as root or
disable its sandbox. Linux uses `hidapi` (libusb); the kernel normally
doesn't create a hidraw node for this hub. The source wizard is enabled
automatically and also opens from **File → Set Up a New Harmony Hub…**.
`MELODIOUS_WIZARD_PYTHON` can override the default tool `.venv` interpreter.
No Linux desktop download or bundled Linux Python runtime is published.
The [CLI](../tools/hub-root/README.md) plus `install_webui.py` is an equal
alternative on Windows, Linux and macOS.

The app icon is `resources/icon.png`, made from the Melodious artwork:

```sh
sips -s format bmp Android/branding/melodious-icon-source.jpg --out /tmp/melodious.bmp
python3 -I desktop/scripts/build-icon.py /tmp/melodious.bmp desktop/resources/icon.png
```

## Release

The owner publishes releases. A release:

- is tagged `desktop-v<version>` on the same commit as a hub build, so the
  app's bundle matches that commit's `codex_webui`;
- includes Windows and macOS downloads (Linux remains source-only);
- has the macOS `.dmg`/`.zip` and Windows installer/zip files and checksums attached,
  with the checksums in the notes (`RELEASE_NOTES.md` is the text);
- says which Electron version it ships.

Electron updates arrive only with a new release of the app.

## Opening an unsigned app

- Finder: Control-click Melodious → Open. Where macOS no longer offers Open,
  use System Settings → Privacy & Security → Open Anyway.
- Terminal: `xattr -dr com.apple.quarantine /Applications/Melodious.app`.

Each build has a new ad-hoc signature, so after an update macOS may ask once
more to let Melodious use "Melodious Safe Storage" in your Keychain. Choose
Always Allow. If you deny it, the app can't read its saved sign-ins: sign in
to the hub and Logitech again.
