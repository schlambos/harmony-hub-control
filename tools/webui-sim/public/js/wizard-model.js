/* Wizard graph builder: turns the guided-setup draft into genuine Harmony
   activity resources (Activity, ActivityButtonMap, ActivityFunctionMap) and
   saves the whole graph through /api/activity-save.
   Shapes mirror the vendored editor (payload/web/activity-ui.js) and the
   genuine Logitech fixture — same floors, same __type names, same fields.

   Ownership rule: the wizard may only create/replace the 16414Activity<ID>
   map for the activity being saved, plus the hard buttons of its Harmony
   Touch map (16417Activity<ID>) and of a Companion's (1642xActivity<ID>; see
   mirrorHardButtons). The Touch's
   on-screen buttons, number pad, gestures and sequences belong to the Touch
   editor. Every other ButtonMap (second surfaces, conditional 16420 keyboard
   HID maps, root/device maps, other activities) is preserved byte-for-byte.
   The one map it adds beside those: a remote without a screen that has an
   activity map and no <EquadID>Root gets one (see ensureRootMaps).
   When a KeyboardTextEntryActivityRole is present the wizard also ensures
   exactly one 16420Activity<ID> map exists, matching the advanced editor's
   reconcile/validate contract. */

import * as api from "./api.js";
import {
  BUTTON_KEY_BY_LABEL,
  REMOTE_BUTTONS,
  matchCommand,
} from "./remote-layout.js";

/* Clone a JSON-representable Harmony resource tree.
   Prefers native structuredClone (resolved at call time so tests can remove
   it). Falls back to JSON round-trip only when no clone function is available.
   Native clone errors propagate — never silently switch to JSON.
   Optional second arg injects a clone implementation for unit tests. */
export function cloneJsonResource(value, cloneImpl = globalThis.structuredClone) {
  if (typeof cloneImpl === "function") {
    return cloneImpl(value);
  }
  return JSON.parse(JSON.stringify(value));
}

/* Highest identities Logitech ever issued for this hub; local allocation
   starts above them so it can never reuse a cloud-issued value. */
const MAP_ID_FLOOR = 52944089;
const BUTTON_ID_FLOOR = 1878029713;
const ID_CEILING = 2147483000;
const IDENTITY_KEYS = new Set(["Id", "Id-", "ButtonId", "ButtonMapId", "ButtonMapId-"]);

/* HID keys the firmware's 16420 keyboard map understands — mirrored from
   payload/web/activity-ui.js composeKeyboardHidMap / hidButtonKey. */
const HID_DIRECT_COMMANDS = new Set([
  "Back", "DirectionDown", "DirectionLeft", "DirectionRight", "DirectionUp",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
  "FastForward", "Info", "Menu", "Pause", "Play", "Rewind", "Stop",
  "VolumeDown", "VolumeUp",
]);

export const ACTIVITY_TYPES = [
  { value: 1, label: "Watch TV" },
  { value: 2, label: "Watch a movie" },
  { value: 3, label: "Play a game" },
  { value: 4, label: "Listen to music" },
];

export const ROLE_TYPES = [
  { type: "DisplayActivityRole", label: "Shows the picture", hint: "TV or projector — usually switches to an HDMI input" },
  { type: "VolumeActivityRole", label: "Controls the volume", hint: "Receiver, soundbar, or TV speakers" },
  { type: "PlayMovieActivityRole", label: "Plays movies & shows", hint: "Streamer, Blu-ray player, or media box" },
  { type: "PlayGameActivityRole", label: "Plays games", hint: "Console or gaming PC" },
  { type: "PlayMediaActivityRole", label: "Plays music & media", hint: "Music streamer or media player" },
  { type: "ChannelChangingActivityRole", label: "Changes channels", hint: "Cable box, tuner, or set-top box" },
  { type: "KeyboardTextEntryActivityRole", label: "Keyboard / typing", hint: "Device you type searches and logins into" },
];

/* An activity selects a device's input by its exact InputName, so offer the
   device's input names; a device without inputs set up offers none. */
export function inputOptions(device) {
  return (Array.isArray(device?.inputs) ? device.inputs : []).map((name) => ({ value: name }));
}

export function roleLabel(type) {
  return ROLE_TYPES.find((r) => r.type === type)?.label ?? type;
}

/* Power-on priority (§6.3): ROLE_TYPES is already in power-on order — display
   first so it can accept input changes, then volume, players, channel/keyboard. */
export const ROLE_RANK = new Map(ROLE_TYPES.map((r, i) => [r.type, i]));

/* Default wait before the next device turns on, for a device first assigned
   in a new activity (§6.3). A draft value of ""/null means "never set". */
export function defaultPowerDelay(roleType) {
  if (roleType === "DisplayActivityRole") return 2500;
  if (roleType === "VolumeActivityRole") return 1500;
  return 1000;
}

/* ---- Button defaults (step 3 arrival state) -----------------------------
   Mirrors activity-ui preferredButtonDeviceId role routing, then resolves
   each remote key against real device commands via remote-layout aliases.
   Draft-only `source` tags distinguish defaults from user/existing mappings;
   they are never written into the saved graph. */

export const BUTTON_SOURCE = {
  default: "default",
  user: "user",
  existing: "existing",
};

/* Draft mappings for the keys an existing activity's wizard-owned map already
   has. The wizard edits press and hold only; a double-press action has no
   wizard control, so it rides along untouched instead of being lost on save. */
export function draftButtonsFromMap(map) {
  const buttons = {};
  for (const b of map?.Buttons ?? []) {
    if (!b.ButtonKey || !b.ButtonAction?.CommandName) continue;
    buttons[b.ButtonKey] = {
      deviceId: String(b.ButtonAction["DeviceId-"]),
      command: { name: b.ButtonAction.CommandName, functionId: b.ButtonAction["FunctionId-"] },
      hold: b.ButtonLongPressAction?.CommandName
        ? {
            deviceId: String(b.ButtonLongPressAction["DeviceId-"]),
            command: { name: b.ButtonLongPressAction.CommandName, functionId: b.ButtonLongPressAction["FunctionId-"] },
          }
        : null,
      doublePress: b.ButtonDoublePressAction ?? null,
      /* Existing activity mappings are locked against default overwrite. */
      source: BUTTON_SOURCE.existing,
    };
  }
  return buttons;
}

function roleDeviceId(roles, roleType) {
  const role = (roles ?? []).find(
    (r) => r?.deviceId && String(r.roleType ?? "").includes(roleType),
  );
  return role ? String(role.deviceId) : "";
}

/** Same priority chain as activity-ui.js preferredButtonDeviceId. */
export function preferredDeviceForButtonKey(buttonKey, roles) {
  const identity = String(buttonKey ?? "").toLowerCase();
  if (!identity) return "";
  if (/^(volumeup|volumedown|volumemute|mute)$/.test(identity)) {
    return roleDeviceId(roles, "VolumeActivityRole");
  }
  if (/^(channelup|channeldown|number[0-9]|[0-9])$/.test(identity)) {
    const channel = roleDeviceId(roles, "ChannelChangingActivityRole");
    if (channel) return channel;
  }
  return (
    roleDeviceId(roles, "PlayGameActivityRole") ||
    roleDeviceId(roles, "PlayMovieActivityRole") ||
    roleDeviceId(roles, "PlayMediaActivityRole") ||
    roleDeviceId(roles, "ChannelChangingActivityRole") ||
    roleDeviceId(roles, "KeyboardTextEntryActivityRole") ||
    roleDeviceId(roles, "DisplayActivityRole") ||
    ""
  );
}

function deviceIndex(devices) {
  const map = new Map();
  for (const d of devices ?? []) {
    if (d?.id != null) map.set(String(d.id), d);
  }
  return map;
}

/**
 * Pure derivation: every assignable wizard key → mapping when the preferred
 * role device actually has a matching command. Unresolvable keys stay out.
 */
export function deriveDefaultButtons(roles, devices) {
  const byId = deviceIndex(devices);
  const out = {};
  for (const button of REMOTE_BUTTONS) {
    const buttonKey = BUTTON_KEY_BY_LABEL[button.label];
    if (!buttonKey) continue;
    const deviceId = preferredDeviceForButtonKey(buttonKey, roles);
    if (!deviceId) continue;
    const device = byId.get(deviceId);
    if (!device) continue;
    const command = matchCommand(device.commands, button.aliases);
    if (!command?.name) continue;
    out[buttonKey] = {
      deviceId,
      command: {
        name: command.name,
        functionId: command.functionId ?? command["FunctionId-"] ?? 0,
      },
      hold: null,
      source: BUTTON_SOURCE.default,
    };
  }
  return out;
}

function mappingPointsAtRoleDevice(mapping, roleDeviceIds) {
  return roleDeviceIds.has(String(mapping?.deviceId ?? ""));
}

/**
 * Reconcile draft.buttons after role/device changes or when entering step 3.
 * Hardware rules (P06 #7 / P13, proven S2/S3/S4/S5/S6/S8):
 * - Non-member "Extra controls" are kept (any device in DeviceList works on
 *   hard keys, even when not a role member). They are flagged `extra: true`
 *   so the UI can badge them ("Extra control · not powered by activity").
 * - Mappings whose device vanished from the hub are dropped.
 * - Never overwrites source=user or source=existing.
 * - Fills empty keys (and refreshes source=default) from deriveDefaultButtons
 *   only when `fillDefaults` is true. The wizard passes false when opening an
 *   existing activity, so unmapped keys stay unmapped until the owner picks
 *   Reset or a per-key default (P06 #7).
 */
export function reconcileWizardButtons(buttons, roles, devices, options) {
  const fillDefaults = options?.fillDefaults ?? true;
  const roleDeviceIds = new Set(
    (roles ?? []).map((r) => String(r?.deviceId ?? "")).filter(Boolean),
  );
  const deviceIds = new Set(
    (devices ?? []).map((d) => String(d?.id ?? "")).filter(Boolean),
  );
  const defaults = fillDefaults ? deriveDefaultButtons(roles, devices) : {};
  const next = {};

  for (const [key, mapping] of Object.entries(buttons ?? {})) {
    if (!mapping?.command?.name) continue;
    // Drop mappings whose device is gone from the hub entirely.
    if (deviceIds.size && !deviceIds.has(String(mapping.deviceId))) continue;
    // Drop default entries so they refresh from defaults; keep user/existing
    // even when the device is not a role member (extra controls, P13).
    const source = mapping.source || BUTTON_SOURCE.user;
    if (source === BUTTON_SOURCE.user || source === BUTTON_SOURCE.existing) {
      const extra = !mappingPointsAtRoleDevice(mapping, roleDeviceIds);
      next[key] = { ...mapping, source, extra };
    }
    /* source=default entries are dropped so they refresh from defaults. */
  }

  for (const [key, def] of Object.entries(defaults)) {
    if (next[key]) continue;
    next[key] = def;
  }
  return next;
}

/** Clear non-locked keys and re-derive defaults (reset-all affordance). */
export function resetWizardButtonsToDefaults(buttons, roles, devices) {
  const kept = {};
  for (const [key, mapping] of Object.entries(buttons ?? {})) {
    if (mapping?.source === BUTTON_SOURCE.existing) {
      kept[key] = mapping;
    }
  }
  return reconcileWizardButtons(kept, roles, devices, { fillDefaults: true });
}

/** Revert one key to a fresh default (or remove it if none resolves). */
export function revertWizardButtonToDefault(buttons, buttonKey, roles, devices) {
  const next = { ...(buttons ?? {}) };
  const current = next[buttonKey];
  if (current?.source === BUTTON_SOURCE.existing) return next;
  delete next[buttonKey];
  const defaults = deriveDefaultButtons(roles, devices);
  if (defaults[buttonKey]) next[buttonKey] = defaults[buttonKey];
  return next;
}

export function wizardButtonStats(buttons) {
  const entries = Object.values(buttons ?? {}).filter((m) => m?.command?.name);
  let user = 0;
  let existing = 0;
  let defaults = 0;
  for (const m of entries) {
    if (m.source === BUTTON_SOURCE.user) user += 1;
    else if (m.source === BUTTON_SOURCE.existing) existing += 1;
    else defaults += 1;
  }
  return {
    mapped: entries.length,
    user,
    existing,
    defaults,
    assignable: Object.keys(BUTTON_KEY_BY_LABEL).length,
  };
}

export function mappingSourceLabel(source) {
  if (source === BUTTON_SOURCE.user) return "set by you";
  if (source === BUTTON_SOURCE.existing) return "from this activity";
  return "wizard default";
}

export function createAllocator(config) {
  let nextMap = MAP_ID_FLOOR + 1;
  let nextId = BUTTON_ID_FLOOR + 1;
  const seen = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (IDENTITY_KEYS.has(key)) {
          const n = Number(child);
          if (Number.isFinite(n) && n > 0) {
            seen.add(n);
            if (key.startsWith("ButtonMapId")) nextMap = Math.max(nextMap, n + 1);
            else nextId = Math.max(nextId, n + 1);
          }
        } else {
          walk(child);
        }
      }
    }
  };
  walk(config);
  const take = (isMap) => {
    let cursor = isMap ? nextMap : nextId;
    while (seen.has(cursor) || cursor >= ID_CEILING) cursor += 1;
    seen.add(cursor);
    if (isMap) nextMap = cursor + 1;
    else nextId = cursor + 1;
    return cursor;
  };
  return { mapId: () => take(true), id: () => take(false) };
}

function harmonyDate() {
  return `/Date(${Date.now()}+0000)/`;
}

function commandAction(deviceId, command, eventType) {
  return {
    "DeviceId-": Number(deviceId),
    __type: "ButtonCommandAction",
    "FunctionId-": Number(command.functionId ?? command["FunctionId-"] ?? command.FunctionId ?? command["Id-"] ?? command.Id ?? 0),
    Order: 0,
    CommandName: String(command.name ?? command.Name ?? command.CommandName ?? command.command),
    EventType: eventType,
    Id: 0,
  };
}

function composeRoles(draft, alloc, existingRoles, isNew = false) {
  const orderByDevice = new Map();
  let nextOrder = 1;
  /* New activities power on by role priority (§6.3); an existing activity
     keeps the hub's saved order, which rolesOf loads as draft order. */
  if (isNew) {
    const firstSeen = new Map();
    const rankByDevice = new Map();
    draft.roles.forEach((role, i) => {
      if (!firstSeen.has(role.deviceId)) firstSeen.set(role.deviceId, i);
      const rank = ROLE_RANK.get(role.roleType) ?? 99;
      rankByDevice.set(role.deviceId, Math.min(rankByDevice.get(role.deviceId) ?? 99, rank));
    });
    const ordered = [...firstSeen.keys()].sort(
      (a, b) => rankByDevice.get(a) - rankByDevice.get(b) || firstSeen.get(a) - firstSeen.get(b),
    );
    for (const deviceId of ordered) {
      orderByDevice.set(deviceId, nextOrder);
      nextOrder += 1;
    }
  }
  /* A device's wait is shared by its jobs. On a new activity an unset wait
     (""/null) takes the default of the device's highest-priority job; a value
     the user set — including 0 — is kept. On edit nothing is defaulted. */
  const unsetDelay = (v) => v === "" || v == null;
  const delayByDevice = new Map();
  if (isNew) {
    for (const role of draft.roles) {
      if (!unsetDelay(role.powerDelay) && !delayByDevice.has(role.deviceId)) {
        delayByDevice.set(role.deviceId, Number(role.powerDelay));
      }
    }
    for (const role of draft.roles) {
      if (!delayByDevice.has(role.deviceId)) {
        const types = draft.roles.filter((r) => r.deviceId === role.deviceId).map((r) => r.roleType);
        const best = types.sort((a, b) => (ROLE_RANK.get(a) ?? 99) - (ROLE_RANK.get(b) ?? 99))[0];
        delayByDevice.set(role.deviceId, defaultPowerDelay(best));
      }
    }
  }
  const delayOf = (role) => {
    if (isNew) return delayByDevice.get(role.deviceId) ?? null;
    if (unsetDelay(role.powerDelay)) return null;
    const n = Number(role.powerDelay);
    return Number.isFinite(n) ? n : null;
  };
  // Reuse role and SelectedInput IDs by (device, type, input) so an unchanged
  // save is byte-identical apart from intended fields (P06 #8).
  const existingByKey = new Map();
  for (const r of existingRoles ?? []) {
    const key = `${String(r?.["DeviceId-"])}|${String(r?.__type)}`;
    if (!existingByKey.has(key)) existingByKey.set(key, []);
    existingByKey.get(key).push(r);
  }
  return draft.roles.map((role) => {
    if (!orderByDevice.has(role.deviceId)) {
      orderByDevice.set(role.deviceId, nextOrder);
      nextOrder += 1;
    }
    const order = orderByDevice.get(role.deviceId);
    const key = `${String(role.deviceId)}|${String(role.roleType)}`;
    const candidates = existingByKey.get(key) ?? [];
    // Prefer a candidate with the same input name, else the first unused.
    let reuse = candidates.find((c) => String(c?.SelectedInput?.Name ?? "") === String(role.input ?? ""))
      ?? candidates.shift();
    if (reuse && candidates.includes(reuse)) {
      // Remove the reused entry so a duplicated role gets a fresh ID.
      existingByKey.set(key, candidates.filter((c) => c !== reuse));
    }
    const inputId = role.input
      ? (reuse?.SelectedInput?.["Id-"] && String(reuse.SelectedInput.Name) === String(role.input)
          ? reuse.SelectedInput["Id-"]
          : alloc.id())
      : null;
    return {
      "DeviceId-": Number(role.deviceId),
      SelectedInput: role.input
        ? { ChannelNumber: null, "Id-": inputId, Name: role.input }
        : null,
      PowerOffOrder: order,
      __type: role.roleType,
      PowerOnOrder: order,
      NextDevicePowerOnDelay: delayOf(role),
      "Id-": reuse?.["Id-"] ?? alloc.id(),
    };
  });
}

function blankActivity(alloc) {
  const now = harmonyDate();
  return {
    "AccountId-": 0,
    Alternatives: [],
    BaseImageUri: null,
    DefaultChannel: null,
    DefaultStation: null,
    DefaultStationName: null,
    EnterActions: [],
    Icon: null,
    ImageKey: null,
    IsDefault: false,
    IsMultiZone: false,
    IsTuningDefault: false,
    LeaveActions: [],
    StartScreen: null,
    State: 0,
    SuggestedDisplay: null,
    Zones: [],
    "Id-": alloc.id(),
    Name: "New Activity",
    ActivityDisplayName: "New Activity",
    ActivityOrder: 0,
    ActivityGroup: 1,
    Type: 1,
    DateCreated: now,
    DateModified: now,
    Roles: [],
  };
}

function surfaceTemplate(config) {
  const maps = config?.mapList?.ButtonMaps ?? [];
  const surface = maps.find((m) =>
    m?.__type === "ActivityButtonMap" && /^16414Activity/.test(String(m?.ButtonMapIdentifier ?? "")));
  const fallback = maps.find((m) => m?.__type === "ActivityButtonMap");
  const source = surface ?? fallback ?? {};
  return {
    "ButtonMapSurfaceId-": source["ButtonMapSurfaceId-"] ?? null,
    "RemoteId-": source["RemoteId-"] ?? null,
    "SurfaceId-": source["SurfaceId-"] ?? null,
  };
}

function wizardMapIdentifier(activityId) {
  return `16414Activity${activityId}`;
}

function hidMapIdentifier(activityId) {
  return `16420Activity${activityId}`;
}

export function isWizardOwnedActivityMap(map, activityId) {
  return String(map?.ButtonMapIdentifier ?? "") === wizardMapIdentifier(activityId);
}

export function isKeyboardHidActivityMap(map) {
  return /^16420Activity-?\d+$/.test(String(map?.ButtonMapIdentifier ?? ""));
}

function keyboardDeviceIdsFromRoles(roles) {
  return (Array.isArray(roles) ? roles : [])
    .filter((role) => String(role?.__type ?? "").includes("KeyboardTextEntryActivityRole"))
    .map((role) => role?.["DeviceId-"])
    .filter((id) => id != null && id !== "");
}

function hidButtonKey(commandName) {
  const name = String(commandName ?? "");
  if (/^[0-9]$/.test(name)) return `Number${name}`;
  if (name === "Mute") return "VolumeMute";
  if (name === "Select") return "Enter";
  return HID_DIRECT_COMMANDS.has(name) ? name : "";
}

function deviceEntryFromConfig(config, deviceId) {
  const entries = config?.deviceList?.DevicesWithFeatures ?? [];
  return entries.find((entry) => {
    const device = entry?.Device ?? entry;
    const id = device?.["Id-"] ?? device?.Id ?? device?.id ?? entry?.id;
    return String(id) === String(deviceId);
  }) ?? null;
}

/* Mirror of payload/web/activity-ui.js composeKeyboardHidMap. Builds the
   conditional 16420Activity<ID> Bluetooth HID map the advanced editor's
   validator requires whenever a KeyboardTextEntryActivityRole is present. */
export function composeKeyboardHidMap({ activityId, deviceId, config, sourceMap, alloc }) {
  const entry = deviceEntryFromConfig(config, deviceId);
  if (!entry) return null;
  const device = entry.Device ?? entry;
  const deviceIdValue = Number(device["Id-"] ?? device.Id ?? deviceId);
  const commands = Array.isArray(entry.Commands) ? entry.Commands : [];
  const buttons = [];
  const seen = new Set();
  for (const command of commands) {
    const commandName = String(command?.Name ?? command?.CommandName ?? command?.name ?? "");
    const key = hidButtonKey(commandName);
    if (!key || seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    buttons.push({
      ButtonId: alloc.id(),
      __type: "HardRemoteButton",
      ButtonAction: commandAction(deviceIdValue, command, 1),
      ButtonDoublePressAction: null,
      FunctionGroupType: /^Number[0-9]$/.test(key) ? 2 : 0,
      ButtonState: 1,
      ButtonKey: key,
      ButtonLongPressAction: null,
    });
  }
  const surface = sourceMap ?? surfaceTemplate(config);
  return {
    "ButtonMapId-": alloc.mapId(),
    "ActivityId-": Number(activityId),
    Buttons: buttons,
    "ButtonMapSurfaceId-": surface["ButtonMapSurfaceId-"] ?? surface.ButtonMapSurfaceId ?? null,
    "RemoteId-": surface["RemoteId-"] ?? surface.RemoteId ?? null,
    __type: "ActivityButtonMap",
    ButtonMapIdentifier: hidMapIdentifier(activityId),
    DateModified: harmonyDate(),
    Sequences: [],
    "SurfaceId-": surface["SurfaceId-"] ?? surface.SurfaceId ?? null,
  };
}

function composeButtonMap(draft, activityId, config, alloc, existing) {
  // Reuse ButtonIds by ButtonKey so an unchanged save keeps identities (P06 #8).
  const existingByKey = new Map();
  for (const b of existing?.Buttons ?? []) {
    if (b?.ButtonKey && !existingByKey.has(b.ButtonKey)) existingByKey.set(b.ButtonKey, b);
  }
  const buttons = [];
  for (const [buttonKey, mapping] of Object.entries(draft.buttons ?? {})) {
    if (!mapping?.command) continue;
    buttons.push({
      ButtonId: existingByKey.get(buttonKey)?.ButtonId ?? alloc.id(),
      __type: "HardRemoteButton",
      ButtonAction: commandAction(mapping.deviceId, mapping.command, 1),
      ButtonDoublePressAction: mapping.doublePress ?? existingByKey.get(buttonKey)?.ButtonDoublePressAction ?? null,
      FunctionGroupType: /^Number\d$/.test(buttonKey) ? 2 : 0,
      ButtonState: 1,
      ButtonKey: buttonKey,
      ButtonLongPressAction: mapping.hold?.command
        ? commandAction(mapping.hold.deviceId, mapping.hold.command, 2)
        : null,
    });
  }

  /* Reuse the existing wizard-owned map shell so unknown per-map fields
     round-trip; only Buttons / DateModified / identity fields are rewritten. */
  const map = existing && typeof existing === "object"
    ? existing
    : {
        "ButtonMapId-": alloc.mapId(),
        ...surfaceTemplate(config),
        __type: "ActivityButtonMap",
        Sequences: [],
      };

  if (!Number.isFinite(Number(map["ButtonMapId-"])) || Number(map["ButtonMapId-"]) <= 0) {
    map["ButtonMapId-"] = alloc.mapId();
  }
  const surf = surfaceTemplate(config);
  for (const key of ["ButtonMapSurfaceId-", "RemoteId-", "SurfaceId-"]) {
    if (map[key] == null && surf[key] != null) map[key] = surf[key];
  }
  map["ActivityId-"] = Number(activityId);
  map.Buttons = buttons;
  map.__type = "ActivityButtonMap";
  map.ButtonMapIdentifier = wizardMapIdentifier(activityId);
  map.DateModified = harmonyDate();
  if (!Array.isArray(map.Sequences)) map.Sequences = [];
  return map;
}

function composeFunctionMap(activityId) {
  return {
    UIModeName: `Functions.UserConfigurator.${activityId}`,
    __type: "ActivityFunctionMap",
    "ActivityId-": Number(activityId),
    FunctionGroups: [],
  };
}

function isActivityFunctionMap(map, activityId) {
  return String(map?.__type ?? "").includes("ActivityFunctionMap")
    && String(map?.["ActivityId-"]) === String(activityId);
}

/* Surface key used by the advanced editor for remote-surface totality.
   HID maps use a virtual key and are excluded from surface templates. */
function activityMapSurfaceKey(map) {
  if (!map || typeof map !== "object") return "";
  if (isKeyboardHidActivityMap(map)) return "virtual|16420|ActivityButtonMap";
  const surface = map["SurfaceId-"] ?? map.SurfaceId;
  const buttonSurface = map["ButtonMapSurfaceId-"] ?? map.ButtonMapSurfaceId;
  if (surface == null && buttonSurface == null) return "";
  return [
    map["RemoteId-"] ?? map.RemoteId,
    surface,
    buttonSurface,
    map.__type,
  ].map((v) => String(v ?? "")).join("|");
}

function rewriteIdentifierForActivity(identifier, activityId) {
  const text = String(identifier ?? "");
  if (/Activity-?\d+$/.test(text)) {
    return text.replace(/Activity-?\d+$/, `Activity${activityId}`);
  }
  return text || `Activity${activityId}`;
}

/* Clone a non-HID activity surface template for a new/missing surface.
   Empty Buttons (no action-less entries) so the paired remote stays safe;
   the advanced editor can route actions later without a repair warning for
   missing surfaces. Mirrors activity-ui cloneMapForActivity(keepActions=false)
   after prune. */
function cloneEmptySurfaceMap(template, activityId, alloc) {
  const map = cloneJsonResource(template);
  delete map.ButtonMapId;
  delete map["Id-"];
  delete map.Id;
  map["ButtonMapId-"] = alloc.mapId();
  map["ActivityId-"] = Number(activityId);
  map.ButtonMapIdentifier = rewriteIdentifierForActivity(map.ButtonMapIdentifier, activityId);
  map.Buttons = [];
  map.Sequences = [];
  if (Object.prototype.hasOwnProperty.call(map, "DateModified")) {
    map.DateModified = harmonyDate();
  }
  map.__type = map.__type || "ActivityButtonMap";
  return map;
}

/* Hub-wide non-HID activity surfaces that every activity must carry (editor
   surface-totality rule). HID / root / device maps are not templates. */
function collectSurfaceTemplates(buttonMaps) {
  const templates = new Map();
  for (const map of buttonMaps) {
    const activityId = map?.["ActivityId-"];
    if (activityId == null || String(activityId) === "-1") continue;
    if (isKeyboardHidActivityMap(map)) continue;
    if (!String(map?.__type ?? "").includes("ActivityButtonMap")) continue;
    const key = activityMapSurfaceKey(map);
    if (!key) continue;
    if (!templates.has(key)) templates.set(key, map);
  }
  return templates;
}

/* Merge the wizard-owned 16414 map (and optional 16420 HID map) into the
   existing ButtonMaps list without touching anything the wizard does not own.
   Also fills any hub-wide remote surfaces the activity is missing so the
   advanced editor's surface-totality check needs zero repairs. */
function mergeActivityButtonMaps({
  buttonMaps,
  activityId,
  wizardMap,
  keyboardDeviceIds,
  config,
  alloc,
}) {
  const needsHid = keyboardDeviceIds.length > 0;
  let existingHid = null;
  let wizardPlaced = false;
  let hidPlaced = false;
  const result = [];

  for (const map of buttonMaps) {
    if (String(map?.["ActivityId-"]) !== String(activityId)) {
      result.push(map);
      continue;
    }
    if (isWizardOwnedActivityMap(map, activityId)) {
      if (!wizardPlaced) {
        result.push(wizardMap);
        wizardPlaced = true;
      }
      continue;
    }
    if (isKeyboardHidActivityMap(map)) {
      if (needsHid && !hidPlaced) {
        existingHid = map;
        result.push(map);
        hidPlaced = true;
      }
      /* Drop stale HID maps when the keyboard role is gone (editor rule). */
      continue;
    }
    /* Second-surface / unknown activity maps — preserve untouched. */
    result.push(map);
  }

  if (!wizardPlaced) result.push(wizardMap);

  /* Surface totality: every activity needs one map per hub remote surface. */
  const templates = collectSurfaceTemplates(buttonMaps);
  /* Prefer the just-built wizard map as the 16414 template for this activity. */
  const wizardKey = activityMapSurfaceKey(wizardMap);
  if (wizardKey) templates.set(wizardKey, wizardMap);

  const presentKeys = new Set(
    result
      .filter((m) => String(m?.["ActivityId-"]) === String(activityId) && !isKeyboardHidActivityMap(m))
      .map(activityMapSurfaceKey)
      .filter(Boolean),
  );
  for (const [key, template] of templates) {
    if (presentKeys.has(key)) continue;
    if (isKeyboardHidActivityMap(template)) continue;
    if (isWizardOwnedActivityMap(template, template["ActivityId-"]) ||
        /^16414Activity/.test(String(template?.ButtonMapIdentifier ?? ""))) {
      /* Never duplicate the wizard-owned surface via a second 16414 clone. */
      if (wizardKey && key === wizardKey) continue;
    }
    const cloned = cloneEmptySurfaceMap(template, activityId, alloc);
    result.push(cloned);
    presentKeys.add(key);
  }

  if (needsHid && !hidPlaced) {
    const created = composeKeyboardHidMap({
      activityId,
      deviceId: keyboardDeviceIds[0],
      config,
      sourceMap: wizardMap,
      alloc,
    });
    if (created) result.push(created);
  }

  return { buttonMaps: result, preservedHid: existingHid };
}

/* The Harmony Touch's hard keys, as Logitech's own 16417Activity maps name
   them. The Touch has no hard number keys (its number pad is on screen) and
   spells the 16414 surface's "Dvr" as "DVR". */
const TOUCH_HARD_KEYS = new Set([
  "Blue", "ChannelDown", "ChannelUp", "DVR", "DirectionDown", "DirectionLeft",
  "DirectionRight", "DirectionUp", "Exit", "FastForward", "Green", "Guide",
  "Info", "Menu", "Pause", "Play", "PrevChannel", "Record", "Red", "Rewind",
  "Select", "Stop", "VolumeDown", "VolumeMute", "VolumeUp", "Yellow",
]);

/** The Touch's name for a wizard key, or "" when the Touch has no such key. */
export function touchHardKey(buttonKey) {
  const key = buttonKey === "Dvr" ? "DVR" : String(buttonKey ?? "");
  return TOUCH_HARD_KEYS.has(key) ? key : "";
}

export function isTouchActivityMap(map, activityId) {
  return String(map?.ButtonMapIdentifier ?? "") === `16417Activity${activityId}`;
}

function actionShape(action) {
  if (!action) return null;
  return [action.__type, String(action["DeviceId-"] ?? ""), action.CommandName ?? null, action["ActivityId-"] ?? null];
}

export function sameButton(left, right) {
  if (!left || !right) return !left && !right;
  return ["ButtonAction", "ButtonLongPressAction", "ButtonDoublePressAction"].every(
    (field) => JSON.stringify(actionShape(left[field])) === JSON.stringify(actionShape(right[field])),
  );
}

/* Remotes without a screen besides the Smart Control: the Companion's two
   EquadIDs. hal names their keys from the same table as the Smart Control's,
   so they take the wizard's 16414 keys as they are, number keys included. */
export const COMPANION_REMOTES = Object.freeze(["16422", "16423"]);
const SMART_CONTROL_REMOTE = "16414";

/* A wizard key's name on remote `prefix`, or "" when that remote has no such key. */
function keyNameOn(prefix, buttonKey) {
  return prefix === "16417" ? touchHardKey(buttonKey) : String(buttonKey ?? "");
}

function hardButtonsByKey(map, prefix) {
  const out = new Map();
  for (const button of map?.Buttons ?? []) {
    if (button?.__type !== "HardRemoteButton") continue;
    const key = keyNameOn(prefix, button.ButtonKey);
    if (key && !out.has(key)) out.set(key, button);
  }
  return out;
}

/* Each remote answers its hard buttons from its own <EquadID>Activity map,
   never the 16414 one; Logitech's maps carry the same hard buttons on all
   of them. A remote's map with no hard buttons (an empty one the wizard
   made for a new activity, or one made by Melodious) gets every one the
   wizard map has. A map that already has some keeps them, and only the keys
   this edit changed are copied over, so a mapping set for one remote in
   MyHarmony survives. Buttons that aren't hard buttons are untouched.
   `prefix` is the remote's EquadID: 16417 (screen remotes; no number keys,
   DVR spelled "DVR") or a Companion's. */
export function mirrorHardButtons({ buttonMaps, activityId, wizardMap, previousWizardMap, alloc, prefix }) {
  const target = buttonMaps.find((m) => String(m?.ButtonMapIdentifier ?? "") === `${prefix}Activity${activityId}`);
  if (!target) return;
  const next = hardButtonsByKey(wizardMap, prefix);
  const before = hardButtonsByKey(previousWizardMap, prefix);
  const current = hardButtonsByKey(target, prefix);
  const mirrorAll = current.size === 0;
  const result = new Map(); // key -> button, or null to drop it
  for (const key of new Set([...next.keys(), ...current.keys()])) {
    const wanted = next.get(key);
    if (!mirrorAll && sameButton(wanted, before.get(key))) continue;
    if (!wanted) {
      result.set(key, null);
      continue;
    }
    if (current.has(key) && sameButton(wanted, current.get(key))) continue;
    const copy = cloneJsonResource(wanted);
    copy.ButtonId = current.get(key)?.ButtonId ?? alloc.id();
    // Screen remotes have no number pad among their hard keys; the others keep the wizard's group.
    if (prefix === "16417") copy.FunctionGroupType = 0;
    copy.ButtonKey = key;
    result.set(key, copy);
  }
  if (result.size === 0) return;
  // Changed buttons keep their place; new ones go after the rest.
  const buttons = [];
  for (const button of target.Buttons ?? []) {
    const key = button?.__type === "HardRemoteButton" ? keyNameOn(prefix, button.ButtonKey) : "";
    if (!key || !result.has(key)) {
      buttons.push(button);
      continue;
    }
    if (result.get(key)) buttons.push(result.get(key));
    result.delete(key);
  }
  for (const button of result.values()) {
    if (button) buttons.push(button);
  }
  target.Buttons = buttons;
  target.DateModified = harmonyDate();
}

/** The screen remote's copy of the wizard's hard keys (16417Activity). */
export function mirrorTouchHardButtons(args) {
  mirrorHardButtons({ ...args, prefix: "16417" });
}

/* The Touch's number-pad slots, as Logitech's own activity maps lay the pad
   out: 1-9 at slots 0-8 and 0 at slot 10, each in the pad's own group
   (FunctionGroupType 2). The Touch has no hard digit keys. */
const TOUCH_PAD_SLOTS = [
  ["Number1", "1", 0], ["Number2", "2", 1], ["Number3", "3", 2],
  ["Number4", "4", 3], ["Number5", "5", 4], ["Number6", "6", 5],
  ["Number7", "7", 6], ["Number8", "8", 7], ["Number9", "9", 8],
  ["Number0", "0", 10],
];

/* One on-screen button in Logitech's key order, mirroring the Touch editor's
   newButton (touch-model.js). */
function touchSoftButton({ group, slot, label, deviceId, command, activityId, buttonId }) {
  return {
    FunctionGroupType: group,
    ButtonImageKey: null,
    "ImageId-": 0,
    MenuItem: { IndexInMenu: slot, MenuName: `Activity.${activityId}` },
    ButtonId: buttonId,
    ButtonState: 1,
    ButtonAction: commandAction(deviceId, command, 0),
    TextOnRemote: label,
    __type: "SoftRemoteButton",
    ButtonImagePath: null,
    ButtonDoublePressAction: null,
    ButtonLongPressAction: null,
  };
}

/* A brand-new activity's on-screen buttons on the Touch, seeded from the
   wizard's own mapping the way Logitech's setup did: the number pad (from
   the wizard's Number0-9) and the first member command the wizard's keys
   have no key for (Home). Existing activities are never reseeded; what an
   owner edited, or left empty, stays. */
function seedTouchOnScreenButtons({ buttonMaps, activityId, draft, config, alloc }) {
  const targets = buttonMaps.filter((m) => String(m?.ButtonMapIdentifier ?? "") === `16417Activity${activityId}`);
  for (const target of targets) {
    seedOneTouchScreen({ target, activityId, draft, config, alloc });
  }
}

function seedOneTouchScreen({ target, activityId, draft, config, alloc }) {
  if (!target || !Array.isArray(target.Buttons)) return;
  if (target.Buttons.some((b) => b?.__type === "SoftRemoteButton")) return;
  const soft = [];
  for (const [key, label, slot] of TOUCH_PAD_SLOTS) {
    const mapping = draft.buttons?.[key];
    if (!mapping?.command) continue;
    soft.push(touchSoftButton({
      group: 2, slot, label,
      deviceId: mapping.deviceId,
      command: { name: mapping.command.name, functionId: mapping.command.functionId },
      activityId, buttonId: alloc.id(),
    }));
  }
  const roleOrder = draft.roles ?? [];
  const members = [...new Set(
    [
      ...roleOrder.filter((r) => /^Play/.test(String(r?.roleType ?? ""))),
      ...roleOrder,
    ].map((r) => String(r?.deviceId)).filter(Boolean),
  )];
  const entryById = new Map(
    (config?.deviceList?.DevicesWithFeatures ?? [])
      .map((entry) => [String(entry?.Device?.["Id-"] ?? ""), entry]),
  );
  for (const id of members) {
    const home = (entryById.get(id)?.Commands ?? [])
      .find((command) => String(command?.Name ?? "").toLowerCase() === "home");
    if (!home) continue;
    const onHardKey = target.Buttons.some((b) => b?.__type === "HardRemoteButton"
      && String(b.ButtonAction?.["DeviceId-"] ?? "") === id
      && String(b.ButtonAction?.CommandName ?? "").toLowerCase() === "home");
    if (!onHardKey) {
      soft.push(touchSoftButton({
        group: 0, slot: 0, label: "Home",
        deviceId: id, command: { name: home.Name, functionId: home["FunctionId-"] ?? 0 },
        activityId, buttonId: alloc.id(),
      }));
    }
    break;
  }
  if (!soft.length) return;
  target.Buttons.push(...soft);
  target.DateModified = harmonyDate();
}

/* The three activity buttons of a remote without a screen, by the kind of
   activity each is named for. A game, which has no button, takes TV's. */
const ACTIVITY_BUTTON_BY_TYPE = { 1: "WatchTVActivity", 2: "MovieActivity", 4: "MusicActivity" };

/* A remote without a screen answers its activity buttons, and every key
   while nothing runs, from <EquadID>Root; with no such map the engine drops
   those presses, so the remote can't start anything (seen on a fresh hub).
   Logitech's setup made that map; a hub set up here has none until this
   does. So each such remote that has a map for this activity and no root
   map gets one, with this activity on its button. A root map that exists
   is never touched: Settings > Remotes > Activity buttons edits those.
   Screen remotes (16417) have no activity buttons, and Logitech gave them
   no root map. Same shapes as remotes-model's buildActivityButtonsMapList. */
function ensureRootMaps({ buttonMaps, activity, alloc }) {
  const activityId = activity["Id-"];
  for (const remote of [SMART_CONTROL_REMOTE, ...COMPANION_REMOTES]) {
    const rootId = `${remote}Root`;
    if (buttonMaps.some((m) => String(m?.ButtonMapIdentifier ?? "") === rootId)) continue;
    const own = buttonMaps.find((m) => String(m?.ButtonMapIdentifier ?? "") === `${remote}Activity${activityId}`);
    if (!own) continue;
    buttonMaps.push({
      "ButtonMapId-": alloc.mapId(),
      Buttons: [{
        ButtonId: alloc.id(),
        __type: "HardRemoteButton",
        ButtonAction: {
          __type: "ButtonActivityAction",
          "ActivityId-": Number(activityId),
          Order: 0,
          EventType: 1,
          Id: 0,
        },
        ButtonDoublePressAction: null,
        FunctionGroupType: 0,
        ButtonState: 1,
        ButtonKey: ACTIVITY_BUTTON_BY_TYPE[Number(activity.Type)] ?? ACTIVITY_BUTTON_BY_TYPE[1],
        ButtonLongPressAction: null,
      }],
      "ButtonMapSurfaceId-": own["ButtonMapSurfaceId-"] ?? null,
      "RemoteId-": own["RemoteId-"] ?? null,
      "SurfaceId-": own["SurfaceId-"] ?? null,
      __type: "RootButtonMap",
      ButtonMapIdentifier: rootId,
      DateModified: harmonyDate(),
      Sequences: null,
    });
  }
}

/* Pure graph builder used by saveDraft and unit tests. Does not touch the network.
   `remotes`: the EquadIDs of the remotes paired with the hub, when known. */
export function buildActivityGraph({ config, draft, editId, remotes = [] }) {
  const alloc = createAllocator(config);

  const activityList = cloneJsonResource(config?.activityList ?? { Activities: [] });
  if (!Array.isArray(activityList.Activities)) activityList.Activities = [];
  const activities = activityList.Activities;

  const mapList = cloneJsonResource(config?.mapList ?? { ButtonMaps: [] });
  if (!Array.isArray(mapList.ButtonMaps)) mapList.ButtonMaps = [];
  const buttonMaps = mapList.ButtonMaps;

  const functionList = cloneJsonResource(config?.functionList ?? { FunctionMaps: [] });
  if (!Array.isArray(functionList.FunctionMaps)) functionList.FunctionMaps = [];
  const functionMaps = functionList.FunctionMaps;

  let activity;
  if (editId) {
    const index = activities.findIndex((a) => String(a["Id-"]) === String(editId));
    if (index === -1) throw new Error("The activity being edited no longer exists in this config.");
    activity = activities[index];
  } else {
    activity = blankActivity(alloc);
    activity.ActivityOrder = activities.length;
    activities.push(activity);
  }

  /* Mutate the cloned activity in place so unknown top-level activity keys
     round-trip instead of being rebuilt from a fixed template. */
  activity.Name = String(draft.name ?? "").trim();
  activity.ActivityDisplayName = activity.Name;
  activity.Type = Number(draft.type);
  activity.DateModified = harmonyDate();
  const existingRoles = Array.isArray(activity.Roles) ? activity.Roles : [];
  activity.Roles = composeRoles(draft, alloc, existingRoles, !editId);

  const activityId = activity["Id-"];
  const existingWizardMap = buttonMaps.find((m) => isWizardOwnedActivityMap(m, activityId));
  const previousWizardMap = cloneJsonResource(existingWizardMap ?? null);
  const wizardMap = composeButtonMap(draft, activityId, config, alloc, existingWizardMap);
  const keyboardDeviceIds = keyboardDeviceIdsFromRoles(activity.Roles);

  const { buttonMaps: mergedMaps } = mergeActivityButtonMaps({
    buttonMaps,
    activityId,
    wizardMap,
    keyboardDeviceIds,
    config,
    alloc,
  });
  mapList.ButtonMaps = mergedMaps;
  /* The engine drops every press from a remote that has no map for the
     running activity, and the surface copy above misses a Companion's map
     when it shares the Smart Control's surface ids (seen on a hub in #79).
     So each Companion the hub has maps for gets one, modelled on another
     of its activity maps, and the mirror below fills it. A paired Companion
     the hub has no map for yet (a fresh hub) starts from the wizard's map. */
  const paired = new Set((Array.isArray(remotes) ? remotes : []).map(String));
  for (const prefix of COMPANION_REMOTES) {
    const id = `${prefix}Activity${activityId}`;
    if (mergedMaps.some((m) => String(m?.ButtonMapIdentifier ?? "") === id)) continue;
    const sibling = mergedMaps.find((m) => String(m?.ButtonMapIdentifier ?? "").startsWith(`${prefix}Activity`))
      ?? (paired.has(prefix) ? wizardMap : null);
    if (!sibling) continue;
    const made = cloneEmptySurfaceMap(sibling, activityId, alloc);
    made.ButtonMapIdentifier = id;
    mergedMaps.push(made);
  }
  for (const prefix of ["16417", ...COMPANION_REMOTES]) {
    mirrorHardButtons({ buttonMaps: mergedMaps, activityId, wizardMap, previousWizardMap, alloc, prefix });
  }
  if (!editId) {
    seedTouchOnScreenButtons({ buttonMaps: mergedMaps, activityId, draft, config, alloc });
  }
  ensureRootMaps({ buttonMaps: mergedMaps, activity, alloc });

  const existingFunction = functionMaps.find((m) => isActivityFunctionMap(m, activityId));
  if (!existingFunction) {
    functionMaps.push(composeFunctionMap(activityId));
  }
  /* Existing ActivityFunctionMap is left untouched (wizard does not own its groups). */

  return {
    activityId: String(activityId),
    name: activity.Name,
    activityList,
    mapList,
    functionList,
  };
}

/* Build the three replacement resources for the draft and POST them.
   editId: when set, that activity is updated in place and only its wizard-owned
   16414 map is replaced; otherwise a new activity is appended. */
export async function saveDraft({ config, revision, draft, editId, remotes }) {
  const graph = buildActivityGraph({ config, draft, editId, remotes });
  const payload = {
    baseRevision: revision,
    activityList: graph.activityList,
    mapList: graph.mapList,
    functionList: graph.functionList,
  };
  const result = await api.saveActivity(payload);
  return { result, activityId: graph.activityId, name: graph.name };
}

const ACTION_FIELDS = ["ButtonAction", "ButtonLongPressAction", "ButtonDoublePressAction"];

/* The three resources without one activity. The hub refuses a MapList that
   still starts the deleted activity anywhere (a Smart Control activity
   button, say), so those actions become null. A button left with no action
   goes, except in a root map: an action-less button in an activity map
   stops the paired remote, while Logitech's root maps keep empty ones. */
export function deleteActivityResources(config, id) {
  const activityList = cloneJsonResource(config.activityList ?? { Activities: [] });
  activityList.Activities = (activityList.Activities ?? []).filter(
    (a) => String(a["Id-"]) !== String(id));
  const mapList = cloneJsonResource(config.mapList ?? { ButtonMaps: [] });
  mapList.ButtonMaps = (mapList.ButtonMaps ?? []).filter(
    (m) => String(m?.["ActivityId-"]) !== String(id));
  for (const map of mapList.ButtonMaps) {
    if (!Array.isArray(map?.Buttons)) continue;
    const isRoot = String(map.__type ?? "").includes("RootButtonMap");
    let changed = false;
    map.Buttons = map.Buttons.filter((button) => {
      let cleared = false;
      for (const field of ACTION_FIELDS) {
        if (button?.[field] && String(button[field]["ActivityId-"] ?? "") === String(id)) {
          button[field] = null;
          cleared = true;
        }
      }
      if (!cleared) return true;
      changed = true;
      return isRoot || ACTION_FIELDS.some((field) => button[field]);
    });
    if (changed && Object.prototype.hasOwnProperty.call(map, "DateModified")) map.DateModified = harmonyDate();
  }
  const functionList = cloneJsonResource(config.functionList ?? { FunctionMaps: [] });
  functionList.FunctionMaps = (functionList.FunctionMaps ?? []).filter((m) =>
    !(String(m?.__type ?? "").includes("ActivityFunctionMap") && String(m?.["ActivityId-"]) === String(id)));
  return { activityList, mapList, functionList };
}

export async function deleteActivityGraph({ config, revision, id }) {
  const { activityList, mapList, functionList } = deleteActivityResources(config, id);
  const result = await api.saveActivity({
    baseRevision: revision,
    activityList,
    mapList,
    functionList,
  });
  return { result };
}

export async function reorderActivityGraph({ config, revision, id, direction }) {
  const activityList = cloneJsonResource(config.activityList ?? { Activities: [] });
  const activities = activityList.Activities ?? [];
  const ordered = [...activities].sort((a, b) => (a.ActivityOrder ?? 0) - (b.ActivityOrder ?? 0));
  const index = ordered.findIndex((a) => String(a["Id-"]) === String(id));
  const target = index + Number(direction);
  if (index < 0 || target < 0 || target >= ordered.length) return { result: null, moved: false };
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  ordered.forEach((a, i) => { a.ActivityOrder = i; });
  /* Reorder only touches ActivityOrder; maps and functions pass through intact. */
  const result = await api.saveActivity({
    baseRevision: revision,
    activityList,
    mapList: cloneJsonResource(config.mapList ?? { ButtonMaps: [] }),
    functionList: cloneJsonResource(config.functionList ?? { FunctionMaps: [] }),
  });
  return { result, moved: true };
}
