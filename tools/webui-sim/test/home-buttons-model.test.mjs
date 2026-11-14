import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPANION_EQUAD,
  HOME_BUTTONS,
  NOTHING_NAME,
  ROCKER_KEYS,
  SCREEN_EQUAD,
  buildHomeButtonsMapList,
  clearAction,
  dimKeys,
  effectiveAssignment,
  hasHomeButtons,
  homeRemote,
  isChanged,
  keysChanged,
  readHomeButtons,
  revertKeys,
  saveOutcome,
  setAction,
  setNothing,
} from "../public/js/views/home-buttons-model.js";
import { validateMapList } from "../public/js/views/remote-model.js";
import { hasRemoteMaps, touchMapIdentifier } from "../public/js/views/touch-model.js";
import { parseRfInfo, remoteModels } from "../public/js/views/remotes-model.js";

const ROOT_MAP = "16422Root";
const activityMapIdentifier = (activityId) => touchMapIdentifier(activityId, COMPANION_EQUAD);

const readFixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));

/* The fixture as the hub would send it (see touch-model.test.mjs), with a
   Companion (companion-maps.json; the shared fixture's hub has none): a
   FunctionList, and no maps for activities the hub doesn't have. */
const fixture = (() => {
  const raw = readFixture("activity-config.json");
  raw.mapList.ButtonMaps.push(...readFixture("companion-maps.json"));
  const ids = new Set(raw.activityList.Activities.map((a) => String(a["Id-"])));
  raw.mapList.ButtonMaps = raw.mapList.ButtonMaps.filter((m) => m["ActivityId-"] == null || ids.has(String(m["ActivityId-"])));
  raw.functionList = {
    FunctionMaps: [...ids].map((id) => ({ __type: "ActivityFunctionMap", "ActivityId-": Number(id), FunctionGroups: [] })),
  };
  return raw;
})();
const config = () => structuredClone(fixture);
const NOW = 1761264000000;

/* From a config or a built MapList. */
const mapOf = (source, identifier) => (source.mapList ?? source).ButtonMaps.find((m) => m.ButtonMapIdentifier === identifier);
const keyOf = (map, key) => map.Buttons.find((b) => b.__type === "HardRemoteButton" && b.ButtonKey === key);
const built = (cfg, draft) => buildHomeButtonsMapList(cfg, draft, { now: NOW });

/* The fixture's Companion: a global Light 1 (with a long press and + / −),
   Light 2 and fixed + / −; Smart TV overrides Light 2 and turns Plug 1 off;
   NVIDIA Shield has a map without overrides; Music has no Companion map. */
const SMART_TV = "48113650";
const SHIELD = "48113644";
const MUSIC = "49051068";

const amp = () => fixture.deviceList.DevicesWithFeatures.find((d) => d.Device.Name === "Nakamichi Amp");
const ampCommand = (name) => {
  const command = amp().Commands.find((c) => c.Name === name);
  return { kind: "command", deviceId: String(amp().Device["Id-"]), command: command.Name, functionId: command["FunctionId-"] ?? 0 };
};
const MUTE = ampCommand("Mute");
const START_MUSIC = { kind: "activity", activityId: MUSIC };

describe("reading the Companion's buttons", () => {
  it("finds the Companion by its 16422 maps", () => {
    assert.equal(hasRemoteMaps(fixture, COMPANION_EQUAD), true);
    const cfg = config();
    cfg.mapList.ButtonMaps = cfg.mapList.ButtonMaps.filter((m) => !m.ButtonMapIdentifier.startsWith("16422"));
    assert.equal(hasRemoteMaps(cfg, COMPANION_EQUAD), false);
  });

  it("reads the global keys, and nothing it doesn't own", () => {
    const draft = readHomeButtons(fixture);
    assert.equal(draft.canEdit, true);
    assert.deepEqual(Object.keys(draft.entries).sort(), ["Ha1", "Ha1Down", "Ha1Up", "Ha2", "HcDown", "HcUp"]);
    assert.equal(draft.entries.Ha1.press.command, "Dimmer");
    assert.equal(draft.entries.Ha1.long.command, "DisplayOff");
    assert.equal(draft.entries.Ha2.long, null);
    assert.deepEqual(effectiveAssignment(draft, "Ha1").source, "global");
    assert.deepEqual(effectiveAssignment(draft, "Ha3").source, "unset");
  });

  it("reads an activity's overrides, its \"nothing\", and what follows the global keys", () => {
    const draft = readHomeButtons(fixture, SMART_TV);
    assert.equal(draft.exists, true);
    assert.equal(effectiveAssignment(draft, "Ha2").source, "override");
    assert.equal(effectiveAssignment(draft, "Ha2").press.command, "InputHdmi1");
    assert.equal(effectiveAssignment(draft, "Ha3").source, "nothing");
    assert.equal(effectiveAssignment(draft, "Ha1").source, "global");
    assert.equal(effectiveAssignment(draft, "Ha1").long.command, "DisplayOff");
    assert.equal(effectiveAssignment(draft, "Ha4").source, "unset");
    assert.equal(effectiveAssignment(draft, ROCKER_KEYS.up).source, "global");
    assert.deepEqual(draft.sequences, [], "the Nothing sequence isn't offered as a sequence");
  });

  it("reads an activity without a Companion map as following the global keys", () => {
    const draft = readHomeButtons(fixture, MUSIC);
    assert.equal(draft.exists, false);
    assert.equal(draft.canEdit, true);
    assert.deepEqual(draft.entries, {});
    assert.equal(effectiveAssignment(draft, "Ha1").source, "global");
  });

  it("keeps a key with an action it doesn't own as it is until replaced or cleared", () => {
    const cfg = config();
    keyOf(mapOf(cfg, ROOT_MAP), "Ha2").ButtonAction = { __type: "ButtonHomeControlAction", ProgramId: 7, EventType: 1 };
    const draft = readHomeButtons(cfg);
    assert.equal(effectiveAssignment(draft, "Ha2").source, "other");
    assert.throws(() => setAction(draft, "Ha2", "long", MUTE), /press does first/);
    assert.equal(clearAction(draft, "Ha2", "long").entries.Ha2.state, "other");
    const map = mapOf(built(cfg, setAction(draft, "Ha3", "press", MUTE)), ROOT_MAP);
    assert.deepEqual(keyOf(map, "Ha2"), keyOf(mapOf(cfg, ROOT_MAP), "Ha2"));

    const replaced = setAction(draft, "Ha2", "press", MUTE);
    assert.equal(effectiveAssignment(replaced, "Ha2").source, "global");
    assert.deepEqual(effectiveAssignment(replaced, "Ha2").press, MUTE);
    assert.equal(isChanged(cfg, replaced), true);
    assert.equal(keysChanged(cfg, replaced, ["Ha2"]), true);
    assert.equal(keyOf(mapOf(built(cfg, replaced), ROOT_MAP), "Ha2").ButtonAction.CommandName, "Mute");

    const cleared = clearAction(draft, "Ha2", "press");
    assert.equal(effectiveAssignment(cleared, "Ha2").source, "unset");
    assert.equal(isChanged(cfg, cleared), true);
    assert.equal(keyOf(mapOf(built(cfg, cleared), ROOT_MAP), "Ha2"), undefined);

    const reverted = revertKeys(cfg, cleared, ["Ha2"]);
    assert.equal(effectiveAssignment(reverted, "Ha2").source, "other");
    assert.equal(isChanged(cfg, reverted), false);
    assert.equal(keysChanged(cfg, reverted, ["Ha2"]), false);
  });
});

describe("editing", () => {
  it("overrides a key in an activity with its own press, and back to the global one", () => {
    const cfg = config();
    let draft = setAction(readHomeButtons(cfg, SHIELD), "Ha1", "press", MUTE);
    assert.equal(effectiveAssignment(draft, "Ha1").source, "override");
    assert.equal(effectiveAssignment(draft, "Ha1").long, null, "an override is the whole button");
    assert.equal(isChanged(cfg, draft), true);
    draft = clearAction(draft, "Ha1", "press");
    assert.equal(effectiveAssignment(draft, "Ha1").source, "global");
    assert.equal(isChanged(cfg, draft), false);
  });

  it("starts an override from the global press when only the long press changes", () => {
    const draft = setAction(readHomeButtons(fixture, SHIELD), "Ha2", "long", START_MUSIC);
    assert.equal(draft.entries.Ha2.press.command, "PowerToggle");
    assert.deepEqual(draft.entries.Ha2.long, START_MUSIC);
  });

  it("needs a press before a long press, and gives only the home buttons one", () => {
    assert.throws(() => setAction(readHomeButtons(fixture), "Ha4", "long", MUTE), /press does first/);
    assert.throws(() => setAction(readHomeButtons(fixture), ROCKER_KEYS.up, "long", MUTE), /long press/);
    assert.throws(() => setAction(readHomeButtons(fixture), "Menu", "press", MUTE), /isn't a home control key/);
  });

  it("clears only the long press", () => {
    const draft = clearAction(readHomeButtons(fixture), "Ha1", "long");
    assert.equal(draft.entries.Ha1.long, null);
    assert.equal(draft.entries.Ha1.press.command, "Dimmer");
  });

  it("turns a key off in an activity only", () => {
    assert.throws(() => setNothing(readHomeButtons(fixture), "Ha1"), /Only an activity/);
    const draft = setNothing(readHomeButtons(fixture, SHIELD), dimKeys("Ha1").up);
    assert.equal(effectiveAssignment(draft, "Ha1Up").source, "nothing");
  });
});

describe("one button's keys (the sheet's Undo my change)", () => {
  const light1 = ["Ha1", ...Object.values(dimKeys("Ha1"))];

  it("tells whether any of a button's keys changed", () => {
    const cfg = config();
    const draft = setAction(readHomeButtons(cfg), "Ha1Up", "press", MUTE);
    assert.equal(keysChanged(cfg, draft, light1), true);
    assert.equal(keysChanged(cfg, draft, ["Ha2", ...Object.values(dimKeys("Ha2"))]), false);
  });

  it("puts a button's keys back as the hub has them and leaves the others", () => {
    const cfg = config();
    let draft = setAction(readHomeButtons(cfg), "Ha1", "press", MUTE);
    draft = clearAction(draft, "Ha1Down", "press");
    draft = setAction(draft, "Ha3", "press", START_MUSIC);
    draft = revertKeys(cfg, draft, light1);
    assert.equal(keysChanged(cfg, draft, light1), false);
    assert.equal(draft.entries.Ha1.press.command, "Dimmer");
    assert.equal(draft.entries.Ha1Down.press.command, "CenterDown");
    assert.deepEqual(draft.entries.Ha3.press, START_MUSIC);
  });

  it("drops a key the scope doesn't have when it goes back", () => {
    const cfg = config();
    const draft = revertKeys(cfg, setNothing(readHomeButtons(cfg, SHIELD), "Ha4"), ["Ha4"]);
    assert.equal(draft.entries.Ha4, undefined);
    assert.equal(isChanged(cfg, draft), false);
  });
});

describe("writing the MapList", () => {
  it("writes a new global key in Logitech's shape, the press as EventType 1 and the long press as 2", () => {
    const cfg = config();
    let draft = setAction(readHomeButtons(cfg), "Ha4", "press", MUTE);
    draft = setAction(draft, "Ha4", "long", START_MUSIC);
    const root = mapOf(built(cfg, draft), ROOT_MAP);
    const button = keyOf(root, "Ha4");
    assert.deepEqual(Object.keys(button), [
      "ButtonKey", "__type", "ButtonLongPressAction", "ButtonState", "FunctionGroupType",
      "ButtonDoublePressAction", "ButtonAction", "ButtonId",
    ]);
    assert.deepEqual(button.ButtonAction, {
      "DeviceId-": Number(MUTE.deviceId), __type: "ButtonCommandAction", "FunctionId-": 91,
      Order: 0, CommandName: "Mute", EventType: 1, Id: 0,
    });
    assert.deepEqual(button.ButtonLongPressAction, {
      __type: "ButtonActivityAction", "ActivityId-": Number(MUSIC), Order: 0, EventType: 2, Id: 0,
    });
    assert.ok(button.ButtonId > 1878029713, "a new id above Logitech's floor");
    assert.equal(root.DateModified, `/Date(${NOW}+0000)/`);
  });

  it("changes a key in place and carries everything else through", () => {
    const cfg = config();
    const before = mapOf(cfg, ROOT_MAP);
    keyOf(before, "Ha1").Unknown = "kept";
    const draft = setAction(readHomeButtons(cfg), "Ha1", "long", START_MUSIC);
    const mapList = built(cfg, draft);
    const root = mapOf(mapList, ROOT_MAP);
    assert.deepEqual(root.Buttons.map((b) => b.ButtonKey), before.Buttons.map((b) => b.ButtonKey));
    const light = keyOf(root, "Ha1");
    assert.equal(light.Unknown, "kept");
    assert.deepEqual(light.ButtonAction, keyOf(before, "Ha1").ButtonAction);
    assert.equal(light.ButtonLongPressAction.__type, "ButtonActivityAction");
    for (const map of cfg.mapList.ButtonMaps.filter((m) => m.ButtonMapIdentifier !== ROOT_MAP)) {
      assert.deepEqual(mapOf(mapList, map.ButtonMapIdentifier), map, map.ButtonMapIdentifier);
    }
  });

  it("removes a cleared key and its + / − stay", () => {
    const cfg = config();
    const root = mapOf(built(cfg, clearAction(readHomeButtons(cfg), "Ha1", "press")), ROOT_MAP);
    assert.equal(keyOf(root, "Ha1"), undefined);
    assert.ok(keyOf(root, "Ha1Up"));
  });

  it("writes \"nothing\" as the map's one Nothing sequence, reused by every key", () => {
    const cfg = config();
    let draft = setNothing(readHomeButtons(cfg, SMART_TV), "Ha4");
    draft = setNothing(draft, ROCKER_KEYS.down);
    const map = mapOf(built(cfg, draft), activityMapIdentifier(SMART_TV));
    const nothing = map.Sequences.filter((s) => s.Name === NOTHING_NAME);
    assert.equal(nothing.length, 1);
    for (const key of ["Ha3", "Ha4", "HcDown"]) {
      assert.deepEqual(keyOf(map, key).ButtonAction, {
        __type: "ButtonSequenceAction", SequenceId: nothing[0].SequenceId, Order: 0, EventType: 1, Id: 0,
      }, key);
    }
  });

  it("adds the Nothing sequence with one zero delay at Order 1 to a map that has none", () => {
    const cfg = config();
    const map = mapOf(built(cfg, setNothing(readHomeButtons(cfg, SHIELD), "Ha1")), activityMapIdentifier(SHIELD));
    const [sequence] = map.Sequences;
    assert.deepEqual(sequence.Actions, [{ __type: "ButtonDelayAction", Duration: 0, Order: 1 }]);
    assert.equal(sequence.Name, NOTHING_NAME);
    const used = new Set(cfg.mapList.ButtonMaps.flatMap((m) => m.Sequences ?? []).map((s) => s.SequenceId));
    assert.equal(used.has(sequence.SequenceId), false, "a sequence id no map uses yet");
    assert.equal(keyOf(map, "Ha1").ButtonLongPressAction, null);
  });

  it("removes the Nothing sequence once no key runs it", () => {
    const cfg = config();
    const map = mapOf(built(cfg, clearAction(readHomeButtons(cfg, SMART_TV), "Ha3", "press")), activityMapIdentifier(SMART_TV));
    assert.equal(keyOf(map, "Ha3"), undefined);
    assert.deepEqual(map.Sequences, []);
  });

  it("makes a Companion map for an activity that has none, from a sibling's ids", () => {
    const cfg = config();
    const mapList = built(cfg, setAction(readHomeButtons(cfg, MUSIC), "Ha1", "press", MUTE));
    const map = mapOf(mapList, activityMapIdentifier(MUSIC));
    const sibling = mapOf(cfg, activityMapIdentifier(SMART_TV));
    assert.equal(map.__type, "ActivityButtonMap");
    assert.equal(map["ActivityId-"], Number(MUSIC));
    assert.equal(map["RemoteId-"], sibling["RemoteId-"]);
    assert.equal(map["SurfaceId-"], sibling["SurfaceId-"]);
    assert.ok(map["ButtonMapId-"] > 52944089);
    assert.deepEqual(map.Buttons.map((b) => b.ButtonKey), ["Ha1"]);
    assert.deepEqual(validateMapList(mapList), []);
  });

  it("never makes an empty map", () => {
    const cfg = config();
    const mapList = built(cfg, readHomeButtons(cfg, MUSIC));
    assert.equal(mapOf(mapList, activityMapIdentifier(MUSIC)), undefined);
    assert.deepEqual(mapList, cfg.mapList);
  });

  it("refuses a map that changed on the hub, or an activity that's gone", () => {
    const cfg = config();
    const draft = setAction(readHomeButtons(cfg, SMART_TV), "Ha1", "press", MUTE);
    const changed = structuredClone(cfg);
    keyOf(mapOf(changed, activityMapIdentifier(SMART_TV)), "Ha2").ButtonAction.CommandName = "InputHdmi2";
    assert.throws(() => built(changed, draft), /changed on the hub/);
    const gone = structuredClone(cfg);
    gone.activityList.Activities = gone.activityList.Activities.filter((a) => String(a["Id-"]) !== SMART_TV);
    assert.throws(() => built(gone, draft), /isn't on the hub/);
  });

  it("refuses a sequence that isn't in the map", () => {
    const cfg = config();
    const draft = setAction(readHomeButtons(cfg), "Ha3", "press", { kind: "sequence", sequenceId: "424242", name: "Gone" });
    assert.throws(() => built(cfg, draft), /sequence isn't on the hub/);
  });

  it("copies a global sequence press into the activity map when only the long press is set there", () => {
    const cfg = config();
    const lightsOff = { SequenceId: 7701, Name: "Lights off", Actions: [
      { __type: "ButtonCommandAction", "DeviceId-": Number(MUTE.deviceId), CommandName: MUTE.command, Order: 1 },
      { __type: "ButtonDelayAction", Duration: 500, Order: 2 },
    ] };
    mapOf(cfg, ROOT_MAP).Sequences = [lightsOff];
    const press = { kind: "sequence", sequenceId: "7701", name: "Lights off" };
    cfg.mapList = built(cfg, setAction(setAction(readHomeButtons(cfg), "Ha2", "press", press), "Ha4", "press", press));
    for (const activityId of [SHIELD, MUSIC]) {
      const draft = setAction(setAction(readHomeButtons(cfg, activityId), "Ha2", "long", MUTE), "Ha4", "long", MUTE);
      const mapList = built(cfg, draft);
      const map = mapOf(mapList, activityMapIdentifier(activityId));
      const copies = map.Sequences.filter((s) => s.Name === "Lights off");
      assert.equal(copies.length, 1, activityId);
      assert.notEqual(copies[0].SequenceId, 7701);
      assert.deepEqual(copies[0].Actions, lightsOff.Actions);
      assert.equal(keyOf(map, "Ha2").ButtonAction.SequenceId, copies[0].SequenceId);
      assert.equal(keyOf(map, "Ha4").ButtonAction.SequenceId, copies[0].SequenceId);
      assert.deepEqual(mapOf(mapList, ROOT_MAP), mapOf(cfg, ROOT_MAP));
      assert.deepEqual(validateMapList(mapList), []);
      const saved = readHomeButtons({ ...cfg, mapList }, activityId);
      assert.equal(saved.entries.Ha2.press.name, "Lights off");
      assert.deepEqual(saved.entries.Ha2.long, MUTE);
    }
  });

  it("reuses the activity map's copy of a global sequence when the override comes back", () => {
    const cfg = config();
    mapOf(cfg, ROOT_MAP).Sequences = [{ SequenceId: 7701, Name: "Lights off", Actions: [{ __type: "ButtonDelayAction", Duration: 500, Order: 1 }] }];
    cfg.mapList = built(cfg, setAction(readHomeButtons(cfg), "Ha2", "press", { kind: "sequence", sequenceId: "7701", name: "Lights off" }));
    const withLong = (c) => ({ ...c, mapList: built(c, setAction(readHomeButtons(c, SHIELD), "Ha2", "long", MUTE)) });
    const first = withLong(cfg);
    const cleared = { ...first, mapList: built(first, clearAction(readHomeButtons(first, SHIELD), "Ha2", "press")) };
    const again = withLong(cleared);
    const copies = mapOf(again, activityMapIdentifier(SHIELD)).Sequences.filter((s) => s.Name === "Lights off");
    assert.equal(copies.length, 1);
    assert.equal(keyOf(mapOf(again, activityMapIdentifier(SHIELD)), "Ha2").ButtonAction.SequenceId, copies[0].SequenceId);
  });
});

/* The sim fixture isn't a graph the hub validator accepts as a whole: its
   DeviceList has only some of the devices its activities use, and its
   other remotes' maps name an activity it doesn't have. The page carries
   those through untouched, so the hub check gets the Companion's maps and
   a DeviceList with every device the graph names. */
function devicesNamedBy(graph) {
  const ids = new Set();
  JSON.stringify(graph, (key, value) => {
    if (key === "DeviceId-" && value != null) ids.add(Number(value));
    return value;
  });
  return { DevicesWithFeatures: [...ids].map((id) => ({ Device: { "Id-": id } })) };
}

function editedConfigs() {
  const edits = [
    ["global-press-and-long", "", (d) => setAction(setAction(d, "Ha3", "press", MUTE), "Ha3", "long", START_MUSIC)],
    ["global-cleared", "", (d) => clearAction(clearAction(d, "Ha1", "press"), ROCKER_KEYS.up, "press")],
    ["override-and-nothing", SHIELD, (d) => setNothing(setAction(d, "Ha2", "press", MUTE), "Ha1")],
    ["nothing-removed", SMART_TV, (d) => clearAction(d, "Ha3", "press")],
    ["new-map", MUSIC, (d) => setNothing(setAction(d, dimKeys("Ha1").up, "press", MUTE), "Ha2")],
  ];
  return edits.map(([name, activityId, edit]) => {
    const cfg = config();
    const payload = { ...cfg, mapList: built(cfg, edit(readHomeButtons(cfg, activityId))) };
    return {
      name: `home-buttons-${name}`,
      expect: "valid",
      stock: "ok",
      graph: {
        activityList: payload.activityList,
        mapList: { ButtonMaps: payload.mapList.ButtonMaps.filter((m) => m.ButtonMapIdentifier.startsWith("16422")) },
        functionList: payload.functionList,
        deviceList: devicesNamedBy(payload),
      },
    };
  });
}

describe("page output and the hub validator", () => {
  it("passes the web mirror for every kind of edit", () => {
    for (const c of editedConfigs()) assert.deepEqual(validateMapList(c.graph.mapList), [], c.name);
  });

  it("passes codexactivity.lua validateGraph (LuaJIT) for every kind of edit", (t) => {
    const probe = spawnSync("luajit", ["-v"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      t.skip("luajit is not available");
      return;
    }
    const cases = editedConfigs();
    const dir = mkdtempSync(join(tmpdir(), "home-buttons-"));
    try {
      const file = join(dir, "cases.json");
      writeFileSync(file, JSON.stringify({ cases }));
      const out = execFileSync("luajit", ["tools/touch-validator/codexactivity-validate-test.lua", file], {
        cwd: new URL("../../../", import.meta.url).pathname,
        encoding: "utf8",
      });
      assert.match(out, new RegExp(`${cases.length}/${cases.length} cases passed`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("saveOutcome (after a save the hub didn't confirm)", () => {
  const edited = (cfg) => setNothing(setAction(readHomeButtons(cfg, SMART_TV), "Ha1", "press", MUTE), "Ha4");
  const withMapList = (cfg, mapList) => ({ ...cfg, mapList });

  it("says saved when the hub has the draft", () => {
    const cfg = config();
    const draft = edited(cfg);
    assert.equal(saveOutcome(withMapList(cfg, built(cfg, draft)), draft), "saved");
  });

  it("says unchanged when the hub still has the map the draft started from", () => {
    const cfg = config();
    assert.equal(saveOutcome(cfg, edited(cfg)), "unchanged");
  });

  it("says changed when the hub has something else", () => {
    const cfg = config();
    const draft = edited(cfg);
    const other = structuredClone(cfg);
    keyOf(mapOf(other, activityMapIdentifier(SMART_TV)), "Ha2").ButtonAction.CommandName = "InputHdmi2";
    assert.equal(saveOutcome(other, draft), "changed");
  });
});

describe("maps the page didn't write", () => {
  it("reads a delay-only sequence of the owner's as that sequence, and keeps it on save", () => {
    const cfg = config();
    const map = mapOf(cfg, activityMapIdentifier(SMART_TV));
    map.Sequences[0].Name = "Pause";
    const draft = readHomeButtons(cfg, SMART_TV);
    assert.equal(draft.entries.Ha3.state, "set");
    assert.deepEqual(draft.entries.Ha3.press, { kind: "sequence", sequenceId: String(map.Sequences[0].SequenceId), name: "Pause" });
    const saved = mapOf(built(cfg, setAction(draft, "Ha4", "press", MUTE)), activityMapIdentifier(SMART_TV));
    assert.deepEqual(keyOf(saved, "Ha3"), keyOf(map, "Ha3"));
    assert.deepEqual(saved.Sequences, map.Sequences);
  });

  it("writes a key into a map that has no Buttons list", () => {
    const cfg = config();
    mapOf(cfg, ROOT_MAP).Buttons = null;
    const saved = mapOf(built(cfg, setAction(readHomeButtons(cfg), "Ha4", "press", MUTE)), ROOT_MAP);
    assert.equal(keyOf(saved, "Ha4").ButtonAction.CommandName, "Mute");
  });
});

/* A Harmony Elite or 950: a remote with a screen, so its home buttons are in
   the 16417 maps. The fixture's hub has those for a Touch and no 16417Root. */
describe("a screen remote with home buttons (Elite, 950)", () => {
  const SCREEN_ROOT = "16417Root";
  const screenMap = (activityId) => touchMapIdentifier(activityId, SCREEN_EQUAD);
  const read = (cfg, activityId = "") => readHomeButtons(cfg, activityId, SCREEN_EQUAD);
  const runsNothing = (map, key) => {
    const sequence = map.Sequences.find((s) => s.SequenceId === keyOf(map, key).ButtonAction.SequenceId);
    return sequence.Name === NOTHING_NAME && sequence.Actions.length === 1 && sequence.Actions[0].Duration === 0;
  };
  const rfInfo = (rows) => JSON.stringify({ code: 200, data: { EquadID: "34827", RFID: "1", Devices: rows.map(([slot, equad, skin]) => ({ DeviceIndex: String(slot), EquadID: equad, RFID: String(slot), SkinId: skin })) } });
  const models = (rows) => remoteModels(parseRfInfo(rfInfo(rows)).remotes);

  it("orders and labels the 950/Elite buttons as physical dots while leaving the Companion unchanged", () => {
    const companion = homeRemote(COMPANION_EQUAD);
    assert.deepEqual(companion.buttons, HOME_BUTTONS);
    assert.deepEqual(companion.buttons, [
      { key: "Ha1", label: "Light 1" },
      { key: "Ha2", label: "Light 2" },
      { key: "Ha3", label: "Plug 1" },
      { key: "Ha4", label: "Plug 2" },
    ]);
    assert.equal(companion.copy.section, "Light and plug buttons");
    assert.equal(companion.copy.introButtons, "light, plug and + / − buttons");
    assert.equal(companion.copy.hintLast, "light or plug button");

    const screen = homeRemote(SCREEN_EQUAD);
    assert.deepEqual(screen.buttons, [
      { key: "HomeControl1", label: "• 1 dot" },
      { key: "HomeControl3", label: "•• 2 dots" },
      { key: "HomeControl2", label: "••• 3 dots" },
      { key: "HomeControl4", label: "•••• 4 dots" },
    ]);
    assert.equal(screen.copy.section, "Dot buttons");
    assert.equal(screen.copy.introButtons, "home control and + / − buttons");
    assert.equal(screen.copy.hintLast, "dot button");
    assert.equal(screen.copy.hintGroup, "Dot buttons");

    const cfg = config();
    assert.throws(() => setAction(readHomeButtons(cfg), ROCKER_KEYS.up, "long", MUTE), /Light 1, Light 2, Plug 1 and Plug 2/);
    assert.throws(() => setAction(read(cfg), ROCKER_KEYS.up, "long", MUTE), /• 1 dot, •• 2 dots, ••• 3 dots and •••• 4 dots/);
  });

  it("only the Elite's and the 950's skins have them", () => {
    const [touch] = models([[2, "16417", "99"]]);
    assert.equal(hasHomeButtons(touch), false);
    const [pair] = models([[2, "16417", "99"], [3, "16417", "112"]]);
    assert.deepEqual(pair.slots, [2, 3]);
    assert.equal(hasHomeButtons(pair), true);
    assert.equal(pair.name, "Harmony remote with a screen");
    assert.equal(models([[1, "16417", "111"]])[0].name, "Harmony Elite");
    assert.equal(hasHomeButtons(models([[1, "16422", ""]])[0]), true);
    assert.equal(hasHomeButtons(models([[1, "16414", ""]])[0]), false);
  });

  it("can be set up on a hub without a 16417Root, and reads nothing as set", () => {
    const cfg = config();
    assert.equal(mapOf(cfg, SCREEN_ROOT), undefined);
    const draft = read(cfg);
    assert.equal(draft.canEdit, true);
    assert.deepEqual(draft.entries, {});
    assert.equal(isChanged(cfg, draft), false);
    assert.deepEqual(built(cfg, draft), cfg.mapList);
  });

  it("a global button makes the root map, with + and − in it doing nothing", () => {
    const cfg = config();
    let draft = setAction(read(cfg), "HomeControl1", "press", MUTE);
    draft = setAction(draft, "HomeControl1", "long", START_MUSIC);
    draft = setAction(draft, "HomeControl1Up", "press", MUTE);
    const mapList = built(cfg, draft);
    const root = mapOf(mapList, SCREEN_ROOT);
    const sibling = mapOf(cfg, screenMap(SMART_TV));
    assert.equal(root.__type, "RootButtonMap");
    assert.equal("ActivityId-" in root, false);
    assert.equal(root["SurfaceId-"], sibling["SurfaceId-"]);
    assert.equal(root["RemoteId-"], sibling["RemoteId-"]);
    assert.equal(keyOf(root, "HomeControl1").ButtonAction.CommandName, "Mute");
    assert.equal(keyOf(root, "HomeControl1").ButtonLongPressAction.__type, "ButtonActivityAction");
    assert.equal(keyOf(root, "HomeControl1Up").ButtonAction.CommandName, "Mute");
    assert.ok(runsNothing(root, "HomeControlPlus") && runsNothing(root, "HomeControlMinus"));
    assert.equal(root.Sequences.length, 1);
    assert.deepEqual(validateMapList(mapList), []);
    // Every map the hub had is as it was.
    assert.deepEqual(mapList.ButtonMaps.slice(0, cfg.mapList.ButtonMaps.length), cfg.mapList.ButtonMaps);
    const after = read({ ...cfg, mapList });
    assert.equal(after.entries.HomeControl1.state, "set");
    assert.equal(isChanged({ ...cfg, mapList }, draft), false);
    assert.equal(saveOutcome({ ...cfg, mapList }, draft), "saved");
  });

  it("an activity's override goes in that activity's map, beside the Touch's keys", () => {
    const cfg = config();
    const before = mapOf(cfg, screenMap(SMART_TV));
    const draft = setAction(read(cfg, SMART_TV), "HomeControl3", "press", MUTE);
    const mapList = built(cfg, draft);
    const map = mapOf(mapList, screenMap(SMART_TV));
    assert.equal(keyOf(map, "HomeControl3").ButtonAction.CommandName, "Mute");
    assert.deepEqual(map.Buttons.slice(0, before.Buttons.length), before.Buttons);
    assert.deepEqual(map.Sequences, before.Sequences);
    // The remote sends + and − only while the root map has them.
    const root = mapOf(mapList, SCREEN_ROOT);
    assert.deepEqual(root.Buttons.map((b) => b.ButtonKey), ["HomeControlPlus", "HomeControlMinus"]);
    assert.deepEqual(validateMapList(mapList), []);
  });

  it("keeps a + the root map already has, and adds only the one missing", () => {
    const cfg = config();
    const first = built(cfg, setAction(read(cfg), "HomeControl2", "press", MUTE));
    const own = { __type: "ButtonHomeControlAction", ProgramId: 7, EventType: 1 };
    const root = mapOf(first, SCREEN_ROOT);
    keyOf(root, "HomeControlPlus").ButtonAction = own;
    root.Buttons = root.Buttons.filter((b) => b.ButtonKey !== "HomeControlMinus");
    const next = { ...cfg, mapList: first };
    const second = mapOf(built(next, setAction(read(next), "HcUp", "press", MUTE)), SCREEN_ROOT);
    assert.deepEqual(keyOf(second, "HomeControlPlus").ButtonAction, own);
    assert.ok(runsNothing(second, "HomeControlMinus"));
    assert.equal(keyOf(second, "HcUp").ButtonAction.CommandName, "Mute");
    assert.equal(second.Sequences.length, 1);
  });

  it("replaces or clears legacy ButtonHomeControlAction dot bindings in 16417Root while keeping untouched ones", () => {
    const cfg = config();
    const own1 = { __type: "ButtonHomeControlAction", ProgramId: 1, EventType: 1 };
    const own2 = { __type: "ButtonHomeControlAction", ProgramId: 2, EventType: 1 };
    const own3 = { __type: "ButtonHomeControlAction", ProgramId: 3, EventType: 1 };
    const seeded = built(cfg, setAction(setAction(setAction(read(cfg), "HomeControl1", "press", MUTE), "HomeControl2", "press", MUTE), "HomeControl3", "press", MUTE));
    const root = mapOf(seeded, SCREEN_ROOT);
    keyOf(root, "HomeControl1").ButtonAction = own1;
    keyOf(root, "HomeControl2").ButtonAction = own2;
    keyOf(root, "HomeControl3").ButtonAction = own3;
    const legacy = { ...cfg, mapList: seeded };

    const draft = read(legacy);
    assert.equal(effectiveAssignment(draft, "HomeControl1").source, "other");
    assert.equal(effectiveAssignment(draft, "HomeControl2").source, "other");
    assert.equal(effectiveAssignment(draft, "HomeControl3").source, "other");
    assert.throws(() => setAction(draft, "HomeControl1", "long", START_MUSIC), /press does first/);

    let edited = setAction(draft, "HomeControl1", "press", MUTE);
    edited = clearAction(edited, "HomeControl3", "press");
    assert.equal(isChanged(legacy, edited), true);
    assert.equal(keysChanged(legacy, edited, ["HomeControl1"]), true);
    assert.equal(keysChanged(legacy, edited, ["HomeControl2"]), false);
    assert.equal(keysChanged(legacy, edited, ["HomeControl3"]), true);

    const saved = mapOf(built(legacy, edited), SCREEN_ROOT);
    assert.equal(keyOf(saved, "HomeControl1").ButtonAction.CommandName, "Mute");
    assert.deepEqual(keyOf(saved, "HomeControl2").ButtonAction, own2);
    assert.equal(keyOf(saved, "HomeControl3"), undefined);
    assert.ok(runsNothing(saved, "HomeControlPlus") && runsNothing(saved, "HomeControlMinus"));

    const undone = revertKeys(legacy, edited, ["HomeControl1", "HomeControl3"]);
    assert.equal(effectiveAssignment(undone, "HomeControl1").source, "other");
    assert.equal(effectiveAssignment(undone, "HomeControl3").source, "other");
    assert.equal(isChanged(legacy, undone), false);
  });

  it("can't turn a button off in one activity, and knows no Companion keys", () => {
    const cfg = config();
    assert.throws(() => setNothing(read(cfg, SMART_TV), "HomeControl1"), /can't be turned off/);
    assert.throws(() => setAction(read(cfg), "Ha1", "press", MUTE), /isn't a home control key/);
    assert.throws(() => setAction(readHomeButtons(cfg), "HomeControl1", "press", MUTE), /isn't a home control key/);
  });

  it("passes codexactivity.lua validateGraph (LuaJIT)", (t) => {
    const probe = spawnSync("luajit", ["-v"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      t.skip("luajit is not available");
      return;
    }
    const cfg = config();
    const withRoot = { ...cfg, mapList: built(cfg, setAction(read(cfg), "HomeControl1", "press", MUTE)) };
    const withOverride = { ...cfg, mapList: built(cfg, setAction(read(cfg, SMART_TV), "HomeControl4", "press", START_MUSIC)) };
    const cases = [["screen-root", withRoot], ["screen-override", withOverride]].map(([name, payload]) => ({
      name: `home-buttons-${name}`,
      expect: "valid",
      stock: "ok",
      graph: {
        activityList: payload.activityList,
        mapList: { ButtonMaps: payload.mapList.ButtonMaps.filter((m) => m.ButtonMapIdentifier.startsWith("16417")) },
        functionList: payload.functionList,
        deviceList: devicesNamedBy(payload),
      },
    }));
    const dir = mkdtempSync(join(tmpdir(), "home-buttons-"));
    try {
      const file = join(dir, "cases.json");
      writeFileSync(file, JSON.stringify({ cases }));
      const out = execFileSync("luajit", ["tools/touch-validator/codexactivity-validate-test.lua", file], {
        cwd: new URL("../../../", import.meta.url).pathname,
        encoding: "utf8",
      });
      assert.match(out, /2\/2 cases passed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
