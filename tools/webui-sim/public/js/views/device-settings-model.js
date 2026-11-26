/* Power and timing settings for one device (the P1 settings editor).
   Pure data shaping, importable under node:test. The checks mirror
   codexactivity's CommitDeviceSettings so the UI refuses what the hub would;
   the hub re-checks everything against the device's own commands. */

export const SETTINGS_LIMITS = Object.freeze({
  interKeyDelayMs: [0, 5000],
  interDeviceDelayMs: [0, 10000],
  repeats: [0, 10],
  powerOnDelayMs: [0, 60000],
});

export const POWER_TYPES = Object.freeze([
  { value: "discrete", label: "Separate On and Off commands" },
  { value: "toggle", label: "One power button (toggle)" },
  { value: "none", label: "No power control (always on, or switched by hand)" },
]);

export const INPUT_TYPES = Object.freeze([
  { value: "discrete", label: "Each input has its own command" },
  { value: "cycle", label: "One button cycles through the inputs" },
  { value: "none", label: "No input switching" },
]);

/* Device.ControlPort: which IR emitter sends the device's commands, as stock
   Harmony stores it. 7 is every hub output; the remote's blaster is never
   part of it. Other stored values are kept as they are and never sent. */
export const IR_OUTPUTS = Object.freeze([
  { value: 7, label: "All hub outputs (built-in, external 1 and 2)" },
  { value: 1, label: "Hub built-in emitters" },
  { value: 2, label: "External blaster 1" },
  { value: 4, label: "External blaster 2" },
  { value: 0, label: "Remote's IR blaster" },
]);
const IR_OUTPUT_VALUES = new Set(IR_OUTPUTS.map((o) => o.value));

/* Device.Transport is a bitmask: 1 IR, 32 Bluetooth (the hub as a HID
   keyboard), 64 IP. A stock Sony TV is 65: IP control with an IR fallback.
   Missing reads as IR, the stock default; anything but a positive whole
   number, text such as "65" included, has no bits, as codexactivity reads
   it. */
export const TRANSPORT_IR = 1;
export const TRANSPORT_BLUETOOTH = 32;
export const TRANSPORT_IP = 64;

export function transportBits(value) {
  if (value === undefined || value === null) return TRANSPORT_IR;
  return Number.isInteger(value) && value > 0 ? value : 0;
}

export function hasTransport(value, bit) {
  return (transportBits(value) & bit) !== 0;
}

/* Devices with IR (alone or as a fallback, like Sony's 65) have an output. */
export function isIrDevice(entry) {
  return hasTransport(entry?.Device?.Transport, TRANSPORT_IR);
}

/* The Devices list badge for one state.devices() entry. The hub's own IP
   devices come first, since each also has the IP bit; then Home Assistant,
   Bluetooth and any other network device; plain IR last. */
export function deviceBadge(d) {
  if (d.isAndroidTv) return { cls: "badge-network", label: "Network" };
  if (d.isWebOs) return { cls: "badge-network", label: "LG webOS" };
  if (d.isSwitch2) return { cls: "badge-bluetooth", label: "BLE Wake" };
  if (d.isHa) return { cls: "badge-ha", label: "Home Assistant" };
  if (d.isBluetooth) return { cls: "badge-bluetooth", label: "Bluetooth" };
  if (d.isNetwork) return { cls: "badge-network", label: "Network" };
  return { cls: "", label: "IR" };
}

export const MAX_INPUTS = 32;
export const INPUT_DELAY_MAX_MS = 60000;

/* A readable input name for an input command: InputHdmi1 → "HDMI 1". */
export function inputDisplayName(commandName) {
  return String(commandName)
    .replace(/^Input/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/\bHdmi\b/gi, "HDMI")
    .replace(/\bTv\b/g, "TV")
    .replace(/\bAv\b/g, "AV")
    .replace(/\bUsb\b/g, "USB")
    .replace(/\bArc\b/g, "ARC")
    .trim();
}

// PowerFeature.PowerTypeId: 0 not specified and 3 manual both mean the engine
// sends no power commands.
const TYPE_BY_ID = { 0: "none", 1: "discrete", 2: "toggle", 3: "none" };
const TYPE_ID = { none: 0, discrete: 1, toggle: 2 };

function featureOf(entry, type) {
  const features = Array.isArray(entry?.DeviceFeatures) ? entry.DeviceFeatures : [];
  return features.find((f) => String(f?.__type ?? "").includes(type)) ?? null;
}

function powerFeature(entry) {
  return featureOf(entry, "PowerFeature");
}

function firstCommand(actions) {
  const action = (Array.isArray(actions) ? actions : []).find((a) => a?.IRCommandName);
  return action ? String(action.IRCommandName) : "";
}

function wholeNumber(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function commandNames(entry) {
  return (Array.isArray(entry?.Commands) ? entry.Commands : [])
    .map((c) => String(c?.Name ?? ""))
    .filter(Boolean);
}

/* Best guesses for a device without a power feature, by command name. */
export function suggestPowerCommands(names) {
  const key = (name) => name.toLowerCase().replace(/[\s_-]+/g, "");
  const pick = (candidates) => {
    for (const candidate of candidates) {
      const hit = names.find((name) => key(name) === candidate);
      if (hit) return hit;
    }
    return "";
  };
  return {
    on: pick(["poweron", "discreteon", "on"]),
    off: pick(["poweroff", "discreteoff", "off"]),
    toggle: pick(["powertoggle", "power", "poweronoff", "onoff", "standby"]),
  };
}

function defaultPowerOnDelay(device) {
  return /television|projector/i.test(String(device?.DeviceTypeDisplayName ?? "")) ? 10000 : 2000;
}

export function readDeviceSettings(entry) {
  const device = entry?.Device ?? {};
  const feature = powerFeature(entry);
  const suggested = suggestPowerCommands(commandNames(entry));
  let type;
  if (feature) type = TYPE_BY_ID[Number(feature.PowerTypeId)] ?? "none";
  else if (suggested.on && suggested.off) type = "discrete";
  else type = suggested.toggle ? "toggle" : "none";
  // Only a stored number counts: Number(null) would read as 0, the remote.
  const port = typeof device.ControlPort === "number" ? device.ControlPort : NaN;
  return {
    hasPowerFeature: Boolean(feature),
    // null: not an IR device, or a stored value this editor does not know.
    irOutput: isIrDevice(entry) && IR_OUTPUT_VALUES.has(port) ? port : null,
    interKeyDelayMs: wholeNumber(device.InterKeyDelay, 100),
    interDeviceDelayMs: wholeNumber(device.InterDeviceDelay, 500),
    // The engine repeats 3 times when PressMinRepeats is missing.
    repeats: wholeNumber(device.PressMinRepeats, 3),
    power: {
      type,
      on: firstCommand(feature?.PowerOnActions) || suggested.on,
      off: firstCommand(feature?.PowerOffActions) || suggested.off,
      toggle: firstCommand(feature?.PowerToggleActions) || suggested.toggle,
      delayMs: wholeNumber(feature?.PowerOnDelay, defaultPowerOnDelay(device)),
      alwaysOn: feature?.IsPowerAlwaysOn === true,
      onBetweenActivities: feature?.IsPoweredOnBetweenActivities === true,
    },
  };
}

/* The device's input names in order: what an activity's SelectedInput must
   match exactly. */
export function inputNames(entry) {
  const inputs = featureOf(entry, "InputFeature")?.Inputs;
  return (Array.isArray(inputs) ? inputs : [])
    .filter((i) => i?.InputName)
    .slice()
    .sort((a, b) => (Number(a.InputOrder) || 0) - (Number(b.InputOrder) || 0))
    .map((i) => String(i.InputName));
}

/* Inputs for a device without an input feature, from its Input* commands. */
export function suggestInputs(names) {
  return names
    .filter((n) => /^input/i.test(n) && !/^input(next|previous|prev|cycle|select)$/i.test(n.replace(/[\s_-]+/g, "")))
    .map((n) => ({ name: inputDisplayName(n) || n, command: n }));
}

// InputFeature.InputType 2 (toggle) and 4 (menu toggle) cycle. A device
// without an input feature reads as "none", with suggestions offered rather
// than applied.
export function readInputSettings(entry) {
  const feature = featureOf(entry, "InputFeature");
  const names = commandNames(entry);
  const cycleKey = (name) => name.toLowerCase().replace(/[\s_-]+/g, "");
  const guess = (keys) => names.find((n) => keys.includes(cycleKey(n))) ?? "";
  const suggested = suggestInputs(names);
  if (!feature) {
    const tv = /television|projector/i.test(String(entry?.Device?.DeviceTypeDisplayName ?? ""));
    return {
      hasInputFeature: false,
      type: "none",
      delayMs: tv ? 0 : 1000,
      list: [],
      suggested,
      next: guess(["inputnext", "input", "source", "inputselect"]),
      previous: guess(["inputprevious", "inputprev"]),
      afterPowerOn: "",
    };
  }
  const order = (i) => Number(i?.InputOrder) || 0;
  const resets = powerFeature(entry)?.PowerOnResetActions;
  const reset = (Array.isArray(resets) ? resets : [])
    .find((a) => a?.StateName === "Input" && Number(a?.DevActionType) === 1);
  return {
    hasInputFeature: true,
    type: [2, 4].includes(Number(feature.InputType)) ? "cycle" : "discrete",
    delayMs: wholeNumber(feature.InputDelay, 0),
    list: (Array.isArray(feature.Inputs) ? feature.Inputs : [])
      .filter((i) => i?.InputName)
      .slice()
      .sort((a, b) => order(a) - order(b))
      .map((i) => ({ name: String(i.InputName), command: firstCommand(i.Actions) })),
    suggested,
    next: firstCommand(feature.NextActions) || guess(["inputnext", "input", "source"]),
    previous: firstCommand(feature.PreviousActions) || guess(["inputprevious", "inputprev"]),
    afterPowerOn: reset?.StateValue ? String(reset.StateValue) : "",
  };
}

/* Activities that would lose their input switch if the device's inputs
   became `names`. */
export function inputsInUse(config, deviceId, names) {
  const keep = new Set(names);
  const uses = new Map();
  for (const activity of config?.activityList?.Activities ?? []) {
    for (const role of Array.isArray(activity?.Roles) ? activity.Roles : []) {
      const selected = role?.SelectedInput?.Name;
      if (String(role?.["DeviceId-"]) === String(deviceId) && typeof selected === "string" && !keep.has(selected)) {
        const name = activity.Name || activity.ActivityDisplayName || String(activity["Id-"]);
        uses.set(`${name}\u0000${selected}`, { activity: name, input: selected });
      }
    }
  }
  return [...uses.values()];
}

function validateInputs(inputs, has, errors) {
  if (!["discrete", "cycle", "none"].includes(inputs.type)) {
    errors.push("Choose how the device switches inputs.");
    return;
  }
  if (!Number.isInteger(inputs.delayMs) || inputs.delayMs < 0 || inputs.delayMs > INPUT_DELAY_MAX_MS) {
    errors.push(`Input delay must be from 0 to ${INPUT_DELAY_MAX_MS / 1000} seconds.`);
  }
  if (inputs.type === "none") return;
  const list = Array.isArray(inputs.list) ? inputs.list : [];
  if (!list.length || list.length > MAX_INPUTS) errors.push(`List 1 to ${MAX_INPUTS} inputs.`);
  const seen = new Set();
  for (const input of list) {
    const name = String(input?.name ?? "").trim();
    if (!name || name.length > 64 || /[\u0000-\u001f\u007f"\\]/.test(name)) {
      errors.push("Input names must be 1–64 characters without quotes or backslashes.");
      break;
    }
    if (seen.has(name.toLowerCase())) errors.push(`Input "${name}" is listed twice.`);
    seen.add(name.toLowerCase());
    if (inputs.type === "discrete" && input.command && !has.has(String(input.command).toLowerCase())) {
      errors.push(`Input "${name}" needs a command that the device has.`);
    }
  }
  if (inputs.type === "cycle") {
    if (list.length < 2) errors.push("Cycling needs at least two inputs.");
    if (!has.has(String(inputs.next ?? "").toLowerCase())) errors.push("Choose the device's next-input command.");
    if (inputs.previous && !has.has(String(inputs.previous).toLowerCase())) {
      errors.push("The previous-input command is not on the device.");
    }
    if (inputs.afterPowerOn && !seen.has(String(inputs.afterPowerOn).toLowerCase())) {
      errors.push("The input after power-on must be one of the inputs.");
    }
  }
}

export function validateDeviceSettings(settings, names, { wakeOnly = false } = {}) {
  const errors = [];
  const has = new Set(names.map((n) => n.toLowerCase()));
  const range = (label, value, [low, high]) => {
    if (!Number.isInteger(value) || value < low || value > high) {
      errors.push(`${label} must be a whole number from ${low} to ${high}.`);
    }
  };
  range("Delay between commands (ms)", settings.interKeyDelayMs, SETTINGS_LIMITS.interKeyDelayMs);
  range("Inter-device delay (ms)", settings.interDeviceDelayMs, SETTINGS_LIMITS.interDeviceDelayMs);
  range("Repeats", settings.repeats, SETTINGS_LIMITS.repeats);
  if (settings.irOutput != null && !IR_OUTPUT_VALUES.has(settings.irOutput)) {
    errors.push("Choose which IR output sends this device's commands.");
  }
  const power = settings.power ?? {};
  const [, maxDelay] = SETTINGS_LIMITS.powerOnDelayMs;
  if (!Number.isInteger(power.delayMs) || power.delayMs < 0 || power.delayMs > maxDelay) {
    errors.push(`Power-on delay must be from 0 to ${maxDelay / 1000} seconds.`);
  }
  if (!(power.type in TYPE_ID)) errors.push("Choose how the device is powered.");
  if (power.type === "discrete") {
    const hasOn = has.has(String(power.on ?? "").toLowerCase());
    const offEmpty = !String(power.off ?? "").trim();
    const hasOff = has.has(String(power.off ?? "").toLowerCase());
    if (!hasOn || (!hasOff && !(wakeOnly && offEmpty))) {
      errors.push("Choose an On and an Off command that the device has.");
    } else if (!offEmpty && String(power.on).toLowerCase() === String(power.off).toLowerCase()) {
      errors.push("On and Off are the same command; choose one power button instead.");
    }
  }
  if (power.type === "toggle" && !has.has(String(power.toggle ?? "").toLowerCase())) {
    errors.push("Choose the device's power command.");
  }
  if (settings.inputs) validateInputs(settings.inputs, has, errors);
  return errors;
}

/* Body for POST /api/device-settings. deviceId leads: the hub finds it by
   the first "deviceId" key. Inputs are sent only when given; the hub leaves
   the device's inputs alone otherwise. */
export function deviceSettingsRequest(deviceId, settings) {
  const power = settings.power;
  const body = {
    deviceId: String(deviceId),
    settings: {
      interKeyDelayMs: settings.interKeyDelayMs,
      interDeviceDelayMs: settings.interDeviceDelayMs,
      repeats: settings.repeats,
      ...(settings.irOutput != null ? { irOutput: settings.irOutput } : {}),
      power: {
        type: power.type,
        on: power.type === "discrete" ? power.on : null,
        off: power.type === "discrete" ? (power.off || null) : null,
        toggle: power.type === "toggle" ? power.toggle : null,
        delayMs: power.delayMs,
        alwaysOn: Boolean(power.alwaysOn),
        onBetweenActivities: Boolean(power.onBetweenActivities),
      },
    },
  };
  const inputs = settings.inputs;
  if (inputs) {
    const cycle = inputs.type === "cycle";
    body.settings.inputs = {
      type: inputs.type,
      delayMs: inputs.delayMs,
      list: inputs.type === "none" ? [] : inputs.list.map((i) => ({
        name: String(i.name).trim(),
        command: inputs.type === "discrete" && i.command ? i.command : null,
      })),
      next: cycle ? inputs.next : null,
      previous: cycle && inputs.previous ? inputs.previous : null,
      afterPowerOn: cycle && inputs.afterPowerOn ? inputs.afterPowerOn : null,
    };
  }
  return body;
}

/* What the hub writes: a copy of the DeviceList entry with the settings
   applied (the sim uses this; codexactivity does the same in Lua). */
export function applyDeviceSettings(entry, settings) {
  const next = structuredClone(entry);
  const names = commandNames(next);
  const stored = (name) => names.find((n) => n.toLowerCase() === String(name ?? "").toLowerCase()) ?? null;
  const press = (name) => (name ? [{ __type: "IRPressAction", IRCommandName: name, Order: 0, Duration: null, ActionId: 0 }] : []);
  const power = settings.power;
  next.Device.InterKeyDelay = settings.interKeyDelayMs;
  next.Device.InterDeviceDelay = settings.interDeviceDelayMs;
  next.Device.PressMinRepeats = settings.repeats;
  if (settings.irOutput != null) next.Device.ControlPort = settings.irOutput;
  if (!Array.isArray(next.DeviceFeatures)) next.DeviceFeatures = [];
  let feature = powerFeature(next);
  if (!feature) {
    feature = { __type: "PowerFeature", "DeviceId-": next.Device["Id-"], Id: 0, State: 1 };
    next.DeviceFeatures.push(feature);
  }
  feature.PowerTypeId = TYPE_ID[power.type];
  feature.PowerOnActions = press(power.type === "discrete" ? stored(power.on) : null);
  feature.PowerOffActions = press(power.type === "discrete" ? stored(power.off) : null);
  feature.PowerToggleActions = press(power.type === "toggle" ? stored(power.toggle) : null);
  feature.PowerOnDelay = power.delayMs;
  if (typeof feature.DefaultPowerOnDelay !== "number") feature.DefaultPowerOnDelay = power.delayMs;
  feature.IsPowerAlwaysOn = Boolean(power.alwaysOn);
  feature.IsPoweredOnBetweenActivities = Boolean(power.onBetweenActivities);
  if (settings.inputs) applyInputs(next, feature, settings.inputs, stored, press);
  return next;
}

function applyInputs(entry, power, inputs, stored, press) {
  const index = entry.DeviceFeatures.findIndex((f) => String(f?.__type ?? "").includes("InputFeature"));
  if (inputs.type === "none") {
    if (index >= 0) entry.DeviceFeatures.splice(index, 1);
  } else {
    let feature = entry.DeviceFeatures[index];
    if (!feature) {
      feature = { __type: "InputFeature", "DeviceId-": entry.Device["Id-"], Id: 0, State: 1, CanSkipInputs: 0 };
      entry.DeviceFeatures.unshift(feature);
    }
    const byName = new Map((feature.Inputs ?? []).filter((i) => i?.InputName).map((i) => [i.InputName, i]));
    feature.InputType = inputs.type === "cycle" ? 2 : 1;
    feature.InputDelay = inputs.delayMs;
    if (typeof feature.DefaultInputDelay !== "number") feature.DefaultInputDelay = inputs.delayMs;
    feature.Inputs = inputs.list.map((input, i) => ({
      ...(byName.get(String(input.name).trim()) ?? { Id: 0, ActionId: 0, IsOnline: false, PressDuration: 0, PortTypes: null }),
      InputName: String(input.name).trim(),
      InputOrder: i + 1,
      IsActiveInput: true,
      ActionSetTypeId: 1,
      Actions: press(inputs.type === "discrete" ? stored(input.command) : null),
    }));
    feature.NextActions = press(inputs.type === "cycle" ? stored(inputs.next) : null);
    feature.PreviousActions = press(inputs.type === "cycle" ? stored(inputs.previous) : null);
  }
  const resets = (power.PowerOnResetActions ?? []).filter((a) => !(a?.StateName === "Input" && Number(a?.DevActionType) === 1));
  if (inputs.type === "cycle" && inputs.afterPowerOn) {
    resets.push({ __type: "IRDevAction", DevActionType: 1, StateName: "Input", StateValue: inputs.afterPowerOn, IRCommandName: null, Order: resets.length, ActionId: 0 });
  }
  power.PowerOnResetActions = resets;
}
