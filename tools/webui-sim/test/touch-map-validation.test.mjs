import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { validateMapList } from "../public/js/views/remote-model.js";

const fixtures = JSON.parse(
  readFileSync(new URL("../fixtures/touch-maplist.json", import.meta.url), "utf8"),
);
const liveConfig = JSON.parse(
  readFileSync(new URL("../fixtures/activity-config.json", import.meta.url), "utf8"),
);

describe("validateMapList (web mirror of the hub validator)", () => {
  for (const testCase of fixtures.cases) {
    it(`${testCase.expect}: ${testCase.name}`, () => {
      const errors = validateMapList(testCase.graph.mapList);
      if (testCase.expect === "valid") {
        assert.deepEqual(errors, [], testCase.name);
      } else {
        assert.ok(
          errors.some((e) => e.includes(testCase.errorIncludes)),
          `${testCase.name}: expected an error containing ${JSON.stringify(testCase.errorIncludes)}, got ${JSON.stringify(errors)}`,
        );
      }
    });
  }

  it("accepts the fixture hub config, including its device-screen slot clash", () => {
    // The fixture's device map has two soft buttons at IndexInMenu 3 in
    // different function groups. Device maps keep their existing slots
    // until the device screen editor sets their rule, so this is valid.
    assert.deepEqual(validateMapList(liveConfig.mapList), []);
  });

  it("rejects a MapList without a ButtonMaps array", () => {
    assert.deepEqual(validateMapList(null), ["MapList.ButtonMaps must be an array"]);
    assert.deepEqual(validateMapList({}), ["MapList.ButtonMaps must be an array"]);
  });
});

describe("codexactivity.lua validateGraph (LuaJIT)", () => {
  it("validates every fixture case the same way", (t) => {
    const probe = spawnSync("luajit", ["-v"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      t.skip("luajit is not available");
      return;
    }
    const repoRoot = new URL("../../../", import.meta.url);
    const out = execFileSync(
      "luajit",
      [
        "tools/touch-validator/codexactivity-validate-test.lua",
        "tools/webui-sim/fixtures/touch-maplist.json",
      ],
      { cwd: repoRoot.pathname, encoding: "utf8" },
    );
    assert.match(out, /18\/18 cases passed/);
  });

  it("ends its engine wait in time for codex_webui's transaction limit", (t) => {
    const probe = spawnSync("luajit", ["-v"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      t.skip("luajit is not available");
      return;
    }
    const out = execFileSync("luajit", ["tools/touch-validator/codexactivity-barrier-test.lua"], {
      cwd: new URL("../../../", import.meta.url).pathname,
      encoding: "utf8",
    });
    assert.match(out, /5\/5 checks passed/);
  });

  it("builds, rebuilds and removes Touch device screens, and keeps Home Assistant devices' screens", (t) => {
    const probe = spawnSync("luajit", ["-v"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      t.skip("luajit is not available");
      return;
    }
    const out = execFileSync("luajit", ["tools/touch-validator/codexactivity-device-screens-test.lua"], {
      cwd: new URL("../../../", import.meta.url).pathname,
      encoding: "utf8",
    });
    assert.match(out, /34\/34 checks passed/);
  });

  it("gives one-shot device screens self-long and simulates Touch gestures (P11/P18)", (t) => {
    const probe = spawnSync("luajit", ["-v"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      t.skip("luajit is not available");
      return;
    }
    const out = execFileSync("luajit", ["tools/touch-validator/codexactivity-touch-controls-test.lua"], {
      cwd: new URL("../../../", import.meta.url).pathname,
      encoding: "utf8",
    });
    assert.match(out, /18\/18 checks passed/);
  });
});

describe("netservicestarter.lua Touch Sync guards (LuaJIT)", () => {
  it("answers the time offline, leaves the firmware check to stock, serves missing device content, and defers otherwise", (t) => {
    const probe = spawnSync("luajit", ["-v"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      t.skip("luajit is not available");
      return;
    }
    const out = execFileSync("luajit", ["tools/touch-validator/netservicestarter-guards-test.lua"], {
      cwd: new URL("../../../", import.meta.url).pathname,
      encoding: "utf8",
    });
    assert.match(out, /12\/12 checks passed/);
  });
});
