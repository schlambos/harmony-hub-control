import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveSkinPowerAction,
  offStateSendNote,
  skinPowerLabel,
  isEverythingOff,
} from "../public/js/views/control-power.js";
import { textHelperRemedy } from "../public/js/views/bluetooth-model.js";
import { missingBinariesRemedy } from "../public/js/views/system-model.js";

describe("resolveSkinPowerAction", () => {
  it("ends the activity while one is running", () => {
    assert.deepEqual(
      resolveSkinPowerAction({
        mode: "activities",
        currentActivityId: "48113644",
        selectedDeviceId: "",
        deviceCommands: [],
      }),
      { kind: "activity-poweroff" },
    );
  });

  it("stays inert in Activities mode when nothing is running", () => {
    assert.equal(
      resolveSkinPowerAction({
        mode: "activities",
        currentActivityId: "-1",
        selectedDeviceId: "",
        deviceCommands: [],
      }).kind,
      "inert",
    );
    assert.equal(
      resolveSkinPowerAction({
        mode: "activities",
        currentActivityId: "",
        selectedDeviceId: "",
        deviceCommands: [],
      }).reason,
      "nothing-running",
    );
  });

  it("sends the device power command when aliases match", () => {
    const action = resolveSkinPowerAction({
      mode: "devices",
      currentActivityId: "-1",
      selectedDeviceId: "10",
      deviceCommands: [
        { name: "VolumeUp", functionId: 1 },
        { name: "PowerToggle", functionId: 2 },
      ],
    });
    assert.equal(action.kind, "device-power");
    assert.equal(action.deviceId, "10");
    assert.equal(action.command, "PowerToggle");
  });

  it("stays inert in Devices mode without a power command", () => {
    const action = resolveSkinPowerAction({
      mode: "devices",
      currentActivityId: "-1",
      selectedDeviceId: "10",
      deviceCommands: [{ name: "VolumeUp", functionId: 1 }],
    });
    assert.equal(action.kind, "inert");
    assert.equal(action.reason, "no-power-command");
  });
});

describe("offStateSendNote", () => {
  it("leaves the note alone while an activity runs", () => {
    assert.equal(
      offStateSendNote({
        baseNote: "sent",
        currentActivityId: "99",
        selectedActivityName: "Movie",
      }),
      "sent",
    );
  });

  it("adds a start nudge when everything is off", () => {
    assert.match(
      offStateSendNote({
        baseNote: "sent",
        currentActivityId: "-1",
        selectedActivityName: "NVIDIA Shield",
      }),
      /nothing is running — start NVIDIA Shield\?/,
    );
    assert.equal(isEverythingOff("-1"), true);
    assert.equal(isEverythingOff("1"), false);
  });
});

describe("skinPowerLabel", () => {
  it("describes each resolution", () => {
    assert.match(skinPowerLabel({ kind: "activity-poweroff" }), /end the running activity/i);
    assert.match(skinPowerLabel({ kind: "inert", reason: "nothing-running" }), /nothing is running/i);
    assert.match(skinPowerLabel({ kind: "device-power", command: "PowerOn" }), /PowerOn/);
  });
});

describe("B7 remedies", () => {
  it("text helper remedy mentions bthid / reboot / install", () => {
    const r = textHelperRemedy({ live: false, state: "missing", error: "Bluetooth FIFO runtime is not running" });
    assert.match(r, /codex_bthid_keyboard/);
    assert.match(r, /[Rr]eboot|install/);
    assert.equal(textHelperRemedy({ live: true }), "");
  });

  it("missing binaries remedy names reinstall and MANIFEST", () => {
    const r = missingBinariesRemedy([
      { name: "codex_webui", present: false },
      { name: "codex_hbus", present: true },
    ]);
    assert.match(r, /codex_webui/);
    assert.match(r, /install_webui/);
    assert.match(r, /MANIFEST/);
    assert.equal(missingBinariesRemedy([{ name: "x", present: true }]), "");
  });
});
