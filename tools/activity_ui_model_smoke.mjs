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
const rootMap = {
  "ButtonMapId-": 1200,
  "RemoteId-": 10,
  "SurfaceId-": 20,
  ButtonMapIdentifier: "skinRoot",
  __type: "RootButtonMap",
  DateModified: "/Date(1)/",
  Buttons: [{
    ButtonId: 5200,
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
      Device: { "Id-": 500, Name: "Test device" },
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
assert.equal(rootMap.Buttons[0].ButtonAction, null);
assert.equal(rootMap.Buttons[0].ButtonLongPressAction["ActivityId-"], 100);
assert.equal(repair.createdFunctions[0].FunctionGroups.length, 1);
assert.equal(repair.createdFunctions[0].FunctionGroups[0].Name, "Volume");
assert.equal(repair.createdFunctions[0].FunctionGroups[0].Functions[0]["DeviceId-"], 500);
assert.equal(state.config.mapList.ButtonMaps.length, 5, "non-activity maps are preserved");

const newMaps = state.config.mapList.ButtonMaps.filter(
  (entry) => String(entry["ActivityId-"]) === "200"
);
assert.equal(newMaps.length, 2);
for (const entry of newMaps) {
  assert.equal("ButtonMapId-" in entry, false, "new local maps omit map IDs");
  assert.equal(entry.Buttons[0].ButtonId, 0, "new local maps use zero physical button IDs");
  assert.equal(entry.Buttons[0].ButtonAction, null, "blank recovery maps do not inherit actions");
  assert.match(entry.ButtonMapIdentifier, /Activity200$/);
}
assert.equal(sourceMapA["ButtonMapId-"], 1000, "the source map remains unchanged");
assert.equal(sourceMapA.Buttons[0].ButtonId, 5000, "the source button identity remains unchanged");
validateGraph();

const duplicate = cloneMapForActivity(sourceMapA, 100, 300, true);
assert.equal("ButtonMapId-" in duplicate, false);
assert.equal(duplicate.Buttons[0].ButtonId, 0);
assert.equal(duplicate.Buttons[0].ButtonAction.Id, 0);
assert.equal(duplicate.Buttons[0].ButtonAction.CommandName, "PowerOn");
assert.equal(duplicate.Buttons[0].ButtonAction["DeviceId-"], 500);
assert.match(duplicate.ButtonMapIdentifier, /Activity300$/);

const duplicateFunctions = cloneFunctionMapForActivity(functionMap(100), 100, 300);
assert.equal(duplicateFunctions["ActivityId-"], 300);
assert.match(duplicateFunctions.UIModeName, /300$/);

newMaps[0].Buttons[0].ButtonId = 5000;
assert.throws(
  () => validateGraph(),
  /Remote button ID 5000 is duplicated/,
  "canonical nonzero button identities must remain unique"
);
newMaps[0].Buttons[0].ButtonId = 0;
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

console.log("activity UI model smoke: ok");
