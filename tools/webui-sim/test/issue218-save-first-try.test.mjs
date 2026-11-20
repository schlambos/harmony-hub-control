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

  it("saveMapList checks baseline BEFORE the first POST when a digest refresh brought a conflicting edit (another tab / Android)", async () => {
    const configAtOpen = { ...loadFixture(), revision: "rev-1" };
    const {
      SMART_CONTROL_EQUAD,
      activityButtonsSaveOutcome,
      buildActivityButtonsMapList,
      readActivityButtons,
    } = await import("../public/js/views/remotes-model.js");
    const baseRows = readActivityButtons(configAtOpen, SMART_CONTROL_EQUAD).rows;
    const editedRows = structuredClone(baseRows);
    // Edit Music locally, while another tab/Android changes Watch TV in the refreshed config.
    const musicRow = editedRows.find((r) => r.key === "Music") ?? editedRows[1];
    const tvRow = editedRows.find((r) => r.key === "Movie" || r.key === "WatchTV") ?? editedRows[0];
    const otherActId = String(configAtOpen.activityList.Activities[configAtOpen.activityList.Activities.length - 1]["Id-"]);
    musicRow.press = otherActId;

    // Refreshed config at rev-2 has another client's edit on tvRow!
    const refreshedConfig = { ...loadFixture(), revision: "rev-2" };
    const rootMap = refreshedConfig.mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === "16414Root");
    const tvBtn = rootMap.Buttons.find((b) => b.ButtonKey === tvRow.key);
    assert.ok(tvBtn?.ButtonAction, "fixture must have a root activity button action");
    const originalTvId = tvBtn.ButtonAction["ActivityId-"];
    const changedTvId = originalTvId + 6;
    tvBtn.ButtonAction["ActivityId-"] = changedTvId;

    const posts = [];
    const prevDoc = globalThis.document;
    globalThis.document = { getElementById: () => null };
    globalThis.fetch = async (path, opts) => {
      if (path === "/api/activity-config") {
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, ...refreshedConfig }) };
      }
      if (path === "/api/activity-save") {
        posts.push(JSON.parse(opts.body));
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, saved: true, revision: "rev-3" }) };
      }
      throw new Error(`unexpected fetch ${path}`);
    };
    try {
      const hub = await import("../public/js/state.js");
      const { saveMapList } = await import("../public/js/views/map-save.js");
      await hub.reloadConfig();
      assert.equal(hub.state.config.revision, "rev-2");
      const built = buildActivityButtonsMapList(hub.state.config, editedRows, SMART_CONTROL_EQUAD);
      const result = await saveMapList(built.mapList, {
        done: "Saved.",
        check: (cfg) => activityButtonsSaveOutcome(cfg, baseRows, editedRows, SMART_CONTROL_EQUAD),
        rebuild: (cfg) => buildActivityButtonsMapList(cfg, editedRows, SMART_CONTROL_EQUAD).mapList,
      });
      assert.equal(result, "replaced", "conflicting refresh before first POST must refuse and return replaced");
      assert.equal(posts.length, 0, "must NOT send a POST that would overwrite another client's button assignment");
    } finally {
      globalThis.document = prevDoc;
    }
  });

  it("saveTouchWithRebase checks baseline BEFORE the first POST when config already refreshed with a conflict", async () => {
    const cfg1 = { ...loadFixture(), revision: "rev-1" };
    const activityId = String(cfg1.activityList.Activities[0]["Id-"]);
    const base = touchModel.readTouchScreen(cfg1, activityId).base;
    // Simulate a background digest refresh bringing another client's change to the same screen.
    const cfg2 = { ...loadFixture(), revision: "rev-2" };
    const touchMap = cfg2.mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === `16417Activity${activityId}`);
    assert.ok(touchMap, "fixture must have a Touch map");
    touchMap.Buttons.push({
      __type: "SoftButton",
      ButtonId: 9999991,
      ButtonKey: "OtherClientBtn",
      IndexInMenu: 99,
      ButtonAction: { __type: "ButtonCommandAction", "DeviceId-": 1, CommandName: "PowerToggle" },
    });
    const sent = [];
    await assert.rejects(
      touchModel.saveTouchWithRebase({
        getConfig: () => cfg2,
        reloadConfig: async () => {},
        buildPayload: (cfg) => ({
          baseRevision: cfg.revision,
          activityList: cfg.activityList,
          mapList: cfg1.mapList,
          functionList: cfg.functionList,
        }),
        activityId,
        base,
        saveFn: async (p) => { sent.push(p); return { ok: true }; },
      }),
      (err) => err.status === 409,
    );
    assert.equal(sent.length, 0, "must NOT send first POST when target screen already changed in refreshed config");
  });

  it("wizard conflict catch does not silently replace baseSnapshot onto a stale draft", () => {
    const wizardSrc = readPublic("js/views/wizard.js");
    const catchIdx = wizardSrc.indexOf("} catch (error) {");
    assert.ok(catchIdx > 0, "wizard.js save() must have catch block");
    const catchBlock = wizardSrc.slice(catchIdx, wizardSrc.indexOf("} finally {", catchIdx));
    assert.doesNotMatch(catchBlock, /baseSnapshot\s*=/,
      "wizard.js catch must not overwrite baseSnapshot with the conflicting hub copy while keeping the stale draft");
  });

  it("hub writer serializes compare-and-commit under lock and rejects stale CommitActivityResources without writing or rolling back", async () => {
    const { execFileSync } = await import("node:child_process");
    const cSrc = readFileSync(new URL("../../../payload/source/codex_webui.c", import.meta.url), "utf8");
    const handleStart = cSrc.indexOf("static void render_activity_save_json(");
    const handleEnd = cSrc.indexOf("\nstatic ", handleStart + 40);
    const handleSrc = cSrc.slice(handleStart, handleEnd);
    const lockPos = handleSrc.indexOf("offline_writer_lock()");
    const readPos = handleSrc.indexOf("read_file_alloc(ACTIVITY_LIST");
    assert.ok(lockPos > 0 && readPos > 0 && lockPos < readPos,
      "render_activity_save_json must acquire offline_writer_lock() BEFORE reading ActivityList/MapList/FunctionList");
    assert.match(cSrc, /"baseRevision"/, "CommitActivityResources must carry baseRevision to codexactivity.lua");

    // Exercise codexactivity.lua's real CommitActivityResources with a stale baseRevision
    // (simulating an intervening HA device push / Android save / second tab).
    const luaSrc = readFileSync(new URL("../../../payload/activity/codexactivity.lua", import.meta.url), "utf8");
    assert.match(luaSrc, /request\.baseRevision/, "codexactivity.lua must verify request.baseRevision before saving");
    const out = execFileSync("luajit", ["-e", `
      local luaPath = ${JSON.stringify(new URL("../../../payload/activity/codexactivity.lua", import.meta.url).pathname)}
      local src = assert(io.open(luaPath, "r")):read("*a")
      -- Extract fnv1a32 check via a minimal stubbed load of codexactivity.lua
      local act = '{"Activities":[]}'
      local map1 = '{"ButtonMaps":[{"ButtonMapIdentifier":"16414Root","Buttons":[]}]}'
      local map2 = '{"ButtonMaps":[{"ButtonMapIdentifier":"16414Root","Buttons":[{"ButtonKey":"HA"}]}]}'
      local fn = '{"FunctionMaps":[]}'
      local files = {
        ["/data/codex/cloud_blocker.conf"] = "1",
        ["/data/resources/ActivityList.json"] = act,
        ["/data/resources/MapList.json"] = map1,
        ["/data/resources/FunctionList.json"] = fn,
      }
      local saves = 0
      local realIoOpen = io.open
      io.open = function(p, m)
        if files[p] ~= nil then
          return { read = function() return files[p] end, close = function() end }
        end
        return realIoOpen(p, m)
      end
      package.preload["system"] = function() return {
        isMessageRegistered = function() return true end,
        sendMessage = function() return true end,
      } end
      package.preload["json"] = function() return {
        decode = function(s) return { Activities = {}, ButtonMaps = {}, FunctionMaps = {}, DevicesWithFeatures = {} } end,
        encode = function() return "{}" end,
      } end
      package.preload["log"] = function() return { logger = function() return { notice = function() end, error = function() end, warning = function() end } end } end
      package.preload["tasks.harmonywebservices.core.resourcemanager"] = function() return {
        getResource = function(name) return "200", '"e1"', { Activities = {}, ButtonMaps = {}, FunctionMaps = {}, DevicesWithFeatures = {} } end,
        getHubEtag = function() return "1" end,
        isAnySyncInProgress = function() return false end,
        saveResource = function() saves = saves + 1; return true end,
      } end
      package.preload["tasks.harmonywebservices.core.statedigest"] = function() return { instance = function() return { configVersion = 1, saveStateDigest = function() end } end } end
      package.preload["tasks.connectserver.core.utils"] = function() return { createResponse = function() return {} end } end
      local fn_chunk = assert(loadstring(src:gsub("local function commitActivityResources", "function commitActivityResources"):gsub("local function currentActivityRevision", "function currentActivityRevision")))
      fn_chunk("codexactivity")
      local rev1 = _G.codexactivity.currentActivityRevision()
      -- Simulate intervening HA/Android/tab write updating MapList.json on disk:
      files["/data/resources/MapList.json"] = map2
      local rev2 = _G.codexactivity.currentActivityRevision()
      assert(rev1 and rev2 and rev1 ~= rev2, "revisions must differ after MapList change")
      local res = _G.codexactivity.commitActivityResources({
        baseRevision = rev1,
        activityList = { Activities = {} },
        mapList = { ButtonMaps = {} },
        functionList = { FunctionMaps = {} },
      })
      assert(res.ok == false and res.conflict == true and res.revision == rev2, "expected conflict response")
      assert(saves == 0, "stale commit must not write or roll back newer state")
      assert(files["/data/resources/MapList.json"] == map2, "newer MapList must remain untouched")
      print("CONFLICT_OK " .. rev1 .. " -> " .. rev2)
    `], { encoding: "utf8" });
    assert.match(out, /CONFLICT_OK /);
  });
});
