import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseLibraryText } from "../../tools/webui-sim/public/js/ir-library.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

test("all entry guide links, images, and anchors resolve", () => {
  const script = path.join(repoRoot, "desktop/scripts/check-guide-links.mjs");
  const out = execFileSync(process.execPath, [script], { encoding: "utf8" });
  assert.match(out, /local links\/images\/anchors resolve/);
});

test("DEVICES_AND_CODES_GUIDE.md Paste examples parse cleanly with zero skipped rows", () => {
  const doc = fs.readFileSync(path.join(repoRoot, "docs/DEVICES_AND_CODES_GUIDE.md"), "utf8");
  const pasteSection = doc.split(/^### Paste:/m)[1]?.split(/^### /m)[0] ?? "";
  assert.ok(pasteSection.length > 0, "expected ### Paste: section in docs/DEVICES_AND_CODES_GUIDE.md");

  const blocks = [...pasteSection.matchAll(/```text\r?\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  assert.equal(blocks.length, 3, "expected pipe, IRDB CSV, and Pronto hex fenced examples");

  const [pipeBlock, csvBlock, prontoBlock] = blocks;

  const pipe = parseLibraryText(pipeBlock);
  assert.equal(pipe.format, "pipe");
  assert.equal(pipe.skipped, 0);
  assert.equal(pipe.supported, 2);

  const csv = parseLibraryText(csvBlock);
  assert.equal(csv.format, "irdb-csv");
  assert.equal(csv.skipped, 0);
  assert.equal(csv.supported, 2);

  const pronto = parseLibraryText(prontoBlock);
  assert.equal(pronto.format, "pronto");
  assert.equal(pronto.skipped, 0);
  assert.equal(pronto.supported, 1);
});
