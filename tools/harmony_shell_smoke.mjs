#!/usr/bin/env node
/* Packaging + contract smoke for the production harmony shell embed.
 *
 * Runs tools/package_harmony_shell.sh, then asserts the flash-safe contract:
 *   - production HTML references exactly one shell JS and one shell CSS
 *   - no Google Fonts / external URLs anywhere in the production bundle
 *   - no routable /sim/ URL in the production bundle (sim-only API)
 *   - vendor editor is NOT copied into the shell bundle or its header;
 *     it stays lazy-loaded from the existing /assets/activity-ui.* routes
 *   - the remote skin JPEG is embedded nowhere; production defines
 *     REMOTE_SKIN_SRC from the pre-existing REMOTE_SKIN_JPG_B64 in C
 *   - generated C arrays exist and are non-empty
 *   - tools/webui-sim/public/vendor/* stay byte-identical to payload/web/*
 *   - packaging is deterministic (two runs produce identical bytes)
 *
 * Run:  node tools/harmony_shell_smoke.mjs
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const REPO = new URL("..", import.meta.url).pathname;
const at = (rel) => new URL(rel, import.meta.url).pathname;

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function read(rel) {
  return fs.readFileSync(at(rel), "utf8");
}

// data:image/svg+xml URIs embed "http://www.w3.org/2000/svg" as an XML
// namespace identifier — never a network request. Strip them so only real
// external URLs are flagged.
function stripDataUris(text) {
  return text
    .replace(/"data:image\/svg\+xml,[^"]*"/g, '""')
    .replace(/'data:image\/svg\+xml,[^']*'/g, "''");
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(at(file))).digest("hex");
}

/* -- run the packager, then again for determinism ----------------------- */

const PACKAGER = at("package_harmony_shell.sh");
execFileSync("sh", [PACKAGER], { cwd: REPO, stdio: "pipe" });

const ARTIFACTS = [
  "webui-sim/build/index.html",
  "webui-sim/build/harmony-shell.js",
  "webui-sim/build/harmony-shell.css",
  "../payload/source/harmony_shell_assets.h",
];
const firstPass = Object.fromEntries(ARTIFACTS.map((a) => [a, sha256(`./${a}`)]));

execFileSync("sh", [PACKAGER], { cwd: REPO, stdio: "pipe" });
for (const artifact of ARTIFACTS) {
  check(
    `deterministic: ${artifact} identical across two packaging runs`,
    sha256(`./${artifact}`) === firstPass[artifact]
  );
}

const html = read("./webui-sim/build/index.html");
const shellJs = read("./webui-sim/build/harmony-shell.js");
const shellCss = read("./webui-sim/build/harmony-shell.css");
const header = read("../payload/source/harmony_shell_assets.h");
const webuiC = read("../payload/source/codex_webui.c");
const simIndex = read("./webui-sim/public/index.html");
const irView = read("./webui-sim/public/js/views/ir.js");

/* -- production HTML: single shell JS + single shell CSS ---------------- */

const stylesheetLinks = html.match(/<link[^>]*rel="stylesheet"[^>]*>/g) ?? [];
check(
  "index.html: exactly one stylesheet link",
  stylesheetLinks.length === 1,
  `found ${stylesheetLinks.length}`
);
check(
  "index.html: stylesheet is /assets/harmony-shell.css",
  stylesheetLinks.length === 1 && stylesheetLinks[0].includes('href="/assets/harmony-shell.css"')
);

const scriptSrcs = html.match(/<script[^>]*src="[^"]*"[^>]*>/g) ?? [];
check("index.html: exactly one external script", scriptSrcs.length === 1, `found ${scriptSrcs.length}`);
check(
  "index.html: script is /assets/harmony-shell.js (classic + defer, not module)",
  scriptSrcs.length === 1 &&
    scriptSrcs[0].includes('src="/assets/harmony-shell.js"') &&
    scriptSrcs[0].includes("defer") &&
    !scriptSrcs[0].includes("module")
);


/* -- no external / sim-only requests in production ----------------------- */

check("index.html: no Google Fonts or external URLs", !/https?:\/\//.test(stripDataUris(html)));
check("shell.js: no Google Fonts or external URLs", !/https?:\/\//.test(shellJs));
check("shell.css: no @import and no external URLs",
  !/@import/.test(shellCss) && !/https?:\/\//.test(stripDataUris(shellCss)));
check("index.html: no /sim/ URLs", !/\/sim\//.test(html));
check("shell.js: no routable /sim/ URLs", !/\/sim\//.test(shellJs));
check("index.html: no simulated-hub wording left", !/simulated/i.test(html));

/* -- runtime flags + skin injection seam --------------------------------- */

check("sim index.html: explicit simulation flag window.HARMONY_SIM = true", /window\.HARMONY_SIM\s*=\s*true/.test(simIndex));
check("index.html: production flag HARMONY_SIM=false + HARMONY_PRODUCTION=true",
  html.includes("window.HARMONY_SIM=false") && html.includes("window.HARMONY_PRODUCTION=true"));
check(
  "index.html: ends the head seam at globalThis.REMOTE_SKIN_SRC base64 marker (C injects REMOTE_SKIN_JPG_B64 here)",
  html.includes("<script>globalThis.REMOTE_SKIN_SRC='data:image/jpeg;base64,")
);
check("shell.js: remote skin resolved from globalThis.REMOTE_SKIN_SRC with local fallback",
  shellJs.includes("REMOTE_SKIN_SRC") && shellJs.includes("/assets/remote-skin.jpg"));
check("shell.js: simulation behavior gated on HARMONY_SIM",
  shellJs.includes("HARMONY_SIM"));
check("IR view: lab danger guard remains in factory scope for route teardown",
  irView.includes("let labGuard;") &&
  irView.includes("labGuard = dangerGuard(labClearBtn, {") &&
  !irView.includes("const labGuard = dangerGuard(labClearBtn, {"));

/* -- vendor editor dedup --------------------------------------------------- */

check("shell.js: lazy-loads vendor editor from absolute /assets/activity-ui.js",
  shellJs.includes("/assets/activity-ui.js"));
check("shell.js: lazy-loads vendor stylesheet from absolute /assets/activity-ui.css",
  shellJs.includes("/assets/activity-ui.css"));
check("shell.js: vendor source NOT bundled in",
  !shellJs.includes("__HARMONY_ACTIVITY_TEST__") && !shellJs.includes("pruneActionlessButtons"));
check("harmony_shell_assets.h: no duplicate vendor arrays",
  !header.includes("activity_ui_js") && !header.includes("activity_ui_css"));
const vendorRoutes = webuiC.match(/strcmp\(req\.path, "\/assets\/activity-ui\.(?:js|css)"\)/g) ?? [];
check("codex_webui.c: exactly one route each for /assets/activity-ui.js and .css",
  vendorRoutes.length === 2, `found ${vendorRoutes.length}`);

/* -- skin JPEG embedded nowhere ------------------------------------------- */

function arraysFromHeader(text) {
  const out = {};
  const re = /static const unsigned char (\w+)\[\] = \{([\s\S]*?)\};/g;
  let m;
  while ((m = re.exec(text))) {
    out[m[1]] = m[2]
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean)
      .map((b) => parseInt(b, 16));
  }
  return out;
}

const arrays = arraysFromHeader(header);
check("harmony_shell_assets.h: generated arrays present and non-empty",
  ["harmony_index_head", "harmony_index_tail", "harmony_shell_js", "harmony_shell_css"]
    .every((name) => Array.isArray(arrays[name]) && arrays[name].length > 0),
  `found ${Object.keys(arrays).join(", ") || "none"}`);

{
  // Arrays are NUL-terminated for fputs(); drop the terminator before text checks.
  const toText = (bytes) => Buffer.from(bytes.filter((b) => b !== 0)).toString("utf8");
  const headText = toText(arrays.harmony_index_head ?? []);
  const tailText = toText(arrays.harmony_index_tail ?? []);
  // No newline may sit between "base64," and the injected B64, or between
  // the B64 and the closing quote — a newline inside the single-quoted
  // REMOTE_SKIN_SRC literal is a JS syntax error in the served page.
  check("harmony_index_head ends exactly at the base64 seam (no trailing newline)",
    headText.endsWith("data:image/jpeg;base64,"));
  check("harmony_index_tail opens with the closing quote of the skin literal",
    tailText.startsWith("';"));
}

for (const [name, bytes] of Object.entries(arrays)) {
  let jpeg = false;
  for (let i = 0; i + 2 < bytes.length; i += 1) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
      jpeg = true;
      break;
    }
  }
  check(`harmony_shell_assets.h: ${name} embeds no raw JPEG (skin only via REMOTE_SKIN_JPG_B64)`, !jpeg);
}

for (const name of ["harmony_index_head", "harmony_index_tail", "harmony_shell_js", "harmony_shell_css"]) {
  const lenMatch = header.match(new RegExp(`static const unsigned int ${name}_len = (\\d+);`));
  check(`harmony_shell_assets.h: ${name}_len declared and > 0`,
    Boolean(lenMatch) && Number(lenMatch?.[1]) > 0);
}

/* -- C wiring contract ------------------------------------------------------ */

check('codex_webui.c: includes harmony_shell_assets.h', webuiC.includes('#include "harmony_shell_assets.h"'));
check("codex_webui.c: defines render_harmony_shell", /static void render_harmony_shell\(int fd\)/.test(webuiC));
check("codex_webui.c: routes / and /index.html to the shell",
  /render_harmony_shell\(client\)/.test(webuiC));
check("codex_webui.c: routes /assets/harmony-shell.css",
  webuiC.includes('strcmp(req.path, "/assets/harmony-shell.css")'));
check("codex_webui.c: routes /assets/harmony-shell.js",
  webuiC.includes('strcmp(req.path, "/assets/harmony-shell.js")'));
check("codex_webui.c: injects REMOTE_SKIN_JPG_B64 between the head and tail arrays",
  /fputs\(\(const char \*\)harmony_index_head, f\);\s*fputs\(REMOTE_SKIN_JPG_B64, f\);\s*fputs\(\(const char \*\)harmony_index_tail, f\);/.test(webuiC));

/* -- shell content is the validated design, fully concatenated -------------- */

check("shell.css: design tokens present", shellCss.includes("--surface-canvas") && shellCss.includes("--accent-primary"));
check("shell.css: remote skin styles present", shellCss.includes(".ir-remote-skin"));
check("shell.css: wizard styles present", shellCss.includes(".wiz-rail"));
check("shell.css: activity-overrides baked in", shellCss.includes("#view-activities .activity-hero"));

/* -- vendor sources untouched and still identical --------------------------- */

check("vendor activity-ui.js identical between webui-sim and payload/web",
  sha256("./webui-sim/public/vendor/activity-ui.js") === sha256("../payload/web/activity-ui.js"));
check("vendor activity-ui.css identical between webui-sim and payload/web",
  sha256("./webui-sim/public/vendor/activity-ui.css") === sha256("../payload/web/activity-ui.css"));
check("payload/source/activity_ui_assets.h still carries the vendor arrays",
  read("../payload/source/activity_ui_assets.h").includes("activity_ui_js"));

/* --------------------------------------------------------------------------- */

if (failures) {
  console.error(`\n${failures} harmony shell smoke check(s) failed`);
  process.exit(1);
}
console.log("\nharmony shell smoke: all checks passed");
