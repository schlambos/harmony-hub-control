# Home Assistant devices in Melodious: design

**Phase 0 deliverable — no production code.** This document designs the
programme in `HA_FULL_DEVICES_PROMPT.md`: one Harmony device per Home
Assistant *device* (device-registry entry), built from all of its mappable
entities, with two-way state and a hub `remote` entity in Home Assistant.

**Status:** proposed. The owner approves this document at the Phase 0 gate.
The merge profiles in §3 depend on the owner's real inventory (§2); run the
dumper before approving them.

**Repos:** `schlambos/harmony-hub-control` (hub) and
`schlambos/ha-melodious` (integration). Phase 0 touches the hub repo only:
this document, `tools/ha_device_inventory.py` and its test.

---

## 0. Executive summary

1. **One Harmony device per HA device.** The integration expands a selected
   HA device through the entity registry, merges its entities with a
   platform-aware profile, and sends one v2 device spec. The user can untick
   entities and commands before the set is sent.
2. **Spec v2 keeps the engine and the webhook body unchanged.** The body
   stays `{"device":"{d}","command":"{c}"}`. For a merged device, `{d}` is a
   stable device key and `{c}` is `<entity-alias>:<action>`. The hub writer
   only learns to validate and match the new spec; the stock engine, the
   protocol record, the Touch and the apps see ordinary IP commands.
3. **Backward compatibility is the design centre.** v1 sets keep working.
   A v2 spec matches the old v1 device by its key or by any of its entities,
   so the existing `Id-` is preserved. Commands keep their `Id-` by name.
   Old devices that are absorbed into a merge and are still referenced by an
   activity or button are *retained*, not deleted.
4. **The merge profile is keyed on `(domain, platform)`, not just domain.**
   The entity registry's `platform` is what distinguishes an LG `webostv`
   media player from an Android TV one. This is how LG navigation can use
   `webostv.button` even though HA core's webOS integration has no `remote`
   entity, while Google TV navigation uses the `androidtv_remote` remote.
5. **State is a new volatile channel.** `POST /api/ha-state` carries a
   per-device snapshot; the hub stores it in `/var/volatile` and serves it to
   the web and Android apps. It is display-only first; activity power
   assumptions stay command-based until proven.
6. **Phase 5 is an integration phase.** The hub already has a route that
   fires any device command (`POST /api/ir-send`, used by
   `tools/ha_devices.mjs send` for HA-backed devices). The integration wraps
   it in a `remote` entity with the `ACTIVITY` feature only. No hub PR is
   planned unless the owner's hardware test shows that route cannot fire
   IR, BT and HA-backed commands reliably.

---

## 1. What exists today (verified)

### 1.1 The v1 wire format

`POST /api/ha-devices` takes:

```json
{
  "webhook": "http://192.0.2.10:8123/api/webhook/abc",
  "devices": [{
    "entity": "media_player.living_room",
    "name": "Living Room Speaker",
    "commands": [
      {"name": "PowerOn", "value": "turn_on"},
      {"name": "Input TV", "value": "select_source:TV"}
    ],
    "power": {"on": "PowerOn", "off": "PowerOff"},
    "inputs": [{"name": "TV", "command": "Input TV"}]
  }]
}
```

Each device becomes a `DeviceList` entry whose commands are IP commands
(`TransportType` 64). The shared protocol record is `Melodious Home
Assistant`; its `ControlSection.Body` is
`{"device":"{d}","command":"{c}"}`. The engine fills `{d}` from the device's
`Tokens.Parameters` and `{c}` from the command's `Parameters` with
`string.gsub`, then POSTs to the webhook.

The integration answers `200` immediately and calls the HA service in the
background. The engine drops an IP command that waited more than 500 ms in
its queue, so the webhook must never wait for the service call.

### 1.2 The hub writer

`payload/activity/codexactivity.lua`:

| Function | Line | Role |
| --- | --- | --- |
| `HA_PROTOCOL_NAME` | 1857 | `Melodious Home Assistant` |
| `haValue` | 1885 | Rejects `%`, `{`, `}`, quotes, backslashes, control chars |
| `haDeviceSpecFrom` | 1924 | Validates one v1 device spec |
| `haEntityOf` | 2042 | Reads `{d}` from `Tokens.Parameters` |
| `haDeviceEntry` | 2135 | Builds/updates one `DeviceList` entry, preserving IDs |
| `commitHaDevices` | 2218 | Transactional add/update/remove, reference checks, Touch screens |

The writer owns every device whose `AutoDetectedDevice.Id` starts with
`melodious-ha-`. It matches owned devices by `{d}` (today, the entity ID).
It preserves device and command `Id-` values across updates, refuses to
remove a device/command/input still referenced by `ActivityList`, `MapList`
or `FunctionList`, saves only what changed, and rebuilds the device's Touch
screen.

### 1.3 The integration

`ha-melodious/custom_components/melodious/`:

- `config_flow.py:88` — `EntitySelector` over ten domains.
- `devices.py` — pure rules: `Entity`, `_commands_for`, `device_spec`,
  `build_device_set`, `allowed_values`, `service_call`. One Harmony device
  per entity.
- `__init__.py` — `MelodiousRuntime` pushes the set on start, on option
  change and 5 s after a state change that would change the set; the webhook
  handler validates `(entity, value)` against the last set and calls the
  service.
- `hub.py` — `HubClient` for `/api/ha-devices` and `/api/activity-config`.

### 1.4 Real limits

| Limit | Value | Source |
| --- | --- | --- |
| HA devices | 64 | `HA_MAX_DEVICES` |
| Commands per device | 128 | `HA_MAX_COMMANDS` |
| Inputs per device | 32 | `MAX_INPUTS` |
| Command value | 96 chars | `haValue(command.value, 96)` |
| Device key / entity | 128 chars | `haValue(raw.entity, 128)` |
| Device name | 64 chars | `haLabel(raw.name, 64)` |
| Command name | 48 chars | `haDeviceSpecFrom` |
| Request body | 256 KiB | `MAX_HA_DEVICE_SET` |
| IP queue | 500 ms | engine |
| Webhook | plain `http://` | hub trust store |
| HA token on hub | none | webhook ID is the secret |

A merged TV with 2–4 entities and 30–60 commands fits comfortably. A profile
that would exceed 128 commands must trim in the merge UI with a visible
reason (for example, "Google TV reports 140 apps; only the first 32 are
kept").

### 1.5 The Touch cannot show live state

Stock firmware only shows live state for `AutomationConfig` devices
(`re/reports/touch-firmware.md` §5). Phase 4 state therefore targets the web,
Android and macOS apps and hub-side logic. Do not promise Touch state; any
claim otherwise needs hardware proof.

---

## 2. Real inventories

### 2.1 The dumper

`tools/ha_device_inventory.py` is read-only. It connects to Home Assistant's
WebSocket API, reads:

- `config/device_registry/list`
- `config/entity_registry/list`
- `get_states`
- `get_config` (for the HA version)

and writes one JSON file grouped by device. It never calls a service and
never writes to Home Assistant.

```sh
python3 -m pip install aiohttp
HA_TOKEN=... python3 tools/ha_device_inventory.py \
  --url http://homeassistant.local:8123 \
  --device "LG" --device "Google" \
  --out ha-inventory.json
```

Create a long-lived token under **Profile → Security → Long-lived access
tokens**. Pass it with `--token-file` or the `HA_TOKEN` environment
variable, not `--token` on the command line, so it does not appear in the
process list. The output removes serial numbers, unique IDs, identifiers,
connections, configuration URLs, MAC addresses and IPv4 addresses. Add
`--anonymise` to replace device names and entity object IDs with stable
placeholders; the domain and platform stay visible, which is what the
profiles need.

The owner runs this and shares `ha-inventory.json`. The profiles below are
written against the expected shape; the dump confirms or corrects:

- which entities the LG and Google TV devices actually expose;
- each entity's `platform` (the profile key);
- `supported_features` bits (which commands are honest);
- `source_list` / `activity_list` contents (inputs vs apps);
- volume/mute attributes on the remotes;
- whether the LG TV has a `remote` entity at all.

### 2.2 Expected LG webOS inventory

HA core 2026.11.0's `webostv` integration has `media_player`, `switch`,
`notify` and services, but **no `remote` platform**. The expected device:

| Entity | Domain | Platform | Role in the merge |
| --- | --- | --- | --- |
| `media_player.<lg>` | `media_player` | `webostv` | Power, volume, mute, transport, source list, state |
| `switch.<lg>_screen` | `switch` | `webostv` | Ignored (screen on/off, disabled by default) |
| `button.*` / `switch.*` | — | — | Ignored unless the owner wants an explicit binding |

LG navigation is still available through the `webostv.button` service
(`homeassistant/components/webostv/services.py`), whose `button` field
accepts the `aiowebostv` button names: `LEFT`, `RIGHT`, `UP`, `DOWN`,
`ENTER`, `BACK`, `HOME`, `MENU`, `GUIDE`, `INFO`, `EXIT`, digits, colour
keys, transport keys. The profile maps canonical Harmony names to those
names (§3.2). This is a service-backed mapping, not a `remote` entity; it is
within the owner's "service-backed domains with a clean mapping" decision.
`service_call` returns the **service** domain (`webostv`) with the
media_player's `entity_id`; the webhook handler uses the returned domain,
not the entity's domain.

If the owner's LG TV is exposed by a different integration (for example a
custom `remote` entity), the dump will show it and the profile uses the
`remote` path instead. The design does not depend on the entity ID.

### 2.3 Expected Google TV inventory

A Google TV usually exposes two or three entities from two integrations:

| Entity | Domain | Platform | Role in the merge |
| --- | --- | --- | --- |
| `remote.<google_tv>` | `remote` | `androidtv_remote` | Navigation, OK, Back, Home, Menu, digits, power, current app |
| `media_player.<google_tv>` | `media_player` | `androidtv_remote` | Power, volume, mute, transport, playing state, app name |
| `media_player.<google_tv>_cast` | `media_player` | `cast` | Fallback transport/volume; app state; no navigation |

The `androidtv_remote` remote's `send_command` takes Android TV key codes
(`DPAD_UP`, `DPAD_DOWN`, `DPAD_LEFT`, `DPAD_RIGHT`, `DPAD_CENTER`, `BACK`,
`HOME`, `MENU`, `POWER`, `VOLUME_UP`, `VOLUME_DOWN`, `VOLUME_MUTE`,
`MEDIA_PLAY_PAUSE`, digits). The profile translates canonical Harmony names
to those codes; the hub only ever sees canonical names.

An older `androidtv` (ADB) setup exposes a `remote` whose `send_command`
accepts the `androidtv.constants.KEYS` names (`UP`, `DOWN`, `LEFT`, `RIGHT`,
`ENTER`, `BACK`, `HOME`, `MENU`, digits). The same profile handles it with a
different key table.

### 2.4 What the dump must confirm

1. **LG power:** does `media_player` report `TURN_ON` (Wake-on-LAN
   configured) or only `TURN_OFF`? If only `TURN_OFF`, the profile uses
   `webostv.button` `POWER` as `PowerToggle`, not a fake discrete `PowerOn`.
2. **LG volume:** `VOLUME_STEP` and `VOLUME_MUTE` bits. If the TV reports
   `VOLUME_SET` but not step, do not fake absolute volume; use the step
   service or the `webostv.button` `VOLUMEUP`/`VOLUMEDOWN`.
3. **LG source list:** which entries are inputs (`HDMI 1`, `Live TV`) and
   which are apps (`Netflix`). The merge UI splits them; see §3.2.
4. **Google TV navigation:** is the `remote` entity present, and is it
   `androidtv_remote` or `androidtv`? The key table differs.
5. **Google TV volume:** does the `media_player` report step/mute? If the AVR
   is the volume role, the user can untick these commands.
6. **Cast overlap:** which entity reports power/playing/volume, and which is
   stale when the TV is off. The profile prefers the Android TV entity.

---

## 3. Merge profiles

### 3.1 The profile model

A profile is a pure function:

```text
profile(domain, platform, supported_features, attributes)
  -> commands[(canonical_name, action)]
     power? {on, off}
     inputs? [{name, command}]
     roles? {power, volume, source, navigation, transport, state}
```

`platform` comes from the entity registry (`RegistryEntry.platform`), not
from the entity ID. This is the key to honest mappings: a `media_player`
from `webostv` and one from `androidtv_remote` do not get the same commands.

The profile is applied per entity, then the merge layer resolves overlaps
(§3.6). The user can untick any entity or command in the Configure UI
(§3.8).

**Ignored by default:**

- entities with `entity_category` `diagnostic` or `config`;
- entities that are `disabled_by` or `hidden_by` in the registry;
- domains with no supported profile (`climate`, `lock`, `vacuum`,
  `sensor`, `binary_sensor`, `update`, …);
- entities whose profile yields no commands (for example a media player
  with no power, volume, transport or source features);
- auxiliary entities such as `switch.<tv>_screen`, firmware-update
  buttons and diagnostic sensors.

The review UI shows ignored entities in a collapsed "Ignored" section with
the reason. An entity that has a clean profile but was ignored only because
it is auxiliary can be added explicitly; there is no arbitrary service-call
editor. The dumper records `entity_category`, `disabled_by` and
`hidden_by`, so the profile review can confirm the default set.

### 3.2 LG webOS (`media_player` + `webostv`)

| Canonical command | Action | When |
| --- | --- | --- |
| `PowerOn` | `turn_on` | `TURN_ON` feature |
| `PowerOff` | `turn_off` | `TURN_OFF` feature |
| `PowerToggle` | `button:POWER` | only when discrete power is not available |
| `VolumeUp` | `volume_up` | `VOLUME_STEP` |
| `VolumeDown` | `volume_down` | `VOLUME_STEP` |
| `Mute` | `mute` | `VOLUME_MUTE` |
| `Play` / `Pause` / `PlayPause` / `Stop` | `media_play` / `media_pause` / `media_play_pause` / `media_stop` | matching feature |
| `SkipForward` / `SkipBack` | `media_next_track` / `media_previous_track` | matching feature; on Live TV these are channel up/down |
| `Input <source>` | `select_source:<source>` | `SELECT_SOURCE`; only safe source names |
| `DirectionUp` | `button:UP` | always (webostv.button) |
| `DirectionDown` | `button:DOWN` | always |
| `DirectionLeft` | `button:LEFT` | always |
| `DirectionRight` | `button:RIGHT` | always |
| `Select` | `button:ENTER` | always |
| `Back` | `button:BACK` | always |
| `Home` | `button:HOME` | always |
| `Menu` | `button:MENU` | always |
| `Guide` | `button:GUIDE` | always |
| `Info` | `button:INFO` | always |
| `Exit` | `button:EXIT` | always |
| `0`–`9` | `button:0`–`button:9` | always |
| `Dash` | `button:DASH` | always |
| `Record` | `button:RECORD` | always |
| `Red` / `Green` / `Yellow` / `Blue` | `button:RED` / `GREEN` / `YELLOW` / `BLUE` | always |
| `ChannelUp` / `ChannelDown` | `button:CHANNELUP` / `button:CHANNELDOWN` | always |

Notes:

- **No absolute volume.** `VOLUME_SET` is not used; Harmony commands are
  step-based. The profile never invents a `Volume 35` command.
- **Power:** prefer `turn_on`/`turn_off` when both feature bits are
  present. If only one discrete direction is present, use the toggle pair
  for the activity and keep the discrete command for manual use; the
  activity's power assumption is then toggle-based. If neither is present,
  emit `PowerToggle` and let the Touch's one-shot self-long prevent double
  toggles (`codexactivity.lua` `ONE_SHOT_COMMANDS`). Do not emit both
  `PowerOn` and `PowerToggle` in the same power pair.
- **Inputs vs apps:** `source_list` mixes inputs and apps. The profile
  classifies an entry as an input when its name looks like an input
  (`HDMI`, `AV`, `Component`, `Live TV`, `Antenna`, `USB`) or when the
  integration's config marks it; everything else is an app. Inputs become
  `Input <name>` in `inputs`; apps become `App <name>` commands (not
  inputs). The user can move an entry between the two lists in the merge UI.
  For backward compatibility, a v1 device keeps the old "all sources are
  inputs" behaviour until it is migrated.
- **Command order matters for the Touch.** The screen builder takes the
  first command matching a hard-key alias. Emit `Menu` before `Home`
  (`Menu`'s aliases include `home`), `Back` before any `Previous*` command,
  and `Select` before `Enter`. The profile's command order is part of the
  contract.

### 3.3 Google TV / Android TV (`remote` + `media_player`)

Two sub-profiles:

**`androidtv_remote` (Google TV, the modern integration)**

| Canonical command | Action | Source |
| --- | --- | --- |
| `PowerOn` / `PowerOff` | `turn_on` / `turn_off` on the `remote` | remote |
| `VolumeUp` / `VolumeDown` / `Mute` | `volume_up` / `volume_down` / `volume_mute` on the `media_player` | media_player |
| `Play` / `Pause` / `PlayPause` / `Stop` | media_player services | media_player |
| `SkipForward` / `SkipBack` | `media_next_track` / `media_previous_track` | media_player |
| `DirectionUp` | `send_command:DPAD_UP` | remote |
| `DirectionDown` | `send_command:DPAD_DOWN` | remote |
| `DirectionLeft` | `send_command:DPAD_LEFT` | remote |
| `DirectionRight` | `send_command:DPAD_RIGHT` | remote |
| `Select` | `send_command:DPAD_CENTER` | remote |
| `Back` | `send_command:BACK` | remote |
| `Home` | `send_command:HOME` | remote |
| `Menu` | `send_command:MENU` | remote |
| `0`–`9` | `send_command:0`–`9` | remote |
| `Dash` | `send_command:MINUS` | remote, if the key table has it |
| `Record` / colour keys | `send_command:RECORD` / `PROG_RED` … | remote, only if the key table has them |
| `App <name>` | `turn_on` with `activity:<name>` on the remote | remote `activity_list` |

**`androidtv` (ADB, older Android TV / Fire TV)**

Same canonical set, but the key table is the `androidtv.constants.KEYS`
names: `UP`, `DOWN`, `LEFT`, `RIGHT`, `ENTER`, `BACK`, `HOME`, `MENU`,
digits. Power/volume/transport come from the `media_player`; navigation from
the `remote`.

Notes:

- **No inputs.** A Google TV is a source, not a display. Its apps are `App
  <name>` commands, not `Input` entries. The display (LG TV) selects the HDMI
  input.
- **Power:** the `remote`'s `turn_on` sends `POWER` only when off and then
  optionally launches an activity; `turn_off` sends `POWER` only when on.
  This is the honest discrete power path. Do not use the Cast entity's
  `turn_on`/`turn_off` when the Android TV entity is present.
- **Volume:** prefer the Android TV `media_player` (device volume) over Cast
  (app volume). If the AVR is the volume role, untick these commands in the
  merge UI.
- **Transport:** prefer the Android TV `media_player` over Cast. Cast is a
  fallback only when the Android TV entity is unavailable.
- **Digits:** the Android TV remote accepts digit key codes; the profile
  emits `0`–`9`, not `Digit0`.

### 3.4 Cast overlap

A Google TV often exposes a Cast `media_player` and an Android TV
`media_player`/`remote`. The merge priority is:

1. `remote` + `androidtv_remote` / `androidtv` — navigation, power, app.
2. `media_player` + `androidtv_remote` / `androidtv` — power, volume,
   transport, playing state.
3. `media_player` + `cast` — fallback transport/volume, `media_title`,
   `app_name`.

Overlap resolution:

- **Power:** the highest-priority entity that reports discrete power wins.
  Do not emit two `PowerOn` commands.
- **Volume/mute:** the highest-priority entity with step/mute wins. If the
  user chooses the AVR as the activity's volume role, the TV's volume
  commands are still on the device screen; the user can untick them.
- **Transport:** the Android TV entity wins; Cast is fallback.
- **Source:** Cast's `source_list` is apps, not inputs; it does not create
  `Input` entries. Apps become `App <name>` commands only if the Android TV
  entity does not already provide them.
- **State:** power from the Android TV entity, playing from the
  media_player, app from the remote's `current_activity`, volume from the
  media_player.

### 3.5 Generic domains

| Domain | Profile | Commands | Notes |
| --- | --- | --- | --- |
| `media_player` | generic | power, volume, mute, transport, `Input <source>` | Existing v1 behaviour; no navigation |
| `remote` | generic | power, `send_command:<name>` for a small canonical set | Only when the integration's key names are known; otherwise ignore |
| `light` | generic | `PowerOn`, `PowerOff`, `PowerToggle`, `BrightnessUp`, `BrightnessDown` | Existing |
| `switch`, `input_boolean` | generic | `PowerOn`, `PowerOff`, `PowerToggle` | Existing |
| `fan` | generic | as switch + `SpeedUp`, `SpeedDown` | Existing |
| `cover` | generic | `Open`, `Close`, `Stop` | Existing |
| `script`, `scene` | generic | `Run` / `Activate` | Existing |
| `button`, `input_button` | generic | `Press` | Existing |
| `select` | generic | `Input <option>` for each option | AVR source selectors; `select_option`; options become inputs |
| `number` | **deferred** | — | Only if a clean step mapping exists; Harmony has no arbitrary-number command. Not in this programme. |

`select` is the only new domain recommended for Phase 2. It has a clean
mapping: the entity's `options` are the choices, `select_option` sets one,
and the current option is state. An AVR's input selector becomes a set of
`Input <option>` commands and inputs, exactly like a media player's source
list. `number` is deferred because a step-based mapping is only honest for a
level control with a known `step`; the owner's AVR should use `select` or
`media_player` instead.

### 3.6 Overlap resolution and command names

The merge layer:

1. Applies each entity's profile in priority order.
2. Keeps the first command for each canonical name (case-insensitive).
3. Renames non-canonical collisions with a stable suffix (`Input HDMI 2`,
   `Input HDMI 2 2`) so a reordered entity list never re-points a button.
4. Drops commands the user unticked.
5. Recomputes `power` and `inputs` from the surviving commands.
6. Trims to 128 commands / 32 inputs with a visible reason.

Canonical names are the contract with the wizard, the Touch screen builder
and the Android app. The profile must emit the names in
`tools/webui-sim/public/js/remote-layout.js` (`REMOTE_BUTTONS`) and
`payload/activity/codexactivity.lua` (`TOUCH_SCREEN_KEYS`), not integration
vocabulary (`DPAD_CENTER`, `ENTER`, `KEYCODE_*`).

### 3.7 Limits and trimming

- **128 commands:** a TV with 32 inputs, 20 apps, 20 transport/navigation
  commands and 10 digits is near the limit. The merge UI shows the count and
  trims the lowest-priority commands (apps first, then non-canonical extras).
- **32 inputs:** keep at most 32; prefer true inputs over apps.
- **96-char values / 64-char aliases:** `<alias>:<action>` must fit. The
  alias is the entity ID by default; if the entity ID exceeds 64 chars or
  the value would exceed 96, the builder uses a short `e<8hex>` alias and
  records it in the entities table.
- **128-char keys:** if the primary entity ID exceeds 128 chars, use a
  stable `ha.<hash>` key. An entity ID longer than 128 chars cannot be sent
  as an entity; skip it with a visible warning. The hub's `haValue` limit is
  real.
- **64 devices:** one per HA device, not per entity, so the merge reduces the
  count. A user with 70 entities across 20 devices fits.

### 3.8 The editable merge UI

The Configure flow becomes:

1. **Pick** — `DeviceSelector` (multiple) and the existing `EntitySelector`
   (multiple). A device expands to its supported entities; an entity picked
   on its own becomes a single-entity device. If an entity belongs to a
   picked device, the device selection wins (no duplicate).
2. **Review** — one card per device: name, entities with checkboxes,
   commands with checkboxes, inputs/apps split, power pair, warnings
   (missing power, no navigation, over limits). The user can untick an
   entity or a command; the computed set updates.
3. **Save** — store the selected device IDs, entity IDs and disabled
   command names in the options. The merge builder recomputes from current
   state on every push, so a new source or feature appears without a
   reconfiguration, unless the user disabled it. Apply `disabled_commands`
   after the previous-set merge, so a disabled command never comes back
   from the "keep every command it had" rule.

The options schema (Phase 1):

```json
{
  "devices": [{
    "device_id": "a1b2c3",
    "key": "media_player.living_room_tv",
    "entities": ["media_player.living_room_tv", "remote.living_room_tv"],
    "disabled_commands": ["VolumeUp", "VolumeDown"]
  }],
  "entities": ["light.desk"]
}
```

`key` is stored once and never changes. On first migration it is taken from
an existing v1 device if one exists (§4.7); otherwise it is the profile's
primary entity ID. `device_id` is the HA device registry ID; it is only used
to re-expand the entity list.

---

## 4. Spec v2: one Harmony device from N entities

### 4.1 Requirements

1. One Harmony device per HA device.
2. The shared protocol body stays `{"device":"{d}","command":"{c}"}`; the
   engine and Touch need no change.
3. The hub must route each command to the right entity.
4. Existing v1 sets keep working.
5. Existing Harmony device and command `Id-` values survive migration.
6. Activities, buttons and Touch screens that reference an old device keep
   working.
7. Values fit 96 chars; keys fit 128; names fit 64/48.
8. The integration can validate a webhook call against the set it sent.
9. The design is reversible by pushing the old set.

### 4.2 Options evaluated

**Option A — `{d}` = synthetic HA-device key, `{c}` = `<alias>:<action>`,
`entities` table.**

- Pros: clean separation; the key can be the HA device registry ID; aliases
  can be short.
- Cons: a new key does not match the v1 device, so migration must map the
  old entity devices to the new key. Reverting to a v1 set (which has only
  `entity`) cannot match the synthetic key, so device IDs change and
  activities break. Adding a `migrateFrom` list fixes migration but not
  reversibility.

**Option B — `{d}` = primary entity, `{c}` = `<alias>:<action>`,
`entities` table.**

- Pros: the key matches the v1 device for the primary entity; device and
  command IDs survive; reverting to v1 works for that device. The
  integration already knows the primary entity.
- Cons: if the primary entity is removed, the key changes unless it is
  stored. The key is an entity ID that may no longer exist, which is
  cosmetically odd but harmless.

**Recommendation: Option B, refined.**

- The key is chosen once and stored in the config entry. It is the primary
  entity ID at migration time, or the highest-priority entity ID for a new
  device. It never changes, even if that entity is later removed.
- `{d}` = key; `{c}` = `<alias>:<action>`; the spec carries an `entities`
  table mapping aliases to entity IDs.
- The alias is the full entity ID by default, so the value is readable and
  unique. If `<entity_id>:<action>` would exceed 96 chars, the builder uses
  a stable short alias `e<8hex>` and records it in the table.
- The hub validates that every command value starts with a known alias.
- v1 sets have no `key`/`entities`; the writer synthesizes
  `key = entity`, `entities = [{alias: entity, entity}]`, and values stay
  bare actions.

This is the smallest change that satisfies all nine requirements. It keeps
the engine and the protocol record untouched, and it makes migration and
reversibility a matching problem rather than a reference-rewriting problem.

### 4.3 JSON shape

```json
{
  "webhook": "http://192.0.2.10:8123/api/webhook/abc",
  "dryRun": false,
  "devices": [{
    "key": "media_player.living_room_tv",
    "name": "Living Room TV",
    "model": "LG webOS TV",
    "entities": [
      {"alias": "media_player.living_room_tv", "entity": "media_player.living_room_tv"},
      {"alias": "remote.living_room_tv", "entity": "remote.living_room_tv"}
    ],
    "commands": [
      {"name": "PowerOn", "value": "media_player.living_room_tv:turn_on"},
      {"name": "PowerOff", "value": "media_player.living_room_tv:turn_off"},
      {"name": "VolumeUp", "value": "media_player.living_room_tv:volume_up"},
      {"name": "DirectionUp", "value": "remote.living_room_tv:send_command:DPAD_UP"},
      {"name": "Select", "value": "remote.living_room_tv:send_command:DPAD_CENTER"},
      {"name": "Input HDMI 1", "value": "media_player.living_room_tv:select_source:HDMI 1"}
    ],
    "power": {"on": "PowerOn", "off": "PowerOff"},
    "inputs": [{"name": "HDMI 1", "command": "Input HDMI 1"}]
  }]
}
```

A v1 device in the same set is unchanged:

```json
{
  "entity": "light.desk",
  "name": "Desk Lamp",
  "commands": [{"name": "PowerOn", "value": "turn_on"}]
}
```

The writer accepts a mixed set. `dryRun` works for both.

### 4.4 Validation

`haDeviceSpecFrom` gains a v2 branch:

| Field | Rule |
| --- | --- |
| `key` | optional in v1, required in v2; `^[a-z0-9_]+\.[a-z0-9_]+$`; ≤128; unique |
| `entities` | v2 only; 1–32 objects; unique aliases; unique entity IDs; each entity matches the entity regex; an entity may appear in only one device of the set |
| `alias` | `^[a-z0-9_.]+$` (an entity ID or a short alias); no colon; ≤64 |
| `entity` | `^[a-z0-9_]+\.[a-z0-9_]+$`; ≤128 |
| `commands` | 1–128; names as today; values `haValue(..., 96)` |
| v2 value | must be `<alias>:<action>`; alias must be in `entities`; action non-empty |
| v1 value | unchanged; no colon requirement |
| `power` | names commands; on/off distinct; toggle alternative |
| `inputs` | names commands; ≤32; unique names |
| `model` | optional; default "Home Assistant device" in v2, "Home Assistant entity" in v1 |

The writer does **not** validate the action vocabulary. That is the
integration's contract; the hub only guarantees the bytes reach the webhook.
This keeps the hub generic and lets the integration add profiles without a
hub change.

### 4.5 Routing

The webhook body is unchanged. For a v2 device:

```text
{"device":"media_player.living_room_tv",
 "command":"remote.living_room_tv:send_command:DPAD_UP"}
```

The integration:

1. Looks up the device by `device` (the key) in the set it last sent.
2. Splits `command` on the **first** colon:
   `alias = "remote.living_room_tv"`, `action = "send_command:DPAD_UP"`.
3. Resolves `alias` to the entity ID in the device's `entities` table.
4. Checks `action` against the allowed values for that `(key, alias)`.
5. Calls `service_call(entity_id, action, attributes, platform)`.
6. Fires `melodious.command_received` (§5.8).
7. Schedules the service call and answers `200` immediately.

For a v1 device, `device` is the entity ID and `command` is the bare action;
the handler keeps the current path. If a v1 body arrives for a v2 device
(for example after a downgrade), the handler treats the command as a v1
action for the primary entity and logs a warning.

The hub never learns entity IDs, platforms or service names. It only stores
the key and the opaque command value.

### 4.6 Device matching and ID stability

`commitHaDevices` builds:

- `ownedByKey`: old HA devices by their `{d}` value.
- `ownedByEntity`: old HA devices whose `{d}` is an entity ID (v1).

For each spec, in order:

1. `old = ownedByKey[spec.key]` — exact match, the normal update.
2. Else, the first old device whose `{d}` equals an entity in
   `spec.entities` (in the spec's order) — v1 migration.
3. Else, no old device — new device.

If `old` is found by entity and its `{d}` differs from `spec.key`, the
writer updates `{d}` to `spec.key`. The device `Id-` is preserved. This is
the migration.

The integration orders `entities` with the key first, so the chosen device
is the key's old device. If several old devices match the spec's entities
(the user previously had one v1 device per entity), the chosen one is the
primary; the others are **absorbed**. An absorbed device is:

- **removed** if no activity, button or sequence references it, and its
  Touch screen is removed with it;
- **retained** if referenced. It keeps its device ID, commands and screen.
  The result lists it under `retained` with the referencing resources. The
  integration shows a notification: "Old device X is still used by activity
  Y; update the activity to the merged device, then it will be removed."

Retaining is safer than rewriting references. It preserves the owner's gate
("same Harmony device IDs, activities untouched") and is reversible: the
old device is still there until the user updates the activity.

Command IDs are preserved by lower-case name on the chosen device. Commands
that only existed on an absorbed device are new commands on the merged
device; if an activity still references the absorbed device, that device is
retained, so the reference keeps working. When the user re-points the
activity to the merged device, the command name exists there.

### 4.7 v1 compatibility and migration

- **v1 set:** no `key`/`entities`; the writer synthesizes them. Device and
  command IDs are preserved exactly as today.
- **v2 set:** new fields; the writer validates and matches as above.
- **Mixed set:** allowed.
- **Old hub, new integration:** the integration reads `/api/version` and
  checks for the `ha-devices-v2` feature. If absent, it sends v1 (one device
  per entity) and shows a notice: "Update Melodious on the hub to merge
  devices." The hub PR adds the feature flag.
- **New hub, old integration:** the old integration sends v1; the writer
  accepts it. No change.
- **Existing options without `devices`:** the integration keeps the v1
  one-device-per-entity set exactly as before. The Configure UI offers
  "Merge by device"; the new options are stored only when the user saves
  that step. This is the gate's "existing entity-based devices survive"
  guarantee, and it makes the upgrade opt-in per device.
- **Choosing the key on first migration:** the integration reads the hub's
  current HA devices (`/api/activity-config`) and, if one of the merged
  entities already has a v1 device, uses that device's `{d}` as the key.
  Prefer the profile's primary entity; otherwise use the first existing
  device. This keeps the device ID and makes the v1 revert match even when
  the owner's only old device was a secondary entity. If there is no
  existing device, use the primary entity ID. If the key's entity no longer
  exists, keep it in the `entities` table as a retired alias (no command
  references it) so the old device still matches.
- **Reversibility:** for a migrated device, the key is an existing v1
  `{d}`, so pushing the old v1 set matches the same device and preserves the
  device ID. For a new device, the key is the primary entity ID chosen at
  creation; a v1 set that contains that entity matches. If the primary
  entity was deleted, the key remains but a v1 revert cannot match it; the
  old device is removed and a new one is created. Document this edge case;
  it does not affect the owner's existing devices.

### 4.8 Reference protection

The existing `haReferences()` walk is unchanged. It collects every
`DeviceId-` and `CommandName` in `ActivityList`, `MapList` and
`FunctionList`, excluding a device's own Touch screen. The new rules:

- A command removed from the chosen device is refused if referenced, as
  today.
- An input removed from the chosen device is refused if an activity selects
  it, as today.
- An absorbed device is retained if referenced, instead of refusing the
  whole commit. This is the one behavioural change: the writer prefers a
  safe partial migration over a failed save.
- A retained device is reported in `retained`; the integration can surface
  it.
- The integration keeps the previous set's allowed values for retained
  devices until they are removed, so a button on a retained v1 device still
  runs the service it ran before the migration. A webhook call for a
  retained v1 device uses the v1 path (bare action, entity key).

### 4.9 Touch screens

- The chosen device's screen is rebuilt from the merged commands, exactly as
  today. The screen builder's hard-key aliases and one-shot self-longs are
  unchanged.
- An absorbed device that is removed loses its screen.
- A retained device keeps its screen.
- The merged device's command order is the profile's order; this is what
  makes `Menu`/`Home`, `Back`/`Previous`, `Select`/`Enter` land on the right
  hard keys (§3.2).

### 4.10 Limits and failure modes

| Failure | Behaviour |
| --- | --- |
| Key/entity duplicate | 422 with the offending value |
| Command value without a known alias | 422 |
| Value > 96 chars | 422; the integration trims or uses a short alias |
| > 128 commands | 422; the merge UI trims with a reason |
| > 32 inputs | 422; the merge UI trims |
| Name collision with another hub device | 422; the integration adds " (HA)" |
| Referenced device removed | retained (not an error) |
| Referenced command removed | 422; the integration keeps the command |
| Save/reload failure | rollback of all changed lists, as today |
| Unchanged set | no save, no Touch sync |

### 4.11 API and docs changes

Hub PR (Phase 1):

- `payload/activity/codexactivity.lua`: v2 parsing, matching, retention,
  result fields.
- `payload/source/codex_webui.c`: no route change; `/api/ha-devices` already
  forwards the body. Add `ha-devices-v2` to `/api/version` features.
- `docs/API.md`: v2 request/response, migration, retention, limits.
- `docs/HOME_ASSISTANT.md`: "devices" vs "entities" wording; merge and
  migration.
- `tools/touch-validator/codexactivity-ha-devices-test.lua`: multi-entity,
  alias routing, v1→v2 migration, retention, ID stability.
- `tools/ha_devices.mjs`: a `--set` example and a `status` that prints keys
  and entities.

Integration PR (Phase 1):

- `devices.py`: `merge_device`, `build_device_set` v2, `allowed_values`,
  `service_call` with platform, short aliases. The previous set is keyed by
  device key; the merge builder preserves every command/input the previous
  merged device had, by name, so a player that is off does not lose commands
  an activity uses.
- `config_flow.py`: `DeviceSelector` + `EntitySelector`, review step.
- `__init__.py`: v2 routing, event hook, state tracking for all entities.
  `entities()` reads the entity registry for `platform`, `device_id`,
  `entity_category`, `disabled_by` and `hidden_by`; the state provides the
  rest.
- `hub.py`: version/feature check, v1 fallback.
- `manifest.json`: `after_dependencies` for `cast`, `androidtv`,
  `androidtv_remote` and `webostv` (the profiles read their entities; the
  integration does not require them).
- Tests: merge profiles, overlap, limits, v1 regression, v2 routing.
- Docs: README, strings, examples.

---

## 5. State channel (Phase 4)

### 5.1 Snapshot

The integration computes one snapshot per merged device:

```json
{
  "key": "media_player.living_room_tv",
  "available": true,
  "power": "on",
  "source": "HDMI 1",
  "volume": 0.35,
  "muted": false,
  "playing": "playing",
  "activity": "Netflix",
  "seq": 17,
  "updated": 1762500000,
  "entities": {
    "media_player.living_room_tv": "on",
    "remote.living_room_tv": "on"
  }
}
```

Field rules:

| Field | Source | Values |
| --- | --- | --- |
| `available` | any entity not `unavailable` | bool |
| `power` | profile's power entity | `on`, `off`, `unknown`; `standby` maps to `off`, `idle`/`playing`/`paused`/`on` map to `on` |
| `source` | media_player `source` or select `current_option` | string or null |
| `volume` | media_player `volume_level` | 0..1 or null |
| `muted` | media_player `is_volume_muted` | bool or null |
| `playing` | media_player state | `playing`, `paused`, `idle`, `off`, `unknown` |
| `activity` | remote `current_activity`, else media_player `app_name`/`source` | string or null |
| `seq` | integration push counter | integer, increments per push |
| `updated` | integration clock | Unix seconds (informational) |
| `entities` | per-entity state strings | alias → string |

The snapshot never invents state. If a field's entity is missing or
`unavailable`, the field is `null`/`unknown`, not `off`. `seq` is the
out-of-order guard; `updated` is only for display, so clock skew between HA
and the hub cannot drop a newer snapshot.

### 5.2 Endpoint

**Why a new endpoint, not piggyback.** `/api/ha-devices` is a flash-writing,
Touch-syncing writer: a state change every few seconds would consume the
hub's jffs2 and make the Touch pull a new revision. `/api/state` is a
read-only engine digest and `/api/activity-config` is a read-only snapshot;
neither accepts a push. A separate volatile endpoint is the only option
that meets the "never write state to flash" rule. It is also independently
rate-limited and can be absent on older hubs without breaking the device
writer.

New hub route:

```text
POST /api/ha-state
Content-Type: application/json
```

```json
{
  "states": [ { ...snapshot... } ]
}
```

Response:

```json
{"ok": true, "version": 42, "stored": 2}
```

Read:

```text
GET /api/ha-state?since=<version>
```

```json
{"ok": true, "version": 42, "changed": true, "stale": false, "states": [ ... ]}
```

`changed:false` and `code:304` when `since` equals the current version
(the same shape as `/api/state`). `stale:true` when the last push is older
than 90 s; the states are still returned for diagnostics but consumers
render "unknown".

The hub validates the top-level object, the `states` array and the state
count; it does not parse every field. The integration is the only writer
and is trusted on the LAN, so this keeps the C route small and fast. The
web/Android apps validate what they consume.

The web app's initial `/api/activity-config` response also carries
`haState` and `haStateVersion`, so a page load does not need a second
request. The activity page can keep its existing `/api/state` poll and read
`haState` from the full config when the activity state changes; a device
page polls `/api/ha-state?since=...` directly. Android can use the same
field or poll `/api/ha-state`.

### 5.3 Storage

- Path: `/var/volatile/codex-ha-state.json` (tmpfs; never flash).
- Atomic write: write a temp file in the same directory, `rename` over the
  old one. The file is at most 64 KiB.
- Version: an integer in the file, incremented on each accepted push.
- No backup, no export, no `resourceSnapshot`, no Touch sync. This is
  volatile by design; a reboot starts at `stale:true`.
- The hub's `codex_webui` child processes read the file on each request;
  no shared memory is needed.

### 5.4 Debounce, rate limit, staleness

Integration:

- Coalesce state changes per device with a 2 s debounce.
- Batch all devices into one push.
- Send a heartbeat every 30 s even when nothing changed.
- Never push more than once per 2 s.
- Use a state-push lock/timer separate from the device-set push, so a slow
  `/api/ha-devices` save does not delay state.
- On HA shutdown/unload, do not send an "off" snapshot; the hub's stale
  timer is the source of truth.

Hub:

- Accept at most one push per second per source IP; return `429` with
  `Retry-After: 2` if exceeded.
- Reject a body over 64 KiB with `413`.
- Reject more than 64 states with `400`.
- Mark stale after 90 s without a push (using the hub's receive time, not
  the integration's clock).
- Store the latest accepted body. The integration serializes pushes (one in
  flight, `seq` monotonic), so out-of-order writes do not occur; `seq` is
  carried for diagnostics and for a future hub-side check if a second writer
  ever appears.

### 5.5 Consumers

| Consumer | What it shows |
| --- | --- |
| Web device page | Power, source, volume, mute, playing, app; grey out commands that do not apply |
| Web remote screen | Same, plus a "state unknown" badge when stale |
| Android device/remote screens | Same; parse `haState` from `/api/activity-config` or `/api/ha-state` |
| macOS app | Same as web (shared model) |
| Fix It | "TV is already on" / "TV is off" hints |
| Activity power assumptions | **Phase 4 follow-up only**: skip `PowerOn` when `power == "on"` and the state is fresh, for devices with discrete power; otherwise keep the current command-based behaviour |
| Touch | **Not supported**; do not claim it |

### 5.6 When HA is down

- No pushes; after 90 s the hub marks the state stale.
- Apps render "unknown", never "off".
- The hub's activity start/stop still sends the configured commands; it
  does not block on state.
- The integration's `available` flag is not a substitute for the hub's
  stale timer: a crashed HA cannot send a final "unavailable".

### 5.7 Security

- The hub API is LAN-only and uses the same Basic auth as the rest of the
  web UI. The state endpoint adds no new secret.
- Anyone on the LAN who can reach the hub can spoof state. This is the same
  threat model as the existing unauthenticated webhook and the hub's other
  routes; document it. Do not put an HA token on the hub.
- The state file contains no HA token, only entity keys and state values.
  It is not included in `/export/bundle`.
- One HA instance per hub is assumed. The writer already rejects duplicate
  device keys, so two HA instances cannot silently share a key; the second
  push is refused with a clear error.

### 5.8 Event hook

For every accepted hub-originated command, the integration fires:

```python
hass.bus.async_fire(
    "melodious.command_received",
    {
        "hub": entry.data[CONF_HOST],
        "device": device_name,
        "device_key": key,
        "entity_id": entity_id,
        "command": command_name,      # e.g. "DirectionUp"
        "action": action,             # e.g. "send_command:DPAD_UP"
        "value": raw_value,           # e.g. "remote.tv:send_command:DPAD_UP"
    },
)
```

The runtime keeps a reverse map from `(key, alias, action)` to the hub
command name, so the event carries `DirectionUp` rather than the raw
`send_command:DPAD_UP`. Fire it after validation and before/after scheduling
the service call; the event means "the hub asked for this command", not
"the service succeeded". Document an example automation:

```yaml
alias: Harmony DirectionUp also starts the movie lights
triggers:
  - trigger: event
    event_type: melodious.command_received
    event_data:
      device: Living Room TV
      command: DirectionUp
actions:
  - action: light.turn_on
    target:
      entity_id: light.movie_lights
  - action: remote.send_command
    target:
      entity_id: remote.melodious_hub   # the Phase 5 hub remote entity
    data:
      device: Google TV
      command: DPAD_UP
```

Do not build a hub-side automation engine; HA is the automation engine.

---

## 6. Activity coexistence (Phase 3)

### 6.1 Target activity

The hub fixture's "NVIDIA Shield" activity is the shape to prove (the
owner's real activity will be confirmed from the hub, not the fixture):

| Role | Device | Input | Power order |
| --- | --- | --- | --- |
| Display | LG TV (HA, merged) | `HDMI 2` (Google TV) | 1 |
| Volume | AVR (IR or HA) | `TV` / `ARC` | 2 |
| PlayMovie | Google TV (HA, merged) | — | 3 |
| Extra | HA lights | — | not a member |

The Google TV is a source, not a display. The LG TV selects the Google TV's
HDMI input. The AVR selects the TV's ARC/optical input (or the Google TV's
audio, depending on the wiring). The lights are bound to colour keys or
swipes as Extra controls; they are not powered by the activity.

### 6.2 Roles

The wizard's role defaults already key on command names
(`tools/webui-sim/public/js/wizard-model.js:124`):

- Volume keys → `VolumeActivityRole`.
- Channel/digits → `ChannelChangingActivityRole`.
- Transport/D-pad/OK/Back/Home/Menu → `PlayGame` → `PlayMovie` →
  `PlayMedia` → `ChannelChanging` → `Keyboard` → `Display`.

A merged LG TV with `VolumeUp`/`VolumeDown`/`Mute` and a merged Google TV
with `DirectionUp`/`Select`/`Back`/`Home` therefore resolve correctly. The
AVR as volume role wins the volume keys. The Google TV as PlayMovie wins the
transport/D-pad keys. No wizard change is needed for the default mapping.

### 6.3 Power order and delays

The wizard currently assigns `PowerOnOrder`/`PowerOffOrder` by first
appearance in the roles list (`wizard-model.js:330`), not by role. For a
mixed activity the owner must set the order manually. Phase 3 should change
the default to:

1. Display (TV on first, so it can accept the input change)
2. Volume (AVR/soundbar on second)
3. Play* (player on third)
4. Channel/Keyboard (last)

with a per-role delay (`NextDevicePowerOnDelay`) default of 2–3 s for a TV,
1–2 s for an AVR, 1 s for a player. The advanced editor already exposes
both fields (`payload/web/activity-ui.js:1202-1212`). The change is in
`wizard-model.js`/`activity-ui.js` with sim tests; it must not reorder an
existing activity on open (only new activities and "Reset to defaults").

### 6.4 Input selection

- The LG TV's `Input HDMI 2` is selected by the Display role.
- The AVR's `Input TV`/`ARC` is selected by the Volume role.
- The Google TV has no input; it starts its app or stays on its launcher.
- If the LG TV is already on the right input, the activity still sends the
  input command; the state channel can later suppress it, but that is a
  Phase 4 follow-up, not a Phase 3 requirement.

### 6.5 Volume

- If the AVR is the volume role, the volume keys go to the AVR. The LG TV's
  and Google TV's `VolumeUp`/`VolumeDown`/`Mute` remain on their device
  screens; the user can untick them in the merge UI to avoid confusion.
- If the TV is the volume role, the AVR is not a volume role; the TV's
  commands are used. Do not point the volume role at a device without
  step/mute commands.
- Absolute volume is never faked. The state channel shows the level; the
  commands are steps.

### 6.6 Extra non-member bindings

The existing "Extra" handling already keeps non-member devices and their
one-shot self-longs across saves (`wizard-model.js:199`,
`docs/HOME_ASSISTANT.md`). A merged HA light device works as an Extra:
bind it to a colour key, an on-screen row or a swipe. No change is needed.
The only gap is discoverability: the device picker should show merged HA
devices with their device names, not entity names.

### 6.7 Wizard/editor gaps

| Gap | Fix | Phase |
| --- | --- | --- |
| Power order defaults by first appearance | Role-based default order + delays | 3 |
| Device picker shows entity names for v1 HA devices | Show the merged device name; group by HA device | 1 (integration) / 3 (wizard display) |
| Input list mixes apps and inputs | Profile splits `inputs` and `apps`; UI shows both | 2 |
| Touch hard-key aliases collide on `Menu`/`Home`, `Back`/`Previous`, `Select`/`Enter` | Profile emits canonical order; no builder change | 2 |
| Extra controls badge says "not powered by activity" | Already correct; keep | — |
| Android editor parity | Check first; some editors are web-only by design | 3 |

### 6.8 Android parity

The Android app's `ActivityGraphBuilder` parses `DeviceList` and
`ActivityList`; merged devices are ordinary devices, so the graph builder
needs no change. The device/remote screens need the Phase 4 state field.
Check the activity editor's Android parity first; if it is web-only by
design, keep that split and do not port it in this programme.

---

## 7. Reverse direction: the hub as a `remote` entity (Phase 5 / #87)

### 7.1 HA core contract (2026.11.0)

Citations are to `home-assistant/core` tag `2026.11.0`:

- `homeassistant/components/remote/const.py`:
  - `RemoteEntityFeature`: `LEARN_COMMAND = 1`, `DELETE_COMMAND = 2`,
    `ACTIVITY = 4`.
  - `DEFAULT_NUM_REPEATS = 1`, `DEFAULT_DELAY_SECS = 0.4`,
    `DEFAULT_HOLD_SECS = 0`.
  - `ATTR_ACTIVITY`, `ATTR_DEVICE`, `ATTR_COMMAND`, `ATTR_NUM_REPEATS`,
    `ATTR_DELAY_SECS`, `ATTR_HOLD_SECS`.
- `homeassistant/components/remote/entity.py`:
  - `RemoteEntity` extends `ToggleEntity`; `state` is on/off from `is_on`.
  - `state_attributes` returns `activity_list` and `current_activity` only
    when `ACTIVITY` is in `supported_features`; otherwise `None`.
  - `async_send_command(command: Iterable[str], **kwargs)` is the override
    point; `async_learn_command`/`async_delete_command` exist, but the base
    methods raise `NotImplementedError`. The feature flags control whether
    HA advertises the capability; they do not remove the services.
- `homeassistant/components/remote/services.py`:
  - `send_command` schema: required `command` (list of strings), optional
    `device` (string), `num_repeats` (positive int, default 1),
    `delay_secs` (float), `hold_secs` (float, default 0).
  - `turn_on`/`turn_off`/`toggle` schema: optional `activity` (string).
  - `learn_command` schema: optional `device`, `command`, `command_type`,
    `alternative`, `timeout`.
- `homeassistant/components/harmony/remote.py` (the built-in Harmony
  integration, the behavioural model for #87):
  - `_attr_supported_features = RemoteEntityFeature.ACTIVITY`.
  - `turn_on(activity=...)` starts the named/default/last activity;
    `turn_off()` starts PowerOff.
  - `send_command` requires `device`, resolves it by name or numeric ID,
    logs an error for an unknown device, and sends the command list with
    `num_repeats`, `delay_secs`, `hold_secs`.
  - `is_on` is false when the current activity is `PowerOff`.
  - The entity is `unavailable` when the hub is disconnected (the
    `HarmonyEntity.available` path).
- `homeassistant/helpers/selector.py`: `DeviceSelector` and
  `EntitySelector` are the config-flow selectors; `DeviceSelectorConfig`
  supports `multiple` and filters.
- `homeassistant/helpers/entity_registry.py`:
  `async_entries_for_device(registry, device_id)` returns the entities for
  a device; this is the expansion API.
- `homeassistant/helpers/device_registry.py`: `DeviceEntry` carries `id`,
  `name`, `name_by_user`, `manufacturer`, `model`, `model_id`,
  `identifiers`, `connections`, `disabled_by`.

What cannot be honestly implemented:

- **`learn_command`:** the hub can learn IR through its own UI/API, but the
  integration cannot learn a command into a named hub device through a
  stable public route, and it cannot learn BT/HA commands at all. Do not
  advertise `LEARN_COMMAND`.
- **`delete_command`:** the hub has no public route to delete one command
  from a device. Do not advertise `DELETE_COMMAND`.
- **Exact `hold_secs`:** the hub's IR/BT hold is press/hold/release with
  the engine's repeat cadence; HA-backed IP commands repeat the webhook
  POST. It is an approximation, documented and logged. It is not silently
  dropped.
- **Absolute state for every device:** the hub only knows what the Phase 4
  state channel reports for HA-backed devices and what the engine reports
  for activities. IR devices without state feedback are assumed-state.

### 7.2 Entity model

One `remote` entity per config entry (per hub). Set `PARALLEL_UPDATES = 0`
so HA does not serialize commands behind a platform update:

```python
class MelodiousRemote(RemoteEntity, CoordinatorEntity[MelodiousCoordinator]):
    _attr_supported_features = RemoteEntityFeature.ACTIVITY
    _attr_has_entity_name = True
    _attr_name = None
    _attr_unique_id = f"{entry.unique_id}_remote"
    _attr_device_info = DeviceInfo(
        identifiers={(DOMAIN, entry.unique_id)},
        manufacturer="Melodious",
        model="Harmony Hub",
        name=entry.title,
        sw_version=hub_version,   # from /api/version
        configuration_url=f"http://{entry.data[CONF_HOST]}:{entry.data[CONF_PORT]}",
    )
```

- `available`: coordinator's last update succeeded and the catalogue is
  loaded.
- `is_on`: `current_activity not in (None, "PowerOff")`.
- `current_activity`: from `/api/activity-state` (the hub's engine).
- `activity_list`: from `ActivityList`.
- `extra_state_attributes`: `devices` (names), `device_count`,
  `activities` (names), `last_activity`. Do not dump the full command
  catalogue into state attributes; it can be thousands of entries. Add a
  `melodious.list_commands` service (response) if users need discovery, or
  document that command names are the ones shown in the Melodious app.
- `RestoreEntity`: restore `last_activity` so `turn_on` with no activity
  resumes the previous one, like the built-in Harmony.
- The entity ID is derived from the entry title (for example
  `remote.melodious_hub_192_168_0_123`); the examples below use
  `remote.melodious_hub` as a placeholder.
- `manifest.json` adds `remote` to `dependencies` (the platform needs the
  `remote` component); the existing `webhook` dependency stays.

### 7.3 Catalogue sync

The coordinator fetches `/api/activity-config` (0.2 s on the hub) and
`/api/activity-state` every 30 s. It builds:

```python
@dataclass(frozen=True)
class HubDevice:
    id: str
    name: str
    commands: tuple[str, ...]
    is_ha: bool

@dataclass(frozen=True)
class HubActivity:
    id: str
    name: str
```

Resolution:

- Device: strip the name, then exact name, then numeric ID, then a
  case-insensitive name match with a warning. The built-in Harmony uses
  exact name or numeric ID; match that, and log the available names on
  failure.
- Command: exact name on the resolved device; log the available commands on
  failure (truncate the log to a reasonable number).
- Activity: exact name, then numeric ID; log the available activities on
  failure.

Renames on the hub are visible after the next refresh (≤30 s). Automations
that use the old name fail until updated; document this breakage. The
`devices` attribute lists the current names.

### 7.4 Commands

`async_send_command(command, **kwargs)`:

1. Require `device`; if missing, log an error and return (built-in
   behaviour).
2. Resolve the device. If unknown, log an error with the available names
   and return.
3. For each command name, resolve it on the device. If unknown, log an
   error and skip it (built-in behaviour); do not send a wrong command.
4. Clamp `delay_secs` and `hold_secs` to ≥0; treat `num_repeats` < 1 as 1.
5. For `num_repeats` times, for each command:
   - `POST /api/ir-send` form-encoded with `deviceId` and `command`.
   - If `hold_secs > 0`: `status=press` with a unique `holdId` (8–40
     letters/digits), send `status=hold` every 200 ms while waiting
     `hold_secs` (the hub's lease is 700 ms), then `status=release` with the
     same `holdId`; always release in a `finally`.
   - Sleep `delay_secs` between commands/repeats.
6. Log the hub's `reply` at debug; if it contains an engine error, log a
   warning. If the HTTP call fails, raise `HomeAssistantError` so the
   automation sees it.
7. If the target is HA-backed (`TransportType` 64) and `hold_secs > 0`,
   log a warning: the hub repeats the IP command on each hold, which is
   right for step commands but can double-fire a one-shot toggle. The
   parameter is honoured as the hub can honour it, not silently dropped.

`turn_on(activity=None)`:

1. Resolve the activity: explicit name/ID, else `last_activity`, else the
   first activity.
2. If it is already current, log debug and return (avoid restarting, like
   the built-in Harmony).
3. `POST /api/activity-run` with `activityId`, form-encoded.
4. Refresh the coordinator.

`turn_off()`: `POST /api/activity-run` with `activityId: -1`, form-encoded;
refresh. The `activity` argument on `turn_off` is accepted by HA's schema
but ignored, like the built-in Harmony; log it at debug.

Both `/api/activity-run` and `/api/ir-send` read form fields
(`form_value`), so the integration posts
`application/x-www-form-urlencoded`, not JSON. `/api/ha-devices` and
`/api/ha-state` are JSON routes.

`toggle()`: the base `ToggleEntity.async_toggle` calls `turn_on`/`turn_off`
based on `is_on`; the hub's `remote.toggle` service works.

### 7.5 Activity state

The remote entity's state is the hub's running activity, not the Phase 4
HA-device state. Phase 4 state is per HA-backed device; the hub's activity
is engine state. Use `/api/activity-state` (`harmony.engine?getCurrentActivity`)
for the entity. If the hub is unreachable, `available = False` → HA renders
`unavailable`, not `off`. Use a short grace period (for example two failed
30 s polls, or a 10 s retry) before flipping to unavailable, so a transient
poll failure does not flap the entity; the state is still never "off".
Map the hub's no-activity reply (`-1`/`null`/empty) to `PowerOff`, the same
name the built-in Harmony uses. `/api/activity-state` wraps the engine's
reply as a JSON string; parse it defensively (the exact engine payload is
confirmed on the owner's hub during Phase 5).

### 7.6 Multi-hub coexistence

- One config entry per hub; one `remote` entity per entry.
- `unique_id` is `entry.unique_id` (the host) plus `_remote`; stable across
  restarts and renames.
- Entity IDs are derived from the entry title; HA's entity registry keeps
  them stable if the title changes (the user can rename).
- The #87 reporter runs four hubs; four entries produce four distinct
  entities with distinct unique IDs. No global state.
- The integration's existing `async_set_unique_id(data[CONF_HOST])` prevents
  duplicate entries for the same host.

### 7.7 Unknown names

Match the built-in Harmony: log an error with the available names and
return; do not raise for an unknown device/command. A malformed service call
(missing `command`, wrong type) is rejected by HA's schema before the entity
method. This is the behaviour HA users expect from the built-in integration.
If the owner prefers a hard error, use `ServiceValidationError`; document
the choice.

### 7.8 `learn_command` and `delete_command`

Not advertised: the `LEARN_COMMAND`/`DELETE_COMMAND` feature flags are
absent, so HA's UI does not offer the capability. The services are still
registered globally by the `remote` component; if one is called against
this entity, the base method raises `NotImplementedError`, which HA
surfaces as an error. The hub's IR learning remains in the Melodious app.
Document this limitation in the README and the entity's docs.

### 7.9 Transport to the hub

Use the existing `POST /api/ir-send` (form-encoded) because:

- `tools/ha_devices.mjs send` already uses it for HA-backed devices, so it
  reaches `TransportType` 64 as well as IR/BT.
- It supports `status=press|hold|release` with a `holdId` for hold.
- It returns the engine's reply string.
- It requires no hub PR.

If the owner's hardware test shows that `/api/ir-send` cannot fire a BT or
HA-backed command reliably (for example, the BT pre-connect path refuses a
non-IR device), Phase 5 adds a small hub PR:
`POST /api/device-command` with JSON `{deviceId, command, holdSecs}` and a
structured `{ok, reply}` response. The design keeps this as a contingency,
not a planned change.

### 7.10 Worked example

```yaml
alias: Movie night from HA
triggers:
  - trigger: state
    entity_id: input_boolean.movie_night
    to: "on"
actions:
  - action: remote.turn_on
    target:
      entity_id: remote.melodious_hub
    data:
      activity: Watch a movie
  - action: remote.send_command
    target:
      entity_id: remote.melodious_hub
    data:
      device: Living Room TV
      command: Input HDMI 2
  - action: remote.send_command
    target:
      entity_id: remote.melodious_hub
    data:
      device: Google TV
      command: Select          # the hub device's command name, not DPAD_CENTER
      num_repeats: 1
      delay_secs: 0.4
```

The #87 use case (an existing automation that used the built-in Harmony
remote):

```yaml
- action: remote.send_command
  target:
    entity_id: remote.melodious_hub
  data:
    device: NVIDIA Game Console
    command: DirectionUp   # the exact name the hub shows for that device
```

The command name is the hub's name, not an Android key code. A device that
calls its command `Up` must be called with `Up`; a merged HA device that
emits the canonical profile calls it `DirectionUp`. The `devices` attribute
and the Melodious app are the discovery surfaces.

### 7.11 Tests

Pure functions (no HA runtime):

- `catalogue.py`: parse a fixture `DeviceList`/`ActivityList`; resolve
  names/IDs; unknown names; duplicate names.
- `remote.py` parameter translation: `num_repeats`, `delay_secs`,
  `hold_secs`; command list order; missing device; unknown command.
- Multi-hub unique ID derivation.
- State mapping: current activity → `is_on`; PowerOff → off; unavailable →
  unavailable.

HA runtime tests (optional, if the repo adds
`pytest-homeassistant-custom-component`):

- Entity setup, `turn_on`/`turn_off`, `send_command`, coordinator failure.
- The existing plain `unittest` suite stays dependency-free.

---

## 8. Phased build plan

Estimates are for one PR unless stated; S ≈ half a day, M ≈ 1–2 days,
L ≈ 3–5 days.

### Phase 1 — Spec v2 (two PRs)

**Hub PR (M/L):**

- v2 parsing/validation in `haDeviceSpecFrom`/`haSetFrom`.
- Matching by key/entity; migration; absorption/retention.
- Result fields (`key`, `entities`, `migratedFrom`, `retained`).
- `ha-devices-v2` feature flag.
- Lua tests: multi-entity, alias routing, v1→v2 migration, retention,
  ID stability, unchanged-set no-op.
- Docs: `API.md`, `HOME_ASSISTANT.md`, `ha_devices.mjs`.

**Integration PR (L):**

- `DeviceSelector` + review step; options schema.
- Merge builder (pure functions) with webOS/Android TV/Cast/generic
  profiles; overlap; limits; short aliases.
- v2 set builder; v1 fallback via `/api/version`.
- Webhook routing by key/alias; `allowed_values`; event hook stub.
- Tests: merge profiles, overlap, limits, v1 regression, v2 routing.
- Docs: README, strings.

**Gate:** owner deploys the hub PR and updates the integration; existing
entity-based devices keep their Harmony device IDs and activities are
untouched.

### Phase 2 — `remote` entity and expanded profiles (integration, M/L)

- `remote` domain profile for `androidtv_remote`/`androidtv`.
- `webostv.button` profile for LG navigation.
- `select` profile for AVR inputs.
- `media_player` refinements (no fake absolute volume).
- Command-order rules for Touch hard keys (`Menu` before `Home`, etc.).
- Tests: per-profile command tables, service calls, allowed values.
- Docs: per-integration gaps.

**Gate:** LG TV and Google TV each work as a single Harmony device from the
web app and a Touch device screen — power, volume, source, transport,
D-pad/OK/Back/Home — with no IR/BT configured for those two.

### Phase 3 — Activities (hub, M)

- Role-based power order/delay defaults in the wizard.
- Device picker display for merged devices.
- The activity editor's input list shows the merged device's inputs, not
  its apps.
- Sim tests; regenerate the web bundle and rebuild `codex_webui` if JS
  changed (pinned bun/Zig, update pins).
- Android parity check; no port of web-only editors.
- Docs: role/power-order notes in `HOME_ASSISTANT.md` and the web UI guide.

**Gate:** owner runs the mixed activity (LG TV + Google TV + AVR + lights)
for an evening; IR/BT fallbacks for the two TVs removed or disabled.

### Phase 4 — State and event chaining (two PRs)

**Hub PR (M):**

- `POST/GET /api/ha-state`; tmpfs storage; version/stale/rate limit.
- `haState` in `/api/activity-config`.
- Web app device/remote state display; grey-out; "unknown" for stale.
- Tests: route validation, stale, version, no flash writes.
- Docs: `API.md`, `HOME_ASSISTANT.md`.

**Integration PR (M):**

- Snapshot builder; debounce/heartbeat; state push.
- `melodious.command_received` event; example automation.
- Tests: snapshot fields, stale/unknown, event payload.

**Gate:** turning the LG on with its own remote updates the app state; an
HA automation chained from a Harmony button fires end to end.

### Phase 5 — Hub `remote` entity (integration, M/L)

- `remote` platform, coordinator, catalogue, `send_command`,
  `turn_on`/`turn_off`, restore last activity.
- Multi-hub unique IDs; unavailable state.
- Tests: catalogue, parameter translation, unknown names, multi-hub.
- Docs: README, worked example, limitations (`learn_command` not
  advertised, hold approximation).
- Contingency hub PR only if `/api/ir-send` fails the hardware matrix.

**Gate:** owner recreates one existing automation with
`remote.send_command` against the Melodious entity; #87 closes.

### Phase 0 (this PR, S)

- This document.
- `tools/ha_device_inventory.py` and `tools/test_ha_device_inventory.py`.
- Baseline measurements (below).

---

## 9. Test plan and baselines

Measured on 2026-11-07 from `origin/main` (`f235321`) in a clean worktree:

| Suite | Command | Result |
| --- | --- | --- |
| Web UI sim | `node --test tools/webui-sim/test/` | 577/577 pass |
| HA writer Lua | `luajit tools/touch-validator/codexactivity-ha-devices-test.lua` | 44/44 checks |
| Desktop | `node --test desktop/test/` | 54 pass, 2 skipped |
| Integration | `python3 -m unittest discover -s tests -p 'test_*.py'` | 12/12 pass |
| Inventory dumper | `python3 tools/test_ha_device_inventory.py` | 4/4 pass |
| Hygiene | `node tools/shipped_copy_hygiene.mjs` | ok |
| Shell smoke | `node tools/harmony_shell_smoke.mjs` | ok |

The handoff's `tools/reconciliation` suite is not present in this `main`
checkout, so the 12 known reconciliation failures could not be re-measured
here. They are not part of this programme.

Per-PR requirements:

- Hub: the Lua HA writer suite, the full `tools/touch-validator/*.lua` set,
  the sim suite, hygiene and shell smoke. Report exact counts.
- Integration: `python3 -m unittest discover -s tests -p 'test_*.py'`.
- Every PR updates docs in the same PR.
- Phase 3 web changes: rebuild with pinned bun/Zig and update pins per repo
  convention.

---

## 10. Risks and open questions

1. **LG navigation without a `remote` entity.** The design uses
   `webostv.button`; the dump must confirm the service is available and the
   button names work on the owner's TV. If not, LG D-pad is a documented
   gap (power/volume/source/transport still work).
2. **LG power.** If `TURN_ON` is absent and `POWER` toggles, the profile
   emits `PowerToggle`; the Touch's one-shot self-long prevents double
   toggles, but the activity's power assumption is weaker. The dump
   confirms.
3. **Apps vs inputs.** The v1 behaviour treats every source as an input.
   The v2 profile splits them; existing activities that use `Input Netflix`
   must keep working. The migration keeps the v1 command names on the
   retained old device until the user re-points the activity.
4. **Retained old devices.** The merge may leave old v1 devices in
   `DeviceList` until the user updates activities. This is intentional and
   reported; the alternative (rewriting references) is riskier.
5. **State spoofing.** The hub API is LAN-trusted; state can be spoofed by
   anyone on the LAN. This matches the existing threat model; document it.
6. **State on the Touch.** Not possible on stock firmware; do not promise.
7. **Phase 5 hold timing.** The hub's hold is press/hold/release with the
   engine's cadence; HA-backed commands repeat. Document the approximation.
8. **`/api/ir-send` for all transports.** The tool already uses it for HA
   devices, but the owner's hardware test must prove IR, BT and HA-backed
   commands. If not, the contingency is a small `/api/device-command` hub
   PR.
9. **Catalogue size.** `/api/activity-config` includes every device and
   command; the coordinator parses it every 30 s. On a 62 MB hub this is
   fine (0.2 s), but the integration should cache and avoid logging the
   whole catalogue.
10. **Name changes.** Renaming a device/command on the hub changes the
    automation-visible name after ≤30 s. Automations using the old name
    fail; document the breakage and the `devices` attribute for discovery.

Any Phase 3/4 screenshots or recordings for the docs use real data with
MAC addresses, IP addresses and the Wi-Fi name masked, per `HANDOFF.md`.

---

## 11. Phase 0 gate checklist

Owner approval is requested for:

1. **Spec v2 routing** — `{d}` is the stable device key (the primary entity
   ID, stored once); `{c}` is `<entity-alias>:<action>`; the spec carries an
   `entities` table. v1 sets keep working; v1→v2 migration preserves the
   primary device ID and command IDs; absorbed devices that are still
   referenced are retained, not deleted.
2. **Merge profiles** — platform-aware; LG webOS uses `webostv.button` for
   navigation; Google TV uses `androidtv_remote`/`androidtv` for navigation
   and its `media_player` for power/volume/transport; Cast is a fallback;
   inputs and apps are split; the user can untick entities and commands.
3. **State channel** — new `POST/GET /api/ha-state`, tmpfs storage, 2 s
   debounce, 30 s heartbeat, 90 s stale, display-only first.
4. **Phase 5 transport** — `/api/ir-send` (form-encoded) for IR, BT and
   HA-backed commands; hold via press/release; no hub PR unless the
   hardware matrix fails.
5. **Activity defaults** — role-based power order (Display 1, Volume 2,
   Player 3) and delays in Phase 3, without reordering existing activities
   on open.

Before approving the merge profiles, run the dumper (§2.1) against the
owner's Home Assistant and share the anonymised JSON. The profiles are
keyed on `(domain, platform)`, so the design survives different entity IDs;
the dump confirms the feature bits, the source/app lists and the LG
navigation path.

---

## Appendix A — Canonical command table

Use these names; they are what the wizard, Touch builder and Android app
match.

| Canonical | Aliases the wizard/Touch also accept | Use |
| --- | --- | --- |
| `PowerOn` | — | discrete on |
| `PowerOff` | `poweroff`, `standby`, `off` | discrete off |
| `PowerToggle` | `powertoggle`, `power` | toggle when discrete is unavailable |
| `VolumeUp` / `VolumeDown` | `volup`, `voldown`, `brightnessup`/`down` | step volume |
| `Mute` | `mute` | mute toggle |
| `Play` / `Pause` / `Stop` | — | transport |
| `PlayPause` | — | one-shot toggle |
| `SkipForward` / `SkipBack` | `fastforward`, `rewind`, `next track`, `previous track` | transport |
| `DirectionUp` / `Down` / `Left` / `Right` | `up`, `down`, `left`, `right` | D-pad |
| `Select` | `ok`, `enter` | OK |
| `Back` | `return`, `previous` | Back |
| `Home` | via the `Menu` key when `Menu` is absent | Home (after `Menu` in command order) |
| `Menu` | `menu`, `home` | Menu |
| `Guide` | `epg` | Guide |
| `Info` | `information`, `settings`, `options` | Info |
| `Exit` | `clear`, `cancel` | Exit |
| `ChannelUp` / `ChannelDown` | `chup`, `chdown`, `pageup`, `pagedown` | channel |
| `0`–`9` | `digit0`, `number0`, `num0` | digits |
| `Dash` | `hyphen`, `separator`, `dot`, `period`, `minus` | dash |
| `Record` | `rec` | record |
| `Red` / `Green` / `Yellow` / `Blue` | — | colour keys |
| `Input <source>` | — | input selection |
| `App <name>` | — | app launch (not an input) |
| `Open` / `Close` | — | cover |
| `Run` / `Activate` / `Press` | — | script/scene/button |
| `BrightnessUp` / `BrightnessDown` | — | light step |
| `SpeedUp` / `SpeedDown` | — | fan step |

Do not emit integration vocabulary (`DPAD_CENTER`, `ENTER`, `KEYCODE_*`,
`turn_on`) as a command name. The value carries the integration action; the
name is canonical.

---

## Appendix B — HA core citations

All from `home-assistant/core` tag `2026.11.0`:

- `homeassistant/components/remote/const.py` — features, attributes,
  defaults.
- `homeassistant/components/remote/entity.py` — `RemoteEntity`,
  `state_attributes`, `async_send_command`.
- `homeassistant/components/remote/services.py` — service schemas.
- `homeassistant/components/harmony/remote.py` — built-in Harmony remote
  behaviour.
- `homeassistant/components/harmony/data.py` — device/activity resolution
  and `send_command` parameter handling.
- `homeassistant/components/webostv/media_player.py` — webOS features,
  sources, power/volume/transport.
- `homeassistant/components/webostv/services.py` — `webostv.button`,
  `webostv.command`.
- `homeassistant/components/androidtv_remote/remote.py` — Android TV key
  codes, `send_command`, `turn_on`/`turn_off`.
- `homeassistant/components/androidtv_remote/media_player.py` — Android TV
  media player features and app/volume state.
- `homeassistant/components/androidtv/remote.py` — ADB key names.
- `homeassistant/helpers/selector.py` — `DeviceSelector`,
  `EntitySelector`.
- `homeassistant/helpers/entity_registry.py` —
  `async_entries_for_device`.
- `homeassistant/helpers/device_registry.py` — `DeviceEntry`.

The `aiowebostv` button names are from
`home-assistant-libs/aiowebostv/aiowebostv/buttons.py`.

---

## Appendix C — Dumper output example

```json
{
  "generated_at": "2026-11-07T22:00:00+00:00",
  "ha_version": "2026.11.0",
  "anonymised": true,
  "devices": [{
    "id": "device-id 1",
    "name": "Device 1",
    "manufacturer": "LG",
    "model": "OLED55C9",
    "entities": [{
      "entity_id": "media_player.entity_1",
      "domain": "media_player",
      "platform": "webostv",
      "supported_features": 12345,
      "state": "on",
      "attributes": {
        "source_list": ["HDMI 1", "HDMI 2", "Live TV", "Netflix"],
        "volume_level": 0.3,
        "is_volume_muted": false
      }
    }]
  }]
}
```

The real dump is the input to the profile review; this example only shows
the shape.

---

## Appendix D — Glossary

- **HA device:** a device-registry entry; the unit the owner picks.
- **Entity:** an HA entity; the unit that supplies commands/state.
- **Merged device:** one Harmony device built from N entities of one HA
  device.
- **Key:** the stable `{d}` value for a merged device; normally the primary
  entity ID.
- **Alias:** the `<alias>` prefix in `<alias>:<action>`; normally the entity
  ID, or a short `e<8hex>` when the value would exceed 96 chars.
- **Profile:** the pure mapping from `(domain, platform, features,
  attributes)` to commands/power/inputs.
- **Retained device:** an old v1 device kept because an activity/button
  still references it.
- **Absorbed device:** an old v1 device merged into a new merged device and
  removed because nothing references it.
