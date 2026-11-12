/* Issue #86, question 1: a remote paired after its activities exist.
   The engine answers a press from <EquadID>Activity<id> while that activity
   runs and drops it when that map is missing. Pairing writes no maps, and
   Logitech's setup made activity maps only for the remotes the account had,
   so a Smart Control paired onto a Companion hub started an activity from
   16414Root and was then dead in it until each activity was saved again.

   The fixtures are synthetic (fixtures/issue86/README.md): generic
   activities, devices and ids in the same shape as the reported hub —
   paired snapshot with no 16414 activity maps, resaved snapshot with two of
   them plus the 16420 keyboard map. The fix must turn the first into the
   second's 16414 maps with no re-save. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildActivityButtonsMapList,
  buildRemoteActivityMapsMapList,
  missingRemoteActivityMaps,
  parseRfInfo,
  remoteActivityMapsSaveOutcome,
} from "../public/js/views/remotes-model.js";
import { validateMapList } from "../public/js/views/remote-model.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/issue86");
const load = (name) => JSON.parse(fs.readFileSync(join(FIXTURES, name), "utf8"));

const BETA = "102";
const GAMMA = "103";
const ALPHA = "101"; // never re-saved in the synthetic hub
const PAIRED = ["16422", "16414"];

function pairedSnapshot() {
  return {
    revision: "test",
    activityList: load("synthetic_ActivityList.json"),
    mapList: load("synthetic_paired_MapList.json"),
  };
}
const resaved = () => load("synthetic_resaved_MapList.json");

const identifiers = (mapList) => mapList.ButtonMaps.map((m) => m.ButtonMapIdentifier);
const mapOf = (mapList, id) => mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === id);
const actionShape = (a) => (a
  ? [a.__type, String(a["DeviceId-"] ?? ""), a.CommandName ?? null, String(a["FunctionId-"] ?? ""), a.EventType ?? null]
  : null);
const keyShapes = (map) => Object.fromEntries(map.Buttons
  .map((b) => [b.ButtonKey, [
    b.__type, b.FunctionGroupType,
    actionShape(b.ButtonAction), actionShape(b.ButtonLongPressAction), actionShape(b.ButtonDoublePressAction),
  ]])
  .sort(([a], [b]) => a.localeCompare(b)));

/* The engine's lookup (activity.lua buttonPress): the map a press resolves
   to while `activityId` runs; null means the press is dropped. */
const engineMap = (mapList, equadId, activityId) => mapOf(mapList, `${equadId}Activity${activityId}`) ?? null;

describe("issue #86: a synthetic hub after pairing a Smart Control", () => {
  it("has a root map for the new remote and no activity map (the reported state)", () => {
    const config = pairedSnapshot();
    assert.ok(mapOf(config.mapList, "16414Root"));
    for (const id of [BETA, GAMMA, ALPHA]) {
      assert.equal(engineMap(config.mapList, "16414", id), null, `16414 press in ${id} is dropped`);
      assert.ok(engineMap(config.mapList, "16422", id), `16422 has its map in ${id}`);
    }
  });

  it("lists every activity the new remote has no keys for", () => {
    const missing = missingRemoteActivityMaps(pairedSnapshot(), PAIRED);
    assert.deepEqual(missing.map((m) => `${m.remote}:${m.activityId}`).sort(),
      [`16414:${ALPHA}`, `16414:${BETA}`, `16414:${GAMMA}`].sort());
    assert.ok(missing.every((m) => m.name));
  });

  it("makes the maps the two re-saves made, and the third activity's too", () => {
    const config = pairedSnapshot();
    const { mapList, created } = buildRemoteActivityMapsMapList(config, PAIRED);
    assert.deepEqual(created.slice().sort(),
      [`16414Activity${ALPHA}`, `16414Activity${BETA}`, `16414Activity${GAMMA}`].sort());
    /* The re-saved hub's map set, less the 16420 keyboard map (the wizard
       makes that for an activity with a text-entry device; no remote
       resolves presses through it), plus the activity nobody re-saved. */
    const expected = identifiers(resaved())
      .filter((id) => id !== `16420Activity${BETA}`)
      .concat(`16414Activity${ALPHA}`);
    assert.deepEqual(identifiers(mapList).sort(), expected.sort());
    for (const id of [BETA, GAMMA, ALPHA]) {
      assert.ok(engineMap(mapList, "16414", id), `16414 press in ${id} now resolves`);
    }
  });

  it("gives each new map the same keys and commands the re-save gave it", () => {
    const { mapList } = buildRemoteActivityMapsMapList(pairedSnapshot(), PAIRED);
    const after = resaved();
    for (const id of [BETA, GAMMA]) {
      const made = mapOf(mapList, `16414Activity${id}`);
      const real = mapOf(after, `16414Activity${id}`);
      assert.deepEqual(keyShapes(made), keyShapes(real), `16414Activity${id}`);
      for (const field of ["RemoteId-", "SurfaceId-", "ButtonMapSurfaceId-", "__type", "ActivityId-"]) {
        assert.equal(made[field], real[field], `${id} ${field}`);
      }
    }
  });

  it("takes only command keys: the Companion's sequence key stays the Companion's", () => {
    const config = pairedSnapshot();
    const companion = mapOf(config.mapList, `16422Activity${BETA}`);
    assert.ok(companion.Buttons.some((b) => b.ButtonKey === "Red" && b.ButtonAction.__type === "ButtonSequenceAction"));
    const { mapList } = buildRemoteActivityMapsMapList(config, PAIRED);
    const made = mapOf(mapList, `16414Activity${BETA}`);
    assert.ok(!made.Buttons.some((b) => b.ButtonKey === "Red"));
    assert.ok(made.Buttons.every((b) => b.ButtonAction?.CommandName && b.ButtonState === 1 && b.ButtonId > 0));
  });

  it("leaves every existing map exactly as it was and issues fresh ids", () => {
    const config = pairedSnapshot();
    const before = structuredClone(config);
    const { mapList, created } = buildRemoteActivityMapsMapList(config, PAIRED);
    assert.deepEqual(config, before, "the input is not mutated");
    for (const map of before.mapList.ButtonMaps) {
      assert.deepEqual(mapOf(mapList, map.ButtonMapIdentifier), map);
    }
    const mapIds = mapList.ButtonMaps.map((m) => m["ButtonMapId-"] ?? m.ButtonMapId);
    assert.equal(new Set(mapIds).size, mapIds.length, "map ids are unique");
    const buttonIds = mapList.ButtonMaps.flatMap((m) => m.Buttons.map((b) => b.ButtonId)).filter((n) => n > 0);
    assert.equal(new Set(buttonIds).size, buttonIds.length, "button ids are unique");
    /* The new maps add nothing the remote-map validator objects to. */
    const errorsBefore = validateMapList(before.mapList);
    assert.deepEqual(validateMapList(mapList), errorsBefore);
    assert.equal(created.length, 3);
  });

  it("is a no-op once the maps exist", () => {
    const config = pairedSnapshot();
    const { mapList } = buildRemoteActivityMapsMapList(config, PAIRED);
    const again = buildRemoteActivityMapsMapList({ ...config, mapList }, PAIRED);
    assert.deepEqual(again.created, []);
    assert.deepEqual(again.mapList, mapList);
    assert.deepEqual(missingRemoteActivityMaps({ ...config, mapList }, PAIRED), []);
    /* The re-saved hub still lacked one. */
    assert.deepEqual(
      missingRemoteActivityMaps({ ...config, mapList: resaved() }, PAIRED).map((m) => m.activityId),
      [ALPHA],
    );
  });

  it("only acts for remotes that are paired", () => {
    const config = pairedSnapshot();
    assert.deepEqual(buildRemoteActivityMapsMapList(config, ["16422"]).created, []);
    assert.deepEqual(buildRemoteActivityMapsMapList(config, []).created, []);
    assert.deepEqual(buildRemoteActivityMapsMapList(config, undefined).created, []);
    /* A remote with a screen keeps its setup itself and is left alone; so
       are a keyboard and a dongle. */
    assert.deepEqual(buildRemoteActivityMapsMapList(config, ["16417", "16420", "34830"]).created, []);
  });

  it("reads the paired remotes from the hub's own rf.info reply", () => {
    const reply = JSON.stringify({
      id: 1,
      data: {
        EquadID: "34827", RFID: "SYNTHETIC", DeviceCount: 2,
        Devices: [
          { EquadID: "16422", SkinId: "", DeviceIndex: "1", RFID: "SYNTHETIC" },
          { EquadID: "16414", SkinId: "", DeviceIndex: "2", RFID: "SYNTHETIC" },
        ],
      },
      code: 200,
    });
    const { created } = buildRemoteActivityMapsMapList(pairedSnapshot(), parseRfInfo(reply).remotes);
    assert.equal(created.length, 3);
  });
});

describe("issue #86: a paired remote's missing maps, other shapes", () => {
  it("makes an empty map when no other remote has keys there, so Off still reaches the root map", () => {
    const config = pairedSnapshot();
    config.mapList.ButtonMaps = config.mapList.ButtonMaps.filter((m) => m.ButtonMapIdentifier !== `16422Activity${GAMMA}`);
    const { mapList } = buildRemoteActivityMapsMapList(config, ["16414"]);
    const made = mapOf(mapList, `16414Activity${GAMMA}`);
    assert.ok(made);
    assert.deepEqual(made.Buttons, []);
    assert.deepEqual(made.Sequences, []);
  });

  it("gives a Companion paired onto a Smart Control hub its maps too", () => {
    const config = pairedSnapshot();
    const full = buildRemoteActivityMapsMapList(config, PAIRED).mapList;
    const smartOnly = { ...config, mapList: { ...full, ButtonMaps: full.ButtonMaps.filter((m) => !String(m.ButtonMapIdentifier).startsWith("16422")) } };
    const { mapList, created } = buildRemoteActivityMapsMapList(smartOnly, ["16414", "16423"]);
    assert.deepEqual(created.slice().sort(), [ALPHA, BETA, GAMMA].map((id) => `16423Activity${id}`).sort());
    assert.deepEqual(
      keyShapes(mapOf(mapList, `16423Activity${BETA}`)),
      keyShapes(mapOf(full, `16414Activity${BETA}`)),
    );
  });

  it("borrows a screen remote's hard keys in the no-screen spelling", () => {
    const config = pairedSnapshot();
    const source = mapOf(config.mapList, `16422Activity${BETA}`);
    source.ButtonMapIdentifier = `16417Activity${BETA}`;
    source.Buttons.find((b) => b.ButtonKey === "Info").ButtonKey = "DVR";
    const { mapList } = buildRemoteActivityMapsMapList(config, ["16414"]);
    const keys = mapOf(mapList, `16414Activity${BETA}`).Buttons.map((b) => b.ButtonKey);
    assert.ok(keys.includes("Dvr"));
    assert.ok(!keys.includes("DVR"));
    assert.ok(keys.includes("VolumeUp"));
  });

  it("reports whether an unconfirmed save landed", () => {
    const config = pairedSnapshot();
    const { mapList, created } = buildRemoteActivityMapsMapList(config, PAIRED);
    assert.equal(remoteActivityMapsSaveOutcome({ ...config, mapList }, created), "saved");
    assert.equal(remoteActivityMapsSaveOutcome(config, created), "unchanged");
    assert.equal(remoteActivityMapsSaveOutcome({ ...config, mapList: resaved() }, created), "changed");
  });

  it("a new root map borrows surface ids instead of saving nulls", () => {
    const config = pairedSnapshot();
    config.mapList.ButtonMaps = config.mapList.ButtonMaps.filter((m) => m.ButtonMapIdentifier !== "16414Root");
    const { mapList } = buildActivityButtonsMapList(config, [{ key: "WatchTVActivity", press: BETA, longPress: "" }], "16414");
    const root = mapOf(mapList, "16414Root");
    assert.equal(root["RemoteId-"], 7000001);
    assert.equal(root["SurfaceId-"], 6000001);
    assert.equal(root["ButtonMapSurfaceId-"], 6000001);
  });
});
