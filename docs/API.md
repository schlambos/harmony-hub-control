# Local Control API

The web UI intentionally has no HTTP authentication. Run it only on a trusted
LAN or behind your own access controls.

Most write endpoints accept `application/x-www-form-urlencoded` bodies. The
transactional activity save endpoint accepts `application/json`. JSON responses
use `ok: true` on success and `ok: false` with `error` on failure.

## Activities

Load the native activity, remote-map, and device resources plus a conflict
revision:

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

The browser saves `ActivityList.json` and `MapList.json` as one transaction:

```json
{
  "baseRevision": "01234567-89abcdef",
  "syncRemote": true,
  "activityList": {"Activities": []},
  "mapList": {"ButtonMaps": [], "FunctionMaps": null}
}
```

```text
POST /api/activity-save
Content-Type: application/json
```

`baseRevision` must match the value returned by `/api/activity-config`. A stale
editor receives `409 Conflict`, preventing an official sync or a second browser
from being overwritten. Before writing, the Hub snapshots all resource files.
The five newest timestamped resource snapshots are retained so repeated edits
cannot exhaust the Hub's small data partition; settings backups are not part of
that rotation.
The endpoint compares parsed JSON rather than serialized bytes, so whitespace,
object-key order, escaped characters, and equivalent number formatting do not
turn an unchanged browser payload into a firmware write. Only changed resources
are sent through Harmony's native `proxy.resource?put` handler. The resource is
embedded as a JSON object rather than an escaped JSON string, which keeps the
large MapList request small enough for the Hub's memory and watchdog limits.

Harmony checks the Hub etag, updates `index.json`, queues the corresponding
service operation, and sends `config_new` to the engine. A successful write
requires the matching HBus request ID and native `200`/`204` response, followed
by a valid changed resource on disk. The firmware is allowed to choose its own
JSON serialization. If either write or verification fails, resources already
changed by the transaction are restored through the same native handler; the
endpoint falls back to the on-disk snapshot only if Harmony cannot perform that
rollback. Successful save responses include `activityChanged` and `mapChanged`
so callers can distinguish a write from a semantic no-op.

With `syncRemote: true`, the endpoint reloads `ActivityList`, `MapList`, and
`AutomationConfig`, then invokes `setup.syncremotechanges`. That is the firmware
path which processes locally queued resource PUTs; `setup.sync` is deliberately
not used because it clears pending local requests before its cloud-to-Hub sync.
The API reports that Harmony accepted the remote-sync request and checks whether
the local resources changed immediately afterward. Physical remote propagation
continues asynchronously inside the firmware; `syncQueued: true` (and the
backward-compatible `synced: true`) means the firmware accepted that work, not
that a handset acknowledgement was observed. Submit the currently stored
resources for remote synchronization without an edit using:

```text
POST /api/activity-sync
```

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

`/export/cloud` returns `1` when the Logitech cloud blocker is enabled and `0`
when cloud tasks are allowed on the next network start.

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
