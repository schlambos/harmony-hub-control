// #201: the Advanced Editor's load-time repair built a missing 16414 (Smart
// Control) activity map and routed the Touch map's colour-key presses into it,
// sequence presses included, without the sequences. The Hub resolves a
// ButtonSequenceAction against its own map only, so it refused the save:
// "MapList map 16414Activity52529231 button references missing sequence 1925596".
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { validateMapList } from "../public/js/views/remote-model.js";
import { repairGraph } from "../../activity_graph_repair.mjs";

const repoRoot = new URL("../../../", import.meta.url).pathname;
const source = readFileSync(new URL("../../../payload/web/activity-ui.js", import.meta.url), "utf8");
const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/issue201/activity-config.json", import.meta.url), "utf8"),
);

function loadEditor(config) {
  const context = { __HARMONY_ACTIVITY_TEST__: {} };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "activity-ui.js" });
  const api = context.__HARMONY_ACTIVITY_TEST__.api;
  api.state.config = JSON.parse(JSON.stringify(config));
  api.resetIdPool();
  return api;
}

// Values made in the editor's vm realm, as plain JSON for deepEqual.
const plain = (value) => JSON.parse(JSON.stringify(value));
const mapById = (mapList, id) => mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === id);
const hardKey = (map, key) => map.Buttons.find((b) => b.ButtonKey === key);

// Every sequence press resolves in its own map, as the stock engine needs.
function danglingSequencePresses(mapList) {
  const out = [];
  for (const map of mapList.ButtonMaps) {
    const own = new Set((map.Sequences ?? []).map((s) => String(s.SequenceId)));
    for (const button of map.Buttons) {
      for (const field of ["ButtonAction", "ButtonLongPressAction", "ButtonDoublePressAction"]) {
        const action = button[field];
        if (action?.__type === "ButtonSequenceAction" && !own.has(String(action.SequenceId))) {
          out.push(`${map.ButtonMapIdentifier} ${button.ButtonKey ?? button.ButtonId} ${action.SequenceId}`);
        }
      }
    }
  }
  return out;
}

describe("#201 sequence presses routed into a new remote map", () => {
  it("the reporter's hub config is valid as stored", () => {
    assert.deepEqual(validateMapList(fixture.mapList), []);
    assert.deepEqual(danglingSequencePresses(fixture.mapList), []);
    assert.equal(mapById(fixture.mapList, "16414Activity52529231"), undefined);
  });

  it("creates 16414Activity52529231 with the Touch map's sequences, so the MapList still validates", () => {
    const api = loadEditor(fixture);
    const repair = api.reconcileActivityMaps();
    const mapList = api.state.config.mapList;
    const created = mapById(mapList, "16414Activity52529231");
    assert.ok(created, "the missing Smart Control map is created");
    assert.ok(repair.created.some((m) => m.ButtonMapIdentifier === "16414Activity52529231"));

    assert.deepEqual(danglingSequencePresses(mapList), []);
    assert.deepEqual(validateMapList(mapList), []);

    // The Smart Control's Green and Red keys run the same sequences as the Touch's.
    const touch = mapById(mapList, "16417Activity52529231");
    for (const key of ["Green", "Red"]) {
      const action = hardKey(created, key)?.ButtonAction;
      assert.equal(action?.__type, "ButtonSequenceAction", `${key} keeps its sequence press`);
      const copied = created.Sequences.find((s) => String(s.SequenceId) === String(action.SequenceId));
      const original = touch.Sequences.find((s) => String(s.SequenceId) === String(action.SequenceId));
      assert.deepEqual(plain(copied), plain(original), `${key}'s sequence ${action.SequenceId} is carried over intact`);
    }
    assert.equal(created.Sequences.length, 2, "only the sequences its buttons run are carried");

    // A second pass finds nothing more to do.
    const again = api.reconcileActivityMaps();
    assert.equal(again.carriedSequences, 0);
    assert.deepEqual(plain(again.clearedSequenceActions), []);
    assert.equal(again.routedButtonActions, 0);
  });

  it("the Hub's own validator (codexactivity.lua) accepts the repaired MapList and rejects main's", (t) => {
    const probe = spawnSync("luajit", ["-v"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      t.skip("luajit is not available");
      return;
    }
    const api = loadEditor(fixture);
    api.reconcileActivityMaps();
    const repaired = api.state.config;
    // What main's editor sent: the Green press with no sequence in its map.
    const broken = JSON.parse(JSON.stringify(repaired));
    mapById(broken.mapList, "16414Activity52529231").Sequences = [];
    const graph = (config) => ({
      activityList: config.activityList,
      mapList: config.mapList,
      functionList: config.functionList,
      deviceList: config.deviceList,
    });
    const dir = mkdtempSync(path.join(tmpdir(), "issue201-"));
    try {
      const file = path.join(dir, "cases.json");
      writeFileSync(file, JSON.stringify({
        cases: [
          { name: "issue201 repaired editor MapList", expect: "valid", graph: graph(repaired) },
          {
            name: "issue201 sequence press without its sequence",
            expect: "invalid",
            errorIncludes: "MapList map 16414Activity52529231 button references missing sequence",
            graph: graph(broken),
          },
        ],
      }));
      const out = execFileSync("luajit", ["tools/touch-validator/codexactivity-validate-test.lua", file], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      assert.match(out, /PASS issue201 repaired editor MapList/);
      assert.match(out, /PASS issue201 sequence press without its sequence/);
      assert.match(out, /2\/2 cases passed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tools/activity_graph_repair.mjs routes the same presses with their sequences", () => {
    const { next } = repairGraph(JSON.parse(JSON.stringify(fixture)));
    const created = mapById(next.mapList, "16414Activity52529231");
    assert.ok(created, "the repair tool creates the missing Smart Control map");
    assert.equal(hardKey(created, "Green")?.ButtonAction?.__type, "ButtonSequenceAction");
    assert.deepEqual(danglingSequencePresses(next.mapList), []);
    assert.deepEqual(validateMapList(next.mapList), []);
  });

  it("duplicating an activity keeps the sequences its copied presses run", () => {
    const api = loadEditor(fixture);
    const touch = mapById(api.state.config.mapList, "16417Activity52529231");
    const copy = api.cloneMapForActivity(touch, 52529231, 99000001, true);
    assert.deepEqual(danglingSequencePresses({ ButtonMaps: [copy] }), []);
    assert.equal(copy.Sequences.length, touch.Sequences.length);
  });

  it("clears a sequence press the Hub has nowhere to resolve, and names the button and map", () => {
    const config = JSON.parse(JSON.stringify(fixture));
    const touch = mapById(config.mapList, "16417Activity53782167");
    const yellow = hardKey(touch, "Yellow");
    assert.equal(yellow.ButtonAction.__type, "ButtonSequenceAction");
    const missingId = yellow.ButtonAction.SequenceId;
    touch.Sequences = touch.Sequences.filter((s) => String(s.SequenceId) !== String(missingId));
    assert.ok(validateMapList(config.mapList).some((e) => e.includes(`references missing sequence ${missingId}`)));

    const api = loadEditor(config);
    const repair = api.reconcileActivityMaps();
    assert.equal(repair.changed, true);
    assert.deepEqual(
      plain(repair.clearedSequenceActions),
      [{ map: "16417Activity53782167", button: "yellow", field: "ButtonAction", sequenceId: String(missingId) }],
    );
    assert.deepEqual(validateMapList(api.state.config.mapList), []);
    // Its other presses are untouched.
    const after = mapById(api.state.config.mapList, "16417Activity53782167");
    assert.equal(hardKey(after, "Info").ButtonAction.__type, "ButtonSequenceAction");
  });

  it("a press whose sequence lives in a sibling map of the same activity gets a copy instead of being cleared", () => {
    const config = JSON.parse(JSON.stringify(fixture));
    const smart = mapById(config.mapList, "16414Activity53782167");
    const touch = mapById(config.mapList, "16417Activity53782167");
    const info = hardKey(touch, "Info").ButtonAction;
    const green = hardKey(smart, "Green");
    green.ButtonAction = { ...info, Id: 0 };
    assert.ok(validateMapList(config.mapList).length > 0);

    const api = loadEditor(config);
    const repair = api.reconcileActivityMaps();
    assert.equal(repair.carriedSequences, 1);
    assert.deepEqual(plain(repair.clearedSequenceActions), []);
    assert.deepEqual(validateMapList(api.state.config.mapList), []);
  });
});
