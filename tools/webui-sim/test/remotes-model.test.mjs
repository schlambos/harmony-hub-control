import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ROOT_MAP_ID,
  activityButtonsSaveOutcome,
  buildActivityButtonsMapList,
  buildKeyParityMapList,
  keyParity,
  pairOutcome,
  parseRfInfo,
  readActivityButtons,
  remoteKindName,
  smartControlKey,
} from "../public/js/views/remotes-model.js";
import { validateMapList } from "../public/js/views/remote-model.js";
import { deleteActivityResources } from "../public/js/wizard-model.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/activity-config.json", import.meta.url), "utf8"));
const config = () => structuredClone(fixture);
const mapOf = (cfg, id) => cfg.mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === id);
const ids = fixture.activityList.Activities.map((a) => String(a["Id-"]));
/* The fixture's root map still starts an activity it no longer has. */
const withoutDeleted = () => {
  const cfg = config();
  for (const button of mapOf(cfg, "16414Root").Buttons) {
    for (const field of ["ButtonAction", "ButtonLongPressAction"]) {
      if (button[field] && !ids.includes(String(button[field]["ActivityId-"]))) button[field] = null;
    }
  }
  return cfg;
};

/* hal's rf.info answer: [slot, EquadID, RFID, SkinId] per paired remote. */
const rfInfo = (devices, code = 200) => JSON.stringify({
  id: 1,
  data: {
    EquadID: "34827",
    RFID: "9000000001",
    Devices: devices.map(([slot, equad, rfid, skin = ""]) => ({ EquadID: equad, SkinId: skin, DeviceIndex: String(slot), RFID: rfid })),
    DeviceCount: devices.length,
  },
  code,
});
const SMART = [1, "16414", "1000000001"];
const TOUCH = [2, "16417", "2000000001", "99"];
const NEW_SMART = [3, "16414", "3000000003"];
const pairReply = (slot, equad) => JSON.stringify({ id: 1, data: { DeviceIndex: String(slot), EquadID: equad, RFID: "x", SkinId: "" }, code: 200 });

describe("parseRfInfo", () => {
  it("lists remotes by slot with their kind", () => {
    const parsed = parseRfInfo(rfInfo([TOUCH, SMART]));
    assert.deepEqual(parsed.remotes.map((r) => [r.slot, r.equadId, r.name]), [
      [1, "16414", "Harmony Smart Control remote"],
      [2, "16417", "Harmony Touch"],
    ]);
    assert.equal(parsed.hub.equadId, "34827");
  });

  it("reads codex_hal_ltcp output with noise before the JSON", () => {
    assert.equal(parseRfInfo(`warning\n${rfInfo([SMART])}`).remotes.length, 1);
  });

  it("refuses failed or unreadable replies", () => {
    assert.equal(parseRfInfo(rfInfo([SMART], 500)), null);
    assert.equal(parseRfInfo("decode_ltcp_payload failed (raw_len=0)"), null);
    assert.equal(parseRfInfo(""), null);
  });

  it("names screen remotes by skin and unknown kinds honestly", () => {
    assert.equal(remoteKindName("16417", "99"), "Harmony Touch");
    assert.equal(remoteKindName("16417", "5"), "Harmony remote with a screen");
    assert.equal(remoteKindName("16999"), "Unknown remote (EquadID 16999)");
  });
});

describe("pairOutcome", () => {
  it("reports a new Smart Control and the older one hal replaced, Touch kept", () => {
    const outcome = pairOutcome({
      before: rfInfo([SMART, TOUCH]),
      after: rfInfo([TOUCH, NEW_SMART]),
      pair: pairReply(3, "16414"),
    });
    assert.equal(outcome.status, "paired");
    assert.deepEqual(outcome.added.map((r) => r.slot), [3]);
    assert.deepEqual(outcome.replaced.map((r) => r.slot), [1]);
    assert.deepEqual(outcome.lost, []);
    assert.ok(outcome.remotes.some((r) => r.equadId === "16417"));
  });

  it("flags a remote of another kind that disappeared", () => {
    const outcome = pairOutcome({ before: rfInfo([SMART, TOUCH]), after: rfInfo([NEW_SMART]) });
    assert.equal(outcome.status, "lost");
    assert.deepEqual(outcome.lost.map((r) => r.equadId), ["16417"]);
  });

  it("tells an already-paired remote from a window nobody used", () => {
    const same = { before: rfInfo([SMART, TOUCH]), after: rfInfo([SMART, TOUCH]) };
    assert.equal(pairOutcome({ ...same, pair: pairReply(1, "16414") }).status, "already");
    assert.equal(pairOutcome({ ...same, pair: "decode_ltcp_payload failed" }).status, "timeout");
    assert.equal(pairOutcome({ ...same, pair: JSON.stringify({ id: 1, code: 500 }) }).status, "timeout");
  });

  it("treats the same slot with another radio ID as a change", () => {
    const outcome = pairOutcome({ before: rfInfo([SMART, TOUCH]), after: rfInfo([[1, "16414", "5"], TOUCH]) });
    assert.equal(outcome.status, "paired");
    assert.deepEqual(outcome.replaced.map((r) => r.rfid), ["1000000001"]);
  });

  it("is unknown when either table couldn't be read", () => {
    assert.equal(pairOutcome({ before: rfInfo([SMART]), after: "no response" }).status, "unknown");
    assert.equal(pairOutcome({}).status, "unknown");
  });
});

describe("activity buttons", () => {
  it("reads press and long press, flagging deleted activities", () => {
    const { hasRoot, rows } = readActivityButtons(config());
    assert.equal(hasRoot, true);
    const tv = rows.find((r) => r.key === "WatchTVActivity");
    assert.equal(tv.press, "48113644");
    assert.equal(tv.longPress, "48113650");
    const music = rows.find((r) => r.key === "MusicActivity");
    assert.deepEqual(music.missing, [music.press]);
    assert.ok(!ids.includes(music.press));
  });

  it("writes only the actions that change and keeps every other map", () => {
    const cfg = config();
    const before = structuredClone(cfg.mapList);
    const rows = [{ key: "MusicActivity", press: ids[0], longPress: "" }, { key: "MovieActivity", press: null, longPress: null }];
    const { mapList, changed } = buildActivityButtonsMapList(cfg, rows);
    assert.equal(changed, true);
    assert.deepEqual(cfg.mapList, before, "input untouched");
    const root = mapOf({ mapList }, ROOT_MAP_ID);
    const music = root.Buttons.find((b) => b.ButtonKey === "MusicActivity");
    const oldMusic = mapOf(fixture, ROOT_MAP_ID).Buttons.find((b) => b.ButtonKey === "MusicActivity");
    assert.equal(music.ButtonId, oldMusic.ButtonId);
    assert.deepEqual(music.ButtonAction, { __type: "ButtonActivityAction", "ActivityId-": Number(ids[0]), Order: 0, EventType: 1, Id: 0 });
    assert.equal(music.ButtonLongPressAction, null);
    for (const key of ["WatchTVActivity", "MovieActivity"]) {
      assert.deepEqual(root.Buttons.find((b) => b.ButtonKey === key), mapOf(fixture, ROOT_MAP_ID).Buttons.find((b) => b.ButtonKey === key));
    }
    for (const map of mapList.ButtonMaps) {
      if (map.ButtonMapIdentifier !== ROOT_MAP_ID) assert.deepEqual(map, mapOf(fixture, map.ButtonMapIdentifier));
    }
    assert.deepEqual(validateMapList(mapList), []);
  });

  it("reports no change when the rows match the hub", () => {
    const cfg = withoutDeleted();
    const rows = readActivityButtons(cfg).rows;
    assert.deepEqual(rows.flatMap((r) => r.missing), []);
    assert.equal(buildActivityButtonsMapList(cfg, rows).changed, false);
  });

  it("clears a button left on a deleted activity (the hub refuses one)", () => {
    const rows = readActivityButtons(config()).rows;
    const { mapList, changed } = buildActivityButtonsMapList(config(), rows);
    assert.equal(changed, true);
    const root = mapOf({ mapList }, ROOT_MAP_ID);
    assert.equal(root.Buttons.find((b) => b.ButtonKey === "MusicActivity").ButtonAction, null);
    assert.deepEqual(readActivityButtons({ ...config(), mapList }).rows.flatMap((r) => r.missing), []);
    assert.equal(activityButtonsSaveOutcome({ ...config(), mapList }, rows, rows), "saved");
  });

  it("refuses a new choice the hub doesn't have", () => {
    assert.throws(() => buildActivityButtonsMapList(config(), [{ key: "WatchTVActivity", press: "1", longPress: null }]), /no longer exists/);
  });

  it("makes 16414Root with the Smart Control surface when the hub has none", () => {
    const cfg = config();
    cfg.mapList.ButtonMaps = cfg.mapList.ButtonMaps.filter((m) => m.ButtonMapIdentifier !== ROOT_MAP_ID);
    const { mapList, changed } = buildActivityButtonsMapList(cfg, [{ key: "WatchTVActivity", press: ids[1], longPress: "" }]);
    assert.equal(changed, true);
    const root = mapOf({ mapList }, ROOT_MAP_ID);
    const surface = mapOf(fixture, `16414Activity${ids[0]}`);
    assert.equal(root.__type, "RootButtonMap");
    assert.equal(root["SurfaceId-"], surface["SurfaceId-"]);
    assert.equal(root["RemoteId-"], surface["RemoteId-"]);
    assert.ok(root["ButtonMapId-"] > 0);
    assert.deepEqual(root.Buttons.map((b) => [b.ButtonKey, b.__type, b.ButtonAction["ActivityId-"]]), [["WatchTVActivity", "HardRemoteButton", Number(ids[1])]]);
    assert.deepEqual(validateMapList(mapList), []);
    const nothing = buildActivityButtonsMapList(cfg, [{ key: "WatchTVActivity", press: "", longPress: "" }]);
    assert.equal(nothing.changed, false);
    assert.equal(mapOf(nothing, ROOT_MAP_ID), undefined);
  });

  it("deleting an activity clears the buttons that start it", () => {
    const cfg = withoutDeleted();
    const tv = ids[0];
    const { activityList, mapList } = deleteActivityResources(cfg, tv);
    assert.ok(!activityList.Activities.some((a) => String(a["Id-"]) === tv));
    const root = mapOf({ mapList }, ROOT_MAP_ID);
    const button = root.Buttons.find((b) => b.ButtonKey === "WatchTVActivity");
    assert.equal(button.ButtonAction, null, "the press that started it is gone");
    assert.equal(String(button.ButtonLongPressAction["ActivityId-"]), ids[1], "the long press to another activity stays");
    assert.equal(root.Buttons.length, mapOf(cfg, ROOT_MAP_ID).Buttons.length, "root buttons stay");
    const left = JSON.stringify(mapList);
    assert.ok(!left.includes(`"ActivityId-":${tv}`), "nothing names the deleted activity");
  });

  it("deleting an activity drops an activity-map button that only started it", () => {
    const cfg = withoutDeleted();
    const touch = mapOf(cfg, `16417Activity${ids[1]}`);
    touch.Buttons.push({
      ButtonId: 1999999999,
      __type: "SoftRemoteButton",
      ButtonAction: { __type: "ButtonActivityAction", "ActivityId-": Number(ids[2]), Order: 0 },
      ButtonLongPressAction: null,
      ButtonDoublePressAction: null,
      MenuItem: { IndexInMenu: 40, MenuName: `Activity.${ids[1]}` },
    });
    const { mapList } = deleteActivityResources(cfg, ids[2]);
    const after = mapOf({ mapList }, `16417Activity${ids[1]}`);
    assert.ok(!after.Buttons.some((b) => b.ButtonId === 1999999999));
    assert.equal(after.Buttons.length, touch.Buttons.length - 1);
  });

  it("judges a save the hub didn't confirm", () => {
    const base = readActivityButtons(config()).rows;
    const sent = [{ key: "MusicActivity", press: ids[0], longPress: null }];
    const saved = { ...config(), mapList: buildActivityButtonsMapList(config(), sent).mapList };
    assert.equal(activityButtonsSaveOutcome(saved, base, sent), "saved");
    assert.equal(activityButtonsSaveOutcome(config(), base, sent), "unchanged");
    const other = { ...config(), mapList: buildActivityButtonsMapList(config(), [{ key: "MusicActivity", press: ids[1], longPress: null }]).mapList };
    assert.equal(activityButtonsSaveOutcome(other, base, sent), "changed");
  });
});

describe("keys shared with the Touch", () => {
  const command = (device, name) => ({ "DeviceId-": device, __type: "ButtonCommandAction", "FunctionId-": 0, Order: 0, CommandName: name, EventType: 1, Id: 0 });
  const hard = (key, action, extra = {}) => ({ ButtonId: 0, __type: "HardRemoteButton", ButtonAction: action, ButtonDoublePressAction: null, FunctionGroupType: 0, ButtonState: 1, ButtonKey: key, ButtonLongPressAction: null, ...extra });
  const activityMap = (equad, activityId, buttons, sequences = []) => ({
    "ButtonMapId-": equad === "16414" ? 60000001 : 60000002,
    "ActivityId-": Number(activityId),
    Buttons: buttons,
    "ButtonMapSurfaceId-": 1,
    "RemoteId-": 2,
    __type: "ActivityButtonMap",
    ButtonMapIdentifier: `${equad}Activity${activityId}`,
    DateModified: "/Date(0+0000)/",
    Sequences: sequences,
    "SurfaceId-": 1,
  });
  const graph = () => ({
    activityList: { Activities: [{ "Id-": 7, Name: "Lounge", ActivityOrder: 1 }, { "Id-": 8, Name: "Radio", ActivityOrder: 0 }] },
    mapList: {
      ButtonMaps: [
        activityMap("16414", 7, [
          hard("Menu", command(1, "Menu"), { ButtonId: 1878030001 }),
          hard("Number1", command(1, "1"), { ButtonId: 1878030002, FunctionGroupType: 2 }),
          hard("Play", command(1, "Play"), { ButtonId: 1878030003 }),
        ]),
        activityMap("16417", 7, [
          hard("Menu", command(1, "Menu"), { ButtonId: 1878030101 }),
          hard("Play", command(2, "Play"), { ButtonId: 1878030102 }),
          hard("Select", command(1, "OK"), { ButtonId: 1878030103 }),
          hard("DVR", command(1, "Recordings"), { ButtonId: 1878030104 }),
          hard("Guide", { __type: "ButtonSequenceAction", SequenceId: 5, Order: 0 }, { ButtonId: 1878030105 }),
          hard("Exit", null, { ButtonId: 1878030106 }),
          { ButtonId: 1878030107, __type: "SoftRemoteButton", ButtonAction: command(1, "Netflix"), MenuItem: { IndexInMenu: 0, MenuName: "Activity.7" } },
        ], [{ SequenceId: 5, Name: "Guide twice", Actions: [] }]),
        activityMap("16417", 8, [hard("Play", command(3, "Play"), { ButtonId: 1878030201 })]),
      ],
    },
  });

  it("maps Touch key names to the Smart Control's", () => {
    assert.equal(smartControlKey("DVR"), "Dvr");
    assert.equal(smartControlKey("Select"), "Select");
    assert.equal(smartControlKey("Home"), "");
  });

  it("lists missing, different and uncopyable keys per activity", () => {
    const [radio, lounge] = keyParity(graph());
    assert.deepEqual([radio.name, radio.smartMap, radio.touchMap], ["Radio", false, true]);
    assert.deepEqual(lounge.missing, ["Select", "Dvr"]);
    assert.deepEqual(lounge.differs, ["Play"]);
    assert.deepEqual(lounge.skipped, ["Guide"]);
  });

  it("copies Touch keys onto the Smart Control, keeping its IDs and groups", () => {
    const cfg = graph();
    const { mapList, copied } = buildKeyParityMapList(cfg);
    assert.equal(copied, 3);
    const smart = mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === "16414Activity7");
    const byKey = Object.fromEntries(smart.Buttons.map((b) => [b.ButtonKey, b]));
    assert.equal(byKey.Play.ButtonId, 1878030003, "replaced key keeps its ButtonId");
    assert.equal(byKey.Play.ButtonAction["DeviceId-"], 2);
    assert.equal(byKey.Dvr.ButtonAction.CommandName, "Recordings");
    assert.ok(byKey.Select.ButtonId > 1878030201, "new key gets a fresh ButtonId");
    assert.notEqual(byKey.Select.ButtonId, byKey.Dvr.ButtonId);
    assert.equal(byKey.Number1.FunctionGroupType, 2);
    assert.equal(byKey.Guide, undefined, "a Touch sequence is never copied");
    assert.equal(byKey.Menu.ButtonId, 1878030001);
    assert.deepEqual(mapList.ButtonMaps.filter((m) => m.ButtonMapIdentifier.startsWith("16417")), graph().mapList.ButtonMaps.filter((m) => m.ButtonMapIdentifier.startsWith("16417")));
    assert.deepEqual(validateMapList(mapList), []);
    const after = keyParity({ ...cfg, mapList }).find((p) => p.name === "Lounge");
    assert.deepEqual([after.missing, after.differs, after.skipped], [[], [], ["Guide"]]);
  });

  it("copies only the activities asked for", () => {
    assert.equal(buildKeyParityMapList(graph(), ["8"]).copied, 0);
    assert.equal(buildKeyParityMapList(graph(), ["7"]).copied, 3);
  });

  it("finds the live fixture's Smart Control maps", () => {
    const parity = keyParity(config());
    assert.equal(parity.length, fixture.activityList.Activities.length);
    assert.ok(parity.filter((p) => p.smartMap).length >= 4);
  });
});
