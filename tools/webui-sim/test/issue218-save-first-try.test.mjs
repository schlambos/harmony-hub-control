import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as wizardModel from "../public/js/wizard-model.js";
import * as touchModel from "../public/js/views/touch-model.js";

const readPublic = (rel) => readFileSync(new URL(`../public/${rel}`, import.meta.url), "utf8");

function loadFixture() {
  const raw = JSON.parse(readFileSync(new URL("../fixtures/activity-config.json", import.meta.url), "utf8"));
  const ids = new Set(raw.activityList.Activities.map((a) => String(a["Id-"])));
  raw.mapList.ButtonMaps = raw.mapList.ButtonMaps.filter((m) => m["ActivityId-"] == null || ids.has(String(m["ActivityId-"])));
  raw.functionList = {
    FunctionMaps: [...ids].map((id) => ({ __type: "ActivityFunctionMap", "ActivityId-": Number(id), FunctionGroups: [] })),
  };
  return raw;
}

describe("issue #218: first Save commits cleanly after unrelated hub revision drift", () => {
  it("state.js tracks configVersion in pollStateDigest and exposes ensureFreshConfig", async () => {
    const requests = [];
    let hubRevision = "rev-1";
    let digestReply = '{"code":200,"data":{"stateVersion":10,"configVersion":1,"activityId":"-1"}}';
    globalThis.fetch = async (path) => {
      requests.push(path);
      if (path === "/api/activity-config") {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            ok: true,
            revision: hubRevision,
            activityList: { Activities: [] },
            mapList: { ButtonMaps: [] },
            functionList: { FunctionMaps: [] },
            deviceList: { DevicesWithFeatures: [] },
          }),
        };
      }
      if (path.startsWith("/api/state")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, changed: true, reply: digestReply }),
        };
      }
      if (path === "/api/activity-state") {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, reply: '{"result":"-1"}' }),
        };
      }
      throw new Error(`unexpected fetch ${path}`);
    };

    const hub = await import(`../public/js/state.js?issue218=${Date.now()}`);
    assert.equal(typeof hub.extractConfigVersion, "function", "extractConfigVersion must be exported from state.js");
    assert.equal(typeof hub.ensureFreshConfig, "function", "ensureFreshConfig must be exported from state.js");

    assert.equal(hub.extractConfigVersion('{"code":200,"msg":"{\\"stateVersion\\":7,\\"configVersion\\":42}"}'), "42");
    assert.equal(hub.extractConfigVersion('{"code":304}'), null);

    await hub.ensureConfig();
    assert.equal(hub.state.config.revision, "rev-1");

    // First poll records configVersion=1 without triggering a redundant config GET.
    requests.length = 0;
    await hub.pollStateDigest();
    assert.equal(requests.filter((p) => p === "/api/activity-config").length, 0);

    // State-only change (stateVersion 10 -> 11, configVersion still 1): no config GET.
    digestReply = '{"code":200,"data":{"stateVersion":11,"configVersion":1,"activityId":"123"}}';
    requests.length = 0;
    await hub.pollStateDigest();
    assert.equal(requests.filter((p) => p === "/api/activity-config").length, 0);

    // Unrelated config change on the hub (e.g. HA push bumps configVersion 1 -> 2):
    // pollStateDigest refreshes hub.state.config so editors see rev-2.
    hubRevision = "rev-2";
    digestReply = '{"code":200,"data":{"stateVersion":12,"configVersion":2,"activityId":"123"}}';
    await hub.pollStateDigest();
    // Allow background refreshConfig microtask to finish.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(hub.state.config.revision, "rev-2");

    // ensureFreshConfig always fetches the latest revision when already loaded.
    hubRevision = "rev-3";
    await hub.ensureFreshConfig();
    assert.equal(hub.state.config.revision, "rev-3");
  });

  it("wizard saveDraftWithRebase retries once on a non-conflicting 409 and preserves unrelated hub changes", async () => {
    assert.equal(typeof wizardModel.activitySnapshot, "function", "activitySnapshot must be exported");
    assert.equal(typeof wizardModel.saveDraftWithRebase, "function", "saveDraftWithRebase must be exported");

    const rev1 = loadFixture();
    rev1.revision = "rev-1";
    const act = rev1.activityList.Activities[0];
    const editId = String(act["Id-"]);
    const baseSnapshot = wizardModel.activitySnapshot(rev1, editId);

    // Hub moved to rev-2 because an unrelated HA device map was added to MapList.
    const rev2 = structuredClone(rev1);
    rev2.revision = "rev-2";
    rev2.mapList.ButtonMaps.push({
      ButtonMapId: 99999901,
      ButtonMapIdentifier: "16417Device999999",
      "DeviceId-": 999999,
      __type: "DeviceButtonMap",
      Buttons: [],
    });

    let currentConfig = rev1;
    const attempts = [];
    const draft = {
      name: `${act.Name} Edited`,
      type: Number(act.Type ?? 1),
      roles: (act.Roles ?? []).map((r) => ({
        deviceId: String(r["DeviceId-"]),
        roleType: String(r.__type),
        input: r.SelectedInput?.Name ?? "",
        powerDelay: r.NextDevicePowerOnDelay ?? "",
      })),
      buttons: {},
    };

    const outcome = await wizardModel.saveDraftWithRebase({
      getConfig: () => currentConfig,
      reloadConfig: async () => { currentConfig = rev2; },
      draft,
      editId,
      remotes: [],
      baseSnapshot,
      saveFn: async (payload) => {
        attempts.push(payload.baseRevision);
        if (payload.baseRevision !== "rev-2") {
          const err = new Error("activity resources changed since this editor loaded");
          err.status = 409;
          throw err;
        }
        // Unrelated map added in rev-2 must survive in the rebased payload!
        assert.ok(
          payload.mapList.ButtonMaps.some((m) => m.ButtonMapIdentifier === "16417Device999999"),
          "rebased save must preserve unrelated maps from rev-2",
        );
        return { ok: true, saved: true, revision: "rev-3" };
      },
    });

    assert.deepEqual(attempts, ["rev-1", "rev-2"]);
    assert.equal(outcome.name, `${act.Name} Edited`);
  });

  it("wizard saveDraftWithRebase refuses to overwrite when the same activity actually changed on the hub", async () => {
    assert.equal(typeof wizardModel.saveDraftWithRebase, "function");
    const rev1 = loadFixture();
    rev1.revision = "rev-1";
    const act = rev1.activityList.Activities[0];
    const editId = String(act["Id-"]);
    const baseSnapshot = wizardModel.activitySnapshot(rev1, editId);

    const rev2 = structuredClone(rev1);
    rev2.revision = "rev-2";
    rev2.activityList.Activities[0].Name = "Edited Elsewhere";

    let currentConfig = rev1;
    const attempts = [];
    const draft = {
      name: "My Edit",
      type: Number(act.Type ?? 1),
      roles: (act.Roles ?? []).map((r) => ({
        deviceId: String(r["DeviceId-"]),
        roleType: String(r.__type),
        input: r.SelectedInput?.Name ?? "",
        powerDelay: r.NextDevicePowerOnDelay ?? "",
      })),
      buttons: {},
    };

    await assert.rejects(
      () => wizardModel.saveDraftWithRebase({
        getConfig: () => currentConfig,
        reloadConfig: async () => { currentConfig = rev2; },
        draft,
        editId,
        remotes: [],
        baseSnapshot,
        saveFn: async (payload) => {
          attempts.push(payload.baseRevision);
          const err = new Error("activity resources changed since this editor loaded");
          err.status = 409;
          throw err;
        },
      }),
      (err) => err.status === 409,
    );
    assert.deepEqual(attempts, ["rev-1"], "must not retry and clobber a real conflict on the same activity");
  });

  it("touch-model saveTouchWithRebase retries once on a non-conflicting 409 and refuses a real conflict", async () => {
    assert.equal(typeof touchModel.saveTouchWithRebase, "function", "saveTouchWithRebase must be exported");

    const rev1 = loadFixture();
    rev1.revision = "rev-1";
    const isSoft = (b) => b.__type === "SoftRemoteButton" && b.FunctionGroupType !== 2;
    const activityId = String(rev1.activityList.Activities.map((a) => a["Id-"]).find((id) => {
      const m = rev1.mapList.ButtonMaps.find((x) => x.ButtonMapIdentifier === `16417Activity${id}`);
      return m?.Buttons.some(isSoft);
    }));
    const soft0 = touchModel.readTouchScreen(rev1, activityId);
    const row = soft0.rows.find((r) => !r.locked);
    const softEdited = touchModel.setLabel(soft0, row.key, "Renamed Button");
    const hardRows = touchModel.readHardKeys(rev1, activityId).rows;
    const gestureRows = touchModel.readGestures(rev1, activityId).rows;

    const buildPayload = (cfg) => ({
      baseRevision: cfg.revision,
      activityList: structuredClone(cfg.activityList),
      mapList: touchModel.buildTouchControlsMapList(cfg, {
        soft: softEdited,
        hard: { rows: hardRows },
        gestures: { rows: gestureRows },
      }),
      functionList: structuredClone(cfg.functionList),
    });

    // Unrelated map change on hub (rev-2): same activity's screen is unchanged.
    const rev2 = structuredClone(rev1);
    rev2.revision = "rev-2";
    rev2.mapList.ButtonMaps.push({
      ButtonMapId: 99999902,
      ButtonMapIdentifier: "16417Device999998",
      "DeviceId-": 999998,
      __type: "DeviceButtonMap",
      Buttons: [],
    });

    let currentConfig = rev1;
    const attempts = [];
    const res = await touchModel.saveTouchWithRebase({
      getConfig: () => currentConfig,
      reloadConfig: async () => { currentConfig = rev2; },
      buildPayload,
      activityId,
      base: softEdited.base,
      remote: touchModel.TOUCH_REMOTE,
      twins: [],
      saveFn: async (payload) => {
        attempts.push(payload.baseRevision);
        if (payload.baseRevision !== "rev-2") {
          const err = new Error("activity resources changed since this editor loaded");
          err.status = 409;
          throw err;
        }
        return { ok: true, saved: true, revision: "rev-3" };
      },
    });
    assert.deepEqual(attempts, ["rev-1", "rev-2"]);
    assert.equal(res.rebased, true);

    // Real conflict: this activity's own screen changed on hub (rev-conflict).
    const revConflict = structuredClone(rev1);
    revConflict.revision = "rev-conflict";
    const m = revConflict.mapList.ButtonMaps.find((x) => x.ButtonMapIdentifier === `16417Activity${activityId}`);
    m.Buttons.find(isSoft).TextOnRemote = "Edited Elsewhere";

    currentConfig = rev1;
    const conflictAttempts = [];
    await assert.rejects(
      () => touchModel.saveTouchWithRebase({
        getConfig: () => currentConfig,
        reloadConfig: async () => { currentConfig = revConflict; },
        buildPayload,
        activityId,
        base: softEdited.base,
        remote: touchModel.TOUCH_REMOTE,
        twins: [],
        saveFn: async (payload) => {
          conflictAttempts.push(payload.baseRevision);
          const err = new Error("activity resources changed since this editor loaded");
          err.status = 409;
          throw err;
        },
      }),
      (err) => err.status === 409,
    );
    assert.deepEqual(conflictAttempts, ["rev-1"]);
  });

  it("map-save saveMapList retries once on a non-conflicting 409 via rebuild and returns saved", async () => {
    let hubRevision = "rev-1";
    const postRevisions = [];
    const prevDoc = globalThis.document;
    globalThis.document = { getElementById: () => null };
    globalThis.fetch = async (path, opts) => {
      if (path === "/api/activity-config") {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            ok: true,
            revision: hubRevision,
            activityList: { Activities: [] },
            mapList: { ButtonMaps: [{ ButtonMapIdentifier: "16422Root", Buttons: [] }] },
            functionList: { FunctionMaps: [] },
            deviceList: { DevicesWithFeatures: [] },
          }),
        };
      }
      if (path === "/api/activity-save") {
        const body = JSON.parse(opts.body);
        postRevisions.push(body.baseRevision);
        if (body.baseRevision !== "rev-2") {
          return {
            ok: false,
            status: 409,
            text: async () => JSON.stringify({ ok: false, error: "activity resources changed since this editor loaded", revision: "rev-2" }),
          };
        }
        hubRevision = "rev-3";
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, saved: true, revision: "rev-3" }),
        };
      }
      throw new Error(`unexpected fetch ${path}`);
    };
    try {
      const hub = await import("../public/js/state.js");
      const { saveMapList } = await import("../public/js/views/map-save.js");
      await hub.reloadConfig();
      assert.equal(hub.state.config.revision, "rev-1");
      // Hub advances to rev-2 while editor holds rev-1.
      hubRevision = "rev-2";
      const result = await saveMapList(
        { ButtonMaps: [{ ButtonMapIdentifier: "16422Root", Buttons: [{ ButtonKey: "Ha1" }] }] },
        {
          done: "Saved.",
          check: () => "unchanged",
          rebuild: (cfg) => ({
            ButtonMaps: [...cfg.mapList.ButtonMaps, { ButtonMapIdentifier: "rebuilt", rev: cfg.revision }],
          }),
        },
      );
      assert.equal(result, "saved");
      assert.deepEqual(postRevisions, ["rev-1", "rev-2"]);
      assert.equal(hub.state.config.revision, "rev-3");
    } finally {
      globalThis.document = prevDoc;
    }
  });

  it("editor views refresh config on entry / exit from Advanced editor", () => {
    for (const file of [
      "js/views/wizard.js",
      "js/views/touch-screen.js",
      "js/views/home-buttons.js",
      "js/views/activity-buttons.js",
    ]) {
      const src = readPublic(file);
      assert.match(src, /ensureFreshConfig\(/, `${file} should call hub.ensureFreshConfig() on show`);
    }
    const adv = readPublic("js/views/activities.js");
    assert.match(adv, /refreshConfig\(/, "activities.js should refresh hub config when leaving the Advanced editor");
  });
});
