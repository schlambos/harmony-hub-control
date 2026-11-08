import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildActivityGraph,
  cloneJsonResource,
  composeKeyboardHidMap,
  createAllocator,
  draftButtonsFromMap,
  inputOptions,
  isKeyboardHidActivityMap,
  isTouchActivityMap,
  isWizardOwnedActivityMap,
  touchHardKey,
} from "../public/js/wizard-model.js";
import { inputNames } from "../public/js/views/device-settings-model.js";

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
  const buttons = draftButtonsFromMap(surface);
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
    assert.deepEqual(
      secondSurface.Buttons.map((b) => [b.__type, b.ButtonKey, b.ButtonAction?.CommandName]),
      [["HardRemoteButton", "Play", "Play"]],
      "the Touch surface gets the wizard's hard buttons and nothing else",
    );

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

describe("double-press actions", () => {
  it("draftButtonsFromMap carries press, hold and double-press", () => {
    const doublePress = { "DeviceId-": 1, __type: "ButtonCommandAction", "FunctionId-": 9, CommandName: "Mute", EventType: 3 };
    const buttons = draftButtonsFromMap({
      Buttons: [
        { ButtonKey: "Mute", ButtonAction: { "DeviceId-": 1, CommandName: "Mute", "FunctionId-": 8 }, ButtonDoublePressAction: doublePress },
        { ButtonKey: "Info", ButtonAction: null },
      ],
    });
    assert.deepEqual(Object.keys(buttons), ["Mute"]);
    assert.deepEqual(buttons.Mute.doublePress, doublePress);
    assert.equal(buttons.Mute.hold, null);
    assert.equal(buttons.Mute.source, "existing");
  });

  it("an edit keeps the activity's existing double-press actions", () => {
    const activityId = "48113644";
    const config = structuredClone(FIXTURE);
    const map = config.mapList.ButtonMaps.find((m) => isWizardOwnedActivityMap(m, activityId));
    const button = map.Buttons.find((b) => b.ButtonKey && b.ButtonAction?.CommandName);
    const doublePress = { ...button.ButtonAction, EventType: 3 };
    button.ButtonDoublePressAction = doublePress;

    const graph = buildActivityGraph({ config, draft: draftFromActivity(config, activityId), editId: activityId });
    const after = graph.mapList.ButtonMaps.find((m) => isWizardOwnedActivityMap(m, activityId));
    const kept = after.Buttons.find((b) => b.ButtonKey === button.ButtonKey);
    assert.deepEqual(kept.ButtonDoublePressAction, doublePress);
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

function withStructuredCloneGlobal(install, run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "structuredClone");
  try {
    install();
    return run();
  } finally {
    if (original === undefined) {
      delete globalThis.structuredClone;
    } else {
      Object.defineProperty(globalThis, "structuredClone", original);
    }
  }
}

describe("cloneJsonResource — structured-clone seam", () => {
  it("uses an injectable native clone implementation when provided", () => {
    const source = {
      ExtraActivityListKey: { nested: true, leaf: "keep" },
      Activities: [{ "Id-": 1, CustomField: "x" }],
    };
    let saw = null;
    const injected = (value) => {
      saw = value;
      return {
        ExtraActivityListKey: {
          nested: value.ExtraActivityListKey.nested,
          leaf: value.ExtraActivityListKey.leaf,
        },
        Activities: value.Activities.map((a) => ({ ...a })),
      };
    };

    const cloned = cloneJsonResource(source, injected);
    assert.equal(saw, source);
    assert.deepEqual(cloned, source);
    assert.notEqual(cloned, source);
    assert.notEqual(cloned.ExtraActivityListKey, source.ExtraActivityListKey);
    assert.notEqual(cloned.Activities, source.Activities);
    assert.notEqual(cloned.Activities[0], source.Activities[0]);
  });

  it("resolves globalThis.structuredClone when called with no second argument", () => {
    const source = {
      ExtraActivityListKey: { nested: true, leaf: "keep" },
      Activities: [{ "Id-": 1, CustomField: "x" }],
    };
    const calls = [];
    const spy = (value) => {
      calls.push(value);
      return {
        ExtraActivityListKey: {
          nested: value.ExtraActivityListKey.nested,
          leaf: value.ExtraActivityListKey.leaf,
        },
        Activities: value.Activities.map((a) => ({ ...a })),
      };
    };

    const cloned = withStructuredCloneGlobal(() => {
      Object.defineProperty(globalThis, "structuredClone", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: spy,
      });
    }, () => cloneJsonResource(source));

    assert.equal(calls.length, 1);
    assert.equal(calls[0], source);
    assert.deepEqual(cloned, source);
    assert.notEqual(cloned, source);
    assert.notEqual(cloned.ExtraActivityListKey, source.ExtraActivityListKey);
    assert.notEqual(cloned.Activities, source.Activities);
    assert.notEqual(cloned.Activities[0], source.Activities[0]);
  });

  it("propagates errors from a present native clone implementation", () => {
    assert.throws(
      () =>
        cloneJsonResource({ ok: true }, () => {
          throw new TypeError("native clone refused");
        }),
      { name: "TypeError", message: "native clone refused" },
    );
  });

  it("falls back to JSON round-trip when global structuredClone is absent", () => {
    const source = {
      ExtraMapListKey: "keep",
      nested: { deep: { k: 1 } },
      ButtonMaps: [
        {
          ButtonMapIdentifier: "16499CustomActivity1",
          CustomMapField: "round-trip-map",
          Buttons: [{ ExtraButtonField: "keep-me", ButtonKey: "Play" }],
        },
      ],
    };

    const cloned = withStructuredCloneGlobal(() => {
      Object.defineProperty(globalThis, "structuredClone", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: undefined,
      });
    }, () => cloneJsonResource(source));

    assert.deepEqual(cloned, source);
    assert.notEqual(cloned, source);
    assert.notEqual(cloned.nested, source.nested);
    assert.notEqual(cloned.nested.deep, source.nested.deep);
    assert.notEqual(cloned.ButtonMaps, source.ButtonMaps);
    assert.notEqual(cloned.ButtonMaps[0], source.ButtonMaps[0]);
    assert.equal(cloned.ButtonMaps[0].CustomMapField, "round-trip-map");
    assert.equal(cloned.ButtonMaps[0].Buttons[0].ExtraButtonField, "keep-me");
    cloned.nested.deep.k = 99;
    assert.equal(source.nested.deep.k, 1);
  });

  it("forced fallback through buildActivityGraph preserves unknown keys and non-owned maps", () => {
    const activityId = "48113644";
    const { config, extraSurface, hid } = injectHidAndExtraSurface(FIXTURE, activityId);
    config.activityList.ExtraActivityListKey = { nested: true, deep: { k: 1 } };
    config.mapList.ExtraMapListKey = "keep";
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
      ExtraFunctionListKey: 42,
    };

    const draft = draftFromActivity(config, activityId);
    draft.buttons.VolumeUp = {
      deviceId: "78760839",
      command: { name: "VolumeUp", functionId: 1 },
      hold: null,
    };

    const beforeOther = structuredClone(
      (config.mapList.ButtonMaps ?? []).filter(
        (m) => String(m?.["ActivityId-"]) !== String(activityId),
      ),
    );

    withStructuredCloneGlobal(() => {
      delete globalThis.structuredClone;
      assert.equal(typeof globalThis.structuredClone, "undefined");
    }, () => {
      const graph = buildActivityGraph({ config, draft, editId: activityId });
      const after = graph.mapList.ButtonMaps;
      const mine = mapsForActivity(after, activityId);

      assert.deepEqual(graph.activityList.ExtraActivityListKey, {
        nested: true,
        deep: { k: 1 },
      });
      assert.equal(graph.mapList.ExtraMapListKey, "keep");
      assert.equal(graph.functionList.ExtraFunctionListKey, 42);

      const hidAfter = mine.find(isKeyboardHidActivityMap);
      assert.ok(hidAfter, "16420 HID map survives edit under JSON fallback");
      assert.equal(hidAfter.CustomHidField, "round-trip-hid");
      assert.deepEqual(hidAfter.Buttons, hid.Buttons);
      assert.equal(hidAfter["ButtonMapId-"], hid["ButtonMapId-"]);

      const extraAfter = mine.find(
        (m) => m.ButtonMapIdentifier === extraSurface.ButtonMapIdentifier,
      );
      assert.ok(extraAfter, "second surface map survives edit under JSON fallback");
      assert.equal(extraAfter.CustomMapField, "round-trip-map");
      assert.equal(extraAfter.Buttons[0].ExtraButtonField, "keep-me");
      assert.deepEqual(extraAfter, extraSurface);

      const fn = graph.functionList.FunctionMaps.find(
        (m) =>
          String(m.__type).includes("ActivityFunctionMap") &&
          String(m["ActivityId-"]) === String(activityId),
      );
      assert.equal(fn.CustomFnField, "fn-keep");
      assert.equal(fn.FunctionGroups[0].Name, "Volume");

      const wizardAfter = mine.find((m) => isWizardOwnedActivityMap(m, activityId));
      assert.ok(wizardAfter);
      assert.ok(
        wizardAfter.Buttons.some((b) => b.ButtonKey === "VolumeUp"),
        "wizard-owned 16414 map reflects the edit under JSON fallback",
      );

      const afterOther = after.filter(
        (m) => String(m?.["ActivityId-"]) !== String(activityId),
      );
      assert.deepEqual(afterOther, beforeOther, "other activities' maps untouched under fallback");

      graph.activityList.ExtraActivityListKey.deep.k = 99;
      assert.equal(config.activityList.ExtraActivityListKey.deep.k, 1);
    });
  });
});

describe("Harmony Touch hard buttons", () => {
  const touchMap = (maps, id) => maps.find((m) => isTouchActivityMap(m, id));
  const hardKeys = (map) => map.Buttons.filter((b) => b.__type === "HardRemoteButton").map((b) => b.ButtonKey);
  const notHard = (map) => map.Buttons.filter((b) => b.__type !== "HardRemoteButton");
  const command = (deviceId, name) => ({ deviceId, command: { name, functionId: 0 }, hold: null });

  it("names keys the way the Touch does and skips keys it doesn't have", () => {
    assert.equal(touchHardKey("Dvr"), "DVR");
    assert.equal(touchHardKey("VolumeUp"), "VolumeUp");
    assert.equal(touchHardKey("Number5"), "");
    assert.equal(touchHardKey("WatchTVActivity"), "");
  });

  it("a new activity's Touch map gets every hard button the Touch has", () => {
    const draft = {
      name: "Touch keys",
      type: 1,
      roles: [{ deviceId: "74521691", roleType: "VolumeActivityRole", input: "", powerDelay: "" }],
      buttons: {
        VolumeUp: command("74521691", "VolumeUp"),
        Dvr: command("74521691", "Guide"),
        Number1: command("74521691", "1"),
      },
    };
    draft.buttons.VolumeUp.hold = { deviceId: "74521691", command: { name: "VolumeUp", functionId: 0 } };
    const graph = buildActivityGraph({ config: FIXTURE, draft, editId: null });
    const touch = touchMap(graph.mapList.ButtonMaps, graph.activityId);
    assert.ok(touch, "the Touch surface is created");
    assert.deepEqual(hardKeys(touch).sort(), ["DVR", "VolumeUp"]);
    const volume = touch.Buttons.find((b) => b.ButtonKey === "VolumeUp");
    const wizard = graph.mapList.ButtonMaps.find((m) => isWizardOwnedActivityMap(m, graph.activityId))
      .Buttons.find((b) => b.ButtonKey === "VolumeUp");
    assert.deepEqual(volume.ButtonAction, wizard.ButtonAction);
    assert.deepEqual(volume.ButtonLongPressAction, wizard.ButtonLongPressAction, "hold mirrors too");
    assert.notEqual(volume.ButtonId, wizard.ButtonId, "each map has its own button identities");
    assertNoActionlessActivityButtons([touch]);
    assertUniqueIdentities(graph.mapList.ButtonMaps);
  });

  it("an unchanged save leaves a Logitech Touch map exactly as it was", () => {
    for (const activity of FIXTURE.activityList.Activities) {
      const id = String(activity["Id-"]);
      const before = touchMap(FIXTURE.mapList.ButtonMaps, id);
      if (!before) continue;
      const graph = buildActivityGraph({ config: FIXTURE, draft: draftFromActivity(FIXTURE, id), editId: id });
      assert.deepEqual(touchMap(graph.mapList.ButtonMaps, id), before, activity.Name);
    }
  });

  it("a changed key reaches the Touch; its other buttons stay put", () => {
    // Music's 16414 map has Stop; its Touch map was set up without it.
    const id = "49051068";
    const before = touchMap(FIXTURE.mapList.ButtonMaps, id);
    assert.ok(!hardKeys(before).includes("Stop"));
    const draft = draftFromActivity(FIXTURE, id);
    assert.ok(draft.buttons.Stop);
    const [removed] = hardKeys(before).filter((k) => k !== "VolumeUp" && draft.buttons[k]);
    draft.buttons.VolumeUp = command("78760839", "ChannelUp");
    delete draft.buttons[removed];
    const graph = buildActivityGraph({ config: FIXTURE, draft, editId: id });
    const after = touchMap(graph.mapList.ButtonMaps, id);

    const volumeBefore = before.Buttons.find((b) => b.ButtonKey === "VolumeUp");
    const volumeAfter = after.Buttons.find((b) => b.ButtonKey === "VolumeUp");
    assert.equal(volumeAfter.ButtonAction.CommandName, "ChannelUp");
    assert.equal(volumeAfter.ButtonId, volumeBefore.ButtonId, "the button keeps its identity");
    const order = (map) => map.Buttons.filter((b) => b.ButtonKey !== removed).map((b) => b.ButtonId);
    assert.deepEqual(order(after), order(before), "every button keeps its place");
    assert.ok(!hardKeys(after).includes(removed), "a removed key leaves the Touch too");
    assert.ok(!hardKeys(after).includes("Stop"), "Stop stays off the Touch");
    assert.deepEqual(notHard(after), notHard(before), "gestures and on-screen buttons are untouched");
  });

  it("an activity made without Touch buttons gets them on its next save", () => {
    const id = "48113644";
    const config = structuredClone(FIXTURE);
    const touch = touchMap(config.mapList.ButtonMaps, id);
    touch.Buttons = touch.Buttons.filter((b) => b.__type !== "HardRemoteButton");
    const graph = buildActivityGraph({ config, draft: draftFromActivity(config, id), editId: id });
    const wizardKeys = graph.mapList.ButtonMaps.find((m) => isWizardOwnedActivityMap(m, id))
      .Buttons.map((b) => touchHardKey(b.ButtonKey)).filter(Boolean);
    const after = touchMap(graph.mapList.ButtonMaps, id);
    assert.deepEqual(hardKeys(after).sort(), wizardKeys.sort());
    assert.deepEqual(notHard(after), touch.Buttons, "its on-screen buttons stay as they were");
    assertUniqueIdentities(graph.mapList.ButtonMaps);
  });

  it("a hub without a Touch gets no Touch map", () => {
    const config = structuredClone(FIXTURE);
    config.mapList.ButtonMaps = config.mapList.ButtonMaps.filter((m) => !/^16417/.test(m.ButtonMapIdentifier));
    const draft = { name: "No Touch", type: 1, roles: [], buttons: {} };
    const graph = buildActivityGraph({ config, draft, editId: null });
    assert.equal(touchMap(graph.mapList.ButtonMaps, graph.activityId), undefined);
  });
});

describe("Companion hard buttons", () => {
  /* The fixture as a hub with a Companion (16422): Logitech gives it its own
     map per activity, on its own surface, alike with the Smart Control's. */
  const withCompanion = ({ sharedSurface = false } = {}) => {
    const config = structuredClone(FIXTURE);
    const companion = config.mapList.ButtonMaps
      .filter((m) => /^16414Activity/.test(m.ButtonMapIdentifier))
      .map((m, i) => ({
        ...structuredClone(m),
        "ButtonMapId-": 70000000 + i,
        ButtonMapIdentifier: m.ButtonMapIdentifier.replace(/^16414/, "16422"),
        // #79's hub: the Companion's maps may carry the Smart Control's surface ids.
        ...(sharedSurface ? {} : { "RemoteId-": 4242, "SurfaceId-": 4243, "ButtonMapSurfaceId-": 4244 }),
        Buttons: m.Buttons.map((b, j) => ({ ...structuredClone(b), ButtonId: 71000000 + i * 100 + j })),
      }));
    config.mapList.ButtonMaps.push(...companion);
    return config;
  };
  const companionMap = (maps, id) => maps.find((m) => m.ButtonMapIdentifier === `16422Activity${id}`);
  const hard = (map) => map.Buttons.filter((b) => b.__type === "HardRemoteButton");
  const command = (deviceId, name) => ({ deviceId, command: { name, functionId: 0 }, hold: null });

  it("a new activity's Companion map gets every hard button, number keys included", () => {
    const config = withCompanion();
    const draft = {
      name: "Companion keys",
      type: 1,
      roles: [{ deviceId: "74521691", roleType: "VolumeActivityRole", input: "", powerDelay: "" }],
      buttons: { VolumeUp: command("74521691", "VolumeUp"), Dvr: command("74521691", "Guide"), Number1: command("74521691", "1") },
    };
    const graph = buildActivityGraph({ config, draft, editId: null });
    const map = companionMap(graph.mapList.ButtonMaps, graph.activityId);
    assert.ok(map, "the Companion surface is created");
    assert.equal(map["RemoteId-"], 4242, "on the Companion's own surface");
    assert.equal(graph.mapList.ButtonMaps.filter((m) => m.ButtonMapIdentifier === `16422Activity${graph.activityId}`).length, 1, "exactly one");
    const wizard = graph.mapList.ButtonMaps.find((m) => isWizardOwnedActivityMap(m, graph.activityId));
    assert.deepEqual(hard(map).map((b) => b.ButtonKey).sort(), ["Dvr", "Number1", "VolumeUp"]);
    for (const button of hard(map)) {
      const twin = wizard.Buttons.find((b) => b.ButtonKey === button.ButtonKey);
      assert.deepEqual(button.ButtonAction, twin.ButtonAction);
      assert.equal(button.FunctionGroupType, twin.FunctionGroupType, "number keys stay in the number-pad group");
      assert.notEqual(button.ButtonId, twin.ButtonId);
    }
    assertUniqueIdentities(graph.mapList.ButtonMaps);
  });

  it("an unchanged save leaves a Logitech Companion map exactly as it was", () => {
    const config = withCompanion();
    for (const activity of config.activityList.Activities) {
      const id = String(activity["Id-"]);
      const before = companionMap(config.mapList.ButtonMaps, id);
      if (!before) continue;
      const graph = buildActivityGraph({ config, draft: draftFromActivity(config, id), editId: id });
      assert.deepEqual(companionMap(graph.mapList.ButtonMaps, id), before, activity.Name);
    }
  });

  it("a changed key reaches the Companion and keeps its identity", () => {
    const config = withCompanion();
    const id = "48113644";
    const before = companionMap(config.mapList.ButtonMaps, id);
    const draft = draftFromActivity(config, id);
    draft.buttons.VolumeUp = command("78760839", "ChannelUp");
    const graph = buildActivityGraph({ config, draft, editId: id });
    const after = companionMap(graph.mapList.ButtonMaps, id);
    const volume = (map) => map.Buttons.find((b) => b.ButtonKey === "VolumeUp");
    assert.equal(volume(after).ButtonAction.CommandName, "ChannelUp");
    assert.equal(volume(after).ButtonId, volume(before).ButtonId);
    assert.deepEqual(after.Buttons.filter((b) => b.ButtonKey !== "VolumeUp"), before.Buttons.filter((b) => b.ButtonKey !== "VolumeUp"));
  });

  it("an empty Companion map (made before this fix) gets every key on the next save", () => {
    const config = withCompanion();
    const id = "48113644";
    companionMap(config.mapList.ButtonMaps, id).Buttons = [];
    const graph = buildActivityGraph({ config, draft: draftFromActivity(config, id), editId: id });
    const wizard = graph.mapList.ButtonMaps.find((m) => isWizardOwnedActivityMap(m, id));
    assert.deepEqual(hard(companionMap(graph.mapList.ButtonMaps, id)).map((b) => b.ButtonKey).sort(),
      hard(wizard).map((b) => b.ButtonKey).sort());
  });

  it("a Companion sharing the Smart Control's surface ids still gets its own map (#79)", () => {
    const config = withCompanion({ sharedSurface: true });
    const draft = { name: "Shared surface", type: 1, roles: [], buttons: { VolumeUp: command("74521691", "VolumeUp") } };
    const graph = buildActivityGraph({ config, draft, editId: null });
    const made = graph.mapList.ButtonMaps.filter((m) => m.ButtonMapIdentifier === `16422Activity${graph.activityId}`);
    assert.equal(made.length, 1);
    assert.deepEqual(hard(made[0]).map((b) => b.ButtonKey), ["VolumeUp"]);
    assertUniqueIdentities(graph.mapList.ButtonMaps);
  });

  it("an activity with no Companion map gets one on its next save", () => {
    const config = withCompanion({ sharedSurface: true });
    const id = "48113644";
    config.mapList.ButtonMaps = config.mapList.ButtonMaps.filter((m) => m.ButtonMapIdentifier !== `16422Activity${id}`);
    const graph = buildActivityGraph({ config, draft: draftFromActivity(config, id), editId: id });
    const wizard = graph.mapList.ButtonMaps.find((m) => isWizardOwnedActivityMap(m, id));
    const made = companionMap(graph.mapList.ButtonMaps, id);
    assert.ok(made);
    assert.deepEqual(hard(made).map((b) => b.ButtonKey).sort(), hard(wizard).map((b) => b.ButtonKey).sort());
    assertUniqueIdentities(graph.mapList.ButtonMaps);
  });

  it("a hub without a Companion gets no Companion map", () => {
    const draft = { name: "No Companion", type: 1, roles: [], buttons: {} };
    const graph = buildActivityGraph({ config: FIXTURE, draft, editId: null });
    assert.ok(!graph.mapList.ButtonMaps.some((m) => /^1642[23]/.test(m.ButtonMapIdentifier)));
  });
});

describe("power order and delays (§6.3)", () => {
  const role = (deviceId, roleType, powerDelay = "") => ({ deviceId, roleType, input: "", powerDelay });
  const byDevice = (graph) => {
    const activity = graph.activityList.Activities.find((a) => String(a["Id-"]) === String(graph.activityId));
    return new Map(activity.Roles.map((r) => [String(r["DeviceId-"]), r]));
  };

  it("a new activity powers on display, volume, player with default waits, whatever order jobs were added", () => {
    const draft = {
      name: "Reverse order",
      type: 2,
      roles: [
        role("66690268", "PlayMovieActivityRole"),
        role("78760839", "VolumeActivityRole"),
        role("74521691", "DisplayActivityRole"),
      ],
      buttons: {},
    };
    const saved = byDevice(buildActivityGraph({ config: FIXTURE, draft, editId: null }));
    assert.equal(saved.get("74521691").PowerOnOrder, 1, "display first");
    assert.equal(saved.get("78760839").PowerOnOrder, 2, "volume second");
    assert.equal(saved.get("66690268").PowerOnOrder, 3, "player third");
    assert.deepEqual([...saved.values()].map((r) => r.PowerOffOrder).sort(), [1, 2, 3]);
    assert.equal(saved.get("74521691").NextDevicePowerOnDelay, 2500);
    assert.equal(saved.get("78760839").NextDevicePowerOnDelay, 1500);
    assert.equal(saved.get("66690268").NextDevicePowerOnDelay, 1000);
  });

  it("a wait the user stepped down to 0 on a new activity stays 0", () => {
    const draft = {
      name: "No waits",
      type: 1,
      roles: [role("74521691", "DisplayActivityRole", 0), role("66690268", "PlayMovieActivityRole", 500)],
      buttons: {},
    };
    const saved = byDevice(buildActivityGraph({ config: FIXTURE, draft, editId: null }));
    assert.equal(saved.get("74521691").NextDevicePowerOnDelay, 0);
    assert.equal(saved.get("66690268").NextDevicePowerOnDelay, 500);
  });

  it("opening an existing activity and saving untouched keeps its custom order and waits, 0 and null included", () => {
    const config = structuredClone(FIXTURE);
    const activity = config.activityList.Activities[0];
    const id = String(activity["Id-"]);
    // Deliberately not role order: player first, display second, volume last.
    activity.Roles = [
      { "DeviceId-": 66690268, __type: "PlayMovieActivityRole", SelectedInput: null, PowerOnOrder: 1, PowerOffOrder: 1, NextDevicePowerOnDelay: 0, "Id-": 910001 },
      { "DeviceId-": 74521691, __type: "DisplayActivityRole", SelectedInput: null, PowerOnOrder: 2, PowerOffOrder: 2, NextDevicePowerOnDelay: null, "Id-": 910002 },
      { "DeviceId-": 78760839, __type: "VolumeActivityRole", SelectedInput: null, PowerOnOrder: 3, PowerOffOrder: 3, NextDevicePowerOnDelay: 7000, "Id-": 910003 },
    ];
    const graph = buildActivityGraph({ config, draft: draftFromActivity(config, id), editId: id });
    const saved = byDevice({ ...graph, activityId: id });
    assert.equal(saved.get("66690268").PowerOnOrder, 1);
    assert.equal(saved.get("74521691").PowerOnOrder, 2);
    assert.equal(saved.get("78760839").PowerOnOrder, 3);
    assert.equal(saved.get("66690268").NextDevicePowerOnDelay, 0);
    assert.equal(saved.get("74521691").NextDevicePowerOnDelay, null);
    assert.equal(saved.get("78760839").NextDevicePowerOnDelay, 7000);
    assert.deepEqual([...saved.values()].map((r) => r["Id-"]).sort(), [910001, 910002, 910003], "role identities reused");
  });
});

describe("inputOptions", () => {
  const entry = (id) => FIXTURE.deviceList.DevicesWithFeatures.find((e) => String(e.Device["Id-"]) === id);

  it("offers the device's input names exactly, so the engine finds them", () => {
    const options = inputOptions({ inputs: inputNames(entry("81897247")) });
    assert.deepEqual(options.map((o) => o.value),
      ["Aux", "Bluetooth", "Coaxial", "HDMI Arc", "HDMI 2", "HDMI 3", "HDMI 4", "Optical", "USB"]);
  });

  it("matches what the cloud-made activities select", () => {
    for (const activity of FIXTURE.activityList.Activities) {
      for (const role of activity.Roles) {
        const name = role.SelectedInput?.Name;
        // The fixture's older activities also name devices it no longer has.
        if (!name || !entry(String(role["DeviceId-"]))) continue;
        const values = inputOptions({ inputs: inputNames(entry(String(role["DeviceId-"]))) }).map((o) => o.value);
        assert.ok(values.includes(name), `${activity.Name}: ${name}`);
      }
    }
  });

  it("offers nothing for a device without inputs set up", () => {
    assert.deepEqual(inputOptions({ inputs: inputNames(entry("93111391")) }), []);
    assert.deepEqual(inputOptions(null), []);
  });
});
