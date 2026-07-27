# Local Control API

The web UI intentionally has no HTTP authentication. Run it only on a trusted
LAN or behind your own access controls.

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
overwritten. Before writing, the Hub snapshots all resource files.
The five newest timestamped resource snapshots are retained so repeated edits
cannot exhaust the Hub's small data partition; settings backups are not part of
that rotation.
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

New maps use the firmware's local allocation-compatible form:

- omit `ButtonMapId-`;
- set each physical `ButtonId` to `0`;
- set copied button-action and sequence object identities to `0`;
- retain the remote and surface references;
- use the new activity ID in `ActivityId-` and `ButtonMapIdentifier`.

The local engine accepts those omitted and zero identities; no account-service
allocator is involved. The editor reloads after every save. On load it also
repairs the recoverable split state left by older builds: orphaned activity maps
are removed and missing per-surface maps are recreated in this form, then
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
configuration revision for paired remotes.

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

Check adapter and connection state:

```powershell
Invoke-RestMethod "http://<hub-ip>:8080/api/bt-call" -Method Post -Body @{
  action = "adapter_status"
}
```

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
