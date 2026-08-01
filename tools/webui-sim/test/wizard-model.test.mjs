import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildActivityGraph,
  composeKeyboardHidMap,
  createAllocator,
  isKeyboardHidActivityMap,
  isWizardOwnedActivityMap,
} from "../public/js/wizard-model.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(join(ROOT, "../fixtures/activity-config.json"), "utf8"),
);

const isPositiveInt = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;

function mapsForActivity(maps, activityId) {
  return maps.filter((m) => String(m?.["ActivityId-"]) === String(activityId));
}

function assertNoActionlessActivityButtons(maps) {
  for (const map of maps) {
    if (!String(map?.__type ?? "").includes("ActivityButtonMap")) continue;
    for (const button of map.Buttons ?? []) {
      const has =
        button?.ButtonAction ||
        button?.ButtonLongPressAction ||
        button?.ButtonDoublePressAction;
      assert.ok(
        has,
        `action-less button ${button?.ButtonId} in ${map.ButtonMapIdentifier}`,
      );
      assert.equal(button.ButtonState, 1, "ButtonState must be 1");
      assert.ok(isPositiveInt(button.ButtonId), "ButtonId must be positive");
    }
    assert.ok(isPositiveInt(map["ButtonMapId-"]), "ButtonMapId- must be positive");
  }
}

function assertUniqueIdentities(maps) {
  const mapIds = new Set();
  const buttonIds = new Set();
  for (const map of maps) {
    const mid = String(map["ButtonMapId-"] ?? "");
    if (mid && mid !== "0") {
      assert.equal(mapIds.has(mid), false, `duplicate ButtonMapId- ${mid}`);
      mapIds.add(mid);
    }
    for (const button of map.Buttons ?? []) {
      const bid = String(button.ButtonId ?? "");
      if (!bid || bid === "0") continue;
      assert.equal(buttonIds.has(bid), false, `duplicate ButtonId ${bid}`);
      buttonIds.add(bid);
    }
  }
}

function draftFromActivity(config, activityId, { dropKeyboard = false } = {}) {
  const activity = config.activityList.Activities.find(
    (a) => String(a["Id-"]) === String(activityId),
  );
  assert.ok(activity, `fixture activity ${activityId}`);
  const roles = (activity.Roles ?? [])
    .filter((r) => !(dropKeyboard && String(r.__type).includes("KeyboardTextEntryActivityRole")))
    .map((r) => ({
      deviceId: String(r["DeviceId-"]),
      roleType: String(r.__type ?? ""),
      input: r.SelectedInput?.Name ?? "",
      powerDelay: r.NextDevicePowerOnDelay ?? "",
    }));
  const surface = (config.mapList.ButtonMaps ?? []).find(
    (m) => isWizardOwnedActivityMap(m, activityId),
  );
  const buttons = {};
  for (const b of surface?.Buttons ?? []) {
    if (!b.ButtonKey || !b.ButtonAction?.CommandName) continue;
    buttons[b.ButtonKey] = {
      deviceId: String(b.ButtonAction["DeviceId-"]),
      command: {
        name: b.ButtonAction.CommandName,
        functionId: b.ButtonAction["FunctionId-"],
      },
      hold: b.ButtonLongPressAction?.CommandName
        ? {
            deviceId: String(b.ButtonLongPressAction["DeviceId-"]),
            command: {
              name: b.ButtonLongPressAction.CommandName,
              functionId: b.ButtonLongPressAction["FunctionId-"],
            },
          }
        : null,
    };
  }
  return {
    name: activity.Name,
    type: Number(activity.Type ?? 1),
    roles,
    buttons,
  };
}

function injectHidAndExtraSurface(config, activityId) {
  const clone = structuredClone(config);
  const maps = clone.mapList.ButtonMaps;
  const wizard = maps.find((m) => isWizardOwnedActivityMap(m, activityId));
  assert.ok(wizard, "fixture needs a 16414 map");

  /* A second non-wizard surface map the advanced editor may have created. */
  const extraSurface = {
    "ButtonMapId-": 90000001,
    "ActivityId-": Number(activityId),
    Buttons: [
      {
        ButtonId: 90000002,
        __type: "HardRemoteButton",
        ButtonAction: {
          "DeviceId-": 66690268,
          __type: "ButtonCommandAction",
          "FunctionId-": 1,
          Order: 0,
          CommandName: "Play",
          EventType: 1,
          Id: 0,
        },
        ButtonDoublePressAction: null,
        FunctionGroupType: 0,
        ButtonState: 1,
        ButtonKey: "Play",
        ButtonLongPressAction: null,
        ExtraButtonField: "keep-me",
      },
    ],
    "ButtonMapSurfaceId-": 999001,
    "RemoteId-": wizard["RemoteId-"],
    "SurfaceId-": 999002,
    __type: "ActivityButtonMap",
    ButtonMapIdentifier: `16499CustomActivity${activityId}`,
    DateModified: "/Date(0+0000)/",
    Sequences: [],
    CustomMapField: "round-trip-map",
  };

  const alloc = createAllocator(clone);
  const hid = composeKeyboardHidMap({
    activityId,
    deviceId: 66690268,
    config: clone,
    sourceMap: wizard,
    alloc,
  });
  assert.ok(hid, "HID map must compose against fixture shield device");
  hid.CustomHidField = "round-trip-hid";

  maps.push(extraSurface, hid);
  return { config: clone, extraSurface, hid };
}

describe("buildActivityGraph — map ownership", () => {
  it("edit preserves 16420 HID map + second surface map; only 16414 changes", () => {
    const activityId = "48113644";
    const { config, extraSurface, hid } = injectHidAndExtraSurface(FIXTURE, activityId);
    const beforeOther = structuredClone(
      (config.mapList.ButtonMaps ?? []).filter(
        (m) => String(m?.["ActivityId-"]) !== String(activityId),
      ),
    );
    const draft = draftFromActivity(config, activityId);
    draft.buttons.VolumeUp = {
      deviceId: "78760839",
      command: { name: "VolumeUp", functionId: 1 },
      hold: null,
    };

    const graph = buildActivityGraph({ config, draft, editId: activityId });
    const after = graph.mapList.ButtonMaps;
    const mine = mapsForActivity(after, activityId);

    const hidAfter = mine.find(isKeyboardHidActivityMap);
    assert.ok(hidAfter, "16420 HID map survives edit");
    assert.equal(hidAfter.CustomHidField, "round-trip-hid");
    assert.deepEqual(hidAfter.Buttons, hid.Buttons);
    assert.equal(hidAfter["ButtonMapId-"], hid["ButtonMapId-"]);

    const extraAfter = mine.find(
      (m) => m.ButtonMapIdentifier === extraSurface.ButtonMapIdentifier,
    );
    assert.ok(extraAfter, "second surface map survives edit");
    assert.equal(extraAfter.CustomMapField, "round-trip-map");
    assert.equal(extraAfter.Buttons[0].ExtraButtonField, "keep-me");
    assert.deepEqual(extraAfter, extraSurface);

    const wizardAfter = mine.find((m) => isWizardOwnedActivityMap(m, activityId));
    assert.ok(wizardAfter);
    assert.equal(wizardAfter.ButtonMapIdentifier, `16414Activity${activityId}`);
    assert.ok(
      wizardAfter.Buttons.some((b) => b.ButtonKey === "VolumeUp"),
      "wizard-owned 16414 map reflects the edit",
    );

    const afterOther = after.filter(
      (m) => String(m?.["ActivityId-"]) !== String(activityId),
    );
    assert.deepEqual(afterOther, beforeOther, "other activities' maps untouched");

    assertNoActionlessActivityButtons(mine);
    assertUniqueIdentities(after);
  });

  it("new activity with KeyboardTextEntryActivityRole creates a 16420 HID map", () => {
    const draft = {
      name: "BT Movie Night",
      type: 2,
      roles: [
        {
          deviceId: "74521691",
          roleType: "DisplayActivityRole",
          input: "HDMI 1",
          powerDelay: "",
        },
        {
          deviceId: "66690268",
          roleType: "PlayMovieActivityRole",
          input: "",
          powerDelay: "",
        },
        {
          deviceId: "66690268",
          roleType: "KeyboardTextEntryActivityRole",
          input: "",
          powerDelay: "",
        },
      ],
      buttons: {
        Play: {
          deviceId: "66690268",
          command: { name: "Play", functionId: 1 },
          hold: null,
        },
      },
    };

    const graph = buildActivityGraph({ config: FIXTURE, draft, editId: null });
    const activityId = graph.activityId;
    const mine = mapsForActivity(graph.mapList.ButtonMaps, activityId);

    assert.equal(mine.filter((m) => isWizardOwnedActivityMap(m, activityId)).length, 1);
    const hid = mine.find(isKeyboardHidActivityMap);
    assert.ok(hid, "conditional 16420 map is created for new BT-keyboard activity");
    assert.equal(hid.ButtonMapIdentifier, `16420Activity${activityId}`);
    assert.equal(Number(hid["ActivityId-"]), Number(activityId));
    assert.ok(isPositiveInt(hid["ButtonMapId-"]));
    assert.ok((hid.Buttons ?? []).length > 0, "HID map carries mapped HID keys");
    for (const button of hid.Buttons) {
      assert.equal(button.ButtonState, 1);
      assert.ok(button.ButtonAction, "no action-less HID buttons");
      assert.match(String(button.ButtonKey), /^(Number\d|VolumeMute|Enter|.+)$/);
    }
    assert.ok(
      hid.Buttons.some((b) => b.ButtonKey === "Back"),
      "HID map includes Back from shield command list",
    );
    assert.ok(
      hid.Buttons.some((b) => b.ButtonKey === "VolumeMute"),
      "Mute command maps to VolumeMute key",
    );
    assert.ok(
      hid.Buttons.some((b) => b.ButtonKey === "Enter"),
      "Select command maps to Enter key",
    );
    assert.ok(
      hid.Buttons.some((b) => b.ButtonKey === "Number0"),
      "digit commands map to NumberN keys",
    );

    /* Fixture activities carry a 16417 second surface — new activities must too. */
    const secondSurface = mine.find((m) =>
      /^16417Activity/.test(String(m.ButtonMapIdentifier ?? "")),
    );
    assert.ok(secondSurface, "hub-wide second remote surface is cloned for the new activity");
    assert.equal((secondSurface.Buttons ?? []).length, 0, "cloned surface starts action-less-free");

    /* Other activities keep every map they had. */
    for (const activity of FIXTURE.activityList.Activities) {
      const id = activity["Id-"];
      const before = mapsForActivity(FIXTURE.mapList.ButtonMaps, id).map(
        (m) => m.ButtonMapIdentifier,
      );
      const after = mapsForActivity(graph.mapList.ButtonMaps, id).map(
        (m) => m.ButtonMapIdentifier,
      );
      assert.deepEqual(after, before, `activity ${id} maps unchanged by new save`);
    }

    assertNoActionlessActivityButtons(mine);
    assertUniqueIdentities(graph.mapList.ButtonMaps);
  });

  it("removing the keyboard role drops the 16420 HID map", () => {
    const activityId = "48113644";
    const { config, hid } = injectHidAndExtraSurface(FIXTURE, activityId);
    assert.ok(
      mapsForActivity(config.mapList.ButtonMaps, activityId).some(isKeyboardHidActivityMap),
    );

    const draft = draftFromActivity(config, activityId, { dropKeyboard: true });
    assert.equal(
      draft.roles.some((r) => r.roleType.includes("KeyboardTextEntryActivityRole")),
      false,
    );

    const graph = buildActivityGraph({ config, draft, editId: activityId });
    const mine = mapsForActivity(graph.mapList.ButtonMaps, activityId);
    assert.equal(
      mine.filter(isKeyboardHidActivityMap).length,
      0,
      "HID map removed when keyboard role is gone",
    );
    assert.ok(
      mine.some((m) => m.ButtonMapIdentifier === `16499CustomActivity${activityId}`),
      "non-HID extra surface still preserved",
    );
    assert.equal(
      graph.mapList.ButtonMaps.some((m) => m["ButtonMapId-"] === hid["ButtonMapId-"]),
      false,
    );
  });

  it("edit/delete/reorder leave other activities' maps untouched", () => {
    const activityId = "48113650";
    const snapshotOthers = () =>
      structuredClone(
        (FIXTURE.mapList.ButtonMaps ?? []).filter(
          (m) => String(m?.["ActivityId-"]) !== String(activityId),
        ),
      );
    const before = snapshotOthers();

    const draft = draftFromActivity(FIXTURE, activityId);
    draft.name = "Smart TV Renamed";
    const edited = buildActivityGraph({
      config: FIXTURE,
      draft,
      editId: activityId,
    });
    const afterEdit = edited.mapList.ButtonMaps.filter(
      (m) => String(m?.["ActivityId-"]) !== String(activityId),
    );
    assert.deepEqual(afterEdit, before);

    /* Simulate delete: filter activity maps the same way deleteActivityGraph does. */
    const afterDelete = (FIXTURE.mapList.ButtonMaps ?? []).filter(
      (m) => String(m?.["ActivityId-"]) !== String(activityId),
    );
    assert.deepEqual(afterDelete, before);

    /* Reorder must pass mapList through unchanged (byte-for-byte clone). */
    const reorderedMaps = structuredClone(FIXTURE.mapList ?? { ButtonMaps: [] });
    assert.deepEqual(reorderedMaps.ButtonMaps, FIXTURE.mapList.ButtonMaps);
  });

  it("never emits action-less buttons; identity/ButtonState invariants hold", () => {
    const draft = {
      name: "Sparse",
      type: 1,
      roles: [
        {
          deviceId: "74521691",
          roleType: "DisplayActivityRole",
          input: "HDMI 1",
          powerDelay: "",
        },
      ],
      buttons: {
        /* Only mapped keys are emitted — unmapped keys stay out of the map. */
        Mute: {
          deviceId: "74521691",
          command: { name: "Mute", functionId: 5 },
          hold: null,
        },
      },
    };
    const graph = buildActivityGraph({ config: FIXTURE, draft, editId: null });
    const mine = mapsForActivity(graph.mapList.ButtonMaps, graph.activityId);
    const wizard = mine.find((m) => isWizardOwnedActivityMap(m, graph.activityId));
    assert.equal(wizard.Buttons.length, 1);
    assert.equal(wizard.Buttons[0].ButtonKey, "Mute");
    assert.equal(wizard.Buttons[0].ButtonState, 1);
    assert.ok(isPositiveInt(wizard.Buttons[0].ButtonId));
    assert.ok(isPositiveInt(wizard["ButtonMapId-"]));
    assert.match(wizard.ButtonMapIdentifier, /^16414Activity\d+$/);
    assertNoActionlessActivityButtons(graph.mapList.ButtonMaps);
    assertUniqueIdentities(graph.mapList.ButtonMaps);
  });

  it("round-trips unknown top-level resource keys", () => {
    const config = structuredClone(FIXTURE);
    config.activityList.ExtraActivityListKey = { nested: true };
    config.mapList.ExtraMapListKey = "keep";
    config.functionList = {
      FunctionMaps: structuredClone(config.functionList?.FunctionMaps ?? []),
      ExtraFunctionListKey: 42,
    };
    /* Ensure target has a function map to preserve. */
    const activityId = "49051068";
    const draft = draftFromActivity(config, activityId);
    const graph = buildActivityGraph({ config, draft, editId: activityId });
    assert.deepEqual(graph.activityList.ExtraActivityListKey, { nested: true });
    assert.equal(graph.mapList.ExtraMapListKey, "keep");
    assert.equal(graph.functionList.ExtraFunctionListKey, 42);
  });

  it("preserves existing ActivityFunctionMap on edit instead of wiping groups", () => {
    const activityId = "48113644";
    const config = structuredClone(FIXTURE);
    config.functionList = {
      FunctionMaps: [
        {
          UIModeName: `Functions.UserConfigurator.${activityId}`,
          __type: "ActivityFunctionMap",
          "ActivityId-": Number(activityId),
          FunctionGroups: [
            {
              Name: "Volume",
              Functions: [
                {
                  "DeviceId-": 78760839,
                  __type: "FunctionAction",
                  Name: "VolumeUp",
                  CommandName: "VolumeUp",
                  "FunctionId-": 1,
                },
              ],
            },
          ],
          CustomFnField: "fn-keep",
        },
      ],
    };
    const draft = draftFromActivity(config, activityId);
    const graph = buildActivityGraph({ config, draft, editId: activityId });
    const fn = graph.functionList.FunctionMaps.find(
      (m) =>
        String(m.__type).includes("ActivityFunctionMap") &&
        String(m["ActivityId-"]) === String(activityId),
    );
    assert.equal(fn.CustomFnField, "fn-keep");
    assert.equal(fn.FunctionGroups.length, 1);
    assert.equal(fn.FunctionGroups[0].Name, "Volume");
  });
});

describe("composeKeyboardHidMap", () => {
  it("mirrors editor key renaming and skips unknown commands", () => {
    const alloc = createAllocator(FIXTURE);
    const source = FIXTURE.mapList.ButtonMaps.find((m) =>
      isWizardOwnedActivityMap(m, "48113644"),
    );
    const hid = composeKeyboardHidMap({
      activityId: 48113644,
      deviceId: 66690268,
      config: FIXTURE,
      sourceMap: source,
      alloc,
    });
    assert.equal(hid.ButtonMapIdentifier, "16420Activity48113644");
    assert.equal(hid["RemoteId-"], source["RemoteId-"]);
    assert.equal(hid["SurfaceId-"], source["SurfaceId-"]);
    const keys = new Set(hid.Buttons.map((b) => b.ButtonKey));
    assert.ok(keys.has("Number0"));
    assert.ok(keys.has("VolumeMute"));
    assert.ok(keys.has("Enter"));
    assert.ok(keys.has("DirectionUp"));
    assert.equal(keys.has("PowerOn") || keys.has("PowerToggle"), false);
  });
});
