// Device.Transport is a bitmask (1 IR, 32 Bluetooth, 64 IP), not an enum: a
// stock Sony TV is 65, IP control with an IR fallback. The web app's device
// flags, badges and IR-output setting must read it that way, and must not
// take every IP device for Home Assistant's.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TRANSPORT_BLUETOOTH,
  TRANSPORT_IP,
  TRANSPORT_IR,
  deviceBadge,
  hasTransport,
  isIrDevice,
  readDeviceSettings,
  transportBits,
} from "../public/js/views/device-settings-model.js";
import { groupPickerDevices, isHaDevice } from "../public/js/views/remote-model.js";
import { devices, state } from "../public/js/state.js";

const entry = (id, device) => ({
  Device: { "Id-": id, Name: `Device ${id}`, ControlPort: 7, ...device },
  Commands: [],
  DeviceFeatures: [],
});

const FIXTURE = {
  sony: entry(1, { Name: "Sony TV", Manufacturer: "Sony", Transport: 65, RegisterSection: { Url: "http://{IP}/sony/accessControl" } }),
  roku: entry(2, { Name: "Roku", Manufacturer: "Roku", Transport: 64 }),
  haTagged: entry(3, { Name: "Lamp", Manufacturer: "Philips", Transport: 64, AutoDetectedDevice: { Id: "melodious-ha-3" } }),
  haByMaker: entry(4, { Name: "Scene", Manufacturer: "Home Assistant", Transport: 64 }),
  shield: entry(5, { Name: "Shield", Manufacturer: "NVIDIA", Transport: 32 }),
  btWithIr: entry(6, { Name: "Console", Manufacturer: "Sony", Transport: 33 }),
  hubBt: entry(7, { Name: "Laptop", Transport: 64, AutoDetectedDevice: { Id: "melodious-bt-7" } }),
  androidTv: entry(8, { Name: "Google TV", Manufacturer: "Home Assistant", Transport: 64, AutoDetectedDevice: { Id: "melodious-androidtv-8" } }),
  ir: entry(9, { Name: "Amp", Manufacturer: "Nakamichi", Transport: 1 }),
  legacy: entry(10, { Name: "Old Amp", Manufacturer: "Denon" }),
};

function view() {
  state.config = { deviceList: { DevicesWithFeatures: Object.values(FIXTURE) } };
  const byName = {};
  const ids = Object.fromEntries(Object.entries(FIXTURE).map(([key, e]) => [String(e.Device["Id-"]), key]));
  for (const d of devices()) byName[ids[d.id]] = d;
  return byName;
}

const flags = (d) => ({ isHa: d.isHa, isNetwork: d.isNetwork, isBluetooth: d.isBluetooth });

describe("Transport bits", () => {
  it("reads a missing Transport as IR and anything but a positive whole number as no bits", () => {
    assert.equal(transportBits(undefined), TRANSPORT_IR);
    assert.equal(transportBits(null), TRANSPORT_IR);
    assert.equal(transportBits(65), 65);
    // Text is no bitmask, as codexactivity reads it: no IR output it would refuse.
    for (const bad of [0, -1, 1.5, "65", "x", true]) assert.equal(transportBits(bad), 0, String(bad));
    assert.equal(isIrDevice(entry(11, { Transport: "65" })), false);
  });

  it("tests each bit on its own", () => {
    assert.equal(hasTransport(65, TRANSPORT_IR), true);
    assert.equal(hasTransport(65, TRANSPORT_IP), true);
    assert.equal(hasTransport(65, TRANSPORT_BLUETOOTH), false);
    assert.equal(hasTransport(33, TRANSPORT_BLUETOOTH), true);
    assert.equal(hasTransport(64, TRANSPORT_IR), false);
  });

  it("gives every device with the IR bit an IR output, a Sony TV's 65 too", () => {
    assert.equal(isIrDevice(FIXTURE.sony), true);
    assert.equal(readDeviceSettings(FIXTURE.sony).irOutput, 7);
    assert.equal(isIrDevice(FIXTURE.btWithIr), true);
    assert.equal(isIrDevice(FIXTURE.legacy), true);
    assert.equal(isIrDevice(FIXTURE.roku), false);
    assert.equal(isIrDevice(FIXTURE.shield), false);
  });
});

describe("device flags", () => {
  const d = view();

  it("treats a stock IP device (Sony 65, Roku 64) as a network device, not Home Assistant's", () => {
    assert.deepEqual(flags(d.sony), { isHa: false, isNetwork: true, isBluetooth: false });
    assert.deepEqual(flags(d.roku), { isHa: false, isNetwork: true, isBluetooth: false });
  });

  it("knows Home Assistant devices by the hub's tag or the manufacturer", () => {
    assert.deepEqual(flags(d.haTagged), { isHa: true, isNetwork: false, isBluetooth: false }, "renamed maker, still HA");
    assert.deepEqual(flags(d.haByMaker), { isHa: true, isNetwork: false, isBluetooth: false });
  });

  it("reads the Bluetooth bit alone or with IR", () => {
    assert.deepEqual(flags(d.shield), { isHa: false, isNetwork: false, isBluetooth: true });
    assert.deepEqual(flags(d.btWithIr), { isHa: false, isNetwork: false, isBluetooth: true });
  });

  it("leaves the hub's own IP devices to their own badges", () => {
    assert.deepEqual(flags(d.hubBt), { isHa: false, isNetwork: false, isBluetooth: true });
    assert.deepEqual(flags(d.androidTv), { isHa: false, isNetwork: false, isBluetooth: false });
  });

  it("keeps IR devices plain", () => {
    assert.deepEqual(flags(d.ir), { isHa: false, isNetwork: false, isBluetooth: false });
    assert.deepEqual(flags(d.legacy), { isHa: false, isNetwork: false, isBluetooth: false });
  });
});

describe("Devices list badges", () => {
  const d = view();
  const label = (key) => deviceBadge(d[key]).label;

  it("labels each kind of device, the hub's own IP devices before Home Assistant", () => {
    assert.deepEqual(
      Object.fromEntries(Object.keys(FIXTURE).map((key) => [key, label(key)])),
      {
        sony: "Network", roku: "Network", haTagged: "Home Assistant", haByMaker: "Home Assistant",
        shield: "Bluetooth", btWithIr: "Bluetooth", hubBt: "Bluetooth", androidTv: "Network",
        ir: "IR", legacy: "IR",
      },
    );
  });

  it("puts Home Assistant before Bluetooth and the network badge, and gives IR no class", () => {
    assert.equal(deviceBadge({ isHa: true, isBluetooth: true, isNetwork: true }).label, "Home Assistant");
    assert.equal(deviceBadge({ isBluetooth: true, isNetwork: true }).label, "Bluetooth");
    assert.deepEqual(deviceBadge({}), { cls: "", label: "IR" });
    assert.deepEqual(deviceBadge({ isWebOs: true, isHa: true }), { cls: "badge-network", label: "LG webOS" });
    assert.deepEqual(deviceBadge({ isSwitch2: true, isHa: true }), { cls: "badge-bluetooth", label: "BLE Wake" });
  });
});

describe("isHaDevice and the pickers", () => {
  const d = view();

  it("agrees with the device flags, and on a bare entry", () => {
    for (const [key, device] of Object.entries(d)) assert.equal(isHaDevice(device), device.isHa, key);
    assert.equal(isHaDevice({ entry: FIXTURE.sony }), false);
    assert.equal(isHaDevice({ entry: FIXTURE.roku }), false);
    assert.equal(isHaDevice({ entry: FIXTURE.haTagged }), true);
  });

  it("lists a Sony TV with the other devices, not under Home Assistant", () => {
    const groups = groupPickerDevices(Object.values(d), []);
    assert.deepEqual(groups.ha.map((x) => x.name).sort(), ["Lamp", "Scene"]);
    assert.ok(groups.other.some((x) => x.name === "Sony TV"));
  });
});
