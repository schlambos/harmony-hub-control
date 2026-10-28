<p align="center">
  <img src="desktop/resources/icon.png" alt="Melodious" width="112">
</p>

<h1 align="center">Melodious</h1>

<p align="center">
  Local control for the Logitech Harmony Hub and its remotes, connected to Home Assistant in both directions.<br>
  No Logitech app, account or cloud.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#harmony">Harmony</a> ·
  <a href="#home-assistant">Home Assistant</a> ·
  <a href="#buttons-gestures-and-timing">Buttons and timing</a> ·
  <a href="#the-apps">Apps</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="docs/API.md">API</a>
</p>

Melodious is software for a Harmony Hub that has already been rooted with
[harmony-hub-root](https://github.com/Ripthulhu/harmony-hub-root). It runs on
the hub next to Logitech's own firmware. It takes over the jobs that used to
need Logitech's cloud (adding devices, building activities, keeping the paired
remote in sync), and it connects the hub and Home Assistant so each can
control the other. You set it up from a web app the hub serves, from an
Android app or from a macOS app.

This repository contains no rooting tools, exploits, private keys or personal
backups.

<p align="center">
  <img src="docs/screenshots/web/remote.png" alt="The web app's remote on a phone" height="480">
  <img src="docs/screenshots/android/remote.png" alt="The Android app's remote" height="480">
  <br><sub>The web app (left) and the Android app (right)</sub>
</p>

## At a glance

<table>
<tr>
<th width="50%">Harmony</th>
<th width="50%">Home Assistant</th>
</tr>
<tr>
<td valign="top">

- Runs offline. Logitech's cloud is blocked, and the paired remote syncs
  from the hub.
- Activities, devices, inputs and power order, all edited on the hub.
- IR learning, and code import from IRDB, Flipper files, Pronto, RemoteCentral
  or Logitech's catalog.
- Any command can go on a hard key, an on-screen button, the number pad or a
  gesture.
- The hub can also act as a Bluetooth keyboard and remote for TVs and
  streaming boxes.

</td>
<td valign="top">

- Home Assistant entities become devices on the hub: lights, media players,
  switches, fans, covers, scripts, scenes and buttons.
- Use them in activities, on any remote button, or on their own device
  screen.
- Hold a key to dim or change volume. Toggles fire once per press.
- An MQTT bridge with discovery gives Home Assistant an activity selector,
  status sensors and a power-off button.
- Home Assistant's built-in Harmony integration keeps working, locally.

</td>
</tr>
</table>

Both sides share the same apps, the same button mapping and the same save
path. To the hub, an IR code, a Bluetooth key and a Home Assistant action are
all ordinary device commands.

## Why Melodious

Logitech stopped making Harmony remotes in 2021. A Harmony Hub depends on
Logitech's app and cloud for its setup: adding a device, building an activity
and updating the paired remote all go through Logitech's servers. If that
service changes or goes away, the hub's setup is frozen.

Melodious moves that work onto the hub. It keeps Logitech's engine for what
the engine does well: sending IR, running activities and talking to the
remote. It replaces only the parts that needed the cloud. Your setup lives in
the hub's own files, where you can back it up, restore it and edit it without
an account.

## Requirements

| Requirement | Details |
| --- | --- |
| Harmony Hub | Rooted with [harmony-hub-root](https://github.com/Ripthulhu/harmony-hub-root). Melodious doesn't root hubs. |
| SSH key | The root tool's private key, `harmony_owner_*`, in `~/.ssh` (`%USERPROFILE%\.ssh` on Windows). |
| Hub ID | The numeric Hub ID the root tool prints. Don't guess it: Melodious sends it with every command to the hub's engine. |
| Install computer | Windows with PowerShell, Linux or macOS with Python 3, or a Docker or Unraid host. The installer needs only `ssh`, not `scp` or `sftp`. |
| Network | A trusted home network. The web app is plain HTTP. |
| Home Assistant (optional) | Any recent Home Assistant with [HACS](https://hacs.xyz/), reachable from the hub over plain `http://`. An MQTT broker is needed only for the MQTT bridge. |
| Android app (optional) | Android 8.0 or later. Building it needs JDK 17 or 21 and the Android SDK. |
| macOS app (optional) | macOS 13 or later, on Apple silicon or Intel. Catalog lookup needs a Logitech account; building the app needs Node.js. |

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
3. Open `http://<hub-ip>:8080/` on your phone or computer. Your existing
   activities and devices are there, including any set up with the Logitech
   app before rooting.
4. Optional: add Home Assistant (see [Set up Home Assistant](#set-up-home-assistant)).

## Harmony

### Offline operation

- **The cloud is blocked.** The hub doesn't start Logitech's cloud tasks
  (cloud API, PubNub, the package manager), and requests to Logitech and
  PubNub hosts fail cleanly. The internet route is removed and kept off,
  while LAN and multicast routes stay up. Local control, SSDP/mDNS
  discovery, MQTT and Home Assistant webhooks keep working.
- **The paired remote syncs from the hub.** Each saved change publishes a new
  configuration revision, and the remote pulls it by itself within seconds.
  You don't need a MyHarmony account or a sync cable, and there's no cloud
  copy to overwrite your edits.
- **Syncs finish offline.** During a sync the remote checks connectivity,
  asks for the time, and asks for device content records (`CD_<id>`). Devices
  made on the hub don't have those records. The hub answers all three
  locally.
- **The hub keeps its own time.** Its clock is set over NTP; each query gets a
  temporary route. You can set the time zone in System.
- **Local edits are protected.** System → Cloud egress turns the cloud blocker
  on, and the app has no control to turn it off. Activity and device changes
  are refused while the blocker is off, so a local edit can't race a cloud
  sync.

### Remotes

Melodious does its work on the hub, so it's designed for any Harmony remote
that pairs with the hub. **So far it has been validated on hardware only with
the Harmony Touch.**

| Remote | Status |
| --- | --- |
| Harmony Touch | Validated, with stock remote firmware: offline sync, hard keys, on-screen buttons, the number pad, gestures, device screens and press modes. |
| Other remotes that pair with the hub, such as the Harmony Companion, Ultimate, Elite or 950 | Expected to work, but not yet tested. Features that need a screen apply only to remotes that have one. |
| Phones, tablets and computers | The web, Android and macOS apps. |

No remote needs modified firmware. If you run Melodious with another remote,
please report what works and what doesn't (see [CONTRIBUTING.md](CONTRIBUTING.md)).

### Activities

- **Setup wizard.** It has five steps:
  - Name.
  - Devices: which device does each job, and how long to wait after each one
    turns on.
  - Inputs.
  - Buttons: 36 keys, each with a press action and a hold action.
  - Review.
- **Advanced editor.** It covers the roles, the button map for each remote
  surface, and the activity's JSON.
- **Start and end** (Android app). Set the order devices turn on and off, and
  commands to send when the activity starts or ends.
- **Saves are transactions.** The hub checks each save against the rules the
  remote's own reader enforces, then writes it and reads it back. If anything
  fails, it restores the previous version. If the setup changed after you
  opened it, the save is refused and the latest copy loads.

### Devices and codes

- **Device settings.** You can set:
  - power: separate On and Off commands, one toggle, or none;
  - turning on: warm-up time, Always on, and Keep on between activities;
  - inputs and timing.
- **Learn a button.** Point the original remote at the hub, press the button,
  then test and save it.
- **Import codes.** The sources are:
  - search IRDB;
  - open Flipper `.ir` files;
  - paste IRDB CSV, `name|mode|code` lines or Pronto hex;
  - fetch a RemoteCentral page;
  - type a code.

  IRDB's NEC, NECx, Samsung, Pioneer, Sony, RC5, RC6, Panasonic, JVC, Denon
  and Sharp codes are converted with each protocol's frame timing.
- **Logitech catalog** (macOS and Android apps). Sign in with your own
  Logitech account, search by brand and model, preview every command, and
  import to the hub. The preview lists any command whose IR protocol the hub
  lacks, with the reason, instead of dropping it silently. Your credentials
  stay in the macOS Keychain or the Android Keystore, and the hub never sees
  them.
- **Find codes that work.**
  - Send all: sends every command in turn, with a dry run, a set gap between
    commands and Stop.
  - IR lab: a scratch device for trying candidate codes.

### Bluetooth keyboard

The hub can pair with a TV, a streaming box (such as an NVIDIA SHIELD or a
Google TV) or a computer as a Bluetooth keyboard and remote. From your phone
you can type searches and passwords and send keys. Paired targets are saved
along with their keystroke scripts. Bluetooth commands go on remote buttons
like any other command.

## Home Assistant

Melodious connects the hub and Home Assistant in both directions.

| Direction | How |
| --- | --- |
| **Harmony controls Home Assistant** | The [Melodious integration](https://github.com/schlambos/ha-melodious) turns the entities you pick into devices on the hub. Remote buttons, activities and the apps control them through a local webhook. |
| **Home Assistant controls Harmony** | The MQTT bridge publishes the hub's state with Home Assistant discovery, and takes commands. Home Assistant's built-in Logitech Harmony integration also keeps working over the hub's local WebSocket. |

### Entities as Harmony devices

Each entity you pick becomes an ordinary device on the hub that uses IP
transport (`TransportType: 64`):

| Domain | Commands | Power and inputs |
| --- | --- | --- |
| `light` | `PowerOn`, `PowerOff`, `PowerToggle`, plus `BrightnessUp` and `BrightnessDown` (±10 %) when dimmable | On and off |
| `media_player` | `PowerOn`, `PowerOff`, `VolumeUp`, `VolumeDown`, `Mute`, `Play`, `Pause`, `PlayPause`, `Stop`, `SkipForward`, `SkipBack`, each when the player supports it | On and off, plus one `Input <source>` per source |
| `switch`, `input_boolean` | `PowerOn`, `PowerOff`, `PowerToggle` | On and off |
| `fan` | As `switch`, plus `SpeedUp` and `SpeedDown` | On and off |
| `cover` | `Open`, `Close`, `Stop` | None |
| `script`, `scene` | `Run` / `Activate` | None |
| `button`, `input_button` | `Press` | None |

- **Default key mapping.** Command names match the wizard's key names, so
  Volume, Mute and the transport keys map by default.
- **Inputs.** A media player's sources become device inputs, and activities
  select them like any other input.
- **Commands are never lost.** A device keeps every command and input it has
  ever reported. A player that's off often stops reporting its sources, and
  merging instead of replacing keeps buttons bound to them working. When a
  player gains `SkipForward` and `SkipBack` once media plays, the update
  reaches the hub within 5 s.
- **Safe removal.** If an activity or button still uses an entity, removing
  it is refused, and Home Assistant shows a notification.
- **No token on the hub.** No Home Assistant token is stored on the hub; the
  webhook ID is the only secret.

### Using them

- **As an activity member.** The activity turns the device on and off, and
  selects its input, when it starts and ends.
- **On any button, without membership.** Examples:
  - room lights on the colour keys;
  - a scene on an on-screen button;
  - a Chromecast Audio's transport keys in a Music activity.

  The activity doesn't turn these devices on or off. The editors mark them
  **Extra**, and saves keep them.
- **On its own device screen.** On remotes with a screen, each Home Assistant
  device gets a screen, which is rebuilt whenever the device set changes:
  - brightness or volume goes on the volume rocker;
  - transport commands go on their own keys (`SkipForward` → `FastForward`,
    `SkipBack` → `Rewind`);
  - power and inputs become on-screen buttons.
- **From the apps.** Each device page has its own remote.

### Controlling the hub from Home Assistant

The MQTT bridge uses `harmony/hub` as its base topic and `homeassistant` as
its discovery prefix by default. You can change both.

| Topic | Direction | Content |
| --- | --- | --- |
| `harmony/hub/status` | Published (retained) | `online` or `offline` |
| `harmony/hub/state` | Published (retained) | The running activity, IP, firmware, and device and command counts, as JSON |
| `harmony/hub/result` | Published | The result of each command |
| `harmony/hub/activity/set` | Subscribed | An activity name or ID, or `off` |
| `harmony/hub/command`, `harmony/hub/hbus` | Subscribed | An activity, a device command (`deviceId`, `command`), or a raw hub-engine command |

Discovery creates:
- an **Activity** selector;
- sensors for the activity ID, IP address, firmware, and IR device and
  command counts;
- a **Power Off** button.

Set the bridge up at install time or in Settings → MQTT.

### Set up Home Assistant

1. In HACS, add `https://github.com/schlambos/ha-melodious` as a custom
   repository of type **Integration**, then install Melodious.
2. Go to Settings → Devices & services → Add integration → **Melodious**, and
   enter:
   - the hub's address and port (`8080`), and its sign-in if you set one;
   - the URL the hub should use to reach Home Assistant, such as
     `http://<server-ip>:8123`.

   That URL must be plain `http://`, because the hub's certificate bundle
   lacks the Let's Encrypt root. It must also be reachable from the hub, so a
   Docker-internal address won't work.
3. Open the integration's **Configure**, and pick entities.

`tools/ha_devices.mjs` does the same from the command line. It can list, dry
run, apply or revert a device set, send one command, and run a test webhook
listener. See [docs/HOME_ASSISTANT.md](docs/HOME_ASSISTANT.md).

## Buttons, gestures and timing

Everything in this section works the same way for IR, Bluetooth and Home
Assistant commands.

### Where a command can go

| Control | What the remote sends | Notes |
| --- | --- | --- |
| Hard keys | `press`, then `hold` every 300 ms, then `release` | The wizard writes the hub's activity map and copies the keys to the remote's map. Only changed keys are copied, so mappings that exist only on the remote survive. |
| On-screen buttons | `press` and `release`, plus `hold` every 300 ms while held | Each button keeps its slot. A new button takes the lowest free slot, and nothing is renumbered unless you move a button. |
| Number pad | A single `fire` per digit | Kept in its own slot space. |
| Gestures (`SwipeUp`, `SwipeDown`, `SwipeLeft`, `SwipeRight`, `Tap`) | Resolved on the remote, against the target device's screen, then sent as an ordinary press | The target device needs a screen with that command. If a gesture resolves to a hard key, the activity must map that key too. |

The timings and gesture behaviour above were measured on the Harmony Touch.

- **On-screen buttons editor.** Open Activities → ⋮ → **On-screen buttons**
  (`#touch/<activityId>`).
  - Tabs: on-screen buttons, hard keys and gestures.
  - Devices: the device picker groups Home Assistant devices, and you choose a
    press mode for each binding.
  - Gesture simulator: shows what each gesture will run, and offers a
    one-click fix when a hard key is missing.
  - The Android app edits on-screen buttons and sequences; hard keys and
    gestures are edited in the web app.
- **Device screens.** On a device page, ⋮ → **Make Touch screen**, **Rebuild
  Touch screen** or **Remove Touch screen** builds, rebuilds or removes the
  device's screen from its commands (`POST /api/device-screen`). Home
  Assistant devices get one automatically.

### Press modes

| Mode | What happens | Default for |
| --- | --- | --- |
| Standard | Fires on press, then again on every hold, about every 300 ms | Step commands (`VolumeUp`/`Down`, `BrightnessUp`/`Down`, `SpeedUp`/`Down`) and commands that are safe to repeat (`PowerOn`, `Play`) |
| One-shot | Fires once: at release if you let go before about 600 ms, or at about 600 ms if you hold. Later holds are ignored | `PowerToggle`, `PlayPause`, `Mute`, `SkipForward`, `SkipBack`, `Run`, `Activate`, `Press` |
| Short + long | One command for a tap, another for a hold | — |

One-shot matters most for Home Assistant: each hold is another webhook call,
so a held toggle would otherwise flip the device twice. It sets the button's
long-press action to its own command, which engages the hub's built-in
long-press handling on hard keys and on-screen buttons. Gestures resolve on
the remote, so they can't use it; the editor warns when a gesture runs a
toggle.

## The apps

The web app, the Android app and the macOS app control the same hub and share
one design ([DESIGN.md](DESIGN.md)). The hub serves the web app. The Android
and macOS apps are downloads on the release page.

### The web app

The hub serves the web app to any browser on your network, and nothing loads
from the internet. It has four tabs: Remote, Activities, Devices and Settings.
On phones they're a bottom bar; on screens 840 px and wider they're a
navigation rail. Every screen has its own address, such as `#devices/<id>`,
so you can bookmark it.

<p align="center"><img src="docs/screenshots/web/desktop-remote.png" alt="The web app on a computer, with the navigation rail and More keys beside the remote"><br><sub>On a computer: the navigation rail, with More keys beside the remote</sub></p>

**Remote**
- With nothing running, the tab shows "Everything's off" and a card for each
  activity. While an activity runs, it shows that activity's remote.
- The power button turns everything off at once, without asking, like the
  physical remote.
- **Keyboard** sends text and keys to the TV through the hub's Bluetooth
  keyboard.
- **More keys** has:
  - the activity's on-screen buttons;
  - the colour keys and the number pad;
  - "All device commands…";
  - the send log.
- **Fix it** resends a device's power or input command when something didn't
  turn on or switch input.
- A status line shows what each key sends, as "key → device · command".
- **Key timing:**
  - Keys fire when you lift your finger, and sliding off cancels.
  - A key with a hold action fires that action after 500 ms.
  - Volume, channel and the D-pad fire on touch and repeat while held. The
    hub keeps the command going until you let go.

<table>
<tr><td align="center"><img src="docs/screenshots/web/remote.png" alt="The web app's remote with an activity running" width="200"><br><sub>Remote</sub></td><td align="center"><img src="docs/screenshots/web/remote-more-keys.png" alt="The More keys sheet with on-screen buttons, colour keys and the number pad" width="200"><br><sub>More keys</sub></td><td align="center"><img src="docs/screenshots/web/remote-fix-it.png" alt="The Fix it sheet with power and input resends for each device" width="200"><br><sub>Fix it</sub></td><td align="center"><img src="docs/screenshots/web/remote-switch.png" alt="The Switch activity sheet with Turn everything off" width="200"><br><sub>Switch activity</sub></td></tr>
</table>

**Activities**
- **The list.** The running activity's card has Open remote and Turn off.
  Each other activity's row has Start and a ⋮ menu: Edit, Set up buttons,
  On-screen buttons, Try the buttons (its remote, without starting it),
  Advanced editor, Move up, Move down and Delete.
- **+** opens the setup wizard.

<table>
<tr><td align="center"><img src="docs/screenshots/web/activities.png" alt="The Activities tab with the running activity's card" width="200"><br><sub>Activities</sub></td><td align="center"><img src="docs/screenshots/web/activity-menu.png" alt="An activity's menu" width="200"><br><sub>Activity menu</sub></td><td align="center"><img src="docs/screenshots/web/wizard-devices.png" alt="The setup wizard's Devices step" width="200"><br><sub>Wizard: Devices</sub></td><td align="center"><img src="docs/screenshots/web/wizard-buttons.png" alt="The setup wizard's Buttons step" width="200"><br><sub>Wizard: Buttons</sub></td></tr>
</table>

**Devices**
- **The list.** Search it by device or command. **+** adds a device, and
  Tools opens the IR lab.
- **A device page** has Remote and Commands tabs.
  - Its remote sends straight to the device, outside any activity.
  - On the Commands tab, tap a command to send it. Learn a button, Import
    codes and Send all are there too.
  - The ⋮ menu has Edit details, Delete device and the device screen actions.
  - A device that is still in use can't be deleted, and the page says where
    it's used.

<table>
<tr><td align="center"><img src="docs/screenshots/web/devices.png" alt="The Devices tab" width="200"><br><sub>Devices</sub></td><td align="center"><img src="docs/screenshots/web/device-commands.png" alt="A device's Commands tab" width="200"><br><sub>Commands</sub></td><td align="center"><img src="docs/screenshots/web/import-find.png" alt="The Import codes sheet" width="200"><br><sub>Import codes</sub></td><td align="center"><img src="docs/screenshots/web/device-settings.png" alt="A device's settings" width="200"><br><sub>Device settings</sub></td></tr>
</table>

**Settings**
- **Hub**: whether the hub is connected, and its activity and device counts.
- **Bluetooth keyboard**: pairing and saved devices.
- **MQTT**: the broker, Home Assistant discovery and the topics.
- **Wi-Fi**: the network the hub joins. Changes take effect after a reboot.
- **Backup**: downloads and restore.
- **System**: status and logs, the cloud blocker, the time zone, sign-in,
  the hub's software version, Home Assistant discovery and reboot.

<details>
<summary>More web app screenshots</summary>

<table>
<tr><td align="center"><img src="docs/screenshots/web/remote-keyboard.png" alt="The Keyboard tab" width="200"><br><sub>Keyboard</sub></td><td align="center"><img src="docs/screenshots/web/wizard-name.png" alt="The wizard's Name step" width="200"><br><sub>Wizard: Name</sub></td><td align="center"><img src="docs/screenshots/web/wizard-inputs.png" alt="The wizard's Inputs step" width="200"><br><sub>Wizard: Inputs</sub></td><td align="center"><img src="docs/screenshots/web/wizard-review.png" alt="The wizard's Review step" width="200"><br><sub>Wizard: Review</sub></td></tr>
<tr><td align="center"><img src="docs/screenshots/web/device-remote.png" alt="A device's own remote" width="200"><br><sub>Device remote</sub></td><td align="center"><img src="docs/screenshots/web/learn.png" alt="The Learn a button sheet" width="200"><br><sub>Learn a button</sub></td><td align="center"><img src="docs/screenshots/web/import-paste.png" alt="Import codes: Paste" width="200"><br><sub>Import: Paste</sub></td><td align="center"><img src="docs/screenshots/web/send-all.png" alt="The Send all commands page" width="200"><br><sub>Send all</sub></td></tr>
<tr><td align="center"><img src="docs/screenshots/web/ir-lab.png" alt="The IR lab" width="200"><br><sub>IR lab</sub></td><td align="center"><img src="docs/screenshots/web/settings.png" alt="The Settings tab" width="200"><br><sub>Settings</sub></td><td align="center"><img src="docs/screenshots/web/bluetooth.png" alt="The Bluetooth keyboard page" width="200"><br><sub>Bluetooth</sub></td><td align="center"><img src="docs/screenshots/web/mqtt.png" alt="The MQTT page" width="200"><br><sub>MQTT</sub></td></tr>
<tr><td align="center"><img src="docs/screenshots/web/backup.png" alt="The Backup page" width="200"><br><sub>Backup</sub></td><td align="center"><img src="docs/screenshots/web/system.png" alt="The System page" width="200"><br><sub>System</sub></td><td align="center"><img src="docs/screenshots/web/wifi.png" alt="The Wi-Fi page" width="200"><br><sub>Wi-Fi</sub></td><td></td></tr>
</table>

<p align="center"><img src="docs/screenshots/web/desktop-editor.png" alt="The advanced editor on a computer"><br><sub>The advanced editor</sub></p>

</details>

### The Android app

The app is in [`Android/`](Android/). It's written in Kotlin with Jetpack
Compose, its package is `app.melodious`, and it runs on Android 8.0 (API 26)
and later. It isn't in an app store.

**Install**

Download `melodious-<version>.apk` from the
[latest release](https://github.com/schlambos/harmony-hub-control/releases/latest)
and open it on your phone. Android asks you to allow installs from your
browser or file manager.

To build it from source:

```bash
Android/deploy_to_phone.sh                               # phone on USB, or already paired with adb
Android/deploy_to_phone.sh --wireless <phone-ip>:<port>  # Android wireless debugging
Android/deploy_to_phone.sh --build-only                  # build the APK and run the tests only
```

The script expects macOS with Homebrew. It installs the Android command-line
tools and `adb` if they're missing, runs the unit tests, builds a debug APK
and installs it.

**What it does**

The app finds the hub with SSDP and then a scan of the subnet, or you type its
address. It uses the same API on port 8080, plus the hub's WebSocket on port
8088 for live state and press-and-hold. On top of the web app's features it
adds:

- **Touchpad**: swipe to move, tap for OK.
- **Sleep timer**: the hub turns everything off after 15 minutes to 2 hours,
  even if the phone is off.
- **Fix it → Resend everything**: the hub checks each device and resends only
  the power and input commands it needs.
- **Phone volume keys**: control the activity's volume while the app is open.
- **Start and end**: the order devices turn on and off, and the commands sent
  when an activity starts or ends.
- **Phone extras**:
  - a Quick Settings tile ("Melodious: Turn off");
  - a home-screen widget;
  - lock-screen controls while something is on;
  - `melodious://hub/poweroff` and `melodious://hub/activity/<id>` links.
- **SSH recovery** (Settings → Advanced): with your SSH key, check the hub,
  clear the web sign-in or restart Melodious's services. The key isn't saved.
- **Logitech catalog**: sign in with Chrome, search, preview and import. Or
  open a `harmony-catalog-*.json` package made on a computer.

Some things are web-only: adding and deleting devices, Edit details, device
inputs, Find codes, Fetch from RemoteCentral, Type a code, the IR lab, the
advanced editor, reordering activities, and the Wi-Fi, MQTT, Backup and
System pages.

<table>
<tr><td align="center"><img src="docs/screenshots/android/touchpad.png" alt="The Touchpad remote mode" width="200"><br><sub>Touchpad</sub></td><td align="center"><img src="docs/screenshots/android/sleep-timer.png" alt="The Sleep timer sheet" width="200"><br><sub>Sleep timer</sub></td><td align="center"><img src="docs/screenshots/android/editor-start-end.png" alt="The activity editor's Start and end step" width="200"><br><sub>Start &amp; end</sub></td><td align="center"><img src="docs/screenshots/android/on-screen-buttons.png" alt="The on-screen buttons editor" width="200"><br><sub>On-screen buttons</sub></td></tr>
</table>

<details>
<summary>More Android screenshots</summary>

<table>
<tr><td align="center"><img src="docs/screenshots/android/everything-off.png" alt="Nothing running" width="200"><br><sub>Everything's off</sub></td><td align="center"><img src="docs/screenshots/android/keyboard.png" alt="Keyboard" width="200"><br><sub>Keyboard</sub></td><td align="center"><img src="docs/screenshots/android/more-keys.png" alt="More keys" width="200"><br><sub>More keys</sub></td><td align="center"><img src="docs/screenshots/android/fix-it.png" alt="Fix it with Resend everything" width="200"><br><sub>Fix it</sub></td></tr>
<tr><td align="center"><img src="docs/screenshots/android/switch-activity.png" alt="Switch activity" width="200"><br><sub>Switch activity</sub></td><td align="center"><img src="docs/screenshots/android/activities.png" alt="Activities" width="200"><br><sub>Activities</sub></td><td align="center"><img src="docs/screenshots/android/activity-menu.png" alt="Activity menu" width="200"><br><sub>Activity menu</sub></td><td align="center"><img src="docs/screenshots/android/editor-name.png" alt="Editor: Name" width="200"><br><sub>Editor: Name</sub></td></tr>
<tr><td align="center"><img src="docs/screenshots/android/editor-devices.png" alt="Editor: Devices" width="200"><br><sub>Editor: Devices</sub></td><td align="center"><img src="docs/screenshots/android/editor-inputs.png" alt="Editor: Inputs" width="200"><br><sub>Editor: Inputs</sub></td><td align="center"><img src="docs/screenshots/android/editor-buttons.png" alt="Editor: Buttons" width="200"><br><sub>Editor: Buttons</sub></td><td align="center"><img src="docs/screenshots/android/editor-button-picker.png" alt="Button picker" width="200"><br><sub>Button picker</sub></td></tr>
<tr><td align="center"><img src="docs/screenshots/android/devices.png" alt="Devices" width="200"><br><sub>Devices</sub></td><td align="center"><img src="docs/screenshots/android/device-remote.png" alt="Device remote" width="200"><br><sub>Device remote</sub></td><td align="center"><img src="docs/screenshots/android/device-commands.png" alt="Commands" width="200"><br><sub>Commands</sub></td><td align="center"><img src="docs/screenshots/android/learn.png" alt="Learn a button" width="200"><br><sub>Learn a button</sub></td></tr>
<tr><td align="center"><img src="docs/screenshots/android/import.png" alt="Import codes" width="200"><br><sub>Import codes</sub></td><td align="center"><img src="docs/screenshots/android/device-settings.png" alt="Device settings" width="200"><br><sub>Device settings</sub></td><td align="center"><img src="docs/screenshots/android/device-settings-timing.png" alt="Device timing" width="200"><br><sub>Device timing</sub></td><td align="center"><img src="docs/screenshots/android/bluetooth.png" alt="Bluetooth keyboard" width="200"><br><sub>Bluetooth keyboard</sub></td></tr>
<tr><td align="center"><img src="docs/screenshots/android/settings.png" alt="Settings" width="200"><br><sub>Settings</sub></td><td align="center"><img src="docs/screenshots/android/advanced.png" alt="Advanced" width="200"><br><sub>Advanced</sub></td><td align="center"><img src="docs/screenshots/android/ssh-recovery.png" alt="SSH recovery" width="200"><br><sub>SSH recovery</sub></td><td></td></tr>
</table>

</details>

### The macOS app

The macOS app, in [`desktop/`](desktop/), is the web app in a Mac window. It's
built with Electron for macOS 13 and later, and uses the same bundle the hub
serves. It adds the one thing a page served by the hub can't do: sign in to
your Logitech account and pull a device's codes from Logitech's catalog.

**Install.** Download `Melodious-<version>-arm64.dmg` (Apple silicon) or
`-x64.dmg` (Intel) from the
[release page](https://github.com/schlambos/harmony-hub-control/releases),
open it and drag Melodious to Applications. The app isn't signed with an
Apple Developer ID, so macOS asks before the first launch. Control-click
Melodious → Open, or use System Settings → Privacy & Security → Open Anyway.
To build it yourself, see [`desktop/README.md`](desktop/README.md).

**First run.** When macOS asks whether Melodious may find and connect to
devices on your local network, choose **Allow**; without it, the app can't
reach the hub. The app then looks for the hub with SSDP, or you type its
address.

**Logitech catalog.** Open a device, then Import codes → Logitech catalog:

1. **Sign in.** Logitech's sign-in opens in its own window; Google sign-in
   works too.
2. **Search.** Type the brand and model, then pick a match.
3. **Download and import.** The preview shows what will import and why
   anything is skipped. **Import** adds the rest.

Your Logitech tokens stay in the app's background process, encrypted with
your Keychain. The web page, the hub and the logs never see them. The app has
no telemetry. If you turn on update checks, it asks GitHub once a day for
Melodious's releases; GitHub sees your IP address and the app's version,
nothing else. Without the app, the same tab opens a
package made with `tools/catalog/harmony_catalog.py` (see
[its README](tools/catalog/README.md)).

<table>
<tr><td align="center"><img src="docs/screenshots/desktop/catalog-search-1280.png" alt="Searching Logitech's catalog" width="420"><br><sub>Search and download</sub></td><td align="center"><img src="docs/screenshots/desktop/catalog-preview-1280.png" alt="The catalog preview with a skipped command" width="420"><br><sub>Preview, with skipped commands</sub></td></tr>
</table>

## More on the hub

- **Backup and restore.** You can download:
  - ten single exports: devices, functions, protocols, activities, button
    maps, automation, MQTT, Wi-Fi, cloud blocker and Bluetooth;
  - one owner bundle with all ten.

  A restore from a file is checked before anything is written. The hub also
  keeps rolling backups before every write.
- **Wi-Fi recovery.** If the hub can't join your Wi-Fi, hold its reset button.
  It starts an open recovery network, `Harmony-Recovery-xxxxxx`, with a setup
  portal at `http://192.168.76.1/`.
- **Sign-in.** An optional HTTP Basic username and password protects the web
  app and its API.
- **Local HTTP API.** Scripts and automations can use it to:
  - start activities;
  - send IR, Bluetooth or IP commands;
  - manage device screens and Home Assistant devices;
  - read or update the hub's setup.

  See [docs/API.md](docs/API.md).

## Install, update and roll back

The first run on a hub writes Melodious's configuration: the Hub ID, the
cloud blocker (on), and the MQTT settings (off, unless you pass the `--mqtt-*`
options). Later runs upgrade in place and keep that configuration.
`--clean-install` writes it from scratch.

Each run:

1. Finds your key: `--key-path`, or else the newest `harmony_owner_*` key in
   `~/.ssh`.
2. Uploads every file to a private folder in the hub's RAM
   (`/var/volatile/codex-install-*`). It checks each MD5 and compares it with
   the installed copy, so unchanged files aren't written.
3. Checks that flash and RAM can hold the change and a rollback. It copies the
   files it will change into RAM and writes a handoff backup to
   `/data/codex-backups/webui-handoff-*`.
4. Writes each changed file next to its target as `<file>.codex-new` and
   verifies it, then renames the copies into place, `codex_webui` last.
   - If flash runs out, it removes the copies and nothing in use changes.
   - If a later step fails, it puts the originals back in reverse order and
     verifies them.
5. Restarts the web app and the Bluetooth keyboard service, registers the hub
   plugins, and waits for the web app to answer.
6. Reboots the hub only if the cloud-blocker files changed.

| Python | PowerShell | What it does |
| --- | --- | --- |
| `--preflight-only` | `-PreflightOnly` | Stages and compares in RAM, prints what would change and a verdict, and writes nothing to flash. |
| `--clean-install` | `-CleanInstall` | Writes the configuration from scratch. |
| `--hub-id` | `-HubId` | The Hub ID. Without it, the installer reads it from the hub, then from the root tool's files in `~/.harmony-hub/`. |
| `--no-prompt` | `-NoPrompt` | Fails instead of asking for a missing value. |
| `--mqtt-broker`, `--mqtt-port`, `--mqtt-user`, `--mqtt-password`, `--mqtt-base-topic`, `--mqtt-discovery-prefix`, `--mqtt-client-id`, `--mqtt-disabled` | `-MqttBroker` … `-MqttDisabled` | Set up the MQTT bridge. Without them, an upgrade keeps the hub's MQTT settings. |
| `--no-apply-cloud-restart` | `-NoApplyCloudRestart` | Skips the reboot after the cloud-blocker files change. |
| `--skip-cloud-suppression` | `-SkipCloudSuppression` | Leaves the hub's `netservicestarter.lua` as it is. With a clean install, it also writes the cloud blocker as off. |

`python3 install_webui.py --help` lists every option.

- **Updating.** Get the latest release or the latest copy of this repository,
  and run the installer again. Or let the Android or macOS app do it: when a
  newer hub release is out, Settings → Updates offers **Update hub**.
  - **Download:** the app fetches the hub zip from the GitHub release, checks
    it against the release's `SHA256SUMS.txt`, and sends only the files that
    differ.
  - **Key:** it connects over SSH with the same key as the installer. The Mac
    app finds `~/.ssh/harmony_owner_*`; the Android app asks for the key once
    and keeps it encrypted.
  - **On the hub:** a short script does the installer's steps from a RAM
    folder: check every file, copies in RAM, a handoff backup, `.codex-new`
    then rename with `codex_webui` last, then a restart and a check that the
    web app answers. If that check fails, it puts the old files back. It
    reboots when the boot scripts or plugins changed. Because it runs on the
    hub, it finishes even if the phone drops off Wi-Fi.
  - **A new hub** still needs the installer once; the app only updates a hub
    that already has Melodious.
  - **Doesn't change:** the hub's settings (the Hub ID, cloud blocker, MQTT)
    and its web routes.
- **Rolling back.** In PowerShell, `restore_backup.ps1` restores these from
  the newest handoff backup, then tells you to reboot the hub:
  - the boot script;
  - `netservicestarter.lua`;
  - the SSH wrappers;
  - the Hub ID;
  - the MQTT settings.

  ```powershell
  .\restore_backup.ps1 -HubHost <hub-ip> -KeyPath "$env:USERPROFILE\.ssh\<key-file>"
  ```
- **Docker and Unraid.** The image runs the same installer with settings from
  environment variables, then stays up as a small proxy to the hub's web app.
  See [UNRAID.md](UNRAID.md) and `compose.yaml`.

## How it works

```text
Phone or computer
  ├─ web app ────► http://<hub-ip>:8080 ── codex_webui (one static C binary)
  ├─ Android app ► the same API, plus the hub's WebSocket on :8088
  └─ macOS app ──► the web app's bundle; only the app itself talks to Logitech

codex_webui
  ├─ codex_hbus ─────────► the hub's activity engine (activities, IR, learning)
  ├─ codexactivity.lua ──► the hub's resource manager (every activity, device,
  │                         Home Assistant and screen save; publishes revisions)
  ├─ codex_hal_ltcp, codex_bthid_keyboard, codex_bt_pair_agent ──► Bluetooth
  └─ JSON files on the hub's flash (/data)

Paired remote ◄── pull sync ── netservicestarter.lua (answers from local files)
Home Assistant ◄── webhook POST ── engine IP commands (Transport 64)
Home Assistant ◄─► MQTT ── codexmqtt.lua
Logitech cloud ✕  cloud tasks not started, hosts refused, WAN route removed
```

- **It builds on Logitech's engine.** Melodious drives the hub's stock
  activity engine and resource manager instead of replacing them. Logitech's
  IR handling, activity logic and remote protocol keep working, and every
  change is saved the way the engine itself saves, so the remote accepts it.
- **Server.** `payload/source/codex_webui.c` is built with Zig as a static,
  stripped MIPS32 big-endian binary. It listens on port 8080 and forks for
  each request. The web app is plain JavaScript modules in
  `tools/webui-sim/public/`, with no framework.
  `tools/package_harmony_shell.sh` bundles them into
  `payload/source/harmony_shell_assets.h`, which is compiled into the server.
  The hub serves one page, one script and one stylesheet.
- **Hub plugins.**
  - `codexactivity.lua` runs inside the hub's own Lua runtime and is the
    single writer for activities, device settings, Home Assistant devices and
    device screens.
  - `codexmqtt.lua` runs the MQTT bridge.
  - `netservicestarter.lua` blocks the cloud, answers the remote's sync, and
    keeps the clock.
- **Saves.** Every activity change (from the wizard, the editors, a reorder
  or a delete) is one transaction:
  1. The hub checks the activities, button maps and command maps against its
     devices.
  2. It backs up its resource files and writes the activity files.
  3. It reads them back, reloads the engine, and waits for the engine.
  4. It publishes a new configuration revision, and the paired remote pulls
     it.

  If any step fails, the hub restores the previous files. The advanced
  editor's "Refresh remote locally" publishes the stored setup again without
  changing it.
- **Home Assistant devices.**
  - Each entity is a device whose commands are IP commands. The engine sends
    them as an HTTP `POST` of `{"device":"<entity>","command":"<action>"}` to
    the integration's webhook.
  - The integration answers at once and calls the Home Assistant service
    afterwards, because the engine drops IP commands that wait more than
    500 ms.
  - Melodious writes these devices with the exact fields the engine needs.
    [docs/HOME_ASSISTANT.md](docs/HOME_ASSISTANT.md) lists the rules, each
    verified on hardware.
- **Remote sync.** The hub never pushes; the remote pulls when it sees a new
  revision. While the cloud blocker is on, the hub answers each of the
  remote's requests from its own files. [docs/TOUCH_EDITOR.md](docs/TOUCH_EDITOR.md)
  documents the sync, how presses resolve, slot rules and validation.
- **Network access.**
  - The apps load nothing from the internet.
  - IRDB search runs in your browser, and fetches from the jsDelivr CDN only
    when you click Search IRDB or Preview.
  - The hub fetches a RemoteCentral page only when you click Fetch, and only
    if it has a route to the internet, which the cloud blocker removes.
  - The macOS and Android apps contact Logitech only for catalog lookup.
- **Backups on the hub:**

  | Backups | Folder | Kept |
  | --- | --- | --- |
  | Resource backups (`YYYYMMDD_HHMMSS`), taken before each write | `/data/codex/resource-backups` | Newest 5 |
  | Installer handoffs (`webui-handoff-*`) | `/data/codex-backups` | Newest 3 |

  Only folders with those exact names are ever removed.

## Safety and limits

- **Use a trusted network only.** The web app is plain HTTP on every interface
  of the hub. Sign-in is optional and off by default.
  - The hub doesn't check where a request comes from. A web page open on any
    device on your network could send it commands.
  - Never expose the hub to the internet.
- **Exports contain secrets.** The MQTT, Wi-Fi and owner-bundle exports
  include your MQTT password and Wi-Fi key.
- **MQTT is a control channel.** Anyone who can publish to the bridge's
  topics can start activities, send IR and run hub-engine commands. The
  bridge doesn't use TLS, so use a broker with authentication.
- **Home Assistant webhooks are plain HTTP.** The webhook ID is the only
  secret, so keep Home Assistant on your LAN.
- **Update with the installer.** Updates aren't signed. Install from a copy of
  this repository or a release you trust.
- **Some actions interrupt the room.** Wi-Fi changes, reboots, restores and
  updates can take the hub offline for a while; the web app asks you to
  confirm them.
- **The hub is small.** Flash and RAM are limited, so download a backup before
  a big import. Limits: 32 devices, 2,048 commands per device and 1,024
  commands per import.
- **Offline is the supported mode.** Using the Logitech app or cloud sync
  alongside Melodious isn't supported, and can overwrite local changes.
- **Logitech catalog lookup uses your account**, one device at a time, and
  changes nothing in it. Logitech's terms govern it. If Logitech closes this
  path, IRDB search, code files and learning still work.
- **The macOS app is ad-hoc signed.** It doesn't update itself.
- **Locked out of sign-in?** The Android app's SSH recovery clears it. You can
  also delete `/data/codex/webui_auth.conf` over SSH and restart
  `codex_webui`.
- **Hand-edited activity JSON must follow the remote's rules.** For example,
  an activity button without an action makes the paired remote stop
  responding until it's power-cycled. The wizard and the editors follow these
  rules, and [docs/API.md](docs/API.md) lists them.
  `tools/activity_graph_repair.mjs` checks a hub's activities and proposes
  repairs. It writes only with `--apply`:

  ```bash
  node tools/activity_graph_repair.mjs --base-url http://<hub-ip>:8080
  ```

## Development and testing

You don't need a hub to work on the web app.

- **Simulator.** An in-memory hub with fixture data, on loopback only. It
  never contacts a hub or sends IR.

  ```bash
  node tools/webui-sim/server.mjs   # then open http://127.0.0.1:8787/#remote
  ```
- **Hub emulator.** [`tools/hub-emu/`](tools/hub-emu/README.md) runs the real
  `codex_webui` and `codex_hbus` binaries under QEMU in Docker, against an
  emulated engine. Use it to test anything the hub's request handling
  affects.

**Tests**

```bash
node --test tools/webui-sim/test/                 # web app models and hub contracts
node tools/harmony_shell_smoke.mjs                # rebuilds the embedded web app and checks it (needs bun)
node tools/shipped_copy_hygiene.mjs               # no personal names or IDs in shipped files
python3 tools/installer_contract_smoke.py         # the installers' contract, with a fake hub
python3 -m unittest discover -s docker/tests      # the Docker manager
for t in barrier device-screens ha-devices touch-controls; do
  luajit tools/touch-validator/codexactivity-$t-test.lua
done                                              # the hub's writer: barrier, screens, Home Assistant, press modes
luajit tools/touch-validator/codexactivity-validate-test.lua tools/webui-sim/fixtures/touch-maplist.json
luajit tools/touch-validator/netservicestarter-guards-test.lua   # offline sync guards
(cd Android && ./gradlew :core-protocol:test)    # Android protocol and graph tests
node --test desktop/test/*.test.mjs               # macOS app units (after npm ci in desktop/)
(cd desktop && npm run test:e2e)                  # macOS app end-to-end, against the simulator
```

The Android tests need JDK 17 or 21 and the Android SDK; `deploy_to_phone.sh`
sets both up on macOS.

**Rebuilding `codex_webui`.** After changing the web app, run
`sh tools/package_harmony_shell.sh` to rebuild the embedded bundle. Then build
the binary with the official Zig 0.16.0, as described in
[docs/BUILD.md](docs/BUILD.md). When `codex_webui` changes, update its pins in
`build/build_harmony_tools_kali.sh` and `payload/bin/MANIFEST.txt`.

## Documentation

| Document | What it covers |
| --- | --- |
| [docs/API.md](docs/API.md) | The hub's HTTP API, and the activity rules the paired remote needs |
| [docs/HOME_ASSISTANT.md](docs/HOME_ASSISTANT.md) | Home Assistant entities as hub devices, webhook rules, press and hold behaviour, and setup |
| [docs/TOUCH_EDITOR.md](docs/TOUCH_EDITOR.md) | Remote sync, how presses and gestures resolve, on-screen buttons, device screens, slot rules and validation |
| [docs/MELODIOUS_WEB_UI.md](docs/MELODIOUS_WEB_UI.md) | The web app's architecture, screen map, tokens and components |
| [DESIGN.md](DESIGN.md) | The design system shared by the web and Android apps |
| [docs/ANDROID_CATALOG.md](docs/ANDROID_CATALOG.md) | Logitech catalog lookup and sign-in in the Android app |
| [docs/DESKTOP_APP.md](docs/DESKTOP_APP.md) | The macOS app's design, catalog lookup and security model |
| [desktop/README.md](desktop/README.md) | Building, testing and releasing the macOS app |
| [tools/catalog/README.md](tools/catalog/README.md) | The Logitech catalog helper for the command line |
| [docs/BUILD.md](docs/BUILD.md) | Building the MIPS binaries with the pinned toolchain |
| [docs/PROTOCOLS.md](docs/PROTOCOLS.md) | The hub's own protocols and ports |
| [docs/SECURITY.md](docs/SECURITY.md) | Security notes and what never to commit |
| [UNRAID.md](UNRAID.md) | Docker and Unraid |
| [tools/webui-sim/README.md](tools/webui-sim/README.md) | The simulator and the web app's packaging |
| [tools/hub-emu/README.md](tools/hub-emu/README.md) | The QEMU hub emulator |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute |

## Contributing, credits and license

Contributions are welcome, and so are reports from owners of remotes other
than the Harmony Touch. Keep changes small and scoped, and add a short test
note. Never commit SSH keys, MQTT passwords, tokens, hub backups, firmware
dumps or rooting tools. Read [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/SECURITY.md](docs/SECURITY.md) first.

- **Rooting the hub:**
  [harmony-hub-root](https://github.com/Ripthulhu/harmony-hub-root), a
  separate project.
- **Home Assistant integration:**
  [schlambos/ha-melodious](https://github.com/schlambos/ha-melodious).
- **Third-party code:**
  - Material Icons (Apache-2.0), in
    [`third_party/material-icons/`](third_party/material-icons/);
  - Dropbear SSH, in [`third_party/dropbear-2025.89/`](third_party/dropbear-2025.89/),
    with its licence.

**License**: see [LICENSE](LICENSE). Melodious code, meaning every change
after this fork's upstream commit `d87ceba`, is under the MIT License. Code
from the upstream project, Ripthulhu/harmony-hub-control, is all rights
reserved by its authors. Third-party components keep their own licences.
