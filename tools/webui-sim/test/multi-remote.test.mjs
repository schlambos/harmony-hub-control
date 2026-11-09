import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* Multiple remotes of one model (docs/MULTI_REMOTE.md): the hal edits live in
   payload/helpers/hal_multiremote_patch.json (read by both installers) and
   again in codex_webui.c (the Settings switch builds the copy on the hub).
   The two, the boot script's md5s and the simulator's must agree exactly. */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const patch = JSON.parse(readFileSync(join(ROOT, "payload/helpers/hal_multiremote_patch.json"), "utf8"));
const webui = readFileSync(join(ROOT, "payload/source/codex_webui.c"), "utf8");
const rcs = readFileSync(join(ROOT, "payload/scripts/rcS.local"), "utf8");
const sim = readFileSync(join(ROOT, "tools/webui-sim/server.mjs"), "utf8");

const hex = (bytes) => bytes.split(",").map((b) => Number(b.trim()).toString(16).padStart(2, "0")).join("");

describe("multi-remote hal patch", () => {
  it("codex_webui.c carries exactly the patch file's edits", () => {
    const table = webui.split("static const struct hal_edit HAL_MULTI_EDITS[] = {")[1].split("};")[0];
    const rows = [...table.matchAll(/\{(0x[0-9a-f]+), \{([^}]*)\}, \{([^}]*)\}\}/g)]
      .map(([, offset, stock, patched]) => ({ offset: `0x${Number(offset).toString(16).padStart(5, "0")}`, stock: hex(stock), patched: hex(patched) }));
    assert.equal(rows.length, patch.edits.length);
    assert.deepEqual(rows, patch.edits);
  });

  it("the md5s and size agree everywhere", () => {
    assert.match(webui, new RegExp(`#define HAL_STOCK_MD5 "${patch.stock_md5}"`));
    assert.match(webui, new RegExp(`#define HAL_MULTI_MD5 "${patch.patched_md5}"`));
    assert.match(webui, new RegExp(`#define HAL_SIZE ${patch.size}\\b`));
    assert.ok(rcs.includes(patch.stock_md5) && rcs.includes(patch.patched_md5));
    assert.ok(sim.includes(patch.stock_md5) && sim.includes(patch.patched_md5));
  });

  it("every edit is 4 bytes inside the file, sorted and changing something", () => {
    let last = -1;
    for (const e of patch.edits) {
      const offset = Number.parseInt(e.offset, 16);
      assert.ok(offset > last && offset + 4 <= patch.size, e.offset);
      assert.equal(e.stock.length, 8);
      assert.equal(e.patched.length, 8);
      assert.notEqual(e.stock, e.patched);
      last = offset;
    }
  });
});
