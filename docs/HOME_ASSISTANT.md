# Home Assistant devices

Melodious connects the hub and Home Assistant in both directions:

| Direction | How |
| --- | --- |
| **Harmony controls Home Assistant** | The [Melodious integration](https://github.com/schlambos/ha-melodious) turns whole Home Assistant devices (merged) or single entities into ordinary devices on the hub (`TransportType: 64`). Activities, physical remote buttons, Touch screens and the apps drive them through a local webhook, and every command also fires a `melodious.command_received` event in Home Assistant, so a button can chain into any automation. |
| **Home Assistant controls Harmony** | The Melodious integration also exposes the hub itself as a `remote` entity in Home Assistant: `turn_on` / `turn_off` start and stop activities, and `send_command` sends any command to any IR, Bluetooth or Home Assistant device on the hub. The optional MQTT bridge and Home Assistant's built-in Logitech Harmony integration also keep working over the hub's local connections. |
| **Live state back to Harmony** | Home Assistant pushes live device state (power, input/source, current app, playing or paused, volume and mute, plus an LG webOS TV's HDMI port and ARC status) to the hub's RAM-only `/api/ha-state` channel, where the web and Android apps show it. |

This page is the deep reference for all three: merged device profiles,
the per-domain command table, the `remote` entity and event, live state,
LG theater/ARC state and port links, redundant-command skipping, the
MQTT topic table, and the hub-side rules each piece must follow.

Home Assistant entities as ordinary Harmony devices are usable on their
own Touch device screens, as activity members, or bound directly to any
activity's hard keys, on-screen rows, and swipe gestures. A device may
also be a **merged v2 device**: one Harmony device built from several
entities of one Home Assistant device (see
[API.md](API.md#home-assistant-devices)); the hub routes each command to
its entity via the `<alias>:<action>` value.

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

1. In HACS, add `https://github.com/schlambos/ha-melodious` as a custom
   repository of type **Integration**, then install Melodious.
2. Settings → Devices & services → Add integration → Melodious asks for:
   - the Hub's address, its web port (`8080`), and its web UI login if the
     web UI has a password;
   - the URL the Hub uses to reach Home Assistant. It must be plain
     `http://`, because the hub's certificate bundle lacks the Let's
     Encrypt root, and reachable from the Hub, for example
     `http://<server-ip>:8123`; a Docker-internal address won't do.
3. Open the integration's **Configure**, and pick whole devices and/or
   single entities. The review step lists each merged device's entities
   and commands; untick any entity or command you don't want on the hub.

Setup sends the Hub an empty dry run, which saves nothing, to check that
the Hub has the device writer. Each pick becomes a Hub device. Removing
one takes its device off the Hub, unless an activity or button still
uses it; the Hub refuses then, and Home Assistant shows a notification.

### What each entity gets

| Domain | Commands | Power and inputs |
| --- | --- | --- |
| `light` | `PowerOn`, `PowerOff`, `PowerToggle`, plus `BrightnessUp` and `BrightnessDown` (±10 %) when dimmable | On and off |
| `media_player` | `PowerOn`, `PowerOff`, `VolumeUp`, `VolumeDown`, `Mute`, `Play`, `Pause`, `PlayPause`, `Stop`, `SkipForward`, `SkipBack`, each when the player supports it | On and off, plus one `Input <source>` per source |
| `switch`, `input_boolean` | `PowerOn`, `PowerOff`, `PowerToggle` | On and off |
| `fan` | As `switch`, plus `SpeedUp` and `SpeedDown` | On and off |
| `cover` | `Open`, `Close`, `Stop` | None |
| `script`, `scene` | `Run` / `Activate` | None |
| `button`, `input_button` | `Press` | None |
| `remote` | `DirectionUp`/`Down`/`Left`/`Right`, `Select`, `Back`, `Home`, `Menu`, digits and colour keys, where the platform's key table has them | — (merged with its `media_player`) |
| `select` | One `Input <option>` per option (AVR source selectors), routed to `select.select_option` | — |

- Command names match the activity wizard's key aliases, so its defaults
  map Volume, Mute, and the transport keys automatically.
- A media player's sources become device inputs (`select_source:<src>`).
  Activities select them like any other input.
- A source whose name the Hub can't carry safely (quotes, `%`, braces,
  or over 64 characters) is skipped.

### Merged device profiles

Picking a **whole Home Assistant device** merges all of its entities
into one Harmony device under a profile for its platform. A duplicate
Cast twin of the same hardware is suppressed automatically, so one
physical player never appears twice.

- **LG webOS TV (`webostv`).** Discrete `PowerOn`/`PowerOff` when
  Wake-on-LAN is enabled in Home Assistant (`PowerToggle` otherwise),
  `VolumeUp`/`VolumeDown`/`Mute`, transport, the full D-pad with `Back`,
  `Home`, `Menu`, `Guide`, `Info` and `Exit`, digits `0`–`9`, colour keys
  and channel up/down. Inputs are stable `Input HDMI 1` to
  `Input HDMI 4` commands, switched by hardware port ID
  (`tv/switchInput`), so a CEC label change never breaks an activity.
  Apps get their own `App <name>` commands.
- **Google TV / Android TV (`androidtv_remote`, and the older
  `androidtv` ADB integration).** Discrete `PowerOn`/`PowerOff`, volume
  and transport come from the `media_player`, merged with the D-pad,
  `Select`, `Back`, `Home`, `Menu`, digits and colour keys from the
  `remote`, plus `App <name>` commands when the box reports an app list.
- **AVRs and other source selectors.** Each option of a `select` entity
  becomes an `Input <option>` command, so an activity picks the AVR's
  input like any other.
- **Cast players, lights, switches, fans, covers, scripts, scenes and
  buttons** keep the per-domain commands in the table above.

Commands are never lost: a device keeps every command and input it has
ever reported. A player that's off often stops reporting its sources,
and merging instead of replacing keeps buttons bound to them working.
When a player gains `SkipForward` and `SkipBack` once media plays, the
update reaches the hub within 5 s.

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
  options). The hub stores both without parsing them; the web and Android
  apps show the live/connected ports and "Sound: <bar> (ARC) · Vol <n>" on
  the LG's device and remote screens, and the same observations on a linked
  device's screen.
  A link never implies the linked device's power: connection, video signal
  and ARC are observations, not measured power. Older integrations simply
  don't send these fields.
- **Deleting the integration** leaves the Hub's devices intact unless
  they are unticked in Configure first.
- **From the apps.** Each Home Assistant device page in the web and
  Android apps has its own remote, outside any activity.

### Live state in the apps

The web and Android apps show the pushed state as a state strip on the
running activity's remote and on each device page (On/Off, input, app,
Playing/Paused, volume and mute). Fix It uses it too, hinting *"already
on · on HDMI 1"* and dimming commands the device doesn't need. If Home
Assistant is unreachable for 90 s, the apps show **State unknown** —
never **Off**.

While an LG webOS TV is on, the integration also reads its external
HDMI port list, which port is active, the CEC device names, each port's
signal status, and the ARC soundbar's volume and mute. An LG HDMI port
can be linked to any device on the hub (IR, Bluetooth or Home
Assistant) so the apps can show which port it's on. A link is for
display only: it never merges devices or changes what a button sends.

### Redundant commands are skipped (smart startup)

When Home Assistant reports a device is already on, a discrete
`PowerOn` does nothing; when an LG TV is already on the wanted HDMI
port — or a player or selector is already on that source — the input
switch does nothing either. Activities start faster and don't disturb a
TV that's already showing the right thing. The
`melodious.command_received` event still fires, so automations chained
to the button always run.

### Controlling the hub from Home Assistant

**The hub as a `remote` entity.** The Melodious integration adds one
`remote` entity per hub. `remote.turn_on` starts an activity (by name
or ID), `remote.turn_off` turns everything off, and
`remote.send_command` sends any hub command by device and command name
— IR, Bluetooth and Home Assistant devices alike — with `num_repeats`,
`delay_secs` and `hold_secs`. It reports the running activity and the
hub's devices, and shows unavailable (never off) when the hub can't be
reached.

**The `melodious.command_received` event.** Every command the hub sends
to a Home Assistant device also fires this event in Home Assistant
(hub, device, entity and command), so a Harmony button can trigger any
automation — including when the underlying command was skipped as
redundant (above).

**Built-in Harmony integration.** Home Assistant's built-in Logitech
Harmony integration keeps working locally over the hub's WebSocket
(8088), alongside Melodious.

**Repeated pushes are cheap.** Repeated identical `/api/ha-devices`
(and `/api/androidtv/devices`) pushes are memoized in RAM on the hub,
so an unchanged or refused device set never triggers a flash backup or
reloads the engine.

### The MQTT bridge

The bridge uses `harmony/hub` as its base topic and `homeassistant` as
its discovery prefix by default. You can change both. Set it up at
install time (see [INSTALL.md](INSTALL.md)) or in Settings → MQTT.

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

MQTT is a control channel: anyone who can publish to these topics can
start activities, send IR and run hub-engine commands. The bridge
doesn't use TLS, so use a broker with authentication (see
[SECURITY.md](SECURITY.md)).

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
