# Melodious

Melodious keeps a Logitech Harmony Hub working on your own network, with no
Logitech app, account or cloud. It has three parts:

- **Melodious on the hub**: software you install on a rooted Harmony Hub. It
  serves the web app and an HTTP API, saves your changes to activities and
  devices on the hub itself, adds a Bluetooth keyboard, an MQTT bridge and a
  Wi-Fi recovery network, and blocks the Logitech cloud.
- **The Melodious web app**: a remote and setup app that the hub serves at
  `http://<hub-ip>:8080/`, for phones and computers. It works fully offline.
- **The Melodious Android app**: a native remote for Android 8.0 and later that
  connects to the same hub.

Melodious is for owners of a Harmony Hub that is already rooted with
[harmony-hub-root](https://github.com/Ripthulhu/harmony-hub-root) who want the
hub, and the Harmony remote paired with it, to run entirely on their local
network. This repository contains no rooting tools, exploits, private keys or
personal backups.

<p align="center">
  <img src="docs/screenshots/web/remote.png" alt="The web app's remote on a phone" height="540">
  <img src="docs/screenshots/android/remote.png" alt="The Android app's remote" height="540">
  <br><sub>The web app (left) and the Android app (right), on a real hub. Network addresses and the Wi-Fi name are masked in every screenshot.</sub>
</p>

## Quick start

1. Root the hub with harmony-hub-root. Keep the SSH key it creates
   (`harmony_owner_*` in `~/.ssh`) and the numeric Hub ID it prints.
2. Download `melodious-hub-<version>.zip` from the
   [latest release](https://github.com/schlambos/harmony-hub-control/releases/latest)
   and unzip it, or clone this repository. From a computer on the same
   network, install Melodious:

   ```bash
   python3 install_webui.py --hub-host <hub-ip> --hub-id <hub-id>
   ```

   On Windows, double-click `Install_Harmony_Control.cmd`, or in PowerShell:

   ```powershell
   .\install_webui.ps1 -HubHost <hub-ip> -HubId <hub-id>
   ```

   The first install turns on the cloud blocker, leaves MQTT off, and reboots
   the hub once.
3. Open `http://<hub-ip>:8080/` on your phone or computer.

## Requirements

| Requirement | Details |
| --- | --- |
| Harmony Hub | Rooted with [harmony-hub-root](https://github.com/Ripthulhu/harmony-hub-root). Melodious doesn't root hubs. |
| SSH key | The root tool's private key, `harmony_owner_*`, in `~/.ssh` (`%USERPROFILE%\.ssh` on Windows). |
| Hub ID | The numeric Hub ID the root tool prints. Don't guess it: Melodious sends it with every command to the hub's engine. |
| Install computer | Windows with PowerShell, Linux or macOS with Python 3, or a Docker or Unraid host. The installer needs only `ssh`, not `scp` or `sftp`. |
| Network | A trusted home network. The web app is plain HTTP. |
| Browser | A current browser on a phone, tablet or computer. |
| Android app (optional) | A phone with Android 8.0 or later, and a computer with JDK 17 or 21 and the Android SDK to build the app. |

## Install and first run

### Install

The first run on a hub writes Melodious's configuration: the Hub ID, the
cloud blocker (on) and the MQTT settings (off, unless you pass the `--mqtt-*`
options). Later runs upgrade in place and keep that configuration;
`--clean-install` writes it from scratch.

Each run:

1. finds your key (`--key-path`, or the newest `harmony_owner_*` key in
   `~/.ssh`);
2. uploads every file to a private folder in the hub's RAM
   (`/var/volatile/codex-install-*`), checks each MD5 and compares it with the
   installed copy, so unchanged files aren't written;
3. copies the files it will change into RAM and writes a handoff backup to
   `/data/codex-backups/webui-handoff-*`;
4. writes each changed file next to its target as `<file>.codex-new` and
   verifies it, then renames the copies into place, `codex_webui` last. If
   flash runs out, it removes the copies and nothing in use changes; if a
   later step fails, it puts the originals back;
5. restarts the web app and the Bluetooth keyboard service, registers the hub
   plugins and waits for the web app to answer;
6. reboots the hub if the cloud-blocker files changed, so they take effect.

| Python | PowerShell | What it does |
| --- | --- | --- |
| `--preflight-only` | `-PreflightOnly` | Stages and compares in RAM, prints what would change and a verdict, and writes nothing to flash. |
| `--clean-install` | `-CleanInstall` | Writes the configuration from scratch. |
| `--hub-id` | `-HubId` | The Hub ID. Without it, the installer reads it from the hub, then from the root tool's files in `~/.harmony-hub/`. |
| `--no-prompt` | `-NoPrompt` | Fails instead of asking for a missing value. |
| `--mqtt-broker`, `--mqtt-port`, `--mqtt-user`, `--mqtt-password`, `--mqtt-base-topic`, `--mqtt-discovery-prefix`, `--mqtt-client-id`, `--mqtt-disabled` | `-MqttBroker` … `-MqttDisabled`, same names | Set up the MQTT bridge. Without them, an upgrade keeps the hub's MQTT settings. |
| `--no-apply-cloud-restart` | `-NoApplyCloudRestart` | Skips the reboot after the cloud-blocker files change. |
| `--skip-cloud-suppression` | `-SkipCloudSuppression` | Leaves the hub's `netservicestarter.lua` as it is. With a clean install, it also writes the cloud blocker as off. |

`python3 install_webui.py --help` lists every option.

**Updating.** Get the latest copy of this repository and run the installer
again. On Windows, `Install_Harmony_Control.cmd` runs `install_webui.ps1`
with your `harmony_owner_*` key and asks for the rest.

**Rolling back.** In PowerShell, `restore_backup.ps1` restores the boot script,
`netservicestarter.lua`, the SSH wrappers, the Hub ID and the MQTT settings
from the newest handoff backup, then tells you to reboot the hub:

```powershell
.\restore_backup.ps1 -HubHost <hub-ip> -KeyPath "$env:USERPROFILE\.ssh\<key-file>"
```

**Docker and Unraid.** The image runs the same installer with settings from
environment variables, then stays up as a small proxy to the hub's web app.
See [UNRAID.md](UNRAID.md) and `compose.yaml`.

### First run

Open `http://<hub-ip>:8080/`. The web app shows the activities and devices
already on the hub, including any set up with the Logitech app before rooting.

- With nothing running, the Remote tab shows "Everything's off" and a card for
  each activity. Tap one to start it.
- To build an activity, open Activities and tap **+** (New activity).
- To add a device, open Devices and tap **+** (Add a device), then use Learn a
  button or Import codes on its Commands tab.
- To type on a TV, pair the hub as a keyboard in Settings → Bluetooth
  keyboard.

## The web app

The hub serves the web app from `codex_webui` itself: one page, one script and
one stylesheet, plus the advanced editor's script and stylesheet when you open
it. Nothing loads from the internet. There are four tabs, Remote, Activities,
Devices and Settings: a bottom bar on phones and a navigation rail on screens
840 px and wider. Every screen has its own address, such as `#devices/<id>`,
so you can bookmark it.

<p align="center"><img src="docs/screenshots/web/desktop-remote.png" alt="The web app on a computer, with the navigation rail and More keys beside the remote"><br><sub>On a computer: the navigation rail, the remote and More keys beside it</sub></p>

### Remote

- **Nothing running**: "Everything's off" and one card per activity.
- **An activity running**: its remote. Tap the activity's name to switch to
  another one or to "Turn everything off". The power button turns everything
  off at once, without asking, like the physical remote.
- **Buttons**: the transport row, the D-pad and OK, the VOL and CH rockers,
  and Back, Menu, Exit and Mute.
- **Keyboard**: text and keys sent to the TV through the hub's Bluetooth
  keyboard.
- **More keys**: the activity's on-screen buttons, Guide, Info, DVR, Record,
  Stop, the colour keys, the number pad, "All device commands…" and the send
  log. On screens 1100 px and wider it sits beside the remote.
- **Fix it** (the wrench): resends a device's power or input command when
  something didn't turn on or switch input.
- A status line shows what each key sends, as "key → device · command".

Keys fire when you lift your finger, and sliding off cancels. A key with a
hold action fires it after 500 ms. Keys the activity doesn't use are dimmed.

<table>
<tr><td align="center"><img src="docs/screenshots/web/remote.png" alt="The web app's remote with an activity running" width="200"><br><sub>Remote</sub></td><td align="center"><img src="docs/screenshots/web/remote-more-keys.png" alt="The More keys sheet with on-screen buttons, colour keys and the number pad" width="200"><br><sub>More keys</sub></td><td align="center"><img src="docs/screenshots/web/remote-fix-it.png" alt="The Fix it sheet with power and input resends for each device" width="200"><br><sub>Fix it</sub></td><td align="center"><img src="docs/screenshots/web/remote-switch.png" alt="The Switch activity sheet with Turn everything off" width="200"><br><sub>Switch activity</sub></td></tr>
</table>

<details>
<summary>More screenshots</summary>

<table>
<tr><td align="center"><img src="docs/screenshots/web/remote-keyboard.png" alt="The Keyboard tab for typing on the TV" width="200"><br><sub>Keyboard</sub></td></tr>
</table>

</details>

### Activities

- The running activity's card, with Open remote and Turn off.
- A row for each other activity, with Start and a ⋮ menu: Edit, Set up
  buttons, Try the buttons (its remote, without starting it), Advanced editor,
  Move up, Move down and Delete.
- **+** opens the setup wizard: Name, Devices (which device does each job, and
  how long to wait after each one turns on), Inputs, Buttons (36 keys, each
  with a press and a hold action) and Review.
- The advanced editor covers what the wizard doesn't: roles, the button maps
  for each remote surface, and the activity's JSON.

<table>
<tr><td align="center"><img src="docs/screenshots/web/activities.png" alt="The Activities tab with the running activity's card" width="200"><br><sub>Activities</sub></td><td align="center"><img src="docs/screenshots/web/activity-menu.png" alt="An activity's menu: Edit, Set up buttons, Try the buttons and more" width="200"><br><sub>Activity menu</sub></td><td align="center"><img src="docs/screenshots/web/wizard-devices.png" alt="The setup wizard's Devices step" width="200"><br><sub>Wizard: Devices</sub></td><td align="center"><img src="docs/screenshots/web/wizard-buttons.png" alt="The setup wizard's Buttons step" width="200"><br><sub>Wizard: Buttons</sub></td></tr>
</table>

<details>
<summary>More screenshots</summary>

<table>
<tr><td align="center"><img src="docs/screenshots/web/wizard-name.png" alt="The setup wizard's Name step" width="200"><br><sub>Wizard: Name</sub></td><td align="center"><img src="docs/screenshots/web/wizard-inputs.png" alt="The setup wizard's Inputs step" width="200"><br><sub>Wizard: Inputs</sub></td><td align="center"><img src="docs/screenshots/web/wizard-review.png" alt="The setup wizard's Review step" width="200"><br><sub>Wizard: Review</sub></td></tr>
</table>

<p align="center"><img src="docs/screenshots/web/desktop-editor.png" alt="The advanced editor on a computer"><br><sub>Advanced editor</sub></p>

</details>

### Devices

- A list you can search by device or command, **+** (Add a device), and Tools
  → IR lab, a scratch device for trying codes.
- A device page with Remote and Commands tabs. Its remote sends straight to the
  device, outside any activity. The ⋮ menu has Edit details and Delete device;
  a device that is still in use can't be deleted, and the page says where it's
  used.
- On the Commands tab, tap a command to send it, or use its ⋮ to edit or
  delete it.
  - **Learn a button**: point the original remote at the hub, press the
    button, then test and save it.
  - **Import codes**: Find codes (search IRDB, or open a code file), Paste
    (IRDB CSV, `name|mode|code` lines or Pronto hex, plus Fetch from
    RemoteCentral) or Type a code.
  - **Send all commands**: sends every command in turn to find the ones the
    device answers to, with a dry run, the gap and commands per request, Stop
    and a run log.
- **Device settings** (the tune icon): power (separate On and Off commands,
  one toggle, or none), turning on (warm-up time, Always on, Keep on between
  activities), inputs and timing.

<table>
<tr><td align="center"><img src="docs/screenshots/web/devices.png" alt="The Devices tab with search, Add a device and the IR lab" width="200"><br><sub>Devices</sub></td><td align="center"><img src="docs/screenshots/web/device-commands.png" alt="A device's Commands tab with Learn a button and Import codes" width="200"><br><sub>Commands</sub></td><td align="center"><img src="docs/screenshots/web/import-find.png" alt="The Import codes sheet on Find codes" width="200"><br><sub>Import codes</sub></td><td align="center"><img src="docs/screenshots/web/device-settings.png" alt="A device's settings: power, turning on, inputs and timing" width="200"><br><sub>Device settings</sub></td></tr>
</table>

<details>
<summary>More screenshots</summary>

<table>
<tr><td align="center"><img src="docs/screenshots/web/device-remote.png" alt="A device's own remote" width="200"><br><sub>Device remote</sub></td><td align="center"><img src="docs/screenshots/web/learn.png" alt="The Learn a button sheet" width="200"><br><sub>Learn a button</sub></td><td align="center"><img src="docs/screenshots/web/import-paste.png" alt="The Import codes sheet on Paste, with Fetch from RemoteCentral" width="200"><br><sub>Import codes: Paste</sub></td><td align="center"><img src="docs/screenshots/web/send-all.png" alt="The Send all commands page" width="200"><br><sub>Send all commands</sub></td></tr>
<tr><td align="center"><img src="docs/screenshots/web/ir-lab.png" alt="The IR lab page" width="200"><br><sub>IR lab</sub></td></tr>
</table>

<p align="center"><img src="docs/screenshots/web/desktop-devices.png" alt="A device page on a computer, with More keys beside the remote"><br><sub>A device page on a computer</sub></p>

</details>

### Settings

- **Hub**: whether the hub is connected, and its activity and device counts.
- **Bluetooth keyboard**: pair the hub with a TV, streaming box or computer as
  a keyboard, connect, send keys and text, and keep saved devices with
  keystroke scripts.
- **MQTT**: the broker, Home Assistant discovery and the topics.
- **Wi-Fi**: the network the hub joins. Changes take effect after a reboot.
- **Backup**: the full owner bundle, ten single exports, and restore from a
  file.
- **System**: status and logs, the cloud blocker, the time zone, sign-in,
  software update, Home Assistant discovery and reboot.

<table>
<tr><td align="center"><img src="docs/screenshots/web/settings.png" alt="The Settings tab" width="200"><br><sub>Settings</sub></td><td align="center"><img src="docs/screenshots/web/bluetooth.png" alt="The Bluetooth keyboard page" width="200"><br><sub>Bluetooth</sub></td><td align="center"><img src="docs/screenshots/web/backup.png" alt="The Backup page" width="200"><br><sub>Backup</sub></td><td align="center"><img src="docs/screenshots/web/system.png" alt="The System page" width="200"><br><sub>System</sub></td></tr>
</table>

<details>
<summary>More screenshots</summary>

<table>
<tr><td align="center"><img src="docs/screenshots/web/mqtt.png" alt="The MQTT page" width="200"><br><sub>MQTT</sub></td><td align="center"><img src="docs/screenshots/web/wifi.png" alt="The Wi-Fi page" width="200"><br><sub>Wi-Fi</sub></td></tr>
</table>

</details>

## The Android app

The app is in [`Android/`](Android/): Kotlin and Jetpack Compose, package
`app.melodious`, for Android 8.0 (API 26) and later. Download
`melodious-<version>.apk` from the
[latest release](https://github.com/schlambos/harmony-hub-control/releases/latest)
and open it on your phone (Android asks you to allow installs from your browser
or file manager), or build it from source. It isn't in an app store.

```bash
Android/deploy_to_phone.sh                               # phone on USB, or already paired with adb
Android/deploy_to_phone.sh --wireless <phone-ip>:<port>  # Android wireless debugging
Android/deploy_to_phone.sh --build-only                  # build the APK and run the tests only
```

The script expects macOS with Homebrew: it uses Homebrew's JDK 17 or 21 and
installs the Android command-line tools and `adb` if they're missing. It runs
the unit tests, builds a debug APK and installs it.

On first start the app looks for the hub on your network (SSDP, then a scan of
the phone's subnet on port 8080), or you type the hub's address. It has the
same four tabs as the web app and uses the same hub API on port 8080. It also
connects to the hub's own WebSocket on port 8088 for live state, press and
hold, and the hub's sleep timer and help.

What the app adds:

- **Touchpad**: a remote mode where you swipe to move and tap for OK.
- **Press and hold**: volume, channel and the D-pad repeat while held, and the
  hub pushes state changes to the app.
- **Sleep timer**: the hub turns everything off after 15 minutes to 2 hours,
  even if the phone is off.
- **Fix it → Resend everything**: the hub checks each device and resends only
  the power and input commands it needs.
- **Phone volume keys**: they control the activity's volume while the app is
  open.
- **Start & end**: an activity editor step for the order devices turn on and
  off, and for commands to send when the activity starts or ends.
- **On-screen buttons**: an editor for an activity's on-screen buttons and
  sequences.
- **Phone extras**: a Quick Settings tile ("Melodious: Turn off"), a
  home-screen widget that starts activities or turns everything off, and
  lock-screen controls (volume, play and pause, turn off) while something is
  on.
- **Links**: `melodious://hub/poweroff` and `melodious://hub/activity/<id>`,
  which act when the app is already connected.
- **SSH recovery** (Settings → Advanced): with your SSH key, check the hub,
  clear the web sign-in or restart Melodious's services. The key isn't saved.

Only the web app adds and deletes devices and has Edit details, device
inputs, Find codes, Fetch from RemoteCentral, Type a code, the IR lab, the
advanced editor, activity reordering, and the Wi-Fi, MQTT, Backup and System
pages.

<table>
<tr><td align="center"><img src="docs/screenshots/android/remote.png" alt="The Android app's remote with an activity running" width="200"><br><sub>Remote</sub></td><td align="center"><img src="docs/screenshots/android/touchpad.png" alt="The Touchpad remote mode" width="200"><br><sub>Touchpad</sub></td><td align="center"><img src="docs/screenshots/android/sleep-timer.png" alt="The Sleep timer sheet" width="200"><br><sub>Sleep timer</sub></td><td align="center"><img src="docs/screenshots/android/fix-it.png" alt="The Fix it sheet with Resend everything" width="200"><br><sub>Fix it</sub></td></tr>
<tr><td align="center"><img src="docs/screenshots/android/editor-start-end.png" alt="The activity editor's Start and end step" width="200"><br><sub>Start &amp; end</sub></td><td align="center"><img src="docs/screenshots/android/on-screen-buttons.png" alt="The on-screen buttons editor" width="200"><br><sub>On-screen buttons</sub></td><td align="center"><img src="docs/screenshots/android/activities.png" alt="The Activities tab" width="200"><br><sub>Activities</sub></td><td align="center"><img src="docs/screenshots/android/settings.png" alt="The Settings tab with the phone options" width="200"><br><sub>Settings</sub></td></tr>
</table>

<details>
<summary>More screenshots</summary>

<table>
<tr><td align="center"><img src="docs/screenshots/android/everything-off.png" alt="The Remote tab with nothing running" width="200"><br><sub>Everything's off</sub></td><td align="center"><img src="docs/screenshots/android/keyboard.png" alt="The Keyboard remote mode" width="200"><br><sub>Keyboard</sub></td><td align="center"><img src="docs/screenshots/android/more-keys.png" alt="The More keys sheet" width="200"><br><sub>More keys</sub></td><td align="center"><img src="docs/screenshots/android/switch-activity.png" alt="The Switch activity sheet with Sleep timer" width="200"><br><sub>Switch activity</sub></td></tr>
<tr><td align="center"><img src="docs/screenshots/android/activity-menu.png" alt="An activity's menu" width="200"><br><sub>Activity menu</sub></td><td align="center"><img src="docs/screenshots/android/editor-name.png" alt="The activity editor's Name step" width="200"><br><sub>Editor: Name</sub></td><td align="center"><img src="docs/screenshots/android/editor-devices.png" alt="The activity editor's Devices step" width="200"><br><sub>Editor: Devices</sub></td><td align="center"><img src="docs/screenshots/android/editor-inputs.png" alt="The activity editor's Inputs step" width="200"><br><sub>Editor: Inputs</sub></td></tr>
<tr><td align="center"><img src="docs/screenshots/android/editor-buttons.png" alt="The activity editor's Buttons step" width="200"><br><sub>Editor: Buttons</sub></td><td align="center"><img src="docs/screenshots/android/editor-button-picker.png" alt="Picking the command for a button" width="200"><br><sub>Button picker</sub></td><td align="center"><img src="docs/screenshots/android/devices.png" alt="The Devices tab" width="200"><br><sub>Devices</sub></td><td align="center"><img src="docs/screenshots/android/device-remote.png" alt="A device's own remote" width="200"><br><sub>Device remote</sub></td></tr>
<tr><td align="center"><img src="docs/screenshots/android/device-commands.png" alt="A device's Commands tab" width="200"><br><sub>Commands</sub></td><td align="center"><img src="docs/screenshots/android/learn.png" alt="The Learn a button sheet" width="200"><br><sub>Learn a button</sub></td><td align="center"><img src="docs/screenshots/android/import.png" alt="The Import codes sheet" width="200"><br><sub>Import codes</sub></td><td align="center"><img src="docs/screenshots/android/device-settings.png" alt="A device's power settings" width="200"><br><sub>Device settings</sub></td></tr>
<tr><td align="center"><img src="docs/screenshots/android/device-settings-timing.png" alt="A device's turning-on and timing settings" width="200"><br><sub>Device timing</sub></td><td align="center"><img src="docs/screenshots/android/bluetooth.png" alt="The Bluetooth keyboard page" width="200"><br><sub>Bluetooth keyboard</sub></td><td align="center"><img src="docs/screenshots/android/advanced.png" alt="The Advanced page with hub status and the IR sweep lab" width="200"><br><sub>Advanced</sub></td><td align="center"><img src="docs/screenshots/android/ssh-recovery.png" alt="SSH recovery on the Advanced page" width="200"><br><sub>SSH recovery</sub></td></tr>
</table>

</details>

## Features

### Offline by default

With the cloud blocker on, as a clean install sets it:

- the hub doesn't start Logitech's cloud tasks (cloudapi, PubNub, the package
  manager), and requests to Logitech and PubNub hosts fail;
- the WAN default route is removed and kept off, while LAN and multicast
  routes stay, so local control, discovery and MQTT keep working;
- the paired Harmony remote gets its setup from the hub's own files when it
  syncs, so a cloud copy can't overwrite your changes;
- the hub still sets its clock over NTP (pool.ntp.org, time.google.com,
  time.cloudflare.com), through a temporary route for each query;
- activity and device-settings changes are refused unless the blocker is on,
  so a local edit can't race a cloud sync.

System → Cloud egress turns the blocker on. The web app has no control to turn
it off.

### Activities and your Harmony remote

Every change to activities, from the wizard, the advanced editor, a reorder or
a delete, is one transaction on the hub. It checks the activities, button maps
and command maps against the hub's devices, backs up the hub's resource files,
writes the three activity files, reads them back and restores the old ones if
anything fails. If the setup changed since the page loaded, the hub refuses
the save and the page loads the latest copy.

Each save is published as a fresh configuration revision for the paired
Harmony remote, which picks it up the next time it syncs with the hub. The
advanced editor's "Refresh remote locally" publishes the stored setup again
without changing it.

### IR codes

- Learn codes from the original remote; import IRDB codes, Flipper `.ir`
  files, `name|mode|code` lines, Pronto hex or RemoteCentral pages; or type a
  keycode, NEC or raw code.
- IRDB search and preview run in your browser and fetch from the jsDelivr CDN
  only when you click Search IRDB or Preview. The hub fetches a RemoteCentral
  page only when you click Fetch, and that needs a route to the internet,
  which the cloud blocker removes.
- Limits: 32 devices, 2,048 commands per device and 1,024 commands per import.
  The hub backs up its device list before each write.

### Bluetooth keyboard

The hub pairs with a TV, streaming box or computer as a Bluetooth keyboard,
with its own pairing agent and the link keys kept on the hub. The web app and
the Android app then type text and send keys through it, and the Bluetooth
page runs saved keystroke scripts.

### MQTT and Home Assistant

The MQTT bridge publishes the hub's status, the current activity and device
counts, and Home Assistant discovery (an activity selector, sensors and a
power-off button). It takes activity changes, IR commands and raw hub-engine
commands on its topics, under `harmony/hub` by default. Set it up at install
time or in Settings → MQTT; the page never shows the stored password.

### Backup and restore

Settings → Backup downloads ten single exports (devices, functions, protocols,
activities, button maps, automation, MQTT, Wi-Fi, cloud blocker and Bluetooth)
or one owner bundle with all ten. A restore is checked before it runs and asks
you to confirm. The hub also keeps its own backups:

| Backups | Folder | Kept |
| --- | --- | --- |
| Resource backups (`YYYYMMDD_HHMMSS`), taken before each write | `/data/codex/resource-backups` | Newest 5 |
| Software-update backups | `/data/codex/update-backups` | Newest 3 |
| Installer handoffs (`webui-handoff-*`) | `/data/codex-backups` | Newest 3 |

Only folders with those exact names are ever removed.

### Wi-Fi and recovery

Settings → Wi-Fi changes the network the hub joins. If the hub can't join it,
hold the hub's reset button: the hub starts an open recovery network,
`Harmony-Recovery-xxxxxx`, with a setup page at `http://192.168.76.1/` where
you enter the Wi-Fi details again.

### Sign-in

System → Sign-in adds an optional username and password (HTTP Basic) to the
web app and its API. It's off by default. If you're locked out, the Android
app's SSH recovery clears it, or you can delete `/data/codex/webui_auth.conf`
over SSH and restart `codex_webui`.

## How it works

```text
Phone or computer on your network
  ├─ web app ───► http://<hub-ip>:8080   codex_webui, one static C binary
  │                 ├─ the embedded web app and the JSON API
  │                 ├─ codex_hbus ──► the hub's activity engine (activities, IR, learning)
  │                 ├─ codexactivity.lua ──► the hub's resource manager (activity and device saves)
  │                 ├─ codex_hal_ltcp, codex_bthid_keyboard, codex_bt_pair_agent ──► Bluetooth
  │                 └─ JSON files on the hub's flash (/data)
  └─ Android app ► the same API on 8080, plus the hub's WebSocket on 8088

Also on the hub: netservicestarter.lua (cloud blocker and local sync),
offline_egress_guard.sh (WAN route), codexmqtt.lua (MQTT bridge),
recovery_ap.sh (recovery network)
```

- **Web app**: plain JavaScript modules in `tools/webui-sim/public/`, with no
  framework. `tools/package_harmony_shell.sh` bundles them with bun into
  `payload/source/harmony_shell_assets.h`, which is compiled into
  `codex_webui`.
- **Server**: `payload/source/codex_webui.c`, built with Zig as a static,
  stripped MIPS32 big-endian binary. It listens on port 8080 and forks for
  each request.
- **Hub plugins**: `codexactivity.lua` writes activities and device settings
  through the hub's resource manager and reloads its engine; `codexmqtt.lua`
  runs the MQTT bridge.
- **Installed files**: `payload/bin/MANIFEST.txt` lists the eight binaries,
  with their MD5s, that go to `/data/codex/bin/`.
- **Data**: activities, devices and settings stay in the hub's own JSON files
  under `/data`; the backups download them.

## Safety and limits

- **Trusted network only.** The web app is plain HTTP on every interface of
  the hub. Sign-in is optional and off by default, and the server has no
  protection against cross-site requests. Never expose the hub to the
  internet.
- **Exports contain secrets.** The MQTT, Wi-Fi and owner-bundle exports
  include your MQTT password and Wi-Fi key. Keep them safe.
- **MQTT is a control channel.** Anyone who can publish to the bridge's
  topics can start activities, send IR and run hub-engine commands, and the
  bridge doesn't use TLS. Use a broker with authentication.
- **Update with the installer.** System → Software update applies only an
  update already staged on the hub, and updates aren't signed. Update by
  running the installer from a copy of this repository you trust.
- **Some actions interrupt the room.** Wi-Fi changes, reboots, restores and
  updates can take the hub offline for a while; the web app asks you to
  confirm them.
- **The hub is small.** Flash and RAM are limited. Download a backup before a
  big import.
- **Offline is the supported mode.** Using the Logitech app or cloud sync
  alongside Melodious isn't supported and can overwrite local changes.
- **Hand-edited activity JSON must follow the remote's rules.** For example,
  an activity button without an action makes the paired remote stop
  responding until it's power-cycled. The wizard and the advanced editor
  follow these rules; [docs/API.md](docs/API.md) lists them.
  `tools/activity_graph_repair.mjs` checks a hub's activities and proposes
  repairs, and writes only with `--apply`:

  ```bash
  node tools/activity_graph_repair.mjs --base-url http://<hub-ip>:8080
  ```

## Development and testing

You don't need a hub to work on the web app.

**Simulator**: an in-memory hub with fixture data, on loopback only. It never
contacts a hub and never sends IR, so Learn a button, Test and sends need the
real hub.

```bash
node tools/webui-sim/server.mjs
# then open http://127.0.0.1:8787/#remote
```

**Hub emulator**: [`tools/hub-emu/`](tools/hub-emu/README.md) runs the real
`codex_webui` and `codex_hbus` binaries under QEMU in Docker, against an
emulated engine.

**Tests**:

```bash
node --test tools/webui-sim/test/                 # web app models and hub contracts
node tools/harmony_shell_smoke.mjs                # rebuilds the embedded web app and checks it (needs bun)
node tools/shipped_copy_hygiene.mjs               # no personal names or IDs in shipped files
python3 tools/installer_contract_smoke.py         # the installers' contract, with a fake hub
python3 -m unittest discover -s tools/reconciliation -p 'test_*.py'   # provenance; 12 known failures
(cd Android && ./gradlew :core-protocol:test)    # Android protocol and graph tests
```

The Android tests need JDK 17 or 21 and the Android SDK; `deploy_to_phone.sh`
sets both up on macOS.

**Rebuilding `codex_webui`**: after changing the web app, bundle it, then
build the binary with the official Zig 0.16.0 as described in
[docs/BUILD.md](docs/BUILD.md). The build script,
`build/build_harmony_tools_kali.sh`, checks the Zig executable and each
binary against pinned SHA-256 values.

```bash
sh tools/package_harmony_shell.sh   # writes payload/source/harmony_shell_assets.h
```

When `codex_webui` changes, update its pins in the build script,
`payload/bin/MANIFEST.txt` and `tools/reconciliation/test_webui_source_build.py`.

## Documentation

| Document | What it covers |
| --- | --- |
| [DESIGN.md](DESIGN.md) | The Melodious design system, shared by the web app and the Android app |
| [docs/API.md](docs/API.md) | The hub's HTTP API and the activity rules the paired remote needs |
| [docs/BUILD.md](docs/BUILD.md) | Building the MIPS binaries with the pinned toolchain |
| [docs/PROTOCOLS.md](docs/PROTOCOLS.md) | The hub's own protocols and ports |
| [docs/SECURITY.md](docs/SECURITY.md) | Security notes and what never to commit |
| [UNRAID.md](UNRAID.md) | Docker and Unraid |
| [tools/webui-sim/README.md](tools/webui-sim/README.md) | The simulator and the web app's packaging |
| [tools/hub-emu/README.md](tools/hub-emu/README.md) | The QEMU hub emulator |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute |

## Contributing, security, credits and license

Contributions are welcome. Keep changes small and scoped, add a short test
note, and never commit SSH keys, MQTT passwords, tokens, hub backups, firmware
dumps or rooting tools. Read [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/SECURITY.md](docs/SECURITY.md) first.

- Rooting the hub: [harmony-hub-root](https://github.com/Ripthulhu/harmony-hub-root),
  a separate project.
- Melodious: [schlambos/harmony-hub-control](https://github.com/schlambos/harmony-hub-control).
- Third-party code: Material Icons (Apache-2.0) in
  [`third_party/material-icons/`](third_party/material-icons/), built into the
  web app, and Dropbear SSH in
  [`third_party/dropbear-2025.89/`](third_party/dropbear-2025.89/), with its
  licence.

**License**: the repository has no license file at its root, so default
copyright applies. Ask the author before redistributing the code or binaries
built from it.
