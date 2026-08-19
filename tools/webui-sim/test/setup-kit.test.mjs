import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDangerGuardState, escapeHtml } from "../public/js/setup-kit.js";

describe("createDangerGuardState", () => {
  it("starts unarmed", () => {
    const state = createDangerGuardState();
    assert.equal(state.armed, false);
  });

  it("arms then confirms without a typed phrase", () => {
    const state = createDangerGuardState();
    state.arm();
    assert.equal(state.armed, true);
    const result = state.attemptConfirm();
    assert.equal(result.confirmed, true);
    assert.equal(state.armed, false);
  });

  it("ignores a confirm attempt while unarmed", () => {
    const state = createDangerGuardState();
    const result = state.attemptConfirm();
    assert.equal(result.confirmed, false);
    assert.equal(state.armed, false);
  });

  it("rejects a wrong typed phrase and stays armed", () => {
    const state = createDangerGuardState({ typedPhrase: "REBOOT" });
    state.arm();
    const result = state.attemptConfirm("reboot"); // case-sensitive mismatch
    assert.equal(result.confirmed, false);
    assert.equal(result.mismatch, true);
    assert.equal(state.armed, true);
  });

  it("confirms on the exact typed phrase, trimming whitespace", () => {
    const state = createDangerGuardState({ typedPhrase: "REBOOT" });
    state.arm();
    const result = state.attemptConfirm("  REBOOT  ");
    assert.equal(result.confirmed, true);
    assert.equal(result.mismatch, false);
    assert.equal(state.armed, false);
  });

  it("treats a missing typed value as a mismatch when a phrase is required", () => {
    const state = createDangerGuardState({ typedPhrase: "REBOOT" });
    state.arm();
    assert.equal(state.attemptConfirm(undefined).confirmed, false);
    assert.equal(state.armed, true);
  });

  it("disarm resets an armed guard", () => {
    const state = createDangerGuardState();
    state.arm();
    state.disarm();
    assert.equal(state.armed, false);
    assert.equal(state.attemptConfirm().confirmed, false);
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
  });

  it("renders an XSS payload as inert text, not markup", () => {
    const payload = `<img src=x onerror=alert(1)>`;
    const out = escapeHtml(payload);
    assert.ok(!out.includes("<img"), `escaped output must not contain a live tag: ${out}`);
    assert.ok(!out.includes(">"), `escaped output must not contain a raw gt that could close a tag: ${out}`);
    assert.equal(out, "&lt;img src=x onerror=alert(1)&gt;");
  });

  it("coerces null and undefined to an empty string", () => {
    assert.equal(escapeHtml(null), "");
    assert.equal(escapeHtml(undefined), "");
  });

  it("stringifies non-string values", () => {
    assert.equal(escapeHtml(42), "42");
    assert.equal(escapeHtml(0), "0");
    assert.equal(escapeHtml(true), "true");
  });

  it("leaves safe text unchanged", () => {
    assert.equal(escapeHtml("Movie night"), "Movie night");
    assert.equal(escapeHtml(""), "");
  });

  it("escapes a quote so it cannot break out of a double-quoted attribute", () => {
    const out = escapeHtml(`" onmouseover="alert(1)`);
    assert.equal(out, "&quot; onmouseover=&quot;alert(1)");
    assert.ok(!out.includes('"'), `no raw double-quote may remain: ${out}`);
  });
});
