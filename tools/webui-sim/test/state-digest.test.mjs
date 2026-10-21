import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractStateVersion } from "../public/js/state.js";

describe("extractStateVersion", () => {
  it("reads stateVersion from a plain digest reply", () => {
    assert.equal(
      extractStateVersion('{"code":200,"data":{"stateVersion":12345,"activityId":"-1"}}'),
      "12345",
    );
  });

  it("reads stateVersion when the engine body is escaped/nested", () => {
    assert.equal(
      extractStateVersion('{"code":200,"msg":"{\\"stateVersion\\":67890,\\"activityStatus\\":2}"}'),
      "67890",
    );
  });

  it("reads a string-valued stateVersion", () => {
    assert.equal(extractStateVersion('{"stateVersion":"42"}'), "42");
  });

  it("preserves large version numbers as strings (no integer truncation)", () => {
    assert.equal(
      extractStateVersion('{"stateVersion":4294967295}'),
      "4294967295",
    );
  });

  it("returns null for an unchanged (304) reply with no digest", () => {
    assert.equal(extractStateVersion('{"code":304}'), null);
  });

  it("returns null for empty / missing input", () => {
    assert.equal(extractStateVersion(null), null);
    assert.equal(extractStateVersion(undefined), null);
    assert.equal(extractStateVersion(""), null);
  });

  it("accepts an already-parsed object", () => {
    assert.equal(
      extractStateVersion({ code: 200, data: { stateVersion: 7 } }),
      "7",
    );
  });
});
