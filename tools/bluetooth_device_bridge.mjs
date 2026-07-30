#!/usr/bin/env node

import fs from "node:fs";

function fail(message) {
  console.error(`bluetooth_device_bridge: ${message}`);
  process.exit(1);
}

function usage() {
  console.error(
    "Usage: bluetooth_device_bridge.mjs --input BUNDLE --output BUNDLE " +
    "--device-id ID --template-device-id ID --address AA:BB:CC:DD:EE:FF " +
    "[--name NAME] [--mode clone|reuse-template]"
  );
  process.exit(2);
}

function argumentsFrom(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--") || index + 1 >= argv.length) usage();
    out[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return out;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function idText(value) {
  return String(value == null ? "" : value);
}

function numericId(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${label} must be a positive integer`);
  }
  return parsed;
}

function bundleFile(bundle, name) {
  const value = bundle?.files?.[name] ?? bundle?.[name];
  if (typeof value !== "string" || !value.trim()) {
    fail(`input bundle is missing ${name}`);
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`${name} is not valid JSON: ${error.message}`);
  }
}

function setBundleFile(bundle, name, value) {
  const encoded = JSON.stringify(value);
  if (bundle?.files && Object.prototype.hasOwnProperty.call(bundle.files, name)) {
    bundle.files[name] = encoded;
  } else {
    bundle[name] = encoded;
  }
}

function deviceEntries(deviceList) {
  const entries = deviceList?.DevicesWithFeatures ?? deviceList?.Devices;
  if (!Array.isArray(entries)) fail("DeviceList has no DevicesWithFeatures array");
  return entries;
}

function deviceObject(entry) {
  return entry?.Device ?? entry;
}

function maxValue(root, key, initial = 0) {
  let maximum = initial;
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [name, child] of Object.entries(value)) {
      if (name === key && Number.isSafeInteger(Number(child))) {
        maximum = Math.max(maximum, Number(child));
      }
      visit(child);
    }
  };
  visit(root);
  return maximum;
}

function replaceDeviceReferences(value, oldId, newId) {
  if (Array.isArray(value)) {
    value.forEach((child) => replaceDeviceReferences(child, oldId, newId));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "DeviceId-" && idText(child) === idText(oldId)) {
      value[key] = newId;
    } else {
      replaceDeviceReferences(child, oldId, newId);
    }
  }
}

function replaceDeviceMenuReferences(value, oldId, newId) {
  if (Array.isArray(value)) {
    value.forEach((child) => replaceDeviceMenuReferences(child, oldId, newId));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") {
      value[key] = child
        .split(`Device.${oldId}`).join(`Device.${newId}`)
        .split(`Device${oldId}`).join(`Device${newId}`);
    } else {
      replaceDeviceMenuReferences(child, oldId, newId);
    }
  }
}

function reallocateFeatureIds(features, firstId) {
  let nextId = firstId;
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "Id" && Number.isSafeInteger(Number(child)) && Number(child) > 0) {
        value[key] = nextId;
        nextId += 1;
      } else {
        visit(child);
      }
    }
  };
  visit(features);
  return nextId;
}

function commandNames(entry) {
  return new Set(
    (Array.isArray(entry?.Commands) ? entry.Commands : [])
      .map((command) => String(command?.Name ?? ""))
      .filter(Boolean)
  );
}

const options = argumentsFrom(process.argv.slice(2));
if (!options.input || !options.output || !options["device-id"] ||
    !options["template-device-id"] || !options.address) {
  usage();
}
if (!/^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/i.test(options.address)) {
  fail("address must use AA:BB:CC:DD:EE:FF notation");
}

const targetId = numericId(options["device-id"], "device-id");
const templateId = numericId(options["template-device-id"], "template-device-id");
if (targetId === templateId) fail("device-id and template-device-id must differ");
const mode = options.mode || "clone";
if (!["clone", "reuse-template"].includes(mode)) {
  fail("mode must be clone or reuse-template");
}

let bundle;
try {
  bundle = JSON.parse(fs.readFileSync(options.input, "utf8"));
} catch (error) {
  fail(`could not read input bundle: ${error.message}`);
}

const deviceList = bundleFile(bundle, "DeviceList.json");
const functionList = bundleFile(bundle, "FunctionList.json");
const protocolList = bundleFile(bundle, "ProtocolList.json");
const mapList = bundleFile(bundle, "MapList.json");
const activityList = bundleFile(bundle, "ActivityList.json");
const entries = deviceEntries(deviceList);
const targetEntry = entries.find((entry) =>
  idText(deviceObject(entry)?.["Id-"] ?? deviceObject(entry)?.Id) === idText(targetId)
);
const templateEntry = entries.find((entry) =>
  idText(deviceObject(entry)?.["Id-"] ?? deviceObject(entry)?.Id) === idText(templateId)
);
if (!targetEntry) fail(`target device ${targetId} was not found`);
if (!templateEntry) fail(`template device ${templateId} was not found`);
if (!Array.isArray(templateEntry.Commands) || !templateEntry.Commands.length) {
  fail(`template device ${templateId} has no commands`);
}

const targetDevice = deviceObject(targetEntry);
const templateDevice = deviceObject(templateEntry);
const identity = {
  name: options.name || targetDevice.Name || `Bluetooth device ${targetId}`,
  manufacturer: targetDevice.Manufacturer || "Local",
  model: targetDevice.Model || "Bluetooth HID",
  parentManufacturer: targetDevice.ParentDeviceManufacturer ||
    targetDevice.Manufacturer || "Local",
  parentModel: targetDevice.ParentDeviceModel || targetDevice.Model || "Bluetooth HID",
  dateAdded: targetDevice.DeviceAddedDate
};

if (mode === "reuse-template") {
  if (!Array.isArray(activityList?.Activities)) {
    fail("ActivityList has no Activities array");
  }
  if (!Array.isArray(functionList?.FunctionMaps)) {
    fail("FunctionList has no FunctionMaps array");
  }
  if (!Array.isArray(mapList?.ButtonMaps)) {
    fail("MapList has no ButtonMaps array");
  }

  const reusableFunctionMap = functionList.FunctionMaps.find((map) =>
    String(map?.__type ?? "").includes("DeviceFunctionMap") &&
    idText(map?.["DeviceId-"]) === idText(templateId)
  );
  if (!reusableFunctionMap) {
    fail(`template device ${templateId} has no reusable DeviceFunctionMap`);
  }
  const reusableButtonMap = mapList.ButtonMaps.find((map) =>
    String(map?.__type ?? "").includes("DeviceButtonMap") &&
    idText(map?.["DeviceId-"]) === idText(templateId)
  );
  if (!reusableButtonMap) {
    fail(`template device ${templateId} has no reusable DeviceButtonMap`);
  }
  functionList.FunctionMaps = functionList.FunctionMaps.filter((map) =>
    !(String(map?.__type ?? "").includes("DeviceFunctionMap") &&
      idText(map?.["DeviceId-"]) === idText(targetId))
  );
  mapList.ButtonMaps = mapList.ButtonMaps.filter((map) =>
    !(String(map?.__type ?? "").includes("DeviceButtonMap") &&
      idText(map?.["DeviceId-"]) === idText(targetId))
  );

  replaceDeviceReferences(activityList, targetId, templateId);
  replaceDeviceReferences(mapList, targetId, templateId);
  replaceDeviceMenuReferences(mapList, targetId, templateId);
  replaceDeviceReferences(functionList, targetId, templateId);

  const targetIndex = entries.indexOf(targetEntry);
  if (targetIndex < 0) fail(`target device ${targetId} could not be removed`);
  entries.splice(targetIndex, 1);

  templateDevice.Name = options.name || identity.name;
  templateDevice.BTAddress = options.address.toUpperCase();
  // A paired physical remote refuses to transmit for a Bluetooth device whose
  // IsKeyboardAssociated is true and reports "use the Harmony App to pair".
  templateDevice.IsKeyboardAssociated = false;
  templateDevice.Transport = 32;
  templateDevice.ControlPort = 7;

  setBundleFile(bundle, "ActivityList.json", activityList);
  setBundleFile(bundle, "DeviceList.json", deviceList);
  setBundleFile(bundle, "FunctionList.json", functionList);
  setBundleFile(bundle, "MapList.json", mapList);
  try {
    fs.writeFileSync(options.output, `${JSON.stringify(bundle)}\n`, { mode: 0o600 });
  } catch (error) {
    fail(`could not write output bundle: ${error.message}`);
  }

  console.log(
    `reused template device ${templateId} as ${templateDevice.Name} at ` +
    `${options.address.toUpperCase()}, migrated references from ${targetId}, ` +
    "and removed the fabricated device profile"
  );
  process.exit(0);
}

const operationalKeys = [
  "DongleIndex",
  "InterDeviceDelay",
  "HoldInterKeyDelay",
  "DeviceType",
  "SetupState",
  "DeviceSearchType",
  "DeviceTypeDisplayName",
  "Transport",
  "PressMinRepeats",
  "DefaultPressMinRepeats",
  "DefaultInterDeviceDelay",
  "IsKeyboardAssociated",
  "Icon",
  "IsInterKeyDelayOptimized",
  "SuggestedDisplay",
  "ControlPort",
  "InterKeyDelay",
  "DeviceClassification",
  "DeviceCapabilitiesWithPriority",
  "Characterization",
  "HoldMinRepeats",
  "DefaultInterKeyDelay",
  "HoldInterDeviceDelay"
];
for (const key of operationalKeys) {
  if (Object.prototype.hasOwnProperty.call(templateDevice, key)) {
    targetDevice[key] = clone(templateDevice[key]);
  }
}
targetDevice["Id-"] = targetId;
targetDevice.ContentProfileKey = targetId;
targetDevice.Name = identity.name;
targetDevice.Manufacturer = identity.manufacturer;
targetDevice.Model = identity.model;
targetDevice.ParentDeviceManufacturer = identity.parentManufacturer;
targetDevice.ParentDeviceModel = identity.parentModel;
targetDevice.ParentDeviceId = null;
targetDevice["ParentDevice-"] = 0;
targetDevice.BTAddress = options.address.toUpperCase();
// See above: true blocks physical-remote control of this device.
targetDevice.IsKeyboardAssociated = false;
targetDevice.Transport = 32;
targetDevice.ControlPort = 7;
targetDevice.PrivateAddType = 1;
targetDevice.DeviceProfileUri = "";
targetDevice["GlobalDeviceVersionId-"] = 0;
targetDevice["GlobalLanguageVersionId-"] = 0;
targetDevice.DeviceAddedDate = identity.dateAdded || `/Date(${Date.now()}+0000)/`;
targetDevice.AppLaunchConfigs = [];

let nextCommandId = maxValue(entries, "Id-", 0) + 1;
targetEntry.Commands = clone(templateEntry.Commands).map((command) => {
  command["Id-"] = nextCommandId;
  nextCommandId += 1;
  command.TransportType = 32;
  return command;
});

const otherFeatures = entries
  .filter((entry) => entry !== targetEntry)
  .flatMap((entry) => Array.isArray(entry.DeviceFeatures) ? entry.DeviceFeatures : []);
let nextFeatureId = maxValue(otherFeatures, "Id", 0) + 1;
targetEntry.DeviceFeatures = clone(
  Array.isArray(templateEntry.DeviceFeatures) ? templateEntry.DeviceFeatures : []
);
replaceDeviceReferences(targetEntry.DeviceFeatures, templateId, targetId);
nextFeatureId = reallocateFeatureIds(targetEntry.DeviceFeatures, nextFeatureId);

if (!Array.isArray(functionList?.FunctionMaps)) {
  fail("FunctionList has no FunctionMaps array");
}
const templateMap = functionList.FunctionMaps.find((map) =>
  String(map?.__type ?? "").includes("DeviceFunctionMap") &&
  idText(map?.["DeviceId-"]) === idText(templateId)
);
if (!templateMap) fail(`template device ${templateId} has no DeviceFunctionMap`);
const targetMap = clone(templateMap);
replaceDeviceReferences(targetMap, templateId, targetId);
targetMap["DeviceId-"] = targetId;
const existingMapIndex = functionList.FunctionMaps.findIndex((map) =>
  String(map?.__type ?? "").includes("DeviceFunctionMap") &&
  idText(map?.["DeviceId-"]) === idText(targetId)
);
if (existingMapIndex >= 0) functionList.FunctionMaps[existingMapIndex] = targetMap;
else functionList.FunctionMaps.push(targetMap);

if (!Array.isArray(mapList?.ButtonMaps)) {
  fail("MapList has no ButtonMaps array");
}
const isDeviceButtonMap = (map, deviceId) =>
  String(map?.__type ?? "").includes("DeviceButtonMap") &&
  idText(map?.["DeviceId-"]) === idText(deviceId);
const templateButtonMap = mapList.ButtonMaps.find((map) =>
  isDeviceButtonMap(map, templateId)
);
if (!templateButtonMap) {
  fail(`template device ${templateId} has no DeviceButtonMap`);
}
const existingButtonMapIndex = mapList.ButtonMaps.findIndex((map) =>
  isDeviceButtonMap(map, targetId)
);
const otherButtonMaps = mapList.ButtonMaps.filter(
  (_, index) => index !== existingButtonMapIndex
);
let nextButtonMapId = maxValue(otherButtonMaps, "ButtonMapId-", 0) + 1;
let nextButtonId = maxValue(otherButtonMaps, "ButtonId", 0) + 1;
const targetButtonMap = clone(templateButtonMap);
replaceDeviceReferences(targetButtonMap, templateId, targetId);
replaceDeviceMenuReferences(targetButtonMap, templateId, targetId);
targetButtonMap["DeviceId-"] = targetId;
targetButtonMap["ButtonMapId-"] = nextButtonMapId;
targetButtonMap.ButtonMapIdentifier = String(
  targetButtonMap.ButtonMapIdentifier || `Device${templateId}`
).split(idText(templateId)).join(idText(targetId));
targetButtonMap.DateModified = `/Date(${Date.now()}+0000)/`;
for (const button of targetButtonMap.Buttons ?? []) {
  button.ButtonId = nextButtonId;
  nextButtonId += 1;
}
if (existingButtonMapIndex >= 0) {
  mapList.ButtonMaps[existingButtonMapIndex] = targetButtonMap;
} else {
  mapList.ButtonMaps.push(targetButtonMap);
}

const names = commandNames(targetEntry);
for (const group of targetMap.FunctionGroups ?? []) {
  for (const action of group?.Functions ?? []) {
    if (!names.has(String(action?.CommandName ?? ""))) {
      fail(`function map command ${JSON.stringify(action?.CommandName)} is missing`);
    }
  }
}
for (const button of targetButtonMap.Buttons ?? []) {
  for (const field of [
    "ButtonAction",
    "ButtonLongPressAction",
    "ButtonDoublePressAction"
  ]) {
    const action = button?.[field];
    if (action?.CommandName && !names.has(String(action.CommandName))) {
      fail(`button map command ${JSON.stringify(action.CommandName)} is missing`);
    }
  }
}
const protocols = Array.isArray(protocolList?.Protocols) ? protocolList.Protocols : [];
const requiredProtocols = new Set(
  targetEntry.Commands.map((command) => Number(command?.ProtocolId)).filter(Number.isSafeInteger)
);
for (const protocolId of requiredProtocols) {
  if (!protocols.some((protocol) =>
    Number(protocol?.["Id-"] ?? protocol?.Id ?? protocol?.ProtocolId) === protocolId
  )) {
    fail(`ProtocolList is missing required protocol ${protocolId}`);
  }
}

setBundleFile(bundle, "DeviceList.json", deviceList);
setBundleFile(bundle, "FunctionList.json", functionList);
setBundleFile(bundle, "MapList.json", mapList);
try {
  fs.writeFileSync(options.output, `${JSON.stringify(bundle)}\n`, { mode: 0o600 });
} catch (error) {
  fail(`could not write output bundle: ${error.message}`);
}

console.log(
  `bridged ${identity.name} (${targetId}) to ${options.address.toUpperCase()} ` +
  `with ${targetEntry.Commands.length} commands, ${targetEntry.DeviceFeatures.length} features, ` +
  `command IDs through ${nextCommandId - 1}, and device button map ` +
  `${targetButtonMap["ButtonMapId-"]} with ${targetButtonMap.Buttons?.length ?? 0} buttons`
);
