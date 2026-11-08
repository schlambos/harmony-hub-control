import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PAIRING_STEPS,
  RF_SLOTS,
  activityButtonsSaveOutcome,
  buildActivityButtonsMapList,
  keyComparison,
  pairOutcome,
  parseRfInfo,
  hasActivityButtons,
  readActivityButtons,
  rootMapId,
  remoteKindName,
  remoteModels,
  multiRemoteStatus,
  pairedMessage,
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
    assert.deepEqual(parsed.remotes.map((r) => [r.slot, r.equadId, r.name, r.short, r.role]), [
      [1, "16414", "Harmony Smart Control remote", "Smart Control", "no-screen"],
      [2, "16417", "Harmony Touch", "Touch", "screen"],
    ]);
    assert.equal(parsed.hub.equadId, "34827");
  });

  it("gives every kind a role, so the page offers only what fits it", () => {
    const parsed = parseRfInfo(rfInfo([[1, "16417", "5", "104"], [2, "16422", "6"], [3, "16420", "7"], [4, "16999", "8"]]));
    assert.deepEqual(parsed.remotes.map((r) => [r.name, r.short, r.role]), [
      ["Harmony remote with a screen", "screen remote", "screen"],
      ["Harmony Companion remote", "Companion", "no-screen"],
      ["Harmony keyboard", "keyboard", "other"],
      ["Unknown remote (EquadID 16999)", "remote", "other"],
    ]);
    assert.equal(parsed.remotes[0].skinId, "104");
  });

  it("knows the Smart Control's pairing steps and no unproven ones", () => {
    assert.deepEqual(Object.keys(PAIRING_STEPS), ["16414"]);
    assert.match(PAIRING_STEPS[16414], /Menu and Mute/);
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
    // hal's answer when a remote re-pairs into its own slot (hardware, 2026-10-31).
    assert.equal(pairOutcome({ ...same, pair: JSON.stringify({ id: 1, code: 200 }) }).status, "already");
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

  it("with multi-remote, a second Smart Control joins the first and shares its buttons", () => {
    const outcome = pairOutcome({
      before: rfInfo([SMART, TOUCH]),
      after: rfInfo([SMART, TOUCH, NEW_SMART]),
      pair: pairReply(3, "16414"),
    });
    assert.equal(outcome.status, "paired");
    assert.deepEqual(outcome.added.map((r) => r.slot), [3]);
    assert.deepEqual(outcome.replaced, []);
    assert.deepEqual(outcome.sharing.map((r) => r.slot), [3]);
  });

  it("a remote of a new model shares nothing", () => {
    const outcome = pairOutcome({ before: rfInfo([SMART]), after: rfInfo([SMART, TOUCH]), pair: pairReply(2, "16417") });
    assert.deepEqual(outcome.sharing, []);
    assert.deepEqual(pairOutcome({}).sharing, []);
  });
});

describe("remoteModels", () => {
  it("groups remotes of one model, in slot order", () => {
    const remotes = parseRfInfo(rfInfo([SMART, TOUCH, NEW_SMART])).remotes;
    const models = remoteModels(remotes);
    assert.deepEqual(models.map((m) => [m.equadId, m.slots]), [["16414", [1, 3]], ["16417", [2]]]);
    assert.equal(models[0].short, "Smart Control");
  });

  it("is empty without remotes, and the radio has 6 slots", () => {
    assert.deepEqual(remoteModels(undefined), []);
    assert.equal(RF_SLOTS, 6);
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
    const root = mapOf({ mapList }, rootMapId("16414"));
    const music = root.Buttons.find((b) => b.ButtonKey === "MusicActivity");
    const oldMusic = mapOf(fixture, rootMapId("16414")).Buttons.find((b) => b.ButtonKey === "MusicActivity");
    assert.equal(music.ButtonId, oldMusic.ButtonId);
    assert.deepEqual(music.ButtonAction, { __type: "ButtonActivityAction", "ActivityId-": Number(ids[0]), Order: 0, EventType: 1, Id: 0 });
    assert.equal(music.ButtonLongPressAction, null);
    for (const key of ["WatchTVActivity", "MovieActivity"]) {
      assert.deepEqual(root.Buttons.find((b) => b.ButtonKey === key), mapOf(fixture, rootMapId("16414")).Buttons.find((b) => b.ButtonKey === key));
    }
    for (const map of mapList.ButtonMaps) {
      if (map.ButtonMapIdentifier !== rootMapId("16414")) assert.deepEqual(map, mapOf(fixture, map.ButtonMapIdentifier));
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
    const root = mapOf({ mapList }, rootMapId("16414"));
    assert.equal(root.Buttons.find((b) => b.ButtonKey === "MusicActivity").ButtonAction, null);
    assert.deepEqual(readActivityButtons({ ...config(), mapList }).rows.flatMap((r) => r.missing), []);
    assert.equal(activityButtonsSaveOutcome({ ...config(), mapList }, rows, rows), "saved");
  });

  it("refuses a new choice the hub doesn't have", () => {
    assert.throws(() => buildActivityButtonsMapList(config(), [{ key: "WatchTVActivity", press: "1", longPress: null }]), /no longer exists/);
  });

  it("makes 16414Root with the Smart Control surface when the hub has none", () => {
    const cfg = config();
    cfg.mapList.ButtonMaps = cfg.mapList.ButtonMaps.filter((m) => m.ButtonMapIdentifier !== rootMapId("16414"));
    const { mapList, changed } = buildActivityButtonsMapList(cfg, [{ key: "WatchTVActivity", press: ids[1], longPress: "" }]);
    assert.equal(changed, true);
    const root = mapOf({ mapList }, rootMapId("16414"));
    const surface = mapOf(fixture, `16414Activity${ids[0]}`);
    assert.equal(root.__type, "RootButtonMap");
    assert.equal(root["SurfaceId-"], surface["SurfaceId-"]);
    assert.equal(root["RemoteId-"], surface["RemoteId-"]);
    assert.ok(root["ButtonMapId-"] > 0);
    assert.deepEqual(root.Buttons.map((b) => [b.ButtonKey, b.__type, b.ButtonAction["ActivityId-"]]), [["WatchTVActivity", "HardRemoteButton", Number(ids[1])]]);
    assert.deepEqual(validateMapList(mapList), []);
    const nothing = buildActivityButtonsMapList(cfg, [{ key: "WatchTVActivity", press: "", longPress: "" }]);
    assert.equal(nothing.changed, false);
    assert.equal(mapOf(nothing, rootMapId("16414")), undefined);
  });

  /* A hub with a Companion (16422): its own root map, from Logitech's app,
     on its own surface (issue #79). */
  const withCompanionRoot = () => {
    const cfg = withoutDeleted();
    const root = structuredClone(mapOf(cfg, "16414Root"));
    root.ButtonMapIdentifier = "16422Root";
    root["ButtonMapId-"] = 72000000;
    root["RemoteId-"] = 4242;
    root.Buttons = root.Buttons.map((b, i) => ({ ...b, ButtonId: 72000100 + i }));
    const tv = root.Buttons.find((b) => b.ButtonKey === "WatchTVActivity");
    tv.ButtonAction = { __type: "ButtonActivityAction", "ActivityId-": Number(ids[2]), Order: 0, EventType: 1, Id: 0 };
    cfg.mapList.ButtonMaps.push(root);
    return cfg;
  };

  it("reads and writes a Companion's own root map, never the Smart Control's", () => {
    const cfg = withCompanionRoot();
    assert.equal(readActivityButtons(cfg, "16422").rows.find((r) => r.key === "WatchTVActivity").press, ids[2]);
    assert.notEqual(readActivityButtons(cfg, "16414").rows.find((r) => r.key === "WatchTVActivity").press, ids[2]);
    const rows = [{ key: "WatchTVActivity", press: ids[3], longPress: ids[1] }];
    const { mapList, changed } = buildActivityButtonsMapList(cfg, rows, "16422");
    assert.equal(changed, true);
    const tv = mapOf({ mapList }, "16422Root").Buttons.find((b) => b.ButtonKey === "WatchTVActivity");
    assert.equal(tv.ButtonAction["ActivityId-"], Number(ids[3]));
    assert.equal(tv.ButtonLongPressAction["ActivityId-"], Number(ids[1]));
    assert.equal(tv.ButtonId, 72000100 + mapOf(cfg, "16422Root").Buttons.indexOf(mapOf(cfg, "16422Root").Buttons.find((b) => b.ButtonKey === "WatchTVActivity")));
    for (const map of mapList.ButtonMaps) {
      if (map.ButtonMapIdentifier !== "16422Root") assert.deepEqual(map, mapOf(cfg, map.ButtonMapIdentifier), map.ButtonMapIdentifier);
    }
    assert.deepEqual(validateMapList(mapList), []);
    assert.equal(activityButtonsSaveOutcome({ ...cfg, mapList }, readActivityButtons(cfg, "16422").rows, rows, "16422"), "saved");
    assert.equal(activityButtonsSaveOutcome(cfg, readActivityButtons(cfg, "16422").rows, rows, "16422"), "unchanged");
  });

  it("makes a Companion's root map on its own surface when it has none", () => {
    const cfg = withCompanionRoot();
    cfg.mapList.ButtonMaps = cfg.mapList.ButtonMaps.filter((m) => m.ButtonMapIdentifier !== "16422Root");
    cfg.mapList.ButtonMaps.push({ ...structuredClone(mapOf(cfg, `16414Activity${ids[0]}`)), ButtonMapIdentifier: `16423Activity${ids[0]}`, "RemoteId-": 4343, "ButtonMapId-": 73000000, Buttons: [] });
    const { mapList } = buildActivityButtonsMapList(cfg, [{ key: "MovieActivity", press: ids[0], longPress: "" }], "16423");
    const root = mapOf({ mapList }, "16423Root");
    assert.equal(root.__type, "RootButtonMap");
    assert.equal(root["RemoteId-"], 4343);
    assert.deepEqual(mapOf({ mapList }, "16414Root"), mapOf(cfg, "16414Root"));
  });

  it("knows which remotes have activity buttons", () => {
    assert.deepEqual(["16414", "16417", "16420", "16422", "16423"].map(hasActivityButtons), [true, false, false, true, true]);
    assert.equal(rootMapId("16423"), "16423Root");
  });

  it("deleting an activity clears the buttons that start it", () => {
    const cfg = withoutDeleted();
    const tv = ids[0];
    const { activityList, mapList } = deleteActivityResources(cfg, tv);
    assert.ok(!activityList.Activities.some((a) => String(a["Id-"]) === tv));
    const root = mapOf({ mapList }, rootMapId("16414"));
    const button = root.Buttons.find((b) => b.ButtonKey === "WatchTVActivity");
    assert.equal(button.ButtonAction, null, "the press that started it is gone");
    assert.equal(String(button.ButtonLongPressAction["ActivityId-"]), ids[1], "the long press to another activity stays");
    assert.equal(root.Buttons.length, mapOf(cfg, rootMapId("16414")).Buttons.length, "root buttons stay");
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

describe("keys on both remotes", () => {
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
          hard("Info", command(1, "Info"), { ButtonId: 1878030004 }),
          hard("Exit", { __type: "ButtonSequenceAction", SequenceId: 9, Order: 0 }, { ButtonId: 1878030005 }),
        ], [{ SequenceId: 9, Name: "Exit twice", Actions: [] }]),
        activityMap("16417", 7, [
          hard("Menu", command(1, "Menu"), { ButtonId: 1878030101 }),
          hard("Play", command(2, "Play"), { ButtonId: 1878030102 }),
          hard("Select", command(1, "OK"), { ButtonId: 1878030103 }),
          hard("DVR", command(1, "Recordings"), { ButtonId: 1878030104 }),
          hard("Guide", { __type: "ButtonSequenceAction", SequenceId: 5, Order: 0 }, { ButtonId: 1878030105 }),
          hard("Stop", null, { ButtonId: 1878030106 }),
          { ButtonId: 1878030107, __type: "SoftRemoteButton", ButtonAction: command(1, "Netflix"), MenuItem: { IndexInMenu: 0, MenuName: "Activity.7" } },
        ], [{ SequenceId: 5, Name: "Guide twice", Actions: [] }]),
        activityMap("16417", 8, [hard("Play", command(3, "Play"), { ButtonId: 1878030201 })]),
      ],
    },
  });

  it("lists, per activity, the keys where one remote differs from each other", () => {
    const [radio, lounge] = keyComparison(graph(), "16414", ["16417"]);
    assert.deepEqual([radio.name, radio.hasMap, radio.others[0].hasMap], ["Radio", false, true]);
    const [touch] = lounge.others;
    assert.deepEqual(touch.differ, ["Play"]);
    assert.deepEqual(touch.mineOnly, ["Exit", "Info"], "Number1 isn't compared: the Touch has no number keys");
    assert.deepEqual(touch.theirsOnly, ["Dvr", "Guide", "Select"], "in the Smart Control's spelling");
    const [, fromTouch] = keyComparison(graph(), "16417", ["16414"]);
    assert.deepEqual([fromTouch.others[0].mineOnly, fromTouch.others[0].theirsOnly], [["DVR", "Guide", "Select"], ["Exit", "Info"]]);
  });

  it("compares a Companion with the other remotes the same way", () => {
    const cfg = graph();
    const smart = cfg.mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === "16414Activity7");
    cfg.mapList.ButtonMaps.push({ ...structuredClone(smart), ButtonMapIdentifier: "16422Activity7", Buttons: smart.Buttons.filter((b) => b.ButtonKey !== "Info") });
    const lounge = keyComparison(cfg, "16422", ["16414", "16417"]).find((p) => p.name === "Lounge");
    const [fromSmart, fromTouch] = lounge.others;
    assert.deepEqual([fromSmart.remote, fromSmart.differ, fromSmart.mineOnly, fromSmart.theirsOnly], ["16414", [], [], ["Info"]]);
    assert.deepEqual(fromTouch.differ, ["Play"]);
    assert.deepEqual(fromTouch.mineOnly, ["Exit"]);
  });

  it("finds the live fixture's maps", () => {
    const rows = keyComparison(config(), "16414", ["16417"]);
    assert.equal(rows.length, fixture.activityList.Activities.length);
    assert.ok(rows.filter((p) => p.hasMap && p.others[0].hasMap).length >= 4);
  });
});

describe("multiRemoteStatus", () => {
  it("says what the switch does now", () => {
    assert.equal(multiRemoteStatus(undefined), "Checking…");
    assert.equal(multiRemoteStatus(null), "Couldn't check this setting");
    assert.equal(multiRemoteStatus({ enabled: true, active: true, supported: true }), "On");
    assert.equal(multiRemoteStatus({ enabled: true, active: false, supported: true }), "On after the hub restarts");
    // Switched on, but the hub's hal changed (a firmware update): rcS.local won't bind the copy.
    assert.match(multiRemoteStatus({ enabled: true, active: false, supported: false }), /^Not available.*turn it off/);
    assert.equal(multiRemoteStatus({ enabled: false, active: true, supported: true }), "Off after the hub restarts");
    assert.equal(multiRemoteStatus({ enabled: false, active: false, supported: true }), "Off");
    assert.equal(multiRemoteStatus({ enabled: false, active: false, supported: false }), "Not available on this hub");
    assert.match(multiRemoteStatus({ enabled: false }, "restarting"), /Restarting the hub/);
    assert.equal(multiRemoteStatus({ enabled: false }, "saving"), "Saving…");
  });
});

describe("pairedMessage", () => {
  it("names the model and slot, and the twin it shares buttons with", () => {
    const outcome = pairOutcome({ before: rfInfo([SMART, TOUCH]), after: rfInfo([SMART, TOUCH, NEW_SMART]), pair: pairReply(3, "16414") });
    assert.equal(pairedMessage(outcome),
      "Harmony Smart Control remote paired in slot 3. It does the same as the Smart Control in slot 1: remotes of one model share their buttons.");
  });
  it("says which older remote a stock hub replaced", () => {
    const outcome = pairOutcome({ before: rfInfo([SMART, TOUCH]), after: rfInfo([TOUCH, NEW_SMART]), pair: pairReply(3, "16414") });
    assert.equal(pairedMessage(outcome), "Harmony Smart Control remote paired in slot 3. It replaced the older Smart Control in slot 1.");
  });
  it("covers a remote that was already paired, and stays quiet otherwise", () => {
    const same = { before: rfInfo([SMART]), after: rfInfo([SMART]) };
    assert.match(pairedMessage(pairOutcome({ ...same, pair: pairReply(1, "16414") })), /already paired/);
    assert.equal(pairedMessage(pairOutcome({ ...same, pair: JSON.stringify({ id: 1, code: 500 }) })), "");
    assert.equal(pairedMessage(null), "");
  });
});
