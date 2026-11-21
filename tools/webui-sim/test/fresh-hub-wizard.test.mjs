/* The wizard on a hub that was never set up: the first activity must leave a
   paired remote without a screen able to start it, which needs that remote's
   <EquadID>Root map beside its <EquadID>Activity<id> map (activity.lua
   buttonPress answers a press from the root map while nothing runs, and
   drops it when there is none).

   fixtures/fresh-hub.json is what hardware showed: `blank` is the hub before
   its first activity, `proven` is the setup a paired Smart Control started
   that activity from, once 16414Root had been added by hand. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildActivityGraph, isWizardOwnedActivityMap } from "../public/js/wizard-model.js";
import {
  buildActivityButtonsMapList,
  readActivityButtons,
} from "../public/js/views/remotes-model.js";
import { validateMapList } from "../public/js/views/remote-model.js";
import { readTouchScreen } from "../public/js/views/touch-model.js";

const load = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
const FRESH = load("fresh-hub.json");
const CONFIGURED = load("activity-config.json");

const DEVICE = String(FRESH.blank.deviceList.DevicesWithFeatures[0].Device["Id-"]);
const firstActivity = (overrides = {}) => ({
  name: "Watch TV",
  type: 1,
  roles: [{ deviceId: DEVICE, roleType: "DisplayActivityRole", input: "", powerDelay: "" }],
  buttons: {},
  ...overrides,
});
const withKeys = () => firstActivity({
  buttons: { VolumeUp: { deviceId: DEVICE, command: { name: "Power", functionId: 0 }, hold: null } },
});

const mapById = (graph, id) => graph.mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === id) ?? null;
const rootOf = (graph, remote) => mapById(graph, `${remote}Root`);

/* Dates are the save's own time; everything else must match. */
function undated(value) {
  return JSON.parse(JSON.stringify(value), (_, v) =>
    (typeof v === "string" && /^\/Date\(\d+\+0000\)\/$/.test(v) ? "/Date(0+0000)/" : v));
}

/* The one activity button a new root map carries. */
function assertStarts(root, key, activityId) {
  assert.equal(root.__type, "RootButtonMap");
  assert.deepEqual(root.Buttons.map((b) => b.ButtonKey), [key]);
  assert.deepEqual(root.Buttons[0].ButtonAction, {
    __type: "ButtonActivityAction",
    "ActivityId-": Number(activityId),
    Order: 0,
    EventType: 1,
    Id: 0,
  });
  assert.equal(root.Buttons[0].ButtonLongPressAction, null);
}

describe("the first activity on a fresh hub", () => {
  it("is the setup hardware started from a Smart Control: 16414Activity and 16414Root", () => {
    const graph = buildActivityGraph({ config: FRESH.blank, draft: firstActivity(), editId: null });
    assert.ok(mapById(graph, `16414Activity${graph.activityId}`), "the activity map");
    const root = rootOf(graph, "16414");
    assert.ok(root, "16414Root is created with the first activity map");
    assertStarts(root, "WatchTVActivity", graph.activityId);
    assert.deepEqual(undated({
      activityList: graph.activityList,
      mapList: graph.mapList,
      functionList: graph.functionList,
    }), undated(FRESH.proven));
  });

  it("makes the root map Settings > Remotes > Activity buttons would have made", () => {
    const graph = buildActivityGraph({ config: FRESH.blank, draft: firstActivity(), editId: null });
    const withoutRoot = {
      ...graph,
      mapList: { ButtonMaps: graph.mapList.ButtonMaps.filter((m) => m.ButtonMapIdentifier !== "16414Root") },
    };
    const byHand = buildActivityButtonsMapList(
      withoutRoot, [{ key: "WatchTVActivity", press: graph.activityId, longPress: null }], "16414");
    assert.deepEqual(undated(rootOf(graph, "16414")), undated(rootOf(byHand, "16414")));
    assert.equal(readActivityButtons(graph, "16414").rows.find((r) => r.key === "WatchTVActivity").press, graph.activityId);
  });

  for (const companion of ["16422", "16423"]) {
    it(`gives a paired Companion (${companion}) its own activity map and ${companion}Root`, () => {
      const graph = buildActivityGraph({ config: FRESH.blank, draft: withKeys(), editId: null, remotes: [companion] });
      const own = mapById(graph, `${companion}Activity${graph.activityId}`);
      assert.ok(own, "the Companion's activity map");
      assert.equal(own.__type, "ActivityButtonMap");
      assert.equal(own["ActivityId-"], Number(graph.activityId));
      const wizard = graph.mapList.ButtonMaps.find((m) => isWizardOwnedActivityMap(m, graph.activityId));
      assert.deepEqual(own.Buttons.map((b) => b.ButtonKey), ["VolumeUp"]);
      assert.deepEqual(own.Buttons[0].ButtonAction, wizard.Buttons[0].ButtonAction);
      assertStarts(rootOf(graph, companion), "WatchTVActivity", graph.activityId);
      // The Smart Control's maps are written whether or not one is paired.
      assertStarts(rootOf(graph, "16414"), "WatchTVActivity", graph.activityId);
      const other = companion === "16422" ? "16423" : "16422";
      assert.ok(!graph.mapList.ButtonMaps.some((m) => String(m.ButtonMapIdentifier).startsWith(other)), "no maps for a Companion that isn't paired");
    });
  }

  it("a Companion that isn't paired gets no maps", () => {
    const graph = buildActivityGraph({ config: FRESH.blank, draft: withKeys(), editId: null, remotes: ["16414"] });
    assert.deepEqual(graph.mapList.ButtonMaps.map((m) => m.ButtonMapIdentifier).sort(),
      [`16414Activity${graph.activityId}`, "16414Root"]);
  });

  it("a screen remote gets no root map: it has no activity buttons, and Logitech made none", () => {
    assert.ok(!CONFIGURED.mapList.ButtonMaps.some((m) => m.ButtonMapIdentifier === "16417Root"), "Logitech's own setup has none");
    const graph = buildActivityGraph({ config: FRESH.blank, draft: withKeys(), editId: null, remotes: ["16417"] });
    assert.ok(mapById(graph, `16417Activity${graph.activityId}`), "the screen remote got its activity map");
    assert.ok(!graph.mapList.ButtonMaps.some((m) => m.ButtonMapIdentifier === "16417Root"));
    assert.ok(!graph.mapList.ButtonMaps.some((m) => String(m.__type).includes("RootButtonMap") && String(m.ButtonMapIdentifier).startsWith("16417")));
    // A cloud-seeded Touch (skin 99) hub behaves the same: keeps its cloud 16417 surface and gets no 16417Root.
    const cloud = buildActivityGraph({
      config: CONFIGURED,
      draft: { name: "Touch cloud", type: 1, roles: [], buttons: {} },
      editId: null,
      remotes: ["16417"],
    });
    const cloudTouch = mapById(cloud, `16417Activity${cloud.activityId}`);
    assert.ok(cloudTouch, "cloud hub still builds 16417Activity");
    assert.equal(cloudTouch["SurfaceId-"], 14551427);
    assert.equal(cloudTouch["ButtonMapSurfaceId-"], 14551427);
    assert.equal(cloudTouch["RemoteId-"], 12345678);
    assert.ok(!cloud.mapList.ButtonMaps.some((m) => m.ButtonMapIdentifier === "16417Root"));
  });

  it("gives a paired screen remote on an offline hub its own activity map (#219)", () => {
    const graph = buildActivityGraph({ config: FRESH.blank, draft: withKeys(), editId: null, remotes: ["16417"] });
    const own = mapById(graph, `16417Activity${graph.activityId}`);
    assert.ok(own, "the screen remote's activity map");
    assert.equal(own.__type, "ActivityButtonMap");
    assert.equal(own["ActivityId-"], Number(graph.activityId));
    // No 16417 map on the hub to take surface ids from, and the Smart Control's are not the screen's.
    for (const key of ["ButtonMapSurfaceId-", "RemoteId-", "SurfaceId-"]) assert.equal(own[key], null, key);
    const wizard = graph.mapList.ButtonMaps.find((m) => isWizardOwnedActivityMap(m, graph.activityId));
    const hard = own.Buttons.filter((b) => b.__type === "HardRemoteButton");
    assert.deepEqual(hard.map((b) => b.ButtonKey), ["VolumeUp"]);
    assert.deepEqual(hard[0].ButtonAction, wizard.Buttons[0].ButtonAction);
    assert.deepEqual(validateMapList(graph.mapList), []);
    const saved = { ...FRESH.blank, activityList: graph.activityList, mapList: graph.mapList, functionList: graph.functionList };
    const screen = readTouchScreen(saved, graph.activityId);
    assert.equal(screen.exists, true);
    assert.equal(screen.canCreate, true);
  });

  it("mirrors Touch hard-key spelling and seeds on-screen buttons on a fresh hub with a paired 16417", () => {
    const config = structuredClone(FRESH.blank);
    config.deviceList.DevicesWithFeatures[0].Commands.push(
      { Name: "Home", "FunctionId-": 10 },
      { Name: "1", "FunctionId-": 11 },
      { Name: "Guide", "FunctionId-": 12 },
    );
    const draft = firstActivity({
      buttons: {
        VolumeUp: { deviceId: DEVICE, command: { name: "Power", functionId: 0 }, hold: null },
        Dvr: { deviceId: DEVICE, command: { name: "Guide", functionId: 12 }, hold: null },
        Number1: { deviceId: DEVICE, command: { name: "1", functionId: 11 }, hold: null },
      },
    });
    const graph = buildActivityGraph({ config, draft, editId: null, remotes: ["16417"] });
    const own = mapById(graph, `16417Activity${graph.activityId}`);
    assert.ok(own);
    const hardKeys = own.Buttons.filter((b) => b.__type === "HardRemoteButton").map((b) => b.ButtonKey).sort();
    assert.deepEqual(hardKeys, ["DVR", "VolumeUp"], "Dvr becomes DVR and digits stay off hard keys");
    const soft = own.Buttons.filter((b) => b.__type === "SoftRemoteButton");
    assert.ok(soft.some((b) => b.FunctionGroupType === 2 && b.TextOnRemote === "1"), "number pad seeded");
    assert.ok(soft.some((b) => b.FunctionGroupType === 0 && b.TextOnRemote === "Home"), "Home button seeded");
    assert.deepEqual(validateMapList(graph.mapList), []);
  });

  it("never copies Smart Control surface ids onto 16417 maps across first or later activities", () => {
    const smartOnly = structuredClone(CONFIGURED);
    smartOnly.mapList.ButtonMaps = smartOnly.mapList.ButtonMaps.filter(
      (m) => !String(m.ButtonMapIdentifier ?? "").startsWith("16417"),
    );
    const devId = String(smartOnly.deviceList.DevicesWithFeatures[0].Device["Id-"]);
    const draft = (name) => ({
      name,
      type: 1,
      roles: [{ deviceId: devId, roleType: "DisplayActivityRole", input: "", powerDelay: "" }],
      buttons: { VolumeUp: { deviceId: devId, command: { name: "VolumeUp", functionId: 0 }, hold: null } },
    });
    const first = buildActivityGraph({ config: smartOnly, draft: draft("First"), editId: null, remotes: ["16417"] });
    const first16417 = mapById(first, `16417Activity${first.activityId}`);
    assert.ok(first16417);
    for (const key of ["ButtonMapSurfaceId-", "RemoteId-", "SurfaceId-"]) assert.equal(first16417[key], null, `first ${key}`);
    const afterFirst = { ...smartOnly, activityList: first.activityList, mapList: first.mapList, functionList: first.functionList };
    const second = buildActivityGraph({ config: afterFirst, draft: draft("Second"), editId: null, remotes: ["16417"] });
    const second16417 = mapById(second, `16417Activity${second.activityId}`);
    assert.ok(second16417);
    for (const key of ["ButtonMapSurfaceId-", "RemoteId-", "SurfaceId-"]) assert.equal(second16417[key], null, `second ${key}`);
    assert.deepEqual(validateMapList(second.mapList), []);
  });

  it("a screen remote that isn't paired still gets no maps on an offline hub", () => {
    const graph = buildActivityGraph({ config: FRESH.blank, draft: withKeys(), editId: null, remotes: ["16414"] });
    assert.ok(!graph.mapList.ButtonMaps.some((m) => String(m.ButtonMapIdentifier).startsWith("16417")));
  });

  it("re-saving an activity made before the screen remote was paired adds its map", () => {
    const first = buildActivityGraph({ config: FRESH.blank, draft: withKeys(), editId: null, remotes: [] });
    const config = { ...FRESH.blank, activityList: first.activityList, mapList: first.mapList, functionList: first.functionList };
    assert.ok(!first.mapList.ButtonMaps.some((m) => String(m.ButtonMapIdentifier).startsWith("16417")));
    const again = buildActivityGraph({ config, draft: withKeys(), editId: first.activityId, remotes: ["16417"] });
    assert.ok(mapById(again, `16417Activity${first.activityId}`), "the screen remote's map after the edit");
    assert.deepEqual(validateMapList(again.mapList), []);
  });

  it("puts the activity on the button named for its kind", () => {
    for (const [type, key] of [[1, "WatchTVActivity"], [2, "MovieActivity"], [4, "MusicActivity"], [3, "WatchTVActivity"]]) {
      const graph = buildActivityGraph({ config: FRESH.blank, draft: firstActivity({ type }), editId: null });
      assertStarts(rootOf(graph, "16414"), key, graph.activityId);
    }
  });

  it("saves a MapList the map checks accept, with no identity used twice", () => {
    const graph = buildActivityGraph({ config: FRESH.blank, draft: withKeys(), editId: null, remotes: ["16422"] });
    assert.deepEqual(validateMapList(graph.mapList), []);
    const mapIds = graph.mapList.ButtonMaps.map((m) => m["ButtonMapId-"]);
    const buttonIds = graph.mapList.ButtonMaps.flatMap((m) => m.Buttons.map((b) => b.ButtonId));
    assert.equal(new Set(mapIds).size, mapIds.length);
    assert.equal(new Set(buttonIds).size, buttonIds.length);
  });
});

describe("a root map after the first activity", () => {
  it("a hub left without one (set up before this fix) gets it on the next save of an activity", () => {
    const config = structuredClone(FRESH.blank);
    Object.assign(config, structuredClone(FRESH.proven));
    config.mapList.ButtonMaps = config.mapList.ButtonMaps.filter((m) => m.ButtonMapIdentifier !== "16414Root");
    const id = String(config.activityList.Activities[0]["Id-"]);
    const graph = buildActivityGraph({ config, draft: firstActivity(), editId: id });
    assertStarts(rootOf(graph, "16414"), "WatchTVActivity", id);
  });

  it("a second activity leaves the root map exactly as it is", () => {
    const config = structuredClone(FRESH.blank);
    Object.assign(config, structuredClone(FRESH.proven));
    const before = structuredClone(config.mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === "16414Root"));
    const graph = buildActivityGraph({ config, draft: firstActivity({ name: "Movie night", type: 2 }), editId: null });
    assert.deepEqual(rootOf(graph, "16414"), before);
    assert.equal(graph.mapList.ButtonMaps.filter((m) => m.ButtonMapIdentifier === "16414Root").length, 1);
  });

  it("Logitech's root map is never touched, by a new activity or an edit", () => {
    const before = structuredClone(CONFIGURED.mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === "16414Root"));
    const made = buildActivityGraph({ config: CONFIGURED, draft: { name: "New", type: 2, roles: [], buttons: {} }, editId: null });
    assert.deepEqual(rootOf(made, "16414"), before);
    const roots = made.mapList.ButtonMaps.filter((m) => String(m.__type).includes("RootButtonMap"));
    assert.deepEqual(roots.map((m) => m.ButtonMapIdentifier), ["16414Root"], "and no other root map appears");
  });

  it("a Companion with activity maps and no root map gets its own, on its own surface", () => {
    const config = structuredClone(CONFIGURED);
    const companion = config.mapList.ButtonMaps
      .filter((m) => /^16414Activity/.test(m.ButtonMapIdentifier))
      .map((m, i) => ({
        ...structuredClone(m),
        "ButtonMapId-": 70000000 + i,
        ButtonMapIdentifier: m.ButtonMapIdentifier.replace(/^16414/, "16422"),
        "RemoteId-": 4242, "SurfaceId-": 4243, "ButtonMapSurfaceId-": 4244,
        Buttons: m.Buttons.map((b, j) => ({ ...structuredClone(b), ButtonId: 71000000 + i * 100 + j })),
      }));
    config.mapList.ButtonMaps.push(...companion);
    const smartRoot = structuredClone(config.mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === "16414Root"));
    const graph = buildActivityGraph({ config, draft: { name: "Records", type: 4, roles: [], buttons: {} }, editId: null });
    const root = rootOf(graph, "16422");
    assertStarts(root, "MusicActivity", graph.activityId);
    assert.deepEqual([root["RemoteId-"], root["SurfaceId-"], root["ButtonMapSurfaceId-"]], [4242, 4243, 4244]);
    assert.deepEqual(rootOf(graph, "16414"), smartRoot);
    assert.equal(rootOf(graph, "16423"), null);
  });
});
