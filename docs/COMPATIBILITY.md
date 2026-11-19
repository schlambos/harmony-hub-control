# Requirements and compatibility

What Melodious needs, which Harmony remotes work with it, and the hardware it has been verified
against. The short version is in the [README](../README.md#requirements-and-compatibility).

## Requirements

| Requirement | Details |
| --- | --- |
| Harmony Hub | Firmware 4.15.600, rooted. The desktop Setup Wizard roots and installs Melodious on existing, new or reset hubs: Windows and macOS releases after `v2.1.0`, plus Linux from source ([Setup Guide](SETUP_GUIDE.md); wizard on `main`). The bundled CLI, [`tools/hub-root/`](../tools/hub-root/README.md), works on all three platforms now; then run `install_webui.ps1` or `install_webui.py` ([fresh-hub CLI guide](FRESH_HUB_ACTIVATION.md)). The web and Android apps don't root hubs. |
| SSH key & Hub ID | Created automatically by the Setup Wizard, or printed/saved by the root CLI (`harmony_owner_*` in `~/.ssh` or `%USERPROFILE%\.ssh` on Windows, plus the numeric Hub ID — never guess the Hub ID). |
| Free flash | About 1.2–1.6 MB free on the hub's data flash (~0.65 MB for updates), checked automatically before writing anything — see [if the hub's flash is full](INSTALL.md#if-the-hubs-flash-is-full). |
| Computer or host | Windows (Desktop app or PowerShell), Linux (Desktop app from source or Python 3), macOS (Desktop app or Python 3), or Docker/Unraid ([UNRAID.md](../UNRAID.md)). CLI installs need only `ssh`, not `scp` or `sftp`. |
| Network | A trusted home network. The web app is plain HTTP. |
| Home Assistant (optional) | Any recent Home Assistant with [HACS](https://hacs.xyz/), reachable from the hub over plain `http://`. An MQTT broker is needed only for the MQTT bridge. |
| Android app (optional) | Android 8.0 or later ([`Android/README.md`](../Android/README.md) for source builds). |
| Desktop app (optional) | Windows 10/11 x64 (experimental, unsigned), macOS 13+ (Apple silicon or Intel), or [Linux from source](../desktop/README.md#linux-from-source). Windows downloads and the Windows/macOS Setup Wizard start in the release after `v2.1.0`. Catalog lookup needs a Logitech account; source build prerequisites are in [`desktop/README.md`](../desktop/README.md) and [BUILD.md](BUILD.md). |

## Remotes

Designed for any remote that pairs with the hub; **validated on the Harmony Touch and Smart Control,
and a user reports the Harmony Elite works.**

| Remote | Status |
| --- | --- |
| Harmony Touch | Validated, with stock remote firmware: offline sync, hard keys, on-screen buttons, the number pad, gestures, device screens and press modes. |
| Harmony Smart Control remote | Validated, paired next to a Touch: pairing on the hub with no cloud (Settings → Remotes), its keys driving the same devices as the Touch's, and its activity buttons. It keeps no setup of its own; its buttons live on the hub. If it stops responding, take its coin cell out for 10 seconds, then pair it again. |
| Harmony Elite | Works, per a user report; not yet tested here. Its home control buttons can be set like the Companion's; that was run on a 950, which has the same buttons, not on an Elite ([HOME_CONTROL_BUTTONS.md](HOME_CONTROL_BUTTONS.md#harmony-elite-and-950)). |
| Harmony Companion remote | Supported: activity buttons and per-activity keys in its own maps, edited the same way as the Smart Control's, and its home control buttons (Light 1, Light 2, Plug 1, Plug 2, + / −), each a command, an activity or a sequence with a long press and + / −, for all activities or one ([HOME_CONTROL_BUTTONS.md](HOME_CONTROL_BUTTONS.md)). Community-tested. |
| Harmony 950 | Works next to a Touch on one hub ([TWO_SCREEN_REMOTES.md](TWO_SCREEN_REMOTES.md)). Its home control buttons can be set like the Companion's, labeled as physical dots (`• 1 dot`–`•••• 4 dots`): all four dot buttons and + / − are validated on a 950; a long press and one activity's own buttons are not yet ([HOME_CONTROL_BUTTONS.md](HOME_CONTROL_BUTTONS.md#harmony-elite-and-950)). |
| Other remotes that pair with the hub, such as the Harmony Ultimate | Expected to work, but not yet tested. Features that need a screen apply only to remotes that have one. |
| Phones, tablets and computers | The web, Android and desktop apps. |

Two or more remotes of the same model (e.g. two Smart Controls) can share a hub: turn on
**Settings → Experimental → Multiple remotes of one model** (or install with `--multi-remote on`).
They share one button setup. See [MULTI_REMOTE.md](MULTI_REMOTE.md).

Two remotes with a screen (Touch, Ultimate, Elite, 950) can share a hub too and stay in sync: an
activity started on one shows on both. It is off unless you turn it on (`--two-screen once`, Python
installer, firmware 4.15.600) and was run on a Touch with a 950. See
[TWO_SCREEN_REMOTES.md](TWO_SCREEN_REMOTES.md).

A lost or unused remote can be unpaired in **Settings → Remotes**: every radio slot has its own
**Unpair** button.

No remote needs modified firmware; reports for other remotes welcome
([CONTRIBUTING.md](../CONTRIBUTING.md)).

## Hardware tested with Melodious

Verified on a live hub, across hub control (IR/Bluetooth/network) and the HA integration:

| Hardware | How it's controlled |
| --- | --- |
| Harmony Hub, firmware 4.15.600 | The hub itself, in both its 62 MB and 32 MB RAM versions |
| Harmony Touch, Harmony Smart Control | Paired remotes (a user also reports the Harmony Elite works; see [Remotes](#remotes)) |
| LG webOS OLED TV (`OLED65C4PUA`) | Via Home Assistant `webostv` with Wake-on-LAN: stable HDMI 1–4 port switching and live theater/ARC state; also by IR |
| Hisense Google TV (`75U8H`) | Natively over the network (`codex_androidtv`, TLS) with Wake-on-LAN — see [ANDROID_TV.md](ANDROID_TV.md) |
| SEI Robotics Google TV box (`Box R 4K Plus`) | Via Home Assistant `androidtv_remote` (merged `media_player` + `remote`), and as a Bluetooth HID keyboard/remote target |
| Chromecast with Google TV | Bluetooth HID, including the consumer-page Home/Back and TV keys ([BLUETOOTH_KEYBOARD.md](BLUETOOTH_KEYBOARD.md)) |
| Chromecast Audio | Via Home Assistant (`cast`) |
| Nakamichi Shockwafe soundbar | By IR, linked to the LG's HDMI ARC port for theater state |
| Philips Hue lights | Via Home Assistant (`light`) |
| Nintendo Switch 2 | BLE wake only ([SWITCH2_WAKE.md](SWITCH2_WAKE.md)); Switch 1 wake and Switch controller input are not supported |
