import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commandsPanelShouldOpen } from "../public/js/views/control-panel-state.js";
import { checkShippedCopyHygiene, deriveForbiddenTokens } from "../../shipped_copy_hygiene.mjs";

describe("commandsPanelShouldOpen", () => {
  it("honors explicit hhc.commands preference", () => {
    assert.equal(
      commandsPanelShouldOpen({ mode: "activities", commandsPref: "open", legacyInspectorPref: null }),
      true,
    );
    assert.equal(
      commandsPanelShouldOpen({ mode: "devices", commandsPref: "closed", legacyInspectorPref: "open" }),
      false,
    );
  });

  it("migrates legacy inspector=open to open", () => {
    assert.equal(
      commandsPanelShouldOpen({ mode: "activities", commandsPref: null, legacyInspectorPref: "open" }),
      true,
    );
  });

  it("defaults Devices open and Activities closed when unset", () => {
    assert.equal(
      commandsPanelShouldOpen({ mode: "devices", commandsPref: null, legacyInspectorPref: null }),
      true,
    );
    assert.equal(
      commandsPanelShouldOpen({ mode: "activities", commandsPref: null, legacyInspectorPref: null }),
      false,
    );
    assert.equal(
      commandsPanelShouldOpen({ mode: "activities", commandsPref: null, legacyInspectorPref: "closed" }),
      false,
    );
  });
});

describe("shipped_copy_hygiene", () => {
  it("derives fixture ids and personal names, not command words", () => {
    const tokens = deriveForbiddenTokens();
    assert.ok(tokens.ids.includes("66690268"));
    assert.ok(tokens.names.includes("Heather's PC"));
    assert.ok(tokens.names.includes("OLED65C8PUA"));
    assert.equal(tokens.names.includes("Play"), false);
    assert.ok(tokens.allowlist.some((a) => a.phrase === "SHIELD"));
  });

  it("passes on the current tree", () => {
    const result = checkShippedCopyHygiene();
    assert.equal(result.ok, true, result.problems.map((p) => `${p.file}:${p.token}`).join("; "));
  });
});
