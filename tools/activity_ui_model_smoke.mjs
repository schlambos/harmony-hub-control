#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../payload/web/activity-ui.js", import.meta.url),
  "utf8"
);
const context = {
  __HARMONY_ACTIVITY_TEST__: {}
};
vm.createContext(context);
vm.runInContext(source, context, { filename: "activity-ui.js" });
const {
  state,
  resetIdPool,
  cloneMapForActivity,
  cloneFunctionMapForActivity,
  reconcileActivityMaps,
  removeActivityFromGraph,
  pruneActionlessButtons,
  validateGraph
} = context.__HARMONY_ACTIVITY_TEST__.api;

function activity(id, name, order) {
  return {
    "Id-": id,
    Name: name,
    ActivityDisplayName: name,
    ActivityOrder: order,
    Roles: []
  };
}

function map(mapId, activityId, surface, buttonId, actionId = 0, prefix = `skin${surface}`) {
  return {
    "ButtonMapId-": mapId,
    "ActivityId-": activityId,
    "RemoteId-": 10,
    "SurfaceId-": surface,
    "ButtonMapSurfaceId-": surface,
    ButtonMapIdentifier: `${prefix}Activity${activityId}`,
    __type: "ActivityButtonMap",
    Buttons: [{
      ButtonId: buttonId,
      ButtonState: 1,
      MenuItem: {
        IndexInMenu: 0,
        MenuName: `Activity.${activityId}`
      },
      ButtonAction: {
        Id: actionId,
        "DeviceId-": 500,
        "FunctionId-": 12,
        CommandName: "PowerOn",
        EventType: 1,
        Order: 0,
        __type: "ButtonCommandAction"
      },
      ButtonLongPressAction: null,
      ButtonDoublePressAction: null
    }],
    Sequences: []
  };
}

function functionMap(activityId) {
  return {
    UIModeName: `Functions.UserConfigurator.${activityId}`,
    __type: "ActivityFunctionMap",
    "ActivityId-": activityId,
    FunctionGroups: []
  };
}

const sourceMapA = map(1000, 100, 20, 5000, 6000);
const sourceMapB = map(1001, 100, 30, 5001, 6001);
sourceMapA.Buttons[0].MenuItem.MenuName = "Activity.999";
const rootMap = {
  "ButtonMapId-": 1200,
  "RemoteId-": 10,
  "SurfaceId-": 20,
  ButtonMapIdentifier: "skinRoot",
  __type: "RootButtonMap",
  DateModified: "/Date(1)/",
  Buttons: [{
    ButtonId: 5200,
    ButtonState: 1,
    ButtonKey: "WatchTVActivity",
    ButtonAction: {
      __type: "ButtonActivityAction",
      "ActivityId-": 999,
      EventType: 1,
      Id: 0,
      Order: 0
    },
    ButtonLongPressAction: {
      __type: "ButtonActivityAction",
      "ActivityId-": 100,
      EventType: 2,
      Id: 0,
      Order: 0
    },
    ButtonDoublePressAction: null
  }]
};
state.config = {
  activityList: {
    Activities: [
      activity(100, "Existing", 0),
      {
        ...activity(200, "New", 1),
        Roles: [{
          __type: "VolumeActivityRole",
          "DeviceId-": 500,
          SelectedInput: null
        }]
      }
    ]
  },
  mapList: {
    ButtonMaps: [
      sourceMapA,
      sourceMapB,
      map(1100, 999, 20, 5100, 6100),
      map(1101, 999, 30, 5101, 6101),
      rootMap
    ]
  },
  functionList: {
    FunctionMaps: [
      {
        UIModeName: "Functions.Device.500",
        __type: "DeviceFunctionMap",
        "DeviceId-": 500,
        FunctionGroups: [{
          Name: "Volume",
          Functions: [{
            "DeviceId-": 500,
            __type: "FunctionAction",
            Name: "VolumeUp",
            Label: "Volume Up",
            CommandName: "VolumeUp",
            "FunctionId-": 171
          }]
        }]
      },
      functionMap(100),
      functionMap(999)
    ]
  },
  deviceList: {
    DevicesWithFeatures: [{
      Device: {
        "Id-": 500,
        Name: "Test device",
        Transport: 32,
        IsKeyboardAssociated: true
      },
      Commands: [],
      DeviceFeatures: []
    }]
  }
};

resetIdPool();
const repair = reconcileActivityMaps();
assert.equal(repair.removed.length, 2, "orphaned activity maps are removed");
assert.equal(repair.created.length, 2, "one map is created for every missing remote surface");
assert.equal(repair.removedFunctions.length, 1, "orphaned activity function maps are removed");
assert.equal(repair.createdFunctions.length, 1, "a missing activity function map is created");
assert.equal(repair.clearedActivityActions.length, 1, "stale root activity shortcuts are cleared");
assert.equal(repair.repairedIdentifiers.length, 1, "stale activity menu identifiers are repaired");
assert.equal(sourceMapA.Buttons[0].MenuItem.MenuName, "Activity.100");
assert.equal(repair.createdKeyboardRoles.length, 1, "Bluetooth activities receive a keyboard role");
assert.equal(repair.createdKeyboardHidMaps.length, 1, "Bluetooth activities receive a 16420 HID map");
assert.equal(
  state.config.activityList.Activities[1].Roles.filter(
    (role) => role.__type === "KeyboardTextEntryActivityRole" &&
      role["DeviceId-"] === 500
  ).length,
  1
);
assert.equal(rootMap.Buttons[0].ButtonAction, null);
assert.equal(rootMap.Buttons[0].ButtonLongPressAction["ActivityId-"], 100);
assert.equal(repair.createdFunctions[0].FunctionGroups.length, 1);
assert.equal(repair.createdFunctions[0].FunctionGroups[0].Name, "Volume");
assert.equal(repair.createdFunctions[0].FunctionGroups[0].Functions[0]["DeviceId-"], 500);
assert.equal(state.config.mapList.ButtonMaps.length, 6, "non-activity maps are preserved");

const newMaps = state.config.mapList.ButtonMaps.filter(
  (entry) =>
    String(entry["ActivityId-"]) === "200" &&
    !String(entry.ButtonMapIdentifier).startsWith("16420Activity")
);
assert.equal(newMaps.length, 2);
// Genuine Logitech maps never omit these identities and never ship ButtonState 0.
// The offline editor must allocate them itself: there is no cloud allocator.
const MAP_ID_FLOOR = 52944089;
const BUTTON_ID_FLOOR = 1878029713;
const isPositiveInt = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;

for (const entry of newMaps) {
  assert.ok(
    isPositiveInt(entry["ButtonMapId-"]),
    "new local maps carry a locally allocated positive ButtonMapId-"
  );
  assert.ok(
    Number(entry["ButtonMapId-"]) > MAP_ID_FLOOR,
    "allocated map IDs never reuse a value Logitech already issued"
  );
  assert.ok(Array.isArray(entry.Sequences), "Sequences is an empty array, not null");
  assert.match(entry.ButtonMapIdentifier, /Activity200$/);
  // A blank recovery map inherits no actions, so pruning action-less buttons
  // legitimately empties it rather than persisting buttons that wedge the remote.
  assert.equal(
    entry.Buttons.length,
    0,
    "a blank recovery map keeps no action-less buttons"
  );
}

const populated = state.config.mapList.ButtonMaps.filter(
  (entry) =>
    String(entry.__type).includes("ActivityButtonMap") && (entry.Buttons || []).length > 0
);
assert.ok(populated.length > 0, "populated activity maps exist to assert identities against");
for (const entry of populated) {
  for (const button of entry.Buttons) {
    assert.ok(
      isPositiveInt(button.ButtonId),
      "every surviving activity button carries a positive allocated ButtonId"
    );
    assert.equal(
      button.ButtonState,
      1,
      "ButtonState 0 stops the paired remote from transmitting; it must be 1"
    );
  }
}
const keyboardHidMap = state.config.mapList.ButtonMaps.find(
  (entry) => entry.ButtonMapIdentifier === "16420Activity200"
);
assert.ok(keyboardHidMap, "the firmware's hard-coded keyboard map identifier exists");
assert.equal(keyboardHidMap["ActivityId-"], 200);
assert.equal(sourceMapA["ButtonMapId-"], 1000, "the source map remains unchanged");
assert.equal(sourceMapA.Buttons[0].ButtonId, 5000, "the source button identity remains unchanged");
validateGraph();

const duplicate = cloneMapForActivity(sourceMapA, 100, 300, true);
assert.ok(isPositiveInt(duplicate["ButtonMapId-"]), "a duplicated map gets its own map identity");
assert.ok(isPositiveInt(duplicate.Buttons[0].ButtonId), "a duplicated button gets its own identity");
assert.notEqual(
  duplicate["ButtonMapId-"],
  sourceMapA["ButtonMapId-"],
  "a duplicate never reuses the template's map identity"
);
assert.notEqual(
  duplicate.Buttons[0].ButtonId,
  sourceMapA.Buttons[0].ButtonId,
  "a duplicate never reuses the template's button identity"
);
assert.equal(duplicate.Buttons[0].ButtonState, 1, "duplicated buttons stay enabled");
// Nested command/activity action identities are legitimately 0 in genuine data.
assert.equal(duplicate.Buttons[0].ButtonAction.Id, 0);
assert.equal(duplicate.Buttons[0].ButtonAction.CommandName, "PowerOn");
assert.equal(duplicate.Buttons[0].ButtonAction["DeviceId-"], 500);
assert.equal(duplicate.Buttons[0].MenuItem.MenuName, "Activity.300");
assert.match(duplicate.ButtonMapIdentifier, /Activity300$/);

const duplicateFunctions = cloneFunctionMapForActivity(functionMap(100), 100, 300);
assert.equal(duplicateFunctions["ActivityId-"], 300);
assert.match(duplicateFunctions.UIModeName, /300$/);

const probe = sourceMapB.Buttons[0];
const restoreButtonId = probe.ButtonId;
probe.ButtonId = 5000;
assert.throws(
  () => validateGraph(),
  /Remote button ID 5000 is duplicated/,
  "canonical nonzero button identities must remain unique"
);
probe.ButtonId = 0;
assert.throws(
  () => validateGraph(),
  /without a positive ButtonId/,
  "zero physical button identities are rejected, not blessed"
);
probe.ButtonId = restoreButtonId;
validateGraph();

// ButtonState is what the paired remote reads; only 0 or 1 may ever be persisted.
probe.ButtonState = 2;
assert.throws(
  () => validateGraph(),
  /ButtonState/,
  "an out-of-range ButtonState is rejected"
);
probe.ButtonState = 1;
validateGraph();

probe.MenuItem.MenuName = "Activity.999";
assert.throws(
  () => validateGraph(),
  /menu identifies activity 999 but references 100/,
  "remote menu identifiers must match their activity map"
);
probe.MenuItem.MenuName = "Activity.100";
validateGraph();

const removed = removeActivityFromGraph(100);
assert.equal(removed.removedActivities, 1);
assert.equal(removed.removedMaps, 2, "every deleted activity surface map is removed");
assert.equal(removed.removedFunctions, 1, "the deleted activity control map is removed");
assert.equal(
  removed.clearedActivityActions.length,
  1,
  "surviving root buttons no longer launch the deleted activity"
);
assert.equal(rootMap.Buttons[0].ButtonAction, null);
assert.equal(rootMap.Buttons[0].ButtonLongPressAction, null);
assert.deepEqual(
  state.config.activityList.Activities.map((entry) => entry["Id-"]),
  [200]
);
validateGraph();

// --- offline identity contract regression coverage ---

// Every persisted identity must be globally unique across all maps.
{
  const mapIds = new Map();
  const buttonIds = new Map();
  for (const entry of state.config.mapList.ButtonMaps) {
    const id = entry["ButtonMapId-"] ?? entry.ButtonMapId;
    if (isPositiveInt(id)) mapIds.set(String(id), (mapIds.get(String(id)) || 0) + 1);
    for (const button of entry.Buttons || []) {
      assert.ok(
        isPositiveInt(button.ButtonId),
        `every persisted button needs a positive ButtonId (map ${entry.ButtonMapIdentifier})`
      );
      buttonIds.set(String(button.ButtonId), (buttonIds.get(String(button.ButtonId)) || 0) + 1);
    }
  }
  assert.deepEqual([...mapIds].filter(([, n]) => n > 1), [], "map identities are unique");
  assert.deepEqual([...buttonIds].filter(([, n]) => n > 1), [], "button identities are unique");
}

// Reconciliation is idempotent: a second pass allocates and corrects nothing.
{
  const second = reconcileActivityMaps();
  assert.equal(second.allocatedMapIds, 0, "a second reconcile allocates no map IDs");
  assert.equal(second.allocatedButtonIds, 0, "a second reconcile allocates no button IDs");
  assert.equal(second.correctedButtonStates, 0, "a second reconcile corrects no ButtonState");
  assert.equal(second.repairedMapIdentities, 0, "a second reconcile repairs no maps");
  validateGraph();
}

// A ButtonClientAction carries a Hub-issued Id that must survive cloning.
// Blanket Id zeroing was a live data-loss bug.
{
  const clientMap = map(1300, 100, 20, 5300, 0);
  clientMap.Buttons[0].ButtonAction = {
    __type: "ButtonClientAction",
    Id: 987654,
    EventType: 1,
    Order: 0
  };
  const clonedClient = cloneMapForActivity(clientMap, 100, 400, true);
  assert.equal(
    clonedClient.Buttons[0].ButtonAction.Id,
    987654,
    "a nonzero ButtonClientAction.Id is preserved, never zeroed"
  );
  assert.ok(
    isPositiveInt(clonedClient.Buttons[0].ButtonId),
    "the physical button identity is still allocated alongside it"
  );
}

// deviceList must participate in the pool, otherwise a device Id- could collide.
{
  state.config.deviceList.DevicesWithFeatures.push({
    Device: { "Id-": 52944095, Name: "Collision probe", Transport: 1 },
    Commands: [],
    DeviceFeatures: []
  });
  resetIdPool();
  assert.ok(
    state.knownIds.has("52944095"),
    "deviceList identities are scanned into the pool so allocation cannot collide"
  );
  assert.ok(state.knownIds.has("500"), "existing device identities are pooled");
}

// An action-less button (no ButtonAction, ButtonLongPressAction or
// ButtonDoublePressAction) is dropped by the hub but wedges the paired remote:
// it flashes "starting activity", returns to home and stops responding until
// power-cycled. Genuine Logitech configs contain zero of them.
{
  const actionless = (b) =>
    !b.ButtonAction && !b.ButtonLongPressAction && !b.ButtonDoublePressAction;

  for (const entry of state.config.mapList.ButtonMaps) {
    if (!String(entry.__type).includes("ActivityButtonMap")) continue;
    const stray = (entry.Buttons || []).filter(actionless);
    assert.equal(
      stray.length,
      0,
      `activity map ${entry.ButtonMapIdentifier} must not persist action-less buttons`
    );
  }

  const pruning = reconcileActivityMaps();
  assert.equal(
    pruning.prunedActionlessButtons,
    0,
    "a clean graph prunes nothing, so pruning is idempotent"
  );
  validateGraph();

  const survivingId = state.config.activityList.Activities[0]["Id-"];
  const probeMap = map(1400, survivingId, 40, 5400, 0);
  probeMap.Buttons[0].MenuItem.MenuName = `Activity.${survivingId}`;
  state.config.mapList.ButtonMaps.push(probeMap);
  validateGraph();

  probeMap.Buttons[0].ButtonAction = null;
  probeMap.Buttons[0].ButtonLongPressAction = null;
  probeMap.Buttons[0].ButtonDoublePressAction = null;
  assert.throws(
    () => validateGraph(),
    /has no press, long-press, or double-press action/,
    "validateGraph rejects an action-less button in an activity map"
  );

  assert.equal(
    pruneActionlessButtons(probeMap),
    1,
    "the prune pass drops the action-less button"
  );
  assert.equal(probeMap.Buttons.length, 0, "no action-less button survives the prune");
  validateGraph();

  state.config.mapList.ButtonMaps = state.config.mapList.ButtonMaps.filter(
    (entry) => entry !== probeMap
  );
  validateGraph();

  // The root map legitimately ships action-less shortcut buttons; rejecting or
  // pruning it would block every save.
  assert.ok(
    rootMap.Buttons.length > 0,
    "the root map survives with its own buttons"
  );
  const rootVictim = rootMap.Buttons[0];
  const rootAction = rootVictim.ButtonAction;
  const rootLong = rootVictim.ButtonLongPressAction;
  rootVictim.ButtonAction = null;
  rootVictim.ButtonLongPressAction = null;
  validateGraph();
  assert.equal(
    rootMap.Buttons.length,
    1,
    "an action-less root button is neither pruned nor rejected"
  );
  rootVictim.ButtonAction = rootAction;
  rootVictim.ButtonLongPressAction = rootLong;
  validateGraph();
}

// --- Issue #86: remote-prefix map identity & Root surface fallback ---
{
  const survivingId = state.config.activityList.Activities[0]["Id-"];
  // Companion map sharing the Smart Control's RemoteId-/SurfaceId-/ButtonMapSurfaceId-
  // (#79 / #86): distinct EquadID prefixes must not collide as duplicate surfaces.
  const smartMap = state.config.mapList.ButtonMaps.find(
    (entry) => String(entry["ActivityId-"]) === String(survivingId) && entry["SurfaceId-"] === 20
  );
  const companionShared = cloneMapForActivity(smartMap, survivingId, survivingId, true);
  companionShared.ButtonMapIdentifier = `16422Activity${survivingId}`;
  state.config.mapList.ButtonMaps.push(companionShared);
  validateGraph();

  // Duplicate ButtonMapIdentifier is rejected (hub loader overwrites earlier map).
  const dupIdentifier = cloneMapForActivity(smartMap, survivingId, survivingId, true);
  dupIdentifier.ButtonMapIdentifier = `16422Activity${survivingId}`;
  dupIdentifier["SurfaceId-"] = 999;
  dupIdentifier["ButtonMapSurfaceId-"] = 999;
  state.config.mapList.ButtonMaps.push(dupIdentifier);
  assert.throws(
    () => validateGraph(),
    /has more than one button map for remote surface 16422\|ActivityButtonMap|Button map identifier 16422Activity.*is duplicated/,
    "two maps with the same EquadID prefix / ButtonMapIdentifier are rejected"
  );
  state.config.mapList.ButtonMaps.pop();

  // Null surface ids on an activity map with a valid <EquadID>Activity<id>
  // identifier are backfilled from Root during reconcile and never block validateGraph.
  companionShared["RemoteId-"] = null;
  companionShared["SurfaceId-"] = null;
  companionShared["ButtonMapSurfaceId-"] = null;
  validateGraph();
  const backfill = reconcileActivityMaps();
  assert.equal(companionShared["RemoteId-"], 10, "RemoteId- backfilled from root/existing map");
  assert.equal(companionShared["SurfaceId-"], 20, "SurfaceId- backfilled from root/existing map");
  assert.equal(companionShared["ButtonMapSurfaceId-"], 20, "ButtonMapSurfaceId- backfilled from root/existing map");
  assert.ok(backfill.repairedIdentifiers.includes(companionShared));
  validateGraph();
}

// --- Issue #178: Logitech 16417Device maps with missing ButtonMapId- and ButtonId 0 ---
{
  const logitechDeviceMap = {
    "DeviceId-": 500,
    "RemoteId-": 10,
    "SurfaceId-": 30,
    "ButtonMapSurfaceId-": 30,
    ButtonMapIdentifier: "16417Device500",
    __type: "DeviceButtonMap",
    DateModified: null,
    Sequences: null,
    Buttons: [
      {
        ButtonId: 0,
        ButtonState: 0,
        FunctionGroupType: 0,
        ButtonKey: "VolumeUp",
        __type: "HardRemoteButton",
        ButtonAction: {
          Id: 0,
          "DeviceId-": 500,
          "FunctionId-": 12,
          CommandName: "VolumeUp",
          EventType: 1,
          Order: 0,
          __type: "ButtonCommandAction"
        },
        ButtonLongPressAction: null,
        ButtonDoublePressAction: null
      },
      {
        ButtonId: 0,
        ButtonState: 0,
        FunctionGroupType: 0,
        TextOnRemote: "Audio",
        ButtonImageKey: null,
        ButtonImagePath: null,
        "ImageId-": 0,
        MenuItem: { IndexInMenu: 0, MenuName: "Device.500" },
        __type: "SoftRemoteButton",
        ButtonAction: {
          Id: 0,
          "DeviceId-": 500,
          "FunctionId-": 13,
          CommandName: "Audio",
          EventType: 0,
          Order: 0,
          __type: "ButtonCommandAction"
        },
        ButtonLongPressAction: null,
        ButtonDoublePressAction: null
      }
    ]
  };
  state.config.mapList.ButtonMaps.push(logitechDeviceMap);
  const repairWithDeviceMap = reconcileActivityMaps();
  assert.equal(repairWithDeviceMap.allocatedMapIds, 0, "16417Device map keeps missing ButtonMapId-");
  assert.equal(repairWithDeviceMap.allocatedButtonIds, 0, "16417Device buttons stay ButtonId 0");
  assert.equal(repairWithDeviceMap.correctedButtonStates, 0, "16417Device buttons stay ButtonState 0");
  assert.equal(logitechDeviceMap["ButtonMapId-"], undefined);
  assert.equal(logitechDeviceMap.Buttons[0].ButtonId, 0);
  assert.equal(logitechDeviceMap.Buttons[0].ButtonState, 0);
  validateGraph();

  // Non-activity map errors identify ButtonMapIdentifier instead of "unknown".
  logitechDeviceMap["DeviceId-"] = 999999;
  assert.throws(
    () => validateGraph(),
    /Button map 16417Device500 references unavailable device 999999\./,
    "DeviceButtonMap without ButtonMapId- reports its ButtonMapIdentifier"
  );
  logitechDeviceMap["DeviceId-"] = 500;
  logitechDeviceMap.Buttons[0].ButtonAction["DeviceId-"] = 888888;
  assert.throws(
    () => validateGraph(),
    /Button map 16417Device500 ButtonAction references unavailable device 888888\./,
    "DeviceButtonMap button action error reports ButtonMapIdentifier"
  );
  logitechDeviceMap.Buttons[0].ButtonAction["DeviceId-"] = 500;
  validateGraph();

  // ActivityButtonMap buttons with ButtonId 0 are still rejected with ButtonMapIdentifier.
  const survivingActivityMap = state.config.mapList.ButtonMaps.find(
    (entry) => String(entry.__type).includes("ActivityButtonMap")
  );
  const probeButton = {
    ButtonId: 0,
    ButtonState: 1,
    ButtonKey: "Mute",
    __type: "HardRemoteButton",
    ButtonAction: {
      Id: 0,
      "DeviceId-": 500,
      "FunctionId-": 12,
      CommandName: "Mute",
      EventType: 1,
      Order: 0,
      __type: "ButtonCommandAction"
    },
    ButtonLongPressAction: null,
    ButtonDoublePressAction: null
  };
  survivingActivityMap.Buttons.push(probeButton);
  assert.throws(
    () => validateGraph(),
    new RegExp(`Button map ${survivingActivityMap.ButtonMapIdentifier} has a button without a positive ButtonId\\.`),
    "ActivityButtonMap button with ButtonId 0 still fails with map identifier"
  );
  survivingActivityMap.Buttons.pop();

  // End-to-end saveActivities() posts /api/activity-save cleanly with 16417Device ButtonId 0 maps present.
  let postedBody = null;
  const notices = [];
  const saveContext = {
    __HARMONY_ACTIVITY_TEST__: {},
    document: {
      getElementById: (id) => {
        if (id === "activityNotice") {
          return {
            set textContent(msg) {
              if (msg) notices.push({ msg, kind: this.className });
            },
            className: ""
          };
        }
        return { disabled: false, textContent: "", classList: { toggle() {} } };
      }
    },
    fetch: async (url, opts) => {
      assert.equal(url, "/api/activity-save");
      postedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          saved: true,
          revision: "rev-after-178",
          message: "Saved."
        })
      };
    }
  };
  vm.createContext(saveContext);
  vm.runInContext(source, saveContext, { filename: "activity-ui.js" });
  const saveApi = saveContext.__HARMONY_ACTIVITY_TEST__.api;
  saveApi.state.config = JSON.parse(JSON.stringify(state.config));
  saveApi.state.revision = "rev-before-178";
  saveApi.resetIdPool();
  await saveApi.saveActivities(false);
  assert.ok(postedBody, "saveActivities POSTed /api/activity-save instead of aborting on 16417Device ButtonId 0");
  const savedDevMap = postedBody.mapList.ButtonMaps.find(
    (entry) => entry.ButtonMapIdentifier === "16417Device500"
  );
  assert.ok(savedDevMap, "16417Device500 survived saveActivities");
  assert.equal(savedDevMap["ButtonMapId-"], undefined);
  assert.equal(savedDevMap.Buttons[0].ButtonId, 0);
  assert.equal(savedDevMap.Buttons[0].ButtonState, 0);
}

// Activity icons (docs/REMOTE_IMAGES.md): the stored name comes from the
// ImageKey only, the cover crop is centered, and the picker's glyphs are path
// data only, as Path2D draws them.
{
  const { activityImageName, coverRect, ICON_GLYPHS, ICON_BASE_URI } = context.__HARMONY_ACTIVITY_TEST__.api;
  assert.equal(activityImageName({ ImageKey: "Activity/123_ab-cd.png" }), "123_ab-cd");
  assert.equal(activityImageName({ ImageKey: "Activity/123_ab-cd_small.png" }), "");
  assert.equal(activityImageName({ ImageKey: "Activity/../x.png" }), "");
  assert.equal(activityImageName({ ImageKey: "Other/x.png" }), "");
  assert.equal(activityImageName({ ImageKey: null, Icon: 5 }), "");
  assert.deepEqual({ ...coverRect(400, 300) }, { x: 50, y: 0, side: 300 });
  assert.deepEqual({ ...coverRect(300, 500) }, { x: 0, y: 100, side: 300 });
  assert.ok(ICON_GLYPHS.length >= 10);
  for (const glyph of ICON_GLYPHS) {
    assert.match(glyph.d, /^[MmZzLlHhVvCcSsQqTtAa0-9 .,-]+$/, `${glyph.key} is plain path data`);
  }
  assert.match(ICON_BASE_URI, /^https:\/\/[^/]+\/$/);
}

// User image status: the editor only reports; an old hub (no route, 404)
// disables setting icons and says to update the hub.
{
  const statusContext = { __HARMONY_ACTIVITY_TEST__: {} };
  vm.createContext(statusContext);
  vm.runInContext(source, statusContext, { filename: "activity-ui.js" });
  const { imageStatus, imageStatusHtml } = statusContext.__HARMONY_ACTIVITY_TEST__.api;
  assert.equal(imageStatusHtml(), "");
  Object.assign(imageStatus, { checked: true, oldHub: true });
  assert.match(imageStatusHtml(), /older than this editor: update the hub/);
  Object.assign(imageStatus, { oldHub: false, missing: 3, total: 17 });
  assert.match(imageStatusHtml(), /Missing user images: 3 of 17\. Sync them with the Melodious desktop app \(Settings → Logitech account\)\./);
  assert.doesNotMatch(imageStatusHtml(), /<button/);
  statusContext.melodiousDesktop = { catalog: {} };
  assert.match(imageStatusHtml(), /Missing user images: 3 of 17\. Sync them in Settings → Logitech account\./);
  Object.assign(imageStatus, { missing: 0 });
  assert.equal(imageStatusHtml(), "");
}

// Changing an icon goes straight to the hub for that one activity (no full
// save), takes the hub's new revision, and leaves the editor's dirty state.
{
  const calls = [];
  let answer = { status: 200, body: { ok: true, imageKey: "Activity/9_new.png", revision: "rev-icon" } };
  const iconContext = {
    __HARMONY_ACTIVITY_TEST__: {},
    document: { getElementById: () => null, dispatchEvent: () => true },
    CustomEvent: class { constructor(type) { this.type = type; } },
    fetch: async (path, options) => {
      calls.push({ path, body: JSON.parse(options.body) });
      return { ok: answer.status === 200, status: answer.status, text: async () => JSON.stringify(answer.body) };
    }
  };
  vm.createContext(iconContext);
  vm.runInContext(source, iconContext, { filename: "activity-ui.js" });
  const iconApi = iconContext.__HARMONY_ACTIVITY_TEST__.api;
  iconApi.state.config = { activityList: { Activities: [{ "Id-": 77, Name: "A", ImageKey: null, BaseImageUri: null }] },
    mapList: { ButtonMaps: [] }, functionList: { FunctionMaps: [] }, deviceList: { DevicesWithFeatures: [] } };
  iconApi.state.selectedId = "77";
  iconApi.state.revision = "rev-old";
  iconApi.state.dirty = false;
  const target = iconApi.state.config.activityList.Activities[0];

  await iconApi.changeActivityIcon({ image: "i", thumbnail: "t" }, "done");
  assert.equal(calls[0].path, "/api/activity-icon");
  assert.deepEqual({ ...calls[0].body }, { image: "i", thumbnail: "t", activityId: "77", baseImageUri: iconApi.ICON_BASE_URI });
  assert.equal(target.ImageKey, "Activity/9_new.png");
  assert.equal(target.BaseImageUri, iconApi.ICON_BASE_URI);
  assert.equal(iconApi.state.revision, "rev-icon");
  assert.equal(iconApi.state.dirty, false);

  answer = { status: 200, body: { ok: true, cleared: true, revision: "rev-clear" } };
  await iconApi.changeActivityIcon({ clear: true }, "done");
  assert.equal(calls[1].body.clear, true);
  assert.equal(target.ImageKey, null);
  assert.equal(iconApi.state.revision, "rev-clear");

  answer = { status: 422, body: { ok: false, error: "that activity isn't on the hub yet; save the activity first" } };
  await iconApi.changeActivityIcon({ image: "i", thumbnail: "t" }, "done");
  assert.equal(target.ImageKey, null);
  assert.equal(iconApi.state.revision, "rev-clear");
}

console.log("activity UI model smoke: ok");
