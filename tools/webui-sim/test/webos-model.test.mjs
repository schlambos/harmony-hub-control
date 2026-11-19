import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  WEBOS_TAG,
  isWebOsDevice,
  isWebOsEntry,
  makeWebOsId,
  normalizeWebOsHost,
  normalizeWebOsMac,
  validateWebOsForm,
  webOsAppsFromTv,
  webOsConfigOf,
  webOsDeviceSet,
  webOsIdOf,
  webOsInputsFromTv,
  webOsPairStateText,
  webOsStatusText,
} from "../public/js/views/webos-model.js";
import { deviceDomainLabel, isHaDevice } from "../public/js/views/remote-model.js";
import { touchScreenState } from "../public/js/views/ir-model.js";

function sampleEntry({ id = 39000050, entity = "webos1a2b3c4d", name = "Living Room LG", host = "192.168.1.40", mac = "AA:BB:CC:11:22:33", paired = true } = {}) {
  return {
    Device: {
      "Id-": id,
      Name: name,
      Manufacturer: "LG",
      Model: "webOS TV",
      DeviceType: 1,
      DeviceTypeDisplayName: "Television",
      Transport: 64,
      AutoDetectedDevice: { Id: `${WEBOS_TAG}${id}` },
      Tokens: {
        Parameters: [
          { Key: "{d}", Value: entity },
          { Key: "{host}", Value: host },
          { Key: "{mac}", Value: mac },
          { Key: "{keySlot}", Value: paired ? "set" : "unset" },
        ],
      },
    },
    Commands: [{ Name: "PowerOn" }, { Name: "PowerOff" }, { Name: "VolumeUp" }],
    DeviceFeatures: [],
  };
}

describe("webos-model", () => {
  it("recognizes native LG webOS entries and keeps them distinct from HA devices", () => {
    const entry = sampleEntry();
    const device = { id: "39000050", name: "Living Room LG", transport: 64, entry };
    assert.equal(isWebOsEntry(entry), true);
    assert.equal(isWebOsDevice(device), true);
    assert.equal(webOsIdOf(device), "webos1a2b3c4d");
    assert.equal(isHaDevice(device), false);
    assert.equal(deviceDomainLabel(device), "LG webOS TV");
    assert.deepEqual(webOsConfigOf(entry), {
      entity: "webos1a2b3c4d",
      name: "Living Room LG",
      host: "192.168.1.40",
      mac: "AA:BB:CC:11:22:33",
      paired: true,
    });
  });

  it("marks webOS Touch screens as managed", () => {
    const entry = sampleEntry();
    const config = {
      deviceList: { DevicesWithFeatures: [entry] },
      mapList: { ButtonMaps: [] },
    };
    assert.equal(touchScreenState(config, "39000050"), "managed");
  });

  it("validates IPv4 hosts, optional MACs, and names strictly", () => {
    assert.equal(normalizeWebOsHost("192.168.1.40"), "192.168.1.40");
    assert.equal(normalizeWebOsHost(" 10.0.0.5 "), "10.0.0.5");
    assert.equal(normalizeWebOsHost("192.168.1.999"), null);
    assert.equal(normalizeWebOsHost("lg-tv.local"), null);

    assert.deepEqual(normalizeWebOsMac(""), { mac: "" });
    assert.deepEqual(normalizeWebOsMac("aa-bb-cc-11-22-33"), { mac: "AA:BB:CC:11:22:33" });
    assert.deepEqual(normalizeWebOsMac("aabbcc112233"), { mac: "AA:BB:CC:11:22:33" });
    assert.ok(normalizeWebOsMac("00:00:00:00:00:00").error);
    assert.ok(normalizeWebOsMac("FF:FF:FF:FF:FF:FF").error);
    assert.ok(normalizeWebOsMac("ZZ:BB:CC:11:22:33").error);

    const ok = validateWebOsForm({ name: "Theater LG", host: "192.168.1.40", mac: "aa:bb:cc:11:22:33" });
    assert.deepEqual(ok.spec, { name: "Theater LG", host: "192.168.1.40", mac: "AA:BB:CC:11:22:33" });

    const okNoMac = validateWebOsForm({ name: "Bedroom LG", host: "192.168.1.41", mac: "" });
    assert.deepEqual(okNoMac.spec, { name: "Bedroom LG", host: "192.168.1.41", mac: "" });

    assert.equal(validateWebOsForm({ name: "", host: "192.168.1.40" }).field, "name");
    assert.equal(validateWebOsForm({ name: 'Bad "Quote"', host: "192.168.1.40" }).field, "name");
    assert.equal(validateWebOsForm({ name: "LG", host: "bad" }).field, "host");
    assert.equal(validateWebOsForm({ name: "LG", host: "192.168.1.40", mac: "bad" }).field, "mac");
  });

  it("maps stable HDMI port IDs and visible apps for CommitWebOsDevices", () => {
    const tv = {
      inputs: [
        { id: "HDMI_1", label: "Apple TV" },
        { id: "HDMI_2", label: "PS5" },
        { id: "HDMI_2", label: "Duplicate" },
        { id: "AV_1", label: "AV" },
      ],
      apps: [
        { id: "netflix", title: "Netflix", command: "App Netflix" },
        { id: "cdp-30", title: "Plex", command: "App Plex" },
        { id: "bad", title: "Bad", command: "NotAnApp" },
      ],
    };
    assert.deepEqual(webOsInputsFromTv(tv), [
      { name: "HDMI 1", command: "Input HDMI 1" },
      { name: "HDMI 2", command: "Input HDMI 2" },
    ]);
    assert.deepEqual(webOsAppsFromTv(tv), [
      { name: "App Netflix", id: "netflix" },
      { name: "App Plex", id: "cdp-30" },
    ]);
  });

  it("builds CommitWebOsDevices device sets for add, edit, and remove without client-keys", () => {
    const config = { deviceList: { DevicesWithFeatures: [sampleEntry()] } };
    const id = makeWebOsId(new Set(["webos1a2b3c4d"]));
    assert.match(id, /^webos[0-9a-f]{8}$/);

    const added = webOsDeviceSet(config, {
      add: { entity: id, name: "Bedroom LG", host: "192.168.1.41", mac: "", paired: false },
    });
    assert.equal(added.devices.length, 2);
    assert.equal("clientKey" in added.devices[0], false);
    assert.equal("clientKey" in added.devices[1], false);

    const removed = webOsDeviceSet(config, { remove: "webos1a2b3c4d" });
    assert.deepEqual(removed.devices, []);
  });

  it("renders accurate paired/unpaired status and pairing guidance copy", () => {
    assert.match(webOsStatusText({ paired: false, host: "192.168.1.40" }), /Unpaired/);
    assert.match(webOsStatusText({ paired: true, connected: true, pointerReady: true, volume: 22, muted: false, host: "192.168.1.40" }), /Connected · Volume 22/);
    assert.match(webOsStatusText({ paired: true, connected: false, mac: "AA:BB:CC:11:22:33", host: "192.168.1.40" }), /Wake-on-LAN/);
    assert.match(webOsPairStateText("prompt", "Living Room LG"), /Accept/);
    assert.match(webOsPairStateText("denied", "Living Room LG"), /declined/);
  });
});
