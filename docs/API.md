# Local Control API

HTTP Basic authentication is optional. When enabled from the System view, the
same global check protects every page, API route, and export; otherwise the
interface is open on the local network.

Most write endpoints accept `application/x-www-form-urlencoded` bodies. The
transactional activity save endpoint accepts `application/json`. JSON responses
use `ok: true` on success and `ok: false` with `error` on failure.

## Activities

Load the native activity, remote-button-map, activity-function-map, and device
resources plus a conflict revision:

```text
GET /api/activity-config
```

Read or start the current activity:

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/activity-state"

Invoke-RestMethod "http://<hub-ip>:8080/api/activity-run" -Method Post -Body @{
  activityId = "<activity-id>"
}
```

Use `-1` as the activity ID to run `PowerOff`.

The browser saves `ActivityList.json`, `MapList.json`, and `FunctionList.json`
as one compensated, Hub-local transaction:

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

`baseRevision` must match the value returned by `/api/activity-config`. A stale
editor receives `409 Conflict`, preventing another local editor from being
overwritten. Before writing, the Hub snapshots all resource files. Retention
of those snapshots is byte-budgeted by the C binary itself
(`codex_webui --prune-backups` and the same engine at production startup),
never by count: strict-name generations under `/data/codex/resource-backups`
are bounded by a 768 KiB resource budget and a 64 KiB settings budget within
a 2 MiB combined budget across all backup families, and the newest valid
generation of each non-empty family is protected from deletion. This bounds
growth but is not exact JFFS2 free-space enforcement.
The endpoint compares parsed JSON rather than serialized bytes, so whitespace,
object-key order, escaped characters, and equivalent number formatting do not
turn an unchanged browser payload into a resource write. Changed data is passed
over a root-only volatile file channel to `codexactivity.lua`. That plugin
refuses every write unless `/data/codex/cloud_blocker.conf` is exactly enabled.

The plugin calls the firmware resource manager's local `saveResource` method
directly. It does not call the resource proxy, create an offline request, invoke
the firmware sync task, or contact an account service. It writes and verifies
all three resources, reloads `ActivityList`, `FunctionList`, and `MapList` in
the local activity engine, increments the local configuration digest, and
notifies connected local clients. All three resource etags are refreshed for
every transaction so role, hard-button, and control-group-only edits all create
a new paired-remote configuration revision.

When the paired handset later performs its own synchronization, the guarded
network-service layer serves `proxy.resource?get` from the Hub's local resource
manager, acknowledges `proxy.resource?put` without changing Hub-owned files or
creating a cloud queue entry, and answers `setup.sync*` locally. A separate
egress guard removes the WAN default route while preserving LAN and multicast
routes. This prevents firmware conflict reconciliation from downloading an
older Logitech ActivityList, MapList, and FunctionList over the local edits.

If any resource write, read-back, engine reload, or digest update fails, the
plugin restores all three previous resources and their metadata. The web endpoint
performs a second semantic read-back and requests another local compensation if
needed. Successful responses include `activityChanged`, `mapChanged`,
`functionChanged`, `localOnly: true`, and `remoteRefreshed`.

### Activity map identity rules

Harmony stores one `ActivityButtonMap` for every activity on every compatible
paired-remote surface. The map's `ActivityId-` and the numeric suffix of
`ButtonMapIdentifier` must identify the same activity. Deleting an activity
must delete all of its activity maps.

This deployment is strictly offline: Logitech cloud is blocked and no server or
cloud allocator ever assigns identities. The offline implementation must allocate
persistent map and button identities itself, locally, at creation time.

Genuine Logitech configs set a positive `ButtonMapId-` on every map and a
positive unique `ButtonId` plus `ButtonState: 1` on every button. Omitting those
or writing zeros breaks the paired physical remote (hub firmware does not read
`ButtonId` / `ButtonMapId-` / `ButtonState`, but the remote's separate firmware
does).

**Allocate locally (offline only):**

- Map IDs and button IDs use two disjoint bands. Genuine map IDs occupy
  40,550,459 to 52,944,089; genuine button IDs occupy 1,357,129,005 to
  1,878,029,713. Allocate new map IDs above 52944089 and new button IDs above
  1878029713 so a value Logitech once issued is never reused. Signed-int32
  ceiling is 2147483000.
- Build the ID pool by scanning all four resources: `activityList`, `mapList`,
  `functionList`, and `deviceList` (`deviceList` holds 168 `Id-` values spanning
  1,933,417 to 81,897,247).
- Only these keys are identities to allocate: `Id`, `Id-`, `ButtonId`,
  `ButtonMapId`, `ButtonMapId-`.
- These keys are foreign-key references and must never be allocated or rewritten:
  `FunctionId-`, `DeviceId-`, `ActivityId-`, `RemoteId-`, `SurfaceId-`,
  `ButtonMapSurfaceId-`, `AccountId-`, `ParentDevice-`,
  `GlobalDeviceVersionId-`, `GlobalLanguageVersionId-`, `ContentProfileKey`,
  `ProtocolId`.
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
  `ButtonDoublePressAction` are all null, and never pad a map to a fixed size.
  Genuine Logitech configs contain zero action-less buttons in all 19 maps, and
  their activity map button counts vary (15 to 54) because Logitech includes only
  the buttons an activity can actually drive; a two-device activity legitimately
  has 15 buttons rather than a padded 36.

  This is not cosmetic. The hub tolerates action-less buttons and silently drops
  them (`getButtonMaps` only registers a button when its parsed action list is
  non-empty), so every hub-side check passes. The paired physical remote does
  not: starting an activity whose maps contain an action-less button makes the
  remote flash "starting activity", return to its home screen, and stop
  responding to every button until it is power-cycled. Verified on hardware -
  pruning the action-less buttons from two affected activities restored full
  remote control immediately.

  Pruning is scoped to activity maps. `RootButtonMap` legitimately ships
  action-less shortcut buttons, and activity selection and power-off work
  through it, so it is neither pruned nor rejected.

Firmware identity keys (from `harmony-userconfigreader.decompiled.lua`): maps
are keyed by the string `ButtonMapIdentifier` (lines 11574/11578/11585); buttons
are keyed by the string `ButtonKey` (line 11602); any button with no parsed
action is dropped (line 11629). `ButtonId`, `ButtonMapId-`, and `ButtonState`
are read by zero hub firmware modules. Genuine parity still matters because the
physical remote runs separate, undecompiled firmware that fails without them.

The editor reloads after every save. On load it also repairs the recoverable
split state left by older builds: orphaned activity maps are removed and missing
per-surface maps are recreated with locally allocated positive identities, then
presented as an unsaved repair for review.

Every activity must also have exactly one `ActivityFunctionMap` in
`FunctionList.json`. These maps produce the command/control groups returned by
`harmony.engine?config`; a button map alone can make an activity appear while
leaving it with no generated controls. The editor removes orphaned function
maps, creates a missing one from current device roles, and exposes the selected
activity's full FunctionMap under **Advanced JSON**. The Hub-side writer rejects
orphaned activities, deleted device references, duplicate activity function
maps, or a missing function map before writing anything.

`syncRemote: true` is retained for API compatibility, but it never selects a
network path. It forces a local etag/configuration-digest refresh even when the
resource bodies are unchanged. Refresh the currently stored configuration
without an edit using:

```text
POST /api/activity-sync
```

This endpoint is also strictly local. It returns `syncQueued: false` and
`synced: false`; `remoteRefreshed: true` means the Hub published a new local
configuration revision for paired remotes. The writer waits for the separate
activity-execution task to finish rebuilding before it publishes that revision;
the embedded writer reply reports `activityEngineReady: true` when the paired
remote can safely start an activity.

## Inventory

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/inventory"
```

Returns hub limits, configured devices, command names, keycode/raw flags, and
local command counts.

List runnable commands for one device:

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/device-commands?deviceId=<device-id>"
```

## IR Control

Send one saved command:

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/ir-send" -Method Post -Body @{
  deviceId = "<device-id>"
  command  = "PowerOff"
}
```

Send a cancellable batch:

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/ir-batch-send" -Method Post -Body @{
  deviceId = "<device-id>"
  commands = "PowerOff`nInputHdmi1"
  delayMs  = "80"
  dryRun   = "0"
  runId    = "example-run-1"
}
```

The response includes `sent`, `attempted`, `skipped`, `failed`, `elapsedMs`, and
`lastReply`. `failed` is incremented when the hub rejects a stored command, so
large sweeps can keep going while still showing unsupported names clearly.

Cancel a running batch:

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/ir-cancel" -Method Post -Body @{
  runId = "example-run-1"
}
```

Create or reuse the temporary IR sweep target:

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/ir-lab-target" -Method Post
```

Import commands from database-converted lines:

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

## IR Learning

Capture from a remote:

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/capture" -Method Post -Body @{
  timeout = "8"
}
```

Test a learned signal before saving:

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/ir-test-learned" -Method Post -Body @{
  deviceId = "<device-id>"
  name     = "PowerToggle"
  mode     = "raw"
  raw      = "F9470P20D0S1068..."
}
```

## Bluetooth HID

Make the hub discoverable and pairable as a keyboard:

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/bt-call" -Method Post -Body @{
  action = "pairing_on"
  type   = "btkeyboard"
  name   = "Harmony Keyboard"
}
```

Use `btkeyboard` for Google TV, Android TV, and NVIDIA SHIELD. The
`btkeyboard-nexus` profile is for the original Nexus Player, not generic Android
TV devices. Pairing mode registers the selected HID profile before making the
hub discoverable. If a target was bonded under the wrong profile, forget the
keyboard on both the target and the hub before pairing again.

Pairing is completed entirely on the LAN. The endpoint starts Logitech's local
HID listener without a placeholder address, then starts
`codex_bt_pair_agent`, which confirms Secure Simple Pairing through the Hub's
controller and stores the resulting link key in BlueZ's local `linkkeys` file.
No Logitech account or cloud relay participates. The helper keeps pairing
available for ten minutes or exits after a stable bond. A successful response
includes `pairAgent: true`, `profileSettled: true`, and `profileSettleMs`;
clients should wait for that response before selecting the keyboard.

Profile registration also resets the adapter's display name. The pairing
endpoint reapplies the requested name after registration settles and before
enabling discoverability, so the target sees the name entered in the WebGUI.

Check adapter and connection state:

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/bt-call" -Method Post -Body @{
  action = "adapter_status"
}
```

`paired` and `connected` are different states. Report and text endpoints reject
the request unless `hcitool con` shows the target with both `AUTH` and
`ENCRYPT`; a saved bond or unauthenticated ACL alone is not considered a
working connection. Before reconnecting, the WebGUI reloads the local link key
into the controller and discards a stale unauthenticated ACL. The Bluetooth
page checks both the authenticated connection and keyboard runtime when it
opens, then shows the connected address in the page header and pairing status
box.

Android HID hosts query several input reports while opening a keyboard. The
stock Harmony handler emits a truncated response for report `0xAC`, which can
leave Android bonded but unable to accept keys. The persistent
`codex_bt_pair_agent --hid-control-daemon` runtime supplies the complete
zero-valued report through the local HCI control channel. It also reloads saved
link keys at startup, so this compatibility path survives a Hub reboot without
cloud access.

The WebGUI remote-control endpoint also recognizes DeviceList entries whose
transport is Bluetooth HID (`Transport: 32`). When one of those devices is
disconnected, `/api/ir-send` first establishes and verifies a stable link to
the device's `BTAddress`, then submits the requested Harmony command. This
avoids losing the first key while the native HAL is still connecting.

Physical Harmony remotes require more configuration than direct WebGUI
control. A Bluetooth device must have both a `DeviceFunctionMap` and a
`DeviceButtonMap`; otherwise it can appear in the remote's Devices list but
tapping it has no selectable menu. `tools/bluetooth_device_bridge.mjs` clones
both maps from a known working Bluetooth template, allocates unique map and
button identities, and rewrites the `Device.<id>` menu keys for the target.

Activity soft-button maps have the same constraint: every
`MenuItem.MenuName` must be `Activity.<ActivityId->`. The activity editor
repairs stale cloned menu keys during reconciliation and validates them before
saving, because a mismatched key can make a visible activity ignore taps on a
paired remote.

Harmony also represents a Bluetooth HID device twice inside an activity: once
for its normal playback/game responsibility and once as a
`KeyboardTextEntryActivityRole` for the same device ID. The paired handheld
uses that second role as its keyboard-routing and pairing marker. The activity
editor creates the role automatically for every `Transport: 32` keyboard
device and rejects an incomplete graph before saving.

Check the FIFO keyboard runtime:

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/bt-text-status"
```

Send exact text through the keyboard FIFO runtime:

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/bt-text" -Method Post -Body @{
  text = "Hello World`n"
}
```

The installer starts `/data/codex/bin/codex_bthid_keyboard` automatically and
creates `/cache/bin/bthid_keyboard` as a friendly symlink. The runtime reads
`/tmp/bthid_input`, sends exact press/release reports for ASCII text, and uses
the paired target saved by the Bluetooth controls.

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

## System Status

Read the bounded, non-mutating data shown by the modern System view:

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

`firmware` comes from `/etc/version`; `uptime` uses the dashboard's human-readable
format. The remaining detail fields use the same local read-only sources as the
legacy System panel and are captured in fixed buffers. The response contains no
configuration files or credentials, performs no WAN request, and remains below
64 KiB. When Basic authentication is enabled, this route returns `401` without
valid credentials.

## Exports

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
```

Exports are for backups and debugging. Do not share files containing local
network or credential material.

The full bundle format is `harmony-owner-bundle-v2` and includes
`ActivityList.json`, `MapList.json`, and `AutomationConfig.json`. Version 1
bundles remain importable and leave those three resources unchanged.

`/export/cloud` returns `1` when strict LAN-only mode is enabled and `0` when
WAN/cloud handlers are allowed. The route guard applies that value immediately;
background cloud workers are reevaluated after reboot or network reconnect.

## Software Updates

The System page can update the local control stack from this repository. The
browser fetches `payload/bin/MANIFEST.txt` and selected `codex_*` binaries,
uploads them to the hub in chunks, then the hub verifies MD5 hashes from the
manifest before installing. The default updater tries the GitHub contents API,
raw GitHub, and jsDelivr mirrors so public updates still work when one browser
fetch path is blocked.

Low-level SSH/dropbear files are intentionally not updated by the web UI.

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/update-status"
```

The chunked update endpoints are:

```text
POST /api/update-begin
POST /api/update-chunk
POST /api/update-apply
```

The default public GitHub repository is read through GitHub's Contents API and
works without a token. For a private GitHub repo or fork, paste a GitHub token
into the System page update field. It is used only by the browser to read GitHub
and is not sent to or stored on the hub. Change the raw base URL only when using
a public mirror.
