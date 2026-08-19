import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseManifest,
  buildInventory,
  checkDrift,
} from "../../payload_bin_inventory.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const MANIFEST = readFileSync(join(ROOT, "payload/bin/MANIFEST.txt"), "utf8");

describe("payload_bin_inventory", () => {
  it("parses MANIFEST and includes pair agent in update+install", () => {
    const inv = buildInventory(MANIFEST);
    assert.ok(inv.install.includes("codex_bt_pair_agent"));
    assert.ok(inv.update.includes("codex_bt_pair_agent"));
    assert.ok(inv.install.includes("dropbearmulti"));
    assert.equal(inv.update.includes("dropbearmulti"), false);
    assert.ok(inv.restart.includes("codex_bt_pair_agent"));
  });

  it("parseManifest ignores garbage lines", () => {
    const entries = parseManifest("not-a-line\nabc\n" + MANIFEST);
    assert.ok(entries.length >= 7);
  });

  it("checkDrift passes on the live tree", () => {
    const result = checkDrift();
    assert.equal(result.ok, true, result.problems.join("; "));
  });
});
