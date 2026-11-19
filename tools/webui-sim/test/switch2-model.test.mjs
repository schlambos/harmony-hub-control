import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildSwitch2WakePayload,
  controllerTypeLabel,
  isSwitch2Entry,
  makeSwitch2Id,
  normalizeMac,
  normalizePid,
  SWITCH2_TAG,
  switch2ConfigOf,
  switch2DeviceSet,
  switch2IdOf,
  validateSwitch2Form,
} from "../public/js/views/switch2-model.js";
import { validateDeviceSettings } from "../public/js/views/device-settings-model.js";
import { touchScreenState } from "../public/js/views/ir-model.js";
import { deviceDomainLabel, fixItDevices, isHaDevice, isOneShotCommand } from "../public/js/views/remote-model.js";
import { resolveSkinPowerAction } from "../public/js/views/control-power.js";

// Hardware PoC captured 31-byte BLE wake payload (re/reports/switch2-wake-poc-results.md):
//   PID: 66 20 (Joy-Con 2 Right, 0x2066)
//   Switch 2 MAC: D8:6B:83:F0:42:FD -> reversed FD 42 F0 83 6B D8
const POC_PAYLOAD_HEX =
  "0201061BFF53050100037E056620000181FD42F0836BD80F00000000000000";

describe("Switch 2 wake payload construction", () => {
  it("matches the PoC's captured 31 bytes byte-for-byte", () => {
    const payload = buildSwitch2WakePayload("D8:6B:83:F0:42:FD", "66 20");
    assert.equal(payload.length, 31);
    const hex = Buffer.from(payload).toString("hex").toUpperCase();
    assert.equal(hex, POC_PAYLOAD_HEX);
  });

  it("supports Joy-Con 2 Left (67 20), Pro Controller 2 (69 20), and Custom PID", () => {
    const jcLeft = Buffer.from(buildSwitch2WakePayload("d8-6b-83-f0-42-fd", "67 20")).toString("hex").toUpperCase();
    assert.equal(jcLeft, POC_PAYLOAD_HEX.replace("7E056620", "7E056720"));

    const pro2 = Buffer.from(buildSwitch2WakePayload("D86B83F042FD", "6920")).toString("hex").toUpperCase();
    assert.equal(pro2, POC_PAYLOAD_HEX.replace("7E056620", "7E056920"));

    const custom = Buffer.from(buildSwitch2WakePayload("AA:BB:CC:11:22:33", "ab:cd")).toString("hex").toUpperCase();
    assert.equal(
      custom,
      "0201061BFF53050100037E05ABCD000181332211CCBBAA0F00000000000000",
    );
  });
});

describe("Switch 2 MAC and PID validation", () => {
  it("accepts colon, dash, and bare 12-hex MAC formats and normalizes to uppercase colon form", () => {
    assert.equal(normalizeMac("d8:6b:83:f0:42:fd").mac, "D8:6B:83:F0:42:FD");
    assert.equal(normalizeMac("  bc-89-a6-1f-ca-5b  ").mac, "BC:89:A6:1F:CA:5B");
    assert.equal(normalizeMac("aabbcc112233").mac, "AA:BB:CC:11:22:33");
  });

  it("rejects invalid, empty, broadcast, all-zero, and injection MAC strings", () => {
    for (const bad of [
      "",
      "   ",
      "00:00:00:00:00:00",
      "FF:FF:FF:FF:FF:FF",
      "D8:6B:83:F0:42",
      "D8:6B:83:F0:42:FD:01",
      "D8:6B:83:F0:42:GG",
      "D8:6B-83:F0:42:FD",
      "D8:6B:83:F0:42:FD; id",
      "$(touch /tmp/pwn)",
      "AA:BB:CC:DD:EE:FF\nrm -rf /",
    ]) {
      const res = normalizeMac(bad);
      assert.ok(res.error, `expected error for MAC ${JSON.stringify(bad)}`);
    }
  });

  it("accepts 2-byte wire PIDs and rejects invalid or injection PIDs", () => {
    assert.equal(normalizePid("66 20").pid, "6620");
    assert.equal(normalizePid("67:20").pid, "6720");
    assert.equal(normalizePid("69-20").pid, "6920");
    assert.equal(normalizePid("  abCD ").pid, "ABCD");

    for (const bad of ["", "66", "66 20 00", "0x2066", "ZZZZ", "66 20;id", "66  20"]) {
      const res = normalizePid(bad);
      assert.ok(res.error, `expected error for PID ${JSON.stringify(bad)}`);
    }
  });

  it("validates the complete form and refuses identical Switch 2 and controller MACs", () => {
    const ok = validateSwitch2Form({
      name: "Nintendo Switch 2",
      switch2Mac: "D8:6B:83:F0:42:FD",
      controllerMac: "BC:89:A6:1F:CA:5B",
      controllerType: "joycon2-r",
      customPid: "",
    });
    assert.deepEqual(ok, {
      spec: {
        name: "Nintendo Switch 2",
        switch2Mac: "D8:6B:83:F0:42:FD",
        controllerMac: "BC:89:A6:1F:CA:5B",
        pid: "6620",
      },
    });

    const same = validateSwitch2Form({
      name: "Switch 2",
      switch2Mac: "D8:6B:83:F0:42:FD",
      controllerMac: "d8-6b-83-f0-42-fd",
      controllerType: "pro2",
      customPid: "",
    });
    assert.equal(same.field, "controllerMac");
    assert.match(same.error, /not the Switch 2/i);

    const customBad = validateSwitch2Form({
      name: "Switch 2",
      switch2Mac: "AA:BB:CC:11:22:33",
      controllerMac: "12:34:56:78:9A:BC",
      controllerType: "custom",
      customPid: "nothex",
    });
    assert.equal(customBad.field, "customPid");
    assert.ok(customBad.error);
  });
});

describe("Switch 2 device model integration", () => {
  const entry = {
    Device: {
      "Id-": 39000010,
      Name: "Nintendo Switch 2",
      Manufacturer: "Nintendo",
      Model: "Switch 2",
      DeviceType: 23,
      DeviceTypeDisplayName: "GameConsole",
      Transport: 64,
      AutoDetectedDevice: { Id: `${SWITCH2_TAG}39000010` },
      Tokens: {
        Parameters: [
          { Key: "{d}", Value: "switch2a1b2c3d4" },
          { Key: "{s2mac}", Value: "D8:6B:83:F0:42:FD" },
          { Key: "{cmac}", Value: "BC:89:A6:1F:CA:5B" },
          { Key: "{pid}", Value: "6620" },
        ],
      },
    },
    Commands: [{ Name: "Wake", "Id-": 39000011, TransportType: 64 }],
    DeviceFeatures: [
      {
        __type: "PowerFeature",
        PowerTypeId: 1,
        PowerOnActions: [{ __type: "IRPressAction", IRCommandName: "Wake" }],
        PowerOffActions: [],
        PowerToggleActions: [],
        PowerOnDelay: 0,
        IsPowerAlwaysOn: false,
        IsPoweredOnBetweenActivities: false,
      },
    ],
  };

  it("identifies Switch 2 wake devices distinctly from Home Assistant devices", () => {
    assert.equal(isSwitch2Entry(entry), true);
    assert.equal(switch2IdOf(entry), "switch2a1b2c3d4");
    assert.equal(isHaDevice({ entry, transport: 64 }), false);
    assert.equal(deviceDomainLabel({ entry, name: "Nintendo Switch 2", commands: [{ name: "Wake" }] }), "Switch 2 Wake");
    assert.equal(isOneShotCommand("Wake"), true);
    assert.equal(controllerTypeLabel("6620"), "Joy-Con 2 (Right) (66 20)");
    assert.match(controllerTypeLabel("9988"), /untested/i);

    const cfg = switch2ConfigOf(entry);
    assert.equal(cfg.controllerType, "joycon2-r");
    assert.equal(cfg.switch2Mac, "D8:6B:83:F0:42:FD");
    assert.equal(cfg.controllerMac, "BC:89:A6:1F:CA:5B");
  });

  it("marks Touch screen as managed, allows wake-only device settings, and wires Fix It", () => {
    const config = { deviceList: { DevicesWithFeatures: [entry] }, mapList: { ButtonMaps: [] } };
    assert.equal(touchScreenState(config, "39000010"), "managed");

    const errs = validateDeviceSettings(
      {
        interKeyDelayMs: 0,
        interDeviceDelayMs: 0,
        repeats: 0,
        power: { type: "discrete", on: "Wake", off: "", toggle: "", delayMs: 0, alwaysOn: false, onBetweenActivities: false },
      },
      ["Wake"],
      { wakeOnly: true },
    );
    assert.deepEqual(errs, []);

    const skinPower = resolveSkinPowerAction({
      mode: "devices",
      selectedDeviceId: "39000010",
      deviceCommands: [{ name: "Wake", functionId: 0 }],
      deviceEntry: entry,
    });
    assert.deepEqual(skinPower, {
      kind: "device-power",
      deviceId: "39000010",
      command: "Wake",
      functionId: 0,
    });

    const fixes = fixItDevices(
      { "Id-": 500, Name: "Play Switch 2", Roles: [{ "DeviceId-": 39000010, __type: "PlayGameActivityRole", PowerOnOrder: 1 }] },
      [{ id: "39000010", name: "Nintendo Switch 2", entry, commands: [{ name: "Wake", functionId: 0 }], inputs: [] }],
    );
    assert.equal(fixes.length, 1);
    assert.equal(fixes[0].powerOn?.name, "Wake");
  });

  it("builds add/edit/remove device sets with stable ids", () => {
    const config = { deviceList: { DevicesWithFeatures: [entry] } };
    const edited = switch2DeviceSet(config, {
      add: {
        entity: "switch2a1b2c3d4",
        name: "Living Room Switch 2",
        switch2Mac: "D8:6B:83:F0:42:FD",
        controllerMac: "BC:89:A6:1F:CA:5B",
        pid: "6920",
      },
    });
    assert.equal(edited.devices.length, 1);
    assert.equal(edited.devices[0].pid, "6920");

    const removed = switch2DeviceSet(config, { remove: "switch2a1b2c3d4" });
    assert.deepEqual(removed, { devices: [] });

    const freshId = makeSwitch2Id(new Set(["switch2a1b2c3d4"]));
    assert.match(freshId, /^switch2[0-9a-f]{8}$/);
  });
});
