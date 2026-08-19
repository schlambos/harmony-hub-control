# Session Handoff

State of the Harmony Hub Control project as of commit `5d84cd9`. This describes
where things stand, what was wrong, what was fixed, and what is known about the
hardware. It contains no recommended next steps.

## 1. Original brief

Extend `harmony-hub-control` into a complete, strictly offline replacement for
the Logitech Harmony configuration workflow, with emphasis on Activities and a
Bluetooth-controlled Google TV / NVIDIA SHIELD. Target end state: activities
created, edited, reordered, deleted, saved and executed from the Hub-hosted web
UI; roles, inputs, power ordering, button maps and Bluetooth keyboard routing
managed locally; changes persisted into the Hub's native resources; a paired
physical remote syncing from the Hub and able to start, stop and control
everything. Logitech cloud must never be contacted and must never overwrite
local configuration.

The incoming handoff stated the blocking bug as: activity button maps had no
persistent `ButtonMapId-` and all 206 physical `ButtonId` values were `0`, and
that this prevented the physical remote from controlling anything after an
activity started. That diagnosis was wrong. See section 3.

## 2. Current state

### Repository

```
branch        agent/activity-webgui
HEAD          5d84cd9  (== fork/agent/activity-webgui, in sync)
origin        Ripthulhu upstream, never pushed to, no ref for this branch
fork          github.com/schlambos/harmony-hub-control
```

Commits added this session, oldest first:

```
09d83b6  feat: allocate activity map identities offline; enable BT remote control
2d87b45  fix: never persist action-less buttons in activity maps
abdd78b  docs: document paired-remote requirements and current layout
9c0743a  fix: stop forcing IsKeyboardAssociated true on bridged Bluetooth devices
5d84cd9  chore: true up MANIFEST.txt for the rebuilt codex_webui
```

`09d83b6` also carries pre-existing uncommitted Bluetooth pairing work that was
in the working tree before this session began (pairing agent, HAL crash guards,
device bridge, HID smoke test).

### Hub

```
IP / WebGUI    192.168.0.123 : 8080
SSH            root, key ~/.ssh/harmony_owner_<key-name>
Hub / HBus ID  12345678        hostname <hub-hostname>
Firmware       4.15.600, Linux 2.6.31, 32-bit big-endian MIPS
configVersion  576
cloud_blocker  1
routes         192.168.0.0/24 and 224.0.0.0/4 via ath0, no default route
WAN            unreachable
codex_webui    ad1ef2b15f922bbe658fda0417f845a4  (matches repo)
processes      webui 1, luaworks 1, hal 13 threads, bluetoothd 1
```

### Devices

```
66690268  Google TV      NVIDIA SHIELD TV   Transport 32 (Bluetooth)  IsKeyboardAssociated=false
74521691  LG TV          OLED65C8PUA        Transport 1  (IR)
81897247  Nakamichi Amp  Shockwafe Pro 7.1  Transport 1  (IR)
```

Bluetooth: hub adapter `C8:DB:26:05:C2:52` presents as "Harmony Keyboard"
(Peripheral/Keyboard class), target `22:22:7C:82:96:9E`, profile `btkeyboard`,
hub is BR/EDR slave, link runs in sniff mode at 62.5 ms.

### Activities

```
1594209107  Arugala's PC   Type=3 Group=4
   on=0  DisplayActivityRole   LG TV      input HDMI 2
   on=1  VolumeActivityRole    Nakamichi  input HDMI 3   NextDevicePowerOnDelay 8000

1878029666  Watch TV       Type=2 Group=2
   on=0  PlayMovieActivityRole GoogleTV
   on=1  VolumeActivityRole    Nakamichi  input HDMI Arc
   on=2  DisplayActivityRole   LG TV      input HDMI 1
```

Both confirmed working from the physical remote, including Bluetooth control of
the SHIELD from inside Watch TV.

### Button maps

```
16414Root                  3 buttons   mapId 40550459
16417Device66690268       45 buttons   mapId 46597140
16417Device74521691       65 buttons   mapId 46754241
16417Device81897247       61 buttons   mapId 52944088
16414Activity1594209107   36 buttons   mapId 52944090
16417Activity1594209107   48 buttons   mapId 52944091
16414Activity1878029666   19 buttons   mapId 52944092
16417Activity1878029666   31 buttons   mapId 52944093
```

Zero action-less buttons in activity maps. Zero nonpositive or duplicate
identities. `16414Root` retains 3 action-less shortcut buttons, which is normal.

The physical remote is a **Harmony Touch** (`Settings.json` `RemoteName`). It
registers as two equad devices: index 1 = `16414` (RFID 1089578031) and index 2
= `16417`, SkinId 99 (RFID 1276934181). Hub RF identity: RFID 3556612565,
EquadID 34827.

## 3. What was actually wrong

Two independent defects, both in this project's own tooling, stacked on top of
each other. Fixing either alone left the remote broken, which is why single
fixes appeared to fail.

### Defect A: action-less buttons in activity maps

The editor and repair tool built activity maps by cloning a fixed 36-button
(surface 16414) / 48-button (surface 16417) skeleton and setting
`ButtonAction`, `ButtonLongPressAction` and `ButtonDoublePressAction` to `null`
on every button they could not map to a device in that activity.

The hub tolerates this. `getButtonMaps` in
`harmony-userconfigreader.decompiled.lua:11629` only registers a button when its
parsed action list is non-empty, so action-less buttons are silently dropped and
every hub-side check passes.

The paired remote does not tolerate it. Starting an activity whose maps contain
an action-less button makes the remote briefly display "starting activity",
return to its home screen, and stop responding to every button until it is
power cycled. It transmits nothing at all, so no `control.button?press` ever
reaches the hub and no hub log line is produced.

Evidence: a genuine Logitech configuration contains zero action-less buttons in
all 19 maps, and its activity map button counts vary (15, 17, 30, 36, 38, 48,
54) because Logitech includes only the buttons an activity can actually drive.
Maps are never padded. The only activity that worked on this hub before the fix
was `1594209107`, the one Logitech created.

Confirmed by pruning: `36 -> 19` / `48 -> 31` on Watch TV and `36 -> 16` /
`48 -> 28` on a scratch activity restored full remote control immediately.

### Defect B: `IsKeyboardAssociated` true on the Bluetooth device

With `IsKeyboardAssociated: true` on device `66690268`, the remote reports
"you have to use the Harmony App to pair this device" and transmits nothing for
that device, in both device mode and activity mode. Setting it to `false`
restored device-mode Bluetooth control and removed the prompt.

`tools/bluetooth_device_bridge.mjs` hardcoded `true` at both assignment sites,
so onboarding or re-bridging any Bluetooth device reintroduced the failure.

This value lives in the hub's `DeviceList.json`, not in the repository, so an
install, a reinstall, or importing an older bundle can silently restore it.

## 4. What was fixed, and where

### Code, committed and pushed

- `payload/web/activity-ui.js`
  - Two independent identity cursors: map IDs above `52944089`, button IDs above
    `1878029713`, signed-int32 ceiling `2147483000`. Genuine Logitech data keeps
    these in disjoint bands.
  - Identity pool now scans `activityList`, `mapList`, `functionList` **and**
    `deviceList`. `deviceList` was previously missed and holds 168 `Id-` values
    in the same numeric span.
  - Allocation is idempotent: only absent, null or non-positive values are
    assigned; valid identities are never renumbered.
  - `ButtonState` set to `1`, `Sequences` set to `[]`.
  - Split the old blanket identity reset. A nonzero `ButtonClientAction.Id` is
    now preserved; zeroing it was live data loss.
  - Action-less buttons pruned on create and clone, ordered **after** action
    routing so buttons that legitimately inherit an action survive.
  - Idempotent backfill prunes already-persisted maps, reported in the repair
    summary.
  - `validateGraph` rejects: non-positive `ButtonMapId-` on an activity map,
    non-positive or duplicate `ButtonId`, `ButtonState` outside {0,1}, missing
    `ButtonKey` on hard/gesture buttons, missing `MenuItem.IndexInMenu` on soft
    buttons, identifier/activity suffix mismatch, and any action-less button in
    an activity map. It does not reject nested action `Id == 0`, which is
    genuine.
  - `pruneActionlessButtons` exported on the test API.
- `tools/activity_graph_repair.mjs` - same contract, plus a backfill, plus
  pruned-button counts in the dry-run report, plus a check that fails when a
  `Transport: 32` device referenced by an activity role still has
  `IsKeyboardAssociated` true.
- `tools/bluetooth_device_bridge.mjs` - both sites now set
  `IsKeyboardAssociated = false`.
- `tools/activity_ui_model_smoke.mjs` - previously asserted the broken contract
  (omitted map IDs, zero button IDs). Now asserts positive unique identities,
  `ButtonState 1`, uniqueness across all maps, prune idempotence, template
  preservation, `ButtonClientAction.Id` preservation, `deviceList` in the pool,
  the action-less rejection, and that root maps are neither pruned nor rejected.
- `docs/API.md` - the old "omit `ButtonMapId-`, set `ButtonId` to 0" contract was
  wrong and is replaced. Added the action-less button contract and why hub-side
  checks cannot catch a violation.
- `docs/AI_HANDOFF.md` - corrected the claim that every activity needs two
  surface maps plus a `16420` map.
- `README.md` - rewritten, 231 to 453 lines. New sections: Paired Remote
  Requirements, Activity Graph Maintenance. Repository layout corrected. Build
  guidance now states the Zig cross-compile recipe.
- `payload/bin/codex_webui` rebuilt (`ad1ef2b1`), `activity_ui_assets.h`
  regenerated, `MANIFEST.txt` corrected.

### Hub resource state, not in the repository

- `MapList.json` - 5 activity maps received allocated map IDs `52944090` to
  `52944094`, 206 buttons received allocated IDs from `1878029714`, 206
  `ButtonState` values corrected to 1, `Sequences` normalized, then action-less
  buttons pruned.
- `ActivityList.json` - Watch TV moved to `Type=2 Group=2` with
  `PlayMovieActivityRole`; its `KeyboardTextEntryActivityRole` was removed;
  Arugala's PC Nakamichi role given `NextDevicePowerOnDelay: 8000`.
- `DeviceList.json` - `IsKeyboardAssociated` false on `66690268`, written via
  `POST /import` with `target=devices` (the only path that writes DeviceList;
  `/api/activity-save` silently ignores a `deviceList` key).
- The `16420Activity1878029666` map was deleted and is not recreated. Genuine
  Logitech configs contain no `16420` map even for activities carrying a
  Bluetooth keyboard role.
- A scratch activity `1878029882` ("BT Test") was created for isolation testing
  and has been deleted graph-aware.

## 5. Verified firmware behaviour

All line numbers refer to decompiled Lua in `/private/tmp/*.decompiled.lua`.

- `harmony-userconfigreader.decompiled.lua:11574/11578/11585` - a button map's
  runtime key is the **string** `ButtonMapIdentifier`. `ButtonMapId-` is read by
  no firmware module.
- `:11602` - a button's runtime key is the **string** `ButtonKey`. `ButtonId` is
  read by no firmware module.
- `:11629` - a button with no parsed action is silently dropped.
- `:11590-11592` and `:11649-11658` - a synthetic `PowerOffActivity` button is
  fabricated for root maps unconditionally.
- `:11340` - `properties.btAddress` comes from `DeviceList` `Device.BTAddress`.
- `harmonyengine-main.decompiled.lua:5498` - `btAddress` is re-applied at engine
  init from the settings store `/data/luaworks/harmonyengine/settings`, which
  holds `{"btAddresses":{"<deviceId>":"<mac>"}}`.
- `:5516-5546` - `properties.btDevice` is derived: `band(transport,8)==8` gives
  `ps3` or `wii`, otherwise `btkeyboard`, refined to `fire` for a FireTV
  protocol or `btkeyboard-nexus` for model "Nexus Player". A SHIELD on
  Transport 32 therefore gets `btkeyboard`.
- `harmonyengine-activity-api.decompiled.lua:2302-2309` - button dispatch builds
  `bMapId = equadId .. "Activity" .. currentActivityId`, and returns **silently**
  with no log output if that key is absent from `account.buttonMaps`. Lines
  2312-2339 are unreachable dead code because 2308 already returned.
- `:2355` logs at debug level; `:2377` and `:2325/2334/2362` log at notice.
- `:1709-1716` - the keyboard device is selected from
  `KeyboardTextEntryActivityRole`, overridden by `ControlsMediaPlayerActivityRole`,
  then by `PlayMovieActivityRole`.
- `:1899-1917` `setKeyboardDevice` - emits `hid.setdevice` with numeric
  `type` ("0", "1", "2") and the profile in `subtype`. Device-mode control
  instead emits `type = <profile string>` from `model-device:148`. Both forms
  are harmless.
- `:1244-1257` then `:1486-1488` - activity start runs a **power phase**
  (`powerActions` in `PowerOnOrder`, with `nextDelayActions[deviceId]` appended
  immediately after that device's power command) and then a separate **input
  phase** (`inputActions` in role-array order). All power commands precede all
  input commands.
- `userconfigreader:10918-10922` - `NextDevicePowerOnDelay` becomes a
  `SendDelay` action with `DelayValue` in milliseconds.
- `core-bthidmanager.decompiled.lua:48-68` - `isConnected` calls `bthid.status`
  and requires `data.type == bdType` and `data.bdaddr == bdAddr`.
- `core-kbdhidmanager.decompiled.lua` - `sendHidReport` uses `hid.report`;
  `setHidDevice` uses `hid.setdevice`. For a `pimento` host in mode 3 the short
  command names are used.
- `model-device.decompiled.lua:571-574` - `isBluetoothPaired` simply returns
  `properties.btAddress`.
- `resourcemanager:5797-5819` - `saveResource(contentType, etag, content, name,
  maxAge, hetag)` preserves the existing hetag when the 6th argument is nil.
- `resource-api:4200-4206` - a paired remote treats itself as current only when
  **both** etag and hetag match, so a hetag bump is what forces a re-pull.
- All `/opt/luaworks/**/*.lua` files are compiled Lua 5.1 bytecode despite the
  `.lua` extension (magic `1B 4C 75 61`). `payload/scripts/netservicestarter.lua`
  is the exception: it is plain editable source.

## 6. Hypotheses tested and eliminated

Recorded so they are not re-investigated. Each was disproved on hardware.

1. **Missing `ButtonMapId-` / zero `ButtonId`** - repaired, synced, no change.
   Firmware reads neither field.
2. **`ButtonState 0`** - correlated 9/9 with broken maps and was corrected to 1,
   but correcting it alone did not restore control.
3. **`bthid.status` returning 500** - a standalone `codex_hbus bthid.status '{}'`
   returns 500 because the call lacks the `type` parameter, but in the real
   firmware flow it returns 200. Not a defect.
4. **Bluetooth radio contention** - the hub holds a live BT HID link while the
   remote works normally in device mode. Unbinding BT does not un-wedge an
   already-wedged remote. Not causal.
5. **BT sniff mode** - the link was already in sniff at 62.5 ms;
   `HCI_Sniff_Mode` returned `0x0C Command Disallowed` because it was already
   sniffing. Per-connection link policy was already `0x000F`.
6. **Screen sleep / RF power management** - buttons fail while the remote is
   demonstrably awake.
7. **`proxy.resource?put` being fake-acked** - the remote wedges in runs where
   no put is ever attempted.
8. **`hid.setdevice` numeric type convention** - firing
   `hid.setdevice {"type":"0","addr":"0"}` directly while the remote was awake
   and working did not disturb it.
9. **Activity `Type` / `ActivityGroup` class** - Watch TV and the scratch
   activity were incoherent hybrids (`Type=1 Group=1` with `WatchShieldTV` and a
   `PlayMedia` role, a combination absent from genuine data). Correcting the
   class did not fix the wedge.
10. **The invented `16420Activity<id>` map** - removed; the wedge persisted.
11. **Remote battery / RF association failure** - the remote was fully charged
    and idle; flat `rfspi` counters were an idle remote, not a failing one.

## 7. Diagnostic instruments that proved useful

- **`/proc/interrupts` IRQ 46 `rfspi`** - the CC2544 interrupt counter. A
  hardware-level probe for remote RF activity that bypasses every firmware
  layer. Flat means no RF traffic; it also goes flat when the remote is merely
  asleep, which caused two wrong conclusions before that was understood.
- **Byte-exact build reproduction** - rebuilding the unmodified sources
  reproduced the deployed binary's md5 exactly, proving the toolchain and making
  any later difference attributable solely to a source change.
- **Recovering the pre-change JS from `activity_ui_assets.h`** - the header is a
  hex array of `activity-ui.js`, so the exact deployed source can be decoded
  from the binary asset. This was necessary because the working tree was already
  dirty and `git diff` could not isolate agent changes.
- **A local HTTP harness serving a saved `/api/activity-config`** - lets the
  repair tool run fully offline and repeatedly against captured states, which is
  how prune counts and idempotence were verified without touching the hub.
- **A change gate** comparing before/after configs and failing on any field
  outside an allowed set. It independently quantified the original defect as
  `417 = 5 missing map IDs + 206 non-positive ButtonIds + 206 wrong ButtonStates`.

## 8. Hardware and environment gotchas

- The hub's BusyBox lacks `find`, `df`, `du`, `stat`, `wc`, `sort`, `head`,
  `tail`, `tar`, `gzip`, `nohup`, `usleep`, and `od`. It has `awk`, `cut`, `tr`,
  `expr`, `md5sum`, `lua`, `sed`, `grep`, `cp`, `mv`, `unzip`, `hcitool`,
  `hciconfig`, `route`.
- `ls` does not support `-R`. `sleep` does not accept fractional seconds.
  `command -v` does not work; use absolute paths or `ls`.
- `/data` (mtd4) and `/cache` (mtd5) are 5 MiB jffs2 each. jffs2 compresses, so
  summing logical file sizes exceeds partition size and cannot be used to infer
  free space. There is no way to query free space on this device.
- Replacing a ~670 KB binary in place on `/data` **can exhaust the partition and
  truncate the file mid-write**. This happened once. Recovery required deleting
  old backups. Staging in `/var/volatile` (tmpfs) costs no flash.
- `/var/volatile` is tmpfs, i.e. RAM, on a 62 MB device. An unbounded
  `logread -f` capture grew to 39 MB there and dropped free memory from 24 MB to
  6 MB. Use bounded snapshots.
- Spawning `codex_hbus` once per second in a sampler drove load average to 4.75.
  Sample `/proc/interrupts` directly instead.
- `scp` fails: dropbear has no `sftp-server`. Use `ssh 'cat > file' < local` and
  `ssh 'cat file' > local`.
- Parallel SSH sessions can overload the device. Run one at a time.
- The syslog ring buffer rolls quickly and destroys evidence. `syslogd` already
  runs with `-C256`; restarting it wipes the buffer entirely.
- `/proc/uptime` reports an implausible absolute value on this device, though its
  rate is correct. The syslog clock resets to `Jan 1 00:00` each boot and the two
  disagree. Correlate by anchoring uptime to a log timestamp.
- `hal` appears as ~13 to 15 processes in `ps`; that is thread display, not
  crashes.
- Pre-existing crashlogs exist in `/cache/crashlog-*.json` from earlier direct
  `bthid` testing.
- Build: the repository's `build/build_harmony_tools_kali.sh` fetches a Linux
  x86-64 bootlin toolchain that cannot run on arm64 macOS. The deployed binaries
  were actually built with Zig's bundled clang. Proven recipe:
  `zig cc -target mips-linux-musleabi -Os -static -s -I payload/source -o payload/bin/codex_webui payload/source/codex_webui.c`.
  Result must be `ELF 32-bit MSB executable, MIPS, MIPS32 rel2, statically
  linked, stripped`. `activity-ui.js` is embedded, so
  `sh tools/embed_activity_ui.sh` must run first.
- Node is not on PATH; use a bundled runtime via `NODE=/path/to/node`.
- `/api/activity-save` accepts `activityList`, `mapList` and `functionList` only.
  A `deviceList` key is silently ignored and the response still reports success.
- `POST /import` with `target=devices` is the only path that writes
  `DeviceList.json`. It writes the file directly, bypassing the resource
  manager, so the engine keeps a stale copy until it reloads.
- `connect.stateDigest?notify` has no callable handler, so a digest broadcast
  cannot be triggered in isolation.
- `rf.info` works and reports the RF pairing table. `rf.unpair` exists; it was
  not used.

## 9. Known divergences and open items

- **`netservicestarter.lua` differs between hub and repository.** The hub carries
  a `CODEX DIAG` instrumentation patch (`aee707563156f5ad7f75174540916ecb`,
  12707 bytes) that logs `proxy.resource?put` payloads. The repository has the
  clean original (`f29d22aeda0166abf5441901aabe8897`, 11788 bytes), backed up on
  the hub at `/data/codex-backups/nss-put-diag/netservicestarter.lua.orig`. The
  patch is behaviour-neutral and captured nothing useful. Removing it requires an
  engine reload.
- **The offline egress guard is not running.** `/data/codex/offline_egress_guard.sh`
  exists, is executable, and `init.sh:14-15` starts it at boot. Its log shows it
  working correctly, stripping a default route via `192.168.0.1` roughly hourly
  as DHCP re-added it, with the last entry at `04:46:27` on the current boot. No
  such process is running now. At this moment there is no default route and WAN
  is unreachable, but nothing is enforcing that, and the DHCP lease is 7200s.
- `payload/bin/FILES` and `MANIFEST.txt` are generated by the Linux build script.
  `MANIFEST.txt` was corrected by hand for `codex_webui`; the other seven entries
  match.
- Google TV exposes 44 commands; roughly 22 are mapped in Watch TV. The LG TV has
  no buttons in Watch TV, matching Logitech's own SHIELD activity, which treats a
  display as power and input only.
- The `NextDevicePowerOnDelay` value of 8000 ms on Arugala's PC is an initial
  estimate and has not been tuned.
- `payload/source/codex_bthid_keyboard.c` and `codex_webui.c` contain hardcoded
  Bluetooth MAC addresses in self-test fixtures, including a real NVIDIA OUI.
  These are published on the fork; the owner elected to publish as-is.
- `/private/tmp/harmony-pre-profile-reuse.bundle.json` is mode `644` and contains
  a Wi-Fi PSK, `wpa_supplicant` content and MQTT config. It predates this
  session. Every bundle created during this session is mode `600`.
- The Bluetooth saved-device list contains two labels ("ushyboard" and "Harmony
  Keyboard") pointing at the same address. Cosmetic.
- Two HOT sequence anomalies were recorded early on (`unexpected ACK`,
  `MSG SEQ ERROR 2`). `MSG SEQ ERROR` has not incremented since. `LINK LOSS`
  climbs steadily and appears to track normal remote sleep/wake cycles.

## 10. Assets

On the Mac, in `/private/tmp` unless noted. `/private/tmp` is cleared on reboot.

```
hub-binary-backup/codex_webui.live-20260728    4539d0dd  original deployed binary
hub-binary-backup/codex_webui.pre-prunefix     4eb20a13  pre-prune-fix binary
hub-backups-archive-20260728/                            5 superseded hub backups
harmony-before-activity-id-repair.bundle.json  mode 600  full owner bundle, pre-repair
harmony-activity-config-after-1009.json                  GENUINE Logitech config, ground truth
activity-ui.baseline.js                                  pre-change JS decoded from the asset header
live-before-*.json                                       per-step config snapshots
verify_identity_repair.mjs                               change gate
serve_config.mjs                                         offline HTTP harness
prune_null_buttons.mjs, remove_16420.mjs, remove_kbd_role.mjs,
set_kbdassoc.mjs, fix_activity_class.mjs, finalize_watchtv.mjs,
fix_arugala_and_cleanup.mjs, make_bt_test_activity.mjs    one-off operations
*.decompiled.lua                                         firmware reference, do not commit
```

`harmony-activity-config-after-1009.json` is the single most valuable artifact.
Every correct answer this session came from diffing live state against it.

## 11. Constraints that still apply

- Do not enable Logitech cloud access, restore a WAN default route, or call
  Logitech APIs as a fallback.
- Do not use the Harmony mobile app.
- Do not unpair or factory-reset the physical remote.
- Do not bypass the deployed Bluetooth/HAL crash guards in `codex_hal_ltcp.c`
  and `codex_bthid_keyboard.c`; direct `bthid.report` / `bthid.connect` calls
  previously caused `/usr/bin/hal` to SIGSEGV.
- Do not push to `origin` (Ripthulhu). The only publication target is the
  `fork` remote, and only on explicit request.
- Do not commit SSH keys, owner bundles, Wi-Fi or MQTT configuration, firmware
  dumps, link keys, or decompiled firmware.
- Physical remote testing requires monitoring to be started first, an explicit
  statement that monitoring is ready, and then waiting for the owner to act.
- The owner's household uses this equipment. Activities must not be powered off
  and the TV must not be interrupted without checking first.

## 12. Things worth knowing that were learned the hard way

- **The hub is not a proxy for the remote.** The hub silently tolerates
  configuration the remote rejects. A green hub-side check proves nothing about
  the handset. This single asymmetry is what hid the bug.
- **Diff against genuine data first.** The genuine Logitech configuration was
  available from the start. Enumerating every structural difference between the
  one working activity and the broken ones produced the answer in minutes;
  hypothesis-driven patching consumed most of the session and produced eleven
  dead ends.
- **A narrow observation window produces confident wrong conclusions.** An idle
  remote and a wedged remote look identical over 60 seconds. Two wrong
  diagnoses came directly from this.
- **Design the experiment to answer the question asked.** Unbinding Bluetooth on
  an already-wedged remote tests whether removing a trigger heals damage, not
  whether the trigger causes it. That confusion discarded a correct hypothesis
  for several hours.
- **Change one variable.** Switching an activity's class also switched
  `PlayMedia` to `PlayMovie`, which silently re-enabled a keyboard binding,
  making that test uninterpretable.
- **`git diff` is not a verification tool on a dirty tree.** Most files here were
  already modified before the session, so a diff against HEAD blends new work
  with pre-existing work.
- **Verify tooling before trusting its output.** Several wrong conclusions came
  from broken probes: `ip` absent making a route check appear clean,
  `command -v` reporting present binaries as missing, `ls -R` unsupported making
  disk usage read as zero, and a documentation snippet that threw on the real
  API shape.
- **Owner-supplied experiments were decisive.** Comparing an IR-only activity
  against a Bluetooth activity, and then reducing to a blank activity containing
  only the Bluetooth device, isolated variables that had been conflated for
  hours.
