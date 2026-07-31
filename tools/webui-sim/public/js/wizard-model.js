/* Wizard graph builder: turns the guided-setup draft into genuine Harmony
   activity resources (Activity, ActivityButtonMap, ActivityFunctionMap) and
   saves the whole graph through /api/activity-save.
   Shapes mirror the vendored editor (payload/web/activity-ui.js) and the
   genuine Logitech fixture — same floors, same __type names, same fields. */

import * as api from "./api.js";

/* Highest identities Logitech ever issued for this hub; local allocation
   starts above them so it can never reuse a cloud-issued value. */
const MAP_ID_FLOOR = 52944089;
const BUTTON_ID_FLOOR = 1878029713;
const ID_CEILING = 2147483000;
const IDENTITY_KEYS = new Set(["Id", "Id-", "ButtonId", "ButtonMapId", "ButtonMapId-"]);

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
    "FunctionId-": Number(command.functionId ?? 0),
    Order: 0,
    CommandName: String(command.name ?? command.command),
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

function composeButtonMap(draft, activityId, config, alloc) {
  const buttons = [];
  for (const [buttonKey, mapping] of Object.entries(draft.buttons)) {
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
  return {
    "ButtonMapId-": alloc.mapId(),
    "ActivityId-": Number(activityId),
    Buttons: buttons,
    ...surfaceTemplate(config),
    __type: "ActivityButtonMap",
    ButtonMapIdentifier: `16414Activity${activityId}`,
    DateModified: harmonyDate(),
    Sequences: [],
  };
}

function composeFunctionMap(activityId) {
  return {
    UIModeName: `Functions.UserConfigurator.${activityId}`,
    __type: "ActivityFunctionMap",
    "ActivityId-": Number(activityId),
    FunctionGroups: [],
  };
}

/* Build the three replacement resources for the draft and POST them.
   editId: when set, that activity (and its maps) is replaced in place;
   otherwise a new activity is appended at the end of the order. */
export async function saveDraft({ config, revision, draft, editId }) {
  const alloc = createAllocator(config);

  const activities = structuredClone(config.activityList?.Activities ?? []);
  const buttonMaps = structuredClone(config.mapList?.ButtonMaps ?? []);
  const functionMaps = (config.functionList?.FunctionMaps ?? []).map((m) => structuredClone(m));

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

  activity.Name = draft.name.trim();
  activity.ActivityDisplayName = activity.Name;
  activity.Type = Number(draft.type);
  activity.DateModified = harmonyDate();
  activity.Roles = composeRoles(draft, alloc);

  const activityId = activity["Id-"];
  const map = composeButtonMap(draft, activityId, config, alloc);
  const functionMap = composeFunctionMap(activityId);

  const keptMaps = buttonMaps.filter((m) => String(m?.["ActivityId-"]) !== String(activityId));
  keptMaps.push(map);
  const keptFunctions = functionMaps.filter((m) =>
    !(String(m?.__type ?? "").includes("ActivityFunctionMap") && String(m?.["ActivityId-"]) === String(activityId)));
  keptFunctions.push(functionMap);

  const payload = {
    baseRevision: revision,
    activityList: { Activities: activities },
    mapList: { ButtonMaps: keptMaps },
    functionList: { FunctionMaps: keptFunctions },
  };
  const result = await api.saveActivity(payload);
  return { result, activityId: String(activityId), name: activity.Name };
}

export async function deleteActivityGraph({ config, revision, id }) {
  const activities = (config.activityList?.Activities ?? []).filter(
    (a) => String(a["Id-"]) !== String(id));
  const keptMaps = (config.mapList?.ButtonMaps ?? []).filter(
    (m) => String(m?.["ActivityId-"]) !== String(id));
  const keptFunctions = (config.functionList?.FunctionMaps ?? []).filter((m) =>
    !(String(m?.__type ?? "").includes("ActivityFunctionMap") && String(m?.["ActivityId-"]) === String(id)));
  const result = await api.saveActivity({
    baseRevision: revision,
    activityList: { Activities: activities },
    mapList: { ButtonMaps: keptMaps },
    functionList: { FunctionMaps: keptFunctions },
  });
  return { result };
}

export async function reorderActivityGraph({ config, revision, id, direction }) {
  const activities = structuredClone(config.activityList?.Activities ?? []);
  const ordered = [...activities].sort((a, b) => (a.ActivityOrder ?? 0) - (b.ActivityOrder ?? 0));
  const index = ordered.findIndex((a) => String(a["Id-"]) === String(id));
  const target = index + Number(direction);
  if (index < 0 || target < 0 || target >= ordered.length) return { result: null, moved: false };
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  ordered.forEach((a, i) => { a.ActivityOrder = i; });
  const result = await api.saveActivity({
    baseRevision: revision,
    activityList: { Activities: activities },
    mapList: structuredClone(config.mapList ?? { ButtonMaps: [] }),
    functionList: structuredClone(config.functionList ?? { FunctionMaps: [] }),
  });
  return { result, moved: true };
}
