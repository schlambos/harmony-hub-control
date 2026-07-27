#!/usr/bin/env node

import fs from "node:fs";

const ACTION_FIELDS = [
  "ButtonAction",
  "ButtonLongPressAction",
  "ButtonDoublePressAction"
];

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
      features: Array.isArray(entry.DeviceFeatures) ? entry.DeviceFeatures : []
    }];
  }));
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

function resetIdentity(value) {
  if (Array.isArray(value)) {
    value.forEach(resetIdentity);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "Id" || key === "Id-" || key === "ButtonId" ||
        key === "SequenceId" || key === "SequenceId-") {
      value[key] = 0;
    } else {
      resetIdentity(child);
    }
  }
}

function cloneAllocationMap(source, activityId, roleDeviceIds) {
  const oldActivityId = source["ActivityId-"];
  const map = clone(source);
  replaceActivityStrings(map, oldActivityId, activityId);
  map["ActivityId-"] = idValue(activityId);
  delete map["ButtonMapId-"];
  delete map["Id-"];
  delete map.Id;
  map.ButtonMapId = null;
  map.DateModified = null;
  map.Sequences = null;
  for (const button of map.Buttons || []) {
    button.ButtonId = 0;
    button.ButtonState = 0;
    for (const field of ACTION_FIELDS) {
      const action = button?.[field];
      if (action && !roleDeviceIds.has(idText(action["DeviceId-"]))) {
        button[field] = null;
      } else {
        resetIdentity(action);
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
  const summary = {
    roleReplacements: [],
    inputReplacements: [],
    actionReplacements: [],
    functionActionReplacements: [],
    removedOrphanActivityMaps: [],
    removedDeletedDeviceMaps: [],
    removedOrphanActivityActions: [],
    createdActivityMaps: [],
    removedOrphanActivityFunctionMaps: [],
    removedDeletedDeviceFunctionMaps: [],
    createdActivityFunctionMaps: []
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
    keptMaps.push(map);
  }
  mapList.ButtonMaps = keptMaps;

  for (const map of mapList.ButtonMaps) {
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
    if (!activityId || !activityIds.has(activityId)) continue;
    const key = surfaceKey(map);
    if (!templatesBySurface.has(key)) templatesBySurface.set(key, []);
    templatesBySurface.get(key).push(map);
  }
  for (const activity of activityList.Activities) {
    const activityId = idText(activity["Id-"] ?? activity.Id);
    const existing = new Set(mapList.ButtonMaps
      .filter((map) => idText(map?.["ActivityId-"]) === activityId)
      .map(surfaceKey));
    const roleDeviceIds = new Set((activity.Roles || []).map((role) => idText(role?.["DeviceId-"])).filter(Boolean));
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
      const created = cloneAllocationMap(ranked[0].template, activityId, roleDeviceIds);
      mapList.ButtonMaps.push(created);
      existing.add(key);
      summary.createdActivityMaps.push({
        activity: activity.Name,
        activityId,
        surfaceId: created["SurfaceId-"],
        sourceMapId: ranked[0].template["ButtonMapId-"] ?? ranked[0].template.ButtonMapId,
        buttons: Array.isArray(created.Buttons) ? created.Buttons.length : 0
      });
    }
  }

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
  for (const activity of activityList.Activities) {
    const activityId = idText(activity["Id-"] ?? activity.Id);
    for (const role of activity.Roles || []) {
      if (!devices.has(idText(role?.["DeviceId-"]))) {
        throw new Error(`post-repair stale role device ${role?.["DeviceId-"]}`);
      }
    }
    for (const [key] of templatesBySurface) {
      const count = finalMaps.filter((map) =>
        idText(map?.["ActivityId-"]) === activityId && surfaceKey(map) === key
      ).length;
      if (count !== 1) throw new Error(`post-repair activity ${activityId} has ${count} maps for ${key}`);
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
  createdActivityMaps: summary.createdActivityMaps,
  removedOrphanActivityFunctionMaps: summary.removedOrphanActivityFunctionMaps,
  removedDeletedDeviceFunctionMaps: summary.removedDeletedDeviceFunctionMaps,
  createdActivityFunctionMaps: summary.createdActivityFunctionMaps,
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
