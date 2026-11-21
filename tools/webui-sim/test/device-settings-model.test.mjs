import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  IR_OUTPUTS,
  SETTINGS_LIMITS,
  isIrDevice,
  commandNames,
  suggestPowerCommands,
  readDeviceSettings,
  validateDeviceSettings,
  deviceSettingsRequest,
  applyDeviceSettings,
  inputDisplayName,
  inputNames,
  suggestInputs,
  readInputSettings,
  inputsInUse,
} from "../public/js/views/device-settings-model.js";

const FIXTURE = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../fixtures/activity-config.json"), "utf8"));
const device = (id) => structuredClone(
  FIXTURE.deviceList.DevicesWithFeatures.find((e) => String(e.Device["Id-"]) === id));
const LG = "74521691";
const AMP = "81897247";
const SHIELD = "66690268";
const BARE = "93111391";

function valid(over = {}) {
  return {
    interKeyDelayMs: 100,
    interDeviceDelayMs: 500,
    repeats: 1,
    ...over,
    power: {
      type: "discrete", on: "PowerOn", off: "PowerOff", toggle: "",
      delayMs: 10000, alwaysOn: false, onBetweenActivities: false,
      ...(over.power ?? {}),
    },
  };
}

describe("readDeviceSettings", () => {
  it("reads discrete power, delays and repeats from a cloud-made TV", () => {
    assert.deepEqual(readDeviceSettings(device(LG)), {
      hasPowerFeature: true,
      irOutput: 7,   // the fixture's ControlPort: all hub outputs
      interKeyDelayMs: 100,
      interDeviceDelayMs: 500,
      repeats: 1,
      power: {
        type: "discrete", on: "PowerOn", off: "PowerOff", toggle: "PowerToggle",
        delayMs: 10000, alwaysOn: false, onBetweenActivities: false,
      },
    });
  });

  it("reads toggle power from the amp", () => {
    const s = readDeviceSettings(device(AMP));
    assert.equal(s.power.type, "toggle");
    assert.equal(s.power.toggle, "PowerToggle");
    assert.equal(s.power.delayMs, 2000);
  });

  it("keeps non-IR power actions (the console powers on with Home)", () => {
    const s = readDeviceSettings(device(SHIELD));
    assert.equal(s.power.type, "discrete");
    assert.equal(s.power.on, "Home");
    assert.equal(s.power.off, "Sleep");
    assert.equal(s.interKeyDelayMs, 0);
  });

  it("suggests settings for a device without a power feature", () => {
    const s = readDeviceSettings(device(BARE));
    assert.equal(s.hasPowerFeature, false);
    assert.equal(s.power.type, "toggle");
    assert.equal(s.power.toggle, "Power");
    assert.equal(s.repeats, 3);
  });

  it("defaults the repeats to the engine's 3 when the device has none", () => {
    const entry = device(BARE);
    delete entry.Device.PressMinRepeats;
    assert.equal(readDeviceSettings(entry).repeats, 3);
  });
});

describe("suggestPowerCommands", () => {
  it("matches common spellings, preferring the explicit power names", () => {
    assert.deepEqual(suggestPowerCommands(["POWER ON", "Power_Off", "POWER"]),
      { on: "POWER ON", off: "Power_Off", toggle: "POWER" });
    assert.deepEqual(suggestPowerCommands(["On", "Off", "Standby"]),
      { on: "On", off: "Off", toggle: "Standby" });
    assert.deepEqual(suggestPowerCommands(["VolumeUp"]), { on: "", off: "", toggle: "" });
  });
});

describe("validateDeviceSettings", () => {
  const names = commandNames(device(LG));

  it("accepts settings the hub would accept", () => {
    assert.deepEqual(validateDeviceSettings(valid(), names), []);
    assert.deepEqual(validateDeviceSettings(valid({ power: { type: "toggle", toggle: "powertoggle" } }), names), []);
    assert.deepEqual(validateDeviceSettings(valid({ power: { type: "none", on: "", off: "" } }), names), []);
  });

  it("rejects commands the device lacks and On equal to Off", () => {
    assert.match(validateDeviceSettings(valid({ power: { on: "Nope" } }), names)[0], /On and an Off/);
    assert.match(validateDeviceSettings(valid({ power: { off: "poweron" } }), names)[0], /same command/);
    assert.match(validateDeviceSettings(valid({ power: { type: "toggle", toggle: "" } }), names)[0], /power command/);
    assert.match(validateDeviceSettings(valid({ power: { type: "sometimes" } }), names)[0], /how the device is powered/);
  });

  it("enforces the hub's ranges and whole numbers", () => {
    const [, maxKey] = SETTINGS_LIMITS.interKeyDelayMs;
    assert.equal(validateDeviceSettings(valid({ interKeyDelayMs: maxKey + 1 }), names).length, 1);
    assert.equal(validateDeviceSettings(valid({ interDeviceDelayMs: -1 }), names).length, 1);
    assert.equal(validateDeviceSettings(valid({ repeats: 1.5 }), names).length, 1);
    assert.equal(validateDeviceSettings(valid({ repeats: Number.NaN }), names).length, 1);
    assert.match(validateDeviceSettings(valid({ power: { delayMs: 60001 } }), names)[0], /0 to 60 seconds/);
  });
});

describe("deviceSettingsRequest", () => {
  it("leads with deviceId and only sends the commands the power type uses", () => {
    const body = deviceSettingsRequest(81897247, valid({ power: { type: "toggle", toggle: "PowerToggle" } }));
    assert.deepEqual(Object.keys(body), ["deviceId", "settings"]);
    assert.equal(body.deviceId, "81897247");
    assert.deepEqual(body.settings.power, {
      type: "toggle", on: null, off: null, toggle: "PowerToggle",
      delayMs: 10000, alwaysOn: false, onBetweenActivities: false,
    });
  });
});

describe("applyDeviceSettings", () => {
  it("adds a power feature to a bare device, using the stored command spelling", () => {
    const before = device(BARE);
    const after = applyDeviceSettings(before, valid({ power: { type: "toggle", toggle: "power", delayMs: 3000 } }));
    const feature = after.DeviceFeatures.find((f) => f.__type === "PowerFeature");
    assert.equal(feature.PowerTypeId, 2);
    assert.deepEqual(feature.PowerToggleActions.map((a) => a.IRCommandName), ["Power"]);
    assert.deepEqual(feature.PowerOnActions, []);
    assert.equal(feature.PowerOnDelay, 3000);
    assert.equal(before.DeviceFeatures.length, 0, "input entry is not mutated");
  });

  it("round-trips through readDeviceSettings", () => {
    const settings = valid({ repeats: 2, power: { alwaysOn: true, onBetweenActivities: true, delayMs: 8000 } });
    const read = readDeviceSettings(applyDeviceSettings(device(LG), settings));
    assert.equal(read.repeats, 2);
    assert.equal(read.power.delayMs, 8000);
    assert.equal(read.power.alwaysOn, true);
    assert.equal(read.power.onBetweenActivities, true);
    assert.equal(read.power.on, "PowerOn");
  });

  it("keeps the cloud feature's other fields", () => {
    const after = applyDeviceSettings(device(AMP), valid({ power: { type: "toggle", toggle: "PowerToggle" } }));
    const feature = after.DeviceFeatures.find((f) => f.__type === "PowerFeature");
    assert.equal(feature["GlobalDeviceVersionId-"], 625762);
    assert.equal(feature.DefaultPowerOnDelay, 2000);
    assert.equal(after.DeviceFeatures.length, 4);
  });
});

describe("inputs", () => {
  const discrete = (list, over = {}) => ({ type: "discrete", delayMs: 1000, list, next: "", previous: "", afterPowerOn: "", ...over });

  it("reads the cloud TV's discrete inputs in order with their commands", () => {
    const s = readInputSettings(device(LG));
    assert.equal(s.hasInputFeature, true);
    assert.equal(s.type, "discrete");
    assert.equal(s.delayMs, 0);
    assert.deepEqual(s.list.slice(0, 4), [
      { name: "TV", command: "InputTv" }, { name: "AV", command: "InputAv1" },
      { name: "Component", command: "InputComponent1" }, { name: "HDMI 1", command: "InputHdmi1" },
    ]);
    assert.deepEqual(inputNames(device(AMP)).slice(0, 4), ["Aux", "Bluetooth", "Coaxial", "HDMI Arc"]);
  });

  it("reads a device without inputs as none, with suggestions offered, not applied", () => {
    const s = readInputSettings(device(BARE));
    assert.equal(s.hasInputFeature, false);
    assert.equal(s.type, "none");
    assert.deepEqual(s.list, []);
    assert.equal(s.delayMs, 1000);
  });

  it("suggests inputs from Input commands, without the cycling ones", () => {
    assert.deepEqual(suggestInputs(["InputHdmi1", "INPUT_NEXT", "InputPrevious", "InputBD", "VolumeUp"]),
      [{ name: "HDMI 1", command: "InputHdmi1" }, { name: "BD", command: "InputBD" }]);
    assert.equal(inputDisplayName("InputHDMI2"), "HDMI 2");
    assert.equal(inputDisplayName("InputHdmiArc"), "HDMI ARC");
  });

  it("names the activities that still select an input", () => {
    const keepAll = inputNames(device(LG));
    assert.deepEqual(inputsInUse(FIXTURE, LG, keepAll), []);
    const uses = inputsInUse(FIXTURE, LG, keepAll.filter((n) => n !== "HDMI 1"));
    assert.ok(uses.length >= 1);
    assert.ok(uses.every((u) => u.input === "HDMI 1"));
  });

  it("validates inputs like the hub", () => {
    const names = [...commandNames(device(LG)), "InputNext"];
    const check = (inputs) => validateDeviceSettings(valid({ inputs }), names);
    assert.deepEqual(check(discrete([{ name: "HDMI 1", command: "inputhdmi1" }, { name: "Phono", command: "" }])), []);
    assert.match(check(discrete([{ name: "TV" }, { name: "tv" }]))[0], /listed twice/);
    assert.match(check(discrete([{ name: "X", command: "Nope" }]))[0], /needs a command/);
    assert.match(check(discrete([{ name: 'A"B' }]))[0], /without quotes/);
    assert.match(check(discrete([]))[0], /1 to 32/);
    assert.match(check(discrete([{ name: "A" }], { delayMs: 61000 }))[0], /0 to 60 seconds/);
    assert.match(check({ type: "cycle", delayMs: 0, list: [{ name: "A" }, { name: "B" }], next: "" })[0], /next-input/);
    assert.match(check({ type: "cycle", delayMs: 0, list: [{ name: "A" }], next: "InputNext" })[0], /at least two/);
    assert.match(check({ type: "cycle", delayMs: 0, list: [{ name: "A" }, { name: "B" }], next: "InputNext", afterPowerOn: "Z" })[0], /after power-on/);
    assert.deepEqual(check({ type: "none", delayMs: 0 }), []);
  });

  it("sends inputs only when given, trimmed, with the fields the type uses", () => {
    assert.equal("inputs" in deviceSettingsRequest(LG, valid()).settings, false);
    const body = deviceSettingsRequest(LG, valid({ inputs: discrete([{ name: " HDMI 1 ", command: "InputHdmi1" }, { name: "Phono", command: "" }], { next: "InputNext" }) }));
    assert.deepEqual(body.settings.inputs, {
      type: "discrete", delayMs: 1000,
      list: [{ name: "HDMI 1", command: "InputHdmi1" }, { name: "Phono", command: null }],
      next: null, previous: null, afterPowerOn: null,
    });
    const cycle = deviceSettingsRequest(LG, valid({ inputs: { type: "cycle", delayMs: 500, list: [{ name: "A", command: "X" }, { name: "B" }], next: "InputNext", previous: "", afterPowerOn: "B" } }));
    assert.deepEqual(cycle.settings.inputs.list, [{ name: "A", command: null }, { name: "B", command: null }]);
    assert.equal(cycle.settings.inputs.afterPowerOn, "B");
    assert.equal(cycle.settings.inputs.previous, null);
  });

  it("applies discrete inputs, keeping each cloud input's fields by name", () => {
    const after = applyDeviceSettings(device(LG), valid({ inputs: discrete([
      { name: "HDMI 1", command: "inputhdmi1" }, { name: "Game", command: "InputHdmi4" }]) }));
    const feature = after.DeviceFeatures.find((f) => f.__type === "InputFeature");
    assert.equal(feature.InputType, 1);
    assert.equal(feature.InputDelay, 1000);
    assert.deepEqual(feature.Inputs.map((i) => [i.InputName, i.InputOrder, i.Actions[0].IRCommandName]),
      [["HDMI 1", 1, "InputHdmi1"], ["Game", 2, "InputHdmi4"]]);
    assert.equal(feature.Inputs[0].PortTypes[0].Name, "HDMI", "cloud PortTypes kept");
    assert.equal(after.DeviceFeatures.length, 4);
  });

  it("applies a cycle with an input after power-on, and none removes the feature", () => {
    const names = ["InputNext", "InputPrev"];
    const entry = device(BARE);
    entry.Commands.push(...names.map((n) => ({ Name: n })));
    let after = applyDeviceSettings(entry, valid({ power: { type: "toggle", toggle: "Power" },
      inputs: { type: "cycle", delayMs: 800, list: [{ name: "TV" }, { name: "HDMI" }], next: "inputnext", previous: "InputPrev", afterPowerOn: "HDMI" } }));
    const feature = after.DeviceFeatures.find((f) => f.__type === "InputFeature");
    const power = after.DeviceFeatures.find((f) => f.__type === "PowerFeature");
    assert.equal(after.DeviceFeatures[0], feature, "input feature leads, like the cloud's");
    assert.equal(feature.InputType, 2);
    assert.deepEqual(feature.NextActions.map((a) => a.IRCommandName), ["InputNext"]);
    assert.deepEqual(feature.PreviousActions.map((a) => a.IRCommandName), ["InputPrev"]);
    assert.deepEqual(feature.Inputs.map((i) => i.Actions.length), [0, 0]);
    assert.deepEqual(power.PowerOnResetActions.map((a) => [a.StateName, a.StateValue, a.DevActionType]), [["Input", "HDMI", 1]]);
    assert.deepEqual(readInputSettings(after).afterPowerOn, "HDMI");
    after = applyDeviceSettings(after, valid({ power: { type: "toggle", toggle: "Power" }, inputs: { type: "none", delayMs: 0 } }));
    assert.equal(after.DeviceFeatures.some((f) => f.__type === "InputFeature"), false);
    assert.deepEqual(after.DeviceFeatures.find((f) => f.__type === "PowerFeature").PowerOnResetActions, []);
  });
});

describe("IR output (Device.ControlPort)", () => {
  const withPort = (port, transport = 1) => {
    const entry = device(LG);
    entry.Device.ControlPort = port;
    entry.Device.Transport = transport;
    return entry;
  };

  it("reads each stock value on an IR device", () => {
    for (const { value } of IR_OUTPUTS) {
      assert.equal(readDeviceSettings(withPort(value)).irOutput, value);
    }
  });

  it("offers all hub outputs first", () => {
    assert.equal(IR_OUTPUTS[0].value, 7);
  });

  it("reads an unknown value as null and leaves it unsent", () => {
    const s = readDeviceSettings(withPort(3));
    assert.equal(s.irOutput, null);
    const body = deviceSettingsRequest(LG, valid({ irOutput: s.irOutput }));
    assert.equal("irOutput" in body.settings, false);
    const next = applyDeviceSettings(withPort(3), valid({ irOutput: s.irOutput }));
    assert.equal(next.Device.ControlPort, 3);
  });

  it("reads a null or text ControlPort as unknown, not as the remote", () => {
    for (const stored of [null, "", "7", true]) {
      assert.equal(readDeviceSettings(withPort(stored)).irOutput, null, String(stored));
    }
  });

  it("gives non-IR devices no output", () => {
    assert.equal(isIrDevice(withPort(7, 32)), false);
    assert.equal(readDeviceSettings(withPort(1, 32)).irOutput, null);
  });

  it("rejects values the hub would reject", () => {
    const names = commandNames(device(LG));
    for (const bad of [3, 5, 8, -1, 1.5]) {
      assert.equal(validateDeviceSettings(valid({ irOutput: bad }), names).length, 1, String(bad));
    }
    assert.deepEqual(validateDeviceSettings(valid({ irOutput: 4 }), names), []);
  });

  it("sends and applies a chosen output", () => {
    assert.equal(deviceSettingsRequest(LG, valid({ irOutput: 2 })).settings.irOutput, 2);
    assert.equal(applyDeviceSettings(withPort(1), valid({ irOutput: 0 })).Device.ControlPort, 0);
  });
});
