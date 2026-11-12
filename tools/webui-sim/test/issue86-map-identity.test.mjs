/* Issue #86: editor / wizard / repair map identity.
   The hub resolves button presses by ButtonMapIdentifier (<EquadID>Activity<id>
   or <EquadID>Root) and never reads RemoteId-, SurfaceId- or ButtonMapSurfaceId-.
   Covers the two proven failures from re/reports/issue86-imported-activity-maps.md:
   1. Companion maps (16422/16423) sharing the Smart Control's (16414) surface ids
      must be treated as distinct remote surfaces in the wizard, advanced editor,
      and activity_graph_repair.mjs — never rejected as duplicates.
   2. After deleting all activities, new wizard maps and repaired maps take their
      surface ids from surviving <EquadID>Root (or device) maps instead of leaving
      nulls that block the advanced editor or get cloned across activities. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildActivityGraph,
  deleteActivityResources,
  draftButtonsFromMap,
} from "../public/js/wizard-model.js";
import { repairGraph, identityTotals } from "../../activity_graph_repair.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(ROOT, "../../..");
const EDITOR_SRC = fs.readFileSync(join(REPO_ROOT, "payload/web/activity-ui.js"), "utf8");
const RAW_FIXTURE = JSON.parse(
  fs.readFileSync(join(ROOT, "../fixtures/activity-config.json"), "utf8"),
);

function createEditor(config) {
  const context = { __HARMONY_ACTIVITY_TEST__: {} };
  vm.createContext(context);
  vm.runInContext(EDITOR_SRC, context, { filename: "activity-ui.js" });
  const api = context.__HARMONY_ACTIVITY_TEST__.api;
  api.state.config = structuredClone(config);
  api.resetIdPool();
  return api;
}

function cleanFixture() {
  const base = structuredClone(RAW_FIXTURE);
  const ids = base.activityList.Activities.map((a) => a["Id-"]);
  base.mapList.ButtonMaps = base.mapList.ButtonMaps.filter(
    (m) => m["ActivityId-"] == null || ids.includes(m["ActivityId-"]),
  );
  base.functionList = {
    FunctionMaps: ids.map((id) => ({
      UIModeName: `Functions.UserConfigurator.${id}`,
      __type: "ActivityFunctionMap",
      "ActivityId-": id,
      FunctionGroups: [],
    })),
  };
  const devIds = new Set(
    base.deviceList.DevicesWithFeatures.map((e) => String((e.Device ?? e)["Id-"])),
  );
  for (const a of base.activityList.Activities) {
    a.Roles = a.Roles.filter((r) => devIds.has(String(r["DeviceId-"])));
  }
  for (const m of base.mapList.ButtonMaps) {
    for (const b of m.Buttons ?? []) {
      for (const f of ["ButtonAction", "ButtonLongPressAction", "ButtonDoublePressAction"]) {
        if (b[f] && b[f]["DeviceId-"] != null && !devIds.has(String(b[f]["DeviceId-"]))) {
          b[f] = null;
        }
      }
    }
  }
  const api = createEditor(base);
  api.reconcileActivityMaps();
  api.validateGraph();
  return api.state.config;
}

function addSharedSurfaceCompanionMaps(config, prefix = "16422") {
  const next = structuredClone(config);
  const ids = next.activityList.Activities.map((a) => a["Id-"]);
  let nextMap = 60000000;
  let nextBtn = 1900000000;
  for (const id of ids) {
    const sc = next.mapList.ButtonMaps.find(
      (m) => m.ButtonMapIdentifier === `16414Activity${id}`,
    );
    const comp = structuredClone(sc);
    comp.ButtonMapIdentifier = `${prefix}Activity${id}`;
    comp["ButtonMapId-"] = nextMap++;
    comp.Buttons.forEach((b) => {
      b.ButtonId = nextBtn++;
    });
    next.mapList.ButtonMaps.push(comp);
  }
  return next;
}

describe("issue #86 failure 2 — Companion + Smart Control sharing surface ids", () => {
  it("S1: advanced editor accepts 16414Activity + 16422Activity on identical RemoteId|SurfaceId|ButtonMapSurfaceId", () => {
    const s1 = addSharedSurfaceCompanionMaps(cleanFixture());
    const api = createEditor(s1);
    const r = api.reconcileActivityMaps();
    assert.equal(r.changed, false);
    assert.equal(r.created.length, 0);
    assert.equal(r.removed.length, 0);
    assert.doesNotThrow(() => api.validateGraph());
  });

  it("S1b: deleting one activity's 16422 map is healed by editor reconcile and passes validateGraph", () => {
    const s1b = addSharedSurfaceCompanionMaps(cleanFixture());
    const firstId = s1b.activityList.Activities[0]["Id-"];
    s1b.mapList.ButtonMaps = s1b.mapList.ButtonMaps.filter(
      (m) => m.ButtonMapIdentifier !== `16422Activity${firstId}`,
    );
    const api = createEditor(s1b);
    const r = api.reconcileActivityMaps();
    assert.equal(r.changed, true);
    assert.deepEqual(
      [...r.created].map((m) => m.ButtonMapIdentifier),
      [`16422Activity${firstId}`],
    );
    assert.doesNotThrow(() => api.validateGraph());
  });

  it("S1c: wizard re-save of an activity with shared-surface Companion maps produces a graph the editor accepts", () => {
    const s1 = addSharedSurfaceCompanionMaps(cleanFixture());
    const first = s1.activityList.Activities[0];
    const firstId = first["Id-"];
    const wizMap = s1.mapList.ButtonMaps.find(
      (m) => m.ButtonMapIdentifier === `16414Activity${firstId}`,
    );
    const draft = {
      name: first.Name,
      type: first.Type,
      roles: first.Roles.map((r) => ({
        deviceId: String(r["DeviceId-"]),
        roleType: r.__type,
        input: r.SelectedInput?.Name ?? "",
        powerDelay: r.NextDevicePowerOnDelay,
      })),
      buttons: draftButtonsFromMap(wizMap),
    };
    const g = buildActivityGraph({ config: s1, draft, editId: firstId });
    const api = createEditor({
      ...s1,
      activityList: g.activityList,
      mapList: g.mapList,
      functionList: g.functionList,
    });
    assert.doesNotThrow(() => api.validateGraph());
  });

  it("repairGraph accepts a Companion hub with shared surface ids and heals a missing Companion map", () => {
    const s1 = addSharedSurfaceCompanionMaps(cleanFixture());
    for (const d of s1.deviceList.DevicesWithFeatures) {
      if ((d.Device ?? d).Transport === 32) (d.Device ?? d).IsKeyboardAssociated = false;
    }
    assert.doesNotThrow(() => repairGraph(s1));
    const { summary: cleanSummary } = repairGraph(s1);
    assert.equal(cleanSummary.createdActivityMaps.length, 0);

    const firstId = s1.activityList.Activities[0]["Id-"];
    const missingOne = structuredClone(s1);
    missingOne.mapList.ButtonMaps = missingOne.mapList.ButtonMaps.filter(
      (m) => m.ButtonMapIdentifier !== `16422Activity${firstId}`,
    );
    const { next, summary } = repairGraph(missingOne);
    assert.equal(summary.createdActivityMaps.length, 1);
    assert.ok(
      next.mapList.ButtonMaps.some(
        (m) => m.ButtonMapIdentifier === `16422Activity${firstId}`,
      ),
    );
  });

  it("rejects two maps with the same ButtonMapIdentifier even if their surface ids differ", () => {
    const cfg = cleanFixture();
    const firstId = cfg.activityList.Activities[0]["Id-"];
    const sc = cfg.mapList.ButtonMaps.find(
      (m) => m.ButtonMapIdentifier === `16414Activity${firstId}`,
    );
    const dup = structuredClone(sc);
    dup["ButtonMapId-"] = 69000001;
    dup["RemoteId-"] = 9991;
    dup["SurfaceId-"] = 9992;
    dup["ButtonMapSurfaceId-"] = 9992;
    dup.Buttons.forEach((b, i) => {
      b.ButtonId = 1990000000 + i;
    });
    cfg.mapList.ButtonMaps.push(dup);

    const api = createEditor(cfg);
    assert.throws(
      () => api.validateGraph(),
      /has more than one button map for remote surface 16414\|ActivityButtonMap|Button map identifier 16414Activity.*is duplicated/,
    );

    // Also rejected for non-activity maps (e.g., duplicate 16414Root).
    const rootCfg = cleanFixture();
    const root = rootCfg.mapList.ButtonMaps.find(
      (m) => m.ButtonMapIdentifier === "16414Root",
    );
    const dupRoot = structuredClone(root);
    dupRoot["ButtonMapId-"] = 69000002;
    dupRoot.Buttons.forEach((b, i) => {
      b.ButtonId = 1990001000 + i;
    });
    rootCfg.mapList.ButtonMaps.push(dupRoot);
    const rootApi = createEditor(rootCfg);
    assert.throws(
      () => rootApi.validateGraph(),
      /Button map identifier 16414Root is duplicated/,
    );
  });
});

describe("issue #86 failure 3 — deleting all activities then creating a new one", () => {
  it("S2: wizard takes surface ids from surviving 16414Root map, and advanced editor + repair accept the result", () => {
    let s2 = addSharedSurfaceCompanionMaps(cleanFixture());
    for (const a of s2.activityList.Activities) {
      const d = deleteActivityResources(s2, a["Id-"]);
      s2 = { ...s2, ...d };
    }
    assert.deepEqual(
      s2.mapList.ButtonMaps.filter((m) => !/Device/.test(m.ButtonMapIdentifier)).map(
        (m) => m.ButtonMapIdentifier,
      ),
      ["16414Root"],
    );

    const dev = s2.deviceList.DevicesWithFeatures[0];
    const devId = String((dev.Device ?? dev)["Id-"]);
    const cmd = (dev.Commands ?? [])[0];
    const newDraft = {
      name: "Fresh",
      type: 1,
      roles: [{ deviceId: devId, roleType: "DisplayActivityRole", input: "", powerDelay: "" }],
      buttons: {
        VolumeUp: {
          deviceId: devId,
          command: { name: cmd.Name, functionId: cmd["FunctionId-"] ?? 0 },
          hold: null,
        },
      },
    };
    const g2 = buildActivityGraph({ config: s2, draft: newDraft });
    const createdMap = g2.mapList.ButtonMaps.find(
      (m) => m.ButtonMapIdentifier === `16414Activity${g2.activityId}`,
    );
    assert.ok(createdMap);
    assert.equal(createdMap["RemoteId-"], 12345678);
    assert.equal(createdMap["SurfaceId-"], 13151460);
    assert.equal(createdMap["ButtonMapSurfaceId-"], 13151460);

    const s2cfg = {
      ...s2,
      activityList: g2.activityList,
      mapList: g2.mapList,
      functionList: g2.functionList,
    };
    const api = createEditor(s2cfg);
    api.reconcileActivityMaps();
    assert.doesNotThrow(() => api.validateGraph());
    for (const m of api.state.config.mapList.ButtonMaps.filter(
      (entry) => String(entry["ActivityId-"]) === String(g2.activityId),
    )) {
      assert.equal(m["RemoteId-"], 12345678, `${m.ButtonMapIdentifier} RemoteId-`);
      assert.equal(m["SurfaceId-"], 13151460, `${m.ButtonMapIdentifier} SurfaceId-`);
      assert.equal(
        m["ButtonMapSurfaceId-"],
        13151460,
        `${m.ButtonMapIdentifier} ButtonMapSurfaceId-`,
      );
    }
  });

  it("editor and repair backfill null surface ids from Root and never clone null-id maps without an identifier", () => {
    const cfg = cleanFixture();
    for (const d of cfg.deviceList.DevicesWithFeatures) {
      if ((d.Device ?? d).Transport === 32) (d.Device ?? d).IsKeyboardAssociated = false;
    }
    const firstId = cfg.activityList.Activities[0]["Id-"];
    const sc = cfg.mapList.ButtonMaps.find(
      (m) => m.ButtonMapIdentifier === `16414Activity${firstId}`,
    );
    sc["RemoteId-"] = null;
    sc["SurfaceId-"] = null;
    sc["ButtonMapSurfaceId-"] = null;

    // Also inject a broken map with no remote prefix and null surface ids on one activity:
    // repairGraph must not treat "" as a surface key and clone it into every other activity.
    const api = createEditor(cfg);
    api.reconcileActivityMaps();
    assert.doesNotThrow(() => api.validateGraph());
    const healedSc = api.state.config.mapList.ButtonMaps.find(
      (m) => m.ButtonMapIdentifier === `16414Activity${firstId}`,
    );
    assert.equal(healedSc["RemoteId-"], 12345678);
    assert.equal(healedSc["SurfaceId-"], 13151460);
    assert.equal(healedSc["ButtonMapSurfaceId-"], 13151460);

    const { next, summary } = repairGraph(cfg);
    const repairedSc = next.mapList.ButtonMaps.find(
      (m) => m.ButtonMapIdentifier === `16414Activity${firstId}`,
    );
    assert.equal(repairedSc["RemoteId-"], 12345678);
    assert.equal(repairedSc["SurfaceId-"], 13151460);
    assert.equal(repairedSc["ButtonMapSurfaceId-"], 13151460);
    assert.equal(summary.createdActivityMaps.length, 0);

    // Soundness check: repairGraph still allocates missing ButtonMapId-/ButtonId and fixes ButtonState.
    repairedSc["ButtonMapId-"] = 0;
    repairedSc.Buttons[0].ButtonId = 0;
    repairedSc.Buttons[0].ButtonState = 0;
    const { next: next2, summary: summary2 } = repairGraph(next);
    const totals = identityTotals(summary2.identityRepairs);
    assert.equal(totals.allocatedMapIds, 1);
    assert.equal(totals.allocatedButtonIds, 1);
    assert.equal(totals.buttonStateCorrections, 1);
    const fixedSc = next2.mapList.ButtonMaps.find(
      (m) => m.ButtonMapIdentifier === `16414Activity${firstId}`,
    );
    assert.ok(fixedSc["ButtonMapId-"] > 52944089);
    assert.ok(fixedSc.Buttons[0].ButtonId > 1878029713);
    assert.equal(fixedSc.Buttons[0].ButtonState, 1);
  });
});
