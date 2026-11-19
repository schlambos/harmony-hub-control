import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { validateMapList } from "../public/js/views/remote-model.js";
import {
  buildTouchControlsMapList,
  moveButton,
  readHardKeys,
  readTouchScreen,
  saveOutcome,
  setLabel,
  touchSavePayload,
} from "../public/js/views/touch-model.js";
import {
  buildHomeButtonsMapList,
  readHomeButtons,
  setAction as setHomeButtonAction,
} from "../public/js/views/home-buttons-model.js";

const fixtures = JSON.parse(
  readFileSync(new URL("../fixtures/touch-maplist.json", import.meta.url), "utf8"),
);
const liveConfig = JSON.parse(
  readFileSync(new URL("../fixtures/activity-config.json", import.meta.url), "utf8"),
);

describe("validateMapList (web mirror of the hub validator)", () => {
  for (const testCase of fixtures.cases) {
    it(`${testCase.expect}: ${testCase.name}`, () => {
      const errors = validateMapList(testCase.graph.mapList, testCase.oldMapList ?? null);
      if (testCase.expect === "valid") {
        assert.deepEqual(errors, [], testCase.name);
      } else {
        assert.ok(
          errors.some((e) => e.includes(testCase.errorIncludes)),
          `${testCase.name}: expected an error containing ${JSON.stringify(testCase.errorIncludes)}, got ${JSON.stringify(errors)}`,
        );
      }
    });
  }

  it("accepts the fixture hub config, including its device-screen slot clash", () => {
    // The fixture's device map has two soft buttons at IndexInMenu 3 in
    // different function groups. Device maps keep their existing slots
    // until the device screen editor sets their rule, so this is valid.
    assert.deepEqual(validateMapList(liveConfig.mapList), []);
  });

  it("rejects a MapList without a ButtonMaps array", () => {
    assert.deepEqual(validateMapList(null), ["MapList.ButtonMaps must be an array"]);
    assert.deepEqual(validateMapList({}), ["MapList.ButtonMaps must be an array"]);
  });
});

describe("codexactivity.lua validateGraph (LuaJIT)", () => {
  it("validates every fixture case the same way", (t) => {
    const probe = spawnSync("luajit", ["-v"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      t.skip("luajit is not available");
      return;
    }
    const repoRoot = new URL("../../../", import.meta.url);
    const out = execFileSync(
      "luajit",
      [
        "tools/touch-validator/codexactivity-validate-test.lua",
        "tools/webui-sim/fixtures/touch-maplist.json",
      ],
      { cwd: repoRoot.pathname, encoding: "utf8" },
    );
    assert.match(out, /18\/18 cases passed/);
    assert.match(out, /7\/7 issue178 checks passed/);
  });

  it("ends its engine wait in time for codex_webui's transaction limit", (t) => {
    const probe = spawnSync("luajit", ["-v"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      t.skip("luajit is not available");
      return;
    }
    const out = execFileSync("luajit", ["tools/touch-validator/codexactivity-barrier-test.lua"], {
      cwd: new URL("../../../", import.meta.url).pathname,
      encoding: "utf8",
    });
    assert.match(out, /5\/5 checks passed/);
  });

  it("builds, rebuilds and removes Touch device screens, and keeps Home Assistant devices' screens", (t) => {
    const probe = spawnSync("luajit", ["-v"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      t.skip("luajit is not available");
      return;
    }
    const out = execFileSync("luajit", ["tools/touch-validator/codexactivity-device-screens-test.lua"], {
      cwd: new URL("../../../", import.meta.url).pathname,
      encoding: "utf8",
    });
    assert.match(out, /35\/35 checks passed/);
  });

  it("owns the hub's Bluetooth keyboard devices apart from the Home Assistant ones", (t) => {
    const probe = spawnSync("luajit", ["-v"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      t.skip("luajit is not available");
      return;
    }
    const out = execFileSync("luajit", ["tools/touch-validator/codexactivity-bt-devices-test.lua"], {
      cwd: new URL("../../../", import.meta.url).pathname,
      encoding: "utf8",
    });
    assert.match(out, /24\/24 checks passed/);
  });

  it("gives one-shot device screens self-long and simulates Touch gestures (P11/P18)", (t) => {
    const probe = spawnSync("luajit", ["-v"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      t.skip("luajit is not available");
      return;
    }
    const out = execFileSync("luajit", ["tools/touch-validator/codexactivity-touch-controls-test.lua"], {
      cwd: new URL("../../../", import.meta.url).pathname,
      encoding: "utf8",
    });
    assert.match(out, /18\/18 checks passed/);
  });

  it("keeps the Companion's home keys, and routes its rocker, \"nothing\" and holds", (t) => {
    const probe = spawnSync("luajit", ["-v"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      t.skip("luajit is not available");
      return;
    }
    const out = execFileSync("luajit", ["tools/touch-validator/codexactivity-home-buttons-test.lua"], {
      cwd: new URL("../../../", import.meta.url).pathname,
      encoding: "utf8",
    });
    assert.match(out, /42\/42 checks passed/);
  });
});

describe("netservicestarter.lua Touch Sync guards (LuaJIT)", () => {
  it("answers the time offline, leaves the firmware check to stock, serves missing device and user content and saved remote backgrounds, defers otherwise, and boots a blank hub (string remoteId, missing AutomationConfig)", (t) => {
    const probe = spawnSync("luajit", ["-v"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      t.skip("luajit is not available");
      return;
    }
    const out = execFileSync("luajit", ["tools/touch-validator/netservicestarter-guards-test.lua"], {
      cwd: new URL("../../../", import.meta.url).pathname,
      encoding: "utf8",
    });
    assert.match(out, /55\/55 checks passed/);
  });
});

describe("netservicestarter.lua activity time restrictions (LuaJIT)", () => {
  it("refuses starts inside a restricted window and lets everything else through", (t) => {
    const probe = spawnSync("luajit", ["-v"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      t.skip("luajit is not available");
      return;
    }
    const out = execFileSync("luajit", ["tools/touch-validator/netservicestarter-restrictions-test.lua"], {
      cwd: new URL("../../../", import.meta.url).pathname,
      encoding: "utf8",
    });
    assert.match(out, /40\/40 checks passed/);
  });
});

function logitechClashHubConfig() {
  const soft = (buttonId, fgt, slot, label, commandName, activityId = 301) => ({
    __type: "SoftRemoteButton",
    FunctionGroupType: fgt,
    ButtonId: buttonId,
    ButtonState: 1,
    TextOnRemote: label,
    ButtonImageKey: null,
    ButtonImagePath: null,
    "ImageId-": 0,
    MenuItem: { IndexInMenu: slot, MenuName: `Activity.${activityId}` },
    ButtonAction: {
      __type: "ButtonCommandAction",
      "DeviceId-": 10,
      CommandName: commandName,
      "FunctionId-": 0,
      Order: 0,
      EventType: 0,
      Id: 0,
    },
    ButtonLongPressAction: null,
    ButtonDoublePressAction: null,
  });
  const hard = (buttonId, key, commandName) => ({
    __type: "HardRemoteButton",
    FunctionGroupType: 0,
    ButtonId: buttonId,
    ButtonState: 1,
    ButtonKey: key,
    ButtonAction: {
      __type: "ButtonCommandAction",
      "DeviceId-": 10,
      CommandName: commandName,
      "FunctionId-": 0,
      Order: 0,
      EventType: 1,
      Id: 0,
    },
    ButtonLongPressAction: null,
    ButtonDoublePressAction: null,
  });
  return {
    revision: "rev-178",
    activityList: {
      Activities: [
        { "Id-": 301, Name: "Activity 301", Roles: [{ "DeviceId-": 10, __type: "DisplayActivityRole" }] },
        { "Id-": 302, Name: "Activity 302", Roles: [{ "DeviceId-": 10, __type: "DisplayActivityRole" }] },
      ],
    },
    deviceList: {
      DevicesWithFeatures: [
        {
          Device: { "Id-": 10, Name: "Receiver" },
          Commands: [
            { Name: "VolumeUp", "FunctionId-": 0 },
            { Name: "Mute", "FunctionId-": 0 },
            { Name: "Audio", "FunctionId-": 0 },
            { Name: "Clear", "FunctionId-": 0 },
          ],
        },
      ],
    },
    functionList: {
      FunctionMaps: [
        { __type: "ActivityFunctionMap", "ActivityId-": 301, FunctionGroups: [] },
        { __type: "ActivityFunctionMap", "ActivityId-": 302, FunctionGroups: [] },
      ],
    },
    mapList: {
      ButtonMaps: [
        {
          __type: "RootButtonMap",
          "ButtonMapId-": 5300,
          "RemoteId-": 8001,
          "SurfaceId-": 7001,
          "ButtonMapSurfaceId-": 7001,
          ButtonMapIdentifier: "16417Root",
          Sequences: [],
          Buttons: [],
        },
        {
          __type: "DeviceButtonMap",
          "DeviceId-": 10,
          ButtonMapIdentifier: "16417Device10",
          "RemoteId-": 8001,
          "SurfaceId-": 7001,
          "ButtonMapSurfaceId-": 7001,
          Buttons: [
            {
              __type: "HardRemoteButton",
              FunctionGroupType: 0,
              ButtonId: 0,
              ButtonState: 0,
              ButtonKey: "VolumeUp",
              ButtonAction: {
                __type: "ButtonCommandAction",
                "DeviceId-": 10,
                CommandName: "VolumeUp",
                "FunctionId-": 0,
                Order: 0,
                EventType: 1,
                Id: 0,
              },
              ButtonLongPressAction: null,
              ButtonDoublePressAction: null,
            },
          ],
        },
        {
          "ButtonMapId-": 5301,
          "ActivityId-": 301,
          "RemoteId-": 8001,
          "SurfaceId-": 7001,
          "ButtonMapSurfaceId-": 7001,
          __type: "ActivityButtonMap",
          ButtonMapIdentifier: "16417Activity301",
          DateModified: null,
          Sequences: [],
          Buttons: [
            hard(2001, "VolumeUp", "VolumeUp"),
            soft(2008, 2, 8, "9", "9"),
            soft(2009, 0, 9, "NumberPlus", "Clear"),
            soft(2010, 2, 10, "0", "0"),
            soft(2020, 0, 8, "Guide", "Guide"),
            soft(2021, 0, 9, "Audio", "Audio"),
            soft(2022, 0, 10, "Subtitle", "Subtitle"),
          ],
        },
        {
          "ButtonMapId-": 5302,
          "ActivityId-": 302,
          "RemoteId-": 8001,
          "SurfaceId-": 7001,
          "ButtonMapSurfaceId-": 7001,
          __type: "ActivityButtonMap",
          ButtonMapIdentifier: "16417Activity302",
          DateModified: null,
          Sequences: [],
          Buttons: [
            hard(2101, "VolumeUp", "VolumeUp"),
            soft(2110, 0, 0, "Aspect", "Aspect", 302),
          ],
        },
      ],
    },
  };
}

describe("issue #178: pre-existing Logitech IndexInMenu clashes & 16417Device ButtonId 0 maps", () => {
  it("keeps 1-arg validateMapList strict while allowing pre-existing slot 9 clashes against baseline", () => {
    const baseline = logitechClashHubConfig();
    assert.deepEqual(validateMapList(baseline.mapList), [
      "MapList map 16417Activity301 has duplicate IndexInMenu 9 for on-screen buttons",
    ]);

    const hardEdited = logitechClashHubConfig();
    hardEdited.mapList.ButtonMaps[3].Buttons.push({
      __type: "HardRemoteButton",
      FunctionGroupType: 0,
      ButtonId: 2102,
      ButtonState: 1,
      ButtonKey: "VolumeMute",
      ButtonAction: {
        __type: "ButtonCommandAction",
        "DeviceId-": 10,
        CommandName: "Mute",
        "FunctionId-": 0,
        Order: 0,
        EventType: 1,
        Id: 0,
      },
      ButtonLongPressAction: null,
      ButtonDoublePressAction: null,
    });
    assert.deepEqual(validateMapList(hardEdited.mapList, baseline), []);
    assert.deepEqual(validateMapList(hardEdited.mapList, baseline.mapList), []);
  });

  it("still rejects any newly introduced duplicate IndexInMenu even when baseline is provided", () => {
    const baseline = logitechClashHubConfig();

    const newSlotDup = logitechClashHubConfig();
    newSlotDup.mapList.ButtonMaps[2].Buttons.push({
      ...structuredClone(newSlotDup.mapList.ButtonMaps[2].Buttons[4]),
      ButtonId: 2099,
      TextOnRemote: "Duplicate 8",
    });
    assert.deepEqual(validateMapList(newSlotDup.mapList, baseline), [
      "MapList map 16417Activity301 has duplicate IndexInMenu 8 for on-screen buttons",
    ]);

    const thirdOnNine = logitechClashHubConfig();
    thirdOnNine.mapList.ButtonMaps[2].Buttons.push({
      ...structuredClone(thirdOnNine.mapList.ButtonMaps[2].Buttons[5]),
      ButtonId: 2098,
      TextOnRemote: "Third 9",
    });
    assert.deepEqual(validateMapList(thirdOnNine.mapList, baseline), [
      "MapList map 16417Activity301 has duplicate IndexInMenu 9 for on-screen buttons",
    ]);

    const otherActivityDup = logitechClashHubConfig();
    const sample = structuredClone(otherActivityDup.mapList.ButtonMaps[3].Buttons[1]);
    otherActivityDup.mapList.ButtonMaps[3].Buttons.push(
      { ...sample, ButtonId: 2198, MenuItem: { IndexInMenu: 9, MenuName: "Activity.302" } },
      { ...sample, ButtonId: 2199, MenuItem: { IndexInMenu: 9, MenuName: "Activity.302" } },
    );
    assert.deepEqual(validateMapList(otherActivityDup.mapList, baseline), [
      "MapList map 16417Activity302 has duplicate IndexInMenu 9 for on-screen buttons",
    ]);
  });

  it("saves hard-key and home-button edits cleanly when another activity carries an untouched slot 9 clash", () => {
    const cfg = logitechClashHubConfig();
    const hard = readHardKeys(cfg, "302");
    const nextHard = [
      ...hard.rows,
      {
        key: "VolumeMute",
        buttonKey: "VolumeMute",
        buttonId: null,
        action: { kind: "command", deviceId: "10", command: "Mute", functionId: 0 },
        pressMode: "oneShot",
        longPress: { kind: "command", deviceId: "10", command: "Mute", functionId: 0 },
        doublePress: null,
      },
    ];
    const mapList = buildTouchControlsMapList(cfg, { hard: { activityId: "302", rows: nextHard, base: hard.base } });
    assert.deepEqual(validateMapList(mapList, cfg), []);

    let homeDraft = readHomeButtons(cfg, "302", "16417");
    homeDraft = setHomeButtonAction(homeDraft, "HomeControl1", "press", {
      kind: "command",
      deviceId: "10",
      command: "Mute",
      functionId: 0,
    });
    const homeMapList = buildHomeButtonsMapList(cfg, homeDraft);
    assert.deepEqual(validateMapList(homeMapList, cfg), []);
  });

  it("preserves NumberPlus on soft edits and cleanly separates colliding slot 9 rows when moved", () => {
    const cfg = logitechClashHubConfig();
    let draft = readTouchScreen(cfg, "301");
    assert.deepEqual(draft.rows.map((r) => [r.slot, r.label]), [
      [8, "Guide"],
      [9, "NumberPlus"],
      [9, "Audio"],
      [10, "Subtitle"],
    ]);

    // Editing a label without moving preserves both slot 9 buttons and saves cleanly.
    const relabelled = setLabel(draft, draft.rows.find((r) => r.label === "Audio").key, "Audio Track");
    const savedPayload = touchSavePayload(cfg, relabelled, { now: 1761264000000 });
    assert.deepEqual(validateMapList(savedPayload.mapList, cfg), []);
    const afterRelabel = savedPayload.mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === "16417Activity301");
    assert.equal(afterRelabel.Buttons.filter((b) => b.__type === "SoftRemoteButton" && b.FunctionGroupType !== 2).length, 4);
    assert.equal(saveOutcome({ ...cfg, mapList: savedPayload.mapList }, relabelled), "saved");

    // Reordering Audio above NumberPlus de-conflicts slot 9 without dropping any button.
    const movedUp = moveButton(draft, draft.rows.find((r) => r.label === "Audio").key, -1);
    assert.deepEqual(movedUp.rows.map((r) => [r.slot, r.label]), [
      [8, "Guide"],
      [9, "Audio"],
      [10, "Subtitle"],
      [11, "NumberPlus"],
    ]);
    const movedUpPayload = touchSavePayload(cfg, movedUp, { now: 1761264000000 });
    assert.deepEqual(validateMapList(movedUpPayload.mapList), []);
    assert.equal(saveOutcome({ ...cfg, mapList: movedUpPayload.mapList }, movedUp), "saved");

    // Reordering NumberPlus down past Audio also separates them onto distinct slots.
    const movedDown = moveButton(draft, draft.rows.find((r) => r.label === "NumberPlus").key, 1);
    assert.deepEqual(movedDown.rows.map((r) => [r.slot, r.label]), [
      [8, "Guide"],
      [9, "Audio"],
      [10, "Subtitle"],
      [11, "NumberPlus"],
    ]);
    const movedDownPayload = touchSavePayload(cfg, movedDown, { now: 1761264000000 });
    assert.deepEqual(validateMapList(movedDownPayload.mapList), []);
    assert.equal(saveOutcome({ ...cfg, mapList: movedDownPayload.mapList }, movedDown), "saved");
  });
});
