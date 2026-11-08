# Home Assistant devices

Home Assistant already controls the Hub through HA's built-in Harmony
integration (WebSocket on 8088). This page covers the other direction:
Home Assistant entities as ordinary Harmony devices on the Hub and the
Harmony Touch—usable on their own Touch device screens, as activity
members, or bound directly to any activity's hard keys, on-screen rows,
and swipe gestures. A device may also be a **merged v2 device**: one
Harmony device built from several entities of one Home Assistant device
(see [API.md](API.md#home-assistant-devices)); the hub routes each
command to its entity via the `<alias>:<action>` value.

## How a command reaches Home Assistant

- Each entity is a device in `DeviceList` whose commands are IP commands
  (`TransportType` 64). The stock engine sends those through
  `harmonyengine/core/ipmanager.lua`, not the IR blaster.
- All Home Assistant devices share one protocol, `Melodious Home
  Assistant`, whose `ControlSection` holds the request:
  - `Url`: the integration's webhook (`http://<ha-ip>:8123/api/webhook/...`);
  - `Method`: `POST`;
  - `Header`: `{"Content-Type":"application/json"}`;
  - `Body`: `{"device":"{d}","command":"{c}"}`;
  - `Timeout`: `"2"`.
- The engine fills the placeholders with `string.gsub`: `{d}` from the
  device's `Tokens.Parameters` (the entity ID), `{c}` from the command's
  `Parameters` (an action the integration maps to a service call).
- The engine's HTTP client can do TLS with certificate checking, but the
  Hub's certificate bundle lacks the Let's Encrypt root (ISRG Root X1),
  so in practice the webhook must be plain `http://`. Using a numeric IP
  literal with an explicit port avoids a DNS lookup on every button press.
- No Home Assistant token lives on the Hub; the webhook ID is the only
  secret.

## Press, hold-to-ramp, and one-shot toggle semantics

Hardware validation against the Hub and a Harmony Touch established the
exact wire behavior for IP (`Transport 64`) buttons:

- **Plain buttons (tap and hold-to-ramp):**
  - A quick tap (< 300 ms) sends `press` followed by `release`. The Hub
    fires one HTTP `POST` on `press` and sends nothing on `release`.
  - Holding a button on the Harmony Touch sends `hold` every **300 ms**
    (including hold-swipes on the Touch gesture pad). For a plain IP
    button, the Hub turns **each `hold` into another identical HTTP
    `POST`**. (The web UI keeps a hub-side hold alive with a 200 ms
    heartbeat.)
  - This is ideal for **idempotent** commands (`PowerOn`, `PowerOff`,
    `Play`, `Pause`, `Stop`) and **momentary step** commands
    (`BrightnessUp`, `BrightnessDown`, `VolumeUp`, `VolumeDown`,
    `SpeedUp`, `SpeedDown`), where holding a key or a swipe smoothly
    ramps brightness or volume.
- **One-shot buttons (preventing double-toggles):**
  - On a plain button, pressing a toggle or single-shot command
    (`PowerToggle`, `PlayPause`, `Mute`, `SkipForward`, `SkipBack`, or a
    scene/script) for 300 ms or longer fires a second `POST` on the
    first `hold`, flipping the state right back.
  - Assigning a **self-long press action** (`ButtonLongPressAction` with
    `EventType: 2` pointing to the same device and command as
    `ButtonAction`) engages the Hub's native long-press state machine
    (`activity.lua:1937-1963`):
    - Nothing is sent on initial `press`.
    - Releasing before ~600 ms fires the short action **once** at
      `release` (`modifier: fire`).
    - Holding past the 2nd `hold` (~600 ms) fires the long action
      **once** (`modifier: fire`); later `hold` messages act only as
      heartbeats, and `release` sends nothing.
  - This works identically on both `HardRemoteButton` (physical keys)
    and `SoftRemoteButton` (on-screen rows), guaranteeing **exactly one
    webhook call per press** regardless of how long the button is held.

## Rules the device data must follow

Each rule was verified on hardware. `codexactivity`'s `CommitHaDevices`
writes them automatically; nothing else should create these devices.

1. **`Device.AutoDetectedDevice.Id` is set** (`melodious-ha-<deviceId>`).
   After every answered IP command the engine runs
   `capodDeviceList[params.uid] = nil`. Without a uid that throws, which
   kills the unprotected `ipqueuehandler` task: every later IP command
   drops silently until the Hub reboots, while the Hub still answers
   200. The synthetic Id never matches a real SSDP device.
2. **The protocol looks like an IR protocol:** `__type: "IrProtocol"`,
   `IRSegments: []`, `CodeSegments: []`, `CarrierFrequency: 38000`,
   `KeyCode: null`. `model/protocol.lua` reads `ControlSection` only for
   that type.
3. **Each command has** `TransportType: 64`, the protocol's
   `ProtocolId`, `Raw: null` written out (the engine string-slices `Raw`
   unless it is null, so a missing `Raw` throws), and its `{c}`
   parameter. `KeyCode` may be `""` or null; `""` only logs a harmless
   "Invalid command" when the engine loads the device. The device's
   `Transport` is 64, not 65 (65 adds an IR fallback).
4. **The webhook always answers 200.** For a device with an
   `AutoDetectedDevice.Id` (every device here, rule 1), a 404 or no
   answer makes the engine run an SSDP rescan inside the IP task, at
   most once per 24 h. The scan blocks the IP task for about 10–35 s, so
   IP commands queued meanwhile expire (rule 5). Unknown commands get
   200 too and are logged on the Home Assistant side.
5. **The webhook answers fast.** The engine discards an IP command that
   waited more than 500 ms in its queue. The integration answers first
   and calls the Home Assistant service afterwards.
6. **Missing content records (`CD_<id>`) are answered locally.** Devices
   Melodious makes have no `CD_<id>` content record. The offline guard
   answers that request with an empty record, so a Touch sync always
   completes cleanly.

## Saving: how changes reach the Touch

The Touch syncs by itself when the Hub's state digest shows a new
`stateVersion` together with a new `configVersion` (or
`contentVersion`), which is what a publish (`publishLocalRevision` in
`codexactivity`) does. It then asks the Hub for each list with
`proxy.resource?get`, sending the etag and hetag it holds.

With the cloud blocker on (the normal Melodious setting), the offline
guard in `netservicestarter.lua` answers every such request with 200 and
the file on disk. `CommitHaDevices` saves `ProtocolList`, `DeviceList`,
and `MapList` through `resMgr.saveResource` with a new etag and hetag
for each list it changes, reloads the engine with `config_new`, and
publishes a new revision. The protocol is saved before the devices, and
a failed save or reload restores the previous lists. An unchanged set
saves nothing, so a Home Assistant restart that pushes the same set does
not make the Touch sync.

Each request to the offline writer takes turns on a writer lock
(`flock`), waiting up to 50 s if an activity save is already in
progress.

## Controlling Home Assistant devices from the Touch

Home Assistant devices work in three places on the Harmony Touch:

1. **Dedicated Touch device screens (`16417Device<id>`):**
   - Tapping **Devices** on the Touch and selecting a Home Assistant
     device opens its own screen.
   - `CommitHaDevices` builds and updates that screen automatically from
     the device's commands: `BrightnessUp` and `BrightnessDown` map to
     `VolumeUp` and `VolumeDown`, transport/volume commands (`Play`,
     `Pause`, `Stop`, `VolumeUp`, `VolumeDown`, `Mute`, `SkipForward` →
     `FastForward`, `SkipBack` → `Rewind`) map to their matching
     physical hard keys, and remaining commands (`PowerOn`, `PowerOff`,
     `PowerToggle`, `PlayPause`, inputs) become on-screen rows in
     function group 0.
   - Because hard keys and on-screen rows occupy separate namespaces,
     when a media player dynamically gains `SkipForward` and `SkipBack`
     they land on the physical `FastForward` and `Rewind` keys without
     shifting any existing on-screen row index.
2. **Activity members (automatic power and input routing):**
   - Adding a Home Assistant device to an activity runs its `PowerOn` /
     `PowerOff` and selected `Input <source>` at activity start and end,
     and lets the activity wizard map its transport or volume keys.
3. **Non-member action devices inside any activity:**
   - The Hub and the Touch execute `ButtonCommandAction` bindings for
     any device in `DeviceList`, even if that device is **not** a member
     role of the running activity.
   - This lets you bind room lights, fans, scripts, or a Chromecast
     Audio onto an activity's **hard keys** (such as colour keys, D-pad,
     channel rocker, or transport keys), **on-screen rows** (including
     filling index gaps), or **swipe gestures** (`SwipeUp`/`Down` for
     brightness or volume, `SwipeRight`/`Left` for discrete On/Off)
     without the activity turning those devices on or off when the
     activity starts or ends.
   - Note: `ButtonHomeControlAction` is honored by the stock Hub engine
     only on `Root` maps (`16414Root`); on activity and device maps it
     logs `Device not found` and drops the press. Always use ordinary
     `ButtonCommandAction` bindings to the Home Assistant device in
     `DeviceList`.
   - The Touch & HA Control Studio (`#touch/<activityId>`) and the activity wizard both keep non-member "Extra controls" and their one-shot self-longs across saves. Re-saving never strips them, and defaults never pick non-member devices. Hub-built device screens add self-long (`EventType: 2`) to one-shot commands.

## The Home Assistant integration

The integration lives in
[schlambos/ha-melodious](https://github.com/schlambos/ha-melodious),
with its own releases for HACS. Add
`https://github.com/schlambos/ha-melodious` in HACS as a custom
repository of type **Integration**.

### Setup

Settings → Devices & services → Add integration → Melodious asks for:
- the Hub's address, its web port (`8080`), and its web UI login if the
  web UI has a password;
- the URL the Hub uses to reach Home Assistant. It must be plain
  `http://` and reachable from the Hub, for example
  `http://<server-ip>:8123`; a Docker-internal address won't do.

Setup sends the Hub an empty dry run, which saves nothing, to check that
the Hub has the device writer. Then pick entities under the
integration's **Configure**. Each one becomes a Hub device. Removing one
takes its device off the Hub, unless an activity or button still uses
it; the Hub refuses then, and Home Assistant shows a notification.

### What each entity gets

| Domain | Commands | Power |
| --- | --- | --- |
| `media_player` | `PowerOn`, `PowerOff`, `VolumeUp`, `VolumeDown`, `Mute`, `Play`, `Pause`, `PlayPause`, `Stop`, `SkipForward`, `SkipBack` (each when the player reports the feature); one `Input <source>` per source | on/off |
| `light` | `PowerOn`, `PowerOff`, `PowerToggle`; `BrightnessUp` / `BrightnessDown` (±10 %) when dimmable | on/off |
| `switch`, `input_boolean` | `PowerOn`, `PowerOff`, `PowerToggle` | on/off |
| `fan` | as `switch`, plus `SpeedUp`, `SpeedDown` | on/off |
| `cover` | `Open`, `Close`, `Stop` | none |
| `script`, `scene` | `Run` / `Activate` | none |
| `button`, `input_button` | `Press` | none |

- Command names match the activity wizard's key aliases, so its defaults
  map Volume, Mute, and the transport keys automatically.
- A media player's sources become device inputs (`select_source:<src>`).
  Activities select them like any other input.
- A source whose name the Hub can't carry safely (quotes, `%`, braces,
  or over 64 characters) is skipped.

### How it stays in step

- **On every Home Assistant start,** and whenever an option changes, the
  integration sends the whole set. An unchanged set saves nothing on the
  Hub, so the Touch doesn't sync.
- **When an entity changes** in a way that expands its device (a new
  source, or `SkipForward`/`SkipBack` appearing when media starts
  playing), the updated set goes out after 5 s.
- **A device keeps every command and input it has ever reported.** A
  media player or smart bulb that is off or idle often drops its sources
  or queue features; merging rather than replacing prevents `DeviceList`
  rewrites on every power cycle and preserves commands bound to buttons.
- **Names stay unique,** and a name another Hub device already has gets
  ` (HA)`.
- **A webhook call runs only a command the integration set up for that
  entity.** It answers `200` immediately and dispatches the service call
  in the background.
- **Live state (`POST /api/ha-state`, `GET /api/ha-state?since=<version>`):**
  when the hub reports `ha-state` in `GET /api/version`, the integration
  pushes a volatile snapshot of each exposed device's power, input/source,
  volume, mute, playing state and current app (debounced to 2 s with a 30 s
  heartbeat). The hub stores it only in `/var/volatile/codex-ha-state.json`
  (never flash) and marks it stale after 90 s without a push so the web and
  Android apps show "State unknown", never "Off", when Home Assistant is
  unreachable.
- **LG theater state (Phase 6):** an LG snapshot may also carry `theater`
  (active HDMI port, per-port connected/signal/CEC name, and the TV-reported
  sound output with volume and mute) and `theater_links` (explicit,
  display-only HDMI-port -> hub-device links from the integration's
  options). The hub stores both without parsing them; the web app shows the
  live/connected ports and "Sound: <bar> (ARC) · Vol <n>" on the LG's device
  and remote screens, and the same observations on a linked device's screen.
  A link never implies the linked device's power: connection, video signal
  and ARC are observations, not measured power. Older integrations simply
  don't send these fields.
- **Deleting the integration** leaves the Hub's devices intact unless
  they are unticked in Configure first.

## Command-line tool (`tools/ha_devices.mjs`)

`tools/ha_devices.mjs` inspects, tests, and manages Home Assistant
devices directly against `POST /api/ha-devices`:

```bash
# List Home Assistant devices and commands currently on the Hub
node tools/ha_devices.mjs status --hub http://<hub-ip>:8080

# Dry-run a device set (validates without writing or syncing)
node tools/ha_devices.mjs plan --hub http://<hub-ip>:8080 --set devices.json

# Apply a device set, or send a single command through the Hub
node tools/ha_devices.mjs apply --hub http://<hub-ip>:8080 --set devices.json
node tools/ha_devices.mjs send --hub http://<hub-ip>:8080 --entity light.living_room --command PowerOn

# Run a local 200-OK webhook listener to inspect incoming Hub POSTs
node tools/ha_devices.mjs listen --port 8770
```
