# How Melodious works

Melodious runs on a rooted Harmony Hub, next to Logitech's own firmware. It takes over the cloud's
jobs (devices, activities, remote sync) and connects the hub and Home Assistant both ways. This page
covers how the pieces fit, what offline operation means, and how presses, holds and gestures are
timed. For the HTTP API see [API.md](API.md); for the hub's own protocols and ports see
[PROTOCOLS.md](PROTOCOLS.md).

## Overview

```text
Phone or computer
  ├─ web app ─────► http://<hub-ip>:8080 ── codex_webui (one static C binary)
  ├─ Android app ─► the same API, plus the hub's WebSocket on :8088
  └─ desktop app ─► the web app's bundle; only the app itself talks to Logitech

codex_webui
  ├─ codex_hbus ─────────► the hub's activity engine (activities, IR, learning)
  ├─ codexactivity.lua ──► the hub's resource manager (every activity, device,
  │                         Home Assistant and screen save; publishes revisions)
  ├─ codex_androidtv ────► network Android/Google TVs (127.0.0.1:8095, BearSSL TLS)
  ├─ codex_hal_ltcp, codex_bthid_keyboard, codex_bt_pair_agent ──► Bluetooth
  └─ JSON files on the hub's flash (/data)

Paired remote ◄── pull sync ── netservicestarter.lua (answers from local files)
Home Assistant ◄── webhook POST ── engine IP commands (Transport 64)
Home Assistant ──► POST /api/ha-state ──► RAM-only live state for the apps
Home Assistant ◄── remote entity ── the Melodious integration (activities and
                                    send_command back to the hub's API)
Home Assistant ◄─► MQTT ── codexmqtt.lua
Logitech cloud ✕  cloud tasks not started, hosts refused, WAN route removed
```

Both sides share the same apps, the same button mapping and the same save path. To the hub, an IR
code, a Bluetooth key and a Home Assistant action are all ordinary device commands.

- **On Logitech's engine:** stock activity engine/resource manager do IR, activities and the remote
  protocol; Melodious saves the engine's own way, so the remote accepts every change.
- **Server:** one static Zig-built MIPS binary (:8080, fork per request) with the framework-free web
  app compiled in (`harmony_shell_assets.h`) — one page, one script, one stylesheet.
- **Plugins:** `codexactivity.lua` (single writer: activities/devices/HA/screens), `codexmqtt.lua`
  (MQTT), `codex_androidtv` (network TVs, BearSSL :8095), `netservicestarter.lua` (cloud block,
  sync, clock).
- **Transactional saves:** validate → back up → write → read back → reload → publish revision;
  failure restores prior files. Backups kept: 5 resource / 3 handoff
  ([INSTALL.md](INSTALL.md#rolling-back-an-update)). The remote *pulls* revisions, answered locally
  — [TOUCH_EDITOR.md](TOUCH_EDITOR.md). A setup changed since you opened it refuses the save.
- **HA path:** IP commands POST to the integration webhook (instant 200, service after); back the
  other way, a `remote` entity drives the hub API and live state lands in RAM-only `/api/ha-state`
  (stale 90 s). Rules: [HOME_ASSISTANT.md](HOME_ASSISTANT.md) · [API.md](API.md).
- **Network:** apps load nothing online — IRDB is browser-side on click, RemoteCentral fetch is on
  click (route removed by the blocker), Logitech only for catalog lookup.

## Offline operation

- **The cloud is blocked.** Logitech's cloud tasks don't start, Logitech/PubNub requests fail
  cleanly, and the internet route is removed — LAN, SSDP/mDNS discovery, MQTT and Home Assistant
  keep working.
- **The paired remote syncs from the hub.** Each save publishes a new revision, which the remote
  pulls within seconds — no MyHarmony account and no cloud copy to overwrite your edits.
- **Syncs finish offline:** the connectivity, time and device-content checks along the way are all
  answered locally.
- **The hub keeps its own time** over NTP (temporary route per query); set the time zone in System.
  You can choose a custom NTP server instead of the default public ones (System -> Custom NTP
  server, or `--ntp-server <host>`); then only that server is asked.
- **Local edits are protected:** System → Cloud egress turns the blocker on (there's no off
  control), and activity/device edits are refused while it's off.

Offline is the supported mode — Logitech app/cloud use can overwrite local edits
([SECURITY.md](SECURITY.md)).

## What the hub does

A summary of the features each user guide walks through.

**Devices and codes** ([DEVICES_AND_CODES_GUIDE.md](DEVICES_AND_CODES_GUIDE.md))

- **Device settings:** power mode (discrete/toggle/none), warm-up, Always on / Keep on, inputs,
  timing. **Learn a button** from the original remote, then test and save.
- **Import codes** via IRDB search, Flipper `.ir` files, pasted IRDB CSV / `name|mode|code` / Pronto
  hex, a RemoteCentral fetch, or typing a code — NEC, Samsung, Sony, RC5/6 and more converted with
  proper frame timing.
- **Logitech catalog** (Desktop app on Windows, Linux, macOS + Android app): sign in, search
  brand/model, preview (skips explained), import. Credentials never reach the hub. See
  [DESKTOP_APP.md](DESKTOP_APP.md) · [ANDROID_CATALOG.md](ANDROID_CATALOG.md).
- **Find what works:** Send all (dry run, set gap, Stop) or the IR lab scratch device.

**Activities** ([ACTIVITIES_GUIDE.md](ACTIVITIES_GUIDE.md))

- **Setup wizard:** Name → Devices → Inputs → Buttons (36 keys, press + hold) → Review. New
  activities power on Display → Volume → Player with waits between devices (2.5 s TV, 1.5 s
  AVR/soundbar, 1 s player) and get the Touch's number pad and on-screen Home button; existing ones
  keep their saved order/waits.
- **Advanced editor:** roles, per-remote button maps, activity JSON. Android adds **Start and end**
  (power order + start/end commands).
- **Saves are transactions:** validated, written, read back, rolled back on failure; a setup changed
  since opening refuses the save.

**Network TVs** ([ANDROID_TV.md](ANDROID_TV.md))

Android/Google TV over the network, not IR: Devices → + → **Android or Google TV on the network**,
type the on-screen pairing code, name it. Every key then goes over the network (power on from
standby, Wake-on-LAN for deep sleep), PowerOn/Off never toggle wrong, and the TV works in
activities, on buttons and on Touch screens.

**Bluetooth keyboard** ([BLUETOOTH_KEYBOARD.md](BLUETOOTH_KEYBOARD.md)) and **wired Ethernet** over
a self-powered OTG micro-USB Realtek adapter ([USB_ETHERNET.md](USB_ETHERNET.md)).

**More on the hub**

- **Backup/restore:** ten single exports or one owner bundle — pre-checked restores, rolling backups.
- **Wi-Fi recovery:** hold reset → open `Harmony-Recovery-xxxxxx` network, portal at
  `http://192.168.76.1/` ([SECURITY.md](SECURITY.md)).
- **Sign-in** (optional HTTP Basic) and a **local HTTP API** for scripts/automations:
  [API.md](API.md).

## Buttons, gestures and timing

Same behaviour for IR, Bluetooth and Home Assistant commands; timings measured on the Harmony Touch.

### Where a command can go

| Control | What the remote sends | Notes |
| --- | --- | --- |
| Hard keys | `press`, then `hold` every 300 ms, then `release` | The wizard writes the hub's activity map and copies the keys to the remote's map. Only changed keys are copied, so mappings that exist only on the remote survive. |
| On-screen buttons | `press` and `release`, plus `hold` every 300 ms while held | Each button keeps its slot. A new button takes the lowest free slot, and nothing is renumbered unless you move a button. |
| Number pad | A single `fire` per digit | Kept in its own slot space. |
| Gestures (`SwipeUp`, `SwipeDown`, `SwipeLeft`, `SwipeRight`, `Tap`) | Resolved on the remote, against the target device's screen, then sent as an ordinary press | The target device needs a screen with that command. If a gesture resolves to a hard key, the activity must map that key too. |

Edit via Activities → ⋮ → **On-screen buttons** (`#touch/<id>`, one tap from the running activity):
on-screen/hard-key/gesture tabs, hold picker, gesture simulator, device-screen Make/Rebuild/Remove
(HA auto). Android: on-screen/buttons only. Details: **[TOUCH_EDITOR.md](TOUCH_EDITOR.md)**.

### Press modes

| Mode | What happens | Default for |
| --- | --- | --- |
| Standard | Fires on press, then again on every hold, about every 300 ms | Step commands (`VolumeUp`/`Down`, `BrightnessUp`/`Down`, `SpeedUp`/`Down`) and commands that are safe to repeat (`PowerOn`, `Play`) |
| One-shot | Fires once: at release if you let go before about 600 ms, or at about 600 ms if you hold. Later holds are ignored | `PowerToggle`, `PlayPause`, `Mute`, `SkipForward`, `SkipBack`, `Run`, `Activate`, `Press` |
| Short + long | One command for a tap, another for a hold | — |

One-shot reuses the hub's long-press handling so a held toggle fires a single webhook instead of
flipping twice; gestures can't use it, so the editor warns on gesture toggles. The Home Assistant
side of these rules is in [HOME_ASSISTANT.md](HOME_ASSISTANT.md#press-hold-to-ramp-and-one-shot-toggle-semantics).
