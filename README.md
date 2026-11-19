<p align="center">
  <img src="desktop/resources/icon.png" alt="Melodious" width="112">
</p>

<h1 align="center">Melodious</h1>

<p align="center">
  Local control for the Logitech Harmony Hub and its remotes, connected to Home Assistant in both directions.<br>
  No Logitech app, account or cloud.
</p>

<p align="center"><a href="#start-here">Start here</a> · <a href="#what-it-does">What it does</a> · <a href="#requirements-and-compatibility">Requirements</a> · <a href="#the-apps">Apps</a> · <a href="#install-update-and-roll-back">Install</a> · <a href="#guides-and-reference">Docs</a></p>

Melodious runs on a rooted Harmony Hub, next to Logitech's own firmware, and takes over the cloud's
jobs: devices, activities and remote sync, plus two-way Home Assistant control. Install it with the
desktop Setup Wizard or the command line, then run it from the hub's web app or the Android and
desktop apps (Windows, Linux, macOS).

**Installing Melodious keeps your setup.** Your existing devices, activities and remote button
bindings stay as they are, including any made with the Logitech app. Melodious runs beside
Logitech's firmware without reflashing it, the hub backs up its setup before every later save, and
the Backup page downloads a full copy. `--turn-off` (experimental; back up first) returns the hub to
Logitech's stock behaviour with nothing of Melodious's deleted
([Install, update and roll back](#install-update-and-roll-back)).

Logitech stopped making Harmony remotes in 2021, yet a stock hub still needs its app and cloud to
change anything. Melodious keeps Logitech's IR, activity and remote engine, with your setup in local
files you can back up, restore and edit without an account.

<p align="center">
  <img src="docs/screenshots/web/remote.png" alt="The web app's remote on a phone" height="480">
  <img src="docs/screenshots/android/remote.png" alt="The Android app's remote" height="480">
  <br><sub>The web app (left) and the Android app (right)</sub>
</p>

<a id="quick-start"></a>

## Start here

New to Melodious? Follow the three guides in order:

1. **[Set up your hub](docs/SETUP_GUIDE.md)** — the cross-platform desktop Setup Wizard roots the
   hub and installs Melodious over Wi-Fi or USB (Windows and macOS releases after `v2.1.0`; Linux
   from source), or use the CLI: [`tools/hub-root/`](tools/hub-root/README.md) + `install_webui`
   ([INSTALL.md](docs/INSTALL.md)).
2. **[Add devices & import IR codes](docs/DEVICES_AND_CODES_GUIDE.md)** — Logitech catalog, IRDB
   and other imports, learning, and the power, input and timing settings activities need.
3. **[Create activities & customize your remote](docs/ACTIVITIES_GUIDE.md)** — the activity wizard,
   button maps, screen and Home Control buttons, and troubleshooting.

Then open `http://<hub-ip>:8080/` on your phone or computer.

## What it does

<table>
<tr><th width="50%">Harmony</th><th width="50%">Home Assistant</th></tr>
<tr><td valign="top">

- **Runs offline:** Logitech's cloud is blocked and the paired remote syncs from the hub.
- **Devices and codes:** Logitech catalog, IRDB, Flipper and Pronto imports, or learn from the
  original remote.
- **Activities:** a setup wizard, power order and inputs, and any command on any button or gesture.
- **Network TVs:** Android and Google TV sets over the network, no IR
  ([ANDROID_TV.md](docs/ANDROID_TV.md)).
- **Bluetooth keyboard:** the hub types and sends TV keys to TVs and streaming boxes
  ([BLUETOOTH_KEYBOARD.md](docs/BLUETOOTH_KEYBOARD.md)).
- **Nintendo Switch 2 wake:** wakes a sleeping Switch 2 over BLE from any activity or remote
  ([SWITCH2_WAKE.md](docs/SWITCH2_WAKE.md)).

</td><td valign="top">

- **Control HA from Harmony:** whole HA devices or single entities become hub devices for
  activities and buttons.
- **Control Harmony from HA:** the hub is a `remote` entity, and every press can trigger an
  automation.
- **Mirror hub devices into HA:** IR, Bluetooth and network devices as switches, selectors and
  buttons.
- **Live state and smart startup:** power, input and volume shown in the apps, and no redundant
  power or input commands.
- Setup and details: **[HOME_ASSISTANT.md](docs/HOME_ASSISTANT.md)**.

</td></tr>
</table>

How the pieces fit, and how presses and gestures are timed: [ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements and compatibility

- **Harmony Hub** on firmware 4.15.600, rooted by the Setup Wizard or the bundled root tool.
- **A computer** to install from: Windows, Linux or macOS (Desktop app, PowerShell or Python 3),
  or Docker/Unraid ([UNRAID.md](UNRAID.md)).
- **A trusted home network:** the web app is plain HTTP ([SECURITY.md](docs/SECURITY.md)).
- **Home Assistant** (optional), with [HACS](https://hacs.xyz/).
- **Android 8.0+** or the **Desktop app** (optional).

Validated on the Harmony Touch and Smart Control; the Companion and 950 work, a user reports the
Elite works, and other remotes that pair with the hub are expected to. Remote details, flash and
SSH-key needs, and tested hardware: **[COMPATIBILITY.md](docs/COMPATIBILITY.md)**.

<a id="the-macos-app"></a>

## The apps

One hub, three apps, one design ([DESIGN.md](DESIGN.md)):

- **Web app** — served by the hub at `http://<hub-ip>:8080/`, in any browser on your network:
  [MELODIOUS_WEB_UI.md](docs/MELODIOUS_WEB_UI.md).
- **Android app** — the release's `melodious-<version>.apk`, adding a touchpad, sleep timer, phone
  extras and catalog lookup: [Android/README.md](Android/README.md) ·
  [ANDROID_CATALOG.md](docs/ANDROID_CATALOG.md).
- **Desktop app (Windows, Linux, macOS)** — the web app plus the Setup Wizard and Logitech catalog
  lookup: [DESKTOP_APP.md](docs/DESKTOP_APP.md) · [desktop/README.md](desktop/README.md).
- **iOS / iPadOS app (experimental)** — native SwiftUI remote for iPhone and iPad, sideloaded via
  AltStore/SideStore (`melodious-ios-<version>.ipa`) or Xcode: [IOS_APP.md](docs/IOS_APP.md).

## Install, update and roll back

The guided path is the desktop Setup Wizard: **[SETUP_GUIDE.md](docs/SETUP_GUIDE.md)**. From the
command line, root the hub with [`tools/hub-root/`](tools/hub-root/README.md), then from the
unzipped [release](https://github.com/schlambos/harmony-hub-control/releases/latest) or a clone:

```bash
python3 install_webui.py --hub-host <hub-ip> --hub-id <hub-id>
```

On Windows, double-click `Install_Harmony_Control.cmd` or run
`.\install_webui.ps1 -HubHost <hub-ip> -HubId <hub-id>`.

Re-run the installer (or use the desktop app's **Update hub…**) to update.
**[INSTALL.md](docs/INSTALL.md)** covers every flag, a full flash, `--turn-off`/`--turn-on`
(experimental), rolling back and Docker/Unraid.

## Guides and reference

| Category | Documents |
| --- | --- |
| **User guides** | [Setup Guide](docs/SETUP_GUIDE.md) · [Devices & codes](docs/DEVICES_AND_CODES_GUIDE.md) · [Activities](docs/ACTIVITIES_GUIDE.md) · [Install, update, roll back](docs/INSTALL.md) · [Home Assistant](docs/HOME_ASSISTANT.md) · [Web app](docs/MELODIOUS_WEB_UI.md) · [Android app](Android/README.md) · [Android catalog](docs/ANDROID_CATALOG.md) · [Desktop app](docs/DESKTOP_APP.md) · [iOS app (experimental)](docs/IOS_APP.md) · [Bluetooth keyboard](docs/BLUETOOTH_KEYBOARD.md) · [Network TVs](docs/ANDROID_TV.md) · [Remote backgrounds](docs/REMOTE_BACKGROUNDS.md) · [Docker and Unraid](UNRAID.md) |
| **Remotes & hardware** | [Compatibility](docs/COMPATIBILITY.md) · [Home control buttons](docs/HOME_CONTROL_BUTTONS.md) · [Two-screen remotes](docs/TWO_SCREEN_REMOTES.md) · [Multiple remotes](docs/MULTI_REMOTE.md) · [Fresh hub activation](docs/FRESH_HUB_ACTIVATION.md) · [Root tool](tools/hub-root/README.md) · [USB Ethernet](docs/USB_ETHERNET.md) |
| **Technical reference** | [Architecture](docs/ARCHITECTURE.md) · [HTTP API](docs/API.md) · [Protocols](docs/PROTOCOLS.md) · [Security](docs/SECURITY.md) · [Touch editor](docs/TOUCH_EDITOR.md) · [Design system](DESIGN.md) · [Catalog CLI](tools/catalog/README.md) |
| **Development** | [Building](docs/BUILD.md) · [CI](docs/CI.md) · [CI/build/release design](docs/CI_BUILD_RELEASE_DESIGN.md) · [Desktop app source](desktop/README.md) · [Simulator](tools/webui-sim/README.md) · [Hub emulator](tools/hub-emu/README.md) · [Contributing](CONTRIBUTING.md) |

No hub is needed to develop: run the simulator with `node tools/webui-sim/server.mjs`
(`http://127.0.0.1:8787/#remote`), or the real binaries under QEMU with the hub emulator.

## Contributing, credits and license

Contributions are welcome, and so are reports from owners of remotes other than the Harmony Touch.
Keep changes small and scoped, and add a short test note. Never commit SSH keys, MQTT passwords,
tokens, hub backups, firmware dumps or rooting tools. Read [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/SECURITY.md](docs/SECURITY.md) first. This repository contains no private keys or personal
backups.

- **Rooting the hub:** [harmony-hub-root](https://github.com/Ripthulhu/harmony-hub-root) by
  Ripthulhu and contributors, bundled in [`tools/hub-root/`](tools/hub-root/README.md) (see
  [PROVENANCE.md](tools/hub-root/PROVENANCE.md)).
- **Home Assistant integration:**
  [schlambos/ha-melodious](https://github.com/schlambos/ha-melodious) (0.7.1+ for mirror
  devices).
- **Third-party code** (each with its licence):
  - Material Icons (Apache-2.0): [`third_party/material-icons/`](third_party/material-icons/);
  - Dropbear SSH: [`third_party/dropbear-2025.89/`](third_party/dropbear-2025.89/);
  - BusyBox 1.37.0 (GPL-2.0), built into `busybox-extra`, with its patch, configuration and how to
    rebuild it: [`third_party/busybox-1.37.0/`](third_party/busybox-1.37.0/);
  - BearSSL 0.6 (MIT), built into `codex_androidtv` and `codex_webos`: [`third_party/bearssl-0.6/`](third_party/bearssl-0.6/);
  - the Linux kernel 2.6.31 (GPL-2.0), from Logitech's published hub kernel archive, built into
    `asix.ko` with two upstream Linux 3.1 patches by Marek Vasut; config, patches and how to rebuild:
    [`third_party/linux-2.6.31-harmony/`](third_party/linux-2.6.31-harmony/README.md).

**Contributors.** Thank you to everyone who has contributed code, pull requests, testing and issue
reports so far: [@Ripthulhu](https://github.com/Ripthulhu),
[@s7thamon](https://github.com/s7thamon), [@danielvijge](https://github.com/danielvijge),
[@Bergasha](https://github.com/Bergasha), [@apnar](https://github.com/apnar),
[@roosen5](https://github.com/roosen5), [@NemoN](https://github.com/NemoN),
[@Tezzlicious](https://github.com/Tezzlicious), [@AXEBro](https://github.com/AXEBro),
[@dramatic-paws](https://github.com/dramatic-paws), [@sumps71](https://github.com/sumps71) and
[@boomfunks](https://github.com/boomfunks).

**License**: see [LICENSE](LICENSE). Melodious code, meaning every change after this fork's upstream
commit `d87ceba`, is under the MIT License. Code from the upstream project,
Ripthulhu/harmony-hub-control, is all rights reserved by its authors. Third-party components keep
their own licences.
