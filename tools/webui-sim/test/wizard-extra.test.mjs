import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BUTTON_SOURCE,
  buildActivityGraph,
  draftButtonsFromMap,
  reconcileWizardButtons,
} from "../public/js/wizard-model.js";

function device(id, names) {
  return { id: String(id), name: `Device ${id}`, commands: names.map((n, i) => ({ name: n, functionId: 100 + i })) };
}
const player = device(10, ["Play", "Pause", "PowerToggle"]);
const volume = device(20, ["VolumeUp", "Mute"]);
const haLamp = device(99, ["PowerOn", "PowerOff", "PowerToggle", "BrightnessUp"]);
haLamp.isHa = true;

const roles = [
  { deviceId: "10", roleType: "PlayMovieActivityRole" },
  { deviceId: "20", roleType: "VolumeActivityRole" },
];

describe("reconcileWizardButtons extra controls (P06 #7 / P13)", () => {
  it("keeps non-member mappings flagged extra instead of dropping", () => {
    const buttons = {
      Play: { deviceId: "10", command: { name: "Play", functionId: 100 }, hold: null, source: BUTTON_SOURCE.existing },
      Red: { deviceId: "99", command: { name: "PowerToggle", functionId: 102 }, hold: null, source: BUTTON_SOURCE.user },
    };
    const next = reconcileWizardButtons(buttons, roles, [player, volume, haLamp]);
    assert.ok(next.Red, "non-member HA mapping survives");
    assert.equal(next.Red.extra, true);
    assert.equal(next.Play.extra, false);
    assert.equal(next.Red.source, BUTTON_SOURCE.user);
  });

  it("drops only devices gone from the hub, not non-members", () => {
    const buttons = {
      Play: { deviceId: "10", command: { name: "Play", functionId: 100 }, hold: null, source: BUTTON_SOURCE.user },
    };
    // Player still on hub but not in roles: kept as extra.
    const kept = reconcileWizardButtons(buttons, [{ deviceId: "20", roleType: "VolumeActivityRole" }], [player, volume]);
    assert.ok(kept.Play);
    assert.equal(kept.Play.extra, true);
    // Player gone from hub entirely: dropped.
    const dropped = reconcileWizardButtons(buttons, [{ deviceId: "20", roleType: "VolumeActivityRole" }], [volume]);
    assert.equal(dropped.Play, undefined);
  });

  it("fillDefaults=false never adds defaults (existing open)", () => {
    const next = reconcileWizardButtons({}, roles, [player, volume], { fillDefaults: false });
    assert.deepEqual(next, {});
    const withUser = reconcileWizardButtons(
      { Play: { deviceId: "10", command: { name: "Play", functionId: 100 }, hold: null, source: BUTTON_SOURCE.user } },
      roles, [player, volume], { fillDefaults: false },
    );
    assert.ok(withUser.Play);
    assert.equal(withUser.VolumeUp, undefined);
  });

  it("defaults still fill for new activities", () => {
    const next = reconcileWizardButtons({}, roles, [player, volume]);
    assert.ok(next.Play);
    assert.equal(next.Play.source, BUTTON_SOURCE.default);
  });

  it("preserves hold and double-press across reconcile", () => {
    const hold = { deviceId: "10", command: { name: "Pause", functionId: 101 } };
    const doublePress = { "DeviceId-": 10, __type: "ButtonCommandAction", CommandName: "Play", "FunctionId-": 100, EventType: 3 };
    const buttons = {
      Play: { deviceId: "10", command: { name: "Play", functionId: 100 }, hold, doublePress, source: BUTTON_SOURCE.existing },
    };
    const next = reconcileWizardButtons(buttons, roles, [player, volume]);
    assert.deepEqual(next.Play.hold, hold);
    assert.deepEqual(next.Play.doublePress, doublePress);
  });
});

describe("buildActivityGraph preserves extra + long + double + IDs (P06)", () => {
  it("keeps non-member hard keys and self-longs through a save", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const fixture = JSON.parse(readFileSync(join(root, "fixtures/activity-config.json"), "utf8"));
    const activityId = String(fixture.activityList.Activities[0]["Id-"]);
    const existingMap = fixture.mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === `16414Activity${activityId}`);
    const beforeIds = new Map(existingMap.Buttons.map((b) => [b.ButtonKey, b.ButtonId]));
    const beforeRoles = new Map(fixture.activityList.Activities[0].Roles.map((r) => [`${r["DeviceId-"]}|${r.__type}`, r["Id-"]]));

    // Draft from existing, then add an extra HA key with self-long + double.
    const draftButtons = draftButtonsFromMap(existingMap);
    const firstKey = Object.keys(draftButtons)[0];
    draftButtons[firstKey].hold = { deviceId: draftButtons[firstKey].deviceId, command: { ...draftButtons[firstKey].command } };
    draftButtons[firstKey].doublePress = { "DeviceId-": Number(draftButtons[firstKey].deviceId), __type: "ButtonCommandAction", CommandName: "Play", "FunctionId-": 0, EventType: 3 };
    draftButtons.Red = { deviceId: "78760839", command: { name: "PowerOn", functionId: 1 }, hold: null, source: BUTTON_SOURCE.user };

    const roles = fixture.activityList.Activities[0].Roles.map((r) => ({
      deviceId: String(r["DeviceId-"]), roleType: String(r.__type), input: r.SelectedInput?.Name ?? "", powerDelay: r.NextDevicePowerOnDelay ?? "",
    }));
    const graph = buildActivityGraph({
      config: fixture,
      draft: { name: "Keep", type: 2, roles, buttons: draftButtons },
      editId: activityId,
    });
    const after = graph.mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === `16414Activity${activityId}`);
    // Extra survives.
    assert.ok(after.Buttons.some((b) => b.ButtonKey === "Red"));
    // Self-long survives.
    const kept = after.Buttons.find((b) => b.ButtonKey === firstKey);
    assert.ok(kept.ButtonLongPressAction);
    assert.equal(kept.ButtonLongPressAction.EventType, 2);
    // Double survives.
    assert.ok(kept.ButtonDoublePressAction);
    // ButtonIds reused for unchanged keys.
    for (const b of after.Buttons) {
      if (beforeIds.has(b.ButtonKey) && b.ButtonKey !== "Red") {
        assert.equal(b.ButtonId, beforeIds.get(b.ButtonKey), `ButtonId reused for ${b.ButtonKey}`);
      }
    }
    // Role IDs reused.
    for (const r of graph.activityList.Activities.find((a) => String(a["Id-"]) === activityId).Roles) {
      const key = `${r["DeviceId-"]}|${r.__type}`;
      if (beforeRoles.has(key)) assert.equal(r["Id-"], beforeRoles.get(key), `Role Id reused for ${key}`);
    }
  });
});
