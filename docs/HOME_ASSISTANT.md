# Home Assistant devices

Home Assistant already controls the Hub through HA's built-in Harmony
integration (WebSocket on 8088). This page covers the other direction:
Home Assistant entities as ordinary Harmony devices, which can sit in
activities, go on buttons and run from the web and Android apps.

## How a command reaches Home Assistant

- Each entity is a device in DeviceList whose commands are IP commands
  (`TransportType` 64). The stock engine sends those through
  `harmonyengine/core/ipmanager.lua`, not the IR blaster.
- All Home Assistant devices share one protocol, "Melodious Home
  Assistant", whose `ControlSection` holds the request:
  - `Url`: the integration's webhook;
  - `Method`: `POST`;
  - `Header`: a JSON string;
  - `Body`: `{"device":"{d}","command":"{c}"}`;
  - `Timeout`: `"2"`.
- The engine fills the placeholders with `string.gsub`: `{d}` from the
  device's `Tokens.Parameters` (the entity ID), `{c}` from the command's
  `Parameters` (an action the integration maps to a service call).
- A tap sends one request. A held key repeats it about every 250 ms
  until release.
- The request comes from LuaSocket 2.0.2: plain `http://` only (the Hub
  lacks the Let's Encrypt root), and the `Host` header has no port.
- No Home Assistant token lives on the Hub; the webhook ID is the only
  secret.

## Rules the device data must follow

Each one was learned on hardware. `codexactivity`'s `CommitHaDevices`
writes them; nothing else should create these devices.

1. **`Device.AutoDetectedDevice.Id` is set** (`melodious-ha-<deviceId>`).
   After every answered IP command the engine runs
   `capodDeviceList[params.uid] = nil`. Without a uid that throws, which
   kills the unprotected `ipqueuehandler` task: every later IP command
   drops silently until the Hub reboots, while the Hub still answers
   200. The made-up Id never matches a real SSDP device.
2. **The protocol looks like an IR protocol:** `__type: "IrProtocol"`,
   `IRSegments: []`, `CodeSegments: []`, `CarrierFrequency: 38000`,
   `KeyCode: null`. `model/protocol.lua` reads `ControlSection` only for
   that type.
3. **Each command has** `TransportType: 64`, the protocol's
   `ProtocolId`, `KeyCode: ""`, `Raw: null` written out (the engine
   string-slices `Raw` unless it is null), and its `{c}` parameter.
   The device's `Transport` is 64, not 65 (65 adds an IR fallback).
4. **The webhook always answers 200.** A 404 or no answer makes the
   engine run an SSDP rescan inside the IP task. Unknown commands get
   200 too and are logged on the Home Assistant side.
5. **The webhook answers fast.** The engine discards an IP command that
   waited more than 500 ms in its queue. The integration answers first
   and calls the service afterwards.
6. Devices Melodious makes have no `CD_<id>` content record. The offline
   guard answers that request with an empty record (PR #54), so a Touch
   menu Sync still finishes.

## Saving: why only the writer reaches the Touch

The Touch asks the Hub for each list with `proxy.resource?get`, sending
the etag and hetag it holds. The Hub answers 304 when both match its
in-memory `index.json` (`harmonywebservices/apihandler/resource.lua`,
`isResourceMatch`). A file written straight to disk, as `/import` and
the IR device forms do, keeps its old etag. The Touch therefore keeps
its old copy, even though the reload and publish make it sync.

`CommitHaDevices` saves through `resMgr.saveResource` with a new etag and
hetag for each list it changes. It then reloads the engine with
`config_new` and publishes a new revision. The protocol is saved before
the devices, and a failed save or reload restores both lists. An
unchanged set saves nothing, so a Home Assistant restart that pushes the
same set does not make the Touch sync.

The 2026-10-24 spike wrote through `/import`, so it probably never put
its device on the Touch. Whether the Touch accepts an IP device is still
untested.

## What the Touch shows

- **Devices list:** the device appears there. Tapping it shows no
  commands until it has a `DeviceFunctionMap` and a `DeviceButtonMap`,
  the same as the IR devices Melodious creates. Device screens come with
  the Touch editor's device-screens slice.
- **Activities:** the device's power and inputs run at activity start
  and end, like any other device's.
- **Activity on-screen buttons and sequences:** these can send its
  commands; set them up in the web editor.

## The Home Assistant integration

`custom_components/melodious/` sets up the devices and answers their
webhook calls. Install it through HACS: add this repository as a
custom repository of type Integration.

### Setup

Settings → Devices & services → Add integration → Melodious asks for:
- the hub's address, its web port (8080), and its web UI login if the
  web UI has a password;
- the URL the hub uses to reach Home Assistant. It must be plain
  `http://` and reachable from the hub, for example
  `http://<server-ip>:8123`; a Docker-internal address won't do.

Setup sends the hub an empty dry run, which saves nothing, to check
that the hub has the device writer. Then pick entities under the
integration's **Configure**. Each one becomes a hub device. Removing one
takes its device off the hub, unless an activity or button still uses
it; the hub refuses then, and Home Assistant shows a notification.

### What each entity gets

| Domain | Commands | Power |
|---|---|---|
| `media_player` | PowerOn, PowerOff, VolumeUp, VolumeDown, Mute, Play, Pause, PlayPause, Stop, SkipForward, SkipBack (each when the player supports it); one `Input <source>` per source | on/off |
| `light` | PowerOn, PowerOff, PowerToggle; BrightnessUp/Down (10 %) when dimmable | on/off |
| `switch`, `input_boolean` | PowerOn, PowerOff, PowerToggle | on/off |
| `fan` | as `switch`, plus SpeedUp, SpeedDown | on/off |
| `cover` | Open, Close, Stop | none |
| `script`, `scene` | Run / Activate | none |
| `button`, `input_button` | Press | none |

- The names match the activity wizard's key aliases, so its defaults
  map Volume, Mute and the transport keys by themselves.
- A media player's sources become device inputs. Activities select
  them like any other input.
- A source whose name the hub can't carry exactly (quotes, `%`, braces,
  over 64 characters) is skipped.

### How it stays in step

- **On every Home Assistant start,** and whenever an option changes, the
  integration sends the whole set. An unchanged set saves nothing on
  the hub, so the Touch doesn't sync.
- **When an entity changes** in a way that changes its device (a new
  source, for example), the set goes out again after 5 s.
- **A device keeps every command and input it had.** A player that is off
  or unavailable often drops its sources or features, and rebuilding
  from that would rewrite the hub's DeviceList on every power cycle and
  drop inputs that activities use.
- **Names stay unique,** and a name another hub device already has gets
  " (HA)".
- **A webhook call runs only a command the integration set up for that
  entity.** It runs it without waiting, and always answers 200.
- **Deleting the integration** asks the hub to remove its devices.

## Hardware gate

The owner watches the Touch throughout. Steps run one at a time, and the
gate stops at the first surprise. `HUB` is the Hub's address, `MAC` this
computer's.

1. **Baseline.**
   - Start `node tools/ha_devices.mjs listen --port 8770`.
   - Read the Touch's `/data/loggly/SyncCounter.json` over HOT (see
     `touch-hot.md`): note `lastSyncSuccess` and `lastSyncAbort`.
   - Note the Touch's Devices list.
   - Check that `node tools/ha_devices.mjs status --hub http://HUB:8080`
     shows no devices.
2. **Deploy** with the installer: `--preflight-only` first, then the
   install.
   - The engine keeps the old `codexactivity.lua` loaded until the Hub
     reboots: a request answers `422 unknown local operation`.
   - After the reboot, the writer starts a minute or two after the web UI.
     Until then a request answers `503`.
   - `node tools/ha_devices.mjs plan --hub http://HUB:8080 --webhook
     http://MAC:8770/api/webhook/melodious-gate` runs the real writer as
     a dry run, with nothing saved.
   - Expect `200`, `changed: true`, and `added: ["HA test"]`.
3. **Add the test device** with `apply` and the same options.
   - Expect the Touch to sync by itself within a minute. `logread` shows
     its `proxy.resource?get` for DeviceList and ProtocolList.
   - SyncCounter shows a new `lastSyncSuccess` and no new abort.
   - The Touch's Devices list shows every earlier device plus "HA test",
     and its activities are unchanged.
4. **Send from the Hub:** `node tools/ha_devices.mjs send --hub
   http://HUB:8080 --entity light.melodious_test --command PowerOn`.
   - The listener shows
     `{"device":"light.melodious_test","command":"turn_on"}`.
5. **Activity.**
   - In the web editor, make a test activity that uses "HA test" with
     Input A, and add an on-screen button for its VolumeUp.
   - Start the activity from the Touch: the listener shows `turn_on` and
     `select_source:A`.
   - Tap the button: `volume_up` arrives.
   - End the activity: `turn_off` arrives.
6. **Revert.**
   - Delete the test activity in the editor.
   - Run `node tools/ha_devices.mjs revert --hub http://HUB:8080`.
   - The Touch syncs again, SyncCounter shows success, and "HA test" is
     gone.

Don't send a set while a web editor save is still running. Each request to
the writer goes through one shared request file and one shared response
file, with no lock. If two requests overlap, one waits the full 45 s and
answers `503`; send it again.

### Results, 2026-10-24

- The Touch synced the IP device by itself and listed it beside every
  earlier device. Its activities were intact, and its sync log showed
  success with no abort.
- Tapping the device on the Touch does nothing (it has no device maps),
  as expected.
- Commands sent from the Hub reached the webhook. Repeated sends worked,
  so the IP command task survives.
- Starting and ending an activity from the Touch sent `turn_on` and
  `turn_off`. Overlapping Off and Start presses run side by side in the
  stock engine, so the earlier Off's power-off can land after the
  Start's power-on. IR devices behave the same way.
- The writer refused to remove the device while an activity and its
  button map still used it. After the activity was deleted, revert
  removed the device and the protocol, and the Touch synced back to the
  earlier DeviceList.
- Not tested:
  - **Input selection:** the activity had no input set.
  - **Touch buttons sending an HA command:** the web activity editor
    writes hard buttons only to the `16414Activity<id>` map, never to the
    Touch's `16417Activity<id>` map. This affects every activity made in
    Melodious, not only Home Assistant devices.

If step 3 goes wrong, revert at once; the device is not used yet, so the
writer allows it. Then change one field at a time to find the cause:
Transport, AutoDetectedDevice, Tokens, Parameters, and then the
protocol's shape.
