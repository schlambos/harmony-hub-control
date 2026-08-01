/* Wizard graph builder: turns the guided-setup draft into genuine Harmony
   activity resources (Activity, ActivityButtonMap, ActivityFunctionMap) and
   saves the whole graph through /api/activity-save.
   Shapes mirror the vendored editor (payload/web/activity-ui.js) and the
   genuine Logitech fixture — same floors, same __type names, same fields.

   Ownership rule: the wizard may only create/replace the 16414Activity<ID>
   map for the activity being saved. Every other ButtonMap (second surfaces,
   conditional 16420 keyboard HID maps, root/device maps, other activities)
   is preserved byte-for-byte. When a KeyboardTextEntryActivityRole is present
   the wizard also ensures exactly one 16420Activity<ID> map exists, matching
   the advanced editor's reconcile/validate contract. */

import * as api from "./api.js";

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

export function roleLabel(type) {
  return ROLE_TYPES.find((r) => r.type === type)?.label ?? type;
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

function composeRoles(draft, alloc) {
  const orderByDevice = new Map();
  let nextOrder = 1;
  return draft.roles.map((role) => {
    if (!orderByDevice.has(role.deviceId)) {
      orderByDevice.set(role.deviceId, nextOrder);
      nextOrder += 1;
    }
    const order = orderByDevice.get(role.deviceId);
    return {
      "DeviceId-": Number(role.deviceId),
      SelectedInput: role.input
        ? { ChannelNumber: null, "Id-": alloc.id(), Name: role.input }
        : null,
      PowerOffOrder: order,
      __type: role.roleType,
      PowerOnOrder: order,
      NextDevicePowerOnDelay: role.powerDelay ? Number(role.powerDelay) : null,
      "Id-": alloc.id(),
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
  const buttons = [];
  for (const [buttonKey, mapping] of Object.entries(draft.buttons ?? {})) {
    if (!mapping?.command) continue;
    buttons.push({
      ButtonId: alloc.id(),
      __type: "HardRemoteButton",
      ButtonAction: commandAction(mapping.deviceId, mapping.command, 1),
      ButtonDoublePressAction: null,
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
  const map = structuredClone(template);
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

/* Pure graph builder used by saveDraft and unit tests. Does not touch the network. */
export function buildActivityGraph({ config, draft, editId }) {
  const alloc = createAllocator(config);

  const activityList = structuredClone(config?.activityList ?? { Activities: [] });
  if (!Array.isArray(activityList.Activities)) activityList.Activities = [];
  const activities = activityList.Activities;

  const mapList = structuredClone(config?.mapList ?? { ButtonMaps: [] });
  if (!Array.isArray(mapList.ButtonMaps)) mapList.ButtonMaps = [];
  const buttonMaps = mapList.ButtonMaps;

  const functionList = structuredClone(config?.functionList ?? { FunctionMaps: [] });
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
  activity.Roles = composeRoles(draft, alloc);

  const activityId = activity["Id-"];
  const existingWizardMap = buttonMaps.find((m) => isWizardOwnedActivityMap(m, activityId));
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
export async function saveDraft({ config, revision, draft, editId }) {
  const graph = buildActivityGraph({ config, draft, editId });
  const payload = {
    baseRevision: revision,
    activityList: graph.activityList,
    mapList: graph.mapList,
    functionList: graph.functionList,
  };
  const result = await api.saveActivity(payload);
  return { result, activityId: graph.activityId, name: graph.name };
}

export async function deleteActivityGraph({ config, revision, id }) {
  const activityList = structuredClone(config.activityList ?? { Activities: [] });
  activityList.Activities = (activityList.Activities ?? []).filter(
    (a) => String(a["Id-"]) !== String(id));
  const mapList = structuredClone(config.mapList ?? { ButtonMaps: [] });
  mapList.ButtonMaps = (mapList.ButtonMaps ?? []).filter(
    (m) => String(m?.["ActivityId-"]) !== String(id));
  const functionList = structuredClone(config.functionList ?? { FunctionMaps: [] });
  functionList.FunctionMaps = (functionList.FunctionMaps ?? []).filter((m) =>
    !(String(m?.__type ?? "").includes("ActivityFunctionMap") && String(m?.["ActivityId-"]) === String(id)));
  const result = await api.saveActivity({
    baseRevision: revision,
    activityList,
    mapList,
    functionList,
  });
  return { result };
}

export async function reorderActivityGraph({ config, revision, id, direction }) {
  const activityList = structuredClone(config.activityList ?? { Activities: [] });
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
    mapList: structuredClone(config.mapList ?? { ButtonMaps: [] }),
    functionList: structuredClone(config.functionList ?? { FunctionMaps: [] }),
  });
  return { result, moved: true };
}
