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

function map(mapId, activityId, surface, buttonId, actionId = 0) {
  return {
    "ButtonMapId-": mapId,
    "ActivityId-": activityId,
    "RemoteId-": 10,
    "SurfaceId-": surface,
    "ButtonMapSurfaceId-": surface,
    ButtonMapIdentifier: `skinActivity${activityId}`,
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
  assert.ok(
    isPositiveInt(entry.Buttons[0].ButtonId),
    "new local maps carry locally allocated positive physical button IDs"
  );
  assert.ok(
    Number(entry.Buttons[0].ButtonId) > BUTTON_ID_FLOOR,
    "allocated button IDs never reuse a value Logitech already issued"
  );
  assert.equal(
    entry.Buttons[0].ButtonState,
    1,
    "ButtonState 0 stops the paired remote from transmitting; it must be 1"
  );
  assert.ok(Array.isArray(entry.Sequences), "Sequences is an empty array, not null");
  assert.equal(entry.Buttons[0].ButtonAction, null, "blank recovery maps do not inherit actions");
  assert.equal(entry.Buttons[0].MenuItem.MenuName, "Activity.200");
  assert.match(entry.ButtonMapIdentifier, /Activity200$/);
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

const restoreButtonId = newMaps[0].Buttons[0].ButtonId;
newMaps[0].Buttons[0].ButtonId = 5000;
assert.throws(
  () => validateGraph(),
  /Remote button ID 5000 is duplicated/,
  "canonical nonzero button identities must remain unique"
);
newMaps[0].Buttons[0].ButtonId = 0;
assert.throws(
  () => validateGraph(),
  /without a positive ButtonId/,
  "zero physical button identities are rejected, not blessed"
);
newMaps[0].Buttons[0].ButtonId = restoreButtonId;
validateGraph();

// ButtonState is what the paired remote reads; only 0 or 1 may ever be persisted.
newMaps[0].Buttons[0].ButtonState = 2;
assert.throws(
  () => validateGraph(),
  /ButtonState/,
  "an out-of-range ButtonState is rejected"
);
newMaps[0].Buttons[0].ButtonState = 1;
validateGraph();

newMaps[0].Buttons[0].MenuItem.MenuName = "Activity.999";
assert.throws(
  () => validateGraph(),
  /menu identifies activity 999 but references 200/,
  "remote menu identifiers must match their activity map"
);
newMaps[0].Buttons[0].MenuItem.MenuName = "Activity.200";
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

console.log("activity UI model smoke: ok");
