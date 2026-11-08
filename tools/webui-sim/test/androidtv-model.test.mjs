import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ANDROIDTV_TAG,
  androidTvDeviceSet,
  androidTvIdOf,
  androidTvSpecs,
  foundList,
  isAndroidTvDevice,
  isAndroidTvEntry,
  nameProblem,
  normalizeCode,
  normalizeHost,
  pairingToUndo,
  pairStateText,
  tvStatusText,
} from "../public/js/views/androidtv-model.js";
import { deviceDomainLabel, isHaDevice } from "../public/js/views/remote-model.js";
import { touchScreenState } from "../public/js/views/ir-model.js";

const tvEntry = (id, token, name, extra = {}) => ({
  Device: {
    "Id-": id,
    Name: name,
    Manufacturer: extra.manufacturer ?? "Hisense",
    Model: extra.model ?? "75U8H",
    Transport: 64,
    Tokens: { Parameters: [{ Key: "{d}", Value: token }] },
    AutoDetectedDevice: { Id: `${ANDROIDTV_TAG}${id}` },
  },
  Commands: [{ Name: "PowerOn" }, { Name: "VolumeUp" }],
});
const haEntry = {
  Device: {
    "Id-": 39000100,
    Name: "Kitchen",
    Manufacturer: "Home Assistant",
    Transport: 64,
    Tokens: { Parameters: [{ Key: "{d}", Value: "light.kitchen" }] },
    AutoDetectedDevice: { Id: "melodious-ha-39000100" },
  },
};
const irEntry = { Device: { "Id-": 1001, Name: "Receiver", Transport: 1 } };
const config = {
  deviceList: { DevicesWithFeatures: [irEntry, haEntry, tvEntry(39000200, "androidtv1a2b3c4d", "Game Room TV")] },
  mapList: { ButtonMaps: [] },
};

describe("network TV devices", () => {
  it("are recognised by the writer's tag, not by transport", () => {
    assert.equal(isAndroidTvEntry(config.deviceList.DevicesWithFeatures[2]), true);
    assert.equal(isAndroidTvEntry(haEntry), false);
    assert.equal(isAndroidTvEntry(irEntry), false);
    assert.equal(isAndroidTvDevice({ entry: config.deviceList.DevicesWithFeatures[2] }), true);
  });

  it("are not Home Assistant devices in pickers", () => {
    const tv = { entry: config.deviceList.DevicesWithFeatures[2], transport: 64, commands: [] };
    assert.equal(isHaDevice(tv), false);
    assert.equal(isHaDevice({ entry: haEntry, transport: 64 }), true);
    assert.equal(deviceDomainLabel(tv), "Network TV");
  });

  it("have writer-managed Touch screens", () => {
    assert.equal(touchScreenState(config, "39000200"), "managed");
  });

  it("read the codex_androidtv id from the {d} token", () => {
    assert.equal(androidTvIdOf(config.deviceList.DevicesWithFeatures[2]), "androidtv1a2b3c4d");
    assert.equal(androidTvIdOf(irEntry), "");
  });
});

describe("the device set for /api/androidtv/devices", () => {
  it("lists only network TVs, with their names", () => {
    assert.deepEqual(androidTvSpecs(config), [
      { entity: "androidtv1a2b3c4d", name: "Game Room TV", manufacturer: "Hisense", model: "75U8H" },
    ]);
  });

  it("adds a TV and keeps the others", () => {
    const set = androidTvDeviceSet(config, { add: { entity: "androidtv99887766", name: " Den TV ", manufacturer: "", model: "" } });
    assert.deepEqual(set.devices.map((d) => [d.entity, d.name]), [["androidtv1a2b3c4d", "Game Room TV"], ["androidtv99887766", "Den TV"]]);
    assert.equal("manufacturer" in set.devices[1], false);
  });

  it("replaces the device for a TV paired again", () => {
    const set = androidTvDeviceSet(config, { add: { entity: "androidtv1a2b3c4d", name: "Renamed" } });
    assert.deepEqual(set.devices.map((d) => d.name), ["Renamed"]);
  });

  it("removes a TV", () => {
    assert.deepEqual(androidTvDeviceSet(config, { remove: "androidtv1a2b3c4d" }), { devices: [] });
  });
});

describe("what people type", () => {
  it("normalises the pairing code", () => {
    assert.deepEqual(normalizeCode(" ed3c28 "), { code: "ED3C28" });
    assert.deepEqual(normalizeCode("ED3-C28"), { code: "ED3C28" });
    assert.match(normalizeCode("").error, /Enter the code/);
    assert.match(normalizeCode("ED3C2G").error, /0–9/);
    assert.match(normalizeCode("ED3C2").error, /6 characters/);
  });

  it("accepts an IPv4 address only", () => {
    assert.equal(normalizeHost(" 192.168.88.39 "), "192.168.88.39");
    assert.equal(normalizeHost("192.168.088.039"), "192.168.88.39");
    assert.equal(normalizeHost("192.168.88"), null);
    assert.equal(normalizeHost("192.168.88.300"), null);
    assert.equal(normalizeHost("tv.local"), null);
  });

  it("checks names the hub can store", () => {
    assert.equal(nameProblem("Game Room TV"), "");
    assert.match(nameProblem(""), /name/);
    assert.match(nameProblem('Joe"s TV'), /quotes/);
    assert.match(nameProblem("x".repeat(65)), /64/);
  });
});

describe("words on screen", () => {
  it("describes a TV's connection", () => {
    assert.equal(tvStatusText({ connected: true, on: true, volume: 10, volumeMax: 100, host: "192.168.88.39" }),
      "Connected · On · Volume 10 · 192.168.88.39");
    assert.equal(tvStatusText({ connected: true, on: false, volume: -1, volumeMax: 0, host: "10.0.0.5" }),
      "Connected · In standby · 10.0.0.5");
    assert.match(tvStatusText({ connected: false, error: "connect: No route to host", host: "10.0.0.5" }), /^Not connected \(connect: No route to host\)/);
    assert.match(tvStatusText(null), /Not paired/);
  });

  it("lists found TVs, those already added last", () => {
    const list = foundList(
      [{ name: "Zed", host: "10.0.0.9", paired: "" }, { name: "Alpha", host: "10.0.0.8", paired: "androidtv1a2b3c4d" }, { name: "", host: "" }],
      new Set(["androidtv1a2b3c4d"]),
    );
    assert.deepEqual(list, [
      { name: "Zed", host: "10.0.0.9", added: false },
      { name: "Alpha", host: "10.0.0.8", added: true },
    ]);
  });

  it("explains the waits", () => {
    assert.match(pairStateText("preparing"), /first time/);
    assert.match(pairStateText("connecting", "Den TV"), /Den TV/);
    assert.equal(pairStateText("code"), "");
  });
});

describe("closing the Add a TV sheet", () => {
  const onHub = new Set(["androidtv1a2b3c4d"]);
  it("undoes a new pairing that never became a device", () => {
    assert.equal(pairingToUndo("androidtv99887766", { devicesByTv: onHub }), "androidtv99887766");
  });
  it("keeps the pairing of a TV already on the hub (paired again from a typed address)", () => {
    assert.equal(pairingToUndo("androidtv1a2b3c4d", { devicesByTv: onHub }), "");
  });
  it("keeps the pairing once the save went through, even before the device list refreshes", () => {
    assert.equal(pairingToUndo("androidtv99887766", { committed: true, devicesByTv: onHub }), "");
  });
  it("has nothing to undo without a paired TV", () => {
    assert.equal(pairingToUndo("", { devicesByTv: onHub }), "");
    assert.equal(pairingToUndo(undefined), "");
  });
});
