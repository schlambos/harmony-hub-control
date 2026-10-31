# Harmony Touch screen editor

The Harmony Touch draws its screens from button maps in the hub's `MapList`.
This document is the contract for editing those maps locally: how the Touch
pulls its configuration, how it resolves physical keys, on-screen rows,
number pads, and swipe gestures on the wire, what an editor may change, and
the validation rules every save must pass.

The hard rule: never leave the Touch unusable. The Touch loads its own copy
of `MapList` with the same stock reader the hub uses. A map that reader
cannot load leaves the Touch without a screen until the next good sync, and
a Touch cannot be re-provisioned without the cloud. Every `MapList` an
editor produces must pass the validation rules below before it is saved.

## How the Touch gets its screens

- **Local pull sync:** The hub never pushes config to the Touch. When the
  hub publishes a new configuration revision (`stateVersion` +
  `configVersion` in the state digest), the Touch starts a pull by itself:
  it asks the hub for each resource (`proxy.resource?get`), reads the
  changed files, and commits the staged copy when the sync finishes
  (`proxy.finished`).
- **Offline connectivity check:** The Touch's own Sync menu checks for
  internet first by asking the hub for `wifi.status`, which the hub's
  hardware daemon answers by resolving `ping.myharmony.com` and connecting
  to it on ports 80 and 443. While the cloud blocker is on, `codex_webui`
  points that name at `127.0.0.1` in `/etc/hosts` and accepts connections on
  loopback ports 80 and 443.
- **Clock sync:** During a pull, the Touch asks the hub for the time
  (`harmony.engine?getTime`). While the blocker is on,
  `netservicestarter.lua` answers from the hub's NTP-set clock (once past
  2026-01-01).
- **Content records (`CD_<device>`):** After pulling resources, the Touch
  requests `CD_<device>` for certain devices and aborts the pull (error 553)
  unless the answer is 200 or 304. Devices created on the hub have no
  content record, so while the blocker is on the offline guard answers a
  missing one with an empty record.
- **USB tether caveat:** Plugging a USB cable into the Touch puts it on its
  locked `myharmony.com` screen and aborts any in-flight RF sync with error
  554 (`USB cable connected` in `/data/loggly/SyncCounter.json`). Always let
  automatic pulls run while untethered.
- **Stale-Touch window:** The hub resolves a Touch press against its current
  maps. An on-screen press arrives as a menu index; the Touch draws labels
  from its own synced copy. Until the Touch finishes pulling after a save, a
  slot whose action changed or moved runs the new action under the old
  label.
- **Single save transaction:** Saves go through `POST /api/activity-save`,
  which writes `ActivityList`, `MapList`, and `FunctionList` with new etags,
  reloads the engine, and publishes a new configuration revision. Device
  screen generation (`POST /api/device-screen`) and Home Assistant device
  updates (`POST /api/ha-devices`) use the same plugin save and publish
  path.

## How the Touch and Hub resolve presses

End-to-end hardware observation (capturing `logread` on both the Hub and a
rooted Harmony Touch) confirmed how each control type behaves:

- **Hard keys (`HardRemoteButton`):**
  - Pressing a physical key sends `control.button?press`, then
    `control.button?hold` every **300 ms** while held, then
    `control.button?release`.
  - Without `ButtonLongPressAction`, the command executes immediately on
    `press`, repeats on each `hold`, and stops on `release`.
  - With `ButtonLongPressAction` (`EventType: 2`), the hub arms its
    long-press state machine on `press` and executes nothing yet: releasing
    before the 2nd hold (~600 ms) fires the short action once at `release`
    (`modifier: fire`, `pressType` 59), whereas reaching the 2nd hold
    (~600 ms) fires the long action once (`modifier: fire`, `pressType` 58)
    and treats later holds as heartbeats.
- **On-screen rows (`SoftRemoteButton`, `FunctionGroupType` ≠ 2):**
  - Tapping a row sends `press` then `release` (no `hold` under 300 ms).
    Holding a row emits `hold` every 300 ms, just like a hard key.
  - Adding `ButtonLongPressAction` (`EventType: 2`) to a `SoftRemoteButton`
    arms the exact same hub long-press state machine as a hard key. Setting
    `ButtonLongPressAction` equal to `ButtonAction` ("self-long") makes any
    hard key or on-screen row strictly single-shot—ideal for IP/Home
    Assistant toggles (`PowerToggle`, `PlayPause`, `Mute`, `SkipForward`,
    `SkipBack`).
- **Number pad (`SoftRemoteButton`, `FunctionGroupType: 2`):**
  - Tapping a digit on the Touch's number pad sends a single
    `control.button?fire` with `functionGroupType: 2` and no `release`.
- **Gestures (`GestureRemoteButton`):**
  - The Touch never sends `SwipeUp`, `SwipeDown`, `SwipeLeft`, `SwipeRight`,
    or `Tap` to the hub.
  - Instead, the Touch resolves a gesture locally (`juniper/gesturepad.lua`)
    against the target device's **`16417Device<id>`** screen (matching by
    `FunctionId-` when > 0, or by `CommandName` / `ButtonKey` when
    `FunctionId-` is 0) and sends an ordinary device-map `press` and
    `release` with that `deviceId`.
  - Consequently, a command gesture works only if the target device has a
    `16417Device<id>` screen containing that command, and any gesture that
    resolves to a hard key on the device screen (such as `VolumeUp`/`Down`
    for lamp brightness or receiver volume) must also have that `ButtonKey`
    present in the activity's own map.
  - A plain swipe sends `press` and releases ~200–240 ms later (0 `hold`
    messages, single execution). Holding a finger down at the end of a swipe
    (≥ 700 ms) sends `hold` every 300 ms until finger-up, ramping volume or
    brightness.

## The MapList contract

`MapList` holds one map per remote surface and activity or device. The
Touch's screens are the `16417` maps; the `16414` maps hold hard buttons
only. Editors work to these rules:

- Never delete or rename a map the Touch resolves.
- Never change `SurfaceId-`, `RemoteId-`, or `ButtonMapSurfaceId-` on an
  existing map. A new map copies those fields from a sibling `16417` map,
  and is refused when the hub has no such sibling.
- Carry through untouched everything the editor does not own: hard buttons,
  the number pad, client, channel and bookmark actions, image fields,
  unknown fields, and key order.
- Labels are text only. Custom icons need the cloud and are out of scope.
- New `ButtonId`, `ButtonMapId-`, and `SequenceId` values are allocated
  above every existing value in the `MapList` and are never reused while
  live.

### What each editor owns

| Map | Owned | Carried through |
| --- | --- | --- |
| `16417Activity<id>` | On-screen buttons, their sequences, hard keys, gestures (Touch & HA Control Studio, `#touch/<id>`) | Number pad, Touch-only actions |
| `16417Device<id>` made on the hub | The whole map, built from the device's commands (`POST /api/device-screen` or `POST /api/ha-devices`), with self-long on one-shot commands | Map and button IDs |
| `16417Device<id>` made by Logitech | Nothing | The whole map |
| `16414Activity<id>` | Hard keys (the same editor from Settings → Remotes, `#touch/<id>/16414`) | Everything else |
| `16414Root` | The three activity buttons (Settings → Remotes → Activity buttons) | Other buttons |
| Any other root map | Nothing | The whole map |

The activity wizard (web and Android) owns each activity's
`16414Activity<id>` map and the hard buttons of its `16417Activity<id>` map.
The Touch & HA Control Studio (`#touch/<id>`) owns the on-screen rows, hard
keys and gestures of `16417Activity<id>` directly. Opened for the Smart
Control (`#touch/<id>/16414`, from Settings → Remotes), the same page edits
only the hard keys of `16414Activity<id>`. Either way the two remotes' hard
keys stay alike: a key edit is written to both maps in one save, unless the
owner picks "Only the <remote>" for it (an override). A key already set
differently on the two remotes stays that way unless they pick "Both
remotes", and the page shows the other remote's setting next to it. Keys
only the other remote has set are listed with "Add these here too". The
number keys are the Smart Control's alone. Settings → Remotes notes, per
activity, where the two differ. The Touch answers its
hard keys from its own `16417` map only; Logitech's configs carry the same
hard buttons on both maps, minus the number keys (which are on screen on
the Touch) and with `Dvr` spelled `DVR`.

- Non-member "Extra controls" (any device in `DeviceList`, including HA
  lights, media players, scenes, fans, covers) work on hard keys, soft rows
  and gestures without activity membership (P13). They are badged `Extra`
  and never power on/off with the activity. Wizard and Touch saves never
  strip them, and defaults never pick non-member devices.
- Press modes (P11): Standard (hold repeats, for idempotent and step
  commands), One-shot self-long (`ButtonLongPressAction` == `ButtonAction`,
  `EventType: 2`, auto-default for `PowerToggle`, `PlayPause`, `Mute`,
  `SkipForward`, `SkipBack`, `Run`, `Activate`, `Press`), and Short +
  Separate Long. One-shot fires exactly once at release (<600ms) or once at
  the 2nd hold (≥600ms) on both hard and soft rows.
- Gestures (`SwipeUp/Down/Left/Right`, `Tap` plus Hold/Double-tap) resolve
  locally on the Touch against `16417Device<id>` (P18). The editor runs the
  lookup simulator live, warns on raw toggles (no hub one-shot on gestures)
  and on hard-gate blocks, and offers a one-click fix to add the missing
  hard key.
- When the Touch map has no hard buttons (activities made in Melodious), a
  wizard save copies all of them.
- When it already has some, a save copies only the keys that the edit
  changed. A Touch-only mapping made in MyHarmony survives.
- A hub with a Touch surface gets a `16417Activity<id>` map for each
  activity the wizard saves.

An on-screen button is a `SoftRemoteButton` whose `FunctionGroupType` is not
2 (the number pad). Its editable fields are its label (`TextOnRemote`, text
only), its press, long-press and double-press actions, and its menu slot.
Press uses `EventType: 0`; long uses `EventType: 2`. Actions an editor can
assign are a device command or a sequence in the same map. Buttons that
switch to another activity, and home control and program actions, keep
working and pass through; an editor does not create them. Never use
`ButtonHomeControlAction` on activity or device maps (only `Root` honors
it); always use `ButtonCommandAction`.

A sequence lives in its map's `Sequences`. Its steps are device commands and
delays only, run in `Order`. Deleting a sequence deletes the buttons that
run it.

Gestures are `GestureRemoteButton` entries keyed by `ButtonKey`:
`SwipeUp`, `SwipeDown`, `SwipeLeft`, `SwipeRight`, and `Tap`. Their press
uses `EventType: 1`, as Logitech's gestures and the hardware-tested ones do.
A save changes only the gestures the owner edited.

### Menu slots

The stock reader keys on-screen buttons by `MenuItem.IndexInMenu` alone,
within each map; the number pad (`FunctionGroupType: 2`) is keyed
separately. Slots are fixed:

- An existing button keeps its slot. Saving never renumbers.
- Reorder is explicit: the user moves a button, and two buttons swap slots.
- A new button takes the lowest free slot in its map (filling any index gap
  first). Removing a button leaves a gap, and gaps are valid.
- Two non-number-pad buttons in one map must never share an `IndexInMenu`.
  Hardware testing confirmed that even across different function groups
  (such as `FunctionGroupType: 1006` and `0` in a Logitech Bluetooth device
  map), the hub's reader indexes `buttons` by `IndexInMenu` alone, so the
  later entry in the `Buttons` array overwrites the earlier one and both
  on-screen rows execute the later button's command. The screens the hub
  builds (`POST /api/device-screen`) avoid this by placing every on-screen
  button in function group 0 with a unique slot.

## Validation

Two copies of the same rules run before any save: the hub's `validateGraph`,
which is authoritative and protects every client, and a mirror in the web
UI's remote model, which reports problems before the save is sent. A
`MapList` is rejected when:

- a map is not an object, its `__type` is missing or is not a device,
  activity or root button map, or its `Buttons` array is missing;
- a button is not an object or its `__type` is missing or is not a hard,
  soft or gesture button;
- a hard or gesture button has no `ButtonKey`;
- a soft button has no `MenuItem.IndexInMenu`, or the index is not a
  non-negative integer;
- two non-number-pad soft buttons in one activity map share an index;
- a button runs a sequence that is not in the same map's `Sequences`;
- a sequence has no `SequenceId` or no `Actions` array, a step is not a
  command or delay step, or a delay has no numeric `Duration`.

The hub also checks that all activity and device references exist, in
buttons and in sequence steps alike.

Fixtures are synthetic and live in
`tools/webui-sim/fixtures/touch-maplist.json`. They cover a full activity
screen with a number pad, gestures and a sequence, gap slots, an empty touch
map, an activity with no touch map, the device-screen slot clash, and each
rejected shape. The web tests run the mirror and, when LuaJIT is available,
the hub validator over the same fixtures, so the two copies cannot drift.

## The web editor

Activities → ⋮ → On-screen buttons (`#touch/<activityId>`) opens one
activity's Touch screen. Its model is
`tools/webui-sim/public/js/views/touch-model.js`; it reads the activity's
`16417Activity<id>` map and writes the whole `MapList` back through
`POST /api/activity-save`, with `ActivityList` and `FunctionList` sent
exactly as the hub returned them.

- The list shows the on-screen buttons in slot order, numbered by slot, so
  gaps stay visible.
- A button that sends a device command can be renamed, pointed at another
  command, moved, or removed. A button that runs a sequence or switches to
  another activity can be renamed, moved, removed, or changed to send a
  command.
- Buttons with Touch-only actions (such as the number-pad toggle) are shown,
  keep their slot, and can't be changed.
- Move swaps slots with the nearest button that can move. Add takes the
  lowest free slot. Remove leaves a gap. Nothing else is renumbered.
- An activity without a screen gets one on its first added button, its
  surface and remote IDs copied from another activity's screen. On a hub
  with no Touch screen at all, the editor says so and offers nothing to add.
- Labels are plain text, trimmed, at most 24 characters, and required.
- Before sending, the editor checks that the activity's map hasn't changed
  on the hub since the screen opened, and runs the validation rules above.
  It refuses to save a config without its `FunctionList` rather than send an
  empty one.
- After a save it notes that the Touch picks up the change by itself, and
  that until it does, a moved or changed button can run its new action under
  its old label.
- When the hub reports a failed save, the editor reloads and compares: if
  the hub has the edits, it reports that they were saved; if the screen is
  as the editor found it, it reports that nothing changed and keeps the
  edits; if the screen changed some other way, it shows what the hub has
  now.

Tests: `tools/webui-sim/test/touch-model.test.mjs` covers each edit,
byte-identical carry-through of every other map and button, key order, ID
allocation, and the new-screen path, and runs the hub's Lua validator over a
graph for every kind of edit.

## Saves while the engine is busy

A save writes the resources, reloads the engine, then waits for the activity
engine before it answers. An activity that is starting can hold the engine
for a long time. `codex_webui` gives the whole save 120 s, while the plugin's
engine-ready wait ends by the clock after 25 s, leaving room for the writes
and the reload, and then answers; a slow engine is reported rather than
treated as a failure. With an activity running, saves have taken over 45 s
on hardware. If the plugin still hasn't answered after 120 s, `codex_webui`
answers 504 with `"pending": true` and does not roll back: the plugin may
still finish the save, and a rollback would then land after it and undo it. `tools/touch-validator/codexactivity-barrier-test.lua`
checks the wait against a fake clock and against the limit in
`codex_webui.c`.
