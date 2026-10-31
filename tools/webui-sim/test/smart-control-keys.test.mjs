import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SMART_CONTROL_HARD_KEYS,
  TOUCH_HARD_KEYS,
  buildTouchControlsMapList,
  controlsSaveOutcome,
  hardKeysFor,
  hasRemoteMaps,
  keyOn,
  keyRowsChanged,
  otherRemote,
  readHardKeys,
  sameKey,
} from "../public/js/views/touch-model.js";
import { validateMapList } from "../public/js/views/remote-model.js";

/* The Touch editor's hard-key half, pointed at the Smart Control's maps
   (16414Activity<id>) from Settings → Remotes, and the two remotes' keys
   kept alike in one save. */

const fixture = (() => {
  const raw = JSON.parse(readFileSync(new URL("../fixtures/activity-config.json", import.meta.url), "utf8"));
  const ids = new Set(raw.activityList.Activities.map((a) => String(a["Id-"])));
  raw.mapList.ButtonMaps = raw.mapList.ButtonMaps.filter((m) => m["ActivityId-"] == null || ids.has(String(m["ActivityId-"])));
  // The fixture's root map still starts an activity it no longer has; the hub refuses that.
  for (const map of raw.mapList.ButtonMaps) {
    for (const button of map.Buttons ?? []) {
      for (const field of ["ButtonAction", "ButtonLongPressAction"]) {
        const id = button[field]?.["ActivityId-"];
        if (id != null && !ids.has(String(id))) button[field] = null;
      }
    }
  }
  raw.functionList = { FunctionMaps: [...ids].map((id) => ({ __type: "ActivityFunctionMap", "ActivityId-": Number(id), FunctionGroups: [] })) };
  return raw;
})();
const config = () => structuredClone(fixture);
const mapOf = (cfg, id) => cfg.mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === id);
const SHIELD = "48113644";
const WITHOUT_SMART = "1594209107"; // has a Touch map but no Smart Control map
const SMART = { remote: "16414" };

describe("the Smart Control's keys in the activity editor", () => {
  it("offers each remote its own keys", () => {
    assert.equal(hardKeysFor("16414"), SMART_CONTROL_HARD_KEYS);
    assert.equal(hardKeysFor(), TOUCH_HARD_KEYS);
    assert.ok(SMART_CONTROL_HARD_KEYS.includes("Number5") && SMART_CONTROL_HARD_KEYS.includes("Dvr"));
    assert.ok(!TOUCH_HARD_KEYS.includes("Number5"));
  });

  it("reads the Smart Control's map, not the Touch's", () => {
    const smart = readHardKeys(config(), SHIELD, SMART);
    const touch = readHardKeys(config(), SHIELD);
    assert.equal(smart.exists, true);
    assert.equal(smart.base, JSON.stringify(mapOf(fixture, `16414Activity${SHIELD}`)));
    assert.equal(touch.base, JSON.stringify(mapOf(fixture, `16417Activity${SHIELD}`)));
    assert.deepEqual(smart.rows.map((r) => r.buttonKey), mapOf(fixture, `16414Activity${SHIELD}`).Buttons.map((b) => b.ButtonKey).sort());
  });

  it("writes a key change to the Smart Control's map only", () => {
    const cfg = config();
    const read = readHardKeys(cfg, SHIELD, SMART);
    const rows = read.rows.map((r) => (r.buttonKey === "Menu" ? { ...r, action: { kind: "command", deviceId: r.action.deviceId, command: "Home", functionId: 0 } } : r));
    const mapList = buildTouchControlsMapList(cfg, { hard: { activityId: SHIELD, rows, base: read.base } }, { ...SMART, now: 0 });
    const smart = mapOf({ mapList }, `16414Activity${SHIELD}`);
    const menu = smart.Buttons.find((b) => b.ButtonKey === "Menu");
    assert.equal(menu.ButtonAction.CommandName, "Home");
    assert.equal(menu.ButtonId, mapOf(fixture, `16414Activity${SHIELD}`).Buttons.find((b) => b.ButtonKey === "Menu").ButtonId);
    for (const map of mapList.ButtonMaps) {
      if (map.ButtonMapIdentifier !== `16414Activity${SHIELD}`) assert.deepEqual(map, mapOf(fixture, map.ButtonMapIdentifier));
    }
    assert.deepEqual(validateMapList(mapList), []);
    assert.equal(controlsSaveOutcome({ ...cfg, mapList }, SHIELD, read.base, mapList, SMART), "saved");
    assert.equal(controlsSaveOutcome(cfg, SHIELD, read.base, mapList, SMART), "unchanged");
  });

  it("puts a new number key in the number-pad group", () => {
    const cfg = config();
    const read = readHardKeys(cfg, SHIELD, SMART);
    const deviceId = read.rows.find((r) => r.action?.kind === "command").action.deviceId;
    const rows = [...read.rows.filter((r) => r.buttonKey !== "Number7"), { buttonKey: "Number7", buttonId: null, action: { kind: "command", deviceId, command: "7", functionId: 0 }, pressMode: "standard", longPress: null }];
    const mapList = buildTouchControlsMapList(cfg, { hard: { activityId: SHIELD, rows, base: read.base } }, SMART);
    const added = mapOf({ mapList }, `16414Activity${SHIELD}`).Buttons.find((b) => b.ButtonKey === "Number7");
    assert.equal(added.FunctionGroupType, 2);
    assert.equal(added.ButtonAction.EventType, 1);
  });

  it("makes the Smart Control's map for an activity that has none, on its own surface", () => {
    const cfg = config();
    assert.equal(mapOf(cfg, `16414Activity${WITHOUT_SMART}`), undefined);
    const read = readHardKeys(cfg, WITHOUT_SMART, SMART);
    assert.equal(read.exists, false);
    const deviceId = String(cfg.activityList.Activities.find((a) => String(a["Id-"]) === WITHOUT_SMART).Roles[0]["DeviceId-"]);
    const rows = [{ buttonKey: "VolumeUp", buttonId: null, action: { kind: "command", deviceId, command: "VolumeUp", functionId: 0 }, pressMode: "standard", longPress: null }];
    const mapList = buildTouchControlsMapList(cfg, { hard: { activityId: WITHOUT_SMART, rows, base: read.base } }, SMART);
    const made = mapOf({ mapList }, `16414Activity${WITHOUT_SMART}`);
    const sibling = mapOf(fixture, `16414Activity${SHIELD}`);
    assert.equal(made.__type, "ActivityButtonMap");
    assert.equal(made["SurfaceId-"], sibling["SurfaceId-"]);
    assert.equal(made["RemoteId-"], sibling["RemoteId-"]);
    assert.deepEqual(made.Buttons.map((b) => b.ButtonKey), ["VolumeUp"]);
    assert.deepEqual(mapOf({ mapList }, `16417Activity${WITHOUT_SMART}`), mapOf(fixture, `16417Activity${WITHOUT_SMART}`));
    assert.deepEqual(validateMapList(mapList), []);
  });

  it("refuses to invent a Smart Control map on a hub that has none", () => {
    const cfg = config();
    cfg.mapList.ButtonMaps = cfg.mapList.ButtonMaps.filter((m) => !String(m.ButtonMapIdentifier).startsWith("16414"));
    assert.equal(hasRemoteMaps(cfg, "16414"), false);
    const read = readHardKeys(cfg, SHIELD, SMART);
    const rows = [{ buttonKey: "Menu", buttonId: null, action: { kind: "command", deviceId: "1", command: "Menu", functionId: 0 }, pressMode: "standard", longPress: null }];
    assert.throws(() => buildTouchControlsMapList(cfg, { hard: { activityId: SHIELD, rows, base: read.base } }, SMART), /no Smart Control keys/);
  });
});

describe("both remotes' keys in one save", () => {
  const command = (deviceId, name) => ({ kind: "command", deviceId, command: name, functionId: 0 });
  const row = (key, action, extra = {}) => ({ key, buttonKey: key, buttonId: null, action, pressMode: "standard", longPress: null, doublePress: null, ...extra });

  it("names keys each remote's way, and only keys it has", () => {
    assert.equal(otherRemote("16414"), "16417");
    assert.equal(otherRemote(), "16414");
    assert.equal(keyOn("16414", "DVR"), "Dvr");
    assert.equal(keyOn("16417", "Dvr"), "DVR");
    assert.equal(keyOn("16417", "Number1"), "", "the Touch has no number keys");
    assert.equal(keyOn("16414", "Home"), "");
  });

  it("matches keys by what they do, not by ids", () => {
    const a = row("Play", command("1", "Play"), { buttonId: 5 });
    assert.ok(sameKey(a, row("Play", command("1", "Play"), { buttonId: 9 })));
    assert.ok(!sameKey(a, row("Play", command("2", "Play"))));
    assert.ok(!sameKey(a, { ...a, pressMode: "oneShot", longPress: a.action }));
    assert.ok(sameKey(null, undefined), "neither remote having the key counts as alike");
    assert.ok(!sameKey(a, null));
    assert.ok(!keyRowsChanged([a], [{ ...a, buttonId: 7 }]));
    assert.ok(keyRowsChanged([a], []));
  });

  it("writes a key to both remotes, keeping each one's ids and spelling", () => {
    const cfg = config();
    const mine = readHardKeys(cfg, SHIELD, SMART);
    const theirs = readHardKeys(cfg, SHIELD);
    const deviceId = mine.rows.find((r) => r.action?.kind === "command").action.deviceId;
    const edit = row("Dvr", command(deviceId, "Recordings"));
    const twinRows = [...theirs.rows.filter((r) => r.buttonKey !== "DVR"), { ...edit, key: "DVR", buttonKey: "DVR" }];
    const mapList = buildTouchControlsMapList(cfg, {
      hard: { activityId: SHIELD, rows: [...mine.rows.filter((r) => r.buttonKey !== "Dvr"), edit], base: mine.base },
      twin: { remote: "16417", rows: twinRows, base: theirs.base },
    }, SMART);
    const smart = mapOf({ mapList }, `16414Activity${SHIELD}`).Buttons.find((b) => b.ButtonKey === "Dvr");
    const touch = mapOf({ mapList }, `16417Activity${SHIELD}`).Buttons.find((b) => b.ButtonKey === "DVR");
    assert.equal(smart.ButtonAction.CommandName, "Recordings");
    assert.equal(touch.ButtonAction.CommandName, "Recordings");
    const before = mapOf(fixture, `16417Activity${SHIELD}`).Buttons.find((b) => b.ButtonKey === "DVR");
    if (before) assert.equal(touch.ButtonId, before.ButtonId, "the Touch's key keeps its ButtonId");
    assert.ok(mapOf({ mapList }, `16417Activity${SHIELD}`).Buttons.some((b) => b.__type === "SoftRemoteButton"), "on-screen buttons stay");
    assert.deepEqual(validateMapList(mapList), []);
    const twin = { remote: "16417", base: theirs.base };
    assert.equal(controlsSaveOutcome({ ...cfg, mapList }, SHIELD, mine.base, mapList, { ...SMART, twin }), "saved");
    assert.equal(controlsSaveOutcome(cfg, SHIELD, mine.base, mapList, { ...SMART, twin }), "unchanged");
    // Only the Smart Control's half landed: not what was sent.
    const half = structuredClone(cfg.mapList);
    half.ButtonMaps = half.ButtonMaps.map((m) => (m.ButtonMapIdentifier === `16414Activity${SHIELD}` ? mapOf({ mapList }, m.ButtonMapIdentifier) : m));
    assert.equal(controlsSaveOutcome({ ...cfg, mapList: half }, SHIELD, mine.base, mapList, { ...SMART, twin }), "changed");
  });

  it("leaves the other remote alone when only this one's keys changed", () => {
    const cfg = config();
    const mine = readHardKeys(cfg, SHIELD, SMART);
    const rows = mine.rows.filter((r) => r.buttonKey !== "Menu");
    const mapList = buildTouchControlsMapList(cfg, { hard: { activityId: SHIELD, rows, base: mine.base }, twin: null }, SMART);
    assert.deepEqual(mapOf({ mapList }, `16417Activity${SHIELD}`), mapOf(fixture, `16417Activity${SHIELD}`));
  });

  it("makes the other remote's map when it has none for the activity", () => {
    const cfg = config();
    const theirs = readHardKeys(cfg, WITHOUT_SMART, SMART);
    const mine = readHardKeys(cfg, WITHOUT_SMART);
    assert.equal(theirs.exists, false);
    const deviceId = String(cfg.activityList.Activities.find((a) => String(a["Id-"]) === WITHOUT_SMART).Roles[0]["DeviceId-"]);
    const edit = row("VolumeUp", command(deviceId, "VolumeUp"));
    const mapList = buildTouchControlsMapList(cfg, {
      hard: { rows: [...mine.rows.filter((r) => r.buttonKey !== "VolumeUp"), edit] },
      soft: { activityId: WITHOUT_SMART, base: mine.base },
      twin: { remote: "16414", rows: [edit], base: theirs.base },
    });
    const made = mapOf({ mapList }, `16414Activity${WITHOUT_SMART}`);
    assert.deepEqual(made.Buttons.map((b) => [b.ButtonKey, b.ButtonAction.CommandName]), [["VolumeUp", "VolumeUp"]]);
    assert.equal(made["SurfaceId-"], mapOf(fixture, `16414Activity${SHIELD}`)["SurfaceId-"]);
    assert.deepEqual(validateMapList(mapList), []);
  });

  it("refuses when the other remote's keys changed on the hub meanwhile", () => {
    const cfg = config();
    const mine = readHardKeys(cfg, SHIELD, SMART);
    const theirs = readHardKeys(cfg, SHIELD);
    mapOf(cfg, `16417Activity${SHIELD}`).Buttons.pop();
    assert.throws(() => buildTouchControlsMapList(cfg, {
      hard: { activityId: SHIELD, rows: mine.rows, base: mine.base },
      twin: { remote: "16417", rows: theirs.rows, base: theirs.base },
    }, SMART), /changed on the hub/);
  });
});
