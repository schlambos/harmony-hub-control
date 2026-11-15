import { describe, it } from "node:test";
import assert from "node:assert/strict";

const calls = [];
let runResponse;

globalThis.fetch = async (path, options = {}) => {
  calls.push({ path, options });
  if (path === "/api/activity-run") {
    return {
      ok: runResponse.status >= 200 && runResponse.status < 300,
      status: runResponse.status,
      text: async () => JSON.stringify(runResponse.body),
    };
  }
  assert.equal(path, "/api/activity-state");
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      ok: true,
      reply: JSON.stringify({ code: 200, data: { result: "-1" } }),
    }),
  };
};

const hub = await import("../public/js/state.js");

describe("activity start failures", () => {
  it("records 502 / ok:false in runError and never marks the target running", async () => {
    for (const status of [502, 200]) {
      calls.length = 0;
      hub.state.currentId = "";
      hub.state.pendingId = "";
      hub.state.runError = null;
      hub.state.stateError = null;
      runResponse = {
        status,
        body: {
          ok: false,
          error: "Account config data is not available",
          activityId: "100",
          reply: JSON.stringify({ code: 560, msg: "Account config data is not available" }),
        },
      };

      await hub.setRunning("100");

      assert.equal(hub.state.currentId, "-1", `HTTP ${status}: refresh keeps the real state`);
      assert.equal(hub.state.pendingId, "", `HTTP ${status}: no pending start remains`);
      assert.equal(hub.state.runError?.status, status);
      assert.equal(hub.state.runError?.message, "Account config data is not available");
      assert.equal(calls[0].path, "/api/activity-run");
      assert.equal(calls[0].options.method, "POST");
      assert.match(calls[0].options.body, /activityId=100/);
    }
  });
});
