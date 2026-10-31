# Local Control API

`codex_webui` serves the web UI and its API on one port (8080). The route
table comes from `handle_client()` in `payload/source/codex_webui.c`; each
route below names the handler that implements it.

HTTP Basic authentication is optional. When enabled from the System view,
the same global check protects every page, API route and export; otherwise
the interface is open on the local network (`handle_client()`,
`webui_auth_ok()`).

Most write endpoints accept `application/x-www-form-urlencoded` bodies.
The transactional activity save endpoint and the catalog import accept
`application/json`. JSON responses use `ok: true` on success and
`ok: false` with `error` on failure. Request bodies are limited to
1 MiB (`MAX_REQUEST_BODY`); an oversized body gets
`413 Payload Too Large`.

## Pages and assets

| Method | Path | Handler | Response |
| --- | --- | --- | --- |
| GET | `/`, `/index.html` | `render_harmony_shell()` | The web UI shell (HTML). |
| GET | `/assets/harmony-shell.css`, `/assets/harmony-shell.js` | `send_embedded_asset()` | Embedded shell assets. |
| GET | `/assets/activity-ui.css`, `/assets/activity-ui.js` | `send_embedded_asset()` | Embedded activity-editor assets. |

An unmatched route gets `404 Not Found`.

## Activities

Load the native activity, remote-button-map, activity-function-map and
device resources plus a conflict revision (`render_activity_config_json()`):

```text
GET /api/activity-config
```

Returns `200` with `revision`, `activityList`, `mapList`, `functionList`
and `deviceList`. A resource file that cannot be read gives `503`.

Read or start the current activity (`render_activity_state_json()`,
`render_activity_run_json()`):

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/activity-state"

Invoke-RestMethod "http://<hub-ip>:8080/api/activity-run" -Method Post -Body @{
  activityId = "<activity-id>"
}
```

`/api/activity-run` takes the form field `activityId`. Use `-1` as the
activity ID to run `PowerOff`. An invalid ID gives `400`; an engine failure
gives `502`.

Save the three activity resources as one transaction
(`render_activity_save_json()`):

```json
{
  "baseRevision": "01234567-89abcdef-fedcba98",
  "syncRemote": true,
  "activityList": {"Activities": []},
  "mapList": {"ButtonMaps": [], "FunctionMaps": null},
  "functionList": {"FunctionMaps": []}
}
```

```text
POST /api/activity-save
Content-Type: application/json
```

`baseRevision` must match the value returned by `/api/activity-config`. A
stale editor receives `409 Conflict`, preventing another local editor from
being overwritten. A body missing any of the three resources, or a resource
that fails validation, gives `400`; unreadable stored resources give `503`.
If the plugin hasn't answered within 120 s, the reply is `504` with
`"pending": true`: the save may still land, so nothing is rolled back.
Reload `/api/activity-config` a minute later to see whether it did.
Before writing, the Hub snapshots all resource files (see Backup retention).
The endpoint compares parsed JSON rather than serialized bytes, so
whitespace, object-key order, escaped characters and equivalent number
formatting do not turn an unchanged browser payload into a resource write.
Changed data is passed over a root-only volatile file channel to
`codexactivity.lua`. That plugin refuses every write unless
`/data/codex/cloud_blocker.conf` is exactly enabled.

The plugin calls the firmware resource manager's local `saveResource`
method directly. It does not call the resource proxy, create an offline
request, invoke the firmware sync task, or contact an account service. It
writes and verifies all three resources, reloads `ActivityList`,
`FunctionList` and `MapList` in the local activity engine, increments the
local configuration digest, and notifies connected local clients. All three
resource etags are refreshed for every transaction so role, hard-button and
control-group-only edits all create a new paired-remote configuration
revision.

When the paired handset later performs its own synchronization, the guarded
network-service layer serves `proxy.resource?get` from the Hub's local
resource manager, acknowledges `proxy.resource?put` without changing
Hub-owned files or creating a cloud queue entry, and answers `setup.sync*`
locally. A separate egress guard removes the WAN default route while
preserving LAN and multicast routes. This prevents firmware conflict
reconciliation from downloading an older Logitech ActivityList, MapList
and FunctionList over the local edits.

If any resource write, read-back, engine reload or digest update fails, the
plugin restores all three previous resources and their metadata. The web
endpoint performs a second semantic read-back and requests another local
compensation if needed. Successful responses include `activityChanged`,
`mapChanged`, `functionChanged`, `localOnly: true` and `remoteRefreshed`.

### Activity map identity rules

Harmony stores one `ActivityButtonMap` for every activity on every
compatible paired-remote surface. The map's `ActivityId-` and the numeric
suffix of `ButtonMapIdentifier` must identify the same activity. Deleting
an activity must delete all of its activity maps.

This deployment is strictly offline: Logitech cloud is blocked and no
server or cloud allocator ever assigns identities. The offline
implementation must allocate persistent map and button identities itself,
locally, at creation time.

Genuine Logitech configs set a positive `ButtonMapId-` on every map and a
positive unique `ButtonId` plus `ButtonState: 1` on every button. Omitting
those or writing zeros breaks the paired physical remote (hub firmware
does not read `ButtonId` / `ButtonMapId-` / `ButtonState`, but the remote's
separate firmware does).

**Allocate locally (offline only):**

- Map IDs and button IDs use two disjoint bands. Genuine map IDs occupy
  40,550,459 to 52,944,089; genuine button IDs occupy 1,357,129,005 to
  1,878,029,713. Allocate new map IDs above 52944089 and new button IDs
  above 1878029713 so a value Logitech once issued is never reused.
  Signed-int32 ceiling is 2147483000.
- Build the ID pool by scanning all four resources: `activityList`,
  `mapList`, `functionList`, and `deviceList` (`deviceList` holds 168
  `Id-` values spanning 1,933,417 to 81,897,247).
- Only these keys are identities to allocate: `Id`, `Id-`, `ButtonId`,
  `ButtonMapId`, `ButtonMapId-`.
- These keys are foreign-key references and must never be allocated or
  rewritten: `FunctionId-`, `DeviceId-`, `ActivityId-`, `RemoteId-`,
  `SurfaceId-`, `ButtonMapSurfaceId-`, `AccountId-`, `ParentDevice-`,
  `GlobalDeviceVersionId-`, `ContentProfileKey`, `ProtocolId`.
- Allocation is idempotent: allocate only when a value is absent, null,
  non-integer, or `<= 0`; never renumber a valid positive ID; a second pass
  changes nothing.
- Set every button's `ButtonState` to `1`. Use `Sequences: []`, not `null`.
  Never invent `SequenceId` / `SequenceId-` (absent from all real configs).
- Nested action `Id` stays `0` for `ButtonCommandAction` and
  `ButtonActivityAction` (genuine configs keep all of these at 0). A nonzero
  `ButtonClientAction.Id` must be preserved, never zeroed.
- Retain the remote and surface references.
- Use the new activity ID in `ActivityId-` and `ButtonMapIdentifier`.
- An `ActivityButtonMap` must contain **only** buttons that carry an action.
  Never persist a button whose `ButtonAction`, `ButtonLongPressAction` and
  `ButtonDoublePressAction` are all null, and never pad a map to a fixed
  size. Genuine Logitech configs contain zero action-less buttons in all 19
  maps, and their activity map button counts vary (15 to 54) because
  Logitech includes only the buttons an activity can actually drive; a
  two-device activity legitimately has 15 buttons rather than a padded 36.

  This is not cosmetic. The hub tolerates action-less buttons and silently
  drops them (`getButtonMaps` only registers a button when its parsed
  action list is non-empty), so every hub-side check passes. The paired
  physical remote does not: starting an activity whose maps contain an
  action-less button makes the remote flash "starting activity", return to
  its home screen, and stop responding to every button until it is
  power-cycled. Verified on hardware — pruning the action-less buttons from
  two affected activities restored full remote control immediately.

  Pruning is scoped to activity maps. `RootButtonMap` legitimately ships
  action-less shortcut buttons, and activity selection and power-off work
  through it, so it is neither pruned nor rejected.

Firmware identity keys (from `harmony-userconfigreader.decompiled.lua`):
maps are keyed by the string `ButtonMapIdentifier` (lines 11574/11578/11585);
buttons are keyed by the string `ButtonKey` (line 11602); any button with no
parsed action is dropped (line 11629). `ButtonId`, `ButtonMapId-`, and
`ButtonState` are read by zero hub firmware modules. Genuine parity still
matters because the physical remote runs separate, undecompiled firmware
that fails without them.

The editor reloads after every save. On load it also repairs the
recoverable split state left by older builds: orphaned activity maps are
removed and missing per-surface maps are recreated with locally allocated
positive identities, then presented as an unsaved repair for review.

Every activity must also have exactly one `ActivityFunctionMap` in
`FunctionList.json`. These maps produce the command/control groups returned
by `harmony.engine?config`; a button map alone can make an activity appear
while leaving it with no generated controls. The editor removes orphaned
function maps, creates a missing one from current device roles, and exposes
the selected activity's full FunctionMap under **Advanced JSON**. The
Hub-side writer rejects orphaned activities, deleted device references,
duplicate activity function maps, or a missing function map before writing
anything.

`syncRemote: true` is retained for API compatibility, but it never selects
a network path. It forces a local etag/configuration-digest refresh even
when the resource bodies are unchanged. Refresh the currently stored
configuration without an edit using (`render_activity_sync_json()`):

```text
POST /api/activity-sync
```

This endpoint is also strictly local. It returns `syncQueued: false` and
`synced: false`; `remoteRefreshed: true` means the Hub published a new
local configuration revision for paired remotes. The deployed writer
publishes that revision as soon as the resources are saved and reloaded; it
does not wait for the activity-execution task to finish rebuilding, so a
paired remote can see the new revision slightly before the activity engine
is ready. Unreadable or invalid stored resources give `503`.

Save one device's settings (`render_device_settings_json()`):

```text
POST /api/device-settings
Content-Type: application/json
```

The body carries a numeric `deviceId` and a `settings` object (at most
16 KiB). The settings go to the offline writer as a
`CommitDeviceSettings` operation after a resource backup.

Writer requests from every route take turns. Each connection is served
by its own `codex_webui` child, and all of them share one request file
and one response file, so each request takes an exclusive lock on
`/var/volatile/codex-activity.lock` first. A request that can't get the
lock within 50 s gives `503` with "another change is still being saved
on the hub". Success is `200`
with `saved: true` and `localOnly: true`. An invalid body gives `400`; a
writer refusal gives `422`; a writer that cannot be reached gives `503`.

## Home Assistant devices

Replace the hub's Home Assistant devices (`render_ha_devices_json()`):

```text
POST /api/ha-devices
Content-Type: application/json
```

```json
{
  "webhook": "http://<ha-host>:8123/api/webhook/<webhook-id>",
  "dryRun": false,
  "devices": [{
    "entity": "media_player.living_room",
    "name": "Living Room Speaker",
    "commands": [
      {"name": "PowerOn", "value": "turn_on"},
      {"name": "PowerOff", "value": "turn_off"},
      {"name": "InputTv", "value": "select_source:TV"}
    ],
    "power": {"on": "PowerOn", "off": "PowerOff"},
    "inputs": [{"name": "TV", "command": "InputTv"}]
  }]
}
```

Each device becomes an ordinary Harmony device whose commands are IP
commands (`TransportType` 64). They can sit in activities and on buttons
like any other device. When one runs, the Hub engine posts
`{"device":"<entity>","command":"<value>"}` to the webhook. The body goes
to the offline writer as a `CommitHaDevices` operation (at most 256 KiB),
after a resource backup unless `dryRun` is true.

- The writer owns the devices whose `AutoDetectedDevice.Id` starts with
  `melodious-ha-` and matches them by `entity`. It adds, updates and
  removes only those, and keeps device and command IDs across updates.
  It never touches other devices.
- `power` is `{"on","off"}`, `{"toggle"}` or absent. Each input names
  one of the device's commands.
- `webhook` must be plain `http://`: the Hub cannot verify Let's Encrypt
  certificates. An empty `devices` list needs no webhook; it removes
  every Home Assistant device and their protocol.
- Command values may not contain quotes, backslashes, `%` or braces.
- It refuses to remove a device, command or input that an activity,
  button or sequence still uses. It also refuses a name another device
  already has.
- A changed set saves DeviceList and ProtocolList with new etags, reloads
  the engine and publishes a new revision, so a paired Touch pulls it. An
  unchanged set saves nothing.

- On a hub with a Harmony Touch, each device also gets a Touch screen
  built from its commands (see [Touch device screens](#touch-device-screens)),
  rebuilt when its commands change and removed with the device. Its own
  screen doesn't count as a use. MapList is saved after DeviceList and
  reloaded with it.

The writer's reply is the body: `200` with `ok`, `changed`, `dryRun`,
`screensChanged`, the `added`, `updated`, `removed` and `unchanged`
device names, and `devices` (`entity`, `deviceId`, `name`). A non-object body gives `400`;
a writer refusal gives `422` with `error`; a writer that cannot be
reached gives `503`. See [HOME_ASSISTANT.md](HOME_ASSISTANT.md).

## Touch device screens

On the Harmony Touch, Devices then a device opens that device's screen.
The Touch builds it from the device's `16417Device<id>` map in MapList
alone: its sync never pulls FunctionList, so no `DeviceFunctionMap` is
needed. A device without the map is listed but opens nothing.

Make, rebuild or remove one device's screen (`render_device_screen_json()`):

```text
POST /api/device-screen
Content-Type: application/json
```

```json
{"deviceId": "40000001", "remove": false, "dryRun": false}
```

The request goes to the offline writer as a `CommitDeviceScreen`
operation, after a resource backup unless `dryRun` is true. The writer
builds the screen from the device's commands:

- A hard key takes the first command named exactly as one of the
  activity wizard's aliases for it (`VolumeUp`, `Mute`, `Return` for
  Back, `Select`, the arrows, transport and colour keys, and so on). The
  volume keys also take `BrightnessUp` and `BrightnessDown`.
- Every other command is an on-screen button in the device's command
  order, labelled with its name. Each takes its own slot (`IndexInMenu`
  0, 1, 2…, `FunctionGroupType` 0, `MenuName` `Device.<id>`), so no two
  buttons share a slot. Digits are on-screen buttons too, not a number
  pad.
- The map copies its surface and remote IDs from a Touch map the hub
  already has; a hub with none is refused. New map and button IDs come
  from above Logitech's floors, and a rebuild keeps the IDs of the
  buttons it keeps.
- A screen Logitech made (map ID at or below 52944089) is never rebuilt
  or removed.

Only MapList is saved, with a new etag, then the engine reloads it and
the hub publishes a new revision, so the Touch pulls the screen by
itself. An unchanged screen saves nothing. Home Assistant devices get
their screens from `/api/ha-devices` instead.

The writer's reply is the body: `200` with `ok`, `changed`, `dryRun`,
`removed`, `deviceId`, `hardKeys` (the keys used) and `onScreen` (how
many on-screen buttons). A missing or non-numeric `deviceId` gives
`400`; a writer refusal gives `422` with `error`; a writer that cannot be
reached gives `503`.

## Inventory

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/inventory"
```

Returns hub limits, configured devices, command names, keycode/raw flags,
and local command counts (`render_inventory_json()`).

List runnable commands for one device (`render_device_commands_json()`).
Both GET (query field `deviceId`) and POST (form field `deviceId`) are
accepted:

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/device-commands?deviceId=<device-id>"
```

An invalid device ID gives `400`; an unknown device gives `404`.

## IR control

Send one saved command (`render_ir_send_json()`):

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/ir-send" -Method Post -Body @{
  deviceId = "<device-id>"
  command  = "PowerOff"
}
```

Hold a command down, as a remote does while a key is held. Add `status`
and a `holdId` you choose (8 to 40 letters and digits, new for each hold):

- `press` starts the hold: the hub sends the command and, from 380 ms on,
  keeps repeating it. The answer comes once the press is out
  (`ok: false` with HTTP 502 if it failed).
- `hold` keeps it going: send one at least every 700 ms (the web app sends
  one every 200 ms). It answers `ok: false` with 502 if the engine refused
  the command, or 410 once the hold has ended.
- `release` ends it. A hold also ends 700 ms after its last `hold`, and
  after 30 s. A quick press and release sends the command once.

The hub runs one hold at a time; a new `press` releases the previous one.
An invalid device, command, status or `holdId` gives `400`.

Send a cancellable batch (`render_ir_batch_send_json()`):

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/ir-batch-send" -Method Post -Body @{
  deviceId = "<device-id>"
  commands = "PowerOff`nInputHdmi1"
  delayMs  = "80"
  dryRun   = "0"
  runId    = "example-run-1"
}
```

`delayMs` is clamped to 40–10000 ms. The response includes `sent`,
`attempted`, `skipped`, `failed`, `elapsedMs`, and `lastReply`. `failed`
is incremented when the hub rejects a stored command, so large sweeps can
keep going while still showing unsupported names clearly. A batch with no
valid commands gives `400`.

Cancel a running batch (`render_ir_cancel_json()`):

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/ir-cancel" -Method Post -Body @{
  runId = "example-run-1"
}
```

Create or reuse the temporary IR sweep target (`render_ir_lab_target_json()`):

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/ir-lab-target" -Method Post
```

Remove every command from the temporary IR sweep target
(`render_ir_lab_clear_json()`). The form field `deviceId` is optional; it
must name the sweep target when present:

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/ir-lab-clear" -Method Post -Body @{
  deviceId = "<sweep-device-id>"
}
```

A different device gives `400`.

Import commands from database-converted lines (`render_irdb_import_json()`):

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/irdb-import" -Method Post -Body @{
  deviceId = "<device-id>"
  payload  = "PowerOff|G:Toshiba 32 Bit:(0xE0E040BF)(Repeat)():3"
}
```

Raw timing imports use:

```text
CommandName|raw|F9470P20D0S1068...
```

A KeyCode is stored with the protocol it names (`G:<protocol>:`), looked
up in the hub's ProtocolList; a KeyCode for a protocol the hub doesn't have
is refused. IRDB CSV lines (`name,protocol,device,subdevice,function`) are
accepted for NEC, NEC1, NEC1-f16 and NEC2. The web app converts other IRDB
protocols to Raw itself (NECx1/2, Samsung32, Pioneer, Sony12/15/20, RC5,
RC6, Panasonic, JVC, Denon, Sharp), with each frame padded to its full
period and three frames for Sony, because the hub plays a Raw code once
per press and loops all of it while a key is held. So a held NECx1 or JVC
key repeats its full frame rather than the protocol's short repeat, and
RC5/RC6 codes keep the same toggle bit on every press. The response counts
submitted, imported, skipped-existing and rejected rows in its `message`;
a refused import gives `400`.

Import catalog rows (`render_catalog_import_json()`):

```text
POST /api/catalog-import
Content-Type: application/json
```

The body carries `deviceId` and a `commands` list of rows with `name` and
either `keycode` or `raw`. Each KeyCode is stored with the protocol named
in its `G:<name>:` prefix, looked up in the hub's ProtocolList; a KeyCode
for a protocol the hub lacks is refused. A row whose name already exists on
the device is skipped. The response `message` counts submitted, imported,
skipped-existing and rejected rows. An empty body, an invalid device, a
missing commands list or an empty list gives `400`; an oversized body
gives `413`.

Fetch a RemoteCentral code page (`render_remotecentral_fetch_json()`).
Both GET (query field `path`) and POST (form field `path`) are accepted.
The path must start with `/cgi-bin/codes/`; a full RemoteCentral address
has its host prefix stripped:

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/remotecentral-fetch?path=/cgi-bin/codes/..."
```

Success is `200` with `ok: true`, `source: "remotecentral"`, the path and
the page `html`. A fetch failure is also `200`, with `ok: false` and an
`error`. An invalid path gives `400`.

## IR learning

Capture from a remote (`render_capture_json()`). Both GET and POST are
accepted; the hub listens for one frame:

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/capture" -Method Post
```

The response carries the raw capture plus its analysis: `mode`,
`protocolId`, `keycode`, `nec` and `analysis`.

Test a learned signal before saving (`render_ir_test_learned_json()`):

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/ir-test-learned" -Method Post -Body @{
  deviceId = "<device-id>"
  name     = "PowerToggle"
  mode     = "raw"
  raw      = "F9470P20D0S1068..."
}
```

The form fields are `deviceId`, `name`, `mode`, `protocol`, `nec`,
`keycode` and `raw`. The hub adds the signal as a temporary command, sends
it, then deletes it; the response reports `addMessage`, `reply`,
`cleanupOk` and `cleanupMessage`. A missing device gives `400`, as does a
request with no signal in any of `raw`, `keycode` or `nec`.

## Bluetooth HID

One endpoint carries every Bluetooth action (`render_bluetooth_call_json()`):

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/bt-call" -Method Post -Body @{
  action = "pairing_on"
  type   = "btkeyboard"
  name   = "Harmony Keyboard"
}
```

The `action` field selects the operation: `adapter_status`, `pairing_on`,
`pairing_off`, `scan`, `classic_scan`, `status`, `connect`, `disconnect`,
`report` and `reportseq`. An unknown action gives `400`.

Make the hub discoverable and pairable as a keyboard with
`action = "pairing_on"` as above. Use `btkeyboard` for Google TV, Android
TV, and NVIDIA SHIELD. The `btkeyboard-nexus` profile is for the original
Nexus Player, not generic Android TV devices. Pairing mode registers the
selected HID profile before making the hub discoverable. If a target was
bonded under the wrong profile, forget the keyboard on both the target and
the hub before pairing again.

Pairing is completed entirely on the LAN. The endpoint starts Logitech's
local HID listener without a placeholder address, then starts
`codex_bt_pair_agent`, which confirms Secure Simple Pairing through the
Hub's controller and stores the resulting link key in BlueZ's local
`linkkeys` file. No Logitech account or cloud relay participates. The
helper keeps pairing available for ten minutes or exits after a stable
bond. A successful response includes `pairAgent: true`,
`profileSettled: true`, and `profileSettleMs`; clients should wait for that
response before selecting the keyboard.

Profile registration also resets the adapter's display name. The pairing
endpoint reapplies the requested name after registration settles and
before enabling discoverability, so the target sees the name entered in
the WebGUI.

Check adapter and connection state:

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/bt-call" -Method Post -Body @{
  action = "adapter_status"
}
```

`paired` and `connected` are different states. Report and text endpoints
reject the request unless `hcitool con` shows the target with both `AUTH`
and `ENCRYPT`; a saved bond or unauthenticated ACL alone is not considered
a working connection. A `report` or `reportseq` against a target that is
not on an authenticated encrypted link gives `409`. Before reconnecting,
the WebGUI reloads the local link key into the controller and discards a
stale unauthenticated ACL. The Bluetooth page checks both the
authenticated connection and keyboard runtime when it opens, then shows
the connected address in the page header and pairing status box.

Android HID hosts query several input reports while opening a keyboard.
The stock Harmony handler emits a truncated response for report `0xAC`,
which can leave Android bonded but unable to accept keys. The persistent
`codex_bt_pair_agent --hid-control-daemon` runtime supplies the complete
zero-valued report through the local HCI control channel. It also reloads
saved link keys at startup, so this compatibility path survives a Hub
reboot without cloud access.

The WebGUI remote-control endpoint also recognizes DeviceList entries
whose transport is Bluetooth HID (`Transport: 32`). When one of those
devices is disconnected, `/api/ir-send` first establishes and verifies a
stable link to the device's `BTAddress`, then submits the requested
Harmony command. This avoids losing the first key while the native HAL is
still connecting.

Physical Harmony remotes require more configuration than direct WebGUI
control. A device needs a `16417Device<id>` button map; otherwise it can
appear in the remote's Devices list but tapping it has no selectable
menu (see [Touch device screens](#touch-device-screens), which builds
one). `tools/bluetooth_device_bridge.mjs`
clones both device maps from a known working Bluetooth template,
allocates unique map and button identities, and rewrites the
`Device.<id>` menu keys for the target.

Activity soft-button maps have the same constraint: every
`MenuItem.MenuName` must be `Activity.<ActivityId->`. The activity editor
repairs stale cloned menu keys during reconciliation and validates them
before saving, because a mismatched key can make a visible activity ignore
taps on a paired remote.

Harmony also represents a Bluetooth HID device twice inside an activity:
once for its normal playback/game responsibility and once as a
`KeyboardTextEntryActivityRole` for the same device ID. The paired
handheld uses that second role as its keyboard-routing and pairing marker.
The activity editor creates the role automatically for every
`Transport: 32` keyboard device and rejects an incomplete graph before
saving.

Check the FIFO keyboard runtime (`render_bluetooth_text_status_json()`):

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/bt-text-status"
```

Send exact text through the keyboard FIFO runtime
(`render_bluetooth_text_json()`):

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/bt-text" -Method Post -Body @{
  text = "Hello World`n"
}
```

The installer starts `/data/codex/bin/codex_bthid_keyboard` automatically
and creates `/cache/bin/bthid_keyboard` as a friendly symlink. The runtime
reads `/tmp/bthid_input`, sends exact press/release reports for ASCII
text, and uses the paired target saved by the Bluetooth controls. Text the
runtime refuses gives `400`.

Send a named key or shortcut through the low-level HID report path:

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/bt-call" -Method Post -Body @{
  action = "report"
  type   = "btkeyboard"
  code   = "ctrl+l"
}
```

Send multiple named keys. Each key is encoded as a press and release pair:

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/bt-call" -Method Post -Body @{
  action = "reportseq"
  type   = "btkeyboard"
  code   = "enter`nspace`nalt+f4"
  gapMs  = "35"
}
```

Send a saved device's Bluetooth command (`render_bt_saved_command_json()`):

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/bt-saved-command" -Method Post -Body @{
  deviceId = "<device-id>"
  command  = "<command-name>"
}
```

A command that cannot be sent gives `400` with the reason in `message`.

## System status

Read the bounded, non-mutating data shown by the modern System view
(`render_system_status_json()`):

```text
GET /api/system-status
```

```json
{
  "ok": true,
  "firmware": "4.15.600",
  "uptime": "1d 2h 3m",
  "memTotal": "62524 kB",
  "memory": "MemTotal: 62524 kB\n...",
  "uname": "Linux ...",
  "mounts": "...",
  "processes": "...",
  "logs": "--- startup log ---\n...",
  "authMode": "open on local network"
}
```

`firmware` comes from `/etc/version`; `uptime` uses the dashboard's
human-readable format. The remaining detail fields use the same local
read-only sources as the legacy System panel and are captured in fixed
buffers. The response contains no configuration files or credentials,
performs no WAN request, and remains below 64 KiB. When Basic
authentication is enabled, this route returns `401` without valid
credentials.

## LED

Set the hub's front LED to one of the hardware daemon's named states. This
drives the hardware directly (the same `sys.led` control the firmware uses
internally), so it is useful for locating a hub, confirming control works,
or signalling from an automation (`render_led_json()`).

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/led" -Method Post -Body @{
  action = "pairing_start"
}
```

```json
{ "ok": true, "action": "pairing_start", "code": 200, "reply": "{\"code\":200,...}" }
```

`action` must be one of the states the hardware daemon accepts:
`config_success`, `config_failure`, `pairing_start`, `pairing_stop`,
`sync_start`, `sync_stop`, `fire_command`, `fw_download_start`,
`fw_download_stop`, `extender_mode`, `non_extender_mode`. Any other value
returns `400`. `ok` is true only when the hardware daemon replies with
code `200`. The LED is a status indicator, so the firmware may overwrite
the state on its next event (for example when an activity starts). See
`PROTOCOLS.md` for the `sys.led` command.

## RF remotes

List the Harmony remotes paired with the hub's radio, and pair one more,
with no cloud (`render_remotes_json()`, `render_remote_pair_json()`). hal
pairs remotes itself: `rf.info` lists the radio's pairing slots and
`rf.pairing` opens its pairing window.

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/remotes"
```

```json
{"ok":true,"pairing":false,
 "reply":"{\"id\":1,\"data\":{\"EquadID\":\"34827\",\"RFID\":\"…\",\"Devices\":[{\"EquadID\":\"16414\",\"SkinId\":\"\",\"DeviceIndex\":\"1\",\"RFID\":\"…\"},{\"EquadID\":\"16417\",\"SkinId\":\"99\",\"DeviceIndex\":\"2\",\"RFID\":\"…\"}],\"DeviceCount\":2},\"code\":200}"}
```

- `reply` is hal's `rf.info` answer as text. `DeviceIndex` is the radio
  slot. `EquadID` is the kind of remote: 16414 Harmony Smart Control,
  16417 a remote with a screen (`SkinId` 99 is the Harmony Touch), 16420
  a keyboard, 16422/16423 Companion.
- While a pairing window is open the answer is `{"ok":true,"pairing":true}`
  with no `reply`: during the window hal reads the same slot registers to
  decide what to unpair, and a second reader can take its answers.
- `502` when the radio doesn't answer.

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/remote-pair" -Method Post `
  -ContentType "application/json" -Body '{"seconds":60}'
```

```json
{"ok":true,"seconds":60,"elapsedMs":21480,"pairCode":200,
 "pair":"{\"id\":1,\"data\":{\"DeviceIndex\":\"3\",\"EquadID\":\"16414\",\"RFID\":\"…\",\"SkinId\":\"\"},\"code\":200}",
 "before":"<rf.info text>","after":"<rf.info text>"}
```

- Opens the radio's pairing window for `seconds` (10–120, default 60) and
  answers when it closes: as soon as a remote pairs, or when the time runs
  out. On a Harmony Smart Control, hold **Menu** and **Mute** for about
  5 seconds while it's open.
- Only the RF window opens. The button on the hub also starts Bluetooth
  advertising; this route doesn't.
- After a pair hal unpairs any older remote of the **same kind** (it keeps
  one per EquadID). Remotes of other kinds are never touched, so a Smart
  Control joins a Touch but replaces an older Smart Control. `before` and
  `after` are the slot tables either side of the window; compare them to
  see what changed (`pairOutcome()` in `views/remotes-model.js`).
- `pairCode` is hal's code for `rf.pairing`: `200` when a remote paired,
  anything else (`500` when the window timed out, `-1` for no answer) when
  none did. A remote that was already this hub's pairs back into its own
  slot: hal answers `200` with no `data`, and `before` and `after` are the
  same (seen on hardware, 2026-10-31). A window nobody used also leaves
  them the same, with `500`.
- One window at a time: a second request gets `409`. If the "before" read
  fails the window doesn't open (`502`).
- After a pair the engine tries to report it to Logitech
  (`RemoteManager/SavePairings`); behind the cloud blocker that fails at
  once and changes nothing.

The Smart Control keeps no setup and never syncs: it sends key codes and
the hub answers them from MapList. `16414Activity<id>` answers keys while
that activity runs; without it the remote does nothing in that activity.
`16414Root` holds the three activity buttons (`WatchTVActivity`,
`MovieActivity`, `MusicActivity`), each with a `ButtonActivityAction` on
press (`EventType` 1) and long press (`EventType` 2), and answers keys
while everything is off. The engine adds `PowerOffActivity` to the root
map itself. The web app's Remotes page edits the activity buttons, edits
each remote's keys per activity (`#touch/<id>/16414` for the Smart Control,
`#touch/<id>/16417` for the Touch), and compares the two remotes' keys and
copies them either way, all through `/api/activity-save`.

## State changes (cheap liveness)

Poll for state changes without a full engine round-trip
(`render_state_json()`). The hub keeps a `stateVersion` that increments on
every state change (an activity starting or stopping, from any source —
the app, a remote, or another client). Pass the last version you saw; the
hub answers "unchanged" until it moves.

```text
GET /api/state?version=<lastStateVersion>
```

```json
{ "ok": true, "code": 200, "changed": true,
  "reply": "{...digest including a new stateVersion...}" }
```

- `code` is `304` with `changed:false` when nothing has changed since
  `version` (a cheap response, safe to poll every few seconds).
- `code` is `200` with `changed:true` when state moved; `reply` carries
  the full state digest, including the new `stateVersion` to pass on the
  next poll.
- Omit `version` (or pass an impossible one) to force a full read.

The web UI uses this to stay live: it polls this endpoint on a short
interval and only re-reads the full activity state
(`/api/activity-state`) when `changed` is true. See `PROTOCOLS.md` for
the underlying `connect.statedigest?get`.

## Exports

Every export is a GET handled by `send_file_download()`,
`send_bundle_download()`, `send_cloud_download()`,
`send_timezone_download()` or `send_bt_devices_download()`:

```text
GET /export/bundle
GET /export/devices
GET /export/functions
GET /export/protocols
GET /export/activities
GET /export/maps
GET /export/automation
GET /export/mqtt
GET /export/wifi
GET /export/cloud
GET /export/timezone
GET /export/bluetooth
```

Exports are for backups and debugging. Do not share files containing local
network or credential material.

The full bundle format is `harmony-owner-bundle-v2` and includes
`ActivityList.json`, `MapList.json`, and `AutomationConfig.json`. Version 1
bundles remain importable and leave those three resources unchanged.

`/export/cloud` returns `1` when strict LAN-only mode is enabled and `0`
when WAN/cloud handlers are allowed. The route guard applies that value
immediately; background cloud workers are reevaluated after reboot or
network reconnect.

`/export/timezone` returns the stored time zone as plain text: the IANA
name on the first line and the POSIX TZ rule on the second. The body is
empty when no time zone is stored.

`/export/bluetooth` returns the saved Bluetooth device store as
`bt-devices.json`; it returns an empty device list when no store exists.

## Software version and updates

Read which Melodious release the hub runs (`render_version_json()`):

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/version"
```

```json
{"ok":true,"product":"melodious","version":"1.3.0","api":1,"update":{"protocol":0},
 "features":["activity-save","activity-sync","catalog-import","device-commands",
             "device-screen","device-settings","ha-devices","irdb-import",
             "remote-pair"]}
```

- `version` is the release the hub software belongs to (`MELODIOUS_VERSION`).
- `api` rises when a route the apps rely on changes shape.
- `features` names routes an app may need, so it can say "update the hub"
  before trying one.
- `update.protocol` is `0`: the hub installs no software over HTTP.
- Hubs older than 1.3.0 answer `404`; treat them as 1.2.x or older.

Read the installed control binaries and their checksums
(`render_update_status_json()`):

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/update-status"
```

The response carries `version` and lists each binary with `present`, `size`
and `md5`: `codex_webui`, `codex_bthid_keyboard`, `codex_bt_pair_agent`,
`codex_hal_ltcp`, `codex_hbus`, `codex_portal` and `codex_dhcpd`.

The hub installs software only through the installer (`install_webui.py` or
`install_webui.ps1`, over SSH). Until 1.2.0 it also had
`POST /api/update-begin`, `/api/update-chunk` and `/api/update-apply`, plus
`GET/POST /api/update-check-state`. Those took the checksum list from the
same client that sent the file, so any client on the network could replace
a hub binary. 1.3.0 removed them; they answer `404`.

### Backup retention

Backups are pruned by count, in `backup_resources()`,
`prune_resource_backups()` and the installer (`install_webui.py`):

- Resource backups under `/data/codex/resource-backups` keep the newest 5
  (`prune_resource_backups(5)`).
- Installer handoffs (`webui-handoff-*` under the installer's backup root)
  keep the newest 3 (`HANDOFF_KEEP` in `install_webui.py`).
- `settings_*` backups under `/data/codex/resource-backups` are never
  pruned: the resource-prune name filter accepts only timestamped resource
  names (`is_resource_backup_name()`).

The `codex_webui` binary has no command-line modes; it takes an optional
port argument and serves.

## Form routes

The form routes accept `application/x-www-form-urlencoded` POSTs and
answer with an HTML page (`render_page()`, `page_head()`). They answer
HTTP 200 even when they refuse: the message in the page body states the
outcome, so a client confirms a change by reading the setup again rather
than by trusting the status. The one exception is `/ir/delete-device`,
which answers through `render_message()` with the status the outcome
carries.

| Method | Path | Handler | Form fields | Effect |
| --- | --- | --- | --- | --- |
| POST | `/mqtt` | `handle_mqtt()` | `enabled`, `haDiscovery`, `host`, `port`, `username`, `password`, `keep_password`, `baseTopic`, `discoveryPrefix`, `clientId`, `name`, `pollSeconds`, `keepAlive` | Saves the MQTT bridge configuration and requests discovery. |
| POST | `/wifi` | `handle_wifi()` | `ssid`, `password`, `keep_password`, `hidden`, `open`, `apply` | Saves the Wi-Fi configuration; `apply=reboot` reboots. An empty SSID, or a secured network with no password, is refused in the page message. |
| POST | `/system` | `handle_system()` | `action` plus the fields for that action | `reboot`; `cloud`/`cloud_reboot` with `cloudBlocker`; `auth` with `authEnabled`, `authUsername`, `authPassword`; `timezone` with `timezone`, `tzPosix`; `rediscover`. |
| POST | `/import` | `handle_import()` | `target`, `payload` | Imports one target: `bundle`, `devices`, `functions`, `protocols`, `activities`, `maps`, `automation`, `mqtt`, `wifi`, `cloud`, `bluetooth`. The payload is validated for its target before anything is written. |
| POST | `/ir/send` | `handle_ir_send()` | `deviceId`, `command` | Sends one saved IR command. |
| POST | `/ir/device` | `handle_ir_device()` | `deviceId`, `name`, `manufacturer`, `model`, `type` | Updates a device's details. |
| POST | `/ir/new-device` | `handle_ir_new_device()` | `name`, `manufacturer`, `model`, `type` | Creates a device. |
| POST | `/ir/command` | `handle_ir_command()` | `deviceId`, `name`, `mode`, `protocol`, `nec`, `keycode`, `raw` | Adds a command to a device. |
| POST | `/ir/update-command` | `handle_ir_update_command()` | `deviceId`, `oldName`, `name`, `mode`, `protocol`, `nec`, `keycode`, `raw` | Renames and replaces a command. |
| POST | `/ir/irdb-import` | `handle_irdb_import()` | `deviceId`, `payload` | Imports database-converted lines, as `/api/irdb-import`. |
| POST | `/ir/capture` | `handle_ir_capture()` | — | Captures one IR frame and shows the result. |
| POST | `/ir/delete-device` | `handle_ir_delete_device()` | `deviceId` | Deletes a device. Answers `200` on success, `409` when an activity uses the device, `404` when the device does not exist, `500` on failure (`render_message()`). |
| POST | `/ir/delete-command` | `handle_ir_delete_command()` | `deviceId`, `command` | Deletes a command from a device. |
| POST | `/bt/device` | `handle_bt_device()` | `deviceId`, `name`, `type`, `bdaddr` | Creates or updates a saved Bluetooth device; `type` defaults to `btkeyboard`. |
| POST | `/bt/delete-device` | `handle_bt_delete_device()` | `deviceId` | Deletes a saved Bluetooth device. |
| POST | `/bt/command` | `handle_bt_command()` | `deviceId`, `oldName`, `name`, `script`, `delayMs` | Creates or replaces a Bluetooth keyboard-script command. |
| POST | `/bt/delete-command` | `handle_bt_delete_command()` | `deviceId`, `command` | Deletes a Bluetooth command. |
| POST | `/bt/send-command` | `handle_bt_send_command()` | `deviceId`, `command` | Sends a saved Bluetooth command. |

## Route index

| Method | Path | Handler |
| --- | --- | --- |
| GET | `/api/activity-config` | `render_activity_config_json()` |
| GET | `/api/activity-state` | `render_activity_state_json()` |
| POST | `/api/activity-run` | `render_activity_run_json()` |
| POST | `/api/activity-save` | `render_activity_save_json()` |
| POST | `/api/device-settings` | `render_device_settings_json()` |
| POST | `/api/ha-devices` | `render_ha_devices_json()` |
| POST | `/api/device-screen` | `render_device_screen_json()` |
| POST | `/api/activity-sync` | `render_activity_sync_json()` |
| GET | `/api/inventory` | `render_inventory_json()` |
| GET | `/api/state` | `render_state_json()` |
| GET | `/api/system-status` | `render_system_status_json()` |
| GET, POST | `/api/device-commands` | `render_device_commands_json()` |
| GET, POST | `/api/remotecentral-fetch` | `render_remotecentral_fetch_json()` |
| GET, POST | `/api/capture` | `render_capture_json()` |
| POST | `/api/ir-send` | `render_ir_send_json()` |
| POST | `/api/led` | `render_led_json()` |
| GET | `/api/remotes` | `render_remotes_json()` |
| POST | `/api/remote-pair` | `render_remote_pair_json()` |
| POST | `/api/ir-test-learned` | `render_ir_test_learned_json()` |
| POST | `/api/ir-batch-send` | `render_ir_batch_send_json()` |
| POST | `/api/ir-cancel` | `render_ir_cancel_json()` |
| POST | `/api/ir-lab-target` | `render_ir_lab_target_json()` |
| POST | `/api/ir-lab-clear` | `render_ir_lab_clear_json()` |
| POST | `/api/bt-call` | `render_bluetooth_call_json()` |
| GET | `/api/bt-text-status` | `render_bluetooth_text_status_json()` |
| POST | `/api/bt-text` | `render_bluetooth_text_json()` |
| POST | `/api/bt-saved-command` | `render_bt_saved_command_json()` |
| GET | `/api/version` | `render_version_json()` |
| GET | `/api/update-status` | `render_update_status_json()` |
| POST | `/api/irdb-import` | `render_irdb_import_json()` |
| POST | `/api/catalog-import` | `render_catalog_import_json()` |
