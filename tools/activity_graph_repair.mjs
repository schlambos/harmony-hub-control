#!/usr/bin/env node

import fs from "node:fs";

const ACTION_FIELDS = [
  "ButtonAction",
  "ButtonLongPressAction",
  "ButtonDoublePressAction"
];

// Only these keys own an identity. Every other *Id- key ("DeviceId-",
// "FunctionId-", "ActivityId-", "RemoteId-", "SurfaceId-",
// "ButtonMapSurfaceId-", "ParentDevice-", ...) is a foreign key and must never
// be allocated or rewritten here.
const IDENTITY_KEYS = new Set([
  "Id",
  "Id-",
  "ButtonId",
  "ButtonMapId",
  "ButtonMapId-"
]);
const MAP_IDENTITY_KEYS = new Set(["ButtonMapId", "ButtonMapId-"]);

// Genuine Logitech data keeps button map IDs and button IDs in disjoint bands,
// so each band gets its own cursor seeded past the highest value Logitech ever
// issued. The hub stores identities as signed 32-bit integers.
const LOGITECH_MAX_MAP_ID = 52944089;
const LOGITECH_MAX_BUTTON_ID = 1878029713;
const MIN_OWNED_IDENTITY = 9999999;
const IDENTITY_CEILING = 2147483000;

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error(`Usage:
  node tools/activity_graph_repair.mjs --base-url http://HUB:8080 [options]

Options:
  --replace OLD=NEW              Replace a deleted device ID with a current one.
  --input OLD:FROM=TO            Rename a selected input while replacing OLD.
  --output-map FILE              Write the proposed MapList to FILE (mode 0600).
  --output-functions FILE        Write the proposed FunctionList to FILE (mode 0600).
  --apply                        POST the proposed repair with syncRemote=false.
  --help                         Show this help.

Without --apply the command is read-only and prints the proposed repair.`);
  process.exit(message ? 2 : 0);
}

function parseArgs(argv) {
  const options = {
    baseUrl: "",
    replacements: new Map(),
    inputAliases: new Map(),
    outputMap: "",
    outputFunctions: "",
    apply: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") usage();
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--base-url") {
      options.baseUrl = argv[++index] || "";
      continue;
    }
    if (arg === "--replace") {
      const value = argv[++index] || "";
      const match = value.match(/^(\d+)=(\d+)$/);
      if (!match) usage(`invalid --replace value ${JSON.stringify(value)}`);
      options.replacements.set(match[1], match[2]);
      continue;
    }
    if (arg === "--input") {
      const value = argv[++index] || "";
      const match = value.match(/^(\d+):([^=]+)=(.+)$/);
      if (!match) usage(`invalid --input value ${JSON.stringify(value)}`);
      options.inputAliases.set(`${match[1]}\u0000${match[2].toLowerCase()}`, match[3]);
      continue;
    }
    if (arg === "--output-map") {
      options.outputMap = argv[++index] || "";
      if (!options.outputMap) usage("--output-map requires a path");
      continue;
    }
    if (arg === "--output-functions") {
      options.outputFunctions = argv[++index] || "";
      if (!options.outputFunctions) usage("--output-functions requires a path");
      continue;
    }
    usage(`unknown option ${JSON.stringify(arg)}`);
  }
  if (!options.baseUrl) usage("--base-url is required");
  options.baseUrl = options.baseUrl.replace(/\/+$/, "");
  return options;
}

const options = parseArgs(process.argv.slice(2));
const clone = (value) => JSON.parse(JSON.stringify(value));
const idText = (value) => String(value == null ? "" : value);
const idValue = (value) => (/^\d+$/.test(idText(value)) ? Number(value) : value);

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const raw = await response.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(`${response.status} ${response.statusText}: ${raw.slice(0, 1000)}`);
  }
  if (!response.ok || body.ok === false) {
    throw new Error(`${response.status} ${response.statusText}: ${body.error || body.message || raw}`);
  }
  return body;
}

function devicesFrom(config) {
  const entries = config.deviceList?.DevicesWithFeatures || config.deviceList?.Devices || [];
  return new Map(entries.map((entry) => {
    const raw = entry.Device || entry;
    return [idText(raw["Id-"] ?? raw.Id), {
      id: idText(raw["Id-"] ?? raw.Id),
      name: raw.Name || raw.Label || idText(raw["Id-"] ?? raw.Id),
      commands: Array.isArray(entry.Commands) ? entry.Commands : [],
      features: Array.isArray(entry.DeviceFeatures) ? entry.DeviceFeatures : [],
      transport: Number(raw.Transport),
      keyboardAssociated: raw.IsKeyboardAssociated !== false
    }];
  }));
}

function identityNumber(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isAllocatedIdentity(value) {
  const parsed = identityNumber(value);
  return parsed !== null && parsed > 0 && parsed < IDENTITY_CEILING;
}

// The known pool must span activityList, mapList, functionList and deviceList:
// deviceList alone carries 168 "Id-" values that share the button map band.
function scanIdentities(resources) {
  const known = new Set();
  let maxMapId = 0;
  let maxButtonId = 0;
  let maxOwned = 0;
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (IDENTITY_KEYS.has(key) && isAllocatedIdentity(child)) {
        const identity = Number(child);
        known.add(identity);
        maxOwned = Math.max(maxOwned, identity);
        if (MAP_IDENTITY_KEYS.has(key)) maxMapId = Math.max(maxMapId, identity);
        if (key === "ButtonId") maxButtonId = Math.max(maxButtonId, identity);
      }
      visit(child);
    }
  };
  resources.forEach(visit);
  return { known, maxMapId, maxButtonId, maxOwned };
}

function createIdentityLedger(config) {
  const scan = scanIdentities([
    config.activityList,
    config.mapList,
    config.functionList,
    config.deviceList
  ]);
  const cursors = {
    map: Math.max(LOGITECH_MAX_MAP_ID, scan.maxMapId) + 1,
    button: Math.max(LOGITECH_MAX_BUTTON_ID, scan.maxButtonId) + 1,
    owned: Math.max(MIN_OWNED_IDENTITY, scan.maxOwned) + 1
  };
  const allocate = (band, label) => {
    while (scan.known.has(cursors[band])) cursors[band] += 1;
    const identity = cursors[band];
    if (identity >= IDENTITY_CEILING) {
      throw new Error(
        `${label} identities are exhausted at ${identity}; the hub stores ` +
        `identities below ${IDENTITY_CEILING}`
      );
    }
    scan.known.add(identity);
    cursors[band] = identity + 1;
    return identity;
  };
  return {
    repairs: [],
    firstMapId: cursors.map,
    firstButtonId: cursors.button,
    allocateMapId: () => allocate("map", "button map"),
    allocateButtonId: () => allocate("button", "button"),
    allocateOwnedId: () => allocate("owned", "activity role")
  };
}

function inputNames(device) {
  const names = [];
  const seen = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value.Inputs)) {
      value.Inputs.forEach((input) => {
        const name = String(input?.InputName || input?.Name || "");
        if (name && !seen.has(name.toLowerCase())) {
          seen.add(name.toLowerCase());
          names.push(name);
        }
      });
    }
    Object.values(value).forEach(visit);
  };
  device.features.forEach(visit);
  return names;
}

function actionDeviceIds(map) {
  const ids = new Set();
  for (const button of map.Buttons || []) {
    for (const field of ACTION_FIELDS) {
      const action = button?.[field];
      const deviceId = idText(action?.["DeviceId-"]);
      if (deviceId) ids.add(deviceId);
    }
  }
  return ids;
}

function functionActionDeviceIds(map) {
  const ids = new Set();
  for (const group of map.FunctionGroups || []) {
    for (const action of group.Functions || []) {
      const deviceId = idText(action?.["DeviceId-"]);
      if (deviceId) ids.add(deviceId);
    }
  }
  return ids;
}

function resolveCommand(commands, action) {
  const commandName = String(action?.CommandName || "");
  const functionId = idText(action?.["FunctionId-"] ?? action?.FunctionId);
  const exactNames = commands.filter((command) =>
    String(command?.Name || command?.CommandName || "") === commandName
  );
  if (exactNames.length === 1) return exactNames[0];
  const exactFunction = commands.filter((command) =>
    idText(command?.["FunctionId-"] ?? command?.FunctionId) === functionId
  );
  return exactFunction.length === 1 ? exactFunction[0] : null;
}

function surfaceKey(map) {
  return [
    map?.["RemoteId-"] ?? map?.RemoteId,
    map?.["SurfaceId-"] ?? map?.SurfaceId,
    map?.["ButtonMapSurfaceId-"] ?? map?.ButtonMapSurfaceId,
    map?.__type
  ].map(idText).join("|");
}

function replaceActivityStrings(value, oldActivityId, newActivityId) {
  if (Array.isArray(value)) {
    value.forEach((item) => replaceActivityStrings(item, oldActivityId, newActivityId));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && child.includes(idText(oldActivityId))) {
      value[key] = child.split(idText(oldActivityId)).join(idText(newActivityId));
    } else {
      replaceActivityStrings(child, oldActivityId, newActivityId);
    }
  }
}

// Genuine data keeps ButtonCommandAction/ButtonActivityAction Id at 0 but
// carries a real identity on ButtonClientAction, so only the former is cleared.
function resetActionIdentity(value) {
  if (Array.isArray(value)) {
    value.forEach(resetActionIdentity);
    return;
  }
  if (!value || typeof value !== "object") return;
  const keepsIdentity = String(value.__type || "") === "ButtonClientAction" &&
    isAllocatedIdentity(value.Id);
  for (const [key, child] of Object.entries(value)) {
    if (key === "Id" || key === "Id-") {
      if (!keepsIdentity) value[key] = 0;
    } else {
      resetActionIdentity(child);
    }
  }
}

function activityRoleDeviceIds(activity) {
  return new Set(
    (activity?.Roles || []).map((role) => idText(role?.["DeviceId-"])).filter(Boolean)
  );
}

// The single field contract for every ActivityButtonMap this tool creates or
// touches. It only fills identities that are absent, null or non-positive, so
// a second run over its own output reports no work.
function applyActivityMapContract(map, ledger) {
  const repair = {
    identifier: map.ButtonMapIdentifier ?? null,
    activityId: map["ActivityId-"] ?? null,
    mapId: null,
    allocatedMapId: null,
    migratedMapIdAlias: false,
    allocatedButtonIds: 0,
    buttonStateCorrections: 0,
    normalizedSequences: false
  };
  if (Object.prototype.hasOwnProperty.call(map, "ButtonMapId")) {
    if (!isAllocatedIdentity(map["ButtonMapId-"]) &&
        isAllocatedIdentity(map.ButtonMapId)) {
      map["ButtonMapId-"] = Number(map.ButtonMapId);
      repair.migratedMapIdAlias = true;
    }
    delete map.ButtonMapId;
  }
  if (!isAllocatedIdentity(map["ButtonMapId-"])) {
    map["ButtonMapId-"] = ledger.allocateMapId();
    repair.allocatedMapId = map["ButtonMapId-"];
  }
  repair.mapId = map["ButtonMapId-"];
  for (const button of map.Buttons || []) {
    if (!isAllocatedIdentity(button.ButtonId)) {
      button.ButtonId = ledger.allocateButtonId();
      repair.allocatedButtonIds += 1;
    }
    if (button.ButtonState !== 1) {
      button.ButtonState = 1;
      repair.buttonStateCorrections += 1;
    }
  }
  if (!Array.isArray(map.Sequences)) {
    map.Sequences = [];
    repair.normalizedSequences = true;
  }
  if (repair.allocatedMapId !== null || repair.migratedMapIdAlias ||
      repair.allocatedButtonIds > 0 || repair.buttonStateCorrections > 0 ||
      repair.normalizedSequences) {
    ledger.repairs.push(repair);
  }
  return repair;
}

function cloneAllocationMap(source, activity, ledger) {
  const activityId = idText(activity["Id-"] ?? activity.Id);
  const roleDeviceIds = activityRoleDeviceIds(activity);
  const oldActivityId = source["ActivityId-"];
  const map = clone(source);
  replaceActivityStrings(map, oldActivityId, activityId);
  map["ActivityId-"] = idValue(activityId);
  delete map["Id-"];
  delete map.Id;
  map.DateModified = null;
  // The clone inherits the template's identities; those belong to the
  // template, so each one is reallocated from the offline cursors instead of
  // being cleared and left for a cloud allocator that never runs.
  map["ButtonMapId-"] = ledger.allocateMapId();
  delete map.ButtonMapId;
  map.Sequences = [];
  for (const button of map.Buttons || []) {
    button.ButtonId = ledger.allocateButtonId();
    button.ButtonState = 1;
    for (const field of ACTION_FIELDS) {
      const action = button?.[field];
      if (action && !roleDeviceIds.has(idText(action["DeviceId-"]))) {
        button[field] = null;
      } else {
        resetActionIdentity(action);
      }
    }
  }
  return map;
}

function cloneFunctionMap(source, activityId) {
  const oldActivityId = source["ActivityId-"];
  const map = clone(source);
  map["ActivityId-"] = idValue(activityId);
  map.__type = "ActivityFunctionMap";
  if (typeof map.UIModeName === "string") {
    map.UIModeName = map.UIModeName
      .split(idText(oldActivityId))
      .join(idText(activityId));
  } else {
    map.UIModeName = `Functions.UserConfigurator.${activityId}`;
  }
  return map;
}

function normalizeActivityMapIdentifiers(map, activityId) {
  const id = idText(activityId);
  let changes = 0;
  if (!id) return changes;
  if (typeof map?.ButtonMapIdentifier === "string" &&
      /Activity-?\d+$/.test(map.ButtonMapIdentifier)) {
    const expected = map.ButtonMapIdentifier.replace(
      /Activity-?\d+$/,
      `Activity${id}`
    );
    if (expected !== map.ButtonMapIdentifier) {
      map.ButtonMapIdentifier = expected;
      changes += 1;
    }
  }
  for (const button of map?.Buttons || []) {
    const menuName = button?.MenuItem?.MenuName;
    if (typeof menuName !== "string" || !/^Activity\.-?\d+$/.test(menuName)) {
      continue;
    }
    const expected = `Activity.${id}`;
    if (menuName !== expected) {
      button.MenuItem.MenuName = expected;
      changes += 1;
    }
  }
  return changes;
}

function isKeyboardHidActivityMap(map) {
  return /^16420Activity-?\d+$/.test(String(map?.ButtonMapIdentifier || ""));
}

function buttonIdentity(button) {
  return String(
    button?.ButtonKey ||
    button?.TextOnRemote ||
    button?.ButtonName ||
    button?.ButtonLabel ||
    ""
  ).toLowerCase();
}

function sameRemoteSurface(left, right) {
  if (!left || !right) return false;
  return idText(left["RemoteId-"] ?? left.RemoteId) ===
      idText(right["RemoteId-"] ?? right.RemoteId) &&
    idText(left["SurfaceId-"] ?? left.SurfaceId) ===
      idText(right["SurfaceId-"] ?? right.SurfaceId) &&
    idText(left["ButtonMapSurfaceId-"] ?? left.ButtonMapSurfaceId) ===
      idText(right["ButtonMapSurfaceId-"] ?? right.ButtonMapSurfaceId);
}

function roleDeviceId(activity, roleType) {
  const role = (activity?.Roles || []).find((item) =>
    String(item?.__type || "").includes(roleType)
  );
  return idText(role?.["DeviceId-"]);
}

function preferredButtonDeviceId(activity, identity) {
  if (/^(volumeup|volumedown|volumemute|mute)$/.test(identity)) {
    return roleDeviceId(activity, "VolumeActivityRole");
  }
  if (/^(channelup|channeldown|number[0-9]|[0-9])$/.test(identity)) {
    const channelDevice = roleDeviceId(activity, "ChannelChangingActivityRole");
    if (channelDevice) return channelDevice;
  }
  return roleDeviceId(activity, "PlayGameActivityRole") ||
    roleDeviceId(activity, "PlayMovieActivityRole") ||
    roleDeviceId(activity, "PlayMediaActivityRole") ||
    roleDeviceId(activity, "ChannelChangingActivityRole") ||
    roleDeviceId(activity, "KeyboardTextEntryActivityRole") ||
    roleDeviceId(activity, "DisplayActivityRole");
}

function findMappedButton(maps, targetMap, targetButton, field) {
  const identity = buttonIdentity(targetButton);
  if (!identity) return null;
  const ranked = maps.slice().sort((left, right) =>
    Number(sameRemoteSurface(right, targetMap)) -
    Number(sameRemoteSurface(left, targetMap))
  );
  for (const map of ranked) {
    const match = (map?.Buttons || []).find((button) =>
      buttonIdentity(button) === identity &&
      button?.[field] &&
      typeof button[field] === "object"
    );
    if (match) return match[field];
  }
  return null;
}

function backfillActivityButtonMaps(mapList, activity) {
  const activityId = idText(activity?.["Id-"] ?? activity?.Id);
  const maps = mapList.ButtonMaps.filter((map) =>
    idText(map?.["ActivityId-"]) === activityId &&
    !isKeyboardHidActivityMap(map)
  );
  let changes = 0;
  for (const map of maps) {
    let mapChanges = 0;
    for (const button of map.Buttons || []) {
      const identity = buttonIdentity(button);
      if (!identity) continue;
      const siblingMaps = maps.filter((candidate) => candidate !== map);
      const deviceId = preferredButtonDeviceId(activity, identity);
      const deviceMaps = deviceId
        ? mapList.ButtonMaps.filter((candidate) =>
            String(candidate?.__type || "").includes("DeviceButtonMap") &&
            idText(candidate?.["DeviceId-"]) === deviceId
          )
        : [];
      for (const field of ACTION_FIELDS) {
        if (button?.[field] && typeof button[field] === "object") continue;
        const action =
          findMappedButton(siblingMaps, map, button, field) ||
          findMappedButton(deviceMaps, map, button, field);
        if (!action) continue;
        button[field] = clone(action);
        resetActionIdentity(button[field]);
        changes += 1;
        mapChanges += 1;
      }
    }
    if (mapChanges > 0 && Object.prototype.hasOwnProperty.call(map, "DateModified")) {
      map.DateModified = `/Date(${Date.now()}+0000)/`;
    }
  }
  return changes;
}

const HID_DIRECT_COMMANDS = new Set([
  "Back", "DirectionDown", "DirectionLeft", "DirectionRight", "DirectionUp",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
  "FastForward", "Info", "Menu", "Pause", "Play", "Rewind", "Stop",
  "VolumeDown", "VolumeUp"
]);

function hidButtonKey(commandName) {
  const name = String(commandName || "");
  if (/^[0-9]$/.test(name)) return `Number${name}`;
  if (name === "Mute") return "VolumeMute";
  if (name === "Select") return "Enter";
  return HID_DIRECT_COMMANDS.has(name) ? name : "";
}

function keyboardHidTemplate(mapList, activityId) {
  return mapList.ButtonMaps.find((map) =>
    idText(map?.["ActivityId-"]) === activityId &&
    !isKeyboardHidActivityMap(map) &&
    /^16414Activity/.test(String(map?.ButtonMapIdentifier || ""))
  ) || mapList.ButtonMaps.find((map) =>
    idText(map?.["ActivityId-"]) === activityId &&
    !isKeyboardHidActivityMap(map)
  ) || null;
}

function composeKeyboardHidMap(source, device, ledger) {
  const activityId = idText(source["ActivityId-"]);
  const seen = new Set();
  const buttons = [];
  for (const command of device.commands || []) {
    const commandName = String(command?.Name || command?.CommandName || "");
    const key = hidButtonKey(commandName);
    if (!key || seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    buttons.push({
      ButtonId: ledger.allocateButtonId(),
      __type: "HardRemoteButton",
      ButtonAction: {
        "DeviceId-": idValue(device.id),
        __type: "ButtonCommandAction",
        "FunctionId-": command["FunctionId-"] ?? command.FunctionId ??
          command["Id-"] ?? command.Id ?? 0,
        Order: 0,
        CommandName: commandName,
        EventType: 1,
        Id: 0
      },
      ButtonDoublePressAction: null,
      FunctionGroupType: /^Number[0-9]$/.test(key) ? 2 : 0,
      ButtonState: 1,
      ButtonKey: key,
      ButtonLongPressAction: null
    });
  }
  return {
    "ButtonMapId-": ledger.allocateMapId(),
    "ActivityId-": idValue(activityId),
    Buttons: buttons,
    "ButtonMapSurfaceId-": source["ButtonMapSurfaceId-"] ?? source.ButtonMapSurfaceId,
    "RemoteId-": source["RemoteId-"] ?? source.RemoteId,
    __type: "ActivityButtonMap",
    ButtonMapIdentifier: `16420Activity${activityId}`,
    DateModified: `/Date(${Date.now()}+0000)/`,
    Sequences: [],
    "SurfaceId-": source["SurfaceId-"] ?? source.SurfaceId
  };
}

// Repairs maps the tool already persisted: the live hub holds ActivityButtonMaps
// with no map ID and buttons stuck at ButtonId 0 / ButtonState 0, which is why
// the paired remote stops transmitting once an activity starts.
function repairPersistedActivityMaps(mapList, ledger) {
  for (const map of mapList.ButtonMaps) {
    if (!String(map?.__type || "").includes("ActivityButtonMap")) continue;
    applyActivityMapContract(map, ledger);
  }
}

// Guards the exact defect this tool once wrote to the hub: an activity map
// without a map ID, or a button left at ButtonId 0 / ButtonState 0.
function assertActivityMapIdentities(maps) {
  const owners = new Map();
  for (const map of maps) {
    const identifier = idText(map?.ButtonMapIdentifier);
    const isActivityMap = String(map?.__type || "").includes("ActivityButtonMap");
    if (isActivityMap && !isAllocatedIdentity(map["ButtonMapId-"])) {
      throw new Error(`post-repair activity map ${identifier} has no ButtonMapId-`);
    }
    for (const button of map.Buttons || []) {
      const buttonKey = idText(button?.ButtonKey);
      if (isActivityMap && !isAllocatedIdentity(button?.ButtonId)) {
        throw new Error(
          `post-repair activity map ${identifier} button ${buttonKey} has no ButtonId`
        );
      }
      if (isActivityMap && button?.ButtonState !== 1) {
        throw new Error(
          `post-repair activity map ${identifier} button ${buttonKey} has ` +
          `ButtonState ${idText(button?.ButtonState)}`
        );
      }
      const buttonId = identityNumber(button?.ButtonId);
      if (buttonId === null || buttonId <= 0) continue;
      if (owners.has(buttonId)) {
        throw new Error(
          `post-repair ButtonId ${buttonId} is shared by ` +
          `${owners.get(buttonId)} and ${identifier}`
        );
      }
      owners.set(buttonId, identifier);
    }
  }
}

function identityTotals(repairs) {
  return repairs.reduce((totals, repair) => ({
    allocatedMapIds: totals.allocatedMapIds + (repair.allocatedMapId === null ? 0 : 1),
    migratedMapIdAliases: totals.migratedMapIdAliases + (repair.migratedMapIdAlias ? 1 : 0),
    allocatedButtonIds: totals.allocatedButtonIds + repair.allocatedButtonIds,
    buttonStateCorrections:
      totals.buttonStateCorrections + repair.buttonStateCorrections,
    normalizedSequences:
      totals.normalizedSequences + (repair.normalizedSequences ? 1 : 0)
  }), {
    allocatedMapIds: 0,
    migratedMapIdAliases: 0,
    allocatedButtonIds: 0,
    buttonStateCorrections: 0,
    normalizedSequences: 0
  });
}

function repairGraph(config) {
  const next = clone(config);
  const devices = devicesFrom(next);
  const activityList = next.activityList;
  const mapList = next.mapList;
  const functionList = next.functionList;
  if (!Array.isArray(activityList?.Activities) ||
      !Array.isArray(mapList?.ButtonMaps) ||
      !Array.isArray(functionList?.FunctionMaps)) {
    throw new Error(
      "activityList.Activities, mapList.ButtonMaps, and functionList.FunctionMaps must be arrays"
    );
  }
  const activityIds = new Set(activityList.Activities.map((activity) =>
    idText(activity["Id-"] ?? activity.Id)
  ));
  const ledger = createIdentityLedger(next);
  const summary = {
    roleReplacements: [],
    inputReplacements: [],
    actionReplacements: [],
    functionActionReplacements: [],
    removedOrphanActivityMaps: [],
    removedDeletedDeviceMaps: [],
    removedOrphanActivityActions: [],
    repairedActivityMenuIdentifiers: [],
    createdBluetoothKeyboardRoles: [],
    createdActivityMaps: [],
    routedButtonActionCount: 0,
    createdKeyboardHidMaps: [],
    removedKeyboardHidMaps: [],
    removedOrphanActivityFunctionMaps: [],
    removedDeletedDeviceFunctionMaps: [],
    createdActivityFunctionMaps: [],
    identityRepairs: ledger.repairs
  };
  const problems = [];

  for (const activity of activityList.Activities) {
    for (const role of activity.Roles || []) {
      const oldId = idText(role?.["DeviceId-"]);
      if (!oldId || devices.has(oldId)) continue;
      const newId = options.replacements.get(oldId);
      if (!newId || !devices.has(newId)) {
        problems.push(`Activity ${activity.Name} role ${role.__type} references deleted device ${oldId}`);
        continue;
      }
      role["DeviceId-"] = idValue(newId);
      summary.roleReplacements.push({
        activity: activity.Name,
        role: role.__type,
        oldDeviceId: oldId,
        newDeviceId: newId,
        newDevice: devices.get(newId).name
      });
      const selected = role.SelectedInput;
      const oldInput = String(selected?.Name || "");
      if (!oldInput) continue;
      const names = inputNames(devices.get(newId));
      const exact = names.find((name) => name.toLowerCase() === oldInput.toLowerCase());
      const alias = options.inputAliases.get(`${oldId}\u0000${oldInput.toLowerCase()}`);
      const target = exact || (alias && names.find((name) => name.toLowerCase() === alias.toLowerCase()));
      if (!target) {
        problems.push(
          `Activity ${activity.Name} input ${JSON.stringify(oldInput)} is not available on ${devices.get(newId).name}`
        );
        continue;
      }
      if (target !== oldInput) {
        selected.Name = target;
        summary.inputReplacements.push({
          activity: activity.Name,
          oldDeviceId: oldId,
          oldInput,
          newInput: target
        });
      }
    }
  }

  for (const activity of activityList.Activities) {
    if (!Array.isArray(activity.Roles)) continue;
    const keyboardDevices = new Set(
      activity.Roles
        .filter((role) =>
          String(role?.__type || "").includes("KeyboardTextEntryActivityRole")
        )
        .map((role) => idText(role?.["DeviceId-"]))
        .filter(Boolean)
    );
    const sources = new Map();
    for (const role of activity.Roles) {
      const type = String(role?.__type || "");
      const deviceId = idText(role?.["DeviceId-"]);
      const device = devices.get(deviceId);
      if (!deviceId || type.includes("KeyboardTextEntryActivityRole") ||
          device?.transport !== 32 || !device.keyboardAssociated ||
          sources.has(deviceId)) {
        continue;
      }
      sources.set(deviceId, role);
    }
    for (const [deviceId, source] of sources) {
      if (keyboardDevices.has(deviceId)) continue;
      const role = {
        "DeviceId-": source["DeviceId-"],
        __type: "KeyboardTextEntryActivityRole",
        PowerOffOrder: source.PowerOffOrder ?? 0,
        "Id-": ledger.allocateOwnedId(),
        NextDevicePowerOnDelay: source.NextDevicePowerOnDelay ?? null,
        PowerOnOrder: source.PowerOnOrder ?? 0,
        SelectedInput: null
      };
      activity.Roles.push(role);
      keyboardDevices.add(deviceId);
      activity.DateModified = `/Date(${Date.now()}+0000)/`;
      summary.createdBluetoothKeyboardRoles.push({
        activity: activity.Name,
        activityId: activity["Id-"] ?? activity.Id,
        deviceId,
        roleId: role["Id-"]
      });
    }
  }

  const keyboardDevicesByActivity = new Map(activityList.Activities.map((activity) => [
    idText(activity["Id-"] ?? activity.Id),
    new Set((activity.Roles || [])
      .filter((role) =>
        String(role?.__type || "").includes("KeyboardTextEntryActivityRole")
      )
      .map((role) => idText(role?.["DeviceId-"]))
      .filter(Boolean))
  ]));

  const keptMaps = [];
  for (const map of mapList.ButtonMaps) {
    const activityId = idText(map?.["ActivityId-"]);
    const deviceId = idText(map?.["DeviceId-"]);
    if (activityId && activityId !== "-1" && !activityIds.has(activityId)) {
      summary.removedOrphanActivityMaps.push({
        mapId: map["ButtonMapId-"] ?? map.ButtonMapId,
        activityId,
        surfaceId: map["SurfaceId-"]
      });
      continue;
    }
    if (deviceId && !devices.has(deviceId)) {
      summary.removedDeletedDeviceMaps.push({
        mapId: map["ButtonMapId-"] ?? map.ButtonMapId,
        deviceId,
        surfaceId: map["SurfaceId-"]
      });
      continue;
    }
    if (isKeyboardHidActivityMap(map) &&
        !(keyboardDevicesByActivity.get(activityId)?.size > 0)) {
      summary.removedKeyboardHidMaps.push({
        activityId,
        identifier: map.ButtonMapIdentifier
      });
      continue;
    }
    keptMaps.push(map);
  }
  mapList.ButtonMaps = keptMaps;

  for (const map of mapList.ButtonMaps) {
    const mapActivityId = idText(map?.["ActivityId-"]);
    if (mapActivityId && mapActivityId !== "-1" && activityIds.has(mapActivityId)) {
      const changes = normalizeActivityMapIdentifiers(map, mapActivityId);
      if (changes > 0) {
        summary.repairedActivityMenuIdentifiers.push({
          activityId: mapActivityId,
          mapId: map["ButtonMapId-"] ?? map.ButtonMapId ?? null,
          surfaceId: map["SurfaceId-"] ?? map["ButtonMapSurfaceId-"] ?? null,
          changes
        });
      }
    }
    for (const button of map.Buttons || []) {
      for (const field of ACTION_FIELDS) {
        const action = button?.[field];
        const actionActivityId = idText(action?.["ActivityId-"]);
        if (actionActivityId && actionActivityId !== "-1" &&
            !activityIds.has(actionActivityId)) {
          summary.removedOrphanActivityActions.push({
            mapId: map["ButtonMapId-"] ?? map.ButtonMapId,
            field,
            activityId: actionActivityId
          });
          button[field] = null;
          continue;
        }
        const oldId = idText(action?.["DeviceId-"]);
        if (!oldId || devices.has(oldId)) continue;
        const newId = options.replacements.get(oldId);
        if (!newId || !devices.has(newId)) {
          problems.push(
            `Map ${map["ButtonMapId-"] ?? map.ButtonMapId} ${field} ${action.CommandName} references deleted device ${oldId}`
          );
          continue;
        }
        const commands = devices.get(newId).commands;
        const functionId = idText(action["FunctionId-"] ?? action.FunctionId);
        const command = resolveCommand(commands, action);
        if (!command) {
          problems.push(
            `Map ${map["ButtonMapId-"] ?? map.ButtonMapId} ${field} ${action.CommandName} cannot map function ${functionId} to ${devices.get(newId).name}`
          );
          continue;
        }
        action["DeviceId-"] = idValue(newId);
        action["FunctionId-"] = command["FunctionId-"] ?? command.FunctionId;
        action.CommandName = command.Name || command.CommandName;
        summary.actionReplacements.push({
          mapId: map["ButtonMapId-"] ?? map.ButtonMapId,
          activityId: map["ActivityId-"] ?? null,
          field,
          oldDeviceId: oldId,
          newDeviceId: newId,
          functionId,
          command: action.CommandName
        });
      }
    }
  }

  const templatesBySurface = new Map();
  for (const map of mapList.ButtonMaps) {
    const activityId = idText(map?.["ActivityId-"]);
    if (!activityId || !activityIds.has(activityId) ||
        isKeyboardHidActivityMap(map)) continue;
    const key = surfaceKey(map);
    if (!templatesBySurface.has(key)) templatesBySurface.set(key, []);
    templatesBySurface.get(key).push(map);
  }
  for (const activity of activityList.Activities) {
    const activityId = idText(activity["Id-"] ?? activity.Id);
    const existing = new Set(mapList.ButtonMaps
      .filter((map) =>
        idText(map?.["ActivityId-"]) === activityId &&
        !isKeyboardHidActivityMap(map)
      )
      .map(surfaceKey));
    const roleDeviceIds = activityRoleDeviceIds(activity);
    for (const [key, templates] of templatesBySurface) {
      if (existing.has(key)) continue;
      const ranked = templates.map((template, index) => {
        const used = actionDeviceIds(template);
        const overlap = [...used].filter((id) => roleDeviceIds.has(id)).length;
        const extra = [...used].filter((id) => !roleDeviceIds.has(id)).length;
        return { template, index, score: overlap * 100 - extra * 20 };
      }).sort((a, b) => b.score - a.score || a.index - b.index);
      if (!ranked.length) {
        problems.push(`Activity ${activity.Name} has no template for remote surface ${key}`);
        continue;
      }
      const created = cloneAllocationMap(ranked[0].template, activity, ledger);
      mapList.ButtonMaps.push(created);
      existing.add(key);
      summary.createdActivityMaps.push({
        activity: activity.Name,
        activityId,
        mapId: created["ButtonMapId-"],
        surfaceId: created["SurfaceId-"],
        sourceMapId: ranked[0].template["ButtonMapId-"] ?? ranked[0].template.ButtonMapId,
        buttons: Array.isArray(created.Buttons) ? created.Buttons.length : 0
      });
    }
  }

  for (const activity of activityList.Activities) {
    summary.routedButtonActionCount +=
      backfillActivityButtonMaps(mapList, activity);
  }

  for (const activity of activityList.Activities) {
    const activityId = idText(activity["Id-"] ?? activity.Id);
    const keyboardDevices = keyboardDevicesByActivity.get(activityId) || new Set();
    if (!keyboardDevices.size || mapList.ButtonMaps.some((map) =>
      idText(map?.["ActivityId-"]) === activityId &&
      isKeyboardHidActivityMap(map)
    )) {
      continue;
    }
    const deviceId = [...keyboardDevices][0];
    const device = devices.get(deviceId);
    const template = keyboardHidTemplate(mapList, activityId);
    const map = device && template &&
      composeKeyboardHidMap(template, device, ledger);
    if (!map) {
      problems.push(`Activity ${activity.Name} cannot create its 16420 keyboard HID map`);
      continue;
    }
    mapList.ButtonMaps.push(map);
    summary.createdKeyboardHidMaps.push({
      activity: activity.Name,
      activityId,
      deviceId,
      mapId: map["ButtonMapId-"],
      buttonCount: map.Buttons.length
    });
  }

  repairPersistedActivityMaps(mapList, ledger);

  const keptFunctionMaps = [];
  const seenActivityFunctionMaps = new Set();
  for (const map of functionList.FunctionMaps) {
    const mapType = String(map?.__type || "");
    if (mapType.includes("ActivityFunctionMap")) {
      const activityId = idText(map?.["ActivityId-"]);
      if (!activityIds.has(activityId) || seenActivityFunctionMaps.has(activityId)) {
        summary.removedOrphanActivityFunctionMaps.push({
          activityId,
          uiModeName: map?.UIModeName || null
        });
        continue;
      }
      seenActivityFunctionMaps.add(activityId);
    } else if (mapType.includes("DeviceFunctionMap")) {
      const deviceId = idText(map?.["DeviceId-"]);
      if (!devices.has(deviceId)) {
        summary.removedDeletedDeviceFunctionMaps.push({
          deviceId,
          uiModeName: map?.UIModeName || null
        });
        continue;
      }
    } else {
      problems.push(`FunctionList contains unknown map type ${JSON.stringify(mapType)}`);
      continue;
    }
    keptFunctionMaps.push(map);
  }
  functionList.FunctionMaps = keptFunctionMaps;

  for (const map of functionList.FunctionMaps) {
    for (const group of map.FunctionGroups || []) {
      for (const action of group.Functions || []) {
        const oldId = idText(action?.["DeviceId-"]);
        if (!oldId || devices.has(oldId)) continue;
        const newId = options.replacements.get(oldId);
        if (!newId || !devices.has(newId)) {
          problems.push(
            `Function map ${map.UIModeName || map.__type} ${group.Name}/${action.Name} references deleted device ${oldId}`
          );
          continue;
        }
        const functionId = idText(action["FunctionId-"] ?? action.FunctionId);
        const command = resolveCommand(devices.get(newId).commands, action);
        if (!command) {
          problems.push(
            `Function map ${map.UIModeName || map.__type} ${group.Name}/${action.Name} cannot map function ${functionId} to ${devices.get(newId).name}`
          );
          continue;
        }
        action["DeviceId-"] = idValue(newId);
        action["FunctionId-"] = command["FunctionId-"] ?? command.FunctionId;
        action.CommandName = command.Name || command.CommandName;
        summary.functionActionReplacements.push({
          activityId: map["ActivityId-"] ?? null,
          group: group.Name,
          name: action.Name,
          oldDeviceId: oldId,
          newDeviceId: newId,
          functionId,
          command: action.CommandName
        });
      }
    }
  }

  const activityFunctionTemplates = functionList.FunctionMaps.filter((map) =>
    String(map?.__type || "").includes("ActivityFunctionMap")
  );
  for (const activity of activityList.Activities) {
    const activityId = idText(activity["Id-"] ?? activity.Id);
    if (activityFunctionTemplates.some((map) =>
      idText(map?.["ActivityId-"]) === activityId
    )) continue;
    const roleDeviceIds = new Set(
      (activity.Roles || []).map((role) => idText(role?.["DeviceId-"])).filter(Boolean)
    );
    const ranked = activityFunctionTemplates.map((template, index) => {
      const used = functionActionDeviceIds(template);
      const overlap = [...used].filter((id) => roleDeviceIds.has(id)).length;
      const extra = [...used].filter((id) => !roleDeviceIds.has(id)).length;
      const sourceActivity = activityList.Activities.find((candidate) =>
        idText(candidate?.["Id-"] ?? candidate?.Id) === idText(template?.["ActivityId-"])
      );
      const sameType = sourceActivity &&
        Number(sourceActivity.Type) === Number(activity.Type) &&
        Number(sourceActivity.ActivityGroup) === Number(activity.ActivityGroup);
      return {
        template,
        index,
        score: overlap * 100 - extra * 20 + (sameType ? 40 : 0)
      };
    }).sort((a, b) => b.score - a.score || a.index - b.index);
    let created;
    if (ranked.length) {
      created = cloneFunctionMap(ranked[0].template, activityId);
      created.FunctionGroups = (created.FunctionGroups || []).map((group) => ({
        ...group,
        Functions: (group.Functions || []).filter((action) =>
          roleDeviceIds.has(idText(action?.["DeviceId-"]))
        )
      })).filter((group) => group.Functions.length > 0);
    } else {
      created = {
        UIModeName: `Functions.UserConfigurator.${activityId}`,
        __type: "ActivityFunctionMap",
        "ActivityId-": idValue(activityId),
        FunctionGroups: []
      };
    }
    functionList.FunctionMaps.push(created);
    activityFunctionTemplates.push(created);
    summary.createdActivityFunctionMaps.push({
      activity: activity.Name,
      activityId,
      sourceActivityId: ranked.length
        ? idText(ranked[0].template["ActivityId-"])
        : null,
      groupCount: created.FunctionGroups.length,
      functionCount: created.FunctionGroups.reduce(
        (count, group) => count + group.Functions.length,
        0
      )
    });
  }

  if (problems.length) {
    throw new Error(`repair is incomplete:\n- ${[...new Set(problems)].join("\n- ")}`);
  }

  const finalMaps = mapList.ButtonMaps;
  assertActivityMapIdentities(finalMaps);
  for (const activity of activityList.Activities) {
    const activityId = idText(activity["Id-"] ?? activity.Id);
    const keyboardDevices = new Set(
      (activity.Roles || [])
        .filter((role) =>
          String(role?.__type || "").includes("KeyboardTextEntryActivityRole")
        )
        .map((role) => idText(role?.["DeviceId-"]))
        .filter(Boolean)
    );
    for (const role of activity.Roles || []) {
      const deviceId = idText(role?.["DeviceId-"]);
      if (!devices.has(deviceId)) {
        throw new Error(`post-repair stale role device ${role?.["DeviceId-"]}`);
      }
      if (!String(role?.__type || "").includes("KeyboardTextEntryActivityRole") &&
          devices.get(deviceId)?.transport === 32 &&
          devices.get(deviceId)?.keyboardAssociated &&
          !keyboardDevices.has(deviceId)) {
        throw new Error(
          `post-repair activity ${activityId} Bluetooth device ${deviceId} ` +
          "has no KeyboardTextEntryActivityRole"
        );
      }
    }
    for (const [key] of templatesBySurface) {
      const count = finalMaps.filter((map) =>
        idText(map?.["ActivityId-"]) === activityId &&
        !isKeyboardHidActivityMap(map) &&
        surfaceKey(map) === key
      ).length;
      if (count !== 1) throw new Error(`post-repair activity ${activityId} has ${count} maps for ${key}`);
    }
    const hidCount = finalMaps.filter((map) =>
      idText(map?.["ActivityId-"]) === activityId &&
      isKeyboardHidActivityMap(map)
    ).length;
    if (keyboardDevices.size > 0 && hidCount !== 1) {
      throw new Error(`post-repair activity ${activityId} has ${hidCount} keyboard HID maps`);
    }
    if (keyboardDevices.size === 0 && hidCount !== 0) {
      throw new Error(`post-repair activity ${activityId} has a keyboard HID map without a keyboard role`);
    }
  }
  for (const map of finalMaps) {
    const activityId = idText(map?.["ActivityId-"]);
    const deviceId = idText(map?.["DeviceId-"]);
    if (activityId && activityId !== "-1" && !activityIds.has(activityId)) {
      throw new Error(`post-repair orphan activity map ${activityId}`);
    }
    if (deviceId && !devices.has(deviceId)) {
      throw new Error(`post-repair deleted device map ${deviceId}`);
    }
    for (const actionDeviceId of actionDeviceIds(map)) {
      if (!devices.has(actionDeviceId)) {
        throw new Error(`post-repair stale map action device ${actionDeviceId}`);
      }
    }
    for (const button of map.Buttons || []) {
      const menuName = button?.MenuItem?.MenuName;
      const menuActivityId = typeof menuName === "string"
        ? menuName.match(/^Activity\.(-?\d+)$/)?.[1]
        : "";
      if (activityId && activityId !== "-1" && menuActivityId &&
          menuActivityId !== activityId) {
        throw new Error(
          `post-repair map ${map["ButtonMapId-"] ?? map.ButtonMapId} menu ` +
          `identifies activity ${menuActivityId} instead of ${activityId}`
        );
      }
      for (const field of ACTION_FIELDS) {
        const actionActivityId = idText(button?.[field]?.["ActivityId-"]);
        if (actionActivityId && actionActivityId !== "-1" &&
            !activityIds.has(actionActivityId)) {
          throw new Error(`post-repair stale map action activity ${actionActivityId}`);
        }
      }
    }
  }
  for (const activityId of activityIds) {
    const count = functionList.FunctionMaps.filter((map) =>
      String(map?.__type || "").includes("ActivityFunctionMap") &&
      idText(map?.["ActivityId-"]) === activityId
    ).length;
    if (count !== 1) {
      throw new Error(`post-repair activity ${activityId} has ${count} function maps`);
    }
  }
  for (const map of functionList.FunctionMaps) {
    const mapType = String(map?.__type || "");
    if (mapType.includes("ActivityFunctionMap")) {
      if (!activityIds.has(idText(map?.["ActivityId-"]))) {
        throw new Error(`post-repair orphan activity function map ${map?.["ActivityId-"]}`);
      }
    } else if (mapType.includes("DeviceFunctionMap")) {
      if (!devices.has(idText(map?.["DeviceId-"]))) {
        throw new Error(`post-repair stale device function map ${map?.["DeviceId-"]}`);
      }
    }
    for (const actionDeviceId of functionActionDeviceIds(map)) {
      if (!devices.has(actionDeviceId)) {
        throw new Error(`post-repair stale function action device ${actionDeviceId}`);
      }
    }
  }
  return { next, summary };
}

const current = await fetchJson(`${options.baseUrl}/api/activity-config`);
const { next, summary } = repairGraph(current);
const identities = identityTotals(summary.identityRepairs);
const condensed = {
  revision: current.revision,
  roleReplacements: summary.roleReplacements,
  inputReplacements: summary.inputReplacements,
  actionReplacementCount: summary.actionReplacements.length,
  actionReplacementsByDevice: Object.values(summary.actionReplacements.reduce((groups, item) => {
    const key = `${item.oldDeviceId}->${item.newDeviceId}`;
    groups[key] ||= { replacement: key, count: 0 };
    groups[key].count += 1;
    return groups;
  }, {})),
  functionActionReplacementCount: summary.functionActionReplacements.length,
  functionActionReplacementsByDevice: Object.values(
    summary.functionActionReplacements.reduce((groups, item) => {
      const key = `${item.oldDeviceId}->${item.newDeviceId}`;
      groups[key] ||= { replacement: key, count: 0 };
      groups[key].count += 1;
      return groups;
    }, {})
  ),
  removedOrphanActivityMaps: summary.removedOrphanActivityMaps,
  removedDeletedDeviceMaps: summary.removedDeletedDeviceMaps,
  removedOrphanActivityActions: summary.removedOrphanActivityActions,
  repairedActivityMenuIdentifiers: summary.repairedActivityMenuIdentifiers,
  createdBluetoothKeyboardRoles: summary.createdBluetoothKeyboardRoles,
  createdActivityMaps: summary.createdActivityMaps,
  routedButtonActionCount: summary.routedButtonActionCount,
  createdKeyboardHidMaps: summary.createdKeyboardHidMaps,
  removedKeyboardHidMaps: summary.removedKeyboardHidMaps,
  removedOrphanActivityFunctionMaps: summary.removedOrphanActivityFunctionMaps,
  removedDeletedDeviceFunctionMaps: summary.removedDeletedDeviceFunctionMaps,
  createdActivityFunctionMaps: summary.createdActivityFunctionMaps,
  allocatedMapIdCount: identities.allocatedMapIds,
  allocatedButtonIdCount: identities.allocatedButtonIds,
  buttonStateCorrectionCount: identities.buttonStateCorrections,
  migratedMapIdAliasCount: identities.migratedMapIdAliases,
  normalizedSequenceCount: identities.normalizedSequences,
  identityRepairs: summary.identityRepairs,
  resultingMapCount: next.mapList.ButtonMaps.length,
  resultingFunctionMapCount: next.functionList.FunctionMaps.length
};
console.log(JSON.stringify(condensed, null, 2));

if (options.outputMap) {
  fs.writeFileSync(options.outputMap, `${JSON.stringify(next.mapList)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  console.log(`\nProposed MapList written to ${options.outputMap}.`);
}

if (options.outputFunctions) {
  fs.writeFileSync(
    options.outputFunctions,
    `${JSON.stringify(next.functionList)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  console.log(`\nProposed FunctionList written to ${options.outputFunctions}.`);
}

if (!options.apply) {
  console.log("\nDry run only; no Hub resources were changed.");
  process.exit(0);
}

const result = await fetchJson(`${options.baseUrl}/api/activity-save`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    baseRevision: current.revision,
    syncRemote: false,
    activityList: next.activityList,
    mapList: next.mapList,
    functionList: next.functionList
  })
});
console.log("\nHarmony response:");
console.log(JSON.stringify(result, null, 2));
