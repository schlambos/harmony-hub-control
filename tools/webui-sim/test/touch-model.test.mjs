import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LABEL_MAX,
  addButton,
  buildTouchMapList,
  freeSlot,
  isChanged,
  moveButton,
  neighbourOf,
  readTouchScreen,
  removeButton,
  saveOutcome,
  setCommand,
  setLabel,
  touchSavePayload,
} from "../public/js/views/touch-model.js";
import { validateMapList } from "../public/js/views/remote-model.js";

/* The fixture as the hub would send it: the hub always includes a
   FunctionList (one activity map per activity) and refuses maps for
   activities it doesn't have, so the fixture's orphan maps are dropped. */
const fixture = (() => {
  const raw = JSON.parse(readFileSync(new URL("../fixtures/activity-config.json", import.meta.url), "utf8"));
  const ids = new Set(raw.activityList.Activities.map((a) => String(a["Id-"])));
  raw.mapList.ButtonMaps = raw.mapList.ButtonMaps.filter((m) => m["ActivityId-"] == null || ids.has(String(m["ActivityId-"])));
  raw.functionList = {
    FunctionMaps: [...ids].map((id) => ({ __type: "ActivityFunctionMap", "ActivityId-": Number(id), FunctionGroups: [] })),
  };
  return raw;
})();
const config = () => structuredClone(fixture);

const mapOf = (cfg, id) => cfg.mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === `16417Activity${id}`);
const NOW = 1761264000000;

/* The fixture activity whose screen has on-screen buttons and a number pad. */
const SCREEN = String(fixture.activityList.Activities
  .map((a) => a["Id-"])
  .find((id) => mapOf(fixture, id)?.Buttons.some((b) => b.__type === "SoftRemoteButton" && b.FunctionGroupType !== 2)));
/* The fixture activity with no touch screen at all. */
const NO_SCREEN = String(fixture.activityList.Activities.map((a) => a["Id-"]).find((id) => !mapOf(fixture, id)));

/* Two buttons at slots 0 and 4, plus a Touch-only button at slot 2. */
function gapConfig() {
  const cfg = config();
  const map = mapOf(cfg, SCREEN);
  const soft = map.Buttons.filter((b) => b.__type === "SoftRemoteButton" && b.FunctionGroupType !== 2);
  map.Buttons = map.Buttons.filter((b) => !soft.includes(b) || b === soft[0] || b === soft[1]);
  soft[0].MenuItem.IndexInMenu = 0;
  soft[1].MenuItem.IndexInMenu = 4;
  map.Buttons.push({
    FunctionGroupType: 36,
    ButtonImageKey: null,
    "ImageId-": 0,
    MenuItem: { IndexInMenu: 2, MenuName: `Activity.${SCREEN}` },
    ButtonId: 1500000001,
    ButtonState: 1,
    ButtonAction: { ActionName: "Numpad", Order: 0, Id: 1500000002, EventType: 0, __type: "ButtonClientAction" },
    TextOnRemote: "123",
    __type: "SoftRemoteButton",
    ButtonImagePath: null,
    ButtonDoublePressAction: null,
    ButtonLongPressAction: null,
  });
  return cfg;
}

const device = () => fixture.deviceList.DevicesWithFeatures[0];
const pick = (n = 0) => ({
  deviceId: String(device().Device["Id-"]),
  command: device().Commands[n].Name,
  functionId: device().Commands[n]["FunctionId-"],
});

describe("readTouchScreen", () => {
  it("lists on-screen buttons in slot order and leaves the number pad out", () => {
    const draft = readTouchScreen(fixture, SCREEN);
    const map = mapOf(fixture, SCREEN);
    const soft = map.Buttons.filter((b) => b.__type === "SoftRemoteButton" && b.FunctionGroupType !== 2);
    assert.equal(draft.exists, true);
    assert.equal(draft.rows.length, soft.length);
    const slots = draft.rows.map((r) => r.slot);
    assert.deepEqual(slots, [...slots].sort((a, b) => a - b));
    assert.equal(draft.kept.numberPad, map.Buttons.filter((b) => b.FunctionGroupType === 2).length);
    assert.ok(draft.kept.numberPad > 0);
    assert.ok(draft.rows.every((r) => r.action.kind === "command" && !r.locked));
  });

  it("locks buttons whose action runs on the Touch", () => {
    const draft = readTouchScreen(gapConfig(), SCREEN);
    assert.deepEqual(draft.rows.map((r) => [r.slot, r.locked]), [[0, false], [2, true], [4, false]]);
    assert.equal(draft.rows[1].action.kind, "touch");
    assert.throws(() => setLabel(draft, draft.rows[1].key, "Pad"), /handled by the remote itself/);
    assert.throws(() => removeButton(draft, draft.rows[1].key), /handled by the remote itself/);
  });

  it("reads an activity without a screen as empty, and creatable from a sibling", () => {
    const draft = readTouchScreen(fixture, NO_SCREEN);
    assert.equal(draft.exists, false);
    assert.equal(draft.canCreate, true);
    assert.deepEqual(draft.rows, []);
  });
});

describe("slots stay fixed", () => {
  it("never renumbers a gap on save", () => {
    const cfg = gapConfig();
    let draft = readTouchScreen(cfg, SCREEN);
    draft = setLabel(draft, draft.rows[2].key, "Renamed");
    const map = buildTouchMapList(cfg, draft, { now: NOW }).ButtonMaps.find((m) => m.ButtonMapIdentifier === `16417Activity${SCREEN}`);
    const slots = map.Buttons.filter((b) => b.__type === "SoftRemoteButton" && b.FunctionGroupType !== 2)
      .map((b) => [b.MenuItem.IndexInMenu, b.TextOnRemote]);
    assert.deepEqual(slots.map(([s]) => s).sort(), [0, 2, 4]);
    assert.ok(slots.some(([s, t]) => s === 4 && t === "Renamed"));
  });

  it("puts a new button in the lowest free slot, around the Touch-only one", () => {
    let draft = readTouchScreen(gapConfig(), SCREEN);
    assert.equal(freeSlot(draft.rows), 1);
    draft = addButton(draft, { label: "One", ...pick() });
    draft = addButton(draft, { label: "Three", ...pick() });
    draft = addButton(draft, { label: "Five", ...pick() });
    assert.deepEqual(draft.rows.map((r) => r.slot), [0, 1, 2, 3, 4, 5]);
  });

  it("removing a button leaves a gap", () => {
    let draft = readTouchScreen(gapConfig(), SCREEN);
    draft = removeButton(draft, draft.rows[0].key);
    assert.deepEqual(draft.rows.map((r) => r.slot), [2, 4]);
  });

  it("moving swaps slots with the nearest movable button, skipping locked ones", () => {
    let draft = readTouchScreen(gapConfig(), SCREEN);
    const [first, , last] = draft.rows;
    assert.equal(neighbourOf(draft, first.key, -1), null);
    assert.equal(neighbourOf(draft, first.key, 1).key, last.key);
    draft = moveButton(draft, last.key, -1);
    assert.deepEqual(draft.rows.map((r) => [r.key, r.slot]), [[last.key, 0], [draft.rows[1].key, 2], [first.key, 4]]);
    assert.equal(draft.rows[1].locked, true);
  });
});

describe("buildTouchMapList", () => {
  it("writes nothing new for an unchanged draft except the date", () => {
    const cfg = config();
    const draft = readTouchScreen(cfg, SCREEN);
    assert.equal(isChanged(cfg, draft), false);
    const out = buildTouchMapList(cfg, draft, { now: NOW });
    const before = structuredClone(cfg.mapList);
    mapOf({ mapList: before }, SCREEN).DateModified = `/Date(${NOW}+0000)/`;
    assert.equal(JSON.stringify(out), JSON.stringify(before));
  });

  it("changes only the edited fields of the activity's screen", () => {
    const cfg = config();
    let draft = readTouchScreen(cfg, SCREEN);
    const target = draft.rows[1];
    draft = setLabel(draft, target.key, "  Renamed   button  ");
    draft = setCommand(draft, target.key, pick(1));
    assert.equal(isChanged(cfg, draft), true);
    const out = buildTouchMapList(cfg, draft, { now: NOW });

    // Every other map is byte-identical and in place.
    cfg.mapList.ButtonMaps.forEach((map, i) => {
      if (map.ButtonMapIdentifier === `16417Activity${SCREEN}`) return;
      assert.equal(JSON.stringify(out.ButtonMaps[i]), JSON.stringify(map));
    });
    const before = mapOf(cfg, SCREEN);
    const after = out.ButtonMaps.find((m) => m.ButtonMapIdentifier === `16417Activity${SCREEN}`);
    assert.deepEqual(Object.keys(after), Object.keys(before));
    assert.equal(after.Buttons.length, before.Buttons.length);
    after.Buttons.forEach((button, i) => {
      const old = before.Buttons[i];
      assert.deepEqual(Object.keys(button), Object.keys(old));
      if (button.ButtonId !== target.buttonId) {
        assert.equal(JSON.stringify(button), JSON.stringify(old));
        return;
      }
      assert.equal(button.TextOnRemote, "Renamed button");
      assert.deepEqual(Object.keys(button.ButtonAction), Object.keys(old.ButtonAction));
      assert.equal(button.ButtonAction.CommandName, pick(1).command);
      assert.equal(button.ButtonAction.EventType, old.ButtonAction.EventType);
      assert.equal(button.MenuItem.IndexInMenu, old.MenuItem.IndexInMenu);
    });
  });

  it("writes a new button with Logitech's fields, a fresh id and its activity's menu name", () => {
    const cfg = config();
    const draft = addButton(readTouchScreen(cfg, SCREEN), { label: "New", ...pick() });
    const out = buildTouchMapList(cfg, draft, { now: NOW });
    const map = out.ButtonMaps.find((m) => m.ButtonMapIdentifier === `16417Activity${SCREEN}`);
    const added = map.Buttons.at(-1);
    const sample = mapOf(cfg, SCREEN).Buttons.find((b) => b.__type === "SoftRemoteButton");
    assert.deepEqual(Object.keys(added), Object.keys(sample));
    assert.deepEqual(Object.keys(added.ButtonAction), Object.keys(sample.ButtonAction));
    assert.deepEqual(added.MenuItem, { IndexInMenu: freeSlot(readTouchScreen(cfg, SCREEN).rows), MenuName: `Activity.${SCREEN}` });
    assert.equal(added.TextOnRemote, "New");
    assert.equal(added.FunctionGroupType, 0);
    assert.equal(added.ButtonAction.EventType, 0);
    const ids = JSON.stringify(cfg).match(/"ButtonId":\d+/g).map((s) => Number(s.split(":")[1]));
    assert.ok(added.ButtonId > Math.max(...ids));
  });

  it("drops a removed button and keeps every other button", () => {
    const cfg = config();
    let draft = readTouchScreen(cfg, SCREEN);
    const gone = draft.rows[0];
    draft = removeButton(draft, gone.key);
    const map = buildTouchMapList(cfg, draft, { now: NOW }).ButtonMaps.find((m) => m.ButtonMapIdentifier === `16417Activity${SCREEN}`);
    assert.equal(map.Buttons.length, mapOf(cfg, SCREEN).Buttons.length - 1);
    assert.ok(!map.Buttons.some((b) => b.ButtonId === gone.buttonId));
  });

  it("creates a screen for an activity without one, copying the surface from a sibling", () => {
    const cfg = config();
    const draft = addButton(readTouchScreen(cfg, NO_SCREEN), { label: "First", ...pick() });
    const out = buildTouchMapList(cfg, draft, { now: NOW });
    assert.equal(out.ButtonMaps.length, cfg.mapList.ButtonMaps.length + 1);
    const map = out.ButtonMaps.at(-1);
    const sibling = cfg.mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier.startsWith("16417Activity"));
    assert.deepEqual(Object.keys(map), Object.keys(sibling));
    assert.equal(map.ButtonMapIdentifier, `16417Activity${NO_SCREEN}`);
    assert.equal(map["ActivityId-"], Number(NO_SCREEN));
    for (const field of ["SurfaceId-", "RemoteId-", "ButtonMapSurfaceId-"]) assert.equal(map[field], sibling[field]);
    const mapIds = cfg.mapList.ButtonMaps.map((m) => m["ButtonMapId-"]);
    assert.ok(map["ButtonMapId-"] > Math.max(...mapIds));
    assert.deepEqual(map.Buttons.map((b) => b.MenuItem.IndexInMenu), [0]);
  });

  it("refuses a new screen when the hub has no touch screen to copy", () => {
    const cfg = config();
    cfg.mapList.ButtonMaps = cfg.mapList.ButtonMaps.filter((m) => !m.ButtonMapIdentifier.startsWith("16417"));
    const draft = readTouchScreen(cfg, NO_SCREEN);
    assert.equal(draft.canCreate, false);
    assert.throws(() => buildTouchMapList(cfg, addButton(draft, { label: "X", ...pick() })), /no remote with a screen/);
  });

  it("refuses when the screen changed on the hub after the draft was read", () => {
    const cfg = config();
    const draft = setLabel(readTouchScreen(cfg, SCREEN), readTouchScreen(cfg, SCREEN).rows[0].key, "Mine");
    mapOf(cfg, SCREEN).Buttons[0].TextOnRemote = "Theirs";
    assert.throws(() => buildTouchMapList(cfg, draft), /changed on the hub/);
  });

  it("keeps sequences, gestures, hard buttons and the number pad", () => {
    const cfg = config();
    const draft = addButton(removeButton(readTouchScreen(cfg, SCREEN), readTouchScreen(cfg, SCREEN).rows[0].key), { label: "N", ...pick() });
    const before = mapOf(cfg, SCREEN);
    const after = buildTouchMapList(cfg, draft, { now: NOW }).ButtonMaps.find((m) => m.ButtonMapIdentifier === `16417Activity${SCREEN}`);
    const others = (map) => JSON.stringify(map.Buttons.filter((b) => b.__type !== "SoftRemoteButton" || b.FunctionGroupType === 2));
    assert.equal(others(after), others(before));
    assert.equal(JSON.stringify(after.Sequences), JSON.stringify(before.Sequences));
  });
});

describe("labels", () => {
  it("are trimmed, single-spaced, capped and required", () => {
    const draft = readTouchScreen(fixture, SCREEN);
    const key = draft.rows[0].key;
    assert.equal(setLabel(draft, key, "x".repeat(40)).rows[0].label.length, LABEL_MAX);
    assert.throws(() => setLabel(draft, key, "   "), /needs a label/);
    assert.throws(() => addButton(draft, { label: "", ...pick() }), /needs a label/);
  });
});

/* Every kind of edit, as the graphs the editor would save, made from the
   validator's complete synthetic graphs (touch-maplist.json): a screen with
   a number pad, gestures, a sequence button and an activity button; one
   with gap slots; an empty screen. TOUCH_CASES_OUT writes them out for the
   out-of-tree stock-reader check. */
const synthetic = JSON.parse(readFileSync(new URL("../fixtures/touch-maplist.json", import.meta.url), "utf8"));
const graphConfig = (name) => ({ revision: "r1", ...structuredClone(synthetic.cases.find((c) => c.name === name).graph) });
const SYN = { deviceId: "10", command: "Mute", functionId: 0 };

function editorCases() {
  const edits = [
    ["relabel-and-recommand", "valid-activity-full", (cfg) => {
      const d = readTouchScreen(cfg, "100");
      const key = d.rows.find((r) => r.action.kind === "command").key;
      return setCommand(setLabel(d, key, "Renamed"), key, SYN);
    }],
    ["sequence-and-activity-buttons-relabelled-and-moved", "valid-activity-full", (cfg) => {
      let d = readTouchScreen(cfg, "100");
      for (const kind of ["sequence", "activity"]) {
        const key = d.rows.find((r) => r.action.kind === kind).key;
        d = moveButton(setLabel(d, key, `My ${kind}`), key, -1);
      }
      return d;
    }],
    ["move-and-remove", "valid-activity-full", (cfg) => {
      const d = readTouchScreen(cfg, "100");
      return removeButton(moveButton(d, d.rows.at(-1).key, -1), d.rows[0].key);
    }],
    ["add-into-gap", "valid-gap-slots", (cfg) => addButton(readTouchScreen(cfg, "101"), { label: "Gap", ...SYN })],
    ["fill-empty-screen", "valid-empty-touch-map", (cfg) => addButton(readTouchScreen(cfg, "102"), { label: "First", ...SYN })],
    ["new-screen", "valid-activity-full", (cfg) => addButton(addButton(readTouchScreen(cfg, "103"), { label: "A", ...SYN }), { label: "B", ...SYN })],
    ["remove-every-button", "valid-activity-full", (cfg) => {
      let d = readTouchScreen(cfg, "100");
      for (const row of d.rows) d = removeButton(d, row.key);
      return d;
    }],
  ];
  return edits.map(([name, base, edit]) => {
    const cfg = graphConfig(base);
    const payload = touchSavePayload(cfg, edit(cfg), { now: NOW });
    return {
      name: `editor-${name}`,
      expect: "valid",
      stock: "ok",
      graph: { activityList: payload.activityList, mapList: payload.mapList, functionList: payload.functionList, deviceList: cfg.deviceList },
    };
  });
}

describe("editor output and the hub validator", () => {
  it("passes the web mirror for every kind of edit", () => {
    for (const c of editorCases()) assert.deepEqual(validateMapList(c.graph.mapList), [], c.name);
  });

  it("passes codexactivity.lua validateGraph (LuaJIT) for every kind of edit", (t) => {
    const probe = spawnSync("luajit", ["-v"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      t.skip("luajit is not available");
      return;
    }
    const cases = editorCases();
    const dir = mkdtempSync(join(tmpdir(), "touch-editor-"));
    try {
      const file = join(dir, "cases.json");
      writeFileSync(file, JSON.stringify({ cases }));
      if (process.env.TOUCH_CASES_OUT) writeFileSync(process.env.TOUCH_CASES_OUT, JSON.stringify({ cases }));
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
  const edited = (cfg) => {
    const d = readTouchScreen(cfg, SCREEN);
    return addButton(moveButton(setLabel(d, d.rows[0].key, "Mine"), d.rows[0].key, 1), { label: "New", ...pick() });
  };
  const withMapList = (cfg, mapList) => ({ ...cfg, mapList });

  it("says saved when the hub has the draft, new buttons included", () => {
    const cfg = config();
    const draft = edited(cfg);
    assert.equal(saveOutcome(withMapList(cfg, buildTouchMapList(cfg, draft, { now: NOW })), draft), "saved");
  });

  it("says unchanged when the hub still has the screen the draft started from", () => {
    const cfg = config();
    assert.equal(saveOutcome(cfg, edited(cfg)), "unchanged");
  });

  it("says changed when the hub has something else", () => {
    const cfg = config();
    const draft = edited(cfg);
    const other = structuredClone(cfg);
    mapOf(other, SCREEN).Buttons.find((b) => b.__type === "SoftRemoteButton").TextOnRemote = "Theirs";
    assert.equal(saveOutcome(other, draft), "changed");
  });
});

describe("touchSavePayload", () => {
  it("sends ActivityList and FunctionList as they are, with the config's revision", () => {
    const cfg = config();
    const draft = setLabel(readTouchScreen(cfg, SCREEN), readTouchScreen(cfg, SCREEN).rows[0].key, "Mine");
    const payload = touchSavePayload(cfg, draft, { now: NOW });
    assert.equal(payload.baseRevision, cfg.revision);
    assert.deepEqual(payload.activityList, cfg.activityList);
    assert.deepEqual(payload.functionList, cfg.functionList);
    assert.deepEqual(validateMapList(payload.mapList), []);
  });

  it("refuses to save without the hub's FunctionList rather than send an empty one", () => {
    const cfg = config();
    const draft = setLabel(readTouchScreen(cfg, SCREEN), readTouchScreen(cfg, SCREEN).rows[0].key, "Mine");
    delete cfg.functionList;
    assert.throws(() => touchSavePayload(cfg, draft), /didn't load completely/);
  });
});
