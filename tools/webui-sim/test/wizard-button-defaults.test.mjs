import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BUTTON_SOURCE,
  deriveDefaultButtons,
  preferredDeviceForButtonKey,
  reconcileWizardButtons,
  resetWizardButtonsToDefaults,
  revertWizardButtonToDefault,
  wizardButtonStats,
  buildActivityGraph,
} from "../public/js/wizard-model.js";

function device(id, names) {
  return {
    id: String(id),
    name: `Device ${id}`,
    commands: names.map((name, i) => ({ name, functionId: 100 + i })),
  };
}

const player = device(10, [
  "Play", "Pause", "Stop", "Rewind", "FastForward", "Record",
  "DirectionUp", "DirectionDown", "DirectionLeft", "DirectionRight",
  "Select", "Menu", "Back", "Info", "Exit", "Guide",
  "Red", "Green", "Yellow", "Blue",
]);
const volume = device(20, ["VolumeUp", "VolumeDown", "Mute"]);
const channel = device(30, ["ChannelUp", "ChannelDown", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
const display = device(40, ["PowerToggle", "InputHdmi1"]);
const silent = device(50, ["PowerOn"]); // no mappable remote commands

const movieRoles = [
  { deviceId: "40", roleType: "DisplayActivityRole" },
  { deviceId: "10", roleType: "PlayMovieActivityRole" },
  { deviceId: "20", roleType: "VolumeActivityRole" },
];

const tvRoles = [
  { deviceId: "40", roleType: "DisplayActivityRole" },
  { deviceId: "30", roleType: "ChannelChangingActivityRole" },
  { deviceId: "20", roleType: "VolumeActivityRole" },
];

describe("preferredDeviceForButtonKey", () => {
  it("routes volume keys to the volume role", () => {
    assert.equal(preferredDeviceForButtonKey("VolumeUp", movieRoles), "20");
    assert.equal(preferredDeviceForButtonKey("VolumeMute", movieRoles), "20");
  });

  it("routes channel and digits to the channel role when present", () => {
    assert.equal(preferredDeviceForButtonKey("ChannelUp", tvRoles), "30");
    assert.equal(preferredDeviceForButtonKey("Number5", tvRoles), "30");
  });

  it("falls channel/digits through to the player when no channel role", () => {
    assert.equal(preferredDeviceForButtonKey("Number5", movieRoles), "10");
  });

  it("routes transport and d-pad to the player chain", () => {
    assert.equal(preferredDeviceForButtonKey("Play", movieRoles), "10");
    assert.equal(preferredDeviceForButtonKey("DirectionUp", movieRoles), "10");
    assert.equal(preferredDeviceForButtonKey("Select", movieRoles), "10");
    assert.equal(preferredDeviceForButtonKey("Menu", movieRoles), "10");
  });
});

describe("deriveDefaultButtons", () => {
  it("populates transport, volume, and nav from role devices", () => {
    const defaults = deriveDefaultButtons(movieRoles, [player, volume, display]);
    assert.equal(defaults.Play?.deviceId, "10");
    assert.equal(defaults.Play?.command?.name, "Play");
    assert.equal(defaults.Play?.source, BUTTON_SOURCE.default);
    assert.equal(defaults.VolumeUp?.deviceId, "20");
    assert.equal(defaults.VolumeMute?.command?.name, "Mute");
    assert.equal(defaults.DirectionUp?.deviceId, "10");
    assert.equal(defaults.Select?.command?.name, "Select");
    assert.ok(Object.keys(defaults).length >= 10);
  });

  it("maps channel keys when a channel role is present", () => {
    const defaults = deriveDefaultButtons(tvRoles, [channel, volume, display]);
    assert.equal(defaults.ChannelUp?.deviceId, "30");
    assert.equal(defaults.Number1?.deviceId, "30");
    assert.equal(defaults.Number1?.command?.name, "1");
  });

  it("leaves keys unmapped when the preferred device lacks the command", () => {
    const defaults = deriveDefaultButtons(
      [{ deviceId: "50", roleType: "PlayMovieActivityRole" }],
      [silent],
    );
    assert.equal(defaults.Play, undefined);
    assert.equal(defaults.VolumeUp, undefined);
    assert.deepEqual(defaults, {});
  });

  it("never invents action-less mappings", () => {
    const defaults = deriveDefaultButtons(movieRoles, [player, volume, display]);
    for (const mapping of Object.values(defaults)) {
      assert.ok(mapping.command?.name);
      assert.ok(mapping.deviceId);
      assert.equal(mapping.hold, null);
    }
  });

  it("is idempotent for the same roles and devices", () => {
    const a = deriveDefaultButtons(movieRoles, [player, volume, display]);
    const b = deriveDefaultButtons(movieRoles, [player, volume, display]);
    assert.deepEqual(a, b);
  });
});

describe("reconcileWizardButtons", () => {
  it("fills empty keys with defaults without touching user mappings", () => {
    const current = {
      Play: {
        deviceId: "10",
        command: { name: "Pause", functionId: 1 },
        hold: null,
        source: BUTTON_SOURCE.user,
      },
    };
    const next = reconcileWizardButtons(current, movieRoles, [player, volume, display]);
    assert.equal(next.Play.command.name, "Pause");
    assert.equal(next.Play.source, BUTTON_SOURCE.user);
    assert.equal(next.VolumeUp.source, BUTTON_SOURCE.default);
    assert.equal(next.VolumeUp.deviceId, "20");
  });

  it("refreshes defaults when roles change but keeps user keys on still-present devices", () => {
    const started = reconcileWizardButtons({}, movieRoles, [player, volume, display, channel]);
    assert.equal(started.Play.deviceId, "10");
    started.Play = {
      deviceId: "10",
      command: { name: "Play", functionId: 1 },
      hold: null,
      source: BUTTON_SOURCE.user,
    };
    /* Add channel role while keeping the player — user Play must survive. */
    const rolesWithChannel = [
      ...movieRoles,
      { deviceId: "30", roleType: "ChannelChangingActivityRole" },
    ];
    const afterChannel = reconcileWizardButtons(
      started,
      rolesWithChannel,
      [player, volume, display, channel],
    );
    assert.equal(afterChannel.Play.source, BUTTON_SOURCE.user);
    assert.equal(afterChannel.Play.command.name, "Play");
    assert.equal(afterChannel.ChannelUp?.deviceId, "30");
    assert.equal(afterChannel.ChannelUp?.source, BUTTON_SOURCE.default);
  });

  it("clears mappings that pointed at a removed device", () => {
    const current = {
      Play: {
        deviceId: "10",
        command: { name: "Play", functionId: 1 },
        hold: null,
        source: BUTTON_SOURCE.user,
      },
      VolumeUp: {
        deviceId: "20",
        command: { name: "VolumeUp", functionId: 2 },
        hold: null,
        source: BUTTON_SOURCE.user,
      },
    };
    const rolesWithoutPlayer = [
      { deviceId: "40", roleType: "DisplayActivityRole" },
      { deviceId: "20", roleType: "VolumeActivityRole" },
    ];
    const next = reconcileWizardButtons(current, rolesWithoutPlayer, [volume, display]);
    assert.equal(next.Play, undefined);
    assert.equal(next.VolumeUp.source, BUTTON_SOURCE.user);
  });

  it("never overwrites existing activity mappings when editing", () => {
    const existing = {
      Play: {
        deviceId: "10",
        command: { name: "CustomPlay", functionId: 99 },
        hold: null,
        source: BUTTON_SOURCE.existing,
      },
    };
    const next = reconcileWizardButtons(existing, movieRoles, [player, volume, display]);
    assert.equal(next.Play.command.name, "CustomPlay");
    assert.equal(next.Play.source, BUTTON_SOURCE.existing);
    assert.ok(next.VolumeUp);
  });

  it("idempotent re-derivation leaves user and existing keys stable", () => {
    let buttons = {
      Play: {
        deviceId: "10",
        command: { name: "Play", functionId: 1 },
        hold: null,
        source: BUTTON_SOURCE.user,
      },
      Pause: {
        deviceId: "10",
        command: { name: "Pause", functionId: 2 },
        hold: null,
        source: BUTTON_SOURCE.existing,
      },
    };
    buttons = reconcileWizardButtons(buttons, movieRoles, [player, volume, display]);
    const again = reconcileWizardButtons(buttons, movieRoles, [player, volume, display]);
    assert.deepEqual(again.Play, buttons.Play);
    assert.deepEqual(again.Pause, buttons.Pause);
    assert.deepEqual(again.VolumeUp, buttons.VolumeUp);
  });
});

describe("reset and revert", () => {
  it("reset all drops user keys but keeps existing activity mappings", () => {
    const buttons = {
      Play: {
        deviceId: "10",
        command: { name: "Custom", functionId: 1 },
        hold: null,
        source: BUTTON_SOURCE.user,
      },
      Pause: {
        deviceId: "10",
        command: { name: "KeepMe", functionId: 2 },
        hold: null,
        source: BUTTON_SOURCE.existing,
      },
    };
    const next = resetWizardButtonsToDefaults(buttons, movieRoles, [player, volume, display]);
    assert.equal(next.Pause.command.name, "KeepMe");
    assert.equal(next.Play.command.name, "Play");
    assert.equal(next.Play.source, BUTTON_SOURCE.default);
  });

  it("per-key revert restores a default without touching other keys", () => {
    const buttons = {
      Play: {
        deviceId: "10",
        command: { name: "Custom", functionId: 1 },
        hold: null,
        source: BUTTON_SOURCE.user,
      },
      VolumeUp: {
        deviceId: "20",
        command: { name: "VolumeUp", functionId: 2 },
        hold: null,
        source: BUTTON_SOURCE.user,
      },
    };
    const next = revertWizardButtonToDefault(
      buttons,
      "Play",
      movieRoles,
      [player, volume, display],
    );
    assert.equal(next.Play.command.name, "Play");
    assert.equal(next.Play.source, BUTTON_SOURCE.default);
    assert.equal(next.VolumeUp.command.name, "VolumeUp");
    assert.equal(next.VolumeUp.source, BUTTON_SOURCE.user);
  });
});

describe("wizardButtonStats", () => {
  it("counts sources and assignable keys", () => {
    const stats = wizardButtonStats({
      Play: { command: { name: "Play" }, source: BUTTON_SOURCE.default },
      Pause: { command: { name: "Pause" }, source: BUTTON_SOURCE.user },
      Stop: { command: { name: "Stop" }, source: BUTTON_SOURCE.existing },
    });
    assert.equal(stats.mapped, 3);
    assert.equal(stats.defaults, 1);
    assert.equal(stats.user, 1);
    assert.equal(stats.existing, 1);
    assert.ok(stats.assignable >= 30);
  });
});

describe("defaults + buildActivityGraph", () => {
  it("emits only mapped buttons with actions from default draft", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const fixture = JSON.parse(
      readFileSync(join(root, "fixtures/activity-config.json"), "utf8"),
    );
    const devices = (fixture.deviceList.DevicesWithFeatures || []).map((e) => ({
      id: String(e.Device["Id-"]),
      name: e.Device.Label || e.Device.DeviceTypeDisplayName || String(e.Device["Id-"]),
      commands: (e.Commands || []).map((c) => ({
        name: c.Name,
        functionId: c["FunctionId-"],
      })),
    }));
    const roles = [
      { deviceId: "74521691", roleType: "DisplayActivityRole", input: "HDMI 1", powerDelay: "" },
      { deviceId: "66690268", roleType: "PlayMovieActivityRole", input: "", powerDelay: "" },
    ];
    const buttons = deriveDefaultButtons(roles, devices);
    assert.ok(Object.keys(buttons).length > 0, "fixture shield should yield defaults");

    const graph = buildActivityGraph({
      config: fixture,
      draft: { name: "Defaults Night", type: 2, roles, buttons },
      editId: null,
    });
    const map = graph.mapList.ButtonMaps.find(
      (m) => m.ButtonMapIdentifier === `16414Activity${graph.activityId}`,
    );
    assert.ok(map);
    assert.ok(map.Buttons.length > 0);
    for (const b of map.Buttons) {
      assert.ok(b.ButtonAction?.CommandName, "no action-less buttons");
      assert.equal(b.ButtonState, 1);
    }
  });
});
