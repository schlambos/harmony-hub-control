import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  activityIconName,
  activityKeys,
  activityRoles,
  canonicalKey,
  deviceIconName,
  deviceKeys,
  deviceNamesFor,
  fixItDevices,
  humanizeLabel,
  roleLabel,
  sendsHome,
  softButtons,
} from "../public/js/views/remote-model.js";

const config = JSON.parse(readFileSync(new URL("../fixtures/activity-config.json", import.meta.url), "utf8"));

/* Same shape as state.devices(), built straight from the fixture. */
const devices = config.deviceList.DevicesWithFeatures.map((entry) => ({
  id: String(entry.Device["Id-"]),
  name: entry.Device.Name,
  model: entry.Device.Model ?? "",
  typeLabel: entry.Device.DeviceTypeDisplayName || entry.Device.DeviceType || "",
  isBluetooth: Number(entry.Device.Transport) === 32,
  entry,
  commands: entry.Commands.map((c) => ({ name: c.Name, functionId: c["FunctionId-"] })),
}));
const activity = (id) => config.activityList.Activities.find((a) => String(a["Id-"]) === id);
const SHIELD = "48113644";
const PC = "1594209107";

describe("canonicalKey", () => {
  it("folds the case variants real maps use", () => {
    assert.equal(canonicalKey("DVR"), "Dvr");
    assert.equal(canonicalKey("dvr"), "Dvr");
    assert.equal(canonicalKey("PrevChannel"), "PrevChannel");
  });

  it("ignores gestures and activity shortcuts the keypad has no key for", () => {
    for (const key of ["SwipeUp", "Tap", "MovieActivity", "", null]) assert.equal(canonicalKey(key), null);
  });
});

describe("activityKeys", () => {
  const keys = activityKeys(config, SHIELD);

  it("resolves hard keys from the activity's own map", () => {
    assert.deepEqual(keys.get("Exit").press, { deviceId: "66690268", command: "Back", functionId: 39 });
    assert.equal(keys.get("Exit").label, "Exit");
  });

  it("keeps a key's long-press action", () => {
    assert.equal(keys.get("Menu").hold.deviceId, "66690268");
    assert.ok(keys.get("Menu").hold.command);
    assert.equal(keys.get("Select").hold, null);
  });

  it("fills the number pad from on-screen digit buttons", () => {
    assert.equal(keys.get("Number1").press.command, "1");
    assert.equal(keys.get("Number0").press.command, "0");
  });

  it("is empty for an unknown activity", () => {
    assert.equal(activityKeys(config, "123").size, 0);
  });
});

describe("softButtons", () => {
  it("lists the activity's on-screen buttons in menu order, without digits", () => {
    assert.deepEqual(softButtons(config, SHIELD).map((b) => b.label), ["Home", "Aspect", "Sleep"]);
  });

  it("keeps the command each button sends", () => {
    const aspect = softButtons(config, SHIELD).find((b) => b.label === "Aspect");
    assert.deepEqual(aspect.action, { deviceId: "74521691", command: "Aspect", functionId: 36 });
  });

  it("keeps an ordinary FGT0 on-screen digit button visible instead of swallowing it into the FGT2 number pad (#190)", () => {
    const clone = structuredClone(config);
    const map = clone.mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === `16417Activity${SHIELD}`);
    map.Buttons.push({
      __type: "SoftRemoteButton",
      FunctionGroupType: 0,
      ButtonId: 1999999001,
      ButtonState: 1,
      TextOnRemote: "Quick 1",
      MenuItem: { IndexInMenu: 17, MenuName: `Activity.${SHIELD}` },
      ButtonAction: {
        __type: "ButtonCommandAction",
        "DeviceId-": 66690268,
        CommandName: "1",
        "FunctionId-": 20,
        EventType: 0,
        Order: 0,
        Id: 0,
      },
      ButtonLongPressAction: {
        __type: "ButtonCommandAction",
        "DeviceId-": 74521691,
        CommandName: "InputHdmi1",
        "FunctionId-": 50,
        EventType: 2,
        Order: 0,
        Id: 0,
      },
      ButtonDoublePressAction: null,
      ButtonImageKey: null,
      ButtonImagePath: null,
      "ImageId-": 0,
    });
    assert.deepEqual(softButtons(clone, SHIELD).map((b) => b.label), ["Home", "Aspect", "Sleep", "Quick 1"]);
  });
});

describe("deviceKeys", () => {
  const lg = devices.find((d) => d.id === "74521691");
  const keys = deviceKeys(lg);

  it("matches the device's commands to keypad keys by name", () => {
    assert.equal(keys.get("VolumeUp").press.command, "VolumeUp");
    assert.equal(keys.get("DirectionUp").press.command, "DirectionUp");
    assert.equal(keys.get("Select").press.command, "OK");
    assert.equal(keys.get("PrevChannel").press.command, "Back");
  });

  it("never puts power on a keypad key", () => {
    for (const entry of keys.values()) assert.ok(!/^power/i.test(entry.press.command), entry.press.command);
  });

  it("is empty without a device", () => {
    assert.equal(deviceKeys(null).size, 0);
  });
});

describe("sendsHome", () => {
  it("is true only when the key's command is Home", () => {
    const keys = new Map([["Menu", { press: { command: "Home" } }], ["Exit", { press: { command: "Back" } }]]);
    assert.equal(sendsHome(keys, "Menu"), true);
    assert.equal(sendsHome(keys, "Exit"), false);
    assert.equal(sendsHome(keys, "Info"), false);
  });
});

describe("activity roles and names", () => {
  it("orders roles by power-on order", () => {
    assert.deepEqual(activityRoles(activity(PC)).map((r) => [r.deviceId, r.input]), [
      ["74521691", "HDMI 2"],
      ["81897247", "HDMI 3"],
    ]);
  });

  it("names each device once, skipping devices the hub no longer has", () => {
    assert.deepEqual(deviceNamesFor(activity(SHIELD), devices), ["LG TV", "NVIDIA Game Console"]);
  });

  it("phrases roles as jobs", () => {
    assert.equal(roleLabel("VolumeActivityRole"), "Sound / volume");
    assert.equal(roleLabel("SomethingActivityRole"), "Something");
  });
});

describe("icons", () => {
  it("picks activity icons like the app", () => {
    assert.equal(activityIconName(activity(PC)), "computer");
    assert.equal(activityIconName(activity(SHIELD)), "movie");
    assert.equal(activityIconName({ Name: "Music", Type: 4 }), "music_note");
    assert.equal(activityIconName({ Name: "X", Type: 9 }), "play_arrow");
  });

  it("picks device icons like the app", () => {
    assert.equal(deviceIconName({ name: "Living room", model: "SHIELD TV", typeLabel: "Media Player" }), "cast");
    assert.equal(deviceIconName({ name: "LG TV", typeLabel: "Television" }), "tv");
    assert.equal(deviceIconName({ name: "Amp", typeLabel: "Amplifier" }), "speaker");
    assert.equal(deviceIconName({ name: "Console", typeLabel: "GameConsoleWithDvd" }), "sports_esports");
  });
});

describe("fixItDevices", () => {
  const fixes = fixItDevices(activity(PC), devices);

  it("offers discrete power-on and the activity's input", () => {
    const tv = fixes.find((f) => f.device.id === "74521691");
    assert.equal(tv.powerOn.name, "PowerOn");
    assert.equal(tv.powerToggle, null);
    assert.equal(tv.inputName, "HDMI 2");
    assert.equal(tv.inputCommand.name, "InputHdmi2");
  });

  it("offers a toggle only when the device has no discrete power-on", () => {
    const amp = fixes.find((f) => f.device.id === "81897247");
    assert.equal(amp.powerOn, null);
    assert.equal(amp.powerToggle.name, "PowerToggle");
    assert.equal(amp.inputCommand.name, "InputHdmi3");
  });

  it("uses the configured power command over name guessing", () => {
    const shield = fixItDevices(activity(SHIELD), devices).find((f) => f.device.id === "66690268");
    assert.equal(shield.powerOn.name, "Home");
  });

  it("lists each device once, in power-on order", () => {
    assert.deepEqual(fixes.map((f) => f.device.name), ["LG TV", "Nakamichi Amp"]);
    assert.deepEqual(fixes[0].roles, ["Screen"]);
  });
});

describe("humanizeLabel", () => {
  it("splits camel case but leaves typed labels alone", () => {
    assert.equal(humanizeLabel("PreviousTrack"), "Previous Track");
    assert.equal(humanizeLabel("Smart TV"), "Smart TV");
  });
});
